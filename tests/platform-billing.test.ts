import { isolatedDatabase } from "./helpers/database.ts";
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import { migrate, reset, createTenant, type Tenant } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { hash } from "../src/crypto.ts";
import type { SellerSession } from "../src/platform-auth.ts";
const directory = await mkdtemp(
  `${process.env.TMPDIR ?? "/Volumes/Scratch/entitle/tmp"}/platform-billing-`,
);
const database = await isolatedDatabase(`sqlite:${directory}/db`);
const db = database.db;
const config = {
  ...loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_BASE_PATH: "",
    APP_SECRET: "22".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
  }),
  stripeConnectClientId: "ca_fixture",
  platformPriceId: "price_platform",
  stripeLiveMode: false,
};
const requests: {
  path: string;
  body: URLSearchParams;
  query: URLSearchParams;
  account: string | undefined;
  key: string | undefined;
}[] = [];
const list = (url: string, data: unknown[], has_more = false) => ({
  object: "list",
  url,
  data,
  has_more,
});
const routes = new Map<
  string,
  (body: URLSearchParams, query: URLSearchParams) => unknown
>();
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url!, "http://localhost");
  const body = new URLSearchParams(Buffer.concat(chunks).toString());
  requests.push({
    path: url.pathname,
    body,
    query: url.searchParams,
    account: req.headers["stripe-account"] as string | undefined,
    key: req.headers["idempotency-key"] as string | undefined,
  });
  res.setHeader("content-type", "application/json");
  const route = routes.get(`${req.method} ${url.pathname}`);
  if (!route) {
    res.statusCode = 404;
    res.end(
      JSON.stringify({
        error: { type: "invalid_request_error", message: "Unexpected fixture" },
      }),
    );
    return;
  }
  const result = await route(body, url.searchParams);
  const failure = failures.get(`${req.method} ${url.pathname}`);
  if (failure) {
    res.statusCode = failure;
    res.end(
      JSON.stringify({
        error: {
          type: "api_error",
          message: "Fixture response lost after execution",
        },
      }),
    );
  } else res.end(JSON.stringify(result));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const stripe = new Stripe("sk_test_fixture", {
  host: "127.0.0.1",
  port: (server.address() as { port: number }).port,
  protocol: "http",
  maxNetworkRetries: 0,
});
let Billing: typeof import("../src/platform-billing.ts").PlatformBilling;
let billing: InstanceType<
  typeof import("../src/platform-billing.ts").PlatformBilling
>;
let tenant: Tenant, seller: SellerSession;
let customerCreated = false;
const sessions = new Map<string, Record<string, unknown>>();
const failures = new Map<string, number>();
before(async () => {
  await migrate(db);
  await (await import("../src/migrations/008_commerce.ts")).up(db);
  const module = await import("../src/platform-billing.ts").catch(
    () => undefined,
  );
  assert.ok(module?.PlatformBilling, "PlatformBilling service is required");
  Billing = module.PlatformBilling;
});
beforeEach(async () => {
  await db("platform_grants").delete();
  await reset(db);
  requests.length = 0;
  routes.clear();
  sessions.clear();
  failures.clear();
  customerCreated = false;
  tenant = await createTenant(db, {
    id: "alpha",
    slug: "alpha",
    name: "Alpha",
  });
  const user = {
    id: "owner",
    email: "owner@example.test",
    verified_at: Date.now(),
    created_at: Date.now(),
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
    created_at: Date.now(),
  });
  seller = { user, csrfToken: "csrf", sessionHash: "session" };
  billing = new Billing(db, config, stripe);
  routes.set("POST /oauth/token", () => ({
    stripe_user_id: "acct_alpha",
    livemode: false,
    scope: "read_write",
  }));
  routes.set("GET /v1/accounts/acct_alpha", () => ({
    id: "acct_alpha",
    type: "standard",
    charges_enabled: true,
    details_submitted: true,
  }));
  routes.set("POST /v1/customers", () => {
    customerCreated = true;
    return { id: "cus_platform" };
  });
  routes.set("POST /v1/checkout/sessions", (body) => {
    const id = sessions.size
      ? `cs_platform_${sessions.size + 1}`
      : "cs_platform";
    const session = {
      id,
      url: "https://checkout.stripe.test/platform",
      status: "open",
      mode: "subscription",
      customer: "cus_platform",
      livemode: false,
      subscription: null,
      client_reference_id: body.get("client_reference_id"),
    };
    sessions.set(session.id, session);
    routes.set(`GET /v1/checkout/sessions/${session.id}`, () =>
      sessions.get(session.id),
    );
    return session;
  });
  routes.set("GET /v1/checkout/sessions", () =>
    list("/v1/checkout/sessions", [...sessions.values()]),
  );
  routes.set("GET /v1/checkout/sessions/cs_platform", () =>
    sessions.get("cs_platform"),
  );
  routes.set("GET /v1/billing_portal/configurations", () =>
    list("/v1/billing_portal/configurations", []),
  );
  routes.set("POST /v1/billing_portal/configurations", () => ({
    id: "bpc_safe",
  }));
  routes.set("GET /v1/billing_portal/configurations/bpc_safe", () => ({
    id: "bpc_safe",
    active: true,
    is_default: false,
    metadata: { double_entitle_policy: "period_end_v1" },
    default_return_url: `${config.origin}/seller`,
    livemode: false,
    login_page: { enabled: false },
    features: {
      subscription_update: { enabled: false },
      subscription_cancel: {
        enabled: true,
        mode: "at_period_end",
        proration_behavior: "none",
      },
    },
  }));
  routes.set("POST /v1/billing_portal/sessions", () => ({
    url: "https://billing.stripe.test/platform",
  }));
  routes.set("GET /v1/prices/price_platform", () => ({
    id: "price_platform",
    active: true,
    type: "recurring",
    livemode: false,
  }));
  routes.set("GET /v1/subscriptions", () =>
    list(
      "/v1/subscriptions",
      customerCreated
        ? []
        : [
            {
              id: "sub_platform",
              customer: "cus_platform",
              status: "active",
              items: { data: [{ price: { id: "price_platform" } }] },
            },
          ],
    ),
  );
  routes.set("GET /v1/subscriptions/sub_platform", () => ({
    id: "sub_platform",
    customer: "cus_platform",
    status: "active",
    livemode: false,
  }));
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", []),
  );
  routes.set("GET /v1/invoices", () =>
    list("/v1/invoices", [
      {
        id: "in_paid",
        status: "paid",
        amount_paid: 1200,
        customer: "cus_platform",
        parent: { subscription_details: { subscription: "sub_platform" } },
        livemode: false,
      },
    ]),
  );
  routes.set("GET /v1/invoices/in_paid/lines", () =>
    list("/v1/invoices/in_paid/lines", [
      {
        id: "il_paid",
        amount: 1200,
        pricing: { price_details: { price: "price_platform" } },
        parent: { subscription_item_details: {} },
        period: { start: 10, end: 100 },
      },
    ]),
  );
});

