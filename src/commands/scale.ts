/**
 * `snoutdata projects scale [ref] --instances N [--yes]`: run a project's app API (auth, the data API
 * and the router) on 1 to 3 instances, each on a server of its own.
 *
 * It is the dashboard's Scale (the Infrastructure page) and calls the same Snout Function,
 * `cloud-project-spread` (the internal name of the dial). The plan comes first: the function's
 * preview, which writes nothing, is printed, then the change is asked for (or taken from --yes) and
 * applied. A refusal is the control plane's own sentence, the one the dashboard shows.
 *
 * **Every sentence this command says is in SCALE_SAYS**, so a rename is one edit (Joel, 2026-10-27:
 * "scale", in "instances"; never "spread", "copies" or "replicas").
 */

import { createInterface } from 'node:readline/promises';
import { call } from '../api.js';
import { UsageError } from '../args.js';
import { CliFailure, type FailureCode } from '../failure.js';
import { canAsk } from '../interactive.js';
import { emit, say } from '../output.js';

/** What `cloud-project-spread` answers to `preview: true`. */
export interface ScalePlan {
	ref: string;
	current: number;
	most: number;
	open: boolean;
	what: string;
	copies?: number;
	outcome?: 'none' | 'apply' | 'prepare' | 'refused';
	error?: string;
	code?: string;
	message?: string;
}

export const SCALE_SAYS = {
	which: '--instances takes 1, 2 or 3',
	now: (ref: string, n: number) => `${ref} runs its app API on ${n === 1 ? '1 instance' : `${n} instances`}.`,
	most: (most: number) => (most <= 1 ? 'More than 1 instance is on the Pro and Business plans.' : `Your plan allows up to ${most} instances.`),
	notOpen: 'Scaling is not open to this account yet.',
	nothing: (ref: string) => `${ref} already runs that many instances. Nothing was changed.`,
	ask: (ref: string, n: number) => `Scale ${ref} to ${n === 1 ? '1 instance' : `${n} instances`}?`,
	noAsk: 'scaling changes where the app API runs, and nothing was asked: pass --yes to apply it',
	declined: 'Not scaled. Nothing was changed.',
	done: (ref: string, n: number) => `${ref}: its app API now runs on ${n === 1 ? '1 instance' : `${n} instances`}.`
} as const;

/** The function's refusal codes, as the CLI's exit codes (`failure.ts`). */
const REFUSED: Record<string, FailureCode> = {
	plan: 'quota',
	'not-allowed': 'forbidden',
	sharded: 'conflict',
	'not-ready': 'conflict',
	'owner-cap': 'quota',
	'too-soon': 'not-ready',
	busy: 'not-ready',
	full: 'no-capacity'
};

export function parseInstances(text: string): number {
	const n = Number(text);
	if (!/^[123]$/.test(text.trim()) || !Number.isInteger(n)) {
		throw new UsageError(SCALE_SAYS.which);
	}
	return n;
}

async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
		return answer === 'y' || answer === 'yes';
	} finally {
		rl.close();
	}
}

export async function scale(
	ref: string,
	options: { instances?: number | undefined; yes: boolean; ask?: (question: string) => Promise<boolean> }
): Promise<void> {
	if (options.instances === undefined) {
		const allows = await call<ScalePlan>('cloud-project-spread', { ref, preview: true });
		emit(allows, () => {
			say(SCALE_SAYS.now(allows.ref, allows.current));
			say(allows.what);
			say(SCALE_SAYS.most(allows.most));
			if (allows.most > allows.current && !allows.open) {
				say(SCALE_SAYS.notOpen);
			}
		});
		return;
	}
	const want = options.instances;
	// Checked before anything is asked of the server: a script with no --yes fails the same way twice.
	if (!options.yes && !options.ask && !canAsk()) {
		throw new UsageError(SCALE_SAYS.noAsk);
	}
	const plan = await call<ScalePlan>('cloud-project-spread', { ref, preview: true, instances: want });
	if (plan.outcome === 'refused') {
		throw new CliFailure(REFUSED[plan.code ?? ''] ?? 'conflict', plan.error ?? SCALE_SAYS.notOpen, { ref, instances: want, code: plan.code });
	}
	if (plan.outcome === 'none') {
		emit({ ref: plan.ref, instances: want, changed: false }, () => say(SCALE_SAYS.nothing(plan.ref)));
		return;
	}
	// The plan on stderr, so stdout stays the answer.
	process.stderr.write(`${plan.what}\n${plan.message ? `${plan.message}\n` : ''}`);
	if (!options.yes) {
		const ask = options.ask ?? confirm;
		if (!(await ask(SCALE_SAYS.ask(plan.ref, want)))) {
			throw new CliFailure('failed', SCALE_SAYS.declined);
		}
	}
	const result = await call<{ ref: string; copies: number; changed: boolean; preparing?: boolean; message?: string }>('cloud-project-spread', {
		ref,
		instances: want
	});
	emit({ ref: result.ref, instances: result.copies, changed: result.changed, ...(result.preparing ? { preparing: true, message: result.message } : {}) }, () => {
		say(SCALE_SAYS.done(result.ref, result.copies));
		if (result.message) {
			say(result.message);
		}
	});
}
