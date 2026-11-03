import { test } from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../src/loadout-policy.js').catch(() => null);
test('Loadout policy protects PostgreSQL, keeps one ingest owner and orders the follower first', () => {
  assert.ok(module);
  const p = module.buildLoadoutPolicy({
    prefix: 'loadout-staging',
    origin: 'https://dev.loadout.be',
    revision: 'e'.repeat(40),
    config: { services: {} },
  });
  assert.deepEqual(p.services, [
    'loadout-staging-api',
    'loadout-staging-api-replica',
    'loadout-staging-web',
  ]);
  assert.equal(p.database, 'loadout-staging-postgres');
  assert(!p.services.includes(p.database));
  assert.match(p.order.at(-1), /leader/);
  assert.match(p.health[0].argv.at(-1), /instanceId/);
  assert.match(p.preflight[0].argv.at(-1), /running.*paused/);
  assert.equal(p.backwardCompatible, true);
  assert.throws(() =>
    module.buildLoadoutPolicy({
      prefix: '../unsafe',
      origin: 'https://dev.loadout.be',
      revision: 'e'.repeat(40),
      config: {},
    }),
  );
  for (const origin of [
    'http://dev.loadout.be',
    'https://user:secret@dev.loadout.be',
    'https://dev.loadout.be/path',
  ])
    assert.throws(() =>
      module.buildLoadoutPolicy({
        prefix: 'loadout',
        origin,
        revision: 'e'.repeat(40),
        config: {},
      }),
    );
});
