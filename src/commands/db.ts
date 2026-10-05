/**
 * `snoutdata db …` — being inside the database, with nothing typed.
 *
 * The promise this file keeps is D12's: **being signed in is enough.** `db psql` fetches
 * the project's credentials, hands psql a URL, and never asks anybody for a password —
 * which is the whole reason the connection function exists.
 *
 * The password reaches psql through `PGPASSWORD` in the child's environment, never on a
 * command line, because argv is readable by every process on the box through /proc.
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { open } from 'node:fs/promises';
import { classifyRestoreErrors, planRestore, PRODUCT_ROLE, restoreVerdict, dumpFormat, type RestorePlan } from '../restore.js';
import { getProducts } from './manage.js';
import * as api from '../api.js';
import { CliFailure, fail } from '../failure.js';
import { canAsk, explainNoHuman, noHumanReason } from '../interactive.js';
import { connection } from '../api.js';
import { dim, emit, relative, say, warn } from '../output.js';
import { pgSslEnv } from '../pgTls.js';

/**
 * Say it, once, if this project has stopped accepting writes.
 *
 * On stderr rather than stdout, and that is the whole reason this is a function rather than
 * a `say()` in three places: `db url` is piped into a `.env` and read by scripts, so a line
 * of prose on stdout would end up INSIDE somebody's connection string. A warning belongs on
 * the other stream.
 *
 * Without it the first symptom of a storage quota is `cannot execute INSERT in a read-only
 * transaction` with nothing whatever to connect it to.
 */
async function warnIfReadOnly(ref: string): Promise<void> {
	try {
		const { projects } = await api.listProjects();
		const project = projects.find((candidate) => candidate.ref === ref);
		if (project?.readOnly) {
			warn(`${ref} is read-only: it is over the storage limit on your plan. Reading works; writing does not.`);
		} else if (project?.readOnlyPending) {
			warn(`${ref} is about to become read-only: it has grown past the storage limit on your plan.`);
		}
	} catch {
		// A warning that cannot be fetched must never stop somebody getting their connection
		// string. This is a courtesy, not a gate.
	}
}

export async function url(ref: string): Promise<void> {
	await warnIfReadOnly(ref);
	const details = await connection(ref);
	emit(details, () => {
		process.stdout.write(`${details.uri}\n`);
	});
}

/**
 * The one command whose exit code is not ours, and the only one that hands over a terminal.
 *
 * `db psql` is a passthrough: it becomes psql, inherits all three streams, and returns
 * whatever psql returned. That is right for the thing it is (a shell), and it means this
 * command's 1, 2 and 3 are psql's meanings and not the ones every other command uses. The
 * README says so rather than leaving it to be discovered from a confusing exit 3.
 *
 * What is NOT allowed is walking into that ambiguity by accident. With no statements after
 * `--` this opens an interactive session, and an interactive session with nobody at the
 * keyboard is a job that hangs until it is killed. So it refuses under the same D1 gate as
 * every other question, and says which flag would have worked.
 */
export async function psql(ref: string, rest: readonly string[]): Promise<number> {
	if (rest.length === 0 && !canAsk()) {
		const why = noHumanReason();
		fail(
			'usage',
			`db psql with no statements opens an interactive session, and ${why ? explainNoHuman(why) : 'there is nobody to use it'}. Pass statements after --, or use \`snoutdata db url\` and your own client.`
		);
	}
	await warnIfReadOnly(ref);
	const details = await connection(ref);
	if (!details.wakesInstantly) {
		say('This project is paused; the connection will wake it, which takes a few seconds.');
	}
	// Everything but the password on the command line, and the password in the child's
	// environment. psql reads PGPASSWORD without being asked.
	const child = spawn(
		'psql',
		[
			'--host',
			details.host,
			'--port',
			String(details.port),
			'--username',
			details.user,
			'--dbname',
			details.database,
			...rest
		],
		{
			stdio: 'inherit',
			env: { ...process.env, PGPASSWORD: details.password, ...pgSslEnv(details.ssl) }
		}
	);
	return new Promise((resolve, reject) => {
		child.on('error', (error) => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				// Reported through the taxonomy like everything else, so `tool-missing` is
				// the same answer here as it is from `db restore`.
				reject(new CliFailure('tool-missing', 'psql is not installed. `snoutdata db url` prints a connection string for any client.'));
				return;
			}
			reject(new CliFailure('failed', String(error)));
		});
		child.on('close', (code) => resolve(code ?? 0));
	});
}

