/**
 * `snoutdata keys …` — the two API keys a project's HTTP stack is reached with.
 *
 * They come from `cloud-project-connection`, which is the same call `db url` makes: one
 * door for "what do I need to reach my project", one audit line, nothing new to sign in
 * to. So `snoutdata keys --json` in a CI job is the whole of what a deploy needs.
 *
 * Two things this file is careful about, and both are about the service_role key:
 *
 *   * **It is printed only when it is asked for.** `keys` shows both, because that is
 *     what the command is; nothing else in the CLI prints it in passing.
 *   * **What it is gets said in words, every time.** `service_role` bypasses row-level
 *     security. A key that reads every row of every table looks exactly like the other
 *     one in a terminal, and the difference is a customer's entire dataset.
 */

import { call, connection } from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, say, table } from '../output.js';

/** What a rotation returns. The signing secret itself is never sent to anybody. */
export interface RotatedKeys {
	ref: string;
	anonKey: string;
	serviceRoleKey: string;
	keysIssuedAt: string | null;
	keysExpireAt: string | null;
	breaks: string;
}

export async function show(ref: string): Promise<void> {
	const details = await connection(ref);
	emit(
		{
			ref: details.ref,
			anonKey: details.anonKey,
			serviceRoleKey: details.serviceRoleKey,
			issuedAt: details.keysIssuedAt,
			expiresAt: details.keysExpireAt
		},
		() => {
			if (!details.anonKey || !details.serviceRoleKey) {
				// Null means the secret could not be generated or read just now, which is a
				// transient failure and not a state a project stays in.
				say(`${ref} has no API keys yet. Ask again in a moment.`);
				return;
			}
			process.stdout.write(`${keyTable(details.anonKey, details.serviceRoleKey)}\n`);
			explain(details.keysIssuedAt);
		}
	);
}

/**
 * A new signing secret, and therefore two new keys.
 *
 * `--force` is required, and it is not ceremony. A password reset breaks connections that
 * reconnect, and the CLI can print the new string afterwards. This breaks every key that
 * has been pasted into a deployment, a CI secret or a colleague's `.env`, and nothing
 * here can go and update them.
 *
 * `--force` rather than `--yes` because `args.ts` refuses `--yes` by name, and says why:
 * nothing in this CLI prompts, so there is no question for a yes to answer. The flag a
 * command asks for is the one that names what it is overriding, which is how
 * `db restore --force` reads.
 */
export async function rotate(ref: string, options: { force: boolean }): Promise<void> {
	if (!options.force) {
		// Not a prompt. Nothing in this CLI prompts; a command that would have to ask names
		// the flag instead, and exits 2.
		say(`Rotating the keys for ${ref} stops every anon and service_role key already pasted anywhere.`);
		say('Anything holding one (a deployed app, a CI secret, a teammate) breaks until it is updated.');
		throw new UsageError('keys rotate needs --force, because this cannot be undone');
	}
	const result = await call<RotatedKeys>('cloud-project-rotate-jwt', { ref });
	emit(result, () => {
		process.stdout.write(`${keyTable(result.anonKey, result.serviceRoleKey)}\n`);
		say('');
		say(result.breaks);
		say(dim('  snoutdata keys --json    to read them again later'));
	});
}

function keyTable(anonKey: string, serviceRoleKey: string): string {
	return table([
		['KEY', 'VALUE'],
		['anon', anonKey],
		['service_role', serviceRoleKey]
	]);
}

function explain(issuedAt: string | null): void {
	say('');
	say(`${bold('anon')} is the public one: it goes in a browser, and row-level security decides what it reads.`);
	say(`${bold('service_role')} bypasses row-level security. Server side only, never in a client bundle.`);
	if (issuedAt) {
		say(dim(`  issued ${issuedAt.slice(0, 10)}`));
	}
}
