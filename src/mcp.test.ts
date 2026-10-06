import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { expiryDays, handle, takeMessages, PlanMemory, PROTOCOL_VERSION, TOOLS, type McpOperations, type McpOptions } from './mcp.js';
import { CliFailure } from './failure.js';
import type { Advice, Job, OpBody, Plan, ShardsClient } from './shardsClient.js';

function operations(over: Partial<McpOperations> = {}): McpOperations {
	return {
		whoami: async () => ({ email: 'a@b.c', via: 'token' }),
		listProjects: async () => ({ projects: [{ ref: 'b7kq2m9xt4rvz', state: 'ready' }] }),
		createProject: async (input) => ({ ref: 'c3hnp8w5y2qkd', name: input.name }),
		setProjectState: async (verb, ref) => ({ verb, ref, changed: true }),
		connection: async (ref) => ({ uri: `postgres://${ref}_owner:secret@${ref}.db.snoutdata.com/${ref}`, state: 'ready', wakesInstantly: true }),
		pushMigrations: async (ref, options) => ({ ref, applied: options.dryRun ? [] : ['001-a.sql'] }),
		usage: async (ref, days) => ({ ref, days: days ?? 30, storage: { state: 'ok' } }),
		exportStatus: async (ref) => ({ ref, export: { pending: false } }),
		requestExport: async (ref) => ({ ref, export: { pending: true } }),
		resetPassword: async (ref) => ({ ref, rotated: true }),
		listTeams: async () => ({ teams: [{ id: 'team_1', name: 'ours' }] }),
		deployFunction: async (ref, name, options) => ({
			ref,
			functions: [{ name, verifyJwt: options.verifyJwt, url: `https://${ref}.api.snoutdata.com/functions/v1/${name}` }]
		}),
		listFunctions: async (ref) => ({ ref, functions: [] }),
		deleteFunction: async (ref, name) => ({ ref, removed: name }),
		sizeFunction: async (ref, name, options) => ({ ref, sized: name, ...options }),
		listFunctionSecrets: async (ref) => ({ ref, secrets: [{ name: 'STRIPE_KEY', bytes: 40 }] }),
		listTokens: async () => ({ tokens: [{ id: 'tok_1', name: 'ci', prefix: 'sdt_abc' }] }),
		createToken: async (name) => ({ token: 'sdt_secret', name }),
		revokeToken: async (id) => ({ id, revoked: true }),
		getProject: async (ref) => ({ ref, products: {}, functions: [], domains: [] }),
		getProducts: async (ref) => ({ ref, auth: { enabled: false }, storage: { enabled: true }, dataApi: { enabled: false, allowedOnPlan: false } }),
		setProduct: async (ref, product, enabled) => ({ ref, product, enabled }),
		listDomains: async (ref) => ({ ref, domains: [] }),
		domainAction: async (ref, action, hostname) => ({ ref, action, hostname }),
		restoreWindow: async (ref) => ({ ref, restore: { available: false, pitrEnabled: false, tier: 'free' } }),
		restoreTo: async (ref, at, name) => ({ ref, at, name }),
		...over
	};
}

const OPTIONS: McpOptions = { version: '0.1.0' };

async function call(name: string, args: Record<string, unknown> = {}, ops = operations(), options: McpOptions = OPTIONS) {
	const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ops, options);
	assert.ok(answer, 'a request with an id must be answered');
	return answer;
}

function text(answer: { result?: unknown }): string {
	const result = answer.result as { content: { text: string }[] };
	return result.content[0]!.text;
}

function isError(answer: { result?: unknown }): boolean {
	return (answer.result as { isError?: boolean }).isError === true;
}

test('the handshake names the protocol and the server', async () => {
	const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, operations(), OPTIONS);
	const result = answer!.result as { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } };
	assert.equal(result.protocolVersion, PROTOCOL_VERSION);
	assert.equal(result.serverInfo.name, 'snoutdata');
	assert.deepEqual(result.capabilities, { tools: { listChanged: false } });
});

test('a notification is answered with silence, which is the whole protocol', async () => {
	// A reply to a message with no id is the easiest way to wedge a client, and
	// notifications/initialized arrives on every single connection.
	assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, operations(), OPTIONS), null);
	assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }, operations(), OPTIONS), null);
});

test('every tool is listed, always, whatever the flags say', async () => {
	// The list is read once at connect, so a tool that appears later is a tool this agent
	// will never see. delete_project is in the list even when it is off.
	const answer = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, operations(), OPTIONS);
	const names = (answer!.result as { tools: { name: string }[] }).tools.map((one) => one.name);
	assert.deepEqual(names, TOOLS.map((one) => one.name));
	assert.ok(names.includes('delete_project'));
});

