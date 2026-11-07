/**
 * `shards`: the words an operation is written in, the gate in front of anything that moves or
 * deletes data, and how a job's end becomes an exit code. Against a fake client, so what is
 * asserted is what would have been SENT, and that a refusal sent nothing at all.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { UsageError, parseArgs } from '../args.js';
import { CliFailure } from '../failure.js';
import { setInteractive } from '../interactive.js';
import { setQuiet } from '../output.js';
import { CloudShardsClient, type Advice, type Job, type OpBody, type Plan, type ShardsClient } from '../shardsClient.js';
import { autopilotLines, autopilotModeSentence, commandFor, describeBytes, follow, parseOp, parseSet, podStep, printStatus, printAdvice, printAlerts, printPlan, replicaPhrase, shards, slotsPhrase, spareSlots } from './shards.js';

setQuiet(true);
// Nobody at a terminal, as in CI: the gate's default.
setInteractive({ canAsk: false, reason: 'not-a-tty' });

function op(...argv: string[]) {
	const args = parseArgs(['cluster', ...argv]);
	return parseOp(args.command.slice(1), args);
}

describe('parseOp: the words become the admin API\'s body', () => {
	test('range move by keyspace:lo, the way status prints it, with the bound kept as text', () => {
		assert.deepEqual(op('range', 'move', 'tenant:-9223372036854775808', '--to', 'node2'), {
			body: { op: 'range.move', keyspace: 'tenant', range: '-9223372036854775808', to: 'node2' },
			destructive: true
		});
	});

	test('a bound that starts with a dash can be named with --keyspace and --range', () => {
		assert.deepEqual(op('range', 'split', '--keyspace', 'tenant', '--range', '-2', '--at', '-1', '--to', '3').body, {
			op: 'range.split',
			keyspace: 'tenant',
			range: '-2',
			at: '-1',
			to: '3'
		});
	});

	test('merge takes two ranges of one keyspace', () => {
		assert.deepEqual(op('range', 'merge', 'tenant:-2', 'tenant:1537228672809129299').body, {
			op: 'range.merge',
			keyspace: 'tenant',
			a: '-2',
			b: '1537228672809129299'
		});
		assert.throws(() => op('range', 'merge', 'tenant:-2', 'device:-2'), UsageError);
		assert.throws(() => op('range', 'merge', 'tenant:-2'), UsageError);
	});

	test('a bound outside 64 bits, or not a number, is refused before anything is sent', () => {
		assert.throws(() => op('range', 'move', 'tenant:9223372036854775808', '--to', 'n2'), UsageError);
		assert.throws(() => op('range', 'move', 'tenant:abc', '--to', 'n2'), UsageError);
		assert.throws(() => op('range', 'move', 'tenant:-2'), /--to/);
	});

	test('nodes add: numbers are numbers, and the optional fields are absent rather than null', () => {
		assert.deepEqual(op('nodes', 'add', 'n4', '--host', 'db4', '--port', '6543', '--sslmode', 'require').body, {
			op: 'node.add',
			name: 'n4',
			host: 'db4',
			port: 6543,
			sslmode: 'require'
		});
		assert.equal(op('nodes', 'add', 'n4', '--host', 'db4').destructive, false);
		assert.throws(() => op('nodes', 'add', 'n4'), /--host/);
		assert.throws(() => op('nodes', 'add', 'n4', '--host', 'db4', '--port', 'x'), UsageError);
	});

	test('the rest of the vocabulary', () => {
		assert.deepEqual(op('nodes', 'drain', 'node3', '--to', 'n1, n2').body, { op: 'node.drain', node: 'node3', to: ['n1', 'n2'] });
		assert.deepEqual(op('nodes', 'remove', '3').body, { op: 'node.remove', node: '3' });
		assert.deepEqual(op('keyspace', 'create', 'k', '--key-type', 'bigint', '--ranges', '6', '--seed', '18446744073709551615', '--nodes', '1,2,3').body, {
			op: 'keyspace.create',
			name: 'k',
			key_type: 'bigint',
			ranges: 6,
			seed: '18446744073709551615',
			nodes: ['1', '2', '3']
		});
		assert.throws(() => op('keyspace', 'create', 'k', '--key-type', 'bigint', '--seed', '18446744073709551616'), UsageError);
		assert.throws(() => op('keyspace', 'create', 'k', '--key-type', 'bigint', '--seed', '-1'), UsageError);
		assert.deepEqual(op('table', 'distribute', 'public.orders', '--column', 'tenant_id', '--keyspace', 'tenant').body, {
			op: 'table.distribute',
			table: 'public.orders',
			column: 'tenant_id',
			keyspace: 'tenant'
		});
		// --distribution-key is the flag's name; --column, its old one, is still taken.
		assert.deepEqual(op('table', 'distribute', 'public.orders', '--distribution-key', 'tenant_id', '--keyspace', 'tenant').body, {
			op: 'table.distribute',
			table: 'public.orders',
			column: 'tenant_id',
			keyspace: 'tenant'
		});
		assert.deepEqual(op('table', 'reference', 'public.countries').body, { op: 'table.reference', table: 'public.countries' });
		assert.deepEqual(op('table', 'global', 'public.plans').body, { op: 'table.global', table: 'public.plans' });
		assert.deepEqual(op('tenant', 'pin', 'tenant', '42', '--node', 'n3').body, { op: 'tenant.pin', keyspace: 'tenant', value: '42', node: 'n3' });
		assert.deepEqual(op('tenant', 'pin', '--keyspace', 'tenant', '--value', '-7').body, { op: 'tenant.pin', keyspace: 'tenant', value: '-7' });
		assert.deepEqual(op('rebalance').body, { op: 'rebalance' });
		assert.deepEqual(op('verify', '--keyspace', 'tenant').body, { op: 'verify', keyspace: 'tenant' });
		assert.deepEqual(op('cleanup', '--node', 'n2').body, { op: 'cleanup', node: 'n2' });
		assert.deepEqual(op('scale', '--add', 'n4=db4:5433,n5=db5', '--sslmode', 'disable', '--remove', '1').body, {
			op: 'scale',
			add: [
				{ name: 'n4', host: 'db4', port: 5433, sslmode: 'disable' },
				{ name: 'n5', host: 'db5', sslmode: 'disable' }
			],
			remove: 1
		});
		assert.throws(() => op('scale'), UsageError);
		assert.throws(() => op('range', 'teleport'), /unknown operation/);
	});

	test('a setting can be overridden for one operation', () => {
		assert.deepEqual(op('rebalance', '--max-write-pause-ms', '500', '--copy-mb-per-s', '200').body, {
			op: 'rebalance',
			max_write_pause_ms: 500,
			copy_mb_per_s: 200
		});
	});

	test('what asks first: everything that moves or deletes data, and nothing that only looks or adds', () => {
		for (const words of [['nodes', 'drain', 'n'], ['nodes', 'remove', 'n'], ['rebalance'], ['cleanup'], ['table', 'global', 't'], ['range', 'move', 'k:1', '--to', 'n']]) {
			assert.equal(op(...words).destructive, true, words.join(' '));
		}
		for (const words of [['verify'], ['keyspace', 'create', 'k', '--key-type', 'int'], ['nodes', 'add', 'n', '--host', 'h']]) {
			assert.equal(op(...words).destructive, false, words.join(' '));
		}
	});
});

const PLAN: Plan = {
	op: 'range.move',
	steps: [{ kind: 'transfer', args: {} }],
	moves: [],
	cutovers: 1,
	estimated_rows: 10,
	estimated_bytes: 2048,
	estimated_copy_seconds: 1,
	expected_pause_ms: 80,
	max_write_pause_ms: 2000,
	warnings: []
};

const ADVICE: Advice = {
	summary: '1 recommendation.',
	advice: [
		{
			op: 'range.split',
			request: { op: 'range.split', keyspace: 'advk', range: '-3074457345618258603', at: '18454348402311335', to: 3 },
			reason: 'node 2 holds 38.5 MB of keyspace advk',
			metric: 'size',
			needs: [],
			plan: PLAN
		},
		{
			op: 'node.add',
			request: { op: 'node.add', name: 'n4', host: null },
			reason: 'every node is using more than 80% of its max_connections',
			metric: 'connections',
			needs: ['host'],
			plan: null
		}
	],
	facts: { sampled_ms: 0, nodes: [], ranges: [] },
	settings: {},
	assumptions: 'chosen, not measured'
};

function job(state: Job['state'], error: string | null = null): Job {
	return {
		id: 1,
		op: 'range.move',
		args: {},
		plan: PLAN,
		state,
		error,
		runner: 'r',
		created_at: '2026-10-05T00:00:00Z',
		updated_at: '2026-10-05T00:00:00Z',
		finished_at: null,
		steps: [{ n: 0, kind: 'transfer', args: {}, state: state === 'done' ? 'done' : 'running', detail: {}, started_at: null, finished_at: null }]
	};
}

/** A client that records every call and answers a job's states in order. */
function fake(states: Job['state'][] = ['running', 'done'], error: string | null = null) {
	const calls: string[] = [];
	const sent: OpBody[] = [];
	let look = 0;
	const client: ShardsClient = {
		target: 'http://127.0.0.1:7432',
		async status() {
			calls.push('status');
			return { catalog: true };
		},
		async ops() {
			calls.push('ops');
			return { ops: [], settings: {} };
		},
		async autopilot() {
			calls.push('autopilot');
			return { mode: 'off', interval_ms: 60000, last: null };
		},
		async setAutopilot(patch) {
			calls.push('setAutopilot');
			return { settings: patch };
		},
		async plan(body) {
			calls.push('plan');
			sent.push(body);
			return PLAN;
		},
		async submit(body) {
			calls.push('submit');
			sent.push(body);
			return { job: 1, plan: PLAN };
		},
		async jobs() {
			calls.push('jobs');
			return [];
		},
		async job() {
			calls.push('job');
			const state = states[Math.min(look, states.length - 1)]!;
			look += 1;
			return job(state, state === 'failed' ? error : null);
		},
		async cancel(id) {
			calls.push('cancel');
			return { job: id, state: 'cancelling' };
		},
		async resume(id) {
			calls.push('resume');
			return { job: id, state: 'running' };
		},
		async settings(patch) {
			calls.push('settings');
			sent.push(patch as unknown as OpBody);
			return { settings: patch as Record<string, number> };
		},
		async advice(sampleMs) {
			calls.push(`advice ${sampleMs ?? '-'}`);
			return ADVICE;
		},
		async check() {
			calls.push('check');
			return { findings: [{ severity: 'error' as const, code: 'should_be_reference', table: 'public.status', related: [], message: 'm', fix: 'f', sql: null, operation: { op: 'table.reference', table: 'public.status' } }], summary: { errors: 1, warnings: 0, info: 0, tables: 3, foreign_keys: 2 } };
		}
	};
	return { client, calls, sent };
}

