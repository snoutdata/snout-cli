/**
 * `snoutdata gen types typescript` — the schema, as a `.ts` file, on stdout.
 *
 * The companion to `snoutdata start`: the two commands a developer working against a hosted
 * Postgres actually reaches for. It needs `psql` and one query, because the thing that turns a
 * schema into TypeScript is ours and lives in
 * `src/shared/typescriptTypes.ts`, copied from the desktop app's `shared/` where it is the
 * canonical file and is tested.
 *
 * ## Three choices worth knowing about
 *
 * **The output goes to stdout and nowhere else unless asked.** The caller is a build script or
 * an agent, so `snoutdata gen types typescript > src/database.types.ts` has to be the whole of
 * it: progress goes to stderr, `--out` is there for a caller that would rather name a file, and
 * `--json` wraps the same text in one JSON value for a caller reading structured output.
 *
 * **It reads `pg_catalog`, not `information_schema`.** The catalogs give the real declared type
 * of a column (`mood`, `character varying(255)`, `text[]`) where `information_schema` says
 * `USER-DEFINED` and `ARRAY` — so enums come out as enums rather than as `unknown`. It is one
 * query and it holds no lock.
 *
 * **It runs through `psql`, for the same reason `db push` does.** The published CLI has no
 * dependencies at all, which is most of why `npx snoutdata` is fast; adding `pg` to it to run
 * one read-only query would be a poor trade. The error when psql is missing says so plainly.
 *
 * **Except for a hosted project, which does not need it.** The query is one read that answers one
 * JSON value, which is exactly what `cloud-project-sql` (the dashboard's SQL editor) carries, with
 * the same token. So with no psql on the machine a `--ref` asks the control plane instead
 * (2026-10-02: on Windows, where psql is rarely installed, `gen types --ref` could not run at all).
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { call, connection, type Connection } from '../api.js';
import { fail } from '../failure.js';
import { emit, say } from '../output.js';
import type { ColumnInfo, DatabaseSchema, RoutineInfo, TableInfo } from '../shared/schema.js';
import { emitTypeScriptTypes, type TypeGenEnum } from '../shared/typescriptTypes.js';
import { cloudSsl } from '../pgTls.js';

/** Where a `gen` command gets its database from. Exactly one of these is used. */
export interface GenTarget {
	/** A project on this account. Resolved through the control plane, like every other command. */
	readonly ref?: string;
	/**
	 * A plain `postgres://` URI, which is how this reaches a database the control plane has
	 * never heard of — a local pod from `snoutdata start`, or somebody else's database.
	 */
	readonly dbUrl?: string;
}

export interface GenOptions extends GenTarget {
	/** Which schemas to read. Defaults to `public`, the way every generator does. */
	readonly schemas?: readonly string[];
	/** The schema the `Tables<>` helpers resolve against. Defaults to the first one read. */
	readonly defaultSchema?: string;
	/** Write here instead of stdout. */
	readonly out?: string;
	/**
	 * How SQL reaches the database, when the caller has a better way than the psql on PATH.
	 *
	 * `gen types --local` passes the pod's own psql, so the command works on a machine with
	 * none of its own. Everything else leaves it unset and gets {@link runPsql}.
	 */
	readonly sql?: (sql: string) => Promise<{ code: number; out: string; err: string }>;
}

/** What `psql` needs to connect, with the password kept out of every argument list. */
export interface Target {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly password: string;
	readonly sslMode: string;
	/** A root file to verify the server with, for a cloud project (`pgTls.ts`). */
	readonly sslRootCert?: string;
	/** For a message: which database this is, without the password in it. */
	readonly label: string;
}

function fromConnection(details: Connection): Target {
	const ssl = cloudSsl(details.ssl);
	return {
		host: details.host,
		port: details.port,
		database: details.database,
		user: details.user,
		password: details.password,
		sslMode: ssl.mode,
		...(ssl.rootCert ? { sslRootCert: ssl.rootCert } : {}),
		label: details.ref
	};
}

