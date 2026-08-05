// Docker layer. Container listing/actions go through the API (dockerode);
// updates deliberately shell out to `docker compose` so a container is
// recreated exactly as its compose file declares, rather than from a
// hand-rebuilt config.
import Docker from 'dockerode';
import { spawn } from 'node:child_process';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export const SELF_NAME = process.env.SELF_NAME || 'kissd';

const L = {
  project: 'com.docker.compose.project',
  workdir: 'com.docker.compose.project.working_dir',
  files: 'com.docker.compose.project.config_files',
  service: 'com.docker.compose.service',
};

function parseHealth(status = '') {
  if (status.includes('(healthy)')) return 'healthy';
  if (status.includes('(unhealthy)')) return 'unhealthy';
  if (status.includes('(health: starting)')) return 'starting';
  return null;
}

function shortName(names = []) {
  return (names[0] || '').replace(/^\//, '');
}

export function composeInfo(labels = {}) {
  const workdir = labels[L.workdir];
  const service = labels[L.service];
  if (!workdir || !service) return null;
  return {
    project: labels[L.project] || '',
    workdir,
    service,
    files: (labels[L.files] || '').split(',').map((f) => f.trim()).filter(Boolean),
  };
}

export async function list() {
  const raw = await docker.listContainers({ all: true });
  return raw.map((c) => ({
    id: c.Id,
    name: shortName(c.Names),
    image: c.Image,
    state: c.State,
    status: c.Status,
    health: parseHealth(c.Status),
    created: c.Created * 1000,
    ports: (c.Ports || [])
      .filter((p) => p.PublicPort)
      .map((p) => `${p.PublicPort}:${p.PrivatePort}/${p.Type}`),
    compose: composeInfo(c.Labels),
    isSelf: shortName(c.Names) === SELF_NAME,
  }));
}

// Stats are expensive: Docker samples over ~1s per container, so 22 containers
// at concurrency 8 costs several seconds. Nothing may wait on that — the
// container list is served from cache and the sample runs in the background.
let statsCache = { at: 0, data: {} };
let statsRefreshing = false;
const STATS_TTL = 5000;

// CPU% is a rate, so it needs two samples. Docker zeroes precpu_stats on the
// first read of a container; treating that as a delta yields the container's
// *lifetime* average against system time, which for a long-running container
// reads as a huge bogus spike (emqx showed 150% at 0.5% actual). Return null
// instead and let the next sample, 5s later, produce a real number.
function computeCpuPercent(s) {
  const prevCpu = s.precpu_stats?.cpu_usage?.total_usage;
  const prevSys = s.precpu_stats?.system_cpu_usage;
  if (!prevCpu || !prevSys) return null;

  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - prevCpu;
  const sysDelta = s.cpu_stats.system_cpu_usage - prevSys;
  if (sysDelta <= 0) return null;
  if (cpuDelta <= 0) return 0;

  const cores = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  return Math.max(0, (cpuDelta / sysDelta) * cores * 100);
}

async function mapLimited(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function sampleStats(ids) {
  const data = {};
  await mapLimited(ids, 8, async (id) => {
    try {
      const s = await docker.getContainer(id).stats({ stream: false });
      const usage = s.memory_stats?.usage || 0;
      // `cache` is reclaimable and inflates usage; Docker's own CLI subtracts it.
      const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
      data[id] = {
        cpu: computeCpuPercent(s),
        memory: Math.max(0, usage - cache),
        memoryLimit: s.memory_stats?.limit || 0,
      };
    } catch {
      data[id] = null;
    }
  });
  return data;
}

// Returns immediately with whatever has been sampled so far, kicking off a
// refresh when the cache is stale. Callers get slightly-old numbers rather
// than a slow response; the client re-polls every 5s so they fill in.
export function stats(ids) {
  if (Date.now() - statsCache.at >= STATS_TTL && !statsRefreshing) {
    statsRefreshing = true;
    sampleStats(ids)
      .then((data) => { statsCache = { at: Date.now(), data }; })
      .catch(() => {})
      .finally(() => { statsRefreshing = false; });
  }
  return statsCache.data;
}

// The detail page shows one container, so a direct sample is cheap enough to
// wait for when that container isn't in the cache yet.
export async function statsOne(id) {
  // Already sampled at some point: hand back what we have (at most a few
  // seconds old) and let the periodic refresh update it. Only a container the
  // cache has never seen is worth waiting ~1s to sample.
  if (statsCache.data[id] !== undefined) return statsCache.data[id];
  const data = await sampleStats([id]);
  statsCache = { at: statsCache.at, data: { ...statsCache.data, ...data } };
  return data[id] ?? null;
}

// Warm the cache at boot so the first page load already has numbers.
export async function primeStats() {
  try {
    const running = (await list()).filter((c) => c.state === 'running').map((c) => c.id);
    statsCache = { at: Date.now(), data: await sampleStats(running) };
  } catch {
    // Not fatal — the first client poll will trigger a refresh anyway.
  }
}

export async function action(id, verb) {
  const container = docker.getContainer(id);
  if (verb === 'start') return container.start();
  if (verb === 'stop') return container.stop({ t: 10 });
  if (verb === 'restart') return container.restart({ t: 10 });
  throw new Error(`Unknown action: ${verb}`);
}

export async function inspect(id) {
  return docker.getContainer(id).inspect();
}

function portList(networkSettings = {}) {
  const out = [];
  for (const [internal, bindings] of Object.entries(networkSettings.Ports || {})) {
    if (!bindings || !bindings.length) {
      out.push({ internal, published: null });
      continue;
    }
    for (const b of bindings) {
      // Docker lists both the v4 and v6 binding; they're the same port.
      if (b.HostIp === '::') continue;
      out.push({ internal, published: `${b.HostIp || '0.0.0.0'}:${b.HostPort}` });
    }
  }
  return out;
}

export async function detail(id) {
  const info = await docker.getContainer(id).inspect();
  const labels = info.Config?.Labels || {};
  const name = (info.Name || '').replace(/^\//, '');

  return {
    id: info.Id,
    name,
    image: info.Config?.Image || '',
    imageId: info.Image || '',
    state: info.State?.Status || 'unknown',
    running: Boolean(info.State?.Running),
    health: info.State?.Health?.Status || null,
    // The last few healthcheck runs explain *why* something is unhealthy.
    healthLog: (info.State?.Health?.Log || []).slice(-3).map((l) => ({
      exitCode: l.ExitCode,
      start: l.Start,
      output: (l.Output || '').slice(0, 500),
    })),
    created: info.Created,
    startedAt: info.State?.StartedAt || null,
    finishedAt: info.State?.FinishedAt || null,
    exitCode: info.State?.ExitCode ?? null,
    restartCount: info.RestartCount || 0,
    restartPolicy: info.HostConfig?.RestartPolicy?.Name || 'no',
    command: [info.Path, ...(info.Args || [])].filter(Boolean).join(' '),
    ports: portList(info.NetworkSettings),
    mounts: (info.Mounts || []).map((m) => ({
      type: m.Type,
      name: m.Name || null,
      source: m.Source,
      destination: m.Destination,
      rw: m.RW,
    })),
    networks: Object.entries(info.NetworkSettings?.Networks || {}).map(([net, v]) => ({
      name: net,
      ip: v.IPAddress || null,
    })),
    compose: composeInfo(labels),
    isSelf: name === SELF_NAME,
  };
}

function composeArgs(info, sub, extra = []) {
  const args = ['compose'];
  if (info.project) args.push('-p', info.project);
  for (const f of info.files) args.push('-f', f);
  args.push(sub, ...extra);
  return args;
}

// Streams combined stdout/stderr of `docker compose pull` then `up -d`.
// onData receives plain text chunks; resolves with the final exit code.
export function update(info, onData) {
  return new Promise((resolve) => {
    const steps = [
      composeArgs(info, 'pull', [info.service]),
      composeArgs(info, 'up', ['-d', info.service]),
    ];

    const runStep = (idx) => {
      if (idx >= steps.length) return resolve(0);
      const args = steps[idx];
      onData(`\n$ docker ${args.join(' ')}\n`);
      const child = spawn('docker', args, { cwd: info.workdir });
      child.stdout.on('data', (d) => onData(d.toString()));
      child.stderr.on('data', (d) => onData(d.toString()));
      child.on('error', (err) => {
        onData(`\nfailed to run docker: ${err.message}\n`);
        resolve(1);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          onData(`\nexited with code ${code}\n`);
          return resolve(code ?? 1);
        }
        runStep(idx + 1);
      });
    };

    runStep(0);
  });
}

// Updating kissd itself would kill the process mid-request, so the
// compose run is handed to the host (via PID 1's namespaces) and detached —
// it outlives this container's replacement.
export function updateSelfDetached(info) {
  const cmd = [
    `cd ${JSON.stringify(info.workdir)}`,
    'docker compose pull',
    'docker compose up -d --build',
  ].join(' && ');
  const child = spawn(
    'nsenter',
    ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'sh', '-c', `sleep 1 && ${cmd}`],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}
