import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withHandlingIntent } from '../lib/db.js';
import {
  backfill,
  countPending,
  expand,
  rollbackDefaults,
  setHandling,
  unsafeDefaultSweep,
  validate,
} from '../lib/migration.js';
import { handlingOf, makeEnv, provenanceOf, v1Insert } from './support/env.js';

/** A row that v2 has written, and one that only ever held a repair default. */
function seedTwoOrigins(db) {
  expand(db);
  backfill(db);
  setHandling(db, { orderId: 1, value: 'critical', actor: 'v2' });
}

test('the database refuses a value rewrite without an intent', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 4 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  seedTwoOrigins(db);

  assert.throws(
    () => db.prepare("UPDATE orders SET handling = 'low' WHERE id = 1").run(),
    (err) => err.message.includes('E_OVERWRITE_WITHOUT_INTENT'),
  );
  assert.equal(handlingOf(db, 1), 'critical');

  // An intent with a *different* value must not authorise this write either.
  assert.throws(
    () =>
      withHandlingIntent(db, { orderId: 1, value: 'high', origin: 'modern', actor: 't' }, () =>
        db.prepare("UPDATE orders SET handling = 'low' WHERE id = 1").run(),
      ),
    (err) => err.message.includes('E_OVERWRITE_WITHOUT_INTENT'),
  );
  assert.equal(handlingOf(db, 1), 'critical');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM handling_intent').get().c, 0, 'intent is consumed');
});

test('a rollback-origin intent cannot overwrite a value v2 wrote', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 4 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  seedTwoOrigins(db);

  for (const origin of ['backfill', 'rollback']) {
    assert.throws(
      () =>
        withHandlingIntent(db, { orderId: 1, value: 'normal', origin, actor: 't' }, () =>
          db.prepare("UPDATE orders SET handling = 'normal' WHERE id = 1").run(),
        ),
      (err) => err.message.includes('E_DEFAULT_OVER_MODERN'),
      `origin ${origin} must be refused on a modern row`,
    );
  }
  assert.equal(handlingOf(db, 1), 'critical');
  assert.equal(provenanceOf(db, 1).origin, 'modern');
});

test('unsafe sweep reverts every default row and is refused on every modern row', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 6 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  setHandling(db, { orderId: 2, value: 'high', actor: 'v2' });
  setHandling(db, { orderId: 5, value: 'low', actor: 'v2' });

  const sweep = unsafeDefaultSweep(db, { actor: 'test-unsafe' });
  assert.equal(sweep.reverted, 4);
  assert.equal(sweep.blocked.length, 2);
  assert.deepEqual(
    sweep.blocked.map((b) => b.id),
    [2, 5],
  );
  assert.ok(sweep.blocked.every((b) => b.token === 'E_DEFAULT_OVER_MODERN'));

  assert.equal(handlingOf(db, 2), 'high');
  assert.equal(handlingOf(db, 5), 'low');
  assert.equal(countPending(db), 4);
});

test('safe rollback keeps modern values and is re-repairable', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 6 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  backfill(db);
  setHandling(db, { orderId: 3, value: 'critical', actor: 'v2' });

  const result = rollbackDefaults(db, { batchSize: 2 });
  assert.equal(result.reverted, 5);
  assert.equal(handlingOf(db, 3), 'critical', 'modern value untouched');
  assert.equal(handlingOf(db, 1), null, 'default rows go back to NULL');
  assert.equal(countPending(db), 5);

  backfill(db);
  assert.equal(countPending(db), 0);
  validate(db);
  assert.equal(handlingOf(db, 3), 'critical');
  assert.equal(provenanceOf(db, 3).origin, 'modern');
});

test('validate fails while a sentinel row is waiting, passes when none is', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 3 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);
  assert.throws(() => validate(db), (err) => err.token === 'E_VALIDATION_FAILED');

  backfill(db);
  const v = validate(db);
  assert.equal(v.ok, true);

  v1Insert(db); // a live old client arrives after validation
  assert.throws(() => validate(db), (err) => err.token === 'E_VALIDATION_FAILED');
});
