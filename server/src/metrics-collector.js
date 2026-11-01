import { SAMPLE_MS } from './metrics-store.js';

function rate(current, previous, key, elapsed) {
  if (!previous || elapsed <= 0 || !Number.isFinite(current?.[key]) || !Number.isFinite(previous?.[key]) || current[key] < previous[key]) return null;
  return (current[key] - previous[key]) / elapsed;
}

export class MetricsCollector {
  constructor({ store, snapshot, list, stats, settings, onError = console.error, clock = Date.now }) {
    Object.assign(this, { store, snapshot, list, stats, settings, onError, clock });
    this.previous = new Map();
    this.timer = null;
    this.active = false;
    this.pending = null;
    this.lastPrune = 0;
    this.lastRetention = null;
    this.lastSampleAt = null;
    this.error = null;
  }

  collect() {
    if (this.pending) return this.pending;
    this.pending = this.sample().finally(() => { this.pending = null; });
    return this.pending;
  }

  async sample() {
    const [hostResult, containerResult] = await Promise.allSettled([
      this.snapshot(),
      this.list().then(async (containers) => ({ containers, stats: await this.stats(containers.filter((c) => c.state === 'running').map((c) => c.id)) })),
    ]);
    const at = this.clock();
    const samples = [];
    const next = new Map();
    const previousFor = (target, id) => {
      const prev = this.previous.get(target);
      return prev && prev.id === id && at - prev.at <= SAMPLE_MS * 1.5 ? prev : null;
    };
    if (hostResult.status === 'fulfilled') {
      const h = hostResult.value;
      const previous = previousFor('host', 'host');
      samples.push({ target: 'host', name: 'Host', state: 'up', metrics: {
        cpu: this.previous.has('host') ? h.cpu : null, memory: h.memory.used, memoryPercent: h.memory.percent,
        load: h.load.one, swapPercent: h.memory.swapPercent,
        diskPercent: h.disks.length ? Math.max(...h.disks.map((d) => d.percent)) : null,
        rxRate: rate(h.network, previous?.counters, 'rxBytes', previous ? (at - previous.at) / 1000 : 0),
        txRate: rate(h.network, previous?.counters, 'txBytes', previous ? (at - previous.at) / 1000 : 0),
        running: containerResult.status === 'fulfilled' ? containerResult.value.containers.filter((c) => c.state === 'running').length : null,
        unhealthy: containerResult.status === 'fulfilled' ? containerResult.value.containers.filter((c) => c.health === 'unhealthy').length : null,
      } });
      next.set('host', { id: 'host', at, counters: h.network });
    }
    if (containerResult.status === 'fulfilled') {
      for (const c of containerResult.value.containers) {
        const s = containerResult.value.stats[c.id];
        const target = `container:${c.name}`;
        const previous = previousFor(target, c.id);
        const elapsed = previous ? (at - previous.at) / 1000 : 0;
        const metrics = c.state === 'running' && s ? {
          cpu: s.cpu, memory: s.memory, memoryPercent: s.memoryLimit ? s.memory / s.memoryLimit * 100 : null,
          pids: s.pids, restartCount: s.restartCount, oomKilled: s.oomKilled,
          rxRate: rate(s, previous?.counters, 'rxBytes', elapsed), txRate: rate(s, previous?.counters, 'txBytes', elapsed),
          readRate: rate(s, previous?.counters, 'readBytes', elapsed), writeRate: rate(s, previous?.counters, 'writeBytes', elapsed),
        } : {};
        // Docker state still establishes availability even if resource sampling
        // failed. A resource error is never a claim that the container is down.
        samples.push({ target, name: c.name, id: c.id, state: c.state !== 'running' ? 'down' : c.health === 'unhealthy' ? 'unhealthy' : c.health === 'starting' ? 'unknown' : 'up', reason: c.health || c.state, metrics });
        next.set(target, { id: c.id, at, counters: s ? { ...s } : null });
      }
    }
    const failures = [hostResult, containerResult].filter((r) => r.status === 'rejected');
    this.error = failures.length ? 'Some metrics could not be collected. Missing observations are shown as unknown.' : null;
    if (samples.length) {
      this.store.record(at, samples);
      this.lastSampleAt = at;
    }
    this.previous = next;
    const { retentionDays } = this.settings().metrics;
    if (at - this.lastPrune >= 3600_000 || retentionDays !== this.lastRetention) {
      this.store.prune(retentionDays, at);
      this.lastPrune = at;
      this.lastRetention = retentionDays;
    }
  }

  start() {
    if (this.active) return;
    this.active = true;
    const tick = async () => {
      const started = this.clock();
      try { await this.collect(); }
      catch (err) { this.error = 'Metrics could not be saved'; this.onError(`metrics collection failed: ${err.message}`); }
      if (this.active) this.timer = setTimeout(tick, Math.max(1000, SAMPLE_MS - (this.clock() - started)));
    };
    tick();
  }

  async stop() {
    this.active = false;
    clearTimeout(this.timer);
    await this.pending;
  }
}
