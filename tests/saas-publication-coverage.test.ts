import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { writeFileSync, unlinkSync } from "node:fs";
import {
  createDb,
  createTenant,
  migrate,
  reset,
  type Tenant,
} from "../src/db.ts";
import { Releases, type Publication } from "../src/releases.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { AppError } from "../src/errors.ts";
import { zipBytes } from "./helpers/zip.ts";
const directory = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/saas-publication-",
);
const db = createDb(`sqlite:${directory}/db`);
class Store extends InMemoryArtifactStore {
  writes: string[] = [];
  removals: string[] = [];
  override async put(
    tenantId: string,
    id: string,
    bytes: Buffer,
    checksum: string,
  ) {
    await super.put(tenantId, id, bytes, checksum);
    this.writes.push(`${tenantId}/${id}`);
  }
  override async delete(tenantId: string, id: string) {
    this.removals.push(`${tenantId}/${id}`);
    await super.delete(tenantId, id);
    this.writes = this.writes.filter((key) => key !== `${tenantId}/${id}`);
  }
}
let store: Store,
  tenant: Tenant,
  releases: Releases,
  publication: Publication,
  bytes: Buffer;
const work = `${directory}/work`;
before(async () => {
  await migrate(db);
});
beforeEach(async () => {
  await reset(db);
  await rm(work, { recursive: true, force: true });
  store = new Store();
  tenant = await createTenant(db, {
    id: randomUUID(),
    slug: "alpha",
    name: "Alpha",
  });
  await db("products").insert({
    tenant_id: tenant.id,
    id: "product",
    slug: "product",
    name: "Product",
    plugin_basename: "product/main.php",
  });
  bytes = zipBytes([
    {
      name: "product/main.php",
      data: "<?php /* Plugin Name: Product\nVersion: 1.0.0\n*/",
    },
  ]);
  const file = `${directory}/input.zip`;
  await writeFile(file, bytes);
  publication = {
    product: "product",
    version: "1.0.0",
    file,
    changelog: "Original release",
    minWp: "6.0",
    minPhp: "8.0",
    minFree: "0.0.0",
    tested: "7.0",
  };
  releases = new Releases(db, store, tenant, work);
});
after(async () => {
  await db.destroy();
  await rm(directory, { recursive: true, force: true });
});
async function clean() {
  assert.equal(
    (await db("releases").where({ tenant_id: tenant.id })).length,
    0,
  );
  assert.equal(
    (await db("upload_reservations").where({ tenant_id: tenant.id })).length,
    0,
  );
  assert.equal(store.writes.length, 0);
  assert.deepEqual(await readdir(work).catch(() => []), []);
}
test("publication captures caller metadata before asynchronous object storage can mutate it", async (t) => {
  const original = store.put.bind(store);
  t.mock.method(store, "put", async (...args: Parameters<Store["put"]>) => {
    publication.version = "2.0.0";
    publication.changelog = "Changed outside publication";
    publication.minPhp = "0.1";
    await original(...args);
  });
  const release = await releases.publish(publication);
  assert.equal(release.version, "1.0.0");
  assert.equal(release.changelog, "Original release");
  assert.equal(release.min_php, "8.0");
  assert.deepEqual(await releases.read(release), bytes);
});
test("publication keeps tenant context fixed if the caller later changes its context object", async (t) => {
  const other = await createTenant(db, {
    id: randomUUID(),
    slug: "beta",
    name: "Beta",
  });
  const original = store.put.bind(store);
  const expected = tenant.id;
  t.mock.method(store, "put", async (...args: Parameters<Store["put"]>) => {
    tenant.id = other.id;
    await original(...args);
  });
  const release = await releases.publish(publication);
  assert.equal(release.tenant_id, expected);
  assert.deepEqual(await releases.read(release), bytes);
  assert.equal((await db("upload_reservations")).length, 0);
});

