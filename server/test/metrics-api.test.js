import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerMetricsRoutes } from '../src/metrics-routes.js';
import { MetricsStore } from '../src/metrics-store.js';

// Credentials and storage belong exclusively to this disposable test process.
process.env.KISSD_ADMIN_PASSWORD = 'fixture-only-password';
process.env.KISSD_JWT_SECRET = 'fixture-only-signing-key-for-integration-tests';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kissd-api-'));
const auth = await import('../src/auth.js');
const settings = await import('../src/config.js');
after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

test('authenticated metrics API validates queries, returns stored history and hides storage errors', async (t) => {
  const store = new MetricsStore(path.join(process.env.DATA_DIR, 'metrics.sqlite'));
  const now = Date.now();
  store.record(now - 30_000, [{ target: 'host', name: 'Host', state: 'up', metrics: { cpu: 5 } }]);
  const app = express();
  app.use(cookieParser());
  app.post('/session', (req, res) => { auth.issueSession(res); res.json({ ok: true }); });
  registerMetricsRoutes(app, { requireAuth: auth.requireAuth, history: (query) => store.history(query) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/metrics`)).status, 401);
  const session = await fetch(`${url}/session`, { method: 'POST' });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const get = (query = '') => fetch(`${url}/api/metrics${query}`, { headers: { cookie } });
  const response = await get('?range=1h&target=host');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.points[0].cpu, 5);
  assert.equal(body.range, '1h');
  for (const query of ['?range=1y', '?range=1h&range=7d', '?target[x]=host']) assert.equal((await get(query)).status, 400);
  const original = store.history;
  store.history = () => { throw new Error('private storage path'); };
  const failed = await get();
  assert.equal(failed.status, 503);
  assert.ok(!(await failed.text()).includes('private storage path'));
  store.history = original;
});

test('settings migration defaults to 7 days and invalid patches never change stored retention', () => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'settings.json'), JSON.stringify({ alerts: { pollSeconds: 60 } }));
  assert.equal(settings.load().metrics.retentionDays, 7);
  assert.equal(settings.load().alerts.pollSeconds, 60);
  assert.equal(settings.applyPatch({ metrics: { retentionDays: 3, ignored: true } }).metrics.retentionDays, 3);
  assert.deepEqual(settings.load().metrics, { retentionDays: 3 });
  for (const metrics of [null, { retentionDays: 0 }, { retentionDays: '90' }, { retentionDays: 1000 }]) assert.throws(() => settings.applyPatch({ metrics }));
  assert.equal(settings.load().metrics.retentionDays, 3);
});