/**
 * A `postgres://` URI, taken apart.
 *
 * Taken apart rather than handed to `psql` whole, because a URI carries the password and an
 * argument is visible in `ps` to every user on the machine. Same rule as everywhere else in
 * this CLI: the password travels in the child's environment.
 */
export function targetFromUrl(url: string): Target {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`--db-url is not a URL: ${url}`);
	}
	if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
		throw new Error(`--db-url must be a postgres:// URL, not ${parsed.protocol}//`);
	}
	const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
	if (!database) {
		throw new Error('--db-url has no database name in its path');
	}
	// `sslmode` in the query string wins; otherwise `prefer`, which is what a local pod on
	// loopback needs and what a remote one upgrades away from anyway.
	const sslMode = parsed.searchParams.get('sslmode') ?? 'prefer';
	return {
		host: parsed.hostname || '127.0.0.1',
		port: parsed.port ? Number(parsed.port) : 5432,
		database,
		user: decodeURIComponent(parsed.username) || 'postgres',
		password: decodeURIComponent(parsed.password),
		sslMode,
		label: `${parsed.hostname || '127.0.0.1'}/${database}`
	};
}

/**
 * Run some SQL and give back what psql said.
 *
 * Fed on stdin rather than with `-f`, because what runs is sometimes a migration wrapped in a
 * transaction with its ledger row, which is not a thing on disk. `ON_ERROR_STOP` is what makes a
 * failure a non-zero exit instead of a message scrolling past a "success", and `-tA` makes the
 * output parseable rather than drawn.
 *
 * Exported because `local.ts` needs exactly this and a third copy of it would be one too many.
 * It belongs in a `psql.ts` beside `push.ts` the day somebody moves `push.ts`'s copy as well.
 */
export function runPsql(target: Target, sql: string): Promise<{ code: number; out: string; err: string }> {
	return new Promise((done) => {
		const child = spawn(
			'psql',
			[
				'--host', target.host,
				'--port', String(target.port),
				'--username', target.user,
				'--dbname', target.database,
				'--no-psqlrc',
				'-v', 'ON_ERROR_STOP=1',
				'-tA'
			],
			{
				stdio: ['pipe', 'pipe', 'pipe'],
				env: { ...process.env, PGPASSWORD: target.password, PGSSLMODE: target.sslMode, ...(target.sslRootCert ? { PGSSLROOTCERT: target.sslRootCert } : {}) }
			}
		);
		let out = '';
		let err = '';
		child.stdout.on('data', (chunk) => (out += String(chunk)));
		child.stderr.on('data', (chunk) => (err += String(chunk)));
		child.on('error', (error) => {
			done({
				code: 127,
				out: '',
				err:
					(error as NodeJS.ErrnoException).code === 'ENOENT'
						? 'psql is not installed, and gen types needs it to read the schema. `snoutdata db url` prints a connection string for any client.'
						: String(error)
			});
		});
		child.on('close', (code) => done({ code: code ?? 0, out, err }));
		child.stdin.end(sql);
	});
}

/**
 * The whole introspection, as one query returning one JSON document.
 *
 * `$1` is the schema list, passed as a `text[]` literal built by {@link arrayLiteral} rather
 * than interpolated, because a schema name arrives from the command line.
 *
 * Everything here is `pg_catalog`. The three things that buys over `information_schema`:
 * `format_type` gives the DECLARED type (so an enum column says `mood`), `attidentity` and the
 * `nextval` default together answer "the database will fill this", and a unique index is
 * visible, which is what decides `isOneToOne` in the emitted `Relationships`.
 */