test("the platform Stripe client is configured lazily, reused, and can be explicitly replaced", () => {
  const service = new Billing(db, { ...config, stripeSecret: "sk_test_lazy_fixture" });
  const client = service.stripe;
  assert.equal(service.stripe, client);
  service.stripe = stripe;
  assert.equal(service.stripe, stripe);
  const unconfigured = new Billing(db, { ...config, stripeSecret: "" });
  assert.throws(() => unconfigured.stripe, /Stripe billing is not configured/);
});
after(async () => {
  await database.close();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
async function state() {
  return new URL((await billing.connect(tenant, seller)).url).searchParams.get(
    "state",
  )!;
}
test("OAuth uses fixed callback, hashed session-bound single-use state and canonical Standard account proof", async () => {
  const token = await state();
  const row = await db("oauth_states").first();
  assert.equal(row.id, hash(token));
  assert.equal(row.session_id, seller.sessionHash);
  assert.equal(
    row.redirect_uri,
    `${config.origin}/api/v1/platform/stripe/callback`,
  );
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(
    (await billing.callback("code", token, seller)).tenant.stripe_account_id,
    "acct_alpha",
  );
  await assert.rejects(billing.callback("code", token, seller), {
    code: "oauth_state",
  });
  assert.equal((await db("audit_events")).length, 1);
  assert.ok(requests.every((r) => r.account === undefined));
});
test("OAuth rejects wrong session, expiry and revoked owner before exchanging code", async () => {
  const token = await state();
  await db("seller_sessions").insert({
    id: "other",
    user_id: seller.user.id,
    expires_at: Date.now() + 10000,
  });
  await assert.rejects(
    billing.callback("code", token, { ...seller, sessionHash: "other" }),
    { code: "oauth_state" },
  );
  await db("oauth_states").update({ expires_at: 0 });
  await assert.rejects(billing.callback("code", token, seller), {
    code: "oauth_state",
  });
  await db("seller_memberships").delete();
  await assert.rejects(billing.connect(tenant, seller), {
    code: "tenant_denied",
  });
  assert.equal(requests.length, 0);
});
test("OAuth rejects provider mode, account type, duplicate account and commerce account replacement", async () => {
  routes.set("POST /oauth/token", () => ({
    stripe_user_id: "acct_alpha",
    livemode: true,
  }));
  await assert.rejects(billing.callback("code", await state(), seller), {
    code: "stripe_mode",
  });
  routes.set("POST /oauth/token", () => ({
    stripe_user_id: "acct_alpha",
    livemode: false,
    scope: "read_write",
  }));
  routes.set("GET /v1/accounts/acct_alpha", () => ({
    id: "acct_alpha",
    type: "express",
    charges_enabled: true,
  }));
  await assert.rejects(billing.callback("code", await state(), seller), {
    code: "stripe_account",
  });
  routes.set("GET /v1/accounts/acct_alpha", () => ({
    id: "acct_alpha",
    type: "standard",
    charges_enabled: true,
  }));
  const other = await createTenant(db, {
    id: "beta",
    slug: "beta",
    name: "Beta",
    stripe_account_id: "acct_alpha",
  });
  await assert.rejects(billing.callback("code", await state(), seller), {
    code: "stripe_account_conflict",
  });
  await db("tenants")
    .where({ id: other.id })
    .update({ stripe_account_id: null });
  await db("tenants")
    .where({ id: tenant.id })
    .update({ stripe_account_id: "acct_old" });
  await db("customers").insert({
    tenant_id: tenant.id,
    id: "buyer",
    email: "buyer@example.test",
    stripe_id: "cus_buyer",
  });
  await assert.rejects(billing.callback("code", await state(), seller), {
    code: "stripe_account_immutable",
  });
});
test("platform checkout keeps seller and buyer customers separate, fixed price and stable idempotency without licenses", async () => {
  await db("customers").insert({
    tenant_id: tenant.id,
    id: "buyer",
    email: seller.user.email,
    stripe_id: "cus_buyer",
  });
  await billing.checkout(tenant, seller);
  await billing.checkout(tenant, seller);
  const customers = requests.filter((r) => r.path === "/v1/customers");
  assert.equal(customers.length, 1);
  assert.equal(
    customers[0]!.key,
    `double-entitle-platform-customer-${tenant.id}`,
  );
  const posted = requests.find((r) => r.path === "/v1/checkout/sessions")!;
  assert.equal(posted.body.get("customer"), "cus_platform");
  assert.equal(posted.body.get("line_items[0][price]"), "price_platform");
  assert.equal(
    posted.body.get("success_url"),
    `${config.origin}/seller?billing=success`,
  );
  assert.ok(requests.every((r) => r.account === undefined));
  assert.equal((await db("licenses")).length, 0);
  await billing.portal(tenant);
  assert.equal(requests.at(-1)!.body.get("customer"), "cus_platform");
});
test("canonical paid invoice reconciliation grows paid through, ignores unpaid upgrades and never creates licenses", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_customer_id: "cus_platform" });
  await billing.reconcile(tenant.id);
  let current = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(current.paid_through, 100000);
  assert.equal(current.platform_subscription_id, "sub_platform");
  routes.set("GET /v1/invoices", () => list("/v1/invoices", []));
  routes.set("GET /v1/subscriptions/sub_platform", () => ({
    id: "sub_platform",
    customer: "cus_platform",
    status: "past_due",
    livemode: false,
  }));
  await billing.reconcile(tenant.id);
  current = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(current.paid_through, 100000);
  assert.equal(current.billing_status, "past_due");
  assert.equal((await db("licenses")).length, 0);
});
test("platform receipts durably retry canonical reconciliation, deduplicate and ignore metadata account spoofing", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_customer_id: "cus_platform" });
  const event = {
    id: "evt_platform",
    type: "invoice.paid",
    livemode: false,
    data: {
      object: {
        id: "in_paid",
        customer: "cus_platform",
        metadata: { tenant_id: "primary" },
      },
    },
  };
  await billing.receive(event);
  await billing.receive(event);
  assert.equal((await db("platform_events")).length, 1);
  assert.equal((await db("platform_work")).length, 1);
  routes.delete("GET /v1/subscriptions/sub_platform");
  await billing.run();
  assert.equal((await db("platform_work").first()).state, "pending");
  routes.set("GET /v1/subscriptions/sub_platform", () => ({
    id: "sub_platform",
    customer: "cus_platform",
    status: "active",
    livemode: false,
  }));
  await db("platform_work").update({ available_at: 0 });
  await billing.run();
  assert.equal((await db("platform_work").first()).state, "sent");
  assert.ok((await db("platform_events").first()).processed_at > 0);
  assert.equal(
    (await db("tenants").where({ id: "primary" }).first()).paid_through,
    0,
  );
  assert.equal((await db("licenses")).length, 0);
});
test("Connect deauthorization preserves mapping and buyer rights, unknown account cannot create tenants", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ stripe_account_id: "acct_alpha" });
  await billing.accountEvent({
    id: "evt_disconnect",
    type: "account.application.deauthorized",
    account: "acct_alpha",
    livemode: false,
    data: { object: {} },
  });
  await billing.run();
  const row = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(row.stripe_account_id, "acct_alpha");
  assert.equal(row.stripe_status, "disconnected");
  await billing.accountEvent({
    id: "evt_unknown",
    type: "account.updated",
    account: "acct_unknown",
    livemode: false,
    data: { object: {} },
  });
  assert.equal((await db("tenants")).length, 2);
});
test("fixture mode denies all external operations and mismatched event modes before data writes", async () => {
  billing = new Billing(db, { ...config, localBilling: true }, stripe);
  for (const call of [
    () => billing.connect(tenant, seller),
    () => billing.callback("code", "state", seller),
    () => billing.checkout(tenant, seller),
    () => billing.portal(tenant),
    () => billing.reconcile(tenant.id),
  ])
    await assert.rejects(call, { code: "local_billing" });
  assert.equal(requests.length, 0);
  billing = new Billing(db, config, stripe);
  await assert.rejects(
    billing.receive({
      id: "evt_live",
      type: "invoice.paid",
      livemode: true,
      data: { object: {} },
    }),
    { code: "stripe_mode" },
  );
  await assert.rejects(
    billing.receive({
      id: "evt_connect",
      type: "invoice.paid",
      account: "acct_alpha",
      livemode: false,
      data: { object: {} },
    }),
    { code: "stripe_account" },
  );
  assert.equal((await db("platform_events")).length, 0);
});
test("missing platform configuration, inactive prices, owner revocation and absent billing mappings reject", async () => {
  const defaults = new Billing(db, config);
  assert.ok(defaults.stripe);
  await assert.rejects(
    new Billing(db, { ...config, stripeConnectClientId: "" }, stripe).connect(
      tenant,
      seller,
    ),
    { code: "stripe_connect_configuration" },
  );
  await assert.rejects(
    new Billing(db, { ...config, platformPriceId: "" }, stripe).checkout(
      tenant,
      seller,
    ),
    { code: "platform_price" },
  );
  await assert.rejects(billing.portal(tenant), {
    code: "platform_customer_missing",
  });
  routes.set("GET /v1/prices/price_platform", () => ({
    active: false,
    type: "recurring",
    livemode: false,
  }));
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_price",
  });
  await db("seller_sessions").delete();
  await assert.rejects(billing.connect(tenant, seller), {
    code: "seller_login_required",
  });
});
test("account updates use canonical account state and preserve independent platform subscription status", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ stripe_account_id: "acct_alpha", billing_status: "active" });
  const update = (id: string) =>
    billing.accountEvent({
      id,
      type: "account.updated",
      account: "acct_alpha",
      livemode: false,
      data: { object: { charges_enabled: true } },
    });
  routes.set("GET /v1/accounts/acct_alpha", () => ({
    id: "acct_alpha",
    charges_enabled: false,
  }));
  await update("evt_restrict");
  await billing.run();
  assert.equal(
    (await db("tenants").where({ id: tenant.id }).first()).stripe_status,
    "restricted",
  );
  routes.set("GET /v1/accounts/acct_alpha", () => ({
    id: "acct_alpha",
    charges_enabled: true,
  }));
  await update("evt_enable");
  await billing.run();
  const row = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(row.stripe_status, "connected");
  assert.equal(row.billing_status, "active");
  await billing.accountEvent({
    id: "evt_ignore",
    type: "customer.created",
    account: "acct_alpha",
    livemode: false,
    data: { object: {} },
  });
  await billing.run();
  await billing.accountEvent({
    id: "evt_no_account",
    type: "account.updated",
    livemode: false,
    data: { object: {} },
  });
});
test("reconciliation skips absent customers and subscriptions and rejects cross-customer canonical snapshots", async () => {
  await billing.reconcile(tenant.id);
  await assert.rejects(billing.reconcile("missing"), {
    code: "tenant_not_found",
  });
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_customer_id: "cus_platform" });
  routes.set("GET /v1/subscriptions", () =>
    list("/v1/subscriptions", [{ id: "sub_other", customer: "cus_other" }]),
  );
  await billing.reconcile(tenant.id);
  assert.equal(
    (await db("tenants").where({ id: tenant.id }).first())
      .platform_subscription_id,
    null,
  );
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: "sub_platform" });
  routes.set("GET /v1/subscriptions/sub_platform", () => ({
    id: "sub_platform",
    customer: "cus_other",
    livemode: false,
  }));
  await assert.rejects(billing.reconcile(tenant.id), {
    code: "platform_customer_conflict",
  });
});
test("only paid positive recurring configured-price invoice lines extend platform access, with pagination", async () => {
  await db("tenants").where({ id: tenant.id }).update({
    platform_customer_id: "cus_platform",
    platform_subscription_id: "sub_platform",
  });
  const valid = {
    id: "in_paid",
    customer: "cus_platform",
    status: "paid",
    amount_paid: 1200,
    livemode: false,
    parent: { subscription_details: { subscription: "sub_platform" } },
  };
  routes.set("GET /v1/invoices", (_b, q) =>
    q.has("starting_after")
      ? list("/v1/invoices", [valid])
      : list(
          "/v1/invoices",
          [
            { ...valid, id: "in_open", status: "open" },
            { ...valid, id: "in_zero", amount_paid: 0 },
            { ...valid, id: "in_foreign", customer: "cus_other" },
            { ...valid, id: "in_manual", parent: null },
          ],
          true,
        ),
  );
  const line = {
    id: "il",
    amount: 1200,
    pricing: { price_details: { price: "price_platform" } },
    parent: { subscription_item_details: {} },
    period: { start: 10, end: 100 },
  };
  routes.set("GET /v1/invoices/in_paid/lines", (_b, q) =>
    q.has("starting_after")
      ? list("/v1/invoices/in_paid/lines", [line])
      : list(
          "/v1/invoices/in_paid/lines",
          [
            { ...line, id: "il_credit", amount: -1 },
            { ...line, id: "il_manual", parent: null },
            { ...line, id: "il_other", pricing: null },
            { ...line, id: "il_bad_period", period: { start: 100, end: 10 } },
          ],
          true,
        ),
  );
  await billing.reconcile(tenant.id);
  assert.equal(
    (await db("tenants").where({ id: tenant.id }).first()).paid_through,
    100000,
  );
  assert.ok(requests.filter((r) => r.path === "/v1/invoices").length === 2);
});
test("unmapped platform events acknowledge without trusting tenant metadata or creating seller data", async () => {
  for (const [id, object] of [
    [
      "evt_unknown",
      { customer: "cus_unknown", metadata: { tenant_id: tenant.id } },
    ],
    ["evt_no_customer", {}],
  ] as const) {
    await billing.receive({
      id,
      type: "customer.created",
      livemode: false,
      data: { object },
    });
  }
  await billing.run();
  assert.ok((await db("platform_work")).every((row) => row.state === "sent"));
  assert.equal((await db("tenants")).length, 2);
  assert.equal(requests.length, 0);
});
test("checkout rejects missing URLs and existing subscription without creating licenses", async () => {
  routes.set("POST /v1/checkout/sessions", () => ({ url: null }));
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "stripe_session",
  });
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: "sub_platform" });
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_subscription_exists",
  });
  assert.equal((await db("licenses")).length, 0);
});

