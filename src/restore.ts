/**
 * Reading a dump file, and deciding whether it may be loaded into this database.
 *
 * Pure: it takes the first bytes of a file and some facts about the target, and returns
 * what to run or why not. The interesting cases — the wrong kind of file, a database that
 * already has something in it, a project that cannot accept writes — are provable without
 * a dump and without a database.
 *
 * ## Why the format is SNIFFED and not taken from the name
 *
 * `pg_dump` writes four formats and the file name says nothing reliable about which:
 * `.sql` is a convention, `.dump` is a convention, and an agent that downloaded an export
 * has whatever name the URL gave it. Loading a custom-format archive with `psql` produces
 * a screen of binary and a syntax error, which is a bad half-hour for anybody. The magic
 * bytes are unambiguous and free to read.
 *
 * ## The refusal that matters
 *
 * **A restore into a database that already has tables is refused.** Not because Postgres
 * cannot do it — it can, and the result is a mess of "already exists" errors with some
 * objects created and some not — but because the overwhelmingly likely cause is the wrong
 * `--ref`. An agent restoring production into a project it just made is fine; an agent
 * restoring into the project it was working in is a bad afternoon. `--force` is there for
 * the person who means it.
 */

/** What `pg_dump` wrote. `plain` is SQL for psql; the rest are archives for pg_restore. */
export type DumpFormat = 'custom' | 'tar' | 'plain' | 'unknown';

/**
 * What kind of dump this is, from its first bytes.
 *
 * Wants at least 512 bytes to recognise a tar; anything shorter is judged on what it has,
 * which is enough for the two that matter.
 */
export function dumpFormat(head: Uint8Array): DumpFormat {
	const ascii = (from: number, length: number): string =>
		String.fromCharCode(...Array.from(head.slice(from, from + length)));

	// pg_dump's custom format opens with "PGDMP", and has since 7.x.
	if (ascii(0, 5) === 'PGDMP') {
		return 'custom';
	}
	// A tar's magic sits at offset 257, which is why a short read cannot see it.
	if (head.length >= 262 && ascii(257, 5) === 'ustar') {
		return 'tar';
	}
	// Plain SQL, if it looks like text at all. A dump's first line is a comment or a SET,
	// but a hand-written seed file is legitimate too, so the test is "is this text".
	const printable = Array.from(head.slice(0, 256)).every(
		(byte) => byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128
	);
	return printable && head.length > 0 ? 'plain' : 'unknown';
}

export type RestoreRefusal = 'unknown-format' | 'directory-format' | 'not-empty' | 'read-only';

export interface RestoreTarget {
	/** How many tables the target database already has, outside the system schemas. */
	readonly existingTables: number;
	/** The project is over its storage limit and refuses writes. */
	readonly readOnly: boolean;
}

export interface RestoreOptions {
	/** Load into a database that already has tables. */
	readonly force?: boolean;
}

export type RestoreVerdict =
	| { ok: true; tool: 'psql' | 'pg_restore'; format: DumpFormat }
	| { ok: false; code: RestoreRefusal; reason: string };

/**
 * May this dump be loaded into this database, and with which tool?
 *
 * `read-only` is checked FIRST, because it is the one refusal that is not about the
 * caller's judgement: a project over its storage limit will fail every write whatever
 * anybody meant, and finding that out half way through a restore is worse than being told.
 */
export function restoreVerdict(
	format: DumpFormat,
	target: RestoreTarget,
	options: RestoreOptions = {}
): RestoreVerdict {
	if (target.readOnly) {
		return {
			ok: false,
			code: 'read-only',
			reason: 'this project is over its plan\'s storage limit, so it refuses writes. A restore would fail part way. Delete some rows or change plan first.'
		};
	}
	if (format === 'unknown') {
		return {
			ok: false,
			code: 'unknown-format',
			reason: 'that file is not a pg_dump archive and does not look like SQL. `snoutdata db export` writes the custom format; psql reads plain .sql.'
		};
	}
	if (!options.force && target.existingTables > 0) {
		return {
			ok: false,
			code: 'not-empty',
			reason: `this database already has ${target.existingTables} table${target.existingTables === 1 ? '' : 's'}. Restoring into it would leave some objects created and some not. Check --ref is the project you meant, or pass --force.`
		};
	}
	return { ok: true, tool: format === 'plain' ? 'psql' : 'pg_restore', format };
}

