/**
 * A project's auth settings from a terminal: Sign in with Google, and where a sign-in may return
 * to. The same `cloud-project-auth` `status` and `settings` actions the dashboard's Auth tab
 * calls (review item 15).
 *
 *   snoutdata auth                                   what is set
 *   snoutdata auth google --client-id ID --stdin     Google on; the client secret from a pipe
 *   snoutdata auth google off                        Google off
 *   snoutdata auth anonymous on|off                  guest sign-in (signInAnonymously)
 *   snoutdata auth redirects --site-url URL --allow URL,URL
 *   snoutdata auth templates                         the five emails, ours or yours
 *   snoutdata auth template KIND --file body.html [--subject S] | reset
 *
 * It is the customer's OWN Google OAuth client. The secret is read from stdin only, never a
 * flag, for `secrets set`'s reason: an argument is in the shell history and in `ps`.
 */

import { readFile } from 'node:fs/promises';
import * as api from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, say, table } from '../output.js';

const API_DOMAIN = 'api.snoutdata.com';

export interface AuthSettings {
	ref: string;
	enabled: boolean;
	siteUrl: string | null;
	redirects: string[];
	google: { enabled: boolean; clientId: string | null; clientSecretSet: boolean; ready: boolean };
	/** What the customer adds to their Google client's Authorized redirect URIs. */
	googleCallback: string;
	/** Guest sign-in: `enabled` is the switch, `ready` is what the auth service was given. */
	anonymous: { enabled: boolean; ready: boolean };
}

interface Status {
	enabled?: boolean;
	settings?: { site_url?: string | null; uri_allow_list?: string[] | null } | null;
	google?: { enabled?: boolean; clientId?: string | null; clientSecretSet?: boolean; ready?: boolean };
	anonymous?: { enabled?: boolean; ready?: boolean };
}

function shape(ref: string, status: Status): AuthSettings {
	return {
		ref,
		enabled: status.enabled === true,
		siteUrl: status.settings?.site_url ?? null,
		redirects: status.settings?.uri_allow_list ?? [],
		google: {
			enabled: status.google?.enabled === true,
			clientId: status.google?.clientId ?? null,
			clientSecretSet: status.google?.clientSecretSet === true,
			ready: status.google?.ready === true,
		},
		googleCallback: `https://${ref}.${API_DOMAIN}/auth/v1/callback`,
		anonymous: {
			enabled: status.anonymous?.enabled === true,
			ready: status.anonymous?.ready === true,
		},
	};
}

export async function getAuth(ref: string): Promise<AuthSettings> {
	return shape(ref, await api.call<Status>('cloud-project-auth', { ref, action: 'status' }));
}

export async function setAuth(ref: string, settings: Record<string, unknown>): Promise<AuthSettings> {
	return shape(ref, await api.call<Status>('cloud-project-auth', { ref, action: 'settings', settings }));
}

