/**
 * Signing in, without typing a password into a terminal.
 *
 * The browser flow, PKCE, with a callback on loopback — the same shape `gh` uses, and for the same reasons: the password never reaches this process, the
 * code that comes back is useless without a verifier this process never sent anywhere,
 * and it works with Google and GitHub as well as email.
 *
 * ## Google does not go through the auth server's redirect, and that is the whole of the 2026-09-07 fix
 *
 * The identity service's provider redirect (`provider=google`) used the Google client configured inside the auth
 * server of the day, which belonged to a GCP project we no longer use and has been deleted. It answers
 * `401 deleted_client`. Nobody noticed for months because this CLI was the only surface
 * still using that door, and it had never been driven by a person.
 *
 * So Google now takes the path the desktop app already takes (`googleNativeAuth.ts`): run
 * the authorization-code flow against Google ourselves, on loopback with PKCE, and hand the
 * resulting ID token to the auth server, which verifies it against its accepted client-id list.
 * That list already contains this client, because the desktop depends on it.
 *
 * **What was deliberately NOT done instead.** Repointing the auth server's Google provider at the
 * live client is one dashboard field and would have fixed this too, but that same field is
 * what verifies the ID tokens the website, the dashboard and the desktop already send: a
 * wrong edit there breaks three working surfaces to fix one broken one. That gets settled
 * properly once, for every surface, by putting one client behind one hosted page.
 *
 * **GitHub stays on the auth server's redirect flow**, exactly as it does in the desktop, because
 * GitHub issues no ID token and there is therefore nothing to hand to `grant_type=id_token`.
 * Its provider there is healthy. That is why the branch below is on the provider rather
 * than on a flag.
 *
 * **`SNOUTDATA_ACCESS_TOKEN` skips all of it.** That is the path CI and an agent take,
 * and it is deliberately first in `readAuth`'s precedence: a script's behaviour should
 * not depend on who happens to be logged in on the machine it runs on.
 *
 * ## SSO is the same flow with a different first request
 *
 * `--sso` is not a fourth way to sign in. It reuses the loopback, the PKCE pair and the
 * `grant_type=pkce` exchange that GitHub already uses; the only difference is where the
 * URL the browser is sent to comes from. GitHub builds one locally from
 * `/v1/identity/provider/start`; SSO asks for one, by POSTing the DOMAIN to `/v1/identity/sso/start` and
 * getting back the identity provider's URL. Everything after the browser comes back is
 * byte for byte the same code, which is why `codeFromBrowser` below takes the authorize
 * URL as a function of the redirect rather than building it: the port is not known until
 * the server is listening, and for SSO the request that needs it is a network call.
 *
 * The domain comes from a work email, because that is what a person knows — nobody can
 * name their identity provider, and asking them to is how a sign-in screen gets abandoned.
 * A bare domain is accepted too. The domain is the ONLY part that is ever sent.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { ACCOUNTS_URL, APP_KEY } from '../api.js';
import { browserUrl, dataRoute, doorFetch, identityRoute } from '../layout.js';
import { UsageError } from '../args.js';
import { currentProfile, DEFAULT_PROFILE, writeAuth } from '../config.js';
import { chooserPage, codePage, donePage, failedPage } from './signInPages.js';
import { CliFailure, codeForStatus } from '../failure.js';
import { canAsk, explainNoHuman, noHumanReason } from '../interactive.js';
import { bold, say, warn } from '../output.js';

export interface LoginResult {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
	email?: string;
}

function base64url(input: Buffer): string {
	return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The page the browser is left on when it comes back.
 *
 * This is the last thing somebody sees of a sign-in. It wears the dashboard's sign-in card
 * (`signInPages.ts`, 2026-11-04), as the chooser before it does, so a terminal sign-in looks like
 * the product's: who it signed in as, and the command to type next. Everything is inline; only
 * the logo comes from snoutdata.com, in a fixed box, because the loopback server is closed by the
 * time this renders.
 *
 * Two deliberate differences from the desktop's version. There is no `snoutdata://` deep
 * link, because the desktop uses that to pull its own window forward and a terminal has
 * nothing to open. And there is a failure state, because the CLI can land here having been
 * refused, where the desktop only ever renders this after succeeding.
 */
export function page(kind: 'ok' | 'failed', detail?: string, email?: string): string {
	const profile = currentProfile() === DEFAULT_PROFILE ? undefined : currentProfile();
	return kind === 'ok' ? donePage({ email, profile }) : failedPage(detail);
}

/** RFC 7636: a verifier we keep, and the challenge we send. */
export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(32));
	const challenge = base64url(createHash('sha256').update(verifier).digest());
	return { verifier, challenge };
}

/**
 * What each platform is actually asked to run. Exported so a test can hold Windows'
 * arrangement still, since it is the one that was wrong and the one hardest to eyeball.
 */
