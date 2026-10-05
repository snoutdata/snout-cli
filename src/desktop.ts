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
 * NOT the app's session. The app holds a real session and is therefore allowed
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

import { execFile } from 'node:child_process';
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
 * Every place SnoutData Studio could have left its config, best first.
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
	| 'not-verified'
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

// ---------------------------------------------------------------------------
// Who holds the port, before the bearer is sent to it.
// ---------------------------------------------------------------------------

/**
 * Whether the socket listening on `127.0.0.1:<port>` belongs to this user.
 *
 * **The bearer in `mcp.json` is long-lived, and a loopback port is not per-user.** Another
 * account on the same machine can bind the port while the app is closed, so sending the
 * token to "whatever answers" hands it to them, and lets them answer `whoami` and
 * `/cli/token` as they like (audit 14-A). The app offers no way to prove it holds the
 * token without being sent it, so the proof here is the operating system's: the listener
 * must be a process of ours. The app binds exactly `127.0.0.1` (`mcpServer.ts` HOST), and
 * only one socket can hold that address and port, so "ours listens there" is the check.
 *
 * Every failure to find out is a NO: the token is not sent, and the caller treats the app
 * as absent, which is the same outcome as it not running.
 */
export type PeerCheck = (port: number) => Promise<boolean>;

/** `/proc/net/tcp` (Linux): the uids of LISTEN sockets on exactly 127.0.0.1:<port>. */
export function procNetListenerUids(table: string, port: number): number[] {
	const want = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
	const uids: number[] = [];
	for (const line of table.split('\n').slice(1)) {
		const cols = line.trim().split(/\s+/);
		// sl, local_address, rem_address, st, tx:rx, tr:when, retrnsmt, uid, ...
		if (cols.length > 7 && cols[1]?.toUpperCase() === want && cols[3] === '0A') {
			uids.push(Number(cols[7]));
		}
	}
	return uids;
}

/** `lsof -F n` restricted to our uid (macOS): did any of our processes list the address. */
export function lsofListsAddress(output: string, port: number): boolean {
	return output.split('\n').some((line) => line.trim() === `n127.0.0.1:${port}`);
}

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 5000, windowsHide: true }, (error, stdout) => {
			// lsof exits 1 when it found nothing, which is an answer ("not ours"), not a fault.
			resolve(error && !stdout ? '' : String(stdout));
		});
	});
}

/** The real check, per platform. Unknown platforms are a NO. */
export async function listenerIsMine(port: number, platform: NodeJS.Platform = process.platform): Promise<boolean> {
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		return false;
	}
	try {
		if (platform === 'linux') {
			const uid = process.getuid?.();
			if (uid === undefined) {
				return false;
			}
			const uids = procNetListenerUids(readFileSync('/proc/net/tcp', 'utf8'), port);
			return uids.length > 0 && uids.every((owner) => owner === uid);
		}
		if (platform === 'darwin') {
			const uid = process.getuid?.();
			if (uid === undefined) {
				return false;
			}
			// -a ANDs the selections: a LISTEN socket on exactly this address, held by a
			// process of this uid. Another user's process is never listed.
			const out = await run('/usr/sbin/lsof', ['-nP', '-a', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-u', String(uid), '-Fn']);
			return lsofListsAddress(out, port);
		}
		if (platform === 'win32') {
			// The listener's owning process, and that process's owner, against ours. A process
			// of another user answers GetOwner with access denied (ReturnValue 2), which is a NO.
			const script = [
				`$c = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1`,
				'$p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction Stop',
				'$o = Invoke-CimMethod -InputObject $p -MethodName GetOwner -ErrorAction Stop',
				'$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name',
				'if ($o.ReturnValue -eq 0 -and ("$($o.Domain)\\$($o.User)" -ieq $me)) { "mine" } else { "other" }'
			].join('; ');
			const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
			return out.trim() === 'mine';
		}
	} catch {
		return false;
	}
	return false;
}

/** A yes is remembered briefly, so a run of tool calls does not ask the OS each time. */
const VERIFIED_MS = 10_000;
const verified = new Map<number, number>();

async function verifyPeer(port: number, check: PeerCheck): Promise<boolean> {
	const at = verified.get(port);
	if (at !== undefined && Date.now() - at < VERIFIED_MS) {
		return true;
	}
	const mine = await check(port).catch(() => false);
	if (mine) {
		verified.set(port, Date.now());
	} else {
		verified.delete(port);
	}
	return mine;
}

/** The one way a request carrying the app's bearer leaves this process. */
async function dial(config: DesktopConfig, path: string, init: RequestInit, check: PeerCheck = listenerIsMine): Promise<Response> {
	if (!(await verifyPeer(config.port as number, check))) {
		throw new PeerNotVerified(config.port as number);
	}
	return fetch(`http://127.0.0.1:${config.port}${path}`, {
		...init,
		headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${config.token}` }
	});
}

export class PeerNotVerified extends Error {
	constructor(port: number) {
		super(`the process on 127.0.0.1:${port} is not one of this user's, so SnoutData Studio's token was not sent to it`);
		this.name = 'PeerNotVerified';
	}
}

/**
 * Ask every app that left a config, and take the first that answers.
 *
 * Walking the list rather than picking one is what makes a stale config harmless: an
 * installed app that has not run since June leaves a file pointing at a port nothing is
 * listening on, and the dev app running right now is the second entry.
 */
export async function look(config?: DesktopConfig | null, check: PeerCheck = listenerIsMine): Promise<DesktopLook> {
	if (config !== undefined) {
		return lookAt(config, check);
	}
	let lastSkip: DesktopSkip = 'no-config';
	for (const path of configPaths()) {
		const found = readDesktopConfig(path);
		if (!found) {
			continue;
		}
		const result = await lookAt(found, check);
		if (result.available) {
			return result;
		}
		// "Switched off" and "signed out" are worth reporting over "not running": they are
		// something the person can act on, and the later candidate is usually the stale one.
		if (result.skip !== 'not-running' && result.skip !== 'not-verified') {
			lastSkip = result.skip;
		} else if (lastSkip === 'no-config') {
			lastSkip = result.skip;
		}
	}
	return { available: false, skip: lastSkip };
}

async function lookAt(config: DesktopConfig | null, check: PeerCheck): Promise<DesktopLook> {
	const skip = offerFromConfig(config);
	if (skip) {
		return { available: false, skip };
	}
	const settled = config as DesktopConfig;
	if (!(await verifyPeer(settled.port as number, check))) {
		// Nothing of ours is listening there: either the app is closed, or somebody else holds
		// the port. Either way the token stays here.
		return { available: false, skip: 'not-verified' };
	}
	let who: DesktopWho;
	try {
		const response = await dial(settled, '/cli/whoami', { signal: AbortSignal.timeout(DIAL_MS) }, check);
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
	const response = await dial(config, '/cli/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
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
	return { declined: true, reason: body.error ?? `SnoutData Studio refused (${response.status})` };
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
	const response = await dial(config, '/mcp', {
		method: 'POST',
		headers: {
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
		throw new Error(body.error.message ?? 'SnoutData Studio refused');
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
