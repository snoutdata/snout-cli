/**
 * `snoutdata tokens …` — the credential a cron job holds.
 *
 * `snoutdata login` writes a session, which lasts an hour. That is right for a
 * terminal and useless for CI, so this is the other half: a token that does not expire,
 * made once at a keyboard, pasted into a secret, and read from
 * `SNOUTDATA_ACCESS_TOKEN` by every command afterwards.
 *
 * Two things this file is careful about, and both are about the moment of creation:
 *
 *   * **The token is printed on stdout, alone.** In `--json` mode it is one field of one
 *     object, and in human mode it is one line with nothing around it, so
 *     `SNOUTDATA_ACCESS_TOKEN=$(snoutdata tokens create --name ci)` is correct with no
 *     `grep`. Everything explanatory goes to stderr, as everywhere else.
 *   * **It says, once, that this is the only time.** Only the hash is stored, so there
 *     is no second call that returns it, and a person who closes the terminal has lost
 *     it. Better to be told than to find out.
 */

import { call } from '../api.js';
import { bold, dim, emit, relative, say, table } from '../output.js';

export interface AccessToken {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	lastUsedAt: string | null;
	expiresAt: string | null;
	revokedAt: string | null;
	live: boolean;
	current: boolean;
	/** The one project it reaches; null for the whole account. */
	project: string | null;
}

export async function create(options: {
	name: string;
	expiresInDays?: number | undefined;
	project?: string | undefined;
}): Promise<void> {
	const created = await call<{
		token: string;
		id: string;
		name: string;
		prefix: string;
		createdAt: string;
		expiresAt: string | null;
		project: string | null;
	}>('cloud-token-create', {
		name: options.name,
		expiresInDays: options.expiresInDays,
		...(options.project ? { project: options.project } : {})
	});

	emit(created, () => {
		process.stdout.write(`${created.token}\n`);
		say('');
		say(`${bold(created.name)} — ${created.expiresAt ? `expires ${created.expiresAt.slice(0, 10)}` : 'does not expire'}.`);
		say(created.project ? `Reaches project ${created.project} only.` : 'Reaches every project on this account.');
		say('This is the only time it is shown: only its hash is stored.');
		say(dim('  export SNOUTDATA_ACCESS_TOKEN=<that token>'));
	});
}

export async function list(): Promise<void> {
	const { tokens } = await call<{ tokens: AccessToken[] }>('cloud-token-list');
	emit({ tokens }, () => {
		if (tokens.length === 0) {
			say('No access tokens. `snoutdata tokens create --name ci`.');
			return;
		}
		process.stdout.write(
			`${table([
				['PREFIX', 'NAME', 'PROJECT', 'STATE', 'LAST USED', 'EXPIRES'],
				...tokens.map((t) => [
					t.current ? bold(t.prefix) : t.prefix,
					t.name,
					t.project ?? 'all',
					t.revokedAt ? 'revoked' : t.live ? 'live' : 'expired',
					relative(t.lastUsedAt),
					t.expiresAt ? t.expiresAt.slice(0, 10) : 'never'
				])
			])}\n`
		);
	});
}

export async function revoke(wanted: string): Promise<void> {
	// Either an id or a prefix, because the prefix is what a person can see in the list
	// and the id is what a script has. The server refuses an ambiguous prefix rather
	// than picking one.
	const body = wanted.startsWith('sdt_') ? { prefix: wanted } : { id: wanted };
	const result = await call<{
		token: { id: string; name: string; prefix: string; revokedAt: string };
		changed: boolean;
	}>('cloud-token-revoke', body);
	emit(result, () => {
		say(
			result.changed
				? `Revoked ${result.token.prefix} (${result.token.name}).`
				: `${result.token.prefix} was already revoked.`
		);
	});
}
