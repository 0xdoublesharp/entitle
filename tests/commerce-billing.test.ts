import test, { before, beforeEach, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import { migrate, createTenant, type Tenant } from "../src/db.ts";
import { up } from "../src/migrations/008_commerce.ts";
import { loadConfig } from "../src/config.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { featureEntitlements } from "../src/plan-features.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import type { SellerSession } from "../src/platform-auth.ts";

const root = await mkdtemp(
  `${process.env.TMPDIR ?? "/Volumes/Scratch/entitle/tmp"}/commerce-billing-`,
);
const fixture = await isolatedDatabase(`sqlite:${root}/db`),
  db = fixture.db;
const config = {
  ...loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_BASE_PATH: "",
    APP_SECRET: "55".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
  }),
  platformPriceId: "price_starter",
  platformProStripePriceId: "price_pro",
};
const routes = new Map<
  string,
  (body: URLSearchParams, query: URLSearchParams) => unknown
>();
const requests: {
  path: string;
  body: URLSearchParams;
  account: unknown;
  key: unknown;
}[] = [];
const list = (url: string, data: unknown[]) => ({
  object: "list",
  url,
  data,
  has_more: false,
});
const disconnect = Symbol("disconnect before Checkout execution");
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url!, "http://fixture"),
    body = new URLSearchParams(Buffer.concat(chunks).toString());
  requests.push({
    path: url.pathname,
    body,
    account: req.headers["stripe-account"],
    key: req.headers["idempotency-key"],
  });
  const route = routes.get(`${req.method} ${url.pathname}`);
  res.setHeader("content-type", "application/json");
  if (!route) {
    res.statusCode = 404;
    res.end(
      JSON.stringify({
        error: { message: `Unexpected fixture ${url.pathname}` },
      }),
    );
    return;
  }
  const result = await route(body, url.searchParams);
  if (result === disconnect) {
    req.socket.destroy();
    return;
  }
  res.end(JSON.stringify(result));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const stripe = new Stripe("sk_test_fixture", {
  host: "127.0.0.1",
  port: (server.address() as { port: number }).port,
  protocol: "http",
  maxNetworkRetries: 0,
});
let billing: PlatformBilling, tenant: Tenant, seller: SellerSession;
const now = Math.floor(Date.now() / 1000),
  end = now + 86400;
let status = "active",
  price: any,
  invoice: any,
  line: any,
  refund = 0,
  disputed = false,
  disputeStatus = "needs_response";
before(async () => {
  await migrate(db);
  await up(db);
  await (
    await import("../src/migrations/013_platform_price_history.ts")
  ).up(db);
});
beforeEach(async () => {
  await db("platform_price_history").delete();
  await db("platform_grants").delete();
  await db("platform_checkouts").delete();
  await db("audit_events").delete();
  await db("seller_memberships").delete();
  await db("seller_sessions").delete();
  await db("seller_users").delete();
  await db("tenants").whereNot({ id: "primary" }).delete();
  await db("locks")
    .where("id", "like", "%:%")
    .whereNot("id", "like", "primary:%")
    .delete();
  tenant = await createTenant(db, {
    id: "pro",
    slug: "pro",
    name: "Pro",
    platform_customer_id: "cus_pro",
    platform_subscription_id: "sub_pro",
    max_products: 1,
    max_storage_bytes: 10,
  });
  const user = {
    id: "owner",
    email: "owner@example.test",
    verified_at: 1,
    created_at: 1,
  };
  await db("seller_users").insert(user);
  await db("seller_sessions").insert({
    id: "session",
    user_id: user.id,
    expires_at: Date.now() + 60000,
  });
  await db("seller_memberships").insert({
    tenant_id: tenant.id,
    user_id: user.id,
    role: "owner",
    created_at: 1,
  });
  seller = { user, sessionHash: "session", csrfToken: "csrf" };
  billing = new PlatformBilling(db, config, stripe);
  routes.clear();
  routes.set("GET /v1/billing_portal/configurations", () =>
    list("/v1/billing_portal/configurations", []),
  );
  requests.length = 0;
  status = "active";
  refund = 0;
  disputed = false;
  disputeStatus = "needs_response";
  price = {
    id: "price_pro",
    active: true,
    type: "recurring",
    livemode: false,
    unit_amount: 100,
    recurring: { interval: "month", interval_count: 1 },
  };
  invoice = {
    id: "in_pro",
    status: "paid",
    amount_paid: 100,
    customer: "cus_pro",
    parent: { subscription_details: { subscription: "sub_pro" } },
    livemode: false,
  };
  line = {
    id: "il_pro",
    amount: 100,
    pricing: { price_details: { price: "price_pro" } },
    parent: { subscription_item_details: {} },
    period: { start: now - 100, end },
  };
  routes.set("GET /v1/prices/price_pro", () => price);
  routes.set("GET /v1/prices/price_starter", () => ({
    ...price,
    id: "price_starter",
  }));
  routes.set("GET /v1/subscriptions/sub_pro", () => ({
    id: "sub_pro",
    customer: "cus_pro",
    status,
    livemode: false,
  }));
  routes.set("GET /v1/subscriptions", () => list("/v1/subscriptions", []));
  routes.set("GET /v1/invoices", () => list("/v1/invoices", [invoice]));
  routes.set("GET /v1/invoices/in_pro/lines", () =>
    list("/v1/invoices/in_pro/lines", [line]),
  );
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", [
      { id: "inpay", payment: { payment_intent: "pi_pro" } },
    ]),
  );
  routes.set("GET /v1/charges", () =>
    list("/v1/charges", [
      { id: "ch_pro", paid: true, amount_refunded: refund, disputed },
    ]),
  );
  routes.set("GET /v1/disputes", () =>
    list("/v1/disputes", [{ id: "dp_pro", status: disputeStatus }]),
  );
  routes.set("POST /v1/checkout/sessions", () => ({
    id: "cs_pro",
    url: "https://checkout.stripe.test/pro",
  }));
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.close();
  await rm(root, { recursive: true, force: true });
});
const current = () => db("tenants").where({ id: tenant.id }).first();

