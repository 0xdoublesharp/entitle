import { isolatedDatabase } from "./helpers/database.ts";
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import {
  migrate,
  reset,
  createTenant,
  type Tenant,
  type Plan,
  type License,
} from "../src/db.ts";
import { StripeBilling } from "../src/stripe.ts";
import { loadConfig } from "../src/config.ts";
import { Billing } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
const directory = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/saas-stripe-",
);
const database = await isolatedDatabase(`sqlite:${directory}/db`);
const db = database.db;
const config = loadConfig({
  DEPLOYMENT_MODE: "hosted",
    APP_BASE_PATH: "",
  APP_SECRET: "11".repeat(32),
  OPERATOR_TOKEN: "x".repeat(32),
});
const requests: {
  path: string;
  account: string | undefined;
  body: URLSearchParams;
  query: URLSearchParams;
}[] = [];
const list = (url: string, data: unknown[], has_more = false) => ({
  object: "list",
  url,
  data,
  has_more,
});
let duplicatePayment = false;
let providerError = 0;
let failedPath = "/v1/subscriptions/sub_1";
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url!, "http://localhost");
  requests.push({
    path: url.pathname,
    account: req.headers["stripe-account"] as string | undefined,
    body: new URLSearchParams(Buffer.concat(chunks).toString()),
    query: url.searchParams,
  });
  if (providerError && url.pathname === failedPath) {
    res.statusCode = providerError;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "Fixture provider account unavailable",
        },
      }),
    );
    return;
  }
  let data: unknown = {};
  if (url.pathname === "/v1/subscriptions")
    data = url.searchParams.has("starting_after")
      ? list("/v1/subscriptions", [{ id: "sub_2" }])
      : list("/v1/subscriptions", [{ id: "sub_1" }], true);
  else if (url.pathname === "/v1/prices/price_one")
    data = {
      id: "price_one",
      active: true,
      type: "recurring",
      unit_amount: 1000,
      currency: "usd",
      recurring: { interval: "year", interval_count: 1 },
    };
  else if (url.pathname === "/v1/customers" && req.method === "POST")
    data = { id: "cus_1" };
  else if (url.pathname === "/v1/checkout/sessions")
    data = { url: "https://checkout.stripe.test/session", client_secret: "cs_fixture_secret" };
  else if (url.pathname === "/v1/billing_portal/sessions")
    data = { url: "https://billing.stripe.test/portal" };
  else if (url.pathname === "/v1/subscriptions/sub_1")
    data = { id: "sub_1", customer: "cus_1", status: "active" };
  else if (url.pathname === "/v1/customers/cus_1")
    data = { id: "cus_1", email: "buyer@example.test" };
  else if (url.pathname === "/v1/invoices")
    data = list("/v1/invoices", [
      {
        id: "in_1",
        status: "paid",
        currency: "usd",
        amount_paid: 1200,
        status_transitions: { paid_at: 10 },
        created: 9,
      },
    ]);
  else if (url.pathname === "/v1/invoice_payments")
    data = list("/v1/invoice_payments", [
      { id: "ip_1", payment: { charge: "ch_1" } },
      ...(duplicatePayment
        ? [{ id: "ip_duplicate", payment: { charge: "ch_1" } }]
        : []),
    ]);
  else if (url.pathname === "/v1/charges/ch_1")
    data = { id: "ch_1", paid: true, amount_refunded: 300 };
  else if (url.pathname === "/v1/invoices/in_1/lines")
    data = list("/v1/invoices/in_1/lines", [
      {
        id: "il_1",
        amount: 1000,
        parent: { subscription_item_details: {} },
        pricing: { price_details: { price: "price_one" } },
        period: { start: 1, end: 100 },
      },
    ]);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
