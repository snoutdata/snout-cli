/**
 * `snoutdata shards …` — a Lepis cluster from a terminal or an agent (L13).
 *
 * Every operation exists once, in the router's admin API, and this file only carries it: it
 * turns words into an operation body, shows the router's own plan, asks before anything that
 * moves or deletes data, and follows the job the router writes. It decides nothing about the
 * cluster a second time. The client it talks through (`shardsClient.ts`) is either a standalone
 * router (`--admin`) or a SnoutData Cloud project (`--project <ref>`, through the
 * `cloud-project-shards` Snout Function); in the Cloud a node is a pod, so `nodes add` makes one,
 * `nodes attach <ref>` hands a ready one to the cluster, `scale --nodes N` is a count, and
 * `enable` turns the router on. Each node pod counts as a project against the plan
 * (TBD-1/TBD-4), so a node is offered while the account has a project slot spare.
 *
 * What an agent depends on, beyond the CLI's own contract (`--json`, typed exit codes):
 *
 *   * **Every operation has a dry run**: `--plan`, or `shards plan <operation>`. It changes
 *     nothing and prints what moves, how much, the estimated copy time and the expected pause.
 *   * **Anything that moves or deletes data asks first.** A person at a terminal is shown the
 *     plan and asked; anything else (no terminal, `--json`, CI) is refused with exit 2 before
 *     a single request, unless it passed `--yes`.
 *   * **A run waits for its job** and exits 0 only when the job is done: 1 when it failed or
 *     was cancelled, 10 when `--timeout` ran out first (the job carries on; `jobs watch` picks it
 *     up). `--no-wait` returns the job id at once.
 *   * **Range bounds are exact.** A range is `keyspace:lo`, the way `status` prints it, and its
 *     64-bit bound (and a seed) travels as a string both ways, never through a double.
 *   * **Advice is advice.** `shards advise` asks the router's advisor what to split, move or add,
 *     and prints each recommendation with its reason, its plan and the command that runs it.
 *     It runs nothing; the command it prints asks like any other.
 *   * **A refusal says why, in a word.** `--json` failures carry the router's `kind`
 *     (`no_such_range`, `not_adjacent`, ...; `shards ops` lists them) beside the exit code.
 */

import { createInterface } from 'node:readline/promises';
import { UsageError, flagBoolean, flagString, type ParsedArgs } from '../args.js';
import { CliFailure } from '../failure.js';
import { canAsk } from '../interactive.js';
import { bold, dim, emit, say, table } from '../output.js';
import {
	ADVICE_SETTINGS,
	CloudShardsClient,
	SETTINGS,
	describeCloudAnswer,
	isFinished,
	shardsClient,
	type Advice,
	type AdviceSettingName,
	type CloudPod,
	type CloudShardsView,
	type ClusterStatus,
	type Job,
	type JobSummary,
	type OpBody,
	type Plan,
	type SettingName,
	type ShardsClient
} from '../shardsClient.js';

/** An operation the words asked for, before anything is sent. */
export interface ParsedOp {
	body: OpBody;
	/** Moves rows, deletes rows, or takes a node away: asks first, or needs `--yes`. */
	destructive: boolean;
}

/** The operations that change where data lives, or delete it. */
const DESTRUCTIVE = new Set([
	'node.drain',
	'node.remove',
	'table.distribute',
	'table.reference',
	'table.global',
	'range.split',
	'range.merge',
	'range.move',
	'tenant.pin',
	'rebalance',
	'scale',
	'cleanup'
]);

/** Per-operation overrides of the cluster's settings, as flags: `--max-write-pause-ms 500`. */
const SETTING_FLAGS: Record<SettingName, string> = {
	max_write_pause_ms: 'max-write-pause-ms',
	drain_timeout_ms: 'drain-timeout-ms',
	ack_timeout_ms: 'ack-timeout-ms',
	copy_mb_per_s: 'copy-mb-per-s'
};

const OP_HELP = 'nodes add|drain|remove, keyspace create, table distribute|reference|global, range split|merge|move, tenant pin, rebalance, scale, verify, cleanup';

/**
 * The operation `words` name (everything after `shards`), as the admin API's body.
 *
 * Pure, and the only place a word becomes a field, so the whole vocabulary is testable without
 * a router. Every refusal is a `UsageError`: exit 2, before any request.
 */
