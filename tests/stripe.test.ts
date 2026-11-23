import { primaryTenant } from "./helpers/tenant.ts";
import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import { createDb, migrate, reset, type Plan } from "../src/db.ts";
import { StripeBilling } from "../src/stripe.ts";
import { Billing } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { loadConfig } from "../src/config.ts";
const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/stripe-");
const db = createDb(`sqlite:${root}/db`);
const requests: {
  path: string;
  body: string;
  version: string | undefined;
  account: string | undefined;
}[] = [];
let refund = 0,
  disputeStatus = "won",
  invoicePaid = true,
  customerCreates = 0;
let downgradeAt: number | undefined;
let includeDowngrade = false;
const list = (data: unknown[]) => ({
  object: "list",
  data,
  has_more: false,
  url: "/v1/fixture",
});
const invoice = () => ({
  id: "in_1",
  object: "invoice",
  status: invoicePaid ? "paid" : "open",
  amount_paid: invoicePaid ? 10000 : 0,
  currency: "usd",
  created: 100,
  status_transitions: { paid_at: 101 },
  parent: { subscription_details: { subscription: "sub_1" } },
});
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const url = new URL(req.url!, "http://localhost");
  const body = Buffer.concat(chunks).toString();
  requests.push({
    path: url.pathname,
    body,
    version: req.headers["stripe-version"] as string | undefined,
    account: req.headers["stripe-account"] as string | undefined,
  });
  let data: unknown;
  if (url.pathname === "/v1/prices/price_one")
    data = {
      id: "price_one",
      active: true,
      type: "recurring",
      unit_amount: 1000,
      recurring: { interval: "year", interval_count: 1 },
    };
  else if (url.pathname === "/v1/customers" && req.method === "POST") {
    customerCreates++;
    data = { id: `cus_created_${customerCreates}`, email: "new@example.test" };
  } else if (url.pathname === "/v1/checkout/sessions")
    data = { id: "cs_1", url: "https://checkout.stripe.com/c/pay/local" };
  else if (url.pathname === "/v1/subscriptions/sub_1")
    data = { id: "sub_1", customer: "cus_1", status: "active" };
  else if (url.pathname === "/v1/customers/cus_1")
    data = { id: "cus_1", email: "owner@example.test" };
  else if (url.pathname === "/v1/invoices") data = list([
    ...(includeDowngrade ? [
      { ...invoice(), id: "in_downgrade", amount_paid: 0, amount_due: 0, amount_remaining: 0, total: -5000 },
      { ...invoice(), id: "in_coupon", amount_paid: 0, amount_due: 0, amount_remaining: 0, total: 0 },
      { ...invoice(), id: "in_unmatched", amount_paid: 0, amount_due: 0, amount_remaining: 0, total: 0 },
    ] : []),
    invoice(),
  ]);
  else if (url.pathname === "/v1/invoices/in_1") data = invoice();
  else if (url.pathname === "/v1/invoices/in_downgrade/lines") data = list([
    {
      id: "il_downgraded",
      amount: 5000,
      parent: { subscription_item_details: {} },
      pricing: { price_details: { price: "price_one" } },
      period: { start: downgradeAt, end: downgradeAt! + 200 },
    },
    {
      id: "il_proration",
      amount: -10000,
      parent: { subscription_item_details: {
        proration: true,
        proration_details: { credited_items: { invoice: "in_1", invoice_line_items: ["il_1"] } },
      } },
      pricing: { price_details: { price: "price_old" } },
      period: { start: downgradeAt, end: downgradeAt! + 200 },
    },
  ]);
  else if (url.pathname === "/v1/invoices/in_coupon/lines") data = list([{
    id: "il_free",
    amount: 10000,
    parent: { subscription_item_details: {} },
    pricing: { price_details: { price: "price_old" } },
    period: { start: downgradeAt, end: downgradeAt! + 400 },
  }]);
  else if (url.pathname === "/v1/invoices/in_unmatched/lines") data = list([
    {
      id: "il_unfunded", amount: 10000,
      parent: { subscription_item_details: {} },
      pricing: { price_details: { price: "price_old" } },
      period: { start: downgradeAt, end: downgradeAt! + 400 },
    },
    {
      id: "il_unmatched", amount: -10000,
      parent: { subscription_item_details: {
        proration: true,
        proration_details: { credited_items: { invoice: "in_other", invoice_line_items: ["il_1"] } },
      } },
      pricing: { price_details: { price: "price_old" } },
      period: { start: downgradeAt, end: downgradeAt! + 200 },
    },
  ]);
  else if (url.pathname === "/v1/invoices/in_1/lines")
    data = list([
      {
        id: "il_1",
        amount: 10000,
        parent: { subscription_item_details: { subscription: "sub_1" } },
        pricing: { price_details: { price: downgradeAt === undefined ? "price_one" : "price_old" } },
        period: downgradeAt === undefined ? { start: 100, end: 200 } : { start: downgradeAt, end: downgradeAt + 200 },
      },
      {
        id: "il_credit",
        amount: -5000,
        parent: { subscription_item_details: {} },
        pricing: { price_details: { price: "price_old" } },
        period: { start: 100, end: 200 },
      },
    ]);
  else if (url.pathname === "/v1/invoice_payments")
    data = list([
      {
        id: "ip_1",
        invoice: "in_1",
        status: "paid",
        amount_paid: 10000,
        payment: { type: "charge", charge: "ch_1" },
      },
    ]);
  else if (url.pathname === "/v1/charges/ch_1")
    data = {
      id: "ch_1",
      customer: "cus_1",
      paid: true,
      amount: 10000,
      amount_refunded: refund,
      refunded: refund === 10000,
      disputed: true,
      payment_intent: null,
    };
  else if (url.pathname === "/v1/disputes")
    data = list([{ id: "dp_1", charge: "ch_1", status: disputeStatus }]);
  else if (url.pathname === "/v1/disputes/dp_1")
    data = { id: "dp_1", charge: "ch_1", status: disputeStatus };
  else if (url.pathname === "/v1/refunds/re_1")
    data = { id: "re_1", charge: "ch_1" };
  else {
    res.statusCode = 404;
    data = {
      error: { message: "Unknown fixture path", type: "invalid_request_error" },
    };
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(data));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const config = loadConfig({ DEPLOYMENT_MODE: "hosted",
  APP_SECRET: "33".repeat(32),
  OPERATOR_TOKEN: "operator-token-".repeat(4),
});
const adapter = new StripeBilling(db, config, primaryTenant);
adapter.stripe = new Stripe("sk_test_fixture", {
  apiVersion: "2026-09-30.endive",
  host: "127.0.0.1",
  port,
  protocol: "http",
  maxNetworkRetries: 0,
});
const plan: Plan = {
  tenant_id: "primary",
  id: "one",
  product_id: "prod",
  name: "One",
  site_allowance: 1,
  stripe_price_id: "price_one",
};
before(async () => {
  await migrate(db);
});
after(async () => {
  await db.destroy();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  requests.length = 0;
  refund = 0;
  invoicePaid = true;
  disputeStatus = "won";
  customerCreates = 0;
  downgradeAt = undefined;
  includeDowngrade = false;
});
afterEach(() => {
  for (const request of requests)
    assert.equal(request.account, "acct_primary", request.path);
});
test("Stripe SDK canonical adapter uses paid positive lines and resolves partial/full refunds and disputes", async () => {
  let s = await adapter.snapshot("sub_1");
  assert.equal(s.grants.length, 1);
  assert.equal(s.grants[0]!.priceId, "price_one");
  assert.equal(s.fullyRefunded, false);
  assert.equal(s.suspended, false);
  refund = 5000;
  s = await adapter.snapshot("sub_1");
  assert.equal(s.fullyRefunded, false);
  refund = 10000;
  s = await adapter.snapshot("sub_1");
  assert.equal(s.fullyRefunded, true);
  disputeStatus = "needs_response";
  assert.equal((await adapter.snapshot("sub_1")).suspended, true);
  disputeStatus = "lost";
  assert.equal((await adapter.snapshot("sub_1")).suspended, true);
  disputeStatus = "won";
  assert.equal((await adapter.snapshot("sub_1")).suspended, false);
  invoicePaid = false;
  assert.equal((await adapter.snapshot("sub_1")).grants.length, 0);
  assert.ok(requests.every((r) => r.version === "2026-09-30.endive"));
});
for (const worker of [false, true]) test(`a paid downgrade preserves coverage in ${worker ? "worker" : "direct"} reconciliation`, async () => {
  const start = Math.floor(Date.now() / 1000) - 20;
  await db("products").insert({ tenant_id: "primary", id: "prod", slug: "fixture", name: "Fixture" });
  await db("plans").insert([plan, { ...plan, id: "old", site_allowance: 5, stripe_price_id: "price_old" }]);
  const licensing = new Licenses(db, config.secret, [], primaryTenant, () => start * 1000);
  const billing = new Billing(db, licensing, adapter);
  downgradeAt = start;
  await billing.reconcile("sub_1");
  assert.equal((await db("licenses").first()).plan_id, "old");
  includeDowngrade = true;
  if (worker) {
    await billing.enqueueReconcile(["sub_1"]);
    await billing.run(async () => null, { maxRequests: 20 });
    assert.equal((await db("work").first()).state, "sent");
  } else await billing.reconcile("sub_1");

  const license = await db("licenses").first();
  assert.ok(license);
  assert.equal(license.plan_id, "one");
  assert.equal(license.site_allowance, 1);
  assert.equal(Number(license.paid_through), (start + 200) * 1000);
  const grants = await db("grants").orderBy("id");
  assert.deepEqual(grants.map(grant => [grant.id, Number(grant.period_end)]), [
    ["il_1", start * 1000],
    ["il_downgraded", (start + 200) * 1000],
  ]);
});
test("refund and dispute events resolve legacy direct charges without payment intents", async () => {
  for (const [type, id] of [
    ["charge.refunded", "ch_1"],
    ["charge.dispute.created", "dp_1"],
    ["charge.dispute.closed", "dp_1"],
    ["refund.updated", "re_1"],
  ])
    assert.equal(
      await adapter.resolveSubscription({
        id: "evt_1",
        type: type!,
        data: { object: { id } },
      }),
      "sub_1",
    );
});
test("existing customer checkout requires authenticated ownership and never selects attacker prices", async () => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "known",
    email: "owner@example.test",
    stripe_id: "cus_1",
  });
  await assert.rejects(adapter.checkout(plan, "owner@example.test"), /Sign in/);
  assert.equal(
    requests.filter((r) => r.path === "/v1/checkout/sessions").length,
    0,
  );
  await adapter.checkout(plan, "owner@example.test", "known");
  const posted = new URLSearchParams(
    requests.find((r) => r.path === "/v1/checkout/sessions")!.body,
  );
  assert.equal(posted.get("customer"), "cus_1");
  assert.equal(posted.get("line_items[0][price]"), "price_one");
});
test("concurrent first checkout creates one billing customer before payment and zero licenses", async () => {
  const result = await Promise.allSettled([
    adapter.checkout(plan, "new@example.test"),
    adapter.checkout(plan, "new@example.test"),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(customerCreates, 1);
  assert.equal((await db("customers")).length, 1);
  assert.equal((await db("licenses")).length, 0);
});
