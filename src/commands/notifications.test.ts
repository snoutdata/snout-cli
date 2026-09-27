import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { UsageError } from '../args.js';
import { apnsBody, fcmBody, parseKind } from './notifications.js';

test('a kind is apns or fcm, and nothing else', () => {
	assert.equal(parseKind('apns'), 'apns');
	assert.equal(parseKind('fcm'), 'fcm');
	assert.throws(() => parseKind('vapid'), UsageError, 'VAPID keys are the project\'s own, made by it');
	assert.throws(() => parseKind(undefined), UsageError);
});

test('the APNs body reads the .p8 from a file and names every field the project checks', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'push-cli-'));
	const p8 = join(dir, 'AuthKey_ABC123DEFG.p8');
	await writeFile(p8, 'key file contents\n');
	assert.deepEqual(await apnsBody({ p8, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'com.example.app' }), {
		topic: 'com.example.app',
		keys: [{ p8: 'key file contents\n', key_id: 'ABC123DEFG', team_id: 'TEAM123456', environment: null }]
	});
	const sandbox = await apnsBody({ p8, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'a.b', environment: 'sandbox' });
	assert.equal((sandbox.keys as { environment: string }[])[0]?.environment, 'sandbox');
	await assert.rejects(() => apnsBody({ p8, keyId: 'ABC123DEFG', teamId: 'TEAM123456' }), /--topic/);
	await assert.rejects(() => apnsBody({ p8, keyId: 'ABC123DEFG', teamId: 'TEAM123456', topic: 'a.b', environment: 'staging' }), /production or sandbox/);
});

test('the FCM body is the service-account file as it is', async () => {
	const dir = await mkdtemp(join(tmpdir(), 'push-cli-'));
	const file = join(dir, 'sa.json');
	await writeFile(file, '{"type":"service_account"}');
	assert.deepEqual(await fcmBody(file), { service_account: '{"type":"service_account"}' });
	await assert.rejects(() => fcmBody(undefined), /--file/);
});
