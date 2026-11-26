import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { closeDb, openDb, scalar } from '../lib/db.js';
import { seedDatabase } from '../lib/seed.js';
import { stopSession } from '../lib/session.js';
import {
  backfill,
  columnSnapshot,
  contract,
  contractPreflight,
  countPending,
  expand,
  rollbackDefaults,
  unsafeDefaultSweep,
  validate,
} from '../lib/migration.js';
import { startLegacyService } from '../services/legacy-service.js';
import { startModernService } from '../services/modern-service.js';
import { startProbeServer } from '../tools/v1-probe.js';

/**
 * End-to-end rehearsal.
 *
 *   node demo/rehearse.js            (fresh temp database, windows 4s/5s)
 *   node demo/rehearse.js --keep     (keep the database and print its path)
 *
 * It runs two real generations of the service (separate SQLite connections;
 * `npm run stack` runs the same code as separate processes) plus a synthetic
 * old client, and walks the whole migration while they write:
 *
 *   1 baseline → expand with both generations live (both keep reading/writing)
 *   2 repair in id-ordered batches; rows the modern generation filled are
 *     skipped, never overwritten
 *   3 a deliberately wrong "default sweep" and the safe rollback are both
 *     refused on modern rows by the database guard
 *   4 contract is attempted while v1 is active → refused with reasons
 *   5 v1 is stopped; the gate stays closed through the drain window, then opens
 *   6 contract re-runs; v1 inserts are rejected, v2 inserts succeed, and every
 *     modern value survives the table rebuild
 *
 * Exit code 0 means every assertion in the transcript held. Every server and
 * timer is closed in a finally block and the process exits explicitly, so a
 * failed assertion can never leave the demo hanging.
 */
const keep = process.argv.includes('--keep');

