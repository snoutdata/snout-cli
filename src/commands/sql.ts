/**
 * `snoutdata db query`, `db run`, `db slow` and the tables of `usage --tables`: SQL with nothing
 * installed.
 *
 * `db psql` needs a local psql, and a machine without one (most Windows machines, most CI images,
 * every agent sandbox) had no way to run a statement at all: a customer wrote a Node runner of
 * their own just to apply DDL and run checks (2026-11-04). These go through the CLI's own client
 * instead (`pgWire.ts`, TLS verified as `pgTls.ts` says), the one `db push` has used since 0.17.4,
 * with the credentials fetched because you are signed in, as every db command does.
 *
 * ## One transaction, or none
 *
 * A file (or a `db query` string) is cut into statements by psql's rules (`sqlScript.ts`) and they
 * are sent one at a time. More than one statement runs inside one transaction, so the first that
 * fails rolls all of them back and the database is as it was; the failure names the statement and
 * its line. A single statement is sent on its own: it is atomic anyway, and that is what lets
 * `VACUUM` or `CREATE INDEX CONCURRENTLY` run, which no transaction block takes. Two ways out of
 * the wrapping, both on purpose:
 *
 *  - a file that is its own transaction (`BEGIN` first, `COMMIT` last, nothing ending it between)
 *    runs as written, which is how most hand-written DDL scripts look;
 *  - `-- snoutdata:no-transaction` on a line of its own, the marker `db push` reads, runs each
 *    statement as written, and a failure leaves the ones before it in place.
 *
 * Anything else that ends a transaction half way (a `COMMIT` in the middle) is refused before
 * anything runs, for the reason `db push` refuses it: what ran before it would stay when a later
 * statement failed. So is a psql meta-command (`\i`, `\set`), which only psql can run.
 */

import { readFileSync, statSync } from 'node:fs';
import { connection } from '../api.js';
import { CliFailure, fail } from '../failure.js';
import { wantsTransaction } from '../migrations.js';
import { dim, emit, relative, say, table } from '../output.js';
import { describePgError, PgConnectError, PgServerError, PgSession, type PgTarget } from '../pgWire.js';
import { endsTransaction, splitScript, type ScriptStatement } from '../sqlScript.js';
import { describeBytes, warnIfReadOnly } from './db.js';
import type { PushHost, SqlSession } from './push.js';

/** What these commands reach the database through. Tests hand it a fake one, as `db push`'s do. */
export type SqlHost = PushHost;

const LIVE: SqlHost = {
	connection: (ref) => connection(ref),
	open: (target) => PgSession.open(target)
};

/** Connect to the project's database, run `work`, and close, failing in a sentence when it cannot connect. */
async function withDatabase<T>(ref: string, host: SqlHost, work: (session: SqlSession) => Promise<T>): Promise<T> {
	const details = await host.connection(ref);
	if (!details.wakesInstantly) {
		say('This project is paused; the connection will wake it, which takes a few seconds.');
	}
	const target: PgTarget = {
		host: details.host,
		port: details.port,
		database: details.database,
		user: details.user,
		password: details.password,
		ssl: details.ssl
	};
	let session: SqlSession;
	try {
		session = await host.open(target);
	} catch (error) {
		if (error instanceof PgConnectError) {
			throw new CliFailure('network', `Could not reach ${ref}'s database: ${error.message}.`);
		}
		if (error instanceof PgServerError) {
			throw new CliFailure('failed', `${ref}'s database refused the connection: ${error.message}`);
		}
		throw error;
	}
	try {
		return await work(session);
	} finally {
		// Closing with a transaction still open is what rolls it back.
		session.close();
	}
}

/** One statement's answer: its rows when it returned any, else its command tag. */
export interface StatementResult {
	/** Its place in the script, from 1. */
	readonly statement: number;
	/** The line it starts on, from 1. */
	readonly line: number;
	/** The command tag the server sent (`CREATE TABLE`, `SELECT 3`). */
	readonly command: string | null;
	readonly columns?: string[];
	readonly rows?: (string | null)[][];
	readonly notices?: string[];
}

/** How a script is run: wrapped by us, its own transaction, or a statement at a time. */
export type TransactionMode = 'wrapped' | 'own' | 'none';

