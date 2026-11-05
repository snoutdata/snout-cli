/**
 * Where the CLI keeps a token, and how it knows which project a folder is about.
 *
 * Two files and one environment variable, and the precedence between them is the whole
 * design:
 *
 *   1. `SNOUTDATA_ACCESS_TOKEN` — CI, and an agent that was handed a token. It wins over
 *      everything, so a script's behaviour never depends on who happens to be logged in
 *      on the machine it runs on.
 *   2. `~/.snoutdata/auth.json`, mode 0600 — what `snoutdata login` writes. A named profile
 *      (`--profile acme`) is `~/.snoutdata/auth.acme.json` beside it, so one machine holds a
 *      session for each account and a command picks one; the default profile is `auth.json`,
 *      as before profiles existed.
 *
 * And for the profile, decided once per run (`useProfile`, from `main.ts`):
 *
 *   1. `--profile`, then `SNOUTDATA_PROFILE`
 *   2. the `profile` of the folder's link, which `snoutdata link` writes when a profile is in use
 *   3. the one `snoutdata profile use` chose for this machine (`~/.snoutdata/profile`)
 *   4. the default
 *
 * Once per run, and never per call, because a session is renewed by writing it back: the
 * renewal has to land in the file the session was read from, or one account's refresh
 * token overwrites another's.
 *
 * And for the project:
 *
 *   1. `--ref`, then `SNOUTDATA_PROJECT`
 *   2. `.snoutdata/project.json` in this folder or any parent, which `snoutdata link`
 *      writes. Walking upward is what makes the CLI work from a subdirectory, the way
 *      git does, and not doing it is the single most irritating thing a project-scoped
 *      tool can get wrong.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
	/** The profile whose session works on this project, when it is not the default one. */
	readonly profile?: string;
}

export const DEFAULT_PROFILE = 'default';

/** A profile's name is part of a file name: letters, digits, `-` and `_`, starting with a letter or digit. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

export class ProfileNameError extends Error {}

export function checkProfileName(name: string): string {
	if (!PROFILE_NAME.test(name)) {
		throw new ProfileNameError(
			`"${name}" is not a profile name: use letters, digits, - and _ (up to 40), starting with a letter or digit`
		);
	}
	return name;
}

let activeProfile = DEFAULT_PROFILE;

/** This run's profile. Set once, by `main.ts`, before any command reads a session. */
export function useProfile(name: string): void {
	activeProfile = checkProfileName(name);
}

export function currentProfile(): string {
	return activeProfile;
}

/**
 * Which profile a run uses: the flag, then `SNOUTDATA_PROFILE`, then the folder's link, then
 * the default. Pure, so its precedence is tested; `main.ts` hands the answer to `useProfile`.
 */
export function resolveProfile(options: {
	flag?: string | undefined;
	cwd?: string;
	environment?: NodeJS.ProcessEnv;
	home?: string;
}): { readonly name: string; readonly from: 'flag' | 'environment' | 'link' | 'chosen' | 'default' } {
	const environment = options.environment ?? process.env;
	if (options.flag !== undefined) {
		return { name: checkProfileName(options.flag), from: 'flag' };
	}
	if (environment.SNOUTDATA_PROFILE) {
		return { name: checkProfileName(environment.SNOUTDATA_PROFILE), from: 'environment' };
	}
	const linked = findLink(options.cwd ?? process.cwd())?.profile;
	if (linked) {
		return { name: checkProfileName(linked), from: 'link' };
	}
	const chosen = readChosenProfile(options.home);
	if (chosen) {
		return { name: chosen, from: 'chosen' };
	}
	return { name: DEFAULT_PROFILE, from: 'default' };
}

/** Where `profile use` keeps this machine's choice: one line, the profile's name. */
export function chosenProfilePath(home = homedir()): string {
	return join(home, '.snoutdata', 'profile');
}

/** The profile `profile use` chose for this machine, or null when none was (or the file is not a name). */
export function readChosenProfile(home = homedir()): string | null {
	try {
		const name = readFileSync(chosenProfilePath(home), 'utf8').trim();
		return PROFILE_NAME.test(name) ? name : null;
	} catch {
		return null;
	}
}

/**
 * `profile use NAME`: every later command on this machine signs in as NAME unless --profile,
 * SNOUTDATA_PROFILE or a folder's link says otherwise. Choosing the default forgets the choice.
 */
export function chooseProfile(name: string, home = homedir()): void {
	const path = chosenProfilePath(home);
	if (checkProfileName(name) === DEFAULT_PROFILE) {
		rmSync(path, { force: true });
		return;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${name}\n`);
}

export function authPath(home = homedir(), profile = activeProfile): string {
	return join(home, '.snoutdata', profile === DEFAULT_PROFILE ? 'auth.json' : `auth.${checkProfileName(profile)}.json`);
}

/** Every profile with a session stored on this machine, the default first. */
export function storedProfiles(home = homedir()): string[] {
	const directory = join(home, '.snoutdata');
	if (!existsSync(directory)) {
		return [];
	}
	const named = readdirSync(directory)
		.map((file) => /^auth\.(.+)\.json$/.exec(file)?.[1])
		.filter((name): name is string => name !== undefined && PROFILE_NAME.test(name) && name !== DEFAULT_PROFILE)
		.sort();
	return [...(existsSync(join(directory, 'auth.json')) ? [DEFAULT_PROFILE] : []), ...named];
}

/** The session a profile holds on disk, never the environment's token: what `whoami --all` lists. */
export function readStoredAuth(home = homedir(), profile = activeProfile): StoredAuth | null {
	const path = authPath(home, profile);
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

export function readAuth(home = homedir(), profile = activeProfile): StoredAuth | null {
	const fromEnvironment = process.env.SNOUTDATA_ACCESS_TOKEN;
	if (fromEnvironment) {
		return { accessToken: fromEnvironment };
	}
	return readStoredAuth(home, profile);
}

export function writeAuth(auth: StoredAuth, home = homedir(), profile = activeProfile): void {
	const path = authPath(home, profile);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
	// Written again, because an existing file keeps its old mode.
	chmodSync(path, 0o600);
}

export function clearAuth(home = homedir(), profile = activeProfile): void {
	rmSync(authPath(home, profile), { force: true });
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
export function findLink(from: string): { ref: string; directory: string; local?: string; profile?: string } | null {
	let directory = resolve(from);
	const root = parse(directory).root;
	for (;;) {
		const path = linkPath(directory);
		if (existsSync(path)) {
			try {
				const parsed = JSON.parse(readFileSync(path, 'utf8')) as LinkedProject;
				if (typeof parsed.ref === 'string' && parsed.ref) {
					return {
						ref: parsed.ref,
						directory,
						...(typeof parsed.local === 'string' && parsed.local ? { local: parsed.local } : {}),
						...(typeof parsed.profile === 'string' && parsed.profile ? { profile: parsed.profile } : {})
					};
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

/**
 * A link records the run's profile when it is not the default, so every later command in the
 * folder signs in as the account the project belongs to without being told again.
 */
export function writeLink(directory: string, project: LinkedProject, profile = activeProfile): string {
	const path = linkPath(directory);
	mkdirSync(dirname(path), { recursive: true });
	const written: LinkedProject = {
		ref: project.ref,
		...(project.name !== undefined ? { name: project.name } : {}),
		...(project.local !== undefined ? { local: project.local } : {}),
		...(profile !== DEFAULT_PROFILE ? { profile } : {})
	};
	writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
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
