/**
 * The control plane, from a terminal.
 *
 * Every call is a POST to a Snout Function with the user's own JWT, which is the same
 * door the dashboard will use — the CLI is not privileged and has no key of its own.
 * That is what makes `SNOUTDATA_ACCESS_TOKEN` in a CI job exactly as capable as a person
 * at a laptop, and no more.
 *
 * The anon key is public by design (it identifies the project, RLS decides the rest) and
 * is baked in so that `npx snoutdata` needs no configuration at all.
 */

import { findLink, isExpired, readAuth, writeAuth, type StoredAuth } from './config.js';
import { localConnection, localStackFor, type LocalStack } from './local.js';
import { CliFailure } from './failure.js';
import { explainNoHuman, noHumanReason } from './interactive.js';
import { climb } from './ladder.js';
import { warn } from './output.js';
import { CLIENT_INFO, VERSION, outdatedAdvice } from './version.js';

export const ACCOUNTS_URL = process.env.SNOUTDATA_ACCOUNTS_URL ?? 'https://accounts.snoutdata.com';
export const ANON_KEY =
	process.env.SNOUTDATA_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzbm91dGRhdGEiLCJyZWYiOiJ6ZjdnNjVtYjhmYXJhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4MDcwNDcsImV4cCI6MjEwNDg3NTUyNH0.M-Cb0wFEhJXU21cXtQxZAn-WnRcq4rK2uNSkeHdLucY';
export const FUNCTIONS = `${ACCOUNTS_URL}/functions/v1`;

export class ApiError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export class NotSignedIn extends Error {
	constructor(message?: string) {
		super(message ?? notSignedInAdvice());
	}
}

/**
 * What would have fixed it, given where this is running.
 *
 * A script that stops with "not signed in: run `snoutdata login`" has been told to do the
 * one thing it cannot do, since `login` needs a browser. Where there is nobody to run it,
 * say the thing that works instead, and say why nothing was offered (D1).
 */
function notSignedInAdvice(): string {
	const reason = noHumanReason();
	if (reason) {
		return `not signed in, and ${explainNoHuman(reason)}. Set SNOUTDATA_ACCESS_TOKEN to a token made at https://dashboard.snoutdata.com/#/tokens, or by \`snoutdata tokens create\` on a machine that is signed in.`;
	}
	return 'not signed in: run `snoutdata login`, or set SNOUTDATA_ACCESS_TOKEN';
}

export interface Project {
	ref: string;
	name: string;
	region: string;
	production: boolean;
	desiredState: string;
	state: string;
	stateDetail: string | null;
	wakesInstantly: boolean;
	sizeBytes: number | null;
	/** Over the plan's storage limit, and therefore refusing writes. */
	readOnly: boolean;
	/** The quota says one thing and the database is still doing the other — the gap between
	 *  a measurement and the host applying it. Worth saying, because it is exactly the
	 *  minute somebody is most likely to still be writing. */
	readOnlyPending: boolean;
	readOnlySince: string | null;
	host: string;
	database: string;
	user: string;
	createdAt: string;
	lastConnectionAt: string | null;
	pausedAt: string | null;
}

export interface Connection {
	ref: string;
	host: string;
	port: number;
	database: string;
	user: string;
	password: string;
	ssl: string;
	uri: string;
	/**
	 * The project's API keys: two HS256 JWTs carrying a `role` claim, which is what a client
	 * presents (STACK.md S2). Derived from the project's signing
	 * secret on every read rather than stored, so they are the same string every time
	 * until somebody rotates them.
	 *
	 * Null only when the secret could not be generated or read just now. A project made
	 * before keys existed grows them on the first request that asks, so this is a
	 * transient answer and never a permanent state.
	 *
	 * `serviceRoleKey` bypasses row-level security. It belongs on a server.
	 */
	anonKey: string | null;
	serviceRoleKey: string | null;
	/** When the signing secret was issued or last rotated, which is also the `iat` both
	 *  keys carry. */
	keysIssuedAt: string | null;
	keysExpireAt: string | null;
	wakesInstantly: boolean;
	state: string;
}

/**
 * Refresh a token that is about to expire.
 *
 * Done before a call rather than after a 401, because half a command's work having
 * already happened is a worse place to discover it. A refresh that fails is treated as
 * "signed out": the stored token is left alone (it may still work for read paths) and
 * the error says to log in again.
 *
 * An `sdt_…` access token passes straight through: it has no expiry to check and
 * nothing to refresh, which is the entire reason it exists. The control plane exchanges
 * it for a short-lived JWT on its side, so this process never holds one.
 */
