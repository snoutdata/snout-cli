# snoutdata

SnoutData Cloud projects from a terminal, or from an agent: a Postgres database with auth,
storage, realtime and functions. One bundled file with no dependencies, so
`npx snoutdata` is a download rather than an install. Needs Node 20 or newer.

```bash
npx snoutdata init --env
```

An empty folder becomes a folder with a working database: a project is created, the command
waits until it is actually serving, writes `.snoutdata/project.json`, and puts `DATABASE_URL`
in `.env`. It is idempotent, so running it twice gives you the same project, not two.

Driven end to end holding nothing but an access token (no browser, no session, no human) in
21 seconds, with a `DATABASE_URL` that connected on the first try.

---

## For an agent

This CLI is built to be driven by a program. The contract, which every command holds:

| | |
| --- | --- |
| `--json` | Accepted everywhere. **Exactly one JSON value on stdout and nothing else**, so a pipe into `jq` needs no filtering. Progress, warnings and prompts go to stderr. |
| Failures are structured | In `--json` mode a failure is `{"ok":false,"code":"...","error":"..."}` on stdout. Including a bad flag, a bad command, and a bad credential. |
| No prompts | Nothing asks a question when stdin is not a terminal, or under `--json`, or in CI. A command that would have to ask says which flag to pass and exits 2 immediately, rather than blocking on a question nobody will answer. |
| Unknown flags are errors | Never ignored. A typo that quietly does something else is worse than a stop. |
| Typed exit codes | The code says what kind of problem it was, so a caller can decide whether to retry, re-authenticate, or give up. |

### Exit codes

| Code | Meaning | What a caller should do |
| --- | --- | --- |
| `0` | Fine | Continue. |
| `1` | The operation failed | Read the error. |
| `2` | The command was wrong | Fix the call. Do not retry. |
| `3` | The credential is no good | Never signed in, expired, or revoked. The message says which. |
| `4` | Not ready yet | Retry. |
| `5` | Forbidden | Do not retry. |
| `6` | Not found | Do not retry. |
| `7` | Conflict | |
| `8` | Over a quota | The plan's limit. Do not retry. |
| `9` | Network | Retry. |
| `10` | Timed out | Retry, or raise `--timeout`. |
| `127` | A tool this command needs is not installed | The message names it. The shell’s own convention, so a CI log reads right. |

### Credentials, without a browser

```bash
export SNOUTDATA_ACCESS_TOKEN=sdt_...   # made once by a person: snoutdata tokens create
```

`SNOUTDATA_ACCESS_TOKEN` outranks everything and never expires, which is what CI and an agent
should use: a script's behaviour should not depend on who happens to be logged in on the machine
it runs on. Failing that, `~/.snoutdata/auth.json` (written by `snoutdata login`, mode 0600),
whose session lasts an hour.

The token is exchanged for a short-lived session by the control plane, so row-level security is
still the only thing deciding what it can see.

### As an MCP server

```bash
snoutdata mcp
```

Serves the operations below as tools over stdio, so an agent configures one server instead of
being handed a connection string. Anything destructive is off unless you pass `--allow-delete`,
and it is present-but-refusing rather than absent, so an agent can tell you what to turn on
instead of inventing something else.

If the SnoutData desktop app is running on the same machine, its own database tools are borrowed
onto the same endpoint under an `app_` prefix, so one configured server covers both the cloud and
the databases already set up locally. `SNOUTDATA_NO_DESKTOP=1` opts out.

---

## Commands

**Setup**

```bash
snoutdata init [--name X] [--env]     # a database for this folder, linked and ready
snoutdata link --ref R                # point this folder at an existing project
```

**Auth**

```bash
snoutdata login                       # through a browser
snoutdata login --sso                 # your company's identity provider; asks for a work email
snoutdata login --sso --domain acme.com   # or name the domain and skip the question
snoutdata login --device              # print a code to type into a browser anywhere
snoutdata login --no-browser          # print the URL instead of opening one
snoutdata logout
snoutdata whoami
snoutdata tokens create --name ci [--expires DAYS]
snoutdata tokens list
snoutdata tokens revoke <id|sdt_prefix>
```

**Projects**

```bash
snoutdata projects list
snoutdata projects create --name X [--region R] [--no-wait]
snoutdata projects pause|resume|delete [--ref R]
snoutdata usage [--ref R] [--days 30] [--history]
snoutdata teams
```

**Database**

```bash
snoutdata db url [--ref R]                        # a connection string
snoutdata db psql [--ref R] [-- ...]              # opens psql, no password typed
snoutdata db reset-password [--ref R]
snoutdata db export [--ref R] [--out FILE]        # take a dump and download it
snoutdata db push [--dir migrations] [--dry-run]  # run the .sql files, once each
snoutdata db restore --file DUMP [--force]
```

**Types**

```bash
snoutdata gen types typescript [--ref R] [--schema public] [--out FILE]
snoutdata gen types typescript --db-url postgres://...   # any Postgres, ours or not
snoutdata gen types typescript --local                   # the database `snoutdata start` runs
```

Your schema as a TypeScript `Database` type, on stdout. Read out of `pg_catalog`, so an enum
column says `mood` and a generated column is optional on insert.

**Local**

```bash
snoutdata start [--port 54322] [--dir migrations] [--no-migrations]
snoutdata stop                        # the data stays
snoutdata status                      # running, how big, on what port
```

A Postgres on your own machine, the same build as a hosted project, with `migrations/*.sql` and
`seed.sql` applied on the way up, using the same migration ledger `db push` uses, so a folder means
the same thing here and in the cloud. It publishes on 54322 by default; pass `--port` if
something else is already on it.

It needs **Podman** (not Docker, and deliberately with no fallback: a database that works under
Docker and not under Podman is one that works here and not in the cloud). The database image is
fetched from `ghcr.io/snoutdata/snoutpod-postgres` the first time you run it, which takes a few
minutes once and nothing after that. Nothing else in this CLI needs anything installed at all.

**Agents**

```bash
snoutdata mcp [--allow-delete]
```

Every command takes `--json`, `--quiet` and `--help`, and anything that waits takes
`--timeout SECONDS`. `snoutdata --help --json` returns the whole command surface as JSON.

---

## Where things come from

**A project**, in order: `--ref`, then `SNOUTDATA_PROJECT`, then `.snoutdata/project.json` in
this folder or a parent.

**A token**, in order: `SNOUTDATA_ACCESS_TOKEN`, then `~/.snoutdata/auth.json`.

**Sign-in, when there is no credential and a person is present**, in order: the SnoutData
desktop app if it is running here and willing, then a browser, then a pairing code for a
terminal that has no browser at all. With no person present (not a terminal, `--json`, CI, or
`SNOUTDATA_NO_INTERACTIVE`) nothing is asked and it exits 3 at once.

---

## Documentation

- Everything an agent needs, on one page: <https://docs.snoutdata.com/cloud/agent>
- Full CLI reference: <https://docs.snoutdata.com/cloud/cli>
- Getting started: <https://docs.snoutdata.com/cloud/getting-started>
- Plans and limits: <https://docs.snoutdata.com/cloud/limits>

A SnoutData Cloud project costs nothing when idle: its Postgres database pauses when nobody
is using it and wakes on the next connection, while the client waits.

---

© SnoutData. Licensed under the [Elastic License 2.0](./LICENSE). Use of SnoutData Cloud is
subject to <https://snoutdata.com/terms>.
