import { primaryTenant } from "./helpers/tenant.ts";
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createDb, migrate, reset, type License } from "../src/db.ts";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { Licenses, normalizeSite } from "../src/licensing.ts";
import { hash } from "../src/crypto.ts";
import { Outbox } from "../src/email.ts";
const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/core-edge-");
const db = createDb(process.env.TEST_DATABASE_URL ?? `sqlite:${root}/db`);
const secret = "45".repeat(32);
const licensing = new Licenses(db, secret, [], primaryTenant);
let snapshot: BillingSnapshot;
const billing = new Billing(db, licensing, {
  snapshot: async () => structuredClone(snapshot),
});
before(async () => {
  await migrate(db);
});
after(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  await db("products").insert([
    { tenant_id: "primary", id: "product", slug: "product", name: "Product" },
    { tenant_id: "primary", id: "other", slug: "other", name: "Other" },
  ]);
  await db("plans").insert([
    {
      tenant_id: "primary",
      id: "plan",
      product_id: "product",
      name: "Plan",
      site_allowance: 1,
      stripe_price_id: "price",
    },
    {
      tenant_id: "primary",
      id: "other",
      product_id: "other",
      name: "Other",
      site_allowance: 5,
      stripe_price_id: "price_other",
    },
  ]);
  snapshot = {
    subscriptionId: "sub",
    customerId: "cus",
    email: "owner@example.test",
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "grant",
        invoiceId: "invoice",
        priceId: "price",
        periodStart: Date.now() - 1000,
        periodEnd: Date.now() + 86400000,
        paidAt: Date.now(),
        settled: true,
      },
    ],
  };
});
test("billing rejects mismatched subscriptions and missing customer email without issuing credentials", async () => {
  snapshot.subscriptionId = "other";
  await assert.rejects(billing.reconcile("sub"), /snapshot mismatch/);
  snapshot.subscriptionId = "sub";
  snapshot.email = "missing";
  await assert.rejects(billing.reconcile("sub"), /email is required/);
  assert.equal((await db("licenses")).length, 0);
  assert.equal((await db("emails")).length, 0);
});
test("unknown prices and invalid invoice periods cannot create initial entitlement", async () => {
  snapshot.grants.push({
    ...snapshot.grants[0]!,
    id: "unknown",
    priceId: "unmapped",
  });
  snapshot.grants[0]!.periodEnd = snapshot.grants[0]!.periodStart;
  await billing.reconcile("sub");
  assert.equal((await db("licenses")).length, 0);
});
test("a paid purchase attaches to the existing verified email customer and preserves that identity", async () => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "local-customer",
    email: "owner@example.test",
    stripe_id: null,
  });
  snapshot.email = " Owner@Example.test ";
  await billing.reconcile("sub");
  assert.equal((await db("customers")).length, 1);
  assert.equal((await db("customers").first()).stripe_id, "cus");
  assert.equal((await db("licenses").first()).customer_id, "local-customer");
});
test("an email already claimed by another Stripe customer cannot receive a second customer grant", async () => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "existing",
    email: "owner@example.test",
    stripe_id: "different-customer",
  });
  await assert.rejects(billing.reconcile("sub"), /another billing customer/);
  assert.equal((await db("licenses")).length, 0);
  assert.equal((await db("emails")).length, 0);
});
test("canonical subscription changes cannot transfer a license to another customer or product", async () => {
  await billing.reconcile("sub");
  const license = await db<License>("licenses").first();
  assert.ok(license);
  await db("customers").insert({
    tenant_id: "primary",
    id: "other-owner",
    email: "other@example.test",
    stripe_id: "cus_other",
  });
  snapshot.customerId = "cus_other";
  snapshot.email = "other@example.test";
  await assert.rejects(
    billing.reconcile("sub"),
    /cannot change license ownership/,
  );
  snapshot.customerId = "cus";
  snapshot.email = "owner@example.test";
  snapshot.grants = [
    { ...snapshot.grants[0]!, id: "other-grant", priceId: "price_other" },
  ];
  await assert.rejects(billing.reconcile("sub"), /cannot move across products/);
  assert.equal((await db("licenses").first()).product_id, license.product_id);
  assert.equal((await db("grants")).length, 1);
  assert.equal((await db("emails")).length, 1);
});
test("reconciliation preserves a preexisting paid license even when Stripe returns no additional grant", async () => {
  const paidThrough = Date.now() + 86400000;
  await db("customers").insert({
    tenant_id: "primary",
    id: "customer",
    email: "owner@example.test",
    stripe_id: "cus",
  });
  await db("licenses").insert({
    tenant_id: "primary",
    id: "imported",
    customer_id: "customer",
    product_id: "product",
    plan_id: "plan",
    site_allowance: 1,
    paid_through: paidThrough,
    billing_status: "active",
    subscription_id: "sub",
    key_hash: hash("key"),
  });
  await db("grants").insert({
    tenant_id: "primary",
    id: "previous-grant",
    license_id: "imported",
    invoice_id: "previous-invoice",
    plan_id: "plan",
    period_start: Date.now() - 1000,
    period_end: paidThrough,
    paid_at: Date.now() - 1000,
  });
  snapshot.grants = [];
  snapshot.billingStatus = "canceled";
  await billing.reconcile("sub");
  const license = await db<License>("licenses").first();
  assert.ok(license);
  assert.equal(license.plan_id, "plan");
  assert.equal(license.site_allowance, 1);
  assert.equal(license.billing_status, "canceled");
  assert.equal(Number(license.paid_through), paidThrough);
  assert.equal(licensing.entitled(license), true);
  assert.equal((await db("emails")).length, 0);
});
test("scheduled reconciliation deduplicates IDs and irrelevant webhooks finish without granting a license", async () => {
  await billing.receive({
    id: "irrelevant",
    type: "customer.updated",
    data: { object: { id: "cus" } },
  });
  await billing.run(async () => null);
  assert.equal((await db("licenses")).length, 0);
  assert.ok((await db("billing_events").first()).processed_at);
  await billing.enqueueReconcile(["sub", "sub"]);
  assert.equal((await db("work").where({ kind: "reconcile" })).length, 1);
  await billing.run(async () => {
    throw Error("not an event");
  });
  assert.equal((await db("licenses")).length, 1);
  assert.equal((await db("work").where({ state: "sent" })).length, 2);
});
test("site normalization rejects credential-bearing/non-HTTP URLs and preserves explicit ports and path case", () => {
  assert.equal(
    normalizeSite("https://EXAMPLE.test:8443/Sub/Path/?key=secret#fragment"),
    "example.test:8443/Sub/Path",
  );
  assert.equal(normalizeSite("http://example.test:80/"), "example.test");
  for (const site of [
    "ftp://example.test/",
    "https://user@example.test/",
    "https://user:password@example.test/",
  ])
    assert.throws(() => normalizeSite(site), /without credentials/);
});
test("activation refuses expired and wrong-product licenses; owned deactivation revokes the actual token", async () => {
  await billing.reconcile("sub");
  const l = await db<License>("licenses").first();
  assert.ok(l);
  const key = await licensing.replaceKey(l.id, l.customer_id);
  await assert.rejects(
    licensing.activate(key, "site-001", "https://example.test", "other"),
    /does not cover/,
  );
  await db("licenses").where({ id: l.id }).update({ paid_through: 1 });
  await assert.rejects(
    licensing.activate(key, "site-001", "https://example.test", "product"),
    /cannot authorize/,
  );
  await db("licenses")
    .where({ id: l.id })
    .update({ paid_through: Date.now() + 86400000 });
  const activation = await licensing.activate(
    key,
    "site-001",
    "https://example.test",
    "product",
  );
  const installation = await db("installations")
    .where({ license_id: l.id })
    .first();
  await assert.rejects(
    licensing.deactivateOwned(installation.id, "foreign-owner"),
    /not found/,
  );
  assert.equal((await licensing.status(activation.token)).entitled, true);
  await licensing.deactivateOwned(installation.id, l.customer_id);
  await assert.rejects(
    licensing.status(activation.token),
    /invalid or revoked/,
  );
  assert.equal((await db("installations").first()).active, 0);
  await assert.rejects(
    licensing.keyEmail(db, { ...l, customer_id: "missing" }, "unissued"),
    /Customer not found/,
  );
});
test("email canceled between its durable claim and send does not deliver a superseded credential", async (t) => {
  if (db.client.config.client !== "better-sqlite3") {
    t.skip(
      "SQLite query hook provides a deterministic boundary; core queue transactions run on every engine.",
    );
    return;
  }
  await billing.reconcile("sub");
  const email = await db("emails").first();
  let sends = 0;
  const connection = await db.client.acquireConnection();
  await db.client.releaseConnection(connection);
  const cancel = (query: { sql: string }) => {
    if (query.sql.startsWith("select * from `emails` where `id`"))
      connection
        .prepare("update emails set state='canceled', payload='' where id=?")
        .run(email.id);
  };
  db.on("query", cancel);
  try {
    await new Outbox(
      db,
      secret,
      {
        send: async () => {
          sends++;
        },
      },
      primaryTenant,
    ).run();
  } finally {
    db.off("query", cancel);
  }
  assert.equal(sends, 0);
  assert.equal((await db("emails").first()).state, "canceled");
});