/**
 * Which of `pg_restore`'s errors mean anything.
 *
 * Every export this product takes, restored into a project this product made, reports two
 * errors and exits 1 while having worked perfectly:
 *
 *     pg_restore: error: could not execute query: ERROR:  must be owner of extension pg_stat_statements
 *     Command was: COMMENT ON EXTENSION pg_stat_statements IS '...'
 *
 * The dump carries comments on the extensions the pod image installs, and the project's
 * owner role does not own them — the pod's superuser does, and never hands that over
 * (`001-cloud.sql` says why). So the comments cannot be restored, and nothing is lost:
 * they are Postgres's own description of an extension that is already installed.
 *
 * Reported as a failure this is worse than useless, because it teaches somebody that a
 * successful restore looks like a failure, and the next real one is ignored. So the
 * errors are counted and classified: if every one of them is that, the restore worked.
 *
 * Deliberately NOT solved with `--no-comments`, which would also throw away the comments
 * the user wrote on their own tables, or by editing the archive's table of contents, which
 * is two passes and a temporary file to save reading four lines.
 */
export interface RestoreErrors {
	/** Every `pg_restore: error:` line. */
	readonly total: number;
	/** Those that are the extension-comment noise above. */
	readonly harmless: number;
	/** The rest, as they were printed. These are the ones a person has to read. */
	readonly fatal: string[];
}

export function classifyRestoreErrors(stderr: string): RestoreErrors {
	const lines = stderr.split('\n').filter((line) => /^pg_restore: error:/.test(line.trim()));
	const fatal = lines.filter((line) => !/must be owner of extension/.test(line));
	return { total: lines.length, harmless: lines.length - fatal.length, fatal };
}


/**
 * What to restore from an archive of OURS into a project of ours, and in which order.
 *
 * An export carries the platform's own objects as well as the customer's: the `auth`,
 * `storage`, `push` and Realtime schemas with their functions, triggers and policies, the
 * pod's event triggers, the extension schemas, the Realtime publication. Every project the
 * platform makes already has them, so restoring them failed by the dozen (85 errors and a
 * "half-finished restore" verdict on a restore whose data was all there, 2026-10-02); and
 * where a product was OFF in the target the restore CREATED its tables, owned by the
 * customer's role, so switching that product on afterwards crashed it: snout-auth could not
 * read `auth.schema_migrations` (docs/cloud/QA-RETEST.md §3e).
 *
 * So the platform's objects are never restored; only their ROWS are, into the tables the
 * platform made, which is why a dump holding auth, storage or push data needs that product on
 * first (`products`). They are told apart by schema and name as well as owner, because a pod
 * makes some of them (the `auth` schema itself, the PostgREST watch triggers, the Realtime
 * publication) as the customer's own role. The rows load first, as the product's own role so
 * its sequences can be set too, parents before children, because the target's foreign keys
 * already exist and a customer's own may point at `auth.users`. Left out, and said: the
 * platform's migration bookkeeping, Realtime's internals, PostGIS's `spatial_ref_sys`, push
 * credentials (sealed for the source project), and pg_cron's jobs (each names the source
 * project's role and database).
 */
export type PlatformProduct = 'auth' | 'storage' | 'push';

/** The role a product's tables belong to in every project, which the owner may SET ROLE to. */
export const PRODUCT_ROLE: Readonly<Record<PlatformProduct, string>> = {
	auth: 'snout_auth_admin',
	storage: 'snout_storage_admin',
	push: 'snout_push_admin'
};

export interface RestorePlan {
	/**
	 * The first pass: each product's rows, parents first, to load as that product's role, after
	 * emptying `clear`: tables the product seeds when it is switched on, whose row in the dump
	 * is the customer's and replaces the default.
	 */
	readonly platformData: readonly {
		readonly product: PlatformProduct;
		readonly clear: readonly string[];
		/** The tables those rows go into, which must exist: a product is "on" before it has made them. */
		readonly tables: readonly string[];
		readonly lines: readonly string[];
	}[];
	/** The second pass: everything the customer owns. */
	readonly rest: string[];
	/** The products the target must have on before the first pass. */
	readonly products: PlatformProduct[];
	/** Entries left out. */
	readonly skipped: number;
	/** What was left out that a person would miss. */
	readonly notes: string[];
}

