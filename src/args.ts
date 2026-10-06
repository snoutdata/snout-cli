/**
 * Argument parsing, as a pure function.
 *
 * Hand-written rather than a dependency, for the reason the whole CLI is one bundled
 * file: `npx snoutdata` competes with the time it takes to install, and an agent that
 * waits on a dependency graph before it can ask for a database will use something else.
 *
 * The shape is `snoutdata <group> <action> [target] [--flags]`, and there are three
 * rules worth stating because they are what an agent depends on:
 *
 *  * **`--json` is accepted everywhere** and never means anything but "emit JSON on
 *    stdout and nothing else". Diagnostics go to stderr.
 *  * **Unknown flags are an error**, not a shrug. A typo in a script that silently does
 *    something else is worse than a script that stops.
 *  * **Nothing prompts when stdin is not a TTY.** That is enforced where the prompt
 *    would be, not here, but it is why every command takes its input as a flag.
 */

export interface ParsedArgs {
	readonly command: string[];
	readonly flags: Readonly<Record<string, string | boolean>>;
	readonly json: boolean;
}

export class UsageError extends Error {}

/** Flags that take a value. Everything else is a boolean. */
const VALUED = new Set([
	'name',
	// `db restore --at 2026-09-20T14:30:00Z`: the moment a point-in-time restore goes back to.
	'at',
	'region',
	'ref',
	'file',
	'provider',
	// `login --domain acme.com`: whose identity provider to sign in with. A work email is
	// accepted too and only its domain is sent, because a person knows their email address
	// and nobody knows the name of their identity provider.
	'domain',
	'expires',
	// `tokens create --project <ref>`: the one project the token reaches.
	'project',
	// `--timeout`: seconds to wait before giving up on anything that blocks. Every waiting
	// path had a hardcoded ceiling (300s to create, 1800s to export) and no way to shorten
	// it, which is fine for a person watching and useless inside a job with its own budget.
	'timeout',
	'out',
	'team',
	// `db push --dir`: which folder holds the migrations. A value rather than a positional
	// so the command reads the same whether or not it is given.
	'dir',
	// `usage --days`: how much history to ask for.
	'days',
	// `gen types --schema a,b`, comma-separated because a flag holds one value.
	'schema',
	// `gen types --db-url`: a database the control plane has never heard of, which is what
	// makes the emitter useful against a local pod or somebody else's Postgres.
	'db-url',
	// `gen types --data-api-version` (and its 0.2.0 spelling, `--postgrest-version`): accepted
	// and ignored since the generated types stopped carrying an internals block (2026-09-30). A
	// published flag that starts erroring on an upgrade breaks somebody's script for the sake of
	// a word. Drop both at the next major.
	'data-api-version',
	'postgrest-version',
	// `start --port`: where the local database publishes.
	'port',
	// `functions deploy --entrypoint`: which file in the folder the runtime starts, when
	// it is not `index.ts`. A value rather than a convention because a bundle may have its
	// own `index.ts` that is NOT the entrypoint, and guessing there runs the wrong file.
	'entrypoint',
	// `functions size <name> --memory 256 --concurrency 4`: one function's own size within the
	// plan (sql/100). Memory per worker in MB, and how many workers it may run at once.
	'memory',
	'concurrency',
	// `auth google --client-id`, `auth redirects --site-url --allow a,b`.
	'client-id',
	'site-url',
	'allow',
	// `auth template confirmation --subject S --file body.html`.
	'subject',
	// `push credentials set apns --p8 AuthKey.p8 --key-id ID --team-id ID --topic BUNDLE
	// --environment production|sandbox`. The .p8 is a FILE path, never the key on argv.
	'p8',
	'key-id',
	'team-id',
	'topic',
	'environment',
	// `login --email you@x.com`: the account to sign in as. A hint to the provider's chooser,
	// and checked against the account that comes back, so a wrong click is said at once rather
	// than discovered later. Never a password (see below).
	'email',
	// `realtime inspect --channel C`, `realtime logs --channel C --since 10m`.
	'channel',
	'since',
	// `db access grant EMAIL --level full|read`: what a person may do in the database.
	'level',
	// `shards --admin <url>`: a standalone Lepis router's admin API, with no SnoutData account.
	'admin',
	// `shards --token`: that router's admin token. LEPIS_ADMIN_TOKEN is the better home for it
	// (see below on credentials and argv); the flag is for a one-off against a test router.
	'token',
	// `shards nodes add <name> --host H --port P --dbname D --sslmode M --peer-host H2`.
	'host',
	'dbname',
	'sslmode',
	'peer-host',
	// `shards range move <keyspace:lo> --to NODE`, `shards nodes drain <node> --to a,b`.
	'to',
	// `shards keyspace create <name> --key-type bigint --ranges 8 --seed S --nodes a,b`.
	'key-type',
	'ranges',
	'seed',
	'nodes',
	// `shards table distribute <table> --column C --keyspace K`. `--range LO` names a range by
	// its bound when that bound starts with a dash, which as a bare word would read as a flag.
	'column',
	'keyspace',
	'range',
	'node',
	'value',
	// `shards scale --add name=host[:port],... --remove N`.
	'add',
	'remove',
	// `shards settings`, or one operation's own override: the cluster's L10 settings.
	'max-write-pause-ms',
	'drain-timeout-ms',
	'ack-timeout-ms',
	'copy-mb-per-s',
	// `shards settings --set advice_min_bytes=1,...`: any setting by its API name.
	'set',
	// `shards advise --sample-ms N`: how long the advisor measures write rates over.
	'sample-ms'
]);