test(
  "a reserved in-flight upload blocks oversubscription while another tenant publishes independently",
  { timeout: 5000 },
  async (t) => {
    await db("tenants")
      .where({ id: tenant.id })
      .update({ max_storage_bytes: bytes.length });
    const entered = Promise.withResolvers<void>(),
      proceed = Promise.withResolvers<void>();
    const original = store.put.bind(store);
    t.mock.method(store, "put", async (...args: Parameters<Store["put"]>) => {
      if (args[0] === tenant.id) {
        entered.resolve();
        await proceed.promise;
      }
      await original(...args);
    });
    const pending = releases.publish(publication);
    await entered.promise;
    try {
      const reserved = await db("upload_reservations")
        .where({ tenant_id: tenant.id })
        .first();
      assert.equal(reserved.bytes, bytes.length);
      await assert.rejects(releases.publish(publication), {
        code: "storage_limit",
      });
      const other = await createTenant(db, {
        id: randomUUID(),
        slug: "beta",
        name: "Beta",
      });
      await db("products").insert({
        tenant_id: other.id,
        id: "other-product",
        slug: "product",
        name: "Product",
        plugin_basename: "product/main.php",
      });
      const independent = new Releases(db, store, other, work);
      assert.deepEqual(
        await independent.read(await independent.publish(publication)),
        bytes,
      );
    } finally {
      proceed.resolve();
    }
    const release = await pending;
    assert.deepEqual(await releases.read(release), bytes);
    assert.equal((await db("upload_reservations")).length, 0);
  },
);

test("source disappearance after reservation releases capacity before any provider put", async () => {
  const removeInput = (_response: unknown, query: { sql: string }) => {
    if (query.sql.startsWith("insert into `upload_reservations`"))
      unlinkSync(publication.file);
  };
  db.on("query-response", removeInput);
  try {
    await assert.rejects(releases.publish(publication), { code: "ENOENT" });
  } finally {
    db.off("query-response", removeInput);
  }
  assert.equal(store.removals.length, 0);
  await clean();
});

test("a staging directory failure releases its reservation without a snapshot or provider object", async () => {
  await writeFile(work, "This is a regular task-owned file");
  await assert.rejects(releases.publish(publication), { code: "EEXIST" });
  assert.equal(store.removals.length, 0);
  await clean();
});

test("put failures with and without provider error codes remove attempted objects and reservations", async (t) => {
  for (const error of [
    new Error("Provider transport failed"),
    new AppError(503, "storage_unavailable", "Provider unavailable"),
  ]) {
    await t.test(error.message, async (t) => {
      t.mock.method(store, "put", async () => {
        throw error;
      });
      await assert.rejects(
        releases.publish(publication),
        (candidate) => candidate === error,
      );
      assert.equal(store.removals.length, 1);
      await clean();
    });
  }
});

test("an ambiguous put and failed object cleanup retain capacity until expiry cleanup succeeds", async (t) => {
  const put = store.put.bind(store),
    remove = store.delete.bind(store);
  t.mock.method(store, "put", async (...args: Parameters<Store["put"]>) => {
    await put(...args);
    throw Error("Response lost after object commit");
  });
  const deletion = t.mock.method(store, "delete", async () => {
    throw Error("Deletion unavailable");
  });
  await assert.rejects(
    releases.publish(publication),
    /Response lost after object commit/,
  );
  assert.equal((await db("releases")).length, 0);
  assert.equal(store.writes.length, 1);
  const reservation = await db("upload_reservations")
    .where({ tenant_id: tenant.id })
    .first();
  assert.equal(reservation.bytes, bytes.length);
  await db("upload_reservations")
    .where({ tenant_id: tenant.id, id: reservation.id })
    .update({ expires_at: 0 });
  await assert.rejects(releases.cleanup(), /Deletion unavailable/);
  assert.equal((await db("upload_reservations")).length, 1);
  deletion.mock.restore();
  t.mock.method(store, "delete", remove);
  await releases.cleanup();
  await clean();
});