test('no two tools share a name, whatever the app offered', async () => {
	// MCP has no answer for a duplicate name: the client keeps one, silently, and which one
	// is its business. On 2026-09-07 `tools/list` really did carry `app_list_connections`
	// twice, because the app publishes both its built-in database tools and its renderer
	// capability registry and each had a `list_connections`.
	//
	// The borrowed half is deduped where it is borrowed; this asserts the property that
	// matters at the wire, over the whole served list, including a borrowed tool that
	// collides with one of ours.
	const borrowed = [
		{ name: 'app_list_connections', description: 'a', inputSchema: { type: 'object' as const, properties: {} } },
		{ name: 'app_list_connections', description: 'b', inputSchema: { type: 'object' as const, properties: {} } }
	];
	const answer = await handle(
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		operations(),
		{ ...OPTIONS, borrowed }
	);
	const names = (answer!.result as { tools: { name: string }[] }).tools.map((one) => one.name);
	assert.deepEqual(
		names.filter((name, i) => names.indexOf(name) !== i),
		[],
		'tools/list must not carry the same name twice'
	);
});

test('an unknown method is a protocol error; an unknown tool is too', async () => {
	const method = await handle({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, operations(), OPTIONS);
	assert.equal(method!.error?.code, -32601);
	const tool = await call('cook_dinner');
	assert.equal(tool.error?.code, -32602);
});

test('the read tools answer with what the control plane said', async () => {
	assert.match(text(await call('whoami')), /a@b\.c/);
	assert.match(text(await call('list_projects')), /b7kq2m9xt4rvz/);
});

test('a missing ref is a sentence the model can act on, not a schema violation', async () => {
	for (const name of ['get_connection_url', 'pause_project', 'resume_project', 'push_migrations']) {
		const answer = await call(name, {});
		assert.equal(isError(answer), true, name);
		assert.match(text(answer), /needs a project ref.*list_projects/s, name);
	}
});

test('the connection url comes with the fact that it is a credential', async () => {
	const answer = await call('get_connection_url', { ref: 'b7kq2m9xt4rvz' });
	assert.match(text(answer), /postgres:\/\//);
	assert.match(text(answer), /live database password/);
});

test('delete is present and refusing when it is off, rather than absent', async () => {
	// Absent, the agent cannot tell the difference between "not allowed" and "not a
	// feature", so it makes something up. Present and refusing, it can tell the person
	// what to turn on.
	const off = await call('delete_project', { ref: 'b7kq2m9xt4rvz' });
	assert.equal(isError(off), true);
	assert.match(text(off), /--allow-delete/);

	const ops = operations();
	const on = await call('delete_project', { ref: 'b7kq2m9xt4rvz' }, ops, { ...OPTIONS, allowDelete: true });
	assert.equal(isError(on), false);
	assert.match(text(on), /"verb": "delete"/);
});

test('and nothing is deleted while it is off', async () => {
	const seen: string[] = [];
	const ops = operations({
		setProjectState: async (verb, ref) => {
			seen.push(verb);
			return { verb, ref };
		}
	});
	await call('delete_project', { ref: 'b7kq2m9xt4rvz' }, ops);
	assert.deepEqual(seen, [], 'the refusal must happen before the operation, not after it');
});

test('a failure from the control plane is a result with its own words, not a broken connection', async () => {
	// A quota, a revoked token and a paused project are all things a model can act on. A
	// JSON-RPC error is not: clients treat it as the tool being unusable.
	const ops = operations({
		createProject: async () => {
			throw new Error('free includes 2 projects, and you have 2');
		}
	});
	const answer = await call('create_project', { name: 'third' }, ops);
	assert.equal(answer.error, undefined);
	assert.equal(isError(answer), true);
	assert.match(text(answer), /free includes 2 projects/);
});

test('create_project needs a name, and says so', async () => {
	const answer = await call('create_project', {});
	assert.equal(isError(answer), true);
	assert.match(text(answer), /needs a name/);
});

test('dryRun reaches push_migrations as a boolean, not as a string', async () => {
	assert.match(text(await call('push_migrations', { ref: 'b7kq2m9xt4rvz', dryRun: true })), /"applied": \[\]/);
	assert.match(text(await call('push_migrations', { ref: 'b7kq2m9xt4rvz' })), /001-a\.sql/);
	// A model that sends "true" as a string is asking for a dry run in every way but the
	// type, and running the migrations instead would be the worst possible reading.
	assert.match(text(await call('push_migrations', { ref: 'b7kq2m9xt4rvz', dryRun: 'true' })), /001-a\.sql/);
});

test('stdin is split into whole messages, and a half-line is kept for the next chunk', async () => {
	assert.deepEqual(takeMessages('{"a":1}\n{"b":2}\n'), { messages: ['{"a":1}', '{"b":2}'], rest: '' });
	assert.deepEqual(takeMessages('{"a":1}\n{"b":'), { messages: ['{"a":1}'], rest: '{"b":' });
	assert.deepEqual(takeMessages(''), { messages: [], rest: '' });
	// Blank lines between messages are not messages.
	assert.deepEqual(takeMessages('{"a":1}\n\n\n'), { messages: ['{"a":1}'], rest: '' });
});

test('every tool has a schema that says what it takes', () => {
	for (const tool of TOOLS) {
		assert.equal((tool.inputSchema as { type: string }).type, 'object', tool.name);
		assert.ok(tool.description.length > 40, `${tool.name} needs a description a model can choose on`);
	}
});

// ---------------------------------------------------------------------------
// The surface an agent gets is the surface the CLI has.
// ---------------------------------------------------------------------------

test('every tool the CLI advertises can actually be called', async () => {
	// The gap this closes: eight tools against twenty-one commands, so an agent could not
	// check its storage headroom, take a backup before a migration, or find the team id
	// that create_project asks for.
	const args: Record<string, Record<string, unknown>> = {
		create_project: { name: 'x' },
		create_token: { name: 'ci' },
		revoke_token: { id: 'tok_1' },
		delete_project: { ref: 'b7kq2m9xt4rvz' },
		deploy_function: { ref: 'b7kq2m9xt4rvz', name: 'hello' },
		delete_function: { ref: 'b7kq2m9xt4rvz', name: 'hello' },
		size_function: { ref: 'b7kq2m9xt4rvz', name: 'hello', memoryMb: 256, concurrency: 4 },
		set_product: { ref: 'b7kq2m9xt4rvz', product: 'storage', enabled: true },
		add_domain: { ref: 'b7kq2m9xt4rvz', hostname: 'api.example.com' },
		verify_domain: { ref: 'b7kq2m9xt4rvz', hostname: 'api.example.com' },
		remove_domain: { ref: 'b7kq2m9xt4rvz', hostname: 'api.example.com' },
		restore_to_point: { ref: 'b7kq2m9xt4rvz', at: '2026-09-20T10:00:00Z' },
		shards_plan: { operation: { op: 'verify' } },
		shards_run: { operation: { op: 'verify' } },
		shards_jobs: { id: 1 },
		shards_watch_job: { id: 1 },
		shards_cancel_job: { id: 1 },
		shards_resume_job: { id: 1 }
	};
	for (const tool of TOOLS) {
		const answer = await call(
			tool.name,
			args[tool.name] ?? { ref: 'b7kq2m9xt4rvz' },
			operations({ shards: () => fakeShards(['done']).client }),
			{ version: '0.1.0', allowDelete: true, shardsPlans: new PlanMemory(), shardsPollMs: 1 }
		);
		assert.equal(isError(answer), false, `${tool.name} could not be called: ${text(answer)}`);
	}
});

test('usage is reachable, because "you are read-only" without a number is not actionable', async () => {
	const answer = await call('usage', { ref: 'b7kq2m9xt4rvz', days: 7 });
	assert.match(text(answer), /"days": 7/);
});

test('a tool that needs a ref says so in a sentence, not a schema error', async () => {
	for (const name of ['usage', 'export_status', 'start_export', 'reset_password']) {
		const answer = await call(name, {});
		assert.equal(isError(answer), true, `${name} accepted a call with no ref`);
		assert.match(text(answer), /needs a project ref/);
	}
});

test('a create that never became ready says so, instead of handing back a half-made project', async () => {
	// The trap this replaces: `.catch(() => created.project)` returned the project in state
	// `creating` with no error at all, causing exactly the failure its own comment warned
	// about. An agent must be able to tell "yours, ready" from "yours, not yet".
	const answer = await call('create_project', { name: 'x' }, operations({
		createProject: async () => ({ ref: 'c3hnp8w5y2qkd', state: 'creating', ready: false, note: 'still starting' })
	}));
	const said = text(answer);
	assert.match(said, /still starting/);
	assert.match(said, /"ready": false/);
});

test('create_token warns that the token is shown once', async () => {
	const tool = TOOLS.find((one) => one.name === 'create_token');
	assert.ok(tool);
	assert.match(tool.description, /ONCE AND NEVER AGAIN/);
});

// ---------------------------------------------------------------------------
// One endpoint, both halves, when both are present.
// ---------------------------------------------------------------------------

const BORROWED_TOOL = {
	name: 'app_run_query',
	description: '[SnoutData Studio, on this machine] Run a read-only query',
	inputSchema: { type: 'object' as const, properties: {}, required: [] as string[] }
};

test('borrowed tools are listed beside the cloud ones, so an agent configures one server', async () => {
	const answer = await handle(
		{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
		operations(),
		{ version: '0.1.0', borrowed: [BORROWED_TOOL] }
	);
	const listed = (answer!.result as { tools: { name: string }[] }).tools.map((one) => one.name);
	assert.ok(listed.includes('list_projects'), 'the cloud half went missing');
	assert.ok(listed.includes('app_run_query'), 'the app half was not offered');
});

test('a borrowed call is forwarded to the app, with the prefix taken off', async () => {
	let sentName = '';
	const ops = operations();
	ops.callBorrowed = async (name, args) => {
		sentName = name;
		return { content: [{ type: 'text', text: JSON.stringify(args) }] };
	};
	const answer = await handle(
		{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app_run_query', arguments: { sql: 'select 1' } } },
		ops,
		{ version: '0.1.0', borrowed: [BORROWED_TOOL] }
	);
	// The app knows its tool as `run_query`; the prefix exists for the agent, not for it.
	assert.equal(sentName, 'app_run_query');
	assert.ok(answer);
});

test('with no app, only the cloud half is offered and nothing pretends otherwise', async () => {
	const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, operations(), { version: '0.1.0' });
	const listed = (answer!.result as { tools: { name: string }[] }).tools.map((one) => one.name);
	assert.equal(listed.some((name) => name.startsWith('app_')), false);
	assert.ok(listed.includes('list_projects'));
});

test('an app that quits mid-session refuses as a RESULT, never by vanishing', async () => {
	// The frozen-list constraint, from the other side. A tool the agent was told about at
	// connect must keep existing; what changes is that calling it now fails, and a failure
	// it can read beats a capability that disappears.
	const ops = operations();
	delete ops.callBorrowed;
	const answer = await handle(
		{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'app_run_query', arguments: {} } },
		ops,
		{ version: '0.1.0', borrowed: [BORROWED_TOOL] }
	);
	assert.equal(isError(answer!), true);
	assert.match(text(answer!), /no longer answering/);
});

test('an agent may deploy a function, and the safe default is the one it gets', async () => {
	// `openToAnyone` absent must mean a function that needs a key. A model reading the
	// tool description and omitting a boolean should not be the way a customer's endpoint
	// becomes reachable by strangers.
	const calls: { name: string; verifyJwt: boolean }[] = [];
	const ops = operations({
		deployFunction: async (ref, name, options) => {
			calls.push({ name, verifyJwt: options.verifyJwt });
			return { ref, name };
		}
	});
	await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deploy_function', arguments: { ref: 'b7kq2m9xt4rvz', name: 'hello' } } }, ops, { version: '0.0.0' });
	assert.deepEqual(calls, [{ name: 'hello', verifyJwt: true }]);

	// And asking for the open form gets it, because a webhook receiver is a real thing.
	await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'deploy_function', arguments: { ref: 'b7kq2m9xt4rvz', name: 'stripe', openToAnyone: true } } }, ops, { version: '0.0.0' });
	assert.deepEqual(calls[1], { name: 'stripe', verifyJwt: false });
});