test("monthly Pro checkout uses only server price and validates paid monthly recurrence", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: null });
  tenant = (await current())!;
  for (const change of [
    { unit_amount: 0 },
    { recurring: { interval: "year", interval_count: 1 } },
    { recurring: { interval: "month", interval_count: 2 } },
    { active: false },
    { type: "one_time" },
  ]) {
    const valid = price;
    price = { ...valid, ...change };
    await assert.rejects(billing.checkout(tenant, seller, "pro"), {
      code: "platform_price",
    });
    price = valid;
  }
  await billing.checkout(tenant, seller, "pro");
  assert.equal(
    requests
      .find((r) => r.path === "/v1/checkout/sessions")!
      .body.get("line_items[0][price]"),
    "price_pro",
  );
  assert.ok(requests.every((r) => r.account === undefined));
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
});

test("Starter checkout requires a positive recurring price", async () => {
  price.unit_amount = 0;
  await assert.rejects(billing.checkout(tenant, seller, "starter"), {
    code: "platform_price",
  });
  assert.equal(requests.some(({ path }) => path === "/v1/checkout/sessions"), false);
});

test("Pro includes prepaid contiguous renewals and delays future-only grants until their start", async () => {
  line.period.start = now + 10;
  await billing.reconcile(tenant.id);
  let paid = (await current())!;
  assert.equal(Number(paid.pro_period_start), (now + 10) * 1000);
  assert.equal(Number(paid.pro_paid_through), end * 1000);
  assert.equal(featureEntitlements(config, paid).automations, false);

  line.period.start = now - 100;
  const renewal = { ...line, id: "il_next", period: { start: end, end: end + 86400 } };
  const afterGap = { ...line, id: "il_later", period: { start: end + 86401, end: end + 172800 } };
  routes.set("GET /v1/invoices/in_pro/lines", () =>
    list("/v1/invoices/in_pro/lines", [line, renewal, afterGap]),
  );
  await billing.reconcile(tenant.id);
  paid = (await current())!;
  assert.equal(Number(paid.pro_period_start), (now - 100) * 1000);
  assert.equal(Number(paid.pro_paid_through), (end + 86400) * 1000);
  assert.equal(featureEntitlements(config, paid).automations, true);
});

test("full cash refund of a mixed cash and credit invoice restores trial quotas", async () => {
  invoice.total = 200;
  await billing.reconcile(tenant.id);
  assert.equal(featureEntitlements(config, (await current())!).automations, true);
  refund = 100;
  await billing.reconcile(tenant.id);
  const trial = (await current())!;
  assert.equal(featureEntitlements(config, trial).automations, false);
  assert.equal(trial.max_products, 3);
  assert.equal(trial.max_storage_bytes, config.trialStorageBytes);
});

test("only durable paid Pro invoices grant Pro and cancellation or downgrade preserves paid period", async () => {
  invoice.status = "open";
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  assert.equal((await current())!.max_products, 1);
  invoice.status = "paid";
  await billing.reconcile(tenant.id);
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    true,
  );
  assert.equal((await db("platform_grants")).length, 1);
  status = "canceled";
  line = {
    ...line,
    id: "il_starter",
    pricing: { price_details: { price: "price_starter" } },
    period: { start: now - 50, end: end + 86400 },
  };
  await billing.reconcile(tenant.id);
  const paid = await current();
  assert.equal(paid!.pro_paid_through, end * 1000);
  assert.equal(paid!.billing_status, "canceled");
  assert.equal(featureEntitlements(config, paid!).automations, true);
  assert.equal((await db("licenses")).length, 0);
});

test("full refunds and losing disputes revoke the affected paid grant but leave core buyers available", async () => {
  await billing.reconcile(tenant.id);
  refund = 50;
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    true,
  );
  refund = 100;
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  assert.equal(featureEntitlements(config, (await current())!).licensing, true);
  refund = 0;
  disputed = true;
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  disputeStatus = "won";
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    true,
  );
});

test("out-of-order events reconcile canonical state once and never grant an unpaid upgrade", async () => {
  invoice.status = "open";
  for (const event of [
    { id: "evt_new", type: "customer.subscription.updated" },
    { id: "evt_old", type: "invoice.paid" },
    { id: "evt_new", type: "customer.subscription.updated" },
  ])
    await billing.receive({
      ...event,
      livemode: false,
      data: { object: { customer: "cus_pro" } },
    });
  await billing.run();
  assert.equal((await db("platform_events")).length, 2);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  assert.equal((await db("platform_grants")).length, 0);
});

