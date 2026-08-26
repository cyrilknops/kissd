import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';

import * as auth from './auth.js';
import * as settingsStore from './config.js';
import * as dockerApi from './docker.js';
import * as host from './host.js';
import * as alerts from './alerts.js';
import * as system from './system.js';
import * as claude from './claude.js';
import * as compose from './compose.js';
import * as registry from './registry.js';
import * as mute from './mute.js';
import { send as ntfySend } from './ntfy.js';
import { handleTerminal, handleLogs } from './terminal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8090);

const app = express();
// Behind Nginx Proxy Manager: needed for correct req.ip in the login throttle.
app.set('trust proxy', true);
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// --- auth ------------------------------------------------------------------

app.post('/api/login', (req, res) => {
  if (auth.rateLimited(req)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const { username, password } = req.body || {};
  if (!auth.verifyCredentials(req, username, password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  auth.issueSession(res);
  return res.json({ ok: true, user: auth.adminUser });
});

app.post('/api/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({ user: auth.adminUser });
});

// Re-authentication gate for the host shell.
app.post('/api/elevate', auth.requireAuth, (req, res) => {
  if (auth.rateLimited(req)) {
    return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  const { password } = req.body || {};
  if (!auth.verifyCredentials(req, auth.adminUser, password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  auth.issueElevated(res);
  return res.json({ ok: true, expiresIn: 300 });
});

// --- host metrics ----------------------------------------------------------

app.get('/api/host', auth.requireAuth, async (req, res) => {
  try {
    res.json(await host.snapshot());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- alert muting ----------------------------------------------------------

// A compose run stops and recreates containers on purpose, so the alert watcher
// is told to hold its tongue for exactly the scope being touched — one
// container, or one project — while it runs. The returned function ends the
// mute (after a grace period, so a freshly recreated container has time to pass
// its healthcheck) and must be called however the request ends.
function muteWhile(keys, scope, reason) {
  // begin() is still called with muting switched off — it is inert then, and
  // skipping it would leave a stale hold behind if the setting flips mid-run.
  // The log entry is not: an alert that was never held back needs no excuse.
  if (mute.isEnabled()) {
    alerts.noteMute(
      `Alerts muted · ${scope}`,
      `${reason} Container alerts for ${scope} are held until it finishes, plus the grace period.`,
    );
  }
  return mute.begin(keys);
}

// --- containers ------------------------------------------------------------

app.get('/api/containers', auth.requireAuth, async (req, res) => {
  try {
    const containers = await dockerApi.list();
    const running = containers.filter((c) => c.state === 'running').map((c) => c.id);
    // Cached and non-blocking: the list must not wait on stats sampling.
    const stats = dockerApi.stats(running);
    res.json(containers.map((c) => ({ ...c, stats: stats[c.id] || null })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/containers/:id', auth.requireAuth, async (req, res) => {
  try {
    const info = await dockerApi.detail(req.params.id);
    const stats = info.running ? await dockerApi.statsOne(info.id) : null;
    return res.json({ ...info, stats });
  } catch (err) {
    const missing = err.statusCode === 404;
    return res.status(missing ? 404 : 500).json({ error: missing ? 'No such container' : err.message });
  }
});

// Declared before the generic /:action route below — Express matches in
// definition order, so the catch-all would otherwise swallow "update" and
// answer "Unsupported action".
// Streams compose output back as it happens (chunked text/plain).
app.post('/api/containers/:id/update', auth.requireAuth, async (req, res) => {
  try {
    const info = await dockerApi.inspect(req.params.id);
    const name = (info.Name || '').replace(/^\//, '');
    const compose = dockerApi.composeInfo(info.Config?.Labels || {});

    if (!compose) {
      return res.status(400).json({
        error: 'Not compose-managed — this container has no compose labels, so it cannot be updated automatically.',
      });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    const keys = [mute.containerKey(name)];
    const release = muteWhile(keys, name, 'An update is running.');
    try {
      if (name === dockerApi.SELF_NAME) {
        res.write('Updating kissd itself.\n');
        res.write('Handing the compose run to the host so it survives this container being replaced.\n');
        res.write('The panel will drop out for a few seconds — reload once it returns.\n');
        await dockerApi.updateSelfDetached(compose);
        // Nothing here ever sees a detached run finish — and this process is
        // about to be replaced — so the mute gets a fixed window on disk.
        mute.muteFor(keys, mute.DETACHED_SECONDS);
        return res.end();
      }

      const code = await dockerApi.update(compose, (chunk) => res.write(chunk));
      res.write(code === 0 ? '\nUpdate complete.\n' : `\nUpdate failed (exit ${code}).\n`);
      return res.end();
    } finally {
      release();
    }
  } catch (err) {
    if (res.headersSent) {
      res.write(`\nError: ${err.message}\n`);
      return res.end();
    }
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/containers/:id/:action', auth.requireAuth, async (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: `Unsupported action: ${action}` });
  }
  try {
    await dockerApi.action(id, action);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// --- disk usage & pruning --------------------------------------------------

app.get('/api/system/df', auth.requireAuth, async (req, res) => {
  try {
    res.json(await system.usage());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/system/prune/:target', auth.requireAuth, async (req, res) => {
  if (!system.PRUNE_TARGETS.includes(req.params.target)) {
    return res.status(400).json({ error: 'Unknown prune target' });
  }
  try {
    return res.json(await system.prune(req.params.target));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Removing a volume destroys data, so it needs the same re-auth as a host
// shell, and the caller must name the exact volume.
app.post('/api/system/volumes/remove', auth.requireElevated, async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'A volume name is required' });
  }
  try {
    return res.json(await system.removeVolume(name));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// --- compose files ---------------------------------------------------------

// Update and reset differ only in the compose steps they run: both stream
// their output, both mute the project's alerts while they work, and both may
// hand the run to the host when the project contains kissd itself.
async function streamProjectRun(req, res, run, label, reason) {
  const name = String(req.body?.project || '');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const keys = [mute.projectKey(name)];
  const release = muteWhile(keys, name, reason);
  try {
    const code = await run(name, (chunk) => res.write(chunk));
    if (code === compose.DETACHED) {
      // A detached run has no exit code to report, and the handoff lines
      // already said what happens next — claiming completion here would
      // contradict them. Nothing will see it finish either, so the mute is
      // given a fixed window on disk that outlives this process.
      mute.muteFor(keys, mute.DETACHED_SECONDS);
    } else {
      res.write(code === 0 ? `\n${label} complete.\n` : `\n${label} failed (exit ${code}).\n`);
    }
  } catch (err) {
    res.write(`\nError: ${err.message}\n`);
  } finally {
    release();
  }
  res.end();
}

app.get('/api/compose', auth.requireAuth, async (req, res) => {
  try {
    res.json(await compose.projects());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/compose/file', auth.requireAuth, async (req, res) => {
  try {
    res.json(await compose.read(String(req.query.path || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/compose/file', auth.requireAuth, async (req, res) => {
  const { path: filePath, content, mtimeMs } = req.body || {};
  try {
    const result = await compose.write(String(filePath || ''), content, mtimeMs);
    // A syntax error is the expected outcome of a bad edit, not a server fault.
    return res.status(result.valid === false ? 422 : 200).json(result);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/compose/apply', auth.requireAuth, async (req, res) => {
  const name = String(req.body?.project || '');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  const release = muteWhile([mute.projectKey(name)], name, 'A compose apply is running.');
  try {
    const code = await compose.apply(name, (chunk) => res.write(chunk));
    res.write(code === 0 ? '\nApplied.\n' : `\nFailed (exit ${code}).\n`);
  } catch (err) {
    res.write(`\nError: ${err.message}\n`);
  } finally {
    release();
  }
  res.end();
});

// Pull + recreate every service in a project, streamed like a single update.
app.post('/api/compose/update', auth.requireAuth, async (req, res) => {
  await streamProjectRun(req, res, compose.update, 'Update', 'An update is running.');
});

// Tear the project down and bring it back up, without pulling. Volumes stay.
app.post('/api/compose/reset', auth.requireAuth, async (req, res) => {
  await streamProjectRun(req, res, compose.reset, 'Reset', 'A reset is running.');
});

app.get('/api/compose/backups', auth.requireAuth, async (req, res) => {
  try {
    res.json(await compose.backups(String(req.query.project || '')));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/compose/backup', auth.requireAuth, async (req, res) => {
  try {
    const content = await compose.readBackup(String(req.query.project || ''), String(req.query.name || ''));
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: 'Backup not found' });
  }
});

// --- claude code (installed on demand into the data volume) ----------------

app.get('/api/claude', auth.requireAuth, async (req, res) => {
  try {
    res.json(await claude.status());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claude/install', auth.requireAuth, async (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    const result = await claude.install((chunk) => res.write(chunk));
    res.write(result.ok ? '\nDone.\n' : '\nInstall failed.\n');
  } catch (err) {
    res.write(`\nError: ${err.message}\n`);
  }
  res.end();
});

app.post('/api/claude/uninstall', auth.requireAuth, async (req, res) => {
  try {
    res.json(await claude.uninstall());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- settings --------------------------------------------------------------

app.get('/api/settings', auth.requireAuth, (req, res) => {
  res.json(settingsStore.redact(settingsStore.load()));
});

app.put('/api/settings', auth.requireAuth, (req, res) => {
  try {
    const updated = settingsStore.applyPatch(req.body || {});
    // Registry logins only take effect once they are on disk where the docker
    // CLI will look for them, so the config is rewritten with every save.
    registry.write(updated);
    res.json(settingsStore.redact(updated));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Verifies each login against the real registry. Entries the browser sent with
// a blank password fall back to the stored one, so a saved credential can be
// re-tested without retyping it.
app.post('/api/settings/registries/test', auth.requireAuth, async (req, res) => {
  try {
    const list = settingsStore.withStoredPasswords(req.body?.registries || []);
    if (!list.length) return res.status(400).json({ error: 'No registries configured' });
    res.json({ results: await Promise.all(list.map((r) => registry.test(r))) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Test against what's about to be saved, without persisting it first.
app.post('/api/settings/ntfy/test', auth.requireAuth, async (req, res) => {
  const stored = settingsStore.load();
  const draft = req.body?.ntfy || {};
  const ntfy = {
    ...stored.ntfy,
    ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== '' && v !== undefined)),
  };
  try {
    await ntfySend({ ntfy }, {
      title: 'Test notification',
      message: 'If you can read this, kissd can reach your ntfy server.',
      priority: 'default',
      tags: ['wave'],
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/alerts', auth.requireAuth, (req, res) => {
  res.json({ log: alerts.recentAlerts(), muted: mute.active() });
});

// --- static frontend -------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Vite fingerprints everything under /assets, so those are safe to pin for a
// year. The shell, the worker and the manifest must not be: a stale service
// worker would keep serving an old build forever.
const ASSET_DIR = `${path.sep}assets${path.sep}`;
const NEVER_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest']);

app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (NEVER_CACHE.has(path.basename(filePath))) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (filePath.includes(ASSET_DIR)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
}));

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'no-cache');
  return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// --- websockets ------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const params = url.searchParams;

  const isTerminal = url.pathname === '/ws/terminal';
  const isLogs = url.pathname === '/ws/logs';
  if (!isTerminal && !isLogs) {
    socket.destroy();
    return;
  }

  // The host shell is the only route that demands the elevated token.
  const needsElevation = isTerminal && params.get('type') === 'host';
  if (!auth.authFromUpgrade(req, { elevated: needsElevation })) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    if (isTerminal) handleTerminal(ws, params);
    else handleLogs(ws, params);
  });
});

server.listen(PORT, () => {
  console.log(`kissd listening on :${PORT}`);
  // The docker config lives on the data volume, but rewriting it at boot keeps
  // it in step with settings.json after a restore, an edit or a fresh volume.
  try {
    const n = registry.write(settingsStore.load());
    if (n) console.log(`registry logins loaded for ${n} registr${n === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.error(`could not write the docker config: ${err.message}`);
  }
  // Sample stats once up front so the first page load already has numbers.
  dockerApi.primeStats();
  alerts.start();
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    alerts.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
