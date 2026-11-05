/**
 * The pages a `snoutdata login` shows in the browser, served by the CLI's own loopback server.
 *
 * They wear the dashboard's sign-in gate (its
 * `.gate-card`, `.btn-provider` and `.sso-*` rules in `styles.css`): the same tokens, the same card,
 * the same three ways in, so signing in from a terminal looks like signing in to the product rather
 * than a page a tool printed. The tokens are copied, not imported, because this is one bundled file
 * with nothing to load; keep them in step with the dashboard's `:root` by hand.
 *
 * Everything is inline: no stylesheet, no font, no script. The only thing fetched is the logo from
 * snoutdata.com, and a page that cannot reach it keeps its layout (the image has a fixed box). The
 * done page renders after the loopback server has closed, which is the other reason nothing here is
 * served by it.
 *
 * Every value that came from outside (an email typed in, an error from a provider) goes through
 * `escapeHtml`. The forms post back to the loopback with the run's own token, so a page elsewhere on
 * the machine cannot drive this sign-in.
 */

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const LOGO = 'https://snoutdata.com/logo-mark.png';

// The dashboard's tokens, light and dark from the system.
const STYLE = `
:root {
	color-scheme: light dark;
	--bg-app: light-dark(#f7f7f4, #0a0c10);
	--bg-card: light-dark(#ffffff, #12161f);
	--bg-input: light-dark(#ffffff, #151a24);
	--bg-hover: light-dark(#f0efe9, #1b212e);
	--border: light-dark(#e5e3da, #232a38);
	--border-soft: light-dark(#edece5, #1a212c);
	--fg: light-dark(#26251e, #f1f4f9);
	--fg-dim: light-dark(#76756d, #8a94a8);
	--btn-bg: light-dark(#26251e, #f1f4f9);
	--btn-fg: light-dark(#f7f7f4, #0a0c10);
	--btn-bg-hover: light-dark(#38362d, #ffffff);
	--btn-secondary: light-dark(#ecebe4, #1b212e);
	--btn-secondary-hover: light-dark(#e3e1d8, #232a38);
	--live: light-dark(#2f9a78, #4fc29c);
	--error: light-dark(#c0392b, #f48771);
	--ring: color-mix(in srgb, var(--fg) 45%, transparent);
	--radius: 12px;
	--radius-xl: 22px;
	--shadow-pop: 0 6px 22px light-dark(rgba(20, 18, 12, 0.1), rgba(0, 0, 0, 0.55)), 0 1px 3px light-dark(rgba(20, 18, 12, 0.06), rgba(0, 0, 0, 0.4));
	--ease: cubic-bezier(0.2, 0, 0, 1);
	--dur: 140ms;
	--font-ui: -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Ubuntu, sans-serif;
	--font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
	margin: 0;
	background: var(--bg-app);
	color: var(--fg);
	font-family: var(--font-ui);
	font-size: 15px;
	line-height: 1.55;
}
.gate { display: grid; place-items: center; min-height: 100vh; padding: 20px; }
.gate-card {
	width: min(400px, 100%);
	display: flex;
	flex-direction: column;
	gap: 14px;
	background: var(--bg-card);
	border: 1px solid var(--border);
	border-radius: var(--radius-xl);
	box-shadow: var(--shadow-pop);
	padding: 28px;
	text-align: center;
	animation: rise 320ms var(--ease) both;
}
.brand-mark { display: block; width: 40px; height: 40px; margin: 0 auto; }
h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -0.02em; }
p { margin: 0; }
.muted { color: var(--fg-dim); }
.small { font-size: 13px; }
.stack { display: flex; flex-direction: column; gap: 10px; }
button, a.btn {
	font: inherit;
	font-size: 14px;
	font-weight: 500;
	color: var(--fg);
	background: var(--btn-secondary);
	border: 1px solid var(--border-soft);
	border-radius: var(--radius);
	padding: 9px 12px;
	cursor: pointer;
	text-decoration: none;
	transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease), transform var(--dur) var(--ease);
}
button:where(:hover), a.btn:where(:hover) { background: var(--btn-secondary-hover); }
button:active, a.btn:active { transform: scale(0.97); }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.btn-provider { display: flex; align-items: center; justify-content: center; gap: 10px; width: 100%; }
.btn-primary { background: var(--btn-bg); border-color: transparent; color: var(--btn-fg); width: 100%; }
.btn-primary:hover { background: var(--btn-bg-hover); }
.or { display: flex; align-items: center; gap: 10px; color: var(--fg-dim); font-size: 12px; }
.or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--border); }
form { display: flex; flex-direction: column; gap: 9px; text-align: left; margin: 0; }
label { font-size: 13px; font-weight: 500; }
input {
	font-family: var(--font-ui);
	font-size: 14px;
	line-height: 1.5;
	color: var(--fg);
	background: var(--bg-input);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 10px 12px;
	width: 100%;
}
input.code { font-family: var(--font-mono); font-size: 20px; letter-spacing: 0.3em; text-align: center; }
.error { font-size: 13px; color: var(--error); text-align: left; }
.link { align-self: flex-start; padding: 0; border: 0; background: none; font-size: 13px; color: var(--fg-dim); text-decoration: underline; }
.link:hover { background: none; color: var(--fg); }
.where { border-top: 1px solid var(--border); padding-top: 14px; }
code, .terminal { font-family: var(--font-mono); font-size: 13px; }
.terminal {
	display: block;
	text-align: left;
	background: var(--bg-app);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 12px 14px;
	color: var(--fg);
	font-size: 12.5px;
	overflow-wrap: anywhere;
}
.gate-card.wide { width: min(440px, 100%); }
.terminal .prompt { color: var(--fg-dim); user-select: none; }
.terminal .ok { color: var(--live); }
.badge {
	width: 56px;
	height: 56px;
	margin: 2px auto 0;
	border-radius: 50%;
	display: grid;
	place-items: center;
	background: color-mix(in srgb, var(--badge) 14%, transparent);
	color: var(--badge);
	animation: pop 420ms var(--ease) both 80ms;
}
.badge svg path { stroke-dasharray: 30; stroke-dashoffset: 30; animation: draw 360ms var(--ease) forwards 300ms; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes pop { from { transform: scale(0.6); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes draw { to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) {
	.gate-card, .badge { animation: none; }
	.badge svg path { animation: none; stroke-dashoffset: 0; }
	button, a.btn { transition: none; }
}
`;

