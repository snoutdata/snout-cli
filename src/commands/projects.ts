/**
 * `snoutdata projects …` — the life of a project, from a terminal.
 *
 * Each of these is one call to the same Snout Function the dashboard will use. The only
 * thing the CLI adds is WAITING: a create returns the moment the row exists, because a
 * host makes it true a few seconds later, and a command that printed a connection string
 * before the database existed would be handing out a string that does not work yet.
 */

import * as api from '../api.js';
import { call, listProjects, waitForReady, waitForSettled, type Project } from '../api.js';
import { CliFailure } from '../failure.js';
import { writeLink } from '../config.js';
import { bold, dim, emit, relative, say, table } from '../output.js';

export async function list(): Promise<void> {
	const { projects, allowance } = await listProjects();
	emit({ projects, allowance }, () => {
		if (projects.length === 0) {
			say('No projects yet. `snoutdata projects create --name "my project"`.');
			return;
		}
		process.stdout.write(`${table(listRows(projects))}\n`);
	});
}

/**
 * The rows `projects list` prints, header first.
 *
 * POSTGRES is left out altogether when no project carries a version, which is what an older
 * control plane answers: a column of dashes would say "unknown" about every project when the
 * truth is that nobody was asked.
 */
export function listRows(projects: readonly Project[]): string[][] {
	const versions = projects.some((p) => typeof p.postgresVersion === 'number');
	return [
		['REF', 'NAME', 'STATE', 'REGION', ...(versions ? ['POSTGRES'] : []), 'LAST CONNECTION'],
		...projects.map((p) => [
			p.ref,
			p.name,
			// A project that is ready and refusing writes is NOT "ready" as far as
			// somebody reading this is concerned: it is the state they need to know
			// about, and showing `ready` beside a database that rejects every INSERT
			// is the listing lying to them.
			p.readOnly ? bold('read-only') : p.state === 'ready' ? p.state : bold(p.state),
			p.region,
			...(versions ? [typeof p.postgresVersion === 'number' ? String(p.postgresVersion) : '-'] : []),
			relative(p.lastConnectionAt)
		])
	];
}

export async function create(options: {
	name: string;
	region?: string | undefined;
	wait: boolean;
	link?: string | undefined;
	/** A team id, already resolved and checked by `resolveTeam`. */
	teamId?: string | undefined;
	/** How long to wait for it to start, when waiting. Default five minutes. */
	timeoutMs?: number | undefined;
	/** Print the connection string, password and all. Off by default (see below). */
	showUrl?: boolean | undefined;
}): Promise<void> {
	const created = await call<{ project: Project; password: string }>('cloud-project-create', {
		name: options.name,
		region: options.region,
		teamId: options.teamId
	});
	const ref = created.project.ref;
	say(`Created ${ref}.`);

	let project = created.project;
	if (options.wait) {
		say('Waiting for it to start…');
		// A line when the state CHANGES, not one a poll: fourteen "creating" lines said nothing
		// the first one had not.
		let shown = '';
		project = await waitForReady(ref, {
			timeoutMs: options.timeoutMs,
			onTick: (state) => {
				if (state !== shown) {
					shown = state;
					say(dim(`  ${state}`));
				}
			}
		});
	}
	if (options.link) {
		writeLink(options.link, { ref, name: project.name });
	}

	// The connection string carries the password, so it is NOT printed by default. stdout is
	// what lands in an agent's transcript, a CI log and a terminal recording, and a create
	// printed `postgres://owner:PASSWORD@…` into all three until 0.10.2. The password is stored
	// for the owner either way: `snoutdata db url` prints it when it is actually wanted, and
	// `--show-url` restores the old output for a script that read it from here.
	const uri = `postgres://${project.user}:${encodeURIComponent(created.password)}@${project.host}:5432/${project.database}?sslmode=require`;
	emit(
		{
			project,
			ref,
			host: project.host,
			database: project.database,
			user: project.user,
			...(options.showUrl ? { password: created.password, uri } : { connectionString: 'snoutdata db url' })
		},
		() => {
			// The answer on stdout is the ref, which is what the next command needs.
			process.stdout.write(`${options.showUrl ? uri : ref}\n`);
			say('');
			say(`Ready. ${bold(ref)} in ${project.region}, at ${project.host}.`);
			say(
				options.showUrl
					? 'The password is stored for you: `snoutdata db url` prints this again.'
					: '`snoutdata db url` prints the connection string (it holds the password, so it is not shown here).'
			);
		}
	);
}

