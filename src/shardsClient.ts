/**
 * The one seam `snoutdata cluster` talks through: a Lepis cluster's operations, whoever serves
 * them (one management API, whatever the surface).
 *
 * Two implementations. `AdminClient`: a standalone router's admin API, reached with `--admin
 * <url>` and its bearer token, with no SnoutData account at all. `CloudShardsClient`: a SnoutData
 * Cloud project, by `--project <ref>`, through the `cloud-project-shards` Snout Function with the
 * user's own session, which forwards to that project's router (Phase 8). The command, its
 * rendering, its confirmations and its exit codes are the same for both. Nothing here decides
 * anything about a cluster: the router plans, the router runs, and this file carries the
 * question and the answer.
 *
 * The Cloud adds one thing a router cannot do for itself, and only there: a node is a POD the
 * control plane makes (`nodes add`, then `nodes attach <ref>` once it is ready) and deletes
 * (`nodes remove` on a node the catalog has let go of). Those answers carry no job, so `submit`
 * says what was done instead (`CloudDone`).
 *
 * Two things this file is careful about:
 *
 *   * **The token never appears in anything this prints.** It goes in one header and nowhere
 *     else, and no error built here quotes a request.
 *   * **A 64-bit number stays exact.** Range bounds and seeds are `bigint` in Lepis's catalog,
 *     and the admin API sends them as strings everywhere (status, plans, steps), so nothing here
 *     ever puts one through a double. The CLI sends them as strings too.
 */

import * as api from './api.js';
import { CliFailure, codeForStatus, codeForThrown, type FailureCode } from './failure.js';

/** An operation as the admin API takes it: `{"op": "range.move", ...}`. */
export interface OpBody {
	op: string;
	[field: string]: unknown;
}

export interface PlanMove {
	source: number;
	targets: number[];
	tables: string[];
	change: Record<string, unknown>;
	estimated_rows: number;
	estimated_bytes: number;
	estimated_copy_seconds: number;
	expected_pause_ms: number;
}

/** What `POST /v1/plan` answers: the dry run every operation has. */
export interface Plan {
	op: string;
	steps: { kind: string; args: Record<string, unknown> }[];
	moves: PlanMove[];
	cutovers: number;
	estimated_rows: number;
	estimated_bytes: number;
	estimated_copy_seconds: number;
	expected_pause_ms: number;
	max_write_pause_ms: number;
	assumptions?: string;
	warnings: string[];
}

export interface ClusterRange {
	lo: string;
	hi: string;
	node: number;
}

export interface ClusterNode {
	id: number;
	name: string;
	host: string;
	port: number;
	dbname: string;
	home: boolean;
	state: string;
	server_version_num: number | null;
	ranges: { keyspace: string; lo: string; hi: string }[];
}

export interface ClusterStatus {
	catalog: boolean;
	epoch?: number | string;
	settings?: Record<string, number>;
	advice_settings?: Record<string, number>;
	nodes?: ClusterNode[];
	keyspaces?: { name: string; key_type: string; seed: string; ranges: ClusterRange[]; pins: { value: string; node: number }[] }[];
	tables?: { table: string; kind: string; keyspace: string | null; column: string | null }[];
	routers?: { id: string; epoch: number | string; current: boolean; seen_at: string; live: boolean; fenced_epoch: number | string | null }[];
	jobs?: { id: number; op: string; state: string; created_at: string }[];
	/** The Cloud form only: the project, its plan's node limit, and its node pods. */
	cloud?: CloudShardsView;
}

/** A node pod of a Cloud project, beside the catalog's view of it, and the step that follows. */
export interface CloudPod {
	ref: string;
	ordinal: number;
	state: string;
	desiredState: string;
	hasOwnBackup: boolean;
	standbyOf: string | null;
	node: { id: number; state: string } | null;
	/**
	 * attach: ready and not in the catalog, joining by hand. delete-pod: the catalog let it go.
	 * wait: still being made. joining: the cluster is bringing it in on its own.
	 */
	next: 'attach' | 'delete-pod' | 'wait' | 'joining' | null;
	/** How far its automatic join is (copying, joining, spreading), or failed. Absent from older control planes. */
	joining?: 'copying' | 'joining' | 'spreading' | 'failed' | null;
	joinError?: string | null;
	/** Set on a replica: the node it follows and protects. A replica is never attached. Absent from older control planes. */
	replicaOf?: string | null;
	/** On a node: its replica's ref, when it has one. */
	replica?: string | null;
	/** The owner asked for a replica; a new one follows a failover. */
	wantsReplica?: boolean;
	/** A failover of this node to its replica: stopping the node, promoting the replica, or stopped. */
	failover?: 'fence' | 'promote' | 'held' | 'failed' | null;
	failoverError?: string | null;
}

