import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, serviceUrl, describeConfig } from '../lib/config.js';
import { closeDb, errorPayload, nowIso, openDb, statusFor, withTx } from '../lib/db.js';
import { backfill, columnSnapshot, contract, contractPreflight, expand, readState, auditTrail, batches, rollbackDefaults, unsafeDefaultSweep, validate, countPending } from '../lib/migration.js';
import { listSessions } from '../lib/session.js';
import { seedDatabase } from '../lib/seed.js';
import { DEFAULT_HANDLING, HANDLING_VALUES } from '../lib/schema.js';

/**
 * The operations page: a single-file HTML console plus a JSON API over the
 * same database, serving the rehearsal's operator workflow:
 *
 *   expand → repair in batches (watching live v1/v2 traffic) → validate →
 *   attempt contract (must be refused while old clients are live) → drain →
 *   contract → prove v1 is rejected and v2 still writes → roll back defaults.
 *
 * The API is deliberately thin: every mutating call goes through the same
 * functions the CLI uses, so the page cannot have a weaker safety story than
 * the CLI.
 */
const cfg = loadConfig();
const here = path.dirname(fileURLToPath(import.meta.url));
const assets = {
  'ops.css': ['text/css; charset=utf-8', path.join(here, 'assets', 'ops.css')],
  'ops.js': ['text/javascript; charset=utf-8', path.join(here, 'assets', 'ops.js')],
};
const PAGE = fs.readFileSync(path.join(here, 'assets', 'ops.html'), 'utf8');
const ASSET_BYTES = Object.fromEntries(
  Object.entries(assets).map(([name, [type, file]]) => [name, { type, body: fs.readFileSync(file) }]),
);

let db = openDb(cfg);
let bus = [];
function log(event) {
  bus.push({ at: nowIso(), ...event });
  if (bus.length > 80) bus = bus.slice(-80);
}

/** Snapshot used by every panel; one transaction so counts agree. */
function snapshot() {
  const state = readState(db);
  const snap = columnSnapshot(db);
  const pre = state && state.phase !== 'baseline' ? contractPreflight(db, cfg) : null;
  const sessions = listSessions(db);
  return {
    ok: true,
    config: describeConfig(cfg),
    state: state ? { phase: state.phase, updatedAt: state.updated_at, notes: state.notes, contractedAt: state.contracted_at, backfilledAt: state.backfill_started_at } : null,
    column: snap.column,
    stats: snap.stats,
    pending: snap.stats.pending,
    sessions,
    preflight: pre,
    contractAllowed: Boolean(pre?.allowed),
    batches: batches(db, 20),
    audit: auditTrail(db, 25),
    events: bus.slice(-14),
    allowedValues: HANDLING_VALUES,
    defaultHandling: DEFAULT_HANDLING,
    serviceUrls: {
      legacy: serviceUrl(cfg, 'legacy'),
      modern: serviceUrl(cfg, 'modern'),
    },
    servedAt: nowIso(),
  };
}

/* --------------------------------------------------------------- actions */

