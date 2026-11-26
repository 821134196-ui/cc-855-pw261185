import {
  BASELINE_INDEX_DDL,
  CONTRACTED_ORDERS_DDL,
  CONTRACTED_TRIGGERS,
  DEFAULT_HANDLING,
  EXPANDED_COLUMN_CHECK,
  EXPANDED_TRIGGERS,
  HANDLING_VALUES,
  INTENT_DDL,
  META_DDL,
  ORIGINS,
  PRE_CONTRACT_VALUES,
  PROVENANCE_DDL,
  REQUIRED_COLUMN,
  SENTINEL,
  TRIGGER_NAMES,
} from './schema.js';
import {
  ageMs,
  audit,
  closeDb,
  nowIso,
  openDb,
  scalar,
  sqliteToken,
  withHandlingIntent,
  withTx,
} from './db.js';
import { backupDatabase } from './seed.js';

export class MigrationError extends Error {
  constructor(token, message, status = 409, extra = {}) {
    super(message);
    this.token = token;
    this.status = status;
    this.extra = extra;
  }
}

export const MIGRATION_ID = 'add-orders-handling-v1';

/* ------------------------------------------------------------------ reads */

export function readState(db) {
  return db.prepare('SELECT * FROM migration_state WHERE id = 1').get() ?? null;
}

export function requiredColumnInfo(db) {
  const cols = db.prepare('PRAGMA table_info(orders)').all();
  const col = cols.find((c) => c.name === REQUIRED_COLUMN);
  return {
    exists: Boolean(col),
    notNull: Boolean(col?.notnull),
    declaredDefault: col?.dflt_value ?? null,
  };
}

export function triggerNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type='trigger'")
    .all()
    .map((r) => r.name)
    .sort();
}

export function countPending(db) {
  return scalar(
    db,
    `SELECT COUNT(*) FROM orders
      WHERE ${REQUIRED_COLUMN} IS NULL OR ${REQUIRED_COLUMN} = ?`,
    SENTINEL,
  );
}

export function pendingIds(db, limit) {
  return db
    .prepare(
      `SELECT id FROM orders
        WHERE ${REQUIRED_COLUMN} IS NULL OR ${REQUIRED_COLUMN} = ?
        ORDER BY id LIMIT ?`,
    )
    .all(SENTINEL, limit)
    .map((r) => r.id);
}

/** One snapshot of the required column: values, provenance, and pending work. */
export function columnSnapshot(db) {
  const info = requiredColumnInfo(db);
  const total = scalar(db, 'SELECT COUNT(*) FROM orders');
  const state = readState(db);
  if (!info.exists) {
    return {
      phase: state?.phase ?? 'baseline',
      column: info,
      total,
      pending: total,
      rows: [],
      stats: {
        total,
        nullRows: total,
        sentinelRows: 0,
        realRows: 0,
        pending: total,
        byOrigin: { legacy_default: 0, backfill: 0, modern: 0, rollback: 0 },
        withoutProvenance: 0,
        intent: 0,
      },
    };
  }
  const rows = db
    .prepare(
      `SELECT o.id, o.ref, o.priority, o.${REQUIRED_COLUMN} AS value,
              p.origin, p.actor, p.at, p.note AS provenanceNote,
              EXISTS(SELECT 1 FROM handling_intent i WHERE i.order_id = o.id) AS hasIntent
         FROM orders o
         LEFT JOIN handling_provenance p ON p.order_id = o.id
        ORDER BY o.id DESC`,
    )
    .all()
    .map((r) => ({ ...r, pending: r.value === null || r.value === SENTINEL }));

  const byOrigin = { legacy_default: 0, backfill: 0, modern: 0, rollback: 0 };
  for (const r of rows) if (r.origin && byOrigin[r.origin] !== undefined) byOrigin[r.origin] += 1;

  return {
    phase: state?.phase ?? 'expanded',
    column: info,
    total: rows.length,
    pending: rows.filter((r) => r.pending).length,
    rows,
    stats: {
      total: rows.length,
      nullRows: rows.filter((r) => r.value === null).length,
      sentinelRows: rows.filter((r) => r.value === SENTINEL).length,
      realRows: rows.filter((r) => r.value !== null && r.value !== SENTINEL).length,
      pending: rows.filter((r) => r.pending).length,
      byOrigin,
      withoutProvenance: rows.filter((r) => r.origin === null).length,
      intent: rows.filter((r) => r.hasIntent).length,
    },
  };
}

