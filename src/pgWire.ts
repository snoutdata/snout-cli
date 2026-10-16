/**
 * Enough of the Postgres wire protocol to run a migration, with nothing installed.
 *
 * `db push` used to hand its SQL to `psql`, so a machine without the Postgres client tools could
 * not run a migration at all (most Windows machines, most CI images, every agent sandbox). A
 * migration needs very little of a client: connect, prove the password, send statements one at a
 * time, stop at the first error. That is this file, on `node:net`, `node:tls` and `node:crypto`,
 * so the CLI stays one bundled file with no dependencies (build.mjs, deploy/audit.sh).
 *
 * ## What it speaks
 *
 * Protocol 3.0, the simple query protocol only (`Q`), which is what psql uses for a script and
 * what lets a statement be anything the server takes, DDL included. Authentication: SCRAM-SHA-256
 * (what every SnoutData project uses), and cleartext and MD5 for a server configured that way, as
 * libpq would. `COPY ... FROM STDIN` is fed the rows the script carries, as psql does; a `COPY ...
 * TO STDOUT` is read and dropped, since nothing here prints rows.
 *
 * ## TLS, as libpq does it
 *
 * The same modes, from the same place (`pgTls.ts`'s `cloudSsl`): `verify-full` for a hosted
 * project (the chain reaches a trusted root and the name matches; `PGSSLROOTCERT` when set, else
 * Node's roots), `disable` for a local pod on the loopback, and the `SNOUTDATA_DB_SSLMODE` opt-out.
 * The server's one-byte answer to the SSL request must arrive alone: a byte after it, before the
 * handshake, is somebody on the path speaking first (CVE-2021-23214), and the connection is closed.
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { cloudSsl } from './pgTls.js';

/** Where to connect and as whom: the subset of `api.ts`'s `Connection` a session needs. */
export interface PgTarget {
	readonly host: string;
	readonly port: number;
	readonly database: string;
	readonly user: string;
	readonly password: string;
	/** The control plane's `ssl` value (`require` for a hosted project, `disable` for a local one). */
	readonly ssl: string;
}

export interface PgOpenOptions {
	readonly env?: NodeJS.ProcessEnv;
	readonly home?: string;
	/** How long connecting and signing in may take. A paused project wakes inside this. */
	readonly connectTimeoutMs?: number;
}

/** What the server said when it refused something, with the fields psql shows. */
export class PgServerError extends Error {
	readonly severity: string;
	readonly code: string;
	readonly detail?: string;
	readonly hint?: string;
	/** 1-based character position in the statement, when the server named one. */
	readonly position?: number;
	readonly where?: string;

	constructor(fields: Map<string, string>) {
		super(fields.get('M') ?? 'the server reported an error');
		this.name = 'PgServerError';
		this.severity = fields.get('V') ?? fields.get('S') ?? 'ERROR';
		this.code = fields.get('C') ?? '';
		const detail = fields.get('D');
		const hint = fields.get('H');
		const position = Number(fields.get('P'));
		const where = fields.get('W');
		if (detail) {
			this.detail = detail;
		}
		if (hint) {
			this.hint = hint;
		}
		if (Number.isInteger(position) && position > 0) {
			this.position = position;
		}
		if (where) {
			this.where = where;
		}
	}
}

/** The connection did not get as far as running anything. */
export class PgConnectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PgConnectError';
	}
}

/** One message from the server: its type byte and its body. */
interface Message {
	readonly type: string;
	readonly body: Buffer;
}

/** What a statement returned: the rows of its last result, as text, and the command tag. */
export interface PgResult {
	readonly rows: (string | null)[][];
	readonly command: string | null;
}

const PROTOCOL_3 = 196608;
const SSL_REQUEST = 80877103;

function frame(type: string, body: Buffer): Buffer {
	const head = Buffer.alloc(5);
	head.write(type, 0, 'latin1');
	head.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([head, body]);
}

