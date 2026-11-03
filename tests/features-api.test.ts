import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate, createTenant, type Tenant } from "../src/db.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { hash, csrf, unseal } from "../src/crypto.ts";
import { zipBytes } from "./helpers/zip.ts";
import { buildApp } from "../src/app.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Tenants } from "../src/tenants.ts";
import { PublisherSandboxes } from "../src/sandboxes.ts";
import { Operations } from "../src/operations.ts";
import { isolatedDatabase } from "./helpers/database.ts";

process.env.NODE_ENV = "test";
async function fixture(t: TestContext, override: Partial<Config> = {}) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/features-api-");
  const config = {
    ...loadConfig({
      APP_SECRET: "12".repeat(32),
      OPERATOR_TOKEN: "x".repeat(32),
      DEPLOYMENT_MODE: "hosted",
    APP_BASE_PATH: "",
      DATA_DIR: root,
      LOCAL_BILLING: "true",
    }),
    ...override,
  };
  const database = await isolatedDatabase(config.databaseUrl),
    db = database.db;
  await migrate(db);
  const user = {
    id: randomUUID(),
    email: "owner@example.test",
    verified_at: Date.now(),
    created_at: Date.now(),
  };
  const token = "s".repeat(43),
    sessionHash = hash(token);
  await db("seller_users").insert(user);
  await db("seller_sessions").insert({
    id: sessionHash,
    user_id: user.id,
    expires_at: Date.now() + 86400000,
  });
  await db("seller_memberships").insert({
    tenant_id: "primary",
    user_id: user.id,
    role: "owner",
    created_at: Date.now(),
  });
  const tenant = (await db<Tenant>("tenants")
    .where({ id: "primary" })
    .first())!;
  const headers = {
    cookie: `de-seller-session=${token}`,
    origin: config.origin,
    "x-csrf-token": csrf(token, config.secret),
  };
  const seller = { user, sessionHash, csrfToken: headers["x-csrf-token"] };
  const app = await buildApp(
    config,
    db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore() },
  );
  t.after(async () => {
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = "/api/v1/tenants/primary/seller";
  return {
    app,
    db,
    config,
    tenant,
    seller,
    headers,
    base,
    request: (
      method: "GET" | "POST" | "PUT" | "DELETE",
      path: string,
      payload?: object,
      h: Record<string, string> = headers,
    ) =>
      app.inject({
        method,
        url: base + path,
        headers: h,
        ...(payload ? { payload } : {}),
      }),
  };
}

test("a publisher test environment does not consume the live-workspace allowance", async (t) => {
  const f = await fixture(t, { maxTenantsPerSeller: 2 });
  await new PublisherSandboxes(f.db, f.config).create(
    f.tenant,
    f.seller,
    "fixture",
  );
  const other = await new Tenants(f.db, f.config).create(f.seller, {
    slug: "second-live",
    name: "Second live workspace",
  });
  assert.equal(other.slug, "second-live");
  await assert.rejects(
    new Tenants(f.db, f.config).create(f.seller, {
      slug: "third-live",
      name: "Third live",
    }),
    /limit|maximum|workspace/i,
  );
});

test("reading operations cannot consume an operational alert before the worker publishes it", async (t) => {
  const f = await fixture(t);
  const operations = new Operations(f.db, "primary");
  await operations.configure({ bandwidthBytes: 1 });
  const productId = randomUUID(),
    releaseId = randomUUID();
  await f.db("products").insert({
    tenant_id: "primary",
    id: productId,
    slug: "bytes",
    name: "Bytes",
  });
  await f.db("releases").insert({
    tenant_id: "primary",
    id: releaseId,
    product_id: productId,
    version: "1.0.0",
    changelog: "",
    published_at: Date.now(),
    checksum: "a".repeat(64),
    size: 1,
    min_wp: "6.0",
    min_php: "8.0",
    min_free: "1.0",
    tested: "6.0",
  });
  await f.db("download_metrics").insert({
    tenant_id: "primary",
    release_id: releaseId,
    day: new Date().toISOString().slice(0, 10),
    served_bytes: 2,
  });
  const response = await f.request("GET", "/operations");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(
    (await f.db("operation_alerts").where({ tenant_id: "primary" })).length,
    0,
    "GET must not claim alert delivery",
  );
  assert.ok((await operations.alerts()).some((a) => a.kind === "bandwidth"));
});

test("hosted Pro APIs use fresh paid grants, keep basic operations core, and isolate API scopes", async (t) => {
  const f = await fixture(t, { platformProStripePriceId: "price_monthly" });
  const activity = await f.request("GET", "/operations/activity?days=7");
  assert.equal(activity.statusCode, 200, activity.body);
  assert.equal(activity.json().daily.length, 7);
  assert.equal((await f.request("GET", "/operations/activity?days=366")).statusCode, 400);
  assert.equal((await f.request("GET", "/operations/activity", undefined, {})).statusCode, 401);
  assert.equal(
    (await f.request("GET", "/features")).json().features.outboundWebhooks,
    false,
  );
  assert.equal(
    (await f.request("GET", "/features")).json().hostedProConfigured,
    true,
  );
  for (const path of ["/operations/reports", "/webhooks"])
    assert.equal((await f.request("GET", path)).statusCode, 403);
  assert.equal(
    (
      await f.request("PUT", "/operations/settings", {
        warningDays: 3,
        notificationsEnabled: false,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.request("PUT", "/operations/settings", { warningDays: 0 }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.request(
        "PUT",
        "/operations/settings",
        {},
        { cookie: f.headers.cookie },
      )
    ).statusCode,
    403,
  );
  const other = await createTenant(f.db, {
    id: randomUUID(),
    slug: "other-features",
    name: "Other",
  });
  assert.equal(
    (
      await f.app.inject({
        url: `/api/v1/tenants/${other.slug}/seller/features`,
        headers: f.headers,
      })
    ).statusCode,
    403,
  );
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({
      pro_period_start: Date.now() - 1000,
      pro_paid_through: Date.now() + 100000,
    });
  const features = await f.request("GET", "/features");
  assert.equal(features.json().features.outboundWebhooks, true);
  const reports = await f.request("GET", "/operations/reports?days=7");
  assert.equal(reports.statusCode, 200, reports.body);
  assert.equal(reports.json().days, 7);
  assert.deepEqual(reports.json().rows, []);
  assert.ok(Number.isSafeInteger(reports.json().generatedAt));
  assert.equal((await f.request("GET", "/operations/reports")).json().days, 30);
  assert.equal(
    (await f.request("GET", "/operations/reports?days=366")).statusCode,
    400,
  );
  const key = `DE-TK-${"O".repeat(43)}`;
  await f.db("tenant_api_keys").insert({
    tenant_id: "primary",
    id: randomUUID(),
    name: "Read only",
    key_hash: hash(key),
    display_prefix: key.slice(0, 14),
    scopes: JSON.stringify(["read"]),
    expires_at: Date.now() + 100000,
    created_at: Date.now(),
  });
  const headers = { authorization: `Bearer ${key}` };
  assert.equal(
    (await f.request("GET", "/operations", undefined, headers)).statusCode,
    200,
  );
  assert.equal(
    (
      await f.request(
        "PUT",
        "/operations/settings",
        { warningDays: 2 },
        headers,
      )
    ).statusCode,
    403,
  );
  await f
    .db("tenant_api_keys")
    .where({ key_hash: hash(key) })
    .update({ scopes: JSON.stringify(["operations:write"]) });
  assert.equal(
    (
      await f.request(
        "PUT",
        "/operations/settings",
        { warningDays: 2 },
        headers,
      )
    ).statusCode,
    200,
  );
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_paid_through: Date.now() - 1, exempt: 1 });
  assert.equal(
    (await f.request("GET", "/features")).json().features.outboundWebhooks,
    false,
  );
});

test("webhook endpoints expose secrets only on create and rotate, enforce ownership and recover failed deliveries", async (t) => {
  const f = await fixture(t);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_paid_through: Date.now() + 100000 });
  const created = await f.request("POST", "/webhooks", {
    url: "https://8.8.8.8/events",
    events: ["license.created"],
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.ok(created.json().secret);
  const endpointId = created.json().id;
  const listed = await f.request("GET", "/webhooks");
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().endpoints[0].secret, undefined);
  assert.equal(
    (
      await f.request("POST", "/webhooks", {
        url: "http://127.0.0.1",
        events: ["license.created"],
      })
    ).statusCode,
    400,
  );
  const { OutboundWebhooks } = await import("../src/outbound-webhooks.ts");
  const hooks = new OutboundWebhooks(f.db, "primary", f.config.secret);
  await hooks.enqueue({
    id: "root-test-event",
    type: "license.created",
    resourceId: "license-opaque",
    occurredAt: Date.now(),
  });
  const delivery = (await f
    .db("outbound_deliveries")
    .where({ tenant_id: "primary" })
    .first())!;
  await f
    .db("outbound_deliveries")
    .where({ id: delivery.id })
    .update({ state: "failed" });
  assert.equal(
    (await f.request("POST", `/webhook-deliveries/${delivery.id}/retry`, {}))
      .statusCode,
    200,
    "retry must accept service-created hashed delivery IDs",
  );
  assert.equal(
    (await f.db("outbound_deliveries").where({ id: delivery.id }).first())
      .state,
    "pending",
  );
  const rotated = await f.request("POST", `/webhooks/${endpointId}/rotate`, {});
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.notEqual(rotated.json().secret, created.json().secret);
  assert.equal(
    (await f.request("POST", `/webhooks/${randomUUID()}/rotate`, {}))
      .statusCode,
    404,
  );
  assert.equal(
    (await f.request("DELETE", `/webhooks/${endpointId}`, {})).statusCode,
    200,
  );
  assert.equal(
    (await f.request("DELETE", `/webhooks/${endpointId}`, {})).statusCode,
    404,
  );
  assert.equal(
    (await f.request("POST", `/webhook-deliveries/${"0".repeat(64)}/retry`, {}))
      .statusCode,
    404,
  );
});

test("sandbox HTTP routes reject live fake purchases and isolate paid test records from their parent", async (t) => {
  const f = await fixture(t);
  delete f.config.graceDays;
  assert.deepEqual((await f.request("GET", "/sandbox")).json(), {
    sandbox: null,
    stripeAvailable: false,
  });
  assert.equal(
    (await f.request("POST", "/sandbox/purchase", { planId: "live-plan" }))
      .statusCode,
    404,
  );
  const created = await f.request("POST", "/sandbox", {});
  assert.equal(created.statusCode, 200, created.body);
  const child = created.json().tenant;
  assert.equal(created.json().customerUrl, `/t/${child.slug}`);
  f.config.appBasePath = "/app";
  const hosted = await f.request("POST", "/sandbox", {});
  assert.equal(hosted.json().customerUrl, `/app/t/${child.slug}`);
  assert.equal(hosted.json().apiBase, `/api/v1/tenants/${child.slug}`);
  f.config.appBasePath = "";
  assert.equal((await f.request("POST", "/sandbox", {})).json().created, false);
  const url = `/api/v1/tenants/${child.slug}/seller`;
  const productId = randomUUID(),
    planId = randomUUID();
  await f.db("products").insert({
    tenant_id: child.id,
    id: productId,
    slug: "test-product",
    name: "Test",
  });
  await f.db("plans").insert({
    tenant_id: child.id,
    id: planId,
    product_id: productId,
    name: "One",
    site_allowance: 1,
    stripe_price_id: "price_sandbox",
  });
  const request = (path: string, payload: object) =>
    f.app.inject({
      method: "POST",
      url: url + path,
      payload,
      headers: f.headers,
    });
  assert.equal(
    (await request("/sandbox/purchase", { planId: "not-owned" })).statusCode,
    404,
  );
  const paid = await request("/sandbox/purchase", { planId });
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().email, f.seller.user.email);
  assert.equal(
    (await f.db("licenses").where({ tenant_id: "primary" })).length,
    0,
  );
  assert.equal(
    (await f.db("licenses").where({ tenant_id: child.id })).length,
    1,
  );
  assert.equal(
    (await f.db("emails").where({ tenant_id: child.id, kind: "license_key" }))
      .length,
    1,
  );
  const info = await f.app.inject({
    url: url + "/sandbox",
    headers: f.headers,
  });
  assert.equal(info.json().sandbox.isSandbox, true);
  await f.db("tenants").where({ id: "primary" }).update({
    exempt: 0,
    trial_ends_at: 0,
    paid_through: 0,
    billing_status: "past_due",
  });
  assert.equal(
    (await request("/sandbox/purchase", { planId })).statusCode,
    403,
    "test purchases must follow the live publisher capacity policy",
  );
  assert.equal(
    (
      await request("/products", {
        slug: "blocked",
        name: "Blocked",
        plans: [],
      })
    ).statusCode,
    403,
  );
});