/**
 * Put `DATABASE_URL` in a `.env`, which is what an agent actually wants.
 *
 * Rewrites an existing line rather than appending a second one: two `DATABASE_URL`s in a
 * file is a bug that takes an hour to find, because which one wins depends on the loader.
 */
export function writeEnv(directory: string, value: string, key = 'DATABASE_URL'): { path: string; replaced: boolean; ignored: boolean } {
	const path = join(directory, '.env');
	const line = `${key}=${value}`;
	// The value holds a password, so in a repository the file is kept out of a commit first.
	const ignored = ignoreEnv(directory);
	if (!existsSync(path)) {
		// Readable by this user only: on a 0755 home or a shared project folder, another
		// account could otherwise read the password (audit 14-D).
		writeFileSync(path, `${line}\n`, { mode: 0o600 });
		return { path, replaced: false, ignored };
	}
	// An existing file keeps its mode, which is the user's to choose; say so when it is open.
	if (process.platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
		warn(`${path} can be read by other users on this machine, and it holds a database password. \`chmod 600 ${path}\` closes it.`);
	}
	const existing = readFileSync(path, 'utf8');
	const pattern = new RegExp(`^${key}=.*$`, 'm');
	if (pattern.test(existing)) {
		writeFileSync(path, existing.replace(pattern, line));
		return { path, replaced: true, ignored };
	}
	appendFileSync(path, existing.endsWith('\n') ? `${line}\n` : `\n${line}\n`);
	return { path, replaced: false, ignored };
}

/**
 * Add `.env` to the `.gitignore` beside it, when the folder is in a git repository and no line
 * there already covers it. True when a line was added.
 *
 * A plain read of the one file rather than `git check-ignore`, which needs git installed: a
 * pattern elsewhere (a parent's .gitignore, a global one) means a redundant line, never a
 * missing one, and a redundant line costs nothing.
 */
export function ignoreEnv(directory: string): boolean {
	let at = directory;
	while (!existsSync(join(at, '.git'))) {
		const up = dirname(at);
		if (up === at) {
			return false;
		}
		at = up;
	}
	const path = join(directory, '.gitignore');
	const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const covered = existing.split(/\r?\n/).some((raw) => /^\/?(\.env|\.env\*|\*\.env|\.env\.\*)$/.test(raw.trim()));
	if (covered) {
		return false;
	}
	appendFileSync(path, existing === '' || existing.endsWith('\n') ? '.env\n' : '\n.env\n');
	return true;
}

/**
 * `snoutdata db export` — a copy of the database, on this machine, in one command.
 *
 * The whole point is that it is one command. Underneath, an export is a request the
 * control plane records, a `pg_dump` a host takes minutes later, and a signed link with an
 * expiry on it — three things a person should not have to know about to get a dump. So
 * this asks, waits, and either prints the link or downloads it.
 *
 * ## Three things about it that are not obvious
 *
 * **Asking twice is one export.** The control plane treats a second request while one is
 * running as the same request, so a script that retries does not queue a second `pg_dump`
 * against a production database. `--status` exists for the same reason: to look without
 * asking.
 *
 * **A missing link is not a failed export.** A host signs the URL with credentials it
 * reads from instance metadata, which rotate every few hours, so a link is good for hours
 * rather than weeks and an aged-out one is dropped rather than handed over dead. The dump
 * is still in the bucket; asking again signs a fresh link against the same file. That is
 * why `error` is checked separately from `url` here rather than treating null as failure.
 *
 * **The download is streamed to the file.** A database dump is exactly the thing that does
 * not fit in memory, and `await response.arrayBuffer()` on a customer's 20 GB export would
 * be a very confident way to be killed by the OOM killer.
 */
