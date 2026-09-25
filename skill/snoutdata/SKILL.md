---
name: snoutdata
description: Create and manage SnoutData Cloud projects, each a hosted Postgres database with its backend, with the `snoutdata` CLI - a DATABASE_URL for a project, migrations, backups and point-in-time restore, auth, storage and the REST/GraphQL data API, Snout Functions (TypeScript on the edge) with their secrets, custom domains, API keys and usage. Use when the user wants a database, a backend, a DATABASE_URL, hosted auth/storage/functions, or mentions SnoutData.
---

# SnoutData Cloud, through the `snoutdata` CLI

A SnoutData Cloud project is a backend: a Postgres 17 database (with `pgvector`) plus auth, storage, a REST and GraphQL data
API and Snout Functions in front of it. `@snoutdata/client` is the JavaScript client for all of it.
Everything is driven by one CLI. Nothing needs installing: every command below can be run as
`npx snoutdata ...`.

## Rules

- **Always pass `--json`.** It puts exactly one JSON value on stdout; progress goes to stderr. A
  failure is `{"ok":false,"code","error"}` on stdout.
- **Nothing prompts** when stdin is not a terminal. A command that would have to ask exits 2 and
  names the flag it needs (`--force`, `--name`, ...). Unknown flags are errors.
- **Read the exit code**: 0 ok, 2 wrong command (fix it, do not retry), 3 bad or missing credential
  (ask the user for a token), 4 not ready (retry after a delay), 5 forbidden, 6 not found,
  7 conflict, 8 plan allowance used up (tell the user), 9 network, 10 timed out, 127 `psql` missing.
- **A `DATABASE_URL` contains a live password.** Put it in `.env` or an environment variable, never
  in a committed file, a log, or your reply.
- **Never pass a secret on a command line.** Set function secrets from stdin:
  `printf %s "$VALUE" | npx snoutdata secrets set NAME --stdin`.
- Destructive commands (`projects delete`, `keys rotate`, `db restore --file` over data) need the
  user's explicit go-ahead. Ask first.

## Credentials

The CLI uses `SNOUTDATA_ACCESS_TOKEN` if set, otherwise the session `snoutdata login` wrote. For an
agent the token is right: the user makes one once with `npx snoutdata tokens create --name agent`
and gives it to you. With neither, commands exit 3; say so and ask for a token rather than running
`login` yourself (it opens a browser for a person).

Check first: `npx snoutdata whoami --json`.

## The project

A command finds its project from `--ref`, then `SNOUTDATA_PROJECT`, then `.snoutdata/project.json`
in this folder or a parent. `init` writes that file.

## Common tasks

| Task | Command |
| --- | --- |
| A database for this folder, with `DATABASE_URL` in `.env` (idempotent) | `npx snoutdata init --env --json` |
| List projects and their state | `npx snoutdata projects list --json` |
| One project whole (state, products, functions, secret names, domains) | `npx snoutdata projects show --json` |
| Create one explicitly (waits until ready) | `npx snoutdata projects create --name NAME --json` |
| Pause / resume / delete | `npx snoutdata projects pause\|resume\|delete --ref REF --json` |
| Connection string | `npx snoutdata db url --json` |
| Run migrations (a folder of `.sql`, once each) | `npx snoutdata db push --dir migrations --dry-run --json`, then without `--dry-run` |
| Storage and compute against the plan limit (read before a big migration) | `npx snoutdata usage --json` |
| Back up (pg_dump) and download | `npx snoutdata db export --out backup.dump --json` |
| How far back a point-in-time restore can go | `npx snoutdata db restore --window --json` |
| Rewind to a moment, into a NEW project beside it | `npx snoutdata db restore --at 2026-09-20T14:30:00Z --json` |
| Load a dump into a project | `npx snoutdata db restore --file backup.dump --json` |
| Auth, storage, data API: on or off | `npx snoutdata products --json` |
| Turn one on (data API: paid plans) | `npx snoutdata products enable auth\|storage\|data-api --json` |
| Auth settings, and the callback to register with Google | `npx snoutdata auth --json` |
| Sign in with Google (the user's own OAuth client; secret on stdin) | `… \| npx snoutdata auth google --client-id ID --stdin --json` |
| Site URL and allowed redirect addresses | `npx snoutdata auth redirects --site-url URL --allow URL,URL --json` |
| The project's own auth email (HTML must include `{{ .ConfirmationURL }}`) | `npx snoutdata auth template confirmation\|recovery\|magic_link\|invite\|email_change --file body.html --subject S --json` |
| API keys for the client (anon, service_role) | `npx snoutdata keys --json` |
| Deploy a function from `functions/NAME` | `npx snoutdata functions deploy NAME --json` |
| List / delete functions | `npx snoutdata functions list\|delete NAME --json` |
| Function secrets (names only are ever readable) | `npx snoutdata secrets list\|unset NAME --json` |
| Your own domain for the project API (paid plans) | `npx snoutdata domains add api.example.com --json`, publish the printed records, then `domains verify api.example.com` |
| TypeScript types for the schema | `npx snoutdata gen types typescript --out src/database.types.ts` |
| The same Postgres locally, migrated and seeded | `npx snoutdata start` |

The project API is `https://<ref>.api.snoutdata.com` (`/rest/v1`, `/graphql/v1`, `/auth/v1`,
`/storage/v1`, `/functions/v1/<name>`). The `service_role` key bypasses row-level security: keep it
on a server, never in client code.

## As an MCP server

`npx snoutdata mcp` serves the same operations as MCP tools over stdio (`list_projects`,
`create_project`, `get_project`, `get_connection_url`, `set_product`, `usage`, `start_export`,
`restore_to_point`, `deploy_function`, ...). Read-only tools are annotated so a client can run them
without asking. `delete_project` refuses unless the server was started with `--allow-delete`.

## When something is refused

A refusal is a sentence from the control plane: report it to the user in those words instead of
working around it. Common ones: the plan's project limit (exit 8), the data API or custom domains
on a free plan, a production project refusing a pause, a project over its storage limit being
read-only (check `usage`).

## Full reference

Every command, flag and output shape: https://docs.snoutdata.com/cloud/agent.md