export function openCommand(
	platform: string,
	url: string
): { command: string; args: string[]; verbatim: boolean } {
	if (platform === 'darwin') {
		return { command: 'open', args: [url], verbatim: false };
	}
	if (platform === 'win32') {
		// `start` is a cmd.exe BUILTIN, not a program on PATH, so spawning it directly fails
		// with ENOENT. That is what made `snoutdata login` die on Windows instead of opening
		// anything, and it had gone unseen because the CLI was written on a Mac.
		//
		// Reaching a builtin means going through cmd.exe, which brings its own hazard: cmd
		// reads a bare `&` as a command separator, and an OAuth authorize URL is mostly `&`.
		// Hence the quotes, and `windowsVerbatimArguments` so Node passes them through rather
		// than re-quoting them. The empty `""` is `start`'s window-title argument: without it,
		// start takes the quoted URL as the title and opens nothing at all.
		return { command: 'cmd.exe', args: ['/c', 'start', '""', `"${url}"`], verbatim: true };
	}
	return { command: 'xdg-open', args: [url], verbatim: false };
}

function open(url: string): void {
	const { command, args, verbatim } = openCommand(process.platform, url);
	const child = spawn(command, args, {
		stdio: 'ignore',
		detached: true,
		windowsVerbatimArguments: verbatim
	});
	// A spawn failure arrives as an EVENT, asynchronously. The try/catch that used to be
	// here could never catch one, so a machine with no browser did not fall through to the
	// URL already printed — it died on an unhandled 'error' and took the sign-in with it.
	//
	// No browser is not an error: the URL was printed, and a person on a remote box pastes
	// it into the browser on the machine in front of them.
	child.on('error', () => {});
	child.unref();
}

// Google's own endpoints. We talk to these directly for Google; every other provider still
// goes through the auth server's redirect.
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// The SAME "Desktop app" OAuth client the desktop uses (`googleNativeAuth.ts`, kept in step
// with this by hand: one client, written down twice, which one hosted sign-in page will
// collapse). Reusing it rather than registering another is the point. It is already in the auth
// server's accepted Client IDs, so `grant_type=id_token` accepts what it mints, which is why this
// fix needed no change in either console.
//
// For an installed app Google states the client secret is NOT confidential: it ships in the
// binary, and the flow is protected by PKCE and the loopback redirect rather than by keeping
// this value quiet. That is what makes it publishable in an npm package. It is also why the
// consent screen reads "SnoutData Desktop" from a terminal, which is cosmetic and goes away
// when one client sits behind one hosted page.
//
// Neither value is in this source, because the source is mirrored to a public repository and
// GitHub's push protection refuses a Google client secret there. build.mjs injects both from
// SNOUTDATA_GOOGLE_CLIENT_ID / SNOUTDATA_GOOGLE_CLIENT_SECRET and refuses to build without them,
// so a published bundle always carries them. Unbundled (the tests), they are read from the
// environment when first asked for.
declare const __SNOUTDATA_GOOGLE_CLIENT_ID__: string | undefined;
declare const __SNOUTDATA_GOOGLE_CLIENT_SECRET__: string | undefined;

function googleClientId(): string {
	return typeof __SNOUTDATA_GOOGLE_CLIENT_ID__ === 'string'
		? __SNOUTDATA_GOOGLE_CLIENT_ID__
		: (process.env.SNOUTDATA_GOOGLE_CLIENT_ID ?? '');
}

function googleClientSecret(): string {
	return typeof __SNOUTDATA_GOOGLE_CLIENT_SECRET__ === 'string'
		? __SNOUTDATA_GOOGLE_CLIENT_SECRET__
		: (process.env.SNOUTDATA_GOOGLE_CLIENT_SECRET ?? '');
}

/**
 * The nonce, in the two forms it has to exist in at once.
 *
 * Google is given the SHA-256 hex and puts it in the token's `nonce` claim. The auth server is
 * given the RAW value, hashes it itself, and compares. Send the same form to both and
 * verification fails — with a message about the nonce that does not say which end is wrong.
 * Exported so a test can hold the two apart; nothing else should call it.
 */
export function nonceForGoogle(raw?: string): { raw: string; hashed: string } {
	const value = raw ?? base64url(randomBytes(32));
	return { raw: value, hashed: createHash('sha256').update(value).digest('hex') };
}

/** The URL the browser is sent to. Exported for the test; there is nothing secret in it. */
export function googleAuthorizeUrl(parts: {
	redirectUri: string;
	challenge: string;
	hashedNonce: string;
	state: string;
	/** `login --email`: Google pre-selects that account in its chooser. */
	loginHint?: string;
}): string {
	return `${GOOGLE_AUTH_ENDPOINT}?${new URLSearchParams({
		...(parts.loginHint ? { login_hint: parts.loginHint } : {}),
		client_id: googleClientId(),
		redirect_uri: parts.redirectUri,
		response_type: 'code',
		scope: 'openid email profile',
		code_challenge: parts.challenge,
		code_challenge_method: 'S256',
		nonce: parts.hashedNonce,
		state: parts.state,
		// ALWAYS ask which account.
		//
		// Without this, Google reuses whatever account the browser is already signed into
		// and never says so: you type `snoutdata login`, a page flashes, and you are signed
		// in as somebody else. On a shared machine, or for anybody with a work account and a
		// personal one, that is silently the wrong identity, and the CLI is the surface where
		// it is hardest to notice, because there is no avatar in the corner to check.
		prompt: 'select_account'
	}).toString()}`;
}

