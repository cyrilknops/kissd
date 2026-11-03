import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../src/metrics-collector.js';

function fixture(overrides = {}) {
  let now = 1_000_000;
  const records = [], prunes = [], errors = [];
  const host = { cpu: 12, memory: { used: 500, percent: 50, swapPercent: 0 }, load: { one: 0.5 }, disks: [{ percent: 30 }], network: { rxBytes: 1000, txBytes: 500 } };
  const containers = [{ id: 'one', name: 'web', state: 'running', health: null }];
  const stats = { one: { cpu: 3, memory: 100, memoryLimit: 200, rxBytes: 100, txBytes: 50, readBytes: 0, writeBytes: 0, restartCount: 0 } };
  const settings = { metrics: { retentionDays: 7 } };
  const collector = new MetricsCollector({
    store: { record: (at, samples) => records.push({ at, samples }), prune: (...args) => prunes.push(args) },
    snapshot: async () => structuredClone(host), list: async () => containers, stats: async () => stats,
    settings: () => settings, clock: () => now, onError: (error) => errors.push(error), ...overrides,
  });
  return { collector, records, prunes, errors, host, containers, stats, settings, advance: (ms = 30_000) => { now += ms; } };
}

test('collects without browser requests, keeps stable names and derives rates from its own counters', async () => {
  const f = fixture();
  await f.collector.collect();
  assert.equal(f.records[0].samples[0].metrics.cpu, null);
  assert.equal(f.records[0].samples[1].target, 'container:web');
  assert.equal(f.records[0].samples[1].metrics.rxRate, null);
  f.advance();
  f.stats.one.rxBytes += 300;
  f.host.network.rxBytes += 600;
  await f.collector.collect();
  assert.equal(f.records[1].samples[0].metrics.rxRate, 20);
  assert.equal(f.records[1].samples[1].metrics.rxRate, 10);
  assert.equal(f.records[1].samples[1].metrics.memoryPercent, 50);
  assert.equal(f.collector.error, null);
});

test('persists observed host/container CPU series and keeps pinning separate from usage', async () => {
  const f = fixture();
  f.host.cpuPerCore = [{ id: 0, percent: null }, { id: 2, percent: null }];
  f.stats.one.cpuPerCore = null;
  f.stats.one.cpuSet = '0,2';
  await f.collector.collect();
  assert.deepEqual(f.records[0].samples[0].metrics.cpuPerCore, f.host.cpuPerCore);
  assert.equal(f.records[0].samples[1].metrics.cpuPerCore, null);
  assert.equal(f.records[0].samples[1].metrics.cpuSet, '0,2');
  f.advance();
  f.host.cpuPerCore = [{ id: 0, percent: 20 }, { id: 2, percent: 80 }];
  f.stats.one.cpuPerCore = [{ id: 0, percent: 0 }, { id: 2, percent: 3 }];
  await f.collector.collect();
  assert.deepEqual(f.records[1].samples[0].metrics.cpuPerCore, f.host.cpuPerCore);
  assert.deepEqual(f.records[1].samples[1].metrics.cpuPerCore, f.stats.one.cpuPerCore);
  f.advance();
  f.containers[0].state = 'exited';
  await f.collector.collect();
  assert.deepEqual(f.records[2].samples[1].metrics, {});
});

test('counter resets, recreated containers, and long gaps produce no bogus rate spikes', async () => {
  const f = fixture();
  await f.collector.collect();
  f.advance();
  f.stats.one.rxBytes = 1;
  await f.collector.collect();
  assert.equal(f.records.at(-1).samples[1].metrics.rxRate, null);
  f.advance(90_000);
  await f.collector.collect();
  assert.equal(f.records.at(-1).samples[1].metrics.rxRate, null);
  f.advance();
  f.containers[0].id = 'two';
  f.stats.two = f.stats.one;
  await f.collector.collect();
  assert.equal(f.records.at(-1).samples[1].metrics.rxRate, null);
});

test('resource sampling failure does not imply downtime, while stopped/unhealthy/starting states are recorded', async () => {
  const f = fixture();
  f.stats.one = null;
  await f.collector.collect();
  assert.equal(f.records.at(-1).samples[1].state, 'up');
  for (const [state, health, expected] of [['exited', null, 'down'], ['running', 'unhealthy', 'unhealthy'], ['running', 'starting', 'unknown']]) {
    f.advance();
    Object.assign(f.containers[0], { state, health });
    await f.collector.collect();
    assert.equal(f.records.at(-1).samples[1].state, expected);
  }
});

test('Docker failure still records host data and reports missing observations', async () => {
  const f = fixture({ list: async () => { throw new Error('Docker unavailable'); } });
  await f.collector.collect();
  assert.equal(f.records[0].samples.length, 1);
  assert.equal(f.records[0].samples[0].target, 'host');
  assert.match(f.collector.error, /could not be collected/);
});

test('host failure still records container data; total failure fabricates no samples', async () => {
  const f = fixture({ snapshot: async () => { throw new Error('proc unavailable'); } });
  await f.collector.collect();
  assert.equal(f.records[0].samples.length, 1);
  assert.equal(f.records[0].samples[0].target, 'container:web');
  f.collector.list = async () => { throw new Error('Docker unavailable'); };
  f.advance();
  await f.collector.collect();
  assert.equal(f.records.length, 1);
});

test('collection never overlaps and retention changes trigger cleanup on the next sample', async () => {
  let resolve;
  const f = fixture({ snapshot: () => new Promise((r) => { resolve = r; }) });
  const first = f.collector.collect();
  assert.equal(f.collector.collect(), first);
  resolve(f.host);
  await first;
  f.collector.snapshot = async () => f.host;
  f.settings.metrics.retentionDays = 2;
  f.advance();
  await f.collector.collect();
  assert.deepEqual(f.prunes.map((p) => p[0]), [7, 2]);
});

test('timer starts sampling immediately, is idempotent and stops cleanly', async () => {
  const f = fixture();
  f.collector.start();
  f.collector.start();
  await f.collector.pending;
  assert.equal(f.records.length, 1);
  await f.collector.stop();
  assert.equal(f.collector.active, false);
});

test('persistence errors are surfaced and do not kill the background loop', async () => {
  const f = fixture({ store: { record: () => { throw new Error('disk full'); } } });
  f.collector.start();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.match(f.collector.error, /could not be saved/);
  assert.match(f.errors[0], /disk full/);
  await f.collector.stop();
});
