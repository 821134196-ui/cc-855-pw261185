import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const nowIso = () => new Date().toISOString();

/** Block the current thread for `ms` — used only between SQLite lock retries. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function isBusyError(err) {
  return (
    err?.errcode === 5 ||
    err?.errcode === 6 ||
    /database is (locked|busy)/i.test(err?.message ?? '')
  );
}

/**
 * Guard triggers raise canned tokens such as E_DEFAULT_OVER_MODERN.
 * Constraint failures get a stable token too, so HTTP callers never have to
 * parse English SQLite messages.
 */
export function sqliteToken(err) {
  const msg = err?.message ?? '';
  const match = msg.match(/(E_[A-Z0-9_]+)/);
  if (match) return match[1];
  if (/NOT NULL constraint failed/i.test(msg)) return 'NOT_NULL';
  if (/CHECK constraint failed/i.test(msg)) return 'CHECK';
  if (/UNIQUE constraint failed/i.test(msg)) return 'UNIQUE';
  if (/FOREIGN KEY constraint failed/i.test(msg)) return 'FOREIGN_KEY';
  if (isBusyError(err)) return 'BUSY';
  return null;
}

export function openDb(cfg) {
  mkdirSync(path.dirname(cfg.dbPath), { recursive: true });
  const db = new DatabaseSync(cfg.dbPath, { timeout: cfg.busyTimeoutMs });
  db.exec(`PRAGMA busy_timeout=${cfg.busyTimeoutMs}`);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA synchronous=NORMAL');
  // The expand triggers rely on the insert fill UPDATE re-firing the
  // provenance trigger. SQLite fires triggers from a trigger body regardless
  // of this pragma, but pin it so a future edit cannot silently change that.
  db.exec('PRAGMA recursive_triggers=OFF');
  return db;
}

export function assertSeeded(db) {
  const state = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_state'")
    .get();
  if (!state) {
    throw new Error('database is not seeded (migration_state missing) — run: npm run seed');
  }
}

export function closeDb(db) {
  try {
    if (db?.isOpen) db.close();
  } catch {
    /* already closed */
  }
}

/**
 * Run fn inside a single IMMEDIATE transaction. BEGIN contention is retried with
 * backoff; once the transaction is open we never retry the body (side effects
 * would double-apply). A failed body is rolled back and rethrown.
 */
export function withTx(db, fn, { mode = 'IMMEDIATE', retries = 6 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec(`BEGIN ${mode}`);
    } catch (err) {
      if (isBusyError(err) && attempt < retries) {
        sleepSync(Math.min(30 * 2 ** attempt, 800));
        continue;
      }
      throw err;
    }
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        /* transaction already resolved */
      }
      throw err;
    }
  }
}

export function audit(db, source, kind, detail = '') {
  db.prepare(
    'INSERT INTO audit_log(at, source, kind, detail) VALUES (?, ?, ?, ?)',
  ).run(nowIso(), source, kind, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

export function scalar(db, sql, ...params) {
  const row = db.prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
}

export function isoAgo(ms, now = Date.now()) {
  return new Date(now - ms).toISOString();
}

/** Milliseconds since an ISO timestamp; null when absent or unparseable. */
export function ageMs(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : now - t;
}

/**
 * Issue a single-use intent token for the next handling write on `orderId`.
 * The guard trigger refuses any non-NULL -> different value change without
 * one, so every writer (modern service, backfill, rollback) goes through here.
 * Caller must hold a transaction; the token is removed on success or failure.
 */
export function withHandlingIntent(db, { orderId, value, origin, actor, note = '' }, fn) {
  db.prepare(
    `INSERT OR REPLACE INTO handling_intent (order_id, value, origin, actor, note, issued_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(orderId, value, origin, actor, note, nowIso());
  try {
    return fn();
  } finally {
    db.prepare('DELETE FROM handling_intent WHERE order_id = ?').run(orderId);
  }
}

/** Turn an internal failure into the JSON shape every HTTP surface returns. */
export function errorPayload(err, extra = {}) {
  const token = err?.token ?? sqliteToken(err) ?? 'E_INTERNAL';
  const message = err?.message ?? String(err);
  const detail = err?.extra ? { detail: err.extra } : {};
  return { ok: false, token, message, ...extra, ...detail };
}

/** Standard status code for a domain/DB failure, so every surface agrees. */
export function statusFor(err) {
  if (err?.status) return err.status;
  const token = sqliteToken(err);
  if (token === 'BUSY') return 503;
  if (token) return 409;
  return 500;
}
