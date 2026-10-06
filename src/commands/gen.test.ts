import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
	arrayLiteral,
	generateTypes,
	mergeIntrospections,
	parseIntrospection,
	targetFromUrl,
	toSchema,
	viaControlPlane,
	type RawIntrospection
} from './gen.js';

/**
 * The half of `gen types` that decides, proven without a database.
 *
 * The emitter itself is tested where it lives, in the desktop app's shared code (schema in and
 * TypeScript out, compared exactly). What is left here is the shaping between the
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

describe('viaControlPlane', () => {
	test('answers like psql: the one JSON value, from the one row of the SQL function', async () => {
		const sent: unknown[] = [];
		const result = await viaControlPlane('j40q3yyej14jn', 'select 1', async (fn, body) => {
			sent.push([fn, body]);
			return { rows: [{ json_build_object: '{"tables":[]}' }], columns: ['json_build_object'] };
		});
		assert.deepEqual(result, { code: 0, out: '{"tables":[]}', err: '' });
		assert.deepEqual(sent, [['cloud-project-sql', { ref: 'j40q3yyej14jn', sql: 'select 1' }]]);
	});

	test('a refusal is a failure with its sentence, never an empty schema', async () => {
		const result = await viaControlPlane('j40q3yyej14jn', 'select 1', async () => ({ error: 'This project is paused' }));
		assert.deepEqual(result, { code: 1, out: '', err: 'This project is paused' });
	});
});

describe('a sharded project (snout-lepis)', () => {
	const orders = {
		name: 'orders',
		schema: 'public',
		kind: 'table' as const,
		columns: [
			{ name: 'tenant_id', dataType: 'bigint', nullable: false, default: null, autoIncrement: false },
			{ name: 'id', dataType: 'uuid', nullable: false, default: 'uuidv7()', autoIncrement: false }
		],
		primaryKey: ['tenant_id', 'id'],
		foreignKeys: [],
		indexes: []
	};
	const countries = { ...orders, name: 'countries', primaryKey: ['code'], columns: [{ name: 'code', dataType: 'text', nullable: false, default: null, autoIncrement: false }] };
	const doc: RawIntrospection = {
		tables: [countries, orders],
		routines: [{ name: 'bump', schema: 'public', kind: 'function', returnType: 'integer', parameters: [] }],
		enums: [{ name: 'mood', schema: 'public', values: ['ok'] }]
	};

	test('an answer from every node is one schema: each table, function and enum once', () => {
		const merged = mergeIntrospections([doc, doc, doc]);
		assert.deepEqual(merged.tables.map((t) => t.name), ['countries', 'orders']);
		assert.equal(merged.routines.length, 1);
		assert.equal(merged.enums.length, 1);
		// An overload is a different function, not a copy.
		const overloaded = mergeIntrospections([
			doc,
			{ ...doc, routines: [{ name: 'bump', schema: 'public', kind: 'function', returnType: 'integer', parameters: [{ name: 'n', dataType: 'integer', mode: 'IN' }] }] }
		]);
		assert.equal(overloaded.routines.length, 2);
	});

	test('one JSON document per line is read; anything else is not JSON', () => {
		const text = `${JSON.stringify(doc)}\n${JSON.stringify(doc)}\n`;
		assert.equal(parseIntrospection(text)!.tables.length, 2);
		assert.equal(parseIntrospection(`${JSON.stringify(doc)}\nnot json`), null);
		assert.equal(parseIntrospection('  '), null);
	});

	/** A database that answers the introspection from each of `nodes` and has `relations` in its catalog. */
	function database(nodes: number, relations: unknown[] | null) {
		const asked: string[] = [];
		const sql = async (text: string) => {
			asked.push(text);
			if (text.includes("n.nspname = 'lepis'")) {
				return { code: 0, out: relations ? 'true' : 'false', err: '' };
			}
			if (text.includes('from lepis.relation')) {
				return { code: 0, out: JSON.stringify(relations), err: '' };
			}
			return { code: 0, out: Array.from({ length: nodes }, () => JSON.stringify(doc)).join('\n'), err: '' };
		};
		return { asked, sql };
	}

	test('the types name a sharded table once, and the result says how each table is spread', async () => {
		const db = database(3, [
			{ schema: 'public', table: 'countries', kind: 'reference', keyColumn: null },
			{ schema: 'public', table: 'orders', kind: 'sharded', keyColumn: 'tenant_id' },
			{ schema: 'auth', table: 'users', kind: 'global', keyColumn: null }
		]);
		const result = await generateTypes({ dbUrl: 'postgres://u:p@127.0.0.1:5432/app', sql: db.sql });
		assert.equal(result.tables, 2);
		assert.equal(result.types.match(/\borders: \{/g)?.length, 1);
		assert.equal(result.types.match(/\bcountries: \{/g)?.length, 1);
		// Only the schemas read; `auth` was not asked for.
		assert.deepEqual(result.distribution, [
			{ schema: 'public', table: 'countries', kind: 'reference', keyColumn: null },
			{ schema: 'public', table: 'orders', kind: 'sharded', keyColumn: 'tenant_id' }
		]);
	});

	test('an unsharded database reads no catalog and its types are what they were', async () => {
		const plain = database(1, null);
		const sharded = database(3, [{ schema: 'public', table: 'orders', kind: 'sharded', keyColumn: 'tenant_id' }]);
		const a = await generateTypes({ dbUrl: 'postgres://u:p@127.0.0.1:5432/app', sql: plain.sql });
		assert.equal(a.tables, 2);
		const b = await generateTypes({ dbUrl: 'postgres://u:p@127.0.0.1:5432/app', sql: sharded.sql });
		assert.deepEqual(a.distribution, []);
		assert.ok(!plain.asked.some((text) => text.includes('from lepis.relation')));
		assert.equal(a.types, b.types);
	});

	test('a catalog that cannot be read costs the distribution, never the types', async () => {
		const sql = async (text: string) => {
			if (text.includes("n.nspname = 'lepis'")) {
				return { code: 0, out: 'true', err: '' };
			}
			if (text.includes('from lepis.relation')) {
				return { code: 1, out: '', err: 'permission denied for schema lepis' };
			}
			return { code: 0, out: JSON.stringify(doc), err: '' };
		};
		const result = await generateTypes({ dbUrl: 'postgres://u:p@127.0.0.1:5432/app', sql });
		assert.deepEqual(result.distribution, []);
		assert.equal(result.tables, 2);
	});
});