test("payment evidence deduplicates charges, supports direct charges and fails closed for unresolved disputes", async () => {
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", [
      { id: "first", payment: { charge: { id: "ch_direct" } } },
      { id: "duplicate", payment: { charge: "ch_direct" } },
      { id: "unpaid", payment: { charge: "ch_unpaid" } },
      { id: "external", payment: { type: "payment_record" } },
    ]),
  );
  routes.set("GET /v1/charges/ch_direct", () => ({
    id: "ch_direct",
    paid: true,
    amount_refunded: 50,
    disputed,
  }));
  routes.set("GET /v1/charges/ch_unpaid", () => ({
    id: "ch_unpaid",
    paid: false,
    amount_refunded: 1000,
    disputed: false,
  }));
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    true,
  );
  disputed = true;
  routes.set("GET /v1/disputes", () => list("/v1/disputes", []));
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
});

test("missing Pro configuration and free or incomplete prices cannot start new Pro checkout", async () => {
  for (const change of [{ unit_amount: null }, { recurring: null }]) {
    const valid = price;
    price = { ...valid, ...change };
    await assert.rejects(billing.checkout(tenant, seller, "pro"), {
      code: "platform_price",
    });
    price = valid;
    assert.equal((await db("platform_grants")).length, 0);
  }
  const absent = { ...config, platformProStripePriceId: "" };
  await assert.rejects(
    new PlatformBilling(db, absent, stripe).checkout(tenant, seller, "pro"),
    { code: "platform_price" },
  );
  const alias = { ...config, platformPriceId: "price_pro" };
  await assert.rejects(
    new PlatformBilling(db, alias, stripe).checkout(tenant, seller, "pro"),
    { code: "platform_price" },
  );
});

test("a stale snapshot cannot restore Pro after a newer full-refund snapshot commits", async () => {
  await billing.reconcile(tenant.id);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  routes.set("GET /v1/charges", async () => {
    const snapshot = {
      id: "ch_pro",
      paid: true,
      amount_refunded: refund,
      disputed: false,
    };
    if (++calls === 1) {
      entered.resolve();
      await release.promise;
    }
    return list("/v1/charges", [snapshot]);
  });
  const stale = billing.reconcile(tenant.id);
  await entered.promise;
  try {
    refund = 100;
    await billing.reconcile(tenant.id);
  } finally {
    release.resolve();
  }
  await stale;
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
});

test("mapping changes during a provider snapshot reject the unowned billing write", async () => {
  routes.set("GET /v1/invoices", async () => {
    await db("tenants")
      .where({ id: tenant.id })
      .update({ platform_subscription_id: "sub_replaced" });
    return list("/v1/invoices", [invoice]);
  });
  await assert.rejects(billing.reconcile(tenant.id), {
    code: "platform_customer_conflict",
  });
  assert.equal((await db("platform_grants")).length, 0);
});

test("canonical refund and dispute webhooks find the platform tenant without customer metadata", async () => {
  await billing.reconcile(tenant.id);
  routes.set("GET /v1/disputes/dp_event", () => ({
    id: "dp_event",
    charge: { id: "ch_event" },
  }));
  routes.set("GET /v1/refunds/re_event", () => ({
    id: "re_event",
    charge: "ch_event",
  }));
  routes.set("GET /v1/refunds/re_unbound", () => ({
    id: "re_unbound",
    charge: null,
  }));
  routes.set("GET /v1/refunds/re_customer", () => ({
    id: "re_customer",
    customer: "cus_pro",
    charge: null,
  }));
  routes.set("GET /v1/refunds/re_intent", () => ({
    id: "re_intent",
    customer: null,
    charge: null,
    payment_intent: { id: "pi_event" },
  }));
  routes.set("GET /v1/payment_intents/pi_event", () => ({
    id: "pi_event", customer: "cus_pro", livemode: false,
  }));
  routes.set("GET /v1/charges/ch_event", () => ({
    id: "ch_event",
    customer: { id: "cus_pro" },
    livemode: false,
  }));
  for (const [type, id] of [
    ["charge.dispute.created", "dp_event"],
    ["charge.refunded", "ch_event"],
    ["refund.updated", "re_event"],
    ["refund.created", "re_customer"],
    ["charge.refund.updated", "re_intent"],
    ["refund.updated", "re_unbound"],
  ]) {
    disputed = true;
    const eventId = `evt_${id}`;
    await billing.receive({
      id: eventId,
      type: type!,
      livemode: false,
      data: { object: { id, customer: "cus_spoofed" } },
    });
    await billing.run();
    assert.equal(
      featureEntitlements(config, (await current())!).automations,
      false,
    );
    assert.ok(
      (await db("platform_events").where({ id: eventId }).first()).processed_at,
    );
  }
});

for (const first of ["starter", "pro"] as const)
  for (const sessionStatus of ["expired", "complete"] as const)
    test(`H1 ${first} Checkout can switch tier after ${sessionStatus} provider session`, async () => {
      await db("tenants")
        .where({ id: tenant.id })
        .update({ platform_subscription_id: null });
      tenant = (await current())!;
      await billing.checkout(tenant, seller, first);
      const original = await db("platform_checkouts")
        .where({ tenant_id: tenant.id })
        .first();
      routes.set("GET /v1/checkout/sessions/cs_pro", () => ({
        id: "cs_pro",
        customer: "cus_pro",
        mode: "subscription",
        status: sessionStatus,
        livemode: false,
        subscription: "sub_pro",
      }));
      status = "canceled";
      const next = first === "starter" ? "pro" : "starter";
      await billing.checkout(tenant, seller, next);
      const guard = await db("platform_checkouts")
        .where({ tenant_id: tenant.id })
        .first();
      assert.equal(
        guard.price_id,
        next === "pro" ? "price_pro" : "price_starter",
      );
      assert.notEqual(guard.id, original.id);
      assert.equal(
        requests
          .filter((r) => r.path === "/v1/checkout/sessions")
          .at(-1)!
          .body.get("line_items[0][price]"),
        guard.price_id,
      );
    });