const INTROSPECT = `
with wanted as (select unnest($SCHEMAS$::text[]) as nspname)
select json_build_object(
  'tables', coalesce((
    select json_agg(json_build_object(
      'name', c.relname,
      'schema', n.nspname,
      'kind', case when c.relkind in ('v', 'm') then 'view' else 'table' end,
      'columns', coalesce((
        select json_agg(json_build_object(
          'name', a.attname,
          'dataType', format_type(a.atttypid, a.atttypmod),
          'nullable', not a.attnotnull,
          'isPrimaryKey', false,
          'default', pg_get_expr(d.adbin, d.adrelid),
          'autoIncrement', a.attidentity <> '' or coalesce(pg_get_expr(d.adbin, d.adrelid), '') like 'nextval(%',
          'generatedAlways', a.attidentity = 'a' or a.attgenerated <> ''
        ) order by a.attnum)
        from pg_attribute a
        left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
        where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      ), '[]'::json),
      'primaryKey', coalesce((
        select json_agg(att.attname order by k.ord)
        from pg_constraint con
        cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
        join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
        where con.conrelid = c.oid and con.contype = 'p'
      ), '[]'::json),
      'foreignKeys', coalesce((
        select json_agg(json_build_object(
          'constraintName', con.conname,
          'columns', (
            select json_agg(att.attname order by k.ord)
            from unnest(con.conkey) with ordinality as k(attnum, ord)
            join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum
          ),
          'referencedTable', rc.relname,
          'referencedColumns', (
            select json_agg(att.attname order by k.ord)
            from unnest(con.confkey) with ordinality as k(attnum, ord)
            join pg_attribute att on att.attrelid = con.confrelid and att.attnum = k.attnum
          )
        ) order by con.conname)
        from pg_constraint con
        join pg_class rc on rc.oid = con.confrelid
        where con.conrelid = c.oid and con.contype = 'f'
      ), '[]'::json),
      'indexes', coalesce((
        select json_agg(json_build_object(
          'name', ic.relname,
          'unique', i.indisunique,
          'columns', (
            select json_agg(att.attname order by k.ord)
            from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
            join pg_attribute att on att.attrelid = i.indrelid and att.attnum = k.attnum
          )
        ) order by ic.relname)
        from pg_index i
        join pg_class ic on ic.oid = i.indexrelid
        where i.indrelid = c.oid and not i.indisprimary
      ), '[]'::json)
    ) order by n.nspname, c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'v', 'm')
      and n.nspname in (select nspname from wanted)
  ), '[]'::json),
  'routines', coalesce((
    select json_agg(json_build_object(
      'name', p.proname,
      'schema', n.nspname,
      'kind', case p.prokind when 'p' then 'procedure' else 'function' end,
      'returnType', pg_get_function_result(p.oid),
      'parameters', coalesce((
        select json_agg(json_build_object(
          'name', coalesce(p.proargnames[a.ord], ''),
          'dataType', format_type(a.t, null),
          'mode', case coalesce(p.proargmodes[a.ord], 'i')
            when 'o' then 'OUT' when 'b' then 'INOUT' when 'v' then 'VARIADIC' when 't' then 'OUT' else 'IN' end
        ) order by a.ord)
        from unnest(coalesce(p.proallargtypes, p.proargtypes::oid[])) with ordinality as a(t, ord)
      ), '[]'::json)
    ) order by n.nspname, p.proname)
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.prokind in ('f', 'p')
      and n.nspname in (select nspname from wanted)
      and not exists (
        select 1 from pg_depend dep
        where dep.objid = p.oid and dep.classid = 'pg_proc'::regclass and dep.deptype = 'e'
      )
  ), '[]'::json),
  'enums', coalesce((
    select json_agg(json_build_object(
      'name', t.typname,
      'schema', n.nspname,
      'values', (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid)
    ) order by n.nspname, t.typname)
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where t.typtype = 'e' and n.nspname in (select nspname from wanted)
  ), '[]'::json)
)::text
`;

/** A Postgres `text[]` literal. Every value is quoted and every quote is doubled. */
export function arrayLiteral(values: readonly string[]): string {
	const inner = values.map((one) => `"${one.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
	return `'{${inner.replace(/'/g, "''")}}'`;
}

