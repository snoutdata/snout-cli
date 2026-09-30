/**
 * Signing in with Google, in the parts that do not need a browser.
 *
 * This command had never been driven by a person, which is exactly how it kept a dead
 * OAuth client for months. What is tested here is therefore not "does OAuth work" (it
 * cannot be, without Google) but the three things that are silent when wrong: the nonce
 * being in the right form for each end, the authorize URL carrying the parameters whose
 * absence is invisible until somebody is signed in as the wrong person, and the loopback
 * server telling a stray request apart from the redirect it is waiting for.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
	googleAuthorizeUrl,
	nonceForGoogle,
	openCommand,
	page,
	pkcePair,
	readRedirect,
	ssoDomain,
	ssoFailure
} from './login.js';

test('the nonce exists in two forms at once, and they are not interchangeable', () => {
	const { raw, hashed } = nonceForGoogle();

	// Google is given the hash and puts it in the token claim; the auth server is given the raw
	// value and hashes it itself. Send one where the other belongs and verification fails
	// with a message about the nonce that does not say which end sent the wrong form.
	assert.notEqual(raw, hashed);
	assert.match(hashed, /^[0-9a-f]{64}$/);
	assert.equal(hashed, createHash('sha256').update(raw).digest('hex'));

	// Two calls do not repeat. A reused nonce is a replayable sign-in.
	assert.notEqual(nonceForGoogle().raw, nonceForGoogle().raw);
});

test('the authorize URL carries the parameters whose absence is silent', () => {
	process.env.SNOUTDATA_GOOGLE_CLIENT_ID = 'the-client.apps.googleusercontent.com';
	const { hashed } = nonceForGoogle('a-known-nonce');
	const url = new URL(
		googleAuthorizeUrl({
			redirectUri: 'http://127.0.0.1:54321',
			challenge: 'the-challenge',
			hashedNonce: hashed,
			state: 'the-state'
		})
	);

	assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');

	// The client the build was given. Which client that is (the installed-app one, NOT the
	// deleted one inside the old auth server) is a fact about the build's environment now, not this file.
	assert.equal(url.searchParams.get('client_id'), 'the-client.apps.googleusercontent.com');

	// Without prompt=select_account, Google silently reuses whichever account the browser
	// is in and the CLI has no avatar in the corner to check afterwards.
	assert.equal(url.searchParams.get('prompt'), 'select_account');

	// PKCE, and the S256 method rather than plain.
	assert.equal(url.searchParams.get('code_challenge'), 'the-challenge');
	assert.equal(url.searchParams.get('code_challenge_method'), 'S256');

	assert.equal(url.searchParams.get('response_type'), 'code');
	assert.equal(url.searchParams.get('state'), 'the-state');
	// The HASHED nonce goes to Google. The raw one must never appear in a URL.
	assert.equal(url.searchParams.get('nonce'), hashed);
	assert.equal(url.searchParams.get('nonce')?.length, 64);

	// Loopback, and an address a browser on this machine can actually reach.
	assert.match(url.searchParams.get('redirect_uri') ?? '', /^http:\/\/127\.0\.0\.1:\d+$/);

	// An email is the whole point of the ID token: without it the session has no identity
	// to show in `whoami`.
	assert.equal(url.searchParams.get('scope'), 'openid email profile');
});

test('a browser asking for the favicon is not the redirect', () => {
	// The old path had no such guard: any request at all resolved or rejected the promise
	// and closed the server, so a browser that asked for /favicon.ico first ended the
	// sign-in before Google's redirect ever arrived.
	assert.deepEqual(readRedirect('/favicon.ico', 'the-state'), { kind: 'ignore' });
	assert.deepEqual(readRedirect('/', 'the-state'), { kind: 'ignore' });
});

test('the redirect is accepted only when the state comes back unchanged', () => {
	assert.deepEqual(readRedirect('/?code=abc&state=the-state', 'the-state'), {
		kind: 'ok',
		code: 'abc'
	});

	// A code arriving with somebody else's state is a redirect that landed on our port, or
	// a replay. It is not our sign-in and must not become our session.
	const mismatch = readRedirect('/?code=abc&state=somebody-elses', 'the-state');
	assert.equal(mismatch.kind, 'error');

	const missing = readRedirect('/?code=abc', 'the-state');
	assert.equal(missing.kind, 'error');
});

test('what Google says went wrong is what the person is told', () => {
	// error_description is the readable half; falling back to `error` alone gives
	// "access_denied", which reads like a bug in the CLI rather than a cancelled consent.
	const described = readRedirect(
		'/?error=access_denied&error_description=The+user+declined',
		'the-state'
	);
	assert.deepEqual(described, { kind: 'error', message: 'The user declined' });

	const bare = readRedirect('/?error=access_denied', 'the-state');
	assert.deepEqual(bare, { kind: 'error', message: 'access_denied' });
});

test('the page the browser is left on cannot be written by the redirect', () => {
	// `detail` is whatever came back in the URL's error_description, so it is attacker-shaped
	// input rendered into HTML on a page the person trusts.
	const html = page('failed', '<img src=x onerror=alert(1)>');
	assert.ok(!html.includes('<img src=x'));
	assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('the two states say different things, and neither pretends to open an app', () => {
	const ok = page('ok');
	assert.match(ok, /Signed in/);
	assert.match(ok, /<title>SnoutData<\/title>/);
	// The desktop's version of this page redirects to snoutdata:// to pull its own window
	// forward. A terminal has no window to raise, and firing it would prompt the browser to
	// open an app the person may not even have installed.
	assert.ok(!ok.includes('snoutdata://'));

	const failed = page('failed', 'The user declined');
	assert.match(failed, /Sign-in failed/);
	assert.match(failed, /The user declined/);
	// A failed sign-in leaves the terminal waiting for nothing, so the page has to say what
	// to do next rather than only what went wrong.
	assert.match(failed, /snoutdata login/);
});

test('Windows is asked to run something that exists', () => {
	// The defect this test exists for: `start` is a cmd.exe builtin, not a program, so
	// spawning it directly fails with ENOENT. `snoutdata login` printed the URL, said it was
	// opening a browser, and then died. Written on a Mac, so nothing caught it.
	const win = openCommand('win32', 'https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2');
	assert.equal(win.command, 'cmd.exe');
	assert.notEqual(win.args[0], 'start');

	// cmd reads a bare & as a command separator and an authorize URL is mostly &, so the URL
	// has to arrive quoted, and verbatim so Node does not re-quote it.
	assert.equal(win.verbatim, true);
	assert.ok(win.args.some((a) => a === '"https://accounts.google.com/o/oauth2/v2/auth?a=1&b=2"'));

	// start's first argument is the window TITLE. Without an empty one it takes the quoted
	// URL as the title and opens nothing.
	assert.deepEqual(win.args.slice(0, 3), ['/c', 'start', '""']);

	// The other two are unchanged and take the URL bare: they are not going through a shell.
	assert.deepEqual(openCommand('darwin', 'https://x?a=1&b=2'), {
		command: 'open',
		args: ['https://x?a=1&b=2'],
		verbatim: false
	});
	assert.deepEqual(openCommand('linux', 'https://x?a=1&b=2'), {
		command: 'xdg-open',
		args: ['https://x?a=1&b=2'],
		verbatim: false
	});
});

test('the flows that go through the auth server have no state of ours to check', () => {
	// GitHub and SSO are redirected by the auth server, which keeps its own state and hands back only
	// a code; the PKCE verifier is what binds that code to this process. Passing no expected
	// state must therefore accept the redirect — while still telling a favicon from it, which
	// is the guard the old GitHub path did not have at all.
	assert.deepEqual(readRedirect('/callback?code=abc'), { kind: 'ok', code: 'abc' });
	assert.deepEqual(readRedirect('/favicon.ico'), { kind: 'ignore' });
	assert.deepEqual(readRedirect('/callback?error=access_denied'), {
		kind: 'error',
		message: 'access_denied'
	});
});

test('the SSO domain comes from a work email, and a bare domain is fine too', () => {
	// What a person knows is their email address; nobody knows the name of their identity
	// provider. Only the domain is ever sent.
	assert.equal(ssoDomain('ada@acme.com'), 'acme.com');
	assert.equal(ssoDomain('  Ada@ACME.com '), 'acme.com');
	assert.equal(ssoDomain('ada.lovelace@mail.corp.acme.co.uk'), 'mail.corp.acme.co.uk');
	assert.equal(ssoDomain('acme.com'), 'acme.com');
	assert.equal(ssoDomain('my-company.co.uk'), 'my-company.co.uk');

	// A typo is refused here rather than becoming a request nobody can answer.
	for (const bad of ['', '   ', 'ada', '@acme.com', 'ada@', 'ada@@acme.com', 'ada@acme', 'ada@localhost', 'ada@acme.1', 'ada@-acme.com', 'ada@acme .com', 'ada@acme..com']) {
		assert.equal(ssoDomain(bad), null, `${JSON.stringify(bad)} is not a domain`);
	}
});

test('a domain nobody has connected is a sentence, not an HTTP status', () => {
	// The ordinary case, and it is not a fault in the product: no identity provider claims
	// that domain yet. It has to name the domain and point somewhere a person can go.
	const unknown = ssoFailure(404, '{"error_code":"sso_provider_not_found","msg":"No SSO provider assigned for this domain"}', 'acme.com');
	assert.equal(unknown.code, 'not-found');
	assert.match(unknown.message, /No single sign-on is set up for acme\.com\./);
	assert.match(unknown.message, /whoever administers your team/);
	assert.ok(!/404/.test(unknown.message));
	assert.deepEqual(unknown.details, { domain: 'acme.com' });

	// Same sentence when the status is something else and the words are the giveaway.
	assert.equal(ssoFailure(400, '{"msg":"No SSO provider assigned for this domain"}', 'acme.com').code, 'not-found');

	// SAML switched off on the project is a different sentence: the domain is not the problem.
	const disabled = ssoFailure(422, '{"msg":"SAML 2.0 is disabled"}', 'acme.com');
	assert.match(disabled.message, /not available for acme\.com yet/);

	// Anything we do not recognise keeps the server's own words rather than inventing a
	// diagnosis, and maps to the code the status means.
	const other = ssoFailure(500, '{"msg":"the sky fell"}', 'acme.com');
	assert.equal(other.code, 'server');
	assert.equal(other.message, 'the sky fell');

	// A body with no sentence in it (a proxy's HTML, an empty 502) still reads as English.
	const wordless = ssoFailure(502, '<html><body>Bad gateway</body></html>', 'acme.com');
	assert.equal(wordless.message, 'Could not start single sign-on for acme.com.');
});

test('PKCE: the verifier is kept and only the challenge is sent', () => {
	const { verifier, challenge } = pkcePair();
	assert.notEqual(verifier, challenge);
	// base64url: no padding, and nothing that would need escaping in a query string.
	assert.match(verifier, /^[A-Za-z0-9_-]+$/);
	assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});
