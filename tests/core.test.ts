import { primaryTenant } from "./helpers/tenant.ts";
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createDb, migrate, reset } from "../src/db.ts";
import { Licenses } from "../src/licensing.ts";
import { hash, unseal } from "../src/crypto.ts";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Releases } from "../src/releases.ts";
import { Outbox } from "../src/email.ts";
import { tenantMetrics } from "../src/metrics.ts";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";

const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/core-");
const db = createDb(
  process.env.TEST_DATABASE_URL ?? `sqlite:${root}/db.sqlite`,
);
const secret = "11".repeat(32);
const licensing = new Licenses(db, secret, [], primaryTenant);
let snapshot: BillingSnapshot;
const billing = new Billing(db, licensing, {
  snapshot: async () => structuredClone(snapshot),
});
const releases = new Releases(
  db,
  new InMemoryArtifactStore(),
  primaryTenant,
  join(root, "releases"),
);
before(async () => {
  await migrate(db);
  await migrate(db);
});
test("engines preserve case-sensitive provider IDs and large encrypted webhook payloads", async () => {
  await db("plans").insert({
    tenant_id: "primary",
    id: "ONE",
    product_id: "prod",
    name: "Case sensitive",
    site_allowance: 5,
    stripe_price_id: "price_ONE",
  });
  const event = {
    id: "evt_Case",
    type: "invoice.paid",
    data: { object: { id: "in_1", description: "x".repeat(200000) } },
  };
  await billing.receive(event);
  await billing.receive({ ...event, id: "evt_case" });
  assert.equal((await db("billing_events")).length, 2);
  const stored = await db("billing_events").where({ id: "evt_Case" }).first();
  assert.equal(
    unseal<typeof event>(stored.payload, secret).data.object.description.length,
    200000,
  );
});
after(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  await db("products").insert({
    tenant_id: "primary",
    id: "prod",
    slug: "example-pro",
    name: "Example Pro",
  });
  await db("plans").insert([
    {
      tenant_id: "primary",
      id: "one",
      product_id: "prod",
      name: "One",
      site_allowance: 1,
      stripe_price_id: "price_one",
    },
    {
      tenant_id: "primary",
      id: "five",
      product_id: "prod",
      name: "Five",
      site_allowance: 5,
      stripe_price_id: "price_five",
    },
  ]);
  snapshot = {
    subscriptionId: "sub_1",
    customerId: "cus_1",
    email: "owner@example.test",
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "il_1",
        invoiceId: "in_1",
        priceId: "price_one",
        periodStart: Date.now() - 1000,
        periodEnd: Date.now() + 86400000,
        paidAt: Date.now(),
        settled: true,
      },
    ],
  };
});
async function purchase() {
  await billing.reconcile("sub_1");
  const license = await db("licenses").first();
  const email = await db("emails").where({ kind: "license_key" }).first();
  const outbox = new Outbox(
    db,
    secret,
    { send: async () => {} },
    primaryTenant,
  );
  const message = outbox.message(email);
  const key = /DE-[A-Za-z0-9_-]+/.exec(message.text)![0];
  assert.ok(message.html?.includes(key), "license email includes the key in HTML");
  assert.match(message.html ?? "", /email-content/);
  return { license, key };
}
test("only confirmed paid grants issue one license and one recoverable key email on retries", async () => {
  snapshot.grants[0]!.settled = false;
  await billing.reconcile("sub_1");
  assert.equal((await db("licenses")).length, 0);
  snapshot.grants[0]!.settled = true;
  const { license, key } = await purchase();
  await Promise.all(
    Array.from({ length: 4 }, () => billing.reconcile("sub_1")),
  );
  assert.equal((await db("licenses")).length, 1);
  assert.equal((await db("emails")).length, 1);
  assert.equal(license.site_allowance, 1);
  assert.ok(!JSON.stringify(await db("licenses")).includes(key));
  let attempts = 0;
  const messages: string[] = [];
  const outbox = new Outbox(
    db,
    secret,
    {
      send: async (m) => {
        messages.push(m.text);
        if (++attempts === 1) throw Error("SMTP offline");
      },
    },
    primaryTenant,
  );
  await outbox.run();
  await db("emails").update({ available_at: 0 });
  await outbox.run();
  assert.equal(messages.length, 2);
  assert.equal(messages[0], messages[1]);
  assert.equal((await db("emails").first()).state, "sent");
});
test("renewals, stale snapshots, failed payment and cancellation preserve already paid entitlement", async () => {
  const { license } = await purchase();
  const end = Number(license.paid_through) + 86400000;
  snapshot.grants.push({
    ...snapshot.grants[0]!,
    id: "il_2",
    invoiceId: "in_2",
    periodStart: Number(license.paid_through),
    periodEnd: end,
    paidAt: Date.now() + 1,
  });
  await billing.reconcile("sub_1");
  snapshot.grants = [snapshot.grants[0]!];
  snapshot.billingStatus = "past_due";
  await billing.reconcile("sub_1");
  snapshot.billingStatus = "canceled";
  await billing.reconcile("sub_1");
  const final = await db("licenses").first();
  assert.equal(Number(final.paid_through), end);
  assert.equal(final.billing_status, "canceled");
  assert.equal(licensing.entitled(final), true);
});
test("unpaid upgrades do not add seats and older paid plans cannot overwrite a paid upgrade", async () => {
  await purchase();
  snapshot.grants.push({
    ...snapshot.grants[0]!,
    id: "il_upgrade",
    invoiceId: "in_up",
    priceId: "price_five",
    settled: false,
    paidAt: Date.now() + 2,
  });
  await billing.reconcile("sub_1");
  assert.equal((await db("licenses").first()).site_allowance, 1);
  snapshot.grants[1]!.settled = true;
  await billing.reconcile("sub_1");
  assert.equal((await db("licenses").first()).site_allowance, 5);
  snapshot.grants = [snapshot.grants[0]!];
  await billing.reconcile("sub_1");
  assert.equal((await db("licenses").first()).site_allowance, 5);
});
test("refund and dispute flags enforce the explicit download policy without changing paid dates", async () => {
  const { license } = await purchase();
  snapshot.suspended = true;
  await billing.reconcile("sub_1");
  assert.equal(licensing.entitled(await db("licenses").first()), false);
  snapshot.suspended = false;
  await billing.reconcile("sub_1");
  assert.equal(licensing.entitled(await db("licenses").first()), true);
  snapshot.fullyRefunded = true;
  await billing.reconcile("sub_1");
  assert.equal(licensing.entitled(await db("licenses").first()), false);
  assert.equal(
    Number((await db("licenses").first()).paid_through),
    Number(license.paid_through),
  );
});
test("concurrent activations enforce the limit; repeats, deactivation and site moves work", async () => {
  const { key } = await purchase();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) =>
      licensing.activate(
        key,
        `install-${i}`,
        "https://EXAMPLE.com:443/path/?x=1#x",
        "example-pro",
      ),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const row = await db("installations").where({ active: 1 }).first();
  const first = await licensing.activate(
    key,
    row.installation_id,
    "http://example.com/path",
    "example-pro",
  );
  const again = await licensing.activate(
    key,
    row.installation_id,
    "https://example.com/path/",
    "example-pro",
  );
  assert.equal(first.token, again.token);
  assert.equal(
    (await db("installations").first()).site_url,
    "example.com/path",
  );
  await assert.rejects(
    licensing.activate(
      key,
      row.installation_id,
      "https://other.test",
      "example-pro",
    ),
    /deactivate/i,
  );
  await licensing.deactivate(first.token);
  await assert.rejects(licensing.status(first.token));
  const moved = await licensing.activate(
    key,
    row.installation_id,
    "https://other.test",
    "example-pro",
  );
  assert.notEqual(moved.token, first.token);
});
test("key replacement invalidates prior key and activation tokens and scopes ownership", async () => {
  const { key, license } = await purchase();
  const activation = await licensing.activate(
    key,
    "stable-install",
    "https://example.test",
    "example-pro",
  );
  await assert.rejects(licensing.replaceKey(license.id, "another-customer"));
  const next = await licensing.replaceKey(license.id, license.customer_id);
  await assert.rejects(
    licensing.activate(
      key,
      "stable-install",
      "https://example.test",
      "example-pro",
    ),
  );
  await assert.rejects(licensing.status(activation.token));
  assert.ok(
    await licensing.activate(
      next,
      "stable-install",
      "https://example.test",
      "example-pro",
    ),
  );
});
test("expired, revoked and suspended licenses deny downloads", async () => {
  const { license } = await purchase();
  for (const patch of [
    { paid_through: 1 },
    { revoked: 1 },
    { suspended: 1 },
    { refund_revoked: 1 },
  ]) {
    assert.equal(licensing.entitled({ ...license, ...patch }), false);
  }
});
test("canceled in-flight key delivery cannot be resurrected by SMTP failure", async () => {
  const { license } = await purchase();
  const old = (await db("emails").first()).id;
  let started!: () => void, fail!: () => void;
  const began = new Promise<void>((r) => {
    started = r;
  });
  const failure = new Promise<void>((_r, reject) => {
    fail = () => reject(Error("SMTP timed out"));
  });
  const outbox = new Outbox(
    db,
    secret,
    {
      send: async () => {
        started();
        await failure;
      },
    },
    primaryTenant,
  );
  const running = outbox.run();
  await began;
  await licensing.replaceKey(license.id, license.customer_id);
  fail();
  // Stop at the one canceled delivery; the new key must remain retryable.
  await running;
  const canceled = await db("emails").where({ id: old }).first();
  assert.equal(canceled.state, "canceled");
  assert.equal(canceled.payload, "");
});
test("duplicate and out-of-order persisted events reconcile once per durable event and retry failures", async () => {
  const event = {
    id: "evt_renewal",
    type: "invoice.paid",
    data: { object: { id: "in_1" } },
  };
  await Promise.all([
    billing.receive(event),
    billing.receive(event),
    billing.receive({ ...event, id: "evt_initial" }),
  ]);
  assert.equal((await db("billing_events")).length, 2);
  await billing.run(async () => {
    throw Error("Stripe unavailable");
  });
  assert.equal((await db("licenses")).length, 0);
  assert.equal((await db("work").where({ state: "pending" })).length, 2);
  await db("work").update({ available_at: 0 });
  await billing.run(async () => "sub_1");
  assert.equal((await db("licenses")).length, 1);
  assert.equal((await db("emails")).length, 1);
  assert.equal((await db("work").where({ state: "sent" })).length, 2);
  assert.equal(
    (await db("billing_events").whereNotNull("processed_at")).length,
    2,
  );
});
test("staging exemptions require configured exact host or dot-delimited suffix", async () => {
  const { key } = await purchase();
  const configured = new Licenses(
    db,
    secret,
    ["staging.example.test"],
    primaryTenant,
  );
  await configured.activate(
    key,
    "production",
    "https://example.test",
    "example-pro",
  );
  await configured.activate(
    key,
    "staging-1",
    "https://staging.example.test",
    "example-pro",
  );
  await configured.activate(
    key,
    "staging-2",
    "https://branch.staging.example.test",
    "example-pro",
  );
  const nondefaultHttp = await configured.activate(
    key,
    "staging-http-443",
    "http://staging.example.test:443/path",
    "example-pro",
  );
  assert.equal((await configured.resolve(nondefaultHttp.token)).installation.exempt, 1);
  await assert.rejects(
    configured.activate(
      key,
      "impostor1",
      "https://notstaging.example.test",
      "example-pro",
    ),
    /allowance/,
  );
  assert.equal(
    (await db("installations").where({ active: 1, exempt: 0 })).length,
    1,
  );
});
test("removed development suffixes count existing seats without revoking active tokens or retries", async () => {
  const { key } = await purchase();
  const configured = new Licenses(db, secret, ["staging.example.test"], primaryTenant);
  const production = await configured.activate(key, "production", "https://example.test", "example-pro");
  const staging = await configured.activate(key, "staging", "https://STAGING.example.test:8443/path/", "example-pro");
  const branch = await configured.activate(key, "branch", "https://branch.staging.example.test", "example-pro");
  const current = new Licenses(db, secret, [], primaryTenant);
  assert.equal((await current.resolve(staging.token)).installation.exempt, 0);
  assert.equal((await current.resolve(branch.token)).installation.exempt, 0);
  assert.equal((await db("installations").where({ installation_id: "staging" }).first()).exempt, 1, "reads do not rewrite snapshots");
  await assert.rejects(current.activate(key, "another", "https://another.example.test", "example-pro"), { code: "site_limit" });
  for (const [id, site, token] of [
    ["production", "https://example.test", production.token],
    ["staging", "https://staging.example.test:8443/path", staging.token],
    ["branch", "https://branch.staging.example.test", branch.token],
  ]) {
    assert.equal((await current.activate(key, id!, site!, "example-pro")).token, token);
    assert.equal((await current.status(token!)).entitled, true);
  }
  assert.equal((await db("installations").where({ active: 1, exempt: 0 })).length, 3);
  await current.deactivate(staging.token);
  await current.deactivate(branch.token);
  await assert.rejects(current.activate(key, "another", "https://another.example.test", "example-pro"), { code: "site_limit" });
  await current.deactivate(production.token);
  await current.activate(key, "another", "https://another.example.test", "example-pro");
});

