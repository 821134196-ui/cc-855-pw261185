import { loadConfig } from '../lib/config.js';
import { errorPayload, nowIso, withHandlingIntent, withTx } from '../lib/db.js';
import { runService } from '../lib/service.js';
import { jsonHandler, readJson } from '../lib/http.js';
import { hasHandling, modernSelectColumns, modernTickOrders } from '../lib/orders.js';
import { HANDLING_VALUES, ORIGINS, REQUIRED_COLUMN, SENTINEL } from '../lib/schema.js';
import { setHandling } from '../lib/migration.js';

/**
 * Generation 2 ("v2"): the modern order service.
 *
 * It is deployed first (before the migration) and must keep working across
 * every phase:
 *  - before expand the column does not exist, so it selects NULL AS handling;
 *  - once expanded it reads and writes real values; on a row that v1 left at
 *    the interim sentinel it supplies a real value with an 'modern' intent;
 *  - after contract v1 inserts start failing while v2 inserts keep succeeding.
 */
function modernRoutes(ctx) {
  const { db, cfg } = ctx;

  return [
    {
      method: 'GET',
      path: '/orders',
      handler: jsonHandler(async (req, res, url) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 30));
        const cols = modernSelectColumns(db);
        const rows = db.prepare(`SELECT ${cols} FROM orders ORDER BY id DESC LIMIT ?`).all(limit);
        return {
          ok: true,
          generation: 'v2',
          requiredColumnPresent: hasHandling(db),
          count: rows.length,
          orders: rows,
        };
      }),
    },
    {
      method: 'GET',
      path: '/orders/:id',
      handler: jsonHandler(async (req, res, url, params) => {
        const id = Number(params.id);
        const cols = modernSelectColumns(db);
        const row = db.prepare(`SELECT ${cols} FROM orders WHERE id = ?`).get(id);
        if (!row) return { ok: false, token: 'E_NOT_FOUND', message: 'no such order' };
        return { ok: true, generation: 'v2', order: row };
      }),
    },
    {
      method: 'POST',
      path: '/orders',
      handler: jsonHandler(async (req) => {
        const body = await readJson(req);
        const customer = String(body.customer ?? 'Modern Co').slice(0, 80);
        const priority = ['low', 'normal', 'high', 'critical'].includes(body.priority)
          ? body.priority
          : 'normal';
        const handling = HANDLING_VALUES.includes(body.handling) ? body.handling : 'normal';
        const amount = Number.isInteger(body.amountCents) ? body.amountCents : 40_000;

        return ctx.writeTx(
          () => {
            const ref = `V2-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            if (!hasHandling(db)) {
              // Pre-expand: v2 cannot name a column that does not exist yet.
              db.prepare(
                `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
                 VALUES (?, ?, ?, ?, 'open', ?)`,
              ).run(ref, customer, amount, priority, nowIso());
              return {
                ok: true,
                generation: 'v2',
                handlingWritten: false,
                note: 'column absent; v2 wrote everything except handling',
              };
            }
            db.prepare(
              `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at, ${REQUIRED_COLUMN})
               VALUES (?, ?, ?, ?, 'open', ?, ?)`,
            ).run(ref, customer, amount, priority, nowIso(), handling);
            return { ok: true, generation: 'v2', handlingWritten: true, handling };
          },
          { inserts: true },
        );
      }),
    },
    {
      method: 'POST',
      path: '/orders/:id/handling',
      handler: jsonHandler(async (req, res, url, params) => {
        const env = await readJson(req);
        const value = env.handling ?? env.value;
        const actor = String(env.actor ?? 'v2').slice(0, 40);
        if (!hasHandling(db)) {
          return { ok: false, token: 'E_COLUMN_MISSING', message: 'handling has not been expanded yet' };
        }
        const result = setHandling(db, { orderId: params.id, value, actor });
        if (!result) return { ok: false, token: 'E_NOT_FOUND', message: 'no such order' };
        ctx.markWrite(false, 1);
        return { ok: true, generation: 'v2', order: result };
      }),
    },
    {
      method: 'GET',
      path: '/view',
      handler: jsonHandler(async () => ({
        ok: true,
        generation: 'v2',
        requiredColumnPresent: hasHandling(db),
        allowedValues: HANDLING_VALUES,
        interimSentinel: SENTINEL,
        note: 'v2 writes real handling values; on expanded-but-unrepaired rows it supplies one',
      })),
    },
  ];
}

/** Traffic tick: revise an existing handling (mostly) or insert a new order. */
export function modernTick(db, cfg, { sessionId } = {}) {
  return withTx(db, () => {
    const colPresent = hasHandling(db);
    const roll = Math.random();
    if (!colPresent || roll < 0.4) {
      const ref = `V2-${Date.now().toString(36)}-${Math.floor(Math.random() * 10_000)}`;
      const customer = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Wayne'][Math.floor(Math.random() * 5)];
      const priority = ['low', 'normal', 'high', 'critical'][Math.floor(Math.random() * 4)];
      const handling = HANDLING_VALUES[Math.floor(Math.random() * HANDLING_VALUES.length)];
      if (colPresent) {
        db.prepare(
          `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at, ${REQUIRED_COLUMN})
           VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        ).run(ref, customer, 20_000 + Math.floor(Math.random() * 80_000), priority, nowIso(), handling);
      } else {
        db.prepare(
          `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
           VALUES (?, ?, ?, ?, 'open', ?)`,
        ).run(ref, customer, 20_000 + Math.floor(Math.random() * 80_000), priority, nowIso());
      }
      markWrite_(db, sessionId, true);
      return { wrote: 1, inserted: 1 };
    }

    if (!colPresent) return { wrote: 0 };
    const targets = modernTickOrders(db, 12).filter((o) => o.handling !== null);
    if (targets.length === 0) return { wrote: 0 };
    const target = targets[Math.floor(Math.random() * targets.length)];
    const value = HANDLING_VALUES[Math.floor(Math.random() * HANDLING_VALUES.length)];
    if (value === target.handling) return { wrote: 0 };
    try {
      withHandlingIntent(
        db,
        { orderId: target.id, value, origin: ORIGINS.MODERN, actor: 'v2', note: 'traffic revise' },
        () => {
          db.prepare(`UPDATE orders SET ${REQUIRED_COLUMN} = ? WHERE id = ?`).run(value, target.id);
        },
      );
      markWrite_(db, sessionId, false);
      return { wrote: 1 };
    } catch (err) {
      return { wrote: 0, error: err.message };
    }
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
export async function startModernService({ cfg: ownCfg = cfg, port = ownCfg.modernPort, tickMs } = {}) {
  const svc = await runService({
    cfg: ownCfg,
    generation: 'v2',
    port,
    name: 'modern-service',
    buildRoutes: modernRoutes,
    tick: modernTick,
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
  startModernService({ cfg, port: Number(process.env.PORT ?? cfg.modernPort) })
    .then((svc) => {
      console.log(`[v2] modern order service on http://${cfg.host}:${svc.port} session=${svc.ctx.sessionId}`);
    })
    .catch((err) => {
      console.error('[v2] failed to start:', errorPayload(err));
      process.exit(1);
    });
}
