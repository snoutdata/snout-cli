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
import { ApiError, NotSignedIn, localStack, whoami } from './api.js';
import { stackShow, stackStart, stackStatus, stackStop } from './commands/stack.js';
import { localDeploy, localList, localRemove, localSecretsList, localSecretsSet, localSecretsUnset } from './commands/stackFunctions.js';
import { CliFailure, EXIT, codeForStatus, codeForThrown, missingFile } from './failure.js';
import { canAsk, interactiveState, setInteractive } from './interactive.js';
import { clearAuth, initStart, resolveRef, writeAuth, writeLink } from './config.js';
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
import { accessCommand } from './commands/dbAccess.js';
import * as manage from './commands/manage.js';
import * as realtime from './commands/realtime.js';
import { authCommand } from './commands/auth.js';
import { push } from './commands/push.js';
import * as notifications from './commands/notifications.js';
import { genTypes } from './commands/gen.js';
import { livePods, localSql, start, status as localStatus, stop } from './commands/local.js';
import { serve as serveMcp } from './commands/mcp.js';
import { findStack, type LocalStack } from './local.js';
import { usage } from './commands/usage.js';
import { shards } from './commands/shards.js';

import { upgrade } from './commands/upgrade.js';
import { expecting, sameEmail } from './commands/login.js';
import { commandsFor, flagHelp } from './catalogue.js';
import { readAuth } from './config.js';
// Injected by build.mjs from package.json, because a hand-maintained copy of the version
// drifts and did: 0.1.1 was published reporting 0.1.0 in --version, --help and the MCP
// serverInfo, which is the one number an agent has to be able to trust. `typeof` on an
// undeclared identifier does not throw, so the tsc build that the tests run against gets
// "dev" rather than a ReferenceError. It lives in version.ts, beside how the CLI was installed.
import { VERSION } from './version.js';