function cstring(value: string): Buffer {
	return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

/** The NUL-terminated strings in a body, from `offset`. */
function cstrings(body: Buffer, offset = 0): string[] {
	const out: string[] = [];
	let at = offset;
	while (at < body.length) {
		const end = body.indexOf(0, at);
		if (end < 0 || end === at) {
			break;
		}
		out.push(body.toString('utf8', at, end));
		at = end + 1;
	}
	return out;
}

/** An ErrorResponse or NoticeResponse body as its fields. */
function fieldsOf(body: Buffer): Map<string, string> {
	const fields = new Map<string, string>();
	let at = 0;
	while (at < body.length && body[at] !== 0) {
		const code = String.fromCharCode(body[at]!);
		const end = body.indexOf(0, at + 1);
		if (end < 0) {
			break;
		}
		fields.set(code, body.toString('utf8', at + 1, end));
		at = end + 1;
	}
	return fields;
}

/**
 * The SCRAM-SHA-256 client (RFC 5802, RFC 7677), without channel binding: what libpq sends with
 * `channel_binding=disable`. The server's signature is checked, so a server that does not know the
 * password cannot pass as one that does.
 */
export class Scram {
	private readonly nonce: string;
	private readonly firstBare: string;
	private serverSignature: Buffer | null = null;

	constructor(private readonly password: string, nonce = randomBytes(18).toString('base64')) {
		this.nonce = nonce;
		// Postgres takes the user from the startup message and ignores this one, as libpq leaves it.
		this.firstBare = `n=,r=${this.nonce}`;
	}

	/** The client-first message, with its GS2 header: no channel binding. */
	first(): string {
		return `n,,${this.firstBare}`;
	}

	/** The client-final message for the server-first one. */
	final(serverFirst: string): string {
		const parts = new Map(serverFirst.split(',').map((part) => [part.slice(0, 1), part.slice(2)] as const));
		const nonce = parts.get('r');
		const salt = parts.get('s');
		const iterations = Number(parts.get('i'));
		if (!nonce || !nonce.startsWith(this.nonce) || nonce.length <= this.nonce.length) {
			throw new PgConnectError('the server answered the password exchange with a nonce that is not ours');
		}
		if (!salt || !Number.isInteger(iterations) || iterations < 1) {
			throw new PgConnectError('the server answered the password exchange with no salt or iteration count');
		}
		const salted = pbkdf2Sync(this.password.normalize('NFKC'), Buffer.from(salt, 'base64'), iterations, 32, 'sha256');
		const clientKey = createHmac('sha256', salted).update('Client Key').digest();
		const storedKey = createHash('sha256').update(clientKey).digest();
		const withoutProof = `c=biws,r=${nonce}`;
		const authMessage = `${this.firstBare},${serverFirst},${withoutProof}`;
		const clientSignature = createHmac('sha256', storedKey).update(authMessage).digest();
		const proof = Buffer.alloc(clientKey.length);
		for (let i = 0; i < proof.length; i++) {
			proof[i] = clientKey[i]! ^ clientSignature[i]!;
		}
		const serverKey = createHmac('sha256', salted).update('Server Key').digest();
		this.serverSignature = createHmac('sha256', serverKey).update(authMessage).digest();
		return `${withoutProof},p=${proof.toString('base64')}`;
	}

	/** Throws unless the server-final message proves the server knows the password. */
	verify(serverFinal: string): void {
		const error = /(?:^|,)e=([^,]*)/.exec(serverFinal);
		if (error) {
			throw new PgConnectError(`the server refused the password exchange: ${error[1]}`);
		}
		const signature = /(?:^|,)v=([^,]*)/.exec(serverFinal);
		const theirs = signature ? Buffer.from(signature[1]!, 'base64') : Buffer.alloc(0);
		if (!this.serverSignature || theirs.length !== this.serverSignature.length || !timingSafeEqual(theirs, this.serverSignature)) {
			throw new PgConnectError('the server could not prove it knows the password, so this is not the database it claims to be');
		}
	}
}

/** Reads whole messages off a socket, in order. */
class Reader {
	private buffer: Buffer = Buffer.alloc(0);
	private readonly queue: Message[] = [];
	private waiting: { resolve: (message: Message) => void; reject: (error: Error) => void } | null = null;
	private failure: Error | null = null;

	constructor(socket: Socket) {
		socket.on('data', (chunk: Buffer) => this.take(chunk));
		socket.on('error', (error) => this.fail(new PgConnectError(error.message)));
		socket.on('close', () => this.fail(new PgConnectError('the server closed the connection')));
	}

	private take(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 5) {
			const length = this.buffer.readInt32BE(1);
			if (length < 4) {
				this.fail(new PgConnectError('the server sent a message this client cannot read'));
				return;
			}
			if (this.buffer.length < length + 1) {
				break;
			}
			const message = { type: String.fromCharCode(this.buffer[0]!), body: this.buffer.subarray(5, length + 1) };
			this.buffer = this.buffer.subarray(length + 1);
			if (this.waiting) {
				const { resolve } = this.waiting;
				this.waiting = null;
				resolve(message);
			} else {
				this.queue.push(message);
			}
		}
	}

	private fail(error: Error): void {
		if (this.failure) {
			return;
		}
		this.failure = error;
		if (this.waiting) {
			const { reject } = this.waiting;
			this.waiting = null;
			reject(error);
		}
	}

	next(): Promise<Message> {
		const ready = this.queue.shift();
		if (ready) {
			return Promise.resolve(ready);
		}
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		return new Promise((resolve, reject) => {
			this.waiting = { resolve, reject };
		});
	}
}