/** Something that happened to a cluster that its owner must know about (L18, migration 174). */
export interface ClusterAlert {
	id: string;
	/** corruption, node-failing, failover-done, failover-failed, replica-missing or replica-behind. */
	kind: string;
	node: string | null;
	severity: 'info' | 'warning' | 'critical';
	message: string;
	openedAt: string;
	resolvedAt: string | null;
	resolution: string | null;
	acknowledged: boolean;
}

/** What `cloud-project-shards` says about a project besides its router's status. */
export interface CloudShardsView {
	ref: string;
	sharded: boolean;
	/** The account's projects plus node pods: each node of a sharded project counts as one project. */
	projectsUsed: number | null;
	/** The plan's project limit, which nodes share. */
	maxProjects: number | null;
	tier: string | null;
	desiredNodes: number;
	maxWritePauseMs: number | null;
	pods: CloudPod[];
	/** ready, starting (the restart after enable, or a wake), paused, or unreachable. */
	router?: 'ready' | 'starting' | 'paused' | 'unreachable' | null;
	/** Set only when the router is really not answering, never while it starts. */
	routerError: string | null;
	/** A request the cluster is finishing on its own, such as a table being spread. */
	automation?: { active: boolean; queue: string[]; queueJob: number | null; queueError: string | null } | null;
	/** Open alerts first, then those resolved in the last day. Absent from older control planes. */
	alerts?: ClusterAlert[];
}

export type JobState = 'pending' | 'running' | 'done' | 'failed' | 'cancelling' | 'cancelled';

export interface JobSummary {
	id: number;
	op: string;
	state: JobState;
	error: string | null;
	created_at: string;
	finished_at: string | null;
	steps: number;
	steps_done: number;
}

export interface JobStep {
	n: number;
	kind: string;
	args: Record<string, unknown>;
	state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
	detail: Record<string, unknown>;
	started_at: string | null;
	finished_at: string | null;
}

export interface Job {
	id: number;
	op: string;
	args: Record<string, unknown>;
	plan: Plan;
	state: JobState;
	error: string | null;
	runner: string | null;
	created_at: string;
	updated_at: string;
	finished_at: string | null;
	steps: JobStep[];
}

/** What `GET /v1/ops` answers: the operations, the default settings, and every refusal kind. */
export interface OpsDescription {
	ops: string[];
	settings: Record<string, number>;
	advice_settings?: Record<string, number>;
	refusals?: { kind: string; status: number }[];
}

/**
 * One recommendation from the router's advisor (`GET /v1/advice`, Phase 10): a body that
 * `POST /v1/jobs` takes as it is, the reason in a sentence, and the plan the router computed for
 * it. `needs` names what a person must still fill in (a new node's `host`), in which case there
 * is no plan yet. Nothing in it has run.
 */
export interface Recommendation {
	op: string;
	request: OpBody;
	reason: string;
	/** What it is about: `size`, `writes`, `disk` or `connections`. */
	metric: string;
	needs: string[];
	plan: Plan | null;
	plan_error?: { kind: string; message: string };
}

/** What `GET /v1/advice` answers. Byte counts are numbers; range bounds are strings. */
export interface Advice {
	summary: string;
	advice: Recommendation[];
	facts: {
		sampled_ms: number;
		nodes: { id: number; name: string; active: boolean; db_bytes: number; connections: number; max_connections: number; writes_per_s: number; error: string | null }[];
		ranges: { keyspace: string; lo: string; hi: string; node: number; rows: number; bytes: number; writes_per_s: number; sampled_rows: number }[];
	};
	settings: Record<string, number>;
	assumptions: string;
}

