/**
 * What went wrong, in a word a program can branch on.
 *
 * The CLI's README has always promised an agent four things, and one of them was that a
 * failure is legible. It was not: every failure wrote a sentence to stderr and exited 1,
 * so "the network is down", "that project does not exist", "you are over quota" and "the
 * server threw" were one outcome as far as a script could tell. An agent that cannot tell
 * those apart cannot choose between retrying, signing in again, and giving up, so it does
 * the only safe thing and stops. That single conflation is what made this CLI something a
 * person drives rather than something a program drives.
 *
 * So: **the code is the contract, and the sentence is for people.** Every failure carries
 * one of the codes below. In `--json` mode it is emitted on stdout as
 * `{ok: false, code, error}`; the human sentence still goes to stderr in both modes.
 *
 * ## Why the exit code is only a coarse index of it
 *
 * A shell has one byte and no structure, so the exit code cannot carry the whole taxonomy
 * usefully. It carries the distinctions somebody would actually branch on in a shell, and
 * `code` carries the rest. Where the two disagree in richness, `code` is the one to read.
 *
 * These numbers are free to choose today because `snoutdata` is not published to npm and
 * nothing depends on the old ones. That will not be true later, so they are written down
 * here rather than left implicit in a switch.
 */

/** Why a command failed. The value an agent branches on. */
export type FailureCode =
	/** The command line was wrong: unknown flag, missing argument, bad subcommand. */
	| 'usage'
	/** No credential, or one the server refused. Sign in again. */
	| 'not-signed-in'
	/** Signed in, and not allowed to do this. Signing in again will not help. */
	| 'forbidden'
	/** No such project, token, or team, for this account. */
	| 'not-found'
	/** It exists and is not ready yet. The one code that means "ask again shortly". */
	| 'not-ready'
	/** The state was not what the operation needed: already exists, already running. */
	| 'conflict'
	/** A plan limit stopped it. Retrying changes nothing; the plan or the size must. */
	| 'quota'
	/** We never reached the server. DNS, TLS, a proxy, no route. Retryable. */
	| 'network'
	/** We reached it and gave up waiting. Distinct from `network` on purpose: the work
	 *  may well still be happening on the other end. */
	| 'timeout'
	/** Something this command shells out to is not installed: psql, pg_restore. */
	| 'tool-missing'
	/** The server failed. Ours to fix, not the caller's. Retryable, with a delay. */
	| 'server'
	/** The operation ran and did not succeed, and none of the above describes it. */
	| 'failed';

/**
 * Exit codes, by name so nothing reads a bare number.
 *
 * 0-4 keep the meanings the README has always documented, so an existing script that
 * checks them keeps working. The rest are new and are the ones worth having in a shell.
 */
export const EXIT: Record<FailureCode | 'ok', number> = {
	ok: 0,
	failed: 1,
	usage: 2,
	'not-signed-in': 3,
	'not-ready': 4,
	forbidden: 5,
	'not-found': 6,
	conflict: 7,
	quota: 8,
	network: 9,
	timeout: 10,
	// 127 is the shell's own convention for "command not found", and somebody reading a CI
	// log knows it on sight. Worth more than a number of ours in sequence.
	'tool-missing': 127,
	server: 1
};

/**
 * A failure with a code on it.
 *
 * Thrown rather than returned, so that no command has to remember to report: `main.ts`
 * has one handler and it is the only place that writes a failure or picks an exit code.
 * Before this, six different call sites did their own `warn` and `return 1`, and four of
 * them emitted nothing at all in JSON mode.
 */
export class CliFailure extends Error {
	readonly code: FailureCode;
	/** Anything structured worth handing back: a list of refusals, a ref, a limit. */
	readonly details?: Record<string, unknown>;

	constructor(code: FailureCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = 'CliFailure';
		this.code = code;
		this.details = details;
	}

	get exitCode(): number {
		return EXIT[this.code];
	}
}

/** Shorthand, because these are thrown from everywhere. */
export function fail(code: FailureCode, message: string, details?: Record<string, unknown>): never {
	throw new CliFailure(code, message, details);
}

/**
 * An HTTP status as a failure code.
 *
 * 401 is handled before this by `NotSignedIn`, which carries the server's own words about
 * whether a token was revoked or expired. 504 is ours: it is what `waitForReady` raises
 * when it stops waiting, not something the control plane sends.
 */
export function codeForStatus(status: number): FailureCode {
	if (status === 403) {
		return 'forbidden';
	}
	if (status === 404) {
		return 'not-found';
	}
	if (status === 409) {
		return 'conflict';
	}
	if (status === 402 || status === 429) {
		return 'quota';
	}
	if (status === 503) {
		return 'not-ready';
	}
	if (status === 504) {
		return 'timeout';
	}
	if (status >= 500) {
		return 'server';
	}
	return 'failed';
}

/**
 * A file the person named that is not there, as a sentence, or null.
 *
 * `push credentials set fcm --file x.json` with a typo printed Node's own
 * `ENOENT: no such file or directory, open '<absolute path>'` and exited 1, as if the CLI had
 * broken (§3n). Every `--file`/`--p8` read goes through `readFile`, so this is decided once,
 * here, for all of them.
 */
export function missingFile(error: unknown): string | null {
	const errno = error as NodeJS.ErrnoException | null;
	if (!errno || typeof errno !== 'object' || errno.code !== 'ENOENT' || typeof errno.path !== 'string' || errno.syscall === 'spawn') {
		return null;
	}
	return `no file at ${errno.path}`;
}

/**
 * A thrown thing that is not one of ours as a failure code.
 *
 * Node reports every connection problem as a bare `TypeError: fetch failed` with the real
 * reason on `cause`, so "the network is down" arrived here indistinguishable from a bug in
 * our own code and exited 1 either way. This is what separates them.
 */
export function codeForThrown(error: unknown): FailureCode {
	const causes: unknown[] = [error];
	let cursor: unknown = error;
	for (let depth = 0; depth < 4 && cursor instanceof Error && cursor.cause; depth += 1) {
		cursor = cursor.cause;
		causes.push(cursor);
	}
	for (const one of causes) {
		const code = typeof one === 'object' && one && 'code' in one ? String((one as { code: unknown }).code) : '';
		if (NETWORK_ERRNO.has(code)) {
			return 'network';
		}
		if (code === 'ABORT_ERR' || code === 'ETIMEDOUT') {
			return 'timeout';
		}
	}
	if (error instanceof Error && /fetch failed|network|socket hang up/i.test(error.message)) {
		return 'network';
	}
	return 'failed';
}

const NETWORK_ERRNO = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EPIPE',
	'CERT_HAS_EXPIRED',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'DEPTH_ZERO_SELF_SIGNED_CERT'
]);
