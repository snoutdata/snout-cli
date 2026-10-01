/**
 * `snoutdata` — hosted Postgres from a terminal, or from an agent.
 *
 * The command this whole thing exists for is `snoutdata init`: a folder with no database
 * becomes a folder with a working `DATABASE_URL`, with no browser if a token is set and
 * no human at any point. Everything else is the vocabulary that makes that honest.
 *
 * Three rules, and they are what an agent depends on:
 *
 *   * `--json` on any command means exactly one JSON value on stdout and nothing else.
 *   * Nothing prompts when stdin is not a TTY. A command that would have to ask says
 *     what flag to pass instead, and exits 2.
 *   * Exit codes: 0 fine, 1 the operation failed, 2 the command was wrong, 3 not signed
 *     in, 4 the project is not ready yet.
 */

import { parseArgs, flagBoolean, flagNumber, flagString, UsageError, type ParsedArgs } from './args.js';
import { COMMANDS } from './catalogue.js';
import { ApiError, NotSignedIn, whoami } from './api.js';
import { CliFailure, EXIT, codeForStatus, codeForThrown } from './failure.js';
import { canAsk, interactiveState, setInteractive } from './interactive.js';
import { clearAuth, resolveRef, writeAuth, writeLink } from './config.js';
import { start as deviceStart, waitForApproval } from './device.js';
import { thisMachine } from './desktop.js';
import { dim, emit, emitFailure, say, setJsonMode, setQuiet, warn } from './output.js';
import { login } from './commands/login.js';
import * as projects from './commands/projects.js';
import * as tokens from './commands/tokens.js';
import * as keys from './commands/keys.js';
import * as functions from './commands/functions.js';
import * as secrets from './commands/secrets.js';
import * as db from './commands/db.js';
import * as manage from './commands/manage.js';
import { authCommand } from './commands/auth.js';
import { push } from './commands/push.js';
import * as notifications from './commands/notifications.js';
import { genTypes } from './commands/gen.js';
import { livePods, localSql, start, status as localStatus, stop } from './commands/local.js';
import { serve as serveMcp } from './commands/mcp.js';
import { usage } from './commands/usage.js';

// Injected by build.mjs from package.json, because a hand-maintained copy of the version
// drifts and did: 0.1.1 was published reporting 0.1.0 in --version, --help and the MCP
// serverInfo, which is the one number an agent has to be able to trust. `typeof` on an
// undeclared identifier does not throw, so the tsc build that the tests run against gets
// "dev" rather than a ReferenceError.
declare const __SNOUTDATA_VERSION__: string | undefined;
const VERSION = typeof __SNOUTDATA_VERSION__ === 'string' ? __SNOUTDATA_VERSION__ : 'dev';

