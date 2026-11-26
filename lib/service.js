import { randomUUID } from 'node:crypto';
import { closeDb, openDb, withTx } from './db.js';
import { startServer, sendJson, jsonHandler } from './http.js';
import { heartbeat, registerSession, stopSession } from './session.js';

/**
 * Shared runtime for the two service generations.
 *
 * Each service process:
 *  - opens its own SQLite connection (WAL lets both generations work at once),
 *  - registers a session row that the contract gate reads,
 *  - heartbeats on an interval,
 *  - exposes a small JSON API plus a built-in traffic loop so the demo can
 *    generate real concurrent load without a separate tool,
 *  - stops gracefully on SIGINT/SIGTERM, marking the session stopped.
 */
export async function runService({
  cfg,
  generation,
  port,
  name,
  buildRoutes,
  tick,
  defaultTickMs = 400,
}) {
  const sessionId = `${name}-${randomUUID().slice(0, 8)}`;
  const db = openDb(cfg);
  registerSession(db, {
    sessionId,
    generation,
    role: 'service',
    pid: process.pid,
    note: `${name} (${generation})`,
  });

  let traffic = null; // { timer, intervalMs, stats }
  let stopping = false;

  const heartbeatTimer = setInterval(() => {
    try {
      heartbeat(db, sessionId);
    } catch {
      /* a busy DB at heartbeat time is not fatal; the next one retries */
    }
  }, cfg.heartbeatMs);
  heartbeatTimer.unref?.();

  function trafficStats() {
    if (!traffic) return { running: false, ticks: 0, writes: 0, errors: 0, lastError: null, intervalMs: null };
    return { running: true, ...traffic.stats, intervalMs: traffic.intervalMs };
  }

  function startTraffic(intervalMs = defaultTickMs) {
    if (traffic) return trafficStats();
    const stats = { ticks: 0, writes: 0, errors: 0, lastError: null, intervalMs };
    const timer = setInterval(() => {
      try {
        stats.ticks += 1;
        const out = tick(db, cfg, { sessionId });
        if (out?.wrote) stats.writes += out.wrote;
      } catch (err) {
        stats.errors += 1;
        stats.lastError = err?.message ?? String(err);
      }
    }, Math.max(50, Number(intervalMs) || defaultTickMs));
    timer.unref?.();
    traffic = { timer, intervalMs, stats };
    return trafficStats();
  }

  function stopTraffic() {
    if (traffic) {
      clearInterval(traffic.timer);
      traffic = null;
    }
    return trafficStats();
  }

  const ctx = {
    db,
    cfg,
    generation,
    sessionId,
    startTraffic,
    stopTraffic,
    trafficStats,
    /**
     * One IMMEDIATE transaction that also stamps the session's last write, so
     * the contract gate's drain window reflects real domain writes rather than
     * heartbeat noise.
     */
    writeTx: (fn, { inserts = false } = {}) =>
      withTx(db, () => {
        const out = fn();
        db.prepare(
          `UPDATE client_sessions
              SET last_write_at = ?, writes = writes + 1, inserts = inserts + ?
            WHERE session_id = ?`,
        ).run(new Date().toISOString(), inserts ? 1 : 0, sessionId);
        return out;
      }),
    markWrite: (isInsert, count = 1) => {
      withTx(db, () => {
        db.prepare(
          `UPDATE client_sessions
              SET last_write_at = ?, writes = writes + ?, inserts = inserts + ?
            WHERE session_id = ?`,
        ).run(new Date().toISOString(), count, isInsert ? count : 0, sessionId);
      });
    },
  };

  const extra = buildRoutes(ctx);
  const routes = [
    { method: 'GET', path: '/health', handler: jsonHandler(async () => ({
      ok: true,
      name,
      generation,
      sessionId,
      pid: process.pid,
      traffic: trafficStats(),
      dbPath: cfg.dbPath,
    })) },
    { method: 'GET', path: '/traffic', handler: jsonHandler(async () => ({ ok: true, traffic: trafficStats() })) },
    { method: 'POST', path: '/traffic/start', handler: jsonHandler(async (req) => {
      const body = await readBody(req);
      return { ok: true, traffic: startTraffic(body.intervalMs ?? defaultTickMs) };
    }) },
    { method: 'POST', path: '/traffic/stop', handler: jsonHandler(async () => {
      const t = stopTraffic();
      return { ok: true, traffic: t };
    }) },
    ...extra,
  ];

  const server = await startServer({ port, host: cfg.host, routes });

  /**
   * Stop the process's own work without exiting: clear timers, mark the
   * session stopped (so the contract gate stops counting it as live), close
   * the socket. The CLI bootstrap and the rehearsal demo both use this;
   * `shutdown` adds the process.exit that a standalone service needs.
   */
  async function closeService(reason = 'shutdown') {
    if (stopping) return;
    stopping = true;
    stopTraffic();
    clearInterval(heartbeatTimer);
    try {
      stopSession(db, sessionId, reason);
    } catch {
      /* best effort */
    }
    await new Promise((resolve) => {
      server.close(() => resolve());
      // Keep-alive sockets from the ops page or a probe must not stall exit.
      setTimeout(resolve, 1200).unref?.();
    });
    closeDb(db);
  }

  async function shutdown(signal) {
    await closeService(signal);
    process.exit(0);
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return {
    server,
    ctx,
    shutdown,
    closeService,
    stopHeartbeat: () => clearInterval(heartbeatTimer),
    port: server.address().port,
    baseUrl: `http://${cfg.host}:${server.address().port}`,
  };
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('body is not valid JSON'), { token: 'E_BAD_JSON', status: 400 });
  }
}

export { sendJson };
