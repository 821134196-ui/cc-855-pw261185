import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { loadConfig } from '../lib/config.js';
import { closeDb, nowIso, openDb, withTx } from '../lib/db.js';
import { heartbeat, registerSession, stopSession } from '../lib/session.js';
import { errorPayload, sqliteToken } from '../lib/db.js';

/**
 * A synthetic "old client" process.
 *
 * The rehearsal needs a v1 population that can be started, paused and stopped
 * on command while a repair runs, without depending on a browser. This probe
 * writes exactly what legacy-service writes — no handling column — heartbeats
 * on an interval, and registers under its own v1 session so stopping the real
 * legacy service is never enough to pass the contract gate.
 *
 * CLI:
 *   node tools/v1-probe.js --port 8093 --tick 600
 *   curl -XPOST localhost:8093/probe/pause
 *   curl -XPOST localhost:8093/probe/resume
 *   curl -XPOST localhost:8093/probe/insert
 *   curl -XPOST localhost:8093/probe/stop   (graceful, marks session stopped)
 */
export function startProbeServer({ cfg, port, tickMs = 600, name = 'v1-probe' }) {
  const db = openDb(cfg);
  const sessionId = `${name}-${randomUUID().slice(0, 8)}`;
  registerSession(db, { sessionId, generation: 'v1', role: 'probe', pid: process.pid, note: name });

  let timer = null;
  const stats = { ticks: 0, inserts: 0, errors: 0, lastError: null, paused: false };

  function oneTick() {
    try {
      stats.ticks += 1;
      const ref = `P1-${Date.now().toString(36)}-${Math.floor(Math.random() * 10_000)}`;
      const customer = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Wayne'][Math.floor(Math.random() * 5)];
      const priority = ['low', 'normal', 'high', 'critical'][Math.floor(Math.random() * 4)];
      withTx(db, () => {
        const row = db
          .prepare(
            `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
             VALUES (?, ?, ?, ?, 'open', ?) RETURNING id`,
          )
          .get(ref, customer, 5000 + Math.floor(Math.random() * 40_000), priority, nowIso());
        // v1 writes no handling column: pre-expand nothing happens; during
        // expand the fill trigger stamps the interim sentinel; after contract
        // this very statement fails on NOT NULL.
        db.prepare(
          `UPDATE client_sessions
              SET last_write_at = ?, writes = writes + 1, inserts = inserts + 1
            WHERE session_id = ?`,
        ).run(nowIso(), sessionId);
        stats.inserts += 1;
        return row;
      });
    } catch (err) {
      stats.errors += 1;
      stats.lastError = err?.message ?? String(err);
    }
  }

  function start() {
    if (timer) return;
    stats.paused = false;
    timer = setInterval(oneTick, Math.max(50, Number(tickMs) || 600));
    timer.unref?.();
  }
  function pause() {
    if (timer) clearInterval(timer);
    timer = null;
    stats.paused = true;
  }

  const hb = setInterval(() => {
    try {
      heartbeat(db, sessionId);
    } catch {
      /* busy: retry next beat */
    }
  }, cfg.heartbeatMs);
  hb.unref?.();

  const routes = {
    'GET /health': () => ({
      ok: true,
      role: 'probe',
      generation: 'v1',
      sessionId,
      paused: stats.paused,
      ...stats,
    }),
    'POST /probe/insert': () => {
      oneTick();
      return { ok: stats.errors === 0, inserted: stats.inserts, lastError: stats.lastError };
    },
    'POST /probe/pause': () => {
      pause();
      return { ok: true, paused: true };
    },
    'POST /probe/resume': () => {
      start();
      return { ok: true, paused: false };
    },
    'POST /probe/stop': () => {
      pause();
      clearInterval(hb);
      stopSession(db, sessionId, 'probe-stop');
      return { ok: true, stopped: sessionId };
    },
  };

  const server = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const key = `${req.method} ${path}`;
    const handler = routes[key];
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    if (!handler) {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, token: 'E_NOT_FOUND', message: `${key} not found` }));
      return;
    }
    try {
      const out = handler();
      res.statusCode = 200;
      res.end(JSON.stringify(out));
    } catch (err) {
      res.statusCode = sqliteToken(err) ? 409 : 500;
      res.end(JSON.stringify(errorPayload(err)));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, cfg.host, () => {
      start();

      /** Stop traffic, mark the session stopped, close the socket — no exit. */
      const close = async (reason = 'probe-close') => {
        pause();
        clearInterval(hb);
        try {
          stopSession(db, sessionId, reason);
        } catch {
          /* another process may hold the write lock; the stopped stamp is best effort */
        }
        await new Promise((done) => {
          server.close(() => done());
          setTimeout(done, 1000).unref?.();
        });
        closeDb(db);
      };

      resolve({
        server,
        sessionId,
        stats,
        pause,
        resume: start,
        close,
        // Standalone CLI: close and then exit.
        shutdown: (reason = 'probe-shutdown') => close(reason).then(() => process.exit(0)),
      });
    });
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cfg = loadConfig();
  const port = Number(process.env.PROBE_PORT ?? 8093);
  const tick = Number(process.env.PROBE_TICK_MS ?? 600);
  startProbeServer({ cfg, port, tickMs: tick })
    .then((probe) => {
      console.log(`[probe] v1 probe on http://${cfg.host}:${port} session=${probe.sessionId}`);
      process.on('SIGINT', () => probe.shutdown('SIGINT'));
      process.on('SIGTERM', () => probe.shutdown('SIGTERM'));
    })
    .catch((err) => {
      console.error('[probe] failed to start:', errorPayload(err));
      process.exit(1);
    });
}