export function parseOp(words: readonly string[], args: ParsedArgs, cloud = false): ParsedOp {
	const [noun, verb, ...rest] = words;
	const flag = (name: string) => flagString(args, name);
	const need = (value: string | undefined, what: string): string => {
		if (value === undefined || value === '') {
			throw new UsageError(what);
		}
		return value;
	};
	let body: OpBody;
	const named = `${noun ?? ''}${verb !== undefined && takesVerb(noun) ? ` ${verb}` : ''}`;
	// In SnoutData Cloud a node is a POD the project makes, so adding one takes no address, a
	// ready one is attached by its ref, and scale is a node count. Everything else is the same.
	if (cloud && (named === 'nodes add' || named === 'node add')) {
		if (rest.length > 0 || flag('host') !== undefined) {
			throw new UsageError('in SnoutData Cloud a node is a pod the project makes: shards nodes add --project <ref>, with no name or --host. Attach it once it is ready: shards nodes attach <node-ref>');
		}
		return { body: { op: 'node.add' }, destructive: false };
	}
	if (named === 'nodes attach' || named === 'node attach') {
		if (!cloud) {
			throw new UsageError('nodes attach is for a SnoutData Cloud project (--project): a standalone node joins with shards nodes add <name> --host H');
		}
		return { body: { op: 'node.attach', name: need(rest[0] ?? flag('node'), 'nodes attach needs the node pod\'s ref, as shards status lists it') }, destructive: false };
	}
	if (cloud && named === 'scale') {
		if (flag('add') !== undefined || flag('remove') !== undefined) {
			throw new UsageError('in SnoutData Cloud, scale takes --nodes N: how many nodes the project should have, the home included');
		}
		const nodes = optionalInteger(args, 'nodes', 'nodes');
		if (!nodes.nodes) {
			throw new UsageError('scale needs --nodes N: how many nodes the project should have, the home included');
		}
		body = { op: 'scale', ...nodes };
		for (const [setting, name] of Object.entries(SETTING_FLAGS)) {
			Object.assign(body, optionalInteger(args, name, setting));
		}
		return { body, destructive: true };
	}
	switch (named) {
		case 'nodes add':
		case 'node add':
			body = {
				op: 'node.add',
				name: need(rest[0] ?? flag('name'), 'nodes add needs a name: shards nodes add <name> --host H [--port 5432] [--dbname D] [--sslmode M]'),
				host: need(flag('host'), 'nodes add needs --host, the address the router reaches the node at'),
				...optionalInteger(args, 'port', 'port'),
				...optionalString(args, 'dbname', 'dbname'),
				...optionalString(args, 'sslmode', 'sslmode'),
				...optionalString(args, 'peer-host', 'peer_host')
			};
			break;
		case 'nodes drain':
		case 'node drain':
			body = {
				op: 'node.drain',
				node: need(rest[0] ?? flag('node'), 'nodes drain needs a node: shards nodes drain <id|name> [--to a,b]'),
				...(flag('to') ? { to: list(flag('to')!) } : {})
			};
			break;
		case 'nodes remove':
		case 'node remove':
			body = { op: 'node.remove', node: need(rest[0] ?? flag('node'), 'nodes remove needs a node: shards nodes remove <id|name>') };
			break;
		case 'keyspace create':
			body = {
				op: 'keyspace.create',
				name: need(rest[0] ?? flag('name'), 'keyspace create needs a name: shards keyspace create <name> --key-type bigint [--ranges N] [--nodes a,b]'),
				key_type: need(flag('key-type'), 'keyspace create needs --key-type, the shard key\'s type (bigint, int, text, uuid, ...)'),
				...optionalInteger(args, 'ranges', 'ranges'),
				...(flag('seed') !== undefined ? { seed: seed(flag('seed')!) } : {}),
				...(flag('nodes') ? { nodes: list(flag('nodes')!) } : {})
			};
			break;
		case 'table distribute':
			body = {
				op: 'table.distribute',
				table: need(rest[0], 'table distribute needs a table: shards table distribute <schema.table> --column C --keyspace K'),
				column: need(flag('column'), 'table distribute needs --column, the shard key column'),
				keyspace: need(flag('keyspace'), 'table distribute needs --keyspace')
			};
			break;
		case 'table reference':
		case 'table global':
			body = {
				op: `table.${verb}`,
				table: need(rest[0], `table ${verb} needs a table: shards table ${verb} <schema.table>`)
			};
			break;
		case 'range split': {
			const range = rangeRef(rest[0], args);
			body = {
				op: 'range.split',
				keyspace: range.keyspace,
				range: range.lo,
				...(flag('at') !== undefined ? { at: bound(flag('at')!, '--at') } : {}),
				...(flag('to') ? { to: flag('to') } : {})
			};
			break;
		}
		case 'range move': {
			const range = rangeRef(rest[0], args);
			body = {
				op: 'range.move',
				keyspace: range.keyspace,
				range: range.lo,
				to: need(flag('to'), 'range move needs --to, the node that will own it')
			};
			break;
		}
		case 'range merge': {
			if (rest.length !== 2) {
				throw new UsageError('range merge needs two adjacent ranges: shards range merge <keyspace:lo> <keyspace:lo>');
			}
			const a = rangeRef(rest[0], args);
			const b = rangeRef(rest[1], args);
			if (a.keyspace !== b.keyspace) {
				throw new UsageError(`range merge: ${a.keyspace} and ${b.keyspace} are different keyspaces`);
			}
			body = { op: 'range.merge', keyspace: a.keyspace, a: a.lo, b: b.lo };
			break;
		}
		case 'tenant pin': {
			const keyspace = flag('keyspace') ?? rest[0];
			const value = flag('value') ?? (flag('keyspace') ? rest[0] : rest[1]);
			body = {
				op: 'tenant.pin',
				keyspace: need(keyspace, 'tenant pin needs a keyspace: shards tenant pin <keyspace> <value> [--node N]'),
				value: need(value, 'tenant pin needs the key value to pin (--value V for one that starts with a dash)'),
				...(flag('node') ? { node: flag('node') } : {})
			};
			break;
		}
		case 'rebalance':
			body = { op: 'rebalance', ...optionalString(args, 'keyspace', 'keyspace') };
			break;
		case 'scale': {
			const add = flag('add') ? list(flag('add')!).map((one) => nodeSpec(one, args)) : [];
			const remove = optionalInteger(args, 'remove', 'remove');
			if (add.length === 0 && !remove.remove) {
				throw new UsageError('scale needs --add name=host[:port],... or --remove N (or both)');
			}
			body = { op: 'scale', ...(add.length > 0 ? { add } : {}), ...remove };
			break;
		}
		case 'verify':
			body = { op: 'verify', ...optionalString(args, 'keyspace', 'keyspace') };
			break;
		case 'cleanup':
			body = { op: 'cleanup', ...optionalString(args, 'node', 'node') };
			break;
		default:
			throw new UsageError(`unknown operation: shards ${words.join(' ')}. One of ${OP_HELP}`);
	}
	for (const [setting, name] of Object.entries(SETTING_FLAGS)) {
		const value = optionalInteger(args, name, setting);
		Object.assign(body, value);
	}
	return { body, destructive: DESTRUCTIVE.has(body.op) };
}

