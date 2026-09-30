/**
 * `snoutdata start` / `stop` / `status` — the same database, on this machine.
 *
 * `docs/cloud/STACK.md` S13. The pod, the egress block, the password rotation and the readiness
 * question all live in `packages/snoutpod/src/local/project.ts`, which is the harness that has
 * been running real pods since 2026-09-06, promoted out of its test tier. This file is the
 * COMMAND: where the project's identity is kept, what happens to migrations and a seed on a
 * start, and what a person or an agent is told afterwards.
 *
 * ## What a local project is
 *
 * A folder with a `.snoutdata/local.json` in it — a ref, a port and the two passwords — beside
 * the `.snoutdata/project.json` that `snoutdata link` writes for a hosted one. The two do not
 * interfere: a folder can be linked to a hosted project and have a local one at the same time,
 * which is the ordinary case (you develop against the local one and deploy to the hosted one).
 *
 * **`.snoutdata/local.json` holds a password and belongs in `.gitignore`.** It is a password for
 * a database on loopback that nothing off this machine can reach, so this is tidiness rather than
 * a vulnerability, but it is still a password and `start` says so the first time it writes one.
 *
 * ## The runtime is a seam, and this file names it
 *
 * `LocalPods` below is the whole of what a command needs from the pod runtime, and it is
 * declared HERE, by the consumer, the way `cloudApi.ts` declares what the desktop asks of the
 * cloud. `packages/snoutpod`'s `startLocal`/`stopLocal`/`localStatus` satisfy it structurally.
 * That keeps the published CLI free of a hard dependency on a private package until the two are
 * wired together, and it is what lets everything this file DECIDES be tested with a fake.
 *
 * ## Migrations
 *
 * A start applies `migrations/*.sql` and then `seed.sql`, if either is there, using the same
 * pure `planMigrations` `db push` uses — the same ledger, the same refusals, the same
 * `-- snoutdata:no-transaction` escape. There is deliberately no second planner: a local
 * database that disagreed with a hosted one about what "already applied" means would be worse
 * than no local database.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fail } from '../failure.js';
import { planMigrations, wantsTransaction, type MigrationFile } from '../migrations.js';
import { bold, dim, emit, say } from '../output.js';
import { runPsql, targetFromUrl, type Target } from './gen.js';

/** What a local project is, on disk and in every command's hands. */
export interface LocalProject {
	readonly ref: string;
	readonly port: number;
	readonly ownerPassword: string;
	readonly adminPassword: string;
}

/** What a start, a stop or a status found. Mirrors snoutpod's `LocalStatus`. */
export interface LocalStatus {
	readonly ref: string;
	readonly exists: boolean;
	readonly status: 'running' | 'stopped' | 'starting' | 'unknown' | 'absent';
	readonly ready: boolean;
	readonly hasData: boolean;
	readonly port: number;
	readonly databaseBytes: number | null;
	readonly services: readonly string[];
	readonly uri: string | null;
}

/**
 * What this command needs from the pod runtime, and nothing more.
 *
 * Declared by the consumer on purpose (see the header). The implementation is
 * `packages/snoutpod/src/local/project.ts`, which reaches Podman; everything here is decided
 * against this interface, so the decisions are provable without it.
 */
export interface LocalPods {
	/** Null when this machine can run a local project; otherwise the sentence saying why not. */
	ready(): Promise<string | null>;
	/**
	 * Make the database image exist on this machine, fetching it if it does not.
	 *
	 * Separate from {@link ready} because it can take minutes and has something to say while it
	 * does. Null when the image is there; otherwise the sentence saying why it is not.
	 */
	ensureImage(onProgress: (message: string) => void): Promise<string | null>;
	/** Make the egress-blocked network exist. Idempotent. */
	prepare(): Promise<void>;
	start(project: LocalProject, onProgress: (message: string) => void): Promise<LocalStatus>;
	stop(ref: string): Promise<LocalStatus>;
	status(project: LocalProject): Promise<LocalStatus>;
	remove(ref: string, withData: boolean): Promise<void>;
	/** The connection string for a project, which only the runtime knows how to spell. */
	uri(project: LocalProject): string;
	/** A fresh ref and fresh passwords, drawn the way the control plane draws them. */
	mint(port: number): LocalProject;
	/**
	 * Run SQL through the psql INSIDE the pod.
	 *
	 * The fallback for a machine with no psql of its own, which is every default Windows
	 * install. See `sqlRunner` below for when it is reached.
	 */
	psql(project: LocalProject, sql: string): Promise<{ code: number; out: string; err: string }>;
}

