import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	authPath,
	clearAuth,
	currentProfile,
	findLink,
	initStart,
	isExpired,
	readAuth,
	readStoredAuth,
	resolveProfile,
	resolveRef,
	storedProfiles,
	useProfile,
	writeAuth,
	writeLink
} from './config.js';
import { writeEnv } from './commands/db.js';

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'snoutdata-cli-'));
}

test('a token is written 0600, because it is a token', () => {
	const home = scratch();
	writeAuth({ accessToken: 'abc' }, home);
	// Windows has no POSIX mode: `chmod` there sets the read-only bit and nothing else,
	// so the file comes back 0666 and asserting otherwise is asserting about Node, not
	// about us. The write still happens; it is the permission that cannot.
	if (process.platform !== 'win32') {
		assert.equal(statSync(authPath(home)).mode & 0o777, 0o600);
	}
	assert.equal(readAuth(home)?.accessToken, 'abc');
	clearAuth(home);
	assert.equal(readAuth(home), null);
});

test('SNOUTDATA_ACCESS_TOKEN wins over a stored one', () => {
	// So a script does not behave differently depending on who is logged in on the box.
	const home = scratch();
	writeAuth({ accessToken: 'stored' }, home);
	process.env.SNOUTDATA_ACCESS_TOKEN = 'from-the-environment';
	try {
		assert.equal(readAuth(home)?.accessToken, 'from-the-environment');
	} finally {
		delete process.env.SNOUTDATA_ACCESS_TOKEN;
	}
});

test('a corrupt auth file reads as signed out rather than crashing', () => {
	const home = scratch();
	mkdirSync(join(home, '.snoutdata'), { recursive: true });
	writeFileSync(authPath(home), 'not json');
	assert.equal(readAuth(home), null);
});

test('a token about to expire counts as expired, so it is refreshed before the call', () => {
	const now = 1_800_000_000_000;
	assert.equal(isExpired({ accessToken: 'x', expiresAt: now / 1000 + 3600 }, now), false);
	assert.equal(isExpired({ accessToken: 'x', expiresAt: now / 1000 + 30 }, now), true);
	// No expiry known (an environment token) is never refreshed.
	assert.equal(isExpired({ accessToken: 'x' }, now), false);
});

test('a link is found from a subdirectory, the way git finds .git', () => {
	const root = scratch();
	const deep = join(root, 'a', 'b', 'c');
	mkdirSync(deep, { recursive: true });
	writeLink(root, { ref: 'b7kq2m9xt4rvz' });
	assert.equal(findLink(deep)?.ref, 'b7kq2m9xt4rvz');
	assert.equal(findLink(root)?.ref, 'b7kq2m9xt4rvz');
});

test('a broken link in a parent does not hide a good one further up', () => {
	const root = scratch();
	const middle = join(root, 'middle');
	const leaf = join(middle, 'leaf');
	mkdirSync(leaf, { recursive: true });
	writeLink(root, { ref: 'b7kq2m9xt4rvz' });
	mkdirSync(join(middle, '.snoutdata'), { recursive: true });
	writeFileSync(join(middle, '.snoutdata', 'project.json'), '{oops');
	assert.equal(findLink(leaf)?.ref, 'b7kq2m9xt4rvz');
});

test('a project comes from the flag, then the environment, then the link', () => {
	const root = scratch();
	writeLink(root, { ref: 'linked7xt4rvz' });
	assert.equal(resolveRef({ flag: 'flagged9xt4rv', cwd: root, environment: {} }), 'flagged9xt4rv');
	assert.equal(
		resolveRef({ cwd: root, environment: { SNOUTDATA_PROJECT: 'envvar09xt4rv' } }),
		'envvar09xt4rv'
	);
	assert.equal(resolveRef({ cwd: root, environment: {} }), 'linked7xt4rvz');
	assert.equal(resolveRef({ cwd: scratch(), environment: {} }), null);
});

