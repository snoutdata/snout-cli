/**
 * `snoutdata functions …` — deploy code to the edge, list it, remove it.
 *
 * `docs/cloud/STACK.md` Phase H. A function is a folder of TypeScript; this reads it,
 * checks it against the rules the control plane will check it against again, and posts
 * it. Nothing here compiles or bundles: the runtime is Deno and takes TypeScript
 * directly.
 *
 * ## Where a function is read from
 *
 * `functions/<name>/`, and `--dir` overrides it. `upstream/functions/<name>/` is also
 * accepted, silently, so a project laid out the Upstream CLI's way deploys unchanged; it is
 * deliberately never named in help, errors or docs (Joel, 2026-09-23: the product does not
 * talk about Upstream).
 *
 * ## What is refused, and why it is refused HERE as well as there
 *
 * `buildBundle` is the same module the control plane re-runs on arrival: the name rule,
 * the path predicate, the file count, the total size. Doing it in the CLI is not a
 * substitute for doing it on the server — a caller with an access token and `curl` is a
 * supported way to use this system — it is so that the person gets a sentence about their
 * own directory rather than a 400 about a document they did not know they were sending.
 *
 * ## `--no-verify-jwt` says what it does out loud
 *
 * It makes the function callable by anybody who knows its URL, which is exactly what a
 * webhook receiver needs and is a mistake anywhere else. So it is printed back after a
 * deploy, every time, in words — a flag whose consequence is invisible in the output is a
 * flag somebody leaves on.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { call } from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, say, table } from '../output.js';
import {
	assertFunctionName,
	buildBundle,
	MAX_BUNDLE_BYTES,
	type BundleFile
} from '../shared/snoutpod/control/functions.js';

interface DeployedFunction {
	name: string;
	digest: string;
	entrypoint: string;
	verifyJwt: boolean;
	bytes: number | null;
	archived: boolean;
	updatedAt: string | null;
	url: string;
}

interface FunctionsAnswer {
	ref: string;
	functions: DeployedFunction[];
	limit: { deployed: number | null; maxFunctions: number | null };
}

/** Where a function called `<name>` is looked for, in order. Only the first is ever named. */
const LAYOUTS = ['functions', 'upstream/functions'];

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function resolveDirectory(name: string, given: string | undefined): Promise<string> {
	if (given) {
		if (!(await isDirectory(given))) {
			throw new UsageError(`${given} is not a directory`);
		}
		return given;
	}
	for (const layout of LAYOUTS) {
		const candidate = join(layout, name);
		if (await isDirectory(candidate)) {
			return candidate;
		}
	}
	throw new UsageError(
		`no folder found for ${name} at ${LAYOUTS[0]}/${name}; use --dir to say where it is.`
	);
}

/**
 * Every file under a directory, as bundle paths.
 *
 * **What is skipped is a decision and not an oversight.** `node_modules` is a deploy that
 * would be refused for size and would be wrong anyway (Deno resolves imports itself);
 * dotfiles are `.env` and `.git`, and shipping a customer's `.env` INTO a place their code
 * can read it is the one mistake here that would look like it worked. A file somebody
 * genuinely wants can be named without a dot.
 */
async function readTree(root: string): Promise<BundleFile[]> {
	const files: BundleFile[] = [];
	async function walk(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') {
				continue;
			}
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
				continue;
			}
			if (!entry.isFile()) {
				continue;
			}
			const bytes = await readFile(full);
			const text = bytes.toString('utf8');
			// A file that does not survive a round trip through UTF-8 is binary, and a
			// bundle is a JSON document of text. Refused by name rather than mangled:
			// a `.wasm` that arrived as replacement characters would fail at run time,
			// somewhere else, for a reason nobody could see from here.
			if (Buffer.compare(Buffer.from(text, 'utf8'), bytes) !== 0) {
				throw new UsageError(
					`${full} is not text, and a function bundle is source code. Put binary assets in Storage.`
				);
			}
			files.push({ path: relative(root, full).split(sep).join('/'), text });
		}
	}
	await walk(root);
	return files;
}

export interface DeployOptions {
	dir?: string | undefined;
	entrypoint?: string | undefined;
	verifyJwt: boolean;
}

/**
 * What a function's bundle holds: its own folder, and `../_shared` when there is one.
 *
 * `upstream/functions/_shared` is Upstream's convention for code every function imports as
 * `../_shared/…`, and until 2026-09-15 this shipped only the function's own folder, so such an
 * import deployed fine and failed at the first request. When the sibling exists the bundle is laid
 * out the way that import assumes, `<name>/…` beside `_shared/…` with the entrypoint under
 * `<name>/`, which is also exactly how the control plane builds its own functions
 * (`packages/snoutpod/control-plane/functions-build.mjs`). Without one the layout is flat, as it
 * always was, so a function that never used `_shared` keeps the same digest.
 */
