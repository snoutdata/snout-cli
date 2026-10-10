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
import { commandFor, describeBytes, follow, parseOp, parseSet, podStep, printAdvice, shards, slotsPhrase, spareSlots } from './shards.js';

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
			if (action in answers) {
				return answers[action] as T;
			}
			if (action === 'plan' || (action === 'enable' && b.plan === true)) {
				return PLAN as T;
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

	test('status names the step each pod is waiting on, as the command that takes it', () => {
		const view = {
			ref: 'abcdefghjkmnp', sharded: true, projectsUsed: 2, maxProjects: 5, tier: 'pro', desiredNodes: 2, maxWritePauseMs: 2000, routerError: null,
			pods: [{ ref: 'qrstvwxyzabcd', ordinal: 2, state: 'ready', desiredState: 'running', hasOwnBackup: false, standbyOf: 'abcdefghjkmnp', node: null, next: 'attach' as const }]
		};
		assert.equal(podStep(view, view.pods[0]!), 'ready: snoutdata cluster nodes attach qrstvwxyzabcd --project abcdefghjkmnp');
	});

	test('each node uses a project slot: offered while one is spare, said beside the count', () => {
		assert.equal(spareSlots({ projectsUsed: 1, maxProjects: 2 }), 1);
		assert.equal(spareSlots({ projectsUsed: 2, maxProjects: 2 }), 0);
		assert.equal(spareSlots({ projectsUsed: null, maxProjects: 2 }), 0);
		assert.equal(slotsPhrase({ projectsUsed: 2, maxProjects: 5, tier: 'pro' }), '2 of 5 project slots used on the pro plan; each node uses one');
		assert.equal(slotsPhrase({ projectsUsed: null, maxProjects: null, tier: null }), 'the plan could not be read');
	});
});
