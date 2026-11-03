import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isolatedDatabase } from "./helpers/database.ts";
import { createTenant, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { csrf, hash } from "../src/crypto.ts";
import { Licenses } from "../src/licensing.ts";
import { Operations } from "../src/operations.ts";
import { Tenants, tenantAvailable } from "../src/tenants.ts";
import { up, down } from "../src/migrations/015_workspace_archive.ts";

process.env.NODE_ENV = "test";
async function fixture(t: test.TestContext) {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/workspace-lifecycle-",
  );
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "17".repeat(32),
    OPERATOR_TOKEN: "operator".repeat(8),
    DATA_DIR: root,
    LOCAL_BILLING: "true",
  });
  const database = await isolatedDatabase(config.databaseUrl);
  const db = database.db;
  await migrate(db);
  const tenant = await createTenant(db, {
    id: randomUUID(),
    slug: "publisher",
    name: "Publisher",
  });
  await db("seller_users").insert({
    id: "owner",
    email: "owner@example.test",
    verified_at: 1,
    created_at: 1,
  });
  await db("seller_sessions").insert({
    id: hash("session"),
    user_id: "owner",
    expires_at: Date.now() + 86400000,
  });
  await db("seller_memberships").insert({
    tenant_id: tenant.id,
    user_id: "owner",
    role: "owner",
    created_at: 1,
  });
  const app = await buildApp(
    config,
    db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore() },
  );
  await app.ready();
  t.after(async () => {
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  const headers = {
    origin: config.origin,
    cookie: "de-seller-session=session",
    "x-csrf-token": csrf("session", config.secret),
  };
  const path = `/api/v1/platform/tenants/${tenant.id}`;
  const post = (
    action: string,
    payload: object = {},
    extra: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url: `${path}/${action}`,
      headers: { ...headers, ...extra },
      payload,
    });
  const proof = async (
    purpose = "workspace_remove",
    session = "session",
    expires = Date.now() + 60000,
  ) => {
    const token = randomUUID();
    await db("account_challenges").insert({
      id: randomUUID(),
      user_id: "owner",
      session_hash: hash(session),
      purpose: `grant:${purpose}`,
      token_hash: hash(token),
      expires_at: expires,
      created_at: Date.now(),
    });
    return { "x-account-verification": token };
  };
  return { db, app, tenant, headers, path, post, proof, config };
}

test("owners can archive and restore without changing entitlements, billing or membership", async (t) => {
  const { db, app, tenant, headers, post } = await fixture(t);
  await db("products").insert({
    tenant_id: tenant.id,
    id: "product",
    slug: "plugin",
    name: "Plugin",
  });
  const archived = await post("archive");
  assert.equal(archived.statusCode, 200, archived.body);
  assert.ok(archived.json().tenant.archived_at > 0);
  const snapshot = archived.json().tenant;
  assert.equal(snapshot.suspended, 0);
  assert.equal(snapshot.billing_status, tenant.billing_status);
  assert.equal(tenantAvailable(snapshot, "buyer"), true);
  assert.equal(tenantAvailable(snapshot, "recovery"), true);
  assert.equal(tenantAvailable(snapshot, "reconcile"), true);
  assert.equal(
    (await db("products").where({ tenant_id: tenant.id })).length,
    1,
  );
  assert.equal(
    (await db("seller_memberships").where({ tenant_id: tenant.id })).length,
    1,
  );
  assert.equal(
    (await post("archive")).json().tenant.archived_at,
    snapshot.archived_at,
  );
  const me = await app.inject({ url: "/api/v1/platform/me", headers });
  assert.equal(me.json().tenants[0].archived_at, snapshot.archived_at);
  assert.equal(
    (
      await app.inject({
        url: `/api/v1/tenants/${tenant.slug}/seller/overview`,
        headers,
      })
    ).statusCode,
    200,
  );
  assert.equal((await post("restore")).json().tenant.archived_at, null);
  assert.equal((await post("restore")).json().tenant.archived_at, null);
  assert.equal(
    (
      await db("audit_events").where({
        tenant_id: tenant.id,
        action: "tenant.archived",
      })
    ).length,
    1,
  );
});