export async function collectFunction(
	name: string,
	directory: string,
	entrypoint: string | undefined
): Promise<{ entrypoint: string; files: BundleFile[] }> {
	const own = await readTree(directory);
	if (own.length === 0) {
		throw new UsageError(`${directory} has no files in it`);
	}
	const start = entrypoint ?? (own.some((file) => file.path === 'index.ts') ? 'index.ts' : '');
	if (!start) {
		throw new UsageError(
			`${directory} has no index.ts, so there is nothing to start. Name the file with --entrypoint.`
		);
	}
	const shared = join(directory, '..', '_shared');
	if (!(await isDirectory(shared))) {
		return { entrypoint: start, files: own };
	}
	const common = (await readTree(shared)).map((file) => ({ path: `_shared/${file.path}`, text: file.text }));
	return {
		entrypoint: `${name}/${start}`,
		files: [...own.map((file) => ({ path: `${name}/${file.path}`, text: file.text })), ...common]
	};
}

/**
 * Read a folder, check it, post it — and RETURN the answer rather than printing it.
 *
 * Split from `deploy` for the reason `runPush` is split from `push`: the MCP server's
 * stdout is the JSON-RPC wire, so a command that writes to it corrupts the protocol. An
 * agent deploying a function and a person deploying one do the same work and only one of
 * them gets a sentence about it.
 */
export async function runDeploy(
	ref: string,
	name: string,
	options: DeployOptions
): Promise<{ answer: FunctionsAnswer; directory: string; files: number; bytes: number }> {
	assertFunctionName(name);
	const directory = await resolveDirectory(name, options.dir);
	const { entrypoint, files } = await collectFunction(name, directory, options.entrypoint);
	// The same rules the control plane will apply again, so the message is about this
	// folder rather than about a document the person never saw.
	const bundle = buildBundle({ entrypoint, files });

	const answer = await call<FunctionsAnswer>('cloud-project-functions', {
		ref,
		action: 'deploy',
		name,
		verifyJwt: options.verifyJwt,
		bundle
	});
	return { answer, directory, files: files.length, bytes: JSON.stringify(bundle).length };
}

export async function deploy(ref: string, name: string, options: DeployOptions): Promise<void> {
	const { answer, directory, files, bytes } = await runDeploy(ref, name, options);
	const deployed = answer.functions.find((one) => one.name === name);

	emit(answer, () => {
		const size = Math.max(1, Math.round(bytes / 1024));
		say(`${bold(name)} deployed from ${directory} (${files} file${files === 1 ? '' : 's'}, ${size} KB)`);
		if (deployed) {
			say(`  ${deployed.url}`);
		}
		if (!options.verifyJwt) {
			// Every time, in words. A flag whose consequence is invisible in the output is
			// a flag somebody leaves on.
			say('');
			say(bold('  Anybody who knows this URL can run it. No API key is required.'));
			say(dim('  That is what a webhook receiver needs. Check the sender signature inside the function.'));
		}
		if (answer.limit.maxFunctions !== null) {
			say(dim(`  ${answer.limit.deployed} of ${answer.limit.maxFunctions} functions on this plan`));
		}
	});
}

export function runList(ref: string): Promise<FunctionsAnswer> {
	return call<FunctionsAnswer>('cloud-project-functions', { ref });
}

export function runRemove(ref: string, name: string): Promise<FunctionsAnswer> {
	assertFunctionName(name);
	return call<FunctionsAnswer>('cloud-project-functions', { ref, action: 'delete', name });
}

export async function list(ref: string): Promise<void> {
	const answer = await runList(ref);
	emit(answer, () => {
		if (answer.functions.length === 0) {
			say(`${ref} has no functions.`);
			say(dim('  snoutdata functions deploy <name>    from functions/<name>'));
			return;
		}
		process.stdout.write(
			`${table([
				['NAME', 'KEY', 'SIZE', 'URL'],
				...answer.functions.map((one) => [
					one.name,
					// The column a person scans for. "open" is the one that matters and it
					// is the shorter word on purpose: it should catch the eye.
					one.verifyJwt ? 'required' : bold('open'),
					one.bytes === null ? '-' : `${Math.max(1, Math.round(one.bytes / 1024))} KB`,
					one.url
				])
			])}\n`
		);
		if (answer.limit.maxFunctions !== null) {
			say(dim(`${answer.limit.deployed} of ${answer.limit.maxFunctions} on this plan`));
		}
	});
}

export async function remove(ref: string, name: string): Promise<void> {
	const answer = await runRemove(ref, name);
	emit(answer, () => {
		say(`${name} is gone. It stops answering within a few seconds.`);
	});
}

export { MAX_BUNDLE_BYTES };