export function batches(db, limit = 60) {
  return db.prepare('SELECT * FROM migration_batches ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

export function auditTrail(db, limit = 40) {
  return db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
}

/* ---------------------------------------------------------------- writes */

function preamble(db, phase, patch = {}) {
  const stamp = {};
  for (const [k, v] of Object.entries(patch)) stamp[k] = v === true ? nowIso() : v;
  db.prepare(
    `UPDATE migration_state SET
       phase = ?, migration_id = ?, updated_at = ?,
       expansion_started_at = COALESCE(?, expansion_started_at),
       backfill_started_at  = COALESCE(?, backfill_started_at),
       validated_at         = COALESCE(?, validated_at),
       contracted_at        = COALESCE(?, contracted_at),
       rolled_back_at       = COALESCE(?, rolled_back_at),
       notes                = COALESCE(?, notes)
     WHERE id = 1`,
  ).run(
    phase,
    MIGRATION_ID,
    nowIso(),
    stamp.expansion_started_at ?? null,
    stamp.backfill_started_at ?? null,
    stamp.validated_at ?? null,
    stamp.contracted_at ?? null,
    stamp.rolled_back_at ?? null,
    stamp.notes ?? null,
  );
}

function createMeta(db) {
  for (const ddl of META_DDL) db.exec(ddl);
  if (!db.prepare('SELECT id FROM migration_state WHERE id = 1').get()) {
    db.prepare(
      `INSERT INTO migration_state (id, phase, migration_id, updated_at, notes)
       VALUES (1, 'baseline', ?, ?, 'fresh database')`,
    ).run(MIGRATION_ID, nowIso());
  }
}

function dropTriggers(db) {
  for (const name of TRIGGER_NAMES) db.exec(`DROP TRIGGER IF EXISTS ${name}`);
}

/* ------------------------------------------------------------- expand step */

/**
 * Additive and backward compatible: the column arrives nullable with an
 * interim sentinel, with a fill trigger for v1 inserts and a guard that makes
 * every rewrite of an existing value carry an explicit intent.
 *
 * Existing rows are deliberately NOT given a default here — that is the
 * batched repair's job, and keeping them NULL is what makes the progress
 * observable (and what a rollback returns to).
 */
export function expand(db) {
  return withTx(db, () => {
    createMeta(db);
    const state = readState(db);
    const info = requiredColumnInfo(db);

    if (['expanded', 'backfilled', 'validated'].includes(state.phase)) {
      return { already: true, step: 'expand', phase: state.phase };
    }
    if (state.phase === 'contracted' || (info.exists && info.notNull)) {
      throw new MigrationError(
        'E_ALREADY_CONTRACTED',
        'orders.handling is already required; expand would loosen the contract',
      );
    }

    const legacyRows = scalar(db, 'SELECT COUNT(*) FROM orders');
    if (!info.exists) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${REQUIRED_COLUMN} TEXT ${EXPANDED_COLUMN_CHECK}`);
    }
    db.exec(PROVENANCE_DDL);
    db.exec(INTENT_DDL);
    dropTriggers(db);
    for (const ddl of EXPANDED_TRIGGERS) db.exec(ddl);

    preamble(db, 'expanded', { expansion_started_at: true });
    audit(
      db,
      'cli',
      'migrate.expand',
      JSON.stringify({
        column: REQUIRED_COLUMN,
        nullable: true,
        interimValues: PRE_CONTRACT_VALUES,
        legacyRowsLeftPending: legacyRows,
        triggers: EXPANDED_TRIGGERS.length,
      }),
    );
    return { already: false, step: 'expand', phase: 'expanded', legacyRows };
  });
}

/* ----------------------------------------------------------- backfill step */

/**
 * Give every still-pending row a real default, one id-ordered batch per
 * IMMEDIATE transaction. The lock is released between batches so both service
 * generations keep reading and writing throughout.
 *
 * Rows that a modern writer already filled (or that v1 inserted with an
 * explicit value) are not pending and are never selected. A row that a v1
 * client inserts mid-backfill carries the sentinel and is picked up by a later
 * batch — that is the concurrent-writer path this rehearsal exercises.
 */
export function backfill(db, { batchSize = 25, maxBatches = Infinity, onBatch } = {}) {
  const state = readState(db);
  if (!state) throw new MigrationError('E_NOT_SEEDED', 'database is not seeded', 500);
  if (state.phase === 'contracted') {
    throw new MigrationError('E_ALREADY_CONTRACTED', 'column is already required; nothing to repair');
  }
  const info = requiredColumnInfo(db);
  if (state.phase === 'baseline' || !info.exists) {
    throw new MigrationError('E_NOT_EXPANDED', 'run expand first');
  }

  const size = Math.max(1, Number(batchSize) || 25);
  const initial = countPending(db);
  if (initial === 0) {
    withTx(db, () => {
      if (readState(db).phase === 'expanded') preamble(db, 'backfilled', { backfill_started_at: true });
      audit(db, 'cli', 'migrate.backfill', JSON.stringify({ attempted: 0, filled: 0, noop: true }));
    });
    return { attempted: 0, filled: 0, blocked: 0, remaining: 0, batches: 0, noop: true, initial };
  }

  let attempted = 0;
  let filled = 0;
  let blocked = 0;
  let batchNo = 0;
  const startedPhase = state.phase;
  const runAll = maxBatches === Infinity;

  for (;;) {
    if (batchNo >= maxBatches) break;
    const ids = pendingIds(db, size);
    if (ids.length === 0) break;
    batchNo += 1;
    const started = nowIso();
    const result = withTx(db, () => {
      let n = 0;
      let refused = 0;
      for (const id of ids) {
        try {
          withHandlingIntent(
            db,
            {
              orderId: id,
              value: DEFAULT_HANDLING,
              origin: ORIGINS.BACKFILL,
              actor: 'backfill',
              note: 'batch default fill',
            },
            () => {
              // Re-check the predicate under the write lock: a concurrent
              // modern write may have landed since the id list was read.
              const changed = db
                .prepare(
                  `UPDATE orders SET ${REQUIRED_COLUMN} = ?
                    WHERE id = ? AND (${REQUIRED_COLUMN} IS NULL OR ${REQUIRED_COLUMN} = ?)
                    RETURNING id`,
                )
                .get(DEFAULT_HANDLING, id, SENTINEL);
              if (changed) n += 1;
            },
          );
        } catch (err) {
          // A writer that already gave the row a real value (or a guard
          // refusal) is not a failure of the batch; record and move on.
          const token = sqliteToken(err);
          if (!['E_DEFAULT_OVER_MODERN', 'E_OVERWRITE_WITHOUT_INTENT'].includes(token)) throw err;
          refused += 1;
        }
      }
      return { n, refused, remaining: countPending(db) };
    });
    attempted += ids.length;
    filled += result.n;
    blocked += result.refused;
    withTx(db, () => {
      db.prepare(
        `INSERT INTO migration_batches
           (migration_id, kind, started_at, finished_at, attempted, filled, blocked, remaining, status, detail)
         VALUES (?, 'backfill', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        MIGRATION_ID,
        started,
        nowIso(),
        ids.length,
        result.n,
        result.refused,
        result.remaining,
        result.n === ids.length ? 'filled' : 'partial',
        `ids ${ids[0]}–${ids[ids.length - 1]}`,
      );
    });
    if (onBatch) {
      onBatch({ batchNo, attempted: ids.length, filled: result.n, blocked: result.refused, remaining: result.remaining });
    }
    if (!runAll && batchNo >= maxBatches) break;
  }

  withTx(db, () => {
    if (['expanded', 'backfilled'].includes(readState(db).phase)) {
      preamble(db, 'backfilled', { backfill_started_at: true });
    }
    audit(
      db,
      'cli',
      'migrate.backfill',
      JSON.stringify({ attempted, filled, blocked, remaining: countPending(db), batchSize: size, from: startedPhase }),
    );
  });
  return { attempted, filled, blocked, remaining: countPending(db), batches: batchNo, noop: false, initial };
}

/* ----------------------------------------------------- contract preflight */

/**
 * Contract is allowed only when ALL of these hold:
 *  - phase is backfilled/validated,
 *  - no row is still pending,
 *  - no v1 session heartbeating inside the active window,
 *  - no v1 write (any session, stopped or not) inside the drain window,
 *  - no dangling intent token.
 *
 * The gate has no override: an operator who wants to move faster must make
 * the old generation quiet, not flag it away.
 */
export function contractPreflight(db, cfg, { now = Date.now() } = {}) {
  const state = readState(db);
  const info = requiredColumnInfo(db);
  const pending = info.exists ? countPending(db) : 0;

  const cutoff = new Date(now - cfg.activeWindowMs).toISOString();
  const liveLegacy = scalar(
    db,
    `SELECT COUNT(*) FROM client_sessions
      WHERE generation = 'v1' AND stopped_at IS NULL AND last_seen_at >= ?`,
    cutoff,
  );
  const lastLegacyWrite = scalar(
    db,
    `SELECT MAX(last_write_at) FROM client_sessions WHERE generation = 'v1'`,
  );
  const quietMs = ageMs(lastLegacyWrite, now);
  const danglingIntent = scalar(db, 'SELECT COUNT(*) FROM handling_intent');
  const sessions = db
    .prepare(
      `SELECT session_id, generation, role, stopped_at, last_seen_at, last_write_at
         FROM client_sessions WHERE generation = 'v1' ORDER BY started_at`,
    )
    .all();

  const checks = [];
  const add = (code, ok, text, value = null) => checks.push({ code, ok, text, value });

  add(
    'E_WRONG_PHASE',
    !state || ['backfilled', 'validated'].includes(state.phase),
    state ? `phase is '${state.phase}'` : 'database is not seeded',
    state?.phase ?? null,
  );
  add('E_PENDING_ROWS', info.exists && pending === 0, `${pending} row(s) still have no real value`, pending);
  add(
    'E_LEGACY_CLIENTS_ACTIVE',
    liveLegacy === 0,
    `${liveLegacy} v1 session(s) alive within the last ${cfg.activeWindowMs} ms`,
    liveLegacy,
  );
  add(
    'E_DRAIN_NOT_SATISFIED',
    quietMs === null || quietMs >= cfg.drainWindowMs,
    quietMs === null
      ? 'no v1 write on record'
      : `last v1 write ${Math.round(quietMs)} ms ago; ${cfg.drainWindowMs} ms quiet required`,
    quietMs,
  );
  add('E_DANGLING_INTENT', danglingIntent === 0, `${danglingIntent} dangling intent token(s)`, danglingIntent);
  add('E_COLUMN_MISSING', info.exists, 'orders.handling column does not exist', info.exists);

  const blocking = checks.filter((c) => !c.ok);
  return {
    allowed: blocking.length === 0,
    checks,
    reasons: blocking.map((c) => ({ code: c.code, text: c.text })),
    observedAt: new Date(now).toISOString(),
    phase: state?.phase ?? null,
    pendingRows: pending,
    liveLegacySessions: liveLegacy,
    lastLegacyWriteAt: lastLegacyWrite,
    quietMs,
    drainWindowMs: cfg.drainWindowMs,
    activeWindowMs: cfg.activeWindowMs,
    sessions,
  };
}

/* ----------------------------------------------------------- contract step */

export function contract(db, cfg, { now = Date.now(), source = 'cli' } = {}) {
  const pre = contractPreflight(db, cfg, { now });
  if (!pre.allowed) {
    // Refusals are part of the operational record, not just an HTTP 409: the
    // ops page and the rehearsal transcript both read this.
    withTx(db, () => {
      audit(
        db,
        source,
        'migrate.contract_refused',
        JSON.stringify({ reasons: pre.reasons.map((r) => r.code), pending: pre.pendingRows }),
      );
    });
    throw new MigrationError(
      'E_CONTRACT_REFUSED',
      'contract refused: ' + pre.reasons.map((r) => r.text).join('; '),
      409,
      { preflight: pre },
    );
  }
  const snap = columnSnapshot(db);
  if (snap.stats.pending !== 0) {
    throw new MigrationError('E_PENDING_ROWS', `${snap.stats.pending} row(s) still pending`);
  }
  const backup = cfg.skipBackup ? null : backupDatabase(cfg, 'pre-contract');
  return contractRebuild(db, { pre, backup, source });
}

/**
 * Rebuild the table to make the column required.
 *
 * Two SQLite facts drive the shape of this function, both verified against the
 * bundled engine:
 *  - `PRAGMA foreign_keys=OFF` is a no-op inside a transaction, so it must be
 *    toggled around the transaction. With FKs left on, `DROP TABLE orders`
 *    would cascade-delete every provenance/intent child row.
 *  - Dropping the table drops its triggers and its sqlite_sequence entry; both
 *    are recreated after the rename, and the sequence is pinned to MAX(id).
 */
export function contractRebuild(db, { pre, expectedRows = null, backup, source = 'cli' }) {
  const started = nowIso();
  const oldPhase = readState(db)?.phase;

  const fkWasOn = Boolean(scalar(db, 'PRAGMA foreign_keys'));
  db.exec('PRAGMA foreign_keys=OFF');
  let committed = false;
  try {
    withTx(db, () => {
      // The row count must be read under the write lock. A modern insert that
      // committed between the preflight and this transaction is legitimate
      // and must be carried through, not treated as a mismatch.
      const expected = expectedRows ?? scalar(db, 'SELECT COUNT(*) FROM orders');
      if (countPending(db) !== 0) {
        throw new MigrationError('E_PENDING_ROWS', 'pending rows appeared inside the contract transaction');
      }
      createMeta(db);
      dropTriggers(db);
      db.exec(CONTRACTED_ORDERS_DDL);
      db.exec(
        `INSERT INTO orders_new (id, ref, customer, amount_cents, priority, status, created_at, handling)
         SELECT id, ref, customer, amount_cents, priority, status, created_at, handling FROM orders`,
      );
      db.exec('DROP TABLE orders');
      db.exec('ALTER TABLE orders_new RENAME TO orders');
      db.exec(BASELINE_INDEX_DDL);
      const maxId = scalar(db, 'SELECT MAX(id) FROM orders') ?? 0;
      if (db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").get()) {
        const seqRow = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='orders'").get();
        if (!seqRow) {
          db.prepare("INSERT INTO sqlite_sequence(name, seq) VALUES('orders', ?)").run(maxId);
        } else if (Number(seqRow.seq) < maxId) {
          db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name='orders'").run(maxId);
        }
      }
      for (const ddl of CONTRACTED_TRIGGERS) db.exec(ddl);

      const after = columnSnapshot(db);
      if (after.stats.nullRows !== 0 || after.stats.sentinelRows !== 0) {
        throw new MigrationError('E_CONTRACT_INCOMPLETE', 'contract left NULL or sentinel values');
      }
      if (after.stats.total !== expected) {
        throw new MigrationError(
          'E_ROW_COUNT_MISMATCH',
          `expected ${expected} rows after contract, found ${after.stats.total}`,
        );
      }
      if (after.stats.withoutProvenance !== 0) {
        throw new MigrationError(
          'E_PROVENANCE_LOST',
          `${after.stats.withoutProvenance} row(s) lost their provenance during the rebuild`,
        );
      }

      preamble(db, 'contracted', { validated_at: true, contracted_at: true });
      db.prepare(
        `INSERT INTO migration_batches
           (migration_id, kind, started_at, finished_at, attempted, filled, blocked, remaining, status, detail)
         VALUES (?, 'contract', ?, ?, ?, 0, 0, 0, 'ok', ?)`,
      ).run(MIGRATION_ID, started, nowIso(), after.stats.total, `backup=${backup?.file ?? 'none'}`);
      committed = true;
      return after;
    });
  } finally {
    if (fkWasOn) db.exec('PRAGMA foreign_keys=ON');
  }

  // Child tables reference orders by name, so they survive the rename; verify
  // that with FKs re-enabled now that the transaction has committed.
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length > 0) {
    throw new MigrationError('E_FK_VIOLATIONS', `${violations.length} foreign key violation(s) after contract`);
  }
  if (!committed) throw new MigrationError('E_CONTRACT_INCOMPLETE', 'contract transaction did not commit');

  const after = columnSnapshot(db);
  audit(
    db,
    source,
    'migrate.contract',
    JSON.stringify({
      rows: after.stats.total,
      fromPhase: oldPhase,
      preflight: { allowed: pre?.allowed ?? true, reasons: (pre?.reasons ?? []).map((r) => r.code) },
      backup: backup?.file ?? null,
      foreignKeyViolations: 0,
      allowedValues: HANDLING_VALUES,
    }),
  );
  return {
    ok: true,
    rows: after.stats.total,
    backup: backup?.file ?? null,
    column: requiredColumnInfo(db),
    provenance: after.stats.byOrigin,
  };
}

