import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { COMMANDS } from './catalogue.js';
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
