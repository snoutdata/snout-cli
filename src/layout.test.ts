import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { browserUrl, doorFetch, fnRoute, forgetHosts, identityRoute, speaksOld } from './layout.js';

interface Seen {
	url: string;
	headers: Record<string, string>;
	body: string | undefined;
	method: string | undefined;
}

/** A door that serves `paths` (by prefix) and answers 404 to the rest. */
function door(serves: string[], status = 200): { fetcher: typeof fetch; seen: Seen[] } {
	const seen: Seen[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined, method: init?.method });
		const path = new URL(url).pathname;
		return new Response('{}', { status: serves.some((prefix) => path.startsWith(prefix)) ? status : 404 });
	}) as typeof fetch;
	return { fetcher, seen };
}

test('a door with the current names is asked once, on the new path, with Snout-Key', async () => {
	forgetHosts();
	const { fetcher, seen } = door(['/v1/fn', '/v1/identity']);
	const response = await doorFetch('https://a.example', fnRoute('cloud-whoami'), { method: 'POST', key: 'k', body: '{"x":1}', headers: { 'x-client-info': 'c' } }, fetcher);
	assert.equal(response.status, 200);
	assert.equal(seen.length, 1);
	assert.equal(seen[0]!.url, 'https://a.example/v1/fn/cloud-whoami');
	assert.deepEqual(seen[0]!.headers, { 'x-client-info': 'c', 'Snout-Key': 'k' });
	assert.equal(seen[0]!.body, '{"x":1}');
	assert.equal(speaksOld('https://a.example'), false);
});

test('a door with only the earlier names: one 404, the same request on the earlier path, then remembered', async () => {
	forgetHosts();
	const { fetcher, seen } = door(['/functions/v1', '/auth/v1']);
	const first = await doorFetch('https://b.example', identityRoute('/session?via=renew', '/token?grant_type=refresh_token'), { method: 'POST', key: 'k', body: 'b' }, fetcher);
	assert.equal(first.status, 200);
	assert.deepEqual(seen.map((one) => one.url), ['https://b.example/v1/identity/session?via=renew', 'https://b.example/auth/v1/token?grant_type=refresh_token']);
	assert.deepEqual(seen[1]!.headers, { apikey: 'k' });
	assert.equal(seen[1]!.body, 'b');
	assert.equal(seen[1]!.method, 'POST');
	assert.equal(speaksOld('https://b.example'), true);

	// The rest of the run goes straight to the earlier names on that host.
	await doorFetch('https://b.example', fnRoute('cloud-project-list'), { method: 'POST', key: 'k' }, fetcher);
	assert.equal(seen.at(-1)!.url, 'https://b.example/functions/v1/cloud-project-list');
	assert.equal(seen.length, 3);
});

test('a 404 under both names is the answer, and teaches nothing about the host', async () => {
	forgetHosts();
	const { fetcher, seen } = door(['/nothing']);
	const response = await doorFetch('https://c.example', fnRoute('gone'), { method: 'POST' }, fetcher);
	assert.equal(response.status, 404);
	assert.equal(seen.length, 2);
	assert.equal(speaksOld('https://c.example'), false);
});

test('any other status on the new path is the answer: no second request', async () => {
	forgetHosts();
	const { fetcher, seen } = door(['/v1/fn'], 401);
	const response = await doorFetch('https://d.example', fnRoute('cloud-whoami'), { method: 'POST' }, fetcher);
	assert.equal(response.status, 401);
	assert.equal(seen.length, 1);
});

test('a browser URL is built in the vocabulary the door speaks', async () => {
	forgetHosts();
	const modern = door(['/v1/identity']);
	assert.equal(await browserUrl('https://e.example', identityRoute('/provider/start', '/authorize'), 'k', modern.fetcher), 'https://e.example/v1/identity/provider/start');
	const earlier = door(['/auth/v1']);
	assert.equal(await browserUrl('https://f.example', identityRoute('/provider/start', '/authorize'), 'k', earlier.fetcher), 'https://f.example/auth/v1/authorize');
});

describe('a request lost on the network', () => {
	const lost = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`connect ${code} 1.2.3.4:443`), { code }) });
	const waited: number[] = [];
	const wait = async (ms: number) => { waited.push(ms); };

	test('a read is tried again, and comes back', async () => {
		waited.length = 0;
		let tries = 0;
		const response = await doorFetch('https://r.example', fnRoute('x'), { method: 'POST', readOnly: true }, (async () => {
			tries += 1;
			if (tries < 3) {
				throw lost('ECONNRESET');
			}
			return new Response('{}');
		}) as typeof fetch, wait);
		assert.equal(response.status, 200);
		assert.deepEqual(waited, [500, 1500]);
	});

	test('a write that may have been sent is not tried again, and the failure names the address and the reason', async () => {
		let tries = 0;
		await assert.rejects(
			doorFetch('https://w.example', fnRoute('x'), { method: 'POST' }, (async () => {
				tries += 1;
				throw lost('ECONNRESET');
			}) as typeof fetch, wait),
			(error: Error & { code?: string }) => {
				assert.equal(error.code, 'network');
				assert.match(error.message, /Could not reach w\.example: connect ECONNRESET 1\.2\.3\.4:443\./);
				return true;
			}
		);
		assert.equal(tries, 1);
	});

	test('a write that never left is tried again, and gives up after three tries', async () => {
		let tries = 0;
		await assert.rejects(doorFetch('https://n.example', fnRoute('x'), { method: 'POST' }, (async () => {
			tries += 1;
			throw lost('ENOTFOUND');
		}) as typeof fetch, wait));
		assert.equal(tries, 3);
	});
});