test("customer notices and exports stay within the authenticated customer and report counters use real rows", async (t) => {
  const f = await fixture(t),
    now = Date.now();
  const productId = randomUUID(),
    planId = randomUUID(),
    customerId = randomUUID(),
    otherId = randomUUID(),
    licenseId = randomUUID(),
    releaseId = randomUUID();
  await f.db("products").insert({
    tenant_id: "primary",
    id: productId,
    slug: "notice",
    name: "Notice",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: planId,
    product_id: productId,
    name: "One",
    site_allowance: 1,
    stripe_price_id: "price_notice",
  });
  await f.db("customers").insert([
    { tenant_id: "primary", id: customerId, email: "buyer@example.test" },
    { tenant_id: "primary", id: otherId, email: "other@example.test" },
  ]);
  await f.db("licenses").insert({
    tenant_id: "primary",
    id: licenseId,
    customer_id: customerId,
    product_id: productId,
    plan_id: planId,
    site_allowance: 1,
    paid_through: now + 86400000,
    billing_status: "active",
    subscription_id: "sub_notice",
    key_hash: hash("notice-key"),
  });
  const token = "b".repeat(43),
    otherToken = "c".repeat(43);
  await f.db("sessions").insert([
    {
      tenant_id: "primary",
      id: hash(token),
      customer_id: customerId,
      expires_at: now + 100000,
    },
    {
      tenant_id: "primary",
      id: hash(otherToken),
      customer_id: otherId,
      expires_at: now + 100000,
    },
  ]);
  const headers = {
    cookie: `de-session-primary=${token}`,
    origin: f.config.origin,
    "x-csrf-token": csrf(token, f.config.secret),
  };
  const path = "/api/v1/tenants/primary";
  const operations = new Operations(f.db, "primary");
  await operations.scanNotifications();
  const notices = await f.app.inject({ url: path + "/notifications", headers });
  assert.equal(notices.statusCode, 200, notices.body);
  assert.equal(notices.json().notifications.length, 1);
  const noticeId = notices.json().notifications[0].id;
  const foreign = {
    cookie: `de-session-primary=${otherToken}`,
    origin: f.config.origin,
    "x-csrf-token": csrf(otherToken, f.config.secret),
  };
  const foreignAttempt = await f.app.inject({
    method: "POST",
    url: `${path}/notifications/${noticeId}/dismiss`,
    headers: foreign,
    payload: {},
  });
  assert.equal(foreignAttempt.statusCode, 200, foreignAttempt.body);
  assert.equal(
    (
      await f
        .db("operation_notifications")
        .where({ tenant_id: "primary", id: noticeId })
        .first()
    ).dismissed,
    0,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${path}/notifications/${noticeId}/dismiss`,
        headers,
        payload: {},
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(
    (await f.app.inject({ url: path + "/notifications", headers })).json()
      .notifications,
    [],
  );
  const exported = await f.app.inject({
    url: path + "/account/export",
    headers,
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.ok(exported.body.includes("buyer@example.test"));
  assert.ok(!exported.body.includes("other@example.test"));
  assert.ok(!exported.body.includes("notice-key"));
  const closure = await f.app.inject({
    method: "POST",
    url: path + "/account/closure",
    headers,
    payload: {},
  });
  assert.equal(closure.statusCode, 200, closure.body);
  assert.equal(
    (await f.db("licenses").where({ id: licenseId }).first()).revoked,
    0,
  );
  assert.equal(
    (await f.app.inject({ url: path + "/account/closure", headers }))
      .statusCode,
    200,
  );
  await f.db("releases").insert({
    tenant_id: "primary",
    id: releaseId,
    product_id: productId,
    version: "1.0.0",
    changelog: "",
    published_at: now,
    checksum: "a".repeat(64),
    size: 1,
    min_wp: "6.0",
    min_php: "8.0",
    min_free: "1.0",
    tested: "6.0",
  });
  const day = new Date().toISOString().slice(0, 10);
  await f.db("download_metrics").insert({
    tenant_id: "primary",
    release_id: releaseId,
    day,
    successful_responses: 2,
    served_bytes: 200,
    storage_read_bytes: 100,
    storage_reads: 1,
  });
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_paid_through: now + 100000 });
  assert.deepEqual(
    (await f.request("GET", "/operations/reports")).json().rows,
    [
      {
        day,
        responses: 2,
        servedBytes: 200,
        storageReadBytes: 100,
        storageReads: 1,
      },
    ],
  );
  await f.db("operation_alerts").insert({
    tenant_id: "primary",
    id: "bandwidth",
    active: 1,
    last_sent_at: now,
  });
  assert.deepEqual((await f.request("GET", "/operations")).json().alerts, [
    { id: "bandwidth", kind: "bandwidth", occurredAt: now },
  ]);
});

test("operator webhook host restrictions apply to every destination creation", async (t) => {
  const f = await fixture(t, { outboundWebhookHosts: ["hooks.example.test"] });
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_paid_through: Date.now() + 100000 });
  const response = await f.request("POST", "/webhooks", {
    url: "https://8.8.8.8/events",
    events: ["license.created"],
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().error.code, "webhook_host");
});

test("sandbox webhooks verify the raw signature, reject live/account mismatches, and never touch live purchases", async (t) => {
  const { default: Stripe } = await import("stripe");
  const credentials = {
    stripeTestSecret: "sk_test_fixture",
    stripeTestPublishableKey: "pk_test_fixture",
    stripeTestWebhookSecret: "whsec_sandbox",
  };
  const f = await fixture(t, credentials);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ stripe_account_id: "acct_primary", stripe_status: "connected" });
  const parent = (await f
    .db<Tenant>("tenants")
    .where({ id: "primary" })
    .first())!;
  const { tenant } = await new PublisherSandboxes(f.db, f.config).create(
    parent,
    f.seller,
    "stripe",
  );
  const stripe = new Stripe("sk_test_fixture");
  const send = (extra: object = {}, secret = "whsec_sandbox") => {
    const body = JSON.stringify({
      id: "evt_sandbox_1",
      type: "invoice.paid",
      livemode: false,
      account: "acct_primary",
      data: { object: { id: "in_test" } },
      ...extra,
    });
    return f.app.inject({
      method: "POST",
      url: "/api/v1/stripe/sandbox-webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret,
        }),
      },
    });
  };
  assert.equal((await send({}, "wrong-secret")).statusCode, 400);
  assert.equal(
    (await send({ livemode: true })).json().error.code,
    "stripe_mode",
  );
  assert.equal(
    (await send({ account: undefined })).json().error.code,
    "stripe_scope",
  );
  assert.equal((await send({ account: "acct_unknown" })).json().ignored, true);
  assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 200);
  assert.equal(
    (await f.db("billing_events").where({ tenant_id: tenant.id })).length,
    1,
  );
  assert.equal(
    (await f.db("billing_events").where({ tenant_id: "primary" })).length,
    0,
  );
  const overview = await f.app.inject({
    url: `/api/v1/tenants/${tenant.slug}/seller/overview`,
    headers: f.headers,
  });
  assert.equal(
    overview.json().sandbox?.isSandbox,
    true,
    "overview must identify the server-confirmed sandbox",
  );
});

test("standalone sandboxes keep their separate API and signed test endpoint without creating another publisher", async (t) => {
  const { default: Stripe } = await import("stripe");
  const f = await fixture(t, {
    deploymentMode: "standalone",
    standaloneOwnerEmail: "owner@example.test",
    stripeTestSecret: "sk_test_fixture",
    stripeTestPublishableKey: "pk_test_fixture",
    stripeTestWebhookSecret: "whsec_sandbox",
  });
  const stripe = new Stripe("sk_test_fixture");
  const send = (extra: object = {}) => {
    const body = JSON.stringify({
      id: "evt_direct_sandbox",
      type: "invoice.paid",
      livemode: false,
      data: { object: { id: "in_test" } },
      ...extra,
    });
    return f.app.inject({
      method: "POST",
      url: "/api/v1/stripe/sandbox-webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "stripe-signature": stripe.webhooks.generateTestHeaderString({
          payload: body,
          secret: "whsec_sandbox",
        }),
      },
    });
  };
  assert.equal((await send()).json().ignored, true);
  const created = await f.request("POST", "/sandbox", { mode: "stripe" });
  assert.equal(created.statusCode, 200, created.body);
  const child = created.json().tenant;
  assert.equal((await send({ account: "acct_connected" })).statusCode, 400);
  assert.equal((await send()).statusCode, 200);
  assert.equal(
    (await f.db("billing_events").where({ tenant_id: child.id })).length,
    1,
  );
  assert.equal(
    (await f.db("billing_events").where({ tenant_id: "primary" })).length,
    0,
  );
  const overview = await f.app.inject({
    url: `/api/v1/tenants/${child.slug}/seller/overview`,
    headers: f.headers,
  });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(
    (await f.request("GET", "/features")).json().features.outboundWebhooks,
    true,
    "standalone needs no Pro subscription",
  );
  const rebuilt = await buildApp(
    f.config,
    f.db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore() },
  );
  await rebuilt.close();
});

test("standalone fixture testing needs no platform subscription and durable forwarding rows stay internal", async (t) => {
  const f = await fixture(t, {
    deploymentMode: "standalone",
    standaloneOwnerEmail: "owner@example.test",
    stripeTestSecret: "sk_test_fixture",
    stripeTestPublishableKey: "pk_test_fixture",
    stripeTestWebhookSecret: "whsec_sandbox",
  });
  const created = await f.request("POST", "/sandbox", {});
  assert.equal(created.statusCode, 200, created.body);
  const child = created.json().tenant;
  const { default: Stripe } = await import("stripe");
  const raw = JSON.stringify({
    id: "evt_fixture_ignored",
    type: "invoice.paid",
    livemode: false,
    data: { object: { id: "in_fixture" } },
  });
  const ignored = await f.app.inject({
    method: "POST",
    url: "/api/v1/stripe/sandbox-webhook",
    payload: raw,
    headers: {
      "content-type": "application/json",
      "stripe-signature": new Stripe(
        "sk_test_fixture",
      ).webhooks.generateTestHeaderString({
        payload: raw,
        secret: "whsec_sandbox",
      }),
    },
  });
  assert.deepEqual(ignored.json(), { ok: true, ignored: true });

  const productId = randomUUID(),
    planId = randomUUID();
  await f.db("products").insert({
    tenant_id: child.id,
    id: productId,
    slug: "local-product",
    name: "Local",
  });
  await f.db("plans").insert({
    tenant_id: child.id,
    id: planId,
    product_id: productId,
    name: "One",
    site_allowance: 1,
    stripe_price_id: "price_local",
  });
  const paid = await f.app.inject({
    method: "POST",
    url: `/api/v1/tenants/${child.slug}/seller/sandbox/purchase`,
    payload: { planId },
    headers: f.headers,
  });
  assert.equal(paid.statusCode, 200, paid.body);
  const operations = new Operations(f.db, "primary");
  await f.db("tenants").where({ id: "primary" }).update({ exempt: 0 });
  await operations.alerts();
  const result = await f.request("GET", "/operations");
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(
    result
      .json()
      .alerts.every(
        (alert: { id: string }) => !alert.id.startsWith("forward_"),
      ),
  );
});

test("the shared worker returns while a tenant webhook is slow, and shutdown drains delivery", async (t) => {
  const { OutboundWebhooks } = await import("../src/outbound-webhooks.ts");
  const f = await fixture(t, {
    deploymentMode: "standalone",
    standaloneOwnerEmail: "owner@example.test",
  });
  let unblock: () => void = () => {},
    started = 0,
    finished = false;
  let signalStarted!: () => void;
  const hasStarted = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  t.mock.method(OutboundWebhooks.prototype, "run", async () => {
    started++;
    signalStarted();
    await blocked;
    finished = true;
  });
  let completed = false;
  const worker = (f.app as typeof f.app & { tick: () => Promise<void> })
    .tick()
    .then(() => {
      completed = true;
    });
  try {
    await hasStarted;
    let deadline!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        worker,
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 1000);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    assert.ok(started > 0);
    assert.equal(completed, true, "slow webhook must not hold the core worker");
    assert.equal(finished, false);
  } finally {
    unblock();
    await worker;
  }
});

async function publicationHeaders(f: Awaited<ReturnType<typeof fixture>>) {
  const before = (
    await f
      .db("platform_emails")
      .where({ kind: "account_verification" })
      .select("id")
  ).map((row) => row.id);
  const requested = await f.app.inject({
    method: "POST",
    url: "/api/v1/platform/account/verification/request",
    payload: { purpose: "release_publish" },
    headers: f.headers,
  });
  assert.equal(requested.statusCode, 200, requested.body);
  const job = await f
    .db("platform_emails")
    .where({ kind: "account_verification" })
    .whereNotIn("id", before)
    .first();
  const token = /#account-verification=([A-Za-z0-9_-]+)/.exec(
    unseal<{ text: string }>(job.payload, f.config.secret).text,
  )![1]!;
  const result = await f.app.inject({
    method: "POST",
    url: "/api/v1/platform/account/verification/consume",
    payload: { purpose: "release_publish", token },
    headers: f.headers,
  });
  assert.equal(result.statusCode, 200, result.body);
  return {
    ...f.headers,
    "x-account-verification": result.json().verification as string,
  };
}

test("browser publication requires a purpose-bound proof before receiving WordPress or native bytes", async (t) => {
  const f = await fixture(t);
  const wordpress = await f.request("POST", "/products", {
    slug: "browser-plugin",
    name: "Browser plugin",
    pluginBasename: "browser-plugin/browser-plugin.php",
    plans: [{ name: "One", siteAllowance: 1, priceId: "price_browser" }],
  });
  assert.equal(wordpress.statusCode, 200, wordpress.body);
  const bytes = zipBytes([
    {
      name: "browser-plugin/browser-plugin.php",
      data: "<?php\n/*\nPlugin Name: Browser plugin\nVersion: 1.0.0\n*/",
    },
  ]);
  const metadata = Buffer.from(
    JSON.stringify({ changelog: "Browser release" }),
  ).toString("base64url");
  const url = f.base + "/releases/browser-plugin/1.0.0";
  const missing = await f.app.inject({
    method: "POST",
    url,
    payload: bytes,
    headers: {
      ...f.headers,
      "content-type": "application/zip",
      "x-release-metadata": metadata,
    },
  });
  assert.equal(missing.statusCode, 403, missing.body);
  assert.equal(missing.json().error.code, "verification_required");
  const proof = await publicationHeaders(f);
  const publication = await f.app.inject({
    method: "POST",
    url,
    payload: bytes,
    headers: {
      ...proof,
      "content-type": "application/zip",
      "x-release-metadata": metadata,
    },
  });
  assert.equal(publication.statusCode, 200, publication.body);
  const replay = await f.app.inject({
    method: "POST",
    url,
    payload: bytes,
    headers: {
      ...proof,
      "content-type": "application/zip",
      "x-release-metadata": metadata,
    },
  });
  assert.equal(replay.statusCode, 403, replay.body);
  const product = await f.request("POST", "/products", {
    slug: "browser-native",
    name: "Browser native",
    framework: "generic",
    frameworkConfig: { activationKind: "device" },
    plans: [{ name: "One", siteAllowance: 1, priceId: "price_native" }],
  });
  assert.equal(product.statusCode, 200, product.body);
  const native = await f.app.inject({
    method: "POST",
    url: f.base + "/assets/browser-native/1.0.0",
    payload: Buffer.from("native artifact"),
    headers: {
      ...(await publicationHeaders(f)),
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "native.bin",
          changelog: "Native release",
        }),
      ).toString("base64url"),
    },
  });
  assert.equal(native.statusCode, 200, native.body);
});

test("background delivery failures are isolated and shutdown prevents another core tick", async (t) => {
  const { OutboundWebhooks } = await import("../src/outbound-webhooks.ts");
  const f = await fixture(t, {
    deploymentMode: "standalone",
    standaloneOwnerEmail: "owner@example.test",
    outboundWebhookHosts: ["hooks.example.test"],
  });
  let failures = 0;
  t.mock.method(OutboundWebhooks.prototype, "run", async () => {
    failures++;
    throw Error("private endpoint credentials");
  });
  const tick = (f.app as typeof f.app & { tick: () => Promise<void> }).tick;
  await tick();
  await f.app.close();
  assert.equal(failures, 1);
  await tick();
  assert.equal(failures, 1);
});

test("delivery refreshes Pro policy after core cleanup and skips a newly delinquent publisher", async (t) => {
  const { OutboundWebhooks } = await import("../src/outbound-webhooks.ts");
  const { Releases } = await import("../src/releases.ts");
  const f = await fixture(t);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_paid_through: Date.now() + 100000 });
  t.mock.method(Releases.prototype, "cleanup", async () => {
    await f
      .db("tenants")
      .where({ id: "primary" })
      .update({ pro_paid_through: 0 });
  });
  let attempts = 0;
  t.mock.method(OutboundWebhooks.prototype, "run", async () => {
    attempts++;
  });
  await (f.app as typeof f.app & { tick: () => Promise<void> }).tick();
  await f.app.close();
  assert.equal(attempts, 0);
});

test("the shared worker tolerates an empty tenant scan without a scheduling cursor error", async (t) => {
  const f = await fixture(t);
  await f.app.ready();
  await f.db("seller_memberships").delete();
  await f.db("tenants").delete();
  await (f.app as typeof f.app & { tick: () => Promise<void> }).tick();
  assert.equal((await f.db("tenants")).length, 0);
});

test("worker holds renewal-gap business events without enabling Pro and dispatches after paid renewal", async (t) => {
  const f = await fixture(t);
  const { OutboundWebhooks } = await import("../src/outbound-webhooks.ts");
  const { recordBusinessEvent } = await import("../src/business-events.ts");
  t.mock.method(OutboundWebhooks.prototype, "run", async () => {});
  const now = Date.now(),
    start = now - 31 * 86400000,
    end = now - 10 * 60000;
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_period_start: start, pro_paid_through: now + 100000 });
  const endpoint = await f.request("POST", "/webhooks", {
    url: "https://8.8.8.8/events",
    events: ["license.created"],
  });
  assert.equal(endpoint.statusCode, 200, endpoint.body);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_paid_through: end });
  const event = await f.db.transaction((tx) =>
    recordBusinessEvent(
      tx,
      "primary",
      "license.created",
      "gap-license",
      "gap-transition",
      now,
    ),
  );
  const tick = (f.app as typeof f.app & { tick: () => Promise<void> }).tick;
  await tick();
  assert.equal(
    (await f.db("business_events").where({ id: event }).first()).state,
    "pending",
  );
  assert.equal((await f.db("outbound_deliveries")).length, 0);
  assert.equal(
    (await f.request("GET", "/features")).json().features.outboundWebhooks,
    false,
  );
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ pro_paid_through: now + 30 * 86400000 });
  await tick();
  assert.equal(
    (await f.db("business_events").where({ id: event }).first()).state,
    "dispatched",
  );
  const deliveries = await f
    .db("outbound_deliveries")
    .where({ event_id: event });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].endpoint_id, endpoint.json().id);
  await tick();
  assert.equal(
    (await f.db("outbound_deliveries").where({ event_id: event })).length,
    1,
  );
});

test("signed connected webhooks supply tenant mode and canonical customer attribution to billing privacy", async (t) => {
  const { Billing } = await import("../src/billing.ts"),
    { StripeBilling } = await import("../src/stripe.ts"),
    { default: Stripe } = await import("stripe");
  const seen: { mode: boolean; customer: string | null }[] = [];
  t.mock.method(
    StripeBilling.prototype,
    "resolveCustomer",
    async () => "cus_private_attribution",
  );
  t.mock.method(
    Billing.prototype,
    "receive",
    async function (
      this: InstanceType<typeof Billing>,
      event: import("../src/billing.ts").BillingEvent,
    ) {
      assert.ok(this.privacy.resolveCustomer);
      seen.push({
        mode: this.privacy.stripeLiveMode,
        customer: await this.privacy.resolveCustomer(event),
      });
    },
  );
  for (const live of [false, true]) {
    const f = await fixture(t, { stripeLiveMode: live });
    await f.db("tenants").where({ id: "primary" }).update({
      stripe_account_id: "acct_privacyContext",
      stripe_status: "connected",
    });
    const body = JSON.stringify({
      id: `evt_privacy_${live}`,
      type: "charge.dispute.created",
      livemode: live,
      account: "acct_privacyContext",
      data: { object: { id: "dp_private" } },
    });
    const signer = new Stripe("sk_test_fixture");
    const response = await f.app.inject({
      method: "POST",
      url: "/api/v1/stripe/connect-webhook",
      payload: body,
      headers: {
        "content-type": "application/json",
        "stripe-signature": signer.webhooks.generateTestHeaderString({
          payload: body,
          secret: f.config.stripeConnectWebhookSecret ?? "whsec_connect_local",
        }),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  }
  assert.deepEqual(seen, [
    { mode: false, customer: "cus_private_attribution" },
    { mode: true, customer: "cus_private_attribution" },
  ]);
});

test("failed export housekeeping cannot stop another publisher's queued login email", async (t) => {
  const f = await fixture(t);
  const { Portability } = await import("../src/portability.ts");
  const { Auth } = await import("../src/auth.ts");
  const other = await new Tenants(f.db, f.config).create(f.seller, {
      slug: "unrelated-publisher",
      name: "Other publisher",
    }),
    customer = randomUUID();
  await f
    .db("customers")
    .insert({
      tenant_id: other.id,
      id: customer,
      email: "other-buyer@example.test",
    });
  await new Auth(f.db, f.config, other).request("other-buyer@example.test");
  assert.equal((await f.db("emails").where({ tenant_id: other.id })).length, 1);
  let attempted = 0;
  t.mock.method(Portability.prototype, "cleanupExpired", async () => {
    attempted++;
    throw Error("private export path cannot be unlinked");
  });
  await (f.app as typeof f.app & { tick: () => Promise<void> }).tick();
  assert.equal(attempted, 1);
  assert.equal(
    (await f.db("emails").where({ tenant_id: other.id }).first()).state,
    "sent",
  );
});

test("an actually unreadable export directory preserves quota without blocking another tenant mail or export", async (t) => {
  const f = await fixture(t),
    { chmod } = await import("node:fs/promises"),
    { join } = await import("node:path"),
    { Auth } = await import("../src/auth.ts");
  const other = await new Tenants(f.db, f.config).create(f.seller, {
    slug: "healthy-export",
    name: "Healthy export",
  });
  for (const [tenantId, account] of [
    ["primary", "acct_blockedExport"],
    [other.id, "acct_healthyExport"],
  ])
    await f
      .db("tenants")
      .where({ id: tenantId })
      .update({ stripe_account_id: account, stripe_status: "connected" });
  const headersFor = async (tenantId: string, letter: string) => {
    const key = `DE-TK-${letter.repeat(43)}`;
    await f
      .db("tenant_api_keys")
      .insert({
        id: randomUUID(),
        tenant_id: tenantId,
        name: "Export fixture",
        key_hash: hash(key),
        display_prefix: key.slice(0, 14),
        scopes: JSON.stringify(["data:export"]),
        created_at: Date.now(),
        expires_at: Date.now() + 86400000,
        revoked_at: null,
        last_used_at: null,
      });
    return { authorization: `Bearer ${key}` };
  };
  const primaryHeaders = await headersFor("primary", "A"),
    otherHeaders = await headersFor(other.id, "B");
  const created = await f.request(
    "POST",
    "/exports",
    { passphrase: "private cleanup fixture passphrase" },
    primaryHeaders,
  );
  assert.equal(created.statusCode, 200, created.body);
  const directory = join(f.config.storage, "tenant-exports", created.json().id);
  await chmod(directory, 0);
  const log = t.mock.method(f.app.log, "error");
  try {
    const deleted = await f.request(
      "DELETE",
      `/exports/${created.json().id}`,
      {},
      primaryHeaders,
    );
    assert.equal(deleted.statusCode, 503, deleted.body);
    const customer = randomUUID();
    await f
      .db("customers")
      .insert({
        tenant_id: other.id,
        id: customer,
        email: "healthy-buyer@example.test",
      });
    await new Auth(f.db, f.config, other).request("healthy-buyer@example.test");
    await (f.app as typeof f.app & { tick: () => Promise<void> }).tick();
    assert.equal(
      (await f.db("emails").where({ tenant_id: other.id }).first()).state,
      "sent",
    );
    const unrelated = await f.app.inject({
      method: "POST",
      url: `/api/v1/tenants/${other.slug}/seller/exports`,
      headers: otherHeaders,
      payload: { passphrase: "other private cleanup passphrase" },
    });
    assert.equal(unrelated.statusCode, 200, unrelated.body);
    assert.ok(
      log.mock.calls.some((c) =>
        JSON.stringify(c.arguments).includes("export_cleanup_failed"),
      ),
    );
    assert.ok(
      log.mock.calls.every(
        (c) => !JSON.stringify(c.arguments).includes(directory),
      ),
    );
  } finally {
    await chmod(directory, 0o700);
  }
});

test("local paid purchases retain portable customer identifiers and export successfully", async (t) => {
  const f = await fixture(t);
  const configured = await f.app.inject({
    method: "POST",
    url: "/api/v1/operator/local/tenants/primary",
    headers: { authorization: `Bearer ${f.config.operatorToken}` },
    payload: { connected: true, paidDays: 30 },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const productId = randomUUID(),
    planId = randomUUID();
  await f.db("products").insert({
    tenant_id: "primary",
    id: productId,
    slug: "portable-local",
    name: "Portable local",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: planId,
    product_id: productId,
    name: "Annual",
    site_allowance: 1,
    stripe_price_id: "price_local_1",
  });
  const token = `DE-TK-${"P".repeat(43)}`;
  await f.db("tenant_api_keys").insert({
    id: randomUUID(),
    tenant_id: "primary",
    name: "Portable local fixtures",
    key_hash: hash(token),
    display_prefix: token.slice(0, 14),
    scopes: JSON.stringify(["licenses:write", "data:export"]),
    created_at: Date.now(),
    expires_at: Date.now() + 86400000,
    revoked_at: null,
    last_used_at: null,
  });
  const headers = { authorization: `Bearer ${token}` };
  for (const email of ["qa+export@example.test", "QA+EXPORT@EXAMPLE.TEST"]) {
    const purchase = await f.request(
      "POST",
      "/local/purchase",
      {
        planId,
        email,
        subscriptionId: "sub_local_portable_fixture",
      },
      headers,
    );
    assert.equal(purchase.statusCode, 200, purchase.body);
  }
  const exported = await f.request(
    "POST",
    "/exports",
    {
      passphrase: "local portable regression passphrase",
    },
    headers,
  );
  assert.equal(exported.statusCode, 200, exported.body);
  assert.ok(exported.json().id);
  const customers = await f.db("customers").where({ tenant_id: "primary" });
  assert.equal(customers.length, 1);
  assert.equal(customers[0]!.email, "qa+export@example.test");
  assert.match(customers[0]!.stripe_id, /^cus_local_[a-f0-9]{64}$/);
  assert.equal(
    (await f.db("licenses").where({ tenant_id: "primary" })).length,
    1,
  );
});