const USAGE = `snoutdata ${VERSION} — hosted Postgres, from a terminal or an agent

  snoutdata init [--name X] [--env]        a database for this folder, linked, ready to use
  snoutdata login [--provider github]      sign in through a browser
  snoutdata login --sso [--domain D]       sign in with your company's identity provider;
                                           D is a work email or a domain, and it is asked
                                           for when not given. Only the domain is sent
  snoutdata login --device                 sign in by typing a code into a browser anywhere
  snoutdata login --no-browser             print the URL instead of opening one
  snoutdata logout
  snoutdata whoami

  snoutdata tokens create --name ci [--expires DAYS] [--project REF]   a credential for CI, shown once
  snoutdata tokens list
  snoutdata tokens revoke <id|sdt_prefix>

  snoutdata projects list
  snoutdata projects create --name X [--region R] [--no-wait]
  snoutdata projects pause|resume|delete [--ref R]
  snoutdata link --ref R                   write .snoutdata/project.json here

  snoutdata projects show [--ref R]        one project: state, products, functions, domains

  snoutdata products [--ref R]             auth, storage, the data API and push: on or off
  snoutdata products enable|disable auth|storage|data-api|push [--ref R]
  snoutdata push credentials [--ref R]     push keys: what is set (never the keys)
  snoutdata push credentials set apns --p8 FILE --key-id ID --team-id ID --topic BUNDLE [--environment E]
  snoutdata push credentials set fcm --file service-account.json
  snoutdata push credentials remove apns|fcm
  snoutdata auth [--ref R]                 Google sign-in and redirect addresses
  … | snoutdata auth google --client-id ID --stdin   your own Google client; secret on stdin
  snoutdata auth google off
  snoutdata auth redirects --site-url URL --allow URL,URL
  snoutdata auth templates                 the five auth emails, ours or yours
  snoutdata auth template KIND --file body.html [--subject S] | reset

  snoutdata domains [--ref R]              your own domains in front of the project's API
  snoutdata domains add|verify|remove <hostname> [--ref R]

  snoutdata usage [--ref R] [--days 30] [--history]   size, compute, and the plan's limit

  snoutdata start [--port 54322] [--dir migrations]   a Postgres here, migrated and seeded
  snoutdata stop                           stop it; the data stays
  snoutdata status                         is it running, how big, on what port

  snoutdata gen types typescript [--local] [--schema public] [--out FILE]
                                           the schema as a TypeScript Database type

  snoutdata functions deploy <name> [--dir D] [--no-verify-jwt]
                                           from functions/<name>, onto the edge
  snoutdata functions list [--ref R]
  snoutdata functions size <name> [--memory MB] [--concurrency N] [--reset]
                                           its memory and workers, within the plan
  snoutdata functions delete <name>

  snoutdata secrets set NAME=value [...]   the environment functions run with
  snoutdata secrets set NAME --stdin       the value from a pipe, not from history
  snoutdata secrets list                   names and sizes; values are never readable
  snoutdata secrets unset NAME

  snoutdata keys [--ref R]                 the anon and service_role API keys
  snoutdata keys rotate --force [--ref R]  new ones, breaking every key already issued

  snoutdata teams                          teams you can share a project with
  snoutdata db url [--ref R]               print a connection string
  snoutdata db psql [--ref R] [-- ...]     open psql, with no password typed
  snoutdata db reset-password [--ref R]
  snoutdata db export [--ref R] [--out FILE]   take a copy, and download it
  snoutdata db export --status [--ref R]       what the last copy is doing
  snoutdata db push [--dir migrations] [--dry-run]   run the .sql files, once each
  snoutdata db restore --file DUMP [--force]   put a dump into this project
  snoutdata db restore --window [--ref R]      how far back a point-in-time restore can go
  snoutdata db restore --at TIME [--name N]    that moment, into a NEW project beside this one

  snoutdata mcp [--allow-delete]           serve these operations to an agent, over stdio
                                           (plus SnoutData Studio's own tools, when it is
                                            running here; SNOUTDATA_NO_DESKTOP opts out)

Every command takes --json, --quiet and --help, and anything that waits takes --timeout
SECONDS. A failure in --json mode is {"ok":false,"code","error"} on stdout, and the exit
code says the same thing more coarsely: 2 the command was wrong, 3 the credential, 4 not
ready yet, 5 forbidden, 6 not found, 7 conflict, 8 quota, 9 network, 10 timed out.

With no credential and a person present, sign-in is offered: SnoutData Studio if it is
running here, then a pairing code. With no person (not a terminal, --json, CI, or
SNOUTDATA_NO_INTERACTIVE) nothing is asked and it exits 3 at once.

A project comes from --ref, then SNOUTDATA_PROJECT, then
.snoutdata/project.json in this folder or a parent. A token comes from
SNOUTDATA_ACCESS_TOKEN, then ~/.snoutdata/auth.json. The session that login writes lasts
an hour, so CI wants "tokens create", which does not expire.

Docs: https://docs.snoutdata.com/cloud/cli
Examples: https://github.com/snoutdata/snoutdata (a star helps other people find it)
Source: https://github.com/snoutdata/snout-cli
`;

