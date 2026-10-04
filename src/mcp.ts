/**
 * The tools an agent gets, and what happens when it calls one.
 *
 * Pure: it takes a JSON-RPC request and a set of operations, and returns a JSON-RPC
 * response. Nothing here reads stdin, writes stdout or opens a socket, so the whole
 * protocol — the handshake, an unknown method, a tool called with the wrong arguments, a
 * destructive tool that was not enabled — is provable without a process and without an
 * account. `commands/mcp.ts` is the twenty lines that make it a server.
 *
 * ## The two decisions in here
 *
 * **The tool list is fixed at connect.** MCP clients read `tools/list` once, so a tool
 * that appears later is a tool that agent will never see. Everything is therefore static
 * and nothing is registered conditionally on state — the same constraint the desktop's
 * harness records (`docs/desktop/AGENT-HARNESS.md`), and the reason `delete_project` is
 * present-but-refusing rather than absent when it is not allowed. An agent that can see it
 * and is told no can tell the user what to turn on; an agent that cannot see it invents
 * something else.
 *
 * **A refusal is a result, not a protocol error.** JSON-RPC errors are for "that is not a
 * method"; a tool that ran and said no is a successful call with `isError` and a sentence.
 * Models handle the second and stall on the first.
 *
 * ## What this deliberately does NOT do
 *
 * It does not run SQL. `snoutdata sql` does not exist yet, and when it does it goes
 * through the engine guard; putting an unguarded statement runner in an agent's hands
 * would be building the thing that guard exists to prevent. An agent that wants to query
 * gets `get_connection_url` and uses a real client.
 *
 * And it holds no credential of its own: it runs as whoever started it, and every call is
 * the same Snout Function the CLI calls, so RLS decides once, in the database.
 */

/** What the tools need from the outside world. Every one of these is impure. */
export interface McpOperations {
	whoami(): Promise<unknown>;
	listProjects(): Promise<unknown>;
	createProject(input: { name: string; region?: string; teamId?: string }): Promise<unknown>;
	setProjectState(verb: 'pause' | 'resume' | 'delete', ref: string): Promise<unknown>;
	connection(ref: string): Promise<{ uri: string; state: string; wakesInstantly: boolean }>;
	pushMigrations(ref: string, options: { dir?: string; dryRun?: boolean }): Promise<unknown>;
	usage(ref: string, days?: number): Promise<unknown>;
	exportStatus(ref: string): Promise<unknown>;
	requestExport(ref: string): Promise<unknown>;
	resetPassword(ref: string): Promise<unknown>;
	listTeams(): Promise<unknown>;
	deployFunction(
		ref: string,
		name: string,
		options: { dir?: string; entrypoint?: string; verifyJwt: boolean }
	): Promise<unknown>;
	listFunctions(ref: string): Promise<unknown>;
	deleteFunction(ref: string, name: string): Promise<unknown>;
	/** A function's memory and concurrency within the plan (sql/100), or `reset` to its default. */
	sizeFunction(ref: string, name: string, options: { memoryMb?: number; concurrency?: number; reset?: boolean }): Promise<unknown>;
	/**
	 * The names of a project's function secrets.
	 *
	 * **There is deliberately no `setFunctionSecret` beside it.** Every agent tool call is
	 * recorded to the AI audit log (`docs/desktop/MCP-SERVER.md`), so a secret passed as a
	 * tool argument is a secret written into a log with different retention from the table
	 * it belongs in — which is the rule `SECURITY-ADMIN.md` already enforces for database
	 * passwords, arrived at from the other direction.
	 */
	listFunctionSecrets(ref: string): Promise<unknown>;
	listTokens(): Promise<unknown>;
	/** One project whole: the list row plus products, function and secret names, domains. */
	getProject(ref: string): Promise<unknown>;
	getProducts(ref: string): Promise<unknown>;
	setProduct(ref: string, product: 'auth' | 'storage' | 'data-api', enabled: boolean): Promise<unknown>;
	listDomains(ref: string): Promise<unknown>;
	domainAction(ref: string, action: 'add' | 'verify' | 'remove', hostname: string): Promise<unknown>;
	restoreWindow(ref: string): Promise<unknown>;
	restoreTo(ref: string, at: string, name?: string): Promise<unknown>;
	createToken(name: string, expiresInDays?: number, project?: string): Promise<unknown>;
	revokeToken(id: string): Promise<unknown>;
	/** Forward a borrowed tool to the desktop app. Absent when there is no app. */
	callBorrowed?(name: string, args: unknown): Promise<unknown>;
	/**
	 * The self-hosted stack on this machine that `ref` names (`snoutdata link --local`), or null.
	 * Absent means no local projects at all, which is what the tests mostly want.
	 */
	localProject?(ref: string): { folder: string } | null;
}