test('there is no tool that sets a secret, and that is deliberate', () => {
	// Every agent tool call is recorded to the AI audit log, so a secret passed as a tool
	// argument is a secret written into a log with different retention from the table it
	// belongs in. Reading the NAMES is fine and is what an agent needs to check that the
	// one a function wants is there.
	const names = TOOLS.map((tool) => tool.name);
	assert.ok(names.includes('list_function_secrets'));
	assert.equal(
		names.some((name) => /set_.*secret|secret.*set|update_secret/i.test(name)),
		false
	);
});

test('every tool says whether it only reads, so a client can skip its own approval for reads', async () => {
	// Codex refuses an unannotated tool outright under `codex exec`.
	const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, operations(), OPTIONS);
	const tools = (answer!.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] }).tools;
	for (const tool of tools) {
		assert.ok(tool.annotations, `${tool.name} has no annotations`);
	}
	const by = new Map(tools.map((t) => [t.name, t.annotations]));
	assert.equal(by.get('list_projects')?.readOnlyHint, true);
	assert.equal(by.get('get_project')?.readOnlyHint, true);
	assert.equal(by.get('set_product')?.readOnlyHint, false);
	assert.equal(by.get('delete_project')?.destructiveHint, true);
});

test('the project controls the desktop has are tools here too', async () => {
	const names = TOOLS.map((t) => t.name);
	for (const name of ['get_project', 'list_products', 'set_product', 'list_domains', 'add_domain', 'verify_domain', 'remove_domain', 'restore_window', 'restore_to_point']) {
		assert.ok(names.includes(name), name);
	}
	// Still no tool that takes a secret value.
	for (const tool of TOOLS) {
		const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
		assert.equal('value' in props || 'password' in props, false, tool.name);
	}
});

