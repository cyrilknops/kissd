// Opt-in real Docker test. Run inside an isolated candidate kissd container, never the live panel.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { configurationHash } from '../src/guarded-updates.js';
const exec = promisify(execFile);
const [root, baseImage, registryImage] = process.argv.slice(2);
assert(
  /^kissd-safe-checks-[a-f0-9]{8}$/.test(path.basename(root || '')),
  'Use a dedicated empty fixture directory',
);
assert(/^cyrilknops\/kissd@sha256:[a-f0-9]{64}$/.test(baseImage || ''));
assert(/^sha256:[a-f0-9]{64}$/.test(registryImage || ''));
assert.match(
  process.env.SELF_NAME || '',
  /^kissd-safe-panel-[a-f0-9]{8}$/,
  'Use an isolated candidate panel',
);
assert.equal(process.env.KISSD_INTEGRATION_ONLY, '1', 'Explicit fixture mode is required');
assert.equal((await fs.readdir(root)).length, 0, 'Fixture directory must be empty');
const token = randomBytes(4).toString('hex');
const name = 'kissd-fixture-' + token;
const projectDir = path.join(root, 'project');
const file = path.join(projectDir, 'compose.json');
await fs.mkdir(projectDir, { mode: 0o700 });
const context = path.join(root, 'build');
await fs.mkdir(context, { mode: 0o700 });
const docker = async (...args) => {
  try {
    return (
      await exec('docker', args, { maxBuffer: 8 * 1024 * 1024, timeout: 180000 })
    ).stdout.trim();
  } catch {
    throw Error('Fixture Docker command failed: ' + args.slice(0, 3).join(' '));
  }
};
const inspect = async (id) => JSON.parse(await docker('inspect', id))[0];
const flags = ['compose', '--project-directory', projectDir, '-p', name, '-f', file];
const ids = async () =>
  Object.fromEntries(
    await Promise.all(
      ['api-a', 'api-b', 'web', 'db'].map(async (s) => [s, await docker(...flags, 'ps', '-q', s)]),
    ),
  );
