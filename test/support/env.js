import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../lib/config.js';
import { openDb } from '../../lib/db.js';
import { seedDatabase } from '../../lib/seed.js';

/**
 * Throwaway database per test file. Windows are small so the gate tests do
 * not have to wait 10 s; skipBackup keeps contract tests from writing a cold
 * copy of a temp database for every case.
 */
export function makeEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-test-'));
  const cfg = loadConfig({
    DB_PATH: path.join(dir, 'test.db'),
    ACTIVE_WINDOW_MS: '1500',
    DRAIN_WINDOW_MS: '800',
    HEARTBEAT_MS: '500',
    BATCH_SIZE: '4',
    ...overrides,
  });
  cfg.skipBackup = true;
  return {
    cfg,
    open({ legacyRows = 12 } = {}) {
      seedDatabase(cfg, { reset: true, legacyRows });
      return openDb(cfg);
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Exactly what the v1 service does: insert every column except handling. */
export function v1Insert(db, customer = 'Legacy Co') {
  return db
    .prepare(
      `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
       VALUES (?, ?, 25000, 'normal', 'open', ?) RETURNING id`,
    )
    .get(`V1-${Math.random().toString(36).slice(2, 10)}`, customer, new Date().toISOString()).id;
}

export function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

/** Age a session's heartbeat/write without going through the service layer. */
export function backdateSession(db, sessionId, { seenMsAgo = 0, writeMsAgo = null } = {}) {
  db.prepare('UPDATE client_sessions SET last_seen_at = ? WHERE session_id = ?').run(
    isoAgo(seenMsAgo),
    sessionId,
  );
  if (writeMsAgo !== null) {
    db.prepare('UPDATE client_sessions SET last_write_at = ? WHERE session_id = ?').run(
      isoAgo(writeMsAgo),
      sessionId,
    );
  }
}

export function provenanceOf(db, orderId) {
  return db.prepare('SELECT * FROM handling_provenance WHERE order_id = ?').get(orderId) ?? null;
}

export function handlingOf(db, orderId) {
  return db.prepare('SELECT handling FROM orders WHERE id = ?').get(orderId)?.handling ?? null;
}