const actions = {
  /** Start the repair: add the nullable column and its guards. */
  expand: () => withTxless((d) => expand(d)),

  /** Repair one batch (or a few) and report progress. */
  'backfill-batch': (body) =>
    cmd(() => {
      const r = backfill(db, { batchSize: Number(body.batchSize) || cfg.batchSize, maxBatches: Number(body.batches) || 1 });
      log({ kind: 'backfill', text: `batch filled ${r.filled}/${r.attempted}, ${r.remaining} pending` });
      return r;
    }),

  /** Run the whole repair to completion in batches, pausing between them. */
  'backfill-all': async (body) => {
    const size = Number(body.batchSize) || cfg.batchSize;
    const pace = Number(body.paceMs) || 250;
    let filled = 0;
    for (let i = 0; i < 400; i += 1) {
      const r = backfill(db, { batchSize: size, maxBatches: 1 });
      filled += r.filled;
      log({ kind: 'backfill', text: `batch ${i + 1}: +${r.filled}, ${r.remaining} pending` });
      if (r.remaining === 0) break;
      await sleep(pace);
    }
    return { filled, remaining: countPending(db) };
  },

  validate: () => cmd(() => validate(db)),

  'attempt-contract': () => {
    const pre = contractPreflight(db, cfg);
    if (!pre.allowed) {
      const err = { ok: false, token: 'E_CONTRACT_REFUSED', message: 'contract refused', detail: { preflight: pre } };
      log({ kind: 'refused', text: `contract refused: ${pre.reasons.map((r) => r.code).join(', ')}` });
      return Promise.resolve({ status: 409, body: err });
    }
    try {
      const result = cmd(() => contract(db, cfg, { source: 'ops' }));
      log({ kind: 'contract', text: `contract applied to ${result.rows} rows` });
      return Promise.resolve(result);
    } catch (err) {
      return Promise.reject(err);
    }
  },

  'rollback-defaults': (body) =>
    cmd(() => {
      const r = rollbackDefaults(db, { batchSize: Number(body.batchSize) || 25, maxBatches: Number(body.batches) || Infinity });
      log({ kind: 'rollback', text: `reverted ${r.reverted} default row(s)` });
      return r;
    }),

  'unsafe-sweep': () =>
    cmd(() => {
      const r = unsafeDefaultSweep(db);
      log({ kind: 'guard', text: `unsafe sweep: reverted ${r.reverted}, refused ${r.blocked.length} modern row(s)` });
      return r;
    }),

  /** Used by the rehearsal page to force a fresh demonstration run. */
  reseed: (body) => {
    closeDb(db);
    const out = seedDatabase(cfg, { reset: true, legacyRows: Number(body.legacyRows) || 240 });
    db = openDb(cfg);
    bus = [];
    log({ kind: 'seed', text: `baseline reseeded with ${out.legacyRows} legacy rows` });
    return out;
  },

  /**
   * Post-contract proof: try one v1-style insert and one v2-style insert and
   * report what the database did to each.
   */
  'probe-inserts': () =>
    cmd(() => {
      const attempts = [];
      try {
        db.prepare(
          `INSERT INTO orders (ref, customer, amount_cents, priority, created_at)
           VALUES (?, 'v1-probe', 1000, 'low', ?)`,
        ).run(`P-${Date.now().toString(36)}`, nowIso());
        attempts.push({ generation: 'v1', accepted: true });
      } catch (err) {
        attempts.push({ generation: 'v1', accepted: false, token: /NOT NULL/.test(err.message) ? 'NOT_NULL' : err.message });
      }
      try {
        db.prepare(
          `INSERT INTO orders (ref, customer, amount_cents, priority, created_at, handling)
           VALUES (?, 'v2-probe', 1000, 'low', ?, 'normal')`,
        ).run(`P-${Date.now().toString(36)}`, nowIso());
        attempts.push({ generation: 'v2', accepted: true });
      } catch (err) {
        attempts.push({ generation: 'v2', accepted: false, token: err.message });
      }
      log({ kind: 'probe', text: `insert probe: v1 ${attempts[0].accepted ? 'accepted' : 'refused'}, v2 ${attempts[1].accepted ? 'accepted' : 'refused'}` });
      return { attempts };
    }),

  /**
   * Stop the demo's own synthetic old clients so the drain window can elapse.
   * This marks every probe-role v1 session stopped. It does NOT stop the
   * real legacy service process — that is the point: an operator must stop it
   * separately.
   */
  'stop-probes': () =>
    cmd(() => {
      const rows = db
        .prepare("SELECT session_id FROM client_sessions WHERE generation='v1' AND role='probe' AND stopped_at IS NULL")
        .all();
      const at = nowIso();
      for (const r of rows) {
        db.prepare('UPDATE client_sessions SET stopped_at = ?, stop_reason = ?, last_seen_at = ? WHERE session_id = ?').run(at, 'ops-stop-probes', at, r.session_id);
      }
      log({ kind: 'probes', text: `stopped ${rows.length} probe session(s)` });
      return { stopped: rows.length };
    }),

  snapshot: () => snapshot(),
};

function cmd(fn) {
  // Each action gets its own small transaction where the migration function
  // does not own one; the surface stays consistent with the CLI.
  return Promise.resolve(fn());
}

function withTxless(fn) {
  return Promise.resolve(fn(db));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* --------------------------------------------------------------- routing */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(Object.assign(new Error('bad json'), { token: 'E_BAD_JSON', status: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathName = url.pathname;
  try {
    if (req.method === 'GET' && (pathName === '/' || pathName === '/ops')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (req.method === 'GET' && pathName.startsWith('/assets/')) {
      const name = pathName.slice('/assets/'.length);
      const asset = ASSET_BYTES[name];
      if (!asset) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' });
      res.end(asset.body);
      return;
    }
    if (req.method === 'GET' && pathName === '/api/snapshot') {
      const body = snapshot();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    if (req.method === 'GET' && pathName === '/api/preflight') {
      const pre = contractPreflight(db, cfg);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, preflight: pre }));
      return;
    }
    if (req.method === 'POST' && pathName.startsWith('/api/action/')) {
      const name = pathName.slice('/api/action/'.length);
      const fn = actions[name];
      if (!fn) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, token: 'E_NOT_FOUND', message: `no action '${name}'` }));
        return;
      }
      const body = await readBody(req);
      const out = await fn(body);
      if (out && typeof out === 'object' && 'status' in out) {
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...out.body, snapshot: snapshot() }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: out?.ok !== false, result: out, snapshot: snapshot() }));
      return;
    }
    if (req.method === 'GET' && pathName === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, role: 'ops', dbPath: cfg.dbPath }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, token: 'E_NOT_FOUND', message: `no route ${req.method} ${pathName}` }));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(statusFor(err), { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...errorPayload(err), snapshot: trySnapshot() }));
    }
  }
});

function trySnapshot() {
  try { return snapshot(); } catch { return null; }
}

const server_ready = new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(cfg.opsPort, cfg.host, () => {
    console.log(`[ops] operations page on http://${cfg.host}:${cfg.opsPort}`);
    log({ kind: 'ops', text: 'operations page ready' });
    resolve(server);
  });
});

function shutdown(signal) {
  server.close(() => {
    try { closeDb(db); } catch { /* closed */ }
    process.exit(0);
  });
  setTimeout(() => {
    try { closeDb(db); } catch { /* closed */ }
    process.exit(0);
  }, 1200).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server_ready.catch((err) => {
  console.error('[ops] failed to start:', errorPayload(err));
  process.exit(1);
});