export interface McpOptions {
	/** Whether `delete_project` may actually delete. Off unless `--allow-delete` was passed. */
	readonly allowDelete?: boolean;
	/** What the server calls itself in the handshake. */
	readonly version: string;
	/**
	 * Tools borrowed from the desktop app, already prefixed and decided at STARTUP.
	 *
	 * Not a live view of the app. The list is fixed at connect, so an app that starts
	 * later cannot appear, and one that quits leaves its tools listed and failing, which
	 * is the honest shape: an agent told a tool exists must keep being told, and a call
	 * that cannot be served is a result rather than a vanishing capability.
	 */
	readonly borrowed?: readonly ToolDefinition[];
}

/** The version of the MCP spec this speaks. Echoed back in the handshake. */
export const PROTOCOL_VERSION = '2024-11-05';

interface JsonRpcRequest {
	jsonrpc?: string;
	id?: number | string | null;
	method?: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number | string | null;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/**
	 * MCP's tool annotations. `readOnlyHint` is what lets a client call a tool without asking its
	 * own user first: Codex refuses every unannotated tool under `codex exec` (found 2026-09-21,
	 * against the desktop's server, which had none). Hints, not permissions.
	 */
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}

const STRING = { type: 'string' };

/**
 * Every tool, always, whatever the flags say.
 *
 * The descriptions are written for a model rather than for a person: they say what the
 * tool is FOR and what it costs, because a model choosing between `get_connection_url` and
 * `push_migrations` has only these sentences to go on.
 */
