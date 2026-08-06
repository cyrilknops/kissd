// Private registry logins for every `docker` the panel runs.
//
// Docker keeps registry credentials client-side: `docker login` writes them to
// the calling client's config and the CLI attaches them to each pull. The
// daemon stores nothing. So a login done on the host is invisible to the CLI
// inside this container, which is why a private image that pulls fine over SSH
// fails from the panel with "no basic auth credentials".
//
// This module owns one config.json that every docker the panel spawns points
// at via DOCKER_CONFIG, so one set of credentials covers container updates,
// project updates and compose apply alike. It is deliberately a directory of
// our own rather than $HOME/.docker, so removing a registry in Settings
// actually removes the credential instead of leaving a stale entry behind.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR || '/data';
export const CONFIG_DIR = path.join(DATA_DIR, 'docker');
const FILE = path.join(CONFIG_DIR, 'config.json');

function basic(username, password) {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function usable(r) {
  return Boolean(r?.server && r?.username && r?.password);
}

// Docker's own on-disk format: { "auths": { "<server>": { "auth": b64 } } }.
// Rewritten in full on every save, so a deleted registry loses its credential.
export function write(settings) {
  const auths = {};
  for (const r of settings?.registries || []) {
    if (usable(r)) auths[r.server] = { auth: basic(r.username, r.password) };
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ auths }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  fs.chmodSync(FILE, 0o600);
  return Object.keys(auths).length;
}

// Spawn environment for any docker the panel runs itself.
export function env(extra) {
  return { ...process.env, DOCKER_CONFIG: CONFIG_DIR, ...extra };
}

// Verifies one login against the real registry, using a throwaway config dir so
// a failed attempt cannot disturb the saved credentials. Never rejects: the
// caller reports per-registry results rather than failing the whole request.
export function test(registry) {
  return new Promise((resolve) => {
    if (!usable(registry)) {
      resolve({ server: registry?.server || '', ok: false, error: 'Needs a server, username and password' });
      return;
    }
    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kissd-login-'));
    } catch (err) {
      resolve({ server: registry.server, ok: false, error: err.message });
      return;
    }
    const done = (result) => {
      fs.rmSync(dir, { recursive: true, force: true });
      resolve({ server: registry.server, ...result });
    };

    // Credentials go in as argv and stdin, never through a shell.
    const child = spawn('docker', [
      '--config', dir,
      'login', registry.server,
      '--username', registry.username,
      '--password-stdin',
    ]);

    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => done({ ok: false, error: `failed to run docker: ${e.message}` }));
    child.on('close', (code) => {
      if (code === 0) return done({ ok: true });
      // Docker's last stderr line carries the useful part; the rest is noise.
      const line = err.trim().split('\n').filter(Boolean).pop();
      done({ ok: false, error: line || `docker login exited ${code}` });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(registry.password);
  });
}