test('init --ref in a new folder links it, and only a linked folder is called linked', () => {
	// `init --ref` used to read the flag as "this folder is linked", say so, write nothing,
	// and leave the next `db url` there with no project.
	const fresh = scratch();
	assert.deepEqual(initStart({ flag: 'flagged9xt4rv', cwd: fresh, environment: {} }), { kind: 'link', ref: 'flagged9xt4rv', replaces: null });
	assert.deepEqual(initStart({ cwd: fresh, environment: {} }), { kind: 'create' });

	const linked = scratch();
	const below = join(linked, 'src');
	mkdirSync(below, { recursive: true });
	writeLink(linked, { ref: 'linked7xt4rvz' });
	assert.deepEqual(initStart({ cwd: below, environment: {} }), { kind: 'linked', ref: 'linked7xt4rvz' });
	assert.deepEqual(initStart({ flag: 'linked7xt4rvz', cwd: below, environment: {} }), { kind: 'linked', ref: 'linked7xt4rvz' });
	// A different ref is a relink, and says what it replaces.
	assert.deepEqual(initStart({ flag: 'flagged9xt4rv', cwd: below, environment: {} }), { kind: 'link', ref: 'flagged9xt4rv', replaces: 'linked7xt4rvz' });

	// The environment names a project without linking anything.
	assert.deepEqual(initStart({ cwd: fresh, environment: { SNOUTDATA_PROJECT: 'envvar09xt4rv' } }), { kind: 'environment', ref: 'envvar09xt4rv' });
	assert.deepEqual(initStart({ cwd: below, environment: { SNOUTDATA_PROJECT: 'linked7xt4rvz' } }), { kind: 'linked', ref: 'linked7xt4rvz' });
});

test('DATABASE_URL is replaced rather than duplicated', () => {
	// Two of them in one file is an hour of somebody's life: which wins depends on the
	// loader, and neither is obviously wrong when you read it.
	const directory = scratch();
	writeEnv(directory, 'postgres://one');
	const second = writeEnv(directory, 'postgres://two');
	assert.equal(second.replaced, true);
	const contents = readFileSync(second.path, 'utf8');
	assert.equal(contents.match(/DATABASE_URL=/g)?.length, 1);
	assert.match(contents, /postgres:\/\/two/);
});

test('in a git repository .env is added to .gitignore once, and a covering line is respected', () => {
	const directory = scratch();
	mkdirSync(join(directory, '.git'));
	assert.equal(writeEnv(directory, 'postgres://one').ignored, true);
	assert.equal(writeEnv(directory, 'postgres://two').ignored, false);
	assert.equal(readFileSync(join(directory, '.gitignore'), 'utf8'), '.env\n');
	const other = scratch();
	mkdirSync(join(other, '.git'));
	writeFileSync(join(other, '.gitignore'), 'node_modules\n.env*');
	assert.equal(writeEnv(other, 'postgres://x').ignored, false);
	const outside = scratch();
	assert.equal(writeEnv(outside, 'postgres://x').ignored, false);
	assert.equal(existsSync(join(outside, '.gitignore')), false);
});

test('an existing .env keeps what it had', () => {
	const directory = scratch();
	writeFileSync(join(directory, '.env'), 'OTHER=1\n');
	writeEnv(directory, 'postgres://x');
	const contents = readFileSync(join(directory, '.env'), 'utf8');
	assert.match(contents, /OTHER=1/);
	assert.match(contents, /DATABASE_URL=postgres:\/\/x/);
});

