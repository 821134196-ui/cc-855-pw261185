import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, serviceUrl } from '../lib/config.js';
import { openDb, closeDb } from '../lib/db.js';
import { seedDatabase } from '../lib/seed.js';

/**
 * One-command launcher for the rehearsal.
 *
 *   node scripts/stack.js [--reset] [--rows 240] [--traffic]
 *
 * Starts the v2 service, the v1 service and the ops page (8090) against the
 * same SQLite file. Each child gets the same DB path and the same windows, so
 * the contract gate in the ops process sees what the services registered.
 * SIGINT stops children gracefully (each marks its session stopped).
 */
const args = new Set(process.argv.slice(2));
const cfg = loadConfig();

if (args.has('--reset')) {
  seedDatabase(cfg, { reset: true, legacyRows: Number(valueAfter('--rows') ?? 240) });
  console.log(`seeded ${cfg.dbPath}`);
} else if (!fs.existsSync(cfg.dbPath)) {
  console.log('no database yet — seeding baseline');
  seedDatabase(cfg, { reset: true, legacyRows: Number(valueAfter('--rows') ?? 240) });
}

function valueAfter(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const shared = {
  ...process.env,
  DB_PATH: cfg.dbPath,
  ACTIVE_WINDOW_MS: String(cfg.activeWindowMs),
  DRAIN_WINDOW_MS: String(cfg.drainWindowMs),
  HEARTBEAT_MS: String(cfg.heartbeatMs),
};

const children = [];
function launch(name, script, env) {
  const child = spawn(process.execPath, [path.join(cfg.root, script)], {
    env: { ...shared, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[${name}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[${name}!] ${d}`));
  child.on('exit', (code) => console.log(`[${name}] exited ${code}`));
  children.push(child);
  return child;
}

const wantTraffic = args.has('--traffic');
const boot = async () => {
  launch('ops', 'ops/server.js', { OPS_PORT: String(cfg.opsPort) });
  launch('v2', 'services/modern-service.js', { MODERN_PORT: String(cfg.modernPort) });
  launch('v1', 'services/legacy-service.js', { LEGACY_PORT: String(cfg.legacyPort) });
  if (args.has('--probe')) launch('probe', 'tools/v1-probe.js', {});

  // Give the services a beat to register, then optionally drive traffic.
  await new Promise((r) => setTimeout(r, 1200));
  if (wantTraffic) {
    await post(`${serviceUrl(cfg, 'legacy')}/traffic/start`, { intervalMs: 250 });
    await post(`${serviceUrl(cfg, 'modern')}/traffic/start`, { intervalMs: 250 });
    console.log('traffic started on both generations');
  }
  console.log(`\nops page: http://${cfg.host}:${cfg.opsPort}\n`);
};

async function post(url, body) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.warn(`could not reach ${url}: ${err.message}`);
  }
}

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) if (!c.killed) c.kill('SIGTERM');
  setTimeout(() => {
    for (const c of children) if (!c.killed) c.kill('SIGKILL');
    process.exit(0);
  }, 2500).unref?.();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

boot().catch((err) => {
  console.error(err);
  shutdown('boot-failed');
});