export const TOOLS: readonly ToolDefinition[] = [
	{
		name: 'whoami',
		description: 'Who this CLI is signed in as, and how (a session or a long-lived access token). Use it to check a credential before doing anything else.',
		inputSchema: object({})
	},
	{
		name: 'list_projects',
		description: "Every hosted Postgres database on this account, with its ref, name, region, state (ready, paused, error), size, and whether it is read-only because it is over its plan's storage limit. Under `local`, the self-hosted projects on this machine (SnoutData Studio's, or linked with `snoutdata link --local`), whose refs work with get_connection_url, push_migrations, get_project and the function tools.",
		inputSchema: object({})
	},
	{
		name: 'create_project',
		description: 'Make a new hosted Postgres database and wait for it to be ready. Costs a project against the plan allowance; a free plan includes two. Returns its ref, which every other tool takes.',
		inputSchema: object({ name: STRING, region: STRING, teamId: STRING }, ['name'])
	},
	{
		name: 'get_connection_url',
		description: 'The postgres:// URL for a project, ready to put in DATABASE_URL. IT CONTAINS A LIVE PASSWORD, so treat it as a credential and do not print it into a log or a file that is committed. Connecting to a paused project wakes it, which takes a few seconds.',
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'pause_project',
		description: 'Stop a project, and wait until it is paused. Its data is kept and the next connection wakes it. A production project refuses this.',
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'resume_project',
		description: 'Start a paused project without waiting for a connection to wake it, and wait until it is ready.',
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'push_migrations',
		description: 'Run the .sql files in a folder against a project, in name order, once each, recording what ran in a _snoutdata_migrations table. Refuses a file that changed after it ran, a file that has gone, and a new file that sorts before one already applied. Use dryRun first to see what would happen. Needs psql on this machine.',
		inputSchema: object({ ref: STRING, dir: STRING, dryRun: { type: 'boolean' } }, ['ref'])
	},
	{
		name: 'usage',
		description: "How much storage and compute a project has used against the limit on this plan, and whether it is near it. READ THIS BEFORE a migration or a bulk insert: a project over its storage limit is made read-only, and `list_projects` will say readOnly afterwards without ever saying how much headroom was left. Takes an optional number of days of history (default 30, maximum 365).",
		inputSchema: object({ ref: STRING, days: { type: 'number' } }, ['ref'])
	},
	{
		name: 'export_status',
		description: 'Whether a copy of this database is being taken, when the last one finished, and a download link if there is a live one. Costs nothing and starts nothing.',
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'start_export',
		description: 'Take a copy of the whole database. Runs a pg_dump on the server and can take minutes, so this STARTS it and returns; poll export_status for the link. Worth doing before a migration you are unsure of. It does not block the database.',
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'reset_password',
		description: "Rotate the project's database password. THE OLD ONE STOPS WORKING within a few seconds, including any DATABASE_URL already written into a file or a running process; connections already open keep working. Returns the new connection URL, which works once the change applies (wait about five seconds before connecting). Use it when a credential has leaked, not routinely.",
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'list_teams',
		description: 'Teams this account belongs to, with the id create_project takes as teamId. Without this there is no way to discover that id.',
		inputSchema: object({})
	},
	{
		name: 'list_tokens',
		description: 'The long-lived sdt_ access tokens on this account: id, name, prefix, when each was made and last used. Never the token itself, which is shown once when it is made.',
		inputSchema: object({})
	},
	{
		name: 'create_token',
		description: 'Mint a long-lived sdt_ access token, for a CI job or another machine. RETURNS THE TOKEN ONCE AND NEVER AGAIN. Without `project` it is as capable as this account, so hand it over deliberately; with a project ref it reaches that one project and nothing else, which is what a CI job for one project should get. Optionally expires, as an ISO date.',
		inputSchema: object({ name: STRING, expires: STRING, project: STRING }, ['name'])
	},
	{
		name: 'revoke_token',
		description: 'Revoke an access token by its id. Anything using it stops working at once. Safe to do to a token you think has leaked.',
		inputSchema: object({ id: STRING }, ['id'])
	},
	{
		name: 'deploy_function',
		description: "Put a folder of TypeScript on the edge as an HTTP endpoint at https://<ref>.api.snoutdata.com/functions/v1/<name>. Reads functions/<name> unless dir says otherwise. Deno, so no build step and no node_modules. Set openToAnyone ONLY for a webhook receiver whose sender cannot send an API key: it makes the URL callable by anybody who knows it, and the function must then check the sender's signature itself.",
		inputSchema: object(
			{ ref: STRING, name: STRING, dir: STRING, entrypoint: STRING, openToAnyone: { type: 'boolean' } },
			['ref', 'name']
		)
	},
	{
		name: 'list_functions',
		description: "The functions deployed to a project, their URLs, bundle sizes, whether each one needs an API key, and each one's memory and concurrency with the plan's limits for both. Costs nothing.",
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'size_function',
		description: "Set one function's memory (MB one worker may use) and concurrency (how many workers it may run at once), within the project's plan. memoryMb x concurrency may not exceed the project's memory; list_functions shows each function's size and the plan's limits (limit.functionMemoryMb, limit.concurrencyMax, limit.podMemoryMb). A size that does not fit is refused with a sentence saying why. Omit one to keep it as it runs now; reset: true goes back to the plan's default. A second worker only helps CPU-bound work: requests that wait on the network share one.",
		inputSchema: object(
			{ ref: STRING, name: STRING, memoryMb: { type: 'integer' }, concurrency: { type: 'integer' }, reset: { type: 'boolean' } },
			['ref', 'name']
		)
	},
	{
		name: 'delete_function',
		description: 'Remove one function from a project. It stops answering within a few seconds. It does not touch the database.',
		inputSchema: object({ ref: STRING, name: STRING }, ['ref', 'name'])
	},
	{
		name: 'list_function_secrets',
		description: "The NAMES of the environment variables a project's functions run with, their sizes and when each was last set. Never the values, which are not readable by anything but the runtime. THERE IS NO TOOL THAT SETS ONE: a secret in a tool call is a secret in an audit log, so a person sets it with `snoutdata secrets set`. Use this to check whether one a function needs is there.",
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'get_project',
		description: 'Everything about one project in one call: its state, region and size, which products are on (auth, storage, data-api), the names of its deployed functions and function secrets, and its custom domains. Never a password, a key or a download link (export_status has the link to the last export).',
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'list_products',
		description: "Whether a project's auth (user sign-up and sign-in), storage (files) and data API (REST and GraphQL over its tables) are on, and whether the plan allows the data API.",
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'set_product',
		description: 'Turn auth, storage or data-api on or off for a project. It starts within about a minute. All three are on every plan, including free.',
		inputSchema: object({ ref: STRING, product: { type: 'string', enum: ['auth', 'storage', 'data-api'] }, enabled: { type: 'boolean' } }, ['ref', 'product', 'enabled'])
	},
	{
		name: 'list_domains',
		description: "The custom domains in front of a project's API, whether each is verified, and the DNS records each needs.",
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'add_domain',
		description: "Serve a project's API at the user's own hostname (paid plans). Returns the DNS records the user must publish before verify_domain can succeed.",
		inputSchema: object({ ref: STRING, hostname: STRING }, ['ref', 'hostname'])
	},
	{
		name: 'verify_domain',
		description: "Check a custom domain's DNS records and verify it once they are published.",
		inputSchema: object({ ref: STRING, hostname: STRING }, ['ref', 'hostname'])
	},
	{
		name: 'remove_domain',
		description: 'Stop serving a project at a custom domain.',
		inputSchema: object({ ref: STRING, hostname: STRING }, ['ref', 'hostname'])
	},
	{
		name: 'restore_window',
		description: 'How far back a point-in-time restore of a project can go, or why it cannot (the plan, or no backup yet). Starts nothing.',
		inputSchema: object({ ref: STRING }, ['ref'])
	},
	{
		name: 'restore_to_point',
		description: 'Rewind a project to a moment (ISO 8601, inside restore_window) into a NEW project beside it, never over it. Costs a project slot on the plan. The original is untouched.',
		inputSchema: object({ ref: STRING, at: STRING, name: STRING }, ['ref', 'at'])
	},
	{
		name: 'delete_project',
		description: 'Delete a project. THIS DESTROYS A DATABASE. Off unless the person who started this server passed --allow-delete, in which case it still only marks the project deleted and its data is erasable for a grace period.',
		inputSchema: object({ ref: STRING }, ['ref'])
	}
];

