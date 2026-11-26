import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contract, contractPreflight, expand, backfill, setHandling } from '../lib/migration.js';
import { registerSession, stopSession } from '../lib/session.js';
import { backdateSession, handlingOf, makeEnv, provenanceOf } from './support/env.js';

/**
 * Register a v1 client and put its clocks where the test needs them. The gate
 * reads exactly these two timestamps, so no sleeping is required.
 */
function v1Session(db, id, { seenMsAgo = 0, writeMsAgo = 0, stopped = false } = {}) {
  registerSession(db, { sessionId: id, generation: 'v1', role: 'service', note: 'test' });
  backdateSession(db, id, { seenMsAgo, writeMsAgo });
  if (stopped) stopSession(db, id, 'test-stop');
}

function codes(pre) {
  return pre.reasons.map((r) => r.code).sort();
}

test('a live v1 client blocks contract, even with every row repaired', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 4 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  v1Session(db, 'v1-live', { seenMsAgo: 0, writeMsAgo: 0 });

  const pre = contractPreflight(db, env.cfg);
  assert.equal(pre.allowed, false);
  assert.deepEqual(codes(pre), ['E_DRAIN_NOT_SATISFIED', 'E_LEGACY_CLIENTS_ACTIVE']);
  assert.equal(pre.liveLegacySessions, 1);

  assert.throws(() => contract(db, env.cfg), (err) => err.token === 'E_CONTRACT_REFUSED');
  const audit = db
    .prepare("SELECT detail FROM audit_log WHERE kind = 'migrate.contract_refused' ORDER BY id DESC")
    .get();
  assert.match(audit.detail, /E_LEGACY_CLIENTS_ACTIVE/);
});

test('stopping the session is not enough: the drain window must pass too', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 4 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  v1Session(db, 'v1-just-stopped', { seenMsAgo: 0, writeMsAgo: 0, stopped: true });

  const pre = contractPreflight(db, env.cfg);
  assert.equal(pre.allowed, false);
  assert.deepEqual(codes(pre), ['E_DRAIN_NOT_SATISFIED']);

  backdateSession(db, 'v1-just-stopped', { writeMsAgo: env.cfg.drainWindowMs + 200 });
  const after = contractPreflight(db, env.cfg);
  assert.equal(after.allowed, true, JSON.stringify(after.reasons));
  assert.equal(after.quietMs >= env.cfg.drainWindowMs, true);
});

test('a session that stops heartbeating but never marks stopped is no longer live, but its writes still drain', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 3 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  v1Session(db, 'v1-crashed', { seenMsAgo: env.cfg.activeWindowMs + 500, writeMsAgo: 0 });

  const pre = contractPreflight(db, env.cfg);
  assert.equal(pre.liveLegacySessions, 0, 'stale heartbeat is not a live client');
  assert.deepEqual(codes(pre), ['E_DRAIN_NOT_SATISFIED']);
});

test('a v2 session never holds the gate closed', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 3 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  registerSession(db, { sessionId: 'v2-live', generation: 'v2', role: 'service' });

  const pre = contractPreflight(db, env.cfg);
  assert.equal(pre.allowed, true, JSON.stringify(pre.reasons));
});

test('pending rows and dangling intents each block contract on their own', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 3 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);

  const pending = contractPreflight(db, env.cfg);
  assert.ok(codes(pending).includes('E_PENDING_ROWS'));

  backfill(db);
  db.prepare(
    "INSERT INTO handling_intent (order_id, value, origin, actor, note, issued_at) VALUES (1, 'high', 'modern', 't', 'left behind', ?)",
  ).run(new Date().toISOString());
  const dangling = contractPreflight(db, env.cfg);
  assert.deepEqual(codes(dangling), ['E_DANGLING_INTENT']);
  assert.equal(dangling.allowed, false);
});

test('contract rebuilds to NOT NULL and preserves values, provenance and the id sequence', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 6 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  setHandling(db, { orderId: 2, value: 'critical', actor: 'v2' });
  const before = db
    .prepare('SELECT id, handling FROM orders ORDER BY id')
    .all()
    .map((r) => [r.id, r.handling]);
  const provenanceBefore = db
    .prepare('SELECT order_id, origin FROM handling_provenance ORDER BY order_id')
    .all()
    .map((r) => [r.order_id, r.origin]);
  const maxId = before.at(-1)[0];

  const out = contract(db, env.cfg);
  assert.equal(out.ok, true);
  assert.equal(out.column.notNull, true);

  const after = db
    .prepare('SELECT id, handling FROM orders ORDER BY id')
    .all()
    .map((r) => [r.id, r.handling]);
  assert.deepEqual(after, before, 'table rebuild must not lose or reorder rows');
  assert.deepEqual(
    db
      .prepare('SELECT order_id, origin FROM handling_provenance ORDER BY order_id')
      .all()
      .map((r) => [r.order_id, r.origin]),
    provenanceBefore,
  );
  assert.ok(Number(db.prepare("SELECT seq FROM sqlite_sequence WHERE name='orders'").get().seq) >= maxId);

  const next = db
    .prepare(
      `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at, handling)
       VALUES ('AFTER-1', 'V2', 1, 'normal', 'open', ?, 'low') RETURNING id`,
    )
    .get(new Date().toISOString());
  assert.ok(next.id > maxId, 'AUTOINCREMENT continues past the rebuilt rows');

  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
           VALUES ('V1-AFTER', 'V1', 1, 'normal', 'open', ?)`,
        )
        .run(new Date().toISOString()),
    (err) => /NOT NULL constraint failed/.test(err.message),
  );

  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(provenanceOf(db, next.id).origin, 'modern');
  assert.equal(handlingOf(db, 2), 'critical');
});

test('a row inserted between preflight and rebuild is carried through, not flagged', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 4 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  assert.equal(contractPreflight(db, env.cfg).allowed, true);

  // A v2 insert commits between the gate's observation and the rebuild's
  // write lock. The rebuild must count under the lock.
  db.prepare(
    `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at, handling)
     VALUES ('RACE-1', 'V2', 1, 'normal', 'open', ?, 'low')`,
  ).run(new Date().toISOString());

  const out = contract(db, env.cfg);
  assert.equal(out.ok, true);
  assert.equal(out.rows, 5);
  assert.equal(
    db.prepare("SELECT handling FROM orders WHERE ref = 'RACE-1'").get().handling,
    'low',
    'the concurrent insert survived the rebuild',
  );
});
