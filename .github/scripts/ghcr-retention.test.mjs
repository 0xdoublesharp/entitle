// Exercise retention at the package-version and registry-manifest boundary.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planPackage } from './ghcr-retention.mjs';

const digest = n => `sha256:${String(n).padStart(64, '0')}`;
const version = (n, tags = [], age = 100) => ({
  id: n, name: digest(n), metadata: { container: { tags } },
  created_at: new Date(Date.UTC(2026, 0, age)).toISOString(),
});
const now = Date.UTC(2026, 6, 1);
const plan = (versions, options = {}) => planPackage({
  name: 'example', owner: 'doublesharp', versions, now, keep: 2,
  references: [], manifest: async () => ({ schemaVersion: 2, layers: [] }), ...options,
});

test('keeps latest tagged images, protected tags, deployed digests and their untagged children', async () => {
  const versions = [version(1, ['old'], 1), version(2, [], 1), version(3, ['main'], 2),
    version(4, ['deployed'], 3), version(5, ['newer'], 4), version(6, ['newest'], 5),
    version(7, [], 6), version(8, ['retain-recovery'], 1)];
  const result = await plan(versions, {
    references: [`ghcr.io/doublesharp/example@${digest(4)}`],
    manifest: async d => d === digest(6)
      ? { schemaVersion: 2, manifests: [{ digest: digest(7) }] }
      : { schemaVersion: 2, layers: [] },
  });
  assert.deepEqual(result.remove.map(v => v.id).sort(), [1, 2]);
});

test('preserves recent untagged pushes and manifest dependencies beyond the listing', async () => {
  const recent = { ...version(2), created_at: new Date(now - 1000).toISOString() };
  const result = await plan([version(1), recent], {
    manifest: async d => d === digest(2)
      ? { schemaVersion: 2, manifests: [{ digest: digest(1) }] }
      : { schemaVersion: 2, layers: [] },
  });
  assert.equal(result.remove.length, 0);
});

test('cache keeps every named cache head and deletes only unreachable old manifests', async () => {
  const result = await plan([version(1, ['api']), version(2, ['bot']), version(3)], { keep: 0, cache: true });
  assert.deepEqual(result.remove.map(v => v.id), [3]);
});

test('missing deployed digest or unreadable retained manifest aborts the plan', async () => {
  await assert.rejects(plan([version(1)], { references: [`ghcr.io/doublesharp/example@${digest(9)}`] }), /not present/);
  await assert.rejects(plan([version(1, ['main'])], { manifest: async () => { throw Error('registry unavailable'); } }), /registry unavailable/);
});

test('a deployed tag is resolved and malformed manifests abort instead of deleting dependencies', async () => {
  assert.equal((await plan([version(1, ['active'])], {
    references: ['ghcr.io/doublesharp/example:active'], keep: 0,
  })).remove.length, 0);
  await assert.rejects(plan([version(1, ['main'])], { manifest: async () => ({}) }), /manifest/);
});