test("OAuth reconnects the same account after commerce and records provider restrictions", async () => {
  await billing.callback("code", await state(), seller);
  await db("customers").insert({
    tenant_id: tenant.id,
    id: "buyer",
    email: "buyer@example.test",
    stripe_id: "cus_buyer",
  });
  routes.set("GET /v1/accounts/acct_alpha", () => ({
    id: "acct_alpha",
    type: "standard",
    charges_enabled: false,
  }));
  const result = await billing.callback("code", await state(), seller);
  assert.equal(result.tenant.stripe_status, "restricted");
  assert.equal(
    (await db("tenants").where({ id: tenant.id }).first()).stripe_status,
    "restricted",
  );
});
test("unspecified live mode defaults to test and expanded customer IDs select only stored mappings", async () => {
  const defaults = { ...config };
  delete (defaults as { stripeLiveMode?: boolean }).stripeLiveMode;
  billing = new Billing(db, defaults, stripe);
  await billing.receive({
    id: "evt_expanded",
    type: "customer.created",
    livemode: false,
    data: { object: { customer: { id: "cus_unknown" } } },
  });
  await billing.run();
  assert.equal((await db("platform_work").first()).state, "sent");
});

test("platform subscription discovery ignores unrelated prices on the same customer", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_customer_id: "cus_platform" });
  routes.set("GET /v1/subscriptions", () =>
    list("/v1/subscriptions", [
      {
        id: "sub_unrelated",
        customer: "cus_platform",
        items: { data: [{ price: { id: "price_unrelated" } }] },
      },
      {
        id: "sub_platform",
        customer: "cus_platform",
        items: { data: [{ price: { id: "price_platform" } }] },
      },
    ]),
  );
  routes.set("GET /v1/subscriptions/sub_unrelated", () => ({
    id: "sub_unrelated",
    customer: "cus_platform",
    status: "active",
    livemode: false,
  }));
  await billing.reconcile(tenant.id);
  assert.equal(
    (await db("tenants").where({ id: tenant.id }).first())
      .platform_subscription_id,
    "sub_platform",
  );
});

