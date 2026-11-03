// Host metrics. The container runs with pid:host, so /proc is the host's
// procfs and reports host-wide CPU/memory/load directly.
import fs from 'node:fs/promises';
import { createCpuSampler } from './host-cpu.js';

const HOST_ROOT = '/host/root';

// Filesystems worth showing. Everything else (overlay, tmpfs, cgroup, …) is
// either virtual or a container layer and would just be noise.
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'vfat', 'f2fs', 'jfs', 'reiserfs']);

async function readText(path) {
  return fs.readFile(path, 'utf8');
}

const sampleCpu = createCpuSampler();
let cpuSample = null;
let cpuSampleAt = 0;
let cpuPending = null;

async function cpuUsage() {
  // Overview, alerts and history share a sample instead of consuming each
  // other's baselines within the same scheduler tick.
  if (cpuSample && Date.now() - cpuSampleAt < 1000) return cpuSample;
  if (cpuPending) return cpuPending;
  cpuPending = readText('/proc/stat').then((text) => {
    cpuSample = sampleCpu(text);
    cpuSampleAt = Date.now();
    return cpuSample;
  }).finally(() => { cpuPending = null; });
  return cpuPending;
}

export async function cpu() {
  return (await cpuUsage()).total;
}

export async function memory() {
  const text = await readText('/proc/meminfo');
  const map = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) map[m[1]] = Number(m[2]) * 1024;
  }
  const total = map.MemTotal || 0;
  // MemAvailable is the honest number — it accounts for reclaimable cache.
  const available = map.MemAvailable ?? map.MemFree ?? 0;
  const swapTotal = map.SwapTotal || 0;
  const swapUsed = swapTotal - (map.SwapFree || 0);
  return {
    total,
    used: total - available,
    available,
    percent: total ? ((total - available) / total) * 100 : 0,
    swapTotal,
    swapUsed,
    swapPercent: swapTotal ? (swapUsed / swapTotal) * 100 : 0,
  };
}

export async function load() {
  const [one, five, fifteen] = (await readText('/proc/loadavg')).split(/\s+/);
  return { one: Number(one), five: Number(five), fifteen: Number(fifteen), cores: cpuCount };
}

export async function uptime() {
  const [secs] = (await readText('/proc/uptime')).split(/\s+/);
  return Number(secs);
}

let lastNet = null;

export async function network() {
  // /proc/net/dev is per network namespace, and this container has its own
  // (it sits on proxy-tier). PID 1 is the host's init, so its view is the
  // host's real interfaces.
  let text;
  try {
    text = await readText('/proc/1/net/dev');
  } catch {
    text = await readText('/proc/net/dev');
  }
  let rx = 0;
  let tx = 0;
  for (const line of text.split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest) continue;
    const iface = name.trim();
    // Skip loopback and virtual interfaces so the number reflects real traffic.
    if (iface === 'lo' || /^(veth|docker|br-)/.test(iface)) continue;
    const cols = rest.trim().split(/\s+/).map(Number);
    rx += cols[0];
    tx += cols[8];
  }
  const now = Date.now();
  const prev = lastNet;
  lastNet = { rx, tx, now };
  if (!prev) return { rxBytes: rx, txBytes: tx, rxRate: 0, txRate: 0 };
  const dt = (now - prev.now) / 1000;
  return {
    rxBytes: rx,
    txBytes: tx,
    rxRate: dt > 0 ? Math.max(0, (rx - prev.rx) / dt) : 0,
    txRate: dt > 0 ? Math.max(0, (tx - prev.tx) / dt) : 0,
  };
}

export async function disks() {
  let mounts = [];
  try {
    // PID 1 is the host's init (pid:host), so its mount table is the host's,
    // not the container's.
    const text = await readText('/proc/1/mounts');
    for (const line of text.split('\n')) {
      const [dev, mountPoint, type] = line.split(/\s+/);
      if (!mountPoint || !REAL_FS.has(type)) continue;
      if (mountPoint.startsWith('/host/root')) continue;
      mounts.push({ dev, mountPoint });
    }
  } catch {
    mounts = [];
  }
  if (!mounts.length) mounts = [{ dev: 'rootfs', mountPoint: '/' }];

  // De-duplicate: bind mounts and snap loopbacks repeat the same device.
  const seen = new Set();
  const out = [];
  for (const { dev, mountPoint } of mounts) {
    const probe = mountPoint === '/' ? HOST_ROOT : `${HOST_ROOT}${mountPoint}`;
    try {
      const st = await fs.statfs(probe);
      const total = st.blocks * st.bsize;
      if (!total) continue;
      const key = `${total}:${st.blocks}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const free = st.bavail * st.bsize;
      const used = total - st.bfree * st.bsize;
      out.push({
        device: dev,
        mountPoint,
        total,
        used,
        free,
        percent: total ? (used / (used + free || total)) * 100 : 0,
      });
    } catch {
      // Mount point not visible through the read-only root bind; skip it.
    }
  }
  return out.sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
}

let cpuCount = 1;
try {
  const text = await readText('/proc/cpuinfo');
  cpuCount = (text.match(/^processor\s*:/gm) || []).length || 1;
} catch {
  cpuCount = 1;
}

export async function snapshot() {
  const [c, m, l, u, n, d] = await Promise.all([
    cpuUsage(), memory(), load(), uptime(), network(), disks(),
  ]);
  return { cpu: c.total, cpuPerCore: c.perCore, cores: cpuCount, memory: m, load: l, uptime: u, network: n, disks: d, at: Date.now() };
}