function takesVerb(noun: string | undefined): boolean {
	return noun === 'nodes' || noun === 'node' || noun === 'keyspace' || noun === 'table' || noun === 'range' || noun === 'tenant';
}

function list(value: string): string[] {
	return value
		.split(',')
		.map((one) => one.trim())
		.filter(Boolean);
}

function optionalString(args: ParsedArgs, flag: string, field: string): Record<string, string> {
	const value = flagString(args, flag);
	return value === undefined ? {} : { [field]: value };
}

/** A whole, non-negative number that a double holds exactly, or a usage error. */
function optionalInteger(args: ParsedArgs, flag: string, field: string): Record<string, number> {
	const value = flagString(args, flag);
	if (value === undefined) {
		return {};
	}
	const parsed = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed)) {
		throw new UsageError(`--${flag} must be a whole number, not "${value}"`);
	}
	return { [field]: parsed };
}

/** A 64-bit range bound, kept as text so it stays exact. */
function bound(value: string, what: string): string {
	const text = value.trim();
	if (!/^-?\d+$/.test(text) || BigInt(text) < -(2n ** 63n) || BigInt(text) >= 2n ** 63n) {
		throw new UsageError(`${what} must be a 64-bit whole number, not "${value}"`);
	}
	return BigInt(text).toString();
}

/** A hash seed: an unsigned 64-bit number, kept as text so it stays exact. */
function seed(value: string): string {
	const text = value.trim();
	if (!/^\d+$/.test(text) || BigInt(text) >= 2n ** 64n) {
		throw new UsageError(`--seed must be an unsigned 64-bit whole number, not "${value}"`);
	}
	return BigInt(text).toString();
}

/**
 * A range, as `status` prints it: `keyspace:lo`. Or `--keyspace K --range LO`, which is the
 * spelling for a bound written on its own, since `-307…` as a bare word reads as a flag.
 */
export function rangeRef(word: string | undefined, args: ParsedArgs): { keyspace: string; lo: string } {
	const keyspaceFlag = flagString(args, 'keyspace');
	const rangeFlag = flagString(args, 'range');
	if (word !== undefined && word.includes(':')) {
		const at = word.lastIndexOf(':');
		const keyspace = word.slice(0, at);
		if (!keyspace) {
			throw new UsageError(`a range is keyspace:lo, as shards status prints it, not "${word}"`);
		}
		return { keyspace, lo: bound(word.slice(at + 1), `the range's lower bound in "${word}"`) };
	}
	const lo = rangeFlag ?? word;
	if (!keyspaceFlag || lo === undefined) {
		throw new UsageError('name the range as keyspace:lo (as shards status prints it), or with --keyspace K --range LO');
	}
	return { keyspace: keyspaceFlag, lo: bound(lo, '--range') };
}