test("Connect webhook receipt queues work without executing provider HTTP", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ stripe_account_id: "acct_alpha" });
  await billing.accountEvent({
    id: "evt_queued_account",
    type: "account.updated",
    account: "acct_alpha",
    livemode: false,
    data: { object: {} },
  });
  assert.equal(requests.length, 0);
  assert.equal((await db("platform_work").first()).state, "pending");
  await billing.run();
  assert.equal((await db("platform_work").first()).state, "sent");
});

test("once connected an account cannot change even before any commerce and conflicts never deauthorize", async () => {
  await billing.callback("code", await state(), seller);
  routes.set("POST /oauth/token", () => ({
    stripe_user_id: "acct_replacement",
    livemode: false,
    scope: "read_write",
  }));
  routes.set("GET /v1/accounts/acct_replacement", () => ({
    id: "acct_replacement",
    type: "standard",
    charges_enabled: true,
  }));
  await assert.rejects(billing.callback("replacement", await state(), seller), {
    code: "stripe_account_immutable",
  });
  assert.equal(
    (await db("tenants").where({ id: tenant.id }).first()).stripe_account_id,
    "acct_alpha",
  );
  assert.equal((await db("customers")).length, 0);
  assert.ok(requests.every((request) => request.path !== "/oauth/deauthorize"));
});