/** What the query gives back, before it is a {@link DatabaseSchema}. */
export interface RawIntrospection {
	tables: Array<{
		name: string;
		schema: string;
		kind: 'table' | 'view';
		columns: Array<{
			name: string;
			dataType: string;
			nullable: boolean;
			default: string | null;
			autoIncrement: boolean;
			generatedAlways?: boolean;
		}>;
		primaryKey: string[] | null;
		foreignKeys: Array<{
			constraintName: string;
			columns: string[];
			referencedTable: string;
			referencedColumns: string[];
		}> | null;
		indexes: Array<{ name: string; unique: boolean; columns: string[] | null }> | null;
	}>;
	routines: Array<{
		name: string;
		schema: string;
		kind: 'function' | 'procedure';
		returnType: string | null;
		parameters: Array<{ name: string; dataType: string; mode: string }> | null;
	}>;
	enums: Array<{ name: string; schema: string; values: string[] | null }>;
}

/**
 * The catalog's answer, as the schema model the emitter reads.
 *
 * Exported and pure so the shaping is provable without a database — the same split
 * `migrations.ts` has, and the reason `runPush` is testable.
 */
export function toSchema(raw: RawIntrospection, database: string, now = 0): {
	schema: DatabaseSchema;
	enums: TypeGenEnum[];
} {
	const tables: TableInfo[] = raw.tables.map((table) => {
		const primaryKey = table.primaryKey ?? [];
		const keyed = new Set(primaryKey);
		const columns: ColumnInfo[] = table.columns.map((column) => ({
			name: column.name,
			dataType: column.dataType,
			nullable: column.nullable,
			isPrimaryKey: keyed.has(column.name),
			default: column.default,
			autoIncrement: column.autoIncrement,
			...(column.generatedAlways === true ? { generatedAlways: true } : {})
		}));
		return {
			name: table.name,
			schema: table.schema,
			kind: table.kind,
			columns,
			primaryKey,
			foreignKeys: (table.foreignKeys ?? []).map((fk) => ({
				constraintName: fk.constraintName,
				columns: fk.columns ?? [],
				referencedTable: fk.referencedTable,
				referencedColumns: fk.referencedColumns ?? []
			})),
			// An index over an expression has a 0 in `indkey` and no attribute to join to, so
			// its column list comes back with a null in it. Dropped rather than carried: the
			// only thing indexes are read for here is whether a foreign key is one-to-one, and
			// a partial answer to that would be a wrong one.
			indexes: (table.indexes ?? [])
				.filter((index) => Array.isArray(index.columns) && index.columns.every((one) => typeof one === 'string'))
				.map((index) => ({ name: index.name, unique: index.unique, columns: index.columns ?? [] }))
		};
	});
	const routines: RoutineInfo[] = raw.routines.map((routine) => ({
		name: routine.name,
		schema: routine.schema,
		kind: routine.kind,
		returnType: routine.returnType ?? undefined,
		parameters: (routine.parameters ?? []).map((one) => ({
			name: one.name,
			dataType: one.dataType,
			mode: one.mode
		}))
	}));
	const enums: TypeGenEnum[] = raw.enums.map((one) => ({
		name: one.name,
		schema: one.schema,
		values: one.values ?? []
	}));
	return { schema: { database, tables, routines, fetchedAt: now }, enums };
}

/** What a generated run produced, so a caller (the MCP server, a test) can have it as a value. */
export interface GenResult {
	/** Which database it read, without a password in it. */
	target: string;
	schemas: string[];
	tables: number;
	views: number;
	functions: number;
	enums: number;
	/** Where it was written, or null when it went to stdout. */
	path: string | null;
	/**
	 * How a sharded project (snout-lepis) spreads the tables read: each one Lepis knows, with its
	 * shard key when it is sharded. Empty for every other database. The types are the same either
	 * way; this is for a caller that wants to know which filter keeps a query on one node.
	 */
	distribution: Distribution[];
	/** The file itself. */
	types: string;
}

/** One table of a sharded project, as `lepis.relation` on its home node describes it. */
export interface Distribution {
	schema: string;
	table: string;
	/** `sharded` (rows by key over the nodes), `reference` (a copy on each), `global` (home only). */
	kind: string;
	/** The shard key of a sharded table; null for the others. */
	keyColumn: string | null;
}

