import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as dockerApi from '../src/docker.js';

test('background and page stats share a completed batch with network, I/O and restart counters', async (t) => {
  const original = dockerApi.docker.getContainer;
  const originalNow = Date.now;
  let now = 1_000_000, calls = 0;
  Date.now = () => now;
  dockerApi.docker.getContainer = () => ({
    stats: async ({ stream, abortSignal }) => {
      calls++;
      assert.equal(stream, false);
      assert.ok(abortSignal instanceof AbortSignal);
      return {
        precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
        cpu_stats: { cpu_usage: { total_usage: 200 }, system_cpu_usage: 2000, online_cpus: 4 },
        memory_stats: { usage: 200, limit: 1000, stats: { inactive_file: 50 } },
        networks: { eth0: { rx_bytes: 100, tx_bytes: 200 }, eth1: { rx_bytes: 20, tx_bytes: 30 } },
        blkio_stats: { io_service_bytes_recursive: [{ op: 'Read', value: 50 }, { op: 'Write', value: 60 }, { op: 'Total', value: 110 }] },
        pids_stats: { current: 5 },
      };
    },
    inspect: async () => ({ RestartCount: 3, State: { OOMKilled: false } }),
  });
  t.after(() => { dockerApi.docker.getContainer = original; Date.now = originalNow; });
  const [a, b] = await Promise.all([dockerApi.refreshStats(['one']), dockerApi.refreshStats(['one'])]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.deepEqual(a.one, { cpu: 40, cpuPerCore: null, cpuSet: null, memory: 150, memoryLimit: 1000, rxBytes: 120, txBytes: 230, readBytes: 50, writeBytes: 60, pids: 5, restartCount: 3, oomKilled: false });
  assert.equal(dockerApi.stats(['one']), a);
  assert.equal(await dockerApi.statsOne('one'), a.one);
  assert.equal(calls, 1);
  now += 6000;
  await dockerApi.refreshStats(['one']);
  assert.equal(calls, 2);
  // A newly discovered ID must be sampled even while the shared cache is fresh.
  await dockerApi.refreshStats(['new']);
  assert.equal(calls, 3);
});

test('Docker sampling failures return missing data and first CPU readings do not create lifetime spikes', async (t) => {
  const original = dockerApi.docker.getContainer;
  dockerApi.docker.getContainer = (id) => ({
    stats: async () => {
      if (id === 'failed') throw new Error('gone');
      return { cpu_stats: { cpu_usage: { total_usage: 12345 }, system_cpu_usage: 50000 } };
    },
    inspect: async () => { throw new Error('gone'); },
  });
  t.after(() => { dockerApi.docker.getContainer = original; });
  const data = await dockerApi.refreshStats(['failed', 'warmup']);
  assert.equal(data.failed, null);
  assert.equal(data.warmup.cpu, null);
  assert.equal(data.warmup.restartCount, null);
});

test('container per-core deltas identify actual CPU use independently of configured pinning', async (t) => {
  t.mock.method(dockerApi.docker, 'getContainer', () => ({
    stats: async () => ({
      precpu_stats: { cpu_usage: { total_usage: 100, percpu_usage: [0, 0, 100, 0] }, system_cpu_usage: 1000 },
      cpu_stats: { cpu_usage: { total_usage: 250, percpu_usage: [50, 100, 100, 0] }, system_cpu_usage: 2000, online_cpus: 4 },
    }),
    inspect: async () => ({ HostConfig: { CpusetCpus: '0-2' }, State: { Running: true } }),
  }));
  const s = await dockerApi.statsOne('per-core');
  assert.equal(s.cpu, 60);
  assert.deepEqual(s.cpuPerCore, [
    { id: 0, percent: 20 }, { id: 1, percent: 40 }, { id: 2, percent: 0 }, { id: 3, percent: 0 },
  ]);
  assert.equal(s.cpuSet, '0-2');
  assert.equal((await dockerApi.detail('per-core')).cpuSet, '0-2');
});

test('missing Docker counters never imply a core assignment; resets and new CPUs need baselines', async (t) => {
  const samples = {
    unsupported: { cpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 2000 } },
    first: { cpu_stats: { cpu_usage: { total_usage: 100, percpu_usage: [50, 50] }, system_cpu_usage: 2000 } },
    reset: {
      precpu_stats: { cpu_usage: { total_usage: 100, percpu_usage: [100, 0] }, system_cpu_usage: 1000 },
      cpu_stats: { cpu_usage: { total_usage: 250, percpu_usage: [1, 100, 100] }, system_cpu_usage: 2000, online_cpus: 4 },
    },
    unchanged: {
      precpu_stats: { cpu_usage: { total_usage: 100, percpu_usage: [50, 50] }, system_cpu_usage: 2000 },
      cpu_stats: { cpu_usage: { total_usage: 100, percpu_usage: [50, 50] }, system_cpu_usage: 2000 },
    },
  };
  t.mock.method(dockerApi.docker, 'getContainer', (id) => ({
    stats: async () => samples[id], inspect: async () => ({ HostConfig: { CpusetCpus: '' } }),
  }));
  assert.equal((await dockerApi.statsOne('unsupported')).cpuPerCore, null);
  assert.equal((await dockerApi.statsOne('unsupported')).cpuSet, '');
  assert.deepEqual((await dockerApi.statsOne('first')).cpuPerCore, [{ id: 0, percent: null }, { id: 1, percent: null }]);
  assert.deepEqual((await dockerApi.statsOne('reset')).cpuPerCore, [{ id: 0, percent: null }, { id: 1, percent: 40 }, { id: 2, percent: null }]);
  assert.deepEqual((await dockerApi.statsOne('unchanged')).cpuPerCore, [{ id: 0, percent: null }, { id: 1, percent: null }]);
});
