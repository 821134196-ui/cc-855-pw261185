import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { closeDb, nowIso, openDb, scalar, withTx } from './db.js';
import {
  BASELINE_INDEX_DDL,
  BASELINE_ORDERS_DDL,
  META_DDL,
  PHASES,
} from './schema.js';

/**
 * Build (or reset) the local relational store.
 *
 * Baseline = the schema BEFORE the migration: orders has no `handling` column
 * and the v1 service is the only writer. The seed rows are the "legacy rows"
 * the batched repair later has to fill in.
 */
export function seedDatabase(
  cfg,
  { reset = false, legacyRows = 240, customers = 6, migrateId = 'add-orders-handling-v1' } = {},
) {
  if (reset) {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(cfg.dbPath + suffix, { force: true });
  }
  const db = openDb(cfg);
  try {
    const hasOrders = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'")
      .get();
    if (hasOrders) {
      const state = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migration_state'")
        .get();
      if (state) return { already: true, legacyRows: scalar(db, 'SELECT COUNT(*) FROM orders') };
      throw new Error(`refusing to seed over a populated but unseeded database at ${cfg.dbPath}`);
    }

    withTx(db, () => {
      db.exec(BASELINE_ORDERS_DDL);
      db.exec(BASELINE_INDEX_DDL);
      for (const ddl of META_DDL) db.exec(ddl);
      db.prepare(
        `INSERT INTO migration_state (id, phase, migration_id, updated_at, notes)
         VALUES (1, 'baseline', ?, ?, 'seeded legacy database')`,
      ).run(migrateId, nowIso());

      const priorities = ['low', 'normal', 'high', 'critical'];
      const names = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Wayne', 'Stark'];
      const namesCount = Math.max(1, customers);
      const insert = db.prepare(
        `INSERT INTO orders (ref, customer, amount_cents, priority, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const base = new Date('2026-08-01T09:00:00.000Z').getTime();
      for (let i = 0; i < legacyRows; i += 1) {
        const created = new Date(base + i * 31 * 60_000).toISOString();
        insert.run(
          `ORD-${String(1000 + i).padStart(5, '0')}`,
          names[i % namesCount],
          ((i * 17) % 90 + 10) * 1000,
          priorities[i % priorities.length],
          i % 9 === 0 ? 'closed' : 'open',
          created,
        );
      }
      db.prepare(
        `INSERT INTO audit_log (at, source, kind, detail) VALUES (?, 'cli', 'seed', ?)`,
      ).run(nowIso(), JSON.stringify({ legacyRows, columns: 'no handling column yet' }));
    });
    const total = scalar(db, 'SELECT COUNT(*) FROM orders');
    return { already: false, legacyRows: total, phases: PHASES };
  } finally {
    closeDb(db);
  }
}

function backupPathFor(cfg, label) {
  const dir = path.join(cfg.root, '.data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const file = path.join(dir, `${label}-${stamp}.db`);
  return { dir, file };
}

/**
 * Consistent cold copy via VACUUM INTO. Must run on its own connection while
 * no write transaction is held by the caller; the contract step takes its
 * backup BEFORE opening its rebuld transaction for exactly that reason.
 */
export function backupDatabase(cfg, label = 'pre-contract') {
  const { dir, file } = backupPathFor(cfg, label);
  const db = openDb(cfg);
  try {
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    const copy = new DatabaseSync(file);
    try {
      copy.exec('PRAGMA journal_mode=DELETE');
    } finally {
      copy.close();
    }
    return { file, dir, size: fs.statSync(file).size };
  } finally {
    closeDb(db);
  }
}

export function latestBackup(cfg) {
  const dir = path.join(cfg.root, '.data', 'backups');
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(dir, files[0].f) : null;
}
