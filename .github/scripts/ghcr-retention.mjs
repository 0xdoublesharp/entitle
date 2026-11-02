// Keep rollback images and all reachable OCI manifests; delete only a preflighted plan.
// Run directly in Actions. The exported planner has no network or filesystem effects.
import { readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const protectedTag = /^(main|latest|stable|production|staging|retain-.+|keep-.+)$/;
const validDigest = /^sha256:[a-f0-9]{64}$/;
const grace = 48 * 60 * 60 * 1000;

export async function planPackage({ name, owner, versions, references, manifest, now = Date.now(), keep = 20, cache = false }) {
  const byDigest = new Map(versions.map(v => [v.name, v]));
  const tagged = versions.filter(v => v.metadata.container.tags.length)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const roots = new Set(tagged.slice(0, keep).map(v => v.name));
  for (const v of versions) {
    if (!validDigest.test(v.name) || !Number.isFinite(Date.parse(v.created_at))) throw Error(`Invalid version in ${name}`);
    if (now - Date.parse(v.created_at) < grace || v.metadata.container.tags.some(t => cache || protectedTag.test(t))) roots.add(v.name);
  }
  const prefix = `ghcr.io/${owner}/${name}`;
  for (const ref of references) {
    let found;
    if (ref.startsWith(`${prefix}@`)) found = byDigest.get(ref.slice(prefix.length + 1));
    else if (ref.startsWith(`${prefix}:`)) found = versions.find(v => v.metadata.container.tags.includes(ref.slice(prefix.length + 1)));
    else continue;
    if (!found) throw Error(`Protected image is not present in ${name}: ${ref}`);
    roots.add(found.name);
  }
  const retained = new Set();
  async function visit(digest) {
    if (!validDigest.test(digest)) throw Error(`Invalid manifest digest in ${name}`);
    if (retained.has(digest)) return;
    retained.add(digest);
    const body = await manifest(digest);
    if (body.schemaVersion !== 2 || (!Array.isArray(body.manifests) && !Array.isArray(body.layers))) throw Error(`Invalid registry manifest in ${name}`);
    // Configs and layers are blobs, not independently deletable package versions.
    for (const child of body.manifests ?? []) await visit(child.digest);
  }
  await Promise.all([...roots].map(visit));
  return { name, total: versions.length, retained, remove: versions.filter(v => !retained.has(v.name)) };
}

async function main() {
  const { GITHUB_TOKEN: token, GITHUB_REPOSITORY: repository, GITHUB_ACTOR: actor } = process.env;
  if (!token || !repository || !actor) throw Error('Missing GitHub identity');
  const owner = repository.split('/')[0].toLowerCase();
  const config = JSON.parse(readFileSync('.github/ghcr-retention.json', 'utf8'));
  const apply = process.env.GHCR_APPLY === 'true';
  function readInventory() {
    let raw;
    if (process.env.GHCR_INVENTORY_KEY_FILE && process.env.GHCR_INVENTORY_HOSTS_FILE) {
      raw = execFileSync('ssh', ['-F', '/dev/null', '-i', process.env.GHCR_INVENTORY_KEY_FILE,
        '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', `UserKnownHostsFile=${process.env.GHCR_INVENTORY_HOSTS_FILE}`, '-o', 'ConnectTimeout=15',
        '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60',
        '-o', `ControlPath=${process.env.GHCR_INVENTORY_CONTROL_PATH ?? `${process.env.GHCR_INVENTORY_KEY_FILE}.socket`}`,
        'ghcr-inventory@159.89.222.183', 'ghcr-image-inventory'], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    } else if (!apply && process.env.GHCR_INVENTORY) raw = readFileSync(process.env.GHCR_INVENTORY, 'utf8');
    else throw Error('Live SSH inventory is required for deletion');
    const result = JSON.parse(raw);
    if (result.schemaVersion !== 1 || !Array.isArray(result.images) || !result.images.length
        || !Number.isFinite(Date.parse(result.observedAt))
        || Math.abs(Date.now() - Date.parse(result.observedAt)) > 5 * 60 * 1000) throw Error('Missing or stale live inventory');
    return result;
  }
  const inventory = readInventory();
  const relevant = images => JSON.stringify(images.filter(ref => config.packages.some(p =>
    ref.startsWith(`ghcr.io/${owner}/${p.name}@`) || ref.startsWith(`ghcr.io/${owner}/${p.name}:`))).sort());
  const baseline = relevant(inventory.images);
  const pins = (process.env.GHCR_RETAIN_IMAGES ?? '').split(/\s+/).filter(Boolean);
  const references = [...inventory.images, ...pins];
  const ghHeaders = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  async function api(path, method = 'GET') {
    const response = await fetch(`https://api.github.com${path}`, { method, headers: ghHeaders, signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
  const plans = [];
  // Complete every package's inventory and manifest traversal BEFORE the first delete.
  for (const entry of config.packages) {
    const name = entry.name;
    const endpoint = `/users/${owner}/packages/container/${encodeURIComponent(name)}/versions`;
    const versions = [];
    for (let page = 1; ; page++) {
      if (page > 100) throw Error(`Package pagination exceeded safety limit: ${name}`);
      const batch = await api(`${endpoint}?per_page=100&page=${page}`);
      versions.push(...batch);
      if (batch.length < 100) break;
    }
    const scope = `repository:${owner}/${name}:pull`;
    const response = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(scope)}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` }, signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error(`Registry authentication failed for ${name}: HTTP ${response.status}`);
    const registryToken = (await response.json()).token;
    if (!registryToken) throw Error(`Missing registry token for ${name}`);
    const manifest = async digest => {
      const res = await fetch(`https://ghcr.io/v2/${owner}/${name}/manifests/${digest}`, {
        headers: { Authorization: `Bearer ${registryToken}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw Error(`Cannot read retained manifest in ${name}: HTTP ${res.status}`);
      return res.json();
    };
    const plan = await planPackage({ name, owner, versions, references, manifest, cache: entry.cache === true });
    plans.push({ ...plan, endpoint });
    console.log(`${name}: ${plan.total} versions, ${plan.remove.length} eligible for deletion`);
  }
  let deleted = 0;
  for (const plan of plans) {
    for (const v of plan.remove) {
      if (apply && relevant(readInventory().images) !== baseline) throw Error('Deployment images changed during cleanup; retry with a fresh plan');
      // Moving tags between planning and deletion must never remove a protected head.
      if (apply) {
        const current = await api(`${plan.endpoint}/${v.id}`);
        if (JSON.stringify([...current.metadata.container.tags].sort()) !== JSON.stringify([...v.metadata.container.tags].sort())) throw Error(`Package tags changed during cleanup: ${plan.name}`);
      }
      console.log(`${apply ? 'Delete' : 'Would delete'} ${plan.name}@${v.name} (id ${v.id})`);
      if (apply) { await api(`${plan.endpoint}/${v.id}`, 'DELETE'); deleted++; }
    }
  }
  const summary = `${apply ? 'Deleted' : 'Dry run; eligible'}: ${apply ? deleted : plans.reduce((n, p) => n + p.remove.length, 0)} package versions. Retention: 20 tagged images, live deployments, explicit pins, protected tags, manifest dependencies and a 48-hour grace period.\n`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
