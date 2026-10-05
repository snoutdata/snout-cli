import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { INSTALL_SH, NPM_INSTALL, installKind, olderThan, outdatedAdvice, upgradeCommand } from './version.js';
import { assetFor, expectedSum } from './commands/upgrade.js';
import { EXIT, codeForStatus } from './failure.js';

describe('how the CLI was installed', () => {
	test('a Bun-compiled snoutdata executable is the binary', () => {
		assert.equal(installKind({ bun: true, execPath: '/home/a/.local/bin/snoutdata', script: '/$bunfs/root/snoutdata' }), 'binary');
		assert.equal(installKind({ bun: true, execPath: 'C:\\Users\\a\\snoutdata.exe', script: 'B:/~BUN/root/snoutdata.exe' }), 'binary');
	});
	test('npx runs from its cache', () => {
		assert.equal(installKind({ bun: false, execPath: '/usr/bin/node', script: '/home/a/.npm/_npx/1a2b/node_modules/snoutdata/dist/snoutdata.mjs' }), 'npx');
		assert.equal(installKind({ bun: false, execPath: 'C:\\node.exe', script: 'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\9f\\node_modules\\snoutdata\\dist\\snoutdata.mjs' }), 'npx');
	});
	test('a global npm install', () => {
		assert.equal(installKind({ bun: false, execPath: '/usr/bin/node', script: '/usr/lib/node_modules/snoutdata/dist/snoutdata.mjs' }), 'npm');
	});
	test('anything else is source', () => {
		assert.equal(installKind({ bun: false, execPath: '/usr/bin/node', script: '/repo/snout-cli/dist/snoutdata.mjs' }), 'source');
	});
});

describe('being out of date', () => {
	test('versions compare numerically, and dev is never behind', () => {
		assert.equal(olderThan('0.3.0', '0.10.1'), true);
		assert.equal(olderThan('0.10.1', '0.10.1'), false);
		assert.equal(olderThan('0.10.2', '0.10.1'), false);
		assert.equal(olderThan('dev', '9.9.9'), false);
	});
	test('the advice names the command that works for this install, and the fallbacks', () => {
		assert.equal(upgradeCommand('npx'), 'npx snoutdata@latest');
		assert.equal(upgradeCommand('binary'), 'snoutdata upgrade');
		const posix = outdatedAdvice({ minimum: '0.11.0', kind: 'binary', platform: 'linux' });
		assert.match(posix, /0\.11\.0 or later is required/);
		assert.ok(posix.includes('snoutdata upgrade') && posix.includes(INSTALL_SH) && posix.includes(NPM_INSTALL));
		// install.sh refuses Windows, so it is never offered there.
		assert.ok(!outdatedAdvice({ kind: 'npm', platform: 'win32' }).includes(INSTALL_SH));
	});
	test('a 410 is outdated, exit 11, not the generic 1', () => {
		assert.equal(codeForStatus(410), 'outdated');
		assert.equal(EXIT.outdated, 11);
	});
});

describe('upgrade', () => {
	test('asset names match the release build', () => {
		assert.equal(assetFor('linux', 'x64'), 'snoutdata-linux-x64');
		assert.equal(assetFor('darwin', 'arm64'), 'snoutdata-darwin-arm64');
		assert.equal(assetFor('win32', 'x64'), 'snoutdata-windows-x64.exe');
		assert.equal(assetFor('win32', 'arm64'), null);
	});
	test('SHA256SUMS is read in both sha256sum forms', () => {
		const a = 'a'.repeat(64);
		const b = 'B'.repeat(64);
		const sums = `${a}  snoutdata-linux-x64\n${b} *snoutdata-windows-x64.exe\n`;
		assert.equal(expectedSum(sums, 'snoutdata-linux-x64'), a);
		assert.equal(expectedSum(sums, 'snoutdata-windows-x64.exe'), b.toLowerCase());
		assert.equal(expectedSum(sums, 'snoutdata-linux-arm64'), null);
	});
});
