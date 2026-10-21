import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildAndUpload, buildArgs, buildInput, deployDockerfile, uploadFailure, withoutCloudInternals, type DockerfileIo } from './containers.js';

test('--dockerfile takes a folder with a Dockerfile, or the Dockerfile itself, and says so when it is neither', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'ct-build-'));
	await assert.rejects(buildInput(folder), /has no Dockerfile in it/);
	await writeFile(join(folder, 'Dockerfile'), 'FROM alpine\n');
	assert.deepEqual(await buildInput(folder), { context: folder, file: null });
	await writeFile(join(folder, 'Dockerfile.prod'), 'FROM alpine\n');
	assert.deepEqual(await buildInput(join(folder, 'Dockerfile.prod')), { context: folder, file: join(folder, 'Dockerfile.prod') });
	await assert.rejects(buildInput(join(folder, 'missing')), /does not exist/);
});

test('the build is linux/arm64 only, one image with no attestation, written to an OCI archive and pushed nowhere', () => {
	const args = buildArgs({ context: './app', file: null, archive: '/tmp/b/image.tar' });
	assert.deepEqual(args, ['buildx', 'build', '--platform', 'linux/arm64', '--provenance=false', '--output', 'type=oci,dest=/tmp/b/image.tar', './app']);
	assert.ok(!args.includes('--push'));
	assert.deepEqual(buildArgs({ context: '.', file: './Dockerfile.prod', archive: 'a' }).slice(-3), ['--file', './Dockerfile.prod', '.']);
});

const DIGEST = `sha256:${'c'.repeat(64)}`;
const TICKET_URL = `https://r1abcdefghijk.api.snoutdata.com/containers/v1/_upload/${'t'.repeat(43)}`;
/** What a leaked infrastructure name would look like; none of it may reach the person. */
const LEAKY = /amazonaws|dkr\.ecr|\b\d{12}\b|arn:aws|docker login|registry login/i;

const PLACE = 'https://cohort.s3.us-west-2.amazonaws.com/r1abcdefghijk/uploads/x.tar?X-Amz-Signature=1';

/**
 * `upload` is the answer to the archive's PUT. A door from before CT30 answers the first POST with
 * 405 and takes the archive itself, which is what these tests drive unless `presigned` is set; then
 * the door hands out a place in storage and the digest comes back from a poll.
 */
function fakeIo(
	options: { upload?: { status: number; body: string }; size?: number; deployError?: string; expiresInMs?: number; presigned?: boolean } = {}
) {
	const said: string[] = [];
	const docker: string[][] = [];
	const asked: Record<string, unknown>[] = [];
	const uploads: string[] = [];
	const calls: string[] = [];
	const removed: string[] = [];
	const io: DockerfileIo = {
		docker: async (args) => {
			docker.push([...args]);
			return 0;
		},
		scratch: async () => '/tmp/b',
		remove: async (dir) => {
			removed.push(dir);
		},
		size: async () => options.size ?? 40 * 1024 * 1024,
		hash: async () => 'c'.repeat(64),
		transport: {
			call: async (method, url) => {
				calls.push(`${method} ${url}`);
				if (!options.presigned) {
					return { status: 405, body: JSON.stringify({ message: 'An image is uploaded with PUT.' }) };
				}
				if (method === 'POST' && url === TICKET_URL) {
					return { status: 200, body: JSON.stringify({ url: PLACE, headers: { 'content-length': '1' }, expiresAt: '2026-10-20T00:15:00Z' }) };
				}
				if (method === 'POST') {
					return { status: 202, body: JSON.stringify({ state: 'storing' }) };
				}
				return { status: 200, body: JSON.stringify({ state: 'stored', name: 'wa', digest: DIGEST }) };
			},
			put: async (url) => {
				uploads.push(url);
				if (options.presigned && options.upload === undefined) {
					return { status: 200, body: '' };
				}
				return options.upload ?? { status: 200, body: JSON.stringify({ name: 'wa', digest: DIGEST }) };
			},
			sleep: async () => undefined,
			now: () => Date.now()
		},
		ask: async <T>(body: Record<string, unknown>): Promise<T> => {
			asked.push(body);
			if (body.action === 'upload-ticket') {
				return { url: TICKET_URL, expiresAt: new Date(Date.now() + (options.expiresInMs ?? 15 * 60_000)).toISOString() } as T;
			}
			if (options.deployError) {
				throw new Error(options.deployError);
			}
			return { ref: 'r1', allowance: null, containers: [] } as T;
		},
		say: (line) => said.push(line),
		now: () => Date.now()
	};
	return { io, said, docker, asked, uploads, calls, removed };
}

