/* Operations console for the required-column rehearsal.
 *
 * Reads /api/snapshot every 1.5 s and renders four things that matter:
 *   - how much repair work is left (hero number + meter),
 *   - where values came from (tall segmented bar, one part per origin),
 *   - the live contract gate with each precondition spelled out,
 *   - the session/batch/audit trail behind those numbers.
 *
 * Every mutating button POSTs to /api/action/<name>; the server runs the same
 * migration function as the CLI, so nothing here can bypass the gate.
 */
(() => {
  'use strict';

  const ORIGIN_META = [
    { key: 'backfill', label: '批量修复默认值', color: 'var(--series-1)', cls: '' },
    { key: 'modern', label: '新版填写', color: 'var(--series-2)', cls: '' },
    { key: 'legacy_default', label: '旧版插入补位', color: 'var(--series-3)', cls: '' },
    { key: 'rollback', label: '回退过', color: 'var(--series-4)', cls: 's4' },
  ];

  const CHECK_LABELS = {
    E_WRONG_PHASE: '阶段必须是 backfilled / validated',
    E_COLUMN_MISSING: '必填列已经存在',
    E_PENDING_ROWS: '没有仍缺真实值的行',
    E_LEGACY_CLIENTS_ACTIVE: '没有活跃的 v1 会话',
    E_DRAIN_NOT_SATISFIED: 'v1 写入已静默足够久',
    E_DANGLING_INTENT: '没有悬挂的意图令牌',
  };

  let latest = null;
  let inFlight = false;
  let staleUntil = 0;

  const $ = (id) => document.getElementById(id);
  const toast = $('toast');
  const tooltip = $('tooltip');

  function showToast(text) {
    toast.textContent = text;
    toast.classList.add('show');
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({ ok: false, token: 'E_BAD_RESPONSE', message: '响应不是 JSON' }));
    return { status: res.status, json };
  }

  function shorten(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toISOString().slice(11, 19);
  }

  function ago(iso, now) {
    if (!iso) return '—';
    const ms = now - Date.parse(iso);
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1000) return '刚刚';
    if (ms < 60_000) return `${Math.round(ms / 1000)} 秒前`;
    return `${Math.round(ms / 60_000)} 分前`;
  }

  function pct(part, total) {
    if (!total) return 0;
    return Math.round((part / total) * 1000) / 10;
  }

  /* --------------------------------------------------------------- render */

  function render(data) {
    const now = Date.now();
    const phase = data.state?.phase ?? 'baseline';
    $('phaseBadge').dataset.phase = phase;
    $('phaseName').textContent = normalizeDone(data);
    $('dbmeta').textContent = data.config?.dbPath ?? '';

    const total = data.stats?.total ?? 0;
    const pending = data.pending ?? 0;
    const byOrigin = data.stats?.byOrigin ?? {};
    $('statTotal').textContent = total;
    $('statPending').textContent = pending;
    $('statPendingSub').textContent = pending === 0 ? '已全部修复' : `占 ${pct(pending, total)}% · 分批修复中`;
    $('statLegacyDefault').textContent = byOrigin.legacy_default ?? 0;
    $('statModern').textContent = byOrigin.modern ?? 0;
    $('repairMeter').style.width = `${total ? (100 - pct(pending, total)) : 0}%`;

    renderSegbar(data, total);
    renderChecks(data, now);
    renderSessions(data, now);
    renderBatches(data);
    renderEvents(data);

    const contractBtn = $('contractBtn');
    contractBtn.disabled = !data.contractAllowed || phase === 'contracted';
    contractBtn.textContent = phase === 'contracted' ? '已收紧' : '4 · 收紧约束';
  }

  function normalizeDone(data) {
    if (data.state?.phase === 'contracted') return 'contracted · 必填已生效';
    return data.state?.phase ?? 'baseline';
  }

  function renderSegbar(data, total) {
    const byOrigin = data.stats?.byOrigin ?? {};
    const bar = $('segbar');
    const legend = $('seglegend');
    const known = ORIGIN_META.reduce((s, o) => s + (byOrigin[o.key] ?? 0), 0);
    const missing = Math.max(0, total - known);

    bar.textContent = '';
    legend.textContent = '';

    const parts = [];
    for (const meta of ORIGIN_META) {
      const value = byOrigin[meta.key] ?? 0;
      if (value > 0) parts.push({ ...meta, value });
    }
    // Rows that have no value yet are a state, not an origin: neutral gray,
    // never a categorical slot, so it cannot be mistaken for a provenance.
    if (missing > 0) parts.push({ key: 'missing', label: '尚无真实值', color: 'var(--grid)', cls: 'neutral', value: missing, missing: true });

    if (!parts.length) {
      bar.hidden = true;
      const p = document.createElement('p');
      p.className = 'empty';
      p.textContent = '还没有可展示的取值来源';
      legend.appendChild(p);
    } else {
      bar.hidden = false;
      for (const p of parts) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = p.missing ? 'neutral' : p.cls;
        btn.style.width = `${(p.value / total) * 100}%`;
        btn.style.background = p.color;
        // Label only when the segment can hold it without clipping.
        const share = pct(p.value, total);
        if (share >= 8) btn.textContent = `${share}%`;
        attachTip(btn, `${p.label}：<b>${p.value}</b> 行（${share}%）`);
        btn.setAttribute('aria-label', `${p.label} ${p.value} 行，占 ${share}%`);
        bar.appendChild(btn);
      }
    }

    for (const p of parts) {
      const span = document.createElement('span');
      const dot = document.createElement('i');
      dot.className = 'keydot';
      dot.style.background = p.color;
      span.append(dot, `${p.label} · ${p.value}`);
      legend.appendChild(span);
    }

    // Table twin: every value in the bar is readable without hover or color.
    const tbody = $('originBody');
    tbody.textContent = '';
    const rows = [
      ...parts.map((p) => [p.label, p.value, `${pct(p.value, total)}%`]),
      ['合计', total, '100%'],
    ];
    for (const cells of rows) {
      const tr = document.createElement('tr');
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i > 0) td.className = 'num';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function renderChecks(data, now) {
    const box = $('checks');
    box.textContent = '';
    const pre = data.preflight;
    if (!pre) {
      const p = document.createElement('p');
      p.className = 'note';
      p.textContent = '处于 baseline：先展开，才会有收紧闸门。';
      box.appendChild(p);
      $('verdict').textContent = '尚未进入迁移';
      $('verdict').className = 'verdict';
      $('gateMeta').textContent = '';
      return;
    }
    for (const c of pre.checks) {
      const row = document.createElement('div');
      row.className = 'check';
      const icon = document.createElement('span');
      icon.className = `icon ${c.ok ? 'ok' : 'bad'}`;
      icon.textContent = c.ok ? '✓' : '✗';
      icon.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = CHECK_LABELS[c.code] ?? c.code;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = c.value === null || c.value === undefined ? '' : String(c.value);
      const note = document.createElement('p');
      note.className = 'noteText';
      note.textContent = c.text;
      row.append(icon, name, val, note);
      box.appendChild(row);
    }

    const verdict = $('verdict');
    if (pre.allowed) {
      verdict.textContent = '✓ 可以收紧';
      verdict.className = 'verdict ok';
    } else {
      verdict.textContent = `✗ 收紧会被拒绝（${pre.reasons.length} 项未满足）`;
      verdict.className = 'verdict bad';
    }
    const quiet = pre.quietMs === null || pre.quietMs === undefined ? null : pre.quietMs;
    $('gateMeta').textContent = quiet === null
      ? `排空窗口 ${pre.drainWindowMs} ms · 活跃窗口 ${pre.activeWindowMs} ms`
      : `v1 静默 ${Math.round(quiet)} ms / 需 ${pre.drainWindowMs} ms`;
  }

  function renderSessions(data, now) {
    const body = $('sessionsBody');
    body.textContent = '';
    const rows = data.sessions ?? [];
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = '还没有会话（服务与探针启动后会注册）';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const s of rows) {
      const tr = document.createElement('tr');
      const cells = [
        s.session_id,
        s.generation,
        s.role,
        s.stopped_at ? `已停止 · ${s.stop_reason ?? ''}` : ago(s.last_seen_at, now),
        ago(s.last_write_at, now),
        `${s.writes} / ${s.inserts}`,
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        if (i === 1) {
          const pill = document.createElement('span');
          pill.className = `pill ${s.generation}`;
          pill.textContent = text;
          td.appendChild(pill);
        } else if (i === 3) {
          const pill = document.createElement('span');
          pill.className = `pill ${s.stopped_at ? 'stopped' : 'alive'}`;
          pill.textContent = text;
          td.appendChild(pill);
        } else {
          td.textContent = text;
        }
        if (i === 5) td.className = 'num';
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
  }

  function renderBatches(data) {
    const body = $('batchesBody');
    body.textContent = '';
    const rows = data.batches ?? [];
    if (!rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 7;
      td.className = 'empty';
      td.textContent = '还没有批次';
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    for (const b of rows.slice(-8)) {
      const tr = document.createElement('tr');
      for (const v of [b.id, b.kind ?? '—', b.attempted, b.filled, b.blocked ?? 0, b.remaining, b.status]) {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
  }

  function renderEvents(data) {
    const box = $('eventlog');
    box.textContent = '';
    const events = [...(data.events ?? [])].reverse();
    const audit = (data.audit ?? []).map((a) => ({
      at: a.at,
      kind: a.kind,
      text: a.detail ?? '',
    }));
    const all = [...events, ...audit].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 24);
    if (!all.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = '还没有事件';
      box.appendChild(p);
      return;
    }
    for (const e of all) {
      const row = document.createElement('div');
      row.className = 'ev';
      const t = document.createElement('time');
      t.textContent = shorten(e.at);
      const k = document.createElement('span');
      k.className = 'kind';
      k.textContent = e.kind;
      const x = document.createElement('span');
      x.textContent = trim(e.text);
      row.append(t, k, x);
      box.appendChild(row);
    }
  }

  function trim(text) {
    if (typeof text !== 'string') return String(text);
    return text.length > 160 ? `${text.slice(0, 157)}…` : text;
  }

  /* --------------------------------------------------------------- tooltip */

  function attachTip(el, html) {
    el.addEventListener('mouseenter', (ev) => {
      tooltip.innerHTML = html;
      tooltip.classList.add('show');
      place(ev.clientX, ev.clientY);
    });
    el.addEventListener('mousemove', (ev) => place(ev.clientX, ev.clientY));
    el.addEventListener('mouseleave', () => tooltip.classList.remove('show'));
    el.addEventListener('focus', () => {
      const r = el.getBoundingClientRect();
      tooltip.innerHTML = html;
      tooltip.classList.add('show');
      place(r.left + r.width / 2, r.top);
    });
    el.addEventListener('blur', () => tooltip.classList.remove('show'));
  }

  function place(x, y) {
    const pad = 14;
    const rect = tooltip.getBoundingClientRect();
    let left = x + pad;
    let top = y - rect.height - pad;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
    if (top < 8) top = y + pad;
    tooltip.style.left = `${Math.max(8, left)}px`;
    tooltip.style.top = `${top}px`;
  }

  /* --------------------------------------------------------------- polling */

  async function refresh() {
    try {
      const { json } = await api('/api/snapshot');
      latest = json;
      if (json.ok !== false || json.stats) render(json);
    } catch (err) {
      $('dbmeta').textContent = `无法连接操作台 API：${err.message}`;
    }
  }

  async function act(name, body = {}, { confirmText = null } = {}) {
    if (inFlight) return;
    if (confirmText && !window.confirm(confirmText)) return;
    inFlight = true;
    document.body.classList.add('stale');
    try {
      const { status, json } = await act._api(name, body);
      if (json.ok === false) {
        showToast(`${json.token ?? '错误'}：${json.message ?? ''}`.slice(0, 240));
      } else if (name === 'attempt-contract' && status === 409) {
        showToast('收紧被拒绝 —— 旧客户端仍在活跃，闸门不允许。');
      } else {
        showToast(actionToast(name, json));
      }
      if (json.snapshot) {
        latest = json.snapshot;
        render(latest);
      }
    } catch (err) {
      showToast(`请求失败：${err.message}`);
    } finally {
      inFlight = false;
      document.body.classList.remove('stale');
      refresh();
    }
  }
  act._api = (name, body) => api(`/api/action/${name}`, body);

  function actionToast(name, json) {
    const r = json.result ?? {};
    switch (name) {
      case 'expand': return r.already ? '已经展开过了' : '已添加可空列与守卫触发器';
      case 'backfill-batch': return `本批填充 ${r.filled ?? 0} 行，剩余 ${r.remaining ?? 0}`;
      case 'backfill-all': return `修复完成：累计 ${r.filled ?? 0} 行，剩余 ${r.remaining ?? 0}`;
      case 'validate': return '校验通过';
      case 'attempt-contract': return `收紧完成，共 ${r.rows ?? 0} 行`;
      case 'unsafe-sweep': return `错误回退：改回 ${r.reverted ?? 0} 行，被守卫拒绝 ${(r.blocked ?? []).length} 行`;
      case 'rollback-defaults': return `安全回退 ${r.reverted ?? 0} 行`;
      case 'probe-inserts': {
        const a = r.attempts ?? [];
        return `插入对照：v1 ${a[0]?.accepted ? '接受' : '被拒绝'}；v2 ${a[1]?.accepted ? '接受' : '被拒绝'}`;
      }
      case 'stop-probes': return `已停止 ${r.stopped ?? 0} 个探针会话`;
      case 'reseed': return `基线已重置（${r.legacyRows ?? 0} 行）`;
      default: return '完成';
    }
  }

  /* --------------------------------------------------------------- wiring */

  const bind = (id, fn) => $(id).addEventListener('click', fn);

  bind('expandBtn', () => act('expand'));
  bind('backfillOneBtn', () => act('backfill-batch', { batchSize: 25, batches: 1 }));
  bind('backfillAllBtn', () => act('backfill-all', { batchSize: 25, paceMs: 250 }));
  bind('validateBtn', () => act('validate'));
  bind('contractBtn', () => act('attempt-contract'));
  bind('unsafeSweepBtn', () => act('unsafe-sweep', {}, {
    confirmText: '这会用一个错误的“全部回退”演示守卫：新版写入的行应被数据库拒绝。继续？',
  }));
  bind('rollbackBtn', () => act('rollback-defaults', { batchSize: 50 }, {
    confirmText: '只回退来自默认值的行；新版写入的行会被排除并由触发器兜底。继续？',
  }));
  bind('probeInsertBtn', () => act('probe-inserts'));
  bind('stopProbesBtn', () => act('stop-probes'));
  bind('reseedBtn', () => act('reseed', { legacyRows: 240 }, {
    confirmText: '重置会删除当前数据库并重建基线，继续？',
  }));

  $('themeBtn').addEventListener('click', () => {
    const root = document.documentElement;
    const current = root.dataset.theme;
    const next = current === 'dark' ? 'light' : current === 'light' ? '' : 'dark';
    if (next) root.dataset.theme = next;
    else delete root.dataset.theme;
    $('themeBtn').textContent = `主题：${next || '跟随系统'}`;
  });

  refresh();
  setInterval(refresh, 1500);
})();