test("empty workspace removal requires typed address and a fresh, purpose-bound single-use proof", async (t) => {
  const { db, app, tenant, path, headers, post, proof } = await fixture(t);
  await db("audit_events").insert({
    id: randomUUID(),
    tenant_id: tenant.id,
    actor_type: "seller",
    actor_id: "owner",
    action: "tenant.created",
    details: "{}",
    created_at: 1,
  });
  await new Operations(db, tenant.id).configure({});
  await db("tenant_api_keys").insert({
    id: "unused",
    tenant_id: tenant.id,
    name: "Unused",
    key_hash: hash("unused"),
    created_at: 1,
  });
  await new Operations(db, tenant.id).alerts();
  assert.equal(
    (await db("operation_alerts").where({ tenant_id: tenant.id })).length,
    5,
  );
  assert.deepEqual(
    (await app.inject({ url: `${path}/removal`, headers })).json(),
    { removable: true, blockers: [] },
  );
  assert.equal((await post("remove", { slug: tenant.slug })).statusCode, 403);
  for (const verification of [
    await proof("api_keys"),
    await proof("workspace_remove", "session", 1),
  ])
    assert.equal(
      (await post("remove", { slug: tenant.slug }, verification)).statusCode,
      403,
    );
  const wrong = await proof();
  assert.equal(
    (await post("remove", { slug: "wrong" }, wrong)).statusCode,
    400,
  );
  assert.equal(
    (await post("remove", { slug: tenant.slug }, wrong)).statusCode,
    403,
  );
  assert.equal((await post("archive")).statusCode, 200);
  const removed = await post("remove", { slug: tenant.slug }, await proof());
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(await db("tenants").where({ id: tenant.id }).first(), undefined);
  assert.equal(
    (await db("tenant_api_keys").where({ tenant_id: tenant.id })).length,
    0,
  );
  assert.equal(
    (await db("seller_memberships").where({ tenant_id: tenant.id })).length,
    0,
  );
  assert.equal(
    (await db("locks").where("id", "like", `${tenant.id}:%`)).length,
    0,
  );
  assert.equal((await db("seller_users")).length, 1);
  const audit = await db("audit_events")
    .where({ action: "tenant.removed" })
    .first();
  assert.equal(audit.tenant_id, null);
  assert.deepEqual(JSON.parse(audit.details), {
    workspace_id: tenant.id,
    slug: tenant.slug,
  });
  assert.equal(
    (await app.inject({ url: "/api/v1/platform/me", headers })).json().tenants
      .length,
    0,
  );
  assert.equal(
    (
      await app.inject({
        url: `/api/v1/tenants/${tenant.slug}/seller/overview`,
        headers,
      })
    ).statusCode,
    404,
  );
});

test("history, payment linkage, used keys and exports block removal even after archive", async (t) => {
  const { db, app, tenant, path, headers, post, proof } = await fixture(t);
  const status = async () =>
    (await app.inject({ url: `${path}/removal`, headers })).json();
  await db("operation_alerts").insert({
    tenant_id: tenant.id,
    id: "queue_failed",
    active: 1,
    last_sent_at: 0,
  });
  assert.match((await status()).blockers.join(), /Operational alert history/);
  await db("operation_alerts")
    .where({ tenant_id: tenant.id })
    .update({ active: 0, last_sent_at: 1 });
  assert.equal((await status()).removable, false);
  await db("operation_alerts").where({ tenant_id: tenant.id }).delete();
  await db("operation_alerts").insert({
    tenant_id: tenant.id,
    id: "forward_queue_failed",
    active: 0,
    last_sent_at: 0,
  });
  assert.equal((await status()).removable, false);
  await db("operation_alerts").where({ tenant_id: tenant.id }).delete();
  for (const [column, value] of Object.entries({
    stripe_account_id: "acct",
    platform_customer_id: "cus",
    platform_subscription_id: "sub",
    paid_through: 10,
    pro_paid_through: 10,
  })) {
    await db("tenants")
      .where({ id: tenant.id })
      .update({ [column]: value });
    assert.equal((await status()).removable, false, column);
    await db("tenants")
      .where({ id: tenant.id })
      .update({ [column]: typeof value === "number" ? 0 : null });
  }
  await db("tenant_api_keys").insert({
    id: "used",
    tenant_id: tenant.id,
    name: "Used",
    key_hash: hash("used"),
    created_at: 1,
    last_used_at: 1,
  });
  assert.match((await status()).blockers.join(), /API key usage/);
  await db("tenant_api_keys").delete();
  await db("audit_events").insert({
    id: "export",
    tenant_id: tenant.id,
    actor_type: "seller",
    actor_id: "owner",
    action: "tenant.export.created",
    details: "{}",
    created_at: 1,
  });
  assert.match((await status()).blockers.join(), /exports/);
  await db("audit_events").where({ id: "export" }).delete();
  await db("products").insert({
    tenant_id: tenant.id,
    id: "product",
    slug: "plugin",
    name: "Plugin",
  });
  assert.match((await status()).blockers.join(), /products/);
  await post("archive");
  assert.equal(
    (await post("remove", { slug: tenant.slug }, await proof())).statusCode,
    409,
  );
  assert.ok(await db("products").where({ tenant_id: tenant.id }).first());
});

