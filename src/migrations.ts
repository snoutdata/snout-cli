/**
 * Which migrations still have to run, and every reason to refuse to run any.
 *
 * Pure: it takes the files as names and checksums, and the ledger as names and checksums,
 * and returns a verdict. Nothing here reads a disk or opens a connection, so all the
 * interesting cases are provable without a database — the same split `control/idle.ts`
 * uses on the other side of this product.
 *
 * ## Why this is mostly refusals
 *
 * Applying a migration is the one thing a person does to a database that they cannot take
 * back by doing it again. So the shape is not "work out what to run"; that part is a
 * filter. It is "list every way this folder and this database disagree, and only then say
 * yes".
 *
 * The three disagreements, and each of them is a real morning somebody has lost:
 *
 *  * **A file that has changed since it ran.** The database and the folder now disagree
 *    about what actually happened to the schema, and no amount of running things can
 *    reconcile them: the old statements already ran and the new ones never will. There is
 *    no override for this, deliberately. The fix is a NEW migration, which is the honest
 *    thing the tool should be pushing you towards.
 *  * **A file that has gone.** Usually a rename, and a rename is the dangerous one: the
 *    old name stays in the ledger while the new name looks brand new, so the same SQL runs
 *    a second time. Refusing on a missing file is what catches it, which is why this is a
 *    refusal and not a shrug about tidying up.
 *  * **A new file that sorts BEFORE one already applied.** Two branches merge and `003`
 *    lands after `004` ran. Applied out of order, the database ends up in a state no fresh
 *    database will ever be in, and that difference is invisible until the first deploy
 *    from scratch. This one HAS an override, because merging branches is normal and
 *    sometimes the order genuinely does not matter, but it is a thing you say rather than
 *    a thing that happens quietly.
 *
 * ## The order
 *
 * Byte-wise on the file name, which is `ls | sort` and is what `apps/cloud/sql/apply.sh`
 * does for this project's own schema. Zero-padded numeric prefixes (`001-`, `002-`) are
 * the convention that makes that correct, and the reason to keep them.
 */

/** A `.sql` file in the migrations folder. */
export interface MigrationFile {
	/** The file name, which is the migration's identity forever. Not the path. */
	readonly name: string;
	/** SHA-256 of the file's bytes, hex. What makes "it changed" answerable. */
	readonly checksum: string;
}

/** A row of `_snoutdata_migrations`: something that has already run. */
export interface AppliedMigration {
	readonly name: string;
	readonly checksum: string;
}

export type MigrationRefusal = 'changed' | 'missing' | 'out-of-order';

export interface MigrationProblem {
	readonly code: MigrationRefusal;
	readonly name: string;
	readonly reason: string;
}

export type MigrationPlan =
	| { ok: true; pending: MigrationFile[] }
	| { ok: false; problems: MigrationProblem[] };

export interface PlanOptions {
	/** Allow a new file that sorts before one already applied. Off unless somebody says so. */
	readonly outOfOrder?: boolean;
}

/** The order files run in: byte-wise by name, so `002` follows `001` and `010` follows `009`. */
export function migrationOrder(files: readonly MigrationFile[]): MigrationFile[] {
	return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * What to run, or why nothing should.
 *
 * Every problem is collected rather than thrown at the first one: somebody who has three
 * changed files wants to see three, not to fix one and run again to find the next.
 */
export function planMigrations(
	files: readonly MigrationFile[],
	applied: readonly AppliedMigration[],
	options: PlanOptions = {}
): MigrationPlan {
	const ordered = migrationOrder(files);
	const onDisk = new Map(ordered.map((file) => [file.name, file]));
	const problems: MigrationProblem[] = [];

	for (const done of applied) {
		const file = onDisk.get(done.name);
		if (!file) {
			problems.push({
				code: 'missing',
				name: done.name,
				reason: `${done.name} has already run against this database and is no longer in the folder. If it was renamed, the old name is still recorded and the new one looks new, so its statements would run a second time.`
			});
			continue;
		}
		if (file.checksum !== done.checksum) {
			problems.push({
				code: 'changed',
				name: done.name,
				reason: `${done.name} has changed since it ran. The database and this folder no longer agree about what happened to the schema, and running anything cannot fix that. Put the change in a new migration instead.`
			});
		}
	}

	// The high-water mark, by NAME rather than by time: the ledger records when a thing
	// ran, and what matters here is where it sits in the order.
	const highWater = applied.map((one) => one.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[applied.length - 1];
	const done = new Set(applied.map((one) => one.name));
	const pending: MigrationFile[] = [];

	for (const file of ordered) {
		if (done.has(file.name)) {
			continue;
		}
		if (highWater !== undefined && file.name < highWater && !options.outOfOrder) {
			problems.push({
				code: 'out-of-order',
				name: file.name,
				reason: `${file.name} sorts before ${highWater}, which has already run. Applying it now gives this database a history no fresh database will have. Pass --out-of-order if that is what you mean.`
			});
			continue;
		}
		pending.push(file);
	}

	if (problems.length > 0) {
		return { ok: false, problems };
	}
	return { ok: true, pending };
}

/**
 * Does this migration want to run inside a transaction?
 *
 * Yes, unless it says otherwise. Wrapping is the safe default: a migration that fails
 * half way leaves nothing behind, and the ledger row is written in the SAME transaction
 * so a database can never believe something ran that did not.
 *
 * The escape exists because a few statements genuinely cannot be wrapped, and
 * `CREATE INDEX CONCURRENTLY` is the one everybody meets. A marker on a line of its own,
 * anywhere in the file, rather than a flag on the command: it is a property of the
 * migration and it should travel with it.
 *
 *     -- snoutdata:no-transaction
 *
 * Such a file gets no ledger row until it finishes, so an interrupted one is re-run and
 * has to be written to tolerate that. Said out loud by `db push` before it runs one.
 */
export function wantsTransaction(sql: string): boolean {
	return !/^[\t ]*--[\t ]*snoutdata:no-transaction[\t ]*$/im.test(sql);
}