/** The bytes after an `S` that answered the SSL request, which there must not be. */
function sslAnswer(socket: Socket): Promise<string> {
	return new Promise((resolve, reject) => {
		const onData = (chunk: Buffer) => {
			cleanup();
			if (chunk.length !== 1) {
				reject(new PgConnectError('the server sent more than its answer to the TLS request, so the connection was closed'));
				return;
			}
			resolve(String.fromCharCode(chunk[0]!));
		};
		const onError = (error: Error) => {
			cleanup();
			reject(new PgConnectError(error.message));
		};
		const onClose = () => {
			cleanup();
			reject(new PgConnectError('the server closed the connection before TLS'));
		};
		const cleanup = () => {
			socket.off('data', onData);
			socket.off('error', onError);
			socket.off('close', onClose);
		};
		socket.on('data', onData);
		socket.on('error', onError);
		socket.on('close', onClose);
	});
}

function plainSocket(host: string, port: number): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host, port });
		const onError = (error: Error) => reject(new PgConnectError(`could not connect to ${host}:${port}: ${error.message}`));
		socket.once('connect', () => {
			socket.off('error', onError);
			resolve(socket);
		});
		socket.once('error', onError);
	});
}

/** The connection, encrypted as `mode` asks: libpq's sslmode names and meanings. */
async function secured(target: PgTarget, mode: string, rootCert: string | undefined, track: (socket: Socket) => void): Promise<Socket> {
	const socket = await plainSocket(target.host, target.port);
	// Handed back at once, so a failure or a timeout from here on can close it.
	track(socket);
	if (mode === 'disable') {
		return socket;
	}
	const request = Buffer.alloc(8);
	request.writeInt32BE(8, 0);
	request.writeInt32BE(SSL_REQUEST, 4);
	socket.write(request);
	const answer = await sslAnswer(socket);
	if (answer !== 'S') {
		if (mode === 'allow' || mode === 'prefer') {
			return socket;
		}
		throw new PgConnectError(`${target.host} does not accept TLS, and this connection requires it (sslmode ${mode})`);
	}
	const verify = mode === 'verify-ca' || mode === 'verify-full';
	return new Promise((resolve, reject) => {
		const secure = tlsConnect({
			socket,
			// The name the certificate is checked against. Without it Node checks "localhost",
			// and a certificate for localhost would pass for any address.
			host: target.host,
			...(isIP(target.host) === 0 ? { servername: target.host } : {}),
			rejectUnauthorized: verify,
			...(verify && rootCert ? { ca: readFileSync(rootCert, 'utf8') } : {}),
			// verify-ca checks the chain and not the name; verify-full checks both (Node's default).
			...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {})
		});
		track(secure);
		secure.once('secureConnect', () => {
			secure.off('error', onError);
			resolve(secure);
		});
		const onError = (error: Error) => reject(new PgConnectError(`TLS to ${target.host} failed: ${error.message}`));
		secure.once('error', onError);
	});
}

