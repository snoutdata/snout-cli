/**
 * `snoutdata sites`: a project's front end at `<name>.snoutpages.dev`.
 *
 *   snoutdata sites [list]                         the project's sites
 *   snoutdata sites deploy <folder> [--name N]     the folder (a built app's dist, say), published
 *   snoutdata sites rollback <name> <deployment>   an earlier deployment, live again
 *   snoutdata sites delete <name>                  unpublished, its files gone, the name free
 *
 * A deploy is `begin` (the manifest: every file's path, size and SHA-256), each file PUT straight to
 * the Sites Worker with the grant `begin` handed out, then `publish`, which the Worker refuses until
 * every declared file is there. Nothing goes through our functions but the manifest.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { call } from '../api.js';
import { UsageError } from '../args.js';
import { emit, say, table } from '../output.js';

interface SiteDeployment {
	id: string;
	state: string;
	files: number;
	bytes: number;
	createdAt: string;
	publishedAt: string | null;
}

interface Site {
	name: string;
	url: string;
	live: boolean;
	liveDeploymentId: string | null;
	takenDown: { at: string; reason: string | null } | null;
	deployments: SiteDeployment[];
}

interface SitesListing {
	domain: string;
	limits: { sites: number; bytes: number; files: number; fileBytes: number };
	sites: Site[];
}

export interface SiteFile {
	path: string;
	bytes: Buffer;
}

/**
 * Every file under a folder, as site paths. Dotfiles (`.env`, `.git`) and `node_modules` are left
 * out on purpose: a site is public, and a `.env` uploaded to one is published to everyone.
 */
export async function readSite(root: string): Promise<SiteFile[]> {
	const files: SiteFile[] = [];
	async function walk(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') {
				continue;
			}
			const full = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(full);
			} else if (entry.isFile()) {
				files.push({ path: relative(root, full).split(sep).join('/'), bytes: await readFile(full) });
			}
		}
	}
	await walk(root);
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function manifestOf(files: SiteFile[]): { path: string; size: number; sha256: string }[] {
	return files.map((f) => ({ path: f.path, size: f.bytes.byteLength, sha256: createHash('sha256').update(f.bytes).digest('hex') }));
}

function megabytes(bytes: number): string {
	return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

async function listSites(ref: string): Promise<SitesListing> {
	return call<SitesListing>('cloud-project-site', { ref, action: 'list' });
}

/** The name to deploy to: the one given, else the project's only site. */
async function nameFor(ref: string, given: string | undefined): Promise<string> {
	if (given) {
		return given.trim().toLowerCase();
	}
	const { sites } = await listSites(ref);
	const only = sites.length === 1 ? sites[0] : undefined;
	if (only) {
		return only.name;
	}
	throw new UsageError(
		sites.length === 0
			? 'name the site: --name my-app (it becomes https://my-app.snoutpages.dev)'
			: `this project has ${sites.length} sites (${sites.map((s) => s.name).join(', ')}): say which with --name`
	);
}

async function deploy(ref: string, folder: string | undefined, name: string | undefined): Promise<void> {
	if (!folder) {
		throw new UsageError('sites deploy <folder> [--name N]: the folder holding index.html (dist, build, out)');
	}
	if (!(await stat(folder).then((s) => s.isDirectory(), () => false))) {
		throw new UsageError(`${folder} is not a folder`);
	}
	const files = await readSite(folder);
	if (!files.some((f) => f.path === 'index.html')) {
		throw new UsageError(`${folder} has no index.html at its top level. Build first, or point at the folder the build wrote.`);
	}
	const site = await nameFor(ref, name);
	const total = files.reduce((sum, f) => sum + f.bytes.byteLength, 0);
	say(`Deploying ${files.length} files (${megabytes(total)}) to ${site}…`);
	const begun = await call<{ url: string; deploymentId: string; upload: { base: string; token: string } }>('cloud-project-site', {
		ref,
		action: 'begin',
		name: site,
		files: manifestOf(files)
	});
	const queue = [...files];
	let done = 0;
	const worker = async () => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const response = await fetch(`${begun.upload.base}/${next.path.split('/').map(encodeURIComponent).join('/')}`, {
				method: 'PUT',
				headers: { authorization: `Bearer ${begun.upload.token}` },
				body: new Uint8Array(next.bytes)
			});
			if (!response.ok) {
				const answer = (await response.json().catch(() => ({}))) as { error?: string };
				throw new Error(answer.error ?? `${next.path}: the upload answered ${response.status}`);
			}
			done += 1;
		}
	};
	await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
	const published = await call<{ url: string; deploymentId: string; files: number; bytes: number }>('cloud-project-site', {
		ref,
		action: 'publish',
		deploymentId: begun.deploymentId
	});
	emit(published, () => say(`Live at ${published.url} (${done} files).`));
}

export async function sitesCommand(
	ref: string,
	action: string | undefined,
	rest: string[],
	options: { name?: string }
): Promise<void> {
	if (action === undefined || action === 'list') {
		const answer = await listSites(ref);
		emit(answer, () => {
			if (answer.sites.length === 0) {
				say(`No sites on ${ref}. \`snoutdata sites deploy dist --name my-app\`.`);
				return;
			}
			process.stdout.write(`${table([
				['NAME', 'ADDRESS', 'LIVE', 'DEPLOYMENTS'],
				...answer.sites.map((s) => [s.name, s.url, s.takenDown ? 'taken down' : s.live ? 'yes' : 'no', String(s.deployments.length)])
			])}\n`);
		});
		return;
	}
	if (action === 'deploy') {
		await deploy(ref, rest[0], options.name);
		return;
	}
	if (action === 'rollback') {
		const [name, deploymentId] = rest;
		if (!name || !deploymentId) {
			throw new UsageError('sites rollback <name> <deployment id> (`snoutdata sites list --json` shows them)');
		}
		const answer = await call<{ url: string }>('cloud-project-site', { ref, action: 'rollback', name, deploymentId });
		emit(answer, () => say(`${answer.url} is serving ${deploymentId} again.`));
		return;
	}
	if (action === 'delete') {
		const name = rest[0];
		if (!name) {
			throw new UsageError('sites delete <name>');
		}
		const answer = await call('cloud-project-site', { ref, action: 'delete', name });
		emit(answer, () => say(`${name} deleted. Its address stops answering within a minute.`));
		return;
	}
	throw new UsageError(`unknown command: sites ${action}. sites [list|deploy|rollback|delete]`);
}
