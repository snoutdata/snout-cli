/**
 * `snoutdata db allow …` — the addresses that may connect to a project's database (359).
 *
 *   snoutdata db allow [list]                       the list, and whether your address is on it
 *   snoutdata db allow add CIDR [--note TEXT]       an address or a range; again changes its note
 *   snoutdata db allow remove CIDR
 *   snoutdata db allow clear                        everyone may connect again
 *
 * All four go through `cloud-project-allow-list`, which decides (reading needs Infrastructure read,
 * a change Full access or the owner) and checks the address. An empty list is everyone.
 *
 * **It warns when the list leaves out the address you are calling from**, as the control plane saw
 * it: from here, the database door would then refuse you. On stderr, in both modes, because the
 * list is still what was asked for; `--json` carries it as `yourAddressListed`.
 */

import { call } from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, say, table, warn } from '../output.js';

export interface AllowEntry {
	cidr: string;
	note: string | null;
	addedAt: string;
}

export interface AllowList {
	ref: string;
	entries: AllowEntry[];
	limit: number;
	yourAddress: string | null;
	yourAddressListed: boolean | null;
	outcome?: 'added' | 'changed' | 'unchanged' | 'removed' | 'cleared' | 'none';
	cidr?: string | null;
}

export type AllowAsk =
	| { action: 'list' }
	| { action: 'add'; cidr: string; note: string | undefined }
	| { action: 'remove'; cidr: string }
	| { action: 'clear' };

/** What the words after `db allow` ask for, checked before anything is sent. */
export function parseAllow(words: readonly string[], note: string | undefined): AllowAsk {
	const [verb = 'list', target, ...extra] = words;
	if (extra.length > 0) {
		throw new UsageError(`db allow ${verb} takes one argument, not ${1 + extra.length}`);
	}
	if (note !== undefined && verb !== 'add') {
		throw new UsageError('--note is for db allow add');
	}
	switch (verb) {
		case 'list':
		case 'clear':
			if (target !== undefined) {
				throw new UsageError(`db allow ${verb} takes no argument`);
			}
			return { action: verb };
		case 'add':
			if (!target) {
				throw new UsageError('db allow add needs an address or a range: db allow add 203.0.113.0/24 [--note "office"]');
			}
			return { action: 'add', cidr: target, note };
		case 'remove':
			if (!target) {
				throw new UsageError('db allow remove needs the address or range to take off the list');
			}
			return { action: 'remove', cidr: target };
		default:
			throw new UsageError(`unknown command: db allow ${verb}. db allow list|add|remove|clear`);
	}
}

export async function allowCommand(ref: string, words: readonly string[], options: { note?: string | undefined }): Promise<void> {
	const asked = parseAllow(words, options.note);
	const body: Record<string, unknown> = { ref, action: asked.action };
	if (asked.action === 'add' || asked.action === 'remove') {
		body.cidr = asked.cidr;
	}
	if (asked.action === 'add' && asked.note !== undefined) {
		body.note = asked.note;
	}
	const result = await call<AllowList>('cloud-project-allow-list', body);
	emit(result, () => printResult(result));
	const caution = addressWarning(result);
	if (caution) {
		// Not commentary: what the database door will do to this machine. Printed under --quiet too.
		warn(caution);
	}
}

/** The sentence about the caller's own address, or null when there is nothing to say. */
export function addressWarning(result: Pick<AllowList, 'entries' | 'yourAddress' | 'yourAddressListed'>): string | null {
	if (result.entries.length === 0 || result.yourAddressListed !== false) {
		return null;
	}
	const where = result.yourAddress ? `Your address (${result.yourAddress})` : 'Your address';
	return `${where} is not on the list, so the database refuses connections from this machine. Add it with: snoutdata db allow add ${result.yourAddress ?? '<your address>'}`;
}

/** What one change did, in a sentence. */
export function outcomeLine(result: AllowList): string | null {
	const cidr = result.cidr ?? '';
	switch (result.outcome) {
		case 'added':
			return `Added ${cidr} to ${result.ref}'s allow-list.`;
		case 'changed':
			return `Changed the note on ${cidr}.`;
		case 'unchanged':
			return `${cidr} was already on the list.`;
		case 'removed':
			return `Took ${cidr} off ${result.ref}'s allow-list.`;
		case 'cleared':
			return `Cleared ${result.ref}'s allow-list: every address may connect again.`;
		case 'none':
			return cidr ? `${cidr} was not on the list.` : 'The list was already empty.';
		default:
			return null;
	}
}

function printResult(result: AllowList): void {
	const line = outcomeLine(result);
	if (line) {
		say(line);
	}
	if (result.entries.length === 0) {
		say(`${result.ref}'s database takes connections from every address (the allow-list is empty).`);
		if (result.yourAddress) {
			say(dim(`Your address: ${result.yourAddress}`));
		}
		return;
	}
	process.stdout.write(
		`${table([
			['ADDRESS', 'NOTE', 'ADDED'],
			...result.entries.map((entry) => [entry.cidr, entry.note ?? '', entry.addedAt.slice(0, 10)])
		])}\n`
	);
	say(dim(`${result.entries.length} of ${result.limit}. Only these addresses may connect to ${result.ref}'s database.`));
	if (result.yourAddress && result.yourAddressListed) {
		say(dim(`Your address ${bold(result.yourAddress)} is on the list.`));
	}
}
