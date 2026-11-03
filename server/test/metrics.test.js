import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MetricsStore, validateMetricsSettings, parseHistoryQuery } from '../src/metrics-store.js';

const MINUTE = 60_000;
const now = 10 * 86400_000;
function store(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kissd-metrics-'));
  const file = path.join(dir, 'metrics.sqlite');
  const db = new MetricsStore(file);
  t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { db, file };
}
function sample(db, at, state = 'up', metrics = { cpu: 10, memory: 100 }, id = 'one') {
  db.record(at, [{ target: 'container:web', name: 'web', state, metrics, id }]);
}

test('history survives a restart and uses private file permissions', (t) => {
  const { db, file } = store(t);
  sample(db, now - MINUTE);
  const reopened = new MetricsStore(file);
  t.after(() => reopened.close());
  const history = reopened.history({ target: 'container:web', range: '1h', now });
  assert.equal(history.points[0].cpu, 10);
  assert.equal(history.targets[0].name, 'web');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('per-core history survives restart, preserves unknowns and supports existing aggregate-only samples', (t) => {
  const { db, file } = store(t);
  sample(db, now - 120_000, 'up', { cpu: 20 });
  sample(db, now - 90_000, 'up', { cpu: 30, cpuPerCore: [{ id: 0, percent: null }, { id: 2, percent: null }] });
  sample(db, now - 60_000, 'up', { cpu: 40, cpuPerCore: [{ id: 0, percent: 0 }, { id: 2, percent: 80 }], cpuSet: '0,2' });
  sample(db, now - 30_000, 'up', { cpu: 50, cpuPerCore: [{ id: 0, percent: 20 }, { id: 2, percent: 100 }], cpuSet: '' });
  const reopened = new MetricsStore(file);
  t.after(() => reopened.close());
  const h = reopened.history({ target: 'container:web', range: '1h', now });
  assert.deepEqual(h.cpuCores, [0, 2]);
  assert.deepEqual(h.points.map((p) => p.cpuCore0), [null, null, 0, 20]);
  assert.deepEqual(h.points.map((p) => p.cpuCore2), [null, null, 80, 100]);
  assert.equal(h.summary.cpuCore0Avg, 10);
  assert.equal(h.summary.cpuCore2Peak, 100);
  assert.equal(h.summary.cpuAvg, 35);
  assert.equal(h.cpuSet, '');
});

test('downsampling retains each CPU average and peak without replacing absent CPUs with zero', (t) => {
  const { db } = store(t);
  const from = now - 7 * 86400_000;
  sample(db, from + 30_000, 'up', { cpuPerCore: [{ id: 2, percent: 10 }, { id: 10, percent: 100 }] });
  sample(db, from + 60_000, 'up', { cpuPerCore: [{ id: 2, percent: 90 }] });
  sample(db, from + 900_000, 'up', { cpuPerCore: [{ id: 0, percent: 50 }, { id: 10, percent: null }] });
  const h = db.history({ target: 'container:web', range: '7d', now });
  assert.deepEqual(h.cpuCores, [0, 2, 10]);
  assert.equal(h.points.length, 2);
  assert.equal(h.points[0].cpuCore2, 50);
  assert.equal(h.points[0].cpuCore2Peak, 90);
  assert.equal(h.points[0].cpuCore10, 100);
  assert.equal(h.points[0].cpuCore0, null);
  assert.equal(h.points[1].cpuCore2, null);
  assert.equal(h.points[1].cpuCore10, null);
  assert.equal(h.summary.cpuCore2Avg, 50);
});

test('per-core series respect retention and ignore invalid CPU IDs', (t) => {
  const { db } = store(t);
  sample(db, now - 2 * 86400_000, 'up', { cpuPerCore: [{ id: 99, percent: 50 }] });
  sample(db, now - 30_000, 'up', { cpuPerCore: [null, { id: -1, percent: 5 }, { id: '0', percent: 5 }, { id: 2, percent: null }] });
  const h = db.history({ target: 'container:web', range: '7d', retentionDays: 1, now });
  assert.deepEqual(h.cpuCores, [2]);
  assert.equal(h.points[0].cpuCore2, null);
  assert.equal(h.summary.cpuCore2Avg, null);
  assert.equal(h.summary.cpuCore2Peak, null);
  assert.deepEqual(db.history({ range: '1h', now }).cpuCores, []);
});

test('down and unhealthy time are separate from unobserved time', (t) => {
  const { db } = store(t);
  sample(db, now - 120_000);
  sample(db, now - 90_000, 'down', {});
  sample(db, now - 60_000, 'unhealthy');
  sample(db, now - 30_000);
  const h = db.history({ target: 'container:web', range: '1h', now });
  assert.equal(h.summary.downMs, 30_000);
  assert.equal(h.summary.unhealthyMs, 30_000);
  assert.equal(h.summary.observedMs, 120_000);
  assert.equal(h.summary.unknownMs, 3600_000 - 120_000);
  assert.equal(h.summary.availabilityPercent, 50);
  assert.equal(h.summary.incidents, 1);
  assert.ok(h.events.some((e) => e.type === 'recovered'));
});

test('collector gaps and time before the first sample are unknown, never downtime', (t) => {
  const { db } = store(t);
  sample(db, now - 600_000, 'down', {});
  sample(db, now - 30_000);
  const h = db.history({ target: 'container:web', range: '1h', now });
  assert.equal(h.summary.downMs, 45_000);
  assert.equal(h.summary.observedMs, 75_000);
  assert.equal(h.summary.unknownMs, 3600_000 - 75_000);
  assert.ok(!h.events.some((e) => e.type === 'recovered'));
});

test('range boundary carries a recent sample forward and clips its interval', (t) => {
  const { db } = store(t);
  sample(db, now - 3600_000 - 10_000, 'down', {});
  const h = db.history({ target: 'container:web', range: '1h', now });
  assert.equal(h.summary.downMs, 35_000);
  assert.equal(h.availability[0].from, h.from);
  assert.equal(h.availability.at(-1).to, now);
});

test('downsampling bounds points while retaining peaks and missing values', (t) => {
  const { db } = store(t);
  for (let i = 0; i < 20160; i++) sample(db, now - (20160 - i) * 30_000, 'up', { cpu: i === 10 ? 99 : 1, memory: 100 });
  const h = db.history({ target: 'container:web', range: '7d', now });
  assert.ok(h.points.length <= 720);
  assert.equal(h.summary.cpuPeak, 99);
  assert.ok(h.points.some((p) => p.cpuPeak === 99));
  assert.equal(h.summary.cpuAvg > 1, true);
  assert.equal(h.points[0].rxRate, null);
});

test('container replacement keeps name history and detects restarts without counter reset spikes', (t) => {
  const { db } = store(t);
  sample(db, now - 90_000, 'up', { restartCount: 3 });
  sample(db, now - 60_000, 'up', { restartCount: 5 });
  sample(db, now - 30_000, 'up', { restartCount: 0 }, 'two');
  const h = db.history({ target: 'container:web', range: '1h', now });
  assert.equal(h.summary.restarts, 2);
  assert.ok(h.events.some((e) => e.type === 'recreated'));
  assert.equal(h.targets.length, 1);
});

test('retention prunes stored samples and target metadata', (t) => {
  const { db } = store(t);
  sample(db, now - 8 * 86400_000);
  db.record(now - 30_000, [{ target: 'host', name: 'Host', state: 'up', metrics: { cpu: 3 } }]);
  db.prune(7, now);
  const h = db.history({ target: 'container:web', range: '7d', now });
  assert.equal(h.points.length, 0);
  assert.equal(h.targets.length, 1);
  assert.equal(h.summary.availabilityPercent, null);
});

test('retention applies at query time even before scheduled cleanup', (t) => {
  const { db } = store(t);
  sample(db, now - 2 * 86400_000);
  const h = db.history({ target: 'container:web', range: '7d', retentionDays: 1, now });
  assert.equal(h.points.length, 0);
  assert.equal(h.summary.observedMs, 0);
});

test('empty history and SQL-like target strings are safe', (t) => {
  const { db } = store(t);
  const h = db.history({ target: "container:'; DROP TABLE samples;--", range: '1h', now });
  assert.equal(h.summary.availabilityPercent, null);
  assert.equal(h.summary.unknownMs, 3600_000);
  sample(db, now - 30_000);
  assert.equal(db.history({ target: 'container:web', range: '1h', now }).points.length, 1);
});

test('a failed sample transaction leaves no partial observations behind', (t) => {
  const { db } = store(t);
  assert.throws(() => db.record(now - 30_000, [
    { target: 'host', name: 'Host', state: 'up', metrics: { cpu: 5 } },
    { target: 'container:broken', state: 'up' },
  ]));
  const h = db.history({ range: '1h', now });
  assert.equal(h.points.length, 0);
  assert.equal(h.targets.length, 0);
});

test('only supported bounded timeframes and valid retention settings are accepted', () => {
  for (const range of ['1h', '3h', '1d', '3d', '7d']) assert.equal(parseHistoryQuery({ range }).range, range);
  assert.deepEqual(parseHistoryQuery({}), { range: '7d', target: 'host' });
  for (const query of [{ range: '90d' }, { range: ['1h'] }, { target: {} }, { target: 'x'.repeat(300) }]) {
    assert.throws(() => parseHistoryQuery(query));
  }
  for (const retentionDays of [1, 7, 90]) assert.doesNotThrow(() => validateMetricsSettings({ retentionDays }));
  for (const value of [null, [], { retentionDays: 0 }, { retentionDays: 91 }, { retentionDays: 1.5 }, { retentionDays: '7' }]) {
    assert.throws(() => validateMetricsSettings(value));
  }
});