async function run(args: ParsedArgs): Promise<number> {
	const [group, action, ...rest] = args.command;

	if (flagBoolean(args, 'version') || group === 'version') {
		emit({ version: VERSION }, () => process.stdout.write(`${VERSION}\n`));
		return 0;
	}
	// Asking for help is not an error, so it exits 0. Running with no arguments at all is
	// (the caller meant to say something), so that stays 2. `--help` used to exit 2 as
	// well, which made `snoutdata --help || exit` fail a script that was reading the help.
	// `snoutdata projects --help` used to print the whole manual, which is the answer to a
	// different question. With a group, answer about that group: the same COMMANDS data,
	// filtered, so there is no second copy of the surface to go stale.
	if (flagBoolean(args, 'help') && group && group !== 'help') {
		const matching = COMMANDS.filter((one) => one.name === group || one.name.startsWith(`${group} `));
		if (matching.length > 0) {
			emit({ commands: matching }, () => {
				for (const one of matching) {
					const flags = one.flags.length > 0 ? ` ${one.flags.join(' ')}` : '';
					process.stdout.write(`  snoutdata ${one.name}${flags}\n      ${one.summary}\n`);
				}
				process.stdout.write(`\n  Every command also takes --json, --quiet and --help.\n`);
			});
			return 0;
		}
	}

	const wantsHelp = flagBoolean(args, 'help') || group === 'help';
	if (wantsHelp || !group) {
		// In JSON mode even the help is machine-readable, because the first thing an agent
		// does with an unfamiliar CLI is ask what it can do.
		emit({ version: VERSION, usage: USAGE.trim(), commands: COMMANDS }, () => process.stdout.write(USAGE));
		return wantsHelp ? 0 : EXIT.usage;
	}

	// `--timeout` in SECONDS: it is what somebody types and what a CI budget is expressed
	// in. Every blocking path takes it; without it the ceilings were 300s and 1800s and
	// there was no way to shorten either from outside.
	const timeoutMs = () => {
		const seconds = flagNumber(args, 'timeout');
		if (seconds === undefined) {
			return undefined;
		}
		if (!(seconds > 0)) {
			throw new UsageError('--timeout is a number of seconds greater than zero');
		}
		return seconds * 1000;
	};

	const ref = () => {
		const found = resolveRef({ flag: flagString(args, 'ref') });
		if (!found) {
			throw new UsageError(
				'no project: pass --ref, set SNOUTDATA_PROJECT, or run `snoutdata link --ref <ref>`'
			);
		}
		return found;
	};

	switch (group) {
		case 'login': {
			if (flagBoolean(args, 'device')) {
				// The pairing flow, asked for by name. The ladder offers it too, but as the
				// last rung of a fallback; somebody who already knows they are on a box with
				// no browser should not have to decline two questions to reach it.
				const started = await deviceStart({ name: thisMachine(), platform: process.platform });
				emit({ verifyUrl: started.verifyUrl, code: started.code, expiresAt: started.expiresAt }, () => {
					say('');
					say(`  Open   ${started.verifyUrl}`);
					say(`  Type   ${started.code}`);
					say('');
					say(dim('Waiting for that to be approved…'));
				});
				const approved = await waitForApproval(started.secret, {
					intervalMs: Math.max(1, started.interval) * 1000,
					expiresAt: started.expiresAt
				});
				writeAuth({ accessToken: approved.token });
				emit({ ok: true, name: approved.name ?? null }, () => say('Signed in.'));
				return 0;
			}
			// `--domain` on its own means SSO: it is the only thing that flag is for, and
			// somebody who typed it has already said what they want. `--provider` names one
			// of OUR doors and SSO is the customer's own, so asking for both is a
			// contradiction rather than a preference, and it is refused here instead of one
			// of them silently winning.
			const domain = flagString(args, 'domain');
			const sso = flagBoolean(args, 'sso') || domain !== undefined;
			if (sso && flagString(args, 'provider')) {
				throw new UsageError('--sso and --provider are two different doors: pass one or the other');
			}
			// No browser when asked, and no browser when there is nobody to look at one:
			// spawning `xdg-open` from a CI job puts a window on nobody's screen and then
			// waits five minutes for a click that cannot happen. D1.
			//
			// The SSO half of D1 is one step earlier and lives in `login.ts`: `--sso` with no
			// `--domain` would have to ASK, so with nobody there it exits 2 naming the flag
			// rather than prompting at a terminal that is not one.
			const result = await login({
				provider: flagString(args, 'provider'),
				sso,
				domain,
				noBrowser: flagBoolean(args, 'no-browser') || !canAsk(),
				timeoutMs: timeoutMs()
			});
			emit({ email: result.email ?? null }, () => say(`Signed in${result.email ? ` as ${result.email}` : ''}.`));
			return 0;
		}
		case 'logout': {
			clearAuth();
			// The env var outranks the stored session, so clearing the file while
			// SNOUTDATA_ACCESS_TOKEN is set leaves `whoami` working and reads as a bug.
			// A command cannot unset a variable in its parent shell, so it says so.
			const stillSet = Boolean(process.env.SNOUTDATA_ACCESS_TOKEN);
			emit({ ok: true, environmentTokenStillSet: stillSet }, () => {
				say('Signed out.');
				if (stillSet) {
					say('SNOUTDATA_ACCESS_TOKEN is still set in this shell, so commands will keep working.');
					say(dim('  unset SNOUTDATA_ACCESS_TOKEN'));
				}
			});
			return 0;
		}
		case 'whoami': {
			const me = await whoami();
			emit(me, () => {
				process.stdout.write(`${me.email ?? me.id}\n`);
				if (me.token) {
					say(
						`via access token ${me.token.prefix} (${me.token.name})${me.token.project ? `, limited to project ${me.token.project}` : ''}.`
					);
				}
			});
			return 0;
		}
		case 'tokens': {
			switch (action) {
				case undefined:
				case 'list':
					await tokens.list();
					return 0;
				case 'create': {
					const name = flagString(args, 'name') ?? rest[0];
					if (!name) {
						throw new UsageError('tokens create needs --name (what is it for, and where does it live)');
					}
					await tokens.create({
						name,
						expiresInDays: flagNumber(args, 'expires'),
						project: flagString(args, 'project')
					});
					return 0;
				}
				case 'revoke': {
					const wanted = rest[0];
					if (!wanted) {
						throw new UsageError('tokens revoke needs the token\'s id or its sdt_ prefix');
					}
					await tokens.revoke(wanted);
					return 0;
				}
				default:
					throw new UsageError(`unknown command: tokens ${action}`);
			}
		}
		case 'projects': {
			switch (action) {
				case undefined:
				case 'list':
					await projects.list();
					return 0;
				case 'create': {
					const name = flagString(args, 'name') ?? rest[0];
					if (!name) {
						throw new UsageError('projects create needs --name');
					}
					const teamFlag = flagString(args, 'team');
					await projects.create({
						teamId: teamFlag ? await projects.resolveTeam(teamFlag) : undefined,
						name,
						region: flagString(args, 'region'),
						wait: !flagBoolean(args, 'no-wait'),
						timeoutMs: timeoutMs(),
						link: undefined
					});
					return 0;
				}
				case 'pause':
				case 'resume':
				case 'delete':
					await projects.action(action, flagString(args, 'ref') ?? rest[0] ?? ref());
					return 0;
				case 'show':
					await manage.showCommand(flagString(args, 'ref') ?? rest[0] ?? ref());
					return 0;
				default:
					throw new UsageError(`unknown command: projects ${action}`);
			}
		}
		case 'functions': {
			switch (action) {
				case 'deploy': {
					const name = rest[0];
					if (!name) {
						throw new UsageError('functions deploy needs a name: snoutdata functions deploy <name>');
					}
					await functions.deploy(ref(), name, {
						dir: flagString(args, 'dir'),
						entrypoint: flagString(args, 'entrypoint'),
						// `--no-verify-jwt`, the usual spelling. Default ON: a function is arbitrary
						// code with a network attached, and the cost of the wrong default is
						// a stranger running it.
						verifyJwt: !flagBoolean(args, 'no-verify-jwt')
					});
					return 0;
				}
				case undefined:
				case 'list':
					await functions.list(ref());
					return 0;
				case 'size': {
					const name = rest[0];
					if (!name) {
						throw new UsageError('functions size needs a name: snoutdata functions size <name> --memory MB --concurrency N');
					}
					await functions.size(ref(), name, {
						memoryMb: flagNumber(args, 'memory'),
						concurrency: flagNumber(args, 'concurrency'),
						reset: flagBoolean(args, 'reset')
					});
					return 0;
				}
				case 'delete':
				case 'remove': {
					const name = rest[0];
					if (!name) {
						throw new UsageError('functions delete needs a name');
					}
					await functions.remove(ref(), name);
					return 0;
				}
				default:
					throw new UsageError(`unknown command: functions ${action}`);
			}
		}
		case 'secrets': {
			switch (action) {
				case 'set':
					await secrets.set(ref(), rest, { stdin: flagBoolean(args, 'stdin') });
					return 0;
				case undefined:
				case 'list':
					await secrets.list(ref());
					return 0;
				case 'unset':
				case 'remove': {
					const name = rest[0];
					if (!name) {
						throw new UsageError('secrets unset needs a name');
					}
					await secrets.unset(ref(), name);
					return 0;
				}
				default:
					throw new UsageError(`unknown command: secrets ${action}`);
			}
		}
		case 'keys': {
			switch (action) {
				case undefined:
				case 'show':
				case 'list':
					await keys.show(ref());
					return 0;
				case 'rotate':
					await keys.rotate(ref(), { force: flagBoolean(args, 'force') });
					return 0;
				default:
					throw new UsageError(`unknown command: keys ${action}`);
			}
		}
		case 'products': {
			if (action === undefined || action === 'list') {
				await manage.productsCommand(ref());
				return 0;
			}
			if (action === 'enable' || action === 'disable') {
				await manage.setProductCommand(ref(), manage.parseProduct(rest[0]), action === 'enable');
				return 0;
			}
			throw new UsageError(`unknown command: products ${action}. products [enable|disable ${manage.PRODUCTS.join('|')}]`);
		}
		case 'push': {
			if (action !== 'credentials') {
				throw new UsageError('push credentials [set apns|fcm | remove apns|fcm]');
			}
			const verb = rest[0];
			if (verb === undefined || verb === 'list') {
				await notifications.listCommand(ref());
				return 0;
			}
			if (verb === 'set') {
				const kind = notifications.parseKind(rest[1]);
				const body =
					kind === 'apns'
						? await notifications.apnsBody({
								p8: flagString(args, 'p8'),
								keyId: flagString(args, 'key-id'),
								teamId: flagString(args, 'team-id'),
								topic: flagString(args, 'topic'),
								environment: flagString(args, 'environment')
							})
						: await notifications.fcmBody(flagString(args, 'file'));
				await notifications.setCommand(ref(), kind, body);
				return 0;
			}
			if (verb === 'remove' || verb === 'unset') {
				await notifications.removeCommand(ref(), notifications.parseKind(rest[1]));
				return 0;
			}
			throw new UsageError(`unknown command: push credentials ${verb}`);
		}
		case 'auth': {
			await authCommand(ref(), action, rest, {
				clientId: flagString(args, 'client-id'),
				stdin: flagBoolean(args, 'stdin'),
				siteUrl: flagString(args, 'site-url'),
				allow: flagString(args, 'allow'),
				file: flagString(args, 'file'),
				subject: flagString(args, 'subject')
			});
			return 0;
		}
		case 'domains': {
			await manage.domainsCommand(ref(), action, rest[0]);
			return 0;
		}
		case 'teams': {
			await projects.listTeamsCommand();
			return 0;
		}
		case 'link': {
			const target = flagString(args, 'ref') ?? action;
			if (!target) {
				throw new UsageError('link needs --ref');
			}
			const path = writeLink(process.cwd(), { ref: target });
			emit({ ref: target, path }, () => say(`Linked ${target} (${path}).`));
			return 0;
		}
		case 'db': {
			switch (action) {
				case 'url':
					await db.url(ref());
					return 0;
				case 'psql':
					return db.psql(ref(), rest);
				case 'reset-password':
					await projects.resetPassword(ref());
					return 0;
				case 'push':
					// --dry-run is its own flag rather than the absence of a --yes, because
					// the safe thing has to be the thing that is easy to type and this
					// command's safe thing is finding out.
					return push(ref(), {
						dir: flagString(args, 'dir'),
						dryRun: Boolean(args.flags['dry-run']),
						outOfOrder: Boolean(args.flags['out-of-order'])
					});
				case 'restore':
					// Two different restores. --at/--window rewind the project to a moment, into a
					// NEW project beside it; --file puts a dump INTO this one.
					if (flagBoolean(args, 'window')) {
						await manage.restoreWindowCommand(ref());
						return 0;
					}
					if (flagString(args, 'at')) {
						await manage.restoreToCommand(ref(), flagString(args, 'at')!, flagString(args, 'name'));
						return 0;
					}
					return db.restoreDatabase(ref(), {
						file: flagString(args, 'file'),
						force: Boolean(args.flags['force'])
					});
				case 'export':
					return db.exportDatabase(ref(), {
						timeoutMs: timeoutMs(),
						out: flagString(args, 'out'),
						// `--status` looks without asking. Worth its own flag rather than being
						// inferred, because the difference between the two is whether a
						// `pg_dump` runs against somebody's production database.
						statusOnly: Boolean(args.flags['status'])
					});
				default:
					throw new UsageError(
						action
							? `unknown command: db ${action}`
							: 'db needs an action: url, psql, reset-password, export, push, restore'
					);
			}
		}
		case 'gen': {
			// The language is an argument rather than part of the command name, so Go or
			// Swift is a new emitter and not a new script.
			if (action !== 'types') {
				throw new UsageError(action ? `unknown command: gen ${action}` : 'gen needs an action: types');
			}
			// --local reads the pod `snoutdata start` is running, and takes its psql too: a machine
			// with none of its own (every default Windows install) could not run this command.
			const local = flagBoolean(args, 'local') ? await localSql(await livePods()) : null;
			const dbUrl = local ? local.dbUrl : flagString(args, 'db-url');
			return genTypes(rest[0], {
				ref: dbUrl ? undefined : ref(),
				dbUrl,
				schemas: (flagString(args, 'schema') ?? 'public')
					.split(',')
					.map((one) => one.trim())
					.filter(Boolean),
				out: flagString(args, 'out'),
				sql: local?.sql
			});
		}
		case 'start':
			return start(await livePods(), {
				port: flagNumber(args, 'port'),
				dir: flagString(args, 'dir'),
				noMigrations: flagBoolean(args, 'no-migrations'),
				outOfOrder: flagBoolean(args, 'out-of-order')
			});
		case 'stop':
			return stop(await livePods());
		case 'status':
			return localStatus(await livePods());
		case 'usage':
			return usage(ref(), {
				days: flagNumber(args, 'days'),
				history: Boolean(args.flags['history'])
			});
		case 'mcp':
			// Not under `db`: it is not about one database, it is the whole CLI as tools.
			return serveMcp({ version: VERSION, allowDelete: Boolean(args.flags['allow-delete']) });
		case 'init':
			return init(args);
		default:
			throw new UsageError(`unknown command: ${group}`);
	}
}

