import { strict as assert } from 'node:assert';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { after, test } from 'node:test';
import { describePgError, PgConnectError, PgServerError, PgSession, Scram, type PgTarget } from './pgWire.js';

// ---------------------------------------------------------------------------
// A Postgres that speaks just enough: SCRAM-SHA-256 for one password, then the simple query
// protocol, answered by a function the test gives it.
// ---------------------------------------------------------------------------

const PASSWORD = 'correct horse';
const SALT = randomBytes(16);
const ITERATIONS = 4096;

function frame(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
	const head = Buffer.alloc(5);
	head.write(type, 0, 'latin1');
	head.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([head, body]);
}

function int32(value: number): Buffer {
	const out = Buffer.alloc(4);
	out.writeInt32BE(value, 0);
	return out;
}

function error(fields: Record<string, string>): Buffer {
	return frame('E', Buffer.concat([...Object.entries(fields).map(([key, value]) => Buffer.from(`${key}${value}\0`)), Buffer.from([0])]));
}

const READY = frame('Z', Buffer.from('I'));

type Answer = (sql: string, session: { copied: string[] }) => Buffer[];

interface Fake {
	readonly target: PgTarget;
	readonly queries: string[];
	readonly copied: string[];
	/** What the client sent as its startup parameters. */
	readonly startup: Record<string, string>[];
}

const servers: Server[] = [];
const accepted: Socket[] = [];
after(() => {
	for (const socket of accepted) {
		socket.destroy();
	}
	for (const server of servers) {
		server.close();
	}
});