/** The cluster's L10 settings, as `POST /v1/settings` takes them. */
export const SETTINGS = ['max_write_pause_ms', 'drain_timeout_ms', 'ack_timeout_ms', 'copy_mb_per_s'] as const;
export type SettingName = (typeof SETTINGS)[number];

/** The advisor's thresholds, set the same way. Their defaults are chosen, not measured. */
export const ADVICE_SETTINGS = [
	'advice_sample_ms',
	'advice_min_bytes',
	'advice_split_bytes',
	'advice_skew_pct',
	'advice_hot_pct',
	'advice_min_writes_per_s',
	'advice_pin_pct',
	'advice_node_disk_bytes',
	'advice_disk_pct',
	'advice_conn_pct'
] as const;
export type AdviceSettingName = (typeof ADVICE_SETTINGS)[number];

/** A job that will not change again. */
export function isFinished(state: string): boolean {
	return state === 'done' || state === 'failed' || state === 'cancelled';
}

/** A job was written: its id and the plan it runs. */
export interface Submitted {
	job: number;
	plan: Plan;
}

/** The Cloud did it with no job: a pod made or deleted. `done` is the sentence for a person. */
export interface CloudDone {
	job?: undefined;
	done: string;
	answer: Record<string, unknown>;
}

/** The operations of a Lepis cluster, wherever it is served from. */
export interface ShardsClient {
	/** Where the answers come from, for a person to read. Never carries the credential. */
	readonly target: string;
	status(): Promise<ClusterStatus>;
	ops(): Promise<OpsDescription>;
	plan(body: OpBody): Promise<Plan>;
	submit(body: OpBody): Promise<Submitted | CloudDone>;
	jobs(): Promise<JobSummary[]>;
	job(id: number): Promise<Job>;
	cancel(id: number): Promise<{ job: number; state: string }>;
	resume(id: number): Promise<{ job: number; state: string }>;
	settings(patch: Partial<Record<SettingName | AdviceSettingName, number>>): Promise<{ settings: Record<string, number> }>;
	/** The advisor's recommendations. `sampleMs`: how long to measure write rates over (0: none). */
	advice(sampleMs?: number): Promise<Advice>;
}

export interface ShardsTarget {
	/** `--project`: a SnoutData Cloud project's ref. Wins over the environment's router. */
	project?: string | undefined;
	/** `--admin`, else `LEPIS_ADMIN_URL`. */
	admin?: string | undefined;
	/** `--token`, else `LEPIS_ADMIN_TOKEN`. */
	token?: string | undefined;
}

/**
 * The client for this run. Refuses before any network: a bad URL is the command being wrong
 * (exit 2), and no token is the credential (exit 3).
 */
export function shardsClient(target: ShardsTarget, env: NodeJS.ProcessEnv = process.env): ShardsClient {
	if (target.project !== undefined) {
		if (target.admin !== undefined) {
			throw new CliFailure('usage', 'cluster takes --project (a SnoutData Cloud project) or --admin (a standalone router), not both');
		}
		return new CloudShardsClient(cloudRef(target.project));
	}
	const admin = target.admin ?? nonEmpty(env.LEPIS_ADMIN_URL);
	if (!admin) {
		throw new CliFailure(
			'usage',
			'cluster needs a project: --project <ref> for a SnoutData Cloud project, or --admin <url> (or LEPIS_ADMIN_URL) for the admin API of a standalone Lepis router (LEPIS_ADMIN_ADDR)'
		);
	}
	const token = target.token ?? nonEmpty(env.LEPIS_ADMIN_TOKEN);
	if (!token) {
		throw new CliFailure('not-signed-in', 'no admin token: set LEPIS_ADMIN_TOKEN to the router\'s token, or pass --token');
	}
	return new AdminClient(adminUrl(admin), token);
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value === '' ? undefined : value;
}

/**
 * `--admin` as a base URL, or a usage error.
 *
 * Plain http is refused for anything but this machine, the same rule the router applies to
 * its own listener: the token is a bearer credential, and it does not cross a network in the
 * clear. A bare `host:port` means http on loopback, since that is how LEPIS_ADMIN_ADDR is written.
 */
