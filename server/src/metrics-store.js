import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SAMPLE_MS = 30_000;
const HOLD_MS = SAMPLE_MS * 1.5;
const DAY_MS = 86400_000;
export const RANGES = { '1h': 3600_000, '3h': 10800_000, '1d': DAY_MS, '3d': DAY_MS * 3, '7d': DAY_MS * 7 };
const METRICS = ['cpu', 'memory', 'memoryPercent', 'rxRate', 'txRate', 'readRate', 'writeRate', 'load', 'swapPercent', 'diskPercent', 'pids', 'running', 'unhealthy'];

export function validateMetricsSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 90) {
    throw new Error('Metrics retention must be a whole number from 1 to 90 days');
  }
  return { retentionDays: value.retentionDays };
}

export function parseHistoryQuery(query) {
  const range = query.range ?? '7d';
  const target = query.target ?? 'host';
  if (typeof range !== 'string' || !Object.hasOwn(RANGES, range)) throw new Error('Unsupported metrics timeframe');
  if (typeof target !== 'string' || !target.length || target.length > 256) throw new Error('Invalid metrics target');
  return { range, target };
}

function availability(rows, from, to) {
  const intervals = [];
  function add(start, end, state) {
    if (end <= start) return;
    const prev = intervals.at(-1);
    if (prev?.state === state && prev.to === start) prev.to = end;
    else intervals.push({ from: start, to: end, state });
  }
  let cursor = from;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const start = Math.max(from, row.at);
    const end = Math.min(to, row.at + HOLD_MS, rows[i + 1]?.at ?? to);
    if (end <= from) continue;
    add(cursor, start, 'unknown');
    add(start, end, row.state);
    cursor = end;
  }
  add(cursor, to, 'unknown');
  return intervals;
}

function transitions(rows, from) {
  const events = [];
  let restarts = 0;
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const row = rows[i];
    if (row.at < from || row.at - prev.at > HOLD_MS) continue;
    const event = (type, detail) => events.push({ at: row.at, type, detail });
    if (row.state !== prev.state) {
      const type = row.state === 'up' ? 'recovered' : row.state;
      event(type, row.reason || (type === 'recovered' ? 'Running / healthy again' : row.state));
    }
    if (prev.id && row.id && prev.id !== row.id) event('recreated', 'Container ID changed; history continues under the same name');
    else if (Number.isFinite(prev.metrics.restartCount) && Number.isFinite(row.metrics.restartCount)) {
      const count = Math.max(0, row.metrics.restartCount - prev.metrics.restartCount);
      if (count) { restarts += count; event('restart', `${count} Docker restart${count === 1 ? '' : 's'}`); }
    }
    if (row.metrics.oomKilled && !prev.metrics.oomKilled) event('oom', 'Docker reported an out-of-memory kill');
  }
  return { events: events.reverse(), restarts };
}

function aggregate(rows, from, intervalMs) {
  const buckets = new Map();
  const totals = Object.fromEntries(METRICS.map((key) => [key, { sum: 0, count: 0, peak: null }]));
  for (const row of rows) {
    if (row.at < from) continue;
    const at = from + Math.floor((row.at - from) / intervalMs) * intervalMs;
    let bucket = buckets.get(at);
    if (!bucket) { bucket = { at, values: {} }; buckets.set(at, bucket); }
    for (const key of METRICS) {
      const value = row.metrics[key];
      if (!Number.isFinite(value)) continue;
      const entry = bucket.values[key] ||= { sum: 0, count: 0, peak: value };
      entry.sum += value;
      entry.count++;
      entry.peak = Math.max(entry.peak, value);
      const total = totals[key];
      total.sum += value;
      total.count++;
      total.peak = total.peak === null ? value : Math.max(total.peak, value);
    }
  }
  const points = [...buckets.values()].map(({ at, values }) => {
    const point = { at };
    for (const key of METRICS) {
      point[key] = values[key] ? values[key].sum / values[key].count : null;
      point[`${key}Peak`] = values[key]?.peak ?? null;
    }
    return point;
  });
  const summary = {};
  for (const [key, value] of Object.entries(totals)) {
    summary[`${key}Avg`] = value.count ? value.sum / value.count : null;
    summary[`${key}Peak`] = value.peak;
  }
  return { points, summary };
}

// One indexed row per target per sample, with a bounded query of at most 7 days.
// No external database service or native npm dependency is needed on Node 22.13+.
export class MetricsStore {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA auto_vacuum = INCREMENTAL;
      CREATE TABLE IF NOT EXISTS samples (
        target TEXT NOT NULL, at INTEGER NOT NULL, state TEXT NOT NULL,
        metrics TEXT NOT NULL, id TEXT, reason TEXT,
        PRIMARY KEY (target, at)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS samples_at ON samples(at);
      CREATE TABLE IF NOT EXISTS targets (
        target TEXT PRIMARY KEY, name TEXT NOT NULL, last_seen INTEGER NOT NULL
      );
    `);
    this.insert = this.db.prepare('INSERT OR REPLACE INTO samples VALUES (?, ?, ?, ?, ?, ?)');
    this.target = this.db.prepare('INSERT OR REPLACE INTO targets VALUES (?, ?, ?)');
  }

  record(at, samples) {
    this.db.exec('BEGIN');
    try {
      for (const sample of samples) {
        this.insert.run(sample.target, at, sample.state, JSON.stringify(sample.metrics || {}), sample.id || null, sample.reason || null);
        this.target.run(sample.target, sample.name, at);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  prune(retentionDays, now = Date.now()) {
    validateMetricsSettings({ retentionDays });
    const cutoff = now - retentionDays * DAY_MS;
    this.db.prepare('DELETE FROM samples WHERE at < ?').run(cutoff);
    this.db.prepare('DELETE FROM targets WHERE last_seen < ?').run(cutoff);
    this.db.exec('PRAGMA incremental_vacuum(1000)');
  }

  history({ target = 'host', range = '7d', retentionDays = 7, now = Date.now() } = {}) {
    parseHistoryQuery({ target, range });
    validateMetricsSettings({ retentionDays });
    const from = now - RANGES[range];
    const cutoff = now - retentionDays * DAY_MS;
    const intervalMs = Math.max(SAMPLE_MS, Math.ceil(RANGES[range] / 720 / SAMPLE_MS) * SAMPLE_MS);
    const rows = this.db.prepare('SELECT * FROM samples WHERE target = ? AND at >= ? AND at < ? ORDER BY at')
      .all(target, Math.max(cutoff, from - HOLD_MS), now)
      .map((row) => ({ ...row, metrics: JSON.parse(row.metrics) }));
    const intervals = availability(rows, from, now);
    const { points, summary } = aggregate(rows, from, intervalMs);
    const { events, restarts } = transitions(rows, from);
    const time = (state) => intervals.filter((i) => i.state === state).reduce((sum, i) => sum + i.to - i.from, 0);
    const unknownMs = time('unknown');
    const observedMs = now - from - unknownMs;
    return {
      target, range, from, to: now, intervalMs, retentionDays, sampleSeconds: SAMPLE_MS / 1000,
      targets: this.db.prepare('SELECT target, name, last_seen AS lastSeen FROM targets WHERE last_seen >= ? ORDER BY name').all(cutoff),
      points, availability: intervals, events: events.slice(0, 100),
      summary: {
        ...summary, observedMs, unknownMs, downMs: time('down'), unhealthyMs: time('unhealthy'),
        availabilityPercent: observedMs ? time('up') / observedMs * 100 : null,
        incidents: intervals.filter((i) => i.state === 'down').length, restarts,
      },
    };
  }

  close() { this.db.close(); }
}
