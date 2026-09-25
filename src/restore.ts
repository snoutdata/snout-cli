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