/** One connection to one database, signed in, ready for statements. */
export class PgSession {
	private constructor(
		private readonly socket: Socket,
		private readonly reader: Reader
	) {}

	/** Connect, encrypt, sign in, and wait for the server to be ready for a statement. */
	static async open(target: PgTarget, options: PgOpenOptions = {}): Promise<PgSession> {
		const env = options.env ?? process.env;
		const ssl = cloudSsl(target.ssl, env, options.home ?? homedir());
		// libpq reads PGSSLROOTCERT itself, so the opt-out (which names a mode and no file) still
		// honours one; and like libpq, `require` with a root file checks the chain (verify-ca).
		const rootCert = ssl.rootCert ?? (env.PGSSLROOTCERT || undefined);
		const mode = ssl.mode === 'require' && rootCert ? 'verify-ca' : ssl.mode;
		const timeoutMs = options.connectTimeoutMs ?? 120_000;
		// Every socket opened on the way, so whatever fails (or runs out of time) closes them all.
		const opened: Socket[] = [];
		const closeAll = () => {
			for (const one of opened) {
				one.destroy();
			}
		};
		let timer: NodeJS.Timeout | undefined;
		const timedOut = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				closeAll();
				reject(new PgConnectError(`${target.host}:${target.port} did not answer within ${Math.round(timeoutMs / 1000)} seconds`));
			}, timeoutMs);
		});
		try {
			return await Promise.race([
				(async () => {
					const socket = await secured(target, mode, rootCert, (one) => opened.push(one));
					const session = new PgSession(socket, new Reader(socket));
					await session.startup(target);
					return session;
				})(),
				timedOut
			]);
		} catch (error) {
			closeAll();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}

	private send(type: string, body: Buffer): void {
		this.socket.write(frame(type, body));
	}

	private async startup(target: PgTarget): Promise<void> {
		const parameters = Buffer.concat([
			...[
				['user', target.user],
				['database', target.database],
				['application_name', 'snoutdata'],
				['client_encoding', 'UTF8']
			].flatMap(([key, value]) => [cstring(key!), cstring(value!)]),
			Buffer.from([0])
		]);
		const head = Buffer.alloc(8);
		head.writeInt32BE(parameters.length + 8, 0);
		head.writeInt32BE(PROTOCOL_3, 4);
		this.socket.write(Buffer.concat([head, parameters]));

		let scram: Scram | null = null;
		for (;;) {
			const message = await this.reader.next();
			switch (message.type) {
				case 'R': {
					const code = message.body.readInt32BE(0);
					if (code === 0) {
						break;
					}
					if (code === 3) {
						this.send('p', cstring(target.password));
					} else if (code === 5) {
						const inner = createHash('md5').update(target.password + target.user).digest('hex');
						const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner), message.body.subarray(4, 8)])).digest('hex');
						this.send('p', cstring(`md5${outer}`));
					} else if (code === 10) {
						const mechanisms = cstrings(message.body, 4);
						if (!mechanisms.includes('SCRAM-SHA-256')) {
							throw new PgConnectError(`the server asked for ${mechanisms.join(', ') || 'a password exchange'}, which this client does not speak`);
						}
						scram = new Scram(target.password);
						const first = Buffer.from(scram.first(), 'utf8');
						const length = Buffer.alloc(4);
						length.writeInt32BE(first.length, 0);
						this.send('p', Buffer.concat([cstring('SCRAM-SHA-256'), length, first]));
					} else if (code === 11 && scram) {
						this.send('p', Buffer.from(scram.final(message.body.toString('utf8', 4)), 'utf8'));
					} else if (code === 12 && scram) {
						scram.verify(message.body.toString('utf8', 4));
					} else {
						throw new PgConnectError(`the server asked for an authentication method (${code}) this client does not speak`);
					}
					break;
				}
				case 'E':
					throw new PgServerError(fieldsOf(message.body));
				case 'Z':
					return;
				default:
					// ParameterStatus, BackendKeyData, NoticeResponse: nothing a migration needs.
					break;
			}
		}
	}

	/**
	 * Run one statement (the simple query protocol), and give back the rows of its last result.
	 * `copyData` is what a `COPY ... FROM STDIN` reads; without it such a COPY is refused, as the
	 * server would be told by psql reaching the end of its input.
	 */
	async query(sql: string, copyData?: string): Promise<PgResult> {
		this.send('Q', cstring(sql));
		let rows: (string | null)[][] = [];
		let command: string | null = null;
		let failure: PgServerError | null = null;
		for (;;) {
			const message = await this.reader.next();
			switch (message.type) {
				case 'T':
					rows = [];
					break;
				case 'D': {
					const count = message.body.readInt16BE(0);
					const row: (string | null)[] = [];
					let at = 2;
					for (let i = 0; i < count; i++) {
						const length = message.body.readInt32BE(at);
						at += 4;
						if (length < 0) {
							row.push(null);
						} else {
							row.push(message.body.toString('utf8', at, at + length));
							at += length;
						}
					}
					rows.push(row);
					break;
				}
				case 'C':
					command = message.body.toString('utf8', 0, Math.max(0, message.body.indexOf(0)));
					break;
				case 'E':
					failure ??= new PgServerError(fieldsOf(message.body));
					break;
				case 'G':
					if (copyData === undefined) {
						this.send('f', cstring('db push has no rows for this COPY: the lines after it, ending in \\., are what it reads'));
					} else {
						if (copyData.length > 0) {
							this.send('d', Buffer.from(copyData, 'utf8'));
						}
						this.send('c', Buffer.alloc(0));
					}
					break;
				case 'W':
					this.send('f', cstring('COPY BOTH is not something a migration can do'));
					break;
				case 'Z':
					if (failure) {
						throw failure;
					}
					return { rows, command };
				default:
					// NoticeResponse, ParameterStatus, CopyOutResponse and its CopyData/CopyDone,
					// EmptyQueryResponse, NotificationResponse: read and let go.
					break;
			}
		}
	}

	/** Say goodbye and close. Anything not committed is rolled back by the server. */
	close(): void {
		if (!this.socket.destroyed) {
			this.socket.end(frame('X', Buffer.alloc(0)));
		}
	}
}

/** An error as psql prints it: the message, the line it points at, then detail, hint, context. */
export function describePgError(error: PgServerError, statement: string, firstLine = 1): string {
	const lines = [`${error.severity}:  ${error.message}`];
	if (error.position !== undefined) {
		// The position counts characters, not UTF-16 units.
		const before = [...statement].slice(0, error.position - 1);
		const lineIndex = before.filter((char) => char === '\n').length;
		const text = statement.split('\n')[lineIndex] ?? '';
		const column = before.length - (before.lastIndexOf('\n') + 1);
		const label = `LINE ${firstLine + lineIndex}: `;
		lines.push(`${label}${text.replace(/\r$/, '')}`, `${' '.repeat(label.length + column)}^`);
	}
	if (error.detail) {
		lines.push(`DETAIL:  ${error.detail}`);
	}
	if (error.hint) {
		lines.push(`HINT:  ${error.hint}`);
	}
	if (error.where) {
		lines.push(`CONTEXT:  ${error.where}`);
	}
	return lines.join('\n');
}
