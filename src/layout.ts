/**
 * Which paths and which key header this CLI speaks to a SnoutData door.
 *
 * The CLI speaks the current vocabulary: `/v1/fn/<name>`, `/v1/identity/...` and the
 * `Snout-Key` header. A door deployed before those names existed answers a new path with a 404
 * (it matches the path before it reads any credential), so on a 404 from a new path the same
 * request is sent once more on the earlier path with the `apikey` header, and when THAT is
 * answered by something other than a 404, the host is remembered as one that speaks only the
 * earlier names, for the rest of this run. A 404 on both is a real 404 and is returned as one.
 *
 * Nothing about a request changes but its path and the name of its key header: same method,
 * same body, same headers otherwise.
 */

import { CliFailure } from './failure.js';

/** A route under each vocabulary: the new path first, the path a door older than it serves. */
export interface Route {
	readonly path: string;
	readonly oldPath: string;
}

/** The header a door reads the app key from, in each vocabulary. */
export const KEY_HEADER = 'Snout-Key';
const OLD_KEY_HEADER = 'apikey';

/** Hosts that answered a new path 404 and its earlier path with something else, this run. */
const oldHosts = new Set<string>();

function hostOf(base: string): string {
	try {
		return new URL(base).host;
	} catch {
		return base;
	}
}

/** A function on the door: `/v1/fn/<name>`, earlier `/functions/v1/<name>`. */
export function fnRoute(name: string, query = ''): Route {
	return { path: `/v1/fn/${name}${query}`, oldPath: `/functions/v1/${name}${query}` };
}

/** A data API route: `/v1/data<route>`, earlier `/rest/v1<route>` (a procedure is `/rpc/<name>`). */
export function dataRoute(route: string): Route {
	return { path: `/v1/data${route}`, oldPath: `/rest/v1${route}` };
}

/** An identity route: `/v1/identity<route>`, earlier `/auth/v1<oldRoute>`. */
export function identityRoute(route: string, oldRoute: string): Route {
	return { path: `/v1/identity${route}`, oldPath: `/auth/v1${oldRoute}` };
}

/** Whether this run has learned that `base` serves only the earlier names. */
export function speaksOld(base: string): boolean {
	return oldHosts.has(hostOf(base));
}

/** For tests: forget what this run has learned. */
export function forgetHosts(): void {
	oldHosts.clear();
}

function withKey(headers: Record<string, string>, key: string | undefined, old: boolean): Record<string, string> {
	if (key === undefined) {
		return headers;
	}
	return { ...headers, [old ? OLD_KEY_HEADER : KEY_HEADER]: key };
}

export interface DoorRequest {
	readonly method?: string;
	readonly headers?: Record<string, string>;
	readonly body?: string;
	/** The app key, sent as `Snout-Key` on a new path and as `apikey` on an earlier one. */
	readonly key?: string;
	/** The request only reads, so one lost on the network may be sent again whatever its method. */
	readonly readOnly?: boolean;
}

/** How long to wait before each further try of a request lost on the network. */
const RETRY_DELAYS_MS = [500, 1500];

/** Failed before anything was sent: any request may be tried again, a write included. */
const NOT_SENT = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** The errno-like code and the words of the deepest cause of a network failure. */
function networkCause(error: unknown): { code: string; reason: string } {
	let cursor: unknown = error;
	for (let depth = 0; depth < 4 && cursor instanceof Error && cursor.cause; depth += 1) {
		cursor = cursor.cause;
	}
	const code = typeof cursor === 'object' && cursor && 'code' in cursor ? String((cursor as { code: unknown }).code) : '';
	const words = cursor instanceof Error ? cursor.message : String(cursor);
	return { code, reason: code && !words.includes(code) ? `${code}: ${words}` : words };
}

/**
 * `fetch`, against `base`, on the route's new path, falling back to its earlier path once.
 *
 * `fetcher` is there for tests; everything else gets the global `fetch`.
 */
export async function doorFetch(
	base: string,
	route: Route,
	request: DoorRequest = {},
	fetcher: typeof fetch = fetch,
	wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<Response> {
	const host = hostOf(base);
	const headers = request.headers ?? {};
	const safe = request.readOnly === true || (request.method ?? 'GET') === 'GET';
	async function send(old: boolean): Promise<Response> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await fetcher(`${base}${old ? route.oldPath : route.path}`, {
					method: request.method ?? 'GET',
					headers: withKey(headers, request.key, old),
					body: request.body
				});
			} catch (error) {
				if (!(error instanceof TypeError)) {
					throw error;
				}
				const { code, reason } = networkCause(error);
				const delay = RETRY_DELAYS_MS[attempt];
				if (delay === undefined || !(safe || NOT_SENT.has(code))) {
					throw new CliFailure('network', `Could not reach ${host}: ${reason}.`);
				}
				await wait(delay);
			}
		}
	}
	if (oldHosts.has(host)) {
		return send(true);
	}
	const response = await send(false);
	if (response.status !== 404) {
		return response;
	}
	const retried = await send(true);
	if (retried.status === 404) {
		// A 404 under both names is the answer, not a vocabulary the door lacks.
		return response;
	}
	oldHosts.add(host);
	return retried;
}

/**
 * The URL for a route a BROWSER is sent to, which cannot fall back by itself.
 *
 * When this run has not yet heard from `base`, one cheap read (the identity service's health,
 * under its new name) decides it: a 404 there means the door serves only the earlier names.
 */
export async function browserUrl(base: string, route: Route, key: string | undefined, fetcher: typeof fetch = fetch): Promise<string> {
	if (!oldHosts.has(hostOf(base))) {
		try {
			await doorFetch(base, identityRoute('/health', '/health'), { key }, fetcher);
		} catch {
			// Unreachable: the browser will say so, under the new name.
		}
	}
	return `${base}${speaksOld(base) ? route.oldPath : route.path}`;
}
