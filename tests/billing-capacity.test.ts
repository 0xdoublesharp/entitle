import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createDb, createTenant, migrate } from "../src/db.ts";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { DeferredJob } from "../src/queue.ts";
import { primaryTenant } from "./helpers/tenant.ts";
import { loadConfig } from "../src/config.ts";
import { PublisherSandboxes } from "../src/sandboxes.ts";
import { buildApp } from "../src/app.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { StripeBilling } from "../src/stripe.ts";
import Stripe from "stripe";

async function fixture(t: TestContext, sandbox = false) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/billing-capacity-");
  const db = createDb(`sqlite:${root}/db`);
  t.after(async () => {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(db);
  await db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    site_allowance: 1,
    stripe_price_id: "price",
  });
  let authorityId = "primary";
  if (sandbox) {
    const parent = await createTenant(db, {
      id: randomUUID(),
      slug: "parent",
      name: "Parent",
    });
    authorityId = parent.id;
    await db("publisher_sandboxes").insert({
      parent_tenant_id: parent.id,
      sandbox_tenant_id: "primary",
      mode: "fixture",
      created_at: Date.now(),
    });
  }
  await db("tenants")
    .where({ id: authorityId })
    .update({
      exempt: 0,
      trial_ends_at: Date.now() + 86400000,
      paid_through: 0,
    });
  const state: BillingSnapshot = {
    subscriptionId: "sub",
    customerId: "cus",
    email: "buyer@example.test",
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
  const licensing = new Licenses(db, "42".repeat(32), [], primaryTenant);
  const source = { snapshot: async () => structuredClone(state) };
  const billing = new Billing(db, licensing, source);
  return { root, db, authorityId, state, source, licensing, billing };
}

for (const state of ["suspended", "expired"] as const) {
  for (const sandbox of [false, true]) {
    test(`first paid issuance rechecks ${sandbox ? "sandbox parent" : "tenant"} ${state} after the canonical read`, async (t) => {
      const f = await fixture(t, sandbox);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      f.source.snapshot = async () => {
        entered.resolve();
        await release.promise;
        return structuredClone(f.state);
      };
      const pending = f.billing.reconcile("sub");
      await entered.promise;
      await f
        .db("tenants")
        .where({ id: f.authorityId })
        .update(
          state === "suspended" ? { suspended: 1 } : { trial_ends_at: 0 },
        );
      release.resolve();
      await assert.rejects(pending, DeferredJob);
      assert.equal((await f.db("licenses")).length, 0);
      assert.equal((await f.db("grants")).length, 0);
      assert.equal((await f.db("emails")).length, 0);
      assert.equal((await f.db("business_events")).length, 0);
    });
  }
}

test("paid events stay unprocessed beyond the retry window during a capacity hold and recover once", async (t) => {
  const f = await fixture(t, true);
  await f.billing.receive({
    id: "evt_paid",
    type: "invoice.paid",
    data: { object: { id: "invoice", customer: "cus" } },
  });
  const payload = (await f.db("billing_events").first()).payload;
  await f.db("work").update({ created_at: Date.now() - 4 * 86400000 });
  await f.db("tenants").where({ id: f.authorityId }).update({ suspended: 1 });
  await f.billing.run(async () => "sub");
  const held = await f.db("work").first();
  assert.equal(held.state, "pending");
  assert.equal(held.attempts, 0);
  assert.equal(held.last_error, "resource_budget");
  assert.ok(Number(held.available_at) > Date.now());
  assert.equal((await f.db("billing_events").first()).processed_at, null);
  assert.equal((await f.db("billing_events").first()).payload, payload);
  assert.equal((await f.db("licenses")).length, 0);
  assert.equal((await f.db("emails")).length, 0);
  await f.db("tenants").where({ id: f.authorityId }).update({ suspended: 0 });
  await f.db("work").update({ available_at: 0 });
  await f.billing.run(async () => "sub");
  await f.billing.run(async () => "sub");
  assert.equal((await f.db("work").first()).state, "sent");
  assert.ok((await f.db("billing_events").first()).processed_at);
  assert.equal((await f.db("licenses")).length, 1);
  assert.equal((await f.db("grants")).length, 1);
  assert.equal((await f.db("emails")).length, 1);
});

for (const policy of [
  { deploymentMode: "standalone", graceDays: 0, allowed: true },
  { deploymentMode: "hosted", graceDays: 2, allowed: true },
  { deploymentMode: "hosted", graceDays: 0, allowed: false },
] as const) {
  test(`first paid issuance respects ${policy.deploymentMode} mode and ${policy.graceDays} grace days`, async (t) => {
    const f = await fixture(t);
    await f
      .db("tenants")
      .where({ id: f.authorityId })
      .update({
        trial_ends_at: 0,
        paid_through: Date.now() - 86400000,
      });
    const billing = new Billing(f.db, f.licensing, f.source, {
      stripeLiveMode: false,
      purchasePolicy: policy,
    });
    if (policy.allowed) {
      await billing.reconcile("sub");
      assert.equal((await f.db("licenses")).length, 1);
    } else {
      await assert.rejects(billing.reconcile("sub"), DeferredJob);
      assert.equal((await f.db("licenses")).length, 0);
    }
  });
}

