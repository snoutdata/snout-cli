/**
 * `snoutdata secrets …` — the environment a project's functions run with.
 *
 * `docs/cloud/STACK.md` Phase H. Every function in a project gets every secret.
 *
 * ## Nothing here ever prints a value, and that is the feature
 *
 * `list` shows names, sizes and when each was last set — enough to answer "is the thing I
 * set the thing that is there", which is the real question, and not enough to be a
 * credential exfiltration path wearing a CLI. There is no `get`, and adding one would
 * mean the control plane growing an endpoint that returns a secret, which it deliberately
 * has not got.
 *
 * ## `NAME=value` on the command line, and where that is a bad idea
 *
 * It is the form everybody expects and it puts the value in the shell's history and in
 * `ps`. `--stdin` reads the value from a pipe instead, which is what a CI job should use,
 * and the human output says so once. Not refusing the inline form: a refusal people work
 * around with `echo` is a worse outcome than a sentence they read.
 */

import { call } from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, relative, say, table } from '../output.js';
import { checkSecretName } from '../shared/snoutpod/control/functions.js';

interface StoredSecret {
	name: string;
	bytes: number | null;
	updatedAt: string | null;
}

interface SecretsAnswer {
	ref: string;
	secrets: StoredSecret[];
}

/** `NAME=value` into its two halves, keeping every `=` after the first. */
export function splitAssignment(argument: string): { name: string; value: string } | null {
	const at = argument.indexOf('=');
	if (at <= 0) {
		return null;
	}
	// The value may contain `=` — a base64 key almost always ends with one — so only the
	// FIRST separator is one.
	return { name: argument.slice(0, at), value: argument.slice(at + 1) };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	// One trailing newline removed, because `echo x | …` adds one and nobody means it.
	// Any further whitespace is left alone: a value that ends in a space is unusual and
	// is not ours to decide about.
	return Buffer.concat(chunks).toString('utf8').replace(/\n$/, '');
}

/** `NAME=value` arguments, or one NAME and a value on stdin, as pairs. Shared with the local path. */
export async function pairsFrom(assignments: readonly string[], options: { stdin: boolean }): Promise<{ name: string; value: string }[]> {
	if (assignments.length === 0) {
		throw new UsageError('secrets set needs NAME=value, or NAME with --stdin');
	}
	if (options.stdin) {
		if (assignments.length !== 1) {
			throw new UsageError('--stdin sets one secret, so it takes one NAME');
		}
		return [{ name: assignments[0] as string, value: await readStdin() }];
	}
	return assignments.map((argument) => {
		const pair = splitAssignment(argument);
		if (!pair) {
			throw new UsageError(`${argument} is not NAME=value. Use --stdin to set a value from a pipe.`);
		}
		return pair;
	});
}

export async function set(
	ref: string,
	assignments: readonly string[],
	options: { stdin: boolean }
): Promise<void> {
	if (assignments.length === 0) {
		throw new UsageError('secrets set needs NAME=value, or NAME with --stdin');
	}
	const pairs: { name: string; value: string }[] = [];
	if (options.stdin) {
		if (assignments.length !== 1) {
			throw new UsageError('--stdin sets one secret, so it takes one NAME');
		}
		pairs.push({ name: assignments[0] as string, value: await readStdin() });
	} else {
		for (const argument of assignments) {
			const pair = splitAssignment(argument);
			if (!pair) {
				throw new UsageError(`${argument} is not NAME=value. Use --stdin to set a value from a pipe.`);
			}
			pairs.push(pair);
		}
	}

	// The name rule and the reserved list, before the first request rather than one
	// refusal at a time: setting four secrets and being told about the third leaves two
	// set and two not.
	for (const pair of pairs) {
		const complaint = checkSecretName(pair.name);
		if (complaint) {
			throw new UsageError(complaint);
		}
	}

	let answer: SecretsAnswer | null = null;
	for (const pair of pairs) {
		answer = await call<SecretsAnswer>('cloud-project-secrets', {
			ref,
			action: 'set',
			name: pair.name,
			value: pair.value
		});
	}

	emit(answer, () => {
		for (const pair of pairs) {
			say(`${bold(pair.name)} set`);
		}
		say(dim('  Functions pick it up within a few seconds. Redeploying is not needed.'));
		if (!options.stdin) {
			// Once, and not as a refusal. People work around a refusal with `echo`, which
			// is the same exposure with an extra step.
			say(dim('  A value typed here is in your shell history. In CI, use: … | snoutdata secrets set NAME --stdin'));
		}
	});
}

export async function unset(ref: string, name: string): Promise<void> {
	const complaint = checkSecretName(name);
	if (complaint) {
		throw new UsageError(complaint);
	}
	const answer = await call<SecretsAnswer>('cloud-project-secrets', { ref, action: 'unset', name });
	emit(answer, () => {
		say(`${name} is gone.`);
	});
}

export async function list(ref: string): Promise<void> {
	const answer = await call<SecretsAnswer>('cloud-project-secrets', { ref });
	emit(answer, () => {
		if (answer.secrets.length === 0) {
			say(`${ref} has no function secrets.`);
			say(dim('  snoutdata secrets set STRIPE_KEY=sk_...'));
			return;
		}
		process.stdout.write(
			`${table([
				['NAME', 'SIZE', 'SET'],
				...answer.secrets.map((one) => [
					one.name,
					// The sealed length. It helps with "I set the short one by mistake" and
					// gives away nothing anybody who can set a secret does not know.
					one.bytes === null ? '-' : `${one.bytes} B`,
					relative(one.updatedAt)
				])
			])}\n`
		);
		say(dim('Values are not readable, here or anywhere. Set one again to change it.'));
	});
}