test("concurrent activations use current development exemptions before allocating the remaining paid seats", async () => {
  snapshot.grants[0]!.priceId = "price_five";
  const { key } = await purchase();
  const configured = new Licenses(db, secret, ["staging.example.test"], primaryTenant);
  for (let i = 0; i < 4; i++)
    await configured.activate(key, `staging-${i}`, `https://${i}.staging.example.test`, "example-pro");
  const current = new Licenses(db, secret, [], primaryTenant);
  const results = await Promise.allSettled(Array.from({ length: 3 }, (_, i) =>
    current.activate(key, `production-${i}`, `https://${i}.example.test`, "example-pro"),
  ));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results)
    if (result.status === "rejected") assert.equal(result.reason.code, "site_limit");
  assert.equal((await db("installations").where({ active: 1, exempt: 0 })).length, 5);
});

test("new development suffixes reclassify existing sites while device products remain counted", async () => {
  const { key } = await purchase();
  const first = await licensing.activate(key, "staging", "https://staging.example.test", "example-pro");
  const current = new Licenses(db, secret, ["staging.example.test", "device"], primaryTenant);
  assert.equal((await current.resolve(first.token)).installation.exempt, 1);
  assert.equal((await current.activate(key, "staging", "https://staging.example.test", "example-pro")).token, first.token);
  assert.equal((await db("installations").first()).exempt, 1);
  const production = await current.activate(key, "production", "https://example.test", "example-pro");
  await db("products").where({ id: "prod", tenant_id: "primary" }).update({ framework: "generic", framework_config: "{}" });
  assert.equal((await current.resolve(first.token)).installation.exempt, 0);
  await assert.rejects(current.activate(key, "another-device", undefined, "example-pro"), { code: "site_limit" });
  await current.deactivate(first.token);
  await current.deactivate(production.token);
  const device = await current.activate(key, "00000001", undefined, "example-pro");
  assert.equal((await current.resolve(device.token)).installation.exempt, 0, "a numeric device ID is never parsed as a host port exemption");
});

