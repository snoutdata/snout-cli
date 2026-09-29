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
	{ name: 'init', summary: 'Create or link a project and write a DATABASE_URL', flags: ['--name', '--region', '--env', '--ref'] },
	{ name: 'login', summary: 'Sign in through a browser, with --sso through your company\'s identity provider, or with --device by typing a code into one anywhere', flags: ['--provider', '--sso', '--domain', '--no-browser', '--device', '--timeout'] },
	{ name: 'logout', summary: 'Forget the stored session', flags: [] },
	{ name: 'whoami', summary: 'Who this credential belongs to', flags: [] },
	{ name: 'tokens list', summary: 'Long-lived access tokens on this account', flags: [] },
	{ name: 'tokens create', summary: 'Mint an sdt_ token for CI or an agent', flags: ['--name', '--expires', '--project'] },
	{ name: 'tokens revoke', summary: 'Revoke one by id or prefix', flags: [] },
	{ name: 'projects list', summary: 'Every project on this account', flags: [] },
	{ name: 'projects create', summary: 'Make a hosted database', flags: ['--name', '--region', '--team', '--no-wait', '--timeout'] },
	{ name: 'projects pause', summary: 'Stop a project', flags: ['--ref'] },
	{ name: 'projects resume', summary: 'Start a paused project', flags: ['--ref'] },
	{ name: 'projects delete', summary: 'Delete a project', flags: ['--ref'] },
	{ name: 'projects show', summary: 'One project: state, products, functions, secrets, domains', flags: ['--ref'] },
	{ name: 'products', summary: 'Auth, storage, the data API and push: on or off', flags: ['--ref'] },
	{ name: 'products enable', summary: 'Turn auth, storage, data-api or push on', flags: ['--ref'] },
	{ name: 'products disable', summary: 'Turn auth, storage, data-api or push off', flags: ['--ref'] },
	{ name: 'push credentials', summary: 'Push keys: what is set for APNs, FCM and Web Push (never the keys)', flags: ['--ref'] },
	{ name: 'push credentials set', summary: 'Set the APNs key (a .p8) or the FCM service account, checked before it is stored', flags: ['--ref', '--p8', '--key-id', '--team-id', '--topic', '--environment', '--file'] },
	{ name: 'push credentials remove', summary: 'Remove the APNs or FCM credentials', flags: ['--ref'] },
	{ name: 'auth', summary: 'Auth settings: Google sign-in and redirect addresses', flags: ['--ref'] },
	{ name: 'auth google', summary: 'Sign in with Google, with your own client (secret on stdin)', flags: ['--ref', '--client-id', '--stdin'] },
	{ name: 'auth redirects', summary: 'The site URL and the addresses a sign-in may return to', flags: ['--ref', '--site-url', '--allow'] },
	{ name: 'auth templates', summary: 'The five auth emails, ours or your own', flags: ['--ref'] },
	{ name: 'auth template', summary: 'Use your own subject and HTML for one, or reset it', flags: ['--ref', '--file', '--subject'] },
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
	{ name: 'db export', summary: 'Take or download a dump', flags: ['--ref', '--out', '--status', '--timeout'] },
	{ name: 'db push', summary: 'Apply migrations from a folder', flags: ['--dir', '--dry-run', '--out-of-order'] },
	{ name: 'db restore', summary: 'Put a dump into a project, or rewind it to a moment into a new project', flags: ['--file', '--force', '--at', '--name', '--window', '--ref'] },
	{ name: 'mcp', summary: 'Serve these operations as tools over stdio', flags: ['--allow-delete'] }
] as const;
