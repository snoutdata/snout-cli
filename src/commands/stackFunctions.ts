/**
 * `functions` and `secrets` for a linked LOCAL project (`local.ts`), as the stack's README does
 * them by hand: a function is a folder in the stack's `functions/`, secrets are `functions/.env`,
 * and `docker compose run --rm functions-deploy` bundles them for the runtime.
 *
 * The same name rules as the cloud (`assertFunctionName`, `checkSecretName`), so a function or a
 * secret that works here works when the project moves to SnoutData Cloud.
 */

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LocalStack } from '../local.js';
import { parseEnv } from '../local.js';
import { assertFunctionName, checkSecretName } from '../shared/snoutpod/control/functions.js';
import { CliFailure } from '../failure.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, say, table } from '../output.js';
import { composeRun } from './stack.js';

/** The functions folder's entries that are functions: not `_shared`, not dotfiles, a folder. */
function functionNames(stack: LocalStack): string[] {
	const root = join(stack.folder, 'functions');
	if (!existsSync(root)) {
		return [];
	}
	return readdirSync(root)
		.filter((name) => !name.startsWith('.') && !name.startsWith('_') && statSync(join(root, name)).isDirectory())
		.sort();
}

/** Bundle what is in `functions/` for the runtime. It picks the result up at once. */
async function redeploy(stack: LocalStack): Promise<void> {
	say(dim('  docker compose run --rm functions-deploy'));
	const run = await composeRun(stack, ['run', '--rm', 'functions-deploy'], true);
	if (run.code !== 0) {
		throw new CliFailure('failed', `functions-deploy failed: ${run.err.trim().split(/\r?\n/).slice(-3).join(' ')}`);
	}
}

