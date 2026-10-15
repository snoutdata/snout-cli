// GENERATED: a copy of SnoutData's control-plane code (containers.ts).
// Do not edit here: edits are overwritten by the build.
/**
 * Snout Containers: what a container IS, decided once for the CLI, the control plane and the host
 * agent. A container is one image of the customer's that runs for as long as the project does,
 * under gVisor, reachable at `/containers/v1/<name>/` on the project's API address.
 *
 * Pure. The one impure step, asking a registry what a tag points at, takes `fetch` and a DNS
 * resolver as arguments, so the same code resolves a digest in a Snout Function and in a test
 * against a fake registry, and only ever asks the public internet (`RegistryNetwork`).
 *
 * What lives here:
 *   - the name rule (a URL segment, a podman container name and part of a systemd unit name);
 *   - reading an image reference the way `docker pull` reads it, so `nginx` means
 *     `docker.io/library/nginx:latest` here too;
 *   - resolving a reference to a digest and checking it can run on the fleet (`linux/arm64`);
 *   - how large that image is, and the cap on it (CT26);
 *   - where the copy in our registry lives (CT25), and that nobody deploys from it by naming it;
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
	/** `bytes`: what the linux/arm64 image is, compressed (its config and layers), as a host pulls it. */
	| { ok: true; digest: string; platforms: string[]; bytes: number }
	| { ok: false; reason: string };

const MANIFEST_ACCEPT = [
	'application/vnd.oci.image.index.v1+json',
	'application/vnd.docker.distribution.manifest.list.v2+json',
	'application/vnd.oci.image.manifest.v1+json',
	'application/vnd.docker.distribution.manifest.v2+json'
].join(', ');

/** What `RegistryFetch` answers: a `fetch` Response is one, and so is the host agent's own (`host/registryPull.ts`). */
export interface RegistryResponse {
	readonly status: number;
	readonly headers: { get(name: string): string | null };
	text(): Promise<string>;
	arrayBuffer(): Promise<ArrayBuffer>;
	/** Let go of a response nobody will read (a redirect hop, a 401 that is asked again). */
	discard?(): void;
}

export type RegistryFetch<R extends RegistryResponse = RegistryResponse> = (
	input: string,
	init?: { method?: string; headers?: Record<string, string>; redirect?: 'manual' }
) => Promise<R>;

type Fetch = RegistryFetch;

// ------------------------------------------------------------------------------
// Where a registry may be: the public internet, over https, on 443
// ------------------------------------------------------------------------------

/**
 * A deploy names the registry, so without this the control plane would GET any host the caller
 * chose, follow that host's `WWW-Authenticate` realm to any URL, and hand the status back in the
 * error: a blind SSRF and port probe from the control plane's own egress (security check,
 * 2026-10-15). So every URL this module fetches, the registry, its token realm and every redirect
 * hop, is checked first:
 *
 *   - `https:` on 443 only (`KNOWN_REGISTRY_PORTS` is where a known registry on another port would
 *     be allowed; it is empty, because none needs one);
 *   - the host, as the WHATWG URL parser reads it (so `2130706433`, `0x7f.1` and `127.1` are the
 *     loopback they are), resolved to EVERY address it has, and each one public: never loopback,
 *     private, link-local (169.254/16, the metadata service), CGNAT, multicast, reserved,
 *     documentation, unique-local or link-local IPv6, or an IPv4 range hidden in IPv6;
 *   - a token realm, in addition, on the registry's own registrable domain or a known token host;
 *   - redirects followed by hand (at most `MAX_REDIRECTS`), each hop checked again, with the
 *     credential dropped when one leaves the registry's origin.
 *
 * And whatever went wrong on the way, the caller reads `REGISTRY_UNREACHABLE` and nothing more: no
 * status, no exception text, so a refused address and a closed port read the same.
 *
 * The network the caller runs on is a second layer, not a replacement: a name can be rebound
 * between this lookup and the fetch's own, and no fetch API here lets the address be pinned. What
 * that layer is for the control plane is written where the resolver is handed in (the
 * `cloud-project-containers` function), since it is a fact about that deployment, not about this.
 */