test('set_product checks its product and its switch before calling anything', async () => {
	assert.ok(isError(await call('set_product', { ref: 'r', product: 'email', enabled: true })));
	assert.ok(isError(await call('set_product', { ref: 'r', product: 'storage' })));
	assert.match(text(await call('set_product', { ref: 'r', product: 'storage', enabled: true })), /"enabled": true/);
});

test('a domain tool needs a hostname, and passes its verb through', async () => {
	assert.ok(isError(await call('add_domain', { ref: 'r' })));
	assert.match(text(await call('verify_domain', { ref: 'r', hostname: 'api.example.com' })), /"action": "verify"/);
});

test('restore_to_point needs a moment', async () => {
	assert.ok(isError(await call('restore_to_point', { ref: 'r' })));
	assert.match(text(await call('restore_to_point', { ref: 'r', at: '2026-09-20T10:00:00Z' })), /2026-09-20/);
});

test('create_token turns an expiry date into the days the control plane reads', () => {
	const now = new Date('2026-09-29T12:00:00Z');
	assert.equal(expiryDays('2026-10-29T12:00:00Z', now), 30);
	assert.equal(expiryDays('2026-09-30', now), 1);
	assert.equal(expiryDays('2026-09-01', now), null);
	assert.equal(expiryDays('next tuesday', now), null);
});