test("H1 another tier cannot replace an open or unresolved Checkout attempt", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: null });
  tenant = (await current())!;
  await billing.checkout(tenant, seller, "starter");
  routes.set("GET /v1/checkout/sessions/cs_pro", () => ({
    id: "cs_pro",
    customer: "cus_pro",
    mode: "subscription",
    status: "open",
    livemode: false,
    url: "https://checkout.stripe.test/starter",
  }));
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    code: "platform_checkout_changed",
  });
  await db("platform_checkouts")
    .where({ tenant_id: tenant.id })
    .update({ session_id: null });
  routes.set("GET /v1/checkout/sessions", () =>
    list("/v1/checkout/sessions", []),
  );
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    code: "platform_checkout_pending",
  });
  assert.equal(
    (await db("platform_checkouts").where({ tenant_id: tenant.id }).first())
      .price_id,
    "price_starter",
  );
});

test("M4 archiving a Pro price cannot block renewal, refund or dispute reconciliation", async () => {
  await billing.reconcile(tenant.id);
  price.active = false;
  line = {
    ...line,
    id: "il_renewal",
    period: { start: now - 10, end: end + 86400 },
  };
  await billing.reconcile(tenant.id);
  assert.equal((await current())!.pro_paid_through, (end + 86400) * 1000);
  refund = 100;
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
});

test("M4 rotated configuration preserves server-verified old tier renewal and duplicate-subscription protection", async () => {
  await billing.reconcile(tenant.id);
  const rotated = new PlatformBilling(
    db,
    { ...config, platformProStripePriceId: "price_pro_new" },
    stripe,
  );
  line = {
    ...line,
    id: "il_rotated_renewal",
    period: { start: now - 10, end: end + 86400 },
  };
  await rotated.reconcile(tenant.id);
  assert.equal((await current())!.pro_paid_through, (end + 86400) * 1000);
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: null });
  routes.set("GET /v1/prices/price_pro_new", () => ({
    ...price,
    id: "price_pro_new",
  }));
  routes.set("GET /v1/subscriptions", () =>
    list("/v1/subscriptions", [
      {
        id: "sub_pro",
        customer: "cus_pro",
        status: "active",
        items: { data: [{ price: { id: "price_pro" } }] },
      },
    ]),
  );
  await assert.rejects(rotated.checkout((await current())!, seller, "pro"), {
    code: "platform_subscription_exists",
  });
});

test("M4 legacy paid tiers are seeded only after canonical Stripe mode verification and remain immutable", async () => {
  await billing.reconcile(tenant.id);
  await db("platform_price_history").delete();
  const rotated = new PlatformBilling(
    db,
    { ...config, platformProStripePriceId: "price_pro_new" },
    stripe,
  );
  price.active = false;
  await rotated.reconcile(tenant.id);
  assert.equal(
    (
      await db("platform_price_history")
        .where({ tenant_id: tenant.id, price_id: "price_pro" })
        .first()
    ).tier,
    "pro",
  );
  price.active = true;
  await assert.rejects(
    new PlatformBilling(
      db,
      { ...config, platformProStripePriceId: "", platformPriceId: "price_pro" },
      stripe,
    ).checkout(tenant, seller, "starter"),
    { code: "platform_price_history" },
  );
  await db("platform_price_history").delete();
  price.livemode = true;
  await assert.rejects(rotated.reconcile(tenant.id), { code: "stripe_mode" });
  assert.equal((await db("platform_price_history")).length, 0);
});

test("M5 canonical applied account credit settles a positive invoice without new cash, free coupons or deferred debits do not", async () => {
  invoice = {
    ...invoice,
    amount_paid: 0,
    amount_due: 0,
    amount_remaining: 0,
    total: 100,
    currency: "usd",
    starting_balance: -100,
    ending_balance: 0,
  };
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", []),
  );
  const transaction = {
    id: "cbtx_applied",
    type: "applied_to_invoice",
    amount: 100,
    invoice: "in_pro",
    customer: "cus_pro",
    currency: "usd",
    livemode: false,
  };
  let ledger: unknown[] = [
    { ...transaction, id: "wrong-customer", customer: "cus_other" },
    { ...transaction, id: "wrong-invoice", invoice: "in_other" },
    { ...transaction, id: "wrong-currency", currency: "eur" },
    transaction,
  ];
  routes.set("GET /v1/customers/cus_pro/balance_transactions", () =>
    list("/v1/customers/cus_pro/balance_transactions", ledger),
  );
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    true,
  );
  ledger = [{ ...transaction, type: "invoice_too_small" }];
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  ledger = [
    transaction,
    {
      ...transaction,
      id: "cbtx_undo",
      type: "unapplied_from_invoice",
      amount: -100,
    },
  ];
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  invoice.total = 0;
  ledger = [transaction];
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
});

