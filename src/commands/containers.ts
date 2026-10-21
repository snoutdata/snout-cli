/**
 * `snoutdata containers …` — run a Docker image of yours for as long as the project runs.
 *
 * A container is one image, pulled from wherever you keep it (Docker Hub, GHCR, any registry),
 * pinned to the digest its tag points at when you deploy, and run under gVisor beside your
 * project. It is reachable at `https://<ref>.api.snoutdata.com/containers/v1/<name>/`, on the
 * port it listens on (`PORT`, 8080 unless you say otherwise), and it reaches your database with
 * the `DATABASE_URL` it is given.
 *
 * ## It is stateless, and the deploy says so
 *
 * Every deploy, restart or move starts the container from its image again, so anything written
 * inside it is lost. What matters goes in the project's database or Storage. Printed after every
 * deploy, because a container that keeps its sessions on its own disk works perfectly until the
 * first restart.
 *
 * ## A registry token never goes on the command line
 *
 * `--registry-user U` plus the token on stdin (`--registry-token-stdin`), so it is not in the
 * shell history or in `ps`. It is stored sealed and used only to pull; a redeploy of the same
 * private image reuses it.
 *
 * ## Or built from a Dockerfile, with your own Docker (`--dockerfile`)
 *
 * No build service of ours (CT2): `deploy <name> --dockerfile <dir>` builds the folder for
 * linux/arm64 with the Docker on this machine into an image archive (OCI), uploads it to the
 * project's own address with a link that works once and for 15 minutes, and deploys the digest the
 * upload was stored at (CT28). No registry login and no registry address: the link is the whole
 * credential, and where SnoutData keeps the image is SnoutData's business.
 *
 * Either way the host copies the image into SnoutData's registry the first time it starts it, so
 * a restart or a move never reaches the registry it came from again (CT25).
 *
 * ## A deploy waits for the host
 *
 * The control plane resolves the image and records it; the host pulls and starts it seconds
 * later. So `deploy` watches the status until it says running or failed (or `--no-wait`), and
 * prints why when it failed: the image would not pull, it exited, and its last lines.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { call } from '../api.js';
import { UploadFailed, uploadArchive, type UploadAnswer, type UploadTransport } from '../shared/snoutpod/control/containerUpload.js';
import { bold, dim, emit, say, table } from '../output.js';
import {
	checkContainerName,
	formatEgressEntry,
	parseEgressEntry,
	parseImageReference,
	type EgressAllowEntry
} from '../shared/snoutpod/control/containers.js';

export interface DeployedContainer {
	name: string;
	image: string;
	digest: string;
	port: number;
	url: string;
	privateRegistry: boolean;
	/** In SnoutData's registry: a restart or a move no longer reaches the image's own. Absent before 6c. */
	copied?: boolean;
	status: string;
	statusDetail: string | null;
	restarts: number;
	statusAt: string | null;
	allowed: boolean;
	updatedAt: string | null;
}

export interface ContainersAnswer {
	ref: string;
	allowance: {
		deployed: number;
		maxContainers: number;
		memoryMb: number;
		cpuPercent: number;
		/** This month's sending (UTC); at the allowance the project's containers stop until the 1st. Absent before 2026-10-14. */
		egress?: { month: string | null; usedBytes: number; allowanceBytes: number; held: boolean };
	} | null;
	containers: DeployedContainer[];
	/**
	 * Where the project's containers may send, when it restricts it: the list, and what they reach
	 * whatever it says (the project's own database and API). Null: the public internet. Absent from a
	 * control plane before 2026-10-16.
	 */
	allowlist?: { allow: EgressAllowEntry[]; updatedAt: string; alwaysAllowed: EgressAllowEntry[] } | null;
}

export interface ContainerDeployOptions {
	image: string;
	port?: number;
	registryUser?: string;
	registryPassword?: string;
	clearCredential?: boolean;
}

/** Statuses a deploy waits through. */
const SETTLING = new Set(['pending', 'pulling', 'starting', 'restarting']);
const WAIT_MS = 5 * 60_000;

