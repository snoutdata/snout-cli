/**
 * `snoutdata db access …` — who may sign in to a project's database as THEMSELVES, with OAuth,
 * instead of with the shared project password (docs/cloud/DB-OAUTH.md, Phase 3). Postgres 18.
 *
 *   snoutdata db access [list]                   everyone with access, and their role
 *   snoutdata db access grant EMAIL [--level L]  full or read (read when not said)
 *   snoutdata db access revoke EMAIL|ROLE
 *
 * All three go through `cloud-project-db-access`, which decides (the project's owner grants and
 * revokes; anybody who can see the project lists). This file only says what came back.
 *
 * Two things it is careful about:
 *
 *   * **A grant prints the connection string on stdout, alone**, as `tokens create` prints its
 *     token, so `psql "$(snoutdata db access grant me@x.com)"` works. It carries `oauth_issuer`
 *     and `oauth_client_id`, without which libpq 18 will not try (DB-OAUTH.md, spike finding 4),
 *     and no password, because there is none.
 *   * **A revoke says what it does not do.** A token already issued can keep working until it
 *     expires, up to an hour, for as long as the database still has the role. The server's
 *     sentence is printed whole, every time, in both modes.
 */

import { call } from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, say, table, warn } from '../output.js';

export type DbAccessLevel = 'full' | 'read';

export interface DbConnection {
	host: string;
	port: number;
	database: string;
	user: string;
	oauthIssuer: string;
	oauthClientId: string;
	keywords: string;
	uri: string;
}

export interface DbAccessEntry {
	email: string;
	level: DbAccessLevel;
	means: string;
	role: string;
	you: boolean;
	grantedAt: string;
	changedAt: string;
	connection: DbConnection | null;
}

export interface DbAccessList {
	ref: string;
	enabled: boolean;
	note?: string;
	access: DbAccessEntry[];
}

export interface DbAccessGrant {
	ref: string;
	outcome: 'granted' | 'changed' | 'unchanged';
	email: string;
	level: DbAccessLevel;
	means: string | null;
	role: string;
	appliesIn: string;
	connection: DbConnection | null;
}

export interface DbAccessRevoke {
	ref: string;
	outcome: 'revoked';
	revoked: { email: string; role: string; level: DbAccessLevel }[];
	note: string;
}

/** What the words after `db access` ask for, checked before anything is sent. */
export function parseAccess(
	words: readonly string[],
	level: string | undefined
): { action: 'list' } | { action: 'grant'; email: string; level: DbAccessLevel } | { action: 'revoke'; who: string } {
	const [verb = 'list', target, ...extra] = words;
	if (extra.length > 0) {
		throw new UsageError(`db access ${verb} takes one argument, not ${1 + extra.length}`);
	}
	switch (verb) {
		case 'list':
			if (target !== undefined) {
				throw new UsageError('db access list takes no argument');
			}
			if (level !== undefined) {
				throw new UsageError('--level is for db access grant');
			}
			return { action: 'list' };
		case 'grant': {
			if (!target || !target.includes('@')) {
				throw new UsageError('db access grant needs an email address: db access grant you@example.com [--level full|read]');
			}
			const chosen = level ?? 'read';
			if (chosen !== 'full' && chosen !== 'read') {
				throw new UsageError(`--level is full or read, not ${JSON.stringify(chosen)}`);
			}
			return { action: 'grant', email: target, level: chosen };
		}
		case 'revoke':
			if (!target) {
				throw new UsageError('db access revoke needs an email address or a role name');
			}
			if (level !== undefined) {
				throw new UsageError('--level is for db access grant');
			}
			return { action: 'revoke', who: target };
		default:
			throw new UsageError(`unknown command: db access ${verb}. db access list|grant|revoke`);
	}
}

export async function accessCommand(ref: string, words: readonly string[], options: { level?: string | undefined }): Promise<void> {
	const asked = parseAccess(words, options.level);
	if (asked.action === 'list') {
		const result = await call<DbAccessList>('cloud-project-db-access', { ref, action: 'list' });
		emit(result, () => printList(result));
		return;
	}
	if (asked.action === 'grant') {
		const result = await call<DbAccessGrant>('cloud-project-db-access', {
			ref,
			action: 'grant',
			email: asked.email,
			level: asked.level
		});
		emit(result, () => printGrant(result));
		return;
	}
	const result = await call<DbAccessRevoke>('cloud-project-db-access', { ref, action: 'revoke', who: asked.who });
	emit(result, () => printRevoke(result));
}

function printList(result: DbAccessList): void {
	if (result.note) {
		say(result.note);
	}
	if (result.access.length === 0) {
		say(`Nobody signs in to ${result.ref}'s database as themselves yet. \`snoutdata db access grant you@example.com --level full\`.`);
		return;
	}
	process.stdout.write(
		`${table([
			['EMAIL', 'LEVEL', 'ROLE'],
			...result.access.map((entry) => [entry.you ? bold(entry.email) : entry.email, entry.level, entry.role])
		])}\n`
	);
	const mine = result.access.find((entry) => entry.you);
	if (mine?.connection) {
		say('');
		say('You sign in with (psql 18; a browser approves it):');
		say(dim(`  psql "${mine.connection.keywords}"`));
	}
}

function printGrant(result: DbAccessGrant): void {
	if (result.connection) {
		process.stdout.write(`${result.connection.keywords}\n`);
	}
	say('');
	const what = result.outcome === 'unchanged' ? 'already has' : 'now has';
	say(`${result.email} ${what} ${bold(result.level)} access to ${result.ref}'s database, as ${result.role}${result.means ? `: ${result.means}` : ''}.`);
	if (result.outcome !== 'unchanged') {
		say(result.appliesIn);
	}
	say('They sign in with psql 18 (libpq 18 with OAuth support) and approve the code it prints in a browser:');
	if (result.connection) {
		say(dim(`  psql "${result.connection.keywords}"`));
	}
}

/** The revoke's words, including the one sentence that must never be dropped. */
export function revokeLines(result: DbAccessRevoke): string[] {
	return [
		...result.revoked.map((gone) => `Took away ${gone.email}'s ${gone.level} access to ${result.ref}'s database (${gone.role}).`),
		result.note
	];
}

function printRevoke(result: DbAccessRevoke): void {
	const lines = revokeLines(result);
	for (const line of lines.slice(0, -1)) {
		say(line);
	}
	// Not commentary: what the revoke does NOT do yet. Printed under --quiet too.
	warn(lines[lines.length - 1]!);
}
