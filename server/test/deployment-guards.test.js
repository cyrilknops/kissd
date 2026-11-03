import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
const guards = await import('../src/deployment-guards.js').catch(() => null);
test('authenticated mutation guards block per-container update, project interruption and maintenance before handlers execute', async (t) => {
  assert.ok(guards, 'Guarded deployment API protection must exist');
  const app = express();
  let changes = 0;
  let idle = false;
  const auth = (req, res, next) =>
    req.headers.authorization === 'fixture' ? next() : res.sendStatus(401);
  guards.registerDeploymentGuards(app, {
    requireAuth: auth,
    inspect: async (id) => ({ Name: '/' + id, Config: { Labels: { project: 'loadout' } } }),
    composeInfo: (labels) => (labels.project ? { project: labels.project } : null),
    selfName: 'kissd',
    ensurePlain: async () => {
      throw Error('Use guarded project update');
    },
    ensureIdle: async () => {
      if (!idle) throw Error('Update is running');
    },
    ensureNoRuns: async () => {
      if (!idle) throw Error('Deployment is running');
    },
  });
  app.post('/api/containers/:id/:action', (req, res) => {
    changes++;
    res.sendStatus(200);
  });
  app.post('/api/system/prune/:target', (req, res) => {
    changes++;
    res.sendStatus(200);
  });
  app.post('/api/system/volumes/remove', (req, res) => {
    changes++;
    res.sendStatus(200);
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (p, authorized = true) =>
    fetch(base + p, { method: 'POST', headers: authorized ? { authorization: 'fixture' } : {} });
  assert.equal((await post('/api/containers/api/update', false)).status, 401);
  for (const p of [
    '/api/containers/api/update',
    '/api/containers/api/restart',
    '/api/containers/db/stop',
    '/api/containers/kissd/update',
    '/api/system/prune/images',
    '/api/system/volumes/remove',
  ])
    assert.equal((await post(p)).status, 409, p);
  assert.equal(changes, 0);
  idle = true;
  assert.equal((await post('/api/containers/api/restart')).status, 200);
  assert.equal((await post('/api/system/prune/images')).status, 200);
  assert.equal(changes, 2);
});
