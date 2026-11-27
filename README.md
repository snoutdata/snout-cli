# snoutdata

Part of [snoutdata/snoutdata](https://github.com/snoutdata/snoutdata), where the docs and examples live.

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
| `11` | This CLI is out of date | `snoutdata upgrade`, then retry. The message names the version required. |
| `12` | The region is full right now, and nothing was created (`no-capacity`) | Do not retry in a loop. We have been told; try again later, not in a minute. |
| `127` | A tool this command needs is not installed | The message names it. The shell’s own convention, so a CI log reads right. |

### Credentials, without a browser

```bash
export SNOUTDATA_ACCESS_TOKEN=sdt_...   # made once by a person: snoutdata tokens create
```

`SNOUTDATA_ACCESS_TOKEN` outranks everything and does not expire unless it was made with
`--expires`. Made with `--project REF`, it reaches that one project and nothing else. It is what
CI and an agent
should use: a script's behaviour should not depend on who happens to be logged in on the machine
it runs on. Failing that, the profile's session: `~/.snoutdata/auth.json` (written by
`snoutdata login`, mode 0600), or `~/.snoutdata/auth.NAME.json` for a named profile, whose session
renews itself as it is used.

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

If SnoutData Studio is running on the same machine, its own database tools are borrowed
onto the same endpoint under an `app_` prefix, so one configured server covers both the cloud and
the databases already set up locally. `SNOUTDATA_NO_DESKTOP=1` opts out.

---

## Commands

**Setup**

```bash
snoutdata init [--name X] [--env]     # a database for this folder, linked and ready
snoutdata link --ref R                # point this folder at an existing project
snoutdata link --local [NAME|FOLDER]  # use a local project (Studio's, or a snout-stack folder) here
snoutdata upgrade [--check]           # the newest CLI, installed the way this one was, checksum verified
```

**Auth**

```bash
snoutdata login                       # a sign-in page: Google, GitHub or your work email
snoutdata login --provider github     # straight to one provider
snoutdata login --sso                 # your company's identity provider; asks for a work email
snoutdata login --sso --domain acme.com   # or name the domain and skip the question
snoutdata login --email you@x.com     # sign in as that account; a different one is reported at once
snoutdata login --device              # print a code to type into a browser anywhere
snoutdata login --no-browser          # print the URL instead of opening one
snoutdata login --profile acme        # a second account, kept beside the first
snoutdata logout [--all]              # this profile, or every one
snoutdata whoami [--all]              # --all: every profile signed in here
snoutdata profile                     # which profile a command would sign in as, and why
snoutdata profile use <name>          # make a signed-in profile this machine's default; `default` goes back
snoutdata tokens create --name ci [--expires DAYS] [--project REF]
snoutdata tokens list
snoutdata tokens revoke <id|sdt_prefix>
```

**Projects**

```bash
snoutdata projects list
snoutdata projects create --name X [--region R] [--no-wait]
snoutdata projects create --name X --servers dedicated --size S [--max-size M] [--team T]
snoutdata projects create --name X --show-url     # also print the connection string (it holds the password)
snoutdata projects show [--ref R]                 # state, products, functions, secrets, domains
snoutdata projects pause|resume|delete [--ref R]
snoutdata projects scale [REF] --instances N [--yes]   # 1 to 3 API instances; shows the plan and asks first
snoutdata usage [--ref R] [--days 30] [--history]
snoutdata usage --tables [--limit 20]             # and the largest tables
snoutdata metrics [--ref R] [--node REF] [--window hour|day|week]
snoutdata teams                                   # teams you can share a project with
```

`projects scale` without `--instances` says what your plan allows.

**Products**

```bash
snoutdata products [--ref R]                      # auth, storage, the data API and push: on or off
snoutdata products enable|disable auth|storage|data-api|push|realtime [--ref R]
snoutdata keys [--ref R]                          # the app key and the server key
snoutdata keys rotate --force [--ref R]           # new keys, breaking every one already issued
snoutdata domains [--ref R]                       # your own domains in front of the project's API
snoutdata domains add <hostname>                  # prints the DNS records to publish
snoutdata domains verify|remove <hostname>
```

