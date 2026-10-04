/**
 * Which CLI this is, and how it was installed.
 *
 * The version is injected by build.mjs from package.json (see main.ts for why it is never a
 * hand-kept constant). How it was installed decides what "upgrade" means, so it is worked out
 * once, here, and both `snoutdata upgrade` and every "this version is out of date" refusal
 * read the same answer. A refusal that names a command the person cannot run (npm for a
 * binary installed by `curl | sh`, or `curl | sh` on Windows) is the failure this exists to
 * stop.
 */

import { basename } from 'node:path';

declare const __SNOUTDATA_VERSION__: string | undefined;

export const VERSION = typeof __SNOUTDATA_VERSION__ === 'string' ? __SNOUTDATA_VERSION__ : 'dev';

/** What the control plane reads to know who called it (and, since 0.10.2, how old it is). */
export const CLIENT_INFO = `snoutdata-cli/${VERSION}`;

export const INSTALL_SH = 'curl -fsSL https://snoutdata.com/install.sh | sh';
export const NPM_INSTALL = 'npm install -g snoutdata@latest';

/**
 * How this copy got here.
 *
 *   * `binary`: the single executable `install.sh` (or a download) put on PATH. It runs on Bun's
 *     runtime, and it is the file at `process.execPath`.
 *   * `npx`: a throwaway copy in npm's cache. There is nothing to upgrade; `npx snoutdata@latest`
 *     fetches the newest one.
 *   * `npm`: `npm install -g`, a bundle under a global node_modules.
 *   * `source`: run from this repository (the tests, `node dist/snoutdata.mjs`).
 */
export type InstallKind = 'binary' | 'npx' | 'npm' | 'source';

export function installKind(
	facts: { bun: boolean; execPath: string; script: string } = {
		bun: typeof (process.versions as Record<string, string | undefined>).bun === 'string',
		execPath: process.execPath,
		script: process.argv[1] ?? ''
	}
): InstallKind {
	const exe = basename(facts.execPath).toLowerCase();
	if (facts.bun && exe.startsWith('snoutdata')) {
		return 'binary';
	}
	const script = facts.script.replace(/\\/g, '/');
	if (/\/_npx\//.test(script)) {
		return 'npx';
	}
	if (/\/node_modules\/snoutdata\//.test(script)) {
		return 'npm';
	}
	return 'source';
}

/** The one command that gets the newest CLI, for this installation. */
export function upgradeCommand(kind: InstallKind = installKind(), platform: string = process.platform): string {
	switch (kind) {
		case 'binary':
		case 'npm':
			return 'snoutdata upgrade';
		case 'npx':
			return 'npx snoutdata@latest';
		case 'source':
			return platform === 'win32' ? NPM_INSTALL : INSTALL_SH;
	}
}

/**
 * What to do about being out of date, as one sentence a person or an agent can act on.
 *
 * Names the version installed, the one required when the server said, and the exact commands,
 * including the ones that work with no CLI at all, since an older copy may not have `upgrade`.
 */
export function outdatedAdvice(options: { minimum?: string | null; kind?: InstallKind; platform?: string } = {}): string {
	const kind = options.kind ?? installKind();
	const platform = options.platform ?? process.platform;
	const required = options.minimum ? `${options.minimum} or later is required` : 'a newer version is required';
	const fallback = platform === 'win32' ? NPM_INSTALL : `${INSTALL_SH}  (or ${NPM_INSTALL})`;
	return `snoutdata ${VERSION} is installed and ${required}. Run \`${upgradeCommand(kind, platform)}\`, or install again: ${fallback}`;
}

/**
 * `a < b` for dotted versions. Pre-release tags are ignored: a CLI is never released as one.
 * `dev` is never older than anything, so a build from source is not told to upgrade.
 */
export function olderThan(a: string, b: string): boolean {
	if (a === 'dev' || b === 'dev') {
		return false;
	}
	const left = a.split('-')[0]!.split('.').map(Number);
	const right = b.split('-')[0]!.split('.').map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const x = left[i] ?? 0;
		const y = right[i] ?? 0;
		if (Number.isNaN(x) || Number.isNaN(y)) {
			return false;
		}
		if (x !== y) {
			return x < y;
		}
	}
	return false;
}
