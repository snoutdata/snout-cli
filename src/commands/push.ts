/**
 * `snoutdata db push` — run the `.sql` files in a folder against the project, once each.
 *
 * The half of migrations that touches the world: read the folder, read the ledger, ask
 * `migrations.ts` what should happen, and then do it. Everything that DECIDES is in that
 * file and has no I/O, which is why the interesting cases (a file that changed, a rename,
 * a merge that lands 003 after 004) are proven without a database.
 *
 * ## Two choices worth knowing about
 *
 * **It runs through `psql`, not through the control plane.** `cloud-project-sql` exists
 * and the dashboard's editor uses it, but it refuses DDL, which is what a migration IS.
 * A migration is an ordinary client connecting to an ordinary Postgres, so this is an
 * ordinary connection: credentials fetched because you are signed in, the password
 * handed over in the child's environment and never on a command line. The cost is that
 * `psql` has to be installed, and the error says so plainly, the way `db psql` already
 * does.
 *
 * **The ledger row is written in the SAME transaction as the migration.** That is the
 * whole reason for wrapping: a file that fails half way leaves nothing behind, and there
 * is no state where the database believes something ran that did not. A file marked
 * `-- snoutdata:no-transaction` gives that up knowingly and is told so before it runs.
 *
 * The ledger is `_snoutdata_migrations`, in the project's own database, because that is
 * the only place that can never disagree with the schema it describes.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative as relativePath, resolve } from 'node:path';
import { connection, type Connection } from '../api.js';
import { bold, emit, say, warn } from '../output.js';
import { fail } from '../failure.js';
import { planMigrations, wantsTransaction, type MigrationFile } from '../migrations.js';
import { pgSslEnv } from '../pgTls.js';

/** How a path reads in a message: relative to here when that is shorter, absolute otherwise. */
function shown(path: string): string {
	const near = relativePath(process.cwd(), path);
	return near && !near.startsWith('..') ? near : path;
}

/** The table that records what has run. Created on first push, never dropped. */
const LEDGER = '_snoutdata_migrations';

const LEDGER_DDL = `create table if not exists ${LEDGER} (
	name text primary key,
	checksum text not null,
	applied_at timestamptz not null default now()
);`;

export interface PushOptions {
	/** The folder of `.sql` files. Defaults to `migrations` beside the working directory. */
	readonly dir?: string;
	/** Say what would run and change nothing. */
	readonly dryRun?: boolean;
	/** Permit a new file that sorts before one already applied. */
	readonly outOfOrder?: boolean;
}

/** A file's identity: its name, its checksum, and the text itself, read once. */
interface LoadedMigration extends MigrationFile {
	readonly path: string;
	readonly sql: string;
}

function readFolder(directory: string): LoadedMigration[] {
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		throw new Error(
			`no migrations folder at ${shown(directory)}. Put your .sql files there, or pass --dir.`
		);
	}
	// Only `.sql`, and only files: a folder of migrations usually also holds a README, an
	// editor's swap file, or a `down/` directory somebody is thinking about.
	return readdirSync(directory)
		.filter((name) => name.endsWith('.sql'))
		.map((name) => {
			const path = join(directory, name);
			const sql = readFileSync(path, 'utf8');
			return {
				name,
				path,
				sql,
				checksum: createHash('sha256').update(sql, 'utf8').digest('hex')
			};
		});
}

/**
 * Run some SQL and give back what psql said.
 *
 * Fed on stdin rather than with `-f`, because what runs is a migration wrapped in a
 * transaction with its ledger row, which is not a thing on disk. `ON_ERROR_STOP` is what
 * makes a failure a non-zero exit instead of a message scrolling past a "success".
 */
function runSql(details: Connection, sql: string, extra: readonly string[] = []): Promise<{ code: number; out: string; err: string }> {
	return new Promise((done) => {
		const child = spawn(
			'psql',
			[
				'--host', details.host,
				'--port', String(details.port),
				'--username', details.user,
				'--dbname', details.database,
				'--no-psqlrc',
				'-v', 'ON_ERROR_STOP=1',
				...extra
			],
			{ stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: details.password, ...pgSslEnv(details.ssl) } }
		);
		let out = '';
		let err = '';
		child.stdout.on('data', (chunk) => (out += String(chunk)));
		child.stderr.on('data', (chunk) => (err += String(chunk)));
		child.on('error', (error) => {
			done({
				code: 127,
				out: '',
				err:
					(error as NodeJS.ErrnoException).code === 'ENOENT'
						? 'psql is not installed, and db push needs it to run your migrations. `snoutdata db url` prints a connection string for any client.'
						: String(error)
			});
		});
		child.on('close', (code) => done({ code: code ?? 0, out, err }));
		child.stdin.end(sql);
	});
}

/** What has already run, read from the project's own database. */
async function readLedger(details: Connection): Promise<{ name: string; checksum: string }[]> {
	const created = await runSql(details, LEDGER_DDL);
	if (created.code !== 0) {
		throw new Error(created.err.trim() || `could not create ${LEDGER}`);
	}
	// A tab separator, because a migration's NAME is a file name and may hold anything a
	// file name may hold, including a comma or a space.
	const rows = await runSql(details, `select name || E'\\t' || checksum from ${LEDGER};`, ['-tA']);
	if (rows.code !== 0) {
		throw new Error(rows.err.trim() || `could not read ${LEDGER}`);
	}
	return rows.out
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const tab = line.indexOf('\t');
			return { name: line.slice(0, tab), checksum: line.slice(tab + 1) };
		});
}

