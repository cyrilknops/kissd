import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as host from '../src/host.js';

test('host snapshots expose per-core usage and share CPU samples with concurrent consumers', async (t) => {
  let now = 10000, reads = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(fs, 'readFile', async (path) => {
    if (path === '/proc/stat') {
      reads++;
      return reads === 1 ? 'cpu 100 0 0 100\ncpu0 100 0 0 100'
        : 'cpu 150 0 0 150\ncpu0 150 0 0 150';
    }
    if (path === '/proc/meminfo') return 'MemTotal: 1000\nMemAvailable: 500';
    if (path === '/proc/loadavg') return '0 0 0';
    if (path === '/proc/uptime') return '100 100';
    return '';
  });
  t.mock.method(fs, 'statfs', async () => { throw new Error('no host mount'); });
  const [a, b, cpu] = await Promise.all([host.snapshot(), host.snapshot(), host.cpu()]);
  assert.equal(reads, 1);
  assert.equal(a.cpu, 0);
  assert.equal(cpu, 0);
  assert.deepEqual(a.cpuPerCore, [{ id: 0, percent: null }]);
  assert.deepEqual(a.cpuPerCore, b.cpuPerCore);
  now += 500;
  await host.snapshot();
  assert.equal(reads, 1);
  now += 500;
  const next = await host.snapshot();
  assert.equal(reads, 2);
  assert.equal(next.cpu, 50);
  assert.deepEqual(next.cpuPerCore, [{ id: 0, percent: 50 }]);
  now += 1000;
  t.mock.method(fs, 'readFile', async () => { throw new Error('proc unavailable'); });
  await assert.rejects(host.cpu(), /proc unavailable/);
  t.mock.method(fs, 'readFile', async () => 'cpu 200 0 0 200\ncpu0 200 0 0 200');
  assert.equal(await host.cpu(), 50);
});
