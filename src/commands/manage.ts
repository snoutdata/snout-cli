/**
 * The rest of a project's controls, from a terminal: what `projects show`, `products`,
 * `domains` and `db restore --at` do. The same controls the desktop app's project tab and the
 * dashboard have (docs/desktop/CLOUD-PROJECTS.md), because the CLI is how somebody without the
 * app does everything the app does.
 *
 * Each export is split the way `functions.ts` splits its: a `get…`/`set…` that RETURNS the answer,
 * which `snoutdata mcp` serves (stdout is the JSON-RPC wire there, so nothing may print), and a
 * command that prints it.
 */

import * as api from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, say, table } from '../output.js';

export type Product = 'auth' | 'storage' | 'data-api';

export const PRODUCTS: readonly Product[] = ['auth', 'storage', 'data-api'];

export interface Products {
	ref: string;
	auth: { enabled: boolean; google: boolean; saml: boolean } | { error: string };
	storage: { enabled: boolean; pending: boolean; bytes: number | null; files: number | null } | { error: string };
	dataApi: { enabled: boolean; allowedOnPlan: boolean } | { error: string };
}

function reason(error: unknown): { error: string } {
	return { error: error instanceof Error ? error.message : String(error) };
}

/** All three, each allowed to fail on its own: one refusing must not hide the other two. */
export async function getProducts(ref: string): Promise<Products> {
	const [auth, storage, dataApi] = await Promise.all([
		api.call<{ enabled?: boolean; google?: { enabled?: boolean }; saml?: { enabled?: boolean } }>('cloud-project-auth', { ref, action: 'status' })
			.then((a) => ({ enabled: a.enabled === true, google: a.google?.enabled === true, saml: a.saml?.enabled === true }), reason),
		api.call<{ storage?: { enabled: boolean; pending: boolean; bytes: number | null; files: number | null } }>('cloud-project-storage', { ref })
			.then((a) => ({ enabled: a.storage?.enabled === true, pending: a.storage?.pending === true, bytes: a.storage?.bytes ?? null, files: a.storage?.files ?? null }), reason),
		api.call<{ dataApi?: { enabled: boolean; allowed: boolean } }>('cloud-project-data-api', { ref })
			.then((a) => ({ enabled: a.dataApi?.enabled === true, allowedOnPlan: a.dataApi?.allowed === true }), reason),
	]);
	return { ref, auth, storage, dataApi };
}

export function parseProduct(word: string | undefined): Product {
	const product = (word ?? '').toLowerCase().replace('_', '-').replace(/^dataapi$/, 'data-api');
	if (!(PRODUCTS as readonly string[]).includes(product)) {
		throw new UsageError(`say which product: ${PRODUCTS.join(', ')}`);
	}
	return product as Product;
}

/** Turn one on or off. It is a DESIRE: the host starts it within about a minute. */
export async function setProduct(ref: string, product: Product, enabled: boolean): Promise<{ ref: string; product: Product; enabled: boolean; note: string }> {
	if (product === 'auth') {
		const answer = await api.call<{ note?: string }>('cloud-project-auth', { ref, action: enabled ? 'enable' : 'disable' });
		return { ref, product, enabled, note: answer.note ?? (enabled ? 'Auth starts within a minute.' : 'Auth stops. Your users stay in the auth schema.') };
	}
	await api.call(product === 'storage' ? 'cloud-project-storage' : 'cloud-project-data-api', { ref, enable: enabled });
	return { ref, product, enabled, note: enabled ? `${product} starts within a minute, when the host picks up the change.` : `${product} is off.` };
}

