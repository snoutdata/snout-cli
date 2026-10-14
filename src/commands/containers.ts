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
 * ## A deploy waits for the host
 *
 * The control plane resolves the image and records it; the host pulls and starts it seconds
 * later. So `deploy` watches the status until it says running or failed (or `--no-wait`), and
 * prints why when it failed: the image would not pull, it exited, and its last lines.
 */

import { call } from '../api.js';
import { bold, dim, emit, say, table } from '../output.js';
import { checkContainerName, parseImageReference } from '../shared/snoutpod/control/containers.js';

export interface DeployedContainer {
	name: string;
	image: string;
	digest: string;
	port: number;
	url: string;
	privateRegistry: boolean;
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
	const answer = await runDeploy(ref, name, options);
	let deployed = answer.containers.find((one) => one.name === name) ?? null;
	if (options.wait !== false && deployed) {
		emit(answer, () => say(dim(`${name}: ${deployed?.image} pinned to ${deployed?.digest.slice(0, 19)}…, waiting for the host`)));
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
