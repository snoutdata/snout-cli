/**
 * Saying things, in two registers.
 *
 * `--json` is not a formatting preference, it is a contract: exactly one JSON value on
 * stdout and nothing else, ever, so a script can pipe it into `jq` without filtering.
 * Everything a person would want to read — progress, warnings, "waiting for the project
 * to start" — goes to stderr, where it does not corrupt that.
 *
 * The human register is deliberately plain. No colour codes unless the terminal is one
 * (a CI log full of escape sequences is worse than no colour), no spinners, no boxes.
 */

let jsonMode = false;
let quiet = false;

export function setJsonMode(on: boolean): void {
	jsonMode = on;
}

/** `--quiet`: commentary off. The answer and every failure still come out. */
export function setQuiet(on: boolean): void {
	quiet = on;
}

export function isJsonMode(): boolean {
	return jsonMode;
}

const colour = process.stdout.isTTY && !process.env.NO_COLOR;

export function dim(text: string): string {
	return colour ? `\u001b[2m${text}\u001b[0m` : text;
}

export function bold(text: string): string {
	return colour ? `\u001b[1m${text}\u001b[0m` : text;
}

/** The answer. In JSON mode this is the only thing that reaches stdout. */
export function emit(value: unknown, human: () => void): void {
	if (jsonMode) {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
		return;
	}
	human();
}

/** Progress and commentary. Never stdout, never in JSON mode, never when quiet. */
export function say(message: string): void {
	if (!jsonMode && !quiet) {
		process.stderr.write(`${message}\n`);
	}
}

/**
 * A failure, in both registers at once.
 *
 * The sentence goes to stderr for a person (and is NOT suppressed by --quiet: something
 * that went wrong is not commentary). In JSON mode the machine-readable half goes to
 * stdout, which is the half that was missing: every failure used to leave stdout empty,
 * so a `jq` pipeline broke on exactly the runs worth understanding.
 *
 * On success stdout carries the value itself, unwrapped, as it always has. A failure is
 * the object below. So the test an agent makes is `.ok === false`, or simply the exit
 * code, which is never 0 when this is called.
 */
export function emitFailure(code: string, message: string, details?: Record<string, unknown>): void {
	process.stderr.write(`${message}\n`);
	if (jsonMode) {
		process.stdout.write(`${JSON.stringify({ ok: false, code, error: message, ...details }, null, 2)}\n`);
	}
}

export function warn(message: string): void {
	process.stderr.write(`${message}\n`);
}

/**
 * A table, sized to its content.
 *
 * Ten lines rather than a dependency, and it keeps the output stable: a column that
 * wraps differently between runs is a diff nobody wanted.
 */
export function table(rows: readonly (readonly string[])[]): string {
	if (rows.length === 0) {
		return '';
	}
	const widths = rows[0]!.map((_, column) =>
		Math.max(...rows.map((row) => (row[column] ?? '').length))
	);
	return rows
		.map((row) => row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd())
		.join('\n');
}

/**
 * A timestamp in words, forwards or backwards.
 *
 * The FUTURE half was missing, and it was not a cosmetic gap: an export's link expires in
 * hours, and `relative()` computed a negative age, fell through the `< 60` branch and said
 * **"that link stops working just now"** about a link that was good until the evening. A
 * time formatter that only understands the past will be handed a future date eventually,
 * and it will lie confidently rather than fail.
 */
export function relative(iso: string | null): string {
	if (!iso) {
		return 'never';
	}
	const delta = Math.round((Date.now() - Date.parse(iso)) / 1000);
	const ahead = delta < 0;
	const seconds = Math.abs(delta);
	if (seconds < 60) {
		return ahead ? 'in a moment' : 'just now';
	}
	const units: Array<[number, string]> = [
		[60, 'minute'],
		[60, 'hour'],
		[24, 'day'],
		[30, 'month']
	];
	let value = seconds;
	let name = 'second';
	for (const [size, unit] of units) {
		if (value < size) {
			break;
		}
		value = Math.round(value / size);
		name = unit;
	}
	const plural = `${value} ${name}${value === 1 ? '' : 's'}`;
	return ahead ? `in ${plural}` : `${plural} ago`;
}