/**
 * What `packages/snoutpod/src/local/project.ts` exports, as this file needs it.
 *
 * Written out here rather than imported as a type, and that is the whole trick: the published
 * CLI is one bundled file with no dependencies, which is most of why `npx snoutdata` is quick,
 * and `@snout/snoutpod` is a private package in this repo. Naming the shape lets everything
 * below be written, typechecked and tested today, and lets the runtime be attached by a build
 * that has the package rather than by an import that would put it on the path of
 * `snoutdata whoami`.
 */
interface SnoutpodLocal {
	podmanReady(imageAdvice?: string): Promise<string | null>;
	ensureImage(onProgress?: (message: string) => void): Promise<string | null>;
	ensureNetwork(): Promise<void>;
	localRuntime(): unknown;
	startLocal(pods: unknown, project: LocalProject, options: { onProgress: (m: string) => void }): Promise<LocalStatus>;
	stopLocal(pods: unknown, ref: string): Promise<LocalStatus>;
	localStatus(pods: unknown, project: LocalProject): Promise<LocalStatus>;
	removeLocal(pods: unknown, ref: string, withData: boolean): Promise<void>;
	localUri(project: LocalProject): string;
	newLocalRef(): string;
	newLocalPassword(): string;
	localPsql(project: LocalProject, sql: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

/**
 * What `await import()` is given.
 *
 * A package name goes through untouched. A PATH does not, and that is a Windows-only
 * difference that cost a run on 2026-09-11: ESM resolves a bare absolute path on POSIX and
 * refuses `C:\…` outright, so the documented escape hatch (point SNOUTDATA_LOCAL_RUNTIME at
 * `packages/snoutpod/dist/local/project.js`) worked on the Mac and reported the runtime
 * "not available to this build" on the machine it was written for. Anything that names a file
 * becomes a `file://` URL here, so a path, a relative path and a URL all arrive the same way.
 *
 * Only ever the value somebody SET. The unset case never reaches here: it is {@link loadRuntime}
 * returning a literal, because the bundler has to be able to see it.
 */
export function runtimeSpecifier(configured: string): string {
	if (/^[a-z][a-z0-9+.-]+:/i.test(configured)) {
		// Already a URL (`file:`, and nothing else is meaningful here). Two characters before the
		// colon, not one: `C:/Users/...` is a Windows drive and not a scheme, and treating it as
		// one would hand `import()` back the string it cannot resolve.
		return configured;
	}
	if (isAbsolute(configured) || configured.startsWith('./') || configured.startsWith('../')) {
		return pathToFileURL(resolve(configured)).href;
	}
	return configured;
}

/**
 * Load the pod runtime, lazily, in a way the bundler can see.
 *
 * Two calls and not one, and the difference is the whole reason `snoutdata start` works for
 * somebody who INSTALLED the CLI rather than only for somebody standing in the checkout.
 *
 * The default is a LITERAL specifier, so esbuild resolves it at build time (through the alias in
 * `build.mjs`) and puts the runtime inside the one file `npx snoutdata` downloads. A variable
 * specifier is opaque to every bundler, which is what the old single call was: the published
 * 0.2.0 answered "the local pod runtime is not available to this build of the CLI" to every
 * `snoutdata start`, because `@snout/snoutpod` is private and is not on npm.
 *
 * It stays an `import()` rather than becoming a top-level import because the runtime does real
 * work when its module body runs — `ENGINE = resolveEngine()` walks `PATH` with `existsSync` —
 * and `snoutdata whoami` should not pay for it. esbuild keeps a dynamic import lazy inside a
 * single-file bundle (checked by hand on 2026-09-11; the build asserts that the runtime is IN
 * the file, which is the failure that matters, and does not try to assert that it stays lazy).
 *
 * `SNOUTDATA_LOCAL_RUNTIME` still wins, and it is still a real variable at run time: that is how
 * a checkout drives its own freshly built `dist/local/project.js` without installing anything.
 */
function loadRuntime(): Promise<unknown> {
	const configured = process.env.SNOUTDATA_LOCAL_RUNTIME;
	return configured ? import(runtimeSpecifier(configured)) : import('@snout/snoutpod/local');
}

/**
 * What to say when the runtime will not load, which is two different situations.
 *
 * An override that does not resolve is the caller's own path and is worth quoting back — that is
 * a typo, a stale `dist/`, or a checkout that has not been built. A DEFAULT that does not resolve
 * is a broken build of this CLI, and telling that person to "point SNOUTDATA_LOCAL_RUNTIME at
 * packages/snoutpod" sends somebody who typed `npx snoutdata start` looking for a checkout they
 * have no reason to have. Published 0.2.0 said exactly that, to everyone.
 */
export function runtimeMissing(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	const configured = process.env.SNOUTDATA_LOCAL_RUNTIME;
	if (configured) {
		return `SNOUTDATA_LOCAL_RUNTIME points at ${configured}, and it could not be loaded: ${detail}`;
	}
	return `this build of the CLI has no local pod runtime in it, so \`snoutdata start\` cannot run. That is a packaging fault rather than anything you did: please report it. (${detail})`;
}

/**
 * What to tell somebody whose machine still does not have the pod image.
 *
 * Rarely reached: `ensureImage` runs first and pulls it. This is the case where the pull did
 * not happen and the readiness check found the gap anyway, which in practice means a machine
 * that cannot reach ghcr.io. Whatever it says must not be a `cd` into this repository, which
 * is what the runtime said on its own until 2026-09-11 to people who had only ever typed
 * `npx snoutdata`.
 */
const IMAGE_ADVICE =
	'It is fetched from ghcr.io/snoutdata/snoutpod-postgres on the first `snoutdata start`, so this usually means that registry could not be reached from here.';

/** The live runtime, loaded only when a local command actually runs. */
export async function livePods(): Promise<LocalPods> {
	let mod: SnoutpodLocal;
	try {
		mod = (await loadRuntime()) as SnoutpodLocal;
	} catch (error) {
		fail(
			'tool-missing',
			runtimeMissing(error)
		);
	}
	// One runtime object per call, not per command: `localRuntime()` builds a small record of
	// closures and holds no connection, so this costs nothing and keeps each call independent.
	return {
		ready: () => mod.podmanReady(IMAGE_ADVICE),
		ensureImage: (onProgress) => mod.ensureImage(onProgress),
		prepare: () => mod.ensureNetwork(),
		start: (project, onProgress) => mod.startLocal(mod.localRuntime(), project, { onProgress }),
		stop: (ref) => mod.stopLocal(mod.localRuntime(), ref),
		status: (project) => mod.localStatus(mod.localRuntime(), project),
		remove: (ref, withData) => mod.removeLocal(mod.localRuntime(), ref, withData),
		uri: (project) => mod.localUri(project),
		psql: async (project, sql) => {
			const result = await mod.localPsql(project, sql);
			return { code: result.code, out: result.stdout, err: result.stderr };
		},
		mint: (port) => ({
			ref: mod.newLocalRef(),
			port,
			ownerPassword: mod.newLocalPassword(),
			adminPassword: mod.newLocalPassword()
		})
	};
}

/** Where a folder's local project is recorded. Beside `project.json`, not inside it. */
export function localPath(directory: string): string {
	return join(directory, '.snoutdata', 'local.json');
}

/**
 * The local project for this folder, or null.
 *
 * This folder only, unlike `findLink`, which walks up to a parent. A local database is a running
 * process on a port, and inheriting one from a parent directory is how you end up running
 * migrations from one repository against the database of another.
 */
export function readLocal(directory: string): LocalProject | null {
	const path = localPath(directory);
	if (!existsSync(path)) {
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LocalProject>;
		if (!parsed.ref || !parsed.port || !parsed.ownerPassword || !parsed.adminPassword) {
			return null;
		}
		return {
			ref: parsed.ref,
			port: parsed.port,
			ownerPassword: parsed.ownerPassword,
			adminPassword: parsed.adminPassword
		};
	} catch {
		return null;
	}
}

export function writeLocal(directory: string, project: LocalProject): string {
	const path = localPath(directory);
	mkdirSync(dirname(path), { recursive: true });
	// 0600 for the same reason `auth.json` is: it holds a password.
	writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
	return path;
}

export interface StartOptions {
	/** Where the project is recorded and where `migrations/` is looked for. Defaults to cwd. */
	readonly cwd?: string;
	/** The host port. Only read when the project is being created for the first time. */
	readonly port?: number;
	/** The migrations folder. Defaults to `migrations` beside `cwd`; missing is not an error. */
	readonly dir?: string;
	/** Skip migrations and the seed entirely. */
	readonly noMigrations?: boolean;
	/** Permit a new migration that sorts before one already applied. */
	readonly outOfOrder?: boolean;
}

/** What `start` did, as a value, so the MCP server and the tests can have it unprinted. */
export interface StartResult {
	status: LocalStatus;
	uri: string;
	/** Migrations that ran this time, in order. */
	applied: string[];
	/** True when `seed.sql` was found and run. */
	seeded: boolean;
	/** Where the project was recorded, when it was recorded for the first time. */
	created: string | null;
}

/**
 * The default port. 54322, a common choice for a local development Postgres, so a `.env` written
 * for another such tool works here, and it does not collide with a Postgres somebody has
 * installed on 5432.
 */
export const DEFAULT_PORT = 54322;

/**
 * Everything that has to be true before a local command touches a pod.
 *
 * The image is fetched BEFORE the readiness check rather than after it, because "you do not
 * have the image" is not a problem to report to somebody who only has to wait: it is a public
 * package and a pull is the answer. What `ready()` is left to report is the things a pull
 * cannot fix, above all no podman at all.
 */
async function preflight(pods: LocalPods): Promise<void> {
	const noImage = await pods.ensureImage((message) => say(message));
	if (noImage) {
		fail('tool-missing', noImage);
	}
	const why = await pods.ready();
	if (why) {
		fail('tool-missing', why);
	}
	await pods.prepare();
}

/**
 * How SQL reaches a local database, and why there are two ways.
 *
 * The host's `psql` first, because that is what every other command in this CLI uses and a
 * developer who has one is used to its version, its `.pgpass` and its output. When there is
 * none — `code: 127`, which {@link runPsql} reports for `ENOENT` and nothing else — the pod's
 * own psql runs the same SQL instead.
 *
 * **That second path is why `snoutdata start` works on Windows**, where there is no psql on a
 * default install: before 2026-09-11 the command created a database, published a port, and then
 * failed on the first migration with a sentence about `gen types`. A local project already needs
 * Podman and nothing else, so the pod's psql costs the caller nothing new.
 *
 * The decision is made ONCE per run and remembered, so a folder of twenty migrations does not
 * spawn twenty processes that are going to fail.
 */
export function sqlRunner(
	pods: LocalPods,
	project: LocalProject,
	target: Target,
	// The host psql is a seam so the CHOICE can be tested without one installed, and without
	// a test on a machine that HAS one dialling a port nothing is listening on.
	host: (target: Target, sql: string) => Promise<{ code: number; out: string; err: string }> = runPsql
): SqlRunner {
	let inPod = false;
	return async (statement) => {
		if (inPod) {
			return pods.psql(project, statement);
		}
		const result = await host(target, statement);
		if (result.code !== 127) {
			return result;
		}
		inPod = true;
		return pods.psql(project, statement);
	};
}

type SqlRunner = (sql: string) => Promise<{ code: number; out: string; err: string }>;

export async function runStart(pods: LocalPods, options: StartOptions = {}): Promise<StartResult> {
	const cwd = options.cwd ?? process.cwd();
	await preflight(pods);

	const existing = readLocal(cwd);
	const project = existing ?? pods.mint(options.port ?? DEFAULT_PORT);
	const created = existing ? null : writeLocal(cwd, project);

	const status = await pods.start(project, (message) => say(message));
	const uri = pods.uri(project);

	if (options.noMigrations) {
		return { status, uri, applied: [], seeded: false, created };
	}
	const sql = sqlRunner(pods, project, targetFromUrl(uri));
	const applied = await applyMigrations(sql, cwd, options);
	const seeded = await applySeed(sql, cwd, applied.length > 0 || Boolean(created));
	return { status, uri, applied, seeded, created };
}

/**
 * Run the folder's migrations against the local database.
 *
 * The planner is `db push`'s, unchanged and unwrapped: the same three refusals (a file that
 * changed after it ran, a file that has gone, a new file that sorts before one already applied)
 * and the same ledger table, so a migration folder means the same thing here and in the cloud.
 * The only thing local about this is where the connection comes from.
 */
async function applyMigrations(sql: SqlRunner, cwd: string, options: StartOptions): Promise<string[]> {
	const directory = resolve(
		options.dir === undefined ? join(cwd, 'migrations') : isAbsolute(options.dir) ? options.dir : join(cwd, options.dir)
	);
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		return [];
	}
	const files = readdirSync(directory)
		.filter((name) => name.endsWith('.sql'))
		.map((name) => {
			const sql = readFileSync(join(directory, name), 'utf8');
			return { name, sql, checksum: createHash('sha256').update(sql, 'utf8').digest('hex') };
		});
	if (files.length === 0) {
		return [];
	}

	const created = await sql(LEDGER_DDL);
	if (created.code !== 0) {
		fail(created.code === 127 ? 'tool-missing' : 'failed', created.err.trim() || `could not create ${LEDGER}`);
	}
	const rows = await sql(`select name || E'\\t' || checksum from ${LEDGER};`);
	if (rows.code !== 0) {
		fail('failed', rows.err.trim() || `could not read ${LEDGER}`);
	}
	const already = rows.out
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => {
			const tab = line.indexOf('\t');
			return { name: line.slice(0, tab), checksum: line.slice(tab + 1) };
		});

