/**
 * `snoutdata usage` — what this project has been using, and how close that is to the plan.
 *
 * One call to `cloud-project-usage`, which returns the daily history AND the plan's limit
 * together, so nothing here has to know a tier's numbers. `../usage.ts` turns those rows
 * into the two or three things somebody wants; this prints them.
 *
 * The headline is a sentence and not a table, because the question is almost always "am I
 * about to have a problem" and a person should not have to divide two numbers to find out.
 * The table is underneath for anybody who wanted the history.
 */

import * as api from '../api.js';
import { bold, dim, emit, say, table } from '../output.js';
import { describeBytes } from './db.js';
import { describeCompute, summariseUsage, type UsageDay, type UsageLimit } from '../usage.js';

interface UsageAnswer {
	ref: string;
	name: string;
	readOnly: boolean;
	measuredAt: string | null;
	days: UsageDay[];
	limit: UsageLimit | null;
}

export async function usage(ref: string, options: { days?: number; history?: boolean } = {}): Promise<number> {
	const answer = await api.call<UsageAnswer>('cloud-project-usage', {
		ref,
		...(options.days ? { days: options.days } : {})
	});
	const summary = summariseUsage(answer.days, answer.limit);

	emit({ ...answer, summary }, () => {
		say(bold(`${answer.name} (${answer.ref})`));

		if (!summary.latest) {
			// Distinct from "it is empty": nothing has measured it, which is what a project
			// created minutes ago looks like, and saying 0 B would be a claim nobody made.
			say('Nothing measured yet. The host samples every fifteen minutes.');
		} else if (summary.storage) {
			const percent = Math.round(summary.storage.fraction * 100);
			const of = `${describeBytes(summary.storage.usedBytes)} of ${describeBytes(summary.storage.limitBytes)} on ${answer.limit?.tier}`;
			say(
				summary.storage.state === 'over'
					? `${of} (${percent}%). Over the limit, so writes are refused until it shrinks or the plan changes.`
					: summary.storage.state === 'near'
						? `${of} (${percent}%). Close to the limit: at 100% the database goes read-only.`
						: `${of} (${percent}%).`
			);
		} else {
			say(`${describeBytes(summary.latest.dbBytes)} as of ${summary.latest.day}.`);
		}

		if (answer.readOnly && summary.storage?.state !== 'over') {
			// The row says read-only and the numbers do not agree, which happens in the
			// minute between shrinking the database and the host lifting the lock.
			say('This project is currently read-only.');
		}

		say(
			`Over ${summary.days} day${summary.days === 1 ? '' : 's'}: ${describeCompute(summary.computeSeconds)} of compute, ${summary.connections} connection${summary.connections === 1 ? '' : 's'}.`
		);
		if (summary.peakDbBytes !== null && summary.latest && summary.peakDbBytes > summary.latest.dbBytes) {
			say(dim(`Peak in that window was ${describeBytes(summary.peakDbBytes)}.`));
		}

		if (options.history && answer.days.length > 0) {
			say('');
			say(
				table([
					['DAY', 'SIZE', 'BACKUPS', 'COMPUTE', 'CONNS'],
					...answer.days.map((one) => [
						one.day,
						one.dbBytes === null ? '-' : describeBytes(one.dbBytes),
						one.repoBytes === null ? '-' : describeBytes(one.repoBytes),
						describeCompute(one.computeSeconds),
						String(one.connections)
					])
				])
			);
			say(dim('A dash is a day nothing measured it, which is what a paused project looks like.'));
		}
	});
	return 0;
}
