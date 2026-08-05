// Claude Code is installed on demand rather than baked into the image — it is
// ~270MB, and most people running a container panel do not want to pay that in
// every pull. It installs into the data volume, so it survives image rebuilds
// and container recreation.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR || '/data';
export const PREFIX = process.env.CLAUDE_PREFIX || path.join(DATA_DIR, 'npm-global');
export const BIN_DIR = path.join(PREFIX, 'bin');

const PACKAGE = '@anthropic-ai/claude-code';

let installing = false;

// Prepended to PATH wherever the CLI needs to be reachable.
export function pathWithClaude(base = process.env.PATH || '') {
  return `${BIN_DIR}:${base}`;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, options);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve({ code: 1, out }));
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
  });
}

async function versionOf(bin) {
  const res = await run(bin, ['--version'], { env: { ...process.env, PATH: pathWithClaude() } });
  if (res.code !== 0) return null;
  return res.out.trim().split('\n')[0] || null;
}

export async function status() {
  if (installing) return { installed: false, installing: true, managed: true, version: null };

  // Installed into the data volume by the button.
  const managedBin = path.join(BIN_DIR, 'claude');
  if (fs.existsSync(managedBin)) {
    return { installed: true, installing: false, managed: true, version: await versionOf(managedBin), location: managedBin };
  }

  // Or baked into the image (docker build --build-arg WITH_CLAUDE=1).
  const bundled = await run('sh', ['-c', 'command -v claude']);
  if (bundled.code === 0 && bundled.out.trim()) {
    const bin = bundled.out.trim();
    return { installed: true, installing: false, managed: false, version: await versionOf(bin), location: bin };
  }

  return { installed: false, installing: false, managed: true, version: null };
}

// Streams npm output to onData. Also used to upgrade — npm install of an
// existing package just moves it to the latest version.
export async function install(onData) {
  if (installing) throw new Error('An install is already running');
  installing = true;

  try {
    fs.mkdirSync(PREFIX, { recursive: true });
    onData(`Installing ${PACKAGE} into ${PREFIX}\n`);
    onData('This is a ~270MB download and takes a minute or two.\n\n');

    const code = await new Promise((resolve) => {
      const child = spawn(
        'npm',
        ['install', '-g', '--prefix', PREFIX, PACKAGE],
        { env: { ...process.env, npm_config_update_notifier: 'false' } },
      );
      child.stdout.on('data', (d) => onData(d.toString()));
      child.stderr.on('data', (d) => onData(d.toString()));
      child.on('error', (err) => { onData(`\nFailed to run npm: ${err.message}\n`); resolve(1); });
      child.on('close', (c) => resolve(c ?? 1));
    });

    if (code !== 0) {
      onData(`\nnpm exited with code ${code}.\n`);
      return { ok: false };
    }

    const version = await versionOf(path.join(BIN_DIR, 'claude'));
    if (!version) {
      onData('\nnpm reported success but the claude binary is not runnable.\n');
      return { ok: false };
    }

    onData(`\nInstalled ${version}\n`);
    onData('Open the Claude tab and sign in — your login persists in the data volume.\n');
    return { ok: true, version };
  } finally {
    installing = false;
  }
}

export async function uninstall() {
  if (installing) throw new Error('An install is running');
  const res = await run('npm', ['uninstall', '-g', '--prefix', PREFIX, PACKAGE]);
  if (res.code !== 0) throw new Error(res.out.slice(-300) || 'npm uninstall failed');
  return { ok: true };
}
