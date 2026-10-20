import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiError } from '../api.js';
import { UsageError } from '../args.js';
import { chooseProvider, findSource, fromDay, inGatewayWords, parseScope, priceText, rate, sameBudget, scopeText } from './ai.js';
import type { Budget, Provider } from '../shared/psyche-admin/index.ts';

function provider(name: string, kind: Provider['kind'], base_url: string): Provider {
	return { name, kind, base_url, region: null, credential: name, credential_stored: true, key: 'credential', origin: 'api', models: [], auth_header: null, problem: null };
}

function budget(over: Partial<Budget>): Budget {
	return { id: 'b', name: 'x', amount: '1', period: 'day', days: null, starts_on: null, hard: true, created_at: 0, key_id: null, every_user: false, user_id: null, group_id: null, ...over };
}

describe('ai: words', () => {
	test('a rate reads to the cent, and finer rates as given', () => {
		assert.equal(rate(1), '$1');
		assert.equal(rate(0.6), '$0.60');
		assert.equal(rate(0.15), '$0.15');
		assert.equal(rate(0.075), '$0.075');
		assert.equal(priceText({ input: 0.15, output: 0.6 }), '$0.15 in, $0.60 out');
		assert.equal(priceText(null), 'no price');
	});

	test('whom a budget is for', () => {
		assert.equal(scopeText(budget({})), 'the project');
		assert.equal(scopeText(budget({ every_user: true })), 'every user');
		assert.equal(scopeText(budget({ key_id: 'k1' })), 'key k1');
	});

	test('the last N days start N-1 days back, in UTC', () => {
		assert.equal(fromDay(1, Date.parse('2026-10-20T23:00:00Z')), '2026-10-20');
		assert.equal(fromDay(30, Date.parse('2026-10-20T01:00:00Z')), '2026-09-21');
	});
});

describe('ai: refusals in the gateway\'s words', () => {
	test('the gateway\'s nested error becomes the sentence, with its code', () => {
		const relayed = new ApiError(400, '400 Bad Request', null, { error: { message: 'The provider refused the key.', code: 'provider_auth' } });
		const said = inGatewayWords(relayed) as ApiError;
		assert.equal(said.message, 'The provider refused the key.');
		assert.equal(said.serverCode, 'provider_auth');
		assert.equal(said.status, 400);
	});

	test('the control plane\'s own sentence is left alone', () => {
		const plain = new ApiError(403, 'You may not change this project.', null, { error: 'You may not change this project.' });
		assert.equal(inGatewayWords(plain), plain);
	});
});

describe('ai models add', () => {
	test('a source is one of the guide\'s, and an unknown one says which there are', () => {
		assert.equal(findSource('openai').kind, 'openai');
		assert.throws(() => findSource('gemini'), UsageError);
		assert.throws(() => findSource(undefined), /--source/);
	});

	test('a new model goes on the provider already connected for its source', () => {
		const openai = findSource('openai');
		const providers = [provider('mine', 'openai', 'https://api.openai.com/v1'), provider('router', 'openai', 'https://openrouter.ai/api/v1')];
		assert.deepEqual(chooseProvider(openai, providers, undefined), { name: 'mine', existing: providers[0] });
	});

	test('with none connected it is a new provider under the source\'s name', () => {
		const anthropic = findSource('anthropic');
		assert.deepEqual(chooseProvider(anthropic, [], undefined), { name: 'anthropic', existing: null });
	});

	test('two connections of one source must be told apart', () => {
		const openai = findSource('openai');
		const providers = [provider('a', 'openai', 'https://api.openai.com/v1'), provider('b', 'openai', 'https://api.openai.com/v1')];
		assert.throws(() => chooseProvider(openai, providers, undefined), /--provider/);
		assert.equal(chooseProvider(openai, providers, 'b').existing, providers[1]);
	});
});

describe('ai budgets set', () => {
	test('it changes the budget of the same scope and period rather than adding one', () => {
		const budgets = [budget({ id: 'p' }), budget({ id: 'u', every_user: true }), budget({ id: 'k', key_id: 'k1' }), budget({ id: 'pm', period: 'month' })];
		assert.equal(sameBudget(budgets, 'project', 'day')?.id, 'p');
		assert.equal(sameBudget(budgets, 'users', 'day')?.id, 'u');
		assert.equal(sameBudget(budgets, 'project', 'month')?.id, 'pm');
		assert.equal(sameBudget(budgets, 'users', 'month'), undefined);
	});

	test('the scope is project or users', () => {
		assert.equal(parseScope('users'), 'users');
		assert.throws(() => parseScope('everyone'), UsageError);
	});
});
