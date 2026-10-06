/**
 * The seam `shards` talks through: what it refuses before a request, what it sends, and how the
 * router's answers become failures an agent can branch on. Against a real HTTP server on
 * 127.0.0.1, so the headers and the body are the ones that would cross the wire.
 */

import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { CliFailure } from './failure.js';
import * as api from './api.js';
import { AdminClient, CloudShardsClient, adminFailure, adminUrl, describeCloudAnswer, shardsClient } from './shardsClient.js';

const TOKEN = 'a-test-token-of-some-length';

describe('adminUrl', () => {
	test('a bare host:port is http on this machine, the way LEPIS_ADMIN_ADDR is written', () => {
		assert.equal(adminUrl('127.0.0.1:7432').toString(), 'http://127.0.0.1:7432/');
		assert.equal(adminUrl('http://localhost:7432/').toString(), 'http://localhost:7432/');
	});

	test('plain http to another machine is refused, since the token would cross it in the clear', () => {
		assert.throws(() => adminUrl('http://db.example.com:7432'), (e: unknown) => e instanceof CliFailure && e.code === 'usage' && /https/.test(e.message));
		assert.equal(adminUrl('https://db.example.com:7432').host, 'db.example.com:7432');
	});

	test('a URL carrying credentials, or another scheme, is refused', () => {
		assert.throws(() => adminUrl('https://u:p@db.example.com'), CliFailure);
		assert.throws(() => adminUrl('postgres://127.0.0.1:5432'), CliFailure);
	});
});

describe('shardsClient', () => {
	test('no router is a usage error, and it names the flag', () => {
		assert.throws(
			() => shardsClient({}, {}),
			(e: unknown) => e instanceof CliFailure && e.code === 'usage' && e.exitCode === 2 && /--admin/.test(e.message)
		);
	});

	test('no token is the credential (exit 3), never a request without one', () => {
		assert.throws(() => shardsClient({ admin: '127.0.0.1:7432' }, {}), (e: unknown) => e instanceof CliFailure && e.exitCode === 3);
	});

	test('the environment fills in what the flags leave out, and the flags win', () => {
		const fromEnv = shardsClient({}, { LEPIS_ADMIN_URL: 'http://127.0.0.1:7432', LEPIS_ADMIN_TOKEN: TOKEN });
		assert.equal(fromEnv.target, 'http://127.0.0.1:7432');
		const fromFlag = shardsClient({ admin: '127.0.0.1:9999' }, { LEPIS_ADMIN_URL: 'http://127.0.0.1:7432', LEPIS_ADMIN_TOKEN: TOKEN });
		assert.equal(fromFlag.target, 'http://127.0.0.1:9999');
		assert.ok(!fromFlag.target.includes(TOKEN));
	});
});

describe('adminFailure: the code decides the exit, the kind is handed back', () => {
	const cases: [number, string, string, number][] = [
		[400, 'bad_request', 'usage', 2],
		[401, 'unauthorized', 'not-signed-in', 3],
		[404, 'not_found', 'not-found', 6],
		[409, 'conflict', 'conflict', 7],
		[500, 'failed', 'failed', 1],
		[408, 'timeout', 'timeout', 10]
	];
	for (const [status, apiCode, code, exit] of cases) {
		test(`${status} ${apiCode}`, () => {
			const failure = adminFailure(status, { error: { code: apiCode, kind: 'some_kind', message: 'a sentence' } });
			assert.equal(failure.code, code);
			assert.equal(failure.exitCode, exit);
			assert.equal(failure.details?.kind, 'some_kind');
		});
	}

	test('a body with no known code falls back to the status', () => {
		assert.equal(adminFailure(404, {}).code, 'not-found');
		assert.equal(adminFailure(502, 'not json').code, 'server');
	});
});