test('a project row never carries the export download link; export_status still does', async () => {
	const link = 'https://bucket.s3.amazonaws.com/ref/exports/x.dump?X-Amz-Security-Token=secret';
	const row = { ref: 'b7kq2m9xt4rvz', export: { pending: false, completedAt: '2026-10-03T01:48:18Z', url: link, rolesSql: 'CREATE ROLE anon;' } };
	const ops = operations({
		listProjects: async () => ({ projects: [row] }),
		getProject: async () => ({ ...row, products: {} }),
		exportStatus: async (ref) => ({ ref, export: { url: link } })
	});
	for (const name of ['list_projects', 'get_project']) {
		const said = text(await call(name, { ref: 'b7kq2m9xt4rvz' }, ops));
		assert.doesNotMatch(said, /X-Amz/, `${name} handed over a presigned dump link`);
		assert.match(said, /"hasLink": true/);
		assert.doesNotMatch(said, /CREATE ROLE/, `${name} carried the export's role script`);
	}
	assert.match(text(await call('export_status', { ref: 'b7kq2m9xt4rvz' }, ops)), /X-Amz/);
});

test('restore_window says why it cannot, in the sentence the CLI prints', async () => {
	const answer = await call('restore_window', { ref: 'b7kq2m9xt4rvz' }, operations({
		restoreWindow: async (ref) => ({ ref, restore: { available: false, pitrEnabled: false, tier: 'plus' } })
	}));
	assert.match(text(answer), /part of the Pro and Business plans, and this project is on plus/);
});