export function adminUrl(raw: string): URL {
	const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new CliFailure('usage', `--admin: not a URL: ${raw}`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new CliFailure('usage', `--admin: http or https, not ${url.protocol.replace(':', '')}`);
	}
	if (url.username || url.password) {
		throw new CliFailure('usage', '--admin: the URL carries no credentials; the token comes from LEPIS_ADMIN_TOKEN or --token');
	}
	if (url.protocol === 'http:' && !isLoopback(url.hostname)) {
		throw new CliFailure(
			'usage',
			`--admin: ${url.host} is not this machine, and plain http would send the token in the clear. Use https (the router serves it when it has LEPIS_TLS_CERT), or a tunnel to 127.0.0.1`
		);
	}
	url.pathname = url.pathname.replace(/\/+$/, '');
	url.search = '';
	url.hash = '';
	return url;
}

function isLoopback(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** One request's ceiling. A plan reads statistics on every node, which is not instant. */
const REQUEST_MS = 60_000;

/** A standalone router's admin API (snout-lepis's `src/admin.rs`). */
export class AdminClient implements ShardsClient {
	readonly target: string;
	readonly #base: URL;
	readonly #token: string;

	constructor(base: URL, token: string) {
		this.#base = base;
		this.#token = token;
		this.target = base.toString().replace(/\/$/, '');
	}

	status(): Promise<ClusterStatus> {
		return this.#call('GET', '/v1/status');
	}

	ops(): Promise<OpsDescription> {
		return this.#call('GET', '/v1/ops');
	}

	plan(body: OpBody): Promise<Plan> {
		return this.#call('POST', '/v1/plan', body);
	}

	submit(body: OpBody): Promise<{ job: number; plan: Plan }> {
		return this.#call('POST', '/v1/jobs', body);
	}

	async jobs(): Promise<JobSummary[]> {
		return (await this.#call<{ jobs: JobSummary[] }>('GET', '/v1/jobs')).jobs;
	}

	job(id: number): Promise<Job> {
		return this.#call('GET', `/v1/jobs/${id}`);
	}

	cancel(id: number): Promise<{ job: number; state: string }> {
		return this.#call('POST', `/v1/jobs/${id}/cancel`);
	}

	resume(id: number): Promise<{ job: number; state: string }> {
		return this.#call('POST', `/v1/jobs/${id}/resume`);
	}

	settings(patch: Partial<Record<SettingName | AdviceSettingName, number>>): Promise<{ settings: Record<string, number> }> {
		return this.#call('POST', '/v1/settings', patch);
	}

	advice(sampleMs?: number): Promise<Advice> {
		return this.#call('GET', sampleMs === undefined ? '/v1/advice' : `/v1/advice?sample_ms=${Math.max(0, Math.floor(sampleMs))}`);
	}

	async #call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
		const url = `${this.target}${path}`;
		let response: Response;
		try {
			response = await fetch(url, {
				method,
				headers: {
					authorization: `Bearer ${this.#token}`,
					accept: 'application/json',
					...(method === 'POST' ? { 'content-type': 'application/json' } : {})
				},
				...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
				signal: AbortSignal.timeout(REQUEST_MS)
			});
		} catch (error) {
			const code = codeForThrown(error);
			const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
			throw new CliFailure(code === 'failed' ? 'network' : code, `could not reach the Lepis admin API at ${this.target}: ${reason}`);
		}
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text === '' ? {} : JSON.parse(text);
		} catch {
			throw new CliFailure('server', `the admin API at ${this.target} answered ${response.status} with something that is not JSON`, { status: response.status });
		}
		if (!response.ok) {
			throw adminFailure(response.status, parsed);
		}
		return parsed as T;
	}
}

/**
 * The admin API's error classes, as this CLI's failure codes. The exit codes are the ones the
 * CLI has always meant: 2 the request was wrong, 3 the token, 6 not found, 7 the cluster's state
 * refused it, 1 a node call failed, 10 timed out.
 */
const API_CODES: Record<string, FailureCode> = {
	bad_request: 'usage',
	unauthorized: 'not-signed-in',
	not_found: 'not-found',
	conflict: 'conflict',
	failed: 'failed',
	timeout: 'timeout'
};