/** The tools that only read. Every other one changes something, and says so to the client. */
const READ_ONLY_TOOLS = new Set([
	'whoami', 'list_projects', 'get_connection_url', 'usage', 'export_status', 'list_teams', 'list_tokens',
	'list_functions', 'list_function_secrets', 'get_project', 'list_products', 'list_domains', 'restore_window'
]);
const DESTRUCTIVE_TOOLS = new Set(['delete_project', 'delete_function', 'reset_password', 'revoke_token', 'remove_domain']);

/** The tools that work on a LOCAL project's ref (`snoutdata link --local`). Every other one is about SnoutData Cloud. */
const LOCAL_TOOLS = ['get_connection_url', 'push_migrations', 'get_project', 'list_functions', 'deploy_function', 'delete_function', 'list_function_secrets'];

/**
 * A project row, or a list of them, without the export's download link.
 *
 * The link is a presigned URL to a dump of the WHOLE database, good for hours, and two
 * kilobytes long. `list_projects` and `get_project` handed it to the model on every call
 * (§3n): a credential to every row in a tool that promises "never a password or a key", and
 * most of what a small model read in a one-project list. `export_status` still returns it,
 * which is the tool whose description says so.
 */
export function withoutDownloadLink(value: unknown): unknown {
	if (!value || typeof value !== 'object') {
		return value;
	}
	const record = value as Record<string, unknown>;
	if (Array.isArray(record.projects)) {
		return { ...record, projects: record.projects.map(withoutDownloadLink) };
	}
	const exported = record.export;
	if (exported && typeof exported === 'object') {
		// `rolesSql` too: the export's role script, three more kilobytes on every row.
		const { url, rolesSql: _roles, ...rest } = exported as Record<string, unknown>;
		return { ...record, export: { ...rest, hasLink: typeof url === 'string' && url.length > 0 } };
	}
	return value;
}

