/**
 * `snoutdata mcp` — the same operations, as tools an agent calls.
 *
 * The transport, and nothing else. Every decision about what the tools ARE, what they
 * refuse and what they say lives in `../mcp.ts`, which is pure and tested; this file reads
 * newline-delimited JSON-RPC off stdin, hands each message over, and writes what comes
 * back. That is the whole of it, and it is deliberately small enough to read in one go.
 *
 * ## Three things that will bite anybody editing this
 *
 * **Nothing may be written to stdout but JSON-RPC.** stdout IS the wire. A stray `console.log`
 * is a protocol violation the client reports as a parse error with no hint where it came
 * from, which is why `setJsonMode(true)` is the first thing this does: the CLI's own
 * `say()` already goes to stderr, and this makes sure `emit()` does too.
 *
 * **A notification gets no reply.** `handle` returns null for one and this writes nothing.
 * Replying to `notifications/initialized` wedges the client on the first message.
 *
 * **stdin arrives in chunks that do not respect line boundaries.** `takeMessages` keeps
 * the remainder; a naive `split('\n')` on each chunk drops half a message on a busy pipe.
 *
 * **Nothing here may borrow stdout, even briefly.** The first version of `push_migrations`
 * captured `process.stdout.write` for the length of the call because `push` prints. Two
 * tool calls overlapped and the capture swallowed another tool's ANSWER, so the client
 * waited forever for a reply that had been written into a string. `push` was split into a
 * core that returns a value and a wrapper that prints; this calls the core.
 *
 * ## What it is, from the user's side
 *
 * An MCP server the person running it has already authenticated: it holds no credential of
 * its own, uses whatever `SNOUTDATA_ACCESS_TOKEN` or `~/.snoutdata/auth.json` says, and
 * every call is the same Snout Function the CLI makes, so RLS decides once. It is exactly
 * as capable as the person who started it, minus deleting a database unless they said
 * `--allow-delete`.
 */

import * as manage from './manage.js';
import * as api from '../api.js';
import { setJsonMode, warn } from '../output.js';
import { TOOLS, handle, takeMessages, type McpOperations, type McpOptions, type ToolDefinition } from '../mcp.js';
import * as desktop from '../desktop.js';
import { runPush } from './push.js';
import { runDeploy, runList, runRemove, runSize } from './functions.js';

/**
 * The impure half, in one object.
 *
 * Each of these is what the equivalent command does, minus the printing: `mcp.ts` decides
 * what to say, and it says it in JSON to a model rather than in prose to a terminal.
 */
