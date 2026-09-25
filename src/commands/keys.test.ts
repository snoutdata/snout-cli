/**
 * The one thing about `keys` that is worth a test without a network: the gate.
 *
 * `keys rotate` invalidates every API key the customer has pasted into a deployment, a
 * CI secret or a colleague's `.env`, and nothing can go and update them. Nothing in this
 * CLI prompts (D1), so `--force` is the only thing between an agent's typo and that, and a
 * refusal that reached the network first would already have done the damage.
 *
 * `--force` and not `--yes`: `args.ts` refuses `--yes` by name, because nothing here
 * prompts and so there is no question for a yes to answer.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../args.js';
import { setQuiet } from '../output.js';
import { rotate } from './keys.js';

// The advice lines go to stderr through `say`, which is commentary. Off, so a passing
// test run stays readable.
setQuiet(true);

test('rotate without --force refuses, and refuses as a usage error', async () => {
	await assert.rejects(
		() => rotate('abcdefghijklm', { force: false }),
		(error: unknown) => {
			// A UsageError is what `main.ts` turns into exit code 2. Any other kind would
			// exit 1 and read to a script as "the rotation failed", which is the opposite
			// of what happened.
			assert.ok(error instanceof UsageError);
			assert.match(String((error as Error).message), /--force/);
			return true;
		}
	);
});

test('the refusal happens before anything is called', async () => {
	// No credential, no `SNOUTDATA_ACCESS_TOKEN`, no server: if the gate were checked
	// after the API call this would fail with a sign-in error instead, and would have been
	// a rotation on any machine that IS signed in.
	const previous = process.env.SNOUTDATA_ACCESS_TOKEN;
	delete process.env.SNOUTDATA_ACCESS_TOKEN;
	try {
		await assert.rejects(() => rotate('abcdefghijklm', { force: false }), UsageError);
	} finally {
		if (previous !== undefined) {
			process.env.SNOUTDATA_ACCESS_TOKEN = previous;
		}
	}
});
