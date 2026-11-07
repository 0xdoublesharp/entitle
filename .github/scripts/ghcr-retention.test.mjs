// Exercise retention at the package-version and registry-manifest boundary.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageVersionsEndpoint, planPackage } from './ghcr-retention.mjs';

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

test('package versions are listed under /users for a personal owner and /orgs for an org', () => {
  assert.equal(packageVersionsEndpoint('doublesharp', 'User', 'entitle-server'), '/users/doublesharp/packages/container/entitle-server/versions');
  assert.equal(packageVersionsEndpoint('0xdoublesharp', 'Organization', 'entitle-server'), '/orgs/0xdoublesharp/packages/container/entitle-server/versions');
  assert.equal(packageVersionsEndpoint('0xdoublesharp', 'Organization', 'a/b'), '/orgs/0xdoublesharp/packages/container/a%2Fb/versions');
  for (const type of ['Bot', 'user', '', undefined, 'constructor']) {
    assert.throws(() => packageVersionsEndpoint('0xdoublesharp', type, 'entitle-server'), /Unsupported package owner type/);
  }
});

test('an org owner is protected only by references to its own namespace', async () => {
  // Images published before the move stay in the personal package, so they never match org versions.
  const result = await plan([version(1, [], 1), version(2, [], 2), version(3, ['active'], 3)], {
    owner: '0xdoublesharp', keep: 0,
    references: [`ghcr.io/0xdoublesharp/example@${digest(2)}`, `ghcr.io/doublesharp/example@${digest(1)}`, 'ghcr.io/0xdoublesharp/example:active'],
  });
  assert.deepEqual(result.remove.map(v => v.id), [1]);
  await assert.rejects(plan([version(1)], { owner: '0xdoublesharp', references: [`ghcr.io/0xdoublesharp/example@${digest(9)}`] }), /not present/);
});

// Run the real entry point in preview mode against an in-memory GitHub API and registry.
const script = fileURLToPath(new URL('./ghcr-retention.mjs', import.meta.url));
const harness = `
const calls = [];
const owner = process.env.FAKE_OWNER;
const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const version = (id, tags) => ({ id, name: 'sha256:' + String(id).repeat(64), created_at: '2026-01-01T00:00:00Z', metadata: { container: { tags } } });
globalThis.fetch = async (url, options = {}) => {
  const { host, pathname, search } = new URL(url);
  calls.push((options.method ?? 'GET') + ' ' + host + pathname + search);
  if (pathname === '/users/' + owner) return reply({ login: process.env.FAKE_LOGIN || owner, type: process.env.FAKE_TYPE });
  if (host === 'api.github.com' && pathname.endsWith('/versions')) return reply([version(1, []), version(2, ['main'])]);
  if (host === 'ghcr.io' && pathname === '/token') return reply({ token: 'registry-token' });
  if (host === 'ghcr.io') return reply({ schemaVersion: 2, layers: [] });
  return reply({}, 404);
};
process.on('exit', () => console.log('CALLS ' + JSON.stringify(calls)));
process.argv[1] = process.env.SCRIPT;
await import(process.env.SCRIPT_URL);
`;
function preview(owner, type, login = '') {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    encoding: 'utf8',
    // The inventory arrives on stdin, so the run needs no SSH access or temporary file.
    input: JSON.stringify({ schemaVersion: 1, images: [`ghcr.io/example/unrelated@sha256:${'f'.repeat(64)}`], observedAt: new Date().toISOString() }),
    env: {
      PATH: process.env.PATH, GITHUB_TOKEN: 'test-token', GITHUB_REPOSITORY: `${owner}/entitle`, GITHUB_ACTOR: 'ci',
      GHCR_APPLY: 'false', GHCR_INVENTORY: '/dev/stdin',
      FAKE_OWNER: owner, FAKE_TYPE: type, FAKE_LOGIN: login, SCRIPT: script, SCRIPT_URL: pathToFileURL(script).href,
    },
  });
  return { ...result, calls: JSON.parse(result.stdout.match(/^CALLS (.*)$/m)?.[1] ?? '[]') };
}

test('preview lists org-owned packages through /orgs and never deletes', () => {
  const run = preview('0xdoublesharp', 'Organization');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls[0], 'GET api.github.com/users/0xdoublesharp');
  for (const name of ['entitle-server', 'entitle-web-runtime']) {
    assert.ok(run.calls.includes(`GET api.github.com/orgs/0xdoublesharp/packages/container/${name}/versions?per_page=100&page=1`), name);
    assert.ok(run.calls.some(call => call.startsWith(`GET ghcr.io/v2/0xdoublesharp/${name}/manifests/`)), name);
    assert.match(run.stdout, new RegExp(`Would delete ${name}@sha256:1{64} \\(id 1\\)`));
  }
  assert.ok(!run.calls.some(call => call.includes('/users/0xdoublesharp/packages') || call.startsWith('DELETE')));
});

test('preview lists user-owned packages through /users', () => {
  const run = preview('doublesharp', 'User');
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.calls.includes('GET api.github.com/users/doublesharp/packages/container/entitle-server/versions?per_page=100&page=1'));
  assert.ok(!run.calls.some(call => call.includes('/orgs/') || call.startsWith('DELETE')));
});

test('an unknown owner type or mismatched account stops before any package is read', () => {
  for (const [type, login] of [['Bot', ''], ['Organization', 'someone-else']]) {
    const run = preview('0xdoublesharp', type, login);
    assert.notEqual(run.status, 0, type);
    assert.deepEqual(run.calls, ['GET api.github.com/users/0xdoublesharp'], type);
  }
});