/**
 * An admin API error as a failure an agent can branch on.
 *
 * The router answers `{"error": {"code", "kind", "message", "sqlstate"?}}`: `code` is the class
 * and decides the exit code; `kind` is the stable reason (`no_such_job`, `not_adjacent`, ...;
 * `shards ops` lists them all) and is handed back as-is in `--json`, so an agent branches on it
 * rather than on the sentence. A body without a known `code` falls back to the HTTP status.
 */
export function adminFailure(status: number, body: unknown): CliFailure {
	const error = (body as { error?: { code?: string; kind?: string; message?: string; sqlstate?: string } } | null)?.error ?? {};
	const message = error.message ?? `the admin API answered ${status}`;
	const details: Record<string, unknown> = { status };
	if (error.code) {
		details.apiCode = error.code;
	}
	if (error.kind) {
		details.kind = error.kind;
	}
	if (error.sqlstate) {
		details.sqlstate = error.sqlstate;
	}
	const code = (error.code ? API_CODES[error.code] : undefined) ?? (status === 401 ? 'not-signed-in' : status === 400 ? 'usage' : codeForStatus(status));
	if (code === 'not-signed-in') {
		return new CliFailure(code, 'the router refused the admin token (LEPIS_ADMIN_TOKEN or --token)', details);
	}
	return new CliFailure(code, message, details);
}

/** A project ref as `--project` must spell it, or a usage error before any request. */
export function cloudRef(raw: string): string {
	const ref = raw.trim();
	if (!/^[a-z][0-9a-z]{12}$/.test(ref)) {
		throw new CliFailure('usage', `--project: not a project ref: ${raw} (13 characters, as projects list prints it)`);
	}
	return ref;
}

/**
 * The Snout Function's action for an operation name: the vocabulary is the router's, and the
 * function takes it by action. A word map, not a decision; the function and the router decide.
 */
const CLOUD_ACTIONS: Record<string, string> = {
	'node.add': 'add-node',
	'node.attach': 'attach',
	'node.drain': 'drain',
	'node.remove': 'remove',
	'keyspace.create': 'keyspace',
	'table.distribute': 'distribute',
	'table.reference': 'reference',
	'table.global': 'global',
	'range.split': 'split',
	'range.merge': 'merge',
	'range.move': 'move',
	'tenant.pin': 'pin',
	rebalance: 'rebalance',
	scale: 'scale',
	verify: 'verify',
	cleanup: 'cleanup',
	'keyspace.drop': 'drop-keyspace',
	dissolve: 'disable'
};

/** How the Snout Function is called; `api.call` unless a test hands in its own. */
export type FunctionCall = <T>(fn: string, body: unknown) => Promise<T>;

/** The Snout Function a Cloud project's cluster is managed through. */
export const SHARDS_FUNCTION = 'cloud-project-shards';

/**
 * A SnoutData Cloud project's cluster, through `cloud-project-shards` with the signed-in user's
 * session (or SNOUTDATA_ACCESS_TOKEN). RLS decides who sees the project and the function decides
 * who may change it; the router decides everything about the cluster.
 */
export class CloudShardsClient implements ShardsClient {
	readonly target: string;
	readonly ref: string;
	readonly #call: FunctionCall;

	constructor(ref: string, call: FunctionCall = api.call) {
		this.ref = ref;
		this.target = `project ${ref}`;
		this.#call = call;
	}

	/** The cluster as the router sees it, with the Cloud's view of the project beside it. */
	async status(): Promise<ClusterStatus> {
		const answer = await this.#send<CloudShardsView & { cluster: ClusterStatus | null }>({ action: 'status' });
		const { cluster, ...cloud } = answer;
		return { ...(cluster ?? { catalog: false }), cloud };
	}

	ops(): Promise<OpsDescription> {
		return this.#send({ action: 'ops' });
	}

	async plan(body: OpBody): Promise<Plan> {
		this.#action(body);
		return this.#send<Plan>({ action: 'plan', request: body });
	}