test("M5 paid linked proration credit funds upgrade and returning unused Pro time truncates that grant", async () => {
  const oldInvoice = {
    ...invoice,
    id: "in_starter",
    parent: { subscription_details: { subscription: "sub_pro" } },
  };
  const oldLine = {
    ...line,
    id: "il_starter_debit",
    pricing: { price_details: { price: "price_starter" } },
    parent: { subscription_item_details: { subscription_item: "si_platform" } },
  };
  const credit = (
    id: string,
    originalInvoice: string,
    originalLine: string,
    priceId: string,
    start: number,
  ) => ({
    id,
    amount: -100,
    pricing: { price_details: { price: priceId } },
    parent: {
      subscription_item_details: {
        subscription_item: "si_platform",
        proration: true,
        proration_details: {
          credited_items: {
            invoice: originalInvoice,
            invoice_line_items: [originalLine],
          },
        },
      },
    },
    period: { start, end },
  });
  line = {
    ...line,
    parent: { subscription_item_details: { subscription_item: "si_platform" } },
  };
  invoice = {
    ...invoice,
    amount_paid: 0,
    total: 0,
    amount_due: 0,
    amount_remaining: 0,
  };
  routes.set("GET /v1/invoices", () =>
    list("/v1/invoices", [invoice, oldInvoice]),
  );
  routes.set("GET /v1/invoices/in_starter/lines", () =>
    list("/v1/invoices/in_starter/lines", [oldLine]),
  );
  routes.set("GET /v1/invoices/in_pro/lines", () =>
    list("/v1/invoices/in_pro/lines", [
      line,
      credit(
        "il_credit_starter",
        "in_starter",
        "il_starter_debit",
        "price_starter",
        now - 50,
      ),
    ]),
  );
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    true,
  );
  const downgrade = { ...invoice, id: "in_downgrade", total: -100 };
  routes.set("GET /v1/invoices", () =>
    list("/v1/invoices", [downgrade, invoice, oldInvoice]),
  );
  routes.set("GET /v1/invoices/in_downgrade/lines", () =>
    list("/v1/invoices/in_downgrade/lines", [
      credit("il_credit_pro", "in_pro", "il_pro", "price_pro", now - 1),
    ]),
  );
  await billing.reconcile(tenant.id);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  assert.equal(
    (
      await db("platform_grants")
        .where({ tenant_id: tenant.id, id: "il_pro" })
        .first()
    ).period_end,
    (now - 1) * 1000,
  );
  assert.equal(featureEntitlements(config, (await current())!).licensing, true);
  await billing.reconcile(tenant.id);
  assert.equal(
    (
      await db("platform_grants")
        .where({ tenant_id: tenant.id, id: "il_pro" })
        .first()
    ).period_end,
    (now - 1) * 1000,
    "replaying credit evidence cannot restore returned Pro time",
  );
});

test("test mode default also scopes newly remembered platform prices", async () => {
  const optional: { stripeLiveMode?: boolean } = config;
  const previous = optional.stripeLiveMode;
  delete optional.stripeLiveMode;
  try {
    await billing.reconcile(tenant.id);
    assert.equal(
      (
        await db("platform_price_history")
          .where({ tenant_id: tenant.id })
          .first()
      ).livemode,
      0,
    );
  } finally {
    if (previous === undefined) delete optional.stripeLiveMode;
    else optional.stripeLiveMode = previous;
  }
});

test("M5 unlinked classic proration credits do not guess a paid-grant attribution", async () => {
  await billing.reconcile(tenant.id);
  const debit = { ...line };
  const creditInvoice = {
    ...invoice,
    id: "in_unlinked",
    amount_paid: 0,
    amount_due: 0,
    amount_remaining: 0,
    total: -50,
  };
  const creditLine = {
    ...line,
    id: "il_unlinked",
    amount: -50,
    parent: {
      subscription_item_details: {
        proration: true,
        proration_details: { credited_items: null },
      },
    },
    period: { start: now - 1, end },
  };
  routes.set("GET /v1/invoices", () =>
    list("/v1/invoices", [creditInvoice, invoice]),
  );
  routes.set("GET /v1/invoices/in_unlinked/lines", () =>
    list("/v1/invoices/in_unlinked/lines", [creditLine]),
  );
  routes.set("GET /v1/invoices/in_pro/lines", () =>
    list("/v1/invoices/in_pro/lines", [debit]),
  );
  await billing.reconcile(tenant.id);
  assert.equal(
    (await current())!.pro_paid_through,
    end * 1000,
    "unsupported unlinked credits require period-end policy, not heuristic revocation",
  );
});

test("N1 expired nonrevoked Pro intervals survive reconciliation and continuous renewal retains the qualification start", async () => {
  line.period = { start: now - 2000, end: now - 1000 };
  await billing.reconcile(tenant.id);
  assert.equal(
    Number((await current())!.pro_paid_through),
    (now - 1000) * 1000,
  );
  assert.equal(
    Number((await current())!.pro_period_start),
    (now - 2000) * 1000,
  );
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    false,
  );
  const old = structuredClone(line);
  const renewal = {
    ...line,
    id: "il_renewal",
    period: { start: now - 1000, end },
  };
  routes.set("GET /v1/invoices/in_pro/lines", () =>
    list("/v1/invoices/in_pro/lines", [old, renewal]),
  );
  await billing.reconcile(tenant.id);
  assert.equal(
    Number((await current())!.pro_period_start),
    (now - 2000) * 1000,
  );
  // A real lapse starts a different qualification period, regardless of history.
  renewal.period.start = now - 500;
  await billing.reconcile(tenant.id);
  assert.equal(Number((await current())!.pro_period_start), (now - 500) * 1000);
  refund = 100;
  await billing.reconcile(tenant.id);
  assert.equal(Number((await current())!.pro_paid_through), 0);
  assert.equal(Number((await current())!.pro_period_start), 0);
});