describe('AdminClient against a server', () => {
	let server: Server;
	let base: URL;
	const seen: { method: string; url: string; authorization: string | undefined; body: string }[] = [];
	const answers = new Map<string, [number, string]>();

	before(async () => {
		server = createServer((req: IncomingMessage, res) => {
			let body = '';
			req.on('data', (chunk) => (body += chunk));
			req.on('end', () => {
				seen.push({ method: req.method ?? '', url: req.url ?? '', authorization: req.headers.authorization, body });
				const [status, text] = answers.get(`${req.method} ${req.url}`) ?? [404, '{"error":{"code":"not_found","message":"no route"}}'];
				res.writeHead(status, { 'content-type': 'application/json' }).end(text);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
	});

	after(() => {
		server.close();
	});

	test('a plan is a POST with the operation as JSON and the token as a bearer, and bounds stay strings', async () => {
		answers.set('POST /v1/plan', [200, '{"op":"range.move","steps":[],"moves":[{"change":{"range_owner":{"lo":"-9223372036854775808","hi":"-7686143364045646508","to":2}}}],"cutovers":1}']);
		const client = new AdminClient(base, TOKEN);
		const plan = await client.plan({ op: 'range.move', keyspace: 'tenant', range: '-9223372036854775808', to: 'node2' });
		const last = seen[seen.length - 1]!;
		assert.equal(last.method, 'POST');
		assert.equal(last.authorization, `Bearer ${TOKEN}`);
		assert.deepEqual(JSON.parse(last.body), { op: 'range.move', keyspace: 'tenant', range: '-9223372036854775808', to: 'node2' });
		assert.deepEqual((plan.moves[0]!.change as { range_owner: unknown }).range_owner, { lo: '-9223372036854775808', hi: '-7686143364045646508', to: 2 });
	});

	test('a wrong token is exit 3, and the message never quotes the token', async () => {
		answers.set('GET /v1/status', [401, '{"error":{"code":"unauthorized","message":"send Authorization: Bearer <LEPIS_ADMIN_TOKEN>"}}']);
		await assert.rejects(new AdminClient(base, TOKEN).status(), (e: unknown) => {
			assert.ok(e instanceof CliFailure);
			assert.equal(e.exitCode, 3);
			assert.ok(!e.message.includes(TOKEN));
			return true;
		});
	});

	test('a refusal is a conflict carrying the router\'s sentence, its kind and sqlstate', async () => {
		answers.set('POST /v1/jobs', [409, '{"error":{"code":"conflict","kind":"no_such_range","sqlstate":"0A000","message":"keyspace tenant has no range starting at 12"}}']);
		await assert.rejects(new AdminClient(base, TOKEN).submit({ op: 'range.move' }), (e: unknown) => {
			assert.ok(e instanceof CliFailure);
			assert.equal(e.code, 'conflict');
			assert.equal(e.exitCode, 7);
			assert.equal(e.message, 'keyspace tenant has no range starting at 12');
			assert.deepEqual(e.details, { status: 409, apiCode: 'conflict', kind: 'no_such_range', sqlstate: '0A000' });
			return true;
		});
	});

	test('job paths carry the id', async () => {
		answers.set('POST /v1/jobs/7/cancel', [200, '{"job":7,"state":"cancelling"}']);
		answers.set('GET /v1/jobs', [200, '{"jobs":[{"id":7,"op":"range.move","state":"running","error":null,"created_at":"x","finished_at":null,"steps":1,"steps_done":0}]}']);
		const client = new AdminClient(base, TOKEN);
		assert.deepEqual(await client.cancel(7), { job: 7, state: 'cancelling' });
		assert.equal((await client.jobs())[0]!.id, 7);
	});

	test('advice is a GET, with the sample interval in the query when one is given', async () => {
		const body = '{"summary":"1 recommendation.","advice":[{"op":"range.split","request":{"op":"range.split","keyspace":"k","range":"-9223372036854775808","at":"-1","to":3},"reason":"r","metric":"size","needs":[],"plan":null}],"facts":{"sampled_ms":0,"nodes":[],"ranges":[]},"settings":{},"assumptions":"a"}';
		answers.set('GET /v1/advice', [200, body]);
		answers.set('GET /v1/advice?sample_ms=0', [200, body]);
		const client = new AdminClient(base, TOKEN);
		const advice = await client.advice();
		assert.equal(seen[seen.length - 1]!.url, '/v1/advice');
		assert.equal(advice.advice[0]!.request.range, '-9223372036854775808');
		await client.advice(0);
		assert.equal(seen[seen.length - 1]!.url, '/v1/advice?sample_ms=0');
		assert.equal(seen[seen.length - 1]!.method, 'GET');
	});

	test('nothing listening is a network failure, which an agent may retry', async () => {
		const closed = createServer();
		await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
		const port = (closed.address() as AddressInfo).port;
		await new Promise<void>((resolve) => closed.close(() => resolve()));
		await assert.rejects(new AdminClient(new URL(`http://127.0.0.1:${port}`), TOKEN).status(), (e: unknown) => {
			assert.ok(e instanceof CliFailure);
			assert.equal(e.code, 'network');
			assert.ok(!e.message.includes(TOKEN));
			return true;
		});
	});
});

describe('the Cloud form: a project, through cloud-project-shards', () => {
	test('--project picks the Cloud client, and a bad ref or both forms is a usage error', () => {
		const client = shardsClient({ project: 'abcdefghjkmnp' }, {});
		assert.ok(client instanceof CloudShardsClient);
		assert.equal(client.target, 'project abcdefghjkmnp');
		assert.throws(() => shardsClient({ project: 'nope' }, {}), (e: unknown) => e instanceof CliFailure && e.exitCode === 2);
		assert.throws(() => shardsClient({ project: 'abcdefghjkmnp', admin: '127.0.0.1:7432' }, {}), (e: unknown) => e instanceof CliFailure && e.exitCode === 2);
	});

	test('every call carries the ref and an action; a plan carries the whole operation', async () => {
		const sent: unknown[] = [];
		const client = new CloudShardsClient('abcdefghjkmnp', async <T>(_fn: string, body: unknown) => {
			sent.push(body);
			return {} as T;
		});
		await client.plan({ op: 'range.merge', keyspace: 'k', a: '-9223372036854775808', b: '0' });
		await client.job(4);
		await client.advice(250);
		assert.deepEqual(sent, [
			{ ref: 'abcdefghjkmnp', action: 'plan', request: { op: 'range.merge', keyspace: 'k', a: '-9223372036854775808', b: '0' } },
			{ ref: 'abcdefghjkmnp', action: 'jobs', id: 4 },
			{ ref: 'abcdefghjkmnp', action: 'advice', sampleMs: 250 }
		]);
	});

	test('status is the router\'s, with the project\'s side beside it', async () => {
		const client = new CloudShardsClient('abcdefghjkmnp', async <T>() => ({ ref: 'abcdefghjkmnp', sharded: false, projectsUsed: 1, maxProjects: 1, tier: 'free', pods: [], cluster: null, routerError: null, desiredNodes: 1, maxWritePauseMs: null }) as T);
		const status = await client.status();
		assert.equal(status.catalog, false);
		assert.equal(status.cloud?.sharded, false);
		assert.equal(status.cloud?.tier, 'free');
	});

	test('an address is never sent: a node is a pod the project makes', async () => {
		const client = new CloudShardsClient('abcdefghjkmnp', async <T>() => ({}) as T);
		await assert.rejects(client.submit({ op: 'node.add', name: 'n2', host: '10.0.0.9' }), (e: unknown) => e instanceof CliFailure && e.exitCode === 2);
		await assert.rejects(client.plan({ op: 'scale', add: [{ name: 'n', host: 'h' }] }), (e: unknown) => e instanceof CliFailure && e.exitCode === 2);
		await assert.rejects(client.plan({ op: 'restore_point' }), (e: unknown) => e instanceof CliFailure && e.exitCode === 2);
	});

	test('a router refusal keeps the exit code and kind it has with --admin', async () => {
		const client = new CloudShardsClient('abcdefghjkmnp', async () => {
			throw new api.ApiError(409, 'those ranges are not adjacent', 'router', { error: 'those ranges are not adjacent', code: 'router', apiCode: 'conflict', kind: 'not_adjacent' });
		});
		await assert.rejects(client.submit({ op: 'range.merge', keyspace: 'k', a: '1', b: '9' }), (e: unknown) => {
			assert.ok(e instanceof CliFailure);
			assert.equal(e.exitCode, 7);
			assert.equal(e.details?.kind, 'not_adjacent');
			return true;
		});
	});

	test('the control plane\'s own refusals keep their status', async () => {
		const refuse = (status: number, body: unknown) =>
			new CloudShardsClient('abcdefghjkmnp', async () => {
				throw new api.ApiError(status, 'no', null, body);
			});
		await assert.rejects(refuse(402, { error: 'no', code: 'quota' }).submit({ op: 'node.add' }), (e: unknown) => e instanceof CliFailure && e.code === 'quota');
		await assert.rejects(refuse(409, { error: 'no', code: 'not-sharded' }).status(), (e: unknown) => e instanceof CliFailure && e.code === 'conflict' && e.details?.kind === 'not-sharded');
		await assert.rejects(refuse(403, { error: 'no' }).status(), (e: unknown) => e instanceof CliFailure && e.code === 'forbidden');
	});

	test('a pod made or deleted is said in a sentence, with the next step', () => {
		assert.match(describeCloudAnswer({ created: ['qrstvwxyzabcd'] }), /nodes attach/);
		assert.match(describeCloudAnswer({ pod: 'qrstvwxyzabcd', deleted: true }), /owned nothing/);
		assert.match(describeCloudAnswer({ unchanged: true, nodes: 3 }), /already has 3/);
	});
});
