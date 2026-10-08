/**
 * Every command and the flags it documents: the command surface, as data.
 *
 * `--help --json` returns this. A person reads `USAGE` in `main.ts`; an agent meeting this CLI
 * for the first time should not have to parse prose to find out that `db push` exists.
 *
 * Its own module because `main.ts` runs the CLI on import (`void main()`), so a test that wants
 * to compare this list against the parser could not reach it there. Which is exactly how two
 * documented flags came to be refused: nothing could compare the two lists. See `flags.test.ts`.
 */
// `shards`: every command reaches a router the same way, and every operation runs the same way.
const SHARDS = ['--admin', '--token', '--project'] as const;
const SHARDS_SETTINGS = ['--max-write-pause-ms', '--drain-timeout-ms', '--ack-timeout-ms', '--copy-mb-per-s'] as const;
const SHARDS_RUN = [...SHARDS, '--plan', '--no-wait', '--timeout', ...SHARDS_SETTINGS] as const;
const SHARDS_MOVES = [...SHARDS_RUN, '--yes'] as const;

export const COMMANDS = [
	{ name: 'init', summary: 'Create or link a project for this folder, and print its DATABASE_URL or write it to .env', flags: ['--name', '--region', '--env', '--ref'] },
	{ name: 'login', summary: 'Sign in through a browser, with --sso through your company\'s identity provider, or with --device by typing a code into one anywhere', flags: ['--email', '--provider', '--sso', '--domain', '--no-browser', '--device', '--timeout'] },
	{ name: 'logout', summary: 'Forget the stored session', flags: [] },
	{ name: 'whoami', summary: 'Who this credential belongs to, and whether it is the account login --email asked for', flags: [] },
	{ name: 'upgrade', summary: 'Install the newest CLI the way this one was installed (binary or npm), checksum verified', flags: ['--check'] },
	{ name: 'tokens list', summary: 'Long-lived access tokens on this account', flags: [] },
	{ name: 'tokens create', summary: 'Mint an sdt_ token for CI or an agent', flags: ['--name', '--expires', '--project'] },
	{ name: 'tokens revoke', args: '<id|sdt_prefix>', summary: 'Revoke one by id or prefix', flags: [] },
	{ name: 'projects list', summary: 'Every project on this account', flags: [] },
	{ name: 'projects create', summary: 'Make a hosted database, and print its ref', flags: ['--name', '--region', '--team', '--no-wait', '--timeout', '--show-url'] },
	{ name: 'projects pause', summary: 'Stop a project, and wait until it is paused', flags: ['--ref', '--no-wait', '--timeout'] },
	{ name: 'projects resume', summary: 'Start a paused project, and wait until it is ready', flags: ['--ref', '--no-wait', '--timeout'] },
	{ name: 'projects delete', summary: 'Delete a project, and wait until it is gone', flags: ['--ref', '--no-wait', '--timeout'] },
	{ name: 'projects show', summary: 'One project: state, products (Realtime included), functions, secrets, domains', flags: ['--ref'] },
	{ name: 'products', summary: 'Auth, storage, the data API and push: on or off. Realtime is always on, and listed', flags: ['--ref'] },
	{ name: 'products enable', args: 'auth|storage|data-api|push', summary: 'Turn auth, storage, data-api or push on', flags: ['--ref'] },
	{ name: 'products disable', args: 'auth|storage|data-api|push', summary: 'Turn auth, storage, data-api or push off', flags: ['--ref'] },
	{ name: 'push credentials', summary: 'Push keys: what is set for APNs, FCM and Web Push (never the keys)', flags: ['--ref'] },
	{ name: 'push credentials set', args: 'apns|fcm', summary: 'Set the APNs key (a .p8) or the FCM service account, checked before it is stored', flags: ['--ref', '--p8', '--key-id', '--team-id', '--topic', '--environment', '--file'] },
	{ name: 'push credentials remove', args: 'apns|fcm', summary: 'Remove the APNs or FCM credentials', flags: ['--ref'] },
	{ name: 'auth', summary: 'Auth settings: Google sign-in and redirect addresses', flags: ['--ref'] },
	{ name: 'auth google', summary: 'Sign in with Google, with your own client (secret on stdin)', flags: ['--ref', '--client-id', '--stdin'] },
	{ name: 'auth anonymous', args: 'on|off', summary: 'Guest sign-in on or off: signInAnonymously() gives a browser a session with no email or password', flags: ['--ref'] },
	{ name: 'auth redirects', summary: 'The site URL and the addresses a sign-in may return to', flags: ['--ref', '--site-url', '--allow'] },
	{ name: 'auth templates', summary: 'The five auth emails, ours or your own', flags: ['--ref'] },
	{ name: 'auth template', args: 'KIND', summary: 'Use your own subject and HTML for one, or reset it', flags: ['--ref', '--file', '--subject'] },
	{ name: 'realtime inspect', summary: 'The channels open now: each client, its presence, when it was last heard, and the last minute of messages', flags: ['--channel', '--watch', '--ref'] },
	{ name: 'realtime logs', summary: 'The connection log: connects, joins, leaves and disconnects, with the reason each ended', flags: ['--since', '--channel', '--ref'] },
	{ name: 'domains', summary: 'Your own domains in front of the project API', flags: ['--ref'] },
	{ name: 'domains add', args: '<hostname>', summary: 'Add one, and print the DNS records to publish', flags: ['--ref'] },
	{ name: 'domains verify', args: '<hostname>', summary: 'Check its records and verify it', flags: ['--ref'] },
	{ name: 'domains remove', args: '<hostname>', summary: 'Stop serving it', flags: ['--ref'] },
	{ name: 'functions deploy', args: '<name>', summary: 'Put a folder of TypeScript on the edge', flags: ['--ref', '--dir', '--entrypoint', '--no-verify-jwt'] },
	{ name: 'functions list', summary: 'What this project has deployed', flags: ['--ref'] },
	{ name: 'functions size', args: '<name>', summary: 'Its memory and workers, within the plan', flags: ['--ref', '--memory', '--concurrency', '--reset'] },
	{ name: 'functions delete', args: '<name>', summary: 'Remove one', flags: ['--ref'] },
	{ name: 'secrets set', summary: 'Set the environment functions run with', flags: ['--ref', '--stdin'] },
	{ name: 'secrets list', summary: 'The names, never the values', flags: ['--ref'] },
	{ name: 'secrets unset', summary: 'Remove one', flags: ['--ref'] },
	{ name: 'keys', summary: 'The anon and service_role API keys for a project', flags: ['--ref'] },
	{ name: 'keys rotate', summary: 'New keys, breaking every one already issued', flags: ['--ref', '--force'] },
	{ name: 'teams', summary: 'Teams this account belongs to', flags: [] },
	{ name: 'link', summary: 'Point this folder at a project', flags: ['--ref'] },
	{ name: 'usage', summary: 'Size and compute against the plan limit', flags: ['--ref', '--days', '--history'] },
	{ name: 'start', summary: 'A Postgres on this machine, with your migrations applied', flags: ['--port', '--dir', '--no-migrations', '--out-of-order'] },
	{ name: 'stop', summary: 'Stop the local database. The data stays', flags: [] },
	{ name: 'status', summary: 'What the local database is doing', flags: [] },
	{ name: 'gen types typescript', summary: 'The schema as a TypeScript Database type, on stdout', flags: ['--ref', '--db-url', '--local', '--schema', '--out'] },
	{ name: 'db url', summary: 'A connection string', flags: ['--ref'] },
	{ name: 'db psql', summary: 'Open psql, or run statements after --', flags: ['--ref'] },
	{ name: 'db reset-password', summary: 'Rotate the project password', flags: ['--ref'] },
	{ name: 'db access', summary: 'Who signs in to the database as themselves with OAuth (Postgres 18), at which level, as which role', flags: ['--ref'] },
	{ name: 'db access grant', summary: 'Let a person sign in to the database as themselves, and print their connection string', flags: ['--ref', '--level'] },
	{ name: 'db access revoke', summary: 'Take it away, by email or role; a token already issued can work until it expires (up to 1 hour)', flags: ['--ref'] },
	{ name: 'db export', summary: 'Take or download a dump', flags: ['--ref', '--out', '--status', '--timeout'] },
	{ name: 'db push', summary: 'Apply migrations from a folder', flags: ['--dir', '--dry-run', '--out-of-order'] },
	{ name: 'db restore', summary: 'Put a dump into a project, or rewind it to a moment into a new project', flags: ['--file', '--force', '--at', '--name', '--window', '--ref'] },
	{ name: 'shards status', summary: 'A Lepis cluster: its nodes, keyspaces and their ranges (keyspace:lo), tables, routers and unfinished jobs', flags: [...SHARDS] },
	{ name: 'shards ops', summary: 'The operations the router offers, and its default settings', flags: [...SHARDS] },
	{ name: 'shards nodes', summary: 'The nodes, their state and how many ranges each owns', flags: [...SHARDS] },
	{ name: 'shards enable', summary: 'SnoutData Cloud: turn sharding on for a project. The router joins its pod, which restarts the database once. Each node then uses one of the plan project slots', flags: ['--project', '--plan', '--yes'] },
	{ name: 'shards nodes attach', summary: 'SnoutData Cloud: hand a ready node pod (nodes add made it) to the cluster, as a standby until a range moves onto it', flags: [...SHARDS_RUN] },
	{ name: 'shards nodes add', summary: 'Join a Postgres node: checks its version and settings, syncs roles and reference tables. In SnoutData Cloud it makes a node pod, which uses one of the plan project slots', flags: [...SHARDS_RUN, '--host', '--port', '--dbname', '--sslmode', '--peer-host'] },
	{ name: 'shards nodes drain', summary: 'Move every range off a node', flags: [...SHARDS_MOVES, '--to'] },
	{ name: 'shards nodes remove', summary: 'Detach a drained node', flags: [...SHARDS_MOVES] },
	{ name: 'shards keyspace create', summary: 'A keyspace: the shard key type and its initial ranges', flags: [...SHARDS_RUN, '--key-type', '--ranges', '--seed', '--nodes'] },
	{ name: 'shards table distribute', summary: 'Shard a table by a column, moving its rows out from the home node', flags: [...SHARDS_MOVES, '--column', '--keyspace'] },
	{ name: 'shards table reference', summary: 'Copy a table to every node', flags: [...SHARDS_MOVES] },
	{ name: 'shards table global', summary: 'Bring a table back to the home node alone', flags: [...SHARDS_MOVES] },
	{ name: 'shards range split', summary: 'One range becomes two, and one half moves', flags: [...SHARDS_MOVES, '--keyspace', '--range', '--at', '--to'] },
	{ name: 'shards range merge', summary: 'Two adjacent ranges become one', flags: [...SHARDS_MOVES] },
	{ name: 'shards range move', summary: 'Give a range to another node', flags: [...SHARDS_MOVES, '--keyspace', '--range', '--to'] },
	{ name: 'shards tenant pin', summary: 'One key value gets its own range, and optionally its own node', flags: [...SHARDS_MOVES, '--keyspace', '--value', '--node'] },
	{ name: 'shards rebalance', summary: 'Even out the ranges across the nodes', flags: [...SHARDS_MOVES, '--keyspace'] },
	{ name: 'shards scale', summary: 'Add nodes and rebalance, or drain and remove the emptiest', flags: [...SHARDS_MOVES, '--add', '--remove', '--nodes', '--dbname', '--sslmode'] },
	{ name: 'shards verify', summary: 'Row counts and a checksum per range, source against target', flags: [...SHARDS_RUN, '--keyspace'] },
	{ name: 'shards cleanup', summary: 'Delete the rows a node no longer owns, then VACUUM', flags: [...SHARDS_MOVES, '--node'] },
	{ name: 'shards plan', summary: 'The dry run of any operation above: steps, what moves, rows, size, copy time, expected pause', flags: [...SHARDS, ...SHARDS_SETTINGS] },
	{ name: 'shards jobs', summary: 'The latest jobs', flags: [...SHARDS] },
	{ name: 'shards jobs show', summary: 'One job, its plan and its steps', flags: [...SHARDS] },
	{ name: 'shards jobs watch', summary: 'Follow a job until it finishes: exit 0 done, 1 failed or cancelled, 10 timed out', flags: [...SHARDS, '--timeout'] },
	{ name: 'shards jobs cancel', summary: 'Stop a job: a move before its cutover rolls back, after it finishes its cleanup', flags: [...SHARDS, '--yes'] },
	{ name: 'shards jobs resume', summary: 'Run a failed job again from the step that failed, and follow it', flags: [...SHARDS, '--no-wait', '--timeout'] },
	{ name: 'shards settings', summary: 'The cluster\'s cutover and advisor settings, or set them', flags: [...SHARDS, ...SHARDS_SETTINGS, '--set'] },
	{ name: 'shards advise', summary: 'What to split, move or add, from the router\'s advisor: each recommendation with its reason, its plan and the command that runs it. Runs nothing', flags: [...SHARDS, '--sample-ms'] },
	{ name: 'mcp', summary: 'Serve these operations as tools over stdio', flags: ['--allow-delete'] }
] as const;

