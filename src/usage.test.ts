import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { describeCompute, summariseUsage, NEAR_FRACTION, type UsageDay } from './usage.js';

const MB = 1024 * 1024;
const FREE = { tier: 'free', maxStorageBytes: 500 * MB };

function day(over: Partial<UsageDay> & { day: string }): UsageDay {
	return { dbBytes: 10 * MB, repoBytes: 5 * MB, computeSeconds: 3600, connections: 4, ...over };
}

test('nothing measured is nothing, and never a zero', () => {
	const summary = summariseUsage([], FREE);
	assert.equal(summary.days, 0);
	assert.equal(summary.latest, null);
	assert.equal(summary.peakDbBytes, null);
	assert.equal(summary.storage, null, 'with no size there is nothing to compare with the limit');
});

test('a paused day reports no size, and that must not read as the database shrinking', () => {
	// The defect this exists to prevent, in miniature: a paused pod measures nothing, and
	// treating null as 0 says the database emptied itself the moment somebody stopped using
	// it. `cloud-host-poll` shipped exactly this against a whole fleet's capacity.
	const summary = summariseUsage(
		[
			day({ day: '2026-09-01', dbBytes: 40 * MB }),
			day({ day: '2026-09-02', dbBytes: null, repoBytes: null, computeSeconds: 0, connections: 0 }),
			day({ day: '2026-09-03', dbBytes: null, repoBytes: null, computeSeconds: 0, connections: 0 })
		],
		FREE
	);
	assert.equal(summary.latest?.day, '2026-09-01');
	assert.equal(summary.latest?.dbBytes, 40 * MB);
	assert.equal(summary.peakDbBytes, 40 * MB);
	assert.equal(summary.days, 3, 'the paused days still happened');
});

test('the latest size is the latest day that HAS one, whatever order the rows arrive in', () => {
	const summary = summariseUsage(
		[
			day({ day: '2026-09-03', dbBytes: 30 * MB }),
			day({ day: '2026-09-01', dbBytes: 10 * MB }),
			day({ day: '2026-09-02', dbBytes: 20 * MB })
		],
		FREE
	);
	assert.equal(summary.latest?.dbBytes, 30 * MB);
	assert.equal(summary.peakDbBytes, 30 * MB);
});

test('the peak is the largest it has been, not the last reading', () => {
	const summary = summariseUsage(
		[day({ day: '2026-09-01', dbBytes: 90 * MB }), day({ day: '2026-09-02', dbBytes: 20 * MB })],
		FREE
	);
	assert.equal(summary.latest?.dbBytes, 20 * MB);
	assert.equal(summary.peakDbBytes, 90 * MB);
});

test('compute and connections are summed, because a day with none really had none', () => {
	const summary = summariseUsage(
		[
			day({ day: '2026-09-01', computeSeconds: 3600, connections: 10 }),
			day({ day: '2026-09-02', computeSeconds: 1800, connections: 0 }),
			day({ day: '2026-09-03', dbBytes: null, computeSeconds: 0, connections: 0 })
		],
		FREE
	);
	assert.equal(summary.computeSeconds, 5400);
	assert.equal(summary.connections, 10);
});

test('the storage state says what to do about it', () => {
	const at = (bytes: number) => summariseUsage([day({ day: '2026-09-01', dbBytes: bytes })], FREE).storage;
	assert.equal(at(100 * MB)?.state, 'ok');
	assert.equal(at(FREE.maxStorageBytes * NEAR_FRACTION)?.state, 'near');
	assert.equal(at(FREE.maxStorageBytes - 1)?.state, 'near');
	assert.equal(at(FREE.maxStorageBytes)?.state, 'over');
	assert.equal(at(FREE.maxStorageBytes * 2)?.state, 'over');
	assert.equal(at(100 * MB)?.fraction.toFixed(2), '0.20');
});

test('a plan with no limit is compared with nothing, rather than with zero', () => {
	const days = [day({ day: '2026-09-01', dbBytes: 40 * MB })];
	assert.equal(summariseUsage(days, null).storage, null);
	assert.equal(summariseUsage(days, { tier: 'x', maxStorageBytes: 0 }).storage, null);
});

test('compute time reads the way somebody would say it', () => {
	assert.equal(describeCompute(0), 'none');
	assert.equal(describeCompute(-5), 'none');
	assert.equal(describeCompute(45), '45s');
	assert.equal(describeCompute(600), '10m');
	assert.equal(describeCompute(3600), '1h');
	assert.equal(describeCompute(3600 + 900), '1h 15m');
	assert.equal(describeCompute(86_400), '1d');
	assert.equal(describeCompute(86_400 * 2 + 3600 * 3), '2d 3h');
});