test("development exemption refresh reaches every page while preserving an over-capacity installation retry", async () => {
  const { key } = await purchase();
  const configured = new Licenses(db, secret, ["staging.example.test"], primaryTenant);
  const staging = await configured.activate(key, "staging", "https://staging.example.test", "example-pro");
  const original = await db("installations").first();
  await db.batchInsert("installations", Array.from({ length: 500 }, (_, index) => ({
    ...original,
    id: `batch-${String(index).padStart(3, "0")}`,
    installation_id: `batch-${index}`,
    site_url: `${index}.staging.example.test`,
    token_hash: hash(`batch-token-${index}`),
  })), 100);
  const current = new Licenses(db, secret, [], primaryTenant);
  assert.equal((await current.activate(key, "staging", "https://staging.example.test", "example-pro")).token, staging.token);
  assert.equal((await db("installations").where({ active: 1, exempt: 0 })).length, 501);
  assert.equal((await current.status(staging.token)).entitled, true);
  await assert.rejects(current.activate(key, "another", "https://another.example.test", "example-pro"), { code: "site_limit" });
});

test("buyer and seller views and metrics apply current suffixes without rewriting installation snapshots", async (t) => {
  const { key, license } = await purchase();
  const configured = new Licenses(db, secret, ["staging.example.test"], primaryTenant);
  await configured.activate(key, "staging", "https://staging.example.test", "example-pro");
  const config = loadConfig({ DEPLOYMENT_MODE: "hosted", APP_SECRET: secret, OPERATOR_TOKEN: "development-policy-fixture".repeat(2), DATA_DIR: root, LOCAL_BILLING: "true" });
  const apiKey = `DE-TK-${"P".repeat(43)}`;
  await db("tenant_api_keys").insert({ id: "policy-key", tenant_id: "primary", name: "Policy", key_hash: hash(apiKey), scopes: '["read"]', display_prefix: "policy", created_at: Date.now(), expires_at: Date.now() + 86400000 });
  await db("sessions").insert({ tenant_id: "primary", id: hash("policy-buyer-session"), customer_id: license.customer_id, expires_at: Date.now() + 86400000 });
  const app = await buildApp(config, db, { send: async () => {} }, { store: new InMemoryArtifactStore() });
  t.after(() => app.close());
  const buyer = await app.inject({ url: "/api/v1/tenants/primary/me", headers: { cookie: "de-session-primary=policy-buyer-session" } });
  assert.equal(buyer.statusCode, 200, buyer.body);
  assert.equal(buyer.json().licenses[0].installations[0].exempt, false);
  const sellerHeaders = { authorization: `Bearer ${apiKey}` };
  const seller = await app.inject({ url: `/api/v1/tenants/primary/seller/licenses/${license.id}`, headers: sellerHeaders });
  assert.equal(seller.statusCode, 200, seller.body);
  assert.equal(seller.json().installations[0].exempt, false);
  const overview = await app.inject({ url: "/api/v1/tenants/primary/seller/overview", headers: sellerHeaders });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(overview.json().metrics.installations.developmentActive, 0);
  assert.equal(overview.json().metrics.seats.used, 1);
  const metrics = await tenantMetrics(db, primaryTenant);
  assert.equal(metrics.installations.developmentActive, 0);
  assert.equal((await db("installations").first()).exempt, 1, "projections leave stored flags alone");
  config.exemptSuffixes.push("staging.example.test");
  assert.equal((await app.inject({ url: "/api/v1/tenants/primary/me", headers: { cookie: "de-session-primary=policy-buyer-session" } })).json().licenses[0].installations[0].exempt, true);
  assert.equal((await app.inject({ url: `/api/v1/tenants/primary/seller/licenses/${license.id}`, headers: sellerHeaders })).json().installations[0].exempt, true);
  assert.equal((await app.inject({ url: "/api/v1/tenants/primary/seller/overview", headers: sellerHeaders })).json().metrics.seats.used, 0);
  await db("products").where({ id: "prod", tenant_id: "primary" }).update({ framework: "generic", framework_config: "{}" });
  assert.equal((await app.inject({ url: "/api/v1/tenants/primary/me", headers: { cookie: "de-session-primary=policy-buyer-session" } })).json().licenses[0].installations[0].exempt, false);
  assert.equal((await app.inject({ url: `/api/v1/tenants/primary/seller/licenses/${license.id}`, headers: sellerHeaders })).json().installations[0].exempt, false);
  assert.equal((await app.inject({ url: "/api/v1/tenants/primary/seller/overview", headers: sellerHeaders })).json().metrics.seats.used, 1);
});