/** Runs `shards` with stdout swallowed, so a passing run stays readable. */
async function run(argv: string[], options: Parameters<typeof shards>[1] = {}): Promise<number> {
	const write = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		return await shards(parseArgs(['cluster', ...argv]), { pollMs: 1, ...options });
	} finally {
		process.stdout.write = write;
	}
}

describe('shards: the gate, the job and the exit code', () => {
	test('with nobody to ask and no --yes, a move is refused as a usage error before any request', async () => {
		const { client, calls } = fake();
		await assert.rejects(run(['range', 'move', 'tenant:1', '--to', 'n2'], { client }), (e: unknown) => {
			assert.ok(e instanceof UsageError);
			assert.match(e.message, /--yes/);
			assert.match(e.message, /--plan/);
			return true;
		});
		assert.deepEqual(calls, []);
	});

	test('--plan asks for the plan and runs nothing, --yes or not', async () => {
		const { client, calls } = fake();
		assert.equal(await run(['range', 'move', 'tenant:1', '--to', 'n2', '--plan'], { client }), 0);
		assert.equal(await run(['plan', 'rebalance'], { client }), 0);
		assert.deepEqual(calls, ['plan', 'plan']);
	});

	test('--yes submits, follows the job, and exits 0 when it is done', async () => {
		const { client, calls, sent } = fake(['pending', 'running', 'done']);
		assert.equal(await run(['range', 'move', 'tenant:1', '--to', 'n2', '--yes'], { client }), 0);
		assert.deepEqual(calls, ['submit', 'job', 'job', 'job']);
		assert.deepEqual(sent[0], { op: 'range.move', keyspace: 'tenant', range: '1', to: 'n2' });
	});

	test('a person is shown the plan and asked; a no changes nothing', async () => {
		const { client, calls } = fake();
		const asked: string[] = [];
		await assert.rejects(
			run(['rebalance'], {
				client,
				confirm: async (question) => {
					asked.push(question);
					return false;
				}
			}),
			(e: unknown) => e instanceof CliFailure && e.exitCode === 1
		);
		assert.deepEqual(calls, ['plan']);
		assert.match(asked[0]!, /rebalance/);
	});

	test('an operation that only adds or looks runs without asking', async () => {
		const { client, calls } = fake(['done']);
		assert.equal(await run(['verify'], { client }), 0);
		assert.deepEqual(calls, ['submit', 'job']);
	});

	test('--no-wait returns the job at once', async () => {
		const { client, calls } = fake();
		assert.equal(await run(['cleanup', '--yes', '--no-wait'], { client }), 0);
		assert.deepEqual(calls, ['submit']);
	});

	test('a failed job is exit 1 and carries the job, so an agent can read which step', async () => {
		const { client } = fake(['running', 'failed'], 'node 3: connection refused');
		await assert.rejects(run(['jobs', 'watch', '1'], { client }), (e: unknown) => {
			assert.ok(e instanceof CliFailure);
			assert.equal(e.exitCode, 1);
			assert.match(e.message, /connection refused/);
			assert.match(e.message, /jobs resume 1/);
			assert.equal((e.details?.job as Job).state, 'failed');
			return true;
		});
	});

	test('the timeout stops the following, not the job: exit 10, and how to pick it up again', async () => {
		const { client } = fake(['running']);
		await assert.rejects(follow(client, 1, { pollMs: 1, timeoutMs: 5 }), (e: unknown) => {
			assert.ok(e instanceof CliFailure);
			assert.equal(e.code, 'timeout');
			assert.equal(e.exitCode, 10);
			assert.match(e.message, /jobs watch 1/);
			return true;
		});
	});

	test('cancelling asks like any change; with nobody to ask it needs --yes', async () => {
		const { client, calls } = fake();
		await assert.rejects(run(['jobs', 'cancel', '1'], { client }), UsageError);
		assert.deepEqual(calls, []);
		assert.equal(await run(['jobs', 'cancel', '1', '--yes'], { client }), 0);
		assert.deepEqual(calls, ['cancel']);
	});

	test('settings: none given reads them, some given sets exactly those', async () => {
		const { client, calls } = fake();
		assert.equal(await run(['settings'], { client }), 0);
		assert.equal(await run(['settings', '--max-write-pause-ms', '1500'], { client }), 0);
		assert.deepEqual(calls, ['status', 'settings']);
	});

	test('settings --set takes any setting by its API name, the advisor thresholds among them', async () => {
		const { client, calls, sent } = fake();
		assert.equal(await run(['settings', '--set', 'advice_min_bytes=1, advice_skew_pct=120', '--max-write-pause-ms', '900'], { client }), 0);
		assert.deepEqual(calls, ['settings']);
		assert.deepEqual(sent[0], { max_write_pause_ms: 900, advice_min_bytes: 1, advice_skew_pct: 120 });
		assert.throws(() => parseSet('advice_nonsense=1'), /unknown setting/);
		assert.throws(() => parseSet('advice_min_bytes=-1'), UsageError);
		assert.throws(() => parseSet('advice_min_bytes'), UsageError);
	});

	test('advise asks the advisor, passes the sample interval, and runs nothing', async () => {
		const { client, calls } = fake();
		assert.equal(await run(['advise'], { client }), 0);
		assert.equal(await run(['advise', '--sample-ms', '0'], { client }), 0);
		assert.deepEqual(calls, ['advice -', 'advice 0']);
		await assert.rejects(run(['advise', '--sample-ms', 'soon'], { client }), UsageError);
	});

	test('a job id is a number', async () => {
		const { client } = fake();
		await assert.rejects(run(['jobs', 'show', 'latest'], { client }), UsageError);
	});
});

