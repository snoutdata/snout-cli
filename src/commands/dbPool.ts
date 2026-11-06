/**
 * `snoutdata db pool [transaction|session]`: how a project's connections reach its database (364).
 * `cloud-project-pool` decides who may read and change it.
 */
import { call } from '../api.js';
import { emit, say } from '../output.js';
import { UsageError } from '../args.js';

interface ProjectPool {
	ref: string;
	mode: 'transaction' | 'session';
	cluster: boolean;
	outcome?: 'changed' | 'unchanged';
}

/** What this mode means, in a sentence. */
export function poolLine(pool: Pick<ProjectPool, 'ref' | 'mode'>): string {
	return pool.mode === 'transaction'
		? `${pool.ref}: transaction mode. Clients share the project's pool, and hold a database connection only during a transaction.`
		: `${pool.ref}: session mode. Each client has a database connection of its own for as long as it is connected.`;
}

/** The mode asked for, if any, or a usage error. */
export function parsePool(words: readonly string[]): 'transaction' | 'session' | undefined {
	const [mode, ...rest] = words;
	if (rest.length > 0 || (mode !== undefined && mode !== 'transaction' && mode !== 'session')) {
		throw new UsageError('db pool takes transaction or session, or nothing to read it');
	}
	return mode;
}

export async function poolCommand(ref: string, words: readonly string[]): Promise<void> {
	const mode = parsePool(words);
	const result = await call<ProjectPool>('cloud-project-pool', mode === undefined ? { ref } : { ref, mode });
	emit(result, () => say(poolLine(result)));
}
