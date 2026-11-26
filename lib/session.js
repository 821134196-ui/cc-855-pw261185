import { nowIso, scalar, withTx } from './db.js';

/**
 * Session registry shared by the two service generations.
 *
 * A session is "alive" while it heartbeats and has not marked itself stopped.
 * The contract gate uses heartbeat age (activeWindowMs) and the last domain
 * write (drainWindowMs); every service process and the rehearsal probes write
 * through this module so the gate cannot be fooled by a process that forgot to
 * register.
 *
 * Writes here use short IMMEDIATE transactions with retry, so a heartbeat never
 * blocks a batch repair for long.
 */
export function registerSession(db, { sessionId, generation, role, baseUrl = '', pid = null, note = '' }) {
  withTx(db, () => {
    db.prepare(
      `INSERT INTO client_sessions
         (session_id, generation, pid, base_url, role, started_at, last_seen_at, stopped_at, writes, inserts, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         last_seen_at = excluded.last_seen_at,
         stopped_at = NULL,
         stop_reason = NULL,
         note = excluded.note`,
    ).run(sessionId, generation, pid, baseUrl, role, nowIso(), nowIso(), note);
  });
}

export function heartbeat(db, sessionId, { role = null } = {}) {
  withTx(db, () => {
    db.prepare('UPDATE client_sessions SET last_seen_at = ? WHERE session_id = ?').run(nowIso(), sessionId);
    if (role) db.prepare('UPDATE client_sessions SET role = ? WHERE session_id = ?').run(role, sessionId);
  });
}

/** Record one domain write (not a heartbeat) so the drain window is real. */
export function recordWrite(db, sessionId, { inserts: isInsert = false, count = 1 } = {}) {
  withTx(db, () => {
    db.prepare(
      `UPDATE client_sessions
          SET last_write_at = ?,
              writes = writes + ?,
              inserts = inserts + ?
        WHERE session_id = ?`,
    ).run(nowIso(), count, isInsert ? count : 0, sessionId);
  });
}

/** Age of the newest write by any v1 session (null when there has been none). */
export function legacyQuietMs(db, now = Date.now()) {
  const iso = lastLegacyWrite(db);
  return ageMs(iso, now);
}

export function stopSession(db, sessionId, reason = 'graceful') {
  withTx(db, () => {
    db.prepare(
      `UPDATE client_sessions
          SET stopped_at = ?, stop_reason = ?, last_seen_at = ?
        WHERE session_id = ?`,
    ).run(nowIso(), reason, nowIso(), sessionId);
  });
}

export function listSessions(db) {
  return db
    .prepare(
      `SELECT session_id, generation, role, pid, base_url, started_at, last_seen_at,
              last_write_at, stopped_at, stop_reason, writes, inserts, note
         FROM client_sessions
        ORDER BY generation, started_at`,
    )
    .all();
}

/** Count of v1 sessions that heartbeat inside the active window and never stopped. */
export function liveLegacySessions(db, activeWindowMs, now = Date.now()) {
  const cutoff = new Date(now - activeWindowMs).toISOString();
  return scalar(
    db,
    `SELECT COUNT(*) FROM client_sessions
      WHERE generation = 'v1' AND stopped_at IS NULL AND last_seen_at >= ?`,
    cutoff,
  );
}

/** Most recent v1 domain write across all sessions, stopped ones included. */
export function lastLegacyWrite(db) {
  return scalar(
    db,
    `SELECT MAX(last_write_at) FROM client_sessions WHERE generation = 'v1'`,
  );
}
