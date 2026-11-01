// Disposable browser fixture: production components, routes, auth and history
// store, with synthetic host/container observations and no Docker connection.
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MetricsStore } from '../../src/metrics-store.js';
import { registerMetricsRoutes } from '../../src/metrics-routes.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kissd-browser-'));
process.env.DATA_DIR = dir;
process.env.KISSD_ADMIN_PASSWORD = 'fixture-only-password';
process.env.KISSD_JWT_SECRET = 'fixture-only-key-for-local-browser-checks';
const auth = await import('../../src/auth.js');
const settings = await import('../../src/config.js');
const store = new MetricsStore(path.join(dir, 'metrics.sqlite'));
const now = Date.now();
for (let i = 20160; i > 0; i--) {
  const at = now - i * 30_000;
  const cpu = 15 + Math.sin(i / 90) * 10 + (i % 700 < 30 ? 45 : 0);
  const down = i > 720 && i < 750;
  const unhealthy = i > 120 && i < 130;
  store.record(at, [
    { target: 'host', name: 'Host', state: 'up', metrics: { cpu, memory: (2.5 + Math.sin(i / 300) * 0.5) * 1024 ** 3, rxRate: 130000 + cpu * 1000, txRate: 80000, load: cpu / 25, diskPercent: 65 - i / 2000, swapPercent: 2, running: down ? 4 : 5, unhealthy: unhealthy ? 1 : 0 } },
    { target: 'container:web', name: 'web', id: i > 240 ? 'old' : 'new', state: down ? 'down' : unhealthy ? 'unhealthy' : 'up', reason: down ? 'exited' : unhealthy ? 'unhealthy' : 'running', metrics: down ? {} : { cpu: cpu / 2, memory: 300 * 1024 ** 2 + cpu * 100000, rxRate: 20000, txRate: 15000, readRate: cpu * 300, writeRate: cpu * 500, pids: 12, restartCount: i > 240 ? 0 : i > 60 ? 1 : 2 } },
  ]);
}
const app = express();
app.use(express.json());
app.use(cookieParser());
app.post('/api/login', (req, res) => {
  if (!auth.verifyCredentials(req, req.body.username, req.body.password)) return res.sendStatus(401);
  auth.issueSession(res);
  res.json({ ok: true });
});
app.get('/api/me', auth.requireAuth, (req, res) => res.json({ user: 'admin' }));
app.get('/api/containers', auth.requireAuth, (req, res) => res.json([{ id: 'new', name: 'web', state: 'running', health: 'healthy', stats: { cpu: 5, memory: 300 * 1024 ** 2 } }]));
app.get('/api/alerts', auth.requireAuth, (req, res) => res.json({ log: [], muted: [] }));
app.get('/api/settings', auth.requireAuth, (req, res) => res.json(settings.redact(settings.load())));
app.put('/api/settings', auth.requireAuth, (req, res) => {
  try {
    const saved = settings.applyPatch(req.body);
    store.prune(saved.metrics.retentionDays);
    res.json(settings.redact(saved));
  } catch (err) { res.status(400).json({ error: err.message }); }
});
registerMetricsRoutes(app, { requireAuth: auth.requireAuth, history: (query) => ({ ...store.history({ ...query, retentionDays: settings.load().metrics.retentionDays }), collector: { lastSampleAt: Date.now(), error: null } }) });
const publicDir = fileURLToPath(new URL('../../../web/dist', import.meta.url));
app.use(express.static(publicDir));
app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
const server = app.listen(8091, '127.0.0.1', () => console.log('Browser fixture ready on http://127.0.0.1:8091'));
process.on('SIGTERM', () => server.close(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0); }));
