/**
 * The CLI's own Postgres connections check the certificate (audit 14-C), and say how not to.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rootCertificates } from 'node:tls';
import { cloudSsl, pgSslEnv, rootBundle } from './pgTls.js';

function home(): string {
	return mkdtempSync(join(tmpdir(), 'snoutdata-tls-'));
}

test('a cloud connection is verify-full against Node\'s roots, written under the home directory', () => {
	const dir = home();
	const env = pgSslEnv('require', {}, dir);
	assert.equal(env.PGSSLMODE, 'verify-full');
	assert.equal(env.PGSSLROOTCERT, join(dir, '.snoutdata', 'ca-roots.pem'));
	const pem = readFileSync(env.PGSSLROOTCERT!, 'utf8');
	assert.equal(pem.match(/BEGIN CERTIFICATE/g)?.length, rootCertificates.length);
});

test('the root file is rewritten when it differs, so a stale or tampered one does not stick', () => {
	const dir = home();
	const path = rootBundle(dir);
	writeFileSync(path, 'not a certificate');
	rootBundle(dir);
	assert.match(readFileSync(path, 'utf8'), /BEGIN CERTIFICATE/);
	if (process.platform !== 'win32') {
		assert.equal(statSync(join(dir, '.snoutdata')).mode & 0o077, 0);
	}
});

test('a PGSSLROOTCERT already set is used instead of ours', () => {
	assert.deepEqual(cloudSsl('require', { PGSSLROOTCERT: '/etc/corp.pem' }, home()), { mode: 'verify-full', rootCert: '/etc/corp.pem' });
});

test('SNOUTDATA_DB_SSLMODE opts out, and a loopback pod stays disable', () => {
	assert.deepEqual(pgSslEnv('require', { SNOUTDATA_DB_SSLMODE: 'require' }, home()), { PGSSLMODE: 'require' });
	assert.deepEqual(pgSslEnv('disable', {}, home()), { PGSSLMODE: 'disable' });
});