Realtime starts off, like the others. On: signals and the roster on every plan, table changes on Plus, Pro and Business. Off keeps the publication and its tables.

**Auth settings**

```bash
snoutdata auth [--ref R]                          # Google sign-in and redirect addresses
... | snoutdata auth google --client-id ID --stdin   # your own Google client; the secret on stdin
snoutdata auth google off
snoutdata auth anonymous on|off                   # guest sign-in: guestSignIn(), no email or password
snoutdata auth redirects --site-url URL --allow URL,URL
snoutdata auth templates                          # the five auth emails, ours or yours
snoutdata auth template KIND --file body.html [--subject S]
snoutdata auth template KIND reset
```

**Push notifications**

```bash
snoutdata push credentials [--ref R]              # what is set for APNs, FCM and Web Push (never the keys)
snoutdata push credentials set apns --p8 FILE --key-id ID --team-id ID --topic BUNDLE [--environment E]
snoutdata push credentials set fcm --file service-account.json
snoutdata push credentials remove apns|fcm
```

Credentials are checked before they are stored.

**Realtime**

```bash
snoutdata realtime inspect [--channel C] [--watch]   # channels open now: each client, its roster entry, the last minute of messages
snoutdata realtime logs [--since 10m] [--channel C]  # connects, joins, leaves and disconnects, with why each ended
```

**Functions, containers and secrets**

```bash
snoutdata functions deploy <name> [--dir D] [--entrypoint F] [--no-verify-jwt]   # from functions/<name>, onto the edge
snoutdata functions list
snoutdata functions size <name> [--memory MB] [--concurrency N] [--reset]       # within the plan
snoutdata functions logs [name] [--errors] [--tail N] [--follow]                # the last seven days
snoutdata functions delete <name>

snoutdata containers deploy <name> <image> [--port 8080] [--registry-user U --stdin] [--no-wait]
snoutdata containers deploy <name> --dockerfile <dir>   # built with your own Docker
snoutdata containers list                               # status, image and URL of each
snoutdata containers logs [name] [--errors] [--tail N] [--follow]
snoutdata containers restart|delete <name>
snoutdata containers egress                             # where containers may send (default: the internet)
snoutdata containers egress set <host[:port,...]|ip[/n][:port,...]> ...
snoutdata containers egress set --none                  # nothing outside the project
snoutdata containers egress clear                       # the public internet again

snoutdata secrets set NAME=value [...]                  # the environment functions and containers run with
snoutdata secrets set NAME --stdin                      # the value from a pipe, not from shell history
snoutdata secrets list                                  # names and sizes, never the values
snoutdata secrets unset NAME
```

A container runs all the time, pinned to the digest its tag points at when it is deployed.
`--clear-registry` forgets stored registry credentials.

**AI gateway**

```bash
snoutdata ai [--ref R]                    # on or off, its models, budgets and the last 30 days' spend
snoutdata ai enable|disable               # enabling restarts the database once; disabling keeps its config
snoutdata ai models
... | snoutdata ai models add [NAME] --source openai --model gpt-4o-mini --stdin
snoutdata ai models remove <name>
snoutdata ai providers [remove <name>]    # where models run, and whether each key is stored
snoutdata ai routes                       # one name for several models, tried in turn
snoutdata ai routes set <name> --models a,b [--sort price]
snoutdata ai routes remove <name>
snoutdata ai keys                         # keys a server calls the gateway with
snoutdata ai keys create --name N [--models a,b] [--expires DAYS]   # shown once
snoutdata ai keys revoke <id>
snoutdata ai budgets
snoutdata ai budgets set project|users --amount 5 [--period day|month] [--soft]
snoutdata ai budgets remove <id>
snoutdata ai usage [--by model|day|key|user|provider] [--days 30]
snoutdata ai test [--model M] [--prompt TEXT]   # one call, with a key made for it and revoked after
```

