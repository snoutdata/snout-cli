/**
 * Where the CLI keeps a token, and how it knows which project a folder is about.
 *
 * Two files and one environment variable, and the precedence between them is the whole
 * design:
 *
 *   1. `SNOUTDATA_ACCESS_TOKEN` — CI, and an agent that was handed a token. It wins over
 *      everything, so a script's behaviour never depends on who happens to be logged in
 *      on the machine it runs on.
 *   2. `~/.snoutdata/auth.json`, mode 0600 — what `snoutdata login` writes.
 *
 * And for the project:
 *
 *   1. `--ref`, then `SNOUTDATA_PROJECT`
 *   2. `.snoutdata/project.json` in this folder or any parent, which `snoutdata link`
 *      writes. Walking upward is what makes the CLI work from a subdirectory, the way
 *      git does, and not doing it is the single most irritating thing a project-scoped
 *      tool can get wrong.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

export interface StoredAuth {
	readonly accessToken: string;
	readonly refreshToken?: string;
	/** Seconds since the epoch, as the auth server reports it. */
	readonly expiresAt?: number;
	readonly email?: string;
	/** The account `login --email` asked for. Kept so `whoami` can say when the session is
	 *  somebody else's, which is the mistake a browser sign-in makes silently. */
	readonly expectedEmail?: string;
}

export interface LinkedProject {
	readonly ref: string;
	readonly name?: string;
	/** A local project: the stack folder its `.env` is read from (`local.ts`). Absent for a cloud one. */
	readonly local?: string;
}

export function authPath(home = homedir()): string {
	return join(home, '.snoutdata', 'auth.json');
}

export function readAuth(home = homedir()): StoredAuth | null {
	const fromEnvironment = process.env.SNOUTDATA_ACCESS_TOKEN;
	if (fromEnvironment) {
		return { accessToken: fromEnvironment };
	}
	const path = authPath(home);
	if (!existsSync(path)) {
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredAuth;
		return typeof parsed.accessToken === 'string' ? parsed : null;
	} catch {
		// A corrupt file is a logged-out machine, not a crash. `login` overwrites it.
		return null;
	}
}

export function writeAuth(auth: StoredAuth, home = homedir()): void {
	const path = authPath(home);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
	// Written again, because an existing file keeps its old mode.
	chmodSync(path, 0o600);
}

export function clearAuth(home = homedir()): void {
	rmSync(authPath(home), { force: true });
}

/**
 * Is this token worth sending?
 *
 * A minute of slack, so a token that expires mid-request is refreshed before the
 * request rather than surfacing as a confusing 401 halfway through a command.
 */
export function isExpired(auth: StoredAuth, now = Date.now()): boolean {
	if (!auth.expiresAt) {
		return false;
	}
	return auth.expiresAt * 1000 - 60_000 <= now;
}

export function linkPath(directory: string): string {
	return join(directory, '.snoutdata', 'project.json');
}

/** Walk up from `from` looking for a link, the way git looks for `.git`. */
export function findLink(from: string): { ref: string; directory: string; local?: string } | null {
	let directory = resolve(from);
	const root = parse(directory).root;
	for (;;) {
		const path = linkPath(directory);
		if (existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, 'utf8')) as LinkedProject;
				if (typeof parsed.ref === 'string' && parsed.ref) {
					return typeof parsed.local === 'string' && parsed.local
						? { ref: parsed.ref, directory, local: parsed.local }
						: { ref: parsed.ref, directory };
				}
			} catch {
				// Ignore and keep walking: a broken file in a parent must not stop a
				// good one in a grandparent from being found.
			}
		}
		if (directory === root) {
			return null;
		}
		directory = dirname(directory);
	}
}

export function writeLink(directory: string, project: LinkedProject): string {
	const path = linkPath(directory);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`);
	return path;
}

/**
 * Which project a command is about.
 *
 * Returns null rather than throwing so the caller can say something useful — "link one,
 * or pass --ref" is a better error than a stack trace, and `projects list` needs no
 * project at all.
 */
export function resolveRef(options: {
	flag?: string | undefined;
	cwd?: string;
	environment?: NodeJS.ProcessEnv;
}): string | null {
	const environment = options.environment ?? process.env;
	if (options.flag) {
		return options.flag;
	}
	if (environment.SNOUTDATA_PROJECT) {
		return environment.SNOUTDATA_PROJECT;
	}
	return findLink(options.cwd ?? process.cwd())?.ref ?? null;
}

/**
 * Where `snoutdata init` starts from: a folder already linked, a ref to link it to, a ref the
 * environment names, or nothing, which means create one.
 *
 * Kept apart from `resolveRef` because the two questions differ. `resolveRef` asks "which
 * project is this command about", and a `--ref` answers it. `init` asks "is this FOLDER
 * linked", and a `--ref` does not answer that at all: `init --ref <ref>` in a new folder said
 * "This folder is already linked", printed the URL and wrote no link, so the next `db url`
 * there exited 2 for want of a project.
 */
export type InitStart =
	/** The folder (or a parent) is linked to this project already. */
	| { readonly kind: 'linked'; readonly ref: string }
	/** `--ref` named a project the folder is not linked to: link it. `replaces` is the ref
	 *  a link here or in a parent pointed at before, if any. */
	| { readonly kind: 'link'; readonly ref: string; readonly replaces: string | null }
	/** `SNOUTDATA_PROJECT` names one. Used, and the folder is left as it is: the variable
	 *  already answers for every later command run where it is set. */
	| { readonly kind: 'environment'; readonly ref: string }
	/** Nothing names a project: make one. */
	| { readonly kind: 'create' };

export function initStart(options: {
	flag?: string | undefined;
	cwd?: string;
	environment?: NodeJS.ProcessEnv;
}): InitStart {
	const environment = options.environment ?? process.env;
	const linked = findLink(options.cwd ?? process.cwd())?.ref ?? null;
	if (options.flag) {
		return linked === options.flag ? { kind: 'linked', ref: linked } : { kind: 'link', ref: options.flag, replaces: linked };
	}
	const fromEnvironment = environment.SNOUTDATA_PROJECT;
	if (fromEnvironment) {
		return linked === fromEnvironment ? { kind: 'linked', ref: linked } : { kind: 'environment', ref: fromEnvironment };
	}
	return linked ? { kind: 'linked', ref: linked } : { kind: 'create' };
}