/* --------------------------------------------------------------- rollback */

/**
 * Undo the interim defaults: every row whose current value came from a default
 * origin (legacy fill, batch repair, earlier rollback) goes back to NULL and
 * becomes pending again.
 *
 * Values written by the modern generation are excluded by the predicate AND
 * refused by the trigger guard. Reverting is pointer-sized work: it never
 * invents a replacement value, so the "repair" can legitimately be re-run.
 */
export function rollbackDefaults(db, { actor = 'cli', batchSize = 25, maxBatches = Infinity } = {}) {
  const state = readState(db);
  if (state?.phase === 'contracted') {
    throw new MigrationError(
      'E_ALREADY_CONTRACTED',
      'the column is required now; a rollback needs a new expand/repair cycle, not a value rewrite',
    );
  }
  if (!requiredColumnInfo(db).exists) {
    throw new MigrationError('E_NOT_EXPANDED', 'no handling column to roll back');
  }

  const size = Math.max(1, Number(batchSize) || 25);
  let reverted = 0;
  const blocked = [];
  let batchNo = 0;

  for (;;) {
    if (batchNo >= maxBatches) break;
    const ids = db
      .prepare(
        `SELECT o.id FROM orders o
           JOIN handling_provenance p ON p.order_id = o.id
          WHERE o.${REQUIRED_COLUMN} IS NOT NULL
            AND p.origin IN ('legacy_default','backfill','rollback')
          ORDER BY o.id LIMIT ?`,
      )
      .all(size)
      .map((r) => r.id);
    if (ids.length === 0) break;
    batchNo += 1;
    const started = nowIso();
    const result = withTx(db, () => {
      let n = 0;
      const refused = [];
      for (const id of ids) {
        try {
          withHandlingIntent(
            db,
            { orderId: id, value: null, origin: ORIGINS.ROLLBACK, actor, note: 'revert interim default to NULL' },
            () => {
              const row = db
                .prepare(`UPDATE orders SET ${REQUIRED_COLUMN} = NULL WHERE id = ? RETURNING id`)
                .get(id);
              if (row) n += 1;
            },
          );
        } catch (err) {
          refused.push({ id, token: sqliteToken(err) ?? err.message });
        }
      }
      if (['expanded', 'backfilled', 'validated'].includes(readState(db).phase)) {
        preamble(db, 'expanded', { rolled_back_at: true });
      }
      db.prepare(
        `INSERT INTO migration_batches
           (migration_id, kind, started_at, finished_at, attempted, filled, blocked, remaining, status, detail)
         VALUES (?, 'rollback', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        MIGRATION_ID,
        started,
        nowIso(),
        ids.length,
        n,
        refused.length,
        countPending(db),
        refused.length ? 'partial' : 'ok',
        `ids ${ids[0]}–${ids[ids.length - 1]}`,
      );
      return { n, refused };
    });
    reverted += result.n;
    blocked.push(...result.refused);
  }

  withTx(db, () => {
    audit(db, actor, 'migrate.rollback', JSON.stringify({ reverted, blocked, batches: batchNo }));
  });
  return { reverted, blocked, noop: reverted === 0, remaining: countPending(db), batches: batchNo };
}

/**
 * Deliberately unsafe default sweep: a careless operator tries to push every
 * row back to the interim sentinel with one wrong predicate and no care for
 * provenance. The point of the demo is that the DATABASE refuses each row
 * whose value the modern service wrote — the operator's cooperation is not
 * what protects the data.
 *
 * Per-row statements are used (not one bulk UPDATE) because a SQLite
 * statement is all-or-nothing: a bulk sweep would abort on the first modern
 * row and hide the fact that it *would* have reverted the others.
 */
export function unsafeDefaultSweep(db, { actor = 'cli' } = {}) {
  const info = requiredColumnInfo(db);
  if (!info.exists) throw new MigrationError('E_NOT_EXPANDED', 'no handling column to sweep');
  const state = readState(db);
  if (state?.phase === 'contracted') {
    throw new MigrationError('E_ALREADY_CONTRACTED', 'column is required; a sweep would violate NOT NULL');
  }

  const targets = db
    .prepare(`SELECT id FROM orders WHERE ${REQUIRED_COLUMN} IS NOT NULL AND ${REQUIRED_COLUMN} <> ?`)
    .all(SENTINEL)
    .map((r) => r.id);

  return withTx(db, () => {
    let reverted = 0;
    const blocked = [];
    for (const id of targets) {
      try {
        // Issue an intent so the sweep gets past the "intent required" rule
        // and reaches the guard rule this demo is actually about.
        withHandlingIntent(
          db,
          { orderId: id, value: SENTINEL, origin: ORIGINS.BACKFILL, actor, note: 'unsafe sweep' },
          () => {
            db.prepare(`UPDATE orders SET ${REQUIRED_COLUMN} = ? WHERE id = ?`).run(SENTINEL, id);
            reverted += 1;
          },
        );
      } catch (err) {
        blocked.push({ id, token: sqliteToken(err) ?? err.message });
      }
    }
    db.prepare(
      `INSERT INTO migration_batches
         (migration_id, kind, started_at, finished_at, attempted, filled, blocked, remaining, status, detail)
       VALUES (?, 'rollback', ?, ?, ?, ?, ?, ?, ?, 'unsafe sweep over every non-NULL row')`,
    ).run(
      MIGRATION_ID,
      nowIso(),
      nowIso(),
      targets.length,
      reverted,
      blocked.length,
      countPending(db),
      blocked.length ? 'partial' : 'ok',
    );
    audit(db, actor, 'migrate.unsafe_sweep', JSON.stringify({ attempted: targets.length, reverted, blocked }));
    return { attempted: targets.length, reverted, blocked, remaining: countPending(db) };
  });
}

/* --------------------------------------------------------------- validate */

export function validate(db) {
  return withTx(db, () => {
    const snap = columnSnapshot(db);
    const problems = [];
    if (!snap.column.exists) problems.push('column missing');
    if (snap.column.notNull) problems.push('column is already required (contract already ran)');
    if (snap.stats.pending > 0) problems.push(`${snap.stats.pending} pending row(s)`);
    if (snap.stats.withoutProvenance > 0) problems.push(`${snap.stats.withoutProvenance} row(s) without provenance`);
    if (snap.stats.nullRows !== 0 && snap.column.notNull) problems.push('NULL rows in a required column');
    const dangling = scalar(db, 'SELECT COUNT(*) FROM handling_intent');
    if (dangling > 0) problems.push(`${dangling} dangling intent token(s)`);
    const badValues = snap.rows.filter(
      (r) => r.value !== null && !PRE_CONTRACT_VALUES.includes(r.value),
    ).length;
    if (badValues > 0) problems.push(`${badValues} value(s) outside the allowed set`);
    if (problems.length) {
      throw new MigrationError('E_VALIDATION_FAILED', problems.join('; '), 409, { problems });
    }
    const phase = readState(db)?.phase;
    if (phase === 'expanded' || phase === 'backfilled') {
      preamble(db, 'validated', { validated_at: true });
    }
    audit(db, 'cli', 'migrate.validate', JSON.stringify({ rows: snap.stats.total, phase }));
    return { ok: true, rows: snap.stats.total, phase: readState(db).phase };
  });
}

/* ------------------------------------------------------------ one-shot API */

export function withDb(cfg, fn) {
  const db = openDb(cfg);
  try {
    return fn(db);
  } finally {
    closeDb(db);
  }
}

export { DEFAULT_HANDLING, SENTINEL, REQUIRED_COLUMN };

/**
 * Write an explicit handling value on one order, as a client that knows the
 * column would. Used by the modern service and by probes. Caller must already
 * hold `db` open; the function opens its own transaction.
 *
 * `origin: 'modern'` marks this as a modern write for the rollback guard. The
 * guard only allows the change when the intent's value matches, so a correction
 * of a previously modern-written row is fine — the intent carries the writer's
 * identity, not a blanket permission.
 */
export function setHandling(db, { orderId, value, actor = 'v2', note = '' }) {
  if (!HANDLING_VALUES.includes(value)) {
    throw new MigrationError(
      'E_BAD_VALUE',
      `handling must be one of ${HANDLING_VALUES.join(', ')}`,
      400,
    );
  }
  return withTx(db, () => {
    // Check the row before issuing an intent: the intent table carries a FK to
    // orders, so an unknown id would otherwise surface as a constraint error
    // instead of the 404 the API promises.
    const exists = db.prepare('SELECT id FROM orders WHERE id = ?').get(idSafe(orderId));
    if (!exists) return null;
    return withHandlingIntent(
      db,
      { orderId: exists.id, value, origin: ORIGINS.MODERN, actor, note },
      () => {
        const row = db
          .prepare(
            `UPDATE orders SET ${REQUIRED_COLUMN} = ? WHERE id = ? RETURNING id, ${REQUIRED_COLUMN} AS value`,
          )
          .get(value, exists.id);
        return row ?? null;
      },
    );
  });
}

function idSafe(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new MigrationError('E_BAD_ORDER_ID', 'order id must be a positive integer', 400);
  }
  return n;
}
