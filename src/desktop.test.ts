/**
 * Rung three, in the parts that do not need a socket.
 *
 * The file-shaped half is where the mistakes live: a path that is wrong on one platform,
 * a switch that reads absent as off, a hand-edited file that stops the CLI working
 * instead of being ignored.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configPath, configPaths, offerFromConfig, readDesktopConfig } from './desktop.js';

test('the config is looked for where Electron actually puts it', () => {
	const win = configPath('win32', { APPDATA: 'C:\\Users\\joel\\AppData\\Roaming' });
	assert.match(win, /Roaming[\\/]snoutdata[\\/]mcp\.json$/);

	const mac = configPath('darwin', {});
	assert.match(mac, /Library[\\/]Application Support[\\/]snoutdata[\\/]mcp\.json$/);

	// Electron follows XDG on Linux and honours the override, so the CLI must too, or it
	// looks in the wrong place for exactly the people who set it.
	const linux = configPath('linux', { XDG_CONFIG_HOME: '/custom/config' });
	assert.equal(linux, join('/custom/config', 'snoutdata', 'mcp.json'));
	assert.match(configPath('linux', {}), /\.config[\\/]snoutdata[\\/]mcp\.json$/);
});

test('a missing, empty or hand-mangled file is "no desktop", never an error', () => {
	const dir = mkdtempSync(join(tmpdir(), 'snoutdata-desktop-'));
	assert.equal(readDesktopConfig(join(dir, 'nothing.json')), null);

	const broken = join(dir, 'broken.json');
	writeFileSync(broken, '{ this is not json');
	assert.equal(readDesktopConfig(broken), null, 'a broken file must not stop the CLI signing in another way');

	// Present but useless: no port, or no token, is nothing to dial.
	const partial = join(dir, 'partial.json');
	writeFileSync(partial, JSON.stringify({ enabled: true, port: 7311 }));
	assert.equal(readDesktopConfig(partial), null);

	const whole = join(dir, 'whole.json');
	writeFileSync(whole, JSON.stringify({ enabled: true, port: 7311, token: 'secret' }));
	assert.deepEqual(readDesktopConfig(whole), { enabled: true, port: 7311, token: 'secret' });
});

test('the two switches are honoured without dialling anything', () => {
	assert.equal(offerFromConfig(null), 'no-config');
	assert.equal(offerFromConfig({ port: 1, token: 'x', enabled: false }), 'server-disabled');
	assert.equal(offerFromConfig({ port: 1, token: 'x', signInHandoff: false }), 'handoff-disabled');
});

test('an older file with no handoff field is not read as a refusal', () => {
	// The app defaults it on and writes it back. Reading absent as off would make an
	// upgrade look like a feature that never worked.
	assert.equal(offerFromConfig({ port: 1, token: 'x' }), null);
	assert.equal(offerFromConfig({ port: 1, token: 'x', enabled: true, signInHandoff: true }), null);
});

test('both the installed app and one running from source are looked for', () => {
	// The bug this test exists for: src/main/index.ts appends "-dev" to userData when the
	// app is not packaged, so a developer's running app writes somewhere the installed
	// path never covers. Looking only at the first meant the feature silently never worked
	// for exactly the people most likely to try it, while a stale installed config sat
	// there pointing at a port nothing was listening on.
	const mac = configPaths('darwin', {});
	assert.equal(mac.length, 2);
	assert.match(mac[0]!, /Application Support[\\/]snoutdata[\\/]mcp\.json$/);
	assert.match(mac[1]!, /Application Support[\\/]snoutdata-dev[\\/]mcp\.json$/);

	// Matched rather than compared, like the two cases either side of it: `join` uses the
	// separator of the machine RUNNING the test, not of the platform being asked about, so
	// a literal '/cfg/snoutdata/mcp.json' passes on the Mac and fails on Windows for a
	// path the CLI builds perfectly well.
	const linux = configPaths('linux', { XDG_CONFIG_HOME: '/cfg' });
	assert.equal(linux.length, 2);
	assert.match(linux[0]!, /cfg[\\/]snoutdata[\\/]mcp\.json$/);
	assert.match(linux[1]!, /cfg[\\/]snoutdata-dev[\\/]mcp\.json$/);

	const win = configPaths('win32', { APPDATA: 'C:\\Roaming' });
	assert.equal(win.length, 2);
	assert.match(win[1]!, /snoutdata-dev/);

	// And the installed one stays first, since that is what a real user has.
	assert.equal(configPath('darwin', {}), mac[0]);
});

test('an explicit override replaces both, for a layout neither predicts', () => {
	assert.deepEqual(configPaths('darwin', { SNOUTDATA_DESKTOP_CONFIG: '/tmp/x.json' }), ['/tmp/x.json']);
});