/**
 * What each flag does, in one line. `<command> --help` prints it under the flag, and
 * `--help --json` carries it as `flagHelp`.
 *
 * Keyed by flag, with a `command --flag` key where one command means something different by
 * it. `flags.test.ts` fails on a documented flag with no line here, so the help cannot go back
 * to being a list of bare names.
 */
const FLAG_HELP: Record<string, string> = {
	'--ref': 'The project. Defaults to SNOUTDATA_PROJECT, then .snoutdata/project.json here or in a parent',
	'--name': 'The project\'s name',
	'tokens create --name': 'What the token is for and where it lives, shown in tokens list',
	'db restore --name': 'The name of the new project the restore makes',
	'--region': 'Where the project runs. Defaults to the nearest',
	'--env': 'Write DATABASE_URL into .env in this folder, and add .env to .gitignore since it holds the password. Without it the URL is printed',
	'--email': 'The account to sign in as. The browser offers it, and a different account is reported at once and by whoami',
	'--provider': 'google (the default) or github',
	'--sso': 'Sign in with your company\'s identity provider',
	'--domain': 'With --sso: your work email or company domain. Only the domain is sent',
	'--no-browser': 'Print the sign-in URL instead of opening a browser',
	'--device': 'Sign in by typing a code into a browser on any machine: SSH, containers, agents',
	'--timeout': 'Seconds to wait before giving up',
	'--check': 'Say whether a newer version exists, and install nothing',
	'--expires': 'Days until the token stops working. Without it, it works until revoked',
	'--project': 'A SnoutData Cloud project ref: its cluster, through the control plane, as you (instead of --admin)',
	'tokens create --project': 'Limit the token to one project ref',
	'--team': 'Create it in a team (name or id), shared with its members',
	'--no-wait': 'Return as soon as it is asked for, without waiting for it to be true',
	'--show-url': 'Also print the connection string, which holds the password. Otherwise db url prints it when wanted',
	'--p8': 'The APNs .p8 key file (a path, never the key itself)',
	'--key-id': 'The APNs key id',
	'--team-id': 'Your Apple developer team id',
	'--topic': 'The app\'s bundle id',
	'--environment': 'production or sandbox',
	'--file': 'A file to read',
	'push credentials set --file': 'The FCM service-account JSON',
	'auth template --file': 'The email\'s HTML body',
	'db restore --file': 'The dump to restore (from db export or pg_dump -Fc)',
	'--client-id': 'Your Google OAuth client id; the secret is read from stdin with --stdin',
	'--stdin': 'Read the secret value from a pipe, so it is not in shell history',
	'--site-url': 'Where sign-in emails send people by default',
	'--allow': 'Comma-separated addresses a sign-in may return to',
	'--subject': 'The email\'s subject line',
	'--dir': 'The folder to read from',
	'db push --dir': 'The migrations folder (default ./migrations)',
	'start --dir': 'The migrations folder (default ./migrations)',
	'functions deploy --dir': 'The function\'s folder (default ./functions/<name>)',
	'--entrypoint': 'The file the runtime starts, when it is not index.ts',
	'--no-verify-jwt': 'Let anybody with the URL call it (webhooks). By default a caller needs a project key or a user session',
	'--memory': 'Memory per worker, in MB, within the plan',
	'--concurrency': 'How many workers it may run at once, within the plan',
	'--reset': 'Back to the plan\'s default size',
	'--force': 'Do it although it cannot be undone',
	'--days': 'How many days of history',
	'--history': 'Print the day-by-day table too',
	'--port': 'The port the local database listens on (default 54322)',
	'--no-migrations': 'Start the database and apply nothing',
	'--out-of-order': 'Apply a new migration that sorts before one already applied',
	'--db-url': 'Read a postgres:// database instead of a project',
	'--local': 'Read the database snoutdata start is running',
	'--schema': 'Comma-separated schemas (default public)',
	'--out': 'Write to this file instead of stdout',
	'db export --out': 'Where to save the dump',
	'--status': 'Show the last export without taking another',
	'--dry-run': 'Show what would run, and change nothing',
	'--at': 'The moment to restore to (an ISO time), into a NEW project',
	'--window': 'How far back a point-in-time restore can go',
	'--allow-delete': 'Let the agent\'s delete_project actually delete',
	'--channel': 'Only this channel',
	'--since': 'How far back, like 10m, 2h or 1d (default 1h)',
	'--watch': 'Keep printing what changes until interrupted',
	'--admin': 'The Lepis router\'s admin API, like http://127.0.0.1:7432 (LEPIS_ADMIN_ADDR). https for any other machine; NODE_EXTRA_CA_CERTS for a private CA. Defaults to LEPIS_ADMIN_URL',
	'--token': 'The router\'s admin token. Prefer LEPIS_ADMIN_TOKEN, which keeps it out of shell history and ps',
	'--plan': 'Show the plan (steps, what moves, rows, size, copy time, expected pause) and change nothing',
	'--yes': 'Run it without asking. Without a terminal to ask at, an operation that moves or deletes data needs it',
	'shards jobs cancel --yes': 'Cancel without asking',
	'shards nodes add --port': 'The node\'s port (default 5432)',
	'--host': 'The address the router reaches the node at',
	'--dbname': 'The database on the node (default postgres)',
	'--sslmode': 'disable, require or verify-full (the default)',
	'--peer-host': 'The address the other nodes reach it at, when it differs from the router\'s',
	'--to': 'The node (id or name) that receives it',
	'shards nodes drain --to': 'Comma-separated nodes to move its ranges to. Default: the least loaded',
	'--key-type': 'The shard key\'s Postgres type: bigint, int, text, uuid, ...',
	'--ranges': 'How many equal ranges to start with',
	'--seed': 'The hash seed',
	'--nodes': 'Comma-separated nodes (ids or names) to place the ranges on',
	'--column': 'The shard key column',
	'--keyspace': 'The keyspace',
	'--range': 'The range\'s lower bound, with --keyspace: the spelling for a bound that starts with a dash',
	'shards range split --at': 'Where to split (a hash value). Default: the middle',
	'--node': 'A node, by id or name',
	'shards cleanup --node': 'Only this node. Default: every node',
	'--value': 'The key value to pin',
	'--add': 'Comma-separated nodes to add, each name=host[:port]',
	'--remove': 'How many of the emptiest nodes to drain and remove',
	'shards scale --nodes': 'SnoutData Cloud: how many nodes the project should have, the home included',
	'--max-write-pause-ms': 'The longest a cutover may pause writes; one that would take longer is postponed',
	'--drain-timeout-ms': 'How long a cutover waits for open transactions to finish',
	'--set': 'Settings by their API names, name=value,... (the advisor\'s advice_* thresholds among them)',
	'--sample-ms': 'How long to measure write rates over, in ms (default: the advice_sample_ms setting; 0 skips them)',
	'--ack-timeout-ms':'How long a cutover waits for every router to acknowledge it',
	'--copy-mb-per-s': 'The copy rate a plan estimates with (chosen, not measured)',
	'--level': "full (everything the project password can do) or read (reads the project's own tables, never the auth or storage schemas, and writes nothing). Default read"
};

export function flagHelp(command: string, flag: string): string {
	return FLAG_HELP[`${command} ${flag}`] ?? FLAG_HELP[flag] ?? '';
}

/**
 * The commands `<group> [action] --help` is about. With an action that names a command (or a
 * group of them), only those: `auth anonymous --help` printed all of `auth` and never showed
 * that `anonymous` takes on or off (2026-10-06). An action that names nothing, such as a
 * hostname, falls back to the whole group.
 */
export function commandsFor(group: string, action?: string): (typeof COMMANDS)[number][] {
	const inGroup = COMMANDS.filter((one) => one.name === group || one.name.startsWith(`${group} `));
	if (!action) {
		return inGroup;
	}
	const named = `${group} ${action}`;
	const narrowed = inGroup.filter((one) => one.name === named || one.name.startsWith(`${named} `));
	return narrowed.length > 0 ? narrowed : inGroup;
}