/** `name=host[:port]`, one node `scale --add` makes; `--dbname`/`--sslmode` apply to each. */
function nodeSpec(word: string, args: ParsedArgs): Record<string, unknown> {
	const match = /^([^=]+)=([^:]+)(?::(\d+))?$/.exec(word);
	if (!match) {
		throw new UsageError(`scale --add takes name=host[:port], not "${word}"`);
	}
	return {
		name: match[1],
		host: match[2],
		...(match[3] ? { port: Number(match[3]) } : {}),
		...optionalString(args, 'dbname', 'dbname'),
		...optionalString(args, 'sslmode', 'sslmode')
	};
}

/** A job id from a word, or a usage error. */
function jobId(word: string | undefined, verb: string): number {
	if (word === undefined || !/^\d+$/.test(word)) {
		throw new UsageError(`jobs ${verb} needs a job id: shards jobs ${verb} <id>`);
	}
	return Number(word);
}

export interface ShardsOptions {
	/** For tests: the client, instead of one built from `--admin` and the token. */
	client?: ShardsClient;
	/** For tests: the answer to "run it?", instead of a prompt. */
	confirm?: (question: string) => Promise<boolean>;
	/** For tests: how long to wait between looks at a running job. */
	pollMs?: number;
	timeoutMs?: number | undefined;
}

/** `snoutdata shards <words>`. Returns the exit code; failures are thrown. */
export async function shards(args: ParsedArgs, options: ShardsOptions = {}): Promise<number> {
	const words = args.command.slice(1);
	const [first, second, third] = words;
	// Parse before the client exists, so a wrong command is exit 2 whatever the credential.
	const project = flagString(args, 'project') ?? flagString(args, 'ref');
	const cloud = project !== undefined;
	const client = () => options.client ?? shardsClient({ project, admin: flagString(args, 'admin'), token: flagString(args, 'token') });

	switch (first) {
		case 'enable': {
			// The Cloud's own step: the router joins the project's pod, a restart of the database.
			if (!cloud) {
				throw new UsageError('shards enable is for a SnoutData Cloud project: shards enable --project <ref>. A standalone router is sharded from the moment it runs');
			}
			const shards = client();
			if (!(shards instanceof CloudShardsClient)) {
				throw new UsageError('shards enable needs --project <ref>');
			}
			if (flagBoolean(args, 'plan')) {
				const plan = (await shards.enable(true)) as Plan;
				emit(plan, () => printPlan(plan, process.stdout));
				return 0;
			}
			if (!flagBoolean(args, 'yes')) {
				if (!options.confirm && !canAsk()) {
					throw new UsageError('turning sharding on restarts the database once, and nothing was asked: pass --yes, or --plan to see what it does');
				}
				printPlan((await shards.enable(true)) as Plan, process.stderr);
				const ask = options.confirm ?? confirm;
				if (!(await ask(`Turn sharding on for ${shards.target}?`))) {
					throw new CliFailure('failed', 'Not turned on. Nothing was changed.');
				}
			}
			const answer = (await shards.enable(false)) as Record<string, unknown>;
			emit(answer, () => say(describeCloudAnswer(answer)));
			return 0;
		}
		case undefined:
		case 'status': {
			const status = await client().status();
			emit(status, () => printStatus(status));
			return 0;
		}
		case 'ops': {
			const ops = await client().ops();
			emit(ops, () => {
				process.stdout.write(`${ops.ops.join('\n')}\n`);
				say(dim(`Default settings: ${Object.entries(ops.settings).map(([k, v]) => `${k}=${v}`).join(', ')}`));
				if (ops.refusals && ops.refusals.length > 0) {
					say(dim(`Refusal kinds: ${ops.refusals.map((r) => `${r.kind} (${r.status})`).join(', ')}`));
				}
			});
			return 0;
		}
		case 'settings':
			return settingsCommand(args, client);
		case 'advise':
		case 'advice': {
			const sample = optionalInteger(args, 'sample-ms', 'sampleMs').sampleMs;
			const advice = await client().advice(sample);
			emit(advice, () => printAdvice(advice, process.stdout));
			return 0;
		}
		case 'jobs':
			return jobsCommand(second, third, args, client(), options);
		case 'nodes':
		case 'node':
			if (second === undefined || second === 'list') {
				const status = await client().status();
				emit({ nodes: status.nodes ?? [] }, () => printNodes(status));
				return 0;
			}
			break;
		case 'plan': {
			const parsed = parseOp(words.slice(1), args, cloud);
			const plan = await client().plan(parsed.body);
			emit(plan, () => printPlan(plan, process.stdout));
			return 0;
		}
	}

	const parsed = parseOp(words, args, cloud);
	if (flagBoolean(args, 'plan')) {
		const plan = await client().plan(parsed.body);
		emit(plan, () => printPlan(plan, process.stdout));
		return 0;
	}
	return runOp(parsed, args, client, options);
}

