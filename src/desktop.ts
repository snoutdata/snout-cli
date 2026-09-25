/**
 * The SnoutData desktop app, if it happens to be running here.
 *
 * Rung three of the auth ladder (`docs/cli/PLAN.md`, D2/D3/D8). Somebody who has the app open and
 * is signed in to it should not have to go and find a browser to use the CLI on the same
 * machine as the same account, and until now the CLI did not know the app existed.
 *
 * ## Nothing here is a discovery protocol
 *
 * The app already writes `mcp.json` into its own userData directory on every launch,
 * holding the port it bound and the bearer token that gates it, because the server walks
 * upward from 7311 and persists whichever port it got so a copied config keeps matching
 * (D8). That file is the whole mechanism. No broadcast, no scanning a port range, no
 * service record: if the file is not there, the app has never run here, and if the port
 * does not answer, it is not running now.
 *
 * ## What is asked for, and what comes back
 *
 * NOT the app's session. The app holds a real Upstream session and is therefore allowed
 * to mint (the control plane's standing rule is that a token cannot mint a token, and a
 * session is not a token). So it mints an `sdt_` named for this machine, which is
 * revocable with `snoutdata tokens revoke`, visible in `tokens list`, and lands on the
 * audit log as itself rather than as the person. Handing over the session would give this
 * process the user's whole login with no way to see it or take it back (D2).
 *
 * ## And it is a courtesy, not a lock
 *
 * The app asks its user before minting, and this asks before requesting. Both are about
 * SURPRISE. Any process running as the user can already decrypt what the app keeps in
 * `safeStorage`, because that is DPAPI or Keychain and it is user-scoped. **The sentence
 * that stays true is that the CLI does not take your session without asking. Never that it
 * could not** (D3).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

/** What the app writes, of which four fields matter here. */
export interface DesktopConfig {
	/** The master switch for the local server. Off means there is nothing to talk to. */
	enabled?: boolean;
	port?: number;
	token?: string;
	/** Whether the user has left the sign-in handoff on. Absent in files written before it existed. */
	signInHandoff?: boolean;
}

/** What the app says about itself when asked. */
export interface DesktopWho {
	signedIn: boolean;
	email: string | null;
	machine?: string;
	/** The single field to branch on: everything else is context for a message. */
	canMintToken: boolean;
	app?: { name: string; version: string };
}

/**
 * Where Electron puts userData, per platform.
 *
 * Hardcoded rather than resolved, because the CLI is not an Electron app and must not
 * take a dependency on one to find a file. `snoutdata` is `package.json`'s `name` in
 * `apps/desktop`, which is what Electron uses for the directory.
 */
function userDataDir(app: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
	if (platform === 'win32') {
		const appData = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
		return join(appData, app);
	}
	if (platform === 'darwin') {
		return join(homedir(), 'Library', 'Application Support', app);
	}
	// Electron follows XDG on Linux, and honours the override when it is set.
	return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), app);
}

/**
 * Every place a SnoutData app could have left its config, best first.
 *
 * **There are two, and missing the second is a bug this had.** `src/main/index.ts` appends
 * `-dev` to userData when it is not packaged, so a developer running the app from source
 * writes `snoutdata-dev/mcp.json` while an installed one writes `snoutdata/mcp.json`. A
 * machine can easily have both, and the stale one is often the installed app that has not
 * run for months. Looking only at the installed path meant the feature silently never
 * worked for exactly the people most likely to try it.
 *
 * Order is installed-then-dev, because a real user has only the first and a developer has
 * both; `look()` walks the list and takes the first that ANSWERS, so a stale config for an
 * app that is not running is skipped rather than being mistaken for a refusal.
 *
 * `SNOUTDATA_DESKTOP_CONFIG` overrides the lot, for any layout neither of these predicts.
 */
export function configPaths(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env
): string[] {
	if (env.SNOUTDATA_DESKTOP_CONFIG) {
		return [env.SNOUTDATA_DESKTOP_CONFIG];
	}
	return ['snoutdata', 'snoutdata-dev'].map((app) => join(userDataDir(app, platform, env), 'mcp.json'));
}

/** The installed app's path. Kept for callers that want one answer. */
export function configPath(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
	return configPaths(platform, env)[0]!;
}

/**
 * Read what the app left behind, or nothing.
 *
 * Every failure here is "no desktop", never an error: this runs on the way to a normal
 * sign-in, and a malformed file somebody hand-edited must not stop the CLI working. The
 * caller falls through to the next rung.
 */
