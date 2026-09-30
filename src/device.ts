/**
 * Signing in from a terminal that has no browser.
 *
 * Rung four of the auth ladder (`docs/cli/PLAN.md`, D4). The loopback flow `login` uses cannot
 * serve the cases this exists for: over SSH the callback lands on the wrong machine, in a
 * container there is nothing listening on the host, in CI there is nobody to click. This
 * needs no callback at all, only a code somebody carries to a browser they already have.
 *
 * **The code is typed, never carried in a link.** A URL with the code in it authorises
 * whoever opens it, and on a shared machine, a screen-shared call, or a terminal whose
 * scrollback is in a CI log, that is not the person at the keyboard. Typing is the thing
 * that proves the two are the same somebody, which is why the control plane returns the
 * URL and the code as two separate strings and this prints them apart.
 *
 * Nothing here holds a secret worth stealing on its own: the pairing secret can only ever
 * be exchanged for whatever a person deliberately approves in a browser, and the control
 * plane hands the token over exactly once.
 */

import { ACCOUNTS_URL, ANON_KEY } from './api.js';
import { fail } from './failure.js';

export interface DeviceStart {
	code: string;
	secret: string;
	expiresAt: string;
	verifyUrl: string;
	/** Seconds the server wants between polls. Honoured rather than guessed at. */
	interval: number;
}

export type DevicePoll =
	| { status: 'pending' | 'slow-down'; interval?: number }
	| { status: 'approved'; token: string; name?: string; prefix?: string; expiresAt?: string | null }
	| { status: 'denied' | 'used' | 'expired'; error?: string };

async function post<T>(fn: string, body: unknown): Promise<{ status: number; body: T }> {
	const response = await fetch(`${ACCOUNTS_URL}/functions/v1/${fn}`, {
		method: 'POST',
		headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const parsed = (await response.json().catch(() => ({}))) as T;
	return { status: response.status, body: parsed };
}

/** Ask for a pairing code. Needs no credential, which is the point of it. */
export async function start(client: { name?: string; platform?: string } = {}): Promise<DeviceStart> {
	const { status, body } = await post<DeviceStart & { error?: string }>('cloud-device-start', { client });
	if (status === 429) {
		fail('quota', body.error ?? 'too many pairing attempts from here: wait a few minutes');
	}
	if (status === 404) {
		// Not "something went wrong": this control plane has no pairing flow deployed, and
		// no amount of retrying changes that. Saying which is the difference between a
		// person trying again forever and a person using the thing that does work.
		fail(
			'not-found',
			'this SnoutData does not have the pairing flow (cloud-device-start is not deployed). Use `snoutdata login` to sign in with a browser, or set SNOUTDATA_ACCESS_TOKEN.'
		);
	}
	if (status !== 200 || !body.code || !body.secret) {
		fail('server', body.error ?? `could not start a pairing (${status})`);
	}
	return body;
}

/**
 * Wait for somebody to approve it, at the pace the server asks for.
 *
 * `slow-down` is not a failure and not a reason to stop: it means we polled early, so the
 * interval widens and the loop continues. A `404` IS a reason to stop, because an unknown
 * secret never becomes a known one and waiting on it is waiting forever.
 */
export async function waitForApproval(
	secret: string,
	options: { intervalMs: number; expiresAt: string; onWait?: (secondsLeft: number) => void }
): Promise<{ token: string; name?: string }> {
	let intervalMs = options.intervalMs;
	const deadline = Date.parse(options.expiresAt);
	for (;;) {
		if (Date.now() > deadline) {
			fail('timeout', 'that pairing code expired before it was approved. Run the command again for a new one.');
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		const { status, body } = await post<DevicePoll & { error?: string }>('cloud-device-poll', { secret });
		if (status === 404) {
			fail('not-found', 'that pairing is not known to the server. Run the command again for a new code.');
		}
		if (status === 400) {
			fail('usage', body.error ?? 'that is not a pairing secret');
		}
		if (status !== 200) {
			fail('server', body.error ?? `the pairing could not be checked (${status})`);
		}
		switch (body.status) {
			case 'approved':
				return { token: (body as { token: string }).token, name: (body as { name?: string }).name };
			case 'denied':
				fail('forbidden', body.error ?? 'that pairing was refused in the browser');
			// falls through, unreachable: `fail` never returns
			case 'used':
				fail('conflict', body.error ?? 'that pairing has already been completed');
			case 'expired':
				fail('timeout', body.error ?? 'that pairing code expired before it was approved');
			case 'slow-down':
				// Polled early. Widen rather than give up, and never below what was asked.
				intervalMs = Math.max(intervalMs * 2, (body.interval ?? 2) * 1000);
				break;
			default:
				if (body.interval) {
					intervalMs = Math.max(intervalMs, body.interval * 1000);
				}
				break;
		}
		options.onWait?.(Math.max(0, Math.round((deadline - Date.now()) / 1000)));
	}
}