test("future paid downgrade preserves seats through the larger paid period then enforces the lower allowance", async () => {
  let now = Date.now();
  const clocked = new Licenses(db, secret, [], primaryTenant, () => now);
  const service = new Billing(db, clocked, {
    snapshot: async () => structuredClone(snapshot),
  });
  snapshot.grants[0]!.priceId = "price_five";
  await service.reconcile("sub_1");
  const end = snapshot.grants[0]!.periodEnd;
  snapshot.grants.push({
    ...snapshot.grants[0]!,
    id: "il_lower",
    invoiceId: "in_lower",
    priceId: "price_one",
    periodStart: end,
    periodEnd: end + 86400000,
    paidAt: now + 1,
  });
  await service.reconcile("sub_1");
  const license = await db("licenses").first();
  assert.equal((await clocked.effective(license)).site_allowance, 5);
  now = end + 1;
  assert.equal((await clocked.effective(license)).site_allowance, 1);
  assert.equal(clocked.entitled(license), true);
});
test("publication verifies ZIP then stores immutable bytes; withdrawal keeps recovery artifact", async () => {
  const zip = join(root, "test.zip");
  // Minimal ZIP with one file, created using the system's ZIP implementation.
  const { execFileSync } = await import("node:child_process");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "example-pro"), { recursive: true });
  await writeFile(
    join(root, "example-pro/example-pro.php"),
    "<?php\n/*\nPlugin Name: Example\nVersion: 1.0.0\n*/",
  );
  execFileSync("zip", ["-q", zip, "example-pro/example-pro.php"], {
    cwd: root,
  });
  const release = await releases.publish({
    product: "example-pro",
    version: "1.0.0",
    file: zip,
    changelog: "First",
    minWp: "6.0",
    minPhp: "8.0",
    minFree: "1.0.0",
    tested: "7.0",
  });
  await assert.rejects(
    releases.publish({
      product: "example-pro",
      version: "v2.0.0",
      file: zip,
      changelog: "Invalid version",
      minWp: "6.0",
      minPhp: "8.0",
      minFree: "1.0.0",
      tested: "7.0",
    }),
    /semantic versioning/,
  );
  assert.deepEqual(await releases.read(release), await readFile(zip));
  await assert.rejects(
    releases.publish({
      product: "example-pro",
      version: "1.0.0",
      file: zip,
      changelog: "Other",
      minWp: "6.0",
      minPhp: "8.0",
      minFree: "1.0.0",
      tested: "7.0",
    }),
  );
  await releases.withdraw(release.id);
  assert.equal(await releases.latest("prod"), undefined);
  assert.ok((await releases.read(release)).length > 0);
  await writeFile(zip, "not a zip");
  await assert.rejects(
    releases.publish({
      product: "example-pro",
      version: "2.0.0",
      file: zip,
      changelog: "Bad",
      minWp: "6.0",
      minPhp: "8.0",
      minFree: "1.0.0",
      tested: "7.0",
    }),
  );
});