test('reset_password returns a URL, as its description promises, and says to wait for it', async () => {
	const answer = await call('reset_password', { ref: 'b7kq2m9xt4rvz' }, operations({
		resetPassword: async (ref) => ({ ref, user: `${ref}_owner`, password: 'p4ss', appliesIn: 'within a few seconds' })
	}));
	const said = JSON.parse(text(answer)) as { url: string; next: string };
	assert.match(said.url, /^postgres:\/\//);
	assert.match(said.next, /five seconds/);
});

test('a local ref asked of a cloud tool is one sentence naming the tools that work locally', async () => {
	const ops = operations({
		localProject: (ref) => (ref === 'fswtzrhfa56yn' ? { folder: '/home/me/stacks/local-test' } : null),
		listFunctions: async (ref) => ({ ref, local: '/home/me/stacks/local-test', functions: [] })
	});
	for (const name of ['list_products', 'usage', 'restore_window', 'pause_project']) {
		const answer = await call(name, { ref: 'fswtzrhfa56yn' }, ops);
		assert.ok(isError(answer), `${name} on a local ref was not refused`);
		assert.ok(text(answer).includes('self-hosted project in /home/me/stacks/local-test'));
		assert.match(text(answer), /get_connection_url/);
	}
	// The ones that work locally are passed through to the operations, which answer from the folder.
	const listed = await call('list_functions', { ref: 'fswtzrhfa56yn' }, ops);
	assert.ok(!isError(listed));
	assert.match(text(listed), /local-test/);
	// And a cloud ref is untouched by the gate.
	assert.ok(!isError(await call('usage', { ref: 'b7kq2m9xt4rvz' }, ops)));
});

// ---------------------------------------------------------------------------
// Lepis (Phase 8): an agent reads, plans, gets advice, runs and watches, and no run
// happens that was not planned first.
// ---------------------------------------------------------------------------

const SHARD_PLAN: Plan = {
	op: 'range.split',
	steps: [{ kind: 'catalog', args: { change: { split: { lo: '-3074457345618258603' } } } }, { kind: 'transfer', args: {} }],
	moves: [{ source: 2, targets: [3], tables: ['app.t'], change: {}, estimated_rows: 66000, estimated_bytes: 19_000_000, estimated_copy_seconds: 1.4, expected_pause_ms: 65 }],
	cutovers: 1,
	estimated_rows: 66000,
	estimated_bytes: 19_000_000,
	estimated_copy_seconds: 1.4,
	expected_pause_ms: 65,
	max_write_pause_ms: 2000,
	warnings: []
};

const SPLIT: OpBody = { op: 'range.split', keyspace: 'advk', range: '-3074457345618258603', at: '18454348402311335', to: 3 };

function shardJob(state: Job['state']): Job {
	return {
		id: 9,
		op: 'range.split',
		args: {},
		plan: SHARD_PLAN,
		state,
		error: state === 'failed' ? 'node 3: connection refused' : null,
		runner: 'r',
		created_at: 'x',
		updated_at: 'x',
		finished_at: null,
		steps: [{ n: 0, kind: 'transfer', args: {}, state: state === 'done' ? 'done' : 'running', detail: { phase: 'copy' }, started_at: null, finished_at: null }]
	};
}

function fakeShards(states: Job['state'][] = ['running', 'done']) {
	const calls: string[] = [];
	const sent: OpBody[] = [];
	let look = 0;
	const advice: Advice = {
		summary: '1 recommendation.',
		advice: [{ op: 'range.split', request: SPLIT, reason: 'node 2 holds most of advk', metric: 'size', needs: [], plan: SHARD_PLAN }],
		facts: { sampled_ms: 0, nodes: [], ranges: [] },
		settings: {},
		assumptions: 'chosen'
	};
	const client: ShardsClient = {
		target: 'http://127.0.0.1:7432',
		status: async () => {
			calls.push('status');
			return { catalog: true, epoch: 3 };
		},
		ops: async () => ({ ops: [], settings: {} }),
		plan: async (body) => {
			calls.push('plan');
			sent.push(body);
			return SHARD_PLAN;
		},
		submit: async (body) => {
			calls.push('submit');
			sent.push(body);
			return { job: 9, plan: SHARD_PLAN };
		},
		jobs: async () => {
			calls.push('jobs');
			return [];
		},
		job: async () => {
			calls.push('job');
			const state = states[Math.min(look, states.length - 1)]!;
			look += 1;
			return shardJob(state);
		},
		cancel: async (id) => {
			calls.push('cancel');
			return { job: id, state: 'cancelling' };
		},
		resume: async (id) => {
			calls.push('resume');
			return { job: id, state: 'running' };
		},
		settings: async (patch) => ({ settings: patch as Record<string, number> }),
		advice: async (sampleMs) => {
			calls.push(`advice ${sampleMs ?? '-'}`);
			return advice;
		}
	};
	return { client, calls, sent };
}

function shardOptions(): McpOptions {
	return { version: '0.1.0', shardsPlans: new PlanMemory(), shardsPollMs: 1 };
}

test('the shards tools are listed, and say which only read', async () => {
	const answer = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, operations(), OPTIONS);
	const tools = (answer!.result as { tools: { name: string; annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] }).tools;
	const by = new Map(tools.map((t) => [t.name, t.annotations]));
	for (const name of ['shards_status', 'shards_advice', 'shards_plan', 'shards_jobs', 'shards_watch_job']) {
		assert.equal(by.get(name)?.readOnlyHint, true, name);
	}
	assert.deepEqual(by.get('shards_run'), { readOnlyHint: false, destructiveHint: true });
	assert.equal(by.get('shards_cancel_job')?.readOnlyHint, false);
	// The router's token is never a tool argument.
	for (const tool of TOOLS.filter((t) => t.name.startsWith('shards_'))) {
		const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
		assert.equal(props.some((p) => /token|admin/i.test(p)), false, tool.name);
	}
});

