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
 * **It connects to the database itself, not through the control plane.** `cloud-project-sql`
 * exists and the dashboard's editor uses it, but it refuses DDL, which is what a migration IS.
 * A migration is an ordinary client connecting to an ordinary Postgres, so this is an
 * ordinary connection: credentials fetched because you are signed in, TLS verified as
 * `pgTls.ts` says. Until 0.17.4 that client was `psql`, which had to be installed; now it is
 * the CLI's own (`pgWire.ts`), and a file is cut into statements by psql's rules
 * (`sqlScript.ts`) and sent one at a time as psql sent them, each migration on a connection
 * of its own as each psql was. The one thing psql did that this cannot is a psql
 * meta-command (`\i`, `\set`), and a file holding one is refused before anything runs.
 *
 * **The ledger row is written in the SAME transaction as the migration.** That is the
 * whole reason for wrapping: a file that fails half way leaves nothing behind, and there
 * is no state where the database believes something ran that did not. A file marked
 * `-- snoutdata:no-transaction` gives that up knowingly and is told so before it runs.
 *
 * The ledger is `_snoutdata_migrations`, in the project's own database, because that is
 * the only place that can never disagree with the schema it describes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative as relativePath, resolve } from 'node:path';
import { connection, type Connection } from '../api.js';
import { bold, emit, say, warn } from '../output.js';
import { CliFailure, fail } from '../failure.js';
import { planMigrations, wantsTransaction, type MigrationFile } from '../migrations.js';
import { describePgError, PgConnectError, PgServerError, PgSession, type PgResult, type PgTarget } from '../pgWire.js';
import { endsTransaction, splitScript, type ScriptStatement } from '../sqlScript.js';

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

/** One connection, as `push` needs it: a statement at a time, then goodbye. */
export interface SqlSession {
	query(sql: string, copyData?: string): Promise<PgResult>;
	close(): void;
}

/** What `runPush` reaches the world through. Tests hand it a fake database. */
export interface PushHost {
	connection(ref: string): Promise<Pick<Connection, keyof PgTarget | 'wakesInstantly'>>;
	open(target: PgTarget): Promise<SqlSession>;
}

const LIVE: PushHost = {
	connection: (ref) => connection(ref),
	open: (target) => PgSession.open(target)
};

/** A connection that failed before running anything, as the failure an agent branches on. */
function unreachable(error: unknown, ref: string): never {
	if (error instanceof PgConnectError) {
		throw new CliFailure('network', `Could not reach ${ref}'s database: ${error.message}.`);
	}
	if (error instanceof PgServerError) {
		throw new CliFailure('failed', `${ref}'s database refused the connection: ${error.message}`);
	}
	throw error;
}

/** Open a connection, or fail in a sentence. */
async function openSession(host: PushHost, target: PgTarget, ref: string): Promise<SqlSession> {
	try {
		return await host.open(target);
	} catch (error) {
		return unreachable(error, ref);
	}
}

/** What has already run, read from the project's own database. */
async function readLedger(host: PushHost, target: PgTarget, ref: string): Promise<{ name: string; checksum: string }[]> {
	const session = await openSession(host, target, ref);
	try {
		await session.query(LEDGER_DDL);
		const { rows } = await session.query(`select name, checksum from ${LEDGER};`);
		return rows.map(([name, checksum]) => ({ name: name ?? '', checksum: checksum ?? '' }));
	} catch (error) {
		if (error instanceof PgServerError) {
			throw new CliFailure('failed', `Could not read ${LEDGER} on ${ref}: ${error.message}`);
		}
		return unreachable(error, ref);
	} finally {
		session.close();
	}
}

/**
 * Run a migration's statements in order on a connection of its own, stopping at the first that
 * fails. Null when all of them ran; otherwise what the database said, as psql would print it,
 * with the line of the file the failing statement starts on.
 */
