/**
 * `projects scale`: the plan first, asked or --yes, the control plane's refusal as it is, and words
 * that say scale and instances.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UsageError } from '../args.js';
import { CliFailure } from '../failure.js';
import { parseInstances, scale, SCALE_SAYS } from './scale.js';

/** Run `body` against a control plane that answers each call with `reply(body)`; what was asked comes back too. */
async function against<T>(reply: (body: Record<string, unknown>) => unknown, body: () => Promise<T>): Promise<{ result: T | unknown; asked: Record<string, unknown>[] }> {
	const realFetch = globalThis.fetch;
	const realToken = process.env.SNOUTDATA_ACCESS_TOKEN;
	const realOut = process.stdout.write;
	const realErr = process.stderr.write;
	const asked: Record<string, unknown>[] = [];
	process.env.SNOUTDATA_ACCESS_TOKEN = 'sdt_test';
	globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
		const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
		asked.push(sent);
		return new Response(JSON.stringify(reply(sent)), { status: 200 });
	}) as typeof fetch;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	process.stderr.write = (() => true) as typeof process.stderr.write;
	try {
		return { result: await body().catch((e: unknown) => e), asked };
	} finally {
		globalThis.fetch = realFetch;
		process.stdout.write = realOut;
		process.stderr.write = realErr;
		if (realToken === undefined) {
			delete process.env.SNOUTDATA_ACCESS_TOKEN;
		} else {
			process.env.SNOUTDATA_ACCESS_TOKEN = realToken;
		}
	}
}

const PLAN = { ref: 'b7kq2m9xt4rvz', current: 1, most: 2, open: true, copies: 2, what: 'what it does', outcome: 'apply' };
const DONE = { ref: 'b7kq2m9xt4rvz', copies: 2, changed: true };
const reply = (plan: unknown) => (sent: Record<string, unknown>) => (sent.preview ? plan : DONE);

test('--instances takes 1, 2 or 3', () => {
	assert.equal(parseInstances('2'), 2);
	assert.throws(() => parseInstances('4'), UsageError);
	assert.throws(() => parseInstances('two'), UsageError);
});

test('the words say scale and instances, never the internal ones', () => {
	const all = [
		SCALE_SAYS.which, SCALE_SAYS.now('r', 1), SCALE_SAYS.now('r', 2), SCALE_SAYS.most(1), SCALE_SAYS.most(3), SCALE_SAYS.notOpen,
		SCALE_SAYS.nothing('r'), SCALE_SAYS.ask('r', 2), SCALE_SAYS.noAsk, SCALE_SAYS.declined, SCALE_SAYS.done('r', 2)
	];
	for (const line of all) {
		assert.ok(!/spread|cop(y|ies)|replica/i.test(line), line);
	}
});

test('the plan first, then the change once it is agreed', async () => {
	const { result, asked } = await against(reply(PLAN), () => scale('b7kq2m9xt4rvz', { instances: 2, yes: false, ask: async () => true }));
	assert.equal(result, undefined);
	assert.deepEqual(asked, [
		{ ref: 'b7kq2m9xt4rvz', preview: true, instances: 2 },
		{ ref: 'b7kq2m9xt4rvz', instances: 2 }
	]);
});

test('declined: nothing is changed', async () => {
	const { result, asked } = await against(reply(PLAN), () => scale('b7kq2m9xt4rvz', { instances: 2, yes: false, ask: async () => false }));
	assert.ok(result instanceof CliFailure && result.message === SCALE_SAYS.declined);
	assert.equal(asked.length, 1);
});

test('--yes applies without asking', async () => {
	const { asked } = await against(reply(PLAN), () => scale('b7kq2m9xt4rvz', { instances: 2, yes: true }));
	assert.equal(asked.length, 2);
});

test('with nothing to ask and no --yes, it refuses before calling anything', async () => {
	const { result, asked } = await against(reply(PLAN), () => scale('b7kq2m9xt4rvz', { instances: 2, yes: false }));
	assert.ok(result instanceof UsageError);
	assert.equal(asked.length, 0);
});

test("a refusal is the control plane's sentence, with an exit code that says what kind", async () => {
	const refused = { ...PLAN, outcome: 'refused', code: 'plan', error: "Your plan allows up to 2 instances of your app's API" };
	const { result, asked } = await against(reply(refused), () => scale('b7kq2m9xt4rvz', { instances: 3, yes: true }));
	assert.ok(result instanceof CliFailure);
	assert.equal(result.code, 'quota');
	assert.equal(result.message, "Your plan allows up to 2 instances of your app's API");
	assert.equal(asked.length, 1);
	const notOpen = await against(reply({ ...PLAN, outcome: 'refused', code: 'not-allowed', error: 'Scaling is not open to this account yet' }), () =>
		scale('b7kq2m9xt4rvz', { instances: 2, yes: true })
	);
	assert.ok(notOpen.result instanceof CliFailure && notOpen.result.code === 'forbidden');
});

test('without --instances, only what the plan allows is asked', async () => {
	const { asked } = await against(reply({ ref: 'b7kq2m9xt4rvz', current: 1, most: 2, open: false, what: 'w' }), () => scale('b7kq2m9xt4rvz', { yes: false }));
	assert.deepEqual(asked, [{ ref: 'b7kq2m9xt4rvz', preview: true }]);
});
