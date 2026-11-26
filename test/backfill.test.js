import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  backfill,
  countPending,
  expand,
  pendingIds,
  setHandling,
} from '../lib/migration.js';
import { handlingOf, makeEnv, provenanceOf, v1Insert } from './support/env.js';

test('backfill repairs in id order, one bounded batch at a time', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 11 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);

  const first = backfill(db, { batchSize: 4, maxBatches: 1 });
  assert.equal(first.filled, 4);
  assert.equal(first.remaining, 7);
  assert.equal(first.batches, 1);

  const repaired = db
    .prepare("SELECT id, handling FROM orders WHERE handling = 'normal' ORDER BY id")
    .all();
  assert.deepEqual(
    repaired.map((r) => r.id),
    [1, 2, 3, 4],
    'the batch covers the lowest ids first',
  );
  assert.ok(repaired.every((r) => provenanceOf(db, r.id).origin === 'backfill'));

  const rest = backfill(db, { batchSize: 4 });
  assert.equal(rest.filled, 7);
  assert.equal(rest.remaining, 0);
  assert.equal(countPending(db), 0);
});

test('backfill at zero pending is a no-op that still advances the phase', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 3 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);

  const again = backfill(db);
  assert.equal(again.noop, true);
  assert.equal(again.filled, 0);
  assert.equal(db.prepare("SELECT phase FROM migration_state WHERE id=1").get().phase, 'backfilled');
});

test('backfill never selects a row the modern generation already filled', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 8 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  setHandling(db, { orderId: 1, value: 'critical', actor: 'v2' });

  assert.deepEqual(pendingIds(db, 50), [2, 3, 4, 5, 6, 7, 8]);
  const result = backfill(db, { batchSize: 50 });
  assert.equal(result.filled, 7);
  assert.equal(handlingOf(db, 1), 'critical');
  assert.equal(provenanceOf(db, 1).origin, 'modern');
});

test('rows inserted by v1 mid-backfill are picked up by a later batch', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 5 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db, { batchSize: 10, maxBatches: 1 });
  const lateId = v1Insert(db, 'arrived late');
  assert.equal(countPending(db), 1);

  const result = backfill(db, { batchSize: 10 });
  assert.equal(result.filled, 1);
  assert.equal(handlingOf(db, lateId), 'normal', 'late v1 row gets a real value');
  assert.equal(provenanceOf(db, lateId).origin, 'backfill');
});

test('batches are recorded with kind, counts and remaining work', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 6 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db, { batchSize: 4, maxBatches: 1 });
  backfill(db, { batchSize: 4 });

  const rows = db
    .prepare('SELECT kind, attempted, filled, remaining, status FROM migration_batches ORDER BY id')
    .all();
  assert.equal(rows.length, 2);
  assert.deepEqual({ ...rows[0] }, { kind: 'backfill', attempted: 4, filled: 4, remaining: 2, status: 'filled' });
  assert.deepEqual({ ...rows[1] }, { kind: 'backfill', attempted: 2, filled: 2, remaining: 0, status: 'filled' });
});

test('backfill refuses to run before expand or after contract', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 2 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  assert.throws(() => backfill(db), (err) => err.token === 'E_NOT_EXPANDED');

  expand(db);
  backfill(db);
  db.prepare("UPDATE migration_state SET phase = 'contracted' WHERE id = 1").run();
  assert.throws(() => backfill(db), (err) => err.token === 'E_ALREADY_CONTRACTED');
});
