import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { migrationOrder, planMigrations, wantsTransaction } from './migrations.js';
import type { AppliedMigration, MigrationFile } from './migrations.js';

function file(name: string, checksum = `sum-${name}`): MigrationFile {
	return { name, checksum };
}

function ran(name: string, checksum = `sum-${name}`): AppliedMigration {
	return { name, checksum };
}

function codes(plan: ReturnType<typeof planMigrations>): string[] {
	return plan.ok ? [] : plan.problems.map((problem) => `${problem.code}:${problem.name}`);
}

function names(plan: ReturnType<typeof planMigrations>): string[] {
	return plan.ok ? plan.pending.map((one) => one.name) : [];
}

test('an empty database runs everything, in name order', () => {
	const plan = planMigrations([file('002-b.sql'), file('001-a.sql'), file('010-j.sql'), file('009-i.sql')], []);
	assert.deepEqual(names(plan), ['001-a.sql', '002-b.sql', '009-i.sql', '010-j.sql']);
});

test('what has run is skipped, and only what has not is pending', () => {
	const plan = planMigrations([file('001-a.sql'), file('002-b.sql'), file('003-c.sql')], [ran('001-a.sql'), ran('002-b.sql')]);
	assert.deepEqual(names(plan), ['003-c.sql']);
});

test('running it twice does nothing the second time', () => {
	const files = [file('001-a.sql'), file('002-b.sql')];
	const applied = files.map((one) => ran(one.name, one.checksum));
	assert.deepEqual(names(planMigrations(files, applied)), []);
});

test('a file that changed after it ran is refused, and there is no way to say "anyway"', () => {
	// The database and the folder now disagree about what happened to the schema, and the
	// old statements have already run. Nothing this tool does can reconcile them.
	const plan = planMigrations([file('001-a.sql', 'edited')], [ran('001-a.sql', 'original')]);
	assert.deepEqual(codes(plan), ['changed:001-a.sql']);
	assert.equal(planMigrations([file('001-a.sql', 'edited')], [ran('001-a.sql', 'original')], { outOfOrder: true }).ok, false);
});

test('a file that has gone is refused, because a rename would run the same SQL twice', () => {
	// The dangerous shape: 001-a.sql is in the ledger and gone from disk, and
	// 001-renamed.sql looks brand new. Both problems are reported, and the rename is
	// exactly why the missing one is a refusal rather than a shrug.
	const plan = planMigrations([file('001-renamed.sql')], [ran('001-a.sql')]);
	assert.deepEqual(codes(plan), ['missing:001-a.sql']);
});

test('a new file that sorts before one already applied is refused by default', () => {
	// Two branches merge: 003 lands after 004 ran. Applied now, this database ends up in a
	// state no fresh database is ever in, and nothing says so until the first deploy from
	// scratch.
	const files = [file('003-late.sql'), file('004-early.sql')];
	const plan = planMigrations(files, [ran('004-early.sql')]);
	assert.deepEqual(codes(plan), ['out-of-order:003-late.sql']);
	assert.match(plan.ok ? '' : plan.problems[0]!.reason, /--out-of-order/);
});

test('and runs when somebody says that is what they mean', () => {
	const files = [file('003-late.sql'), file('004-early.sql')];
	assert.deepEqual(names(planMigrations(files, [ran('004-early.sql')], { outOfOrder: true })), ['003-late.sql']);
});

test('a new file after the last applied one is ordinary, not out of order', () => {
	assert.deepEqual(names(planMigrations([file('001-a.sql'), file('002-b.sql')], [ran('001-a.sql')])), ['002-b.sql']);
});

test('every problem is reported, not just the first', () => {
	// Somebody with three broken things wants to see three. Fixing one to discover the next
	// is how a two-minute job becomes an afternoon.
	const plan = planMigrations(
		[file('001-a.sql', 'edited'), file('002-b.sql', 'edited'), file('003-c.sql')],
		[ran('001-a.sql', 'original'), ran('002-b.sql', 'original'), ran('004-d.sql')]
	);
	assert.deepEqual(codes(plan).sort(), ['changed:001-a.sql', 'changed:002-b.sql', 'missing:004-d.sql', 'out-of-order:003-c.sql'].sort());
});

test('the high-water mark is the LAST name in order, not the last row we were handed', () => {
	// The ledger comes back in whatever order the database felt like. Reading the mark off
	// the end of that list would make the out-of-order check depend on a sort nobody
	// promised.
	const plan = planMigrations(
		[file('001-a.sql'), file('002-b.sql'), file('003-c.sql')],
		[ran('003-c.sql'), ran('001-a.sql')]
	);
	assert.deepEqual(codes(plan), ['out-of-order:002-b.sql']);
});

test('order is byte-wise, which is why the names are zero-padded', () => {
	assert.deepEqual(
		migrationOrder([file('10-j.sql'), file('9-i.sql'), file('2-b.sql')]).map((one) => one.name),
		// Unpadded names sort wrong, and this test exists to say so out loud rather than to
		// bless it: 10 before 9 is what `ls | sort` does and what this will do.
		['10-j.sql', '2-b.sql', '9-i.sql']
	);
});

test('a migration runs in a transaction unless it says otherwise', () => {
	assert.equal(wantsTransaction('create table t (id int);'), true);
	assert.equal(wantsTransaction('-- snoutdata:no-transaction\ncreate index concurrently i on t (id);'), false);
	assert.equal(wantsTransaction('create table t (id int);\n--snoutdata:no-transaction\n'), false);
	assert.equal(wantsTransaction('  --  snoutdata:no-transaction  \n'), false);
	// Not a marker: it has to be a line of its own, or a sentence about the feature in a
	// comment would silently turn wrapping off.
	assert.equal(wantsTransaction('-- this file is snoutdata:no-transaction safe, but wrap it\n'), true);
	assert.equal(wantsTransaction("select 'snoutdata:no-transaction';"), true);
});
