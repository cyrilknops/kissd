// Owner-managed, image-only deployment policies. No policy/command comes from HTTP input.
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { parseDocument } from 'yaml';
import { validTracking, resolveLatest } from './latest-images.js';

const MAX = 512 * 1024;
const active = new Map();
const starting = new Set();
let maintenance = false;
export const selfMaintenanceFile = () =>
  path.join(process.env.DATA_DIR || '/data', 'self-maintenance.lock');
async function noSelfMaintenance() {
  try {
    await fs.lstat(selfMaintenanceFile());
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  throw Error('Kissd maintenance is pending; inspect its recovery marker before continuing');
}
export async function withMaintenance(work) {
  if (maintenance || hasActiveUpdates())
    throw Error('A deployment or maintenance operation is running');
  maintenance = true;
  try {
    await noSelfMaintenance();
    return await work();
  } finally {
    maintenance = false;
  }
}
const pin = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, canonical(value[k])]),
        )
      : value;
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function configurationHash(config, services) {
  const value = structuredClone(config);
  for (const service of services)
    if (value.services?.[service]) delete value.services[service].image;
  return hash(JSON.stringify(canonical(value)));
}
function argv(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 64 &&
    value.every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !v.includes('\0'),
    )
  );
}
function validCheck(c) {
  return (
    c &&
    typeof c.name === 'string' &&
    c.name.length > 0 &&
    c.name.length <= 100 &&
    argv(c.argv) &&
    typeof c.expect === 'string' &&
    c.expect.length <= 1000
  );
}
export async function readPolicy(project) {
  const file = path.join(project.workdir, 'kissd-update.json');
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw Error('Cannot read update policy');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || stat.mode & 0o022)
    throw Error('Update policy must be a private regular file');
  let p;
  try {
    p = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw Error('Invalid update policy JSON');
  }
  if (
    (p.attempts !== undefined &&
      (!Number.isSafeInteger(p.attempts) || p.attempts < 1 || p.attempts > 180)) ||
    (p.intervalMs !== undefined &&
      (!Number.isSafeInteger(p.intervalMs) || p.intervalMs < 1 || p.intervalMs > 10000)) ||
    p.version !== 1 ||
    !Array.isArray(p.services) ||
    p.services.length < 1 ||
    p.services.length > 20 ||
    new Set(p.services).size !== p.services.length ||
    p.services.some((s) => !project.services.includes(s)) ||
    !project.services.includes(p.database) ||
    p.services.includes(p.database) ||
    !p.approvedImages ||
    p.services.some((s) => !pin.test(p.approvedImages[s])) ||
    !sha.test(p.approvedRevision) ||
    (p.imageTags !== undefined && !validTracking(p)) ||
    !/^[a-f0-9]{64}$/.test(p.configurationHash) ||
    p.backwardCompatible !== true ||
    !Array.isArray(p.preflight) ||
    !p.preflight.length ||
    !p.preflight.every(validCheck) ||
    !Array.isArray(p.health) ||
    !p.health.length ||
    !p.health.every(validCheck) ||
    (p.order !== undefined && !argv(p.order))
  )
    throw Error('Invalid guarded update policy');
  return p;
}
export async function policySummary(project) {
  try {
    const p = await readPolicy(project);
    return p
      ? {
          mode: 'guarded',
          services: p.services,
          approvedRevision: p.approvedRevision,
          tracksLatest: Boolean(p.imageTags),
        }
      : null;
  } catch {
    return { mode: 'blocked', message: 'Update policy needs attention' };
  }
}
export async function assertIdle(project) {
  if (active.has(project.workdir)) throw Error('A guarded update is running for this project');
  try {
    await fs.lstat(path.join(project.workdir, '.kissd', 'update.lock'));
  } catch (e) {
    if (e.code === 'ENOENT') return;
    throw e;
  }
  throw Error(
    'An interrupted guarded update needs recovery; inspect the .kissd update journal before continuing',
  );
}
export async function assertPlainAction(project) {
  await assertIdle(project);
  if (await readPolicy(project))
    throw Error(
      'Use the guarded project update; bulk apply, restart and individual updates are disabled',
    );
}
export function hasActiveUpdates() {
  return active.size > 0 || starting.size > 0;
}

