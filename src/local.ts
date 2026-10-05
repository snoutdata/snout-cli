/**
 * A project running in a self-hosted stack on this machine: the published snout-stack, in
 * Docker, as Studio's Projects panel sets it up or as its
 * README has somebody make it by hand.
 *
 * ## How the CLI reaches one, and why it is this
 *
 * Every project command turns a ref into connection details through ONE call
 * (`api.connection`), and that is the seam: for a local project the details come from the
 * stack folder's `.env` instead of the control plane. So `db url`, `db psql`, `db push`,
 * `gen types`, `keys` and the MCP server work against a local stack with no code of their own.
 *
 * The rules are Studio's, kept here:
 *
 * - **`.env` is the only copy of the keys.** Nothing here writes one down. The link file holds
 *   the folder; the keys are read from it on every command, so a rotated key is never stale.
 * - **Studio's list is read, never written.** `localProjects.json` in Studio's data folder holds
 *   each project's folder, ref and ports and nothing secret. It is how `link --local` finds a
 *   project by name. A folder Studio does not know (made by hand) is linked by its path.
 * - **The ref is the stack's own** (`SNOUT_REF` in `.env`). Its owner login is `<ref>_owner` on
 *   database `<ref>`, at `127.0.0.1` on `DB_PORT`, exactly what Studio's connection uses.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Connection } from './api.js';

/** One stack folder, read. */
export interface LocalStack {
	readonly folder: string;
	readonly ref: string;
	/** Studio's name for it, when Studio set it up. */
	readonly name: string | null;
	readonly apiUrl: string;
	readonly apiPort: number;
	readonly dbPort: number;
	readonly anonKey: string | null;
	readonly serviceRoleKey: string | null;
	readonly ownerPassword: string;
}

/** A row of Studio's `localProjects.json`. Nothing secret is in one. */
interface StudioRow {
	readonly name?: string;
	readonly folder?: string;
	readonly ref?: string;
}

/**
 * Where Studio keeps its list, newest-looking first: Electron's `userData` for the app named
 * `snoutdata`, then the development build's `snoutdata-dev`.
 */
export function studioListPaths(environment: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string[] {
	let base: string;
	if (platform === 'win32') {
		base = environment.APPDATA ?? join(home, 'AppData', 'Roaming');
	} else if (platform === 'darwin') {
		base = join(home, 'Library', 'Application Support');
	} else {
		base = environment.XDG_CONFIG_HOME ?? join(home, '.config');
	}
	return ['snoutdata', 'snoutdata-dev'].map((app) => join(base, app, 'localProjects.json'));
}

/** Studio's local projects, from every list that exists. A list that cannot be read is skipped. */
export function studioProjects(paths: string[] = studioListPaths()): Array<{ name: string | null; folder: string; ref: string | null }> {
	const out: Array<{ name: string | null; folder: string; ref: string | null }> = [];
	for (const path of paths) {
		if (!existsSync(path)) {
			continue;
		}
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as { projects?: StudioRow[] };
			for (const row of parsed.projects ?? []) {
				if (typeof row.folder === 'string' && row.folder && !out.some((seen) => seen.folder === row.folder)) {
					out.push({ name: row.name ?? null, folder: row.folder, ref: row.ref ?? null });
				}
			}
		} catch {
			// A half-written list (Studio saving as we read) is not a reason to fail a command.
		}
	}
	return out;
}

/** `.env`, as Compose reads it: `KEY=value`, comments and blank lines skipped, one layer of quotes off. */
export function parseEnv(text: string): Map<string, string> {
	const values = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const at = line.indexOf('=');
		if (at <= 0) {
			continue;
		}
		const key = line.slice(0, at).trim();
		let value = line.slice(at + 1).trim();
		if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
			value = value.slice(1, -1);
		}
		values.set(key, value);
	}
	return values;
}

/** Is this a stack folder at all: its compose file and its `.env` beside it. */
export function isStackFolder(folder: string): boolean {
	return existsSync(join(folder, 'compose.yaml')) && existsSync(join(folder, '.env'));
}

/**
 * Read a stack folder. Throws a sentence when it is not one, or its `.env` is missing what a
 * client needs, because "connection refused" an hour later is the worse way to learn that.
 */