async function currentToken(): Promise<string> {
	let auth = readAuth();
	if (!auth) {
		// The ladder, and the only place it hangs off: every command reaches the network
		// through `call()`, which reaches it through here, so there is one rung order and
		// no command can have its own. See `ladder.ts` for the D1 rule that governs it.
		auth = await climb();
	}
	if (!auth) {
		throw new NotSignedIn();
	}
	if (!isExpired(auth) || !auth.refreshToken) {
		return auth.accessToken;
	}
	const response = await fetch(`${ACCOUNTS_URL}/auth/v1/token?grant_type=refresh_token`, {
		method: 'POST',
		headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify({ refresh_token: auth.refreshToken })
	});
	if (!response.ok) {
		throw new NotSignedIn();
	}
	const data = (await response.json()) as {
		access_token: string;
		refresh_token: string;
		expires_at: number;
	};
	const next: StoredAuth = {
		...auth,
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: data.expires_at
	};
	writeAuth(next);
	return next.accessToken;
}

export async function call<T>(
	fn: string,
	body: unknown = {},
	method: 'POST' | 'GET' = 'POST'
): Promise<T> {
	// A control-plane call about a local project would be a 404 about a project the cloud never
	// had. Say what it is instead, before asking anybody to sign in for it.
	const asked = typeof body === 'object' && body ? (body as { ref?: unknown }).ref : undefined;
	if (typeof asked === 'string') {
		const stack = localStack(asked);
		if (stack) {
			throw new CliFailure(
				'usage',
				`${asked} is a local project (${stack.folder}), and this command is about SnoutData Cloud. Locally: db url, db psql, db push, gen types, keys, status, start, stop, functions, secrets.`,
				{ ref: asked, local: stack.folder }
			);
		}
	}
	const token = await currentToken();
	// A GET carries the ref in the query string, because a function that only READS should
	// not need a POST to answer — polling an export's progress is not a request to take
	// another one, and the export function distinguishes the two by method.
	const query =
		method === 'GET' && typeof body === 'object' && body
			? `?${new URLSearchParams(body as Record<string, string>).toString()}`
			: '';
	const response = await fetch(`${FUNCTIONS}/${fn}${query}`, {
		method,
		headers: {
			Authorization: `Bearer ${token}`,
			apikey: ANON_KEY,
			'Content-Type': 'application/json',
			// Who the audit log says did it. A signed-in CLI holds the same session JWT a browser
			// does, so without this everything it did read "You" and the log's CLI filter only
			// ever found access tokens. Attribution, never authority: the JWT decides that.
			'x-client-info': CLIENT_INFO
		},
		body: method === 'GET' ? undefined : JSON.stringify(body)
	});
	noticeFrom(response);
	const text = await response.text();
	let parsed: unknown;
	try {
		parsed = text ? JSON.parse(text) : {};
	} catch {
		throw new ApiError(response.status, text.slice(0, 300) || response.statusText);
	}
	if (!response.ok) {
		const message =
			typeof parsed === 'object' && parsed && 'error' in parsed
				? String((parsed as { error: unknown }).error)
				: `${response.status} ${response.statusText}`;
		// A credential problem exits 3, not 1, and carries the server's own words —
		// "that access token was revoked" sends a script's owner somewhere useful, and
		// a generic failure exit code sends them to the network.
		if (response.status === 401) {
			throw new NotSignedIn(message);
		}
		if (response.status === 410) {
			throw outdated(response, message);
		}
		throw new ApiError(response.status, message);
	}
	return parsed as T;
}

/**
 * The control plane's word on this CLI's version, said once per run.
 *
 * Every response may carry `x-snoutdata-cli-notice` (a sentence) when this version is
 * deprecated and still served. It goes to stderr, so `--json` stdout stays one value, and it is
 * said on every command until the CLI is upgraded: a warning that appears once and then never
 * again is how a refusal arrives as a surprise.
 */
let noticeShown = false;

export function noticeFrom(response: Response): void {
	const notice = response.headers.get('x-snoutdata-cli-notice');
	if (!notice || noticeShown) {
		return;
	}
	noticeShown = true;
	warn(`${notice} ${outdatedAdvice({ minimum: response.headers.get('x-snoutdata-cli-minimum') })}`);
}

/** A 410: this version is no longer served. The server's words, then what to run about it. */
export function outdated(response: Response, message: string): CliFailure {
	const minimum = response.headers.get('x-snoutdata-cli-minimum');
	return new CliFailure('outdated', `${message.replace(/\s+$/, '')} ${outdatedAdvice({ minimum })}`, {
		status: 410,
		installed: VERSION,
		minimum: minimum ?? null
	});
}

export interface Who {
	id: string;
	email: string | null;
	/** Which door this credential came in by. */
	via: 'jwt' | 'token';
	/** The access token in use, when there is one. */
	token: { id: string; name: string; prefix: string; project?: string | null } | null;
}

/**
 * Who this credential belongs to, and whether it still works.
 *
 * Through the control plane rather than straight to `/auth/v1/user`, because an
 * `sdt_…` access token is not a JWT and the auth server has never heard of it. Both
 * kinds of credential are the same question, so they get one answer from one place.
 */
export async function whoami(): Promise<Who> {
	return call('cloud-whoami');
}

export async function listProjects(): Promise<{ projects: Project[]; allowance: unknown }> {
	return call('cloud-project-list');
}