export async function exportDatabase(
	ref: string,
	options: { out?: string; statusOnly?: boolean; timeoutMs?: number } = {}
): Promise<number> {
	if (options.statusOnly) {
		const { export: current } = await api.exportStatus(ref);
		// The status query succeeded. That the LAST export failed is the answer, not a
		// failure of this command, and returning 1 for it made "did my status call work"
		// unanswerable. The verdict is in `export.error` where a caller can read it.
		emit({ ref, export: current }, () => describeExport(current));
		return 0;
	}

	const asked = await api.requestExport(ref);
	if (!asked.export.pending && asked.export.url && !options.out) {
		// Nothing was started: there is already a finished export with a live link. Handing
		// it over beats taking another dump of the same database to say the same thing.
		emit({ ref, export: asked.export }, () => describeExport(asked.export));
		return 0;
	}

	say('Taking a copy of the database. This runs on the server and can take a few minutes.');
	const finished = await waitForExport(ref, options.timeoutMs);
	if (finished.error) {
		fail('failed', `The export did not finish: ${finished.error}`, { ref });
	}

	if (!options.out) {
		emit({ ref, export: finished }, () => describeExport(finished));
		return 0;
	}

	if (!finished.url) {
		// The dump exists; only the link does not. Say which, because "export failed" would
		// be false and would send somebody to look in the wrong place.
		fail('failed', 'The copy was taken, but no download link could be signed. Run this again to get one.', { ref });
	}
	const written = await download(finished.url, options.out);
	// The roles the dump's GRANTs name, written beside it.
	//
	// Without them `pg_restore` fails each acl entry that mentions a role the target does
	// not have -- and because pg_dump packs an object's WHOLE acl into one entry, that
	// takes every other grant on the object with it. It reports a "role does not exist"
	// nobody reads as fatal, and the database comes up with no privileges on anything.
	//
	// Absent on an export taken before this shipped, and on a control plane that has not
	// applied 060 yet, so it is written only when it is there: an old export still
	// downloads and still restores, the way it always did.
	const rolesPath = finished.rolesSql ? rolesFileFor(options.out) : null;
	if (rolesPath && finished.rolesSql) {
		writeFileSync(rolesPath, finished.rolesSql.endsWith('\n') ? finished.rolesSql : `${finished.rolesSql}\n`, 'utf8');
	}
	emit({ ref, path: options.out, bytes: written, rolesPath }, () => {
		say(`Saved ${describeBytes(written)} to ${options.out}.`);
		// Into one of ours, the restore that knows which objects the project already has.
		say(dim(`Into a SnoutData project: snoutdata db restore --file ${options.out} --ref <ref>`));
		if (rolesPath) {
			say(`Saved the roles it needs to ${rolesPath}.`);
			say(dim('Into any other Postgres, in this order:'));
			say(dim(`  psql --dbname <your database> -f ${rolesPath}`));
			say(dim(`  pg_restore --dbname <your database> ${options.out}`));
			// Said plainly because the alternative is a database that looks fine and has
			// no grants: the roles have no passwords, by design.
			say(dim('The roles are created without passwords. Set them yourself if anything signs in as one.'));
		} else {
			// No roles file, so the grants in the archive cannot apply. Say what to do
			// rather than print a command that half-works.
			say(dim('Restore it with: pg_restore --no-owner --no-privileges --dbname <your database> ' + options.out));
			say(dim('Owners and grants are skipped: this export carries no roles file.'));
		}
	});
	return 0;
}

/**
 * `x.dump` -> `x.roles.sql`, and `x` -> `x.roles.sql`.
 *
 * Beside the dump and named after it, so the pair stays together in a downloads folder
 * and it is obvious which dump a roles file belongs to.
 */
export function rolesFileFor(dumpPath: string): string {
	return dumpPath.replace(/\.[^./\\]*$/, '') + '.roles.sql';
}

/**
 * Poll until the export stops being pending.
 *
 * Every three seconds rather than every one: this is a `pg_dump` of a whole database, so
 * nothing useful changes in a second, and a tighter loop only spends somebody's rate limit.
 */
async function waitForExport(ref: string, timeoutMs = 30 * 60_000): Promise<api.ProjectExport> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const { export: current } = await api.exportStatus(ref);
		if (!current.pending) {
			return current;
		}
		if (Date.now() >= deadline) {
			throw new Error(`the export of ${ref} was still running after waiting`);
		}
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
}

/**
 * Stream a signed URL to a file.
 *
 * No Authorization header, deliberately: the signature IS the credential, and adding ours
 * to an S3 request would be sending a token to a service that has no business seeing one.
 */
async function download(url: string, path: string): Promise<number> {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error(`the download failed: ${response.status} ${response.statusText}`);
	}
	const handle = await open(path, 'w');
	let written = 0;
	try {
		for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
			await handle.write(chunk);
			written += chunk.byteLength;
		}
	} finally {
		await handle.close();
	}
	return written;
}

