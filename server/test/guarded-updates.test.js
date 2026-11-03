import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// A missing guarded engine is the intended RED state for this new deployment contract.
const module = await import('../src/guarded-updates.js').catch(() => null);
const ref = (c) => `registry.test/${c === 'b' || c === 'd' ? 'web' : 'api'}@sha256:${c.repeat(64)}`;
const rev = 'e'.repeat(40);
async function fixture(t, options = {}) {
  assert.ok(module, 'The guarded project update engine must exist');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kissd-guarded-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'compose.yml');
  const config = {
    name: 'fixture',
    services: {
      db: { image: 'postgres:16-alpine' },
      'api-a': { image: ref('c'), environment: { TRACE_RATE: '0.01' } },
      'api-b': { image: ref('c'), environment: { TRACE_RATE: '0.01' } },
      web: { image: ref('d') },
    },
  };
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  await fs.writeFile(path.join(dir, '.env'), 'PRIVATE=fixture-secret\n', { mode: 0o600 });
  const services = ['api-a', 'api-b', 'web'];
  const policy = {
    version: 1,
    backwardCompatible: true,
    services,
    database: 'db',
    approvedRevision: rev,
    approvedImages: Object.fromEntries(services.map((n) => [n, config.services[n].image])),
    configurationHash: module.configurationHash(config, services),
    preflight: [{ name: 'No active games', argv: ['fixture-preflight'], expect: '0' }],
    health: [{ name: 'Quorum and public routes', argv: ['fixture-health'], expect: 'ready' }],
    order: ['fixture-order'],
    attempts: 2,
    intervalMs: 1,
  };
  if (options.latest) policy.imageTags = Object.fromEntries(services.map(s => [s, config.services[s].image.split('@')[0]+':latest']));
  const containers = Object.fromEntries(
    ['db', ...services].map((n) => [
      n,
      {
        Id: n,
        Image: 'sha256:' + (n === 'web' ? 'b' : 'a').repeat(64),
        RestartCount: 0,
        State: { Running: true, StartedAt: 'before', Health: { Status: 'healthy' } },
        Config: {
          Image: n === 'db' ? 'postgres:16-alpine' : ref(n === 'web' ? 'b' : 'a'),
          Labels: { 'org.opencontainers.image.revision': 'f'.repeat(40) },
        },
        Mounts: [],
      },
    ]),
  );
  const calls = [];
  let healthFailures = 0;
  const run = async (argv, opts = {}) => {
    calls.push([...argv]);
    if (argv[0] === 'fixture-preflight') {
      if (options.barrier) await options.barrier;
      return { stdout: options.active ? '1' : '0' };
    }
    if (argv[0] === 'fixture-health') {
      if (options.healthFail && containers['api-a'].Config.Image === ref('c')) {
        healthFailures++;
        throw Error('unhealthy');
      }
      return { stdout: 'ready' };
    }
    if (argv[0] === 'fixture-order')
      return { stdout: JSON.stringify(options.order ?? ['api-b', 'api-a', 'web']) };
    if (argv[1] === 'image' && argv[2] === 'inspect') {
      if (options.pullFail) throw Error('Image unavailable');
      return {
        stdout: JSON.stringify([
          {
            Id: 'sha256:' + (argv[3].endsWith(':latest') ? (argv[3].includes('/web') ? 'd' : 'c').repeat(64) : argv[3].split(':').at(-1)),
            RepoDigests: [ref(argv[3].includes('/web') ? 'd' : 'c')],
            Config: { Labels: { 'org.opencontainers.image.revision': options.revision ?? rev } },
          },
        ]),
      };
    }
    if (argv[1] === 'pull') {
      if (options.latest && !options.pullFail) return {stdout:''};
      throw Error('pull failed: fixture-private-detail');
    }
    if (argv.includes('config'))
      return { stdout: JSON.stringify(JSON.parse(await fs.readFile(file, 'utf8'))) };
    if (argv.some((a) => a.includes('pg_dump'))) {
      if (options.backupFail) throw Error('backup failed');
      await fs.writeFile(opts.outputFile, 'verified archive');
      return { stdout: '' };
    }
    if (argv.some((a) => a.includes('pg_database_size'))) return { stdout: '1024' };
    if (argv.includes('pg_restore')) return { stdout: 'archive list' };
    if (argv.includes('up')) {
      const service = argv.at(-1);
      const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
      containers[service].Config.Image = cfg.services[service].image;
      containers[service].Image = 'sha256:' + cfg.services[service].image.split(':').at(-1);
      containers[service].State.StartedAt = 'after';
      if (options.drift && service === 'api-b')
        await fs.writeFile(path.join(dir, '.env'), 'OWNER_EDIT=preserved\n');
      if (options.upFail && service === 'api-b' && cfg.services[service].image === ref('c'))
        throw Error('recreate failed after replacing service');
      return { stdout: '' };
    }
    throw Error('Unexpected fixture command ' + argv.join(' '));
  };
  const project = {
    project: 'fixture',
    workdir: dir,
    files: [file],
    services: ['db', ...services],
    hasSelf: false,
  };
  let journalWrites = 0;
  const updater = module.createGuardedUpdater({
    writeJournal: options.journalFailure
      ? async (file, value) => {
          if (++journalWrites >= 4) throw Error('fixture journal failure');
          await fs.writeFile(file, value, { mode: 0o600 });
        }
      : undefined,
    run,
    inspect: async (service) => structuredClone(containers[service]),
    sleep: async () => {},
    statfs: options.noSpace ? async () => ({ bavail: 0, bsize: 4096 }) : undefined,
  });
  return {
    dir,
    file,
    config,
    policy,
    project,
    updater,
    containers,
    calls,
    healthFailures: () => healthFailures,
  };
}
test('latest tracking accepts a new release without changing the policy and keeps rollback pins', async t => {
  const f=await fixture(t,{latest:true});
  f.policy.approvedRevision='f'.repeat(40);
  f.policy.approvedImages={'api-a':ref('a'),'api-b':ref('a'),web:ref('b')};
  for (const name of f.policy.services) f.config.services[name].image=f.policy.approvedImages[name];
  await fs.writeFile(f.file,JSON.stringify(f.config));
  const policyBefore=JSON.stringify(f.policy);
  await f.updater.update(f.project,f.policy,()=>{});
  const actual=JSON.parse(await fs.readFile(f.file,'utf8'));
  assert.equal(actual.services['api-a'].image,ref('c'));
  assert.equal(actual.services.web.image,ref('d'));
  assert.equal(JSON.stringify(f.policy),policyBefore);
  assert.equal(f.containers.db.State.StartedAt,'before');
  const pulls=f.calls.filter(a=>a[1]==='pull');
  assert.equal(pulls.length,2);
});
test('guarded update backs up before sequential replacements, excludes DB and preserves configuration', async (t) => {
  const f = await fixture(t);
  const messages = [];
  await f.updater.update(f.project, f.policy, (x) => messages.push(x));
  const updates = f.calls.filter((a) => a.includes('up'));
  assert.deepEqual(
    updates.map((a) => a.at(-1)),
    ['api-b', 'api-a', 'web'],
  );
  assert(
    updates.every((a) => a.includes('--no-deps') && a.includes('--pull') && a.includes('never')),
  );
  const backupIndex = f.calls.findIndex((a) => a.some((v) => v.includes('pg_dump')));
  assert(backupIndex >= 0 && backupIndex < f.calls.findIndex((a) => a.includes('up')));
  assert(f.calls.some((a) => a.includes('pg_restore')));
  assert.equal(f.containers.db.State.StartedAt, 'before');
  assert.equal((await fs.readFile(path.join(f.dir, '.kissd', '.gitignore'), 'utf8')).trim(), '*');
  assert.equal(await fs.readFile(f.file, 'utf8'), JSON.stringify(f.config));
  assert(!messages.join('').includes('fixture-secret'));
});
for (const [name, options, pattern] of [
  ['pull failure', { pullFail: true }, /image|pull/i],
  ['image revision mismatch', { revision: '0'.repeat(40) }, /revision/i],
  ['active games', { active: true }, /preflight|active|check/i],
  ['unverified database backup', { backupFail: true }, /backup/i],
  ['invalid update order', { order: ['db', 'api-a', 'web'] }, /order/i],
]) {
  test(`${name} stops before any application is replaced`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(
      f.updater.update(f.project, f.policy, () => {}),
      pattern,
    );
    assert.equal(
      f.calls.some((a) => a.includes('up')),
      false,
    );
  });
}
test('configuration drift and mutable image refs are refused before changing containers', async (t) => {
  const f = await fixture(t);
  f.config.services['api-a'].environment.TRACE_RATE = '0.1';
  await fs.writeFile(f.file, JSON.stringify(f.config));
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /configuration/i,
  );
  f.config.services['api-a'].image = 'registry.test/api:latest';
  await fs.writeFile(f.file, JSON.stringify(f.config));
  f.policy.configurationHash = module.configurationHash(f.config, f.policy.services);
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /pinned|digest/i,
  );
  assert.equal(
    f.calls.some((a) => a.includes('up')),
    false,
  );
});
for (const options of [{ healthFail: true }, { upFail: true }])
  test(
    'failed replacement restores actual old pins and changed replicas without restoring the database ' +
      JSON.stringify(options),
    async (t) => {
      const f = await fixture(t, options);
      await assert.rejects(
        f.updater.update(f.project, f.policy, () => {}),
        /rolled back/i,
      );
      const restored = JSON.parse(await fs.readFile(f.file, 'utf8'));
      for (const n of ['api-a', 'api-b', 'web'])
        assert.equal(restored.services[n].image, ref(n === 'web' ? 'b' : 'a'));
      assert.equal(f.containers['api-a'].Config.Image, ref('a'));
      assert.equal(f.containers['api-b'].Config.Image, ref('a'));
      assert.equal(f.containers.db.State.StartedAt, 'before');
      assert.equal(
        f.calls.filter((a) => a.includes('pg_restore')).length,
        1,
        'Only archive verification; never restore live database data',
      );
    },
  );
