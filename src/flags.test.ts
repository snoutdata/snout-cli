import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS, commandsFor, flagHelp } from './catalogue.js';
import { parseArgs } from './args.js';

/**
 * Every flag the CLI DOCUMENTS has to parse.
 *
 * The flag list in `main.ts` and the two sets in `args.ts` were three lists nothing compared,
 * and the cost was not theoretical: `start --no-migrations` and `gen types --local` were both
 * printed by the CLI’s own help — and `--local` in the success message `snoutdata start` prints
 * every single time — and both were rejected as an unknown option. Found on Windows, 2026-09-11,
 * because a machine with no psql is the one that has to reach for them.
 *
 * A flag that takes a value is given one; a boolean is passed bare. Either way the only thing
 * asserted is that the parser accepted it, which is the whole of what was broken.
 */
describe('every documented flag parses', () => {
	for (const command of COMMANDS) {
		for (const flag of command.flags) {
			test(`${command.name} ${flag}`, () => {
				const words = command.name.split(' ');
				// Valued or boolean is not written down anywhere, so try bare first and fall back to
				// a value. A flag that is refused BOTH ways is one the parser has never heard of.
				const bare = attempt([...words, flag]);
				const valued = attempt([...words, flag, 'x']);
				assert.ok(
					bare === null || valued === null,
					`${command.name} documents ${flag} and the parser refuses it: ${bare ?? valued}`
				);
			});
		}
	}
});

function attempt(argv: readonly string[]): string | null {
	try {
		parseArgs(argv);
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

describe('every documented flag says what it does', () => {
	for (const command of COMMANDS) {
		for (const flag of command.flags) {
			test(`${command.name} ${flag}`, () => {
				assert.ok(flagHelp(command.name, flag).length > 0, `${command.name} documents ${flag} with no line in FLAG_HELP`);
			});
		}
	}
});

describe('<group> <action> --help is about that command', () => {
	test('an action that names a command narrows to it, with its arguments', () => {
		const found = commandsFor('auth', 'anonymous');
		assert.deepEqual(found.map((one) => one.name), ['auth anonymous']);
		assert.equal('args' in found[0]! ? found[0].args : undefined, 'on|off');
	});

	test('an action that names a group keeps the group', () => {
		assert.deepEqual(commandsFor('push', 'credentials').map((one) => one.name), ['push credentials', 'push credentials set', 'push credentials remove']);
	});

	test('no action, or one that names nothing, is the whole group', () => {
		const all = commandsFor('domains').map((one) => one.name);
		assert.ok(all.length > 1);
		assert.deepEqual(commandsFor('domains', 'example.com').map((one) => one.name), all);
	});
});