`ai models add` takes the provider's key on stdin and proves it with the provider before storing
it. Without `--model`, it prints the steps to find the key and the model's id. A call from a
browser needs both a project budget and a users budget, and both must be hard.

**Alerts**

```bash
snoutdata alerts hooks [--ref R]          # where alerts go besides the owner's email
snoutdata alerts hooks add <url> [--slack]   # an https:// webhook (signed; secret printed once), or Slack
snoutdata alerts hooks remove|test <id>
```

**Database**

```bash
snoutdata db url [--ref R]                        # a connection string
snoutdata db psql [--ref R] [-- ...]              # opens psql, no password typed
snoutdata db query "SQL" [--ref R]                # run SQL, no psql needed; rows as a table
snoutdata db run FILE.sql [--ref R]               # a file in one transaction, no psql needed
snoutdata db slow [--limit 10]                    # the statements that took the most time
snoutdata db reset-password [--grace 60]          # new password, other owner login; old one works 60 min
snoutdata db access [--ref R]                     # who signs in as themselves (Postgres 18+)
snoutdata db access grant EMAIL [--level full|read]   # prints their connection string
snoutdata db access revoke EMAIL|ROLE
snoutdata db token [--ref R]                      # a password for user snout_token: you, for an hour
snoutdata db pool [transaction|session]           # connections through the pool, or each its own
snoutdata db allow [list]                         # the addresses that may connect (empty: every address)
snoutdata db allow add CIDR [--note TEXT]         # such as 203.0.113.0/24; at most 50 entries
snoutdata db allow remove CIDR
snoutdata db allow clear                          # let every address in again
snoutdata db export [--ref R] [--out FILE]        # take a dump and download it
snoutdata db export --status                      # what the last export is doing
snoutdata db push [--dir migrations] [--dry-run]  # run the .sql files, once each
snoutdata db restore --file DUMP [--force]
snoutdata db restore --window                     # how far back a point-in-time restore can go
snoutdata db restore --at TIME [--name N]         # that moment, into a NEW project beside this one
```

`db push`, `db query`, `db run` and `db slow` need nothing installed: they connect to the database
themselves and send SQL a statement at a time, cut where `psql` would cut it. A file holding a
`psql` command (`\i`, `\set`) is refused before anything runs. `db run`, and a `db query` with
several statements, runs them in one transaction: the first that fails rolls it all back and the
error names it. `db psql`, `db restore` and `gen types` use the Postgres client tools.