test('an already deployed pinned release performs health checks without restarting or backing up the DB', async (t) => {
  const f = await fixture(t);
  for (const n of f.policy.services) {
    f.containers[n].Config.Image = f.config.services[n].image;
    f.containers[n].Image = 'sha256:' + f.config.services[n].image.split(':').at(-1);
  }
  await f.updater.update(f.project, f.policy, () => {});
  assert(f.calls.some((a) => a[0] === 'fixture-health'));
  assert.equal(
    f.calls.some((a) => a.includes('up') || a.some((v) => v.includes('pg_dump'))),
    false,
  );
});
test('policy parsing rejects malformed, oversized and writable policies without a legacy fallback', async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  const p = path.join(f.dir, 'kissd-update.json');
  assert.equal(await module.readPolicy(f.project), null);
  for (const value of [
    '{invalid',
    JSON.stringify({ version: 1, services: [] }),
    'x'.repeat(70000),
  ]) {
    await fs.writeFile(p, value, { mode: 0o600 });
    await assert.rejects(module.readPolicy(f.project), /policy/i);
  }
  await fs.writeFile(p, JSON.stringify(f.policy));
  await fs.chmod(p, 0o666);
  await assert.rejects(module.readPolicy(f.project), /policy/i);
});

test('the durable journal records the touched service before a replacement can fail', async (t) => {
  const f = await fixture(t, { upFail: true });
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /rolled back/i,
  );
  const files = await fs.readdir(path.join(f.dir, '.kissd'));
  const jobs = files.filter((x) => !x.includes('.'));
  assert.equal(jobs.length, 1);
  const status = JSON.parse(
    await fs.readFile(path.join(f.dir, '.kissd', jobs[0], 'status.json'), 'utf8'),
  );
  assert.equal(status.status, 'rolled-back');
  assert.deepEqual(status.touched, ['api-b']);
  assert.equal(status.revision, rev);
});
test('a stale deployment lock blocks every new mutation after a process restart', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, '.kissd'), { mode: 0o700 });
  await fs.writeFile(path.join(f.dir, '.kissd', 'update.lock'), 'interrupted', { mode: 0o600 });
  await assert.rejects(module.assertIdle(f.project), /recovery/i);
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /recovery/i,
  );
  assert.equal(f.calls.length, 0);
});
test('a listener disconnected from the browser cannot abort the deployment', async (t) => {
  const f = await fixture(t);
  await f.updater.update(f.project, f.policy, () => {
    throw Error('disconnected');
  });
  assert.equal(f.containers.web.Config.Image, ref('d'));
});
test('valid policies, nested symlinks, and policy validation errors stay distinct', async (t) => {
  const f = await fixture(t);
  const p = path.join(f.dir, 'kissd-update.json');
  await fs.writeFile(p, JSON.stringify(f.policy), { mode: 0o600 });
  assert.equal((await module.readPolicy(f.project)).approvedRevision, rev);
  await fs.unlink(p);
  await fs.symlink(f.file, p);
  await assert.rejects(module.readPolicy(f.project), /policy/i);
});

