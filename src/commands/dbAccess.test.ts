/**
 * `db access`: the words are checked before anything is sent, and a revoke always says what it
 * does not do (a token already issued can outlive it, up to an hour).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../args.js';
import { parseArgs } from '../args.js';
import { setQuiet } from '../output.js';
import { accessCommand, parseAccess, revokeLines, tokenCommand } from './dbAccess.js';

setQuiet(true);

test('list is the default, and takes nothing', () => {
	assert.deepEqual(parseAccess([], undefined), { action: 'list' });
	assert.deepEqual(parseAccess(['list'], undefined), { action: 'list' });
	assert.throws(() => parseAccess(['list', 'x'], undefined), UsageError);
	assert.throws(() => parseAccess([], 'full'), UsageError);
});

test('grant needs an address, and a level that is full or read, read when not said', () => {
	assert.deepEqual(parseAccess(['grant', 'a@b.c'], undefined), { action: 'grant', email: 'a@b.c', level: 'read' });
	assert.deepEqual(parseAccess(['grant', 'a@b.c'], 'full'), { action: 'grant', email: 'a@b.c', level: 'full' });
	assert.throws(() => parseAccess(['grant'], undefined), /needs an email address/);
	assert.throws(() => parseAccess(['grant', 'alice'], undefined), /needs an email address/);
	assert.throws(() => parseAccess(['grant', 'a@b.c'], 'admin'), /full or read/);
	assert.throws(() => parseAccess(['grant', 'a@b.c', 'd@e.f'], undefined), UsageError);
});

test('revoke takes an address or a role, and nothing else', () => {
	assert.deepEqual(parseAccess(['revoke', 'a@b.c'], undefined), { action: 'revoke', who: 'a@b.c' });
	assert.deepEqual(parseAccess(['revoke', `oauth_${'a'.repeat(32)}`], undefined), { action: 'revoke', who: `oauth_${'a'.repeat(32)}` });
	assert.throws(() => parseAccess(['revoke'], undefined), UsageError);
	assert.throws(() => parseAccess(['revoke', 'a@b.c'], 'full'), UsageError);
	assert.throws(() => parseAccess(['remove', 'a@b.c'], undefined), /unknown command: db access remove/);
});

test('a refusal happens before anything is called', async () => {
	// No credential and no server: a check made after the call would fail with a sign-in error.
	const previous = process.env.SNOUTDATA_ACCESS_TOKEN;
	delete process.env.SNOUTDATA_ACCESS_TOKEN;
	try {
		await assert.rejects(() => accessCommand('abcdefghijklm', ['grant'], {}), UsageError);
		await assert.rejects(() => accessCommand('abcdefghijklm', ['grant', 'a@b.c'], { level: 'owner' }), UsageError);
	} finally {
		if (previous !== undefined) {
			process.env.SNOUTDATA_ACCESS_TOKEN = previous;
		}
	}
});

test('--level parses as a value', () => {
	const args = parseArgs(['db', 'access', 'grant', 'a@b.c', '--level', 'full']);
	assert.deepEqual(args.command, ['db', 'access', 'grant', 'a@b.c']);
	assert.equal(args.flags.level, 'full');
});

test('a revoke ends with the sentence about tokens already issued', () => {
	const note =
		'No new database token will be issued to them. One already issued can keep working until it expires (at most 1 hour) for as long as the database still has their role; the host removes the role and ends their sessions within seconds while the project is running, or when it next wakes if it is paused.';
	const lines = revokeLines({
		ref: 'abcdefghijklm',
		outcome: 'revoked',
		revoked: [{ email: 'a@b.c', role: `oauth_${'a'.repeat(32)}`, level: 'full' }],
		note
	});
	assert.match(lines[0]!, /Took away a@b.c's full access/);
	assert.equal(lines.at(-1), note);
});

async function withIssuer(token: string, status: number, reply: unknown, body: () => Promise<void>): Promise<{ error: unknown; asked: { url: string; auth: string | null; sent: unknown }[]; out: string }> {
	const realFetch = globalThis.fetch;
	const realToken = process.env.SNOUTDATA_ACCESS_TOKEN;
	const realOut = process.stdout.write;
	const asked: { url: string; auth: string | null; sent: unknown }[] = [];
	let out = '';
	process.env.SNOUTDATA_ACCESS_TOKEN = token;
	globalThis.fetch = (async (url: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
		asked.push({ url: String(url), auth: init?.headers?.Authorization ?? null, sent: JSON.parse(String(init?.body ?? '{}')) });
		return new Response(JSON.stringify(reply), { status });
	}) as typeof fetch;
	process.stdout.write = ((chunk: string) => {
		out += chunk;
		return true;
	}) as typeof process.stdout.write;
	try {
		const error = await body().then(() => undefined, (e: unknown) => e);
		return { error, asked, out };
	} finally {
		globalThis.fetch = realFetch;
		process.stdout.write = realOut;
		if (realToken === undefined) {
			delete process.env.SNOUTDATA_ACCESS_TOKEN;
		} else {
			process.env.SNOUTDATA_ACCESS_TOKEN = realToken;
		}
	}
}

test('db token asks the issuer with the session, and prints the token alone', async () => {
	const { error, asked, out } = await withIssuer('eyJ.session.jwt', 200, { access_token: 'eyJ.db.token', expires_in: 3600, user: 'snout_token', db_role: `oauth_${'a'.repeat(32)}` }, () => tokenCommand('b7kq2m9xt4rvz'));
	assert.equal(error, undefined);
	assert.equal(out, 'eyJ.db.token\n');
	assert.equal(asked.length, 1);
	assert.match(asked[0]!.url, /\/db\/session-token$/);
	assert.equal(asked[0]!.auth, 'Bearer eyJ.session.jwt');
	assert.deepEqual(asked[0]!.sent, { project_ref: 'b7kq2m9xt4rvz' });
});

test('db token with an access token says to sign in, and asks nobody', async () => {
	const { error, asked } = await withIssuer('sdt_script', 200, {}, () => tokenCommand('b7kq2m9xt4rvz'));
	assert.match(String((error as Error).message), /snoutdata login/);
	assert.equal(asked.length, 0);
});

test('db token passes the issuer\'s refusal on in its own words', async () => {
	const { error } = await withIssuer('eyJ.session.jwt', 403, { code: 'no_database_access', message: 'Your account has no database access to project b7kq2m9xt4rvz. Ask the project\'s owner to give you access.' }, () => tokenCommand('b7kq2m9xt4rvz'));
	assert.match(String((error as Error).message), /no database access to project b7kq2m9xt4rvz/);
});