test('with no router, a shards tool says what to set, as a result', async () => {
	const missing = operations({
		shards: () => {
			throw new Error('The shards tools need a Lepis router: LEPIS_ADMIN_URL');
		}
	});
	const answer = await call('shards_status', {}, missing);
	assert.equal(isError(answer), true);
	assert.match(text(answer), /LEPIS_ADMIN_URL/);
	const none = await call('shards_status', {}, operations());
	assert.equal(isError(none), true);
	assert.match(text(none), /LEPIS_ADMIN_URL/);
});

test('shards_run without confirm returns the plan and runs nothing', async () => {
	const { client, calls } = fakeShards();
	const answer = await call('shards_run', { operation: SPLIT }, operations({ shards: () => client }), shardOptions());
	assert.equal(isError(answer), false);
	const out = JSON.parse(text(answer)) as { ran: boolean; plan: { cutovers: number; moves: { from: number }[]; steps: string[] }; next: string };
	assert.equal(out.ran, false);
	assert.equal(out.plan.cutovers, 1);
	assert.deepEqual(out.plan.steps, ['catalog', 'transfer']);
	assert.equal(out.plan.moves[0]!.from, 2);
	assert.match(out.next, /confirm: true/);
	assert.deepEqual(calls, ['plan']);
});

test('confirm runs only what was planned here, once, however its keys are ordered', async () => {
	const { client, calls, sent } = fakeShards();
	const ops = operations({ shards: () => client });
	const options = shardOptions();
	// Confirmed without a plan first: planned instead, NOT run, and said as a refusal.
	const blind = await call('shards_run', { operation: SPLIT, confirm: true }, ops, options);
	assert.equal(isError(blind), true);
	assert.match(text(blind), /NOT RUN/);
	assert.deepEqual(calls, ['plan']);
	// Now it was planned: the same operation, keys in another order, runs.
	const reordered = { to: 3, at: SPLIT.at, range: SPLIT.range, keyspace: 'advk', op: 'range.split' };
	const ran = await call('shards_run', { operation: reordered, confirm: true }, ops, options);
	assert.equal(isError(ran), false, text(ran));
	const out = JSON.parse(text(ran)) as { ran: boolean; job: number; next: string };
	assert.deepEqual([out.ran, out.job], [true, 9]);
	assert.match(out.next, /shards_watch_job/);
	assert.deepEqual(calls, ['plan', 'submit']);
	assert.deepEqual(sent[1], reordered);
	// A run forgets its plan: a second confirm plans again rather than running twice.
	const again = await call('shards_run', { operation: SPLIT, confirm: true }, ops, options);
	assert.equal(isError(again), true);
	assert.deepEqual(calls, ['plan', 'submit', 'plan']);
});

test('a plan goes stale', async () => {
	let now = 0;
	const { client, calls } = fakeShards();
	const options: McpOptions = { version: '0.1.0', shardsPlans: new PlanMemory(1000, () => now) };
	const ops = operations({ shards: () => client });
	await call('shards_plan', { operation: SPLIT }, ops, options);
	now = 5000;
	const late = await call('shards_run', { operation: SPLIT, confirm: true }, ops, options);
	assert.equal(isError(late), true);
	assert.deepEqual(calls, ['plan', 'plan']);
});

test('advice comes planned, so its operation can be confirmed as it is', async () => {
	const { client, calls } = fakeShards();
	const ops = operations({ shards: () => client });
	const options = shardOptions();
	const answer = await call('shards_advice', { sampleMs: 0 }, ops, options);
	const out = JSON.parse(text(answer)) as { advice: { operation: OpBody; plan: unknown; reason: string }[]; next: string };
	assert.deepEqual(out.advice[0]!.operation, SPLIT);
	assert.ok(out.advice[0]!.plan);
	assert.match(out.next, /Nothing has run/);
	const ran = await call('shards_run', { operation: out.advice[0]!.operation, confirm: true }, ops, options);
	assert.equal(isError(ran), false, text(ran));
	assert.deepEqual(calls, ['advice 0', 'submit']);
});