test('sizes read the way somebody would say them', () => {
	assert.equal(describeBytes(0), '0 B');
	assert.equal(describeBytes(626_700), '626.7 kB');
	assert.equal(describeBytes(4_200_000), '4.2 MB');
});

describe('advice, printed', () => {
	test('each recommendation carries the command that runs it, bounds exact', () => {
		assert.equal(
			commandFor({ op: 'range.split', keyspace: 'advk', range: '-3074457345618258603', at: '18454348402311335', to: 3 }),
			'snoutdata cluster range split advk:-3074457345618258603 --at 18454348402311335 --to 3'
		);
		assert.equal(commandFor({ op: 'range.move', keyspace: 'k', range: '1', to: 2 }), 'snoutdata cluster range move k:1 --to 2');
		assert.equal(commandFor({ op: 'tenant.pin', keyspace: 'k', value: "o'brien co", node: 2 }), "snoutdata cluster tenant pin k --value 'o'\\''brien co' --node 2");
		assert.match(commandFor({ op: 'node.add', name: 'n4', host: null })!, /nodes add n4 --host <its address>, then snoutdata cluster rebalance/);
		assert.equal(commandFor({ op: 'verify' }), null);
		// What the command prints parses back to the request it came from.
		const words = commandFor({ op: 'range.split', keyspace: 'advk', range: '-3074457345618258603', at: '-1', to: 3 })!.split(' ').slice(2);
		assert.deepEqual(op(...words).body, { op: 'range.split', keyspace: 'advk', range: '-3074457345618258603', at: '-1', to: '3' });
	});

	test('the reason, the plan, and what a recommendation still needs', () => {
		let text = '';
		printAdvice(ADVICE, { write: (t: string) => (text += t) });
		assert.match(text, /1\. range\.split.*\(size\)/);
		assert.match(text, /node 2 holds 38\.5 MB/);
		assert.match(text, /run: snoutdata cluster range split advk:-3074457345618258603/);
		assert.match(text, /plan: 1 cutover, ~10 rows/);
		assert.match(text, /needs: host, so it has no plan yet/);
	});
});

