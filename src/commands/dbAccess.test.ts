/**
 * `db access`: the words are checked before anything is sent, and a revoke always says what it
 * does not do (a token already issued can outlive it, up to an hour).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../args.js';
import { parseArgs } from '../args.js';
import { setQuiet } from '../output.js';
import { accessCommand, parseAccess, revokeLines } from './dbAccess.js';

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
