/**
 * Domain vocabulary and DDL for the rehearsal.
 *
 * The one required column being added is `orders.handling` (an order's
 * handling class). Lifecycle:
 *
 *   baseline    no column at all; only v1 writes
 *   expanded    column exists, nullable, accepts interim sentinel 'unassigned';
 *               v1 inserts are filled with the sentinel by a trigger, and every
 *               later rewrite of an existing value needs an intent token
 *   backfilled  pre-existing rows repaired in batches to a real default value
 *   validated   no pending rows, provenance complete
 *   contracted  table rebuilt: NOT NULL, real values only, v1 inserts now fail
 *
 * A default may never overwrite a value written by the modern generation —
 * enforced by the trigger guard, not only by the rollback predicate.
 */
export const REQUIRED_COLUMN = 'handling';
export const SENTINEL = 'unassigned';
export const HANDLING_VALUES = ['low', 'normal', 'high', 'critical'];
export const PRE_CONTRACT_VALUES = [...HANDLING_VALUES, SENTINEL];

/** Value the batched repair gives pre-existing rows that carry none. */
export const DEFAULT_HANDLING = 'normal';
export const INTENT_ORIGINS = ['backfill', 'modern', 'rollback'];
export const ORIGINS = {
  LEGACY_DEFAULT: 'legacy_default',
  BACKFILL: 'backfill',
  MODERN: 'modern',
  ROLLBACK: 'rollback',
};
export const ORIGIN_VALUES = Object.values(ORIGINS);
/** Origins whose value is synthetic and may be reverted. */
export const DEFAULT_ORIGINS = [ORIGINS.LEGACY_DEFAULT, ORIGINS.BACKFILL, ORIGINS.ROLLBACK];

export const PHASES = ['baseline', 'expanded', 'backfilled', 'validated', 'contracted'];

const valueList = (vals) => vals.map((v) => `'${v}'`).join(', ');

export const BASELINE_ORDERS_DDL = `
CREATE TABLE orders (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ref          TEXT NOT NULL UNIQUE,
  customer     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  priority     TEXT NOT NULL CHECK (priority IN ('low','normal','high','critical')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at   TEXT NOT NULL
)`;

export const BASELINE_INDEX_DDL = 'CREATE INDEX orders_created_idx ON orders(created_at)';

export const CONTRACTED_ORDERS_DDL = `
CREATE TABLE orders_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ref          TEXT NOT NULL UNIQUE,
  customer     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  priority     TEXT NOT NULL CHECK (priority IN ('low','normal','high','critical')),
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at   TEXT NOT NULL,
  handling     TEXT NOT NULL CHECK (handling IN ('low','normal','high','critical'))
)`;

export const META_DDL = [
  `CREATE TABLE IF NOT EXISTS migration_state (
    id                   INTEGER PRIMARY KEY CHECK (id = 1),
    phase                TEXT NOT NULL CHECK (phase IN (${valueList(PHASES)})),
    migration_id         TEXT NOT NULL,
    expansion_started_at TEXT,
    backfill_started_at  TEXT,
    validated_at         TEXT,
    contracted_at        TEXT,
    rolled_back_at       TEXT,
    updated_at           TEXT NOT NULL,
    notes                TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS migration_batches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_id TEXT NOT NULL,
    kind         TEXT NOT NULL,          -- 'backfill' | 'rollback' | 'contract'
    started_at   TEXT NOT NULL,
    finished_at  TEXT NOT NULL,
    attempted    INTEGER NOT NULL,
    filled       INTEGER NOT NULL,
    blocked      INTEGER NOT NULL DEFAULT 0,
    remaining    INTEGER NOT NULL,
    status       TEXT NOT NULL,
    detail       TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     TEXT NOT NULL,
    source TEXT NOT NULL,
    kind   TEXT NOT NULL,
    detail TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS client_sessions (
    session_id    TEXT PRIMARY KEY,
    generation    TEXT NOT NULL CHECK (generation IN ('v1','v2')),
    pid           INTEGER,
    base_url      TEXT,
    role          TEXT NOT NULL,         -- 'service' | 'probe'
    started_at    TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    last_write_at TEXT,
    stopped_at    TEXT,
    stop_reason   TEXT,
    writes        INTEGER NOT NULL DEFAULT 0,
    inserts       INTEGER NOT NULL DEFAULT 0,
    note          TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS client_sessions_generation_idx ON client_sessions(generation, last_seen_at)',
  'CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at DESC)',
];

export const PROVENANCE_DDL = `
CREATE TABLE IF NOT EXISTS handling_provenance (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  value    TEXT,
  origin   TEXT NOT NULL CHECK (origin IN (${valueList(ORIGIN_VALUES)})),
  actor    TEXT NOT NULL,
  at       TEXT NOT NULL,
  note     TEXT
)`;

export const INTENT_DDL = `
CREATE TABLE IF NOT EXISTS handling_intent (
  order_id  INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  value     TEXT,
  origin    TEXT NOT NULL CHECK (origin IN (${valueList(INTENT_ORIGINS)})),
  actor     TEXT NOT NULL,
  note      TEXT,
  issued_at TEXT NOT NULL
)`;

export const EXPANDED_COLUMN_CHECK = `CHECK (${REQUIRED_COLUMN} IN (${valueList(
  PRE_CONTRACT_VALUES,
)}) OR ${REQUIRED_COLUMN} IS NULL)`;

/**
 * BEFORE UPDATE guard — the database-level half of the rollback safety rule.
 *
 * 1. Any change away from an existing non-NULL value must carry a single-use
 *    intent token for the exact new value. Nothing, including a batched repair
 *    or a hand-written sweep, can silently rewrite an existing value.
 * 2. A default-origin intent (backfill/rollback/legacy fill) may never land on
 *    a row whose current value was written by the modern service. This holds
 *    even when the caller's WHERE clause is wrong: the deliberately unsafe
 *    "default sweep" is refused row by row with E_DEFAULT_OVER_MODERN, and the
 *    modern value stays put.
 */
export const TRIGGER_GUARD = `
CREATE TRIGGER handling_guard
BEFORE UPDATE OF handling ON orders
WHEN NEW.handling IS NOT OLD.handling
BEGIN
  SELECT RAISE(ABORT, 'E_OVERWRITE_WITHOUT_INTENT')
  WHERE OLD.handling IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM handling_intent i
      WHERE i.order_id = OLD.id AND i.value IS NEW.handling
    );
  SELECT RAISE(ABORT, 'E_DEFAULT_OVER_MODERN')
  WHERE EXISTS (
      SELECT 1 FROM handling_intent i
      WHERE i.order_id = OLD.id
        AND i.origin IN ('backfill','rollback')
    )
    AND EXISTS (
      SELECT 1 FROM handling_provenance p
      WHERE p.order_id = OLD.id AND p.origin = 'modern'
    );