/**
 * What to do with a request that arrived on the loopback port.
 *
 * `ignore` is the one that matters and the one the old code did not have: a browser also
 * asks for `/favicon.ico`, and treating that as the redirect closes the server before the
 * real one lands. Kept pure so all four outcomes are testable without a socket.
 *
 * `expectedState` is absent for the flows that go through the auth server (GitHub, SSO): the
 * state there belongs to it, and it keeps its own and hands back only a code, so there
 * is nothing of ours to compare. The PKCE verifier is what binds that code to this
 * process. Google, which we drive ourselves, sends a state and it is checked.
 */
export function readRedirect(
	requestUrl: string,
	expectedState?: string
): { kind: 'ignore' } | { kind: 'ok'; code: string } | { kind: 'error'; message: string } {
	const url = new URL(requestUrl, 'http://127.0.0.1');
	if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
		return { kind: 'ignore' };
	}
	const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
	if (error) {
		return { kind: 'error', message: error };
	}
	const code = url.searchParams.get('code');
	if (!code) {
		return { kind: 'error', message: 'the browser came back without a code' };
	}
	if (expectedState !== undefined && url.searchParams.get('state') !== expectedState) {
		// Somebody else's redirect landed on our port, or this one was replayed.
		return { kind: 'error', message: 'the browser came back with a state that did not match' };
	}
	return { kind: 'ok', code };
}

/**
 * The loopback half, written once for every flow that ends in a code coming back.
 *
 * Google, GitHub and SSO differ only in the URL the browser is sent to, and that URL cannot
 * be built before the server is listening, because it has to carry the port. So the caller
 * passes a FUNCTION of the redirect rather than a string — and it may be async, which is
 * what SSO needs: its URL is not built here at all, it is asked for over the network, and a
 * refusal there (no identity provider for that domain) has to close this server and reject
 * rather than leave a terminal waiting five minutes for a browser nobody opened.
 */
async function codeFromBrowser(options: {
	authorizeUrl: (redirectUri: string) => string | Promise<string>;
	/** What the redirect lands on. Empty for Google, `/callback` for anything through the auth server. */
	callbackPath?: string;
	/** Ours to check, when the flow is ours. See `readRedirect`. */
	state?: string;
	timeoutMs?: number;
	noBrowser?: boolean;
}): Promise<{ code: string; redirectUri: string }> {
	return new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
		let redirect = '';
		const server = createServer((request, response) => {
			const outcome = readRedirect(request.url ?? '/', options.state);
			if (outcome.kind === 'ignore') {
				response.writeHead(404).end();
				return;
			}
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(outcome.kind === 'ok' ? page('ok') : page('failed', outcome.message));
			server.close();
			if (outcome.kind === 'ok') {
				resolve({ code: outcome.code, redirectUri: redirect });
			} else {
				reject(new Error(outcome.message));
			}
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			redirect = `http://127.0.0.1:${port}${options.callbackPath ?? ''}`;
			Promise.resolve()
				.then(() => options.authorizeUrl(redirect))
				.then(
					(authorize) => {
						// The URL goes to STDOUT, not through `say()`.
						//
						// This is the whole of the `--no-browser` fix, and the reason it is one: the
						// single line telling somebody what to do went through `say()`, which `--json`
						// silences, so `snoutdata login --json` printed absolutely nothing and then
						// blocked for five minutes. On a machine with no browser that is not a degraded
						// experience, it is a hang with no explanation.
						//
						// A URL a person has to read and act on is the ANSWER to this command, so it
						// belongs on stdout in both registers.
						process.stdout.write(`${authorize}\n`);
						if (options.noBrowser) {
							say('Open that in a browser, on any machine, and sign in.');
						} else {
							say('Opening that in your browser. If nothing opens, paste it into one.');
							open(authorize);
						}
					},
					(error: unknown) => {
						server.close();
						reject(error);
					}
				);
		});
		server.on('error', reject);
		// A login that is never completed must not hold a terminal forever.
		const timer = setTimeout(() => {
			server.close();
			reject(new Error('timed out waiting for the browser'));
		}, options.timeoutMs ?? 300_000);
		timer.unref();
	});
}

/** The auth server's end of every PKCE flow: one code, one verifier, one session. */
async function exchangePkceCode(code: string, verifier: string): Promise<LoginResult> {
	const response = await doorFetch(ACCOUNTS_URL, identityRoute('/session?via=pkce', '/token?grant_type=pkce'), {
		method: 'POST',
		key: APP_KEY,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ auth_code: code, code_verifier: verifier })
	});
	if (!response.ok) {
		throw new Error(`could not exchange the code: ${(await response.text()).slice(0, 200)}`);
	}
	return storeSession(await response.json());
}