export async function productsCommand(ref: string): Promise<void> {
	const answer = await getProducts(ref);
	emit(answer, () => {
		const line = (label: string, value: unknown, extra = ''): string[] => [
			label,
			value && typeof value === 'object' && 'error' in value ? `could not read: ${(value as { error: string }).error}` : (value as { enabled: boolean }).enabled ? bold('on') : 'off',
			extra,
		];
		const storage = answer.storage;
		const dataApi = answer.dataApi;
		process.stdout.write(`${table([
			['PRODUCT', 'STATE', ''],
			line('auth', answer.auth),
			line('storage', storage, 'pending' in storage && storage.pending ? 'waiting for the host' : ''),
			line('data-api', dataApi, 'allowedOnPlan' in dataApi && !dataApi.allowedOnPlan ? 'paid plans only' : ''),
		])}\n`);
		say(dim(`  snoutdata products enable storage --ref ${ref}`));
	});
}

export async function setProductCommand(ref: string, product: Product, enabled: boolean): Promise<void> {
	const result = await setProduct(ref, product, enabled);
	emit(result, () => say(result.note));
}

// --- domains --------------------------------------------------------------------------------

export interface DnsRecord { type: string; name: string; value: string }

export interface Domain {
	hostname: string;
	verified: boolean;
	verificationError: string | null;
	record: DnsRecord | null;
	certificateRecord: DnsRecord | null;
	certificate: { state: string | null; expiresAt: string | null; error: string | null } | null;
}

export async function listDomains(ref: string): Promise<{ ref: string; domains: Domain[] }> {
	const answer = await api.call<{ domains?: Domain[] }>('cloud-project-domain', { ref, action: 'list' });
	return { ref, domains: answer.domains ?? [] };
}

export async function domainAction(ref: string, action: 'add' | 'verify' | 'remove', hostname: string): Promise<{ ref: string; domain: Domain | null; next: string | null }> {
	if (!hostname) {
		throw new UsageError(`domains ${action} needs a hostname, e.g. api.example.com`);
	}
	const answer = await api.call<{ domain?: Domain; next?: string }>('cloud-project-domain', { ref, action, hostname });
	return { ref, domain: answer.domain ?? null, next: answer.next ?? null };
}

function printRecords(domain: Domain, ref: string): void {
	const rows: string[][] = [['TYPE', 'NAME', 'VALUE']];
	if (domain.record) {
		rows.push([domain.record.type, domain.record.name, domain.record.value]);
	}
	if (domain.certificateRecord) {
		rows.push([domain.certificateRecord.type, domain.certificateRecord.name, domain.certificateRecord.value]);
	}
	rows.push(['CNAME', domain.hostname, `${ref}.api.snoutdata.com`]);
	process.stdout.write(`${table(rows)}\n`);
}

export async function domainsCommand(ref: string, action: string | undefined, hostname: string | undefined): Promise<void> {
	if (action === undefined || action === 'list') {
		const answer = await listDomains(ref);
		emit(answer, () => {
			if (answer.domains.length === 0) {
				say(`No domains on ${ref}. \`snoutdata domains add api.example.com\`.`);
				return;
			}
			process.stdout.write(`${table([
				['HOSTNAME', 'VERIFIED', 'CERTIFICATE'],
				...answer.domains.map((d) => [d.hostname, d.verified ? 'yes' : bold('no'), d.certificate?.state ?? '']),
			])}\n`);
		});
		return;
	}
	if (action !== 'add' && action !== 'verify' && action !== 'remove') {
		throw new UsageError(`unknown command: domains ${action}`);
	}
	const result = await domainAction(ref, action, hostname ?? '');
	emit(result, () => {
		if (action === 'remove') {
			say(`${hostname} removed.`);
			return;
		}
		if (result.domain) {
			say(result.domain.verified ? `${hostname} is verified.` : (result.domain.verificationError ?? `${hostname} is not verified yet. Publish these records, then \`snoutdata domains verify ${hostname}\`:`));
			if (!result.domain.verified) {
				printRecords(result.domain, ref);
			}
		}
		if (result.next) {
			say(result.next);
		}
	});
}

// --- point-in-time restore -------------------------------------------------------------------

