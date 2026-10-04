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
export const COMMANDS = [
	{ name: 'init', summary: 'Create or link a project for this folder, and print its DATABASE_URL or write it to .env', flags: ['--name', '--region', '--env', '--ref'] },
	{ name: 'login', summary: 'Sign in through a browser, with --sso through your company\'s identity provider, or with --device by typing a code into one anywhere', flags: ['--email', '--provider', '--sso', '--domain', '--no-browser', '--device', '--timeout'] },
	{ name: 'logout', summary: 'Forget the stored session', flags: [] },
	{ name: 'whoami', summary: 'Who this credential belongs to, and whether it is the account login --email asked for', flags: [] },
	{ name: 'upgrade', summary: 'Install the newest CLI the way this one was installed (binary or npm), checksum verified', flags: ['--check'] },
	{ name: 'tokens list', summary: 'Long-lived access tokens on this account', flags: [] },
	{ name: 'tokens create', summary: 'Mint an sdt_ token for CI or an agent', flags: ['--name', '--expires', '--project'] },
	{ name: 'tokens revoke', summary: 'Revoke one by id or prefix', flags: [] },
	{ name: 'projects list', summary: 'Every project on this account', flags: [] },
	{ name: 'projects create', summary: 'Make a hosted database, and print its ref', flags: ['--name', '--region', '--team', '--no-wait', '--timeout', '--show-url'] },
	{ name: 'projects pause', summary: 'Stop a project, and wait until it is paused', flags: ['--ref', '--no-wait', '--timeout'] },
	{ name: 'projects resume', summary: 'Start a paused project, and wait until it is ready', flags: ['--ref', '--no-wait', '--timeout'] },
	{ name: 'projects delete', summary: 'Delete a project, and wait until it is gone', flags: ['--ref', '--no-wait', '--timeout'] },
	{ name: 'projects show', summary: 'One project: state, products (Realtime included), functions, secrets, domains', flags: ['--ref'] },
	{ name: 'products', summary: 'Auth, storage, the data API and push: on or off. Realtime is always on, and listed', flags: ['--ref'] },
	{ name: 'products enable', summary: 'Turn auth, storage, data-api or push on', flags: ['--ref'] },
	{ name: 'products disable', summary: 'Turn auth, storage, data-api or push off', flags: ['--ref'] },
	{ name: 'push credentials', summary: 'Push keys: what is set for APNs, FCM and Web Push (never the keys)', flags: ['--ref'] },
	{ name: 'push credentials set', summary: 'Set the APNs key (a .p8) or the FCM service account, checked before it is stored', flags: ['--ref', '--p8', '--key-id', '--team-id', '--topic', '--environment', '--file'] },
	{ name: 'push credentials remove', summary: 'Remove the APNs or FCM credentials', flags: ['--ref'] },
	{ name: 'auth', summary: 'Auth settings: Google sign-in and redirect addresses', flags: ['--ref'] },
	{ name: 'auth google', summary: 'Sign in with Google, with your own client (secret on stdin)', flags: ['--ref', '--client-id', '--stdin'] },
	{ name: 'auth anonymous', summary: 'Guest sign-in on or off: signInAnonymously() gives a browser a session with no email or password', flags: ['--ref'] },
	{ name: 'auth redirects', summary: 'The site URL and the addresses a sign-in may return to', flags: ['--ref', '--site-url', '--allow'] },
	{ name: 'auth templates', summary: 'The five auth emails, ours or your own', flags: ['--ref'] },
	{ name: 'auth template', summary: 'Use your own subject and HTML for one, or reset it', flags: ['--ref', '--file', '--subject'] },
	{ name: 'realtime inspect', summary: 'The channels open now: each client, its presence, when it was last heard, and the last minute of messages', flags: ['--channel', '--watch', '--ref'] },
	{ name: 'realtime logs', summary: 'The connection log: connects, joins, leaves and disconnects, with the reason each ended', flags: ['--since', '--channel', '--ref'] },
	{ name: 'domains', summary: 'Your own domains in front of the project API', flags: ['--ref'] },
	{ name: 'domains add', summary: 'Add one, and print the DNS records to publish', flags: ['--ref'] },
	{ name: 'domains verify', summary: 'Check its records and verify it', flags: ['--ref'] },
	{ name: 'domains remove', summary: 'Stop serving it', flags: ['--ref'] },
	{ name: 'functions deploy', summary: 'Put a folder of TypeScript on the edge', flags: ['--ref', '--dir', '--entrypoint', '--no-verify-jwt'] },
	{ name: 'functions list', summary: 'What this project has deployed', flags: ['--ref'] },
	{ name: 'functions size', summary: 'Its memory and workers, within the plan', flags: ['--ref', '--memory', '--concurrency', '--reset'] },
	{ name: 'functions delete', summary: 'Remove one', flags: ['--ref'] },
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
	'--project': 'Limit the token to one project ref',
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
	'--level': "full (everything the project password can do) or read (reads the project's own tables, never the auth or storage schemas, and writes nothing). Default read"
};

export function flagHelp(command: string, flag: string): string {
	return FLAG_HELP[`${command} ${flag}`] ?? FLAG_HELP[flag] ?? '';
}