const USAGE = `snoutdata ${VERSION} — hosted Postgres, from a terminal or an agent

  snoutdata init [--name X] [--env]        a database for this folder, linked, ready to use;
                                           --env writes DATABASE_URL into ./.env (and adds
                                           .env to .gitignore) instead of printing it
  snoutdata login [--provider github]      sign in through a browser
  snoutdata login --email you@x.com        sign in as that account: the browser offers it,
                                           and a different account is reported at once
  snoutdata login --sso [--domain D]       sign in with your company's identity provider;
                                           D is a work email or a domain, and it is asked
                                           for when not given. Only the domain is sent
  snoutdata login --device                 sign in by typing a code into a browser anywhere
  snoutdata login --no-browser             print the URL instead of opening one
  snoutdata logout
  snoutdata whoami
  snoutdata upgrade [--check]              install the newest CLI, the way this one was

  snoutdata tokens create --name ci [--expires DAYS] [--project REF]   a credential for CI, shown once
  snoutdata tokens list
  snoutdata tokens revoke <id|sdt_prefix>

  snoutdata projects list
  snoutdata projects create --name X [--region R] [--no-wait] [--show-url]
                                           prints the ref; the connection string (it holds
                                           the password) only with --show-url, or from db url
  snoutdata projects pause|resume|delete [--ref R] [--no-wait]
  snoutdata link --ref R                   write .snoutdata/project.json here
  snoutdata link --local [NAME|FOLDER]     use a local project (Studio's, or a snout-stack folder) here

  snoutdata projects show [--ref R]        one project: state, products, functions, domains

  snoutdata products [--ref R]             auth, storage, the data API and push: on or off;
                                           Realtime is always on (shown, not switched)
  snoutdata products enable|disable auth|storage|data-api|push [--ref R]
  snoutdata push credentials [--ref R]     push keys: what is set (never the keys)
  snoutdata push credentials set apns --p8 FILE --key-id ID --team-id ID --topic BUNDLE [--environment E]
  snoutdata push credentials set fcm --file service-account.json
  snoutdata push credentials remove apns|fcm
  snoutdata auth [--ref R]                 Google sign-in and redirect addresses
  … | snoutdata auth google --client-id ID --stdin   your own Google client; secret on stdin
  snoutdata auth google off
  snoutdata auth anonymous on|off          guest sign-in: signInAnonymously(), no email or password
  snoutdata auth redirects --site-url URL --allow URL,URL
  snoutdata auth templates                 the five auth emails, ours or yours
  snoutdata auth template KIND --file body.html [--subject S] | reset

  snoutdata realtime inspect [--channel C] [--watch] [--ref R]
                                           channels open now: who, their presence, the last minute
  snoutdata realtime logs [--since 10m] [--channel C] [--ref R]
                                           connects, joins, leaves and disconnects, with why

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
  snoutdata db access [list] [--ref R]     who signs in to the database as themselves
                                           (OAuth, Postgres 18), and as which role
  snoutdata db access grant EMAIL [--level full|read]   a teammate, or you; read by default
  snoutdata db access revoke EMAIL|ROLE    take it away
  snoutdata db export [--ref R] [--out FILE]   take a copy, and download it
  snoutdata db export --status [--ref R]       what the last copy is doing
  snoutdata db push [--dir migrations] [--dry-run]   run the .sql files, once each
  snoutdata db restore --file DUMP [--force]   put a dump into this project
  snoutdata db restore --window [--ref R]      how far back a point-in-time restore can go
  snoutdata db restore --at TIME [--name N]    that moment, into a NEW project beside this one

  snoutdata shards --admin URL [status]     a Lepis cluster (Postgres over several nodes), from its
                                           router's admin API; the token from LEPIS_ADMIN_TOKEN
  snoutdata shards --project REF ...       the same, for a SnoutData Cloud project, as you; there
                                           enable turns it on, nodes add makes a node pod, nodes
                                           attach REF hands a ready one over, scale --nodes N
  snoutdata shards nodes [add|drain|remove] | keyspace create | table distribute|reference|global
                   range split|merge|move | tenant pin | rebalance | scale | verify | cleanup
                                           each with --plan for the dry run (size, copy time,
                                           expected pause); one that moves or deletes data asks,
                                           or takes --yes. Waits for its job unless --no-wait
  snoutdata shards plan <operation>        the same dry run
  snoutdata shards jobs [show|watch|cancel|resume <id>]   the durable job log
  snoutdata shards settings [--max-write-pause-ms N ...] [--set advice_min_bytes=N,...]
                                           the cluster's cutover and advisor settings
  snoutdata shards advise [--sample-ms N]  what to split, move or add, each with its reason, its
                                           plan and the command that runs it; runs nothing

  snoutdata mcp [--allow-delete]           serve these operations to an agent, over stdio
                                           (plus SnoutData Studio's own tools, when it is
                                            running here; SNOUTDATA_NO_DESKTOP opts out)

Every command takes --json, --quiet and --help, and anything that waits takes --timeout
SECONDS. A failure in --json mode is {"ok":false,"code","error"} on stdout, and the exit
code says the same thing more coarsely: 2 the command was wrong, 3 the credential, 4 not
ready yet, 5 forbidden, 6 not found, 7 conflict, 8 quota, 9 network, 10 timed out, 11 this
CLI is out of date ("code":"outdated", run "snoutdata upgrade"), 12 the region is full and
nothing was created ("code":"no-capacity", do not retry in a loop). "<command> --help"
explains each of a command's flags.

With no credential and a person present, sign-in is offered: SnoutData Studio if it is
running here, then a pairing code. With no person (not a terminal, --json, CI, or
SNOUTDATA_NO_INTERACTIVE) nothing is asked and it exits 3 at once.

A project comes from --ref, then SNOUTDATA_PROJECT, then
.snoutdata/project.json in this folder or a parent. A token comes from
SNOUTDATA_ACCESS_TOKEN, then ~/.snoutdata/auth.json. The session that login writes renews
itself as it is used; CI, which has no browser to sign in with, wants "tokens create".

psql, pg_dump and pg_restore run by this CLI verify the database's certificate
(sslmode=verify-full). SNOUTDATA_DB_SSLMODE=require turns that check off, for a network
that re-signs Postgres traffic.

Docs: https://docs.snoutdata.com/developers/cli
Examples: https://github.com/snoutdata/snoutdata (a star helps other people find it)
Source: https://github.com/snoutdata/snout-cli
`;

