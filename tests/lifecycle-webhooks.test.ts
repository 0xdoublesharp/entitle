import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { BusinessEvents } from "../src/business-events.ts";
import { migrate } from "../src/db.ts";
import { Licenses } from "../src/licensing.ts";
import { Operations } from "../src/operations.ts";
import {
  OutboundWebhooks,
  outboundEventTypes,
} from "../src/outbound-webhooks.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { primaryTenant } from "./helpers/tenant.ts";

test("paid cancellation and paid or complimentary expiration produce stable outbound events", async (t) => {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/lifecycle-webhooks-",
  );
  const { db, close } = await isolatedDatabase(`sqlite:${root}/db`);
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(db);
  const tenant_id = primaryTenant.id,
    secret = "b2".repeat(32),
    now = Date.now(),
    end = now + 86400000;
  await db("products").insert({
    tenant_id,
    id: "product",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert({
    tenant_id,
    id: "plan",
    product_id: "product",
    name: "Plan",
    site_allowance: 1,
    stripe_price_id: "price",
  });
  const snapshot: BillingSnapshot = {
    subscriptionId: "subscription",
    customerId: "stripe-customer",
    email: "buyer@example.test",
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "line",
        invoiceId: "invoice",
        priceId: "price",
        periodStart: now - 1000,
        periodEnd: end,
        paidAt: now,
        settled: true,
      },
    ],
  };
  const licensing = new Licenses(db, secret, [], primaryTenant);
  const billing = new Billing(db, licensing, {
    snapshot: async () => structuredClone(snapshot),
  });
  await billing.reconcile(snapshot.subscriptionId);
  const paid = await db("licenses")
    .where({ subscription_id: snapshot.subscriptionId })
    .first();
  snapshot.billingStatus = "canceled";
  await Promise.all([
    billing.reconcile(snapshot.subscriptionId),
    billing.reconcile(snapshot.subscriptionId),
  ]);
  const canceled = await db("business_events").where({
    tenant_id,
    type: "license.canceled",
  });
  assert.deepEqual(
    canceled.map((row) => row.resource_id),
    [paid.id],
  );

  await db("licenses").insert(
    [
      {
        id: "complimentary",
        provenance: "complimentary",
        billing_status: "complimentary",
        paid_through: 0,
        expires_at: end,
      },
      {
        id: "lifetime",
        provenance: "paid",
        billing_status: "lifetime",
        paid_through: end,
        expires_at: null,
      },
    ].map((row) => ({
      ...row,
      tenant_id,
      customer_id: paid.customer_id,
      product_id: "product",
      site_allowance: 1,
      key_hash: row.id,
      plan_id: row.id === "lifetime" ? "plan" : null,
      subscription_id: row.id === "lifetime" ? "lifetime" : null,
    })),
  );
  const operations = new Operations(db, tenant_id);
  await operations.scanNotifications(now);
  const notices = await operations.notifications(paid.customer_id, now);
  assert.deepEqual(notices.map((row) => row.kind).sort(), [
    "canceled_no_autorenew",
    "expiry_approaching",
  ]);
  assert.equal(
    notices.find((row) => row.licenseId === "complimentary")?.paidThrough,
    end,
  );
  await db("login_tokens").insert({
    tenant_id,
    id: "verified",
    customer_id: paid.customer_id,
    used: 1,
    expires_at: now,
  });
  assert.equal(await operations.enqueueLifecycleEmails(secret, now), 2);
  await operations.scanNotifications(end);
  await operations.scanNotifications(end + 1);
  const expired = await db("business_events")
    .where({ tenant_id, type: "license.expired" })
    .orderBy("resource_id");
  assert.deepEqual(
    expired.map((row) => row.resource_id).sort(),
    [paid.id, "complimentary"].sort(),
  );
  assert.ok(expired.every((row) => Number(row.occurred_at) === end));
  assert.deepEqual(
    (await operations.notifications(paid.customer_id, end)).map(
      (row) => row.kind,
    ),
    ["expired", "expired"],
  );

  const outbound = new OutboundWebhooks(db, tenant_id, secret, {
    now: () => end + 1,
    network: {
      resolve: async () => [{ address: "8.8.8.8", family: 4 }],
      send: async () => 204,
    },
  });
  assert.equal(outboundEventTypes.length, 9);
  await outbound.createEndpoint({
    url: "https://example.test/events",
    events: ["license.canceled", "license.expired"],
  });
  const dispatcher = new BusinessEvents(db, tenant_id, outbound, () => end + 1);
  await dispatcher.dispatch(true);
  await dispatcher.dispatch(true);
  assert.equal(
    (await db("outbound_deliveries").where({ tenant_id })).length,
    3,
  );
});