/** What the caller reads for anything refused or failed on the way to a registry. */
export const REGISTRY_UNREACHABLE = 'the registry could not be reached.';

/** A known registry that answers on a port other than 443, host to ports. None does today. */
export const KNOWN_REGISTRY_PORTS: Readonly<Record<string, readonly number[]>> = {};

/** Hosts a token realm may be on whatever the registry is called (`*.` is any subdomain). */
export const KNOWN_TOKEN_HOSTS: readonly string[] = [
	'auth.docker.io',
	'ghcr.io',
	'*.amazonaws.com',
	'gcr.io',
	'*.gcr.io',
	'*.pkg.dev',
	'quay.io',
	'registry.gitlab.com',
	'gitlab.com'
];

export const MAX_REDIRECTS = 5;

/**
 * How a registry's addresses are found. `resolve` answers every A and AAAA address of a host name
 * (an empty list, or a throw, is "cannot be reached"). `'trusted'` skips the address check and is
 * only for a registry that is OURS, never one a deploy named (the host agent checking its own copy).
 */
export type RegistryNetwork = { resolve(host: string): Promise<readonly string[]> } | 'trusted';

class Unreachable extends Error {}

function parseIPv4(text: string): number[] | null {
	const parts = text.split('.');
	if (parts.length !== 4) {
		return null;
	}
	const out: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) {
			return null;
		}
		const n = Number(part);
		if (n > 255) {
			return null;
		}
		out.push(n);
	}
	return out;
}

