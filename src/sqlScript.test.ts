import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { splitScript } from './sqlScript.js';

function sqls(text: string): string[] {
	return splitScript(text).statements.map((one) => one.sql);
}

test('statements are cut at each semicolon, with the line each starts on', () => {
	const script = splitScript('create table a (id int);\n\n-- a comment; not a statement\ninsert into a values (1);\nselect 1');
	assert.deepEqual(script.statements, [
		{ sql: 'create table a (id int);', line: 1 },
		{ sql: 'insert into a values (1);', line: 4 },
		{ sql: 'select 1', line: 5 }
	]);
	assert.deepEqual(script.metaCommands, []);
});

test('a semicolon inside quotes, identifiers, comments and parentheses does not end a statement', () => {
	assert.deepEqual(
		sqls(
			[
				"insert into t values ('a;b', 'it''s; fine');",
				'select "odd;name", "x""y;" from t;',
				'select /* one; /* nested; */ still; */ 1;',
				"select E'back\\'slash; quote';",
				'create rule r as on insert to t do also (insert into u values (1); insert into u values (2));'
			].join('\n')
		),
		[
			"insert into t values ('a;b', 'it''s; fine');",
			'select "odd;name", "x""y;" from t;',
			'select /* one; /* nested; */ still; */ 1;',
			"select E'back\\'slash; quote';",
			'create rule r as on insert to t do also (insert into u values (1); insert into u values (2));'
		]
	);
});

test('a dollar-quoted body is one statement, whatever its tag; $1 is not a quote', () => {
	const body = `create function f() returns int language plpgsql as $fn$
begin
	perform 1; -- inside
	return $$ not the end; $$::text::int;
end;
$fn$;`;
	assert.deepEqual(sqls(`${body}\nprepare p as select $1;\nselect 2;`), [body, 'prepare p as select $1;', 'select 2;']);
});

test('BEGIN ATOMIC holds its semicolons until END, CASE included, as psql does', () => {
	const fn = `create or replace function add(a int, b int) returns int language sql
begin atomic
	select case when a is null then 0 else a end + b;
	select 1;
end;`;
	const procedure = 'create procedure p() begin atomic insert into t values (1); end;';
	// Outside a routine, BEGIN is a transaction and ends at its own semicolon.
	assert.deepEqual(sqls(`${fn}\n${procedure}\nbegin;\nselect 1;\ncommit;`), [fn, procedure, 'begin;', 'select 1;', 'commit;']);
});

test('a COPY from stdin takes the lines after it, up to \\., as its rows', () => {
	const script = splitScript('copy t (a, b) from stdin;\n1\tx\n2\ty;z\n\\.\nselect 3;\n');
	assert.deepEqual(script.statements, [
		{ sql: 'copy t (a, b) from stdin;', line: 1, copyData: '1\tx\n2\ty;z\n' },
		{ sql: 'select 3;', line: 5 }
	]);
});

test('CRLF files cut the same way, and a COPY row loses only its CR', () => {
	const script = splitScript('select 1;\r\ncopy t from stdin;\r\na\r\n\\.\r\nselect 2;\r\n');
	assert.deepEqual(script.statements, [
		{ sql: 'select 1;', line: 1 },
		{ sql: 'copy t from stdin;', line: 2, copyData: 'a\n' },
		{ sql: 'select 2;', line: 5 }
	]);
});

test('a psql meta-command is found, with its line, and never sent', () => {
	const script = splitScript("select 1;\n\\i other.sql\nselect E'\\\\i not a command';\n  \\set x 1\n");
	assert.deepEqual(script.metaCommands, [
		{ line: 2, text: '\\i other.sql' },
		{ line: 4, text: '\\set x 1' }
	]);
	assert.deepEqual(sqls("select 1;\n\\i other.sql\nselect E'\\\\i not a command';\n"), ['select 1;', "select E'\\\\i not a command';"]);
});

test('comments and blank lines alone are not a statement; a file of them sends nothing', () => {
	assert.deepEqual(sqls('-- nothing\n\n;\n  ;\n'), []);
});

test('an unterminated quote takes the rest of the file, and the server says what is wrong', () => {
	assert.deepEqual(sqls("select 'open;\nselect 2;"), ["select 'open;\nselect 2;"]);
});
