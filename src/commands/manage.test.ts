import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CliFailure } from '../failure.js';
import { domainsCommand } from './manage.js';

async function withAnswer<T>(answer: unknown, body: () => Promise<T>): Promise<T> {
	const realFetch = globalThis.fetch;
	const realToken = process.env.SNOUTDATA_ACCESS_TOKEN;
	const realWrite = process.stdout.write;
	process.env.SNOUTDATA_ACCESS_TOKEN = 'sdt_test';
	globalThis.fetch = async () => new Response(JSON.stringify(answer), { status: 200 });
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		return await body();
	} finally {
		globalThis.fetch = realFetch;
		process.stdout.write = realWrite;
		if (realToken === undefined) {
			delete process.env.SNOUTDATA_ACCESS_TOKEN;
		} else {
			process.env.SNOUTDATA_ACCESS_TOKEN = realToken;
		}
	}
}

const domain = (verified: boolean) => ({
	hostname: 'api.example.com',
	verified,
	verificationError: verified ? null : 'The TXT record was not found by Cloudflare or Google.',
	record: { name: '_snoutdata-challenge.api.example.com', type: 'TXT', value: 'abc' },
	certificateRecord: null,
	certificate: null
});

test('domains verify on a domain that did not verify fails as not-ready (exit 4)', async () => {
	const thrown = await withAnswer({ domain: domain(false) }, () => domainsCommand('abc', 'verify', 'api.example.com')).catch((error: unknown) => error);
	assert.ok(thrown instanceof CliFailure, 'an unverified verify returned success');
	assert.equal(thrown.code, 'not-ready');
	assert.equal(thrown.exitCode, 4);
	assert.equal((thrown.details?.domain as { verified: boolean }).verified, false);
});

test('domains verify on a verified domain, and add on a new one, succeed', async () => {
	await withAnswer({ domain: domain(true) }, () => domainsCommand('abc', 'verify', 'api.example.com'));
	await withAnswer({ domain: domain(false) }, () => domainsCommand('abc', 'add', 'api.example.com'));
});
