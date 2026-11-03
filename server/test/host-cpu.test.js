import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCpuSampler } from '../src/host-cpu.js';

test('aggregate and each logical CPU use their own interval, including idle and iowait', () => {
  const sample = createCpuSampler();
  assert.deepEqual(sample('cpu  60 0 20 100 20 0 0 0\ncpu0 10 0 10 50 10 0 0 0\ncpu2 50 0 10 50 10 0 0 0\nintr 123'), {
    total: 0, perCore: [{ id: 0, percent: null }, { id: 2, percent: null }],
  });
  assert.deepEqual(sample('cpu  110 0 30 220 40 0 0 0\ncpu2 100 0 20 80 20 0 0 0\ncpu0 10 0 10 140 20 0 0 0'), {
    total: 30, perCore: [{ id: 0, percent: 0 }, { id: 2, percent: 60 }],
  });
});

test('guest counters are not double counted; irq, softirq and steal are busy time', () => {
  const sample = createCpuSampler();
  sample('cpu 100 10 20 100 0 0 0 0 50 5\ncpu0 100 10 20 100 0 0 0 0 50 5');
  const result = sample('cpu 120 20 20 150 0 5 5 10 70 15\ncpu0 120 20 20 150 0 5 5 10 70 15');
  assert.deepEqual(result, { total: 50, perCore: [{ id: 0, percent: 50 }] });
});

test('CPU IDs remain stable across hotplug and reappearing CPUs need a fresh baseline', () => {
  const sample = createCpuSampler();
  sample('cpu0 100 0 0 100\ncpu2 100 0 0 100\ncpu10 100 0 0 100');
  assert.deepEqual(sample('cpu10 110 0 0 110\ncpu2 120 0 0 100\ncpu3 500 0 0 100').perCore, [
    { id: 2, percent: 100 }, { id: 3, percent: null }, { id: 10, percent: 50 },
  ]);
  assert.deepEqual(sample('cpu0 1000 0 0 1000').perCore, [{ id: 0, percent: null }]);
});

test('unchanged or reset counters are unknown and recover on the next interval', () => {
  const sample = createCpuSampler();
  const row = 'cpu0 100 0 0 100';
  sample(row);
  assert.equal(sample(row).perCore[0].percent, null);
  assert.equal(sample('cpu0 1 0 0 1').perCore[0].percent, null);
  assert.equal(sample('cpu0 2 0 0 2').perCore[0].percent, 50);
  // Linux permits iowait to decrease; do not invent a utilization spike.
  assert.equal(sample('cpu0 100 0 0 1').perCore[0].percent, null);
  assert.equal(sample('cpu0 110 0 0 11').perCore[0].percent, 50);
});

test('malformed CPU rows and unrelated proc counters cannot emit invalid percentages', () => {
  const sample = createCpuSampler();
  assert.deepEqual(sample('cpu nope 0 0 0\ncpu0 1 2\ncpu1 -1 0 0 1\ncpu2 Infinity 0 0 1\ncpu3 0 0 0 1\nintr 500'), {
    total: 0, perCore: [{ id: 3, percent: null }],
  });
  assert.deepEqual(sample(''), { total: 0, perCore: [] });
});