export function readDesktopConfig(path = configPath()): DesktopConfig | null {
	if (!existsSync(path)) {
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as DesktopConfig;
		if (typeof parsed.port !== 'number' || typeof parsed.token !== 'string' || !parsed.token) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

/** Why we are not offering the desktop. Worth naming, because two of these are not "it is off". */
export type DesktopSkip =
	| 'no-config'
	| 'server-disabled'
	| 'handoff-disabled'
	| 'not-running'
	| 'signed-out'
	| 'cannot-mint';

export interface DesktopOffer {
	readonly available: true;
	readonly who: DesktopWho;
	readonly config: DesktopConfig;
}

export type DesktopLook = DesktopOffer | { readonly available: false; readonly skip: DesktopSkip };

/**
 * Decide from a config alone, before anything is dialled.
 *
 * Split out so the file-shaped half is testable without a socket, and so the two "the
 * user turned this off" cases are answered without knocking on a port at all.
 */
export function offerFromConfig(config: DesktopConfig | null): DesktopSkip | null {
	if (!config) {
		return 'no-config';
	}
	if (config.enabled === false) {
		return 'server-disabled';
	}
	// Absent means an older file, written before the handoff existed. Absent is not off:
	// the app defaults it on and writes it back, and refusing here would make an upgrade
	// look like a broken feature.
	if (config.signInHandoff === false) {
		return 'handoff-disabled';
	}
	return null;
}

/** A short timeout: the app is on loopback, so slow means absent rather than busy. */
const DIAL_MS = 1500;

/**
 * Ask every app that left a config, and take the first that answers.
 *
 * Walking the list rather than picking one is what makes a stale config harmless: an
 * installed app that has not run since June leaves a file pointing at a port nothing is
 * listening on, and the dev app running right now is the second entry.
 */
export async function look(config?: DesktopConfig | null): Promise<DesktopLook> {
	if (config !== undefined) {
		return lookAt(config);
	}
	let lastSkip: DesktopSkip = 'no-config';
	for (const path of configPaths()) {
		const found = readDesktopConfig(path);
		if (!found) {
			continue;
		}
		const result = await lookAt(found);
		if (result.available) {
			return result;
		}
		// "Switched off" and "signed out" are worth reporting over "not running": they are
		// something the person can act on, and the later candidate is usually the stale one.
		if (result.skip !== 'not-running') {
			lastSkip = result.skip;
		} else if (lastSkip === 'no-config') {
			lastSkip = result.skip;
		}
	}
	return { available: false, skip: lastSkip };
}

async function lookAt(config: DesktopConfig | null): Promise<DesktopLook> {
	const skip = offerFromConfig(config);
	if (skip) {
		return { available: false, skip };
	}
	const settled = config as DesktopConfig;
	let who: DesktopWho;
	try {
		const response = await fetch(`http://127.0.0.1:${settled.port}/cli/whoami`, {
			headers: { Authorization: `Bearer ${settled.token}` },
			signal: AbortSignal.timeout(DIAL_MS)
		});
		if (!response.ok) {
			return { available: false, skip: 'not-running' };
		}
		who = (await response.json()) as DesktopWho;
	} catch {
		// A stale port from a previous launch answers nothing, which is the same outcome
		// as the app never having run: there is nobody to ask.
		return { available: false, skip: 'not-running' };
	}
	if (!who.signedIn) {
		return { available: false, skip: 'signed-out' };
	}
	if (!who.canMintToken) {
		return { available: false, skip: 'cannot-mint' };
	}
	return { available: true, who, config: settled };
}

/**
 * Ask the app to mint a token for this machine.
 *
 * The app shows its own prompt and a person answers it, so this waits as long as the app
 * is willing to (45s at the time of writing) and reports a decline as itself rather than
 * as a failure: somebody who said "not now" has not hit an error.
 */
export async function mint(config: DesktopConfig, command: string): Promise<{ token: string; name: string } | { declined: true; reason: string }> {
	const response = await fetch(`http://127.0.0.1:${config.port}/cli/token`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ client: 'snoutdata-cli', command }),
		// Longer than the dial: there is a person reading a card on the other end of this.
		signal: AbortSignal.timeout(60_000)
	});
	const body = (await response.json().catch(() => ({}))) as {
		ok?: boolean;
		token?: string;
		name?: string;
		code?: string;
		error?: string;
	};
	if (response.ok && body.ok && body.token) {
		return { token: body.token, name: body.name ?? 'SnoutData CLI' };
	}
	return { declined: true, reason: body.error ?? `the app refused (${response.status})` };
}

/** This machine, as the prompt should name it. */
export function thisMachine(): string {
	return hostname();
}

// ---------------------------------------------------------------------------
// The app's own tools, borrowed.
// ---------------------------------------------------------------------------

/**
 * What the app exposes over `/mcp`, if it is there.
 *
 * The CLI does not reimplement any of it. `run_query` against a connection in somebody's
 * keychain is the app's job and only the app can do it: the broker resolves credentials in
 * the main process and hands out a capability, never a secret. This borrows the list and
 * forwards the calls, so one stdio endpoint covers both halves.
 */
export interface BorrowedTool {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

async function rpc(config: DesktopConfig, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
	const response = await fetch(`http://127.0.0.1:${config.port}/mcp`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${config.token}`,
			'Content-Type': 'application/json',
			Accept: 'application/json'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
		signal: AbortSignal.timeout(timeoutMs)
	});
	if (!response.ok) {
		throw new Error(`the app answered ${response.status}`);
	}
	const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
	if (body.error) {
		throw new Error(body.error.message ?? 'the app refused');
	}
	return body.result;
}

/**
 * Ask the app for its tools, once, at connect.
 *
 * **Once is not a shortcut, it is the protocol.** An MCP client is told the tool list at
 * initialize and never again, so a tool discovered later is one the agent can never learn
 * about. That is why this happens at startup and why "the app was not running when I
 * started" is a permanent answer for the life of the process rather than something to
 * retry (`docs/desktop/AGENT-HARNESS.md`).
 */
export async function borrowTools(config: DesktopConfig): Promise<BorrowedTool[]> {
	// The handshake first: the app's server expects `initialize` before it will list.
	await rpc(config, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'snoutdata-cli', version: '0' } }, 3000);
	const listed = (await rpc(config, 'tools/list', {}, 3000)) as { tools?: BorrowedTool[] };
	return listed.tools ?? [];
}

/** Forward one call to the app and hand back whatever it said. */
export async function callBorrowed(config: DesktopConfig, name: string, args: unknown): Promise<unknown> {
	// Generous: `run_query` connects a database on demand, and waking a paused one is
	// seconds. Still bounded, because a hung app must not hang the agent.
	return rpc(config, 'tools/call', { name, arguments: args }, 120_000);
}
