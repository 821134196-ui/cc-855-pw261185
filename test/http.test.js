import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expand, backfill } from '../lib/migration.js';
import { startModernService } from '../services/modern-service.js';
import { makeEnv } from './support/env.js';

async function json(url, init) {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json() };
}

test('HTTP routes receive :id params and serve both generations across contract', async (t) => {
  const env = makeEnv();
  const db = env.open({ legacyRows: 5 });
  const v1 = await startModernService({ cfg: env.cfg, port: 0 }); // v2 code, same shape
  t.after(async () => {
    await v1.closeService('test-end');
    db.close();
    env.cleanup();
  });

  // Pre-expand: v2 reads fine and reports the column absent.
  const before = await json(`${v1.baseUrl}/orders?limit=3`);
  assert.equal(before.status, 200);
  assert.equal(before.body.ok, true);
  assert.equal(before.body.requiredColumnPresent, false);
  assert.equal(before.body.orders[0].handling, null);

  const fillTooEarly = await json(`${v1.baseUrl}/orders/1/handling`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handling: 'high' }),
  });
  assert.equal(fillTooEarly.body.token, 'E_COLUMN_MISSING');

  expand(db);
  backfill(db, { batchSize: 10 });

  // The regression this guards: jsonHandler must forward matchPath params.
  const fill = await json(`${v1.baseUrl}/orders/2/handling`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handling: 'critical', actor: 'v2-http' }),
  });
  assert.equal(fill.status, 200);
  assert.equal(fill.body.ok, true);
  assert.deepEqual({ ...fill.body.order }, { id: 2, value: 'critical' });

  const one = await json(`${v1.baseUrl}/orders/2`);
  assert.equal(one.status, 200);
  assert.equal(one.body.order.handling, 'critical');

  const missing = await json(`${v1.baseUrl}/orders/99999/handling`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handling: 'high' }),
  });
  assert.equal(missing.body.token, 'E_NOT_FOUND');
  assert.equal(missing.status, 200);

  const bad = await json(`${v1.baseUrl}/orders/2/handling`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handling: 'urgent' }),
  });
  assert.equal(bad.body.token, 'E_BAD_VALUE');
  assert.equal(bad.status, 400);
});