/** Whether a statement starts a transaction block. */
function startsTransaction(sql: string): boolean {
	return /^\s*(begin|start\s+transaction)\b/i.test(sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' '));
}

/**
 * How to run these statements, or why not: pure, so every case is decided without a database.
 * `text` is the whole script, for the `-- snoutdata:no-transaction` marker.
 */
export function planScript(text: string, statements: readonly ScriptStatement[]): { mode: TransactionMode } | { refused: string } {
	if (statements.length <= 1 || !wantsTransaction(text)) {
		return { mode: 'none' };
	}
	const first = statements[0]!;
	const last = statements[statements.length - 1]!;
	const between = statements.slice(1, -1);
	const closing = endsTransaction(last.sql);
	if (startsTransaction(first.sql) && (closing === 'COMMIT' || closing === 'END')
		&& between.every((statement) => endsTransaction(statement.sql) === null && !startsTransaction(statement.sql))) {
		return { mode: 'own' };
	}
	const ending = statements.find((statement) => endsTransaction(statement.sql) !== null);
	if (ending) {
		const word = endsTransaction(ending.sql);
		return {
			refused: `line ${ending.line} ends the transaction itself (${word}). Several statements run in one transaction, so a ${word} part way would keep what ran before it if a later statement failed. Take it out, wrap the whole file in BEGIN and COMMIT, or put -- snoutdata:no-transaction on a line of its own to run each statement as written.`
		};
	}
	return { mode: 'wrapped' };
}

/** Run a script's statements, stopping at the first failure. */
async function runScript(
	session: SqlSession,
	statements: readonly ScriptStatement[],
	mode: TransactionMode
): Promise<{ results: StatementResult[] } | { failed: number; line: number; error: string; ran: number }> {
	const results: StatementResult[] = [];
	if (mode === 'wrapped') {
		await session.query('begin;');
	}
	for (const [index, statement] of statements.entries()) {
		try {
			const answer = await session.query(statement.sql, statement.copyData);
			results.push({
				statement: index + 1,
				line: statement.line,
				command: answer.command,
				...(answer.columns ? { columns: answer.columns, rows: answer.rows } : {}),
				...(answer.notices ? { notices: answer.notices } : {})
			});
		} catch (error) {
			if (error instanceof PgServerError) {
				if (mode !== 'none') {
					try {
						await session.query('rollback;');
					} catch {
						// Closing the connection rolls it back all the same.
					}
				}
				return { failed: index + 1, line: statement.line, error: describePgError(error, statement.sql, statement.line), ran: index };
			}
			if (error instanceof PgConnectError) {
				return { failed: index + 1, line: statement.line, error: `the connection was lost: ${error.message}`, ran: index };
			}
			throw error;
		}
	}
	if (mode === 'wrapped') {
		try {
			await session.query('commit;');
		} catch (error) {
			// A deferred constraint is checked here, after every statement has run.
			if (error instanceof PgServerError) {
				return { failed: statements.length + 1, line: 0, error: describePgError(error, 'commit;'), ran: statements.length };
			}
			throw error;
		}
	}
	return { results };
}

/** A cell as one line of a table: NULL empty (as psql shows it), line breaks and tabs spelled out. */
export function formatCell(value: string | null): string {
	return value === null ? '' : value.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t');
}