test("only canonical paid configured-price invoices raise trial quotas to paid defaults and never shrink on cancellation", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({
      platform_customer_id: "cus_platform",
      max_products: 3,
      max_storage_bytes: 100 * 1024 ** 2,
    });
  await billing.reconcile(tenant.id);
  let row = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(row.max_products, 20);
  assert.equal(row.max_storage_bytes, 1024 ** 3);
  routes.set("GET /v1/invoices", () => list("/v1/invoices", []));
  routes.set("GET /v1/subscriptions/sub_platform", () => ({
    id: "sub_platform",
    customer: "cus_platform",
    status: "canceled",
    livemode: false,
  }));
  await billing.reconcile(tenant.id);
  row = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(row.max_products, 20);
  assert.equal(row.max_storage_bytes, 1024 ** 3);
  assert.equal(row.paid_through, 100000);
});

test("paid quota configuration raises small trial limits while preserving larger operator allocations", async () => {
  billing = new Billing(
    db,
    { ...config, paidMaxProducts: 40, paidStorageBytes: 2 * 1024 ** 3 },
    stripe,
  );
  await db("tenants")
    .where({ id: tenant.id })
    .update({
      platform_customer_id: "cus_platform",
      max_products: 3,
      max_storage_bytes: 100 * 1024 ** 2,
    });
  await billing.reconcile(tenant.id);
  let row = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(row.max_products, 40);
  assert.equal(row.max_storage_bytes, 2 * 1024 ** 3);
  await db("tenants")
    .where({ id: tenant.id })
    .update({ max_products: 80, max_storage_bytes: 4 * 1024 ** 3 });
  await billing.reconcile(tenant.id);
  row = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(row.max_products, 80);
  assert.equal(row.max_storage_bytes, 4 * 1024 ** 3);
});