function operations(): McpOperations {
	return {
		whoami: () => api.whoami(),
		listProjects: () => api.listProjects(),
		createProject: async (input) => {
			const created = await api.call<{ project: api.Project }>('cloud-project-create', {
				name: input.name,
				...(input.region ? { region: input.region } : {}),
				...(input.teamId ? { teamId: input.teamId } : {})
			});
			// Waited for, not returned mid-create: an agent handed a ref in state `creating`
			// will connect to it, fail, and conclude the product is broken.
			//
			// And when the wait runs out, SAY SO. This used to `.catch(() => created.project)`,
			// which handed back exactly that half-made project with no error on it, causing
			// the failure the sentence above is about. The project is real and probably fine;
			// what is not true is that it is ready, so the agent is told to ask again rather
			// than told nothing.
			try {
				return await api.waitForReady(created.project.ref);
			} catch {
				return {
					...created.project,
					ready: false,
					note: `${created.project.ref} was created and is still starting. It was not ready within the wait. Call list_projects in a few seconds; do not connect to it yet.`
				};
			}
		},
		usage: (ref, days) => api.call('cloud-project-usage', { ref, ...(days ? { days } : {}) }),
		exportStatus: (ref) => api.exportStatus(ref),
		requestExport: (ref) => api.requestExport(ref),
		resetPassword: (ref) => api.call('cloud-project-reset-password', { ref }),
		listTeams: () => api.call('cloud-team-list', {}),
		// The result-returning halves, for the same reason `pushMigrations` uses one:
		// stdout is the JSON-RPC wire here.
		deployFunction: (ref, name, options) => runDeploy(ref, name, options).then((done) => done.answer),
		listFunctions: (ref) => runList(ref),
		deleteFunction: (ref, name) => runRemove(ref, name),
		sizeFunction: (ref, name, options) => runSize(ref, name, options),
		// Names and sizes. There is no tool that SETS one, and `McpOperations` says why.
		listFunctionSecrets: (ref) => api.call('cloud-project-secrets', { ref }),
		listTokens: () => api.call('cloud-token-list', {}),
		createToken: (name, expiresInDays, project) =>
			api.call('cloud-token-create', {
				name,
				...(expiresInDays ? { expiresInDays } : {}),
				...(project ? { project } : {})
			}),
		revokeToken: (id) => api.call('cloud-token-revoke', { id }),
		getProject: (ref) => manage.getProject(ref),
		getProducts: (ref) => manage.getProducts(ref),
		setProduct: (ref, product, enabled) => manage.setProduct(ref, product, enabled),
		listDomains: (ref) => manage.listDomains(ref),
		domainAction: (ref, action, hostname) => manage.domainAction(ref, action, hostname),
		restoreWindow: (ref) => manage.restoreWindow(ref),
		restoreTo: (ref, at, name) => manage.restoreTo(ref, at, name),
		setProjectState: (verb, ref) => api.call(`cloud-project-${verb}`, { ref }),
		connection: (ref) => api.connection(ref),
		// The result-returning half, never the printing one: stdout is the JSON-RPC wire
		// here, and a command that writes to it corrupts the protocol.
		pushMigrations: (ref, options) => runPush(ref, { dir: options.dir, dryRun: options.dryRun })
	};
}

/** The prefix every borrowed tool wears. */
const BORROWED = 'app_';

/**
 * Look for the desktop app and borrow its tools, ONCE, before serving.
 *
 * The three shapes a user can be in, and all three work:
 *
 *   app only        the app's own MCP server, exactly as before. Nothing here changes it.
 *   CLI only        these tools, talking to the cloud. The common case, and a container.
 *   both            one stdio endpoint carrying both, so an agent configures one server
 *                   and never pastes a bearer token out of a settings screen.
 *
 * Decided at startup because the tool list is frozen at connect. An app that starts later
 * cannot be picked up, and saying so at the handshake is better than pretending otherwise.
 * Every failure is silent and means "cloud only": a CLI that refuses to serve because a
 * desktop app is shut would be worse than one that serves less.
 */
async function borrow(): Promise<{ tools: ToolDefinition[]; config: desktop.DesktopConfig | null }> {
	if (process.env.SNOUTDATA_NO_DESKTOP) {
		return { tools: [], config: null };
	}
	// The same walk the auth ladder does, so a dev app on one port and a stale installed
	// config on another behave identically in both places.
	const found = await desktop.look();
	if (!found.available) {
		return { tools: [], config: null };
	}
	const config = found.config;
	try {
		const borrowed = await desktop.borrowTools(config);
		// Duplicates are NOT filtered here on purpose. The app can and does offer two tools
		// of the same name (2026-09-07: it publishes both its built-in database tools and
		// its renderer capability registry, and each had a `list_connections`), but the
		// promise that no two tools share a name belongs where the list goes on the wire —
		// `uniqueByName` in `mcp.ts` — so it holds for every source at once instead of only
		// for this one. This is a guard's job, not a fix: the app should not be offering two.
		const tools = borrowed.map((tool) => ({
			// Prefixed so provenance is visible in the name itself. An agent choosing
			// between `list_projects` (your account, in the cloud) and `app_list_connections`
			// (the databases configured in the app on this machine) should not have to infer
			// which is which from a description.
			name: `${BORROWED}${tool.name}`,
			description: `[SnoutData app, on this machine] ${tool.description ?? tool.name}`,
			inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as ToolDefinition['inputSchema']
		}));
		return { tools, config };
	} catch {
		return { tools: [], config: null };
	}
}

