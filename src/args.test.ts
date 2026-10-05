import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { flagBoolean, flagNumber, flagString, parseArgs, UsageError } from './args.js';

test('a command is its positional words, in order', () => {
	assert.deepEqual(parseArgs(['db', 'psql']).command, ['db', 'psql']);
});

test('a valued flag takes the next word, or an inline one', () => {
	assert.equal(flagString(parseArgs(['--name', 'my project']), 'name'), 'my project');
	assert.equal(flagString(parseArgs(['--name=my project']), 'name'), 'my project');
});

test('a boolean flag is a boolean, and refusing a value on one is deliberate', () => {
	assert.equal(flagBoolean(parseArgs(['--json']), 'json'), true);
	assert.throws(() => parseArgs(['--json=yes']), UsageError);
});

test('an unknown flag stops the command rather than being ignored', () => {
	// A typo in a script that silently does something else is worse than one that stops.
	assert.throws(() => parseArgs(['--jsno']), /unknown option --jsno/);
});

test('a valued flag with nothing after it is an error, not an empty string', () => {
	assert.throws(() => parseArgs(['--name']), /--name needs a value/);
});

test('everything after -- is positional, however it is spelled', () => {
	const args = parseArgs(['db', 'psql', '--', '-c', 'select 1', '--json']);
	assert.deepEqual(args.command, ['db', 'psql', '-c', 'select 1', '--json']);
	// And the --json AFTER the separator is psql's, not ours.
	assert.equal(args.json, false);
});

test('--json is read once, up front, so every command can honour it', () => {
	assert.equal(parseArgs(['projects', 'list', '--json']).json, true);
	assert.equal(parseArgs(['--json', 'projects', 'list']).json, true);
});

test('a number flag is a number, and anything else stops the command', () => {
	assert.equal(flagNumber(parseArgs(['tokens', 'create', '--expires', '30']), 'expires'), 30);
	assert.equal(flagNumber(parseArgs(['tokens', 'create']), 'expires'), undefined);
	// Exit 2 territory: a script that meant days and typed a date should stop here
	// rather than send it to the control plane and interpret a 400.
	assert.throws(() => flagNumber(parseArgs(['--expires', 'next-tuesday']), 'expires'), UsageError);
	assert.throws(() => flagNumber(parseArgs(['--expires', '1.5']), 'expires'), UsageError);
});

test('the functions flags are known, because an unknown one is refused outright', () => {
	// The guard doing its job is how this was found: `functions deploy --no-verify-jwt`
	// failed with "unknown option" against a live project. Every flag a command reads has
	// to be declared here, and a command reading one that is not is a command whose flag
	// silently never arrives — which is the defect the `--yes` note above describes from
	// the other side.
	assert.equal(parseArgs(['functions', 'deploy', 'hello', '--no-verify-jwt']).flags['no-verify-jwt'], true);
	assert.equal(parseArgs(['secrets', 'set', 'K', '--stdin']).flags.stdin, true);
	assert.equal(
		parseArgs(['functions', 'deploy', 'hello', '--entrypoint', 'server.ts']).flags.entrypoint,
		'server.ts'
	);
	assert.equal(parseArgs(['functions', 'deploy', 'hello', '--dir', 'fns/hello']).flags.dir, 'fns/hello');
});
