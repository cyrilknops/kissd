// Viewing and editing the compose files behind each project.
//
// Every path is checked against an allowlist rebuilt from Docker's own labels
// on each request, so only files that actually define a running project can be
// read or written. Nothing here accepts a caller-supplied path directly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { docker, composeInfo, updateSelfDetached, resetSelfDetached, SELF_NAME } from './docker.js';
import * as registry from './registry.js';

const DATA_DIR = process.env.DATA_DIR || '/data';
const BACKUP_DIR = path.join(DATA_DIR, 'compose-backups');
const MAX_BYTES = 512 * 1024;

// Groups running containers into their compose projects.
export async function projects() {
  const raw = await docker.listContainers({ all: true });
  const map = new Map();

  for (const c of raw) {
    const info = composeInfo(c.Labels);
    if (!info) continue;
    if (!map.has(info.project)) {
      map.set(info.project, {
        project: info.project,
        workdir: info.workdir,
        files: [],
        services: new Set(),
        containers: 0,
        running: 0,
        // A project that contains kissd cannot be updated in-process: the run
        // would kill the request that started it.
        hasSelf: false,
      });
    }
    const entry = map.get(info.project);
    for (const f of info.files) if (!entry.files.includes(f)) entry.files.push(f);
    entry.services.add(info.service);
    entry.containers += 1;
    if (c.State === 'running') entry.running += 1;
    if ((c.Names || []).some((n) => n.replace(/^\//, '') === SELF_NAME)) entry.hasSelf = true;
  }

  return [...map.values()]
    .map((e) => ({ ...e, services: [...e.services].sort(), files: e.files.sort() }))
    .sort((a, b) => a.project.localeCompare(b.project));
}

// The set of files that may be touched, straight from the live labels.
async function allowedFiles() {
  const all = await projects();
  const set = new Map();
  for (const p of all) for (const f of p.files) set.set(f, p);
  return set;
}

async function resolveOrThrow(filePath) {
  const allowed = await allowedFiles();
  const project = allowed.get(filePath);
  if (!project) {
    throw new Error('That file is not a compose file of any project on this host');
  }
  return project;
}

export async function read(filePath) {
  const project = await resolveOrThrow(filePath);
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_BYTES) throw new Error('File is too large to edit here');
  const content = await fs.readFile(filePath, 'utf8');
  return {
    path: filePath,
    project: project.project,
    workdir: project.workdir,
    content,
    // Used to detect edits made elsewhere between load and save.
    mtimeMs: stat.mtimeMs,
    writable: await fs.access(filePath, fs.constants.W_OK).then(() => true, () => false),
  };
}

function runCompose(args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn('docker', args, { cwd, env: registry.env() });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (err) => resolve({ code: 1, out: err.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

function composeArgs(project, sub, extra = []) {
  const args = ['compose', '-p', project.project];
  for (const f of project.files) args.push('-f', f);
  return [...args, sub, ...extra];
}

async function backup(project, filePath, content) {
  const dir = path.join(BACKUP_DIR, project.project);
  await fs.mkdir(dir, { recursive: true });
  // Timestamp comes from the file write itself, not the clock name, so
  // repeated saves in the same second don't collide.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(dir, `${stamp}--${path.basename(filePath)}`);
  await fs.writeFile(target, content, { mode: 0o600 });
  return target;
}

// Writes the file, validates it with `docker compose config`, and rolls back
// automatically if the result does not parse.
export async function write(filePath, content, expectedMtimeMs) {
  const project = await resolveOrThrow(filePath);
  if (typeof content !== 'string') throw new Error('Content must be a string');
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Content is too large');

  const stat = await fs.stat(filePath);
  if (expectedMtimeMs && Math.abs(stat.mtimeMs - expectedMtimeMs) > 1) {
    throw new Error('The file changed on disk since you opened it — reload before saving');
  }

  const previous = await fs.readFile(filePath, 'utf8');
  if (previous === content) {
    return { saved: false, unchanged: true, project: project.project };
  }

  const backupPath = await backup(project, filePath, previous);
  await fs.writeFile(filePath, content, 'utf8');

  const check = await runCompose(composeArgs(project, 'config', ['-q']), project.workdir);
  if (check.code !== 0) {
    await fs.writeFile(filePath, previous, 'utf8');
    return {
      saved: false,
      valid: false,
      error: check.out.trim().slice(0, 2000) || 'compose config failed',
      rolledBack: true,
      project: project.project,
    };
  }

  const after = await fs.stat(filePath);
  return {
    saved: true,
    valid: true,
    backup: backupPath,
    mtimeMs: after.mtimeMs,
    project: project.project,
  };
}

async function findProject(projectName) {
  const all = await projects();
  const project = all.find((p) => p.project === projectName);
  if (!project) throw new Error(`Unknown project: ${projectName}`);
  return project;
}

// Runs compose steps in order, streaming their combined output, and stops at
// the first one that fails. Resolves with the final exit code.
function streamSteps(project, steps, onData) {
  return new Promise((resolve) => {
    const runStep = (idx) => {
      if (idx >= steps.length) return resolve(0);
      const args = steps[idx];
      onData(`$ docker ${args.join(' ')}\n\n`);
      const child = spawn('docker', args, { cwd: project.workdir, env: registry.env() });
      child.stdout.on('data', (d) => onData(d.toString()));
      child.stderr.on('data', (d) => onData(d.toString()));
      child.on('error', (err) => { onData(`\nfailed to run docker: ${err.message}\n`); resolve(1); });
      child.on('close', (code) => {
        if (code !== 0) return resolve(code ?? 1);
        runStep(idx + 1);
      });
    };
    runStep(0);
  });
}

// Streams `docker compose up -d` for the whole project.
export async function apply(projectName, onData) {
  const project = await findProject(projectName);
  return streamSteps(project, [composeArgs(project, 'up', ['-d'])], onData);
}

// Returned instead of an exit code when the run was handed to the host. There
// is no status to wait for, so the caller must not claim the update finished.
export const DETACHED = 'detached';

// Pulls every image in the project, then recreates the services whose image
// actually changed. --ignore-pull-failures keeps a locally-built service (one
// with no image to pull) from aborting the update for everything else.
export async function update(projectName, onData) {
  const project = await findProject(projectName);

  if (project.hasSelf) {
    onData(`This project runs kissd itself (${SELF_NAME}).\n`);
    onData('Handing the compose run to the host so it survives this container being replaced.\n');
    onData('The panel will drop out for a few seconds — reload once it returns.\n');
    await updateSelfDetached(project);
    return DETACHED;
  }

  return streamSteps(project, [
    composeArgs(project, 'pull', ['--ignore-pull-failures']),
    composeArgs(project, 'up', ['-d']),
  ], onData);
}

// Tears the project down and brings it straight back up: containers and the
// project network are recreated from the compose file as it stands on disk,
// without pulling anything. `down` is deliberately run without -v — named
// volumes, and everything in them, survive a reset.
export async function reset(projectName, onData) {
  const project = await findProject(projectName);

  if (project.hasSelf) {
    onData(`This project runs kissd itself (${SELF_NAME}).\n`);
    onData('Handing the compose run to the host so it survives this container going away.\n');
    onData('Recreating every container in place rather than taking the project down first:\n');
    onData('a detached run cannot be relied on to outlive kissd, and a half-finished\n');
    onData('`down` would leave the whole project stopped.\n');
    onData('The panel will drop out for a few seconds — reload once it returns.\n');
    await resetSelfDetached(project);
    return DETACHED;
  }

  return streamSteps(project, [
    composeArgs(project, 'down'),
    composeArgs(project, 'up', ['-d']),
  ], onData);
}

export async function backups(projectName) {
  const dir = path.join(BACKUP_DIR, projectName);
  try {
    const names = await fs.readdir(dir);
    const out = await Promise.all(names.map(async (n) => {
      const st = await fs.stat(path.join(dir, n));
      return { name: n, size: st.size, at: st.mtimeMs };
    }));
    return out.sort((a, b) => b.at - a.at).slice(0, 20);
  } catch {
    return [];
  }
}

export async function readBackup(projectName, name) {
  // basename() keeps a crafted name from climbing out of the backup directory.
  const safe = path.basename(name);
  const file = path.join(BACKUP_DIR, projectName, safe);
  return fs.readFile(file, 'utf8');
}