async function runStatements(session: SqlSession, statements: readonly ScriptStatement[], name: string): Promise<string | null> {
	for (const statement of statements) {
		try {
			await session.query(statement.sql, statement.copyData);
		} catch (error) {
			if (error instanceof PgServerError) {
				const where = statement.line > 0 ? `${name}:${statement.line}: ` : '';
				return `${where}${describePgError(error, statement.sql, statement.line > 0 ? statement.line : 1)}`;
			}
			if (error instanceof PgConnectError) {
				return `the connection was lost: ${error.message}`;
			}
			throw error;
		}
	}
	return null;
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
			// A psql command is a property of the folder alone; the database agrees with it fine.
			if (result.problems.every((problem) => problem.code === 'psql-command' || problem.code === 'ends-transaction')) {
				fail('failed', `Refused, and nothing ran:\n${lines}`, { ref, problems: result.problems });
			}
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
	note: (message: string) => void = () => {},
	host: PushHost = LIVE
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

	const details = await host.connection(ref);
	const target: PgTarget = {
		host: details.host,
		port: details.port,
		database: details.database,
		user: details.user,
		password: details.password,
		ssl: details.ssl
	};
	if (!details.wakesInstantly) {
		record('This project is paused; the connection will wake it, which takes a few seconds.');
	}
	const already = await readLedger(host, target, ref);
	const plan = planMigrations(files, already, { outOfOrder: options.outOfOrder });

	if (!plan.ok) {
		// Every problem, not the first: somebody with three of them wants to see three.
		return { ref, directory, ok: false, applied: [], problems: [...plan.problems], notes };
	}

	const byName = new Map(files.map((file) => [file.name, file]));
	const pending = plan.pending.map((one) => byName.get(one.name)!);

	// psql's own commands cannot run without psql. Found before anything runs, dry run included,
	// so a folder is never left with half of its pending files applied because of one.
	const scripts = new Map(pending.map((one) => [one.name, splitScript(one.sql)]));
	const meta = pending.flatMap((one) =>
		scripts.get(one.name)!.metaCommands.map((command) => ({
			code: 'psql-command',
			name: one.name,
			reason: `${one.name} line ${command.line} is a psql command (${command.text.length > 60 ? `${command.text.slice(0, 57)}...` : command.text}), which only psql runs. db push sends SQL to the database itself, so put the SQL it stands for in the file instead.`
		}))
	);
	// A file that ends its own transaction breaks the one it is wrapped in: what ran before the
	// COMMIT stays even when a later statement fails, and the ledger row is not written with it.
	const ending = pending
		.filter((one) => wantsTransaction(one.sql))
		.flatMap((one) =>
			scripts.get(one.name)!.statements.flatMap((statement) => {
				const word = endsTransaction(statement.sql);
				return word
					? [{
						code: 'ends-transaction',
						name: one.name,
						reason: `${one.name} line ${statement.line} ends the transaction itself (${word}). db push already runs each file in one transaction and records it there, so a ${word} would keep what ran before it if a later statement failed. Take it out, or put -- snoutdata:no-transaction at the top of the file to run it exactly as written.`
					}]
					: [];
			})
		);
	if (meta.length > 0 || ending.length > 0) {
		return { ref, directory, ok: false, applied: [], problems: [...meta, ...ending], notes };
	}

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
		// The ledger row and the transaction's edges carry no line of the file.
		const statements: ScriptStatement[] = [
			...(wrapped ? [{ sql: 'begin;', line: 0 }] : []),
			...scripts.get(migration.name)!.statements,
			{ sql: ledgerRow, line: 0 },
			...(wrapped ? [{ sql: 'commit;', line: 0 }] : [])
		];
		// A connection for each migration, as each psql was: a `set` in one never reaches the next.
		const session = await openSession(host, target, ref);
		let error: string | null;
		try {
			error = await runStatements(session, statements, migration.name);
		} finally {
			// Closing a connection with its transaction open is what rolls a failed one back.
			session.close();
		}
		if (error !== null) {
			// Stop at the first failure. The ones after it were written expecting this one
			// to have run, so carrying on is how a half-migrated schema is made.
			if (wrapped) {
				record('It ran inside a transaction, so nothing from it is in the database.');
				// CREATE INDEX CONCURRENTLY, VACUUM and the like: Postgres's words name the problem
				// and not the way out of it.
				if (/cannot run inside a transaction block/i.test(error)) {
					record('Put -- snoutdata:no-transaction at the top of the file to run it outside one.');
				}
			}
			return {
				ref,
				directory,
				ok: false,
				applied: done,
				failed: migration.name,
				error,
				notes
			};
		}
		done.push(migration.name);
		record(`  applied ${migration.name}`);
	}

	return { ref, directory, ok: true, applied: done, notes };
}