let alpha: Tenant, beta: Tenant;
function source(tenant: Tenant) {
  const s = new StripeBilling(db, config, tenant);
  s.stripe = new Stripe("sk_test_fixture", {
    host: "127.0.0.1",
    port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  return s;
}
before(async () => {
  await migrate(db);
});
beforeEach(async () => {
  await reset(db);
  requests.length = 0;
  duplicatePayment = false;
  providerError = 0;
  failedPath = "/v1/subscriptions/sub_1";
  alpha = await createTenant(db, {
    id: "a",
    slug: "alpha",
    name: "Alpha",
    stripe_account_id: "acct_alpha",
  });
  beta = await createTenant(db, {
    id: "b",
    slug: "beta",
    name: "Beta",
    stripe_account_id: "acct_beta",
  });
});
after(async () => {
  await database.close();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
const plan = (tenant: Tenant): Plan => ({
  tenant_id: tenant.id,
  id: "one",
  product_id: "prod",
  name: "One",
  site_allowance: 1,
  stripe_price_id: "price_one",
});
test("connected checkout scopes duplicate buyer identities and returns to tenant buyer page", async () => {
  for (const tenant of [alpha, beta]) {
    const s = source(tenant);
    await s.checkout(plan(tenant), "buyer@example.test");
    await s.portal("cus_1");
  }
  assert.equal((await db("customers")).length, 2);
  assert.ok(
    requests
      .filter((r) => r.path === "/v1/checkout/sessions")
      .every(
        (r) =>
          r.body.get("success_url") ===
          `${config.origin}/t/${r.account === "acct_alpha" ? "alpha" : "beta"}?checkout=success`,
      ),
  );
  assert.ok(
    requests
      .filter((r) => r.path === "/v1/billing_portal/sessions")
      .every(
        (r) =>
          r.body.get("return_url") ===
          `${config.origin}/t/${r.account === "acct_alpha" ? "alpha" : "beta"}`,
      ),
  );
  assert.ok(
    requests.every((r) => ["acct_alpha", "acct_beta"].includes(r.account!)),
    JSON.stringify(requests),
  );
  await assert.rejects(
    source(alpha).checkout(plan(beta), "different@example.test"),
    { code: "tenant_denied" },
  );
});
test("hosted fee is server-controlled in both Checkout interfaces and can be set to zero", async () => {
  for (const ui of ["hosted", "elements"] as const) {
    const s = new StripeBilling(db, { ...config, hostedApplicationFeePercent: 0.75, stripePublishableKey: "pk_test_fixture" }, alpha);
    s.stripe = source(alpha).stripe;
    const buyer = await db("customers").where({ tenant_id: alpha.id, email: "fee@example.test" }).first();
    await s.checkout(plan(alpha), "fee@example.test", buyer?.id, ui);
    const call = requests.filter(r => r.path === "/v1/checkout/sessions").at(-1)!;
    assert.equal(call.account, "acct_alpha");
    assert.equal(call.body.get("subscription_data[application_fee_percent]"), "0.75");
  }
  const free = new StripeBilling(db, { ...config, hostedApplicationFeePercent: 0 }, alpha);
  free.stripe = source(alpha).stripe;
  await free.checkout(plan(alpha), "fee@example.test", (await db("customers").where({ tenant_id: alpha.id, email: "fee@example.test" }).first()).id);
  assert.equal(requests.filter(r => r.path === "/v1/checkout/sessions").at(-1)!.body.has("subscription_data[application_fee_percent]"), false);
});
test("standalone Stripe uses the merchant account directly with no application fee or connected Elements context", async () => {
  const tenant = (await db<Tenant>("tenants").where({ id: "primary" }).first())!;
  const s = new StripeBilling(db, { ...config, deploymentMode: "standalone", hostedApplicationFeePercent: 0, stripePublishableKey: "pk_test_fixture" }, tenant);
  s.stripe = source(alpha).stripe;
  const checkout = await s.checkout(plan(tenant), "merchant@example.test", undefined, "elements");
  assert.equal("stripeAccount" in checkout, false);
  await s.portal("cus_1");
  await s.snapshot("sub_1");
  assert.ok(requests.every(r => r.account === undefined));
  assert.equal(requests.find(r => r.path === "/v1/checkout/sessions")!.body.has("subscription_data[application_fee_percent]"), false);
  const other = new StripeBilling(db, { ...config, deploymentMode: "standalone" }, alpha);
  await assert.rejects(other.subscriptionIds(), { code: "standalone_tenant" });
});
test("all pagination retains connected account header and snapshot reports canonical tax-inclusive refund facts", async () => {
  const s = source(alpha);
  assert.deepEqual(await s.subscriptionIds(), ["sub_1", "sub_2"]);
  const snapshot = await s.snapshot("sub_1");
  assert.equal(snapshot.grants.length, 1);
  assert.deepEqual(snapshot.invoices, [
    { invoiceId: "in_1", currency: "usd", paidMinor: 1200, refundedMinor: 300 },
  ]);
  assert.ok(
    requests.every((r) => r.account === "acct_alpha"),
    JSON.stringify(requests),
  );
});
test("every unconnected tenant including primary fails closed before provider HTTP", async () => {
  const unconnected = await createTenant(db, {
    id: "none",
    slug: "none",
    name: "None",
  });
  for (const call of [
    () => source(unconnected).subscriptionIds(),
    () => source(unconnected).portal("cus_1"),
    () => source(unconnected).snapshot("sub_1"),
    () => source(unconnected).checkout(plan(unconnected), "buyer@example.test"),
    () =>
      source(unconnected).resolveSubscription({
        id: "evt",
        type: "customer.created",
        data: { object: {} },
      }),
  ])
    await assert.rejects(call, { code: "stripe_not_connected" });
  assert.equal(requests.length, 0);
  const primary = await db<Tenant>("tenants").where({ id: "primary" }).first();
  await assert.rejects(source(primary!).subscriptionIds(), {
    code: "stripe_not_connected",
  });
  assert.equal(requests.length, 0);
});
test("disconnected and restricted accounts cannot start new sales but retain reconciliation", async () => {
  for (const stripe_status of ["disconnected", "restricted"]) {
    await assert.rejects(
      source({ ...alpha, stripe_status }).checkout(
        plan(alpha),
        "new@example.test",
      ),
      { code: "stripe_not_connected" },
    );
  }
  assert.equal(requests.length, 0);
});

test("duplicate invoice payment references count each canonical charge refund once", async () => {
  duplicatePayment = true;
  assert.deepEqual((await source(alpha).snapshot("sub_1")).invoices, [
    { invoiceId: "in_1", currency: "usd", paidMinor: 1200, refundedMinor: 300 },
  ]);
});

test("canonical provider 403 and 404 failures keep reconciliation retryable and preserve purchased grants", async () => {
  await db("products").insert({
    tenant_id: alpha.id,
    id: "prod",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert(plan(alpha));
  const adapter = source(alpha);
  let now = 2000;
  const licensing = new Licenses(db, config.secret, [], alpha, () => now);
  const billing = new Billing(db, licensing, adapter);
  await billing.reconcile("sub_1");
  const paid = await db<License>("licenses")
    .where({ tenant_id: alpha.id })
    .first();
  assert.ok(paid);
  assert.equal(licensing.entitled(paid), true);
  const grants = await db("grants").where({ tenant_id: alpha.id });
  for (const status of [403, 404]) {
    for (const path of [
      "/v1/subscriptions/sub_1",
      "/v1/customers/cus_1",
      "/v1/invoices",
      "/v1/invoices/in_1/lines",
    ]) {
      providerError = status;
      failedPath = path;
      await assert.rejects(adapter.snapshot("sub_1"), { statusCode: status });
      await billing.enqueueReconcile(["sub_1"]);
      await db("work")
        .where({ tenant_id: alpha.id })
        .update({ available_at: 0 });
      await billing.run((event) => adapter.resolveSubscription(event));
      assert.equal(
        (await db("work").where({ tenant_id: alpha.id }).first()).state,
        "pending",
      );
      assert.deepEqual(
        await db("licenses").where({ tenant_id: alpha.id }).first(),
        paid,
      );
      assert.deepEqual(
        await db("grants").where({ tenant_id: alpha.id }),
        grants,
      );
    }
  }
  providerError = 0;
  await db("work").where({ tenant_id: alpha.id }).update({ available_at: 0 });
  await billing.run((event) => adapter.resolveSubscription(event));
  assert.equal(
    (await db("work").where({ tenant_id: alpha.id }).first()).state,
    "sent",
  );
  const platform = new PlatformBilling(db, config, adapter.stripe);
  await platform.accountEvent({
    id: "evt_disconnect_paid",
    type: "account.application.deauthorized",
    account: "acct_alpha",
    livemode: false,
    data: { object: {} },
  });
  await platform.run();
  const disconnected = await db<Tenant>("tenants")
    .where({ id: alpha.id })
    .first();
  assert.equal(disconnected!.stripe_account_id, "acct_alpha");
  assert.equal(disconnected!.stripe_status, "disconnected");
  const preserved = await db<License>("licenses")
    .where({ tenant_id: alpha.id })
    .first();
  assert.equal(preserved!.paid_through, paid.paid_through);
  assert.equal(licensing.entitled(preserved!), true);
  assert.deepEqual(await db("grants").where({ tenant_id: alpha.id }), grants);
  now = Number(preserved!.paid_through);
  assert.equal(licensing.entitled(preserved!), false);
});

test("new guest checkout claims are issued after local commit but before the first provider request, enabling bounded anonymous retries", async () => {
  const adapter = source(alpha);
  let claim = "";
  providerError = 403;
  failedPath = "/v1/prices/price_one";
  await assert.rejects(
    adapter.checkout(plan(alpha), "buyer@example.test", undefined, "hosted", {
      issueGuestClaim: (id) => {
        claim = id;
        assert.equal(requests.length, 0);
      },
    }),
    { statusCode: 403 },
  );
  const local = await db("customers").where({ tenant_id: alpha.id }).first();
  assert.ok(
    local,
    "Local guest identity must be committed before provider HTTP",
  );
  assert.equal(local.id, claim);
  assert.equal(local.stripe_id, null);
  providerError = 0;
  await assert.rejects(adapter.checkout(plan(alpha), "buyer@example.test"), {
    code: "login_required",
  });
  await assert.rejects(
    adapter.checkout(plan(alpha), "buyer@example.test", undefined, "hosted", {
      guestCustomerId: "foreign",
    }),
    { code: "login_required" },
  );
  assert.deepEqual(
    await adapter.checkout(
      plan(alpha),
      "buyer@example.test",
      undefined,
      "hosted",
      { guestCustomerId: claim },
    ),
    { url: "https://checkout.stripe.test/session" },
  );
  assert.equal(
    (await db("customers").where({ tenant_id: alpha.id })).length,
    1,
  );
  await db("products").insert({
    tenant_id: alpha.id,
    id: "prod",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert(plan(alpha));
  await new Billing(
    db,
    new Licenses(db, config.secret, [], alpha),
    adapter,
  ).reconcile("sub_1");
  await assert.rejects(
    adapter.checkout(plan(alpha), "buyer@example.test", undefined, "hosted", {
      guestCustomerId: claim,
    }),
    { code: "login_required" },
  );
  assert.deepEqual(
    await adapter.checkout(plan(alpha), "buyer@example.test", claim),
    { url: "https://checkout.stripe.test/session" },
  );
});

test("a guest retry loses anonymous authority if payment reconciles while its price request is in flight", async (t) => {
  const adapter = source(alpha);
  let claim = "";
  await adapter.checkout(
    plan(alpha),
    "buyer@example.test",
    undefined,
    "hosted",
    {
      issueGuestClaim: (id) => {
        claim = id;
      },
    },
  );
  await db("products").insert({
    tenant_id: alpha.id,
    id: "prod",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert(plan(alpha));
  const billing = new Billing(
    db,
    new Licenses(db, config.secret, [], alpha),
    adapter,
  );
  const retrieve = adapter.stripe.prices.retrieve.bind(adapter.stripe.prices);
  t.mock.method(
    adapter.stripe.prices,
    "retrieve",
    async (...args: Parameters<typeof retrieve>) => {
      await billing.reconcile("sub_1");
      return retrieve(...args);
    },
  );
  await assert.rejects(
    adapter.checkout(plan(alpha), "buyer@example.test", undefined, "hosted", {
      guestCustomerId: claim,
    }),
    { code: "login_required" },
  );
  assert.equal(
    requests.filter((request) => request.path === "/v1/checkout/sessions")
      .length,
    1,
  );
});