/** Google hands back an ID token; the auth server is what turns it into a session. */
async function exchangeCodeForIdToken(
	code: string,
	verifier: string,
	redirectUri: string
): Promise<string> {
	const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: googleClientId(),
			client_secret: googleClientSecret(),
			code,
			code_verifier: verifier,
			grant_type: 'authorization_code',
			redirect_uri: redirectUri
		})
	});
	const body = (await response.json().catch(() => ({}))) as {
		id_token?: string;
		error?: string;
		error_description?: string;
	};
	if (!response.ok || !body.id_token) {
		throw new Error(
			`Google would not exchange the code: ${body.error_description ?? body.error ?? `HTTP ${response.status}`}`
		);
	}
	return body.id_token;
}

/**
 * The Google half: loopback + PKCE against Google, then the auth server's `grant_type=id_token`.
 *
 * The nonce goes to Google HASHED and to the auth server RAW, and that is not a detail to tidy:
 * the auth server hashes what it is given and compares it against the token's claim, so sending the
 * same form to both fails verification.
 */
async function loginWithGoogle(options: {
	timeoutMs?: number;
	noBrowser?: boolean;
	email?: string;
}): Promise<LoginResult> {
	// A test build (`build.mjs --google-optional`) may carry no client. Say so here, rather than
	// sending the browser to Google with an empty client_id and letting Google explain it.
	if (!googleClientId()) {
		throw new Error(
			'this build of snoutdata has no Google sign-in (it was built for testing). Sign in with a released snoutdata, then run this one.'
		);
	}
	const { verifier, challenge } = pkcePair();
	const { raw: rawNonce, hashed: hashedNonce } = nonceForGoogle();
	const state = base64url(randomBytes(16));

	const { code, redirectUri } = await codeFromBrowser({
		state,
		timeoutMs: options.timeoutMs,
		noBrowser: options.noBrowser,
		authorizeUrl: (redirect) =>
			googleAuthorizeUrl({ redirectUri: redirect, challenge, hashedNonce, state, loginHint: options.email })
	});

	const idToken = await exchangeCodeForIdToken(code, verifier, redirectUri);
	return sessionFromGoogle(idToken, rawNonce);
}

/** The auth server's `grant_type=id_token`: Google's ID token, with the RAW nonce, into a session. */
async function sessionFromGoogle(idToken: string, rawNonce: string): Promise<LoginResult> {
	const response = await doorFetch(ACCOUNTS_URL, identityRoute('/session?via=id_token', '/token?grant_type=id_token'), {
		method: 'POST',
		key: APP_KEY,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ provider: 'google', id_token: idToken, nonce: rawNonce })
	});
	if (!response.ok) {
		throw new Error(
			`could not turn the Google sign-in into a session: ${(await response.text()).slice(0, 200)}`
		);
	}
	return storeSession(await response.json());
}

/** The one shape both paths come back in, written down once. */
function storeSession(data: unknown): LoginResult {
	const body = data as {
		access_token: string;
		refresh_token?: string;
		expires_at?: number;
		user?: { email?: string };
	};
	const result: LoginResult = {
		accessToken: body.access_token,
		refreshToken: body.refresh_token,
		expiresAt: body.expires_at,
		email: body.user?.email
	};
	writeAuth(result);
	return result;
}

/**
 * The domain to ask for single sign-on with, or null when what was typed cannot be one.
 *
 * A TWIN of the desktop app's `ssoDomainFromEmail`, by copy, because the
 * CLI is one bundled file with no dependencies and cannot import across an app. Same rules,
 * deliberately: a work email or a bare domain, lowercased, with an alphabetic top-level label
 * so `you@localhost` is refused here instead of becoming a request nobody can answer.
 *
 * It is not a validating email regex and should not become one. The only question it answers
 * is "is there a domain worth asking about"; the control plane is the authority on whether
 * that domain has an identity provider.
 */
export function ssoDomain(input: string): string | null {
	const text = input.trim().toLowerCase();
	if (!text || /\s/.test(text)) {
		return null;
	}
	const at = text.indexOf('@');
	// No local part, or more than one "@", is a typo rather than an address.
	if (at === 0 || text.indexOf('@', at + 1) !== -1) {
		return null;
	}
	const domain = at === -1 ? text : text.slice(at + 1);
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
		return null;
	}
	const tld = domain.slice(domain.lastIndexOf('.') + 1);
	return /^[a-z]{2,}$/.test(tld) ? domain : null;
}

/** Whatever sentence an auth server error body is carrying, under whichever key it used. */
function messageFromBody(body: string): string {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		for (const key of ['error_description', 'msg', 'message', 'error']) {
			const value = parsed[key];
			if (typeof value === 'string' && value) {
				return value;
			}
		}
	} catch {
		// Not JSON, so it is not the auth server talking: a proxy's HTML error page, or nothing at all.
		// Neither is a sentence to show a person, so the caller's own wording is used instead.
		return '';
	}
	return '';
}

