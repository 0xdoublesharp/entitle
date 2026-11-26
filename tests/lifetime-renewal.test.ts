import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type Stripe from "stripe";
import { createDb, createTenant, migrate, type Tenant } from "../src/db.ts";
import {
  Billing,
  type BillingSnapshot,
  type BillingEvent,
} from "../src/billing.ts";
import { Licenses, LIFETIME_PAID_THROUGH } from "../src/licensing.ts";
import { StripeBilling } from "../src/stripe.ts";
import { loadConfig } from "../src/config.ts";
import { up as upgrade } from "../src/migrations/023_licensing_commerce_growth.ts";
import {
  importPortability,
  completePortabilityImport,
  Portability,
} from "../src/portability.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { hash } from "../src/crypto.ts";

const lifetime = Date.UTC(9999, 11, 31, 23, 59, 59);

test("a settled lifetime renewal upgrades a complimentary license in place", async (t) => {
  const db = createDb("sqlite::memory:");
  t.after(() => db.destroy());
  await migrate(db);
  const tenant = (await db<Tenant>("tenants")
    .where({ id: "primary" })
    .first())!;
  await upgrade(db);
  assert.equal(LIFETIME_PAID_THROUGH, lifetime);
  const licensing = new Licenses(db, "22".repeat(32), [], tenant);
  await db("products").insert({
    tenant_id: tenant.id,
    id: "product",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert({
    tenant_id: tenant.id,
    id: "plan",
    product_id: "product",
    name: "Lifetime",
    site_allowance: 5,
    stripe_price_id: "price_life",
  });
  const request = {
    email: "buyer@example.test",
    productId: "product",
    siteAllowance: 1,
    expiresAt: Date.now() + 60000,
    requestId: "a8733a44-9bad-49e7-99b8-09751afd1d76",
    confirm: true as const,
  };
  const actor = { type: "seller", id: "seller" } as const;
  const { id, customerId } = await licensing.issueComplimentary(request, actor);
  await db("customers")
    .where({ tenant_id: tenant.id, id: customerId })
    .update({ stripe_id: "cus_buyer" });
  const before = (await db("licenses").where({ id }).first())!;
  await db("installations").insert({
    tenant_id: tenant.id,
    id: "installation",
    license_id: id,
    installation_id: "site_1",
    site_url: "example.test",
    active: 1,
    exempt: 0,
    token_hash: "token-hash",
    token_cipher: "token-cipher",
  });
  const installBefore = await db("installations")
    .where({ license_id: id })
    .first();
  const now = Date.now();
  const snapshot: BillingSnapshot = {
    subscriptionId: "one_time:cs_life",
    oneTimePaymentId: "cs_life",
    renewLicenseId: id,
    customerId: "cus_buyer",
    email: request.email,
    billingStatus: "lifetime",
    suspended: false,
    fullyRefunded: false,
    grants: [],
  };
  const billing = new Billing(db, licensing, {
    snapshot: async () => snapshot,
  });
  await billing.reconcile(snapshot.subscriptionId);
  assert.equal(
    (await db("licenses").where({ id }).first()).provenance,
    "complimentary",
  );
  snapshot.grants.push({
    id: "cs_life",
    invoiceId: "pi_life",
    priceId: "price_life",
    periodStart: now,
    periodEnd: lifetime,
    paidAt: now,
    settled: true,
  });
  await billing.reconcile(snapshot.subscriptionId);
  await billing.reconcile(snapshot.subscriptionId);
  const renewed = await db("licenses").where({ id }).first();
  assert.equal(renewed.key_hash, before.key_hash);
  assert.equal(renewed.provenance, "paid");
  assert.equal(renewed.expires_at, null);
  assert.equal(renewed.subscription_id, null);
  assert.equal(renewed.one_time_payment_id, "cs_life");
  assert.equal(renewed.site_allowance, 5);
  assert.equal(renewed.paid_through, lifetime);
  assert.equal((await db("licenses")).length, 1);
  assert.deepEqual(
    await db("installations").where({ license_id: id }).first(),
    installBefore,
  );
  assert.equal((await licensing.issueComplimentary(request, actor)).id, id);
  assert.equal((await db("emails").where({ kind: "license_key" })).length, 1);
  assert.equal(
    (
      await db("business_events").where({
        resource_id: id,
        type: "license.renewed",
      })
    ).length,
    1,
  );
  assert.equal((await db("grants").where({ license_id: id })).length, 1);
  snapshot.fullyRefunded = true;
  await billing.reconcile(snapshot.subscriptionId);
  assert.equal((await db("licenses").where({ id }).first()).refund_revoked, 1);
});

test("a paid renewal replaces the old subscription without reissuing on an old event", async (t) => {
  const db = createDb("sqlite::memory:");
  t.after(() => db.destroy());
  await migrate(db);
  const tenant = (await db<Tenant>("tenants")
    .where({ id: "primary" })
    .first())!;
  const licensing = new Licenses(db, "22".repeat(32), [], tenant);
  await db("products").insert({
    tenant_id: tenant.id,
    id: "product",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert({
    tenant_id: tenant.id,
    id: "plan",
    product_id: "product",
    name: "Annual",
    site_allowance: 5,
    stripe_price_id: "price_year",
  });
  const now = Date.now();
  const snapshot: BillingSnapshot = {
    subscriptionId: "sub_old",
    customerId: "cus_buyer",
    email: "buyer@example.test",
    billingStatus: "canceled",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "il_old",
        invoiceId: "in_old",
        priceId: "price_year",
        periodStart: now - 2000,
        periodEnd: now - 1000,
        paidAt: now - 2000,
        settled: true,
      },
    ],
  };
  const billing = new Billing(db, licensing, {
    snapshot: async () => snapshot,
  });
  await billing.reconcile("sub_old");
  const old = await db("licenses").first();
  const oldSnapshot = { ...snapshot };
  Object.assign(snapshot, {
    subscriptionId: "sub_new",
    renewLicenseId: old.id,
    billingStatus: "active",
    grants: [
      {
        ...snapshot.grants[0],
        id: "il_new",
        invoiceId: "in_new",
        periodStart: now,
        periodEnd: now + 60000,
        paidAt: now,
      },
    ],
  });
  await billing.reconcile("sub_new");
  Object.assign(snapshot, oldSnapshot, {
    fullyRefunded: true,
    renewLicenseId: undefined,
  });
  await billing.reconcile("sub_old");
  const licenses = await db("licenses");
  assert.equal(licenses.length, 1);
  assert.equal(licenses[0].id, old.id);
  assert.equal(licenses[0].key_hash, old.key_hash);
  assert.equal(licenses[0].subscription_id, "sub_new");
  assert.equal(licenses[0].refund_revoked, 0);
  assert.equal((await db("emails").where({ kind: "license_key" })).length, 1);
});

test("Stripe payment Checkout and bounded worker reconcile captured cash, disputes, and refunds", async (t) => {
  const db = createDb("sqlite::memory:");
  t.after(() => db.destroy());
  await migrate(db);
  const tenant = await createTenant(db, {
    id: "merchant",
    slug: "merchant",
    name: "Merchant",
    stripe_account_id: "acct_merchant",
    exempt: 1,
  });
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "22".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
    HOSTED_APPLICATION_FEE_PERCENT: "5",
  });
  const licensing = new Licenses(db, config.secret, [], tenant);
  const plan = {
    tenant_id: tenant.id,
    id: "plan",
    product_id: "product",
    name: "Lifetime",
    site_allowance: 5,
    stripe_price_id: "price_life",
  };
  await db("products").insert({
    tenant_id: tenant.id,
    id: plan.product_id,
    slug: "product",
    name: "Product",
  });
  await db("plans").insert(plan);
  const request = {
    email: "buyer@example.test",
    productId: plan.product_id,
    siteAllowance: 1,
    expiresAt: Date.now() + 60000,
    requestId: randomUUID(),
    confirm: true as const,
  };
  const { id, customerId } = await licensing.issueComplimentary(request, {
    type: "seller",
    id: "seller",
  });
  await db("customers")
    .where({ tenant_id: tenant.id, id: customerId })
    .update({ stripe_id: "cus_buyer" });

  const session = {
    id: "cs_life",
    mode: "payment",
    customer: "cus_buyer",
    payment_status: "paid",
    currency: "usd",
    amount_total: 29900,
    payment_intent: "pi_life",
    metadata: { renew_license_id: id },
    line_items: {
      data: [{ id: "li_life", price: { id: "price_life" } }],
      has_more: false,
    },
  };
  const charge = {
    id: "ch_life",
    paid: true,
    amount_captured: 29900,
    amount_refunded: 0,
    created: Math.floor(Date.now() / 1000),
    disputed: false,
    payment_intent: "pi_life",
  };
  let disputeStatus = "needs_response";
  let checkoutParams: Stripe.Checkout.SessionCreateParams | undefined;
  let reads = 0;
  const read =
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A) => {
      reads++;
      return fn(...args);
    };
  const list = <V>(data: V[]) => ({
    data,
    has_more: false,
    async *[Symbol.asyncIterator]() {
      yield* data;
    },
  });
  const stripe = {
    prices: {
      retrieve: async () => ({
        type: "one_time",
        active: true,
        unit_amount: 29900,
      }),
    },
    customers: {
      retrieve: read(async () => ({ id: "cus_buyer", email: request.email })),
    },
    invoicePayments: { list: read(() => list([])) },
    charges: {
      retrieve: read(async () => charge),
      list: read(async () => list([charge])),
    },
    refunds: {
      retrieve: read(async () => ({
        payment_intent: "pi_life",
        charge: "ch_life",
      })),
    },
    disputes: {
      retrieve: read(async () => ({
        payment_intent: "pi_life",
        charge: "ch_life",
      })),
      list: read(async () => list([{ id: "dp_life", status: disputeStatus }])),
    },
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          checkoutParams = params;
          return { url: "https://checkout.stripe.com/local" };
        },
        retrieve: read(async () => session),
        list: read(async (params: Stripe.Checkout.SessionListParams) => {
          assert.deepEqual(params, { payment_intent: "pi_life", limit: 1 });
          return list([session]);
        }),
      },
    },
  } as unknown as Stripe;
  const newSource = () => {
    const source = new StripeBilling(db, config, tenant);
    source.stripe = stripe;
    return source;
  };
  const source = newSource();
  const checkout = (buyer?: string, productId = plan.product_id) =>
    source.checkout(
      { ...plan, product_id: productId },
      request.email,
      buyer,
      "hosted",
      {},
      { renewLicenseId: id },
    );
  await assert.rejects(checkout(), { code: "login_required" });
  await assert.rejects(checkout("another_customer"), { code: "not_found" });
  await assert.rejects(checkout(customerId, "another_product"), {
    code: "renewal_product_mismatch",
  });
  await checkout(customerId);
  assert.equal(checkoutParams?.mode, "payment");
  assert.deepEqual(checkoutParams?.line_items, [
    { price: plan.stripe_price_id, quantity: 1 },
  ]);
  assert.deepEqual(checkoutParams?.metadata, {
    product_id: plan.product_id,
    plan_id: plan.id,
    renew_license_id: id,
  });
  assert.deepEqual(checkoutParams?.payment_intent_data, {
    metadata: checkoutParams?.metadata,
    application_fee_amount: 1495,
  });

  const target = "one_time:cs_life";
  charge.amount_captured = 0;
  assert.equal((await source.snapshot(target)).grants.length, 0);
  charge.amount_captured = 29900;
  session.amount_total = 0;
  assert.equal((await source.snapshot(target)).grants.length, 0);
  session.amount_total = 29900;

  const event = (type: string, objectId: string): BillingEvent => ({
    id: randomUUID(),
    type,
    data: { object: { id: objectId, customer: session.customer } },
  });
  const process = async (e: BillingEvent) => {
    assert.equal(await source.resolveSubscription(e), target);
    await new Billing(db, licensing, source).receive(e);
    for (let attempt = 0; attempt < 15; attempt++) {
      const restarted = newSource();
      const billing = new Billing(db, licensing, restarted);
      const before = reads;
      await billing.run((value) => restarted.resolveSubscription(value), {
        maxRequests: 1,
        budgetMs: 1000,
      });
      assert.ok(reads - before <= 1);
      const job = await db("work").where({ id: e.id }).first();
      if (job.state === "sent") return;
      assert.equal(job.attempts, 0, job.last_error);
      await db("work")
        .where({ id: e.id, state: "pending" })
        .update({ available_at: 0 });
    }
    assert.fail("event did not finish after restarting each bounded turn");
  };
  await process(event("checkout.session.completed", session.id));
  assert.equal(
    (await db("licenses").where({ id }).first()).paid_through,
    lifetime,
  );
  await assert.rejects(checkout(customerId), { code: "renewal_not_allowed" });
  charge.disputed = true;
  await process(event("charge.dispute.created", "dp_life"));
  assert.equal((await db("licenses").where({ id }).first()).suspended, 1);
  disputeStatus = "won";
  await process(event("charge.dispute.closed", "dp_life"));
  assert.equal((await db("licenses").where({ id }).first()).suspended, 0);
  charge.amount_refunded = 1000;
  await process(event("refund.updated", "re_life"));
  assert.equal((await db("licenses").where({ id }).first()).refund_revoked, 0);
  charge.amount_refunded = charge.amount_captured;
  await process(event("charge.refunded", charge.id));
  assert.equal((await db("licenses").where({ id }).first()).refund_revoked, 1);
  assert.equal(
    (await db("invoice_metrics").where({ invoice_id: "pi_life" }).first())
      .refunded_minor,
    29900,
  );
  assert.equal((await db("grants").where({ license_id: id })).length, 1);
  assert.equal((await db("emails").where({ kind: "license_key" })).length, 1);
});

