// GENERATED: a copy of SnoutData's control-plane code (containers.ts).
// Do not edit here: edits are overwritten by the build.
/**
 * Snout Containers: what a container IS, decided once for the CLI, the control plane and the host
 * agent. A container is one image of the customer's that runs for as long as the project does,
 * under gVisor, reachable at `/containers/v1/<name>/` on the project's API address.
 *
 * Pure. The one impure step, asking a registry what a tag points at, takes `fetch` as an argument,
 * so the same code resolves a digest in a Snout Function and in a test against a fake registry.
 *
 * What lives here:
 *   - the name rule (a URL segment, a podman container name and part of a systemd unit name);
 *   - reading an image reference the way `docker pull` reads it, so `nginx` means
 *     `docker.io/library/nginx:latest` here too;
 *   - resolving a reference to a digest and checking it can run on the fleet (`linux/arm64`);
 *   - whether a plan may deploy one more, and the sentences for when it may not;
 *   - the host port a container is published on, so the control plane and the front door cannot
 *     disagree about it.
 */

/** Lower case, so the name is the same in a URL, a container name and a unit name. */
const CONTAINER_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isContainerName(value: string): boolean {
	return CONTAINER_NAME.test(value);
}

export function checkContainerName(value: string): string | null {
	if (isContainerName(value)) {
		return null;
	}
	return `${JSON.stringify(value)} is not a container name: lower-case letters, digits, hyphens and underscores, up to 32 characters, starting with a letter or a digit.`;
}

/** The slots a container's host port is taken from; the catalogue's services never take one. */
export const CONTAINER_SLOTS = { first: 31, last: 39 } as const;

/** `pod_port + slot * 1000`, the rule every per-project service follows, so a person on a box can read it. */
export function containerHostPort(podPort: number, slot: number): number {
	if (!Number.isInteger(slot) || slot < CONTAINER_SLOTS.first || slot > CONTAINER_SLOTS.last) {
		throw new Error(`a container slot is ${CONTAINER_SLOTS.first}-${CONTAINER_SLOTS.last}, not ${slot}`);
	}
	return podPort + slot * 1000;
}

/** The port a container is told to listen on when the deploy names none. */
export const DEFAULT_CONTAINER_PORT = 8080;

/**
 * The runner's own network (the `containers` shared service), policed like the functions runtime's.
 * Customer containers are not on it: each project has a network of its own, made by the runner.
 */
export const CONTAINERS_NETWORK = 'snoutct';
export const CONTAINERS_SUBNET = '10.94.0.0/24';
export const CONTAINERS_GATEWAY = '10.94.0.1';
export const CONTAINERS_SINK = '10.94.0.254';

// ------------------------------------------------------------------------------
// Image references
// ------------------------------------------------------------------------------

