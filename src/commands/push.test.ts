import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PgServerError } from '../pgWire.js';
import { runPush, type PushHost, type SqlSession } from './push.js';

const REF = 'b7kq2m9xt4rvz';

/** A database that remembers what each connection was sent, and fails where it is told to. */
function fakeDatabase(options: { ledger?: { name: string; checksum: string }[]; failOn?: RegExp } = {}) {
	const connections: string[][] = [];
	const ledger = [...(options.ledger ?? [])];
	const copies: string[] = [];
	const host: PushHost = {
		connection: async () => ({ host: 'h', port: 5432, database: 'd', user: 'u', password: 'p', ssl: 'require', wakesInstantly: true }),
		open: async () => {
			const sent: string[] = [];
			connections.push(sent);
			const session: SqlSession = {
				query: async (sql, copyData) => {
					sent.push(sql);
					if (copyData !== undefined) {
						copies.push(copyData);
					}
					if (options.failOn?.test(sql)) {
						throw new PgServerError(new Map([['V', 'ERROR'], ['C', '42601'], ['M', 'syntax error at or near "nope"'], ['P', '1']]));
					}
					if (sql.startsWith('select name, checksum')) {
						return { rows: ledger.map((row) => [row.name, row.checksum]), command: `SELECT ${ledger.length}` };
					}
					return { rows: [], command: 'OK' };
				},
				close: () => {}
			};
			return session;
		}
	};
	return { host, connections, copies };
}

function folder(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), 'push-'));
	const migrations = join(dir, 'migrations');
	mkdirSync(migrations);
	for (const [name, sql] of Object.entries(files)) {
		writeFileSync(join(migrations, name), sql);
	}
	return migrations;
}

function sha(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

test('each migration runs on its own connection, a statement at a time, inside begin and commit with its ledger row', async () => {
	const dir = folder({ '001-a.sql': 'create table a (id int);\ninsert into a values (1);\n', '002-b.sql': 'create table b (id int)' });
	const db = fakeDatabase();
	const result = await runPush(REF, { dir }, () => {}, db.host);
	assert.equal(result.ok, true);
	assert.deepEqual(result.applied, ['001-a.sql', '002-b.sql']);
	// The ledger read, then one connection per migration.
	assert.equal(db.connections.length, 3);
	assert.match(db.connections[0]![0]!, /create table if not exists _snoutdata_migrations/);
	assert.deepEqual(db.connections[1], [
		'begin;',
		'create table a (id int);',
		'insert into a values (1);',
		`insert into _snoutdata_migrations (name, checksum) values ('001-a.sql', '${sha('create table a (id int);\ninsert into a values (1);\n')}');`,
		'commit;'
	]);
	// A last statement with no semicolon is still its own statement.
	assert.equal(db.connections[2]![1], 'create table b (id int)');
});

test('a no-transaction file runs bare, its ledger row last, and is said first', async () => {
	const sql = '-- snoutdata:no-transaction\ncreate index concurrently i on a (id);\n';
	const dir = folder({ '001-a.sql': sql });
	const db = fakeDatabase();
	const notes: string[] = [];
	const result = await runPush(REF, { dir }, (note) => notes.push(note), db.host);
	assert.equal(result.ok, true);
	// A `--` comment before a statement is not sent, as psql does not send it.
	assert.deepEqual(db.connections[1], [
		'create index concurrently i on a (id);',
		`insert into _snoutdata_migrations (name, checksum) values ('001-a.sql', '${sha(sql)}');`
	]);
	assert.ok(notes.some((note) => /outside a transaction/.test(note)));
});

test('the first failing statement stops the push, names its file and line, and nothing after it is tried', async () => {
	const dir = folder({ '001-a.sql': 'select 1;\n\nnope;\nselect 2;\n', '002-b.sql': 'select 3;' });
	const db = fakeDatabase({ failOn: /^nope/ });
	const result = await runPush(REF, { dir }, () => {}, db.host);
	assert.equal(result.ok, false);
	assert.equal(result.failed, '001-a.sql');
	assert.deepEqual(result.applied, []);
	assert.match(result.error ?? '', /^001-a\.sql:3: ERROR: {2}syntax error at or near "nope"\nLINE 3: nope;/);
	// No commit, no ledger row, no second file.
	assert.deepEqual(db.connections[1], ['begin;', 'select 1;', 'nope;']);
	assert.equal(db.connections.length, 2);
	assert.ok(result.notes?.some((note) => /nothing from it is in the database/.test(note)));
});

test('the refusals are the same: changed, missing, out of order', async () => {
	const dir = folder({ '001-a.sql': 'select 1;', '002-b.sql': 'select 2;' });
	const db = fakeDatabase({ ledger: [{ name: '001-a.sql', checksum: 'not it' }, { name: '000-gone.sql', checksum: 'x' }, { name: '003-c.sql', checksum: 'y' }] });
	const result = await runPush(REF, { dir }, () => {}, db.host);
	assert.equal(result.ok, false);
	assert.deepEqual(result.problems?.map((problem) => problem.code).sort(), ['changed', 'missing', 'missing', 'out-of-order']);
	assert.equal(db.connections.length, 1, 'only the ledger was read');
});

test('a dry run reads the ledger and runs nothing', async () => {
	const dir = folder({ '001-a.sql': 'select 1;', '002-b.sql': 'select 2;' });
	const db = fakeDatabase({ ledger: [{ name: '001-a.sql', checksum: sha('select 1;') }] });
	const result = await runPush(REF, { dir, dryRun: true }, () => {}, db.host);
	assert.deepEqual(result.wouldApply, ['002-b.sql']);
	assert.equal(db.connections.length, 1);
});

test('a psql command is refused before anything runs, dry run or not', async () => {
	const dir = folder({ '001-a.sql': 'select 1;', '002-b.sql': 'select 2;\n\\i seed.sql\n' });
	for (const dryRun of [false, true]) {
		const db = fakeDatabase();
		const result = await runPush(REF, { dir, dryRun }, () => {}, db.host);
		assert.equal(result.ok, false);
		assert.deepEqual(result.applied, []);
		assert.equal(result.problems?.[0]?.code, 'psql-command');
		assert.match(result.problems?.[0]?.reason ?? '', /002-b\.sql line 2 is a psql command \(\\i seed\.sql\)/);
		assert.equal(db.connections.length, 1, 'only the ledger was read');
	}
});

test('a COPY in a migration is sent its rows', async () => {
	const dir = folder({ '001-a.sql': 'copy a (id) from stdin;\n1\n2\n\\.\nselect 1;\n' });
	const db = fakeDatabase();
	const result = await runPush(REF, { dir }, () => {}, db.host);
	assert.equal(result.ok, true);
	assert.deepEqual(db.copies, ['1\n2\n']);
	assert.deepEqual(db.connections[1]!.slice(1, 3), ['copy a (id) from stdin;', 'select 1;']);
});
