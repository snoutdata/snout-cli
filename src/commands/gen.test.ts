import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { arrayLiteral, targetFromUrl, toSchema } from './gen.js';

/**
 * The half of `gen types` that decides, proven without a database.
 *
 * The emitter itself is tested where it lives (`apps/desktop/src/shared/typescriptTypes.test.ts`,
 * schema in and TypeScript out compared exactly). What is left here is the shaping between the
 * catalog's JSON and that emitter's input, and the URL parsing that keeps a password off a
 * command line.
 */

describe('targetFromUrl', () => {
	test('takes a URL apart so the password never becomes an argument', () => {
		const target = targetFromUrl('postgres://a234567890abc_owner:p%40ss@127.0.0.1:54322/a234567890abc?sslmode=disable');
		assert.equal(target.host, '127.0.0.1');
		assert.equal(target.port, 54322);
		assert.equal(target.user, 'a234567890abc_owner');
		// Decoded here, so what reaches PGPASSWORD is the password and not its escaping.
		assert.equal(target.password, 'p@ss');
		assert.equal(target.database, 'a234567890abc');
		assert.equal(target.sslMode, 'disable');
		// And the label a message uses has no password in it.
		assert.ok(!target.label.includes('p@ss'));
	});

	test('defaults the port and the ssl mode, and accepts either scheme', () => {
		const target = targetFromUrl('postgresql://user@db.example.com/app');
		assert.equal(target.port, 5432);
		assert.equal(target.sslMode, 'prefer');
		assert.equal(target.password, '');
	});

	test('refuses anything that is not a postgres URL', () => {
		assert.throws(() => targetFromUrl('not a url'), /not a URL/);
		assert.throws(() => targetFromUrl('mysql://host/db'), /must be a postgres/);
		assert.throws(() => targetFromUrl('postgres://host'), /no database name/);
	});
});

describe('arrayLiteral', () => {
	test('quotes every element, so a schema name from a command line cannot end the literal', () => {
		assert.equal(arrayLiteral(['public']), `'{"public"}'`);
		assert.equal(arrayLiteral(['public', 'auth']), `'{"public","auth"}'`);
		assert.equal(arrayLiteral([`o'brien`]), `'{"o''brien"}'`);
		assert.equal(arrayLiteral(['a"b']), `'{"a\\"b"}'`);
	});
});

describe('toSchema', () => {
	const raw = {
		tables: [
			{
				name: 'posts',
				schema: 'public',
				kind: 'table' as const,
				columns: [
					{ name: 'id', dataType: 'bigint', nullable: false, default: "nextval('posts_id_seq'::regclass)", autoIncrement: true },
					{ name: 'author', dataType: 'uuid', nullable: true, default: null, autoIncrement: false }
				],
				primaryKey: ['id'],
				foreignKeys: [
					{ constraintName: 'posts_author_fkey', columns: ['author'], referencedTable: 'users', referencedColumns: ['id'] }
				],
				indexes: [
					{ name: 'posts_author_idx', unique: false, columns: ['author'] },
					// An index over an EXPRESSION has a 0 in `indkey` and no attribute to join to,
					// so its column list comes back with a null in it.
					{ name: 'posts_lower_idx', unique: true, columns: null }
				]
			}
		],
		routines: [
			{ name: 'bump', schema: 'public', kind: 'function' as const, returnType: 'integer', parameters: [{ name: 'n', dataType: 'integer', mode: 'IN' }] }
		],
		enums: [{ name: 'mood', schema: 'public', values: ['ok', 'sad'] }]
	};

	test('marks the primary key on the columns that are in it', () => {
		const { schema } = toSchema(raw, 'app');
		const table = schema.tables[0]!;
		assert.equal(table.columns.find((one) => one.name === 'id')!.isPrimaryKey, true);
		assert.equal(table.columns.find((one) => one.name === 'author')!.isPrimaryKey, false);
	});

	test('drops an index whose columns could not be resolved rather than half-reporting it', () => {
		const { schema } = toSchema(raw, 'app');
		// The only thing indexes are read for is whether a foreign key is one-to-one, and a
		// partial answer to that would be a wrong one.
		assert.deepEqual(schema.tables[0]!.indexes!.map((one) => one.name), ['posts_author_idx']);
	});

	test('carries routines and enums through, and nulls become empty rather than crashing', () => {
		const { schema, enums } = toSchema(
			{ ...raw, enums: [{ name: 'empty', schema: 'public', values: null }] },
			'app'
		);
		assert.equal(schema.routines!.length, 1);
		assert.equal(schema.routines![0]!.returnType, 'integer');
		assert.deepEqual(enums, [{ name: 'empty', schema: 'public', values: [] }]);
	});

	test('a table with nothing on it produces empty lists, not undefined', () => {
		const { schema } = toSchema(
			{
				tables: [
					{
						name: 't',
						schema: 'public',
						kind: 'table' as const,
						columns: [],
						primaryKey: null,
						foreignKeys: null,
						indexes: null
					}
				],
				routines: [],
				enums: []
			},
			'app'
		);
		assert.deepEqual(schema.tables[0]!.primaryKey, []);
		assert.deepEqual(schema.tables[0]!.foreignKeys, []);
		assert.deepEqual(schema.tables[0]!.indexes, []);
	});
});
