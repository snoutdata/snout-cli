/**
 * The contract, asserted.
 *
 * `README.md` has always promised an agent that `--json` puts exactly one JSON value on
 * stdout. That was true on the success path and false on every failure path, and nothing
 * noticed for the life of the CLI, because the only way to notice is to run a command that
 * fails and read stdout rather than the terminal. So: these tests.
 *
 * The end-to-end half runs the built CLI as a subprocess with a deliberately broken
 * environment. It is the only place in this repo that asserts what a *shell* sees, which
 * is the thing an agent actually consumes.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { CliFailure, EXIT, codeForStatus, codeForThrown, type FailureCode } from './failure.js';

test('every code has an exit code, and none of them is zero', () => {
	const codes: FailureCode[] = [
		'usage',
		'not-signed-in',
		'forbidden',
		'not-found',
		'not-ready',
		'conflict',
		'quota',
		'network',
		'timeout',
		'tool-missing',
		'server',
		'failed'
	];
	for (const code of codes) {
		const exit = EXIT[code];
		assert.equal(typeof exit, 'number', `${code} has no exit code`);
		assert.notEqual(exit, 0, `${code} exits 0, so a shell would read a failure as success`);
	}
});

test('the codes the README documents keep the numbers it documents', () => {
	// 0-4 predate this file. A script somebody already wrote checks them, and changing
	// what they mean would be a silent breakage rather than a visible one.
	assert.equal(EXIT.ok, 0);
	assert.equal(EXIT.failed, 1);
	assert.equal(EXIT.usage, 2);
	assert.equal(EXIT['not-signed-in'], 3);
	assert.equal(EXIT['not-ready'], 4);
	assert.equal(EXIT['tool-missing'], 127);
});

test('an HTTP status becomes something worth branching on', () => {
	assert.equal(codeForStatus(403), 'forbidden');
	assert.equal(codeForStatus(404), 'not-found');
	assert.equal(codeForStatus(409), 'conflict');
	assert.equal(codeForStatus(429), 'quota');
	assert.equal(codeForStatus(503), 'not-ready');
	assert.equal(codeForStatus(500), 'server');
	// Not a bucket for everything unrecognised: a 418 is a failure, not a server fault.
	assert.equal(codeForStatus(418), 'failed');
});

test('a dead network is told apart from a bug of ours', () => {
	// Node reports every connection problem as a bare `TypeError: fetch failed` with the
	// real reason on `cause`, which is why this arrived as exit 1 like any other throw.
	const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
	assert.equal(codeForThrown(refused), 'network');
	const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('lookup'), { code: 'ENOTFOUND' }) });
	assert.equal(codeForThrown(dns), 'network');
	// An expired certificate is the network too, as far as what a caller should do.
	const tls = new TypeError('fetch failed', { cause: Object.assign(new Error('tls'), { code: 'CERT_HAS_EXPIRED' }) });
	assert.equal(codeForThrown(tls), 'network');
	// A real bug is not.
	assert.equal(codeForThrown(new TypeError('x is not a function')), 'failed');
});

test('a failure carries its details, so a refusal can say what it refused', () => {
	const failure = new CliFailure('conflict', 'they do not agree', { problems: [{ code: 'changed' }] });
	assert.equal(failure.code, 'conflict');
	assert.equal(failure.exitCode, EXIT.conflict);
	assert.deepEqual(failure.details, { problems: [{ code: 'changed' }] });
});

// ---------------------------------------------------------------------------
// End to end: what a shell actually sees.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
// The compiled test sits BESIDE the compiled entry point (`out/failure.test.js` and
// `out/main.js`), which is how `npm test` runs them.
const entry = join(here, 'main.js');

/** Run the built CLI and return what each stream got, plus the code. */
function run(args: readonly string[], env: NodeJS.ProcessEnv = {}): { code: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(process.execPath, [entry, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, NO_COLOR: '1', ...env }
		});
		return { code: 0, stdout, stderr: '' };
	} catch (error) {
		const spawned = error as { status?: number; stdout?: string; stderr?: string };
		return { code: spawned.status ?? -1, stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' };
	}
}

const built = existsSync(entry);