/**
 * Whether the database is a sharded project's home node: it holds Lepis's catalog. Read from
 * `pg_class`, which needs no privilege on the `lepis` schema, so asking never fails.
 *
 * A sharded project's home node holds every table's DEFINITION, sharded or not, and the
 * introspection reads only `pg_catalog`, which a Lepis router answers from home: each table is
 * read once, on one node. The catalog adds which tables are spread and by what.
 */
const HAS_LEPIS = `select exists (
  select from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'lepis' and c.relname = 'relation'
)::text`;

const LEPIS_RELATIONS = `select coalesce(json_agg(json_build_object(
  'schema', schema_name, 'table', table_name, 'kind', kind, 'keyColumn', key_column
) order by schema_name, table_name), '[]'::json)::text from lepis.relation`;

/**
 * The introspection's answer, which is one JSON document per line. One from a single Postgres;
 * more than one only when something answered from every node (a router fanning a catalog query
 * out), and then the documents describe the same tables, so they are merged with each table,
 * function and enum kept once. A line that is not JSON makes the whole answer unreadable.
 */
export function parseIntrospection(text: string): RawIntrospection | null {
	const docs: RawIntrospection[] = [];
	for (const line of text.split(/\r?\n/)) {
		const one = line.trim();
		if (!one) {
			continue;
		}
		try {
			docs.push(JSON.parse(one) as RawIntrospection);
		} catch {
			return null;
		}
	}
	if (docs.length === 0) {
		return null;
	}
	return mergeIntrospections(docs);
}

/** Several answers as one, each table (by schema and name), function (by signature) and enum once. */
export function mergeIntrospections(docs: readonly RawIntrospection[]): RawIntrospection {
	const once = <T>(lists: readonly (readonly T[] | undefined)[], key: (one: T) => string): T[] => {
		const seen = new Set<string>();
		const out: T[] = [];
		for (const list of lists) {
			for (const one of list ?? []) {
				const k = key(one);
				if (!seen.has(k)) {
					seen.add(k);
					out.push(one);
				}
			}
		}
		return out;
	};
	return {
		tables: once(docs.map((d) => d.tables), (t) => `${t.schema}.${t.name}`),
		routines: once(
			docs.map((d) => d.routines),
			(r) => `${r.schema}.${r.name}(${(r.parameters ?? []).map((p) => `${p.mode} ${p.dataType}`).join(',')})`
		),
		enums: once(docs.map((d) => d.enums), (e) => `${e.schema}.${e.name}`)
	};
}

/**
 * A sharded project's tables in the schemas read, from its catalog; empty when the database has
 * none, or when it cannot be read (the types do not depend on it, so it never fails the command).
 */
export async function readDistribution(
	run: (sql: string) => Promise<{ code: number; out: string; err: string }>,
	schemas: readonly string[]
): Promise<Distribution[]> {
	const present = await run(HAS_LEPIS);
	if (present.code !== 0 || present.out.trim() !== 'true') {
		return [];
	}
	const answer = await run(LEPIS_RELATIONS);
	if (answer.code !== 0) {
		return [];
	}
	try {
		const rows = JSON.parse(answer.out.trim()) as Distribution[];
		const wanted = new Set(schemas);
		return rows
			.filter((one) => wanted.has(one.schema))
			.map((one) => ({ schema: one.schema, table: one.table, kind: one.kind, keyColumn: one.keyColumn ?? null }));
	} catch {
		return [];
	}
}