test("checkout completion, active subscription, unpaid invoice and unrelated price never raise trial quotas", async () => {
  await db("tenants")
    .where({ id: tenant.id })
    .update({ max_products: 3, max_storage_bytes: 100 * 1024 ** 2 });
  await billing.checkout(tenant, seller);
  const paid = {
    id: "in_paid",
    customer: "cus_platform",
    amount_paid: 1200,
    livemode: false,
    parent: { subscription_details: { subscription: "sub_platform" } },
  };
  for (const [status, price] of [
    ["open", "price_platform"],
    ["paid", "price_other"],
  ]) {
    routes.set("GET /v1/invoices", () =>
      list("/v1/invoices", [{ ...paid, status }]),
    );
    routes.set("GET /v1/invoices/in_paid/lines", () =>
      list("/v1/invoices/in_paid/lines", [
        {
          id: "il_test",
          amount: 1200,
          pricing: { price_details: { price } },
          parent: { subscription_item_details: {} },
          period: { start: 10, end: 100 },
        },
      ]),
    );
    await billing.reconcile(tenant.id);
    const row = await db("tenants").where({ id: tenant.id }).first();
    assert.equal(row.max_products, 3);
    assert.equal(row.max_storage_bytes, 100 * 1024 ** 2);
  }
});

test("optional paid quota fields fall back to fixed defaults when older configuration objects omit them", async () => {
  const defaults = { ...config };
  delete (defaults as { paidMaxProducts?: number }).paidMaxProducts;
  delete (defaults as { paidStorageBytes?: number }).paidStorageBytes;
  billing = new Billing(db, defaults, stripe);
  await db("tenants")
    .where({ id: tenant.id })
    .update({
      platform_customer_id: "cus_platform",
      max_products: 3,
      max_storage_bytes: 100 * 1024 ** 2,
    });
  await billing.reconcile(tenant.id);
  const current = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(current.max_products, 20);
  assert.equal(current.max_storage_bytes, 1024 ** 3);
});

test("platform owners can resubscribe after canonical terminal status but never trust a stale canceled database label", async () => {
  await db("tenants").where({ id: tenant.id }).update({
    platform_customer_id: "cus_platform",
    platform_subscription_id: "sub_old",
    billing_status: "canceled",
  });
  routes.set("GET /v1/subscriptions", () => list("/v1/subscriptions", []));
  routes.set("GET /v1/subscriptions/sub_old", () => ({
    id: "sub_old",
    customer: "cus_platform",
    status: "active",
    livemode: false,
    created: 100,
  }));
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_subscription_exists",
  });
  for (const status of ["canceled", "incomplete_expired"]) {
    routes.set("GET /v1/subscriptions/sub_old", () => ({
      id: "sub_old",
      customer: "cus_platform",
      status,
      livemode: false,
      created: 100,
    }));
    assert.deepEqual(await billing.checkout(tenant, seller), {
      url: "https://checkout.stripe.test/platform",
    });
  }
});

test("canonical terminal subscriptions adopt the newest configured-price subscription for the same customer and audit once", async () => {
  await db("tenants").where({ id: tenant.id }).update({
    platform_customer_id: "cus_platform",
    platform_subscription_id: "sub_old",
    paid_through: 200000,
  });
  routes.set("GET /v1/subscriptions/sub_old", () => ({
    id: "sub_old",
    customer: "cus_platform",
    status: "canceled",
    livemode: false,
    created: 100,
  }));
  const price = { data: [{ price: { id: "price_platform" } }] };
  routes.set("GET /v1/subscriptions", () =>
    list("/v1/subscriptions", [
      { id: "sub_old", customer: "cus_platform", created: 100, items: price },
      { id: "sub_new", customer: "cus_platform", created: 200, items: price },
      {
        id: "sub_foreign",
        customer: "cus_foreign",
        created: 300,
        items: price,
      },
      {
        id: "sub_other",
        customer: "cus_platform",
        created: 400,
        items: { data: [{ price: { id: "price_other" } }] },
      },
    ]),
  );
  routes.set("GET /v1/subscriptions/sub_new", () => ({
    id: "sub_new",
    customer: "cus_platform",
    status: "active",
    livemode: false,
    created: 200,
  }));
  routes.set("GET /v1/invoices", () => list("/v1/invoices", []));
  await billing.reconcile(tenant.id);
  let current = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(current.platform_subscription_id, "sub_new");
  assert.equal(current.paid_through, 200000);
  const audit = await db("audit_events")
    .where({ action: "platform.subscription_changed" })
    .first();
  assert.deepEqual(JSON.parse(audit.details), {
    from: "sub_old",
    to: "sub_new",
  });
  await billing.receive({
    id: "evt_stale_old",
    type: "invoice.paid",
    livemode: false,
    data: { object: { customer: "cus_platform", subscription: "sub_old" } },
  });
  await billing.run();
  current = await db("tenants").where({ id: tenant.id }).first();
  assert.equal(current.platform_subscription_id, "sub_new");
  assert.equal(
    (
      await db("audit_events").where({
        action: "platform.subscription_changed",
      })
    ).length,
    1,
  );
});

test("durable pending Checkout sessions survive process restarts and time windows without creating duplicates", async (t) => {
  await billing.checkout(tenant, seller);
  const guard = await db("platform_checkouts")
    .where({ tenant_id: tenant.id })
    .first();
  assert.ok(guard);
  assert.equal(guard.session_id, "cs_platform");
  await db("seller_sessions").update({
    expires_at: Date.now() + 10 * 86400000,
  });
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 2 * 3600000);
  billing = new Billing(db, config, stripe);
  assert.deepEqual(await billing.checkout(tenant, seller), {
    url: "https://checkout.stripe.test/platform",
  });
  assert.equal(
    requests.filter(
      (request) =>
        request.path === "/v1/checkout/sessions" && request.body.has("mode"),
    ).length,
    1,
  );
  assert.equal((await db("platform_checkouts").first()).id, guard.id);
});

