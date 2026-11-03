import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kissd-compose-safety-'));
process.env.DATA_DIR = path.join(root, 'data');
const log = path.join(root, 'calls.jsonl');
await fs.mkdir(path.join(root, 'bin'));
await fs.writeFile(path.join(root, 'compose.yml'), 'services: {}\n');
await fs.writeFile(
  path.join(root, 'bin/docker'),
  `#!${process.execPath}\nimport fs from 'node:fs';\nconst a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.includes('pull')&&!a.includes('--ignore-pull-failures'))process.exit(1);\n`,
  { mode: 0o700 },
);
process.env.PATH = path.join(root, 'bin') + path.delimiter + process.env.PATH;
const { docker } = await import('../src/docker.js');
const compose = await import('../src/compose.js');
docker.listContainers = async () => [
  {
    Names: ['/fixture-api'],
    State: 'running',
    Labels: {
      'com.docker.compose.project': 'fixture',
      'com.docker.compose.project.working_dir': root,
      'com.docker.compose.project.config_files': path.join(root, 'compose.yml'),
      'com.docker.compose.service': 'api',
    },
  },
];
after(() => fs.rm(root, { recursive: true, force: true }));
const calls = async () =>
  (await fs.readFile(log, 'utf8').catch(() => ''))
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
test('a failed project pull prevents every container recreation', async () => {
  const code = await compose.update('fixture', () => {});
  assert.notEqual(code, 0, 'A failed image pull must fail the update');
  assert.equal(
    (await calls()).some((x) => x.includes('up')),
    false,
    'Do not continue with a partially fetched release',
  );
});
test('an invalid guarded policy fails closed instead of falling back to a bulk update', async () => {
  await fs.writeFile(path.join(root, 'kissd-update.json'), '{invalid');
  const before = (await calls()).length;
  await assert.rejects(
    compose.update('fixture', () => {}),
    /policy/i,
  );
  assert.equal((await calls()).length, before);
});
test('guarded projects cannot bypass deployment checks through apply or restart', async () => {
  await fs.writeFile(
    path.join(root, 'kissd-update.json'),
    JSON.stringify({ version: 1, services: ['api'] }),
    { mode: 0o600 },
  );
  for (const action of ['apply', 'restart'])
    await assert.rejects(
      compose[action]('fixture', () => {}),
      /guarded|policy/i,
    );
});

test('the guarded compose adapter resolves running containers through the Docker executable', async () => {
  const { configurationHash } = await import('../src/guarded-updates.js');
  const image = 'registry.test/api@sha256:' + 'a'.repeat(64);
  const config = {
    services: { api: { image }, db: { image: 'postgres:16-alpine' } },
  };
  const revision = 'e'.repeat(40);
  await fs.writeFile(
    path.join(root, 'bin/docker'),
    `#!${process.execPath}\nimport fs from 'node:fs';const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a.includes('config'))console.log(${JSON.stringify(JSON.stringify(config))});else if(a.includes('ps'))console.log(a.at(-1));else if(a[0]==='image'&&a[1]==='inspect')console.log(${JSON.stringify(JSON.stringify([{ Id: 'sha256:' + 'a'.repeat(64), Config: { Labels: { 'org.opencontainers.image.revision': revision } } }]))});else process.exit(1);\n`,
    { mode: 0o700 },
  );
  docker.listContainers = async () =>
    ['api', 'db'].map((service) => ({
      Names: ['/fixture-' + service],
      State: 'running',
      Labels: {
        'com.docker.compose.project': 'fixture',
        'com.docker.compose.project.working_dir': root,
        'com.docker.compose.project.config_files': path.join(root, 'compose.yml'),
        'com.docker.compose.service': service,
      },
    }));
  docker.getContainer = (id) => ({
    inspect: async () => ({
      Id: id,
      Image: 'sha256:' + 'a'.repeat(64),
      RestartCount: 0,
      State: { Running: true, StartedAt: 'unchanged' },
      Config: { Image: id === 'api' ? image : 'postgres:16-alpine' },
      Mounts: [],
    }),
  });
  const check = {
    name: 'Fixture readiness',
    argv: [process.execPath, '-e', "console.log('ready')"],
    expect: 'ready',
  };
  await fs.writeFile(
    path.join(root, 'kissd-update.json'),
    JSON.stringify({
      version: 1,
      services: ['api'],
      database: 'db',
      approvedRevision: revision,
      approvedImages: { api: image },
      backwardCompatible: true,
      configurationHash: configurationHash(config, ['api']),
      preflight: [check],
      health: [check],
    }),
    { mode: 0o600 },
  );
  let output = '';
  assert.equal(
    await compose.update('fixture', (text) => {
      output += text;
    }),
    0,
  );
  assert.match(output, /No services changed/);
});