function makeConfig() {
  const base = loadConfig({
    DB_PATH: path.join(fs.mkdtempSync(path.join('/tmp', 'rehearse-')), 'rehearsal.db'),
    ACTIVE_WINDOW_MS: '4000',
    DRAIN_WINDOW_MS: '5000',
    HEARTBEAT_MS: '1000',
    BATCH_SIZE: '12',
  });
  base.skipBackup = true; // temp DB: the cold backup would only slow the demo
  return base;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Transcript {
  constructor() {
    this.steps = [];
    this.failures = [];
  }
  step(name, detail = '') {
    this.steps.push({ name, detail });
    console.log(`\n▶ ${name}${detail ? `\n  ${detail}` : ''}`);
  }
  evidence(text) {
    console.log(`  · ${text}`);
  }
  assert(label, ok, detail = '') {
    if (ok) {
      console.log(`  ✓ ${label}`);
    } else {
      this.failures.push(label);
      console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    }
    return ok;
  }
}

/** Everything that must be closed before the process may exit. */
const live = {
  services: [],
  probe: null,
  db: null,
};

async function closeAll() {
  for (const svc of live.services.splice(0).reverse()) {
    try {
      await svc.closeService('demo-end');
    } catch {
      /* already closed */
    }
  }
  if (live.probe) {
    const probe = live.probe;
    live.probe = null;
    try {
      await probe.close('demo-end');
    } catch {
      /* already closed */
    }
  }
  if (live.db) {
    closeDb(live.db);
    live.db = null;
  }
}

async function startTracked(start, opts, extra = {}) {
  const svc = await start({ ...opts, ...extra });
  live.services.push(svc);
  return svc;
}

async function run() {
  const cfg = makeConfig();
  const t = new Transcript();
  t.step('准备基线库', `db=${cfg.dbPath}`);
  const seeded = seedDatabase(cfg, { reset: true, legacyRows: 90 });
  t.evidence(`基线 ${seeded.legacyRows} 行，orders 无 handling 列`);

  live.db = openDb(cfg);
  const db = live.db;

  // ---- 1. both generations live, before and through expand -----------------
  t.step('两代服务同时上线（v1 不认识新列，v2 知道新列）');
  const legacy = await startTracked(startLegacyService, { cfg }, { port: 0, tickMs: 260 });
  const modern = await startTracked(startModernService, { cfg }, { port: 0, tickMs: 260 });
  live.probe = await startProbeServer({ cfg, port: 0, tickMs: 500 });
  const probe = live.probe;
  t.evidence(`v1 ${legacy.baseUrl} · v2 ${modern.baseUrl} · 旧客户端探针 ${probe.sessionId}`);
  await sleep(1200);

  const preExpandV1 = await getJson(`${legacy.baseUrl}/orders?limit=5`);
  const preExpandV2 = await getJson(`${modern.baseUrl}/orders?limit=5`);
  t.assert('展开前 v1 读取正常', preExpandV1.ok === true && preExpandV1.count > 0);
  t.assert(
    '展开前 v2 读取正常且知道列还未存在',
    preExpandV2.ok === true && preExpandV2.requiredColumnPresent === false,
  );

  // v2 writes before the column exists: everything except handling.
  const preInsert = await postJson(`${modern.baseUrl}/orders`, { handling: 'critical' });
  t.assert('展开前 v2 插入成功（尚不能写 handling）', preInsert.ok === true);
  t.evidence(`v2 插入返回 handlingWritten=${preInsert.handlingWritten}`);

  t.step('执行 expand：加可空列 + 守卫/填充触发器（服务不停机）');
  const ex = expand(db);
  t.assert('expand 成功', ex.phase === 'expanded');
  t.evidence(`expand 时已有 ${ex.legacyRows} 行，全部保持 NULL，等待分批修复`);

  await sleep(900);
  const afterExpandV1 = await getJson(`${legacy.baseUrl}/orders?limit=5`);
  const v1InsertPostExpand = await postJson(`${legacy.baseUrl}/orders`, { customer: 'expand-v1' });
  t.assert('expand 后 v1 仍能读', afterExpandV1.ok === true);
  t.assert('expand 后 v1 仍能插入（数据库补哨兵）', v1InsertPostExpand.ok === true);

  const fillTarget = pickLegacyRow(db);
  t.assert('存在等待修复的旧行可供 v2 填写', fillTarget !== null);
  const v2Fill = fillTarget === null
    ? { ok: false, token: 'E_NO_PENDING_ROW' }
    : await postJson(`${modern.baseUrl}/orders/${fillTarget}/handling`, {
        handling: 'high',
        actor: 'v2-demo',
      });
  t.assert(
    'expand 后 v2 能为旧行填真实值',
    v2Fill.ok === true && v2Fill.order?.value === 'high',
    `${v2Fill.token ?? ''} ${v2Fill.message ?? ''}`,
  );
  t.evidence(`v2 填写 order ${v2Fill.order?.id ?? fillTarget ?? '?'} → ${v2Fill.order?.value ?? '失败'}`);
  const fillOrigin = fillTarget === null
    ? null
    : db.prepare('SELECT origin FROM handling_provenance WHERE order_id = ?').get(fillTarget)?.origin;
  t.assert('v2 填写被记为 modern 来源', fillOrigin === 'modern', String(fillOrigin));

  const totalBeforeRepair = scalar(db, 'SELECT COUNT(*) FROM orders');
  const pendingBeforeRepair = countPending(db);
  t.evidence(`此刻共 ${totalBeforeRepair} 行，其中 ${pendingBeforeRepair} 行待修复`);

  // ---- 2. batched repair with traffic running ------------------------------
  t.step('分批修复旧行（v1/v2 同时持续读写）');
  let totalFilled = 0;
  let blocked = 0;
  let batches = 0;
  for (;;) {
    const r = backfill(db, { batchSize: cfg.batchSize, maxBatches: 1 });
    totalFilled += r.filled;
    blocked += r.blocked;
    batches += 1;
    if (r.batches === 0) break;
    await sleep(180);
    if (r.remaining === 0) break;
    if (batches > 60) break;
  }
  t.evidence(`共 ${batches} 批，填充 ${totalFilled} 行，跳过 ${blocked} 行（已被 v2 先填）`);

  const snapAfterRepair = columnSnapshot(db);
  t.assert(
    '修复后仍有 v2 写入的行被保留',
    snapAfterRepair.stats.byOrigin.modern > 0,
    JSON.stringify(snapAfterRepair.stats.byOrigin),
  );
  t.evidence(`取值来源：${JSON.stringify(snapAfterRepair.stats.byOrigin)}`);
  // v2's own traffic loop may revise a value it wrote (high → normal is still
  // a v2 write); what must never happen is the repair taking the row over.
  const filledRow = db
    .prepare(
      `SELECT o.handling, p.origin FROM orders o
         JOIN handling_provenance p ON p.order_id = o.id
        WHERE o.id = ?`,
    )
    .get(fillTarget);
  t.assert(
    '批量修复没有覆盖 v2 已填的值',
    filledRow?.origin === 'modern' && ['low', 'normal', 'high', 'critical'].includes(filledRow.handling),
    JSON.stringify(filledRow),
  );
  t.evidence(`order ${fillTarget} 仍由 v2 持有：${filledRow?.origin} · ${filledRow?.handling}`);

  // ---- 3. the guard: a wrong sweep must not touch modern values -----------
  t.step('演示错误的“全部回退”：新版写入的值必须被数据库拒绝');
  const modernBefore = listModernValues(db);
  const sweep = unsafeDefaultSweep(db, { actor: 'demo-unsafe' });
  const modernAfter = listModernValues(db);
  t.assert(
    '错误回退没有覆盖任何新版值',
    JSON.stringify(modernBefore) === JSON.stringify(modernAfter),
    `${modernBefore.length} 个 modern 值被改写`,
  );
  t.assert(
    '错误回退被逐行拒绝',
    sweep.blocked.length >= modernBefore.length && sweep.blocked.every((b) => b.token === 'E_DEFAULT_OVER_MODERN'),
    JSON.stringify(sweep.blocked.slice(0, 4)),
  );
  t.evidence(`改回 ${sweep.reverted} 行默认值，拒绝 ${sweep.blocked.length} 行新版值`);

  t.step('安全回退：只撤销默认值，再重新修复');
  const rollback = rollbackDefaults(db, { batchSize: 40 });
  t.assert('安全回退保留新版值', JSON.stringify(listModernValues(db)) === JSON.stringify(modernBefore));
  let refilled = 0;
  for (;;) {
    const r = backfill(db, { batchSize: cfg.batchSize, maxBatches: 1 });
    refilled += r.filled;
    if (r.batches === 0) break;
    await sleep(120);
    if (r.remaining === 0) break;
  }
  // No timers can fire between these two synchronous calls, so this assertion
  // observes the exact state the last backfill left behind.
  const v = validate(db);
  t.assert('校验通过（无待修复、来源齐全、无悬挂令牌）', v.ok === true);
  t.evidence(`回退 ${rollback.reverted} 行，重新修复 ${refilled} 行`);

  // ---- 4. contract attempt while v1 is still alive ------------------------
  t.step('旧客户端仍活跃时尝试收紧约束');
  await sleep(400);
  const preLive = contractPreflight(db, cfg);
  t.assert('闸门判定：不允许收紧', preLive.allowed === false, JSON.stringify(preLive.reasons));
  const liveFails = preLive.reasons.map((r) => r.code);
  t.assert('拒绝原因包含“旧客户端仍活跃”', liveFails.includes('E_LEGACY_CLIENTS_ACTIVE'), liveFails.join(','));
  t.evidence(`原因：${liveFails.join(', ')}`);

  let refused = null;
  try {
    contract(db, cfg, { source: 'demo' });
  } catch (err) {
    refused = err;
  }
  t.assert('contract 抛出拒绝而不是执行', refused?.token === 'E_CONTRACT_REFUSED');
  const stillExpanded = columnSnapshot(db).column;
  t.assert('拒绝后表结构未被收紧', stillExpanded.notNull === false);
  const refusalAudit = db
    .prepare("SELECT detail FROM audit_log WHERE kind = 'migrate.contract_refused' ORDER BY id DESC LIMIT 1")
    .get();
  t.assert('拒绝写进了审计记录', Boolean(refusalAudit));
  t.evidence(`orders.handling NOT NULL=${stillExpanded.notNull}；审计：${refusalAudit?.detail ?? '无'}`);

  // ---- 5. stop the old generation; gate waits for the drain window --------
  t.step('停掉旧客户端与服务，等待排空窗口');
  const legacySession = legacy.ctx.sessionId;
  const probeSession = probe.sessionId;
  // Stop traffic first, then mark the sessions stopped; that is what the gate
  // reads. v2 keeps running and writing throughout.
  await probe.close('demo-stop-probe');
  stopSession(db, probeSession, 'demo-stop-probe');
  await legacy.closeService('demo-stop-legacy');
  stopSession(db, legacySession, 'demo-stop-legacy');
  t.evidence('v1 服务与探针已停止会话；v2 继续运行');

  // v2 must keep working throughout the drain window.
  const during = await postJson(`${modern.baseUrl}/orders`, { handling: 'normal', customer: 'drain-v2' });
  t.assert('排空窗口期间 v2 仍能写入', during.ok === true);

  // v1 inserted sentinel rows while it was live; repair them after it stops.
  const lastRepair = backfill(db);
  t.evidence(`停止后补一轮修复：${lastRepair.filled} 行，剩余 ${lastRepair.remaining}`);

  const preDrain = contractPreflight(db, cfg);
  t.assert(
    '刚停下时仍不允许收紧（排空窗口未到）',
    preDrain.allowed === false && preDrain.quietMs < cfg.drainWindowMs,
    JSON.stringify(preDrain.reasons),
  );
  const drainCodes = preDrain.reasons.map((r) => r.code);
  t.assert('此时唯一原因是排空不足', drainCodes.every((c) => c === 'E_DRAIN_NOT_SATISFIED'), drainCodes.join(','));
  t.evidence(`v1 静默 ${Math.round(preDrain.quietMs)} ms / 需要 ${cfg.drainWindowMs} ms`);

  const waitMs = Math.max(0, cfg.drainWindowMs - preDrain.quietMs + 350);
  t.evidence(`等待 ${Math.round(waitMs)} ms 让排空窗口满足`);
  await sleep(waitMs);

  const preAfterDrain = contractPreflight(db, cfg);
  t.assert('排空窗口满足后闸门放行', preAfterDrain.allowed === true, JSON.stringify(preAfterDrain.reasons));
  if (!preAfterDrain.allowed) {
    const extra = preAfterDrain.reasons.map((r) => `${r.code}: ${r.text}`).join('; ');
    throw new Error(`闸门未能放行：${extra}`);
  }

  // ---- 6. contract, then prove which generation can still write ----------
  t.step('收紧约束：重建表为 NOT NULL');
  // Pause v2's traffic for the duration of the rebuild so the before/after
  // comparison observes exactly the rows the rebuild had to carry, not a
  // value v2 legitimately revised a millisecond later.
  modern.ctx.stopTraffic();
  const modernAtContract = listModernValues(db);
  const contractResult = contract(db, cfg, { source: 'demo' });
  t.assert('contract 执行成功', contractResult.ok === true);
  const info = columnSnapshot(db).column;
  t.assert('列已是 NOT NULL', info.notNull === true);
  const modernSurvived = listModernValues(db);
  t.assert(
    '收紧前后新版值全部存活',
    modernSurvived.length >= modernAtContract.length &&
      modernAtContract.every(([id, value]) => modernSurvived.some(([sid, svalue]) => sid === id && svalue === value)),
    `${modernAtContract.length} 个新版值 → 现存 ${modernSurvived.length} 个`,
  );
  modern.ctx.startTraffic(260);

  // The v1 that inserted during the migration is closed; start a fresh v1
  // process-shaped service and prove its insert now fails on NOT NULL.
  const lateLegacy = await startTracked(startLegacyService, { cfg }, { port: 0 });
  const v1After = await postJson(`${lateLegacy.baseUrl}/orders`, { customer: 'post-v1' });
  t.assert(
    '收紧后 v1 插入被拒绝（NOT NULL）',
    v1After.ok === false && /NOT_NULL|NOT NULL/.test(`${v1After.token} ${v1After.message}`),
    `${v1After.token} ${v1After.message}`,
  );
  t.evidence(`v1 写入返回：${v1After.token ?? ''} ${v1After.message ?? ''}`);
  await lateLegacy.closeService('demo-end-late-v1');
  live.services.splice(live.services.indexOf(lateLegacy), 1);

  const v2After = await postJson(`${modern.baseUrl}/orders`, { handling: 'critical', customer: 'post-v2' });
  t.assert('收紧后 v2 插入成功', v2After.ok === true && v2After.handling === 'critical');

  const v2Read = await getJson(`${modern.baseUrl}/orders?limit=10`);
  t.assert('收紧后 v2 读取正常', v2Read.ok === true && v2Read.requiredColumnPresent === true);

  const seq = scalar(db, "SELECT seq FROM sqlite_sequence WHERE name='orders'");
  const maxId = scalar(db, 'SELECT MAX(id) FROM orders');
  t.assert('AUTOINCREMENT 序列与新行 id 一致', Number(seq) >= Number(maxId), `seq=${seq} maxId=${maxId}`);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  t.assert('无外键违规', fk.length === 0, JSON.stringify(fk));

  // Post-contract: defaults can no longer be invented.
  let postRollback = null;
  try {
    rollbackDefaults(db);
  } catch (err) {
    postRollback = err;
  }
  t.assert('收紧后回退默认值被拒绝', postRollback?.token === 'E_ALREADY_CONTRACTED');

  return { t, cfg };
}

function pickLegacyRow(db) {
  const row = db
    .prepare('SELECT id FROM orders WHERE handling IS NULL ORDER BY id LIMIT 1')
    .get();
  return row?.id ?? null;
}

/** Unordered list of [id, value] for rows whose provenance says modern wrote them. */
function listModernValues(db) {
  return db
    .prepare(
      `SELECT o.id, o.handling FROM orders o
         JOIN handling_provenance p ON p.order_id = o.id
        WHERE p.origin = 'modern'
        ORDER BY o.id`,
    )
    .all()
    .map((r) => [r.id, r.handling]);
}

async function getJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

run()
  .then(async ({ t, cfg }) => {
    await closeAll();
    // ---- transcript summary ----------------------------------------------
    console.log('\n' + '─'.repeat(64));
    if (t.failures.length === 0) {
      console.log(`✓ 全流程通过：${t.steps.length} 个阶段，所有断言成立`);
    } else {
      console.log(`✗ ${t.failures.length} 个断言失败：`);
      for (const f of t.failures) console.log(`   - ${f}`);
    }
    if (keep) {
      console.log(`  数据库保留在 ${cfg.dbPath}`);
      console.log(`  提示：node ops/server.js 可通过 DB_PATH=${cfg.dbPath} 打开同一库`);
    } else {
      console.log(`  临时数据库 ${cfg.dbPath} 已清理（用 --keep 保留）`);
      fs.rmSync(path.dirname(cfg.dbPath), { recursive: true, force: true });
    }
    console.log('─'.repeat(64));
    process.exit(t.failures.length === 0 ? 0 : 1);
  })
  .catch(async (err) => {
    console.error(`\n✗ 演练中断：${err.token ?? ''} ${err.message}`);
    if (err.stack && process.env.DEBUG) console.error(err.stack);
    await closeAll();
    process.exit(1);
  });
