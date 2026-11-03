import { test } from 'node:test';
import assert from 'node:assert/strict';
const resolver = await import('../src/latest-images.js').catch(() => null);
const ref = (name, char) => `registry.test/${name}@sha256:${char.repeat(64)}`;
const revision = 'e'.repeat(40);
function fixture(options = {}) {
  const services = ['api-a', 'api-b', 'web'];
  const policy = {
    services,
    approvedImages: { 'api-a': ref('api', 'a'), 'api-b': ref('api', 'a'), web: ref('web', 'b') },
    imageTags: {
      'api-a': 'registry.test/api:latest',
      'api-b': 'registry.test/api:latest',
      web: 'registry.test/web:latest',
    },
  };
  const config = {
    services: Object.fromEntries(services.map((s) => [s, { image: policy.approvedImages[s] }])),
  };
  const calls = [];
  const run = async (argv) => {
    calls.push(argv);
    if (argv[1] === 'pull') {
      if (options.pullFail) throw Error('registry secret must stay private');
      return { stdout: '' };
    }
    const web = argv[3].includes('/web');
    const repository = web ? 'web' : 'api';
    const char = web ? 'd' : 'c';
    return {
      stdout: JSON.stringify([
        {
          Id: 'sha256:' + (options.digestMismatch && argv[3].includes('@') ? '0' : char).repeat(64),
          RepoDigests: options.noDigest ? [] : [ref(repository, char)],
          Config: {
            Labels: {
              'org.opencontainers.image.revision': options.noRevision
                ? ''
                : options.mismatch && web
                  ? 'f'.repeat(40)
                  : revision,
            },
          },
        },
      ]),
    };
  };
  return { policy, config, run, calls };
}
test('latest is fetched once per repository and frozen as immutable coherent release pins', async () => {
  assert.ok(resolver, 'Latest resolution must exist');
  const f = fixture();
  const result = await resolver.resolveLatest(f.policy, f.config, f.run, () => {});
  assert.equal(result.revision, revision);
  assert.deepEqual(result.refs, {
    'api-a': ref('api', 'c'),
    'api-b': ref('api', 'c'),
    web: ref('web', 'd'),
  });
  assert.equal(f.calls.filter((a) => a[1] === 'pull').length, 2);
});
for (const [name, options, pattern] of [
  ['failed pull', { pullFail: true }, /pull/i],
  ['mixed release', { mismatch: true }, /revision|release/i],
  ['missing digest', { noDigest: true }, /digest/i],
  ['digest mismatch', { digestMismatch: true }, /digest/i],
  ['missing revision', { noRevision: true }, /revision/i],
]) {
  test(name + ' refuses latest without exposing registry details', async () => {
    assert.ok(resolver);
    const f = fixture(options);
    await assert.rejects(
      resolver.resolveLatest(f.policy, f.config, f.run, () => {}),
      pattern,
    );
  });
}
test('latest cannot switch repositories or accept a mutable configured source', async () => {
  assert.ok(resolver);
  for (const image of [
    'registry.test/other@sha256:' + 'a'.repeat(64),
    'registry.test/api:latest',
  ]) {
    const f = fixture();
    f.config.services['api-a'].image = image;
    await assert.rejects(
      resolver.resolveLatest(f.policy, f.config, f.run, () => {}),
      /repository|pinned/i,
    );
    assert.equal(f.calls.length, 0);
  }
});
