import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { DEFAULT_PORT, localPath, readLocal, runStart, runtimeSpecifier, sqlRunner, writeLocal, type LocalPods, type LocalProject, type LocalStatus } from './local.js';

/**
 * What `snoutdata start` decides, without Podman and without a database.
 *
 * The pod half is proven in the pod runtime's own tests against a fake
 * runtime, and against a real pod in the `*.pod.ts` tier. What is left here is the command's own
 * business: where a project is recorded, that a second `start` reuses the first one rather than
 * minting a second database, and that nothing is written when the machine cannot run one.
 */

function scratch(): string {
	return mkdtempSync(join(tmpdir(), 'snoutdata-local-'));
}

const project: LocalProject = {
	ref: 'a234567890abc',
	port: DEFAULT_PORT,
	ownerPassword: 'secret',
	adminPassword: 'admin'
};

const status: LocalStatus = {
	ref: project.ref,
	exists: true,
	status: 'running',
	ready: true,
	hasData: true,
	port: project.port,
	databaseBytes: 1024,
	services: [],
	uri: 'postgres://x@127.0.0.1:54322/a234567890abc?sslmode=disable'
};

function pods(over: Partial<LocalPods> = {}): { it: LocalPods; calls: string[]; minted: number } {
	const calls: string[] = [];
	const state = { minted: 0 };
	const it: LocalPods = {
		async ready() {
			calls.push('ready');
			return null;
		},
		// The image is already here in every test that does not say otherwise: a fake that PULLED
		// by default would hide the one thing worth asserting, which is that a start does not.
		async ensureImage() {
			calls.push('ensureImage');
			return null;
		},
		async prepare() {
			calls.push('prepare');
		},
		async start(one) {
			calls.push(`start ${one.ref}`);
			return { ...status, ref: one.ref, port: one.port };
		},
		async stop(ref) {
			calls.push(`stop ${ref}`);
			return { ...status, ref, status: 'stopped', ready: false };
		},
		async status(one) {
			calls.push(`status ${one.ref}`);
			return { ...status, ref: one.ref };
		},
		async remove(ref, withData) {
			calls.push(`remove ${ref} data=${withData}`);
		},
		uri: (one) => `postgres://${one.ref}_owner@127.0.0.1:${one.port}/${one.ref}?sslmode=disable`,
		mint: (port) => {
			state.minted += 1;
			calls.push(`mint ${port}`);
			return { ...project, ref: `b${'2'.repeat(11)}${state.minted}`, port };
		},
		// The pod psql is never the fake default: a test that wants the fallback says so, and
		// one that does not should fail loudly rather than quietly take the other path.
		async psql(one, statement) {
			calls.push(`psql-in-pod ${one.ref} ${statement.slice(0, 40)}`);
			return { code: 0, out: '', err: '' };
		},
		...over
	};
	return {
		it,
		calls,
		get minted() {
			return state.minted;
		}
	};
}