export async function action(
	verb: 'pause' | 'resume' | 'delete',
	ref: string,
	options: { wait?: boolean; timeoutMs?: number } = {}
): Promise<void> {
	const fn = `cloud-project-${verb}`;
	const result = await call<{ project: Project; changed: boolean }>(fn, { ref });
	const done = verb === 'delete' ? 'deleted' : `${verb}d`;
	if (options.wait === false) {
		emit({ ...result, settled: false }, () => say(`${ref}: asked to be ${done}. \`snoutdata projects list\` shows when it is.`));
		return;
	}
	// One line per state, as `create` does, so a wait is visibly a wait.
	let shown = result.project?.state ?? '';
	const project = await waitForSettled(ref, verb, {
		timeoutMs: options.timeoutMs,
		onTick: (state) => {
			if (state !== shown) {
				shown = state;
				say(dim(`  ${state}`));
			}
		}
	});
	const state = project?.state ?? 'deleted';
	if (state === 'error') {
		throw new CliFailure('failed', `${ref} went to error instead of ${done}${project?.stateDetail ? `: ${project.stateDetail}` : ''}.`, { ref, state });
	}
	emit({ ...result, ...(project ? { project } : {}), settled: true }, () => {
		say(result.changed ? `${ref}: ${done}.` : `${ref} was already ${done}.`);
	});
}

export async function resetPassword(ref: string): Promise<void> {
	const result = await call<{ ref: string; user: string; password: string; appliesIn: string }>(
		'cloud-project-reset-password',
		{ ref }
	);
	emit(result, () => {
		process.stdout.write(`${result.password}\n`);
		// The honest bit, and it is why this is not silent: the new password becomes true
		// when the host applies it, a few seconds from now (no restart since migration 120).
		say(`New password for ${result.user}. It applies ${result.appliesIn}.`);
	});
}

/**
 * `snoutdata teams` — the teams a project can be shared with.
 *
 * `mayShare` is shown rather than filtered out, and that is the design. A team you can see
 * but cannot share into is exactly the case somebody needs explaining: "your team is
 * missing" sends a person to look for a bug, while "SolarPanda — you are not currently a
 * member of this team" answers it.
 */
export async function listTeamsCommand(): Promise<void> {
	const { teams } = await api.listTeams();
	emit({ teams }, () => {
		if (teams.length === 0) {
			say('You are not on any teams.');
			return;
		}
		// `table()` does not end with a newline — every other caller adds one, and the
		// missing one here ran the next shell prompt into the last row.
		process.stdout.write(
			`${table([
				['NAME', 'ID', 'SHARE'],
				...teams.map((team) => [
					team.name,
					team.id,
					team.mayShare ? 'yes' : (team.why ?? 'no')
				])
			])}\n`
		);
	});
}

/**
 * Turn `--team <name or id>` into a team id, or explain why not.
 *
 * By NAME as well as by id, because a uuid is not something a person has to hand and
 * `--team platform` is what they would type. Ambiguity is refused rather than guessed:
 * two teams called the same thing is rare, and picking one of them silently would share a
 * database with the wrong company.
 */
export async function resolveTeam(wanted: string): Promise<string> {
	const { teams } = await api.listTeams();
	const byId = teams.find((team) => team.id === wanted);
	const matches = byId
		? [byId]
		: teams.filter((team) => team.name.toLowerCase() === wanted.toLowerCase());

	if (matches.length === 0) {
		throw new Error(
			teams.length === 0
				? `You are not on any teams, so there is no "${wanted}" to share with.`
				: `No team called "${wanted}". You are on: ${teams.map((t) => t.name).join(', ')}.`
		);
	}
	if (matches.length > 1) {
		throw new Error(
			`More than one team is called "${wanted}". Use the id: ${matches.map((t) => t.id).join(', ')}.`
		);
	}
	const team = matches[0]!;
	if (!team.mayShare) {
		// Refused HERE rather than by the server, so the message names the team and says
		// what is wrong with it. The server refuses this too, and must.
		throw new Error(`${team.name}: ${team.why ?? 'you cannot share a project into this team'}.`);
	}
	return team.id;
}