function checkName(name: string): void {
	const bad = checkContainerName(name);
	if (bad) {
		throw new Error(bad);
	}
}

/** The result-returning half, for the MCP server, whose stdout is the JSON-RPC wire. */
export function runDeploy(ref: string, name: string, options: ContainerDeployOptions): Promise<ContainersAnswer> {
	checkName(name);
	const image = parseImageReference(options.image);
	if ('error' in image) {
		throw new Error(image.error);
	}
	return call<ContainersAnswer>('cloud-project-containers', {
		ref,
		action: 'deploy',
		name,
		image: options.image,
		...(options.port === undefined ? {} : { port: options.port }),
		...(options.registryUser ? { registryUser: options.registryUser, registryPassword: options.registryPassword ?? '' } : {}),
		...(options.clearCredential ? { clearCredential: true } : {})
	});
}

export function runList(ref: string): Promise<ContainersAnswer> {
	return call<ContainersAnswer>('cloud-project-containers', { ref });
}

export function runRemove(ref: string, name: string): Promise<ContainersAnswer> {
	checkName(name);
	return call<ContainersAnswer>('cloud-project-containers', { ref, action: 'delete', name });
}

export function runRestart(ref: string, name: string): Promise<ContainersAnswer> {
	checkName(name);
	return call<ContainersAnswer>('cloud-project-containers', { ref, action: 'restart', name });
}

export function runLogs(
	ref: string,
	options: { name?: string; errorsOnly?: boolean; limit?: number; since?: string }
): Promise<{ lines?: ContainerLogLine[] }> {
	return call<{ lines?: ContainerLogLine[] }>('cloud-project-containers', {
		ref,
		action: 'logs',
		...(options.name ? { name: options.name } : {}),
		...(options.errorsOnly ? { errorsOnly: true } : {}),
		...(options.since ? { since: options.since } : {}),
		limit: options.limit ?? 100
	});
}

/** Ask until the container settles, or the wait runs out. */
async function settle(ref: string, name: string): Promise<DeployedContainer | null> {
	const until = Date.now() + WAIT_MS;
	let last: DeployedContainer | null = null;
	while (Date.now() < until) {
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		last = (await runList(ref)).containers.find((one) => one.name === name) ?? null;
		if (!last || !SETTLING.has(last.status)) {
			return last;
		}
	}
	return last;
}

function describe(one: DeployedContainer): string {
	if (!one.allowed) {
		return 'stopped: not covered by the plan';
	}
	const restarts = one.restarts > 0 ? `, ${one.restarts} restart${one.restarts === 1 ? '' : 's'}` : '';
	return `${one.status}${restarts}`;
}

export async function deploy(ref: string, name: string, options: ContainerDeployOptions & { wait?: boolean }): Promise<void> {
	await present(ref, name, await runDeploy(ref, name, options), options.wait !== false);
}

/** After a deploy: wait for the host unless told not to, then say how it went and what it is. */
async function present(ref: string, name: string, answer: ContainersAnswer, wait: boolean): Promise<void> {
	let deployed = answer.containers.find((one) => one.name === name) ?? null;
	if (wait && deployed) {
		say(dim(`${name}: ${deployed.image} pinned to ${deployed.digest.slice(0, 19)}…, waiting for the host`));
		deployed = (await settle(ref, name)) ?? deployed;
	}
	emit({ ...answer, containers: deployed ? [deployed] : answer.containers }, () => {
		if (!deployed) {
			say(`${bold(name)} deployed.`);
			return;
		}
		say(`${bold(name)} ${describe(deployed)}`);
		say(`  ${deployed.url}`);
		if (deployed.statusDetail) {
			say(`  ${deployed.statusDetail}`);
		}
		say('');
		say(dim('  Listens on PORT (' + deployed.port + '). DATABASE_URL and your secrets are in its environment.'));
		say(bold('  Anything written inside the container is lost when it restarts or is redeployed.'));
		say(dim('  Keep what matters in your database.'));
		if (answer.allowance) {
			say(
				dim(
					`  ${answer.allowance.deployed} of ${answer.allowance.maxContainers} containers on this plan, ${answer.allowance.memoryMb} MB and ${answer.allowance.cpuPercent}% of a core each`
				)
			);
		}
	});
}