/**
 * What to tell somebody whose single sign-on could not be started.
 *
 * The case that matters is the ordinary one and it is not an error in the product: nobody
 * has connected an identity provider for that domain yet. The auth server answers 404, and a raw
 * "404" or "No SSO provider assigned for this domain" reads as a fault in the CLI. It is
 * not, and the person has somewhere to go, so the sentence names the DOMAIN they asked for
 * and points at whoever administers their team.
 *
 * A twin of the desktop app's `ssoFailureMessage`, for the same
 * reason `ssoDomain` is. Anything we do not recognise keeps the backend's own words rather
 * than inventing a diagnosis. Pure, and exported, so every branch is testable without a
 * network.
 */
export function ssoFailure(status: number, body: string, domain: string): CliFailure {
	const message = messageFromBody(body);
	if (status === 404 || /no sso provider/i.test(message)) {
		return new CliFailure(
			'not-found',
			`No single sign-on is set up for ${domain}. Check the address, or ask whoever administers your team to connect your identity provider.`,
			{ domain }
		);
	}
	if (/saml.*(disabled|not enabled)/i.test(message)) {
		return new CliFailure(
			'failed',
			`Single sign-on is not available for ${domain} yet. Ask whoever administers your team to connect your identity provider.`,
			{ domain }
		);
	}
	return new CliFailure(
		codeForStatus(status),
		message || `Could not start single sign-on for ${domain}.`,
		{ domain }
	);
}

/**
 * Ask the auth server where to send the browser for this domain.
 *
 * `skip_http_redirect` is not optional here: without it the answer is a 302 that `fetch`
 * follows, and we would end up holding the identity provider's HTML instead of a URL to
 * open. The PKCE challenge rides along, so the code that comes back to the loopback is
 * exchangeable by this process and no other.
 */
async function ssoAuthorizeUrl(parts: {
	domain: string;
	redirectTo: string;
	challenge: string;
}): Promise<string> {
	const response = await doorFetch(ACCOUNTS_URL, identityRoute('/sso/start', '/sso'), {
		method: 'POST',
		key: APP_KEY,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			domain: parts.domain,
			redirect_to: parts.redirectTo,
			skip_http_redirect: true,
			code_challenge: parts.challenge,
			code_challenge_method: 's256'
		})
	});
	const text = await response.text();
	if (!response.ok) {
		throw ssoFailure(response.status, text, parts.domain);
	}
	let url: unknown;
	try {
		url = (JSON.parse(text) as { url?: unknown }).url;
	} catch {
		url = undefined;
	}
	if (typeof url !== 'string' || !url) {
		throw new CliFailure(
			'server',
			`Single sign-on for ${parts.domain} was accepted but came back without somewhere to send the browser.`,
			{ domain: parts.domain }
		);
	}
	return url;
}

/**
 * Which domain, asked for once, or refused fast.
 *
 * With nobody to ask, this does NOT prompt. It fails with the flag that would have
 * worked and the reason nothing was asked, which is exit 2 — the documented "a command that
 * would have to ask says what flag to pass instead". A prompt here would be a five-minute
 * hang in CI at the moment an agent is least able to explain itself.
 */
async function resolveSsoDomain(given?: string): Promise<string> {
	if (given !== undefined) {
		const domain = ssoDomain(given);
		if (!domain) {
			throw new UsageError(
				`--domain wants a work email or a company domain, like you@yourcompany.com, not "${given}"`
			);
		}
		return domain;
	}
	if (!canAsk()) {
		const reason = noHumanReason();
		throw new UsageError(
			`login --sso needs --domain <your work email or company domain>${reason ? `, because ${explainNoHuman(reason)}` : ''}`
		);
	}
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	// `question` never settles if the input ends before an answer arrives — a pipe that ran
	// out, a terminal that went away — and a sign-in that hangs in silence is the exact
	// failure the no-prompt rule exists to prevent. Racing it against the reader closing turns that into a
	// sentence. Our own `rl.close()` below fires this too, hence the handler that swallows it.
	const ended = new Promise<string>((_, reject) => {
		rl.once('close', () =>
			reject(
				new UsageError(
					'nothing left to read: pass --domain <your work email or company domain>'
				)
			)
		);
	});
	ended.catch(() => {});
	try {
		for (let attempt = 0; attempt < 3; attempt += 1) {
			// An EMAIL, not a provider name. Nobody knows their identity provider's name, and
			// asking for one is how a sign-in gets abandoned. Only the domain is ever sent.
			const typed = await Promise.race([rl.question('Your work email address: '), ended]);
			const domain = ssoDomain(typed);
			if (domain) {
				return domain;
			}
			say('That is not a work email or a company domain. Try something like you@yourcompany.com.');
		}
	} finally {
		rl.close();
	}
	throw new UsageError('no domain to sign in with: pass --domain <your work email or company domain>');
}

/**
 * The SSO half: the same loopback, the same PKCE pair, the same exchange. Only the first
 * request differs, and it is the one that can say "nobody has set this up for you yet".
 */