// Capture secrets internally, never stream a rendered compose file, inspect output or hook stderr.
export async function runCommand(
  command,
  { cwd, env, timeoutMs = 30000, outputFile, inputFile } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env,
    signal: controller.signal,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let bytes = 0;
  child.stderr.resume();
  const transfers = [];
  if (outputFile)
    transfers.push(
      pipeline(child.stdout, createWriteStream(outputFile, { flags: 'wx', mode: 0o600 })),
    );
  else
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) controller.abort();
      else stdout += chunk;
    });
  if (inputFile) transfers.push(pipeline(createReadStream(inputFile), child.stdin));
  else child.stdin.end();
  child.stdin.on('error', () => {});
  const exit = new Promise((resolve, reject) => {
    child.once('error', () => reject(Error('Command could not complete')));
    child.once('close', (code) => (code === 0 ? resolve() : reject(Error('Command failed'))));
  });
  try {
    await Promise.all([exit, ...transfers]);
    return { stdout };
  } finally {
    clearTimeout(timer);
  }
}
async function privateDir(dir) {
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const s = await fs.lstat(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.mode & 0o077)
    throw Error('Update journal directory must be private');
  const ignore = path.join(dir, '.gitignore');
  try {
    await fs.writeFile(ignore, '*\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const stat = await fs.lstat(ignore);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (await fs.readFile(ignore, 'utf8')).trim() !== '*'
    )
      throw Error('Private backup ignore rules require owner review');
  }
}
async function atomic(file, content, mode = 0o600) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, content, { mode, flag: 'wx' });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
function compose(project, sub, extra = []) {
  return [
    'docker',
    'compose',
    '--project-directory',
    project.workdir,
    '-p',
    project.project,
    ...project.files.flatMap((f) => ['-f', f]),
    sub,
    ...extra,
  ];
}
function fingerprint(x) {
  return { image: x.Image, started: x.State.StartedAt, restarts: x.RestartCount, mounts: x.Mounts };
}
async function sourceState(project) {
  const values = {};
  for (const file of [
    ...project.files,
    path.join(project.workdir, '.env'),
    path.join(project.workdir, 'kissd-update.json'),
  ]) {
    try {
      const s = await fs.lstat(file);
      if (!s.isFile() || s.isSymbolicLink() || s.size > MAX)
        throw Error('Invalid deployment source');
      values[file] = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' && !project.files.includes(file)) values[file] = null;
      else throw e;
    }
  }
  return values;
}
async function unchanged(project, state) {
  if (JSON.stringify(await sourceState(project)) !== JSON.stringify(state))
    throw Error(
      'Deployment configuration changed externally; automatic rollback requires manual recovery',
    );
}
function oldCompose(source, old) {
  return pinnedCompose(
    source,
    Object.fromEntries(Object.entries(old).map(([s, x]) => [s, x.Config.Image])),
  );
}
function pinnedCompose(source, refs) {
  if (source.trimStart().startsWith('{')) {
    const c = JSON.parse(source);
    for (const [s, ref] of Object.entries(refs)) c.services[s].image = ref;
    return JSON.stringify(c, null, 2) + '\n';
  }
  const doc = parseDocument(source);
  if (doc.errors.length) throw Error('Compose cannot be prepared for rollback');
  for (const [s, ref] of Object.entries(refs)) doc.setIn(['services', s, 'image'], ref);
  return String(doc);
}
export function createGuardedUpdater({
  run = runCommand,
  inspect,
  sleep = delay,
  statfs = fs.statfs,
  writeJournal = atomic,
} = {}) {
  async function check(checks, project) {
    for (const c of checks) {
      try {
        const r = await run(c.argv, { cwd: project.workdir, timeoutMs: 10000 });
        if (r.stdout.trim() !== c.expect) throw Error();
      } catch {
        throw Error('Deployment check failed: ' + c.name);
      }
    }
  }
  async function healthy(project, policy, service) {
    const deadline = Date.now() + 180000;
    for (let i = 0; i < (policy.attempts ?? 90) && Date.now() < deadline; i++) {
      try {
        if (service) {
          const x = await inspect(service, project);
          if (!x.State.Running || (x.State.Health && x.State.Health.Status !== 'healthy'))
            throw Error();
        }
        await check(policy.health, project);
        return;
      } catch {}
      await sleep(policy.intervalMs ?? 1000);
    }
    throw Error('Health gate failed');
  }
  async function image(service, ref, policy, emit) {
    let value;
    const read = async () => JSON.parse((await run(['docker', 'image', 'inspect', ref])).stdout)[0];
    try {
      value = await read();
    } catch {
      emit('Fetching pinned image for ' + service + '…\n');
      try {
        await run(['docker', 'pull', ref], { timeoutMs: 300000 });
        value = await read();
      } catch {
        throw Error('Pinned image pull failed for ' + service);
      }
    }
    if (value?.Config?.Labels?.['org.opencontainers.image.revision'] !== policy.approvedRevision)
      throw Error('Image revision does not match the approved release');
    return value;
  }
  async function prepare(project, policy, emit) {
    if (project.hasSelf || project.files.length !== 1)
      throw Error('Guarded updates require one compose file and cannot replace kissd itself');
    const state = await sourceState(project);
    const cfg = JSON.parse(
      (await run(compose(project, 'config', ['--format', 'json']), { cwd: project.workdir }))
        .stdout,
    );
    if (configurationHash(cfg, policy.services) !== policy.configurationHash)
      throw Error('Deployment configuration differs from the approved policy');
    const latest = policy.imageTags ? await resolveLatest(policy, cfg, run, emit) : null;
    const old = {},
      desired = {},
      protectedBefore = {};
    for (const service of policy.services) {
      const ref = cfg.services?.[service]?.image;
      if (!pin.test(ref)) throw Error('Application images must be pinned by digest');
      if (!latest && policy.approvedImages?.[service] !== ref)
        throw Error('Application image is not the approved image');
      old[service] = await inspect(service, project);
      if (!pin.test(old[service].Config.Image))
        throw Error('Running application images must be pinned by digest');
      if (!old[service].State.Running) throw Error('Current release is not running');
      desired[service] = latest ? latest.images[service] : await image(service, ref, policy, emit);
    }
    for (const service of Object.keys(cfg.services).filter((s) => !policy.services.includes(s)))
      protectedBefore[service] = fingerprint(await inspect(service, project));
    return {
      state,
      latest,
      old,
      desired,
      protectedBefore,
      fileMode: (await fs.stat(project.files[0])).mode & 0o777,
      changed: policy.services.filter((s) => old[s].Image !== desired[s].Id),
    };
  }
  async function protectedCheck(project, plan) {
    for (const [service, value] of Object.entries(plan.protectedBefore))
      if (JSON.stringify(fingerprint(await inspect(service, project))) !== JSON.stringify(value))
        throw Error('Protected service changed: ' + service);
  }
  async function order(project, policy) {
    let value = policy.services;
    if (policy.order) {
      try {
        value = JSON.parse(
          (await run(policy.order, { cwd: project.workdir, timeoutMs: 10000 })).stdout,
        );
      } catch {
        throw Error('Deployment order check failed');
      }
    }
    if (
      !Array.isArray(value) ||
      value.length !== policy.services.length ||
      new Set(value).size !== value.length ||
      value.some((s) => !policy.services.includes(s))
    )
      throw Error('Invalid deployment order');
    return value;
  }
  async function backup(project, policy, plan, job, emit) {
    const prior = oldCompose(plan.state[project.files[0]], plan.old);
    await fs.writeFile(path.join(job.dir, 'rollback-compose.yml'), prior, { mode: 0o600 });
    for (const [file, value] of Object.entries(plan.state))
      if (value !== null)
        await fs.writeFile(path.join(job.dir, path.basename(file) + '.private'), value, {
          mode: 0o600,
        });
    emit('Backing up PostgreSQL…\n');
    const database = (await inspect(policy.database, project)).Id;
    const dump = path.join(job.dir, 'database.dump');
    let step = 'database size check';
    try {
      const estimate = Number(
        (
          await run(
            [
              'docker',
              'exec',
              database,
              'sh',
              '-c',
              'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "SELECT pg_database_size(current_database());"',
            ],
            { timeoutMs: 10000 },
          )
        ).stdout.trim(),
      );
      step = 'free-space check';
      const disk = await statfs(project.workdir);
      if (
        !Number.isSafeInteger(estimate) ||
        estimate < 0 ||
        disk.bavail * disk.bsize < estimate * 1.25 + 256 * 1024 * 1024
      )
        throw Error('Insufficient backup space');
      step = 'database dump';
      await run(
        [
          'docker',
          'exec',
          database,
          'sh',
          '-c',
          'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc',
        ],
        { outputFile: dump, timeoutMs: 120000 },
      );
      step = 'archive file check';
      await fs.chmod(dump, 0o600);
      if (!(await fs.stat(dump)).size) throw Error();
      step = 'archive listing';
      // --list reads the header/TOC and can exit before a large archive has
      // finished streaming. Drain the rest so a valid dump cannot fail with
      // EPIPE, while preserving pg_restore's exit status on invalid archives.
      await run(
        [
          'docker',
          'exec',
          '-i',
          database,
          'sh',
          '-c',
          'pg_restore --list >/dev/null; result=$?; cat >/dev/null || exit 1; exit "$result"',
        ],
        {
          inputFile: dump,
          timeoutMs: 120000,
        },
      );
    } catch {
      throw Error('Database backup verification failed during ' + step + '; no services changed');
    }
    return prior;
  }
  async function replace(project, policy, service, expected) {
    await run(compose(project, 'up', ['-d', '--no-deps', '--pull', 'never', service]), {
      cwd: project.workdir,
      timeoutMs: 180000,
    });
    await healthy(project, policy, service);
    const current = await inspect(service, project);
    if (current.Image !== expected || current.RestartCount !== 0)
      throw Error('Image or restart verification failed');
  }
  async function rollback(project, policy, plan, prior, touched, job, emit) {
    // A failed journal write must never prevent an attempt to recover changed replicas.
    try {
      await job.record({ status: 'rolling-back', touched: [...touched] });
    } catch {}
    emit('Update failed. Rolling application images back…\n');
    try {
      await unchanged(project, plan.state);
      await atomic(project.files[0], prior, plan.fileMode);
      const state = { ...plan.state, [project.files[0]]: prior };
      for (const service of [...touched].reverse()) {
        await unchanged(project, state);
        await replace(project, policy, service, plan.old[service].Image);
      }
      await protectedCheck(project, plan);
      emit('Previous application images restored. PostgreSQL data was not restored.\n');
    } catch {
      const error = Error(
        'Automatic rollback could not complete. Manual recovery required; inspect ' + job.dir,
      );
      error.recoveryRequired = true;
      throw error;
    }
    const error = Error('Update failed and was rolled back');
    error.rolledBack = true;
    throw error;
  }
  async function execute(project, policy, emit, job) {
    const plan = await prepare(project, policy, emit);
    if (plan.latest)
      await job.record({ revision: plan.latest.revision, targetImages: plan.latest.refs });
    await check(policy.preflight, project);
    await healthy(project, policy);
    if (!plan.changed.length) {
      await unchanged(project, plan.state);
      await protectedCheck(project, plan);
      emit('Current pinned release is healthy. No services changed.\n');
      return;
    }
    await order(project, policy);
    const prior = await backup(project, policy, plan, job, emit);
    await unchanged(project, plan.state);
    await protectedCheck(project, plan);
    await check(policy.preflight, project);
    // Re-read ownership after the backup, immediately before choosing the first replica.
    const sequence = await order(project, policy);
    await job.record({
      status: 'backup-verified',
      order: sequence,
      previousImages: Object.fromEntries(
        Object.entries(plan.old).map(([s, x]) => [s, x.Config.Image]),
      ),
    });
    emit('Database archive verified. Starting sequential update.\n');
    if (plan.latest) {
      const source = pinnedCompose(plan.state[project.files[0]], plan.latest.refs);
      await unchanged(project, plan.state);
      await atomic(project.files[0], source, plan.fileMode);
      plan.state = { ...plan.state, [project.files[0]]: source };
    }
    const touched = [];
    try {
      for (const service of sequence.filter((s) => plan.changed.includes(s))) {
        await unchanged(project, plan.state);
        touched.push(service);
        await job.record({ status: 'updating', service, touched: [...touched] });
        emit('Updating ' + service + '…\n');
        await replace(project, policy, service, plan.desired[service].Id);
        await protectedCheck(project, plan);
      }
      await unchanged(project, plan.state);
      await protectedCheck(project, plan);
      emit('Guarded update passed all health checks.\n');
    } catch (error) {
      if (!touched.length) throw error;
      await rollback(project, policy, plan, prior, touched, job, emit);
    }
  }
  return {
    async update(project, policy, onData) {
      const running = active.get(project.workdir);
      if (running) {
        for (const line of running.lines)
          try {
            onData(line);
          } catch {}
        running.listeners.add(onData);
        try {
          return await running.promise;
        } finally {
          running.listeners.delete(onData);
        }
      }
      if (maintenance) throw Error('Maintenance is running');
      if (starting.has(project.workdir)) throw Error('A deployment is starting');
      starting.add(project.workdir);
      try {
        await noSelfMaintenance();
        await assertIdle(project);
        const root = path.join(project.workdir, '.kissd');
        await privateDir(root);
        const lock = path.join(root, 'update.lock');
        const id = randomUUID();
        let handle;
        try {
          handle = await fs.open(lock, 'wx', 0o600);
          await handle.writeFile(JSON.stringify({ id, startedAt: new Date().toISOString() }));
        } catch (e) {
          if (e.code === 'EEXIST') throw Error('A guarded update already owns this project');
          throw e;
        } finally {
          await handle?.close();
        }
        const dir = path.join(root, id);
        await fs.mkdir(dir, { mode: 0o700 });
        const journal = {
          id,
          project: project.project,
          revision: policy.approvedRevision,
          status: 'preflight',
          startedAt: new Date().toISOString(),
          touched: [],
        };
        const job = {
          dir,
          lines: [],
          listeners: new Set([onData]),
          record: async (patch) => {
            Object.assign(journal, patch);
            try {
              await writeJournal(path.join(dir, 'status.json'), JSON.stringify(journal, null, 2));
            } catch {
              job.journalFailed = true;
              const error = Error('Deployment journal write failed; manual recovery required');
              error.recoveryRequired = true;
              throw error;
            }
          },
        };
        await job.record({});
        const emit = (line) => {
          job.lines.push(line);
          for (const listener of job.listeners)
            try {
              listener(line);
            } catch {}
        };
        active.set(project.workdir, job);
        let keepLock = false;
        job.promise = (async () => {
          try {
            await execute(project, policy, emit, job);
            await job.record({ status: 'succeeded', completedAt: new Date().toISOString() });
            return 0;
          } catch (e) {
            keepLock = e.recoveryRequired === true;
            await job.record({
              status: keepLock ? 'recovery-required' : e.rolledBack ? 'rolled-back' : 'failed',
              error: e.message,
              completedAt: new Date().toISOString(),
            });
            throw e;
          } finally {
            active.delete(project.workdir);
            if (!keepLock && !job.journalFailed) {
              const own = JSON.parse(await fs.readFile(lock, 'utf8'));
              if (own.id === id) await fs.rm(lock);
            }
          }
        })();
        return job.promise;
      } finally {
        starting.delete(project.workdir);
      }
    },
  };
}