END`;

/**
 * AFTER UPDATE provenance. When an intent is present it names the origin and
 * actor and is consumed. An un-intended NULL -> sentinel transition is the
 * expand fill for a v1 insert; any other unintended transition is recorded as
 * an unidentified writer (it can only be a NULL -> value first write).
 */
export const TRIGGER_PROVENANCE_UPDATE = `
CREATE TRIGGER handling_provenance_after_update
AFTER UPDATE OF handling ON orders
WHEN NEW.handling IS NOT OLD.handling
BEGIN
  INSERT OR REPLACE INTO handling_provenance (order_id, value, origin, actor, at, note)
  VALUES (
    NEW.id,
    NEW.handling,
    COALESCE(
      (SELECT origin FROM handling_intent WHERE order_id = NEW.id),
      CASE WHEN OLD.handling IS NULL AND NEW.handling = '${SENTINEL}'
           THEN 'legacy_default' ELSE 'modern' END
    ),
    COALESCE(
      (SELECT actor FROM handling_intent WHERE order_id = NEW.id),
      CASE WHEN OLD.handling IS NULL AND NEW.handling = '${SENTINEL}' THEN 'v1' ELSE 'unknown' END
    ),
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    COALESCE((SELECT note FROM handling_intent WHERE order_id = NEW.id), '')
  );
  DELETE FROM handling_intent WHERE order_id = NEW.id;
END`;

/**
 * AFTER INSERT fill, expand phase only. v1 writes no handling column, so the
 * database assigns the interim sentinel and records why. The fill is scoped to
 * `handling IS NULL`, so it can never overwrite a value the modern generation
 * supplied. The nested UPDATE also fires the provenance trigger above; the
 * explicit upsert after it covers an insert that arrived with a value.
 */
export const TRIGGER_FILL_INSERT = `
CREATE TRIGGER handling_fill_after_insert
AFTER INSERT ON orders
BEGIN
  UPDATE orders SET handling = '${SENTINEL}'
   WHERE id = NEW.id AND handling IS NULL;
  INSERT OR REPLACE INTO handling_provenance (order_id, value, origin, actor, at, note)
  VALUES (
    NEW.id,
    COALESCE(NEW.handling, '${SENTINEL}'),
    CASE WHEN NEW.handling IS NULL THEN 'legacy_default' ELSE 'modern' END,
    CASE WHEN NEW.handling IS NULL THEN 'v1' ELSE 'v2' END,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    CASE WHEN NEW.handling IS NULL THEN 'v1 insert without handling' ELSE 'insert with handling' END
  );
END`;

/** Post-contract insert: the column is NOT NULL, so every insert carries a value. */
export const TRIGGER_PROVENANCE_INSERT_CONTRACTED = `
CREATE TRIGGER handling_provenance_after_insert
AFTER INSERT ON orders
BEGIN
  INSERT OR REPLACE INTO handling_provenance (order_id, value, origin, actor, at, note)
  VALUES (
    NEW.id, NEW.handling, 'modern', 'v2',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'insert with handling'
  );
END`;

export const EXPANDED_TRIGGERS = [
  TRIGGER_GUARD,
  TRIGGER_PROVENANCE_UPDATE,
  TRIGGER_FILL_INSERT,
];

export const CONTRACTED_TRIGGERS = [
  TRIGGER_GUARD,
  TRIGGER_PROVENANCE_UPDATE,
  TRIGGER_PROVENANCE_INSERT_CONTRACTED,
];

export const TRIGGER_NAMES = [
  'handling_guard',
  'handling_provenance_after_update',
  'handling_fill_after_insert',
  'handling_provenance_after_insert',
];