	const plan = planMigrations(files as readonly MigrationFile[], already, { outOfOrder: options.outOfOrder });
	if (!plan.ok) {
		fail(
			'conflict',
			`Refused. This folder and the local database do not agree:\n${plan.problems.map((one) => `  ${one.reason}`).join('\n')}`,
			{ problems: plan.problems }
		);
	}

	const byName = new Map(files.map((file) => [file.name, file]));
	const done: string[] = [];
	for (const pending of plan.pending) {
		const file = byName.get(pending.name)!;
		const ledgerRow = `insert into ${LEDGER} (name, checksum) values (${literal(file.name)}, ${literal(file.checksum)});`;
		const wrapped = wantsTransaction(file.sql);
		if (!wrapped) {
			say(`${file.name} runs outside a transaction, so an interruption can leave it half applied.`);
		}
		const script = wrapped ? `begin;\n${file.sql}\n${ledgerRow}\ncommit;\n` : `${file.sql}\n${ledgerRow}\n`;
		const result = await sql(script);
		if (result.code !== 0) {
			// Stop at the first failure: the ones after it were written expecting this one to
			// have run, and carrying on is how a half-migrated schema is made.
			fail('failed', `${file.name} failed, and nothing after it was tried.\n${result.err.trim()}`, {
				failed: file.name,
				applied: done
			});
		}
		done.push(file.name);
		say(`  applied ${file.name}`);
	}
	return done;
}

