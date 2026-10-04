/**
 * `realtime` without a network: reading `--since`, and the line an event becomes.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../args.js';
import { describeEvent, parseSince } from './realtime.js';

test('--since reads a duration back from now', () => {
	const now = 1_800_000_000_000;
	assert.equal(parseSince('10m', now), now - 600_000);
	assert.equal(parseSince('30s', now), now - 30_000);
	assert.equal(parseSince('2h', now), now - 7_200_000);
	assert.equal(parseSince('1d', now), now - 86_400_000);
});

test('--since reads a time', () => {
	assert.equal(parseSince('2026-10-03T14:00:00Z'), Date.parse('2026-10-03T14:00:00Z'));
});

test('--since refuses anything else as a usage error', () => {
	assert.throws(() => parseSince('yesterday-ish'), UsageError);
});

test('a disconnect says who and why', () => {
	const line = describeEvent({
		at: Date.parse('2026-10-03T14:00:05'),
		kind: 'disconnect',
		socket: 12,
		reason: 'client closed (1000: heartbeat timeout)'
	});
	assert.match(line, /disconnected/);
	assert.match(line, /socket 12/);
	assert.match(line, /heartbeat timeout\)$/);
});

test('a closed channel names the channel and the presence key', () => {
	const line = describeEvent({
		at: Date.now(),
		kind: 'channel_closed',
		socket: 3,
		channel: 'room:42',
		presence_key: 'ada',
		reason: 'Too many messages per second'
	});
	assert.match(line, /room:42/);
	assert.match(line, /ada, socket 3/);
	assert.match(line, /Too many messages per second$/);
});