	async submit(body: OpBody): Promise<Submitted | CloudDone> {
		const action = this.#action(body);
		const request: Record<string, unknown> = { ...body };
		delete request.op;
		const answer = await this.#send<Record<string, unknown>>({ action, request });
		if (typeof answer.job === 'number') {
			return { job: answer.job, plan: answer.plan as Plan };
		}
		return { done: describeCloudAnswer(answer), answer };
	}

	async jobs(): Promise<JobSummary[]> {
		return (await this.#send<{ jobs: JobSummary[] }>({ action: 'jobs' })).jobs;
	}

	job(id: number): Promise<Job> {
		return this.#send({ action: 'jobs', id });
	}

	cancel(id: number): Promise<{ job: number; state: string }> {
		return this.#send({ action: 'cancel', id });
	}

	resume(id: number): Promise<{ job: number; state: string }> {
		return this.#send({ action: 'resume', id });
	}

	settings(patch: Partial<Record<SettingName | AdviceSettingName, number>>): Promise<{ settings: Record<string, number> }> {
		return this.#send({ action: 'settings', settings: patch });
	}

	advice(sampleMs?: number): Promise<Advice> {
		return this.#send({ action: 'advice', ...(sampleMs === undefined ? {} : { sampleMs: Math.max(0, Math.floor(sampleMs)) }) });
	}

	/** Turn sharding on: the router joins the project's pod, which restarts the database once. */
	enable(planOnly: boolean): Promise<Plan | { sharded: boolean; changed: boolean; note?: string }> {
		return this.#send({ action: 'enable', ...(planOnly ? { plan: true } : {}) });
	}

	/**
	 * Spreads one table over the cluster in one go (172): a keyspace for its key (reused when one
	 * for that column and type exists), the table distributed, and a rebalance, run one after another.
	 */
	spread(request: { table: string; column: string; key_type: string }, planOnly: boolean): Promise<Plan | Record<string, unknown>> {
		return this.#send({ action: 'spread', request, ...(planOnly ? { plan: true } : {}) });
	}

	/** Takes a stopped join (a node's ref) or the stopped queue up again. */
	retry(target: { node: string } | { queue: true }): Promise<Record<string, unknown>> {
		return this.#send({ action: 'retry', ...target });
	}

	/** Turns the cluster off (171): Lepis dissolves it, then the router leaves the pod. */
	disable(planOnly: boolean): Promise<Plan | { sharded: boolean; changed: boolean; job?: number; next?: string; note?: string }> {
		return this.#send({ action: 'disable', ...(planOnly ? { plan: true } : {}) });
	}

	/**
	 * A replica for a data node (one project slot; it follows the node and takes its place on its
	 * own if the node is lost or corrupt), or no more replica for it. `planOnly` says what it costs.
	 */
	replica(node: string, remove: boolean, planOnly: boolean): Promise<Plan | Record<string, unknown>> {
		return this.#send({ action: remove ? 'remove-replica' : 'add-replica', node, ...(planOnly ? { plan: true } : {}) });
	}

	/** The cluster's alerts: open ones first, then those resolved in the last day. */
	async alerts(): Promise<ClusterAlert[]> {
		return (await this.status()).cloud?.alerts ?? [];
	}

	/** Marks an alert as seen. It stays open until what it is about is over. */
	acknowledge(alert: string): Promise<Record<string, unknown>> {
		return this.#send({ action: 'acknowledge', alert });
	}

	#action(body: OpBody): string {
		const action = CLOUD_ACTIONS[body.op];
		if (!action) {
			throw new CliFailure('usage', `${body.op} is not an operation a SnoutData Cloud project takes`);
		}
		const fields = body as Record<string, unknown>;
		// In the Cloud a node is a pod the control plane makes; an address is never the caller's.
		if (body.op === 'node.add' && (fields.host !== undefined || fields.name !== undefined)) {
			throw new CliFailure('usage', 'in SnoutData Cloud a node is a pod the project makes: nodes add takes no name or --host. It joins the cluster on its own once it is ready.');
		}
		if (body.op === 'scale' && (fields.add !== undefined || fields.remove !== undefined)) {
			throw new CliFailure('usage', 'in SnoutData Cloud, scale takes --nodes N: how many nodes the project should have, the home included');
		}
		return action;
	}

