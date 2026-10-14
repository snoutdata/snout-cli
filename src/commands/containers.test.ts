import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildArgs, buildInput } from './containers.js';

test('--dockerfile takes a folder with a Dockerfile, or the Dockerfile itself, and says so when it is neither', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'ct-build-'));
	await assert.rejects(buildInput(folder), /has no Dockerfile in it/);
	await writeFile(join(folder, 'Dockerfile'), 'FROM alpine\n');
	assert.deepEqual(await buildInput(folder), { context: folder, file: null });
	await writeFile(join(folder, 'Dockerfile.prod'), 'FROM alpine\n');
	assert.deepEqual(await buildInput(join(folder, 'Dockerfile.prod')), { context: folder, file: join(folder, 'Dockerfile.prod') });
	await assert.rejects(buildInput(join(folder, 'missing')), /does not exist/);
});

test('the build is linux/arm64 only, one image with no attestation, pushed to the tag, its digest written down', () => {
	const args = buildArgs({ context: './app', file: null, tag: 'r.example/s-fleet/ct/abc:wa', metadataFile: '/tmp/m.json' });
	assert.deepEqual(args, [
		'buildx',
		'build',
		'--platform',
		'linux/arm64',
		'--provenance=false',
		'--tag',
		'r.example/s-fleet/ct/abc:wa',
		'--push',
		'--metadata-file',
		'/tmp/m.json',
		'./app'
	]);
	assert.deepEqual(buildArgs({ context: '.', file: './Dockerfile.prod', tag: 't', metadataFile: 'm' }).slice(-3), ['--file', './Dockerfile.prod', '.']);
});