/**
 * The agent command: from nothing to a working `DATABASE_URL`.
 *
 * Idempotent, which is the part that matters — an agent re-running it must not create a
 * second database. A folder that is already linked is used as it is.
 */
async function init(args: ParsedArgs): Promise<number> {
	const existing = resolveRef({ flag: flagString(args, 'ref') });
	if (existing) {
		say(`This folder is already linked to ${existing}.`);
		await db.url(existing);
		return 0;
	}

	const name = flagString(args, 'name') ?? basenameOf(process.cwd());
	say(`Creating a project called "${name}"…`);
	await projects.create({
		name,
		region: flagString(args, 'region'),
		wait: true,
		link: process.cwd()
	});

	const ref = resolveRef({ cwd: process.cwd() });
	if (ref && flagBoolean(args, 'env')) {
		const { connection } = await import('./api.js');
		const details = await connection(ref);
		const written = db.writeEnv(process.cwd(), details.uri);
		say(`${written.replaced ? 'Updated' : 'Wrote'} DATABASE_URL in ${written.path}.`);
	}
	return 0;
}

function basenameOf(directory: string): string {
	const parts = directory.split(/[\\/]/).filter(Boolean);
	return parts[parts.length - 1] ?? 'project';
}

/**
 * The one place a failure is reported, and the only place an exit code is chosen.
 *
 * Every command throws; nothing returns a number any more. Six call sites used to do
 * their own `warn` and `return 1`, and four of them wrote nothing at all in JSON mode,
 * which is how "exactly one JSON value on stdout" quietly stopped being true.
 */
