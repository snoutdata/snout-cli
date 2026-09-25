/**
 * Turning a month of daily readings into the two or three things somebody actually wants
 * to know.
 *
 * Pure. It takes the rows the control plane returned and the plan's limit, and returns a
 * summary; the command prints it. Which means the awkward cases — a paused project, a
 * project measured once, a plan with no limit — are provable without a network.
 *
 * ## The one rule that shapes all of it
 *
 * **A missing measurement is not a measurement of zero.** A paused pod reports no size at
 * all, so its days carry `null` rather than `0`, and reading those as zero would say the
 * database shrank to nothing every time somebody stopped using it. So the current size is
 * the most recent day that HAS a reading, `null` when there is none, and never a number
 * this file invented. That is the same defect `cloud-host-poll` shipped against a whole
 * fleet's capacity, and it is worth being careful about twice.
 *
 * Compute and connections are different in kind and are summed: they are intervals and
 * counts, so a day with none really did have none.
 */

export interface UsageDay {
	readonly day: string;
	/** Null on a day the project was paused: nothing measured it. */
	readonly dbBytes: number | null;
	readonly repoBytes: number | null;
	readonly computeSeconds: number;
	readonly connections: number;
}

export interface UsageLimit {
	readonly tier: string;
	readonly maxStorageBytes: number;
}

/** How the size compares with the plan. `near` is the one worth acting on before it bites. */
export type StorageState = 'ok' | 'near' | 'over';

/** The fraction of the limit at which "near" starts. */
export const NEAR_FRACTION = 0.8;

export interface UsageSummary {
	/** How many days of history this covers, counting only days there is a row for. */
	readonly days: number;
	/** The most recent day with a SIZE, and that day's numbers. Null when nothing was measured. */
	readonly latest: { day: string; dbBytes: number; repoBytes: number | null } | null;
	/** The largest the database has been, over the window. Null when nothing was measured. */
	readonly peakDbBytes: number | null;
	/** Summed over the window: intervals and counts, where a missing day really is none. */
	readonly computeSeconds: number;
	readonly connections: number;
	/** How the latest size sits against the plan. Null when either half is unknown. */
	readonly storage: { limitBytes: number; usedBytes: number; fraction: number; state: StorageState } | null;
}

function storageState(fraction: number): StorageState {
	if (fraction >= 1) {
		return 'over';
	}
	return fraction >= NEAR_FRACTION ? 'near' : 'ok';
}

export function summariseUsage(days: readonly UsageDay[], limit: UsageLimit | null): UsageSummary {
	// The most recent day that actually measured something, which is not necessarily the
	// most recent day.
	let latest: UsageSummary['latest'] = null;
	let peak: number | null = null;
	let computeSeconds = 0;
	let connections = 0;

	for (const day of days) {
		computeSeconds += Number.isFinite(day.computeSeconds) ? day.computeSeconds : 0;
		connections += Number.isFinite(day.connections) ? day.connections : 0;
		if (day.dbBytes === null || !Number.isFinite(day.dbBytes)) {
			continue;
		}
		peak = peak === null ? day.dbBytes : Math.max(peak, day.dbBytes);
		if (!latest || day.day >= latest.day) {
			latest = { day: day.day, dbBytes: day.dbBytes, repoBytes: day.repoBytes };
		}
	}

	const storage =
		latest && limit && limit.maxStorageBytes > 0
			? {
					limitBytes: limit.maxStorageBytes,
					usedBytes: latest.dbBytes,
					fraction: latest.dbBytes / limit.maxStorageBytes,
					state: storageState(latest.dbBytes / limit.maxStorageBytes)
				}
			: null;

	return { days: days.length, latest, peakDbBytes: peak, computeSeconds, connections, storage };
}

/** "2 days 3 hours", "14 minutes", "none": compute time as somebody would say it. */
export function describeCompute(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds <= 0) {
		return 'none';
	}
	const day = Math.floor(seconds / 86_400);
	const hour = Math.floor((seconds % 86_400) / 3_600);
	const minute = Math.floor((seconds % 3_600) / 60);
	if (day > 0) {
		return hour > 0 ? `${day}d ${hour}h` : `${day}d`;
	}
	if (hour > 0) {
		return minute > 0 ? `${hour}h ${minute}m` : `${hour}h`;
	}
	return minute > 0 ? `${minute}m` : `${Math.round(seconds)}s`;
}
