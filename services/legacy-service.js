import { loadConfig } from '../lib/config.js';
import { errorPayload, nowIso, withTx } from '../lib/db.js';
import { runService } from '../lib/service.js';
import { jsonHandler, readJson } from '../lib/http.js';
import { listTickOrders } from '../lib/orders.js';

/**
 * Generation 1 ("v1"): the legacy order service.
 *
 * It is deployed BEFORE the migration and knows nothing about the new
 * `handling` column. It may not even be redeployable (old mobile clients,
 * a vendor box), so the rehearsal keeps it running untouched through
 * expand and backfill:
 *
 *  - reads select only the columns v1 knows,
 *  - inserts omit `handling` (the database fills the interim sentinel),
 *  - updates touch status/customer/priority, never `handling`.
 *
 * After contract its inserts fail on NOT NULL — that refusal is part of the
 * demonstration, not a bug.
 */
const LEGACY_VIEW = `
SELECT id, ref, customer, amount_cents, priority, status, created_at
  FROM orders ORDER BY id DESC LIMIT ?`;

function legacyRoutes(ctx) {
  const { db, cfg } = ctx;

  return [
    {
      method: 'GET',
      path: '/orders',
      handler: jsonHandler(async (req, res, url) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const rows = db.prepare(LEGACY_VIEW).all(limit);
        return { ok: true, generation: 'v1', count: rows.length, orders: rows };
      }),
    },
    {
      method: 'GET',
      path: '/orders/:id',
      handler: jsonHandler(async (req, res, url, params) => {
        const row = db
          .prepare(
            `SELECT id, ref, customer, amount_cents, priority, status, created_at
               FROM orders WHERE id = ?`,
          )
          .get(Number(params.id));
        if (!row) return { ok: false, token: 'E_NOT_FOUND', message: 'no such order' };
        return { ok: true, generation: 'v1', order: row };
      }),
    },
    {
      method: 'POST',
      path: '/orders',
      handler: jsonHandler(async (req) => {
        const body = await readJson(req);
        const customer = String(body.customer ?? 'Legacy Co').slice(0, 80);
        const priority = ['low', 'normal', 'high', 'critical'].includes(body.priority)
          ? body.priority
          : 'normal';
        const amount = Number.isInteger(body.amountCents) ? body.amountCents : 25_000;
        // Deliberately NO handling column: v1 does not know it exists.
        return ctx.writeTx(
          () => {
            const status = body.status === 'closed' ? 'closed' : 'open';
            const ref = `V1-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const info = db
              .prepare(
                `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .run(ref, customer, amount, priority, status, nowIso());
            const row = db
              .prepare(
                `SELECT id, ref, customer, amount_cents, priority, status, created_at
                   FROM orders WHERE id = ?`,
              )
              .get(info.lastInsertRowid);
            return { ok: true, generation: 'v1', order: row };
          },
          { inserts: true },
        );
      }),
    },
    {
      method: 'POST',
      path: '/orders/:id/status',
      handler: jsonHandler(async (req, res, url, params) => {
        const id = Number(params.id);
        const body = await readJson(req);
        const status = body.status === 'closed' ? 'closed' : 'open';
        return ctx.writeTx(() => {
          const row = db
            .prepare(
              `UPDATE orders SET status = ?
                WHERE id = ? AND status <> ? RETURNING id`,
            )
            .get(status, id, status);
          if (!row) return { ok: true, generation: 'v1', changed: false };
          return { ok: true, generation: 'v1', changed: true, order: { id, status } };
        });
      }),
    },
    {
      method: 'GET',
      path: '/view',
      handler: jsonHandler(async () => ({
        ok: true,
        generation: 'v1',
        knowsRequiredColumn: false,
        selectColumns: ['id', 'ref', 'customer', 'amount_cents', 'priority', 'status', 'created_at'],
        insertColumns: ['ref', 'customer', 'amount_cents', 'priority', 'status', 'created_at'],
        note: 'v1 inserts omit handling; during expand the database fills the interim sentinel',
      })),
    },
  ];
}

/** One traffic tick: mostly status flips, sometimes a fresh v1 insert. */
export function legacyTick(db, cfg, { sessionId } = {}) {
  return withTx(db, () => {
    const orders = listTickOrders(db, 12).map((o) => o.id);
    const roll = Math.random();
    if (orders.length === 0 || roll < 0.68) {
      if (orders.length === 0) return { wrote: 0 };
      const id = orders[Math.floor(Math.random() * orders.length)];
      const status = Math.random() < 0.5 ? 'open' : 'closed';
      const row = db
        .prepare('UPDATE orders SET status = ? WHERE id = ? AND status <> ? RETURNING id')
        .get(status, id, status);
      if (row) markWrite_(db, sessionId);
      return { wrote: row ? 1 : 0 };
    }
    const ref = `V1-${Date.now().toString(36)}-${Math.floor(Math.random() * 10_000)}`;
    const customer = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Wayne'][Math.floor(Math.random() * 5)];
    const priority = ['low', 'normal', 'high', 'critical'][Math.floor(Math.random() * 4)];
    db.prepare(
      `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
       VALUES (?, ?, ?, ?, 'open', ?)`,
    ).run(ref, customer, 10_000 + Math.floor(Math.random() * 90_000), priority, nowIso());
    markWrite_(db, sessionId, true, 1);
    return { wrote: 1, inserted: 1 };
  });
}

function markWrite_(db, sessionId, inserts = false, count = 1) {
  if (!sessionId) return;
  db.prepare(
    `UPDATE client_sessions
        SET last_write_at = ?, writes = writes + ?, inserts = inserts + ?
      WHERE session_id = ?`,
  ).run(nowIso(), count, inserts ? count : 0, sessionId);
}

export const cfg = loadConfig();
export async function startLegacyService({ cfg: ownCfg = cfg, port = ownCfg.legacyPort, tickMs } = {}) {
  const svc = await runService({
    cfg: ownCfg,
    generation: 'v1',
    port,
    name: 'legacy-service',
    buildRoutes: legacyRoutes,
    tick: legacyTick,
  });
  if (tickMs) {
    await fetch(`${svc.baseUrl}/traffic/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intervalMs: tickMs }),
    });
  }
  return svc;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startLegacyService({ cfg, port: Number(process.env.PORT ?? cfg.legacyPort) })
    .then((svc) => {
      console.log(
        `[v1] legacy order service on http://${cfg.host}:${svc.port} session=${svc.ctx.sessionId}`,
      );
    })
    .catch((err) => {
      console.error('[v1] failed to start:', errorPayload(err));
      process.exit(1);
    });
}