/**
 * Plans, asks when it must, submits, and follows the job.
 *
 * The refusal for a missing `--yes` comes before any request: an agent that forgot it learns
 * so in milliseconds, and a router is never asked to plan something nobody can approve.
 */
async function runOp(parsed: ParsedOp, args: ParsedArgs, client: () => ShardsClient, options: ShardsOptions): Promise<number> {
	const yes = flagBoolean(args, 'yes');
	const label = parsed.body.op;
	if (parsed.destructive && !yes && !options.confirm && !canAsk()) {
		throw new UsageError(`${label} moves or deletes data, and nothing was asked: pass --yes to run it, or --plan to see what it would do`);
	}
	const shards = client();
	if (parsed.destructive && !yes) {
		const plan = await shards.plan(parsed.body);
		printPlan(plan, process.stderr);
		const ask = options.confirm ?? confirm;
		if (!(await ask(`Run ${label} on ${shards.target}?`))) {
			throw new CliFailure('failed', 'Not run. Nothing was changed.');
		}
	}
	const submitted = await shards.submit(parsed.body);
	// The Cloud made or deleted a pod: done now, with no job to follow.
	if (submitted.job === undefined) {
		emit(submitted.answer, () => say(submitted.done));
		return 0;
	}
	if (flagBoolean(args, 'no-wait')) {
		emit({ job: submitted.job, state: 'pending', plan: submitted.plan }, () => {
			process.stdout.write(`${submitted.job}\n`);
			say(`Job ${submitted.job} (${label}) is queued. Follow it: snoutdata shards jobs watch ${submitted.job}`);
		});
		return 0;
	}
	say(`Job ${submitted.job} (${label}) is queued; following it. Ctrl+C stops following, not the job.`);
	const job = await follow(shards, submitted.job, options);
	return finished(job);
}

/** Ask a yes/no question whose safe answer is no. Only reached behind `canAsk()`. */
async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
		return answer === 'y' || answer === 'yes';
	} finally {
		rl.close();
	}
}

/**
 * `--set name=value,...`: any setting by its API name, which is how the advisor's thresholds
 * (`advice_min_bytes`, ...) are set without a flag each. Whole numbers only.
 */
export function parseSet(value: string): Partial<Record<SettingName | AdviceSettingName, number>> {
	const known: readonly string[] = [...SETTINGS, ...ADVICE_SETTINGS];
	const patch: Partial<Record<SettingName | AdviceSettingName, number>> = {};
	for (const pair of list(value)) {
		const at = pair.indexOf('=');
		const name = at < 0 ? pair : pair.slice(0, at).trim();
		const text = at < 0 ? '' : pair.slice(at + 1).trim();
		if (!known.includes(name)) {
			throw new UsageError(`--set: unknown setting "${name}". One of ${known.join(', ')}`);
		}
		const parsed = Number(text);
		if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed)) {
			throw new UsageError(`--set ${name} must be a whole number, not "${text}"`);
		}
		patch[name as SettingName | AdviceSettingName] = parsed;
	}
	return patch;
}

async function settingsCommand(args: ParsedArgs, client: () => ShardsClient): Promise<number> {
	const patch: Partial<Record<SettingName | AdviceSettingName, number>> = {};
	for (const setting of SETTINGS) {
		Object.assign(patch, optionalInteger(args, SETTING_FLAGS[setting], setting));
	}
	const set = flagString(args, 'set');
	if (set !== undefined) {
		Object.assign(patch, parseSet(set));
	}
	if (Object.keys(patch).length === 0) {
		const status = await client().status();
		const settings = { ...(status.settings ?? {}), ...(status.advice_settings ?? {}) };
		emit({ settings }, () => process.stdout.write(`${table(Object.entries(settings).map(([k, v]) => [k, String(v)]))}\n`));
		return 0;
	}
	const changed = await client().settings(patch);
	emit(changed, () => say(`Set ${Object.entries(changed.settings).map(([k, v]) => `${k}=${v}`).join(', ')}.`));
	return 0;
}

