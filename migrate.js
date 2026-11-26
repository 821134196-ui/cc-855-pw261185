import { loadConfig } from './lib/config.js';
import { audit, closeDb, nowIso, openDb, scalar, statusFor } from './lib/db.js';
import {
  backfill,
  columnSnapshot,
  contract,
  contractPreflight,
  countPending,
  expand,
  readState,
  requiredColumnInfo,
  rollbackDefaults,
  unsafeDefaultSweep,
  validate,
  withDb,
  MigrationError,
} from './lib/migration.js';
import { seedDatabase } from './lib/seed.js';
import { formatMs } from './lib/workload.js';

/**
 * Migration CLI. Every step runs against the configured database, so it can be
 * invoked while both service generations are live.
 *
 *   node migrate.js status
 *   node migrate.js expand
 *   node migrate.js backfill [--batch 25] [--batches N] [--pace 300]
 *   node migrate.js backfill-loop [--slices 8] [--pace 400]
 *   node migrate.js validate
 *   node migrate.js preflight
 *   node migrate.js contract        (refused unless every gate passes)
 *   node migrate.js rollback [--batch 25] [--batches 1]
 *   node migrate.js unsafe-sweep    (demo: wrong sweep, refused on modern rows)
 *   node migrate.js seed [--rows 240] [--reset]
 */
const cfg = loadConfig();

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else out._.push(token);
  }
  return out;
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const step = args._[0] ?? 'status';

  if (step === 'seed') {
    const rows = Number(args.rows ?? 240);
    print(seedDatabase(cfg, { reset: Boolean(args.reset), legacyRows: rows }));
    return;
  }

  if (step === 'status') {
    const db = openDb(cfg);
    try {
      const snap = columnSnapshot(db);
      const pre = ['baseline'].includes(snap.phase) ? null : contractPreflight(db, cfg);
      print({
        phase: snap.phase,
        column: snap.column,
        total: snap.total,
        pending: snap.stats.pending,
        byOrigin: snap.stats.byOrigin,
        withoutProvenance: snap.stats.withoutProvenance,
        batches: db.prepare('SELECT COUNT(*) AS n FROM migration_batches').get().n,
        contractAllowed: pre ? pre.allowed : false,
        blocking: pre ? pre.reasons : [{ code: 'E_WRONG_PHASE', text: 'still at baseline' }],
      });
    } finally {
      closeDb(db);
    }
    return;
  }

  if (step === 'expand') {
    print(withDb(cfg, (db) => expand(db)));
    return;
  }

  if (step === 'preflight') {
    print(withDb(cfg, (db) => contractPreflight(db, cfg)));
    return;
  }

  if (step === 'validate') {
    print(withDb(cfg, (db) => validate(db)));
    return;
  }

  if (step === 'contract') {
    const db = openDb(cfg);
    try {
      const result = contract(db, cfg);
      print(result);
    } finally {
      closeDb(db);
    }
    return;
  }

  if (step === 'backfill') {
    const db = openDb(cfg);
    try {
      const result = backfill(db, {
        batchSize: Number(args.batch ?? cfg.batchSize),
        maxBatches: args.batches ? Number(args.batches) : Infinity,
        onBatch: (b) => {
          console.log(
            `  batch ${b.batchNo}: filled ${b.filled}/${b.attempted} remaining=${b.remaining}` +
              (b.blocked ? ` blocked=${b.blocked}` : ''),
          );
          if (args.pace) sleep(Number(args.pace));
        },
      });
      print(result);
    } finally {
      closeDb(db);
    }
    return;
  }

  if (step === 'backfill-loop') {
    // Repair in sized slices, waiting `pace` between slices — the shape the ops
    // page uses, and easy to interrupt from the scheduler.
    const db = openDb(cfg);
    try {
      let total = 0;
      for (let i = 0; i < (args.slices ? Number(args.slices) : 8); i += 1) {
        const r = backfill(db, { batchSize: Number(args.batch ?? cfg.batchSize), maxBatches: 1 });
        total += r.filled;
        console.log(`slice ${i + 1}: filled=${r.filled} remaining=${r.remaining}`);
        if (r.remaining === 0) break;
        sleep(Number(args.pace ?? 400));
      }
      print({ filledInSlices: total, remaining: countPending(db) });
    } finally {
      closeDb(db);
    }
    return;
  }

  if (step === 'rollback') {
    print(
      withDb(cfg, (db) =>
        rollbackDefaults(db, { batchSize: Number(args.batch ?? 25), maxBatches: Number(args.batches ?? Infinity) }),
      ),
    );
    return;
  }

  if (step === 'unsafe-sweep') {
    print(withDb(cfg, (db) => unsafeDefaultSweep(db)));
    return;
  }

  throw new MigrationError('E_BAD_COMMAND', `unknown command '${step}'`, 400, {
    commands: ['seed', 'status', 'expand', 'backfill', 'validate', 'preflight', 'contract', 'rollback', 'unsafe-sweep'],
  });
}

main().catch((err) => {
  const payload = { ok: false, token: err.token ?? 'E_INTERNAL', message: err.message };
  if (err.extra) payload.detail = err.extra;
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = statusFor(err) >= 500 ? 1 : 2;
});