/** Set or clear one name in the stack's `FUNCTIONS_NO_VERIFY_JWT` (comma separated, in `.env`). */
function setOpen(stack: LocalStack, name: string, open: boolean): boolean {
	const path = join(stack.folder, '.env');
	const text = readFileSync(path, 'utf8');
	const current = (parseEnv(text).get('FUNCTIONS_NO_VERIFY_JWT') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
	const next = open ? [...new Set([...current, name])] : current.filter((n) => n !== name);
	if (next.join(',') === current.join(',')) {
		return false;
	}
	const line = `FUNCTIONS_NO_VERIFY_JWT=${next.join(',')}`;
	const pattern = /^FUNCTIONS_NO_VERIFY_JWT=.*$/m;
	writeFileSync(path, pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, '\n')}${line}\n`);
	return true;
}

export interface LocalDeployed {
	ref: string;
	name: string;
	url: string;
	verifyJwt: boolean;
	local: string;
}

/** The deploy, returning what it did; `localDeploy` prints it. The MCP server calls this one (stdout is its wire). */
export async function runLocalDeploy(stack: LocalStack, name: string, options: { dir?: string | undefined; verifyJwt: boolean }): Promise<LocalDeployed> {
	assertFunctionName(name);
	const source = resolve(options.dir ?? join(process.cwd(), 'functions', name));
	if (!existsSync(join(source, 'index.ts'))) {
		throw new UsageError(`${source} has no index.ts. A local function is a folder with an index.ts in it.`);
	}
	const target = join(stack.folder, 'functions', name);
	if (resolve(target) !== source) {
		rmSync(target, { recursive: true, force: true });
		cpSync(source, target, { recursive: true });
		// `../_shared` imports resolve in the stack only if the shared folder is there too.
		const shared = join(source, '..', '_shared');
		if (existsSync(shared) && resolve(shared) !== resolve(join(stack.folder, 'functions', '_shared'))) {
			cpSync(shared, join(stack.folder, 'functions', '_shared'), { recursive: true });
		}
	}
	const changedAccess = setOpen(stack, name, !options.verifyJwt);
	await redeploy(stack);
	if (changedAccess) {
		// The gateway reads the list when it starts, so a change to it needs the stack's `up`.
		const up = await composeRun(stack, ['up', '-d', '--wait', '--wait-timeout', '600'], false);
		if (up.code !== 0) {
			throw new CliFailure('failed', `docker compose up failed after changing who may call ${name}: ${up.err.trim().split(/\r?\n/).slice(-2).join(' ')}`);
		}
	}
	return { ref: stack.ref, name, url: `${stack.apiUrl}/functions/v1/${name}`, verifyJwt: options.verifyJwt, local: stack.folder };
}

export async function localDeploy(stack: LocalStack, name: string, options: { dir?: string | undefined; verifyJwt: boolean }): Promise<void> {
	const done = await runLocalDeploy(stack, name, options);
	emit(done, () => {
		say(`${bold(name)} deployed locally: ${done.url}`);
		if (!options.verifyJwt) {
			say(dim('  Callable with no key (FUNCTIONS_NO_VERIFY_JWT), so it must check what calls it itself.'));
		}
	});
}

/** What `functions list` shows for a local project, as a value. */
export function localFunctions(stack: LocalStack): { ref: string; local: string; functions: Array<{ name: string; url: string }> } {
	return { ref: stack.ref, local: stack.folder, functions: functionNames(stack).map((name) => ({ name, url: `${stack.apiUrl}/functions/v1/${name}` })) };
}

export function localList(stack: LocalStack): void {
	const names = functionNames(stack);
	emit(localFunctions(stack), () => {
		if (names.length === 0) {
			say(`No functions in ${join(stack.folder, 'functions')}.`);
			return;
		}
		process.stdout.write(`${table([['NAME', 'URL'], ...names.map((name) => [name, `${stack.apiUrl}/functions/v1/${name}`])])}\n`);
	});
}

export async function runLocalRemove(stack: LocalStack, name: string): Promise<{ ref: string; name: string; removed: true }> {
	assertFunctionName(name);
	const target = join(stack.folder, 'functions', name);
	if (!existsSync(target)) {
		throw new CliFailure('not-found', `this local project has no function called ${name}`);
	}
	rmSync(target, { recursive: true, force: true });
	setOpen(stack, name, false);
	await redeploy(stack);
	return { ref: stack.ref, name, removed: true };
}

export async function localRemove(stack: LocalStack, name: string): Promise<void> {
	emit(await runLocalRemove(stack, name), () => say(`${name} is gone.`));
}

/** `functions/.env`, as the README describes it. Values are written single-quoted, as Studio does. */
function secretsPath(stack: LocalStack): string {
	return join(stack.folder, 'functions', '.env');
}

function readSecrets(stack: LocalStack): Map<string, string> {
	const path = secretsPath(stack);
	return existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : new Map();
}

function writeSecrets(stack: LocalStack, values: Map<string, string>): void {
	const quote = (value: string) => (value.includes("'") ? JSON.stringify(value) : `'${value}'`);
	writeFileSync(secretsPath(stack), [...values].map(([name, value]) => `${name}=${quote(value)}`).join('\n') + (values.size ? '\n' : ''));
}

export async function localSecretsSet(stack: LocalStack, pairs: Array<{ name: string; value: string }>): Promise<void> {
	for (const pair of pairs) {
		const complaint = checkSecretName(pair.name);
		if (complaint) {
			throw new UsageError(complaint);
		}
	}
	const values = readSecrets(stack);
	for (const pair of pairs) {
		values.set(pair.name, pair.value);
	}
	writeSecrets(stack, values);
	await redeploy(stack);
	emit({ ref: stack.ref, set: pairs.map((p) => p.name) }, () => {
		for (const pair of pairs) {
			say(`${bold(pair.name)} set in ${secretsPath(stack)}`);
		}
	});
}

/** The NAMES in `functions/.env`, never the values. */
export function localSecretNames(stack: LocalStack): { ref: string; local: string; secrets: Array<{ name: string }> } {
	return { ref: stack.ref, local: stack.folder, secrets: [...readSecrets(stack).keys()].sort().map((name) => ({ name })) };
}

export function localSecretsList(stack: LocalStack): void {
	const answer = localSecretNames(stack);
	const names = answer.secrets.map((one) => one.name);
	emit(answer, () => {
		say(names.length ? names.join('\n') : `No function secrets in ${secretsPath(stack)}.`);
	});
}

export async function localSecretsUnset(stack: LocalStack, name: string): Promise<void> {
	const values = readSecrets(stack);
	if (!values.delete(name)) {
		throw new CliFailure('not-found', `${name} is not set for this local project`);
	}
	writeSecrets(stack, values);
	await redeploy(stack);
	emit({ ref: stack.ref, unset: name }, () => say(`${name} unset.`));
}