for (const state of ["suspended", "expired"] as const) {
  test(`existing paid renewals, refunds and disputes reconcile with ${state} purchase authority`, async (t) => {
    const f = await fixture(t, true);
    await f.billing.reconcile("sub");
    const original = await f.db("licenses").first();
    await f
      .db("tenants")
      .where({ id: f.authorityId })
      .update(state === "suspended" ? { suspended: 1 } : { trial_ends_at: 0 });
    const grant = f.state.grants[0]!;
    f.state.grants.push({
      ...grant,
      id: "renewal",
      invoiceId: "renewal_invoice",
      periodStart: grant.periodEnd,
      periodEnd: grant.periodEnd + 86400000,
    });
    await f.billing.reconcile("sub");
    let license = await f.db("licenses").first();
    assert.equal(license.id, original.id);
    assert.equal(Number(license.paid_through), grant.periodEnd + 86400000);
    assert.equal((await f.db("grants")).length, 2);
    assert.equal((await f.db("emails")).length, 1);
    f.state.suspended = true;
    f.state.fullyRefunded = true;
    await f.billing.reconcile("sub");
    license = await f.db("licenses").first();
    assert.equal(license.suspended, 1);
    assert.equal(license.refund_revoked, 1);
    const newSubscription = new Billing(f.db, f.licensing, {
      snapshot: async () => ({
        ...structuredClone(f.state),
        subscriptionId: "new_sub",
      }),
    });
    await assert.rejects(newSubscription.reconcile("new_sub"), DeferredJob);
    assert.equal((await f.db("licenses")).length, 1);
  });
}

test("suspended sandbox parents deny tenant requests while signed events and internal reconciliation remain durable", async (t) => {
  const f = await fixture(t, true);
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "42".repeat(32),
    OPERATOR_TOKEN: "capacity-operator-fixture".repeat(2),
    DATA_DIR: f.root,
    LOCAL_BILLING: "true",
    STRIPE_TEST_SECRET_KEY: "sk_test_capacity",
    STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_capacity",
    STRIPE_TEST_WEBHOOK_SECRET: "whsec_capacity",
  });
  await f.db("publisher_sandboxes").update({ mode: "stripe" });
  await f.db("tenants").where({ id: f.authorityId }).update({
    suspended: 1,
    stripe_account_id: "acct_parent",
    stripe_status: "connected",
  });
  const sandboxes = new PublisherSandboxes(f.db, config);
  await assert.rejects(sandboxes.runtime(primaryTenant), {
    code: "tenant_suspended",
  });
  const runtime = await sandboxes.runtime(primaryTenant, {
    reconciliation: true,
  });
  assert.equal(runtime.tenant.suspended, 1);
  const app = await buildApp(
    config,
    f.db,
    { send: async () => {} },
    {
      store: new InMemoryArtifactStore(),
      stripeFactory: (tenant) => {
        const stripe = new StripeBilling(f.db, config, tenant);
        stripe.snapshot = async () => structuredClone(f.state);
        stripe.resolveSubscription = async () => "sub";
        return stripe;
      },
    },
  );
  try {
    await app.ready();
    const denied = await app.inject({ url: "/api/v1/tenants/primary/catalog" });
    assert.equal(denied.statusCode, 403, denied.body);
    const payload = JSON.stringify({
      id: "evt_sandbox",
      type: "invoice.paid",
      livemode: false,
      account: "acct_parent",
      data: { object: { id: "invoice", customer: "cus" } },
    });
    const received = await app.inject({
      method: "POST",
      url: "/api/v1/stripe/sandbox-webhook",
      payload,
      headers: {
        "content-type": "application/json",
        "stripe-signature": Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: config.stripeTestWebhookSecret!,
        }),
      },
    });
    assert.equal(received.statusCode, 200, received.body);
    const tick = () =>
      app.inject({
        method: "POST",
        url: "/api/v1/operator/jobs/run",
        payload: {},
        headers: { authorization: `Bearer ${config.operatorToken}` },
      });
    assert.equal((await tick()).statusCode, 200);
    let stored = await f
      .db("billing_events")
      .where({ id: "evt_sandbox" })
      .first();
    assert.equal(stored.processed_at, null);
    assert.equal(
      (await f.db("work").where({ id: "evt_sandbox" }).first()).attempts,
      0,
    );
    await f.db("tenants").where({ id: f.authorityId }).update({ suspended: 0 });
    await f.db("work").update({ available_at: 0 });
    assert.equal((await tick()).statusCode, 200);
    stored = await f.db("billing_events").where({ id: "evt_sandbox" }).first();
    assert.ok(stored.processed_at);
    assert.equal((await f.db("licenses")).length, 1);
  } finally {
    await app.close();
  }
});