function literal(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/**
 * What a push did, as a value.
 *
 * Returned rather than printed, because `push` is called from two places now: a person at
 * a terminal, and the MCP server, where stdout is the JSON-RPC wire and a stray line on it
 * is a protocol error. The first version of this captured `process.stdout.write` for the
 * length of the call, which worked until two tool calls overlapped and the capture
 * swallowed another tool's ANSWER. Found live 2026-09-06, and the lesson is the general
 * one: a function that prints cannot be reused, so the thing that decides and the thing
 * that says are separate.
 */
export interface PushResult {
	ref: string;
	directory: string;
	ok: boolean;
	/** Migrations that ran, in order. */
	applied: string[];
	/** Nothing to do: everything in the folder has already run. */
	upToDate?: boolean;
	/** `--dry-run`: what would have run. */
	wouldApply?: string[];
	/** Why the whole push was refused, if it was. */
	problems?: { code: string; name: string; reason: string }[];
	/** The migration that failed, and what the database said. */
	failed?: string;
	error?: string;
	/** Said before a file runs outside a transaction, so a caller can pass it on. */
	notes?: string[];
}

/** The CLI command: run it, then say what happened. */
export async function push(ref: string, options: PushOptions = {}): Promise<number> {
	const result = await runPush(ref, options, (message) => say(message));
	if (!result.ok) {
		// Two different failures, and an agent has to be able to act on the difference. A
		// REFUSAL means this folder and that database disagree about history, and running
		// it again changes nothing; a failed migration means one statement broke and the
		// ones after it were never tried. Both used to be exit 1 and a paragraph.
		if (result.problems) {
			const lines = result.problems.map((problem) => `  ${problem.reason}`).join('\n');
			fail('conflict', `Refused. This folder and ${ref} do not agree:\n${lines}`, {
				ref,
				problems: result.problems
			});
		}
		fail('failed', `${result.failed} failed, and nothing after it was tried.\n${result.error ?? ''}`.trimEnd(), {
			ref,
			failed: result.failed
		});
	}
	emit(result, () => {
		if (result.wouldApply) {
			say(`Would apply ${result.wouldApply.length} migration${result.wouldApply.length === 1 ? '' : 's'} to ${ref}:`);
			for (const name of result.wouldApply) {
				say(`  ${name}`);
			}
			return;
		}
		if (result.upToDate) {
			say(`${ref} is up to date.`);
			return;
		}
		say(`Applied ${result.applied.length} migration${result.applied.length === 1 ? '' : 's'} to ${ref}.`);
	});
	return 0;
}

/**
 * Do the work and say nothing. `note` is how progress reaches a caller that wants it.
 */
export async function runPush(
	ref: string,
	options: PushOptions = {},
	note: (message: string) => void = () => {}
): Promise<PushResult> {
	const directory = resolve(
		options.dir === undefined ? join(process.cwd(), 'migrations') : isAbsolute(options.dir) ? options.dir : join(process.cwd(), options.dir)
	);
	const notes: string[] = [];
	function record(message: string): void {
		notes.push(message);
		note(message);
	}

	const files = readFolder(directory);
	if (files.length === 0) {
		record(`No .sql files in ${shown(directory)}.`);
		return { ref, directory, ok: true, applied: [], upToDate: true, notes };
	}

	const details = await connection(ref);
	if (!details.wakesInstantly) {
		record('This project is paused; the connection will wake it, which takes a few seconds.');
	}
	const already = await readLedger(details);
	const plan = planMigrations(files, already, { outOfOrder: options.outOfOrder });

	if (!plan.ok) {
		// Every problem, not the first: somebody with three of them wants to see three.
		return { ref, directory, ok: false, applied: [], problems: [...plan.problems], notes };
	}

	const byName = new Map(files.map((file) => [file.name, file]));
	const pending = plan.pending.map((one) => byName.get(one.name)!);
	if (pending.length === 0) {
		record(`${ref} is up to date: ${already.length} migration${already.length === 1 ? '' : 's'} already applied.`);
		return { ref, directory, ok: true, applied: [], upToDate: true, notes };
	}

	if (options.dryRun) {
		for (const one of pending) {
			if (!wantsTransaction(one.sql)) {
				record(`${one.name} would run outside a transaction.`);
			}
		}
		return { ref, directory, ok: true, applied: [], wouldApply: pending.map((one) => one.name), notes };
	}

	const done: string[] = [];
	for (const migration of pending) {
		const ledgerRow = `insert into ${LEDGER} (name, checksum) values (${literal(migration.name)}, ${literal(migration.checksum)});`;
		const wrapped = wantsTransaction(migration.sql);
		if (!wrapped) {
			// Said before it runs rather than after it fails: this file has given up the
			// guarantee that an interruption leaves nothing behind, and whoever is running
			// it should know that at the moment it matters.
			record(`${migration.name} runs outside a transaction, so an interruption can leave it half applied.`);
		}
		const sql = wrapped ? `begin;\n${migration.sql}\n${ledgerRow}\ncommit;\n` : `${migration.sql}\n${ledgerRow}\n`;
		const result = await runSql(details, sql);
		if (result.code !== 0) {
			// Stop at the first failure. The ones after it were written expecting this one
			// to have run, so carrying on is how a half-migrated schema is made.
			if (wrapped) {
				record('It ran inside a transaction, so nothing from it is in the database.');
			}
			return {
				ref,
				directory,
				ok: false,
				applied: done,
				failed: migration.name,
				error: result.err.trim(),
				notes
			};
		}
		done.push(migration.name);
		record(`  applied ${migration.name}`);
	}

	return { ref, directory, ok: true, applied: done, notes };
}
