/**
 * `status`, `start`, `stop` and `projects show` for a linked LOCAL project (`local.ts`).
 *
 * Compose is called exactly as Studio calls it:
 * `docker compose -p snout-<ref> --project-directory <folder>`, run IN the folder so Compose
 * finds `compose.override.yaml` beside `compose.yaml` on its own. The `-p` is what keeps two
 * projects' containers apart; a project started here is the same project Studio shows.
 */

import { spawn } from 'node:child_process';
import type { LocalStack } from '../local.js';
import { CliFailure } from '../failure.js';
import { bold, dim, emit, say, table } from '../output.js';

/** Studio's `composeProject`: the Compose project name a stack's containers carry. */
export function composeProject(ref: string): string {
	return `snout-${ref}`;
}

export function composeRun(stack: LocalStack, args: string[], stream: boolean): Promise<{ code: number; out: string; err: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn('docker', ['compose', '-p', composeProject(stack.ref), '--project-directory', stack.folder, ...args], {
			cwd: stack.folder,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		let out = '';
		let err = '';
		child.stdout.on('data', (chunk) => {
			out += String(chunk);
		});
		child.stderr.on('data', (chunk) => {
			err += String(chunk);
			if (stream) {
				for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
					say(dim(`  ${line.trim()}`));
				}
			}
		});
		child.on('error', (error) => {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new CliFailure('tool-missing', 'docker is not installed, or not on PATH. A local project runs in Docker (Docker Desktop on Windows and macOS).'));
				return;
			}
			reject(new CliFailure('failed', String(error)));
		});
		child.on('close', (code) => resolve({ code: code ?? 0, out, err }));
	});
}

interface ServiceRow {
	service: string;
	state: string;
	health: string;
}

async function services(stack: LocalStack): Promise<ServiceRow[]> {
	const ps = await composeRun(stack, ['ps', '-a', '--format', 'json'], false);
	if (ps.code !== 0) {
		throw new CliFailure('failed', ps.err.trim() || 'docker compose ps failed. Is Docker running?');
	}
	// One JSON object a line (Compose 2.21+), or one array (older): both read.
	const text = ps.out.trim();
	type Raw = { Service?: string; State?: string; Health?: string; ExitCode?: number };
	const rows: Raw[] = text.startsWith('[')
		? (JSON.parse(text) as Raw[])
		: text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as Raw);
	// A one-time job that finished cleanly (`setup`, `functions-deploy`) is done, not down.
	return rows
		.map((r) => ({ service: r.Service ?? '?', state: r.State === 'exited' && r.ExitCode === 0 ? 'done' : (r.State ?? '?'), health: r.Health ?? '' }))
		.sort((a, b) => a.service.localeCompare(b.service));
}

export async function stackStatus(stack: LocalStack): Promise<number> {
	const rows = await services(stack);
	const running = rows.filter((r) => r.state === 'running').length;
	const longLived = rows.filter((r) => r.state !== 'done').length;
	emit({ ref: stack.ref, local: stack.folder, api: stack.apiUrl, dbPort: stack.dbPort, running, services: rows }, () => {
		say(`${bold(stack.name ?? stack.ref)} (local, ${stack.folder})`);
		if (rows.length === 0) {
			say('Not started. `snoutdata start` brings it up.');
			return;
		}
		process.stdout.write(`${table([['SERVICE', 'STATE', 'HEALTH'], ...rows.map((r) => [r.service, r.state, r.health])])}\n`);
		say(`${running} of ${longLived} services running. API ${stack.apiUrl}, database 127.0.0.1:${stack.dbPort}.`);
	});
	return 0;
}

export async function stackStart(stack: LocalStack): Promise<number> {
	say(`Starting ${stack.name ?? stack.ref} (local)…`);
	const up = await composeRun(stack, ['up', '-d', '--wait', '--wait-timeout', '600'], true);
	if (up.code !== 0) {
		throw new CliFailure('failed', `docker compose up failed: ${up.err.trim().split(/\r?\n/).slice(-3).join(' ')}`);
	}
	emit({ ref: stack.ref, api: stack.apiUrl, dbPort: stack.dbPort, started: true }, () => {
		say(`Running. API ${stack.apiUrl}, database 127.0.0.1:${stack.dbPort}. \`snoutdata db url\` prints the connection string.`);
	});
	return 0;
}

export async function stackStop(stack: LocalStack): Promise<number> {
	const down = await composeRun(stack, ['stop'], true);
	if (down.code !== 0) {
		throw new CliFailure('failed', `docker compose stop failed: ${down.err.trim().split(/\r?\n/).slice(-3).join(' ')}`);
	}
	emit({ ref: stack.ref, stopped: true }, () => say(`Stopped ${stack.name ?? stack.ref}. Its data is kept; \`snoutdata start\` brings it back.`));
	return 0;
}

export function stackShow(stack: LocalStack): void {
	emit({ ref: stack.ref, name: stack.name, local: stack.folder, api: stack.apiUrl, dbPort: stack.dbPort }, () => {
		process.stdout.write(`${table([
			['name', stack.name ?? '(not set up by Studio)'],
			['ref', stack.ref],
			['where', `local, ${stack.folder}`],
			['api', stack.apiUrl],
			['database', `127.0.0.1:${stack.dbPort}`]
		])}\n`);
	});
}