export function readStack(folder: string, name: string | null = null): LocalStack {
	const where = resolve(folder);
	if (!isStackFolder(where)) {
		throw new Error(`${where} is not a SnoutData stack folder: it needs compose.yaml and .env (see github.com/snoutdata/snout-stack)`);
	}
	const env = parseEnv(readFileSync(join(where, '.env'), 'utf8'));
	const ref = env.get('SNOUT_REF');
	const ownerPassword = env.get('POSTGRES_OWNER_PASSWORD');
	if (!ref || !ownerPassword) {
		throw new Error(`${join(where, '.env')} has no ${ref ? 'POSTGRES_OWNER_PASSWORD' : 'SNOUT_REF'}, so this stack was not set up with \`snout-stack init\``);
	}
	const apiPort = Number(env.get('API_PORT') ?? 8000) || 8000;
	// compose.yaml's own defaults, for a stack made by hand whose .env names neither.
	const dbPort = Number(env.get('DB_PORT') ?? 5432) || 5432;
	return {
		folder: where,
		ref,
		name,
		// The address the stack says it answers on; the loopback default when it says nothing.
		apiUrl: (env.get('API_EXTERNAL_URL') || `http://127.0.0.1:${apiPort}`).replace(/\/$/, ''),
		apiPort,
		dbPort,
		anonKey: env.get('ANON_KEY') || null,
		serviceRoleKey: env.get('SERVICE_ROLE_KEY') || null,
		ownerPassword
	};
}

/**
 * Which local project `link --local [query]` means.
 *
 * No query: the folder we are in when it is a stack, else Studio's only project. A query: a
 * path to a stack folder, or a Studio project's name or ref. Anything ambiguous or missing is
 * a sentence naming what there is to choose from.
 */
export function findStack(query: string | undefined, cwd: string = process.cwd(), listed = studioProjects()): LocalStack {
	if (!query) {
		if (isStackFolder(cwd)) {
			return readStack(cwd);
		}
		const [only] = listed;
		if (listed.length === 1 && only) {
			return readStack(only.folder, only.name);
		}
		if (listed.length === 0) {
			throw new Error('there is no local project to link: set one up in Studio (Projects, Local), or pass the folder of a stack you made with snout-stack');
		}
		throw new Error(`there are ${listed.length} local projects; name one: ${listed.map((p) => p.name ?? p.folder).join(', ')}`);
	}
	const asPath = isAbsolute(query) ? query : resolve(cwd, query);
	if (isStackFolder(asPath)) {
		const known = listed.find((p) => resolve(p.folder) === resolve(asPath));
		return readStack(asPath, known?.name ?? null);
	}
	const wanted = query.toLowerCase();
	const matches = listed.filter((p) => p.name?.toLowerCase() === wanted || p.ref === query);
	const [match] = matches;
	if (matches.length === 1 && match) {
		return readStack(match.folder, match.name);
	}
	const names = listed.map((p) => p.name ?? p.folder);
	throw new Error(
		matches.length > 1
			? `more than one local project is called ${query}; link it by its folder`
			: `no local project called ${query}, and it is not a stack folder${names.length ? `. The local projects are ${names.join(', ')}` : ''}`
	);
}

/** The connection a command gets for a local project: Studio's own owner login. */
export function localConnection(stack: LocalStack): Connection {
	const user = `${stack.ref}_owner`;
	return {
		ref: stack.ref,
		host: '127.0.0.1',
		port: stack.dbPort,
		database: stack.ref,
		user,
		password: stack.ownerPassword,
		// A database on the loopback, which the stack's Postgres serves without TLS.
		ssl: 'disable',
		uri: `postgresql://${user}:${encodeURIComponent(stack.ownerPassword)}@127.0.0.1:${stack.dbPort}/${stack.ref}`,
		anonKey: stack.anonKey,
		serviceRoleKey: stack.serviceRoleKey,
		keysIssuedAt: null,
		keysExpireAt: null,
		wakesInstantly: true,
		state: 'local'
	};
}

/**
 * The local stack a ref names, if it names one: the folder linked here, then Studio's list.
 * Null for every cloud ref, which is the fast and common answer.
 */
export function localStackFor(ref: string, linkedFolder: string | null, listed = studioProjects()): LocalStack | null {
	if (linkedFolder && isStackFolder(linkedFolder)) {
		try {
			const known = listed.find((p) => resolve(p.folder) === resolve(linkedFolder));
			const stack = readStack(linkedFolder, known?.name ?? null);
			if (stack.ref === ref) {
				return stack;
			}
		} catch {
			// Fall through to the list.
		}
	}
	for (const project of listed) {
		if (project.ref === ref && isStackFolder(project.folder)) {
			return readStack(project.folder, project.name);
		}
	}
	return null;
}