export interface RestoreWindow {
	available: boolean;
	pitrEnabled: boolean;
	tier: string;
	earliest: string | null;
	latest: string | null;
	retentionDays: number | null;
}

export async function restoreWindow(ref: string): Promise<{ ref: string; restore: RestoreWindow }> {
	return api.call('cloud-project-restore', { ref }, 'GET');
}

/** Into a NEW project beside this one, never over it: a wrong guess then costs nothing. */
export async function restoreTo(ref: string, at: string, name?: string): Promise<{ project: api.Project; from: string; targetAt: string }> {
	if (Number.isNaN(Date.parse(at))) {
		throw new UsageError(`--at needs a moment, e.g. 2026-09-20T14:30:00Z (got "${at}")`);
	}
	return api.call('cloud-project-restore', { ref, at: new Date(at).toISOString(), ...(name ? { name } : {}) });
}

export async function restoreWindowCommand(ref: string): Promise<void> {
	const answer = await restoreWindow(ref);
	emit(answer, () => {
		const w = answer.restore;
		if (!w.available) {
			say(w.pitrEnabled ? `${ref} has no backup to restore from yet.` : `Point-in-time restore is not part of the ${w.tier} plan.`);
			return;
		}
		say(`${ref} can be restored to any moment from ${w.earliest} to ${w.latest}.`);
		say(dim(`  snoutdata db restore --at ${w.latest} --ref ${ref}`));
	});
}

export async function restoreToCommand(ref: string, at: string, name?: string): Promise<void> {
	const result = await restoreTo(ref, at, name);
	emit(result, () => {
		say(`Restoring ${ref} as it was at ${result.targetAt} into a new project, ${bold(result.project.name)} (${result.project.ref}).`);
		say(dim(`  snoutdata projects list    to see when it is ready`));
	});
}

// --- one project, whole -----------------------------------------------------------------------

export async function getProject(ref: string): Promise<Record<string, unknown>> {
	const { projects } = await api.listProjects();
	const project = projects.find((p) => p.ref === ref);
	if (!project) {
		throw new UsageError(`no project ${ref} on this account. \`snoutdata projects list\`.`);
	}
	const [products, functions, secrets, domains] = await Promise.all([
		getProducts(ref),
		api.call<{ functions?: { name: string }[] }>('cloud-project-functions', { ref }).then((a) => (a.functions ?? []).map((f) => f.name), reason),
		api.call<{ secrets?: { name: string }[] }>('cloud-project-secrets', { ref }).then((a) => (a.secrets ?? []).map((s) => s.name), reason),
		listDomains(ref).then((a) => a.domains.map((d) => ({ hostname: d.hostname, verified: d.verified })), reason),
	]);
	return { ...project, products, functions, secretNames: secrets, domains };
}

export async function showCommand(ref: string): Promise<void> {
	const answer = await getProject(ref);
	emit(answer, () => {
		const p = answer as unknown as api.Project & { products: Products; functions: string[] | { error: string }; secretNames: string[] | { error: string }; domains: { hostname: string }[] | { error: string } };
		const on = (v: unknown): string => (v && typeof v === 'object' && 'enabled' in v ? ((v as { enabled: boolean }).enabled ? 'on' : 'off') : '?');
		const list = (v: unknown): string => (Array.isArray(v) ? (v.length ? v.map((x) => (typeof x === 'string' ? x : (x as { hostname: string }).hostname)).join(', ') : 'none') : 'could not read');
		process.stdout.write(`${table([
			['name', p.name],
			['ref', p.ref],
			['state', p.state],
			['region', p.region],
			['auth / storage / data-api', `${on(p.products.auth)} / ${on(p.products.storage)} / ${on(p.products.dataApi)}`],
			['functions', list(p.functions)],
			['secrets', list(p.secretNames)],
			['domains', list(p.domains)],
		])}\n`);
	});
}