test('command runner captures bounded stdout without leaking stderr and streams private backups', async (t) => {
  assert.ok(module);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kissd-command-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(
    (
      await module.runCommand([
        process.execPath,
        '-e',
        'process.stdout.write("ready");process.stderr.write("private-token")',
      ])
    ).stdout,
    'ready',
  );
  await assert.rejects(
    module.runCommand([
      process.execPath,
      '-e',
      'process.stderr.write("private-token");process.exit(2)',
    ]),
    (e) => !e.message.includes('private-token'),
  );
  await assert.rejects(
    module.runCommand([process.execPath, '-e', 'setTimeout(()=>{},10000)'], { timeoutMs: 20 }),
  );
  await assert.rejects(module.runCommand(['/missing/fixture-command']));
  await assert.rejects(
    module.runCommand([process.execPath, '-e', 'process.stdout.write("x".repeat(3*1024*1024))']),
  );
  const output = path.join(dir, 'archive');
  await module.runCommand([process.execPath, '-e', 'process.stdout.write("backup")'], {
    outputFile: output,
  });
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.equal(
    (
      await module.runCommand([process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], {
        inputFile: output,
      })
    ).stdout,
    'backup',
  );
});

test('two update requests attach to one deployment instead of replacing each replica twice', async (t) => {
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, { barrier });
  const first = f.updater.update(f.project, f.policy, () => {});
  for (let i = 0; i < 100 && !f.calls.some((a) => a[0] === 'fixture-preflight'); i++)
    await new Promise((resolve) => setTimeout(resolve, 2));
  await assert.rejects(module.assertIdle(f.project), /running/);
  const second = f.updater.update(f.project, f.policy, () => {});
  release();
  await Promise.all([first, second]);
  assert.equal(f.calls.filter((a) => a.includes('up')).length, 3);
});