test("L12 short Checkout expiry is stable across unresolved retries", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: null });
  tenant = (await current())!;
  const bodies: URLSearchParams[] = [];
  routes.set("POST /v1/checkout/sessions", (body) => {
    bodies.push(body);
    return {};
  });
  routes.set("GET /v1/checkout/sessions", () =>
    list("/v1/checkout/sessions", []),
  );
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    code: "stripe_session",
  });
  const guard = await db("platform_checkouts").first();
  assert.equal(
    Number(bodies[0]!.get("expires_at")),
    Math.floor(Number(guard.attempted_at) / 1000) + 35 * 60,
  );
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    code: "stripe_session",
  });
  assert.deepEqual(bodies[0], bodies[1]);
});

const safePortal = () => ({
  id: "bpc_safe",
  active: true,
  livemode: false,
  is_default: false,
  metadata: { double_entitle_policy: "period_end_v1" },
  default_return_url: `${config.origin}/seller`,
  login_page: { enabled: false },
  features: {
    customer_update: { enabled: false },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_update: { enabled: false },
    subscription_cancel: {
      enabled: true,
      mode: "at_period_end",
      proration_behavior: "none",
    },
  },
});
test("M5 platform portal creates, rereads and explicitly selects a dedicated safe configuration", async () => {
  routes.set("POST /v1/billing_portal/configurations", () => ({
    id: "bpc_safe",
  }));
  routes.set("GET /v1/billing_portal/configurations/bpc_safe", safePortal);
  routes.set("POST /v1/billing_portal/sessions", () => ({
    url: "https://billing.stripe.test/safe",
  }));
  await billing.portal(tenant);
  await billing.portal(tenant);
  const created = requests.find(
    (r) =>
      r.path === "/v1/billing_portal/configurations" &&
      r.body.has("features[subscription_update][enabled]"),
  );
  assert.ok(created, "Portal must create a dedicated safe configuration");
  const body = created.body;
  assert.equal(body.get("features[subscription_update][enabled]"), "false");
  assert.equal(
    body.get("features[subscription_cancel][mode]"),
    "at_period_end",
  );
  assert.equal(
    body.get("features[subscription_cancel][proration_behavior]"),
    "none",
  );
  assert.equal(body.get("login_page[enabled]"), "false");
  assert.equal(requests.filter((r) => r.path.endsWith("/bpc_safe")).length, 2);
  assert.equal(requests.at(-1)!.body.get("configuration"), "bpc_safe");
  assert.ok(requests.every((r) => r.account === undefined));
});

test("M5 unsafe, default, disabled, mutated or cross-mode portal configurations fail closed", async () => {
  routes.set("POST /v1/billing_portal/configurations", () => ({
    id: "bpc_safe",
  }));
  routes.set("POST /v1/billing_portal/sessions", () => ({
    url: "https://billing.stripe.test/unsafe",
  }));
  const safe = safePortal();
  const changes = [
    { active: false },
    { is_default: true },
    { id: "bpc_other" },
    { login_page: { enabled: true } },
    ...[
      { subscription_update: { enabled: true } },
      {
        subscription_cancel: {
          enabled: false,
          mode: "at_period_end",
          proration_behavior: "none",
        },
      },
      {
        subscription_cancel: {
          enabled: true,
          mode: "immediately",
          proration_behavior: "none",
        },
      },
      {
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          proration_behavior: "create_prorations",
        },
      },
    ].map((features) => ({ features: { ...safe.features, ...features } })),
  ];
  for (const change of changes) {
    routes.set("GET /v1/billing_portal/configurations/bpc_safe", () => ({
      ...safe,
      ...change,
    }));
    await assert.rejects(billing.portal(tenant), {
      code: "platform_portal_configuration",
    });
  }
  routes.set("GET /v1/billing_portal/configurations/bpc_safe", () => ({
    ...safe,
    livemode: true,
  }));
  await assert.rejects(billing.portal(tenant), { code: "stripe_mode" });
  assert.ok(!requests.some((r) => r.path === "/v1/billing_portal/sessions"));
});

test("N1 a refunded renewal cannot reopen grace from an older expired nonrevoked period", async () => {
  const previous = { ...invoice, id: "in_previous" };
  const previousLine = {
    ...line,
    id: "il_previous",
    period: { start: now - 2000, end: now - 1000 },
  };
  line.period = { start: now - 1000, end };
  routes.set("GET /v1/invoices", () =>
    list("/v1/invoices", [previous, invoice]),
  );
  routes.set("GET /v1/invoices/in_previous/lines", () =>
    list("/v1/invoices/in_previous/lines", [previousLine]),
  );
  routes.set("GET /v1/invoice_payments", (_body, query) =>
    list("/v1/invoice_payments", [
      {
        payment: {
          payment_intent:
            query.get("invoice") === "in_previous" ? "pi_previous" : "pi_pro",
        },
      },
    ]),
  );
  routes.set("GET /v1/charges", (_body, query) =>
    list("/v1/charges", [
      {
        id: query.get("payment_intent"),
        paid: true,
        amount_refunded:
          query.get("payment_intent") === "pi_previous" ? 0 : refund,
        disputed: false,
      },
    ]),
  );
  await billing.reconcile(tenant.id);
  refund = 100;
  await billing.reconcile(tenant.id);
  assert.equal(Number((await current())!.pro_paid_through), 0);
  assert.equal(Number((await current())!.pro_period_start), 0);
});

