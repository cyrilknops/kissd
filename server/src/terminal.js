// WebSocket terminals and log streams.
//
// Wire protocol, client -> server: JSON objects, so input and control can never
// be confused with each other.
//   {"i": "keystrokes"}      input
//   {"r": [cols, rows]}      resize
// Server -> client: raw text frames (terminal output).
import pty from 'node-pty';
import { docker } from './docker.js';
import { REPO_DIR } from './config.js';

function safeSend(ws, data) {
  if (ws.readyState === 1) ws.send(data);
}

// Prefer bash where the image has it, fall back to sh.
const SHELL_PROBE = 'command -v bash >/dev/null 2>&1 && exec bash || exec sh';

async function containerShell(ws, id) {
  const container = docker.getContainer(id);
  const exec = await container.exec({
    Cmd: ['/bin/sh', '-c', SHELL_PROBE],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
  });
  const stream = await exec.start({ hijack: true, stdin: true, Tty: true });

  stream.on('data', (chunk) => safeSend(ws, chunk.toString('utf8')));
  stream.on('end', () => ws.close());
  stream.on('error', () => ws.close());

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg.i === 'string') stream.write(msg.i);
    if (Array.isArray(msg.r)) {
      exec.resize({ w: msg.r[0], h: msg.r[1] }).catch(() => {});
    }
  });

  ws.on('close', () => {
    try {
      stream.end();
    } catch {
      // Stream already torn down.
    }
  });
}

function spawnPty(ws, file, args, options) {
  const term = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    ...options,
  });

  term.onData((data) => safeSend(ws, data));
  term.onExit(({ exitCode }) => {
    safeSend(ws, `\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    ws.close();
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (typeof msg.i === 'string') term.write(msg.i);
    if (Array.isArray(msg.r)) {
      try {
        term.resize(Math.max(2, msg.r[0]), Math.max(1, msg.r[1]));
      } catch {
        // Resize races with exit; harmless.
      }
    }
  });

  ws.on('close', () => {
    try {
      term.kill();
    } catch {
      // Already gone.
    }
  });
}

// Root shell on the host itself, by entering PID 1's namespaces.
function hostShell(ws) {
  spawnPty(ws, 'nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', '-l'], {
    cwd: '/',
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

// Claude Code runs inside this container, where $HOME is on the ./data volume,
// so the OAuth login survives restarts.
function claudeShell(ws) {
  spawnPty(ws, 'bash', ['-lc', 'claude || (echo; echo "claude exited — press enter for a shell"; read _; exec bash -l)'], {
    cwd: REPO_DIR,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

export async function handleTerminal(ws, params) {
  const type = params.get('type');
  try {
    if (type === 'container') {
      const id = params.get('id');
      if (!id) throw new Error('missing container id');
      await containerShell(ws, id);
    } else if (type === 'host') {
      hostShell(ws);
    } else if (type === 'claude') {
      claudeShell(ws);
    } else {
      throw new Error(`unknown terminal type: ${type}`);
    }
  } catch (err) {
    safeSend(ws, `\r\n\x1b[31mFailed to open terminal: ${err.message}\x1b[0m\r\n`);
    ws.close();
  }
}

export async function handleLogs(ws, params) {
  const id = params.get('id');
  const tail = params.get('tail') || '200';
  try {
    const stream = await docker.getContainer(id).logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: Number(tail),
      timestamps: false,
    });

    // Without a TTY, Docker frames output with an 8-byte header per chunk.
    stream.on('data', (chunk) => {
      let buf = chunk;
      let out = '';
      while (buf.length >= 8) {
        const len = buf.readUInt32BE(4);
        if (buf.length < 8 + len) break;
        out += buf.subarray(8, 8 + len).toString('utf8');
        buf = buf.subarray(8 + len);
      }
      safeSend(ws, out || chunk.toString('utf8'));
    });
    stream.on('end', () => ws.close());
    stream.on('error', () => ws.close());
    ws.on('close', () => {
      try {
        stream.destroy();
      } catch {
        // Already destroyed.
      }
    });
  } catch (err) {
    safeSend(ws, `Failed to stream logs: ${err.message}\n`);
    ws.close();
  }
}