// ------------------------------------------------------------------------------
// deploy --dockerfile
// ------------------------------------------------------------------------------

/** The most an upload may be; the image itself may be at most 1 GB compressed, which the host checks. */
export const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

/** A link is asked for again when less than this is left on it after the build. */
const TICKET_MARGIN_MS = 3 * 60_000;

/**
 * What `--dockerfile <path>` names: a folder holding a `Dockerfile`, or a Dockerfile itself (then
 * its folder is the build context, as `docker build -f` would have it).
 */
export async function buildInput(path: string): Promise<{ context: string; file: string | null }> {
	let info;
	try {
		info = await stat(path);
	} catch {
		throw new Error(`${path} does not exist: --dockerfile takes a folder with a Dockerfile in it, or the Dockerfile.`);
	}
	if (info.isDirectory()) {
		try {
			await stat(join(path, 'Dockerfile'));
		} catch {
			throw new Error(`${path} has no Dockerfile in it.`);
		}
		return { context: path, file: null };
	}
	return { context: dirname(path), file: path };
}

/** `docker buildx build`'s arguments: linux/arm64 only, one image with no attestation, written to an OCI archive. */
export function buildArgs(input: { context: string; file: string | null; archive: string }): string[] {
	return [
		'buildx',
		'build',
		'--platform',
		'linux/arm64',
		// No provenance attestation: what is uploaded is one image, the one that runs.
		'--provenance=false',
		'--output',
		`type=oci,dest=${input.archive}`,
		...(input.file ? ['--file', input.file] : []),
		input.context
	];
}

/**
 * A sentence from SnoutData Cloud with anything of the infrastructure behind it taken out: a
 * registry host name of the cloud provider's (which carries an account number and a region), a
 * resource name of theirs, and any bare 12-digit account number. The cloud already answers without
 * them; this is the second line.
 */