test("canonical active subscriptions block a second platform checkout before webhook reconciliation", async () => {
  await billing.checkout(tenant, seller);
  routes.set("GET /v1/subscriptions", () =>
    list("/v1/subscriptions", [
      {
        id: "sub_platform",
        customer: "cus_platform",
        status: "active",
        created: 100,
        items: { data: [{ price: { id: "price_platform" } }] },
      },
    ]),
  );
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_subscription_exists",
  });
  assert.equal(
    requests.filter(
      (request) =>
        request.path === "/v1/checkout/sessions" && request.body.has("mode"),
    ).length,
    1,
  );
});

test(
  "a live Checkout claim rejects concurrent creators without holding the SQLite connection during provider HTTP",
  { timeout: 5000 },
  async () => {
    const create = routes.get("POST /v1/checkout/sessions")!;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    routes.set("POST /v1/checkout/sessions", async (body, query) => {
      entered.resolve();
      await release.promise;
      return create(body, query);
    });
    const pending = billing.checkout(tenant, seller);
    await entered.promise;
    try {
      assert.equal((await db("platform_checkouts").first()).session_id, null);
      await assert.rejects(
        new Billing(db, config, stripe).checkout(tenant, seller),
        { code: "platform_checkout_pending" },
      );
    } finally {
      release.resolve();
    }
    await pending;
    assert.equal(requests.filter((r) => r.body.has("mode")).length, 1);
    assert.equal((await db("platform_checkouts").first()).lease_owner, null);
  },
);

test("a lost provider response recovers the same generation through paginated Checkout history", async (t) => {
  await db("seller_sessions").update({ expires_at: Date.now() + 86400000 });
  failures.set("POST /v1/checkout/sessions", 503);
  await assert.rejects(billing.checkout(tenant, seller), { statusCode: 503 });
  const pending = await db("platform_checkouts").first();
  assert.ok(pending.attempted_at);
  assert.equal(pending.session_id, null);
  assert.equal(pending.lease_owner, null);
  failures.clear();
  const retryAt = Date.now() + 6 * 60000;
  t.mock.method(Date, "now", () => retryAt);
  const session = sessions.get("cs_platform")!;
  routes.set("GET /v1/checkout/sessions", (_body, query) =>
    query.has("starting_after")
      ? list("/v1/checkout/sessions", [session])
      : list(
          "/v1/checkout/sessions",
          [{ id: "cs_unrelated", client_reference_id: "other" }],
          true,
        ),
  );
  assert.deepEqual(
    await new Billing(db, config, stripe).checkout(tenant, seller),
    { url: "https://checkout.stripe.test/platform" },
  );
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 1);
  assert.equal(
    (await db("platform_checkouts").first()).session_id,
    "cs_platform",
  );
});

test("an unresolved attempt retries with the same durable key but fails closed before provider keys may be pruned", async (t) => {
  failures.set("POST /v1/checkout/sessions", 503);
  await assert.rejects(billing.checkout(tenant, seller), { statusCode: 503 });
  sessions.clear();
  await assert.rejects(billing.checkout(tenant, seller), { statusCode: 503 });
  const keys = requests.filter((r) => r.body.has("mode")).map((r) => r.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  sessions.clear();
  failures.clear();
  await db("seller_sessions").update({
    expires_at: Date.now() + 10 * 86400000,
  });
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 24 * 3600000);
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_checkout_pending",
  });
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 2);
});

test("expired sessions and terminal completed subscriptions permit one fresh durable generation", async () => {
  await billing.checkout(tenant, seller);
  const first = await db("platform_checkouts").first();
  sessions.get("cs_platform")!.status = "expired";
  await billing.checkout(tenant, seller);
  const second = await db("platform_checkouts").first();
  assert.notEqual(second.id, first.id);
  assert.equal(second.session_id, "cs_platform_2");
  const session = sessions.get("cs_platform_2")!;
  session.status = "complete";
  session.subscription = "sub_old";
  await db("tenants")
    .where({ id: tenant.id })
    .update({ platform_subscription_id: "sub_old" });
  routes.set("GET /v1/subscriptions/sub_old", () => ({
    id: "sub_old",
    customer: "cus_platform",
    status: "canceled",
    livemode: false,
    created: 100,
  }));
  await billing.checkout(tenant, seller);
  const third = await db("platform_checkouts").first();
  assert.notEqual(third.id, second.id);
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 3);
});

test("completed sessions cannot create a new checkout until canonical completion and customer identity are resolved", async () => {
  await billing.checkout(tenant, seller);
  const session = sessions.get("cs_platform")!;
  session.status = "complete";
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_checkout_pending",
  });
  session.subscription = "sub_completed";
  routes.set("GET /v1/subscriptions/sub_completed", () => ({
    id: "sub_completed",
    customer: "cus_other",
    status: "canceled",
    livemode: false,
  }));
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_customer_conflict",
  });
  routes.set("GET /v1/subscriptions/sub_completed", () => ({
    id: "sub_completed",
    customer: "cus_platform",
    status: "active",
    livemode: false,
  }));
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_subscription_exists",
  });
  session.status = "unknown";
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_checkout_pending",
  });
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 1);
});

test("stored open checkout sessions reject changed customer, mode and missing URLs", async () => {
  await billing.checkout(tenant, seller);
  const session = sessions.get("cs_platform")!;
  session.customer = "cus_other";
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_customer_conflict",
  });
  session.customer = "cus_platform";
  session.mode = "payment";
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_customer_conflict",
  });
  session.mode = "subscription";
  session.url = null;
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "stripe_session",
  });
});