test("a real empty-workspace export leaves retained history that prevents removal", async (t) => {
  const { db, app, tenant, headers, path, proof } = await fixture(t);
  await db("tenants")
    .where({ id: tenant.id })
    .update({ stripe_account_id: "acct_export", stripe_status: "connected" });
  const exported = await app.inject({
    method: "POST",
    url: `/api/v1/tenants/${tenant.slug}/seller/exports`,
    headers: { ...headers, ...(await proof("tenant_transfer")) },
    payload: { passphrase: "a private export passphrase" },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  await db("tenants")
    .where({ id: tenant.id })
    .update({ stripe_account_id: null, stripe_status: "disconnected" });
  const eligibility = await app.inject({ url: `${path}/removal`, headers });
  assert.equal(eligibility.json().removable, false);
  assert.match(eligibility.json().blockers.join(), /exports/);
});

test("parent archive hides its sandbox while independent sandbox archive survives parent restore", async (t) => {
  const { db, app, tenant, headers, post, config } = await fixture(t);
  const child = await createTenant(db, {
    id: randomUUID(),
    slug: "sandbox",
    name: "Sandbox",
  });
  await db("publisher_sandboxes").insert({
    parent_tenant_id: tenant.id,
    sandbox_tenant_id: child.id,
    mode: "fixture",
    created_at: 1,
  });
  await db("seller_memberships").insert({
    tenant_id: child.id,
    user_id: "owner",
    role: "owner",
    created_at: 1,
  });
  const service = new Tenants(db, config);
  const { PlatformAuth } = await import("../src/platform-auth.ts");
  const seller = await new PlatformAuth(db, config).seller(
    { headers, cookies: { "de-seller-session": "session" } } as never,
    false,
  );
  assert.deepEqual((await service.removal(seller, tenant.id)).blockers, [
    "Linked sandbox workspace",
  ]);
  await post("archive");
  let listed = (
    await app.inject({ url: "/api/v1/platform/me", headers })
  ).json().tenants;
  assert.ok(
    listed.find((v: { id: string }) => v.id === child.id).parent_archived_at >
      0,
  );
  await service.archive(seller, child.id, true);
  await post("restore");
  listed = (await app.inject({ url: "/api/v1/platform/me", headers })).json()
    .tenants;
  const sandbox = listed.find((v: { id: string }) => v.id === child.id);
  assert.equal(sandbox.parent_archived_at, null);
  assert.equal(sandbox.sandbox_parent_slug, tenant.slug);
  assert.ok(sandbox.archived_at > 0);
  await service.remove(seller, child.id, child.slug);
  assert.equal((await db("publisher_sandboxes")).length, 0);
  assert.equal((await service.removal(seller, tenant.id)).removable, true);
  await db("seller_memberships").insert({
    tenant_id: "primary",
    user_id: "owner",
    role: "owner",
    created_at: 1,
  });
  await assert.rejects(service.archive(seller, "primary", true), {
    code: "primary_workspace",
  });
  await assert.rejects(
    new Tenants(db, { ...config, deploymentMode: "standalone" }).archive(
      seller,
      child.id,
      true,
    ),
    { code: "not_found" },
  );
  await up(db); // Replay after an interrupted DDL commit preserves existing state.
  await assert.rejects(down(), /Restore a backup/);
});

test("workspace lifecycle requires the owner session and same-origin CSRF", async (t) => {
  const { app, db, tenant, path, headers, post } = await fixture(t);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/platform/tenants/missing/archive",
        headers,
        payload: {},
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: `${path}/archive`, payload: {} }))
      .statusCode,
    401,
  );
  assert.equal(
    (await post("archive", {}, { "x-csrf-token": "wrong" })).statusCode,
    403,
  );
  assert.equal(
    (await post("archive", {}, { origin: "https://foreign.example" }))
      .statusCode,
    403,
  );
  await db("seller_memberships").where({ tenant_id: tenant.id }).delete();
  assert.equal((await post("archive")).statusCode, 403);
  assert.equal(
    (await app.inject({ url: `${path}/removal`, headers })).statusCode,
    403,
  );
});