`db psql`, `db push`, `db query`, `db run`, `db restore` and `gen types` verify the database's certificate
(`sslmode=verify-full`, against Node's trusted roots). `SNOUTDATA_DB_SSLMODE=require` turns the
check off, for a network that re-signs Postgres traffic.

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

*Why not Docker?* The hosted database runs under Podman, rootless, so a local one that only worked
under Docker could pass here and fail once deployed (file ownership and user mapping are where the
two differ). Podman runs on Windows, macOS and Linux, and installs alongside Docker Desktop.

**Clusters**

A Lepis cluster is Postgres spread over several nodes. You reach it through its router's admin API
(`--admin URL`, with the token from `LEPIS_ADMIN_TOKEN`), or, for a SnoutData Cloud project, with
`--project REF`.

```bash
snoutdata cluster --project REF enable [--plan] [--yes]   # make a project a cluster; each node takes a plan project slot
snoutdata cluster --project REF disable                   # a cluster of one node back to a plain project
snoutdata cluster status                  # nodes, keyspaces and their ranges, tables, routers, unfinished jobs
snoutdata cluster ops                     # the operations the router offers, and its defaults
snoutdata cluster nodes                   # each node's state and how many ranges it owns
snoutdata cluster nodes add [--no-join]   # join a node; in the cloud, a copy of the home node that takes its share
snoutdata cluster nodes attach REF        # hand over a ready node made with --no-join
snoutdata cluster nodes drain [--to N]    # move every range off a node
snoutdata cluster nodes remove            # detach a drained node
snoutdata cluster replica add|remove NODE # a copy of a data node that takes over if it is lost or corrupt
snoutdata cluster spread --distribution-key COL [--key-type T]   # keyspace, distribute and rebalance in one go
snoutdata cluster retry [--queue]         # take up a stopped join, or a stopped spread
snoutdata cluster keyspace create [--key-type T] [--ranges N] [--nodes ...]
snoutdata cluster keyspace drop
snoutdata cluster table distribute --distribution-key COL [--keyspace K]   # shard a table by a column
snoutdata cluster table reference         # copy a table to every node
snoutdata cluster table global            # bring a table back to the home node alone
snoutdata cluster table auto              # choose a key for every table from the schema, say why, distribute
snoutdata cluster range split|merge|move  # --keyspace, --range, --at, --to
snoutdata cluster tenant pin --value V [--node N]   # one key value gets its own range, and optionally its own node
snoutdata cluster rebalance               # even out ranges across the nodes
snoutdata cluster scale [--add|--remove|--nodes N]
snoutdata cluster verify                  # row counts and a checksum per range, source against target
snoutdata cluster cleanup [--node N]      # delete rows a node no longer owns, then VACUUM
snoutdata cluster dissolve                # back to the home node alone
snoutdata cluster plan <operation>        # the dry run: steps, what moves, rows, size, copy time, pause
snoutdata cluster jobs [show|watch|cancel|resume <id>]   # the durable job log
snoutdata cluster settings [--set advice_min_bytes=N,...]   # cutover and advisor settings
snoutdata cluster autopilot [off|advise|auto]   # off unless set; advise records, auto runs (asks, or --yes)
snoutdata cluster alerts [seen <id>]      # a node lost or corrupt, a failover, a node without its replica
snoutdata cluster check                   # the design check; runs nothing, exits 1 when something must be fixed
snoutdata cluster advise [--sample-ms N]  # what to split, move or add, with the command for each; runs nothing
```

`enable`, `disable`, `nodes attach`, `spread`, `retry`, `replica` and `alerts` work only on
SnoutData Cloud. Every operation that moves data takes `--plan` for a dry run (size, copy time,
expected pause). An operation that moves or deletes data asks first, or takes `--yes`. It waits
for its job unless you pass `--no-wait`. `cluster jobs watch` exits 0 when the job is done, 1
when it failed or was cancelled, and 10 when it timed out.

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

**A token**, in order: `SNOUTDATA_ACCESS_TOKEN`, then the profile's session
(`~/.snoutdata/auth.json`, or `auth.NAME.json` for a profile).

**A profile**, in order: `--profile`, then `SNOUTDATA_PROFILE`, then the profile recorded in
`.snoutdata/project.json` (`link --profile NAME` writes it), then the one `profile use` chose,
then the default. Any command takes
`--profile`, so one machine stays signed in to several accounts.

**Sign-in, when there is no credential and a person is present**, in order: SnoutData
Studio if it is running here and willing, then a browser, then a pairing code for a
terminal that has no browser at all. With no person present (not a terminal, `--json`, CI, or
`SNOUTDATA_NO_INTERACTIVE`) nothing is asked and it exits 3 at once.

Studio's local token is never sent to whatever answers on its port: the CLI first sends a random
nonce, and only a listener that answers with an HMAC of it keyed by that token (which proves it
holds the token without revealing it) is trusted. Anything else, including a Studio too old to
answer, is skipped as if Studio were not running.

---

## Documentation

- Everything an agent needs, on one page: <https://docs.snoutdata.com/developers/agent>
- Full CLI reference: <https://docs.snoutdata.com/developers/cli>
- Getting started: <https://docs.snoutdata.com/cloud/getting-started>
- Plans and limits: <https://docs.snoutdata.com/cloud/limits>

A SnoutData Cloud project costs nothing when idle: its Postgres database pauses when nobody
is using it and wakes on the next connection, while the client waits.

---

© SnoutData. Licensed under the [Apache License 2.0](./LICENSE). Use of SnoutData Cloud is
subject to <https://snoutdata.com/terms>.