export async function serve(options: Omit<McpOptions, 'version'> & { version: string }): Promise<number> {
	// Before anything else: the CLI's own prose must not reach stdout.
	setJsonMode(true);
	const { tools: borrowed, config: appConfig } = await borrow();
	const ops = operations();
	if (appConfig) {
		ops.callBorrowed = (name, args) => desktop.callBorrowed(appConfig, name.slice(BORROWED.length), args);
	}
	// Settled once, before a byte is read: what this server offers cannot change while it
	// runs, because the client asked for the list at connect and will not ask again.
	const served: McpOptions = { ...options, borrowed };
	warn(
		borrowed.length > 0
			? `snoutdata mcp: ${TOOLS.length} cloud tools, and ${borrowed.length} borrowed from the SnoutData app on this machine.`
			: 'snoutdata mcp: cloud tools only. The SnoutData app is not answering here, so its database tools are not on this endpoint.'
	);
	let rest = '';

	process.stdin.setEncoding('utf8');

	// One call before serving anybody, for two reasons.
	//
	// It CHECKS THE CREDENTIAL at the moment somebody is watching. A bad token discovered
	// on the first tool call is a confusing answer inside a conversation; discovered here
	// it is a line in the terminal where the server was started.
	//
	// And it WARMS the session. The control plane exchanges an sdt_ token for a real
	// session and caches it, and a cold cache with several calls at once loses some of
	// them: measured live 2026-09-06, four concurrent calls on a fresh token gave two 401s
	// and the same four afterwards were all fine. An agent's first turn is exactly that
	// burst, so it is worth one round trip to make sure it is never the cold one.
	try {
		const who = (await api.whoami()) as { email?: string };
		warn(`snoutdata mcp: signed in as ${who.email ?? 'this account'}.`);
	} catch (error) {
		warn(`snoutdata mcp: ${error instanceof Error ? error.message : String(error)}`);
		warn('Sign in with `snoutdata login`, or set SNOUTDATA_ACCESS_TOKEN.');
		return 3;
	}

	// Reported once, on stderr, because a person who ran this by hand in a terminal sees
	// nothing at all otherwise and cannot tell it from a hang.
	warn(`snoutdata mcp: ready${options.allowDelete ? ' (delete_project is ON)' : ''}. Speaking MCP on stdin/stdout; stop it with Ctrl-C.`);

	// Every call still in flight. Found by driving it (2026-09-06): a client that closes
	// stdin as soon as it has written — which is what a pipe does, and what a fast client
	// can do — ended the process while two tool calls were still waiting on the network,
	// and those two answers were simply never written. Messages arrive faster than they are
	// answered, by design, so "no more input" is not "no more work".
	const inFlight = new Set<Promise<void>>();
	function track(work: Promise<void>): void {
		inFlight.add(work);
		void work.finally(() => inFlight.delete(work));
	}

	return new Promise((resolve) => {
		process.stdin.on('data', (chunk: string) => {
			const taken = takeMessages(rest + chunk);
			rest = taken.rest;
			for (const line of taken.messages) {
				track(respond(line, ops, served));
			}
		});
		process.stdin.on('end', () => {
			void (async () => {
				// A call can start another (nothing does today, and that is not a reason to
				// assume it never will), so drain until the set is empty rather than once.
				while (inFlight.size > 0) {
					await Promise.allSettled([...inFlight]);
				}
				resolve(0);
			})();
		});
		process.stdin.on('error', () => resolve(1));
	});
}

async function respond(line: string, ops: McpOperations, options: McpOptions): Promise<void> {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		// No id to answer with, so there is nobody to tell. Said on stderr, where a person
		// debugging a client can see it and the protocol cannot be corrupted by it.
		warn(`snoutdata mcp: ignoring a line that is not JSON: ${line.slice(0, 120)}`);
		return;
	}
	try {
		const answer = await handle(request as Record<string, unknown>, ops, options);
		if (answer) {
			process.stdout.write(`${JSON.stringify(answer)}\n`);
		}
	} catch (error) {
		// `handle` turns tool failures into results, so reaching here means the handler
		// itself broke. The client still needs an answer or it waits forever.
		const id = (request as { id?: number | string | null }).id ?? null;
		process.stdout.write(
			`${JSON.stringify({
				jsonrpc: '2.0',
				id,
				error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
			})}\n`
		);
	}
}