describe('shards --project: a SnoutData Cloud project, through cloud-project-shards', () => {
	/** A CloudShardsClient whose Snout Function is a recorder that answers by action. */
	function cloud(answers: Record<string, unknown> = {}) {
		const sent: Record<string, unknown>[] = [];
		const client = new CloudShardsClient('abcdefghjkmnp', async <T>(fn: string, body: unknown): Promise<T> => {
			assert.equal(fn, 'cloud-project-shards');
			const b = body as Record<string, unknown>;
			sent.push(b);
			const action = String(b.action);
			if (action === 'plan' || b.plan === true) {
				return PLAN as T;
			}
			if (action in answers) {
				return answers[action] as T;
			}
			return {} as T;
		});
		return { client, sent };
	}

	function cloudOp(...argv: string[]) {
		const args = parseArgs(['cluster', ...argv]);
		return parseOp(args.command.slice(1), args, true);
	}

	test('in the Cloud, nodes add takes no address, attach takes a ref, and scale is a count', () => {
		assert.deepEqual(cloudOp('nodes', 'add'), { body: { op: 'node.add' }, destructive: false });
		assert.throws(() => cloudOp('nodes', 'add', 'n2', '--host', '10.0.0.5'), UsageError);
		assert.deepEqual(cloudOp('nodes', 'attach', 'qrstvwxyzabcd'), { body: { op: 'node.attach', name: 'qrstvwxyzabcd' }, destructive: false });
		assert.deepEqual(cloudOp('scale', '--nodes', '3'), { body: { op: 'scale', nodes: 3 }, destructive: true });
		assert.throws(() => cloudOp('scale', '--add', 'n=h'), UsageError);
		// A standalone router has no pods to attach.
		assert.throws(() => op('nodes', 'attach', 'qrstvwxyzabcd'), UsageError);
		// Everything else is the same words, and the same body.
		assert.deepEqual(cloudOp('range', 'split', 'acct:0'), op('range', 'split', 'acct:0'));
	});

	test('a pod made is done at once, with no job to follow', async () => {
		const { client, sent } = cloud({ 'add-node': { created: ['qrstvwxyzabcd'] } });
		assert.equal(await run(['nodes', 'add', '--project', 'abcdefghjkmnp'], { client }), 0);
		assert.deepEqual(sent, [{ ref: 'abcdefghjkmnp', action: 'add-node', request: {} }]);
	});

	test('an operation is sent by action, its fields as they are, and its job is followed', async () => {
		let look = 0;
		const { client, sent } = cloud({
			split: { job: 9, plan: PLAN },
			jobs: job('done')
		});
		client.job = async () => {
			look += 1;
			return job('done');
		};
		assert.equal(await run(['range', 'split', 'acct:-9223372036854775808', '--project', 'abcdefghjkmnp', '--yes'], { client }), 0);
		assert.deepEqual(sent[0], { ref: 'abcdefghjkmnp', action: 'split', request: { keyspace: 'acct', range: '-9223372036854775808' } });
		assert.equal(look, 1);
	});

	test('enable asks like any change, and needs --project', async () => {
		const { client, sent } = cloud({ enable: { sharded: true, changed: true } });
		await assert.rejects(run(['enable', '--project', 'abcdefghjkmnp'], { client }), UsageError);
		assert.deepEqual(sent, []);
		assert.equal(await run(['enable', '--project', 'abcdefghjkmnp', '--yes'], { client }), 0);
		assert.deepEqual(sent, [{ ref: 'abcdefghjkmnp', action: 'enable' }]);
		await assert.rejects(run(['enable'], { client }), UsageError);
	});

	test('disable is the undo of enable: Cloud only, asks first, and keyspace drop and dissolve are plain operations', async () => {
		const { client, sent } = cloud({ disable: { sharded: false, changed: true, job: 4 } });
		await assert.rejects(run(['disable', '--project', 'abcdefghjkmnp'], { client }), UsageError);
		assert.deepEqual(sent, []);
		assert.equal(await run(['disable', '--project', 'abcdefghjkmnp', '--yes'], { client }), 0);
		assert.deepEqual(sent, [{ ref: 'abcdefghjkmnp', action: 'disable' }]);
		await assert.rejects(run(['disable'], { client }), UsageError);
		assert.deepEqual(op('keyspace', 'drop', 'accounts'), { body: { op: 'keyspace.drop', name: 'accounts' }, destructive: false });
		assert.throws(() => op('keyspace', 'drop'), UsageError);
		assert.deepEqual(op('dissolve'), { body: { op: 'dissolve' }, destructive: true });
		assert.throws(() => cloudOp('dissolve'), /cluster disable/);
	});

	test('a Cloud node joins on its own unless --no-join, and spread and retry are Cloud requests that ask first', async () => {
		assert.deepEqual(cloudOp('nodes', 'add', '--no-join'), { body: { op: 'node.add', join: false }, destructive: false })
		const { client, sent } = cloud({ spread: { queued: ['keyspace.create', 'table.distribute'], keyspace: 'account_id', next: 'public.orders is being spread over the cluster, one step at a time.' }, retry: { node: 'qrstvwxyzabcd', joining: true } });
		await assert.rejects(run(['spread', 'public.orders', '--column', 'account_id', '--key-type', 'bigint', '--project', 'abcdefghjkmnp'], { client }), UsageError);
		assert.deepEqual(sent, []);
		assert.equal(await run(['spread', 'public.orders', '--column', 'account_id', '--key-type', 'bigint', '--project', 'abcdefghjkmnp', '--yes'], { client }), 0);
		assert.deepEqual(sent, [{ ref: 'abcdefghjkmnp', action: 'spread', request: { table: 'public.orders', column: 'account_id', key_type: 'bigint' } }]);
		await assert.rejects(run(['spread', 'public.orders', '--project', 'abcdefghjkmnp', '--yes'], { client }), UsageError);
		await assert.rejects(run(['spread', 'public.orders', '--column', 'a', '--key-type', 'int', '--yes'], { client }), UsageError);
		assert.equal(await run(['retry', 'qrstvwxyzabcd', '--project', 'abcdefghjkmnp'], { client }), 0);
		assert.deepEqual(sent[1], { ref: 'abcdefghjkmnp', action: 'retry', node: 'qrstvwxyzabcd' });
	});

	test('status names the step each pod is waiting on, as the command that takes it', () => {
		const view = {
			ref: 'abcdefghjkmnp', sharded: true, projectsUsed: 2, maxProjects: 5, tier: 'pro', desiredNodes: 2, maxWritePauseMs: 2000, routerError: null,
			pods: [{ ref: 'qrstvwxyzabcd', ordinal: 2, state: 'ready', desiredState: 'running', hasOwnBackup: false, standbyOf: 'abcdefghjkmnp', node: null, next: 'attach' as const }]
		};
		assert.equal(podStep(view, view.pods[0]!), 'ready: snoutdata cluster nodes attach qrstvwxyzabcd --project abcdefghjkmnp');
		const joining = { ...view.pods[0]!, next: 'joining' as const, joining: 'spreading' as const };
		assert.equal(podStep(view, joining), 'joining: taking its share of the data');
		const stopped = { ...view.pods[0]!, next: 'attach' as const, joining: 'failed' as const, joinError: 'no room' };
		assert.equal(podStep(view, stopped), 'stopped joining: no room. Retry: snoutdata cluster retry qrstvwxyzabcd --project abcdefghjkmnp');
	});

	test('replica add and remove ask first like spread, send the node, and are Cloud only', async () => {
		const { client, sent } = cloud({
			'add-replica': { node: 'qrstvwxyzabcd', replica: 'efghjkmnpqrst', note: 'It protects the node once it is following it.' },
			'remove-replica': { node: 'qrstvwxyzabcd', changed: true }
		});
		await assert.rejects(run(['replica', 'add', 'qrstvwxyzabcd', '--project', 'abcdefghjkmnp'], { client }), (e: unknown) => e instanceof UsageError && /project slot/.test(e.message));
		assert.deepEqual(sent, []);
		await assert.rejects(run(['replica', 'add', 'qrstvwxyzabcd', '--yes'], { client }), UsageError);
		await assert.rejects(run(['replica', 'add', '--project', 'abcdefghjkmnp', '--yes'], { client }), UsageError);
		await assert.rejects(run(['replica', 'swap', 'qrstvwxyzabcd', '--project', 'abcdefghjkmnp', '--yes'], { client }), UsageError);
		assert.deepEqual(sent, []);
		assert.equal(await run(['replica', 'add', 'qrstvwxyzabcd', '--project', 'abcdefghjkmnp', '--plan'], { client }), 0);
		assert.deepEqual(sent.pop(), { ref: 'abcdefghjkmnp', action: 'add-replica', node: 'qrstvwxyzabcd', plan: true });
		assert.equal(await run(['replica', 'add', 'qrstvwxyzabcd', '--project', 'abcdefghjkmnp', '--yes'], { client }), 0);
		assert.deepEqual(sent.pop(), { ref: 'abcdefghjkmnp', action: 'add-replica', node: 'qrstvwxyzabcd' });
		// A person is shown the plan and asked; a no sends nothing past the plan.
		await assert.rejects(run(['replica', 'remove', '--node', 'qrstvwxyzabcd', '--project', 'abcdefghjkmnp'], { client, confirm: async () => false }), CliFailure);
		assert.deepEqual(sent.pop(), { ref: 'abcdefghjkmnp', action: 'remove-replica', node: 'qrstvwxyzabcd', plan: true });
		assert.equal(await run(['replica', 'remove', 'qrstvwxyzabcd', '--project', 'abcdefghjkmnp'], { client, confirm: async () => true }), 0);
		assert.deepEqual(sent.splice(0), [
			{ ref: 'abcdefghjkmnp', action: 'remove-replica', node: 'qrstvwxyzabcd', plan: true },
			{ ref: 'abcdefghjkmnp', action: 'remove-replica', node: 'qrstvwxyzabcd' }
		]);
	});

	test('alerts list from status, and seen marks one by its id without asking', async () => {
		const alert = { id: '0f4c2a9e-1b2c-4d5e-8f90-123456789abc', kind: 'node-failing', node: 'qrstvwxyzabcd', severity: 'critical', message: 'node qrstvwxyzabcd is lost.', openedAt: '2026-10-11T10:00:00Z', resolvedAt: null, resolution: null, acknowledged: false };
		const { client, sent } = cloud({ status: { ref: 'abcdefghjkmnp', sharded: true, pods: [], alerts: [alert], cluster: null }, acknowledge: { alert: alert.id, acknowledged: true } });
		assert.deepEqual(await client.alerts(), [alert]);
		assert.equal(await run(['alerts', '--project', 'abcdefghjkmnp'], { client }), 0);
		assert.equal(await run(['alerts', 'seen', alert.id, '--project', 'abcdefghjkmnp'], { client }), 0);
		assert.deepEqual(sent.at(-1), { ref: 'abcdefghjkmnp', action: 'acknowledge', alert: alert.id });
		await assert.rejects(run(['alerts', 'seen', 'latest', '--project', 'abcdefghjkmnp'], { client }), UsageError);
		await assert.rejects(run(['alerts'], { client }), UsageError);
	});

	test('status puts open alerts first and says, per node, whether a replica protects it', () => {
		const base = { ref: 'qrstvwxyzabcd', ordinal: 2, state: 'ready', desiredState: 'running', hasOwnBackup: true, standbyOf: null, node: { id: 2, state: 'active' }, next: null, replicaOf: null, replica: null, wantsReplica: false, failover: null, failoverError: null };
		assert.equal(replicaPhrase(base), 'no replica');
		assert.equal(replicaPhrase({ ...base, replica: 'efghjkmnpqrst' }), 'protected by replica efghjkmnpqrst');
		assert.equal(replicaPhrase({ ...base, wantsReplica: true }), 'no replica yet: one is being made');
		assert.equal(replicaPhrase({ ...base, failover: 'promote' }), 'failing over: its replica is taking its place');
		assert.equal(replicaPhrase({ ...base, failover: 'failed', failoverError: 'no standby' }), 'failover stopped: no standby');
		const replica = { ...base, ref: 'efghjkmnpqrst', node: null, replicaOf: 'qrstvwxyzabcd' };
		assert.equal(replicaPhrase(replica), 'replica of node qrstvwxyzabcd');
		const view = { ref: 'abcdefghjkmnp', sharded: true, projectsUsed: 3, maxProjects: 5, tier: 'pro', desiredNodes: 2, maxWritePauseMs: null, routerError: null, pods: [base, replica] };
		assert.equal(podStep(view, replica), 'replica of node qrstvwxyzabcd (ready)');
		// An older control plane says nothing about replicas, and nothing is said for it.
		const { replicaOf: _r, replica: _p, wantsReplica: _w, failover: _f, failoverError: _e, ...older } = base;
		assert.equal(replicaPhrase(older), '');
		let printed = '';
		const out = { write: (text: string) => (printed += text) };
		const alert = (severity: 'critical' | 'info', resolvedAt: string | null) => ({ id: '0f4c2a9e-1b2c-4d5e-8f90-123456789abc', kind: 'node-failing', node: null, severity, message: `${severity} message.`, openedAt: '2026-10-11T10:00:00Z', resolvedAt, resolution: resolvedAt ? 'Done.' : null, acknowledged: false });
		printAlerts([alert('critical', null), alert('info', '2026-10-11T11:00:00Z')], out, false, 'abcdefghjkmnp');
		assert.match(printed, /CRITICAL critical message\./);
		assert.doesNotMatch(printed, /info message/);
		printed = '';
		printAlerts([alert('critical', null), alert('info', '2026-10-11T11:00:00Z')], out, true);
		assert.match(printed, /0f4c2a9e-1b2c-4d5e-8f90-123456789abc/);
		assert.match(printed, /Resolved in the last day:\n  info message\. Done\./);
	});

	test('each node uses a project slot: offered while one is spare, said beside the count', () => {
		assert.equal(spareSlots({ projectsUsed: 1, maxProjects: 2 }), 1);
		assert.equal(spareSlots({ projectsUsed: 2, maxProjects: 2 }), 0);
		assert.equal(spareSlots({ projectsUsed: null, maxProjects: 2 }), 0);
		assert.equal(slotsPhrase({ projectsUsed: 2, maxProjects: 5, tier: 'pro' }), '2 of 5 project slots used on the pro plan; each node uses one');
		assert.equal(slotsPhrase({ projectsUsed: null, maxProjects: null, tier: null }), 'the plan could not be read');
	});
});