test("N1 a renewal paid after grace starts a new qualification period even when the worker missed the gap", async () => {
  const previous = {
    ...invoice,
    id: "in_previous",
    status_transitions: { paid_at: now - 10 * 86400 },
  };
  const previousLine = {
    ...line,
    id: "il_previous",
    period: { start: now - 10 * 86400, end: now - 9 * 86400 },
  };
  invoice.status_transitions = { paid_at: now - 1 };
  line.period = { start: previousLine.period.end, end };
  routes.set("GET /v1/invoices", () =>
    list("/v1/invoices", [previous, invoice]),
  );
  routes.set("GET /v1/invoices/in_previous/lines", () =>
    list("/v1/invoices/in_previous/lines", [previousLine]),
  );
  await billing.reconcile(tenant.id);
  assert.equal(Number((await current())!.pro_period_start), (now - 1) * 1000);
  assert.equal(
    featureEntitlements(config, (await current())!).automations,
    true,
  );
  const defaultGrace = { ...config };
  delete defaultGrace.graceDays;
  await new PlatformBilling(db, defaultGrace, stripe).reconcile(tenant.id);
  assert.equal(Number((await current())!.pro_period_start), (now - 1) * 1000);
  // The grace boundary is inclusive for qualification, just as retention is.
  invoice.status_transitions.paid_at = line.period.start + 7 * 86400;
  await billing.reconcile(tenant.id);
  assert.equal(
    Number((await current())!.pro_period_start),
    invoice.status_transitions.paid_at * 1000,
  );
});

async function staleCheckout(t: TestContext) {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: null });
  tenant = (await current())!;
  await db("seller_sessions").update({
    expires_at: Date.now() + 10 * 86400000,
  });
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  routes.set("GET /v1/checkout/sessions", () =>
    list("/v1/checkout/sessions", []),
  );
  // A real connection failure occurs before the provider executes create.
  const create = stripe.checkout.sessions.create.bind(stripe.checkout.sessions);
  routes.set("POST /v1/checkout/sessions", () => disconnect);
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    type: "StripeConnectionError",
  });
  const failedRequest = requests.find((r) => r.body.has("mode"))!;
  assert.ok(failedRequest.key);
  // Following counts measure successful execution, excluding this dropped call.
  requests.length = 0;
  const original = await db("platform_checkouts").first();
  clock += 6 * 60000;
  routes.set("POST /v1/checkout/sessions", (body) => {
    assert.ok(
      Number(body.get("expires_at")) >= Math.floor(clock / 1000) + 30 * 60,
      "Stripe requires expiry at least 30 minutes after the fresh create",
    );
    return { id: "cs_fresh", url: "https://checkout.stripe.test/fresh" };
  });
  // Validate expiry before HTTP too, so a fixture assertion cannot hang the server.
  t.mock.method(
    stripe.checkout.sessions,
    "create",
    async (
      params: Stripe.Checkout.SessionCreateParams,
      options?: Stripe.RequestOptions,
    ) => {
      assert.ok(
        Number(params.expires_at) >= Math.floor(clock / 1000) + 30 * 60,
        "stale persisted expiry must be replaced after canonical absence",
      );
      return create(params, options);
    },
  );
  return {
    original,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

test("R3-L1 an unexecuted network failure retries after six minutes with one fresh generation", async (t) => {
  const { original } = await staleCheckout(t);
  assert.deepEqual(
    await new PlatformBilling(db, config, stripe).checkout(
      tenant,
      seller,
      "pro",
    ),
    { url: "https://checkout.stripe.test/fresh" },
  );
  const fresh = await db("platform_checkouts").first();
  assert.notEqual(fresh.id, original.id);
  assert.equal(
    (await db("platform_checkouts").where({ tenant_id: "primary" })).length,
    0,
  );
  assert.equal(Number(fresh.attempted_at), Date.now());
  assert.equal(fresh.lease_owner, null);
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 1);
  assert.equal(
    requests.at(-1)!.key,
    `double-entitle-platform-checkout-${tenant.id}-${fresh.id}`,
  );
});

test("R3-L1 racing retries hold one lease while the complete paginated absence scan runs", async (t) => {
  const { original } = await staleCheckout(t);
  let started!: () => void, resume!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  routes.set("GET /v1/checkout/sessions", async (_body, query) => {
    if (!query.has("starting_after"))
      return {
        ...list("/v1/checkout/sessions", [
          { id: "cs_other", client_reference_id: "other" },
        ]),
        has_more: true,
      };
    started();
    await paused;
    return list("/v1/checkout/sessions", []);
  });
  const pending = billing.checkout(tenant, seller, "pro");
  await entered;
  try {
    await assert.rejects(
      new PlatformBilling(db, config, stripe).checkout(tenant, seller, "pro"),
      { code: "platform_checkout_pending" },
    );
    assert.equal((await db("platform_checkouts").first()).id, original.id);
  } finally {
    resume();
  }
  await pending;
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 1);
});