function describeExport(current: api.ProjectExport): void {
	if (current.error) {
		warn(`The last export did not finish: ${current.error}`);
		return;
	}
	if (current.pending) {
		say('An export is running. Ask again in a minute, or run `snoutdata db export`, which waits for it.');
		return;
	}
	if (!current.completedAt) {
		say('This project has never been exported.');
		return;
	}
	say(`A copy taken ${relative(current.completedAt)}, ${describeBytes(current.bytes ?? 0)}.`);
	if (current.url) {
		process.stdout.write(`${current.url}\n`);
		if (current.urlExpiresAt) {
			say(dim(`That link stops working ${relative(current.urlExpiresAt)}.`));
		}
	} else {
		say(dim('The link has expired. Run the export again to sign a new one; the copy is kept.'));
	}
}

export function describeBytes(value: number): string {
	if (value < 1024) {
		return `${value} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let size = value / 1024;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * `snoutdata db restore --file dump` — put a dump into a project.
 *
 * The other half of `db export`, and what makes "seed a fresh database from production"
 * one loop instead of a paragraph of instructions. `restore.ts` decides which tool the
 * file needs and whether this database should take it; this runs it.
 *
 * The password goes to the child in its environment, never on a command line, for the
 * reason `psql` above says: argv is readable by every process on the box.
 */
export async function restoreDatabase(
	ref: string,
	options: { file?: string; force?: boolean }
): Promise<number> {
	const path = options.file;
	if (!path) {
		fail('usage', 'db restore needs --file, pointing at a dump. `snoutdata db export` writes one.');
	}
	if (!existsSync(path)) {
		fail('usage', `no file at ${path}`, { file: path });
	}

	// The first 512 bytes, which is what tells a custom archive from SQL from a tar.
	const handle = await open(path, 'r');
	const head = new Uint8Array(512);
	const read = await handle.read(head, 0, 512, 0);
	await handle.close();
	const format = dumpFormat(head.slice(0, read.bytesRead));

	const details = await connection(ref);
	if (!details.wakesInstantly) {
		say('This project is paused; the connection will wake it, which takes a few seconds.');
	}
	const { projects } = await api.listProjects();
	const project = projects.find((candidate) => candidate.ref === ref);

	// Counted through the same psql this is about to use, so a machine that cannot run the
	// restore fails here with the right message rather than after reading the file.
	const counted = await countTables(details);
	if (counted === null) {
		// Documented as 127 and, until 2026-09-06, actually a 1: this returned before the
		// caller could tell a missing psql from a failed restore.
		fail('tool-missing', 'psql is not installed, so the tables in this project could not be counted. Install the Postgres client tools, or restore with your own client using `snoutdata db url`.');
	}

	const verdict = restoreVerdict(format, { existingTables: counted, readOnly: project?.readOnly === true }, { force: options.force });
	if (!verdict.ok) {
		fail('conflict', verdict.reason, { ref, file: path, refusal: verdict.code });
	}

	// An archive is read first: an export of ours carries the platform's own objects, which the
	// target already has, and the rows of its auth, storage and push tables, which go into the
	// target's own tables first (`planRestore`).
	let plan: RestorePlan | null = null;
	if (verdict.tool === 'pg_restore') {
		const toc = await capture('pg_restore', ['--list', path]);
		const postData = await capture('pg_restore', ['--section=post-data', '--file=-', path]);
		if (toc.code !== 0 || postData.code !== 0) {
			fail('failed', `pg_restore could not read ${path}: ${(toc.stderr || postData.stderr).trim().slice(0, 300)}`, { ref, file: path });
		}
		plan = planRestore(toc.stdout, postData.stdout);
		if (plan.products.length > 0) {
			const products = await getProducts(ref);
			const isOn = (value: unknown): boolean => Boolean(value && typeof value === 'object' && 'enabled' in value && (value as { enabled: boolean }).enabled);
			const off = plan.products.filter((product) => !isOn(products[product]));
			if (off.length > 0) {
				fail(
					'conflict',
					`this dump holds ${off.length > 1 ? `${off.slice(0, -1).join(', ')} and ${off[off.length - 1]}` : off[0]} data, and ${ref} has ${off.length === 1 ? 'it' : 'them'} off. Their tables are the platform's, so the product has to be on to take the rows. Switch ${off.length === 1 ? 'it' : 'them'} on, wait a minute, and run this again:\n${off.map((product) => `  snoutdata products enable ${product} --ref ${ref}`).join('\n')}`,
					{ ref, file: path, refusal: 'products-off', products: off }
				);
			}
		}
	}

	if (plan && plan.platformData.length > 0) {
		// "On" is the switch; the tables come when the product first runs, up to a minute later.
		const wanted = plan.platformData.flatMap(({ tables }) => tables);
		const missing = await missingTables(details, wanted);
		if (missing === null) {
			fail('failed', `could not check ${ref} for the tables this dump loads into.`, { ref });
		}
		const starting = plan.platformData.filter(({ tables }) => tables.some((table) => missing.includes(table))).map(({ product }) => product);
		if (starting.length > 0) {
			fail('conflict', `${starting.join(', ')} on ${ref} ${starting.length === 1 ? 'has' : 'have'} not finished setting up ${starting.length === 1 ? 'its' : 'their'} tables yet. Run this again in a minute.`, { ref, file: path, refusal: 'products-starting', products: starting });
		}
	}

	say(`Restoring ${path} into ${ref} with ${verdict.tool} (${verdict.format} format).`);
	const run = plan ? await runPlannedRestore(details, path, plan) : await runRestore(details, verdict.tool, path);
	const errors = classifyRestoreErrors(run.stderr);
	for (const note of plan?.notes ?? []) {
		say(dim(note));
	}

	// A non-zero exit whose every error is one the project's owner could never have avoided
	// is a success. See `classifyRestoreErrors`: an export of ours, restored into a project
	// of ours, always fails to comment on the extensions the pod image installs.
	if (run.code !== 0 && errors.fatal.length === 0 && errors.total > 0) {
		emit({ ref, file: path, ok: true, tool: verdict.tool, format: verdict.format, ignoredErrors: errors.harmless }, () => {
			say(`Restored into ${ref}.`);
			say(
				`${errors.harmless} error${errors.harmless === 1 ? '' : 's'} above ${errors.harmless === 1 ? 'is' : 'are'} expected and nothing is missing: a dump carries comments on the extensions this image installs, and your role does not own them.`
			);
		});
		return 0;
	}
	if (run.code !== 0) {
		fail(
			'failed',
			`${verdict.tool} exited ${run.code}. Nothing here retried it: a half-finished restore is undone by deleting the project and making another.`,
			{ ref, file: path, errors: errors.fatal }
		);
	}
	emit({ ref, file: path, ok: true, tool: verdict.tool, format: verdict.format }, () => say(`Restored into ${ref}.`));
	return 0;
}

