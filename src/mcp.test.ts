import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { expiryDays, handle, takeMessages, PROTOCOL_VERSION, TOOLS, type McpOperations, type McpOptions } from './mcp.js';

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
// Phase 5: the surface an agent gets is the surface the CLI has.
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
		restore_to_point: { ref: 'b7kq2m9xt4rvz', at: '2026-09-20T10:00:00Z' }
	};
	for (const tool of TOOLS) {
		const answer = await call(
			tool.name,
			args[tool.name] ?? { ref: 'b7kq2m9xt4rvz' },
			operations(),
			{ version: '0.1.0', allowDelete: true }
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
// Phase 5's last box: one endpoint, both halves, when both are present.
// ---------------------------------------------------------------------------

const BORROWED_TOOL = {
	name: 'app_run_query',
	description: '[SnoutData app, on this machine] Run a read-only query',
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