function report(error: unknown): number {
	if (error instanceof CliFailure) {
		emitFailure(error.code, error.message, error.details);
		return error.exitCode;
	}
	if (error instanceof UsageError) {
		emitFailure('usage', error.message);
		return EXIT.usage;
	}
	if (error instanceof NotSignedIn) {
		emitFailure('not-signed-in', error.message);
		return EXIT['not-signed-in'];
	}
	if (error instanceof ApiError) {
		const code = codeForStatus(error.status);
		emitFailure(code, error.message, { status: error.status });
		return EXIT[code];
	}
	// Anything else: a bug of ours, or the network wearing a TypeError. `codeForThrown`
	// is what tells those apart, and it is the difference between an agent retrying and
	// an agent giving up.
	const code = codeForThrown(error);
	emitFailure(code, error instanceof Error ? error.message : String(error));
	return EXIT[code];
}

/**
 * How this process ends, and why it is not `process.exit()`.
 *
 * `process.exit()` tears the runtime down while handles are still live. After any network
 * call that is undici's socket, and on **Node 24 + Windows** it trips a libuv assertion:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76
 *
 * which replaces the command's real exit code with **127**. `snoutdata whoami` printed the
 * right answer and then reported failure to anything reading `$?`. Node 22 does not do it,
 * which is why it was never seen: this is a Mac-written CLI on a Node 22 repo, and
 * `package.json` says `>=20`, so Node 24 is a version we claim to support.
 *
 * Setting the code and letting the loop drain is the correct way out, and it is prompt —
 * undici's keep-alive does not hold the process open.
 *
 * The unref'd timer is the safety net for a command that leaks a handle. An unref'd timer
 * cannot itself keep a process alive, so it only ever fires when something ELSE is holding
 * the loop open: a clean command exits immediately and never reaches it, and a leaky one
 * still exits, with its real code, instead of hanging.
 */
