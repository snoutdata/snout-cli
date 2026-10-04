/**
 * `snoutdata realtime inspect|logs` — what a project's Realtime is doing, from the server's
 * side.
 *
 * Before this there was nowhere to look. "A friend disappeared from the game" could only be
 * answered by adding logging to the game and reproducing it with a bot client, while the
 * server knew exactly when that socket went and why. It now keeps the channels open, who is
 * on each, their presence, the last minute of messages, and a bounded log of connections
 * coming and going with the reason each one ended (snout-realtime's `inspect.rs`), and
 * `cloud-project-realtime` hands both to the project's owner.
 *
 * In memory on the server and bounded: a restart of the project's host forgets it, and the
 * log keeps the newest thousand events.
 */

import * as api from '../api.js';
import { UsageError } from '../args.js';
import { bold, dim, emit, isJsonMode, say, table } from '../output.js';

export interface RealtimeClient {
	socket: number;
	presence_key: string;
	joined_at: number;
	/** How long since a frame (a heartbeat, a message) last arrived on that socket. A client
	 *  that has been silent for a minute is very likely gone without saying so. */
	last_seen_ms_ago: number | null;
}

export interface RealtimeChannel {
	name: string;
	private: boolean;
	clients: RealtimeClient[];
	/** `{ key: { metas: [...] } }`, exactly as a client receives `presence_state`. */
	presence: Record<string, { metas: Array<Record<string, unknown>> }>;
	messages: {
		window_seconds: number;
		broadcasts_received: number;
		broadcasts_delivered: number;
		presence_diffs_delivered: number;
		peak_broadcasts_per_second: number;
	};
}

export interface RealtimeInspect {
	at: number;
	connections: number;
	connected_users: number;
	limits: {
		max_events_per_second: number;
		max_concurrent_users: number;
		max_channels_per_client: number;
		max_joins_per_second: number;
	};
	channels: RealtimeChannel[];
}

export interface RealtimeEvent {
	at: number;
	kind: 'connect' | 'connect_refused' | 'join' | 'join_refused' | 'leave' | 'channel_closed' | 'disconnect';
	socket?: number;
	channel?: string;
	presence_key?: string;
	reason?: string;
}

export interface RealtimeAnswer {
	ref: string;
	state: string;
	inspect: RealtimeInspect;
	events: RealtimeEvent[];
	logCapacity: number | null;
	at: number;
}

/** A client this long without a frame is called out: twice the usual 25 second heartbeat,
 *  plus slack for a browser that slows timers in a hidden tab. */
const SILENT_MS = 60_000;

async function read(ref: string, options: { channel?: string; since?: number } = {}): Promise<RealtimeAnswer> {
	return api.call<RealtimeAnswer>('cloud-project-realtime', {
		ref,
		...(options.channel ? { channel: options.channel } : {}),
		...(options.since !== undefined ? { since: options.since } : {})
	});
}

/**
 * `--since` as a moment: `10m`, `2h`, `30s`, `1d`, or anything `Date.parse` reads.
 * Milliseconds since the epoch, which is what the server filters on.
 */
export function parseSince(text: string, now = Date.now()): number {
	const relative = /^(\d+)\s*(s|m|h|d)$/i.exec(text.trim());
	if (relative) {
		const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2]!.toLowerCase() as 's' | 'm' | 'h' | 'd'];
		return now - Number(relative[1]) * unit;
	}
	const absolute = Date.parse(text);
	if (Number.isFinite(absolute)) {
		return absolute;
	}
	throw new UsageError(`--since wants a duration like 10m, 2h or 1d, or a time like 2026-10-03T14:00, not "${text}"`);
}

