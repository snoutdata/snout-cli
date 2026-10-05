/**
 * What `projects list` prints, without a network.
 *
 * The Postgres major is per project (one made on 17 stays on 17 after new ones moved to 18),
 * so it is a column. It is also new: a control plane older than 2026-10-05 does not send it,
 * and the listing has to read the same as it always did against one of those.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Project } from '../api.js';
import { listRows } from './projects.js';

function project(overrides: Partial<Project>): Project {
	return {
		ref: 'b7kq2m9xt4rvz',
		name: 'shop',
		region: 'us-west-2',
		production: false,
		desiredState: 'running',
		state: 'ready',
		stateDetail: null,
		wakesInstantly: true,
		sizeBytes: null,
		readOnly: false,
		readOnlyPending: false,
		readOnlySince: null,
		host: 'b7kq2m9xt4rvz.db.snoutdata.com',
		database: 'b7kq2m9xt4rvz',
		user: 'b7kq2m9xt4rvz_owner',
		createdAt: '2026-10-01T00:00:00Z',
		lastConnectionAt: null,
		pausedAt: null,
		...overrides
	};
}

test('the Postgres version is a column', () => {
	const rows = listRows([project({ postgresVersion: 18 }), project({ ref: 'c8lr3n0yu5swa', name: 'old', postgresVersion: 17 })]);
	assert.deepEqual(rows[0], ['REF', 'NAME', 'STATE', 'REGION', 'POSTGRES', 'LAST CONNECTION']);
	assert.deepEqual(rows[1], ['b7kq2m9xt4rvz', 'shop', 'ready', 'us-west-2', '18', 'never']);
	assert.equal(rows[2]![4], '17');
});

test('a project without a version shows a dash beside one that has it', () => {
	const rows = listRows([project({ postgresVersion: 18 }), project({ ref: 'c8lr3n0yu5swa' })]);
	assert.equal(rows[2]![4], '-');
});

test('an older control plane, which sends no version, gets the listing it always got', () => {
	const rows = listRows([project({})]);
	assert.deepEqual(rows[0], ['REF', 'NAME', 'STATE', 'REGION', 'LAST CONNECTION']);
	assert.deepEqual(rows[1], ['b7kq2m9xt4rvz', 'shop', 'ready', 'us-west-2', 'never']);
});
