/**
 * How this CLI gets a credential when it has none, and when it is allowed to try.
 *
 * The rungs, in order, and the order is the whole design:
 *
 *   1. `SNOUTDATA_ACCESS_TOKEN`     read in `config.ts`, before any of this
 *   2. `~/.snoutdata/auth.json`     the stored session, likewise
 *   3. the desktop app              running here, signed in, and willing to mint
 *   4. a browser                    the ordinary sign-in, the same as `snoutdata login`
 *   5. a pairing code               when the browser could not be used
 *
 * Four was missing at first, and declining the app therefore offered only the pairing
 * code, which is the fallback rather than the path. Somebody with no app installed and a
 * perfectly good browser was steered to the least likely option. The order now matches
 * what is actually most likely to work: the app if it is here, a browser if there is one,
 * and a code when there is not.
 *
 * ## The rule that matters more than the rungs
 *
 * **Three and four exist only when there is a person to answer them** (D1). Anything else
 * fails immediately with `not-signed-in` and a sentence naming what would have worked.
 *
 * This is not caution for its own sake. `snoutdata login --json` used to spawn a browser
 * and block for five minutes while printing nothing at all, because the one line telling
 * you what to do went through `say()`, which JSON mode silences. That was one command
 * behaving badly. A ladder that can stop and ask, without this rule, would give that
 * behaviour to all twenty-one, at the moment an agent is least able to explain itself.
 *
 * So: an agent gets exit 3 in milliseconds and a message it can act on. A person gets
 * offered the two things that are actually available to them.
 */

import { createInterface } from 'node:readline/promises';
import { writeAuth, type StoredAuth } from './config.js';
import * as desktop from './desktop.js';
import * as device from './device.js';
import { canAsk } from './interactive.js';
import { login } from './commands/login.js';
import { bold, dim, say } from './output.js';

/** Ask a yes/no question. Only ever reached behind `canAsk()`. */
async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		const answer = (await rl.question(`${question} [Y/n] `)).trim().toLowerCase();
		return answer === '' || answer === 'y' || answer === 'yes';
	} finally {
		rl.close();
	}
}

/**
 * Rung three. Offer the running app, if there is one and it is willing.
 *
 * Every "no" here is silent on purpose. Somebody without the app installed must not read
 * a paragraph about a feature they are not using on their way to signing in normally.
 */
async function fromDesktop(): Promise<StoredAuth | null> {
	const look = await desktop.look();
	if (!look.available) {
		// Two of these are the user having switched something off, and saying so once is
		// worth it: otherwise the feature looks broken rather than disabled.
		if (look.skip === 'handoff-disabled' || look.skip === 'server-disabled') {
			say(dim('SnoutData Studio is running but is not set to hand out sign-ins.'));
		}
		return null;
	}
	const who = look.who.email ?? 'the signed-in account';
	say('');
	say(`SnoutData Studio is open here, signed in as ${bold(who)}.`);
	say(dim('It can create an access token for this terminal. Your sign-in itself is not handed over,'));
	say(dim('and you can revoke the token later with `snoutdata tokens revoke`.'));
	if (!(await confirm('Use it?'))) {
		return null;
	}
	say('Asking SnoutData Studio. Approve it there.');
	const minted = await desktop.mint(look.config, process.argv.slice(2).join(' ').slice(0, 60) || 'snoutdata');
	if ('declined' in minted) {
		say(`The app did not create a token: ${minted.reason}`);
		return null;
	}
	const auth: StoredAuth = { accessToken: minted.token };
	writeAuth(auth);
	say(`Signed in with "${minted.name}".`);
	return auth;
}

/** Rung four. The ordinary sign-in, which is what most people want and what `login` does. */
async function fromBrowser(): Promise<StoredAuth | null> {
	if (!(await confirm('Sign in with a browser?'))) {
		return null;
	}
	try {
		const result = await login({});
		say(`Signed in${result.email ? ` as ${result.email}` : ''}.`);
		return { accessToken: result.accessToken, refreshToken: result.refreshToken, expiresAt: result.expiresAt };
	} catch (error) {
		// Not fatal: this is the rung where "there is no browser on this box" shows up, and
		// the next rung is the answer to exactly that.
		say(`That did not finish: ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
}

/** Rung five. A code, a browser anywhere, and no callback to this machine. */
async function fromDeviceCode(): Promise<StoredAuth | null> {
	if (!(await confirm('Sign in by typing a code into a browser on another machine?'))) {
		return null;
	}
	const started = await device.start({ name: desktop.thisMachine(), platform: process.platform });
	say('');
	say(`  Open   ${bold(started.verifyUrl)}`);
	say(`  Type   ${bold(started.code)}`);
	say('');
	say(dim('The code is typed rather than in the link on purpose: it is what proves the person'));
	say(dim('at the browser is the person at this terminal. Waiting…'));
	const approved = await device.waitForApproval(started.secret, {
		intervalMs: Math.max(1, started.interval) * 1000,
		expiresAt: started.expiresAt
	});
	const auth: StoredAuth = { accessToken: approved.token };
	writeAuth(auth);
	say(`Signed in${approved.name ? ` with "${approved.name}"` : ''}.`);
	return auth;
}

/**
 * Try the interactive rungs, or none of them.
 *
 * Returns null rather than throwing when there is nobody to ask, so the caller raises the
 * `NotSignedIn` it would have raised anyway, with the message that names the token.
 */
export async function climb(): Promise<StoredAuth | null> {
	if (!canAsk()) {
		return null;
	}
	const fromApp = await fromDesktop();
	if (fromApp) {
		return fromApp;
	}
	const browser = await fromBrowser();
	if (browser) {
		return browser;
	}
	return fromDeviceCode();
}
