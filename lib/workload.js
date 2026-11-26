/** Small presentation helpers shared by the CLI, the rehearsal script and the ops page. */

export function percent(n, total) {
  if (!total) return 0;
  return Math.round((n / total) * 1000) / 10;
}

export function formatMs(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
  const n = Math.max(0, Math.round(ms));
  if (n < 1000) return `${n} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)} s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

export function formatClock(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(11, 19) + 'Z';
}

export function backfillEstimate({ rows, batchSize, msPerBatchEstimate = 15 }) {
  const batches = Math.ceil(rows / Math.max(1, batchSize));
  return { batches, ms: batches * msPerBatchEstimate };
}

export function compact(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
