import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findStack, localConnection, localStackFor, parseEnv, readStack, studioListPaths, studioProjects } from './local.js';

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'snoutdata-local-'));
}

/** A stack folder as `snout-stack init` leaves one: compose.yaml and a .env with the keys. */
function stack(ref: string, extra = ''): string {
	const folder = scratch();
	writeFileSync(join(folder, 'compose.yaml'), 'name: snout-stack\n');
	writeFileSync(
		join(folder, '.env'),
		`# made by snout-stack init\nSNOUT_REF=${ref}\nANON_KEY=anon.jwt\nSERVICE_ROLE_KEY="service.jwt"\nPOSTGRES_OWNER_PASSWORD='p@ss w=rd'\nAPI_PORT=8001\nDB_PORT=54342\n${extra}`
	);
	return folder;
}

function studioList(rows: Array<{ name: string; folder: string; ref: string }>): string {
	const path = join(scratch(), 'localProjects.json');
	writeFileSync(path, JSON.stringify({ projects: rows }));
	return path;
}

test('.env is read as Compose reads it: comments skipped, one layer of quotes off, = kept in a value', () => {
	const env = parseEnv("# c\n\nA=1\nB='x=y'\nC=\"q\"\nnot a line\n");
	assert.deepEqual([...env], [['A', '1'], ['B', 'x=y'], ['C', 'q']]);
});

test('a stack folder becomes the owner connection Studio uses, on the loopback and without TLS', () => {
	const read = readStack(stack('abcdefghjkmnp'));
	const c = localConnection(read);
	assert.equal(c.user, 'abcdefghjkmnp_owner');
	assert.equal(c.database, 'abcdefghjkmnp');
	assert.equal(c.port, 54342);
	assert.equal(c.ssl, 'disable');
	assert.equal(c.uri, 'postgresql://abcdefghjkmnp_owner:p%40ss%20w%3Drd@127.0.0.1:54342/abcdefghjkmnp');
	assert.equal(c.anonKey, 'anon.jwt');
	assert.equal(c.serviceRoleKey, 'service.jwt');
	assert.equal(read.apiUrl, 'http://127.0.0.1:8001');
});

test("a stack made by hand with no ports in .env is where compose.yaml puts it: 8000 and 5432", () => {
	const folder = scratch();
	writeFileSync(join(folder, 'compose.yaml'), 'name: snout-stack\n');
	writeFileSync(join(folder, '.env'), 'SNOUT_REF=abcdefghjkmnp\nPOSTGRES_OWNER_PASSWORD=x\n');
	const read = readStack(folder);
	assert.equal(read.dbPort, 5432);
	assert.equal(read.apiUrl, 'http://127.0.0.1:8000');
});

test('API_EXTERNAL_URL wins over the port, and a folder that is not a stack says what it lacks', () => {
	assert.equal(readStack(stack('abcdefghjkmnp', 'API_EXTERNAL_URL=http://localhost:8001/\n')).apiUrl, 'http://localhost:8001');
	assert.throws(() => readStack(scratch()), /not a SnoutData stack folder/);
});

test('link --local finds a project by Studio name, by ref, by folder, or the only one there is', () => {
	const a = stack('aaaaaaaaaaaaa');
	const b = stack('bbbbbbbbbbbbb');
	const listed = studioProjects([studioList([{ name: 'shop', folder: a, ref: 'aaaaaaaaaaaaa' }, { name: 'blog', folder: b, ref: 'bbbbbbbbbbbbb' }])]);
	assert.equal(findStack('shop', scratch(), listed).ref, 'aaaaaaaaaaaaa');
	assert.equal(findStack('bbbbbbbbbbbbb', scratch(), listed).name, 'blog');
	assert.equal(findStack(a, scratch(), listed).name, 'shop');
	assert.throws(() => findStack(undefined, scratch(), listed), /there are 2 local projects; name one: shop, blog/);
	assert.throws(() => findStack('nope', scratch(), listed), /no local project called nope.*The local projects are shop, blog/);
	assert.equal(findStack(undefined, scratch(), listed.slice(0, 1)).ref, 'aaaaaaaaaaaaa');
	// Standing in a stack folder needs no name at all.
	assert.equal(findStack(undefined, b, []).ref, 'bbbbbbbbbbbbb');
});

test('a ref is local only when a linked folder or Studio says so, so every cloud ref goes to the cloud', () => {
	const a = stack('aaaaaaaaaaaaa');
	const listed = [{ name: 'shop', folder: a, ref: 'aaaaaaaaaaaaa' }];
	assert.equal(localStackFor('aaaaaaaaaaaaa', null, listed)?.name, 'shop');
	assert.equal(localStackFor('aaaaaaaaaaaaa', a, [])?.ref, 'aaaaaaaaaaaaa');
	assert.equal(localStackFor('ve9mj4t87y9s1', a, listed), null);
});

test("Studio's list is looked for where Electron keeps userData on each platform", () => {
	assert.equal(studioListPaths({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u')[0], join('C:\\Users\\u\\AppData\\Roaming', 'snoutdata', 'localProjects.json'));
	assert.equal(studioListPaths({}, 'darwin', '/Users/u')[0], join('/Users/u', 'Library', 'Application Support', 'snoutdata', 'localProjects.json'));
	assert.equal(studioListPaths({}, 'linux', '/home/u')[1], join('/home/u', '.config', 'snoutdata-dev', 'localProjects.json'));
});
