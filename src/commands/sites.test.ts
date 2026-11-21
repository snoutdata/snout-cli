import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { manifestOf, readSite } from './sites.js';

test('a site folder is read without dotfiles or node_modules, paths with forward slashes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'sites-'));
	try {
		await mkdir(join(root, 'assets'), { recursive: true });
		await mkdir(join(root, 'node_modules', 'x'), { recursive: true });
		await mkdir(join(root, '.git'), { recursive: true });
		await writeFile(join(root, 'index.html'), '<h1>hi</h1>');
		await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
		await writeFile(join(root, 'assets', 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
		await writeFile(join(root, '.env'), 'SECRET=1');
		await writeFile(join(root, 'node_modules', 'x', 'i.js'), '');
		await writeFile(join(root, '.git', 'HEAD'), '');
		const files = await readSite(root);
		assert.deepEqual(files.map((f) => f.path), ['assets/app.js', 'assets/logo.png', 'index.html']);
		const manifest = manifestOf(files);
		assert.equal(manifest[1]?.size, 6);
		assert.equal(manifest[2]?.sha256, 'e7fbb6fbbf4ce294913eb62b53ff03a7546649cfdc0d824d9e3a2b4541502f7f');
		assert.match(manifest[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