/**
 * Why a project cannot be restored to a point, as the sentence `db restore --window` prints,
 * or null when it can. The window alone (`available: false, pitrEnabled: false`) left a model
 * to work out that the answer was the plan.
 */
export function restoreReason(ref: string, window: { available?: boolean; pitrEnabled?: boolean; tier?: string }): string | null {
	if (window.available) {
		return null;
	}
	return window.pitrEnabled
		? `${ref} has no backup to restore from yet.`
		: `Point-in-time restore is part of the Pro and Business plans, and this project is on ${window.tier ?? 'another plan'}.`;
}

/** A tool as it goes on the wire, with its annotations. */
export function annotated(tool: ToolDefinition): ToolDefinition {
	return {
		...tool,
		annotations: READ_ONLY_TOOLS.has(tool.name)
			? { readOnlyHint: true }
			: { readOnlyHint: false, destructiveHint: DESTRUCTIVE_TOOLS.has(tool.name) }
	};
}

/**
 * One name, one tool. The invariant lives HERE, where the list goes on the wire, because
 * this is the only place that can promise it whatever the parts were.
 *
 * MCP has no answer for a duplicate: the client keeps one, silently, and which one it
 * keeps is its business. On 2026-09-07 `tools/list` really did carry
 * `app_list_connections` twice, because the desktop publishes both its built-in database
 * tools and its renderer capability registry and each had a `list_connections`. The same
 * class of defect is recorded in the desktop's own `AGENT-HARNESS.md`, where a duplicate
 * `get_query_result` was dropped without a word.
 *
 * First one wins, so ours outrank a borrowed tool that collides with them, and a dropped
 * duplicate is dropped rather than renamed: an agent that has read the docs is looking for
 * `app_list_connections`, not `app_list_connections_2`.
 */
function uniqueByName(tools: readonly ToolDefinition[]): ToolDefinition[] {
	const seen = new Set<string>();
	return tools.filter((tool) => !seen.has(tool.name) && seen.add(tool.name));
}

function ok(id: number | string | null, result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result };
}

function fail(id: number | string | null, code: number, message: string): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message } };
}

