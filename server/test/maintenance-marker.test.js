import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('a persistent self-maintenance marker blocks mutations after Kissd replacement', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kissd-marker-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  process.env.DATA_DIR = dir;
  const { withMaintenance } = await import('../src/guarded-updates.js');
  await fs.writeFile(path.join(dir, 'self-maintenance.lock'), 'pending', { mode: 0o600 });
  let called = false;
  await assert.rejects(
    withMaintenance(async () => {
      called = true;
    }),
    /maintenance.*pending/i,
  );
  assert.equal(called, false);
  await fs.unlink(path.join(dir, 'self-maintenance.lock'));
  await withMaintenance(async () => {
    called = true;
  });
  assert.equal(called, true);
});