/** How many tables the target already has. Null means psql could not run at all. */
async function countTables(details: api.Connection): Promise<number | null> {
	return new Promise((resolve) => {
		const child = spawn(
			'psql',
			['--host', details.host, '--port', String(details.port), '--username', details.user, '--dbname', details.database, '--no-psqlrc', '-tAc',
				// ORDINARY tables the USER made, and neither of those words is decoration.
				// `information_schema.tables` was the first version of this and it counted
				// VIEWS: a fresh hosted project carries pg_stat_statements, whose two views
				// made every brand-new database look occupied, so the guard refused exactly
				// the restore it exists to allow. Found by driving it, 2026-09-06.
				//
				// `deptype = 'e'` is the general form of the same fix: anything an extension
				// created belongs to the extension and not to the user, so pgvector's tables
				// do not count either.
				"select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace" +
					" where c.relkind = 'r' and n.nspname not in ('pg_catalog', 'information_schema')" +
					" and n.nspname not like 'pg\\_toast%'" +
					" and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e')" +
					// And not the platform's: a project with auth, storage or push on has their
					// tables, owned by those products' roles, and counting them refused every
					// restore into such a project (2026-10-02).
					" and pg_get_userbyid(c.relowner) !~ '^(snoutpod_admin|snout_[a-z]+_admin)$'"],
			{ stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: details.password, ...pgSslEnv(details.ssl) } }
		);
		let out = '';
		child.stdout.on('data', (chunk) => (out += String(chunk)));
		child.on('error', (error) => {
			warn(
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? 'psql is not installed, and db restore needs it (and pg_restore for an archive).'
					: String(error)
			);
			resolve(null);
		});
		child.on('close', (code) => resolve(code === 0 ? Number(out.trim()) || 0 : null));
	});
}

/** Which of these `schema.table` names this database does not have; null when psql could not ask. */
function missingTables(details: api.Connection, tables: readonly string[]): Promise<string[] | null> {
	if (tables.length === 0) {
		return Promise.resolve([]);
	}
	// Names from our own archive's platform schemas, quoted as literals all the same.
	const list = tables.map((table) => `'${table.replace(/'/g, "''")}'`).join(', ');
	return new Promise((resolve) => {
		const child = spawn(
			'psql',
			['--host', details.host, '--port', String(details.port), '--username', details.user, '--dbname', details.database, '--no-psqlrc', '-tAc',
				`select t from unnest(array[${list}]) t where to_regclass(t) is null`],
			{ stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: details.password, ...pgSslEnv(details.ssl) } }
		);
		let out = '';
		child.stdout.on('data', (chunk) => (out += String(chunk)));
		child.on('error', () => resolve(null));
		child.on('close', (code) => resolve(code === 0 ? out.split('\n').map((line) => line.trim()).filter(Boolean) : null));
	});
}

