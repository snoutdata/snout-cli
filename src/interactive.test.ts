/**
 * The no-prompt rule, asserted. The rule this file protects is the one that keeps an agent from hanging,
 * so every way of saying "nobody is watching" gets a test rather than a comment.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explainNoHuman, interactiveState } from './interactive.js';

const TTY = { isTty: true, json: false, env: {} as NodeJS.ProcessEnv };

test('a person at a terminal may be asked', () => {
	assert.equal(interactiveState(TTY).canAsk, true);
});

test('no terminal, no question', () => {
	const state = interactiveState({ ...TTY, isTty: false });
	assert.equal(state.canAsk, false);
	assert.equal(state.reason, 'not-a-tty');
});

test('--json is a script even when there is a terminal to draw on', () => {
	// The case that would otherwise slip through: somebody running `snoutdata … --json`
	// from their own shell is still writing something that parses the output.
	const state = interactiveState({ ...TTY, json: true });
	assert.equal(state.canAsk, false);
	assert.equal(state.reason, 'json');
});

test('CI is refused even when it hands out a pseudo-terminal', () => {
	// The reason the TTY check is not enough on its own: several providers allocate one,
	// and the job would sit at a prompt until somebody killed it.
	for (const name of ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'TF_BUILD']) {
		const state = interactiveState({ ...TTY, env: { [name]: 'true' } });
		assert.equal(state.canAsk, false, `${name} did not stop a prompt`);
		assert.equal(state.reason, 'ci');
	}
});

test('the opt-out wins, and is not fooled by a falsy string', () => {
	assert.equal(interactiveState({ ...TTY, env: { SNOUTDATA_NO_INTERACTIVE: '1' } }).reason, 'opted-out');
	// An env var set to "0" or "false" is somebody turning it OFF, and reading it as truthy
	// because it is a non-empty string is the classic version of this bug.
	assert.equal(interactiveState({ ...TTY, env: { SNOUTDATA_NO_INTERACTIVE: '0' } }).canAsk, true);
	assert.equal(interactiveState({ ...TTY, env: { SNOUTDATA_NO_INTERACTIVE: 'false' } }).canAsk, true);
	assert.equal(interactiveState({ ...TTY, env: { SNOUTDATA_NO_INTERACTIVE: '' } }).canAsk, true);
	assert.equal(interactiveState({ ...TTY, env: { CI: '0' } }).canAsk, true);
});

test('every reason can be explained to whoever hit it', () => {
	for (const reason of ['not-a-tty', 'json', 'opted-out', 'ci'] as const) {
		const said = explainNoHuman(reason);
		assert.ok(said.length > 0, `${reason} has nothing to say`);
	}
});