/** A result set as a table, with its column names over a rule. */
export function resultTable(columns: readonly string[], rows: readonly (readonly (string | null)[])[]): string {
	const cells = rows.map((row) => columns.map((_, index) => formatCell(row[index] ?? null)));
	const widths = columns.map((name, index) => Math.max(name.length, ...cells.map((row) => row[index]!.length)));
	return table([[...columns], widths.map((width) => '-'.repeat(Math.max(width, 1))), ...cells]);
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Run `text` against the project: the shared body of `db query` and `db run`. `file` is the path
 * it was read from, for the messages.
 */
async function execute(ref: string, text: string, file: string | undefined, host: SqlHost): Promise<number> {
	const script = splitScript(text);
	const source = file ?? 'the SQL';
	if (script.metaCommands.length > 0) {
		const lines = script.metaCommands
			.map((command) => `  line ${command.line}: ${command.text.length > 60 ? `${command.text.slice(0, 57)}...` : command.text}`)
			.join('\n');
		fail('usage', `Refused, and nothing ran: ${source} holds psql commands, which only psql runs. Put the SQL each one stands for in their place.\n${lines}`, {
			ref,
			...(file ? { file } : {}),
			metaCommands: script.metaCommands
		});
	}
	if (script.statements.length === 0) {
		fail('usage', `${file ? `${file} holds` : 'That is'} no SQL to run.`, { ref, ...(file ? { file } : {}) });
	}
	const plan = planScript(text, script.statements);
	if ('refused' in plan) {
		fail('usage', `Refused, and nothing ran: ${file ? `${file} ` : ''}${plan.refused}`, { ref, ...(file ? { file } : {}) });
	}
	const { mode } = plan;

	await warnIfReadOnly(ref);
	const outcome = await withDatabase(ref, host, (session) => runScript(session, script.statements, mode));
	const total = script.statements.length;

	if ('failed' in outcome) {
		const where = outcome.failed > total
			? 'The commit'
			: total === 1
				? 'The statement'
				: `Statement ${outcome.failed} of ${total}${outcome.line > 0 ? ` (${file ? `${file}:` : 'line '}${outcome.line})` : ''}`;
		const after = mode === 'none'
			? total === 1 || outcome.ran === 0
				? 'Nothing was changed.'
				: `The ${plural(outcome.ran, 'statement')} before it ran and stay, since this runs outside a transaction; the ones after it were not tried.`
			: 'It ran in one transaction, which was rolled back, so nothing was changed.';
		fail('failed', `${where} failed. ${after}\n${outcome.error}`, {
			ref,
			...(file ? { file } : {}),
			statement: outcome.failed > total ? null : outcome.failed,
			line: outcome.line > 0 ? outcome.line : null,
			transaction: mode !== 'none',
			error: outcome.error
		});
	}

	const { results } = outcome;
	emit({ ref, ok: true, ...(file ? { file } : {}), transaction: mode !== 'none', statements: results }, () => {
		let printed = false;
		for (const result of results) {
			for (const notice of result.notices ?? []) {
				say(notice);
			}
			if (result.columns) {
				if (printed) {
					process.stdout.write('\n');
				}
				const rows = result.rows ?? [];
				if (result.columns.length > 0) {
					process.stdout.write(`${resultTable(result.columns, rows)}\n`);
				}
				say(dim(`(${plural(rows.length, 'row')})`));
				printed = true;
			} else if (result.command) {
				say(result.command);
			}
		}
		if (mode !== 'none') {
			say(dim(`${plural(total, 'statement')} ran in one transaction, committed.`));
		}
	});
	return 0;
}

/** `snoutdata db query "<sql>"`: SQL from the command line, its rows as a table. */
export async function query(ref: string, sql: string, host: SqlHost = LIVE): Promise<number> {
	return execute(ref, sql, undefined, host);
}

/** `snoutdata db run <file.sql>`: a file of SQL, in one transaction. */
export async function run(ref: string, file: string, host: SqlHost = LIVE): Promise<number> {
	let text: string;
	try {
		if (!statSync(file).isFile()) {
			fail('usage', `${file} is not a file.`, { file });
		}
		text = readFileSync(file, 'utf8');
	} catch (error) {
		if (error instanceof CliFailure) {
			throw error;
		}
		fail('usage', `no file at ${file}`, { file });
	}
	return execute(ref, text, file, host);
}

/** A double-quoted identifier. */
function ident(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

/** A length of time in milliseconds, in the unit that reads best. */
export function describeMs(ms: number): string {
	if (ms < 10) {
		return `${ms.toFixed(2)} ms`;
	}
	if (ms < 1000) {
		return `${ms.toFixed(1)} ms`;
	}
	if (ms < 60_000) {
		return `${(ms / 1000).toFixed(1)} s`;
	}
	if (ms < 3_600_000) {
		return `${(ms / 60_000).toFixed(1)} min`;
	}
	return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** A statement's text on one line, at most `width` characters. */
export function shortenQuery(text: string, width = 80): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > width ? `${flat.slice(0, width - 3)}...` : flat;
}

/** One row of `db slow`. */
export interface SlowStatement {
	readonly role: string;
	readonly calls: number;
	readonly meanMs: number;
	readonly totalMs: number;
	readonly rows: number;
	/** Its share of the time every statement took, in percent. */
	readonly share: number | null;
	readonly query: string;
}

const EXTENSION_SCHEMA_SQL = "select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_stat_statements';";

/**
 * `snoutdata db slow`: the statements that took the most time in all, from `pg_stat_statements`.
 *
 * Read from wherever the extension was created (`snout_ext` on a SnoutData project) rather than by
 * a fixed name, and only this database's rows. The owner role cannot read the text of a statement
 * another role ran (Postgres shows it to that role or to pg_read_all_stats), so such a row says
 * whose it is instead of `<insufficient privilege>`, as the dashboard's Postgres tab does.
 */
export async function slow(ref: string, options: { limit?: number } = {}, host: SqlHost = LIVE): Promise<number> {
	const limit = options.limit ?? 10;
	const answer = await withDatabase(ref, host, async (session) => {
		const found = await session.query(EXTENSION_SCHEMA_SQL);
		const schema = found.rows[0]?.[0];
		if (!schema) {
			return null;
		}
		const view = `${ident(schema)}.pg_stat_statements`;
		const { rows } = await session.query(`select coalesce(r.rolname, s.userid::text),
	s.calls,
	s.mean_exec_time,
	s.total_exec_time,
	s.rows,
	round((100 * s.total_exec_time / nullif(sum(s.total_exec_time) over (), 0))::numeric, 1),
	s.query
from ${view} s
left join pg_roles r on r.oid = s.userid
where s.dbid = (select oid from pg_database where datname = current_database())
order by s.total_exec_time desc, s.queryid
limit ${Math.floor(limit)};`);
		let since: string | null = null;
		try {
			const reset = await session.query(`select to_char(stats_reset at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from ${ident(schema)}.pg_stat_statements_info;`);
			since = reset.rows[0]?.[0] ?? null;
		} catch {
			// Postgres before 14 has no _info view; the totals are just not dated.
		}
		const statements: SlowStatement[] = rows.map(([role, calls, mean, total, count, share, text]) => ({
			role: role ?? '',
			calls: Number(calls),
			meanMs: Number(mean),
			totalMs: Number(total),
			rows: Number(count),
			share: share === null || share === undefined ? null : Number(share),
			query: text === '<insufficient privilege>' ? `(hidden: Postgres shows this text only to ${role ?? 'the role that ran it'})` : (text ?? '')
		}));
		return { schema, since, statements };
	});
	if (!answer) {
		fail(
			'not-found',
			'pg_stat_statements is not switched on in this database, so there is nothing to read. It is loaded on every SnoutData database and starts recording once it is created:\n  snoutdata db query "create extension if not exists pg_stat_statements"',
			{ ref }
		);
	}
	emit({ ref, ...answer }, () => {
		if (answer.statements.length === 0) {
			say('No statements recorded yet.');
			return;
		}
		process.stdout.write(
			`${table([
				['TOTAL', 'MEAN', 'CALLS', 'ROWS', 'SHARE', 'ROLE', 'QUERY'],
				...answer.statements.map((one) => [
					describeMs(one.totalMs),
					describeMs(one.meanMs),
					one.calls.toLocaleString('en-US'),
					one.rows.toLocaleString('en-US'),
					one.share === null ? '-' : `${one.share}%`,
					one.role,
					shortenQuery(one.query)
				])
			])}\n`
		);
		say(dim(`${answer.since ? `Counted since ${answer.since} (${relative(answer.since)}). ` : ''}--json has each statement's whole text.`));
	});
	return 0;
}

/** One table in `usage --tables`: a partitioned table counts once, with its partitions in it. */
export interface TableSize {
	readonly schema: string;
	readonly name: string;
	readonly kind: 'table' | 'partitioned table' | 'materialized view';
	/** How many partitions it has, at every level; 0 for a table that is not partitioned. */
	readonly partitions: number;
	/** Everything: the rows, TOAST and the indexes, of the table and every partition. */
	readonly totalBytes: number;
	readonly indexBytes: number;
	/** Postgres's estimate from the last ANALYZE; null when nothing has analysed it yet. */
	readonly rowsEstimate: number | null;
}

/**
 * The largest tables, every partition under its top-level parent. A partition is followed down
 * through `pg_inherits` only while it IS a partition (`relispartition`), so a child by old-style
 * inheritance stays a table of its own, as Postgres counts it.
 */
export function largestTablesSql(limit: number): string {
	return `with recursive tree(root, rel) as (
	select c.oid, c.oid
	from pg_class c
	join pg_namespace n on n.oid = c.relnamespace
	where c.relkind in ('r', 'p', 'm') and not c.relispartition
		and n.nspname not in ('pg_catalog', 'information_schema')
		and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
	union all
	select t.root, i.inhrelid
	from tree t
	join pg_inherits i on i.inhparent = t.rel
	join pg_class p on p.oid = i.inhrelid and p.relispartition
)
select n.nspname, c.relname, c.relkind::text,
	count(*) - 1,
	coalesce(sum(pg_total_relation_size(t.rel)), 0)::bigint,
	coalesce(sum(pg_indexes_size(t.rel)), 0)::bigint,
	case when bool_or(k.relkind <> 'p' and k.reltuples >= 0)
		then sum(case when k.relkind <> 'p' and k.reltuples > 0 then k.reltuples else 0 end)::bigint end
from tree t
join pg_class c on c.oid = t.root
join pg_namespace n on n.oid = c.relnamespace
join pg_class k on k.oid = t.rel
group by n.nspname, c.relname, c.relkind
order by 5 desc, 1, 2
limit ${Math.floor(limit)};`;
}

const KINDS: Record<string, TableSize['kind']> = { r: 'table', p: 'partitioned table', m: 'materialized view' };

/** The largest tables in the project's database, and the database's whole size. */
export async function largestTables(ref: string, limit = 20, host: SqlHost = LIVE): Promise<{ databaseBytes: number; tables: TableSize[] }> {
	return withDatabase(ref, host, async (session) => {
		const { rows } = await session.query(largestTablesSql(limit));
		const size = await session.query('select pg_database_size(current_database());');
		return {
			databaseBytes: Number(size.rows[0]?.[0] ?? 0),
			tables: rows.map(([schema, name, kind, partitions, total, indexes, estimate]) => ({
				schema: schema ?? '',
				name: name ?? '',
				kind: KINDS[kind ?? 'r'] ?? 'table',
				partitions: Number(partitions),
				totalBytes: Number(total),
				indexBytes: Number(indexes),
				rowsEstimate: estimate === null || estimate === undefined ? null : Number(estimate)
			}))
		};
	});
}

/** A count in a few characters: 950, 12K, 3.4M. */
export function describeCount(value: number): string {
	if (value < 1000) {
		return String(value);
	}
	const units = ['K', 'M', 'B', 'T'];
	let size = value / 1000;
	let unit = 0;
	while (size >= 1000 && unit < units.length - 1) {
		size /= 1000;
		unit += 1;
	}
	return `${size.toFixed(size >= 10 ? 0 : 1)}${units[unit]}`;
}

/** `usage --tables`, as lines for `say`. */
export function describeTables(answer: { databaseBytes: number; tables: readonly TableSize[] }): string[] {
	if (answer.tables.length === 0) {
		return ['No tables yet.'];
	}
	const shown = answer.tables.reduce((sum, one) => sum + one.totalBytes, 0);
	return [
		table([
			['TABLE', 'TOTAL', 'INDEXES', 'ROWS (EST.)'],
			...answer.tables.map((one) => [
				`${one.schema}.${one.name}${one.partitions > 0 ? ` (${plural(one.partitions, 'partition')})` : one.kind === 'materialized view' ? ' (materialized view)' : ''}`,
				describeBytes(one.totalBytes),
				describeBytes(one.indexBytes),
				one.rowsEstimate === null ? '-' : `~${describeCount(one.rowsEstimate)}`
			])
		]),
		dim(`${plural(answer.tables.length, 'table')}, ${describeBytes(shown)} of the database's ${describeBytes(answer.databaseBytes)}. Totals include indexes and TOAST; rows are Postgres's estimate from the last ANALYZE.`)
	];
}
