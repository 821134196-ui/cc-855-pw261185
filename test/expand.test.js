import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countPending, expand } from '../lib/migration.js';
import { requiredColumnInfo, triggerNames } from '../lib/migration.js';
import { handlingOf, makeEnv, provenanceOf, v1Insert } from './support/env.js';

test('expand is additive: existing rows stay pending, no values are invented', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 12 });
  t.after(() => {
    db.close();
    env.cleanup();
  });

  assert.equal(requiredColumnInfo(db).exists, false, 'baseline has no handling column');

  const result = expand(db);
  assert.equal(result.phase, 'expanded');
  assert.equal(result.legacyRows, 12);

  const info = requiredColumnInfo(db);
  assert.equal(info.exists, true);
  assert.equal(info.notNull, false, 'expanded column must be nullable');

  assert.equal(countPending(db), 12, 'every legacy row is still pending after expand');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM handling_provenance').get().c,
    0,
    'expand must not stamp provenance on rows it never touched',
  );
  assert.deepEqual(triggerNames(db), [
    'handling_fill_after_insert',
    'handling_guard',
    'handling_provenance_after_update',
  ]);
});

test('expand is idempotent and refuses to re-open a contracted table', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 6 });
  t.after(() => {
    db.close();
    env.cleanup();
  });

  expand(db);
  const inserted = v1Insert(db);
  const again = expand(db);
  assert.equal(again.already, true);
  assert.equal(again.phase, 'expanded');
  assert.equal(
    db.prepare('SELECT COUNT(*) c FROM handling_provenance').get().c,
    1,
    'only the v1 insert has provenance; untouched legacy rows have none yet',
  );
  assert.equal(provenanceOf(db, inserted).origin, 'legacy_default');

  // A contracted column may not be loosened back to nullable.
  db.prepare("UPDATE migration_state SET phase = 'contracted' WHERE id = 1").run();
  assert.throws(() => expand(db), (err) => err.token === 'E_ALREADY_CONTRACTED');
});

test('a v1 insert during expand gets the sentinel and legacy_default provenance', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 4 });
  t.after(() => {
    db.close();
    env.cleanup();
  });
  expand(db);

  const id = v1Insert(db, 'Mid-migration v1');
  assert.equal(handlingOf(db, id), 'unassigned', 'the fill trigger stamps the interim sentinel');
  const prov = provenanceOf(db, id);
  assert.equal(prov.origin, 'legacy_default');
  assert.equal(prov.actor, 'v1');
  assert.equal(prov.value, 'unassigned');
  assert.equal(countPending(db), 5);
});