function print(settings: AuthSettings): void {
	const google = settings.google;
	let googleWord = 'off';
	if (google.ready) {
		googleWord = bold('on');
	} else if (google.enabled) {
		googleWord = `switched on, not offered yet: needs ${[!google.clientId && 'a client id', !google.clientSecretSet && 'a client secret'].filter(Boolean).join(' and ')}`;
	}
	process.stdout.write(`${table([
		['auth', settings.enabled ? bold('on') : 'off'],
		['site url', settings.siteUrl ?? dim('not set')],
		['redirects', settings.redirects.length ? settings.redirects.join(', ') : dim('none')],
		['google', googleWord],
		['google client id', google.clientId ?? dim('not set')],
		['google callback', settings.googleCallback],
		['guests', settings.anonymous.ready ? bold('on') : settings.anonymous.enabled ? 'switched on, not applied yet' : 'off'],
	])}\n`);
	if (!settings.enabled) {
		say(dim(`  snoutdata products enable auth --ref ${settings.ref}`));
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

export async function authCommand(
	ref: string,
	action: string | undefined,
	rest: readonly string[],
	flags: { clientId?: string; stdin: boolean; siteUrl?: string; allow?: string; file?: string; subject?: string },
): Promise<void> {
	if (action === undefined || action === 'show') {
		const settings = await getAuth(ref);
		emit(settings, () => print(settings));
		return;
	}
	if (action === 'google') {
		if (rest[0] === 'off') {
			const settings = await setAuth(ref, { googleEnabled: false });
			emit(settings, () => say('Google sign-in is off. Your auth service restarts within about a minute.'));
			return;
		}
		if (rest.length > 0) {
			throw new UsageError('auth google takes --client-id and --stdin, or "off"');
		}
		const values: Record<string, unknown> = { googleEnabled: true };
		if (flags.clientId) {
			values.googleClientId = flags.clientId;
		}
		if (flags.stdin) {
			const secret = await readStdin();
			if (!secret) {
				throw new UsageError('--stdin read nothing. Pipe the Google client secret in.');
			}
			values.googleClientSecret = secret;
		}
		const settings = await setAuth(ref, values);
		emit(settings, () => {
			if (settings.google.ready) {
				say('Google sign-in is on. Your auth service restarts within about a minute.');
			} else {
				print(settings);
			}
			say(dim(`  Add ${settings.googleCallback} to your Google client's Authorized redirect URIs.`));
		});
		return;
	}
	if (action === 'anonymous' || action === 'guests') {
		const word = rest[0];
		if (word !== 'on' && word !== 'off') {
			throw new UsageError('auth anonymous takes "on" or "off"');
		}
		const settings = await setAuth(ref, { anonymousEnabled: word === 'on' });
		emit(settings, () => {
			if (word === 'off') {
				say('Guest sign-in is off. Guests who already have a session keep it until it ends. Your auth service restarts within about a minute.');
			} else if (settings.enabled) {
				say('Guest sign-in is on: signInAnonymously() gives a browser a session with no email or password. Your auth service restarts within about a minute.');
			} else {
				say('Guest sign-in is switched on, and takes effect when auth is.');
				say(dim(`  snoutdata products enable auth --ref ${settings.ref}`));
			}
		});
		return;
	}
	if (action === 'redirects') {
		const values: Record<string, unknown> = {};
		if (flags.siteUrl !== undefined) {
			values.siteUrl = flags.siteUrl || null;
		}
		if (flags.allow !== undefined) {
			values.uriAllowList = flags.allow.split(',').map((url) => url.trim()).filter(Boolean);
		}
		if (Object.keys(values).length === 0) {
			throw new UsageError('auth redirects needs --site-url and/or --allow URL,URL (an empty --allow= clears the list)');
		}
		const settings = await setAuth(ref, values);
		emit(settings, () => print(settings));
		return;
	}
	if (action === 'templates') {
		const answer = await api.call<{ templates: EmailTemplate[] }>('cloud-project-auth', { ref, action: 'templates' });
		emit(answer, () => printTemplates(answer.templates));
		return;
	}
	if (action === 'template') {
		const kind = rest[0];
		if (!kind || !TEMPLATE_KINDS.includes(kind)) {
			throw new UsageError(`auth template needs a kind: ${TEMPLATE_KINDS.join(', ')}`);
		}
		let template: Record<string, unknown>;
		if (rest[1] === 'reset') {
			template = { kind, reset: true };
		} else {
			if (!flags.file) {
				throw new UsageError(`auth template ${kind} needs --file body.html (and --subject), or "reset"`);
			}
			const body = await readFile(flags.file, 'utf8');
			const current = await api.call<{ templates: EmailTemplate[] }>('cloud-project-auth', { ref, action: 'templates' });
			const subject = flags.subject ?? current.templates.find((t) => t.kind === kind)?.subject;
			template = { kind, subject, body };
		}
		const answer = await api.call<{ templates: EmailTemplate[] }>('cloud-project-auth', { ref, action: 'template', template });
		emit(answer, () => {
			printTemplates(answer.templates);
			say(dim('  Your auth service restarts with it within about a minute.'));
		});
		return;
	}
	throw new UsageError(`unknown command: auth ${action}. auth [google [off] | anonymous on|off | redirects | templates | template KIND]`);
}

// --- email templates (084) ------------------------------------------------------------------

const TEMPLATE_KINDS = ['confirmation', 'recovery', 'magic_link', 'invite', 'email_change'];

interface EmailTemplate {
	kind: string;
	custom: boolean;
	subject: string;
	body: string;
	updatedAt: string | null;
}

function printTemplates(templates: readonly EmailTemplate[]): void {
	process.stdout.write(`${table([
		['KIND', 'SOURCE', 'SUBJECT'],
		...templates.map((t) => [t.kind, t.custom ? bold('yours') : 'ours', t.subject]),
	])}\n`);
}