async function fakePostgres(answer: Answer, options: { password?: string; forgeSignature?: boolean; sslAnswer?: Buffer } = {}): Promise<Fake> {
	const queries: string[] = [];
	const copied: string[] = [];
	const startup: Record<string, string>[] = [];
	const password = options.password ?? PASSWORD;
	const server = createServer((socket: Socket) => {
		accepted.push(socket);
		let buffer = Buffer.alloc(0);
		let started = false;
		let scram: { clientFirstBare: string; serverFirst: string; nonce: string } | null = null;
		let copying: string[] | null = null;
		socket.on('error', () => {});
		socket.on('data', (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			for (;;) {
				if (!started) {
					if (buffer.length < 8) {
						return;
					}
					const length = buffer.readInt32BE(0);
					if (buffer.length < length) {
						return;
					}
					const code = buffer.readInt32BE(4);
					const body = buffer.subarray(8, length);
					buffer = buffer.subarray(length);
					if (code === 80877103) {
						socket.write(options.sslAnswer ?? Buffer.from('N'));
						continue;
					}
					started = true;
					const parts = body.toString('utf8').split('\0');
					const params: Record<string, string> = {};
					for (let i = 0; i + 1 < parts.length; i += 2) {
						if (parts[i]) {
							params[parts[i]!] = parts[i + 1]!;
						}
					}
					startup.push(params);
					socket.write(frame('R', Buffer.concat([int32(10), Buffer.from('SCRAM-SHA-256\0\0')])));
					continue;
				}
				if (buffer.length < 5) {
					return;
				}
				const type = String.fromCharCode(buffer[0]!);
				const length = buffer.readInt32BE(1);
				if (buffer.length < length + 1) {
					return;
				}
				const body = buffer.subarray(5, length + 1);
				buffer = buffer.subarray(length + 1);
				if (type === 'p' && !scram) {
					const mechanismEnd = body.indexOf(0);
					const data = body.subarray(mechanismEnd + 5).toString('utf8');
					const clientFirstBare = data.slice(3);
					const clientNonce = /r=([^,]*)/.exec(clientFirstBare)![1]!;
					const nonce = clientNonce + randomBytes(12).toString('base64');
					const serverFirst = `r=${nonce},s=${SALT.toString('base64')},i=${ITERATIONS}`;
					scram = { clientFirstBare, serverFirst, nonce };
					socket.write(frame('R', Buffer.concat([int32(11), Buffer.from(serverFirst)])));
				} else if (type === 'p' && scram) {
					const final = body.toString('utf8');
					const withoutProof = final.slice(0, final.indexOf(',p='));
					const proof = Buffer.from(final.slice(final.indexOf(',p=') + 3), 'base64');
					const salted = pbkdf2Sync(password, SALT, ITERATIONS, 32, 'sha256');
					const clientKey = createHmac('sha256', salted).update('Client Key').digest();
					const storedKey = createHash('sha256').update(clientKey).digest();
					const authMessage = `${scram.clientFirstBare},${scram.serverFirst},${withoutProof}`;
					const signature = createHmac('sha256', storedKey).update(authMessage).digest();
					const recovered = Buffer.alloc(32);
					for (let i = 0; i < 32; i++) {
						recovered[i] = proof[i]! ^ signature[i]!;
					}
					if (!createHash('sha256').update(recovered).digest().equals(storedKey)) {
						socket.write(error({ S: 'FATAL', V: 'FATAL', C: '28P01', M: 'password authentication failed for user "owner"' }));
						socket.end();
						return;
					}
					const serverKey = createHmac('sha256', salted).update('Server Key').digest();
					const serverSignature = options.forgeSignature ? randomBytes(32) : createHmac('sha256', serverKey).update(authMessage).digest();
					socket.write(
						Buffer.concat([
							frame('R', Buffer.concat([int32(12), Buffer.from(`v=${serverSignature.toString('base64')}`)])),
							frame('R', int32(0)),
							frame('S', Buffer.from('server_version\x0017.6\0')),
							READY
						])
					);
				} else if (type === 'Q') {
					const sql = body.toString('utf8', 0, body.length - 1);
					queries.push(sql);
					const replies = answer(sql, { copied });
					if (replies.length === 1 && replies[0]!.toString('latin1', 0, 1) === 'G') {
						copying = [];
						socket.write(replies[0]!);
					} else {
						socket.write(Buffer.concat([...replies, READY]));
					}
				} else if (type === 'd' && copying) {
					copying.push(body.toString('utf8'));
				} else if (type === 'c' && copying) {
					copied.push(copying.join(''));
					copying = null;
					socket.write(Buffer.concat([frame('C', Buffer.from('COPY 2\0')), READY]));
				} else if (type === 'f' && copying) {
					copying = null;
					socket.write(Buffer.concat([error({ S: 'ERROR', V: 'ERROR', C: '57014', M: `COPY from stdin failed: ${body.toString('utf8', 0, body.length - 1)}` }), READY]));
				} else if (type === 'X') {
					socket.end();
				}
			}
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		target: { host: '127.0.0.1', port, database: 'db', user: 'owner', password: PASSWORD, ssl: 'disable' },
		queries,
		copied,
		startup
	};
}

function rows(columns: string[], values: (string | null)[][]): Buffer[] {
	const description = frame(
		'T',
		Buffer.concat([
			Buffer.from([0, columns.length]),
			...columns.map((name) => Buffer.concat([Buffer.from(`${name}\0`), Buffer.alloc(18)]))
		])
	);
	const data = values.map((row) =>
		frame(
			'D',
			Buffer.concat([
				Buffer.from([0, row.length]),
				...row.map((value) => (value === null ? int32(-1) : Buffer.concat([int32(Buffer.byteLength(value)), Buffer.from(value)])))
			])
		)
	);
	return [description, ...data, frame('C', Buffer.from(`SELECT ${values.length}\0`))];
}

test('it signs in with SCRAM, says who it is, and reads rows back as text', async () => {
	const fake = await fakePostgres((sql) => (sql.startsWith('select') ? rows(['name', 'checksum'], [['001-a.sql', 'abc'], ['002-b.sql', null]]) : []));
	const session = await PgSession.open(fake.target);
	const result = await session.query('select name, checksum from _snoutdata_migrations;');
	session.close();
	assert.deepEqual(result.rows, [['001-a.sql', 'abc'], ['002-b.sql', null]]);
	assert.equal(result.command, 'SELECT 2');
	assert.equal(fake.startup[0]!.user, 'owner');
	assert.equal(fake.startup[0]!.database, 'db');
	assert.equal(fake.startup[0]!.application_name, 'snoutdata');
});

test('a wrong password is the server’s refusal, in its own words', async () => {
	const fake = await fakePostgres(() => [], { password: 'something else' });
	await assert.rejects(PgSession.open(fake.target), (failure: unknown) => {
		assert.ok(failure instanceof PgServerError);
		assert.equal(failure.code, '28P01');
		return true;
	});
});

test('a server that cannot prove it knows the password is not trusted', async () => {
	const fake = await fakePostgres(() => [], { forgeSignature: true });
	await assert.rejects(PgSession.open(fake.target), (failure: unknown) => failure instanceof PgConnectError && /could not prove/.test(failure.message));
});

test('an error in a statement comes back with its position, and the session goes on', async () => {
	const fake = await fakePostgres((sql) =>
		sql.includes('nope') ? [error({ S: 'ERROR', V: 'ERROR', C: '42P01', M: 'relation "nope" does not exist', P: '15', H: 'Check the name.' })] : [frame('C', Buffer.from('SELECT 1\0'))]
	);
	const session = await PgSession.open(fake.target);
	await assert.rejects(session.query('select *\nfrom nope;'), (failure: unknown) => {
		assert.ok(failure instanceof PgServerError);
		assert.equal(failure.position, 15);
		assert.equal(
			describePgError(failure, 'select *\nfrom nope;', 7),
			['ERROR:  relation "nope" does not exist', 'LINE 8: from nope;', '             ^', 'HINT:  Check the name.'].join('\n')
		);
		return true;
	});
	assert.equal((await session.query('select 1;')).command, 'SELECT 1');
	session.close();
});

test('a COPY from stdin is fed its rows; without them it is refused, not hung', async () => {
	const fake = await fakePostgres((sql) => (sql.startsWith('copy') ? [frame('G', Buffer.from([0, 0, 0]))] : []));
	const session = await PgSession.open(fake.target);
	await session.query('copy t from stdin;', '1\tx\n2\ty\n');
	assert.deepEqual(fake.copied, ['1\tx\n2\ty\n']);
	await assert.rejects(session.query('copy t from stdin;'), (failure: unknown) => failure instanceof PgServerError && /COPY from stdin failed/.test(failure.message));
	session.close();
});

test('a connection that must be encrypted is refused by a server that will not encrypt', async () => {
	const fake = await fakePostgres(() => [], { sslAnswer: Buffer.from('N') });
	await assert.rejects(
		PgSession.open({ ...fake.target, ssl: 'require' }, { env: { SNOUTDATA_DB_SSLMODE: 'verify-full' }, home: '/nonexistent' }),
		(failure: unknown) => failure instanceof PgConnectError && /does not accept TLS/.test(failure.message)
	);
});

test('bytes after the server’s TLS answer, before the handshake, close the connection', async () => {
	const fake = await fakePostgres(() => [], { sslAnswer: Buffer.from('Sxx') });
	await assert.rejects(
		PgSession.open({ ...fake.target, ssl: 'require' }, { env: { SNOUTDATA_DB_SSLMODE: 'require' } }),
		(failure: unknown) => failure instanceof PgConnectError && /more than its answer/.test(failure.message)
	);
});

test('nobody answering is a sentence naming where, within the time given', async () => {
	const server = createServer((socket) => accepted.push(socket));
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	await assert.rejects(
		PgSession.open({ host: '127.0.0.1', port, database: 'd', user: 'u', password: 'p', ssl: 'disable' }, { connectTimeoutMs: 200 }),
		(failure: unknown) => failure instanceof PgConnectError && /did not answer/.test(failure.message)
	);
});

test('the SCRAM client refuses a server nonce that does not extend its own', () => {
	const scram = new Scram('pw', 'clientnonce');
	assert.equal(scram.first(), 'n,,n=,r=clientnonce');
	assert.throws(() => scram.final(`r=othernonce,s=${SALT.toString('base64')},i=4096`), /nonce/);
});