function shell(inner: string, wide = false): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SnoutData</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<style>${STYLE}</style></head>
<body><main class="gate"><div class="gate-card${wide ? ' wide' : ''}">
<img class="brand-mark" src="${LOGO}" width="40" height="40" alt="">
${inner}
</div></main></body></html>`;
}

/** What the card says it is for, under every form: a terminal on this machine is waiting. */
function footnote(profile?: string): string {
	const who = profile ? ` as profile <strong>${escapeHtml(profile)}</strong>` : '';
	return `<p class="small muted where">Signing in the <code>snoutdata</code> CLI on this computer${who}. Your terminal carries on once you are in.</p>`;
}

function errorLine(error?: string): string {
	return error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
}

/** The three ways in, as the dashboard offers them. */
export function chooserPage(options: {
	token: string;
	email?: string;
	error?: string;
	profile?: string;
	google: boolean;
}): string {
	const t = encodeURIComponent(options.token);
	const google = options.google
		? `<a class="btn btn-provider" href="/google?t=${t}">${GOOGLE_ICON}Continue with Google</a>`
		: '';
	return shell(`<h1>SnoutData</h1>
<p class="small muted">Sign in with the same account as the app and the dashboard.</p>
<div class="stack">
${google}
<a class="btn btn-provider" href="/github?t=${t}">${GITHUB_ICON}Continue with GitHub</a>
<div class="or">or</div>
<form method="post" action="/email">
<input type="hidden" name="t" value="${escapeHtml(options.token)}">
<label for="email">Work email</label>
<input id="email" name="email" type="email" autocomplete="email" placeholder="you@company.com" required value="${escapeHtml(options.email ?? '')}"${options.email ? '' : ' autofocus'}>
${errorLine(options.error)}
<button class="btn-primary" type="submit">Continue</button>
</form>
<p class="small muted">Your company's identity provider if it has one, or a code sent to that address.</p>
</div>
${footnote(options.profile)}`);
}

/** The email-code step: six digits, the address they went to, and a quiet way to send another. */
export function codePage(options: { token: string; email: string; error?: string; notice?: string; profile?: string }): string {
	const t = escapeHtml(options.token);
	return shell(`<h1>Check your email</h1>
<p class="small muted">We sent a code to <strong>${escapeHtml(options.email)}</strong>.</p>
<form method="post" action="/code">
<input type="hidden" name="t" value="${t}">
<label for="code">Code</label>
<input id="code" class="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,8}" maxlength="8" required autofocus>
${errorLine(options.error)}
${options.notice ? `<p class="small muted" role="status">${escapeHtml(options.notice)}</p>` : ''}
<button class="btn-primary" type="submit">Sign in</button>
</form>
<form method="post" action="/resend">
<input type="hidden" name="t" value="${t}">
<button class="link" type="submit">Send another code</button>
</form>
<form method="get" action="/">
<input type="hidden" name="t" value="${t}">
<button class="link" type="submit">Use another way to sign in</button>
</form>
${footnote(options.profile)}`);
}

const CHECK = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const CROSS = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;

/** Signed in: who, and what to type next. The terminal has already moved on by the time this shows. */
export function donePage(options: { email?: string; profile?: string } = {}): string {
	const as = options.email ? `<p class="muted">as <strong style="color:var(--fg)">${escapeHtml(options.email)}</strong></p>` : '';
	const flag = options.profile ? ` --profile ${escapeHtml(options.profile)}` : '';
	return shell(`<div class="badge" style="--badge:var(--live)">${CHECK}</div>
<h1>Signed in</h1>
${as}
<p class="small muted where">Your terminal is signed in. Next, try:</p>
<span class="terminal"><span class="prompt">$ </span>snoutdata projects list${flag}</span>
<p class="small muted">You can close this tab.</p>`, true);
}

/** Refused, with what was said and what to do, since the terminal is left waiting for nothing. */
export function failedPage(detail?: string): string {
	return shell(`<div class="badge" style="--badge:var(--error)">${CROSS}</div>
<h1>Sign-in failed</h1>
<p class="muted">${escapeHtml(detail ?? 'Something went wrong.')}</p>
<span class="terminal"><span class="prompt">$ </span>snoutdata login</span>
<p class="small muted">Run that in your terminal to try again.</p>`);
}

const GOOGLE_ICON = `<svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33Z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"/></svg>`;
const GITHUB_ICON = `<svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.4 7.4 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;