/**
 * Run `seed.sql`, if there is one.
 *
 * Only when something CHANGED — a project that was just created, or migrations that just ran.
 * A seed is almost always a pile of `insert`s, and re-running it on every `snoutdata start`
 * would double somebody's fixtures every morning. Pass nothing and re-seed by removing the
 * project, which is the honest way to get a fresh database.
 */
async function applySeed(sql: SqlRunner, cwd: string, changed: boolean): Promise<boolean> {
	const path = join(cwd, 'seed.sql');
	if (!changed || !existsSync(path)) {
		return false;
	}
	const result = await sql(readFileSync(path, 'utf8'));
	if (result.code !== 0) {
		fail('failed', `seed.sql failed.\n${result.err.trim()}`);
	}
	say('  ran seed.sql');
	return true;
}

const LEDGER = '_snoutdata_migrations';

const LEDGER_DDL = `create table if not exists ${LEDGER} (
	name text primary key,
	checksum text not null,
	applied_at timestamptz not null default now()
);`;

function literal(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

/** How big a database is, in words. Null when there is nothing running to ask. */
function size(bytes: number | null): string {
	if (bytes === null) {
		return 'unknown';
	}
	const units = ['B', 'kB', 'MB', 'GB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** `snoutdata start`. */
export async function start(pods: LocalPods, options: StartOptions = {}): Promise<number> {
	const result = await runStart(pods, options);
	emit(result, () => {
		if (result.created) {
			say('');
			say(`Wrote ${result.created}. It holds a password, so put .snoutdata/ in your .gitignore.`);
		}
		say('');
		say(`  ${bold('Database')}  running on port ${result.status.port}`);
		if (result.applied.length > 0) {
			say(`  ${bold('Migrations')}  ${result.applied.length} applied`);
		}
		if (result.seeded) {
			say(`  ${bold('Seed')}  seed.sql ran`);
		}
		say('');
		// The URI on stdout, alone, because that is the thing a script wants:
		// `DATABASE_URL=$(snoutdata start)`.
		process.stdout.write(`${result.uri}\n`);
		say(dim('  snoutdata gen types typescript --local > database.types.ts'));
		say(dim('  snoutdata stop'));
	});
	return 0;
}

/** `snoutdata stop`. */
export async function stop(pods: LocalPods, options: { cwd?: string } = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const project = readLocal(cwd);
	if (!project) {
		fail('not-found', 'there is no local database for this folder. `snoutdata start` makes one.');
	}
	await preflight(pods);
	const status = await pods.stop(project.ref);
	emit(status, () => say('Stopped. The data is still there; `snoutdata start` brings it back.'));
	return 0;
}

/** `snoutdata status`. */
export async function status(pods: LocalPods, options: { cwd?: string } = {}): Promise<number> {
	const cwd = options.cwd ?? process.cwd();
	const project = readLocal(cwd);
	if (!project) {
		// Not a failure: "there isn't one" is a perfectly good answer to "how is it".
		emit({ exists: false, ref: null, status: 'absent' }, () =>
			say('No local database for this folder. `snoutdata start` makes one.')
		);
		return 0;
	}
	const why = await pods.ready();
	if (why) {
		emit({ exists: false, ref: project.ref, status: 'unknown', reason: why }, () => say(why));
		return 0;
	}
	const found = await pods.status(project);
	emit({ ...found, uri: found.uri }, () => {
		say(`  ${bold('Project')}   ${found.ref}`);
		say(`  ${bold('State')}     ${found.ready ? 'running' : found.status}`);
		say(`  ${bold('Port')}      ${found.port}`);
		say(`  ${bold('Size')}      ${size(found.databaseBytes)}`);
		if (found.services.length > 0) {
			say(`  ${bold('Services')}  ${found.services.join(', ')}`);
		}
		if (found.uri) {
			process.stdout.write(`${found.uri}\n`);
		}
	});
	return 0;
}

/**
 * The local database as another command needs it: the URL, and how to run SQL against it.
 *
 * The URL is a URL like any other, so nothing in `gen.ts` knows a local database from a hosted
 * one.
 *
 * The runner is the same two-step `start` uses (the host psql, then the pod's), for the
 * same reason: `gen types --local` is the command `snoutdata start` prints as the next thing
 * to type, and on a machine with no psql of its own it could not run.
 */
export async function localSql(pods: LocalPods, cwd = process.cwd()): Promise<{ dbUrl: string; sql: SqlRunner }> {
	const project = readLocal(cwd);
	if (!project) {
		fail('not-found', 'there is no local database for this folder. `snoutdata start` makes one.');
	}
	const dbUrl = pods.uri(project);
	return { dbUrl, sql: sqlRunner(pods, project, targetFromUrl(dbUrl)) };
}