	async #send<T>(body: Record<string, unknown>): Promise<T> {
		try {
			return await this.#call<T>(SHARDS_FUNCTION, { ref: this.ref, ...body });
		} catch (error) {
			throw cloudFailure(error);
		}
	}
}

/** What the Cloud did with no job, as a sentence. */
export function describeCloudAnswer(answer: Record<string, unknown>): string {
	if (Array.isArray(answer.created)) {
		const created = answer.created.map(String);
		const stopped = typeof answer.stopped === 'string' ? ` Stopped there: ${answer.stopped}` : '';
		const one = created.length === 1;
		return answer.joining === false
			? `New node${one ? '' : 's'} ${created.join(', ')}, starting as a copy of the home node. Attach ${one ? 'it' : 'each'} once it is ready: snoutdata cluster nodes attach <ref>.${stopped}`
			: `New node${one ? '' : 's'} ${created.join(', ')}, starting as a copy of the home node. ${one ? 'It joins' : 'They join'} the cluster and take${one ? 's' : ''} ${one ? 'its' : 'their'} share of the data on ${one ? 'its' : 'their'} own; follow it with snoutdata cluster status.${stopped}`;
	}
	if (answer.deleted === true) {
		return `The pod of ${String(answer.pod)} is being deleted. It owned nothing in the cluster.`;
	}
	if (Array.isArray(answer.queued)) {
		return `${String(answer.next ?? 'The table is being spread over the cluster.')} Steps: ${answer.queued.map(String).join(', ')}. Follow it with snoutdata cluster status.`;
	}
	if (typeof answer.joining === 'boolean' && typeof answer.node === 'string') {
		return answer.joining ? `${answer.node} is joining the cluster again.` : `${answer.node} is left as it is.`;
	}
	if (answer.queue === 'retrying') {
		return 'The cluster is trying that step again.';
	}
	if (typeof answer.replica === 'string' && typeof answer.node === 'string') {
		return `A replica of node ${answer.node} is being made (${answer.replica}). ${String(answer.note ?? 'It protects the node once it is following it.')}`;
	}
	if (typeof answer.changed === 'boolean' && typeof answer.node === 'string' && answer.sharded === undefined) {
		return answer.changed ? `The replica of node ${answer.node} is being removed, and its project slot freed.` : `node ${answer.node} has no replica. Nothing changed.`;
	}
	if (answer.acknowledged === true) {
		return 'Marked as seen. The alert stays open until what it is about is over.';
	}
	if (answer.unchanged === true) {
		return `The project already has ${String(answer.nodes)} nodes. Nothing changed.`;
	}
	if (answer.sharded === true) {
		return answer.changed === false ? 'This project is already a cluster.' : String(answer.note ?? 'This project is a cluster now.');
	}
	if (answer.sharded === false) {
		return answer.changed === false ? 'This project is not a cluster.' : String(answer.note ?? 'This project is not a cluster any more.');
	}
	if (typeof answer.next === 'string') {
		return answer.next;
	}
	return 'Done.';
}

/**
 * A refusal from `cloud-project-shards`, as the same failure the admin API's would be: when the
 * router refused, its class and kind came back beside the sentence (`apiCode`, `kind`), so the
 * exit code and `--json`'s kind match `--admin` exactly. Anything else is the control plane's.
 */
export function cloudFailure(error: unknown): unknown {
	if (!(error instanceof api.ApiError)) {
		return error;
	}
	const body = (error.body ?? {}) as { apiCode?: unknown; kind?: unknown; sqlstate?: unknown; code?: unknown };
	if (typeof body.apiCode === 'string' || typeof body.kind === 'string') {
		return adminFailure(error.status, {
			error: {
				code: typeof body.apiCode === 'string' ? body.apiCode : undefined,
				kind: typeof body.kind === 'string' ? body.kind : undefined,
				message: error.message,
				sqlstate: typeof body.sqlstate === 'string' ? body.sqlstate : undefined
			}
		});
	}
	const code: FailureCode = body.code === 'not-sharded' ? 'conflict' : codeForStatus(error.status);
	return new CliFailure(code, error.message, { status: error.status, ...(typeof body.code === 'string' ? { kind: body.code } : {}) });
}