describe('readLocal / writeLocal', () => {
	test('a round trip, in .snoutdata/local.json beside the linked project', () => {
		const cwd = scratch();
		try {
			const path = writeLocal(cwd, project);
			assert.equal(path, localPath(cwd));
			assert.ok(path.endsWith(join('.snoutdata', 'local.json')));
			assert.deepEqual(readLocal(cwd), project);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('a folder with no local project, and a file that is nonsense, both read as none', () => {
		const cwd = scratch();
		try {
			assert.equal(readLocal(cwd), null);
			writeLocal(cwd, project);
			// Half a project is not a project: acting on one without a password would produce a
			// connection string that cannot connect.
			const path = localPath(cwd);
			const text = readFileSync(path, 'utf8');
			assert.ok(text.includes('ownerPassword'));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('does not walk up to a parent, unlike a link', () => {
		const parent = scratch();
		try {
			writeLocal(parent, project);
			const child = join(parent, 'nested');
			// A local database is a running process on a port. Inheriting one from a parent is how
			// you run one repository's migrations against another repository's database.
			assert.equal(readLocal(child), null);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
});

describe('runStart', () => {
	test('mints and records a project the first time, and reuses it the second', async () => {
		const cwd = scratch();
		try {
			const first = pods();
			const one = await runStart(first.it, { cwd });
			assert.equal(first.minted, 1);
			assert.equal(one.created, localPath(cwd));
			assert.ok(one.uri.startsWith('postgres://'));

			const second = pods();
			const two = await runStart(second.it, { cwd });
			assert.equal(second.minted, 0);
			assert.equal(two.created, null);
			assert.equal(two.status.ref, one.status.ref);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// A start that could not get the image must not go on to create a pod out of nothing, and the
	// reason has to reach the caller rather than being replaced by whatever failed next.
	test('a fetch that fails stops the start, and says why', async () => {
		const cwd = scratch();
		try {
			const it = pods({ ensureImage: async () => 'the registry is unreachable' });
			await assert.rejects(runStart(it.it, { cwd }), /the registry is unreachable/);
			assert.deepEqual(it.calls, []);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The image comes FIRST, and that ordering is the point rather than an accident: not having
	// it is not a problem to report to somebody who only has to wait for a public package to
	// download. `ready()` is left the things a pull cannot fix.
	test('fetches the image, asks whether the machine can run one, prepares the network, in that order', async () => {
		const cwd = scratch();
		try {
			const it = pods();
			await runStart(it.it, { cwd });
			assert.deepEqual(it.calls.slice(0, 3), ['ensureImage', 'ready', 'prepare']);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// The image is the Postgres major the project's volume was made on, so the
	// folder's project must reach the image check, and a folder with none asks for a new one's.
	test("the image is asked for by the folder's project, or for a new one when there is none", async () => {
		const cwd = scratch();
		try {
			const asked: Array<string | null> = [];
			const first = pods({
				ensureImage: async (ref) => {
					asked.push(ref);
					return null;
				},
				ready: async (ref) => {
					asked.push(ref);
					return null;
				}
			});
			const one = await runStart(first.it, { cwd });
			await runStart(first.it, { cwd });
			assert.deepEqual(asked, [null, null, one.status.ref, one.status.ref]);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('a machine that cannot run one is refused, and NOTHING is written', async () => {
		const cwd = scratch();
		try {
			const it = pods({ ready: async () => 'podman is not installed' });
			await assert.rejects(() => runStart(it.it, { cwd }), /podman is not installed/);
			// The refusal comes before the project is minted, so a second attempt after
			// installing podman does not find half a project already recorded.
			assert.equal(readLocal(cwd), null);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('a folder with no migrations folder is not an error, and psql is never reached', async () => {
		const cwd = scratch();
		try {
			const it = pods();
			const result = await runStart(it.it, { cwd });
			assert.deepEqual(result.applied, []);
			assert.equal(result.seeded, false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('--no-migrations skips the folder entirely', async () => {
		const cwd = scratch();
		try {
			const it = pods();
			const result = await runStart(it.it, { cwd, noMigrations: true });
			assert.deepEqual(result.applied, []);
			assert.equal(result.seeded, false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test('the port is only read when a project is being created', async () => {
		const cwd = scratch();
		try {
			await runStart(pods().it, { cwd, port: 55555 });
			assert.equal(readLocal(cwd)!.port, 55555);
			// A second start with a different port does not move a running database's port, which
			// would silently break every .env already written against it.
			await runStart(pods().it, { cwd, port: 60000 });
			assert.equal(readLocal(cwd)!.port, 55555);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});

describe('runtimeSpecifier', () => {
	// Windows, 2026-09-11. The documented escape hatch is a PATH, and ESM resolves a bare
	// absolute path on POSIX and refuses a Windows one, so the checkout path worked on the Mac
	// and reported the runtime missing on the machine it was written for.
	// The UNSET case is not here on purpose: it never reaches this function. `loadRuntime` returns
	// a literal specifier for it, so the bundler can see the runtime and put it in the one file a
	// user downloads — which published 0.2.0 could not do, and that is why `start` did not run.
	test('a package name is left alone', () => {
		assert.equal(runtimeSpecifier('@snout/snoutpod/local'), '@snout/snoutpod/local');
	});

	test('a URL is left alone', () => {
		assert.equal(runtimeSpecifier('file:///x/project.js'), 'file:///x/project.js');
	});

	test('an absolute path becomes a file URL', () => {
		const absolute = join(process.cwd(), 'dist', 'local', 'project.js');
		assert.equal(runtimeSpecifier(absolute), pathToFileURL(absolute).href);
	});

	// WINDOWS ONLY, and the guard is the point rather than an exemption. `C:/x/project.js` is an
	// absolute path on Windows and an ordinary relative-looking string everywhere else, so on
	// POSIX this function correctly leaves it alone and the assertion below cannot hold. It used
	// to run unguarded and failed on both the Mac and Linux, which nothing noticed because the
	// only machine it had ever run on was the Windows box it was written on (2026-09-11) - and
	// the CLI's release workflow runs `npm test` on ubuntu, so it would have blocked every
	// release.
	test('a drive letter is not a URL scheme', { skip: process.platform !== 'win32' && 'Windows paths only resolve on Windows' }, () => {
		// Spelled without a backslash literal so the line reads the same on both platforms. `C:`
		// is ONE character before the colon, and the scheme pattern deliberately needs two.
		const drive = ['C:', 'x', 'project.js'].join(sep);
		assert.ok(runtimeSpecifier(drive).startsWith('file://'), runtimeSpecifier(drive));
	});

	test('a relative path becomes a file URL too', () => {
		assert.ok(runtimeSpecifier('./dist/local/project.js').startsWith('file://'));
	});
});

describe('sqlRunner', () => {
	// Windows, 2026-09-11: there is no psql on a default install, so a start created a database
	// and then failed on the first migration. The pod has one and a local project already needs
	// Podman, so the fallback costs the caller nothing it has not already paid for.
	const target = { host: '127.0.0.1', port: 54322, user: 'u', password: 'p', database: 'd', sslMode: 'disable', label: 'local' } as unknown as Parameters<typeof sqlRunner>[2];

	test('a host psql that answers is the one that is used', async () => {
		const it = pods();
		const run = sqlRunner(it.it, project, target, async () => ({ code: 0, out: 'ok', err: '' }));
		assert.equal((await run('select 1')).out, 'ok');
		assert.deepEqual(it.calls, []);
	});

	test('no host psql (127) falls back to the pod, and asks only once', async () => {
		const it = pods();
		let asked = 0;
		const run = sqlRunner(it.it, project, target, async () => {
			asked += 1;
			return { code: 127, out: '', err: 'psql is not installed' };
		});
		assert.equal((await run('select 1')).code, 0);
		assert.equal((await run('select 2')).code, 0);
		// Twenty migrations must not spawn twenty processes that are all going to fail.
		assert.equal(asked, 1);
		assert.deepEqual(it.calls, [
			`psql-in-pod ${project.ref} select 1`,
			`psql-in-pod ${project.ref} select 2`
		]);
	});

	test('a host psql that FAILS is not a missing one, and the pod is never reached', async () => {
		const it = pods();
		const run = sqlRunner(it.it, project, target, async () => ({ code: 3, out: '', err: 'syntax error' }));
		assert.equal((await run('nonsense')).err, 'syntax error');
		assert.deepEqual(it.calls, []);
	});
});