/** The roles the platform's own objects belong to (the pod's superuser and each product's). */
const PLATFORM_OWNER = /^(snoutpod_admin|snout_[a-z]+_admin)$/;
/** Schemas every project is given, whose objects only the platform makes. */
const PLATFORM_SCHEMAS = new Set([
	'auth', 'storage', 'push', 'realtime', 'snout_realtime', '_realtime', 'graphql', 'graphql_public',
	'extensions', 'net', 'cron', 'pgbouncer', 'vault', 'pgsodium'
]);
/** Objects the platform puts in `public` or in no schema. */
const PLATFORM_NAMES = /^(pgrst_ddl_watch|pgrst_drop_watch|snoutpod_[a-z_]+|snoutdata_realtime|snout_realtime_messages)(\(|$)/;
const PRODUCT_SCHEMAS: Readonly<Record<string, PlatformProduct>> = { auth: 'auth', storage: 'storage', push: 'push' };
/** Tables a product fills when it is switched on (`push.settings` is one row of defaults). */
const SEEDED = new Set(['push.settings']);
/** `pg_restore --list` types of more than one word; any other type is its first word. */
const TYPES = [
	'TABLE DATA', 'SEQUENCE SET', 'SEQUENCE OWNED BY', 'FK CONSTRAINT', 'CHECK CONSTRAINT', 'DEFAULT ACL',
	'EVENT TRIGGER', 'ROW SECURITY', 'INDEX ATTACH', 'TABLE ATTACH', 'MATERIALIZED VIEW DATA', 'MATERIALIZED VIEW',
	'PUBLICATION TABLES IN SCHEMA', 'PUBLICATION TABLE', 'FOREIGN TABLE', 'FOREIGN DATA WRAPPER', 'FOREIGN SERVER',
	'USER MAPPING', 'TEXT SEARCH CONFIGURATION', 'TEXT SEARCH DICTIONARY', 'TEXT SEARCH PARSER',
	'TEXT SEARCH TEMPLATE', 'LARGE OBJECT', 'PROCEDURAL LANGUAGE', 'OPERATOR CLASS', 'OPERATOR FAMILY',
	'ACCESS METHOD', 'EXTENDED STATISTICS', 'DATABASE PROPERTIES'
];

interface Entry {
	readonly line: string;
	readonly type: string;
	readonly schema: string;
	readonly name: string;
	readonly owner: string;
}

/**
 * One `pg_restore --list` line: `id; tableoid oid TYPE schema name owner`. The name may
 * contain spaces (a customer may call a table anything), so the type comes off the front, the
 * owner off the end, and the name is what is between.
 */
function parseEntry(line: string): Entry | null {
	const match = /^\d+; \d+ \d+ (.+)$/.exec(line.trim());
	if (!match) {
		return null;
	}
	const rest = match[1]!;
	const type = TYPES.find((candidate) => rest.startsWith(`${candidate} `)) ?? rest.split(' ')[0]!;
	const words = rest.slice(type.length).trim().split(' ');
	const schema = words[0] ?? '-';
	// An entry with no owner (an EXTENSION, a COMMENT on one) ends at its name.
	const owner = words.length > 2 ? words[words.length - 1]! : '';
	const name = words.slice(1, words.length > 2 ? -1 : undefined).join(' ');
	return { line: line.trim(), type, schema, name, owner };
}

/** `child -> parents` among `schema.table` names, from the archive's post-data SQL. */
export function foreignKeys(postData: string): Map<string, Set<string>> {
	const edges = new Map<string, Set<string>>();
	const unquote = (name: string): string => name.replace(/"/g, '');
	const pattern = /ALTER TABLE (?:ONLY )?([\w."$]+)\s+ADD CONSTRAINT [^;]*?FOREIGN KEY \([^)]*\) REFERENCES ([\w."$]+)\(/g;
	for (const found of postData.matchAll(pattern)) {
		const child = unquote(found[1]!);
		const parent = unquote(found[2]!);
		if (child !== parent) {
			const parents = edges.get(child) ?? new Set<string>();
			parents.add(parent);
			edges.set(child, parents);
		}
	}
	return edges;
}

export function planRestore(toc: string, postData: string): RestorePlan {
	const platformData = new Map<PlatformProduct, Entry[]>();
	const rest: string[] = [];
	const notes = new Set<string>();
	let skipped = 0;
	for (const raw of toc.split('\n')) {
		const entry = parseEntry(raw);
		if (!entry) {
			continue;
		}
		const { type, schema, name, owner } = entry;
		if (type === 'TABLE DATA' || type === 'SEQUENCE SET') {
			const bookkeeping = /^(schema_migrations|migrations)$/.test(name) && PLATFORM_SCHEMAS.has(schema);
			if (/realtime/.test(schema) || bookkeeping || (schema === 'public' && name === 'spatial_ref_sys')) {
				skipped++;
				continue;
			}
			if (schema === 'cron') {
				skipped++;
				notes.add('Scheduled jobs (pg_cron) are not restored: each names the project it came from. Schedule them again with cron.schedule.');
				continue;
			}
			if (schema === 'push' && name === 'credentials') {
				skipped++;
				notes.add('Push credentials are not restored: they are sealed for the project they came from. Set them again with `snoutdata push credentials set`.');
				continue;
			}
			const product = PRODUCT_SCHEMAS[schema];
			if (product) {
				if (product === 'storage' && name === 'objects') {
					notes.add('Storage objects are restored as rows; the files themselves are not part of an export. Upload them again into this project.');
				}
				platformData.set(product, [...(platformData.get(product) ?? []), entry]);
				continue;
			}
			if (PLATFORM_SCHEMAS.has(schema)) {
				skipped++;
				continue;
			}
			rest.push(entry.line);
			continue;
		}
		const platform =
			// The comments on extensions the pod installs, which only the pod's superuser may write.
			(type === 'COMMENT' && schema === '-' && /^EXTENSION( |$)/.test(name)) ||
			(type === 'SCHEMA' ? PLATFORM_SCHEMAS.has(name) : PLATFORM_SCHEMAS.has(schema)) ||
			PLATFORM_NAMES.test(name) ||
			// The platform's own role on anything else, except a schema an extension the customer
			// chose lives in (SnoutTime's), which the extension needs to exist.
			(PLATFORM_OWNER.test(owner) && type !== 'SCHEMA');
		if (platform) {
			skipped++;
			continue;
		}
		rest.push(entry.line);
	}
	const edges = foreignKeys(postData);
	const order: PlatformProduct[] = ['auth', 'storage', 'push'];
	return {
		platformData: order
			.filter((product) => platformData.has(product))
			.map((product) => {
				const entries = platformData.get(product)!;
				const clear = entries.filter((entry) => entry.type === 'TABLE DATA' && SEEDED.has(`${entry.schema}.${entry.name}`)).map((entry) => `${entry.schema}.${entry.name}`);
				const tables = entries.filter((entry) => entry.type === 'TABLE DATA').map((entry) => `${entry.schema}.${entry.name}`);
				return { product, clear, tables, lines: parentsFirst(entries, edges) };
			}),
		rest,
		products: order.filter((product) => platformData.has(product)),
		skipped,
		notes: [...notes]
	};
}

/** Archive order, except that a child waits for its parent; any cycle keeps archive order. */
function parentsFirst(entries: readonly Entry[], edges: Map<string, Set<string>>): string[] {
	const key = (entry: Entry): string => `${entry.schema}.${entry.name}`;
	const present = new Set(entries.map(key));
	const placed = new Set<string>();
	const out: string[] = [];
	let remaining = [...entries];
	while (remaining.length > 0) {
		const ready = remaining.find((entry) =>
			[...(edges.get(key(entry)) ?? [])].every((parent) => !present.has(parent) || placed.has(parent) || parent === key(entry))
		);
		const next = ready ?? remaining[0]!;
		placed.add(key(next));
		out.push(next.line);
		remaining = remaining.filter((entry) => entry !== next);
	}
	return out;
}