async function jobsCommand(verb: string | undefined, word: string | undefined, args: ParsedArgs, client: ShardsClient, options: ShardsOptions): Promise<number> {
	switch (verb) {
		case undefined:
		case 'list': {
			const jobs = await client.jobs();
			emit({ jobs }, () => printJobs(jobs));
			return 0;
		}
		case 'show': {
			const job = await client.job(jobId(word, 'show'));
			emit(job, () => printJob(job));
			return 0;
		}
		case 'watch': {
			const job = await follow(client, jobId(word, 'watch'), options);
			return finished(job);
		}
		case 'cancel': {
			const id = jobId(word, 'cancel');
			// Cancelling a move before its cutover rolls it back; after, it finishes its cleanup.
			// Either way it is a change to the cluster, so it asks like one.
			if (!flagBoolean(args, 'yes')) {
				if (!options.confirm && !canAsk()) {
					throw new UsageError(`cancelling job ${id} stops a running operation, and nothing was asked: pass --yes`);
				}
				const ask = options.confirm ?? confirm;
				if (!(await ask(`Cancel job ${id} on ${client.target}?`))) {
					throw new CliFailure('failed', 'Not cancelled. Nothing was changed.');
				}
			}
			const result = await client.cancel(id);
			emit(result, () => say(`Job ${id}: ${result.state}.`));
			return 0;
		}
		case 'resume': {
			const id = jobId(word, 'resume');
			const result = await client.resume(id);
			if (flagBoolean(args, 'no-wait')) {
				emit(result, () => say(`Job ${id}: ${result.state}. Follow it: snoutdata shards jobs watch ${id}`));
				return 0;
			}
			return finished(await follow(client, id, options));
		}
		default:
			throw new UsageError(`unknown command: shards jobs ${verb}. jobs [list|show|watch|cancel|resume] <id>`);
	}
}

/**
 * Looks at a job until it finishes or the timeout runs out, saying each step as it changes.
 * Following is only reading: stopping it, by Ctrl+C or the timeout, leaves the job running.
 */
