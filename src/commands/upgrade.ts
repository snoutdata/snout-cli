/**
 * `snoutdata upgrade` — the newest CLI, installed the way this one was.
 *
 * Until 0.10.2 the only way to upgrade was to know how the CLI had been installed and run that
 * again, and the refusal an old version met said only "download the latest from snoutdata.com",
 * whose home page does not show the install command. So this command works it out:
 *
 *   * a **binary** (`install.sh`, or a download) downloads the release asset for this platform,
 *     checks it against the release's SHA256SUMS exactly as install.sh does (and refuses on a
 *     mismatch), and replaces itself;
 *   * an **npm** global install runs `npm install -g snoutdata@latest`;
 *   * **npx** has nothing to upgrade, and says so: `npx snoutdata@latest` is already the newest.
 *
 * The newest version is read from the npm registry, not GitHub's API: the registry does not
 * rate-limit by IP the way GitHub's anonymous API does, and the binaries are released from the
 * same build under the same number (the release build), so the two always agree.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { CliFailure } from '../failure.js';
import { emit, say } from '../output.js';
import { INSTALL_SH, NPM_INSTALL, VERSION, installKind, olderThan, type InstallKind } from '../version.js';

const REGISTRY = process.env.SNOUTDATA_NPM_REGISTRY ?? 'https://registry.npmjs.org';
const RELEASES = 'https://github.com/snoutdata/app/releases/download';

/** The published asset for a platform, as the release build names it. Null where none is built. */
export function assetFor(platform: string, arch: string): string | null {
	const cpu = arch === 'x64' || arch === 'amd64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
	if (!cpu) {
		return null;
	}
	if (platform === 'linux' || platform === 'darwin') {
		return `snoutdata-${platform}-${cpu}`;
	}
	if (platform === 'win32' && cpu === 'x64') {
		return 'snoutdata-windows-x64.exe';
	}
	return null;
}

/** The SHA-256 SUMS line for one asset, or null. `<hex>  <name>` (two spaces) or `<hex> *<name>`. */
export function expectedSum(sums: string, asset: string): string | null {
	for (const line of sums.split(/\r?\n/)) {
		const match = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
		if (match && match[2] === asset) {
			return match[1]!.toLowerCase();
		}
	}
	return null;
}

async function latestVersion(): Promise<string> {
	let response: Response;
	try {
		response = await fetch(`${REGISTRY}/snoutdata/latest`, { headers: { accept: 'application/json' } });
	} catch (error) {
		throw new CliFailure('network', `could not reach ${REGISTRY} to find the newest version: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		throw new CliFailure('server', `${REGISTRY} answered ${response.status} when asked for the newest version`);
	}
	const body = (await response.json()) as { version?: unknown };
	if (typeof body.version !== 'string') {
		throw new CliFailure('server', `${REGISTRY} did not say which version is newest`);
	}
	return body.version;
}

async function download(url: string): Promise<Buffer> {
	let response: Response;
	try {
		response = await fetch(url);
	} catch (error) {
		throw new CliFailure('network', `could not download ${url}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) {
		throw new CliFailure('failed', `download failed (${response.status}): ${url}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

/**
 * Replace the running executable.
 *
 * POSIX: write beside it and rename over it, which is atomic and safe while it runs (the old
 * inode lives until this process exits). Windows will not let a running .exe be overwritten or
 * deleted, but it WILL let it be renamed, so the old one is moved aside to `.old` first and
 * removed on the next upgrade.
 */
function replaceExecutable(target: string, bytes: Buffer): void {
	const staged = join(dirname(target), `.snoutdata-upgrade-${process.pid}`);
	writeFileSync(staged, bytes, { mode: 0o755 });
	try {
		if (process.platform === 'win32') {
			const old = `${target}.old`;
			rmSync(old, { force: true });
			renameSync(target, old);
			try {
				renameSync(staged, target);
			} catch (error) {
				renameSync(old, target);
				throw error;
			}
		} else {
			chmodSync(staged, 0o755);
			renameSync(staged, target);
		}
	} catch (error) {
		rmSync(staged, { force: true });
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'EACCES' || code === 'EPERM') {
			throw new CliFailure('forbidden', `${target} is not writable by this user. Run the installer instead: ${process.platform === 'win32' ? NPM_INSTALL : INSTALL_SH}`);
		}
		throw error;
	}
}

function runNpm(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '-g', 'snoutdata@latest'], {
			stdio: ['ignore', 'inherit', 'inherit'],
			// npm.cmd is a batch file, and Node refuses to spawn one without a shell since the
			// April 2024 security release.
			shell: process.platform === 'win32'
		});
		child.on('error', (error) => reject(new CliFailure('tool-missing', `npm could not be run (${error.message}). Run it yourself: ${NPM_INSTALL}`)));
		child.on('exit', (code) => resolve(code ?? 1));
	});
}

export async function upgrade(options: { check?: boolean; kind?: InstallKind } = {}): Promise<number> {
	const kind = options.kind ?? installKind();
	const latest = await latestVersion();
	const behind = olderThan(VERSION, latest);
	const result = { installed: VERSION, latest, upToDate: !behind, install: kind };

	if (!behind || options.check) {
		emit({ ...result, upgraded: false }, () => {
			say(behind ? `snoutdata ${VERSION} is installed; ${latest} is the newest. \`snoutdata upgrade\` installs it.` : `snoutdata ${VERSION} is the newest version.`);
		});
		return 0;
	}

	switch (kind) {
		case 'npx':
			emit({ ...result, upgraded: false }, () => {
				say(`This is a copy npx fetched (${VERSION}). Run \`npx snoutdata@latest\` to use ${latest}; there is nothing installed to upgrade.`);
			});
			return 0;
		case 'source':
			throw new CliFailure('usage', `this snoutdata (${VERSION}) is running from source, so there is nothing to replace. Install the published one: ${process.platform === 'win32' ? NPM_INSTALL : INSTALL_SH}`);
		case 'npm': {
			say(`Upgrading snoutdata ${VERSION} to ${latest} with npm…`);
			const code = await runNpm();
			if (code !== 0) {
				throw new CliFailure('failed', `npm exited ${code}. Run it yourself: ${NPM_INSTALL}`);
			}
			emit({ ...result, upgraded: true }, () => say(`Upgraded to ${latest}.`));
			return 0;
		}
		case 'binary': {
			const asset = assetFor(process.platform, process.arch);
			if (!asset) {
				throw new CliFailure('failed', `no snoutdata binary is built for ${process.platform}-${process.arch}. Use npm: ${NPM_INSTALL}`);
			}
			say(`Downloading snoutdata ${latest} for ${process.platform}-${process.arch}…`);
			const base = `${RELEASES}/cli-v${latest}`;
			const [bytes, sums] = await Promise.all([download(`${base}/${asset}`), download(`${base}/SHA256SUMS`)]);
			const want = expectedSum(sums.toString('utf8'), asset);
			if (!want) {
				throw new CliFailure('failed', `${asset} is not listed in the release's SHA256SUMS. Refusing to install.`);
			}
			const got = createHash('sha256').update(bytes).digest('hex');
			if (got !== want) {
				throw new CliFailure('failed', `checksum mismatch for ${asset}. Refusing to install.\n  expected ${want}\n  actual   ${got}`);
			}
			replaceExecutable(process.execPath, bytes);
			emit({ ...result, upgraded: true, path: process.execPath }, () => say(`Upgraded ${process.execPath} to ${latest}.`));
			return 0;
		}
	}
}