describe('table auto: keys chosen for every table, and why', () => {
	test('the words, the gate, and the Cloud action', () => {
		assert.deepEqual(op('table', 'auto', '--keyspace', 'tenant'), { body: { op: 'table.auto', keyspace: 'tenant' }, destructive: true });
		assert.deepEqual(op('table', 'auto', '--keyspace', 'tenant', '--schemas', 'public, app', '--min-bytes', '0').body, {
			op: 'table.auto',
			keyspace: 'tenant',
			schemas: ['public', 'app'],
			min_bytes: 0
		});
		assert.throws(() => op('table', 'auto'), UsageError);
		assert.throws(() => op('table', 'auto', '--keyspace', 'tenant', '--min-bytes', 'big'), UsageError);
	});

	test('the plan says what it chose for every table', () => {
		const plan: Plan = {
			op: 'table.auto',
			steps: [],
			moves: [],
			cutovers: 2,
			estimated_rows: 0,
			estimated_bytes: 0,
			estimated_copy_seconds: 0,
			expected_pause_ms: 0,
			max_write_pause_ms: 2000,
			warnings: [],
			choices: [
				{ table: 'public.accounts', choice: 'shard', column: 'id', why: 'the tenant: 2 tables reference its id' },
				{ table: 'public.plans', choice: 'reference', column: null, why: 'small, and a distributed table references it' },
				{ table: 'public.audit', choice: 'leave', column: null, why: 'id is filled by a sequence' }
			]
		};
		let text = '';
		printPlan(plan, { write: (t: string) => (text += t) });
		assert.match(text, /public\.accounts\s+shard by id\s+the tenant: 2 tables reference its id/);
		assert.match(text, /public\.plans\s+copy to every node/);
		assert.match(text, /public\.audit\s+leave on the home node\s+id is filled by a sequence/);
	});
});

