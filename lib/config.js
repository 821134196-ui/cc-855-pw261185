import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(value, fallback) {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * One config object shared by every process. All windows are in milliseconds.
 *
 * ACTIVE_WINDOW_MS — how stale a legacy session heartbeat may be and still count as "alive".
 * DRAIN_WINDOW_MS  — required silence (v1 heartbeat *or* write) before the contract step.
 *
 * The contract gate reads these from whichever process runs it, so the stack
 * launcher passes the same environment to services, the CLI and the ops page.
 */
export function loadConfig(env = process.env) {
  const legacyPort = int(env.LEGACY_PORT, 8091);
  const modernPort = int(env.MODERN_PORT, 8092);
  return {
    root: ROOT,
    dbPath: path.resolve(env.DB_PATH ?? path.join(ROOT, '.data', 'rehearsal.db')),
    opsPort: int(env.OPS_PORT, 8090),
    legacyPort,
    modernPort,
    legacyUrl: env.LEGACY_URL ?? `http://127.0.0.1:${legacyPort}`,
    modernUrl: env.MODERN_URL ?? `http://127.0.0.1:${modernPort}`,
    host: env.HOST ?? '127.0.0.1',
    activeWindowMs: int(env.ACTIVE_WINDOW_MS, 15_000),
    drainWindowMs: int(env.DRAIN_WINDOW_MS, 10_000),
    batchSize: int(env.BATCH_SIZE, 25),
    heartbeatMs: int(env.HEARTBEAT_MS, 2_000),
    busyTimeoutMs: int(env.BUSY_TIMEOUT_MS, 8_000),
    serviceTimeoutMs: int(env.SERVICE_TIMEOUT_MS, 5_000),
    historyLimit: int(env.HISTORY_LIMIT, 30),
    probePort: int(env.PROBE_PORT, 8093),
  };
}

export function describeConfig(cfg) {
  return {
    dbPath: cfg.dbPath,
    activeWindowMs: cfg.activeWindowMs,
    drainWindowMs: cfg.drainWindowMs,
    batchSize: cfg.batchSize,
    heartbeatMs: cfg.heartbeatMs,
    legacyUrl: cfg.legacyUrl,
    modernUrl: cfg.modernUrl,
  };
}

/** Absolute URL for a service, honouring a config whose port was picked at runtime. */
export function serviceUrl(cfg, which) {
  const port = which === 'legacy' ? cfg.legacyPort : cfg.modernPort;
  return `http://${cfg.host}:${port}`;
}
