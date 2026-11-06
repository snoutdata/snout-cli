import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePool, poolLine } from './dbPool.js';

test('db pool takes a mode, or nothing to read it', () => {
	assert.equal(parsePool([]), undefined);
	assert.equal(parsePool(['session']), 'session');
	assert.equal(parsePool(['transaction']), 'transaction');
	assert.throws(() => parsePool(['statement']));
	assert.throws(() => parsePool(['session', 'now']));
});

test('it says what each mode means', () => {
	assert.match(poolLine({ ref: 'r', mode: 'transaction' }), /share the project's pool/);
	assert.match(poolLine({ ref: 'r', mode: 'session' }), /of its own/);
});