async function loginWithSso(options: {
	domain?: string;
	timeoutMs?: number;
	noBrowser?: boolean;
}): Promise<LoginResult> {
	const domain = await resolveSsoDomain(options.domain);
	const { verifier, challenge } = pkcePair();
	say(`Signing in with the identity provider for ${bold(domain)}.`);
	const { code } = await codeFromBrowser({
		callbackPath: '/callback',
		timeoutMs: options.timeoutMs,
		noBrowser: options.noBrowser,
		authorizeUrl: (redirect) =>
			ssoAuthorizeUrl({ domain, redirectTo: redirect, challenge })
	});
	return exchangePkceCode(code, verifier);
}

/** This machine's IANA timezone, or null when Node's Intl does not say. */
export function systemTimezone(): string | null {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
	} catch {
		return null;
	}
}

/** How long a sign-in waits for the timezone to be recorded before it says it is done anyway. */
const TIMEZONE_WAIT_MS = 3000;

/**
 * Tell the account this machine's timezone, right after an interactive sign-in. A hosted project's
 * default maintenance window (when a running database may be moved to another server) is 2 to 6 AM
 * in its owner's timezone, and `set_my_timezone(tz, 'signin')` stores it unless the owner set one by
 * hand on the dashboard's Account page. The website, the
 * dashboard and Studio do the same on their sign-ins.
 *
 * Best effort: never throws and never takes longer than TIMEZONE_WAIT_MS. Answers null when it was
 * recorded (or there was nothing to record), else why not, which `login` writes to stderr only under
 * SNOUTDATA_DEBUG: a sign-in that worked should not end on a line about something else.
 */
export async function reportTimezone(
	accessToken: string,
	timezone: string | null = systemTimezone(),
	fetcher: typeof fetch = fetch
): Promise<string | null> {
	if (!timezone || !accessToken) {
		return null;
	}
	const sent = doorFetch(
		ACCOUNTS_URL,
		dataRoute('/rpc/set_my_timezone'),
		{
			method: 'POST',
			key: APP_KEY,
			headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ want_timezone: timezone, want_source: 'signin' })
		},
		fetcher
	).then(
		async (response) => (response.ok ? null : `HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`),
		(e: unknown) => (e instanceof Error ? e.message : String(e))
	);
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<string>((resolve) => {
		timer = setTimeout(() => resolve('timed out'), TIMEZONE_WAIT_MS);
		timer.unref();
	});
	try {
		return await Promise.race([sent, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** Up to 4 KB of a form post, as its fields. A sign-in form never needs more. */
async function formFields(request: IncomingMessage): Promise<URLSearchParams> {
	let body = '';
	for await (const chunk of request) {
		body += String(chunk);
		if (body.length > 4096) {
			break;
		}
	}
	return new URLSearchParams(body);
}

/** The auth server's `/code`: a six-digit code to that address, the account made if there is none. */
async function sendSignInCode(email: string): Promise<string | null> {
	const response = await doorFetch(ACCOUNTS_URL, identityRoute('/code', '/otp'), {
		method: 'POST',
		key: APP_KEY,
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, create_user: true })
	});
	if (response.ok) {
		return null;
	}
	// The auth server allows one send a minute and says so; its sentence tells the person to wait.
	return messageFromBody(await response.text()) || 'Could not send a code just now. Try again in a moment.';
}

/**
 * The auth server's `/confirm` for a code, as the dashboard's SsoSignIn does it: `email` first (an
 * address it knew), then `signup` (one the code itself created), since whoever types it cannot know.
 */
async function confirmSignInCode(email: string, token: string): Promise<LoginResult | string> {
	let last = '';
	for (const type of ['email', 'signup']) {
		const response = await doorFetch(ACCOUNTS_URL, identityRoute('/confirm', '/verify'), {
			method: 'POST',
			key: APP_KEY,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ email, token, type })
		});
		const text = await response.text();
		if (response.ok) {
			return storeSession(JSON.parse(text));
		}
		last = text;
		if (response.status !== 403 && !/otp_expired|expired|invalid/i.test(text)) {
			break;
		}
	}
	const message = messageFromBody(last);
	return /expired|invalid/i.test(message) || !message
		? 'That code did not work. It may be from an older email, or already used. Send another.'
		: message;
}

type ChooserFlow =
	| { readonly kind: 'google'; readonly verifier: string; readonly rawNonce: string; readonly state: string }
	| { readonly kind: 'pkce'; readonly verifier: string };

/**
 * Plain `snoutdata login`: the sign-in page, with every way in.
 *
 * It used to go straight to Google, which left anyone who signs in with GitHub, their company's
 * identity provider or an emailed code to know a flag. Now the browser opens a page this process
 * serves on 127.0.0.1, in the dashboard's design (`signInPages.ts`), and each button runs the same
 * flow its flag runs: Google's loopback PKCE, the auth server's redirect for GitHub and SSO, and the
 * six-digit code for an address no identity provider claims, exactly as the dashboard's work-email
 * field does. One port serves the page and every redirect back, so whichever way is taken, the code
 * lands here and is exchanged with a verifier only this process holds.
 *
 * The page's links and forms carry a per-run token, so another page on this machine cannot drive
 * the sign-in, and the done page is sent only once the session is stored, so it can say whose it is.
 */