/** Eight 16-bit groups, or null. Accepts `::` and a dotted IPv4 tail (`::ffff:1.2.3.4`). */
function parseIPv6(text: string): number[] | null {
	let s = text.replace(/^\[|\]$/g, '');
	const zone = s.indexOf('%');
	if (zone !== -1) {
		s = s.slice(0, zone);
	}
	if (!/^[0-9a-fA-F:.]+$/.test(s) || !s.includes(':')) {
		return null;
	}
	const lastColon = s.lastIndexOf(':');
	if (s.slice(lastColon + 1).includes('.')) {
		const v4 = parseIPv4(s.slice(lastColon + 1));
		if (!v4) {
			return null;
		}
		s = `${s.slice(0, lastColon + 1)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
	}
	const halves = s.split('::');
	if (halves.length > 2) {
		return null;
	}
	const groups = (half: string) => (half === '' ? [] : half.split(':'));
	const head = groups(halves[0] ?? '');
	const rest = halves.length === 2 ? groups(halves[1] ?? '') : [];
	if ([...head, ...rest].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) {
		return null;
	}
	const known = head.length + rest.length;
	if (halves.length === 1 ? known !== 8 : known > 7) {
		return null;
	}
	const zeros = new Array<number>(8 - known).fill(0);
	return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16))];
}

function inV4(ip: number[], base: string, bits: number): boolean {
	const b = parseIPv4(base) as number[];
	const value = (a: number[]) => ((a[0]! << 24) | (a[1]! << 16) | (a[2]! << 8) | a[3]!) >>> 0;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value(ip) & mask) === (value(b) & mask);
}

/** Not the public internet: special-purpose ranges (RFC 6890 and successors). */
const V4_NOT_PUBLIC: readonly [string, number][] = [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4]
];

function isPublicV4(ip: number[]): boolean {
	return !V4_NOT_PUBLIC.some(([base, bits]) => inV4(ip, base, bits));
}

function isPublicV6(g: number[]): boolean {
	// IPv4-mapped (::ffff:0:0/96) and the deprecated IPv4-compatible (::/96): judged as the IPv4.
	if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
		if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) {
			return false; // `::` and `::1`
		}
		return isPublicV4([g[6]! >> 8, g[6]! & 0xff, g[7]! >> 8, g[7]! & 0xff]);
	}
	// Only global unicast (2000::/3) is the internet, and inside it: documentation (2001:db8::/32),
	// Teredo and the other 2001::/23 protocol assignments, 6to4 (2002::/16), which hide an IPv4
	// address we would otherwise have to judge, are refused outright. 64:ff9b::/96 (NAT64) and
	// fc00::/7, fe80::/10, ff00::/8 fall outside 2000::/3.
	if ((g[0]! & 0xe000) !== 0x2000) {
		return false;
	}
	if (g[0] === 0x2001 && (g[1]! < 0x0200 || g[1] === 0x0db8)) {
		return false;
	}
	return g[0] !== 0x2002;
}

/** True when `address` (an IPv4 or IPv6 literal) is on the public internet. Anything else is false. */
export function isPublicAddress(address: string): boolean {
	const v4 = parseIPv4(address);
	if (v4) {
		return isPublicV4(v4);
	}
	const v6 = parseIPv6(address);
	return v6 ? isPublicV6(v6) : false;
}

/** Two-label public suffixes common enough to matter for "the same registrable domain". */
const TWO_LEVEL_SUFFIXES = new Set([
	'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp', 'or.jp',
	'com.br', 'com.cn', 'com.hk', 'com.sg', 'com.tw', 'co.in', 'co.kr', 'co.za', 'com.mx', 'com.ar', 'com.tr'
]);

/** `registry-1.docker.io` → `docker.io`; `cr.acme.co.uk` → `acme.co.uk`. Without the full list, so approximate. */
export function registrableDomain(host: string): string {
	const labels = host.toLowerCase().replace(/\.$/, '').split('.');
	const take = labels.length >= 3 && TWO_LEVEL_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
	return labels.slice(-take).join('.');
}

function matchesHost(host: string, pattern: string): boolean {
	return pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern;
}

/** Whether a token realm on `realmHost` may be asked for a token on behalf of `registryHost`. */
export function isAllowedRealmHost(realmHost: string, registryHost: string): boolean {
	const realm = realmHost.toLowerCase();
	return registrableDomain(realm) === registrableDomain(registryHost) || KNOWN_TOKEN_HOSTS.some((p) => matchesHost(realm, p));
}

/**
 * Throws `Unreachable` unless `url` is https on an allowed port and every address of its host is
 * public. The host is read by the URL parser, which is what the fetch will connect to.
 */
async function checkRegistryUrl(url: URL, network: RegistryNetwork): Promise<void> {
	if (url.protocol !== 'https:' || url.username || url.password) {
		throw new Unreachable();
	}
	const host = url.hostname.toLowerCase();
	if (url.port !== '' && !(KNOWN_REGISTRY_PORTS[host] ?? []).includes(Number(url.port))) {
		throw new Unreachable();
	}
	if (network === 'trusted') {
		return;
	}
	if (parseIPv4(host) || host.startsWith('[')) {
		if (!isPublicAddress(host)) {
			throw new Unreachable();
		}
		return;
	}
	let addresses: readonly string[];
	try {
		addresses = await network.resolve(host);
	} catch {
		throw new Unreachable();
	}
	if (addresses.length === 0 || !addresses.every(isPublicAddress)) {
		throw new Unreachable();
	}
}

/** One GET with every redirect followed by hand and checked; the credential stays on its origin. */
async function guardedGet<R extends RegistryResponse>(
	start: URL,
	headers: Record<string, string>,
	fetcher: RegistryFetch<R>,
	network: RegistryNetwork
): Promise<R> {
	let url = start;
	const sent = { ...headers };
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await checkRegistryUrl(url, network);
		let response;
		try {
			response = await fetcher(url.toString(), { headers: sent, redirect: 'manual' });
		} catch {
			throw new Unreachable();
		}
		if (![301, 302, 303, 307, 308].includes(response.status)) {
			return response;
		}
		response.discard?.();
		const location = response.headers.get('location');
		if (!location) {
			throw new Unreachable();
		}
		let next: URL;
		try {
			next = new URL(location, url);
		} catch {
			throw new Unreachable();
		}
		if (next.origin !== url.origin) {
			delete sent.authorization;
		}
		url = next;
	}
	throw new Unreachable();
}

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

/** A client for one repository: `get('manifests/<digest>', accept)`, `get('blobs/<digest>', accept)`. */
export interface RegistryClient<R extends RegistryResponse = RegistryResponse> {
	get(path: string, accept: string): Promise<R>;
}

/**
 * A client for one repository on one registry, which gets a token when the registry asks for one
 * and keeps it for the next request (a manifest then a config blob is the common pair). Every URL
 * it fetches passes the public-internet check above; anything refused throws, and the caller says
 * `REGISTRY_UNREACHABLE` and nothing more. The host agent copies a customer's image through this
 * too (`host/registryPull.ts`), so the rule is written once.
 */
export function registryClient<R extends RegistryResponse>(
	ref: ImageReference,
	credential: RegistryCredential | null,
	fetcher: RegistryFetch<R>,
	network: RegistryNetwork
): RegistryClient<R> {
	const base = new URL(`${registryApiBase(ref.registry)}/v2/${ref.repository}/`);
	let authorization: string | null = null;

	function at(path: string): URL {
		return new URL(path, base);
	}

	async function get(path: string, accept: string) {
		const headers: Record<string, string> = { accept };
		if (authorization) {
			headers.authorization = authorization;
		}
		const first = await guardedGet(at(path), headers, fetcher, network);
		if (first.status !== 401 || authorization) {
			return first;
		}
		const response = first;
		const challenge = parseChallenge(response.headers.get('www-authenticate'));
		if (challenge?.scheme === 'basic') {
			if (!credential) {
				return response;
			}
			authorization = basic(credential);
		} else if (challenge?.scheme === 'bearer' && challenge.params.realm) {
			// The realm is the registry's word, so it is held to the registry's rules and one more:
			// it is on the registry's own domain or a known token host, never wherever it points.
			let realm: URL;
			try {
				realm = new URL(challenge.params.realm);
			} catch {
				throw new Unreachable();
			}
			if (!isAllowedRealmHost(realm.hostname, base.hostname)) {
				throw new Unreachable();
			}
			if (challenge.params.service) {
				realm.searchParams.set('service', challenge.params.service);
			}
			realm.searchParams.set('scope', challenge.params.scope ?? `repository:${ref.repository}:pull`);
			const tokenHeaders: Record<string, string> = {};
			if (credential) {
				tokenHeaders.authorization = basic(credential);
			}
			const tokenResponse = await guardedGet(realm, tokenHeaders, fetcher, network);
			if (tokenResponse.status !== 200) {
				return response;
			}
			let token: string | undefined;
			try {
				const body = JSON.parse(await tokenResponse.text()) as { token?: string; access_token?: string };
				token = body.token ?? body.access_token;
			} catch {
				token = undefined;
			}
			if (typeof token !== 'string' || token === '') {
				return response;
			}
			authorization = `Bearer ${token}`;
		} else {
			return response;
		}
		response.discard?.();
		return guardedGet(at(path), { accept, authorization }, fetcher, network);
	}

	return { get };
}

interface ManifestDescriptor {
	mediaType?: string;
	digest?: string;
	size?: number;
	platform?: { os?: string; architecture?: string; variant?: string };
}

export interface ManifestBody {
	mediaType?: string;
	manifests?: ManifestDescriptor[];
	config?: { mediaType?: string; digest?: string; size?: number };
	layers?: { mediaType?: string; digest?: string; size?: number }[];
}

/** What a single image's manifest says it weighs: the config and every layer, compressed. */
function imageBytes(body: ManifestBody): number {
	let total = Number(body.config?.size) || 0;
	for (const layer of body.layers ?? []) {
		total += Number(layer.size) || 0;
	}
	return total;
}

function runsOnFleet(platform: string): boolean {
	const wanted = `${FLEET_PLATFORM.os}/${FLEET_PLATFORM.architecture}`;
	return platform === wanted || platform.startsWith(`${wanted}/`);
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
	fetcher: Fetch,
	network: RegistryNetwork
): Promise<ResolvedImage> {
	try {
		return await resolveChecked(ref, credential, fetcher, network);
	} catch {
		// A refused address, a refused realm or redirect, a network error, a body that would not
		// read: one sentence for all of them, so none of them is an oracle (see REGISTRY_UNREACHABLE).
		return { ok: false, reason: REGISTRY_UNREACHABLE };
	}
}

async function resolveChecked(
	ref: ImageReference,
	credential: RegistryCredential | null,
	fetcher: Fetch,
	network: RegistryNetwork
): Promise<ResolvedImage> {
	const shown = formatImageReference(ref);
	const client = registryClient(ref, credential, fetcher, network);
	const wanted = ref.digest ?? ref.tag ?? 'latest';
	const response = await client.get(`manifests/${wanted}`, MANIFEST_ACCEPT);
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
		return { ok: false, reason: REGISTRY_UNREACHABLE };
	}
	const raw = await response.arrayBuffer();
	const headerDigest = response.headers.get('docker-content-digest');
	const digest = headerDigest && isDigest(headerDigest) ? headerDigest : `sha256:${await sha256Hex(raw)}`;
	if (ref.digest && digest !== ref.digest) {
		return { ok: false, reason: `${ref.registry} served ${digest} for ${shown}, which is not the digest asked for.` };
	}
	let body: ManifestBody;
	try {
		body = JSON.parse(new TextDecoder().decode(raw)) as ManifestBody;
	} catch {
		return { ok: false, reason: `${ref.registry} sent a manifest for ${shown} that is not JSON.` };
	}

	let platforms: string[] = [];
	let bytes = imageBytes(body);
	if (Array.isArray(body.manifests)) {
		const listed = body.manifests.filter((m) => m.platform && m.platform.architecture !== 'unknown');
		platforms = listed.map((m) => platformName(m.platform ?? {}));
		// The one image a host pulls out of the index, for its size: the cap is on what we store and
		// pull (CT26), and the other platforms are never copied.
		const ours = listed.find((m) => runsOnFleet(platformName(m.platform ?? {})));
		if (ours) {
			if (!ours.digest || !isDigest(ours.digest)) {
				return { ok: false, reason: `the linux/arm64 entry of ${shown} has no digest.` };
			}
			const child = await client.get(`manifests/${ours.digest}`, MANIFEST_ACCEPT);
			if (child.status !== 200) {
				return { ok: false, reason: `${ref.registry} would not serve the linux/arm64 image of ${shown}.` };
			}
			try {
				bytes = imageBytes(JSON.parse(await child.text()) as ManifestBody);
			} catch {
				return { ok: false, reason: `the linux/arm64 image of ${shown} has a manifest that is not JSON.` };
			}
		}
	} else if (body.config?.digest) {
		const config = await client.get(`blobs/${body.config.digest}`, '*/*');
		if (config.status !== 200) {
			return { ok: false, reason: `${ref.registry} would not serve the configuration of ${shown}.` };
		}
		try {
			const parsed = JSON.parse(await config.text()) as { os?: string; architecture?: string; variant?: string };
			platforms = [platformName(parsed)];
		} catch {
			return { ok: false, reason: `the configuration of ${shown} is not JSON.` };
		}
	}
	if (!platforms.some(runsOnFleet)) {
		return {
			ok: false,
			reason:
				`${shown} is built for ${platforms.length > 0 ? platforms.join(', ') : 'an unknown platform'}, and SnoutData runs linux/arm64. ` +
				`Build it for arm64 too: docker buildx build --platform linux/amd64,linux/arm64 --push .`
		};
	}
	return { ok: true, digest, platforms, bytes };
}

/** The one linux/arm64 image a pinned reference names: its manifest, exactly as the registry signed it. */
export interface FleetImageManifest {
	readonly digest: string;
	readonly mediaType: string;
	readonly raw: Uint8Array;
	readonly body: ManifestBody;
}

/**
 * The linux/arm64 image manifest of `digest` (an index's arm64 entry, or the image itself), each
 * manifest checked against the digest it was asked for. Throws on anything else, which the caller
 * reads as `REGISTRY_UNREACHABLE`: this is the host agent copying an image the control plane
 * already resolved, so there is nothing new for the customer to learn from why.
 */
export async function fleetImageManifest<R extends RegistryResponse>(client: RegistryClient<R>, digest: string): Promise<FleetImageManifest> {
	async function manifest(wanted: string): Promise<FleetImageManifest> {
		if (!isDigest(wanted)) {
			throw new Unreachable();
		}
		const response = await client.get(`manifests/${wanted}`, MANIFEST_ACCEPT);
		if (response.status !== 200) {
			response.discard?.();
			throw new Unreachable();
		}
		const buffer = await response.arrayBuffer();
		const raw = new Uint8Array(buffer);
		if (`sha256:${await sha256Hex(buffer)}` !== wanted) {
			throw new Unreachable();
		}
		let body: ManifestBody;
		try {
			body = JSON.parse(new TextDecoder().decode(raw)) as ManifestBody;
		} catch {
			throw new Unreachable();
		}
		const mediaType = body.mediaType ?? (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
		return { digest: wanted, mediaType, raw, body };
	}
	const top = await manifest(digest);
	if (!Array.isArray(top.body.manifests)) {
		return top;
	}
	const ours = top.body.manifests.find((m) => m.platform && runsOnFleet(platformName(m.platform)));
	const child = await manifest(ours?.digest ?? '');
	if (Array.isArray(child.body.manifests)) {
		throw new Unreachable();
	}
	return child;
}

/**
 * The most a container's image may weigh, compressed, as its linux/arm64 image (CT26). It is stored
 * in our registry for as long as the container exists and unpacked on the host's disk beside every
 * other project's, so it has a ceiling; 1 GB holds a Node, Python, Go or JVM service with room to
 * spare, and is $0.10 a month of registry at most.
 */
export const MAX_IMAGE_BYTES = 1024 ** 3;

/** Null when the image fits; the sentence the CLI prints when it does not. */
export function imageSizeRefusal(image: string, bytes: number): string | null {
	if (bytes <= MAX_IMAGE_BYTES) {
		return null;
	}
	const size = (n: number) => `${Math.round((n / 1024 ** 3) * 10) / 10} GB`;
	return `${image} is ${size(bytes)} compressed, and a container's image may be at most ${size(MAX_IMAGE_BYTES)}. A slimmer base (alpine, distroless, -slim) usually fixes it.`;
}

// ------------------------------------------------------------------------------
// The copy in our registry (CT25)
// ------------------------------------------------------------------------------

/**
 * Where a project's images are copied, below the fleet's registry: one repository per project, so
 * a credential can be scoped to it. It lives in the fleet account, whose names never contain "snout".
 */
export const COPY_REPOSITORY_PREFIX = 's-fleet/ct';

/** `s-fleet/ct/<ref>`: the repository a project's copies and pushed images live in. */
export function copyRepositoryPath(ref: string): string {
	if (!/^[a-z][a-z0-9]{12}$/.test(ref)) {
		throw new Error(`not a project ref: ${JSON.stringify(ref)}`);
	}
	return `${COPY_REPOSITORY_PREFIX}/${ref}`;
}

/**
 * True for an image in one of OUR repositories, whatever registry is named. A deploy may not name
 * one: they hold every project's copies, and the only way in is `deploy --dockerfile`, which pushes
 * to the project's own with a credential scoped to it.
 */
export function isFleetRepository(ref: ImageReference): boolean {
	return ref.repository === 's-fleet' || ref.repository.startsWith('s-fleet/');
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