test('a failure under --json puts a code on stdout, not an empty stream', { skip: built ? false : 'run npm test, which builds first' }, () => {
	// No credential anywhere: the CLI cannot possibly succeed, which is the point.
	const result = run(['whoami', '--json'], { SNOUTDATA_ACCESS_TOKEN: '', HOME: here, USERPROFILE: here });
	assert.notEqual(result.code, 0, 'a command with no credential exited 0');
	assert.notEqual(result.stdout.trim(), '', 'stdout was EMPTY on a failure: this is the bug this file exists for');
	const parsed = JSON.parse(result.stdout) as { ok: boolean; code: string; error: string };
	assert.equal(parsed.ok, false);
	assert.equal(typeof parsed.code, 'string');
	assert.ok(parsed.code.length > 0, 'a failure with no code is a failure a program cannot branch on');
	assert.ok(parsed.error.length > 0, 'a failure with no sentence is one a person cannot read');
});

test('an unknown flag is refused rather than ignored', { skip: built ? false : 'run npm test, which builds first' }, () => {
	// Eight flags used to parse and do nothing, `--yes` among them, which is exactly the
	// one a script author reaches for and assumes has confirmed something.
	for (const flag of ['--yes', '--token', '--password', '--limit', '--nonsense']) {
		const result = run(['whoami', flag, 'x']);
		assert.equal(result.code, EXIT.usage, `${flag} did not exit ${EXIT.usage}`);
		assert.match(result.stderr, /unknown option/, `${flag} was accepted`);
	}
});

test('asking for help is not an error, and answers in JSON when asked to', { skip: built ? false : 'run npm test, which builds first' }, () => {
	const plain = run(['--help']);
	assert.equal(plain.code, 0, '--help exited non-zero, so `snoutdata --help || exit` fails a script reading the help');

	const asJson = run(['--help', '--json']);
	assert.equal(asJson.code, 0);
	const parsed = JSON.parse(asJson.stdout) as { commands: { name: string }[] };
	assert.ok(Array.isArray(parsed.commands), 'the command list is not machine-readable');
	const names = parsed.commands.map((one) => one.name);
	for (const expected of ['init', 'db push', 'db export', 'usage', 'mcp']) {
		assert.ok(names.includes(expected), `${expected} is missing from the machine-readable help`);
	}
});

test('running with no arguments at all is still a usage error', { skip: built ? false : 'run npm test, which builds first' }, () => {
	assert.equal(run([]).code, EXIT.usage);
});

test('with no human, the ladder is never climbed and the message names the token', { skip: built ? false : 'run npm test, which builds first' }, () => {
	// D1, end to end and at the level that matters: a command with no credential must fail
	// in milliseconds rather than stopping to ask something nobody can answer. If a rung
	// ever escapes the gate, this test hangs, which is the correct way to find out.
	const started = Date.now();
	const result = run(['projects', 'list', '--json'], {
		SNOUTDATA_ACCESS_TOKEN: '',
		HOME: here,
		USERPROFILE: here,
		SNOUTDATA_NO_INTERACTIVE: '1'
	});
	assert.equal(result.code, EXIT['not-signed-in'], 'a credential-less run did not exit not-signed-in');
	assert.ok(Date.now() - started < 15_000, 'it waited, which means a rung asked something nobody could answer');
	const parsed = JSON.parse(result.stdout) as { code: string; error: string };
	assert.equal(parsed.code, 'not-signed-in');
	// The advice has to be the thing that works HERE. "Run snoutdata login" tells a script
	// to open a browser, which is the one thing it cannot do.
	assert.match(parsed.error, /SNOUTDATA_ACCESS_TOKEN/);
	assert.match(parsed.error, /nothing was asked/);
});

test('help for one command answers about that command, not the whole manual', { skip: built ? false : 'run npm test, which builds first' }, () => {
	const result = run(['projects', '--help']);
	assert.equal(result.code, 0);
	assert.match(result.stdout, /projects create/);
	// The thing it used to do: print everything, which is the answer to a different
	// question and buries the five lines somebody wanted.
	assert.doesNotMatch(result.stdout, /snoutdata db push/, 'group help printed the whole manual');

	const asJson = run(['db', '--help', '--json']);
	const parsed = JSON.parse(asJson.stdout) as { commands: { name: string }[] };
	assert.ok(parsed.commands.every((one) => one.name.startsWith('db')), 'db --help returned commands that are not db');
	assert.ok(parsed.commands.length >= 5);
});