export async function follow(client: ShardsClient, id: number, options: ShardsOptions = {}): Promise<Job> {
	const pollMs = options.pollMs ?? 1000;
	const deadline = options.timeoutMs === undefined ? Infinity : Date.now() + options.timeoutMs;
	const seen = new Map<number, string>();
	for (;;) {
		const job = await client.job(id);
		for (const step of job.steps) {
			const phase = typeof step.detail?.phase === 'string' ? step.detail.phase : '';
			const now = `${step.state}${phase ? ` ${phase}` : ''}`;
			if (seen.get(step.n) !== now) {
				seen.set(step.n, now);
				if (step.state !== 'pending') {
					say(dim(`  step ${step.n + 1}/${job.steps.length} ${step.kind}: ${now}`));
				}
			}
		}
		if (isFinished(job.state)) {
			return job;
		}
		if (Date.now() >= deadline) {
			throw new CliFailure(
				'timeout',
				`job ${id} is still ${job.state}; it carries on without this command. Follow it again: snoutdata shards jobs watch ${id}`,
				{ job }
			);
		}
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/** A finished job as the exit code: done is 0, anything else is a failure carrying the job. */
function finished(job: Job): number {
	if (job.state === 'done') {
		emit(job, () => process.stdout.write(`Job ${job.id} (${job.op}): done, ${job.steps.length} step${job.steps.length === 1 ? '' : 's'}.\n`));
		return 0;
	}
	const why = job.state === 'failed' ? `failed: ${job.error ?? 'no reason recorded'}. Resume it from the failed step: snoutdata shards jobs resume ${job.id}` : 'was cancelled';
	throw new CliFailure('failed', `job ${job.id} (${job.op}) ${why}`, { job });
}

// ---- Rendering. Human mode only; --json is the API's own value, unchanged.

type Out = { write(text: string): unknown };

function line(out: Out, text = ''): void {
	out.write(`${text}\n`);
}

/** Bytes in the unit a person would say. */
export function describeBytes(bytes: number): string {
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/** The plan, as somebody deciding whether to run it wants to read it. */
export function printPlan(plan: Plan, out: Out): void {
	line(out, `${bold(plan.op)}: ${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}, ${plan.cutovers} cutover${plan.cutovers === 1 ? '' : 's'}`);
	if (plan.moves.length > 0) {
		line(
			out,
			table([
				['  FROM', 'TO', 'TABLES', 'ROWS', 'SIZE', 'COPY', 'PAUSE'],
				...plan.moves.map((move) => [
					`  node ${move.source}`,
					move.targets.map((t) => `node ${t}`).join(', ') || '-',
					move.tables.join(', ') || '-',
					`~${move.estimated_rows.toLocaleString('en-US')}`,
					describeBytes(move.estimated_bytes),
					`~${move.estimated_copy_seconds}s`,
					`~${move.expected_pause_ms}ms`
				])
			])
		);
	}
	line(
		out,
		`  total: ~${plan.estimated_rows.toLocaleString('en-US')} rows, ${describeBytes(plan.estimated_bytes)}, ~${plan.estimated_copy_seconds}s to copy, expected write pause ~${plan.expected_pause_ms}ms (ceiling ${plan.max_write_pause_ms}ms)`
	);
	line(out, `  steps: ${plan.steps.map((s) => s.kind).join(', ') || 'none'}`);
	for (const warning of plan.warnings) {
		line(out, `  warning: ${warning}`);
	}
	if (plan.assumptions) {
		line(out, dim(`  ${plan.assumptions}`));
	}
}

/** A word for a shell: as it is when it is plain, single-quoted otherwise. */
function shellWord(value: unknown): string {
	const text = String(value);
	return /^[\w.:@+-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

/**
 * The `snoutdata shards` command that runs a recommendation, or null for one this CLI has no
 * words for. A `node.add` that still needs an address gets a placeholder a person must replace.
 */
export function commandFor(request: OpBody): string | null {
	const r = request as Record<string, unknown>;
	const base = 'snoutdata shards';
	switch (request.op) {
		case 'range.split':
			return `${base} range split ${shellWord(`${r.keyspace}:${r.range}`)}${r.at !== undefined ? ` --at ${shellWord(r.at)}` : ''}${r.to !== undefined ? ` --to ${shellWord(r.to)}` : ''}`;
		case 'range.move':
			return `${base} range move ${shellWord(`${r.keyspace}:${r.range}`)} --to ${shellWord(r.to)}`;
		case 'tenant.pin':
			return `${base} tenant pin ${shellWord(r.keyspace)} --value ${shellWord(r.value)}${r.node !== undefined ? ` --node ${shellWord(r.node)}` : ''}`;
		case 'node.add':
			return `${base} nodes add ${shellWord(r.name)} --host ${r.host ? shellWord(r.host) : '<its address>'}, then ${base} rebalance`;
		case 'rebalance':
			return `${base} rebalance${r.keyspace ? ` --keyspace ${shellWord(r.keyspace)}` : ''}`;
		default:
			return null;
	}
}

/** The advisor's answer, as somebody deciding what to do next wants to read it. */
export function printAdvice(advice: Advice, out: Out): void {
	line(out, advice.summary);
	advice.advice.forEach((one, i) => {
		line(out);
		line(out, `${bold(`${i + 1}. ${one.op}`)} (${one.metric})`);
		line(out, `   ${one.reason}`);
		const command = commandFor(one.request);
		line(out, `   run: ${command ?? JSON.stringify(one.request)}`);
		if (one.plan) {
			const p = one.plan;
			line(
				out,
				`   plan: ${p.cutovers} cutover${p.cutovers === 1 ? '' : 's'}, ~${p.estimated_rows.toLocaleString('en-US')} rows, ${describeBytes(p.estimated_bytes)}, ~${p.estimated_copy_seconds}s to copy, expected write pause ~${p.expected_pause_ms}ms`
			);
			for (const warning of p.warnings ?? []) {
				line(out, `   warning: ${warning}`);
			}
		} else if (one.needs.length > 0) {
			line(out, `   needs: ${one.needs.join(', ')}, so it has no plan yet`);
		} else if (one.plan_error) {
			line(out, `   no plan: ${one.plan_error.message} (${one.plan_error.kind})`);
		}
	});
	if (advice.assumptions) {
		line(out);
		line(out, dim(advice.assumptions));
	}
}

function nodeName(status: ClusterStatus, id: number): string {
	return status.nodes?.find((n) => n.id === id)?.name ?? `node ${id}`;
}

function printNodes(status: ClusterStatus): void {
	const nodes = status.nodes ?? [];
	if (nodes.length === 0) {
		say('No nodes in the catalog.');
		return;
	}
	line(
		process.stdout,
		table([
			['ID', 'NAME', 'ADDRESS', 'STATE', 'HOME', 'RANGES', 'POSTGRES'],
			...nodes.map((n) => [
				String(n.id),
				n.name,
				`${n.host}:${n.port}/${n.dbname}`,
				n.state,
				n.home ? 'yes' : '',
				String(n.ranges.length),
				n.server_version_num ? String(Math.floor(n.server_version_num / 10_000)) : '?'
			])
		])
	);
}

/** The cluster: nodes, ranges, tables, routers, and what is still running. */
export function printStatus(status: ClusterStatus): void {
	const out = process.stdout;
	if (status.cloud) {
		printCloud(status.cloud, out);
		if (!status.cloud.sharded) {
			return;
		}
	}
	if (!status.catalog) {
		line(out, 'The home node has no Lepis catalog yet (schema lepis).');
		return;
	}
	line(out, `${bold('Cluster')} at epoch ${status.epoch}`);
	line(out);
	printNodes(status);
	for (const keyspace of status.keyspaces ?? []) {
		line(out);
		line(out, `${bold(`Keyspace ${keyspace.name}`)} (${keyspace.key_type}, ${keyspace.ranges.length} range${keyspace.ranges.length === 1 ? '' : 's'})`);
		line(
			out,
			table([
				['  RANGE', 'HI', 'NODE'],
				...keyspace.ranges.map((r) => [`  ${keyspace.name}:${r.lo}`, r.hi, nodeName(status, r.node)])
			])
		);
		for (const pin of keyspace.pins) {
			line(out, `  pinned: ${pin.value} on ${nodeName(status, pin.node)}`);
		}
	}
	const tables = status.tables ?? [];
	if (tables.length > 0) {
		line(out);
		line(
			out,
			table([
				['TABLE', 'KIND', 'KEYSPACE', 'COLUMN'],
				...tables.map((t) => [t.table, t.kind, t.keyspace ?? '', t.column ?? ''])
			])
		);
	}
	const routers = status.routers ?? [];
	if (routers.length > 0) {
		line(out);
		line(out, `Routers: ${routers.map((r) => `${r.id} (epoch ${r.epoch}${r.live ? '' : ', not heard from'}${r.current ? '' : ', behind'})`).join('; ')}`);
	}
	const jobs = status.jobs ?? [];
	if (jobs.length > 0) {
		line(out, `Unfinished jobs: ${jobs.map((j) => `${j.id} ${j.op} ${j.state}`).join('; ')}`);
	}
	if (status.settings) {
		say(dim(`Settings: ${Object.entries(status.settings).map(([k, v]) => `${k}=${v}`).join(', ')}`));
	}
}

/** What the next step for a node pod is, as the command that takes it. */
export function podStep(cloud: CloudShardsView, pod: CloudPod): string {
	switch (pod.next) {
		case 'attach':
			return `ready: snoutdata shards nodes attach ${pod.ref} --project ${cloud.ref}`;
		case 'delete-pod':
			return `let go by the cluster: snoutdata shards nodes remove ${pod.ref} --project ${cloud.ref} deletes its pod`;
		case 'wait':
			return `being made (${pod.state})`;
		default:
			return pod.node ? `node ${pod.node.id}, ${pod.node.state}` : pod.state;
	}
}

/** Project slots left on the plan, 0 when unread: each node pod takes one. */
export function spareSlots(cloud: Pick<CloudShardsView, 'projectsUsed' | 'maxProjects'>): number {
	if (cloud.projectsUsed === null || cloud.maxProjects === null) {
		return 0;
	}
	return Math.max(0, cloud.maxProjects - cloud.projectsUsed);
}

/** The plan's project slots, which nodes share, as a phrase. */
export function slotsPhrase(cloud: Pick<CloudShardsView, 'projectsUsed' | 'maxProjects' | 'tier'>): string {
	if (cloud.projectsUsed === null || cloud.maxProjects === null) {
		return 'the plan could not be read';
	}
	return `${cloud.projectsUsed} of ${cloud.maxProjects} project slots used on the ${cloud.tier ?? 'current'} plan; each node uses one`;
}

/** A Cloud project's side of the cluster: whether it is sharded, its slots, and its node pods. */
function printCloud(cloud: CloudShardsView, out: Out): void {
	const limit = slotsPhrase(cloud);
	if (!cloud.sharded) {
		line(out, `${bold(cloud.ref)} is not sharded (${limit}).`);
		if (spareSlots(cloud) > 0) {
			line(out, `Turn it on: snoutdata shards enable --project ${cloud.ref} (the database restarts once).`);
		}
		return;
	}
	const nodes = 1 + cloud.pods.filter((p) => p.desiredState !== 'deleted').length;
	line(out, `${bold(cloud.ref)}: ${nodes} node${nodes === 1 ? '' : 's'}, ${limit}`);
	if (cloud.pods.length > 0) {
		line(out, table([['  POD', 'STATE', 'NEXT'], ...cloud.pods.map((p) => [`  ${p.ref}`, p.state, podStep(cloud, p)])]));
	}
	if (cloud.routerError) {
		line(out, `The router did not answer: ${cloud.routerError}`);
	}
	line(out);
}

function printJobs(jobs: JobSummary[]): void {
	if (jobs.length === 0) {
		say('No jobs yet.');
		return;
	}
	line(
		process.stdout,
		table([
			['ID', 'OPERATION', 'STATE', 'STEPS', 'CREATED', 'ERROR'],
			...jobs.map((j) => [String(j.id), j.op, j.state, `${j.steps_done}/${j.steps}`, j.created_at.slice(0, 19).replace('T', ' '), j.error ?? ''])
		])
	);
}

function printJob(job: Job): void {
	const out = process.stdout;
	line(out, `${bold(`Job ${job.id}`)} ${job.op}: ${job.state}${job.error ? ` (${job.error})` : ''}`);
	line(
		out,
		table([
			['  STEP', 'KIND', 'STATE', 'PHASE'],
			...job.steps.map((s) => [`  ${s.n + 1}`, s.kind, s.state, typeof s.detail?.phase === 'string' ? s.detail.phase : ''])
		])
	);
	if (job.plan && Array.isArray(job.plan.steps)) {
		line(out);
		printPlan(job.plan, out);
	}
}
