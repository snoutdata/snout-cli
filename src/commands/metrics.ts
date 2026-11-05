/**
 * `snoutdata metrics` — how hard each of a project's servers has been working.
 *
 * One call to `cloud-project-metrics`: per server (the project's own, each
 * cluster node, each replica), every figure's latest reading and its min, mean and max over the
 * window, from the host's minute-by-minute readings. `--json` adds the series the dashboard charts.
 *
 * A figure never measured in the window is left out rather than printed as zero: a project paused
 * for the whole hour has no CPU reading, which is not the same as 0%.
 */

import * as api from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, isJsonMode, relative, say, table } from '../output.js';
import { describeBytes } from './db.js';

type Window = 'hour' | 'day' | 'week';

interface Figure {
	latest: number | null;
	min: number | null;
	avg: number | null;
	max: number | null;
	samples: number;
}

interface NodeAnswer {
	ref: string;
	role: 'home' | 'node' | 'replica';
	latestAt: string | null;
	figures: Record<string, Figure | undefined>;
	points: Record<string, number | string | null>[];
}

interface MetricsAnswer {
	ref: string;
	window: Window;
	bucketSeconds: number;
	nodes: NodeAnswer[];
}

function trim(value: number, digits: number): string {
	return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

const bytesOf = (value: number) => describeBytes(Math.round(value));
const percent = (value: number) => `${trim(value, value < 10 ? 1 : 0)}%`;
const perSecond = (value: number) => `${trim(value, value < 10 ? 2 : value < 100 ? 1 : 0)}/s`;
const ms = (value: number) => (value >= 1000 ? `${trim(value / 1000, 2)} s` : `${trim(value, value < 1 ? 3 : 2)} ms`);
const seconds = (value: number) => (value < 1 ? `${trim(value * 1000, 0)} ms` : `${trim(value, 1)} s`);

/** The rows printed, in order: the figure's key in the answer, its label, how it is printed. */
const ROWS: readonly [string, string, (value: number) => string][] = [
	['cpuPercent', 'CPU', percent],
	['memoryBytes', 'Memory', bytesOf],
	['diskReadBps', 'Disk read', (value) => `${bytesOf(value)}/s`],
	['diskWriteBps', 'Disk write', (value) => `${bytesOf(value)}/s`],
	['connections', 'Connections', (value) => trim(value, 0)],
	['commitsPerSec', 'Commits', perSecond],
	['rollbacksPerSec', 'Rollbacks', perSecond],
	['statementsPerSec', 'Statements', perSecond],
	['meanStatementMs', 'Mean statement time', ms],
	['replicaLagSeconds', 'Replica lag', seconds],
	['replicaLagBytes', 'Replica behind by', bytesOf],
	['keeperLagSeconds', 'Second zone lag', seconds],
	['keeperLagBytes', 'Second zone behind by', bytesOf]
];

const WINDOW_WORDS: Record<Window, string> = { hour: 'the last hour', day: 'the last day', week: 'the last week' };

function nodeName(node: NodeAnswer): string {
	return node.role === 'home' ? `Home (${node.ref})` : node.role === 'replica' ? `Replica ${node.ref}` : `Node ${node.ref}`;
}

/** The limits a figure is read against, in one line. */
function limits(node: NodeAnswer): string {
	const parts: string[] = [];
	const cores = node.figures.cpuLimitCores?.latest;
	parts.push(cores ? `CPU limit ${trim(cores, 2)} cores` : 'no CPU limit');
	const memory = node.figures.memoryLimitBytes?.latest;
	if (memory) {
		parts.push(`memory limit ${describeBytes(memory)}`);
	}
	const connections = node.figures.maxConnections?.latest;
	if (connections) {
		parts.push(`${trim(connections, 0)} connections allowed`);
	}
	return parts.join(', ');
}

export async function metrics(ref: string, options: { node?: string; window?: string } = {}): Promise<number> {
	const window = (options.window ?? 'hour') as Window;
	if (!['hour', 'day', 'week'].includes(window)) {
		throw new UsageError('--window is hour, day or week');
	}
	const answer = await api.call<MetricsAnswer>('cloud-project-metrics', {
		ref,
		window,
		...(options.node ? { node: options.node } : {}),
		points: isJsonMode()
	});

	emit(answer, () => {
		if (answer.nodes.length === 0) {
			say(
				options.node
					? `Nothing measured for ${options.node} over ${WINDOW_WORDS[window]}. Is it one of ${answer.ref}'s servers?`
					: `Nothing measured over ${WINDOW_WORDS[window]}. The server records these once a minute while the database runs.`
			);
			return;
		}
		say(dim(`Over ${WINDOW_WORDS[window]}. NOW is the latest minute; MIN, AVG and MAX are over every minute in the window.`));
		for (const node of answer.nodes) {
			say('');
			say(`${bold(nodeName(node))}  ${dim(`last reading ${relative(node.latestAt)}, ${limits(node)}`)}`);
			const rows = ROWS.filter(([key]) => node.figures[key] !== undefined).map(([key, label, format]) => {
				const figure = node.figures[key]!;
				const show = (value: number | null) => (value === null ? '-' : format(value));
				return [label, show(figure.latest), show(figure.min), show(figure.avg), show(figure.max)];
			});
			say(table([['FIGURE', 'NOW', 'MIN', 'AVG', 'MAX'], ...rows]));
		}
	});
	return 0;
}