test("an archived workspace continues serving existing activation and update access", async (t) => {
  const { db, app, tenant, post, config } = await fixture(t);
  await db("products").insert({
    tenant_id: tenant.id,
    id: "product",
    slug: "plugin",
    name: "Plugin",
  });
  await db("customers").insert({
    tenant_id: tenant.id,
    id: "buyer",
    email: "buyer@example.test",
  });
  await db("licenses").insert({
    tenant_id: tenant.id,
    id: "license",
    customer_id: "buyer",
    product_id: "product",
    plan_id: null,
    subscription_id: null,
    key_hash: hash("DE-test-key"),
    site_allowance: 2,
    paid_through: 0,
    provenance: "complimentary",
    expires_at: Date.now() + 86400000,
    billing_status: "complimentary",
  });
  const licensing = new Licenses(db, config.secret, [], tenant);
  const activated = await licensing.activate(
    "DE-test-key",
    "first-installation",
    "https://buyer.example",
    "plugin",
  );
  await post("archive");
  const headers = { authorization: `Bearer ${activated.token}` };
  const status = await app.inject({
    url: `/api/v1/tenants/${tenant.slug}/activation`,
    headers,
  });
  assert.equal(status.statusCode, 200, status.body);
  assert.equal(status.json().entitled, true);
  const updates = await app.inject({
    url: `/api/v1/tenants/${tenant.slug}/updates/plugin`,
    headers,
  });
  assert.equal(updates.statusCode, 204, updates.body);
  const activate = await app.inject({
    method: "POST",
    url: `/api/v1/tenants/${tenant.slug}/activate`,
    payload: {
      key: "DE-test-key",
      installationId: "second-installation",
      siteUrl: "https://second.example",
      product: "plugin",
    },
  });
  assert.equal(activate.statusCode, 200, activate.body);
});

test("removal cannot race a business record being committed by another transaction", async (t) => {
  const { db, tenant, config, headers } = await fixture(t);
  const { PlatformAuth } = await import("../src/platform-auth.ts");
  const seller = await new PlatformAuth(db, config).seller(
    { headers, cookies: { "de-seller-session": "session" } } as never,
    false,
  );
  const writing = await db.transaction();
  try {
    await writing("products").insert({
      tenant_id: tenant.id,
      id: "racing-product",
      slug: "racing",
      name: "Racing product",
    });
    const removing = new Tenants(db, config)
      .remove(seller, tenant.id, tenant.slug)
      .then(
        () => "removed",
        (error: { code: string }) => error.code,
      );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await writing.commit();
    assert.equal(await removing, "workspace_has_history");
    assert.ok(
      await db("products")
        .where({ tenant_id: tenant.id, id: "racing-product" })
        .first(),
    );
    assert.ok(await db("tenants").where({ id: tenant.id }).first());
  } finally {
    if (!writing.isCompleted()) await writing.rollback();
  }
});