/** A local pg_restore that only reads the archive: its table of contents, its post-data SQL. */
function capture(tool: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(tool, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += String(chunk)));
		child.stderr.on('data', (chunk) => (stderr += String(chunk)));
		child.on('error', (error) => {
			warn((error as NodeJS.ErrnoException).code === 'ENOENT' ? `${tool} is not installed, and this dump needs it.` : String(error));
			resolve({ code: 127, stdout, stderr });
		});
		child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
	});
}

/**
 * The two passes `planRestore` asks for, each from a list of the archive's own entries: the
 * platform tables' rows first, then everything the customer owns. A failed first pass does
 * not stop the second, so the classification afterwards sees every error at once.
 */
async function runPlannedRestore(details: api.Connection, path: string, plan: RestorePlan): Promise<{ code: number; stderr: string }> {
	const lists = join(tmpdir(), `snoutdata-restore-${process.pid}-${Date.now()}`);
	let code = 0;
	let stderr = '';
	try {
		for (const { product, clear, lines } of plan.platformData) {
			// As the product's own role, which the project's owner is a member of: its tables'
			// rows and its sequences, which the owner alone may not set.
			if (clear.length > 0) {
				writeFileSync(`${lists}.sql`, `set role ${PRODUCT_ROLE[product]};\n${clear.map((table) => `delete from ${table};`).join('\n')}\n`, 'utf8');
				const emptied = await runRestore(details, 'psql', `${lists}.sql`, ['--quiet']);
				code = code || emptied.code;
				stderr += emptied.stderr;
			}
			writeFileSync(`${lists}.platform`, `${lines.join('\n')}\n`, 'utf8');
			const first = await runRestore(details, 'pg_restore', path, ['--data-only', `--role=${PRODUCT_ROLE[product]}`, `--use-list=${lists}.platform`]);
			code = code || first.code;
			stderr += first.stderr;
		}
		writeFileSync(`${lists}.rest`, `${plan.rest.join('\n')}\n`, 'utf8');
		const second = await runRestore(details, 'pg_restore', path, [`--use-list=${lists}.rest`]);
		return { code: code || second.code, stderr: stderr + second.stderr };
	} finally {
		for (const suffix of ['.platform', '.rest', '.sql']) {
			try {
				unlinkSync(`${lists}${suffix}`);
			} catch {
				// Never written, or already gone.
			}
		}
	}
}

function runRestore(details: api.Connection, tool: 'psql' | 'pg_restore', path: string, extra: string[] = []): Promise<{ code: number; stderr: string }> {
	const shared = ['--host', details.host, '--port', String(details.port), '--username', details.user, '--dbname', details.database];
	const args = tool === 'psql'
		? [...shared, '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', ...extra, '-f', path]
		// --no-owner and --no-privileges because the roles in the dump are the SOURCE
		// project's, and they do not exist here: every GRANT would fail and the owner would
		// be a role this database has never heard of.
		: [...shared, '--no-owner', '--no-privileges', ...extra, path];
	return new Promise((resolve) => {
		// stderr is piped rather than inherited so it can be CLASSIFIED afterwards, and
		// forwarded as it arrives so a long restore still shows progress. Both, not either:
		// swallowing it would hide the errors, and only inheriting it would leave nothing
		// to judge.
		const child = spawn(tool, args, {
			stdio: ['ignore', 'inherit', 'pipe'],
			env: { ...process.env, PGPASSWORD: details.password, ...pgSslEnv(details.ssl) }
		});
		let stderr = '';
		child.stderr?.on('data', (chunk) => {
			const text = String(chunk);
			stderr += text;
			process.stderr.write(text);
		});
		child.on('error', (error) => {
			warn(
				(error as NodeJS.ErrnoException).code === 'ENOENT'
					? `${tool} is not installed, and this dump needs it.`
					: String(error)
			);
			resolve({ code: 127, stderr });
		});
		child.on('close', (code) => resolve({ code: code ?? 0, stderr }));
	});
}