function exitWith(code: number): void {
	process.exitCode = code;
	setTimeout(() => process.exit(code), 2_000).unref();
}

/**
 * Is `--json` on the command line, without parsing it?
 *
 * The parse is one of the things that can FAIL, and until this existed a failed parse was
 * the one usage error that could not be structured. An unknown COMMAND fails after the
 * parse and produced proper JSON; an unknown FLAG fails during it and produced nothing on
 * stdout at all, with a bare line on stderr. Same failure class, same exit code, two
 * shapes, and which one an agent got depended on which mistake it had made.
 *
 * Scanning raw argv cannot itself fail, which is the point. It stops at `--` because
 * everything after that belongs to a child process (`db psql -- -c "…"`), and a `--json`
 * meant for psql is not a request about our output.
 */
function wantsJson(argv: readonly string[]): boolean {
	const end = argv.indexOf('--');
	return (end === -1 ? argv : argv.slice(0, end)).includes('--json');
}

async function main(): Promise<void> {
	// Set before the parse, so a parse failure can be reported in the shape the caller asked
	// for. Re-set from the parsed flags below, which is authoritative once it exists.
	setJsonMode(wantsJson(process.argv.slice(2)));
	let args: ParsedArgs;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		emitFailure('usage', String(error instanceof Error ? error.message : error));
		exitWith(EXIT.usage);
		return;
	}
	setJsonMode(args.json);
	setQuiet(args.flags.quiet === true);
	// Decided once, here, rather than re-derived at each rung of the auth ladder: whether
	// there is a person to ask is a fact about this run, not about the moment. D1.
	setInteractive(interactiveState({ isTty: Boolean(process.stdin.isTTY), json: args.json, env: process.env }));

	try {
		exitWith(await run(args));
	} catch (error) {
		exitWith(report(error));
	}
}

void main();
