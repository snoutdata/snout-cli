/**
 * How the CLI's own Postgres connections (psql, pg_dump, pg_restore) do TLS.
 *
 * `sslmode=require` encrypts but checks nothing, so anybody on the path (a hotel network, a
 * hostile CI network) can present any certificate, ask for a cleartext password, and get the
 * project's owner password back from libpq (audit 14-C). A cloud project's front door at
 * `<ref>.db.snoutdata.com` presents a publicly trusted certificate, so these connections are
 * `verify-full`: the chain must reach a trusted root AND the name must match the host.
 *
 * The roots are Node's own bundle (`tls.rootCertificates`), written once to
 * `~/.snoutdata/ca-roots.pem` and passed as `PGSSLROOTCERT`. That rather than
 * `sslrootcert=system`, because `system` needs libpq 16 and an older psql reads it as a file
 * called "system" and fails; a PEM file works with every libpq. A `PGSSLROOTCERT` already in
 * the environment is used instead of ours.
 *
 * The opt-out is `SNOUTDATA_DB_SSLMODE` (for example `require`), for a network whose
 * Postgres is re-signed by an inspection proxy, or a development control plane with a
 * self-signed certificate. It is a deliberate step, never a fallback taken on its own.
 *
 * Only the connections this CLI makes are changed. The `DATABASE_URL` it prints or writes is
 * the server's, for the user's own driver, whose CA bundle and `sslmode` support we do not
 * control.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { rootCertificates } from 'node:tls';

/** The env var that turns verification off, by naming the mode to use instead. */
export const SSLMODE_OVERRIDE = 'SNOUTDATA_DB_SSLMODE';

/**
 * Node's trusted roots as one PEM file the user owns, written only when it is missing or
 * different. In the home directory, never a shared temp folder, where another user could
 * plant a file of their own roots first.
 */
export function rootBundle(home = homedir()): string {
	const path = join(home, '.snoutdata', 'ca-roots.pem');
	const pem = `${rootCertificates.join('\n')}\n`;
	let current: string | null = null;
	try {
		current = existsSync(path) ? readFileSync(path, 'utf8') : null;
	} catch {
		current = null;
	}
	if (current !== pem) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, pem, { mode: 0o644 });
		renameSync(temporary, path);
	}
	return path;
}

/** The sslmode and root file for a connection whose `ssl` came from the control plane. */
export function cloudSsl(ssl: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): { mode: string; rootCert?: string } {
	if (ssl === 'disable') {
		// Loopback only: a local pod (`local.ts`) has no certificate to check.
		return { mode: 'disable' };
	}
	const override = env[SSLMODE_OVERRIDE]?.trim();
	if (override) {
		return { mode: override };
	}
	return { mode: 'verify-full', rootCert: env.PGSSLROOTCERT || rootBundle(home) };
}

/** The same, as the environment a libpq child reads. */
export function pgSslEnv(ssl: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): Record<string, string> {
	const { mode, rootCert } = cloudSsl(ssl, env, home);
	return rootCert ? { PGSSLMODE: mode, PGSSLROOTCERT: rootCert } : { PGSSLMODE: mode };
}
