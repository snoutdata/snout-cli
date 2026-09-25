import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { relative } from './output.js';

function at(secondsFromNow: number): string {
	return new Date(Date.now() + secondsFromNow * 1000).toISOString();
}

test('a time in the past reads as the past', () => {
	assert.equal(relative(at(-10)), 'just now');
	assert.equal(relative(at(-120)), '2 minutes ago');
	assert.equal(relative(at(-3600)), '1 hour ago');
	assert.equal(relative(at(-2 * 86400)), '2 days ago');
});

test('a time in the FUTURE reads as the future, which it did not', () => {
	// An export's download link expires in hours. `relative()` computed a negative age, fell
	// through the "under a minute" branch, and said "that link stops working just now" about
	// a link that was good until the evening. A formatter that only understands the past
	// will be handed a future date eventually, and it lies confidently rather than failing.
	assert.equal(relative(at(10)), 'in a moment');
	assert.equal(relative(at(120)), 'in 2 minutes');
	assert.equal(relative(at(2 * 3600)), 'in 2 hours');
	assert.equal(relative(at(20492)), 'in 6 hours');
});

test('nothing is never, in either direction', () => {
	assert.equal(relative(null), 'never');
});

test('one of something is singular', () => {
	assert.equal(relative(at(-60)), '1 minute ago');
	assert.equal(relative(at(60)), 'in 1 minute');
});