test("portability retains lifetime checkout identity, promotion settings, and complimentary issuance history", async (t) => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/lifetime-transfer-");
  const source = createDb("sqlite::memory:");
  const destination = createDb("sqlite::memory:");
  const sourceSecret = "2".repeat(64),
    destinationSecret = "4".repeat(64);
  const store = new InMemoryArtifactStore();
  const portability = new Portability({
    db: source,
    secret: sourceSecret,
    store,
    directory: `${root}/exports`,
  });
  t.after(async () => {
    await portability.close();
    await source.destroy();
    await destination.destroy();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(source);
  await migrate(destination);
  const tenant = await createTenant(source, {
    id: randomUUID(),
    slug: "merchant",
    name: "Merchant",
    stripe_account_id: "acct_merchant",
    allow_promotion_codes: 1,
  });
  const product = randomUUID(),
    plan = randomUUID(),
    customer = randomUUID(),
    license = randomUUID();
  const owned = { tenant_id: tenant.id };
  await source("products").insert({
    ...owned,
    id: product,
    slug: "product",
    name: "Product",
  });
  await source("plans").insert({
    ...owned,
    id: plan,
    product_id: product,
    name: "Lifetime",
    site_allowance: 5,
    stripe_price_id: "price_life",
    billing_interval: "lifetime",
    unit_amount: 29900,
    currency: "usd",
  });
  await source("customers").insert({
    ...owned,
    id: customer,
    email: "buyer@example.test",
    stripe_id: "cus_buyer",
  });
  const converted = {
    ...owned,
    id: license,
    customer_id: customer,
    product_id: product,
    plan_id: plan,
    site_allowance: 5,
    key_hash: hash("paid-key"),
    billing_status: "lifetime",
    paid_through: lifetime,
    one_time_payment_id: "cs_life",
    subscription_id: null,
    provenance: "paid",
    complimentary_request_id: randomUUID(),
    complimentary_request_hash: hash("issued"),
    issued_by: "seller",
    issued_at: 1,
  };
  await source("licenses").insert(converted);
  await assert.rejects(
    source("licenses").insert({
      ...converted,
      id: randomUUID(),
      key_hash: hash("other-key"),
      complimentary_request_id: null,
    }),
    /unique/i,
  );
  const passphrase = "lifetime transfer phrase";
  const bundle = await portability.createExport(tenant.id, passphrase);
  const bundleDirectory = `${root}/transfer`;
  await mkdir(bundleDirectory, { mode: 0o700 });
  await writeFile(
    `${bundleDirectory}/manifest.entitle`,
    await portability.openExport(tenant.id, bundle.id, "manifest"),
    { mode: 0o600 },
  );
  await importPortability({
    db: destination,
    store: new InMemoryArtifactStore(),
    secret: destinationSecret,
    directory: `${root}/import`,
    bundleDirectory,
    passphrase,
    expectedStripeAccountId: "acct_merchant",
    deploymentMode: "standalone",
    verifyDestinationEmpty: async () => {},
  });
  const saved = await destination("licenses").where({ id: license }).first();
  assert.equal(saved.one_time_payment_id, "cs_life");
  assert.equal(
    saved.complimentary_request_id,
    converted.complimentary_request_id,
  );
  assert.equal(saved.paid_through, lifetime);
  assert.equal(
    (await destination("tenants").where({ id: "primary" }).first())
      .allow_promotion_codes,
    1,
  );
  await completePortabilityImport({
    db: destination,
    secret: destinationSecret,
    expectedStripeAccountId: "acct_merchant",
    reconcile: async ({ subscriptionIds }) =>
      assert.deepEqual(subscriptionIds, ["one_time:cs_life"]),
  });
});