test("R3-L1 failed history scan and lost lease cannot rotate a stale generation", async (t) => {
  const { original } = await staleCheckout(t);
  const scan = t.mock.method(
    stripe.checkout.sessions,
    "list",
    () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { id: "cs_other", client_reference_id: "other" };
          throw new Error("history page failed");
        },
      }) as any,
  );
  await assert.rejects(
    billing.checkout(tenant, seller, "pro"),
    /history page failed/,
  );
  assert.equal((await db("platform_checkouts").first()).id, original.id);
  scan.mock.restore();
  routes.set("GET /v1/checkout/sessions", async () => {
    await db("platform_checkouts").update({ lease_owner: "other" });
    return list("/v1/checkout/sessions", []);
  });
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    code: "platform_checkout_pending",
  });
  assert.equal((await db("platform_checkouts").first()).id, original.id);
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 0);
});

test("R3-L1 lost response after execution recovers the old open generation after six minutes", async (t) => {
  const { original } = await staleCheckout(t);
  routes.set("GET /v1/checkout/sessions", () =>
    list("/v1/checkout/sessions", [
      {
        id: "cs_lost",
        client_reference_id: original.id,
        customer: "cus_pro",
        mode: "subscription",
        livemode: false,
        status: "open",
        url: "https://checkout.stripe.test/lost",
      },
    ]),
  );
  assert.deepEqual(await billing.checkout(tenant, seller, "pro"), {
    url: "https://checkout.stripe.test/lost",
  });
  const recovered = await db("platform_checkouts").first();
  assert.equal(recovered.id, original.id);
  assert.equal(recovered.session_id, "cs_lost");
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 0);
});

test("R3-L1 unknown session status and old unresolved attempts stay blocked", async (t) => {
  const { original, advance } = await staleCheckout(t);
  routes.set("GET /v1/checkout/sessions", () =>
    list("/v1/checkout/sessions", [
      {
        id: "cs_unknown",
        client_reference_id: original.id,
        customer: "cus_pro",
        mode: "subscription",
        livemode: false,
        status: null,
      },
    ]),
  );
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    code: "platform_checkout_pending",
  });
  routes.set("GET /v1/checkout/sessions", () =>
    list("/v1/checkout/sessions", []),
  );
  advance(24 * 3600000);
  await assert.rejects(billing.checkout(tenant, seller, "pro"), {
    code: "platform_checkout_pending",
  });
  assert.equal((await db("platform_checkouts").first()).id, original.id);
});

test("R3-L2 a fresh process reuses a paginated metadata-matching dedicated Portal configuration", async (t) => {
  const clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  routes.set("POST /v1/billing_portal/configurations", () => ({
    id: "bpc_safe",
  }));
  const safe = safePortal();
  const unrelated = [
    { ...safe, id: "bpc_default", is_default: true },
    { ...safe, id: "bpc_disabled", active: false },
    { ...safe, id: "bpc_live", livemode: true },
    {
      ...safe,
      id: "bpc_foreign",
      default_return_url: "https://another.test/seller",
    },
    { ...safe, id: "bpc_policy", metadata: { double_entitle_policy: "other" } },
    { ...safe, id: "bpc_no_metadata", metadata: null },
  ];
  routes.set("GET /v1/billing_portal/configurations", (_body, query) =>
    query.has("starting_after")
      ? list("/v1/billing_portal/configurations", [safe])
      : {
          ...list("/v1/billing_portal/configurations", unrelated),
          has_more: true,
        },
  );
  routes.set("GET /v1/billing_portal/configurations/bpc_safe", safePortal);
  routes.set("POST /v1/billing_portal/sessions", () => ({
    url: "https://billing.stripe.test/safe",
  }));
  for (let restart = 0; restart < 2; restart++) {
    if (restart) t.mock.method(Date, "now", () => clock + 25 * 3600000);
    assert.deepEqual(
      await new PlatformBilling(db, config, stripe).portal(tenant),
      { url: "https://billing.stripe.test/safe" },
    );
  }
  assert.equal(requests.filter((r) => r.path.endsWith("/bpc_safe")).length, 2);
  assert.ok(
    !requests.some((r) => r.body.has("features[subscription_update][enabled]")),
  );
});

test("R3-L2 matched Portal configurations are canonically verified and history failures never create defaults", async (t) => {
  routes.set("POST /v1/billing_portal/configurations", () => ({
    id: "bpc_safe",
  }));
  routes.set("GET /v1/billing_portal/configurations", () =>
    list("/v1/billing_portal/configurations", [safePortal()]),
  );
  const safe = safePortal();
  routes.set("GET /v1/billing_portal/configurations/bpc_safe", () => ({
    ...safe,
    features: { ...safe.features, subscription_update: { enabled: true } },
  }));
  await assert.rejects(billing.portal(tenant), {
    code: "platform_portal_configuration",
  });
  const listing = t.mock.method(
    stripe.billingPortal.configurations,
    "list",
    () =>
      ({
        async *[Symbol.asyncIterator]() {
          yield { ...safePortal(), id: "bpc_other", metadata: {} };
          throw new Error("configuration history failed");
        },
      }) as any,
  );
  await assert.rejects(
    new PlatformBilling(db, config, stripe).portal(tenant),
    /configuration history failed/,
  );
  listing.mock.restore();
  assert.ok(!requests.some((r) => r.path.endsWith("/sessions")));
  assert.ok(
    !requests.some((r) => r.body.has("features[subscription_update][enabled]")),
  );
});
