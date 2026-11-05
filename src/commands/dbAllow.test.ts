/**
 * `db allow`: the words are checked before anything is sent, and the caller hears when the list
 * leaves out the address they are calling from.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../args.js';
import { addressWarning, outcomeLine, parseAllow } from './dbAllow.js';

test('the words are checked before anything is sent', () => {
	assert.deepEqual(parseAllow([], undefined), { action: 'list' });
	assert.deepEqual(parseAllow(['list'], undefined), { action: 'list' });
	assert.deepEqual(parseAllow(['add', '203.0.113.0/24'], 'office'), { action: 'add', cidr: '203.0.113.0/24', note: 'office' });
	assert.deepEqual(parseAllow(['remove', '2001:db8::/48'], undefined), { action: 'remove', cidr: '2001:db8::/48' });
	assert.deepEqual(parseAllow(['clear'], undefined), { action: 'clear' });
	assert.throws(() => parseAllow(['add'], undefined), UsageError);
	assert.throws(() => parseAllow(['remove'], undefined), UsageError);
	assert.throws(() => parseAllow(['clear', 'x'], undefined), UsageError);
	assert.throws(() => parseAllow(['add', 'a', 'b'], undefined), UsageError);
	assert.throws(() => parseAllow(['remove', 'a'], 'note'), UsageError);
	assert.throws(() => parseAllow(['drop'], undefined), UsageError);
});

test('a list that leaves out the caller says so, with the command that fixes it', () => {
	const entries = [{ cidr: '203.0.113.0/24', note: null, addedAt: '2026-11-04T00:00:00Z' }];
	const said = addressWarning({ entries, yourAddress: '198.51.100.7', yourAddressListed: false });
	assert.match(said ?? '', /198\.51\.100\.7/);
	assert.match(said ?? '', /snoutdata db allow add 198\.51\.100\.7/);
	assert.equal(addressWarning({ entries, yourAddress: '203.0.113.4', yourAddressListed: true }), null);
	assert.equal(addressWarning({ entries: [], yourAddress: '198.51.100.7', yourAddressListed: true }), null);
	// Not known is not said: only a list known to leave the caller out warns.
	assert.equal(addressWarning({ entries, yourAddress: null, yourAddressListed: null }), null);
});

test('each change is a sentence', () => {
	const base = { ref: 'abc', entries: [], limit: 50, yourAddress: null, yourAddressListed: true };
	assert.equal(outcomeLine({ ...base, outcome: 'added', cidr: '203.0.113.4/32' }), "Added 203.0.113.4/32 to abc's allow-list.");
	assert.match(outcomeLine({ ...base, outcome: 'cleared', cidr: null }) ?? '', /every address/);
	assert.equal(outcomeLine({ ...base }), null);
});
