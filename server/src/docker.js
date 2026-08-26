// Docker layer. Container listing/actions go through the API (dockerode);
// updates deliberately shell out to `docker compose` so a container is
// recreated exactly as its compose file declares, rather than from a
// hand-rebuilt config.
import Docker from 'dockerode';
import { spawn } from 'node:child_process';
import * as registry from './registry.js';

export const docker = new Docker({ socketPath: '/var/run/docker.sock' });

export const SELF_NAME = process.env.SELF_NAME || 'kissd';
const DATA_DIR = process.env.DATA_DIR || '/data';

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

// The -p/-f flags that pin a compose run to exactly the project the labels
// describe, rather than whatever the working directory happens to contain.
export function composeFlags(info) {
  const flags = [];
  if (info.project) flags.push('-p', info.project);
  for (const f of info.files || []) flags.push('-f', f);
  return flags;
}

function composeArgs(info, sub, extra = []) {
  return ['compose', ...composeFlags(info), sub, ...extra];
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
      const child = spawn('docker', args, { cwd: info.workdir, env: registry.env() });
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

// The host-side path of DATA_DIR. A detached run executes in the host's mount
// namespace, where /data does not exist, so the registry config has to be
// pointed at wherever that volume actually lives. Read from this container's
// own mount table rather than guessed from the compose file.
let dataHostPath;
async function selfDataHostPath() {
  if (dataHostPath !== undefined) return dataHostPath;
  dataHostPath = '';
  try {
    const all = await docker.listContainers({ all: true });
    const self = all.find((c) => shortName(c.Names) === SELF_NAME);
    if (self) {
      const info = await docker.getContainer(self.Id).inspect();
      const mount = (info.Mounts || []).find((m) => m.Destination === DATA_DIR);
      if (mount?.Source) dataHostPath = mount.Source;
    }
  } catch {
    // Not fatal: the run just falls back to the host's own docker config.
  }
  return dataHostPath;
}

// Fixed scripts, so nothing here is ever built by string interpolation. Every
// value arrives as a positional parameter, which the shell never re-parses —
// a project name or path containing $(…), a backtick or a quote is inert.
// Both take the same parameters ($1 docker config dir, $2 working dir,
// $3 service or empty, then the -p/-f flags) so one spawn serves either.
//
// --ignore-pull-failures is what keeps this working for a kissd that builds its
// own image rather than pulling the published one: a `build: .` service with a
// local-only `image:` makes a plain `pull` exit non-zero, and the && would then
// skip the `up -d --build` that does the actual work. Nothing would be updated,
// and with stdio ignored nobody would ever find out.
const SELF_UPDATE_SH = `
sleep 1
if [ -n "$1" ]; then DOCKER_CONFIG=$1; export DOCKER_CONFIG; fi
cd "$2" || exit 1
svc=$3
shift 3
if [ -n "$svc" ]; then
  docker compose "$@" pull --ignore-pull-failures "$svc"
  docker compose "$@" up -d --build "$svc"
else
  docker compose "$@" pull --ignore-pull-failures
  docker compose "$@" up -d --build
fi
`;

// A reset is always project-wide, so the service name is ignored here.
//
// This is `up -d --force-recreate` rather than the `down && up -d` a reset runs
// everywhere else, and deliberately so: this run recreates the very container
// it was spawned from, and a detached run that dies as kissd goes away leaves
// the project wherever the last command left it. One command that recreates
// each container in turn can at worst strand the one it was working on — the
// same exposure the self-update already has. `down` first would put every
// service in the project on the wrong side of that window.
const SELF_RESET_SH = `
sleep 1
if [ -n "$1" ]; then DOCKER_CONFIG=$1; export DOCKER_CONFIG; fi
cd "$2" || exit 1
shift 3
docker compose "$@" up -d --force-recreate
`;

// Replacing or tearing down kissd itself would kill the process mid-request, so
// the compose run is handed to the host (via PID 1's namespaces) and detached —
// it outlives this container's replacement.
function runSelfDetached(script, info, configDir) {
  const child = spawn(
    'nsenter',
    [
      '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
      'sh', '-c', script, 'sh',
      configDir, info.workdir, info.service || '', ...composeFlags(info),
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
}

async function selfConfigDir() {
  const data = await selfDataHostPath();
  // registry.CONFIG_DIR lives under DATA_DIR; same suffix, host-side root.
  return data ? data + registry.CONFIG_DIR.slice(DATA_DIR.length) : '';
}

// `info` may describe one service or a whole project; without a service name
// the run covers every service.
export async function updateSelfDetached(info) {
  runSelfDetached(SELF_UPDATE_SH, info, await selfConfigDir());
}

// Recreates every container in the whole project, detached.
export async function resetSelfDetached(info) {
  runSelfDetached(SELF_RESET_SH, info, await selfConfigDir());
}