test("conditional put conflicts never delete pre-existing immutable objects", async (t) => {
  const previous = Buffer.from("pre-existing immutable artifact");
  const checksum = createHash("sha256").update(previous).digest("hex");
  let existingId = "";
  const put = store.put.bind(store);
  t.mock.method(
    store,
    "put",
    async (tenantId: string, id: string, candidate: Buffer, digest: string) => {
      existingId = id;
      await put(tenantId, id, previous, checksum);
      await put(tenantId, id, candidate, digest);
    },
  );
  await assert.rejects(releases.publish(publication), {
    code: "artifact_exists",
  });
  assert.equal(store.removals.length, 0);
  assert.equal((await db("upload_reservations")).length, 0);
  assert.equal((await db("releases")).length, 0);
  assert.deepEqual(
    await store.get(tenant.id, existingId, checksum, previous.length),
    previous,
  );
});

test("post-put integrity failures remove new objects without publishing metadata", async (t) => {
  t.mock.method(store, "get", async () => {
    throw new AppError(
      503,
      "artifact_integrity",
      "Checksum verification failed",
    );
  });
  await assert.rejects(releases.publish(publication), {
    code: "artifact_integrity",
  });
  assert.equal(store.removals.length, 1);
  await clean();
});

test("capacity reductions during provider HTTP reject final commit and release uploaded bytes", async (t) => {
  const get = store.get.bind(store);
  t.mock.method(store, "get", async (...args: Parameters<Store["get"]>) => {
    await db("tenants")
      .where({ id: tenant.id })
      .update({ max_storage_bytes: bytes.length - 1 });
    return get(...args);
  });
  await assert.rejects(releases.publish(publication), {
    code: "storage_limit",
  });
  assert.equal(store.removals.length, 1);
  await clean();
});

for (const state of ["suspended", "expired"] as const) {
  for (const sandbox of [false, true]) {
    test(`WordPress publication rechecks ${sandbox ? "sandbox parent" : "tenant"} ${state} after storage readback`, async (t) => {
      let authority = tenant;
      if (sandbox) {
        authority = await createTenant(db, {
          id: randomUUID(),
          slug: "parent",
          name: "Parent",
        });
        await db("tenants").where({ id: tenant.id }).update({ exempt: 1 });
        await db("publisher_sandboxes").insert({
          parent_tenant_id: authority.id,
          sandbox_tenant_id: tenant.id,
          mode: "fixture",
          created_at: Date.now(),
        });
      }
      const get = store.get.bind(store);
      t.mock.method(store, "get", async (...args: Parameters<Store["get"]>) => {
        const value = await get(...args);
        await db("tenants")
          .where({ id: authority.id })
          .update(
            state === "suspended"
              ? { suspended: 1 }
              : { exempt: 0, trial_ends_at: 0, paid_through: 0 },
          );
        return value;
      });
      await assert.rejects(releases.publish(publication), {
        status: 403,
        code: state === "suspended" ? "tenant_suspended" : "tenant_capacity",
      });
      assert.equal(store.removals.length, 1);
      assert.equal(
        (await db("business_events").where({ tenant_id: tenant.id })).length,
        0,
      );
      await clean();
    });
  }
}

for (const policy of [
  { deploymentMode: "standalone", graceDays: 0, allowed: true },
  { deploymentMode: "hosted", graceDays: 2, allowed: true },
  { deploymentMode: "hosted", graceDays: 0, allowed: false },
] as const) {
  test(`WordPress publication respects ${policy.deploymentMode} mode and ${policy.graceDays} grace days`, async () => {
    await db("tenants")
      .where({ id: tenant.id })
      .update({
        exempt: 0,
        trial_ends_at: 0,
        paid_through: Date.now() - 86400000,
      });
    const service = new Releases(db, store, tenant, work, undefined, policy);
    if (policy.allowed) {
      const release = await service.publish(publication);
      assert.deepEqual(await service.read(release), bytes);
    } else {
      await assert.rejects(service.publish(publication), {
        status: 403,
        code: "tenant_capacity",
      });
      await clean();
    }
  });
}

