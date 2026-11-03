// Run only after verifying the main CI run and backward-compatible database behavior.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { projects } from '../src/compose.js';
import { runCommand, assertIdle, readPolicy } from '../src/guarded-updates.js';
import { buildLoadoutPolicy } from '../src/loadout-policy.js';
import * as registry from '../src/registry.js';
const values = process.argv.slice(2);
const args = {};
for (let i = 0; i < values.length; i++) {
  if (values[i] === '--backward-compatible') args.compatible = true;
  else if (['--project', '--revision', '--origin', '--ci-run'].includes(values[i]))
    args[values[i].slice(2)] = values[++i];
  else throw Error('Unknown argument');
}
if (
  !args.compatible ||
  !/^https:\/\/github\.com\/iwg-it\/iwg\/actions\/runs\/\d+$/.test(args['ci-run'] || '')
)
  throw Error('Supply --backward-compatible and the CI run URL you verified');
const project = (await projects()).find((p) => p.project === args.project);
if (!project || project.files.length !== 1 || project.hasSelf)
  throw Error('Choose an existing Loadout compose project with one compose file');
await assertIdle(project);
const root = path.join(project.workdir, '.kissd');
await fs.mkdir(root, { recursive: true, mode: 0o700 });
const stat = await fs.lstat(root);
if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
  throw Error('Private update directory required');
const lock = path.join(root, 'update.lock');
const id = randomUUID();
const handle = await fs.open(lock, 'wx', 0o600);
await handle.writeFile(JSON.stringify({ id, operation: 'approval' }));
await handle.close();
try {
  const run = (argv) => runCommand(argv, { cwd: project.workdir, env: registry.env() });
  const config = JSON.parse(
    (
      await run([
        'docker',
        'compose',
        '--project-directory',
        project.workdir,
        '-p',
        project.project,
        '-f',
        project.files[0],
        'config',
        '--format',
        'json',
      ])
    ).stdout,
  );
  const policy = buildLoadoutPolicy({
    prefix: project.project,
    origin: args.origin,
    revision: args.revision,
    ciRun: args['ci-run'],
    config,
  });
  if (
    !project.services.includes(policy.database) ||
    policy.services.some((s) => !project.services.includes(s))
  )
    throw Error('Loadout services do not match this project');
  for (const name of policy.services) {
    const ref = config.services[name]?.image;
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(ref || ''))
      throw Error('Pin every application image by digest before approval');
    const image = JSON.parse((await run(['docker', 'image', 'inspect', ref])).stdout)[0];
    if (image.Config.Labels?.['org.opencontainers.image.revision'] !== args.revision)
      throw Error('Pull and verify all approved images first');
  }
  const target = path.join(project.workdir, 'kissd-update.json');
  try {
    const previous = await fs.lstat(target);
    if (!previous.isFile() || previous.isSymbolicLink())
      throw Error('Policy must be a regular file');
    await fs.writeFile(
      path.join(root, 'previous-policy-' + id + '.json'),
      await fs.readFile(target),
      { mode: 0o600, flag: 'wx' },
    );
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const temp = target + '.' + id + '.tmp';
  await fs.writeFile(temp, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, target);
  await readPolicy(project);
  console.log(
    JSON.stringify({
      approved: true,
      project: project.project,
      revision: args.revision,
      services: policy.services,
      databaseExcluded: policy.database,
      ciRun: policy.ciRun,
    }),
  );
} finally {
  await fs.unlink(lock);
}
