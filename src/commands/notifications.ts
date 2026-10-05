/**
 * `snoutdata push credentials …` — a project's APNs and FCM keys for Snout Push.
 *
 * The keys are the customer's own and they live in the project's own database, not in ours:
 * `cloud-project-push` relays them to the project's `/push/v1/credentials`, which PROVES a key
 * before storing it (an Apple key must sign, a Firebase service account must get a real token
 * from Google). So a key that will not work is refused here with the reason. Nothing prints a
 * key back: `list` shows what identifies each one, and the project never returns more.
 *
 * Named `notifications.ts` because `push.ts` is `db push`, which is migrations.
 */

import { readFile } from 'node:fs/promises';
import { call } from '../api.js';
import { UsageError } from '../args.js';
import { dim, emit, say, table } from '../output.js';

export type PushCredentialKind = 'apns' | 'fcm';

export interface PushCredentialSummaries {
	apns?: { topic?: string; keys?: { key_id: string; team_id: string; environment: string | null }[]; updated_at?: string };
	fcm?: { project_id?: string; client_email?: string; updated_at?: string };
	vapid?: { current?: string; public_key?: string; updated_at?: string };
}

export function parseKind(word: string | undefined): PushCredentialKind {
	if (word === 'apns' || word === 'fcm') {
		return word;
	}
	throw new UsageError('say which: apns (an Apple .p8) or fcm (a Firebase service account)');
}

export async function getPushCredentials(ref: string): Promise<{ ref: string; credentials: PushCredentialSummaries }> {
	const credentials = await call<PushCredentialSummaries>('cloud-project-push', { ref, credentials: { list: true } });
	return { ref, credentials: credentials ?? {} };
}

export interface ApnsFlags {
	p8?: string;
	keyId?: string;
	teamId?: string;
	topic?: string;
	environment?: string;
}

/** The body `/push/v1/credentials/apns` takes, from the flags and the .p8 file. */
export async function apnsBody(flags: ApnsFlags): Promise<Record<string, unknown>> {
	if (!flags.p8 || !flags.keyId || !flags.teamId || !flags.topic) {
		throw new UsageError('push credentials set apns needs --p8 AuthKey.p8 --key-id ID --team-id ID --topic com.example.app');
	}
	if (flags.environment !== undefined && flags.environment !== 'production' && flags.environment !== 'sandbox') {
		throw new UsageError('--environment is production or sandbox; leave it out for a key that serves both');
	}
	return {
		topic: flags.topic,
		keys: [{ p8: await readFile(flags.p8, 'utf8'), key_id: flags.keyId, team_id: flags.teamId, environment: flags.environment ?? null }]
	};
}

export async function fcmBody(file: string | undefined): Promise<Record<string, unknown>> {
	if (!file) {
		throw new UsageError('push credentials set fcm needs --file service-account.json');
	}
	return { service_account: await readFile(file, 'utf8') };
}

export async function setPushCredentials(ref: string, kind: PushCredentialKind, body: Record<string, unknown>): Promise<{ ref: string; kind: PushCredentialKind; summary: unknown }> {
	const summary = await call('cloud-project-push', { ref, credentials: { set: { kind, body } } });
	return { ref, kind, summary };
}

export async function removePushCredentials(ref: string, kind: PushCredentialKind): Promise<{ ref: string; kind: PushCredentialKind; removed: true }> {
	await call('cloud-project-push', { ref, credentials: { remove: kind } });
	return { ref, kind, removed: true };
}

export async function listCommand(ref: string): Promise<void> {
	const answer = await getPushCredentials(ref);
	emit(answer, () => {
		const { apns, fcm, vapid } = answer.credentials;
		process.stdout.write(`${table([
			['TRANSPORT', 'SET', ''],
			['web push', vapid ? 'yes' : 'starting', vapid?.public_key ? `public key ${vapid.public_key.slice(0, 16)}…` : ''],
			['apns', apns ? 'yes' : 'no', apns ? `${apns.topic}, key ${apns.keys?.map((k) => k.key_id).join(', ')}` : ''],
			['fcm', fcm ? 'yes' : 'no', fcm ? `${fcm.project_id} as ${fcm.client_email}` : ''],
		])}\n`);
		if (!apns || !fcm) {
			say(dim(`  snoutdata push credentials set ${apns ? 'fcm --file service-account.json' : 'apns --p8 AuthKey.p8 --key-id ID --team-id ID --topic com.example.app'} --ref ${ref}`));
		}
	});
}

export async function setCommand(ref: string, kind: PushCredentialKind, body: Record<string, unknown>): Promise<void> {
	const result = await setPushCredentials(ref, kind, body);
	emit(result, () => say(`${kind === 'apns' ? 'The Apple key signed' : 'Google accepted the service account'}, and it is stored in the project's own database.`));
}

export async function removeCommand(ref: string, kind: PushCredentialKind): Promise<void> {
	const result = await removePushCredentials(ref, kind);
	emit(result, () => say(`${kind} credentials removed. Devices on it stop receiving until new ones are set.`));
}