describe('cluster autopilot: off unless set, said plainly', () => {
	test('each mode is a sentence that says what it does, off included', () => {
		assert.match(autopilotModeSentence('off', 60000), /^Autopilot: off\. It runs nothing on its own/);
		assert.match(autopilotModeSentence('advise', 60000), /Every 60 s it records what it would run, and runs nothing/);
		assert.match(autopilotModeSentence('auto', 5000), /Every 5 s, when no job is running, it runs/);
		for (const m of ['off', 'advise', 'auto'] as const) {
			assert.ok(!autopilotModeSentence(m, 60000).includes('\u2014'), 'no em dash');
		}
	});

	test('what it decided last follows the mode', () => {
		assert.deepEqual(autopilotLines({ mode: 'off', interval_ms: 60000, last: null }), [autopilotModeSentence('off', 60000)]);
		const lines = autopilotLines({
			mode: 'advise',
			interval_ms: 60000,
			last: { mode: 'advise', at: '2026-10-27T16:00:00Z', decision: { kind: 'propose', request: { op: 'range.move', keyspace: 'acct' }, why: 'node 1 holds 80%' } }
		});
		assert.equal(lines[1], 'Last decided 2026-10-27 16:00:00: it would run range.move in acct. node 1 holds 80%');
	});

	test('in the Cloud, the owner\'s choice and what the Cloud ran win over the router, which only advises', () => {
		const router = {
			mode: 'advise' as const,
			interval_ms: 60000,
			last: { mode: 'advise', at: '2026-10-28T05:00:00Z', decision: { kind: 'propose', request: { op: 'range.move', keyspace: 'acct' }, why: 'node 1 holds 80%' } }
		};
		const taken = { mode: 'auto' as const, taken_at: '2026-10-28T05:00:30Z', request: { op: 'range.move', keyspace: 'acct' }, job: 12, error: null };
		const ran = autopilotLines({ ...router, cloud: taken });
		assert.match(ran[0]!, /^Autopilot: auto\. .* In SnoutData Cloud each goes through the same checks as a move of yours/);
		assert.equal(ran[1], 'Last taken 2026-10-28 05:00:30: it ran range.move in acct (job 12)');
		assert.equal(ran.length, 2, 'the router\'s "it would run" is not shown beside what the Cloud ran');
		const refused = autopilotLines({ ...router, cloud: { ...taken, job: null, error: 'Node 2 has no room for it.' } });
		assert.equal(refused[1], 'Last taken 2026-10-28 05:00:30: it did not run range.move in acct. Node 2 has no room for it.');
		assert.deepEqual(autopilotLines({ ...router, cloud: { ...taken, taken_at: null, request: null, job: null } }), [ran[0]]);
		assert.equal(autopilotLines({ ...router, cloud: { ...taken, job: null } })[1], 'Last taken 2026-10-28 05:00:30: it is starting range.move in acct');
		// Advise and off read as before; off from the Cloud wins over a router still reporting advise.
		assert.deepEqual(autopilotLines({ ...router, cloud: { ...taken, mode: 'advise' } }), autopilotLines(router));
		assert.deepEqual(autopilotLines({ ...router, cloud: { ...taken, mode: 'off' } }), [autopilotModeSentence('off', 60000)]);
		for (const line of [...ran, ...refused]) {
			assert.ok(!line.includes('\u2014'), 'no em dash');
		}
	});

	test('it reads, sets, and asks before auto', async () => {
		const { client, calls } = fake();
		assert.equal(await run(['autopilot'], { client }), 0);
		assert.deepEqual(calls, ['autopilot']);
		assert.equal(await run(['autopilot', 'advise', '--interval-ms', '30000'], { client }), 0);
		assert.equal(calls.at(-1), 'setAutopilot');
		// Nobody to ask and no --yes: refused before any request.
		const before = calls.length;
		await assert.rejects(run(['autopilot', 'auto'], { client }), UsageError);
		assert.equal(calls.length, before);
		assert.equal(await run(['autopilot', 'auto', '--yes'], { client }), 0);
		assert.equal(calls.at(-1), 'setAutopilot');
		await assert.rejects(run(['autopilot', 'on'], { client }), UsageError);
	});
});

test('cluster check prints the findings and exits 1 when one must be fixed', async () => {
	const { client, calls } = fake();
	assert.equal(await run(['check'], { client }), 1);
	assert.ok(calls.includes('check'));
});

test('cluster status says which pool mode the cluster is in, and an older router saying nothing prints no line', () => {
	const printed = (status: Parameters<typeof printStatus>[0]) => {
		const write = process.stdout.write;
		let text = '';
		process.stdout.write = ((chunk: string) => {
			text += chunk;
			return true;
		}) as typeof process.stdout.write;
		try {
			printStatus(status);
		} finally {
			process.stdout.write = write;
		}
		return text;
	};
	const status = { catalog: true, epoch: 2, nodes: [] } as unknown as Parameters<typeof printStatus>[0];
	assert.match(printed({ ...status, router_settings: { pool_mode: 'transaction' } }), /^Pool mode: transaction$/m);
	assert.doesNotMatch(printed(status), /Pool mode/);
});
