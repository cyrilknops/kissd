// Linux accounts for each logical CPU separately in /proc/stat. Keep baselines
// by CPU ID so offline/new CPUs cannot shift another CPU's readings.
export function createCpuSampler() {
  let previous = new Map();
  return (text) => {
    const current = new Map();
    const usage = new Map();
    for (const line of text.split('\n')) {
      const match = line.match(/^(cpu\d*)\s+(.+)$/);
      if (!match) continue;
      // guest and guest_nice are already included in user and nice. Summing
      // them again would inflate utilization on virtualization hosts.
      const times = match[2].trim().split(/\s+/).slice(0, 8).map(Number);
      if (times.length < 4 || times.some((n) => !Number.isFinite(n) || n < 0)) continue;
      const idle = times[3] + (times[4] || 0);
      const total = times.reduce((a, b) => a + b, 0);
      const prev = previous.get(match[1]);
      current.set(match[1], { idle, total });
      const dt = prev ? total - prev.total : 0;
      const di = prev ? idle - prev.idle : 0;
      usage.set(match[1], dt > 0 && di >= 0
        ? Math.max(0, Math.min(100, (dt - di) / dt * 100)) : null);
    }
    previous = current;
    return {
      total: usage.get('cpu') ?? 0,
      perCore: [...usage].filter(([id]) => id !== 'cpu')
        .map(([id, percent]) => ({ id: Number(id.slice(3)), percent }))
        .sort((a, b) => a.id - b.id),
    };
  };
}
