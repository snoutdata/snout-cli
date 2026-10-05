/**
 * Whether there is a person here, and what may be asked of them.
 *
 * This is the whole of the CLI's **no-prompt rule**, and it is small on purpose: an auth
 * ladder that can stop and ask is a good thing for somebody at a keyboard and a hang for
 * everything else, so the question "is anybody there" gets one answer, in one place, that
 * every rung consults.
 *
 * The failure it exists to prevent is not hypothetical. `snoutdata login --json` today
 * spawns a browser and blocks for five minutes while printing nothing at all, because the
 * one line that would have told you what to do goes through `say()`, which JSON mode
 * silences. That is one command. A ladder that could prompt would give that behaviour to
 * all twenty-one, at the exact moment an agent is least able to explain itself.
 *
 * **An agent must never wait on a question it cannot answer.** So the default is: unless
 * we can see a human, we fail fast with `not-signed-in` and say what would have fixed it.
 */

/** Why we may not ask. Named, because the answer is worth putting in an error message. */
export type NoHumanReason = 'not-a-tty' | 'json' | 'opted-out' | 'ci';

export interface InteractiveState {
	readonly canAsk: boolean;
	/** Absent when `canAsk`. */
	readonly reason?: NoHumanReason;
}

/**
 * The environments that say "nobody is watching" without being asked.
 *
 * `CI` is the near-universal one and the rest are the big providers, which set theirs
 * whether or not `CI` is present. This is a courtesy rather than the mechanism: a CI job
 * usually has no TTY either, so it would be caught anyway. It matters for the ones that
 * DO allocate a pseudo-terminal, where the TTY check alone would let a prompt through and
 * the job would sit there until it was killed.
 */
const CI_VARIABLES = ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD'];

export interface InteractiveInput {
	readonly isTty: boolean;
	readonly json: boolean;
	readonly env: NodeJS.ProcessEnv;
}

/**
 * Pure, so the rule can be tested without a terminal.
 *
 * Order matters only for the message somebody reads: the most specific reason wins, so
 * "you set SNOUTDATA_NO_INTERACTIVE" is preferred over "there is no terminal", which is
 * true of the same run and less useful to be told.
 */
export function interactiveState(input: InteractiveInput): InteractiveState {
	const optOut = input.env.SNOUTDATA_NO_INTERACTIVE;
	if (optOut !== undefined && optOut !== '' && optOut !== '0' && optOut !== 'false') {
		return { canAsk: false, reason: 'opted-out' };
	}
	// JSON mode before the TTY check, deliberately. Somebody piping `--json` from an
	// interactive shell is still writing a script, and a prompt in the middle of it would
	// be a surprise even though there is technically a terminal to draw it on.
	if (input.json) {
		return { canAsk: false, reason: 'json' };
	}
	for (const name of CI_VARIABLES) {
		const value = input.env[name];
		if (value !== undefined && value !== '' && value !== '0' && value !== 'false') {
			return { canAsk: false, reason: 'ci' };
		}
	}
	if (!input.isTty) {
		return { canAsk: false, reason: 'not-a-tty' };
	}
	return { canAsk: true };
}

/** What to tell somebody, or something, that we could not ask. */
export function explainNoHuman(reason: NoHumanReason): string {
	switch (reason) {
		case 'json':
			return 'running with --json, so nothing was asked';
		case 'opted-out':
			return 'SNOUTDATA_NO_INTERACTIVE is set, so nothing was asked';
		case 'ci':
			return 'this looks like CI, so nothing was asked';
		case 'not-a-tty':
			return 'there is no terminal to ask at';
	}
}

let override: InteractiveState | null = null;

/** For tests, and for `main.ts` to fix the answer once per run rather than re-deriving it. */
export function setInteractive(state: InteractiveState | null): void {
	override = state;
}

export function canAsk(): boolean {
	return (override ?? interactiveState({ isTty: Boolean(process.stdin.isTTY), json: false, env: process.env })).canAsk;
}

export function noHumanReason(): NoHumanReason | undefined {
	return (override ?? interactiveState({ isTty: Boolean(process.stdin.isTTY), json: false, env: process.env })).reason;
}