test('a 64-bit bound sent as a JSON number is refused before anything is sent', async () => {
	const { client, calls } = fakeShards();
	const answer = await call('shards_plan', { operation: { op: 'range.move', keyspace: 'k', range: -3074457345618258603, to: 2 } }, operations({ shards: () => client }), shardOptions());
	assert.equal(isError(answer), true);
	assert.match(text(answer), /as a string/);
	const bad = await call('shards_plan', { operation: { op: 'range.teleport' } }, operations({ shards: () => client }), shardOptions());
	assert.match(text(bad), /one of node\.add/);
	assert.deepEqual(calls, []);
});

test('watching a job waits for its end; a failed one is an error naming the resume', async () => {
	const done = fakeShards(['pending', 'running', 'done']);
	const answer = await call('shards_watch_job', { id: 9 }, operations({ shards: () => done.client }), shardOptions());
	assert.equal(isError(answer), false);
	const out = JSON.parse(text(answer)) as { state: string; finished: boolean; steps: { n: number; phase: string }[] };
	assert.deepEqual([out.state, out.finished, out.steps[0]!.n], ['done', true, 1]);
	assert.deepEqual(done.calls, ['job', 'job', 'job']);
	const failed = fakeShards(['failed']);
	const f = await call('shards_watch_job', { id: '9' }, operations({ shards: () => failed.client }), shardOptions());
	assert.equal(isError(f), true);
	assert.match(text(f), /connection refused/);
	assert.match(text(f), /shards_resume_job/);
	// Out of time: the job carries on, and that is not an error.
	const slow = fakeShards(['running']);
	const s = await call('shards_watch_job', { id: 9, timeoutSeconds: 0.01 }, operations({ shards: () => slow.client }), shardOptions());
	assert.equal(isError(s), false);
	assert.match(text(s), /call shards_watch_job again/);
});

test('a router refusal comes back with its kind', async () => {
	const { client } = fakeShards();
	client.plan = async () => {
		throw new CliFailure('conflict', 'keyspace k has no range starting at 12', { status: 409, kind: 'no_such_range' });
	};
	const answer = await call('shards_plan', { operation: { op: 'range.move', keyspace: 'k', range: '12', to: 2 } }, operations({ shards: () => client }), shardOptions());
	assert.equal(isError(answer), true);
	assert.deepEqual(JSON.parse(text(answer)), { error: 'keyspace k has no range starting at 12', kind: 'no_such_range' });
});

test('project reaches a Cloud cluster, and a plan for one project never confirms a run on another', async () => {
	const { client, calls } = fakeShards();
	const asked: (string | undefined)[] = [];
	const ops = operations({
		shards: (project) => {
			asked.push(project);
			return client;
		}
	});
	const options = shardOptions();
	await call('shards_plan', { project: 'abcdefghjkmnp', operation: SPLIT }, ops, options);
	assert.deepEqual(asked, ['abcdefghjkmnp']);
	// Planned for one project; confirmed for another: planned again, not run.
	const elsewhere = await call('shards_run', { project: 'zzzzzzzzzzzzz', operation: SPLIT, confirm: true }, ops, options);
	assert.match(text(elsewhere), /NOT RUN/);
	const here = await call('shards_run', { project: 'abcdefghjkmnp', operation: SPLIT, confirm: true }, ops, options);
	assert.equal(isError(here), false, text(here));
	assert.deepEqual(calls, ['plan', 'plan', 'submit']);
});

test('a Cloud pod made by shards_run is done, with no job to follow', async () => {
	const { client } = fakeShards();
	client.submit = async () => ({ done: 'New node pod qrstvwxyzabcd.', answer: { created: ['qrstvwxyzabcd'] } });
	const ops = operations({ shards: () => client });
	const options = shardOptions();
	const add: OpBody = { op: 'node.add' };
	await call('shards_plan', { project: 'abcdefghjkmnp', operation: add }, ops, options);
	const ran = await call('shards_run', { project: 'abcdefghjkmnp', operation: add, confirm: true }, ops, options);
	const out = JSON.parse(text(ran)) as { ran: boolean; done: string };
	assert.deepEqual([out.ran, out.done], [true, 'New node pod qrstvwxyzabcd.']);
});