export interface ImageReference {
	/** As podman and the registry's own UI write it: `docker.io`, `ghcr.io`, `registry.gitlab.com`. */
	readonly registry: string;
	/** `library/nginx`, `acme/whatsapp`. */
	readonly repository: string;
	/** Null when the reference is pinned by digest alone. */
	readonly tag: string | null;
	readonly digest: string | null;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
// The distribution spec's path component, lower case, separated by `.`, `_`, `__` or `-`.
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const REGISTRY_HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?$/;

export function isDigest(value: string): boolean {
	return DIGEST.test(value);
}

/**
 * Read an image reference the way `docker pull` does.
 *
 * The first component is a registry only when it looks like one (a dot, a port, or `localhost`);
 * otherwise the image is on Docker Hub, and a one-component Hub name is in `library/`. No tag and
 * no digest means `latest`. Returns a sentence instead of throwing, because what a person typed
 * wrong is an answer, not an error.
 */
export function parseImageReference(input: string): ImageReference | { error: string } {
	const raw = input.trim();
	if (raw.length === 0 || raw.length > 512 || /\s/.test(raw)) {
		return { error: `${JSON.stringify(input)} is not an image reference.` };
	}
	let rest = raw;
	let digest: string | null = null;
	const at = rest.indexOf('@');
	if (at !== -1) {
		digest = rest.slice(at + 1);
		rest = rest.slice(0, at);
		if (!isDigest(digest)) {
			return { error: `${JSON.stringify(digest)} is not a sha256 digest.` };
		}
	}
	let tag: string | null = null;
	const lastSlash = rest.lastIndexOf('/');
	const lastColon = rest.lastIndexOf(':');
	if (lastColon > lastSlash) {
		tag = rest.slice(lastColon + 1);
		rest = rest.slice(0, lastColon);
		if (!TAG.test(tag)) {
			return { error: `${JSON.stringify(tag)} is not an image tag.` };
		}
	}
	const parts = rest.split('/');
	let registry = 'docker.io';
	const first = parts[0] ?? '';
	if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
		registry = first.toLowerCase();
		parts.shift();
	}
	if (!REGISTRY_HOST.test(registry)) {
		return { error: `${JSON.stringify(first)} is not a registry address.` };
	}
	if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') {
		registry = 'docker.io';
	}
	if (registry === 'docker.io' && parts.length === 1) {
		parts.unshift('library');
	}
	if (parts.length === 0 || parts.some((part) => !PATH_COMPONENT.test(part))) {
		return {
			error: `${JSON.stringify(input)} is not an image name: a repository is lower-case letters, digits and separators.`
		};
	}
	if (tag === null && digest === null) {
		tag = 'latest';
	}
	return { registry, repository: parts.join('/'), tag, digest };
}

/** The reference written out, `registry/repository[:tag][@digest]`, for display and for podman. */
export function formatImageReference(ref: ImageReference, options: { digest?: string | null } = {}): string {
	const digest = options.digest === undefined ? ref.digest : options.digest;
	let out = `${ref.registry}/${ref.repository}`;
	if (ref.tag) {
		out += `:${ref.tag}`;
	}
	if (digest) {
		out += `@${digest}`;
	}
	return out;
}

/** What a host pulls: the repository at the pinned digest, never a tag. */
export function pinnedImage(image: string, digest: string): string {
	const parsed = parseImageReference(image);
	if ('error' in parsed) {
		throw new Error(parsed.error);
	}
	if (!isDigest(digest)) {
		throw new Error(`not a digest: ${digest}`);
	}
	return `${parsed.registry}/${parsed.repository}@${digest}`;
}

/** Where a registry's API answers. Docker Hub's name and its API's host differ. */
export function registryApiBase(registry: string): string {
	if (registry === 'docker.io') {
		return 'https://registry-1.docker.io';
	}
	return `https://${registry}`;
}

// ------------------------------------------------------------------------------
// Resolving a tag to a digest, and checking the platform
// ------------------------------------------------------------------------------

/** The architecture the fleet runs (t4g, Graviton). */
export const FLEET_PLATFORM = { os: 'linux', architecture: 'arm64' } as const;

export interface RegistryCredential {
	readonly username: string;
	readonly password: string;
}

export type ResolvedImage =
	| { ok: true; digest: string; platforms: string[] }
	| { ok: false; reason: string };

const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
}>;

interface Challenge {
	readonly scheme: string;
	readonly params: Record<string, string>;
}

/** `Bearer realm="…",service="…",scope="…"`, read without a general header parser. */
export function parseChallenge(header: string | null): Challenge | null {
	if (!header) {
		return null;
	}
	const match = /^\s*([A-Za-z]+)\s*(.*)$/.exec(header);
	if (!match) {
		return null;
	}
	const params: Record<string, string> = {};
	const re = /([A-Za-z_]+)="([^"]*)"/g;
	let one: RegExpExecArray | null;
	while ((one = re.exec(match[2] ?? '')) !== null) {
		params[(one[1] ?? '').toLowerCase()] = one[2] ?? '';
	}
	return { scheme: (match[1] ?? '').toLowerCase(), params };
}