test("source growth after stat is charged by actual validated bytes and cannot bypass storage quota", async () => {
  const expanded = zipBytes([
    {
      name: "product/main.php",
      data: "<?php /* Plugin Name: Product\nVersion: 1.0.0\n*/",
    },
    { name: "product/asset.txt", data: "Additional bounded source bytes" },
  ]);
  await db("tenants")
    .where({ id: tenant.id })
    .update({ max_storage_bytes: bytes.length });
  const growInput = (_response: unknown, query: { sql: string }) => {
    if (query.sql.startsWith("insert into `upload_reservations`"))
      writeFileSync(publication.file, expanded);
  };
  db.on("query-response", growInput);
  try {
    await assert.rejects(releases.publish(publication), {
      code: "storage_limit",
    });
  } finally {
    db.off("query-response", growInput);
  }
  assert.equal(store.removals.length, 1);
  await clean();
  await db("tenants")
    .where({ id: tenant.id })
    .update({ max_storage_bytes: expanded.length });
  const release = await releases.publish(publication);
  assert.equal(release.size, expanded.length);
  assert.deepEqual(await releases.read(release), expanded);
});

test("expired reservation cleanup preserves published bytes, stays tenant scoped and leaves live reservations", async () => {
  const published = await releases.publish(publication);
  const orphan = randomUUID(),
    live = randomUUID();
  await store.put(tenant.id, orphan, bytes, published.checksum);
  const other = await createTenant(db, {
    id: randomUUID(),
    slug: "beta",
    name: "Beta",
  });
  const foreign = randomUUID();
  await store.put(other.id, foreign, bytes, published.checksum);
  await db("upload_reservations").insert([
    {
      tenant_id: tenant.id,
      id: published.id,
      bytes: bytes.length,
      expires_at: 0,
    },
    { tenant_id: tenant.id, id: orphan, bytes: bytes.length, expires_at: 0 },
    {
      tenant_id: tenant.id,
      id: live,
      bytes: bytes.length,
      expires_at: Date.now() + 60000,
    },
    { tenant_id: other.id, id: foreign, bytes: bytes.length, expires_at: 0 },
  ]);
  await releases.cleanup();
  assert.deepEqual(await releases.read(published), bytes);
  assert.deepEqual(
    await db("upload_reservations").orderBy("id").pluck("id"),
    [live, foreign].sort(),
  );
  assert.deepEqual(store.removals, [`${tenant.id}/${orphan}`]);
  assert.deepEqual(
    await store.get(other.id, foreign, published.checksum, bytes.length),
    bytes,
  );
});

test("cleanup bounds one pass to twenty expired reservations", async () => {
  await db("upload_reservations").insert(
    Array.from({ length: 21 }, () => ({
      tenant_id: tenant.id,
      id: randomUUID(),
      bytes: 1,
      expires_at: 0,
    })),
  );
  await releases.cleanup();
  assert.equal(store.removals.length, 20);
  assert.equal((await db("upload_reservations")).length, 1);
  await releases.cleanup();
  assert.equal(store.removals.length, 21);
  await clean();
});

test("invalid version and compatibility metadata fail before object upload or capacity reservation", async () => {
  await assert.rejects(
    releases.publish({ ...publication, version: "v1.0.0" }),
    { code: "invalid_version" },
  );
  for (const key of ["minWp", "minPhp", "minFree", "tested"] as const)
    await assert.rejects(releases.publish({ ...publication, [key]: "7.x" }), {
      code: "invalid_compatibility",
    });
  await clean();
  assert.deepEqual(await readFile(publication.file), bytes);
});