const SHARDS_ONLY = ['yes', 'token'] as const;

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
		const matching = commandsFor(group, action);
		if (matching.length > 0) {
			emit({ commands: matching.map((one) => ({ ...one, flagHelp: Object.fromEntries(one.flags.map((flag) => [flag, flagHelp(one.name, flag)])) })) }, () => {
				for (const one of matching) {
					const words = 'args' in one && one.args ? ` ${one.args}` : '';
					const flags = one.flags.length > 0 ? ` ${one.flags.join(' ')}` : '';
					process.stdout.write(`  snoutdata ${one.name}${words}${flags}\n      ${one.summary}\n`);
					// One line per flag. A list of bare names told nobody where `init --env` writes,
					// or that it writes a password into a file.
					const width = Math.max(0, ...one.flags.map((flag) => flag.length));
					for (const flag of one.flags) {
						process.stdout.write(`        ${flag.padEnd(width)}  ${flagHelp(one.name, flag)}\n`);
					}
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
	// The local project linked here (or named by --ref), when it is one: start, stop, status and
	// projects show then act on its stack in Docker instead of the cloud or a `start` pod.
	const linkedStack = () => {
		const found = resolveRef({ flag: flagString(args, 'ref') });
		return found ? localStack(found) : null;
	};

	// `--yes` and `--token` mean something to `shards` alone. Anywhere else a yes would confirm
	// nothing and a token on argv is the thing args.ts refuses, so they stay refused there.
	for (const flag of SHARDS_ONLY) {
		if (args.flags[flag] !== undefined && group !== 'shards') {
			throw new UsageError(`--${flag} is only for snoutdata shards`);
		}
	}

	switch (group) {
		case 'shards':
			// A Lepis cluster (L13): a standalone router with --admin, or a
			// SnoutData Cloud project with --project, through the same client seam (shardsClient.ts).
			return shards(args, { timeoutMs: timeoutMs() });
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
				// A pairing token carries no email, so whose it is has to be asked.
				const email = flagString(args, 'email');
				const signedInAs = email ? ((await whoami()).email ?? undefined) : undefined;
				if (email) {
					expecting(email, { accessToken: approved.token, email: signedInAs });
				}
				emit({ ok: true, name: approved.name ?? null, email: signedInAs ?? null }, () => say(`Signed in${signedInAs ? ` as ${signedInAs}` : ''}.`));
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
			// waits five minutes for a click that cannot happen (the no-prompt rule, `interactive.ts`).
			//
			// The SSO half of that rule is one step earlier and lives in `login.ts`: `--sso` with no
			// `--domain` would have to ASK, so with nobody there it exits 2 naming the flag
			// rather than prompting at a terminal that is not one.
			const result = await login({
				provider: flagString(args, 'provider'),
				sso,
				domain,
				noBrowser: flagBoolean(args, 'no-browser') || !canAsk(),
				timeoutMs: timeoutMs(),
				email: flagString(args, 'email')
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
			// `login --email` said whose session this should be. Say so when it is not, every
			// time, since the next command acts as whoever this is.
			const expected = readAuth()?.expectedEmail;
			const mismatch = Boolean(expected && me.email && !sameEmail(expected, me.email));
			if (mismatch) {
				warn(`This session is ${me.email}, and login asked for ${expected}. Run "snoutdata login --email ${expected}" to sign in as that account.`);
			}
			emit({ ...me, ...(expected ? { expectedEmail: expected, matchesExpected: !mismatch } : {}) }, () => {
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
						link: undefined,
						showUrl: flagBoolean(args, 'show-url')
					});
					return 0;
				}
				case 'pause':
				case 'resume':
				case 'delete':
					await projects.action(action, flagString(args, 'ref') ?? rest[0] ?? ref(), {
						wait: !flagBoolean(args, 'no-wait'),
						timeoutMs: timeoutMs()
					});
					return 0;
				case 'show':
					{
						const shown = flagString(args, 'ref') ?? rest[0] ?? ref();
						const stack = localStack(shown);
						if (stack) {
							stackShow(stack);
						} else {
							await manage.showCommand(shown);
						}
					}
					return 0;
				default:
					throw new UsageError(`unknown command: projects ${action}`);
			}
		}
		case 'functions': {
			const local = linkedStack();
			if (local) {
				// A local project's functions are folders in its stack (stackFunctions.ts).
				if (action === 'deploy') {
					if (!rest[0]) {
						throw new UsageError('functions deploy needs a name: snoutdata functions deploy <name>');
					}
					await localDeploy(local, rest[0], { dir: flagString(args, 'dir'), verifyJwt: !flagBoolean(args, 'no-verify-jwt') });
					return 0;
				}
				if (action === undefined || action === 'list') {
					localList(local);
					return 0;
				}
				if ((action === 'delete' || action === 'remove') && rest[0]) {
					await localRemove(local, rest[0]);
					return 0;
				}
			}
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
			const local = linkedStack();
			if (local) {
				if (action === 'set') {
					await localSecretsSet(local, await secrets.pairsFrom(rest, { stdin: flagBoolean(args, 'stdin') }));
					return 0;
				}
				if (action === undefined || action === 'list') {
					localSecretsList(local);
					return 0;
				}
				if ((action === 'unset' || action === 'remove') && rest[0]) {
					await localSecretsUnset(local, rest[0]);
					return 0;
				}
			}
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
		case 'realtime': {
			if (action === undefined || action === 'inspect') {
				return realtime.inspect(ref(), { channel: flagString(args, 'channel'), watch: flagBoolean(args, 'watch') });
			}
			if (action === 'logs') {
				return realtime.logs(ref(), { channel: flagString(args, 'channel'), since: flagString(args, 'since') });
			}
			throw new UsageError(`unknown command: realtime ${action}. realtime inspect|logs`);
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
			if (flagBoolean(args, 'local')) {
				// A stack on this machine (local.ts): by Studio's name or ref, or by its folder.
				let stack: LocalStack;
				try {
					stack = findStack(action);
				} catch (e) {
					throw new CliFailure('not-found', e instanceof Error ? e.message : String(e));
				}
				const path = writeLink(process.cwd(), { ref: stack.ref, ...(stack.name ? { name: stack.name } : {}), local: stack.folder });
				emit({ ref: stack.ref, local: stack.folder, api: stack.apiUrl, path }, () => {
					say(`Linked ${stack.name ?? stack.ref}, the local project in ${stack.folder} (${path}).`);
					say(`Its API is ${stack.apiUrl}; its database is on 127.0.0.1:${stack.dbPort}.`);
				});
				return 0;
			}
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
				case 'access':
					// Who may sign in to the database as themselves, with OAuth (Postgres 18).
					await accessCommand(ref(), rest, { level: flagString(args, 'level') });
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
							: 'db needs an action: url, psql, reset-password, access, export, push, restore'
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
		case 'start': {
			const stack = linkedStack();
			if (stack) {
				return stackStart(stack);
			}
		}
			return start(await livePods(), {
				port: flagNumber(args, 'port'),
				dir: flagString(args, 'dir'),
				noMigrations: flagBoolean(args, 'no-migrations'),
				outOfOrder: flagBoolean(args, 'out-of-order')
			});
		case 'stop': {
			const stack = linkedStack();
			return stack ? stackStop(stack) : stop(await livePods());
		}
		case 'status': {
			const stack = linkedStack();
			return stack ? stackStatus(stack) : localStatus(await livePods());
		}
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
		case 'upgrade':
			return upgrade({ check: flagBoolean(args, 'check') });
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
	const start = initStart({ flag: flagString(args, 'ref') });
	if (start.kind !== 'create') {
		const existing = start.ref;
		if (start.kind === 'linked') {
			say(`This folder is already linked to ${existing}.`);
		} else if (start.kind === 'environment') {
			say(`Using ${existing}, from SNOUTDATA_PROJECT. This folder is not linked to it.`);
		}
		if (flagBoolean(args, 'env')) {
			// Linked already is the usual way to arrive here with --env: `init` first, then
			// wanting the .env. It used to print the URL and leave the file as it was.
			await writeEnvFor(existing);
		} else {
			await db.url(existing);
		}
		// The link is written only once the project answered, so a mistyped ref leaves the
		// folder as it was rather than linked to a project that does not exist.
		if (start.kind === 'link') {
			const stack = localStack(existing);
			const path = writeLink(process.cwd(), stack ? { ref: existing, ...(stack.name ? { name: stack.name } : {}), local: stack.folder } : { ref: existing });
			say(`Linked this folder to ${existing}${start.replaces ? `, in place of ${start.replaces}` : ''} (${path}).`);
		}
		return 0;
	}

	const name = flagString(args, 'name') ?? basenameOf(process.cwd());
	say(`Creating a project called "${name}"…`);
	await projects.create({
		name,
		region: flagString(args, 'region'),
		wait: true,
		link: process.cwd(),
		// `init` without --env exists to hand back a DATABASE_URL, so it prints one. With --env
		// the URL goes into .env and nowhere else.
		showUrl: !flagBoolean(args, 'env')
	});

	const ref = resolveRef({ cwd: process.cwd() });
	if (ref && flagBoolean(args, 'env')) {
		await writeEnvFor(ref);
	}
	return 0;
}

async function writeEnvFor(ref: string): Promise<void> {
	const { connection } = await import('./api.js');
	const details = await connection(ref);
	const written = db.writeEnv(process.cwd(), details.uri);
	say(`${written.replaced ? 'Updated' : 'Wrote'} DATABASE_URL in ${written.path}.`);
	if (written.ignored) {
		say('Added .env to .gitignore, since it holds the password.');
	}
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
		const code = codeForStatus(error.status, error.serverCode);
		emitFailure(code, error.message, { status: error.status, ...(error.serverCode ? { serverCode: error.serverCode } : {}) });
		return EXIT[code];
	}
	const missing = missingFile(error);
	if (missing) {
		emitFailure('usage', missing);
		return EXIT.usage;
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
	// there is a person to ask is a fact about this run, not about the moment.
	setInteractive(interactiveState({ isTty: Boolean(process.stdin.isTTY), json: args.json, env: process.env }));

	try {
		exitWith(await run(args));
	} catch (error) {
		exitWith(report(error));
	}
}

void main();