async function loginWithChooser(options: { timeoutMs?: number; noBrowser?: boolean; email?: string }): Promise<LoginResult> {
	const token = base64url(randomBytes(18));
	const profile = currentProfile() === DEFAULT_PROFILE ? undefined : currentProfile();
	const google = Boolean(googleClientId());
	let flow: ChooserFlow | null = null;
	let codeTo: string | null = null;

	return new Promise<LoginResult>((resolve, reject) => {
		let base = '';
		let settled = false;
		const html = (response: ServerResponse, body: string, status = 200): void => {
			response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end(body);
		};
		const finish = (response: ServerResponse, outcome: LoginResult | Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			html(response, outcome instanceof Error ? failedPage(outcome.message) : page('ok', undefined, outcome.email));
			server.close();
			if (outcome instanceof Error) {
				reject(outcome);
			} else {
				resolve(outcome);
			}
		};
		const chooser = (response: ServerResponse, extra: { email?: string; error?: string } = {}): void =>
			html(response, chooserPage({ token, google, profile, email: extra.email ?? options.email, error: extra.error }));

		const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
			const url = new URL(request.url ?? '/', 'http://127.0.0.1');
			const ours = url.searchParams.get('t') === token;

			// The way back from Google (the root, as its desktop client is registered) and from the
			// auth server (`/callback`). Bound by the flow's own state and verifier, not by the token.
			if ((url.pathname === '/' || url.pathname === '/callback') && (url.searchParams.has('code') || url.searchParams.has('error'))) {
				const expected = flow?.kind === 'google' && url.pathname === '/' ? flow.state : undefined;
				const outcome = readRedirect(request.url ?? '/', expected);
				if (outcome.kind === 'ignore') {
					response.writeHead(404).end();
					return;
				}
				if (outcome.kind === 'error' || !flow) {
					finish(response, new Error(outcome.kind === 'error' ? outcome.message : 'the browser came back to a sign-in that was not started'));
					return;
				}
				try {
					if (flow.kind === 'google') {
						const idToken = await exchangeCodeForIdToken(outcome.code, flow.verifier, base);
						finish(response, await sessionFromGoogle(idToken, flow.rawNonce));
					} else {
						finish(response, await exchangePkceCode(outcome.code, flow.verifier));
					}
				} catch (error) {
					finish(response, error instanceof Error ? error : new Error(String(error)));
				}
				return;
			}

			if (request.method === 'GET' && url.pathname === '/' && ours) {
				chooser(response);
				return;
			}
			if (request.method === 'GET' && url.pathname === '/google' && ours && google) {
				const { verifier, challenge } = pkcePair();
				const { raw, hashed } = nonceForGoogle();
				const state = base64url(randomBytes(16));
				flow = { kind: 'google', verifier, rawNonce: raw, state };
				response.writeHead(302, { Location: googleAuthorizeUrl({ redirectUri: base, challenge, hashedNonce: hashed, state, loginHint: options.email }) }).end();
				return;
			}
			if (request.method === 'GET' && url.pathname === '/github' && ours) {
				const { verifier, challenge } = pkcePair();
				flow = { kind: 'pkce', verifier };
				response.writeHead(302, { Location: await providerAuthorizeUrl('github', `${base}/callback`, challenge) }).end();
				return;
			}
			if (request.method === 'POST') {
				const fields = await formFields(request);
				if (fields.get('t') !== token) {
					response.writeHead(403).end();
					return;
				}
				if (url.pathname === '/email') {
					const email = (fields.get('email') ?? '').trim().toLowerCase();
					const domain = ssoDomain(email);
					if (!domain || !email.includes('@')) {
						chooser(response, { email, error: 'Enter your work email, for example you@company.com.' });
						return;
					}
					const { verifier, challenge } = pkcePair();
					try {
						const sso = await ssoAuthorizeUrl({ domain, redirectTo: `${base}/callback`, challenge });
						flow = { kind: 'pkce', verifier };
						response.writeHead(302, { Location: sso }).end();
						return;
					} catch (error) {
						// No identity provider claims the domain: the ordinary case, and not a refusal. A code
						// goes to the address instead, as the dashboard does (SsoSignIn.tsx).
						if (!(error instanceof CliFailure && error.code === 'not-found')) {
							chooser(response, { email, error: error instanceof Error ? error.message : String(error) });
							return;
						}
					}
					const refused = await sendSignInCode(email);
					if (refused) {
						chooser(response, { email, error: refused });
						return;
					}
					codeTo = email;
					html(response, codePage({ token, email, profile }));
					return;
				}
				if (url.pathname === '/code' && codeTo) {
					const typed = (fields.get('code') ?? '').replace(/\s+/g, '');
					const outcome = await confirmSignInCode(codeTo, typed);
					if (typeof outcome === 'string') {
						html(response, codePage({ token, email: codeTo, profile, error: outcome }));
						return;
					}
					finish(response, outcome);
					return;
				}
				if (url.pathname === '/resend' && codeTo) {
					const refused = await sendSignInCode(codeTo);
					html(response, codePage({ token, email: codeTo, profile, ...(refused ? { error: refused } : { notice: 'Another code is on its way.' }) }));
					return;
				}
			}
			// The favicon, a stale tab, a page from somewhere else: nothing of this sign-in's.
			response.writeHead(404).end();
		};

		const server = createServer((request, response) => {
			handle(request, response).catch((error: unknown) => {
				if (!response.headersSent) {
					html(response, failedPage(error instanceof Error ? error.message : String(error)), 500);
				}
			});
		});
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			base = `http://127.0.0.1:${port}`;
			const start = `${base}/?t=${token}`;
			// On stdout, as every flow's URL is: it is the answer a person acts on (see codeFromBrowser).
			process.stdout.write(`${start}\n`);
			if (options.noBrowser) {
				say('Open that in a browser on this machine and sign in.');
			} else {
				say('Opening the sign-in page in your browser. If nothing opens, paste that into one.');
				open(start);
			}
		});
		server.on('error', reject);
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				server.close();
				reject(new Error('timed out waiting for the browser'));
			}
		}, options.timeoutMs ?? 300_000);
		timer.unref();
	});
}