function basic(credential: RegistryCredential): string {
	return `Basic ${btoa(`${credential.username}:${credential.password}`)}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const hash = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A client for one repository on one registry, which gets a token when the registry asks for one
 * and keeps it for the next request (a manifest then a config blob is the common pair).
 */
function registryClient(ref: ImageReference, credential: RegistryCredential | null, fetcher: Fetch) {
	const base = registryApiBase(ref.registry);
	let authorization: string | null = null;

	async function get(path: string, accept: string) {
		const headers: Record<string, string> = { accept };
		if (authorization) {
			headers.authorization = authorization;
		}
		let response = await fetcher(`${base}/v2/${ref.repository}/${path}`, { headers });
		if (response.status !== 401 || authorization) {
			return response;
		}
		const challenge = parseChallenge(response.headers.get('www-authenticate'));
		if (challenge?.scheme === 'basic') {
			if (!credential) {
				return response;
			}
			authorization = basic(credential);
		} else if (challenge?.scheme === 'bearer' && challenge.params.realm) {
			const realm = new URL(challenge.params.realm);
			if (challenge.params.service) {
				realm.searchParams.set('service', challenge.params.service);
			}
			realm.searchParams.set('scope', challenge.params.scope ?? `repository:${ref.repository}:pull`);
			const tokenHeaders: Record<string, string> = {};
			if (credential) {
				tokenHeaders.authorization = basic(credential);
			}
			const tokenResponse = await fetcher(realm.toString(), { headers: tokenHeaders });
			if (tokenResponse.status !== 200) {
				return response;
			}
			const body = JSON.parse(await tokenResponse.text()) as { token?: string; access_token?: string };
			const token = body.token ?? body.access_token;
			if (!token) {
				return response;
			}
			authorization = `Bearer ${token}`;
		} else {
			return response;
		}
		response = await fetcher(`${base}/v2/${ref.repository}/${path}`, {
			headers: { accept, authorization }
		});
		return response;
	}

	return { get };
}

interface ManifestDescriptor {
	mediaType?: string;
	digest?: string;
	platform?: { os?: string; architecture?: string; variant?: string };
}

interface ManifestBody {
	mediaType?: string;
	manifests?: ManifestDescriptor[];
	config?: { digest?: string };
}

function platformName(p: { os?: string; architecture?: string; variant?: string }): string {
	return [p.os ?? '?', p.architecture ?? '?', p.variant].filter(Boolean).join('/');
}

/**
 * Ask the registry what `ref` points at, and whether it can run on the fleet.
 *
 * Returns the digest of what was asked for (an index stays an index: podman picks the arm64 entry
 * on an arm64 host, and pinning the index keeps `podman inspect` showing what the customer
 * deployed). The platforms are read from the index, or from the image's config when there is only
 * one image. Every refusal is a sentence the CLI prints as it is.
 */
export async function resolveImage(
	ref: ImageReference,
	credential: RegistryCredential | null,
	fetcher: Fetch
): Promise<ResolvedImage> {
	const shown = formatImageReference(ref);
	const client = registryClient(ref, credential, fetcher);
	const wanted = ref.digest ?? ref.tag ?? 'latest';
	let response;
	try {
		response = await client.get(`manifests/${wanted}`, MANIFEST_ACCEPT);
	} catch (error) {
		return { ok: false, reason: `could not reach ${ref.registry}: ${(error as Error).message}` };
	}
	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			reason: credential
				? `${ref.registry} refused these registry credentials for ${shown}.`
				: `${shown} is private, or does not exist. If it is private, deploy with --registry-user and a token.`
		};
	}
	if (response.status === 404) {
		return { ok: false, reason: `${ref.registry} has no ${shown}.` };
	}
	if (response.status === 429) {
		return { ok: false, reason: `${ref.registry} is rate limiting pulls right now; try again in a minute.` };
	}
	if (response.status !== 200) {
		return { ok: false, reason: `${ref.registry} answered ${response.status} for ${shown}.` };
	}
	const bytes = await response.arrayBuffer();
	const headerDigest = response.headers.get('docker-content-digest');
	const digest = headerDigest && isDigest(headerDigest) ? headerDigest : `sha256:${await sha256Hex(bytes)}`;
	if (ref.digest && digest !== ref.digest) {
		return { ok: false, reason: `${ref.registry} served ${digest} for ${shown}, which is not the digest asked for.` };
	}
	let body: ManifestBody;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes)) as ManifestBody;
	} catch {
		return { ok: false, reason: `${ref.registry} sent a manifest for ${shown} that is not JSON.` };
	}

	let platforms: string[] = [];
	if (Array.isArray(body.manifests)) {
		platforms = body.manifests
			.filter((m) => m.platform && m.platform.architecture !== 'unknown')
			.map((m) => platformName(m.platform ?? {}));
	} else if (body.config?.digest) {
		const config = await client.get(`blobs/${body.config.digest}`, '*/*');
		if (config.status !== 200) {
			return { ok: false, reason: `${ref.registry} would not serve the configuration of ${shown} (${config.status}).` };
		}
		try {
			const parsed = JSON.parse(await config.text()) as { os?: string; architecture?: string; variant?: string };
			platforms = [platformName(parsed)];
		} catch {
			return { ok: false, reason: `the configuration of ${shown} is not JSON.` };
		}
	}
	const runs = platforms.some((p) => p === `${FLEET_PLATFORM.os}/${FLEET_PLATFORM.architecture}` || p.startsWith(`${FLEET_PLATFORM.os}/${FLEET_PLATFORM.architecture}/`));
	if (!runs) {
		return {
			ok: false,
			reason:
				`${shown} is built for ${platforms.length > 0 ? platforms.join(', ') : 'an unknown platform'}, and SnoutData runs linux/arm64. ` +
				`Build it for arm64 too: docker buildx build --platform linux/amd64,linux/arm64 --push .`
		};
	}
	return { ok: true, digest, platforms };
}

// ------------------------------------------------------------------------------
// The plan
// ------------------------------------------------------------------------------

export interface ContainerAllowance {
	readonly deployed: number;
	readonly maxContainers: number;
	readonly memoryMb: number;
	readonly cpuPercent: number;
}

export function mayDeployContainer(
	allowance: ContainerAllowance,
	name: string,
	existing: readonly string[]
): { ok: true } | { ok: false; reason: string } {
	const bad = checkContainerName(name);
	if (bad) {
		return { ok: false, reason: bad };
	}
	if (allowance.maxContainers <= 0) {
		return {
			ok: false,
			reason: 'Containers run on the Plus and Pro plans, because a container runs all the time. Upgrade this project\'s plan to deploy one.'
		};
	}
	if (existing.includes(name)) {
		// A redeploy is not a new slot, so a project at its limit can still ship a fix.
		return { ok: true };
	}
	if (allowance.deployed >= allowance.maxContainers) {
		return {
			ok: false,
			reason: `this plan runs ${allowance.maxContainers} container${allowance.maxContainers === 1 ? '' : 's'} and this project has ${allowance.deployed}. Remove one, or move to a larger plan.`
		};
	}
	return { ok: true };
}

// ------------------------------------------------------------------------------
// The environment
// ------------------------------------------------------------------------------

/**
 * What a container is given on top of the project's secrets: the platform's variables, the
 * database (the owner's connection string, through the public front door) and `PORT`. A customer's own `DATABASE_URL` or `PORT` secret wins over
 * ours, because it is theirs to point somewhere else; the `SNOUTDATA_*` names cannot be theirs
 * (`RESERVED_SECRET_PREFIXES`), so ours are always what we say they are.
 */
export function containerEnvironment(input: {
	platform: Record<string, string>;
	secrets: Record<string, string>;
	databaseUrl: string | null;
	port: number;
}): Record<string, string> {
	const env: Record<string, string> = {};
	if (input.databaseUrl) {
		env.DATABASE_URL = input.databaseUrl;
	}
	env.PORT = String(input.port);
	Object.assign(env, input.secrets);
	Object.assign(env, input.platform);
	if (input.databaseUrl) {
		env.SNOUTDATA_DB_URL = input.databaseUrl;
	}
	return env;
}

/** `postgresql://` for the project's owner through the front door (`asPublicProject`'s shape). */
export function ownerDatabaseUrl(input: { ref: string; role: string; password: string; dbDomain: string }): string {
	return `postgresql://${encodeURIComponent(input.role)}:${encodeURIComponent(input.password)}@${input.ref}.${input.dbDomain}:5432/${input.ref}?sslmode=require`;
}