test('a .env the CLI creates is readable by this user only', { skip: process.platform === 'win32' }, () => {
	const directory = scratch();
	const { path } = writeEnv(directory, 'postgres://x');
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('each profile keeps its own session, and the default is auth.json as before', () => {
	const home = scratch();
	writeAuth({ accessToken: 'mine', email: 'me@positrondb.com' }, home);
	writeAuth({ accessToken: 'theirs', email: 'ops@joeloliver.com' }, home, 'acme');
	assert.equal(authPath(home), join(home, '.snoutdata', 'auth.json'));
	assert.equal(authPath(home, 'acme'), join(home, '.snoutdata', 'auth.acme.json'));
	assert.equal(readStoredAuth(home)?.accessToken, 'mine');
	assert.equal(readStoredAuth(home, 'acme')?.accessToken, 'theirs');
	if (process.platform !== 'win32') {
		assert.equal(statSync(authPath(home, 'acme')).mode & 0o777, 0o600);
	}
	// Signing one out leaves the other signed in.
	clearAuth(home, 'acme');
	assert.equal(readStoredAuth(home, 'acme'), null);
	assert.equal(readStoredAuth(home)?.accessToken, 'mine');
});

test('a renewed session is written back to the profile it was read from', () => {
	// The one way profiles could sign somebody in as the wrong account: `currentToken` reads,
	// renews and writes with no profile argument, so the run's profile has to carry it.
	const home = scratch();
	writeAuth({ accessToken: 'default-old', refreshToken: 'd' }, home, 'default');
	writeAuth({ accessToken: 'acme-old', refreshToken: 'a' }, home, 'acme');
	useProfile('acme');
	try {
		assert.equal(currentProfile(), 'acme');
		const read = readAuth(home);
		assert.equal(read?.accessToken, 'acme-old');
		writeAuth({ ...read!, accessToken: 'acme-new' }, home);
	} finally {
		useProfile('default');
	}
	assert.equal(readStoredAuth(home, 'acme')?.accessToken, 'acme-new');
	assert.equal(readStoredAuth(home, 'default')?.accessToken, 'default-old');
});

test('a profile comes from the flag, then SNOUTDATA_PROFILE, then the link, then the default', () => {
	const root = scratch();
	writeLink(root, { ref: 'linked7xt4rvz' }, 'linked');
	assert.deepEqual(resolveProfile({ flag: 'flagged', cwd: root, environment: { SNOUTDATA_PROFILE: 'env' } }), { name: 'flagged', from: 'flag' });
	assert.deepEqual(resolveProfile({ cwd: root, environment: { SNOUTDATA_PROFILE: 'env' } }), { name: 'env', from: 'environment' });
	assert.deepEqual(resolveProfile({ cwd: root, environment: {} }), { name: 'linked', from: 'link' });
	assert.deepEqual(resolveProfile({ cwd: scratch(), environment: {} }), { name: 'default', from: 'default' });
});

test('a profile name that is not a plain word is refused, since it becomes a file name', () => {
	for (const bad of ['', '../escape', 'a/b', 'has space', '-leading', 'x'.repeat(41)]) {
		assert.throws(() => resolveProfile({ flag: bad, cwd: scratch(), environment: {} }), /not a profile name/, bad);
		assert.throws(() => useProfile(bad), /not a profile name/, bad);
	}
	assert.equal(currentProfile(), 'default');
});

test('a link records a named profile and leaves the default unwritten', () => {
	const named = scratch();
	writeLink(named, { ref: 'b7kq2m9xt4rvz', name: 'bamboo' }, 'solarpanda');
	assert.deepEqual(JSON.parse(readFileSync(join(named, '.snoutdata', 'project.json'), 'utf8')), {
		ref: 'b7kq2m9xt4rvz',
		name: 'bamboo',
		profile: 'solarpanda'
	});
	assert.equal(findLink(named)?.profile, 'solarpanda');

	// Relinked as the default: the profile goes, so the folder no longer forces one.
	writeLink(named, { ref: 'b7kq2m9xt4rvz', profile: 'solarpanda' }, 'default');
	assert.deepEqual(JSON.parse(readFileSync(join(named, '.snoutdata', 'project.json'), 'utf8')), { ref: 'b7kq2m9xt4rvz' });
	assert.equal(findLink(named)?.profile, undefined);
});

test('the stored profiles are listed default first, and stray files are not profiles', () => {
	const home = scratch();
	assert.deepEqual(storedProfiles(home), []);
	writeAuth({ accessToken: 'z' }, home, 'zeta');
	writeAuth({ accessToken: 'a' }, home, 'acme');
	writeAuth({ accessToken: 'd' }, home);
	writeFileSync(join(home, '.snoutdata', 'auth.json.bak'), '{}');
	writeFileSync(join(home, '.snoutdata', 'auth..json'), '{}');
	assert.deepEqual(storedProfiles(home), ['default', 'acme', 'zeta']);
});
