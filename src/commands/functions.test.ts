import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { splitAssignment } from './secrets.js';
import { collectFunction } from './functions.js';
import { buildBundle, isFunctionName, checkSecretName } from '../shared/snoutpod/control/functions.js';

test('NAME=value splits on the FIRST equals, because a base64 value ends with one', () => {
	// The bug this exists to stop: `KEY=abc==` becoming `abc` and a customer's function
	// getting a truncated credential that fails somewhere else entirely.
	assert.deepEqual(splitAssignment('STRIPE_KEY=sk_live_abc'), { name: 'STRIPE_KEY', value: 'sk_live_abc' });
	assert.deepEqual(splitAssignment('B64=YWJjZA=='), { name: 'B64', value: 'YWJjZA==' });
	assert.deepEqual(splitAssignment('URL=https://x/y?a=1&b=2'), {
		name: 'URL',
		value: 'https://x/y?a=1&b=2'
	});
	// An empty value is a pair, and is refused later with a sentence about what it
	// probably was (a shell that expanded nothing) rather than stored.
	assert.deepEqual(splitAssignment('EMPTY='), { name: 'EMPTY', value: '' });

	// Not a pair at all.
	assert.equal(splitAssignment('STRIPE_KEY'), null);
	assert.equal(splitAssignment('=orphan'), null);
	assert.equal(splitAssignment(''), null);
});

test('the CLI refuses the names the platform sets, before the first request', () => {
	// Checked here as well as on the server, so somebody setting four secrets and getting
	// it wrong on the third is told before two of them are already stored.
	assert.equal(checkSecretName('STRIPE_KEY'), null);
	assert.ok(checkSecretName('UPSTREAM_URL'));
	assert.ok(checkSecretName('SNOUT_ANYTHING'));
	assert.ok(checkSecretName('2FA'));
	assert.ok(checkSecretName('has-a-hyphen'));
});

test('a function name is a URL segment and a directory name, and cannot escape either', () => {
	assert.equal(isFunctionName('send-email'), true);
	assert.equal(isFunctionName('sendEmail'), true);
	assert.equal(isFunctionName('..'), false);
	assert.equal(isFunctionName('a/b'), false);
	assert.equal(isFunctionName('.env'), false);
});

test('a bundle keeps its nested paths, so relative imports inside it still resolve', async () => {
	const bundle = buildBundle({
		entrypoint: 'index.ts',
		files: [
			{ path: 'index.ts', text: "import './lib/util.ts';" },
			{ path: 'lib/util.ts', text: 'export const x = 1;' }
		]
	});
	assert.deepEqual(
		bundle.files.map((file) => file.path),
		['index.ts', 'lib/util.ts']
	);
	// Sorted, so the digest of the same source is the same digest whatever order a
	// directory walk happened to return.
	const other = buildBundle({
		entrypoint: 'index.ts',
		files: [
			{ path: 'lib/util.ts', text: 'export const x = 1;' },
			{ path: 'index.ts', text: "import './lib/util.ts';" }
		]
	});
	assert.deepEqual(bundle.files, other.files);
});

test('an entrypoint that is not one of the files is refused with a sentence', () => {
	assert.throws(
		() => buildBundle({ entrypoint: 'server.ts', files: [{ path: 'index.ts', text: 'x' }] }),
		/is not one of the files/
	);
});

test('a function with no _shared beside it is bundled flat, as it always was', async () => {
	const root = await mkdtemp(join(tmpdir(), 'snoutfn-'));
	await mkdir(join(root, 'hello'));
	await writeFile(join(root, 'hello', 'index.ts'), 'export {};');
	const { entrypoint, files } = await collectFunction('hello', join(root, 'hello'), undefined);
	assert.equal(entrypoint, 'index.ts');
	assert.deepEqual(files.map((file) => file.path), ['index.ts']);
});

test('../_shared is shipped, laid out so the relative import resolves inside the bundle', async () => {
	// The defect: `import '../_shared/cors.ts'` deployed and then failed at the first request,
	// because only the function's own folder was sent.
	const root = await mkdtemp(join(tmpdir(), 'snoutfn-'));
	await mkdir(join(root, 'hello'));
	await mkdir(join(root, '_shared', 'lib'), { recursive: true });
	await writeFile(join(root, 'hello', 'index.ts'), "import '../_shared/cors.ts';");
	await writeFile(join(root, '_shared', 'cors.ts'), 'export const cors = {};');
	await writeFile(join(root, '_shared', 'lib', 'util.ts'), 'export const x = 1;');
	await writeFile(join(root, '_shared', '.env'), 'SECRET=1');
	const { entrypoint, files } = await collectFunction('hello', join(root, 'hello'), undefined);
	assert.equal(entrypoint, 'hello/index.ts');
	const bundle = buildBundle({ entrypoint, files });
	assert.deepEqual(
		bundle.files.map((file) => file.path),
		['_shared/cors.ts', '_shared/lib/util.ts', 'hello/index.ts']
	);
});

test('a named entrypoint moves under the function folder when _shared is shipped', async () => {
	const root = await mkdtemp(join(tmpdir(), 'snoutfn-'));
	await mkdir(join(root, 'hook'));
	await mkdir(join(root, '_shared'));
	await writeFile(join(root, 'hook', 'server.ts'), 'export {};');
	await writeFile(join(root, '_shared', 'a.ts'), 'export {};');
	const { entrypoint } = await collectFunction('hook', join(root, 'hook'), 'server.ts');
	assert.equal(entrypoint, 'hook/server.ts');
});