// Deliberately NOT here, having been accepted and silently ignored until 2026-09-06:
//
//   --password            Nothing has ever read it, and a password on a command line is
//                         readable by every process on the machine through `ps` and lands
//                         in the shell history. Sign in, or use SNOUTDATA_ACCESS_TOKEN.
//                         (`--email` came back in 0.10.2 as `login`'s account hint, which
//                         is not a credential.)
//   --token               Same reason. The env var exists precisely so a credential is not
//                         on argv. (`shards --token` is the one exception, for a Lepis router's
//                         admin token, asked for by name; LEPIS_ADMIN_TOKEN is what to use.)
//   --project             SNOUTDATA_PROJECT and `link` already answer this, and `--ref` is
//                         what every command that takes one actually reads.
//   --output, --limit     Meant something once and never did anything.
//
// They are unknown flags now, which is what the README always claimed they were. A typo in
// a script that quietly does something else is worse than a script that stops.

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const command: string[] = [];
	const flags: Record<string, string | boolean> = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (!arg.startsWith('-')) {
			command.push(arg);
			continue;
		}
		if (arg === '--') {
			// Everything after it is a positional, verbatim. `sql -- --not-a-flag`.
			command.push(...argv.slice(i + 1));
			break;
		}
		const [name, inline] = splitFlag(arg);
		if (VALUED.has(name)) {
			const value = inline ?? argv[++i];
			if (value === undefined) {
				throw new UsageError(`--${name} needs a value`);
			}
			flags[name] = value;
			continue;
		}
		if (inline !== undefined) {
			throw new UsageError(`--${name} does not take a value`);
		}
		if (!KNOWN_BOOLEANS.has(name)) {
			throw new UsageError(`unknown option --${name}`);
		}
		flags[name] = true;
	}

	return { command, flags, json: flags.json === true };
}

