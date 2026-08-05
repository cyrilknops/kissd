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

app.post('/api/containers/:id/:action', auth.requireAuth, async (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return res.status(400).json({ error: 'Unsupported action' });
  }
  try {
    await dockerApi.action(id, action);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

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

    if (name === dockerApi.SELF_NAME) {
      res.write('Updating kissd itself.\n');
      res.write('Handing the compose run to the host so it survives this container being replaced.\n');
      res.write('The panel will drop out for a few seconds — reload once it returns.\n');
      dockerApi.updateSelfDetached(compose);
      return res.end();
    }

    const code = await dockerApi.update(compose, (chunk) => res.write(chunk));
    res.write(code === 0 ? '\nUpdate complete.\n' : `\nUpdate failed (exit ${code}).\n`);
    return res.end();
  } catch (err) {
    if (res.headersSent) {
      res.write(`\nError: ${err.message}\n`);
      return res.end();
    }
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

// --- settings --------------------------------------------------------------

app.get('/api/settings', auth.requireAuth, (req, res) => {
  res.json(settingsStore.redact(settingsStore.load()));
});

app.put('/api/settings', auth.requireAuth, (req, res) => {
  try {
    const updated = settingsStore.applyPatch(req.body || {});
    res.json(settingsStore.redact(updated));
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
  res.json(alerts.recentAlerts());
});

// --- static frontend -------------------------------------------------------

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
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