const imageRefs = [];
const stages = [];
let registry;
let latestTag;
let cookie;
let configuration;
const admin = 'http://127.0.0.1:' + Number(process.env.PORT || 8090);
const post = async (p, body) =>
  fetch(admin + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const source = `import http from 'node:http';import os from 'node:os';http.createServer((req,res)=>{if(process.env.VERSION==='bad'&&process.env.ROLE==='api-b'){res.statusCode=503;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:res.statusCode===200?'ok':'unavailable',service:'loadout-api',version:process.env.VERSION,cluster:{instanceId:os.hostname(),leader:process.env.ROLE==='api-a'}}));}).listen(3000,'0.0.0.0');`;
const health = `const rows=await Promise.all(['api-a','api-b','web'].map(async name=>{const r=await fetch('http://'+name+':3000/api/health',{signal:AbortSignal.timeout(1000)});if(!r.ok)throw Error('not ready');return r.json()}));if(new Set(rows.slice(0,2).map(x=>x.cluster.instanceId)).size!==2||rows.slice(0,2).filter(x=>x.cluster.leader).length!==1)throw Error('quorum');console.log('ready');`;
async function approve(revision, ref, latest = false) {
  if (!latest) for (const s of ['api-a', 'api-b', 'web']) configuration.services[s].image = ref;
  const temp = file + '.tmp';
  await fs.writeFile(temp, JSON.stringify(configuration), { mode: 0o600 });
  await fs.rename(temp, file);
  const effective = JSON.parse(await docker(...flags, 'config', '--format', 'json'));
  const p = {
    version: 1,
    backwardCompatible: true,
    services: ['api-a', 'api-b', 'web'],
    database: 'db',
    approvedRevision: revision,
    approvedImages: Object.fromEntries(
      ['api-a', 'api-b', 'web'].map((s) => [s, configuration.services[s].image]),
    ),
    ...(latest
      ? { imageTags: Object.fromEntries(['api-a', 'api-b', 'web'].map((s) => [s, latestTag])) }
      : {}),
    configurationHash: configurationHash(effective, ['api-a', 'api-b', 'web']),
    attempts: 5,
    intervalMs: 100,
    preflight: [
      {
        name: 'Empty fixture game set',
        argv: [
          'docker',
          'exec',
          name + '-db',
          'sh',
          '-c',
          `exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM game;"`,
        ],
        expect: '0',
      },
    ],
    health: [
      {
        name: 'Fixture quorum',
        argv: ['docker', 'exec', name + '-web', 'node', '--input-type=module', '-e', health],
        expect: 'ready',
      },
    ],
    order: [
      'docker',
      'exec',
      name + '-web',
      'node',
      '--input-type=module',
      '-e',
      `console.log(JSON.stringify(['api-b','api-a','web']))`,
    ],
  };
  await fs.writeFile(path.join(projectDir, 'kissd-update.json'), JSON.stringify(p), {
    mode: 0o600,
  });
}
async function update(onChunk = () => {}) {
  const response = await post('/api/compose/update', { project: name });
  assert.equal(response.status, 200);
  let text = '';
  for await (const data of response.body) {
    const chunk = Buffer.from(data).toString('utf8');
    text += chunk;
    await onChunk(chunk);
  }
  return text;
}
async function journal() {
  const entries = await fs.readdir(path.join(projectDir, '.kissd'));
  const dirs = entries.filter((x) => /^[a-f0-9-]{36}$/.test(x));
  const rows = await Promise.all(
    dirs.map(async (id) => ({
      id,
      ...JSON.parse(await fs.readFile(path.join(projectDir, '.kissd', id, 'status.json'), 'utf8')),
    })),
  );
  return rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
}
try {
  registry = await docker(
    'run',
    '-d',
    '--name',
    name + '-registry',
    '--label',
    'io.kissd.fixture=' + token,
    '--publish',
    '127.0.0.1::5000',
    registryImage,
  );
  const port = (await inspect(registry)).NetworkSettings.Ports['5000/tcp'][0].HostPort;
  const repository = '127.0.0.1:' + port + '/fixture';
  latestTag = repository + ':latest';
  for (const [version, revision] of [
    ['old', 'f'.repeat(40)],
    ['new', 'e'.repeat(40)],
    ['bad', 'c'.repeat(40)],
  ]) {
    await fs.writeFile(path.join(context, 'fixture.mjs'), source);
    await fs.writeFile(
      path.join(context, 'Dockerfile'),
      `FROM ${baseImage}\nLABEL org.opencontainers.image.revision="${revision}" io.kissd.fixture="${token}"\nENV VERSION=${version}\nCOPY fixture.mjs /fixture.mjs\nCMD ["node","/fixture.mjs"]\n`,
    );
    const tag = repository + ':' + version;
    await docker('build', '-q', '-t', tag, context);
    await docker('push', tag);
    const image = JSON.parse(await docker('image', 'inspect', tag))[0];
    const ref = image.RepoDigests.find((x) => x.startsWith(repository + '@'));
    assert(ref);
    imageRefs.push({ version, revision, ref, tag });
  }
  const old = imageRefs.find((x) => x.version === 'old');
  configuration = {
    name,
    services: {
      db: {
        image: 'postgres:16-alpine',
        container_name: name + '-db',
        environment: {
          POSTGRES_USER: 'fixture',
          POSTGRES_DB: 'fixture',
          POSTGRES_PASSWORD: 'disposable-' + token,
        },
        volumes: ['database:/var/lib/postgresql/data'],
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U fixture'],
          interval: '1s',
          timeout: '2s',
          retries: 30,
        },
      },
      ...Object.fromEntries(
        ['api-a', 'api-b', 'web'].map((role) => [
          role,
          {
            image: old.ref,
            container_name: name + '-' + role,
            environment: { ROLE: role, TRACE_RATE: '0.01' },
            depends_on: { db: { condition: 'service_healthy' } },
          },
        ]),
      ),
    },
    volumes: { database: { labels: { 'io.kissd.fixture': token } } },
  };
  await fs.writeFile(file, JSON.stringify(configuration), { mode: 0o600 });
  await fs.writeFile(path.join(projectDir, '.env'), 'DISPOSABLE_FIXTURE=true\n', { mode: 0o600 });
  await docker(...flags, 'up', '-d', '--pull', 'never');
  const before = await ids();
  await docker(
    'exec',
    before.db,
    'psql',
    '-U',
    'fixture',
    '-d',
    'fixture',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    "CREATE TABLE game(status text); CREATE TABLE marker(value text); INSERT INTO marker VALUES ('preserved');",
  );
  const dbBefore = await inspect(before.db);
  for (let i = 0; i < 50; i++) {
    try {
      await docker('exec', before.web, 'node', '--input-type=module', '-e', health);
      break;
    } catch {
      if (i === 49) throw Error('Fixture API startup failed');
      await wait(200);
    }
  }
  const login = await post('/api/login', {
    username: process.env.KISSD_ADMIN_USER || 'admin',
    password: process.env.KISSD_ADMIN_PASSWORD,
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  const current = imageRefs.find((x) => x.version === 'new');
  const bad = imageRefs.find((x) => x.version === 'bad');
  const publish = async (ref) => {
    await docker('tag', ref, latestTag);
    await docker('push', latestTag);
  };
  await publish(current.ref);
  await approve(current.revision, current.ref, true);
  const policyBefore = await fs.readFile(path.join(projectDir, 'kissd-update.json'), 'utf8');
  let moved = false;
  const success = await update(async (chunk) => {
    if (!moved && chunk.includes('Updating api-b')) {
      moved = true;
      await publish(bad.ref);
    }
  });
  assert.match(success, /Guarded update passed/);
  assert.match(success, /Update complete/);
  const successJournal = await journal();
  assert.equal(successJournal.status, 'succeeded');
  assert.deepEqual(successJournal.touched, ['api-b', 'api-a', 'web']);
  const archive = path.join(projectDir, '.kissd', successJournal.id, 'database.dump');
  assert((await fs.stat(archive)).size > 0);
  assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
  const afterSuccess = await ids();
  for (const service of ['api-a', 'api-b', 'web'])
    assert.notEqual(afterSuccess[service], before[service]);
  assert.equal(afterSuccess.db, before.db);
  for (const service of ['api-a', 'api-b', 'web'])
    assert.equal((await inspect(afterSuccess[service])).Image, (await inspect(current.ref)).Id);
  assert(moved, 'Latest tag moved while the frozen release was deploying');
  stages.push({
    stage: 'successful-update',
    order: successJournal.touched,
    archiveBytes: (await fs.stat(archive)).size,
    protectedDatabaseUnchanged: true,
    latestMovedDuringDeployment: moved,
  });
  await publish(current.ref);
  const noOp = await update();
  assert.match(noOp, /No services changed/);
  assert.deepEqual(await ids(), afterSuccess);
  stages.push({ stage: 'healthy-no-op', containersUnchanged: true });
  const blocked = await post('/api/containers/' + afterSuccess.db + '/update', {});
  assert.equal(blocked.status, 409);
  assert.match(await (await post('/api/compose/restart', { project: name })).text(), /guarded/);
  stages.push({ stage: 'bypass-refused', status: blocked.status });
  await publish(bad.ref);
  let inserted = false;
  const failed = await update(async (chunk) => {
    if (!inserted && chunk.includes('Rolling application')) {
      inserted = true;
      await docker(
        'exec',
        before.db,
        'psql',
        '-U',
        'fixture',
        '-d',
        'fixture',
        '-c',
        "INSERT INTO marker VALUES ('written-during-rollback');",
      );
    }
  });
  assert.match(failed, /rolled back/);
  assert.doesNotMatch(failed, /Update complete/);
  const failureJournal = await journal();
  assert.equal(failureJournal.status, 'rolled-back');
  assert.deepEqual(failureJournal.touched, ['api-b']);
  const restored = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const service of ['api-a', 'api-b', 'web'])
    assert.equal(restored.services[service].image, current.ref);
  const dbAfter = await inspect(before.db);
  assert.equal(dbAfter.State.StartedAt, dbBefore.State.StartedAt);
  assert.equal(
    await docker(
      'exec',
      before.db,
      'psql',
      '-U',
      'fixture',
      '-d',
      'fixture',
      '-At',
      '-c',
      'SELECT count(*) FROM marker;',
    ),
    '2',
  );
  await docker('exec', name + '-web', 'node', '--input-type=module', '-e', health);
  stages.push({
    stage: 'failed-health-rollback',
    restoredRelease: current.revision,
    databaseWritesPreserved: inserted,
  });
  assert.equal(
    await fs.readFile(path.join(projectDir, 'kissd-update.json'), 'utf8'),
    policyBefore,
    'New releases require no new approval',
  );
  const beforePullFailure = await ids();
  const sourceBeforePullFailure = await fs.readFile(file, 'utf8');
  await docker('stop', registry);
  const pullFailure = await update();
  assert.match(pullFailure, /Latest image pull failed/);
  assert.doesNotMatch(pullFailure, /Update complete/);
  assert.deepEqual(await ids(), beforePullFailure);
  assert.equal(await fs.readFile(file, 'utf8'), sourceBeforePullFailure);
  stages.push({ stage: 'registry-pull-failure', containersAndSourceUnchanged: true });
  console.log(JSON.stringify({ passed: true, project: name, stages }));
} finally {
  if (configuration) await docker(...flags, 'down', '-v', '--remove-orphans').catch(() => {});
  if (registry) await docker('rm', '-fv', registry).catch(() => {});
  if (latestTag) await docker('image', 'rm', latestTag).catch(() => {});
  for (const image of imageRefs) {
    await docker('image', 'rm', image.tag).catch(() => {});
    await docker('image', 'rm', image.ref).catch(() => {});
  }
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.rm(context, { recursive: true, force: true });
}
