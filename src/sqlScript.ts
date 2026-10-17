/**
 * A `.sql` file cut into the statements psql would have sent, one at a time.
 *
 * `db push` ran each migration through psql, which reads a script statement by statement and
 * sends each one on its own. Sending the whole file as one query would not be the same thing: a
 * multi-statement query runs as one implicit transaction, so `CREATE INDEX CONCURRENTLY` (the
 * reason `-- snoutdata:no-transaction` exists) would be refused, and a file's own `COMMIT` would
 * mean something else. So the file is cut where psql cuts it, by psql's rules (`psqlscan.l`):
 *
 *  - a `;` ends a statement only outside quotes, comments and parentheses;
 *  - `'...'` with `''` inside, `E'...'` with backslash escapes, `"..."` identifiers, `$tag$...$tag$`
 *    bodies, `--` comments to the end of the line, `/* ... *\/` comments that nest;
 *  - inside `CREATE [OR REPLACE] FUNCTION|PROCEDURE`, a `BEGIN` (`BEGIN ATOMIC`) and every `CASE`
 *    in it hold the `;` until their `END`, by psql's own heuristic;
 *  - `COPY ... FROM STDIN` reads the lines after it, up to a line that is `\.`, as its rows.
 *
 * Pure, and with no I/O, so all of it is tested without a database (`sqlScript.test.ts`).
 *
 * ## What psql did that this does not
 *
 * A backslash at the top level starts a psql meta-command (`\i`, `\set`, `\connect`, `\copy`).
 * Those are psql's, not Postgres's; there is no psql here to run them, and sending one to the
 * server would be a syntax error after the statements before it had run. So they are found here,
 * with their lines, and `db push` refuses the file before anything runs.
 */

export interface ScriptStatement {
	/** The statement's text, as it will be sent, with its `;`. */
	readonly sql: string;
	/** The line of the file it starts on, from 1. */
	readonly line: number;
	/** For `COPY ... FROM STDIN`: the rows the file carries after it, each ending in a newline. */
	readonly copyData?: string;
}

export interface MetaCommand {
	readonly line: number;
	/** The command as written, from its backslash to the end of its line. */
	readonly text: string;
}

export interface Script {
	readonly statements: ScriptStatement[];
	readonly metaCommands: MetaCommand[];
}

/** What may continue an identifier (and so cannot start a dollar quote after one). */
const IDENTIFIER_CONTINUE = /[A-Za-z0-9_$\u0080-￿]/;
const IDENTIFIER_START = /[A-Za-z_\u0080-￿]/;
/** A dollar quote's opening: `$$` or `$tag$`, the tag an identifier without a `$`. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/** Whether a statement is a COPY that reads from the script, judged as psql's user would read it. */
function isCopyFromStdin(sql: string): boolean {
	const text = stripComments(sql);
	return /^\s*copy\b/i.test(text) && /\bfrom\s+stdin\b/i.test(text);
}

/**
 * The word that ends the transaction it runs in, when a statement is one of those: COMMIT, END,
 * ROLLBACK (not ROLLBACK TO a savepoint), ABORT, or PREPARE TRANSACTION. Null for anything else.
 * A dollar-quoted body and BEGIN ATOMIC ... END are one statement each here, so a COMMIT inside a
 * procedure's body is not one of these.
 */
export function endsTransaction(sql: string): string | null {
	const text = stripComments(sql).trim();
	if (/^rollback\s+(?:(?:work|transaction)\s+)?to\b/i.test(text)) {
		return null;
	}
	const word = /^(commit|end|rollback|abort|prepare\s+transaction)\b/i.exec(text);
	return word ? word[1]!.toUpperCase().replace(/\s+/, ' ') : null;
}