/** Do the work and say nothing. */
export async function generateTypes(options: GenOptions): Promise<GenResult> {
	const schemas = options.schemas && options.schemas.length > 0 ? [...options.schemas] : ['public'];
	const target = options.dbUrl ? targetFromUrl(options.dbUrl) : fromConnection(await connection(refOf(options)));

	// psql, or with none on this machine the control plane for a hosted project; chosen once.
	let viaPlane = false;
	const run = async (sql: string): Promise<{ code: number; out: string; err: string }> => {
		if (options.sql) {
			return options.sql(sql);
		}
		if (viaPlane && options.ref) {
			return viaControlPlane(options.ref, sql);
		}
		const answer = await runPsql(target, sql);
		if (answer.code === 127 && !options.dbUrl && options.ref) {
			viaPlane = true;
			return viaControlPlane(options.ref, sql);
		}
		return answer;
	};

	const introspect = INTROSPECT.replace('$SCHEMAS$', arrayLiteral(schemas));
	const result = await run(introspect);
	if (result.code === 127) {
		fail('tool-missing', result.err.trim());
	}
	if (result.code !== 0) {
		fail('failed', result.err.trim() || `could not read the schema of ${target.label}`);
	}
	const text = result.out.trim();
	if (!text) {
		fail('failed', `${target.label} returned nothing for the schema query`);
	}
	const raw = parseIntrospection(text);
	if (!raw) {
		fail('failed', `could not read the schema of ${target.label}: the answer was not JSON`);
	}
	const distribution = await readDistribution(run, schemas);

	const { schema, enums } = toSchema(raw, target.database, Date.now());
	const types = emitTypeScriptTypes(schema, {
		driverId: 'postgres',
		defaultSchema: options.defaultSchema ?? schemas[0] ?? 'public',
		enums
	});

	let path: string | null = null;
	if (options.out) {
		path = isAbsolute(options.out) ? options.out : resolve(process.cwd(), options.out);
		writeFileSync(path, types, 'utf8');
	}
	return {
		target: target.label,
		schemas,
		tables: schema.tables.filter((one) => one.kind !== 'view').length,
		views: schema.tables.filter((one) => one.kind === 'view').length,
		functions: (schema.routines ?? []).length,
		enums: enums.length,
		path,
		distribution,
		types
	};
}

/**
 * The introspection query through the control plane's SQL function, answered the way psql would:
 * the one JSON value on stdout. That function returns a single-column row whose JSON it has
 * already turned into text.
 */
export async function viaControlPlane(
	ref: string,
	sql: string,
	send: (fn: string, body: unknown) => Promise<unknown> = call
): Promise<{ code: number; out: string; err: string }> {
	try {
		const answer = (await send('cloud-project-sql', { ref, sql })) as {
			rows?: Record<string, unknown>[];
			error?: string;
		};
		if (answer.error) {
			return { code: 1, out: '', err: answer.error };
		}
		const value = Object.values(answer.rows?.[0] ?? {})[0];
		const out = typeof value === 'string' ? value : value === undefined || value === null ? '' : JSON.stringify(value);
		return { code: 0, out, err: '' };
	} catch (error) {
		return { code: 1, out: '', err: error instanceof Error ? error.message : String(error) };
	}
}

function refOf(options: GenOptions): string {
	if (!options.ref) {
		throw new Error(
			'no project: pass --ref, --db-url, set SNOUTDATA_PROJECT, or run `snoutdata link --ref <ref>`'
		);
	}
	return options.ref;
}

/**
 * The CLI command.
 *
 * `gen types typescript` and not `gen types` alone: the language is where this grows, and a
 * command that takes a language argument today is a command that can grow Go and Swift without
 * anybody's script changing.
 */
export async function genTypes(language: string | undefined, options: GenOptions): Promise<number> {
	const wanted = (language ?? 'typescript').toLowerCase();
	if (wanted !== 'typescript' && wanted !== 'ts') {
		fail(
			'usage',
			`gen types does not know how to write ${language}. It writes typescript, which is the only language it claims.`
		);
	}
	const result = await generateTypes(options);
	if (result.path) {
		say(
			`Wrote ${result.tables} table${result.tables === 1 ? '' : 's'}, ${result.views} view${result.views === 1 ? '' : 's'}, ` +
				`${result.functions} function${result.functions === 1 ? '' : 's'} and ${result.enums} enum${result.enums === 1 ? '' : 's'} to ${result.path}.`
		);
	}
	// In JSON mode the whole result is the value. Otherwise the FILE is the answer and it goes
	// to stdout unwrapped, so `snoutdata gen types typescript > database.types.ts` is the whole
	// of the usage — unless `--out` already wrote it, in which case stdout stays clean.
	emit(result, () => {
		if (!result.path) {
			process.stdout.write(result.types);
		}
	});
	return 0;
}