export function withoutCloudInternals(text: string): string {
	return text
		.replace(/\b\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\/[^\s"',;)]*)?/g, "SnoutData's registry")
		.replace(/\barn:aws[a-z-]*:[^\s"',;)]*/g, 'a SnoutData credential')
		.replace(/\b[a-z0-9.-]*\.amazonaws\.com(?:\/[^\s"',;)]*)?/g, 'SnoutData Cloud')
		.replace(/\b\d{12}\b/g, '(an account)');
}

/** The sentence an upload's refusal carries, or one for a status with none. */
export function uploadFailure(status: number, body: string): string {
	let said = '';
	try {
		const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
		said = String(parsed.error ?? parsed.message ?? '');
	} catch {
		// Not JSON: the status says it.
	}
	if (said) {
		return withoutCloudInternals(said);
	}
	if (status === 413) {
		return "the image is too large to upload: a container's image may be at most 1 GB compressed; a slimmer base (alpine, distroless, -slim) usually fixes it.";
	}
	return `the upload failed (${status}); build again in a moment.`;
}

/** Everything `--dockerfile` does outside itself, so the steps are tested without Docker or a network. */
export interface DockerfileIo {
	/** Run docker with its output on stderr; the exit code. Throws when there is no docker at all. */
	docker(args: readonly string[]): Promise<number>;
	scratch(): Promise<string>;
	remove(dir: string): Promise<void>;
	size(path: string): Promise<number>;
	/** The file's SHA-256, hex, read as a stream. */
	hash(path: string): Promise<string>;
	/** The upload's requests: three small ones through the door and the archive straight to storage (CT30). */
	readonly transport: UploadTransport;
	ask<T>(body: Record<string, unknown>): Promise<T>;
	say(line: string): void;
	now(): number;
}

/** Run docker with its output on stderr (stdout is the answer's, and JSON in --json mode). */
function docker(args: readonly string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', args, { stdio: ['ignore', 2, 2] });
		child.on('error', (error) => reject(error));
		child.on('close', (code) => resolve(code ?? 1));
	});
}

/** The answer to a request, read whole: they are all small. */
function send(
	url: string,
	method: string,
	headers: Readonly<Record<string, string>>,
	body: (request: ReturnType<typeof httpsRequest>) => void
): Promise<UploadAnswer> {
	return new Promise((resolve, reject) => {
		const target = new URL(url);
		const request = (target.protocol === 'http:' ? httpRequest : httpsRequest)(target, { method, headers });
		request.on('response', (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		request.on('error', (error) => {
			reject(error);
		});
		body(request);
	});
}

/**
 * A file PUT to a URL, streamed from disk with its length, never held in memory. With `headers`
 * from a presigned place they are sent exactly, since they are signed; with none (the legacy PUT
 * through the door) the length and type are ours.
 */
async function uploadFile(url: string, file: string, headers: Readonly<Record<string, string>>): Promise<UploadAnswer> {
	const sent =
		Object.keys(headers).length > 0 ? headers : { 'content-type': 'application/octet-stream', 'content-length': String((await stat(file)).size) };
	return send(url, 'PUT', sent, (request) => {
		const stream = createReadStream(file);
		stream.on('error', (error) => request.destroy(error));
		stream.pipe(request);
	});
}

function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash('sha256');
		createReadStream(path)
			.on('error', reject)
			.on('data', (chunk) => hash.update(chunk))
			.on('end', () => resolve(hash.digest('hex')));
	});
}

const realTransport: UploadTransport = {
	call: (method, url, headers) => send(url, method, { 'content-length': '0', ...headers }, (request) => request.end()),
	put: uploadFile,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now()
};

const realIo: DockerfileIo = {
	docker,
	scratch: () => mkdtemp(join(tmpdir(), 'snoutdata-build-')),
	remove: (dir) => rm(dir, { recursive: true, force: true }),
	size: async (path) => (await stat(path)).size,
	hash: sha256File,
	transport: realTransport,
	ask: (body) => call('cloud-project-containers', body),
	say: (line) => say(dim(line)),
	now: () => Date.now()
};

function megabytes(bytes: number): string {
	return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

async function uploadTicket(io: DockerfileIo, ref: string, name: string): Promise<{ url: string; expiresAt: string }> {
	const ticket = await io.ask<{ url?: string; expiresAt?: string }>({ ref, action: 'upload-ticket', name });
	if (typeof ticket.url !== 'string' || !ticket.url.startsWith('https://')) {
		throw new Error('SnoutData Cloud did not hand over an upload link; try again in a moment.');
	}
	return { url: ticket.url, expiresAt: String(ticket.expiresAt ?? '') };
}

/**
 * Build, upload, and return the digest the upload was stored at. Every sentence from the cloud
 * passes `withoutCloudInternals` before it is shown or thrown.
 */
export async function buildAndUpload(
	ref: string,
	name: string,
	input: { context: string; file: string | null },
	io: DockerfileIo = realIo
): Promise<string> {
	try {
		if ((await io.docker(['version', '--format', '{{.Server.Version}}'])) !== 0) {
			throw new Error('docker answered with an error');
		}
	} catch {
		throw new Error('deploy --dockerfile builds with your own Docker, and none is running here. Start Docker, or deploy an image from a registry.');
	}
	try {
		// Asked first, so a plan without containers says so before a build, not after one.
		let ticket = await uploadTicket(io, ref, name);
		const scratch = await io.scratch();
		try {
			const archive = join(scratch, 'image.tar');
			io.say(`${name}: building ${input.file ? basename(input.file) : input.context} for linux/arm64`);
			if ((await io.docker(buildArgs({ ...input, archive }))) !== 0) {
				throw new Error(
					'the build failed; its output is above. If it says the docker driver cannot export OCI, turn on the containerd image store, or run: docker buildx create --use'
				);
			}
			const size = await io.size(archive).catch(() => 0);
			if (size <= 0) {
				throw new Error('docker finished but wrote no image archive, so there is nothing to upload.');
			}
			if (size > MAX_UPLOAD_BYTES) {
				throw new Error(`the image is ${megabytes(size)}, and a container's image may be at most 1 GB compressed. A slimmer base (alpine, distroless, -slim) usually fixes it.`);
			}
			// A long build can outlast the link: ask again rather than upload to one about to run out.
			if (!(Date.parse(ticket.expiresAt) - io.now() > TICKET_MARGIN_MS)) {
				ticket = await uploadTicket(io, ref, name);
			}
			const sha256 = await io.hash(archive);
			io.say(`${name}: uploading the image (${megabytes(size)})`);
			try {
				return await uploadArchive({
					ticketUrl: ticket.url,
					file: archive,
					bytes: size,
					sha256,
					transport: io.transport,
					step: (step) => {
						if (step === 'storing') {
							io.say(`${name}: storing the image in the project`);
						}
					}
				});
			} catch (error) {
				if (error instanceof UploadFailed) {
					throw new Error(uploadFailure(error.status, error.body));
				}
				throw error;
			}
		} finally {
			await io.remove(scratch).catch(() => undefined);
		}
	} catch (error) {
		throw new Error(withoutCloudInternals(error instanceof Error ? error.message : String(error)));
	}
}

export async function deployDockerfile(
	ref: string,
	name: string,
	options: { path: string; port?: number; wait?: boolean },
	io: DockerfileIo = realIo
): Promise<void> {
	checkName(name);
	const input = await buildInput(options.path);
	const digest = await buildAndUpload(ref, name, input, io);
	let answer: ContainersAnswer;
	try {
		answer = await io.ask<ContainersAnswer>({
			ref,
			action: 'deploy',
			name,
			pushed: digest,
			...(options.port === undefined ? {} : { port: options.port })
		});
	} catch (error) {
		throw new Error(withoutCloudInternals(error instanceof Error ? error.message : String(error)));
	}
	await present(ref, name, answer, options.wait !== false);
}

export async function list(ref: string): Promise<void> {
	const answer = await runList(ref);
	emit(answer, () => {
		if (answer.containers.length === 0) {
			say(`No containers on ${ref}.`);
			if (answer.allowance && answer.allowance.maxContainers === 0) {
				say(dim('  Containers run on the Plus and Pro plans.'));
			} else {
				say(dim('  snoutdata containers deploy <name> <image>'));
			}
			return;
		}
		say(
			table([
				['name', 'status', 'image', 'url'],
				...answer.containers.map((one) => [one.name, describe(one), one.image, one.url])
			])
		);
		for (const one of answer.containers) {
			if (one.statusDetail && one.status !== 'running') {
				say(dim(`  ${one.name}: ${one.statusDetail}`));
			}
		}
		const egress = answer.allowance?.egress;
		if (egress && egress.allowanceBytes > 0) {
			say(dim(`  Sent this month: ${gigabytes(egress.usedBytes)} of ${gigabytes(egress.allowanceBytes)}. At ${gigabytes(egress.allowanceBytes)} the project's containers stop until the 1st.`));
		}
	});
}

/**
 * Set the allowlist (`host[:port,port]`, `a.b.c.d[/n][:ports]`; no port is any port), or clear it
 * (null). An empty list is allowed and means nothing outside the project. Checked here first, with
 * the same rule the control plane applies, so a typo is a sentence before anything is sent.
 */
export async function runEgress(ref: string, allow: readonly string[] | null): Promise<ContainersAnswer> {
	if (allow === null) {
		return call<ContainersAnswer>('cloud-project-containers', { ref, action: 'egress', clear: true });
	}
	const entries: EgressAllowEntry[] = [];
	for (const one of allow) {
		const entry = parseEgressEntry(one);
		if ('error' in entry) {
			throw new Error(entry.error);
		}
		entries.push(entry);
	}
	return call<ContainersAnswer>('cloud-project-containers', { ref, action: 'egress', allow: entries });
}

/** What `containers egress` prints: the default, or the list and what is reachable anyway. */
export function describeAllowlist(answer: ContainersAnswer): string[] {
	if (answer.allowlist === undefined) {
		return ['This control plane does not know about allowlists yet.'];
	}
	if (answer.allowlist === null) {
		return [
			`Containers on ${answer.ref} may reach the public internet (within the limits on how much and how fast).`,
			dim('  snoutdata containers egress set <host[:port]> ...   to allow only some destinations')
		];
	}
	const lines = [
		answer.allowlist.allow.length === 0
			? `Containers on ${answer.ref} may reach nothing outside the project.`
			: `Containers on ${answer.ref} may reach only:`
	];
	for (const entry of answer.allowlist.allow) {
		lines.push(`  ${formatEgressEntry(entry)}${entry.ports.length === 0 ? dim('  (any port)') : ''}`);
	}
	lines.push(dim(`  and always: ${answer.allowlist.alwaysAllowed.map(formatEgressEntry).join(', ')}, and each other`));
	lines.push(dim('  snoutdata containers egress clear   to allow the public internet again'));
	return lines;
}

export async function egress(ref: string, change: { set?: readonly string[]; clear?: boolean }): Promise<void> {
	const answer = change.clear ? await runEgress(ref, null) : change.set ? await runEgress(ref, change.set) : await runList(ref);
	emit({ ref: answer.ref, allowlist: answer.allowlist ?? null }, () => {
		for (const line of describeAllowlist(answer)) {
			say(line);
		}
		if (change.set || change.clear) {
			say(dim('  Running containers follow it within a minute; nothing restarts.'));
		}
	});
}

/** Bytes as GB with at most one decimal: 5 GB, 0.3 GB. */
function gigabytes(bytes: number): string {
	return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
}

export async function restart(ref: string, name: string): Promise<void> {
	await runRestart(ref, name);
	const settled = await settle(ref, name);
	emit({ ref, containers: settled ? [settled] : [] }, () => {
		say(settled ? `${bold(name)} ${describe(settled)}` : `${name} is restarting.`);
		if (settled?.statusDetail) {
			say(`  ${settled.statusDetail}`);
		}
	});
}

export async function remove(ref: string, name: string): Promise<void> {
	const answer = await runRemove(ref, name);
	emit(answer, () => say(`${name} is gone. It stops within a few seconds.`));
}

export interface ContainerLogLine {
	name: string;
	stream: 'stdout' | 'stderr';
	message: string;
	at: string;
}

function formatLine(line: ContainerLogLine): string {
	return `${dim(line.at.replace('T', ' ').slice(0, 19))} ${line.name} ${line.stream === 'stderr' ? bold(line.message) : line.message}`;
}

/** Oldest first, from the last seven days; `--follow` asks again every five seconds. */
export async function logs(
	ref: string,
	name: string | undefined,
	options: { errorsOnly?: boolean; limit?: number; follow?: boolean }
): Promise<void> {
	const first = ((await runLogs(ref, { name, errorsOnly: options.errorsOnly, limit: options.limit })).lines ?? []).slice().reverse();
	emit({ ref, lines: first }, () => {
		if (first.length === 0 && !options.follow) {
			say(`Nothing printed${name ? ` by ${name}` : ''} on ${ref} in the last seven days.`);
			say(dim('  Lines show up about a minute after a container prints them.'));
			return;
		}
		for (const line of first) {
			process.stdout.write(`${formatLine(line)}\n`);
		}
	});
	if (!options.follow) {
		return;
	}
	let newest = first.at(-1)?.at ?? new Date().toISOString();
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, 5_000));
		const more = ((await runLogs(ref, { name, errorsOnly: options.errorsOnly, limit: options.limit, since: newest })).lines ?? [])
			.slice()
			.reverse();
		for (const line of more) {
			process.stdout.write(`${formatLine(line)}\n`);
			newest = line.at;
		}
	}
}