/** A tool that ran and has something to say. Text, because that is what a model reads. */
function said(id: number | string | null, value: unknown, isError = false): JsonRpcResponse {
	const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	return ok(id, { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
}

/**
 * The tool takes an expiry as a DATE, the control plane as a number of DAYS. Rounded up, so a
 * token asked to last until a date lasts at least that long. Null for a date that is not one or
 * is not in the future. Until 2026-09-29 the date was sent under a name the control plane never
 * read, so every token made through this tool silently did not expire.
 */
export function expiryDays(iso: string, now = new Date()): number | null {
	const at = Date.parse(iso);
	if (!Number.isFinite(at) || at <= now.getTime()) {
		return null;
	}
	return Math.ceil((at - now.getTime()) / 86_400_000);
}

function stringArg(params: Record<string, unknown>, name: string): string | null {
	const value = params[name];
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Handle one request.
 *
 * Returns null for a notification, which is a message with no `id` and must produce no
 * reply at all — writing one back is the single easiest way to wedge an MCP client, and
 * `notifications/initialized` arrives on every connection.
 */
export async function handle(
	request: JsonRpcRequest,
	operations: McpOperations,
	options: McpOptions
): Promise<JsonRpcResponse | null> {
	const id = request.id ?? null;
	const method = request.method ?? '';
	const params = (request.params ?? {}) as Record<string, unknown>;

	if (request.id === undefined || request.id === null) {
		// A notification. `initialized` is the only one that matters and the answer to all
		// of them is silence.
		return null;
	}

	switch (method) {
		case 'initialize':
			return ok(id, {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: 'snoutdata', version: options.version }
			});
		case 'ping':
			return ok(id, {});
		case 'tools/list':
			return ok(id, { tools: uniqueByName([...TOOLS.map(annotated), ...(options.borrowed ?? [])]) });
		case 'tools/call':
			return callTool(id, params, operations, options);
		default:
			return fail(id, -32601, `unknown method: ${method}`);
	}
}

async function callTool(
	id: number | string | null,
	params: Record<string, unknown>,
	operations: McpOperations,
	options: McpOptions
): Promise<JsonRpcResponse> {
	const name = typeof params.name === 'string' ? params.name : '';
	const args = (params.arguments ?? {}) as Record<string, unknown>;
	// Borrowed tools count as known: they were in the list this client was given at
	// connect, so refusing one here would be telling an agent that a tool it was offered
	// does not exist. (This guard checked only TOOLS and was why the first version of the
	// merge listed the app's tools and then refused every call to them.)
	const known = TOOLS.some((tool) => tool.name === name) || (options.borrowed?.some((tool) => tool.name === name) ?? false);
	if (!known) {
		return fail(id, -32602, `unknown tool: ${name}`);
	}

	// "You did not give me one" is a sentence the model can act on rather than a schema
	// violation it cannot. Listed rather than inferred from the schema, because a required
	// field and a field this code dereferences are two different facts and only one of them
	// is enforced here.
	const needsRef = [
		'get_connection_url',
		'pause_project',
		'resume_project',
		'delete_project',
		'push_migrations',
		'usage',
		'export_status',
		'start_export',
		'reset_password',
		'get_project',
		'list_products',
		'set_product',
		'list_domains',
		'add_domain',
		'verify_domain',
		'remove_domain',
		'restore_window',
		'restore_to_point'
	];
	const ref = stringArg(args, 'ref');
	if (needsRef.includes(name) && !ref) {
		return said(id, `${name} needs a project ref. Call list_projects to see them.`, true);
	}
	// A local project's ref asked of a cloud tool: one sentence naming the tools that DO work,
	// not the control plane's 404 or four copies of the CLI's refusal (§3n).
	const local = ref && operations.localProject ? operations.localProject(ref) : null;
	if (local && !LOCAL_TOOLS.includes(name)) {
		return said(
			id,
			`${ref} is the self-hosted project in ${local.folder}, and ${name} is about SnoutData Cloud. On a local project these tools work: ${LOCAL_TOOLS.join(', ')}.`,
			true
		);
	}

	try {
		switch (name) {
			case 'whoami':
				return said(id, await operations.whoami());
			case 'list_projects':
				return said(id, withoutDownloadLink(await operations.listProjects()));
			case 'create_project': {
				const projectName = stringArg(args, 'name');
				if (!projectName) {
					return said(id, 'create_project needs a name.', true);
				}
				return said(
					id,
					await operations.createProject({
						name: projectName,
						region: stringArg(args, 'region') ?? undefined,
						teamId: stringArg(args, 'teamId') ?? undefined
					})
				);
			}
			case 'get_connection_url': {
				const details = await operations.connection(ref!);
				return said(id, {
					url: details.uri,
					state: details.state,
					wakesInstantly: details.wakesInstantly,
					warning: 'This URL contains a live database password. Put it in an environment variable, not in a file that is committed.'
				});
			}
			case 'pause_project':
				return said(id, await operations.setProjectState('pause', ref!));
			case 'resume_project':
				return said(id, await operations.setProjectState('resume', ref!));
			case 'usage': {
				const days = typeof args.days === 'number' ? args.days : undefined;
				return said(id, await operations.usage(ref!, days));
			}
			case 'export_status':
				return said(id, await operations.exportStatus(ref!));
			case 'start_export':
				return said(id, await operations.requestExport(ref!));
			case 'reset_password': {
				// The description promises a URL, and a bare password left a model to assemble one.
				// `connection` serves the new password as soon as the reset returns.
				const reset = (await operations.resetPassword(ref!)) as { appliesIn?: string };
				const details = await operations.connection(ref!);
				return said(id, {
					url: details.uri,
					appliesIn: reset.appliesIn ?? 'within a few seconds',
					next: 'Wait about five seconds before connecting with this URL: until the change applies the new password is refused and the old one still works. Then update DATABASE_URL wherever it is set.',
					warning: 'This URL contains a live database password. Put it in an environment variable, not in a file that is committed.'
				});
			}
			case 'list_teams':
				return said(id, await operations.listTeams());
			case 'get_project':
				return said(id, withoutDownloadLink(await operations.getProject(ref!)));
			case 'list_products':
				return said(id, await operations.getProducts(ref!));
			case 'set_product': {
				const product = stringArg(args, 'product');
				if (product !== 'auth' && product !== 'storage' && product !== 'data-api') {
					return said(id, 'set_product needs product: auth, storage or data-api.', true);
				}
				if (typeof args.enabled !== 'boolean') {
					return said(id, 'set_product needs enabled: true or false.', true);
				}
				return said(id, await operations.setProduct(ref!, product, args.enabled));
			}
			case 'list_domains':
				return said(id, await operations.listDomains(ref!));
			case 'add_domain':
			case 'verify_domain':
			case 'remove_domain': {
				const hostname = stringArg(args, 'hostname');
				if (!hostname) {
					return said(id, `${name} needs a hostname, e.g. api.example.com.`, true);
				}
				return said(id, await operations.domainAction(ref!, name.split('_')[0] as 'add' | 'verify' | 'remove', hostname));
			}
			case 'restore_window': {
				const answer = (await operations.restoreWindow(ref!)) as { restore?: { available?: boolean; pitrEnabled?: boolean; tier?: string } };
				const reason = answer && answer.restore ? restoreReason(ref!, answer.restore) : null;
				return said(id, reason ? { ...answer, reason } : answer);
			}
			case 'restore_to_point': {
				const at = stringArg(args, 'at');
				if (!at) {
					return said(id, 'restore_to_point needs at: an ISO 8601 moment inside restore_window.', true);
				}
				return said(id, await operations.restoreTo(ref!, at, stringArg(args, 'name') ?? undefined));
			}
			case 'deploy_function': {
				const ref = stringArg(args, 'ref');
				const functionName = stringArg(args, 'name');
				if (!ref || !functionName) {
					return said(id, 'deploy_function needs a project ref and a function name.', true);
				}
				return said(
					id,
					await operations.deployFunction(ref, functionName, {
						dir: stringArg(args, 'dir') ?? undefined,
						entrypoint: stringArg(args, 'entrypoint') ?? undefined,
						// The default is the safe one and the model has to ask for the other.
						verifyJwt: args && typeof args === 'object' && 'openToAnyone' in args
							? (args as { openToAnyone?: unknown }).openToAnyone !== true
							: true
					})
				);
			}
			case 'list_functions': {
				const ref = stringArg(args, 'ref');
				if (!ref) {
					return said(id, 'list_functions needs a project ref.', true);
				}
				return said(id, await operations.listFunctions(ref));
			}
			case 'size_function': {
				const ref = stringArg(args, 'ref');
				const functionName = stringArg(args, 'name');
				if (!ref || !functionName) {
					return said(id, 'size_function needs a project ref and a function name.', true);
				}
				const memoryMb = typeof args.memoryMb === 'number' ? args.memoryMb : undefined;
				const concurrency = typeof args.concurrency === 'number' ? args.concurrency : undefined;
				const reset = args.reset === true;
				if (!reset && memoryMb === undefined && concurrency === undefined) {
					return said(id, 'size_function needs memoryMb, concurrency, or reset: true.', true);
				}
				return said(id, await operations.sizeFunction(ref, functionName, { memoryMb, concurrency, reset }));
			}
			case 'delete_function': {
				const ref = stringArg(args, 'ref');
				const functionName = stringArg(args, 'name');
				if (!ref || !functionName) {
					return said(id, 'delete_function needs a project ref and a function name.', true);
				}
				return said(id, await operations.deleteFunction(ref, functionName));
			}
			case 'list_function_secrets': {
				const ref = stringArg(args, 'ref');
				if (!ref) {
					return said(id, 'list_function_secrets needs a project ref.', true);
				}
				return said(id, await operations.listFunctionSecrets(ref));
			}
			case 'list_tokens':
				return said(id, await operations.listTokens());
			case 'create_token': {
				const tokenName = stringArg(args, 'name');
				if (!tokenName) {
					return said(id, 'create_token needs a name, so somebody can tell later what it was for.', true);
				}
				const expires = stringArg(args, 'expires');
				const days = expires ? expiryDays(expires) : undefined;
				if (days === null) {
					return said(id, `create_token: \`expires\` must be a date in the future, like 2026-12-31. Got "${expires}".`, true);
				}
				return said(id, await operations.createToken(tokenName, days, stringArg(args, 'project') ?? undefined));
			}
			case 'revoke_token': {
				const tokenId = stringArg(args, 'id');
				if (!tokenId) {
					return said(id, 'revoke_token needs the id of a token. list_tokens has them.', true);
				}
				return said(id, await operations.revokeToken(tokenId));
			}
			case 'push_migrations':
				return said(
					id,
					await operations.pushMigrations(ref!, {
						dir: stringArg(args, 'dir') ?? undefined,
						dryRun: args.dryRun === true
					})
				);
			case 'delete_project': {
				if (!options.allowDelete) {
					// Present and refusing, not absent: the list is fixed at connect, so a
					// tool that vanishes is a capability the agent can never learn about.
					return said(
						id,
						'delete_project is off. The person running this server started it without --allow-delete, so deleting a database is theirs to do. Tell them that is what you wanted.',
						true
					);
				}
				return said(id, await operations.setProjectState('delete', ref!));
			}
			default: {
				// A borrowed one, forwarded to the app that owns it. The CLI does not and
				// must not reimplement `run_query`: the credential is in the user's keychain
				// and the app's broker resolves it, handing out a capability rather than a
				// secret. Borrowing is the only shape that keeps that true.
				if (options.borrowed?.some((tool) => tool.name === name)) {
					if (!operations.callBorrowed) {
						return said(id, `${name} needs SnoutData Studio, which is no longer answering.`, true);
					}
					return ok(id, await operations.callBorrowed(name, args));
				}
				return fail(id, -32602, `unknown tool: ${name}`);
			}
		}
	} catch (error) {
		// The control plane's own sentence, as a result rather than as a protocol error: a
		// quota, a revoked token and a paused project are all things a model can act on,
		// and none of them means the connection is broken.
		return said(id, error instanceof Error ? error.message : String(error), true);
	}
}

/**
 * Split a buffer of stdin into whole JSON-RPC messages.
 *
 * MCP's stdio transport is newline-delimited JSON, one message per line, and a read can
 * end mid-line. Returns the messages it could take and whatever is left over, so the
 * caller keeps the remainder for the next chunk.
 */
export function takeMessages(buffer: string): { messages: string[]; rest: string } {
	const parts = buffer.split('\n');
	const rest = parts.pop() ?? '';
	return { messages: parts.map((line) => line.trim()).filter((line) => line.length > 0), rest };
}