export async function connection(ref: string): Promise<Connection> {
	// A local project answers from its stack folder, never the control plane (local.ts).
	const stack = localStack(ref);
	if (stack) {
		return localConnection(stack);
	}
	return call('cloud-project-connection', { ref });
}

/** The local stack this ref names, if it names one: the folder linked here, then Studio's list. */
export function localStack(ref: string): LocalStack | null {
	return localStackFor(ref, findLink(process.cwd())?.local ?? null);
}

/** What the control plane says about a project's last (or running) export. */
export interface ProjectExport {
	/** An export has been asked for and the host has not finished it. */
	pending: boolean;
	requestedAt: string | null;
	completedAt: string | null;
	bytes: number | null;
	/**
	 * A link to the dump, or null.
	 *
	 * Null does NOT mean the export failed. A host signs this with credentials it reads
	 * from the instance metadata service and which rotate every few hours, so a link is
	 * good for hours rather than weeks — and one that has aged out is dropped rather than
	 * handed over dead, because an expired link produces a 403 from S3 that reads like a
	 * broken product. Ask again and a fresh one is signed against the same dump.
	 */
	url: string | null;
	urlExpiresAt: string | null;
	/**
	 * The roles the dump's GRANTs name, as plain SQL to run BEFORE `pg_restore`.
	 *
	 * Null for an export taken before this existed, and against a control plane without
	 * migration 060. `db export` writes it beside the dump when it is there and tells the
	 * user to skip owners and grants when it is not, because a `pg_restore` that meets a
	 * role the target lacks fails that object's WHOLE acl and says nothing useful about it.
	 *
	 * Carries no passwords: the roles are created without them, deliberately.
	 */
	rolesSql: string | null;
	error: string | null;
}

/** A team the caller can see, and whether they may share a project into it. */
export interface Team {
	id: string;
	name: string;
	/**
	 * False when the caller can SEE the team but is not a current member.
	 *
	 * The two are genuinely different: `teams` lets a team's buyer see it whatever their
	 * membership row says, while sharing requires `is_team_member`, which excludes anybody
	 * removed. A team in this list with `mayShare: false` is not a bug, it is the honest
	 * answer, and `why` says which.
	 */
	mayShare: boolean;
	why?: string;
}

export async function listTeams(): Promise<{ teams: Team[] }> {
	return call('cloud-team-list');
}

/** Ask for a new export. Asking twice is one export, not an error. */
export async function requestExport(ref: string): Promise<{ ref: string; export: ProjectExport }> {
	return call('cloud-project-export', { ref });
}

/** What the last export is doing, without asking for another one. */
export async function exportStatus(ref: string): Promise<{ ref: string; export: ProjectExport }> {
	return call('cloud-project-export', { ref }, 'GET');
}

/**
 * Wait for a pause, resume or delete to be TRUE, not merely asked for.
 *
 * Each of those returns as soon as the row says what is wanted; the host makes it so seconds
 * later. Until 2026-10-03 the CLI printed "resumed." at once while the project stayed `paused`
 * for twelve seconds, and a second pause answered "already paused" while it was still
 * `pausing` (docs/cloud/QA-RETEST.md §3n). Resolves with the project as settled, or null once
 * a deleted one has left the list.
 */
export async function waitForSettled(
	ref: string,
	verb: 'pause' | 'resume' | 'delete',
	options: { timeoutMs?: number; onTick?: (state: string) => void } = {}
): Promise<Project | null> {
	const deadline = Date.now() + (options.timeoutMs ?? 300_000);
	for (;;) {
		const { projects } = await listProjects();
		const project = projects.find((candidate) => candidate.ref === ref) ?? null;
		const state = project?.state ?? 'deleted';
		options.onTick?.(state);
		if (isSettled(verb, state)) {
			return project;
		}
		if (Date.now() >= deadline) {
			throw new ApiError(504, `${ref} is still ${state} after waiting`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
}

/** Whether a project in `state` has finished what `verb` asked. `error` ends a wait too: it will not settle on its own. */
export function isSettled(verb: 'pause' | 'resume' | 'delete', state: string): boolean {
	const settled = { pause: 'paused', resume: 'ready', delete: 'deleted' }[verb];
	return state === settled || state === 'error';
}

/**
 * Wait for a project to be ready.
 *
 * A create returns before anything is running — the row is the request, and a host makes
 * it true a few seconds later — so anything that hands the user a connection string has
 * to wait, or the string will not work when they paste it.
 */
export async function waitForReady(
	ref: string,
	options: { timeoutMs?: number; onTick?: (state: string) => void } = {}
): Promise<Project> {
	const deadline = Date.now() + (options.timeoutMs ?? 300_000);
	for (;;) {
		const { projects } = await listProjects();
		const project = projects.find((candidate) => candidate.ref === ref);
		if (!project) {
			throw new ApiError(404, `no project ${ref}`);
		}
		options.onTick?.(project.state);
		if (project.state === 'ready') {
			return project;
		}
		if (Date.now() >= deadline) {
			throw new ApiError(504, `${ref} is still ${project.state} after waiting`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
}