test('external configuration changes keep recovery locked and are never overwritten by rollback', async (t) => {
  const f = await fixture(t, { drift: true });
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /Manual recovery/i,
  );
  assert.equal(await fs.readFile(path.join(f.dir, '.env'), 'utf8'), 'OWNER_EDIT=preserved\n');
  await assert.rejects(module.assertIdle(f.project), /recovery/i);
});

test('an approved source revision cannot be used with different unapproved image digests', async (t) => {
  const f = await fixture(t);
  f.config.services['api-a'].image = ref('e');
  await fs.writeFile(f.file, JSON.stringify(f.config));
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /approved.*image|image.*approved/i,
  );
  assert.equal(
    f.calls.some((a) => a.includes('up')),
    false,
  );
});
test('insufficient backup space stops before database dumping or container changes', async (t) => {
  const f = await fixture(t, { noSpace: true });
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /space|backup/i,
  );
  assert.equal(
    f.calls.some((a) => a.includes('up') || a.some((v) => v.includes('pg_dump'))),
    false,
  );
});

test('maintenance and deployment startup reserve their work before awaiting filesystem or Docker calls', async (t) => {
  const f = await fixture(t);
  assert.equal(typeof module.withMaintenance, 'function');
  let release;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const maintenance = module.withMaintenance(() => barrier);
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /maintenance/i,
  );
  release();
  await maintenance;
  let entered = false;
  const deployment = f.updater.update(f.project, f.policy, () => {});
  await assert.rejects(
    module.withMaintenance(async () => {
      entered = true;
    }),
    /update|deployment/i,
  );
  assert.equal(entered, false);
  await deployment;
});

test('journal write failure after a replacement still rolls back and retains the recovery lock', async (t) => {
  const f = await fixture(t, { journalFailure: true });
  await assert.rejects(
    f.updater.update(f.project, f.policy, () => {}),
    /journal|recovery/i,
  );
  assert.equal(f.containers['api-b'].Config.Image, ref('a'));
  await assert.rejects(module.assertIdle(f.project), /recovery/i);
});