test("checkout guards fail closed when configuration, mapping or lease ownership changes", async () => {
  await billing.checkout(tenant, seller);
  await db("platform_checkouts").update({ price_id: "price_other" });
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_checkout_changed",
  });
  await db("platform_checkouts").update({ price_id: "price_platform" });
  const retrieve = routes.get("GET /v1/checkout/sessions/cs_platform")!;
  routes.set("GET /v1/checkout/sessions/cs_platform", async (body, query) => {
    await db("platform_checkouts").update({ lease_owner: "other" });
    return retrieve(body, query);
  });
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_checkout_pending",
  });
  await db("platform_checkouts").update({ lease_owner: null, lease_until: 0 });
  routes.set("GET /v1/checkout/sessions/cs_platform", async (body, query) => {
    await db("tenants")
      .where({ id: tenant.id })
      .update({ platform_subscription_id: "sub_changed" });
    return retrieve(body, query);
  });
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_checkout_changed",
  });
});

test("new session IDs persist before a missing URL error and provider retrieval failures never create replacements", async () => {
  const create = routes.get("POST /v1/checkout/sessions")!;
  routes.set("POST /v1/checkout/sessions", async (body, query) => {
    const session = (await create(body, query)) as Record<string, unknown>;
    session.url = null;
    return session;
  });
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "stripe_session",
  });
  assert.equal(
    (await db("platform_checkouts").first()).session_id,
    "cs_platform",
  );
  failures.set("GET /v1/checkout/sessions/cs_platform", 404);
  await assert.rejects(billing.checkout(tenant, seller), { statusCode: 404 });
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 1);
});

test("an older active subscription also blocks checkout when the stored subscription is newer and terminal", async () => {
  await db("tenants").where({ id: tenant.id }).update({
    platform_customer_id: "cus_platform",
    platform_subscription_id: "sub_old",
  });
  routes.set("GET /v1/subscriptions/sub_old", () => ({
    id: "sub_old",
    customer: "cus_platform",
    status: "canceled",
    livemode: false,
    created: 200,
  }));
  routes.set("GET /v1/subscriptions", () =>
    list("/v1/subscriptions", [
      {
        id: "sub_older_active",
        customer: "cus_platform",
        status: "active",
        created: 100,
        items: { data: [{ price: { id: "price_platform" } }] },
      },
    ]),
  );
  await assert.rejects(billing.checkout(tenant, seller), {
    code: "platform_subscription_exists",
  });
  assert.equal(requests.filter((r) => r.body.has("mode")).length, 0);
});

test("a replacement created in the same provider second can replace a terminal binding without reviving an older terminal ID", async () => {
  await db("tenants").where({ id: tenant.id }).update({
    platform_customer_id: "cus_platform",
    platform_subscription_id: "sub_old",
  });
  routes.set("GET /v1/subscriptions/sub_old", () => ({
    id: "sub_old",
    customer: "cus_platform",
    status: "canceled",
    livemode: false,
    created: 100,
  }));
  const items = { data: [{ price: { id: "price_platform" } }] };
  routes.set("GET /v1/subscriptions", () =>
    list("/v1/subscriptions", [
      {
        id: "sub_older",
        customer: "cus_platform",
        created: 100,
        status: "canceled",
        items,
      },
      {
        id: "sub_new",
        customer: "cus_platform",
        created: 100,
        status: "active",
        items,
      },
    ]),
  );
  routes.set("GET /v1/subscriptions/sub_new", () => ({
    id: "sub_new",
    customer: "cus_platform",
    status: "active",
    created: 100,
    livemode: false,
  }));
  routes.set("GET /v1/invoices", () => list("/v1/invoices", []));
  await billing.reconcile(tenant.id);
  assert.equal(
    (await db("tenants").where({ id: tenant.id }).first())
      .platform_subscription_id,
    "sub_new",
  );
});

test(
  "concurrent canonical replacement applies converge on one binding and one audit transition",
  { timeout: 5000 },
  async () => {
    await db("tenants").where({ id: tenant.id }).update({
      platform_customer_id: "cus_platform",
      platform_subscription_id: "sub_old",
    });
    routes.set("GET /v1/subscriptions/sub_old", () => ({
      id: "sub_old",
      customer: "cus_platform",
      status: "canceled",
      livemode: false,
      created: 100,
    }));
    routes.set("GET /v1/subscriptions", () =>
      list("/v1/subscriptions", [
        {
          id: "sub_new",
          customer: "cus_platform",
          status: "active",
          created: 200,
          items: { data: [{ price: { id: "price_platform" } }] },
        },
      ]),
    );
    routes.set("GET /v1/subscriptions/sub_new", () => ({
      id: "sub_new",
      customer: "cus_platform",
      status: "active",
      livemode: false,
      created: 200,
    }));
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0;
    routes.set("GET /v1/invoices", async () => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
      return list("/v1/invoices", []);
    });
    const pending = billing.reconcile(tenant.id);
    await entered.promise;
    try {
      await new Billing(db, config, stripe).reconcile(tenant.id);
    } finally {
      release.resolve();
    }
    await pending;
    assert.equal(
      (await db("tenants").where({ id: tenant.id }).first())
        .platform_subscription_id,
      "sub_new",
    );
    assert.equal(
      (
        await db("audit_events").where({
          action: "platform.subscription_changed",
        })
      ).length,
      1,
    );
  },
);