const KNOWN_BOOLEANS = new Set([
	'json',
	// `db restore --window`: how far back a point-in-time restore can go, without doing one.
	'window',
	'help',
	'version',
	'force',
	// `functions deploy --no-verify-jwt`: the webhook case, spelled the way functions CLIs
	// usually spell it. It makes the URL callable by
	// anybody who knows it, which is why the deploy prints what it did in words afterwards.
	'no-verify-jwt',
	// `functions size <name> --reset`: back to the plan's default size.
	'reset',
	// `secrets set NAME --stdin`: the value from a pipe rather than from the shell's
	// history and `ps`. What a CI job should use.
	'stdin',
	// `--quiet`: drop the commentary, keep the answer and keep the errors. Wired 2026-09-06;
	// it parsed and did nothing before.
	'quiet',
	// `--yes`: only `shards` reads it. Its operations that move or delete data ask a person
	// first and refuse anything else unless it is passed. Every other command refuses it
	// (main.ts, SHARDS_ONLY), since a yes that confirms nothing would tell a script author it
	// had; the command that needs a confirmation says which flag it wants (`db restore --force`).
	'yes',
	// `shards <operation> --plan`: the dry run, which changes nothing.
	'plan',
	// `db export --status`: look at the last copy without asking for another one. The
	// distinction is worth a flag rather than an inference, because the other branch runs a
	// pg_dump against somebody's production database.
	'status',
	'no-wait',
	// `login --no-browser`: print the URL and wait, rather than trying to spawn anything.
	// The case the loopback flow could never serve on its own: SSH, a container, WSL.
	'no-browser',
	// `login --device`: a code typed into a browser on ANY machine, with no callback to
	// this one at all. --no-browser still needs the loopback redirect to come back here;
	// this does not, which is what makes it work over SSH and inside a container.
	'device',
	// `login --sso`: the company's own identity provider, reached by the DOMAIN of a work
	// email rather than by a provider name. Same loopback and same PKCE exchange as the rest;
	// only the URL the browser is sent to is asked for rather than built.
	'sso',
	'env',
	// `db push`: find out, and change nothing. Its own flag rather than the absence of a
	// --yes, because the safe thing should be the easy thing to type.
	'dry-run',
	// `db push`: run a new migration that sorts BEFORE one already applied. Refused
	// otherwise, because it gives this database a history no fresh one will have.
	'out-of-order',
	// `mcp`: let the agent's delete_project actually delete. Off by default, and the tool
	// is listed either way so the agent can say what it wanted rather than invent.
	'allow-delete',
	// `gen types --local`: read the schema of the pod `snoutdata start` is running, rather than
	// of a hosted project. It is the command the start prints as the next thing to type, and it
	// was refused as an unknown option for as long as it was missing here.
	'local',
	// `start --no-migrations`: bring the database up and apply nothing. Its own flag because
	// the ordinary start APPLIES, so looking at a database without changing it has to be
	// typeable. It was in `start`'s flag list in main.ts, read by main.ts, and covered by a
	// test that calls `runStart` directly, for as long as it was missing here — so the CLI
	// documented a flag it then refused, and no test could see it.
	'no-migrations',
	// `usage`: print the day-by-day table under the headline, which most callers do not
	// want and --json always carries anyway.
	'history',
	// `projects create --show-url`: print the connection string, password and all. Off by
	// default since 0.10.2, because stdout is what lands in transcripts and CI logs.
	'show-url',
	// `upgrade --check`: say whether a newer version exists, and install nothing.
	'check',
	// `realtime inspect --watch`: keep printing what changes.
	'watch'
]);

function splitFlag(arg: string): [string, string | undefined] {
	const bare = arg.replace(/^--?/, '');
	const equals = bare.indexOf('=');
	if (equals === -1) {
		return [bare, undefined];
	}
	return [bare.slice(0, equals), bare.slice(equals + 1)];
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
	const value = args.flags[name];
	return typeof value === 'string' ? value : undefined;
}

export function flagBoolean(args: ParsedArgs, name: string): boolean {
	return args.flags[name] === true;
}

/**
 * A flag that is a whole number, refused here rather than sent as a string.
 *
 * `--expires next-tuesday` should stop the command, not travel to the control plane and
 * come back as a 400 the caller has to interpret. Exit 2 is "the command was wrong".
 */
export function flagNumber(args: ParsedArgs, name: string): number | undefined {
	const value = flagString(args, name);
	if (value === undefined) {
		return undefined;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed)) {
		throw new UsageError(`--${name} must be a whole number, not "${value}"`);
	}
	return parsed;
}