test('--dockerfile asks for a link, builds an archive, uploads it there and returns the stored digest', async () => {
	const { io, docker, asked, uploads, removed } = fakeIo();
	const digest = await buildAndUpload('r1', 'wa', { context: './app', file: null }, io);
	assert.equal(digest, DIGEST);
	assert.deepEqual(asked, [{ ref: 'r1', action: 'upload-ticket', name: 'wa' }]);
	assert.deepEqual(docker.map((a) => a.slice(0, 2).join(' ')), ['version --format', 'buildx build']);
	assert.deepEqual(uploads, [TICKET_URL]);
	assert.deepEqual(removed, ['/tmp/b']);
	// A link about to run out after a long build is asked for again.
	const late = fakeIo({ expiresInMs: 60_000 });
	await buildAndUpload('r1', 'wa', { context: './app', file: null }, late.io);
	assert.equal(late.asked.filter((b) => b.action === 'upload-ticket').length, 2);
});

test('nothing the CLI prints or throws names the cloud provider, an account, a registry or a login', async () => {
	// Every line of a deploy that worked, what it printed to the terminal included.
	const folder = await mkdtemp(join(tmpdir(), 'ct-build-'));
	await writeFile(join(folder, 'Dockerfile'), 'FROM alpine\n');
	const happy = fakeIo();
	const printed: string[] = [];
	const writes = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
	process.stdout.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => (printed.push(String(chunk)), true)) as typeof process.stderr.write;
	try {
		await deployDockerfile('r1', 'wa', { path: folder, wait: false }, happy.io);
	} finally {
		process.stdout.write = writes.out;
		process.stderr.write = writes.err;
	}
	for (const line of [...happy.said, ...printed, ...happy.docker.flat()]) {
		assert.doesNotMatch(line, LEAKY, line);
	}
	// A refusal and a deploy error that DID carry a name of ours are shown without it.
	const refused = fakeIo({ upload: { status: 502, body: JSON.stringify({ error: 'could not push to 123456789012.dkr.ecr.us-east-1.amazonaws.com/s-fleet/ct/r1abcdefghijk' }) } });
	await assert.rejects(buildAndUpload('r1', 'wa', { context: '.', file: null }, refused.io), (error: Error) => !LEAKY.test(error.message) && /SnoutData's registry/.test(error.message));
	const deploy = fakeIo({ deployError: 'nothing at 123456789012.dkr.ecr.us-east-1.amazonaws.com/s-fleet/ct/x' });
	await assert.rejects(deployDockerfile('r1', 'wa', { path: folder, wait: false }, deploy.io), (error: Error) => !LEAKY.test(error.message));
});

test('an archive over the upload cap is refused before it is sent; a refused link says why', async () => {
	const big = fakeIo({ size: 3 * 1024 ** 3 });
	await assert.rejects(buildAndUpload('r1', 'wa', { context: '.', file: null }, big.io), /at most 1 GB compressed/);
	assert.equal(big.uploads.length, 0);
	assert.deepEqual(big.removed, ['/tmp/b']);
	const used = fakeIo({ upload: { status: 401, body: JSON.stringify({ error: 'This upload link is not valid: it was used already.' }) } });
	await assert.rejects(buildAndUpload('r1', 'wa', { context: '.', file: null }, used.io), /not valid/);
	assert.match(uploadFailure(413, ''), /at most 1 GB/);
	assert.equal(withoutCloudInternals('arn:aws:iam::role/x said no'), 'a SnoutData credential said no');
});

test('containers egress: a destination that is not one is a sentence before anything is sent; the three states read plainly', async () => {
	const { runEgress, describeAllowlist } = await import('./containers.js');
	await assert.rejects(() => runEgress('abc', ['10.0.0.1:443']), /not on the public internet/);
	await assert.rejects(() => runEgress('abc', ['api.example.com:http']), /ports are/);
	const plain = (lines: string[]) => lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
	assert.match(plain(describeAllowlist({ ref: 'abc', allowance: null, containers: [], allowlist: null })), /may reach the public internet/);
	const listed = plain(
		describeAllowlist({
			ref: 'abc',
			allowance: null,
			containers: [],
			allowlist: {
				allow: [{ destination: 'api.example.com', ports: [443] }, { destination: '140.82.112.0/20', ports: [] }],
				updatedAt: '2026-10-16T00:00:00Z',
				alwaysAllowed: [{ destination: 'abc.db.snoutdata.com', ports: [5432] }]
			}
		})
	);
	assert.match(listed, /may reach only:\n  api\.example\.com:443\n  140\.82\.112\.0\/20  \(any port\)\n  and always: abc\.db\.snoutdata\.com:5432, and each other/);
	assert.match(plain(describeAllowlist({ ref: 'abc', allowance: null, containers: [], allowlist: { allow: [], updatedAt: '', alwaysAllowed: [] } })), /nothing outside the project/);
});

test('--dockerfile through storage: the archive goes to the place the door names, and the digest comes back from a poll', async () => {
	const { io, uploads, calls, said } = fakeIo({ presigned: true });
	assert.equal(await buildAndUpload('r1', 'wa', { context: '/app', file: null }, io), DIGEST);
	assert.deepEqual(uploads, [PLACE], 'the archive went somewhere other than the place');
	assert.deepEqual(calls, [`POST ${TICKET_URL}`, `POST ${TICKET_URL}/done`, `GET ${TICKET_URL}`]);
	assert.ok(said.some((line) => /storing the image/.test(line)));
	assert.ok(said.every((line) => !LEAKY.test(line)));
});