export async function login(
	options: {
		provider?: string;
		timeoutMs?: number;
		noBrowser?: boolean;
		/** The company's own identity provider, chosen by domain rather than by name. */
		sso?: boolean;
		domain?: string;
		/** The account to sign in as. A hint to the browser, then checked against the result. */
		email?: string;
	} = {}
): Promise<LoginResult> {
	const result = expecting(options.email, await signIn(options));
	const notRecorded = await reportTimezone(result.accessToken);
	if (notRecorded && process.env.SNOUTDATA_DEBUG) {
		warn(`could not record the timezone: ${notRecorded}`);
	}
	return result;
}

/**
 * Remember which account was asked for, and say so at once when the browser signed in as
 * another. A provider's chooser is a hint, not a promise: somebody can still click the wrong
 * account, and from a terminal there is no avatar in the corner to notice it by.
 */
export function expecting(email: string | undefined, result: LoginResult): LoginResult {
	if (!email) {
		return result;
	}
	const stored = { ...result, expectedEmail: email };
	writeAuth(stored);
	if (result.email && !sameEmail(result.email, email)) {
		warn(`Signed in as ${result.email}, not ${email}. Run \`snoutdata login --email ${email}\` and pick that account.`);
	}
	return stored;
}

export function sameEmail(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

async function signIn(options: {
	provider?: string;
	timeoutMs?: number;
	noBrowser?: boolean;
	sso?: boolean;
	domain?: string;
	email?: string;
}): Promise<LoginResult> {
	if (options.sso) {
		// A work email is what SSO is looked up by anyway, so `--email` answers `--domain`.
		return loginWithSso({ ...options, domain: options.domain ?? options.email });
	}
	// No provider named: the sign-in page, with every way in (`loginWithChooser`). A provider
	// named is the shortcut straight to it, as before.
	if (!options.provider) {
		return loginWithChooser(options);
	}
	// Google is the only provider with a native path. Anything else (GitHub today) has no ID
	// token to offer, so it keeps the auth server's redirect flow below.
	const provider = options.provider;
	if (provider === 'google') {
		return loginWithGoogle(options);
	}
	const { verifier, challenge } = pkcePair();

	const { code } = await codeFromBrowser({
		callbackPath: '/callback',
		timeoutMs: options.timeoutMs,
		noBrowser: options.noBrowser,
		authorizeUrl: (redirect) => providerAuthorizeUrl(provider, redirect, challenge)
	});

	return exchangePkceCode(code, verifier);
}

/** The auth server's redirect flow for a named provider (GitHub), with PKCE and the account chooser. */
async function providerAuthorizeUrl(provider: string, redirect: string, challenge: string): Promise<string> {
	const authorize = new URL(await browserUrl(ACCOUNTS_URL, identityRoute('/provider/start', '/authorize'), APP_KEY));
	authorize.searchParams.set('provider', provider);
	authorize.searchParams.set('redirect_to', redirect);
	authorize.searchParams.set('code_challenge', challenge);
	authorize.searchParams.set('code_challenge_method', 's256');
	// ALWAYS ask which account.
	//
	// Without this, Google reuses whatever account the browser is already signed
	// into and never says so: you type `snoutdata login`, a page flashes, and you
	// are signed in as somebody else. On a shared machine, or for anybody with a
	// work account and a personal one, that is silently the wrong identity, and
	// the CLI is the surface where it is hardest to notice because there is no
	// avatar in the corner to check afterwards.
	//
	// The website has always done this (`prompt: 'select_account'`); the CLI did
	// not, which is the whole difference in behaviour between them.
	authorize.searchParams.set('prompt', 'select_account');
	return authorize.toString();
}