function clock(ms: number): string {
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, '0');
	return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function ago(ms: number | null): string {
	if (ms === null) {
		return '-';
	}
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s ago`;
	}
	const minutes = Math.round(seconds / 60);
	return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

const KIND_WORDS: Record<RealtimeEvent['kind'], string> = {
	connect: 'connected',
	connect_refused: 'refused at connect',
	join: 'joined',
	join_refused: 'join refused',
	leave: 'left',
	channel_closed: 'channel closed by the server',
	disconnect: 'disconnected'
};

/** One event as a line a person reads. */
export function describeEvent(event: RealtimeEvent): string {
	const who = [
		event.presence_key ? event.presence_key : null,
		event.socket !== undefined ? `socket ${event.socket}` : null
	]
		.filter(Boolean)
		.join(', ');
	const parts = [clock(event.at), KIND_WORDS[event.kind] ?? event.kind];
	if (event.channel) {
		parts.push(event.channel);
	}
	if (who) {
		parts.push(`(${who})`);
	}
	return event.reason ? `${parts.join('  ')}: ${event.reason}` : parts.join('  ');
}

function describeMeta(meta: Record<string, unknown>): string {
	const shown = Object.fromEntries(Object.entries(meta).filter(([key]) => !key.startsWith('phx_ref')));
	return JSON.stringify(shown);
}

function printSnapshot(answer: RealtimeAnswer): void {
	const snap = answer.inspect;
	say(bold(`Realtime for ${answer.ref}`));
	say(
		`${snap.connections} connection${snap.connections === 1 ? '' : 's'}, ${snap.connected_users} on a channel. The project's limit is ${snap.limits.max_events_per_second} messages a second, counted once per message sent, however many receive it.`
	);
	if (snap.channels.length === 0) {
		say('No channels are open.');
		return;
	}
	for (const channel of snap.channels) {
		const m = channel.messages;
		say('');
		say(
			bold(`${channel.name}${channel.private ? ' (private)' : ''}`) +
				`  ${channel.clients.length} client${channel.clients.length === 1 ? '' : 's'}`
		);
		say(
			dim(
				`  last ${m.window_seconds}s: ${m.broadcasts_received} broadcast${m.broadcasts_received === 1 ? '' : 's'} sent, ${m.broadcasts_delivered} delivered, busiest second ${m.peak_broadcasts_per_second}; ${m.presence_diffs_delivered} presence update${m.presence_diffs_delivered === 1 ? '' : 's'} delivered`
			)
		);
		if (channel.clients.length > 0) {
			const rows = channel.clients.map((client) => [
				String(client.socket),
				client.presence_key,
				ago(Date.now() - client.joined_at),
				ago(client.last_seen_ms_ago) +
					(client.last_seen_ms_ago !== null && client.last_seen_ms_ago > SILENT_MS ? '  (silent: likely gone)' : '')
			]);
			say(
				table([['SOCKET', 'PRESENCE KEY', 'JOINED', 'LAST HEARD'], ...rows])
					.split('\n')
					.map((line) => `  ${line}`)
					.join('\n')
			);
		}
		const keys = Object.keys(channel.presence);
		if (keys.length > 0) {
			say('  presence:');
			for (const key of keys) {
				for (const meta of channel.presence[key]!.metas) {
					say(`    ${key}  ${describeMeta(meta)}`);
				}
			}
		}
	}
}

export async function inspect(
	ref: string,
	options: { channel?: string; watch?: boolean; intervalMs?: number } = {}
): Promise<number> {
	if (options.watch && isJsonMode()) {
		// One JSON value on stdout is the contract, and a watch never ends. An agent polls
		// `realtime inspect --json` and `realtime logs --since` instead.
		throw new UsageError('--watch is for a person; with --json, poll `realtime inspect --json` or `realtime logs --since 1m --json`');
	}
	const first = await read(ref, { channel: options.channel });
	emit(first.inspect, () => printSnapshot(first));
	if (!options.watch) {
		return 0;
	}
	say('');
	say(dim('Watching. New events appear below as they happen; Ctrl+C to stop.'));
	let since = first.at + 1;
	const interval = options.intervalMs ?? 2_000;
	for (;;) {
		await new Promise((resolve) => setTimeout(resolve, interval));
		const next = await read(ref, { channel: options.channel, since });
		for (const event of next.events) {
			process.stdout.write(`${describeEvent(event)}\n`);
		}
		if (next.events.length > 0) {
			since = Math.max(...next.events.map((event) => event.at)) + 1;
			const counts = next.inspect.channels
				.map((channel) => `${channel.name}: ${Object.keys(channel.presence).join(', ') || 'nobody tracked'}`)
				.join('; ');
			process.stdout.write(dim(`  now ${counts || 'no channels open'}\n`));
		}
	}
}

export async function logs(ref: string, options: { channel?: string; since?: string } = {}): Promise<number> {
	const since = options.since ? parseSince(options.since) : 0;
	const answer = await read(ref, { channel: options.channel, since });
	emit({ ref: answer.ref, events: answer.events, capacity: answer.logCapacity }, () => {
		if (answer.events.length === 0) {
			say(
				options.since || options.channel
					? 'Nothing in the log for that.'
					: 'Nothing in the log yet. It fills as clients connect, and starts again when the project\'s host restarts.'
			);
			return;
		}
		for (const event of answer.events) {
			process.stdout.write(`${describeEvent(event)}\n`);
		}
		if (answer.logCapacity !== null && answer.events.length >= answer.logCapacity) {
			say(dim(`The log keeps the newest ${answer.logCapacity} events; older ones have gone.`));
		}
	});
	return 0;
}