/** `--` and `/* *\/` comments taken out, for looking at a statement's words. Not for sending. */
function stripComments(sql: string): string {
	return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function splitScript(text: string): Script {
	const statements: ScriptStatement[] = [];
	const metaCommands: MetaCommand[] = [];
	const length = text.length;
	let i = 0;
	let line = 1;

	// The statement being read.
	let start = -1;
	let startLine = 1;
	let parenDepth = 0;
	let beginDepth = 0;
	// The first letters of `create`, `or`, `replace`, `function`, `procedure` at the statement's
	// first four identifiers, as psql keeps them; anything else is a blank.
	let identifiers: string[] = [];
	let identifierCount = 0;

	const begin = () => {
		if (start < 0) {
			start = i;
			startLine = line;
		}
	};
	const reset = () => {
		start = -1;
		parenDepth = 0;
		beginDepth = 0;
		identifiers = [];
		identifierCount = 0;
	};
	/** Move past `count` characters, counting the newlines among them. */
	const advance = (count: number) => {
		const end = Math.min(length, i + count);
		for (let at = i; at < end; at++) {
			if (text.charCodeAt(at) === 10) {
				line++;
			}
		}
		i = end;
	};
	/** Move to just past `index` (or the end, when it is -1). */
	const advanceTo = (index: number) => advance(index < 0 ? length - i : index - i);
	// A COPY's rows: skipped over when the reading reaches them, since they are not SQL.
	let rows = null as { from: number; to: number; line: number } | null;
	const end = () => {
		const sql = start >= 0 ? text.slice(start, i).trim() : '';
		// Only a `;`, or comments: psql's buffer would be empty, and it sends nothing.
		if (stripComments(sql).replace(/;/g, '').trim() !== '') {
			if (!isCopyFromStdin(sql)) {
				statements.push({ sql, line: startLine });
			} else {
				// psql reads the rows from the lines AFTER the one the statement ended on, up to `\.`;
				// what follows the `;` on its own line is still SQL.
				const lineEnd = text.indexOf('\n', i);
				const data: string[] = [];
				if (lineEnd >= 0) {
					let at = lineEnd + 1;
					let after = line + 1;
					while (at < length) {
						const next = text.indexOf('\n', at);
						const row = text.slice(at, next < 0 ? length : next).replace(/\r$/, '');
						at = next < 0 ? length : next + 1;
						after++;
						if (row === '\\.') {
							break;
						}
						data.push(`${row}\n`);
					}
					rows = { from: lineEnd + 1, to: at, line: after };
				}
				statements.push({ sql, line: startLine, copyData: data.join('') });
			}
		}
		reset();
	};

	while (i < length) {
		if (rows && i >= rows.from) {
			i = rows.to;
			line = rows.line;
			rows = null;
			continue;
		}
		const char = text[i]!;
		const next = text[i + 1];

		if (char === '\n' || char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v') {
			advance(1);
			continue;
		}
		if (char === '-' && next === '-') {
			advanceTo(text.indexOf('\n', i));
			continue;
		}
		if (char === '/' && next === '*') {
			begin();
			let depth = 0;
			while (i < length) {
				if (text[i] === '/' && text[i + 1] === '*') {
					depth++;
					advance(2);
				} else if (text[i] === '*' && text[i + 1] === '/') {
					depth--;
					advance(2);
					if (depth === 0) {
						break;
					}
				} else {
					advance(1);
				}
			}
			continue;
		}
		if (char === "'") {
			begin();
			readString(false);
			continue;
		}
		if (char === '"') {
			begin();
			advance(1);
			for (;;) {
				const close = text.indexOf('"', i);
				if (close < 0) {
					advanceTo(-1);
					break;
				}
				advanceTo(close + 1);
				if (text[i] === '"') {
					advance(1);
					continue;
				}
				break;
			}
			continue;
		}
		if (char === '$') {
			begin();
			const tag = DOLLAR_TAG.exec(text.slice(i, i + 64))?.[0];
			if (tag) {
				advance(tag.length);
				const close = text.indexOf(tag, i);
				advanceTo(close < 0 ? -1 : close + tag.length);
			} else {
				// `$1`, a parameter: not a quote.
				advance(1);
			}
			continue;
		}
		if (char === '\\') {
			// A psql meta-command runs to the end of its line.
			const lineEnd = text.indexOf('\n', i);
			metaCommands.push({ line, text: text.slice(i, lineEnd < 0 ? length : lineEnd).replace(/\r$/, '').trimEnd() });
			advanceTo(lineEnd);
			continue;
		}
		if (char === '(') {
			begin();
			parenDepth++;
			advance(1);
			continue;
		}
		if (char === ')') {
			begin();
			if (parenDepth > 0) {
				parenDepth--;
			}
			advance(1);
			continue;
		}
		if (char === ';') {
			begin();
			advance(1);
			if (parenDepth === 0 && beginDepth === 0) {
				end();
			}
			continue;
		}
		if (IDENTIFIER_START.test(char)) {
			begin();
			let stop = i + 1;
			while (stop < length && IDENTIFIER_CONTINUE.test(text[stop]!)) {
				stop++;
			}
			const word = text.slice(i, stop);
			advance(stop - i);
			if (text[i] === "'") {
				// E'...' takes backslash escapes; N'', B'', X'', U&'' and a typed literal do not.
				readString(word === 'e' || word === 'E');
				continue;
			}
			identifier(word.toLowerCase());
			continue;
		}
		if (char >= '0' && char <= '9') {
			begin();
			let stop = i + 1;
			while (stop < length && /[0-9A-Za-z_.]/.test(text[stop]!)) {
				stop++;
			}
			advance(stop - i);
			continue;
		}
		begin();
		advance(1);
	}
	// What is left at the end with no `;` is sent as it is, as psql sends it.
	end();
	return { statements, metaCommands };

	/** A quoted string from its opening quote; `escapes` for E'', where a backslash escapes. */
	function readString(escapes: boolean): void {
		advance(1);
		while (i < length) {
			const at = text[i];
			if (escapes && at === '\\') {
				advance(2);
				continue;
			}
			if (at === "'") {
				advance(1);
				if (text[i] === "'") {
					advance(1);
					continue;
				}
				return;
			}
			advance(1);
		}
	}

	/** psql's BEGIN ... END heuristic for `CREATE [OR REPLACE] FUNCTION|PROCEDURE` bodies. */
	function identifier(word: string): void {
		if (identifierCount < 4 && ['create', 'function', 'procedure', 'or', 'replace'].includes(word)) {
			identifiers[identifierCount] = word[0]!;
		}
		identifierCount++;
		const routine =
			identifiers[0] === 'c' &&
			(identifiers[1] === 'f' || identifiers[1] === 'p' || (identifiers[1] === 'o' && identifiers[2] === 'r' && (identifiers[3] === 'f' || identifiers[3] === 'p')));
		if (!routine || parenDepth !== 0) {
			return;
		}
		if (word === 'begin') {
			beginDepth++;
		} else if (word === 'case') {
			if (beginDepth >= 1) {
				beginDepth++;
			}
		} else if (word === 'end' && beginDepth > 0) {
			beginDepth--;
		}
	}
}
