import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import Stripe from "stripe";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDb, createTenant, migrate, type Tenant } from "../src/db.ts";
import { StripeBilling } from "../src/stripe.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { Billing, reconciliationLockId } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { seal } from "../src/crypto.ts";
import { stripeWorkerHttpClient } from "../src/worker-continuation.ts";
import { assertQueueLease, runQueue } from "../src/queue.ts";

const list = (data: unknown[], has_more = false) => ({ object: "list", data, has_more });
const invoice = (id: string) => ({ id, status: "paid", amount_paid: 100, currency: "usd", created: 100,
  status_transitions: { paid_at: 101 }, parent: { subscription_details: { subscription: "sub_one" } } });
type Handler = (url: URL, response: ServerResponse) => unknown;

async function fixture(t: TestContext, handler: Handler) {
  const directory = await mkdtemp("/Volumes/Scratch/entitle/tmp/worker-scheduling-");
  const config = loadConfig({ DEPLOYMENT_MODE: "hosted", APP_SECRET: "71".repeat(32),
    OPERATOR_TOKEN: "worker-operator-token".repeat(3), DATA_DIR: directory,
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_PUBLISHABLE_KEY: "pk_test_fixture", STRIPE_CONNECT_CLIENT_ID: "ca_fixture",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_fixture", PLATFORM_STRIPE_PRICE_ID: "price_platform" });
  const db = createDb(config.databaseUrl), requests: URL[] = [];
  let active = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://fixture"); requests.push(url); active++;
    res.once("close", () => { active--; });
    res.setHeader("content-type", "application/json");
    const result = handler(url, res);
    if (result !== undefined) res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const client = () => new Stripe("sk_test_fixture", { host: "127.0.0.1", port,
    protocol: "http", maxNetworkRetries: 0, httpClient: stripeWorkerHttpClient() });
  const adapter = (tenant: Tenant) => {
    const source = new StripeBilling(db, config, tenant); source.stripe = client(); return source;
  };
  await migrate(db);
  const app = await buildApp(config, db, { send: async () => {} }, {
    store: new InMemoryArtifactStore(), platformBilling: new PlatformBilling(db, config, client()),
    stripeFactory: adapter, billingWorker: { budgetMs: 100, maxRequests: 8, maxOwnersPerTick: 4 },
  });
  t.after(async () => {
    await app.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.destroy(); await rm(directory, { recursive: true, force: true });
  });
  const publisher = async (id: string) => {
    const tenant = await createTenant(db, { id, slug: id, name: id, exempt: 1,
      stripe_account_id: `acct_${id}`, stripe_status: "connected" });
    await db("products").insert({ tenant_id: id, id: `product_${id}`, slug: "product", name: "Product" });
    await db("plans").insert({ tenant_id: id, id: `plan_${id}`, product_id: `product_${id}`, name: "Plan", site_allowance: 1, stripe_price_id: "price" });
    return tenant;
  };
  const billing = (tenant: Tenant) => {
    const source = adapter(tenant);
    return { source, billing: new Billing(db, new Licenses(db, config.secret, [], tenant), source) };
  };
  return { app, db, config, requests, publisher, billing, active: () => active,
    tick: () => (app as typeof app & { tick: () => Promise<void> }).tick() };
}

function healthy(url: URL) {
  if (url.pathname.startsWith("/v1/subscriptions/")) return { id: url.pathname.split("/").at(-1), customer: "cus_healthy", status: "active" };
  if (url.pathname === "/v1/customers/cus_healthy") return { id: "cus_healthy", email: "healthy@example.test" };
  if (url.pathname === "/v1/invoices") return list([invoice("in_healthy")]);
  if (url.pathname === "/v1/invoice_payments") return list([]);
  if (url.pathname === "/v1/invoices/in_healthy/lines") return list([{ id: "il_healthy", amount: 100,
    parent: { subscription_item_details: {} }, pricing: { price_details: { price: "price" } },
    period: { start: 100, end: Math.floor(Date.now() / 1000) + 86400 } }]);
  throw Error(`Unexpected fixture ${url}`);
}

test("four stuck provider histories and a stuck platform read yield turns to a later healthy publisher", async (t) => {
  const stuck = new Set(["sub_slow0", "sub_slow1", "sub_slow2", "sub_slow3"]);
  let canceled = 0;
  const f = await fixture(t, (url, res) => {
    if (stuck.has(url.pathname.split("/").at(-1)!) || url.pathname === "/v1/accounts/acct_platform") {
      res.writeHead(200); res.flushHeaders(); res.write("{");
      res.once("close", () => { canceled++; }); return undefined;
    }
    return healthy(url);
  });
  const platform = await f.publisher("platform");
  await f.db("tenants").where({ id: platform.id }).update({ stripe_account_id: "acct_platform" });
  const event = { id: "evt_platform", type: "account.updated", account: "acct_platform", livemode: false, data: { object: {} } };
  await f.db("platform_events").insert({ id: event.id, type: event.type, payload: seal(event, f.config.secret), received_at: Date.now() });
  await f.db("platform_work").insert({ id: event.id, kind: "connect_account", payload: seal({ eventId: event.id }, f.config.secret), created_at: Date.now() });
  for (const id of ["slow0", "slow1", "slow2", "slow3", "zz-healthy"]) {
    const tenant = await f.publisher(id);
    await f.billing(tenant).billing.enqueueReconcile([id === "zz-healthy" ? "sub_healthy" : `sub_${id}`]);
  }
  for (let pass = 0; pass < 20; pass++) {
    const started = performance.now(); await f.tick();
    assert.ok(performance.now() - started < 1000, "provider body must not hold the tick indefinitely");
    if (await f.db("licenses").where({ tenant_id: "zz-healthy" }).first()) break;
  }
  assert.ok(await f.db("licenses").where({ tenant_id: "zz-healthy" }).first(), "later publisher must get a bounded turn");
  await delay(10);
  assert.ok(canceled >= 5, "all four publisher reads and the platform read were actually canceled");
  assert.equal(f.active(), 0);
  const pending = await f.db("work").whereNot({ tenant_id: "zz-healthy" });
  assert.equal(pending.length, 4);
  assert.ok(pending.every((job) => job.state === "pending" && job.attempts === 0));
  assert.equal((await f.db("platform_events").where({ id: event.id }).first()).processed_at, null);
});

test("durable nested snapshot cursors survive fresh adapter instances and never publish a partial history", async (t) => {
  const count = 12;
  const f = await fixture(t, (url) => {
    if (url.pathname === "/v1/invoices") {
      const index = url.searchParams.has("starting_after") ? Number(url.searchParams.get("starting_after")!.slice(3)) + 1 : 0;
      return list([invoice(`in_${index}`)], index + 1 < count);
    }
    if (url.pathname === "/v1/invoice_payments") {
      const selected = url.searchParams.get("invoice")!.slice(3);
      return list([{ id: `ip_${selected}`, payment: { payment_intent: `pi_${selected}` } }]);
    }
    if (url.pathname === "/v1/charges") {
      const selected = Number(url.searchParams.get("payment_intent")!.slice(3));
      return list([{ id: `ch_${selected}`, paid: true, amount_refunded: selected === count - 1 ? 100 : 0, disputed: selected === count - 1 }]);
    }
    if (url.pathname === "/v1/disputes") return url.searchParams.has("starting_after")
      ? list([{ id: "dp_open", status: "needs_response" }]) : list([{ id: "dp_won", status: "won" }], true);
    if (/^\/v1\/invoices\/in_\d+\/lines$/.test(url.pathname)) {
      const selected = url.pathname.split("/")[3]!;
      return list([{ id: `il_${selected}`, amount: 100,
        parent: { subscription_item_details: {} }, pricing: { price_details: { price: "price" } },
        period: { start: 100, end: Math.floor(Date.now() / 1000) + 86400 } }]);
    }
    return healthy(url);
  });
  const tenant = await f.publisher("large");
  await f.billing(tenant).billing.enqueueReconcile(["sub_many"]);
  await f.db("work").where({ tenant_id: tenant.id }).update({ created_at: Date.now() - 4 * 86400000 });
  for (let pass = 0; pass < 100; pass++) {
    const before = f.requests.length, { source, billing } = f.billing(tenant);
    await billing.run((event) => source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 2 });
    assert.ok(f.requests.length - before <= 2);
    const job = await f.db("work").where({ tenant_id: tenant.id }).first();
    if (job.state === "sent") break;
    assert.equal(job.state, "pending"); assert.equal(job.attempts, 0);
    assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
    assert.equal((await f.db("emails").where({ tenant_id: tenant.id })).length, 0);
    await f.db("work").where({ tenant_id: tenant.id }).update({ available_at: 0 });
  }
  const license = await f.db("licenses").where({ tenant_id: tenant.id }).first();
  assert.ok(license, "history larger than one turn must eventually complete");
  assert.equal(license.suspended, 1); assert.equal(license.refund_revoked, 1);
  assert.equal((await f.db("grants").where({ tenant_id: tenant.id })).length, count);
  assert.equal((await f.db("invoice_metrics").where({ tenant_id: tenant.id })).length, count);
  assert.equal((await f.db("emails").where({ tenant_id: tenant.id })).length, 1);
  assert.equal((await f.db("worker_continuations")).length, 0);
  assert.equal((await f.db("worker_continuation_facts")).length, 0);
  assert.equal(f.requests.filter((url) => url.pathname === "/v1/invoices").length, count, "completed pages are not replayed");
});

test("legacy charge resolution resumes invoice and payment cursors before marking its event processed", async (t) => {
  const f = await fixture(t, (url) => {
    if (url.pathname === "/v1/charges/ch_legacy") return { id: "ch_legacy", customer: "cus_healthy", payment_intent: null };
    if (url.pathname === "/v1/invoices" && url.searchParams.has("customer")) {
      const index = url.searchParams.has("starting_after") ? Number(url.searchParams.get("starting_after")!.slice(7)) + 1 : 0;
      return list([{ id: `legacy_${index}`, parent: { subscription_details: { subscription: "sub_one" } } }], index < 3);
    }
    if (url.pathname === "/v1/invoice_payments" && url.searchParams.get("invoice")?.startsWith("legacy_")) {
      const last = url.searchParams.get("invoice") === "legacy_3";
      return list([{ id: `ip_${url.searchParams.get("invoice")}`, payment: { charge: last ? "ch_legacy" : "ch_other" } }]);
    }
    return healthy(url);
  });
  const tenant = await f.publisher("legacy");
  await f.billing(tenant).billing.receive({ id: "evt_legacy", type: "charge.refunded", data: { object: { id: "ch_legacy", customer: "cus_healthy" } } });
  for (let pass = 0; pass < 30; pass++) {
    const { billing, source } = f.billing(tenant);
    await billing.run((event) => source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 2 });
    const event = await f.db("billing_events").where({ tenant_id: tenant.id, id: "evt_legacy" }).first();
    if (event.processed_at) break;
    assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
    await f.db("work").where({ tenant_id: tenant.id }).update({ available_at: 0 });
  }
  assert.ok((await f.db("billing_events").where({ tenant_id: tenant.id, id: "evt_legacy" }).first()).processed_at);
  assert.ok(await f.db("licenses").where({ tenant_id: tenant.id }).first());
  assert.equal(f.requests.filter((url) => url.pathname === "/v1/invoices" && url.searchParams.has("customer")).length, 4);
});

test("worker queue renews a long live lease and fences a replaced lease before applying", async (t) => {
  const f = await fixture(t, healthy), tenant = await f.publisher("lease");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  await f.db("work").insert({ tenant_id: tenant.id, id: "lease", kind: "fixture", payload: "{}", created_at: Date.now() });
  const running = runQueue(f.db, "work", async () => {
    entered.resolve(); await release.promise;
    await f.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await tx("tenants").where({ id: tenant.id }).update({ name: "stale apply" });
    });
  }, 1, tenant.id, { leaseMs: 200, heartbeatMs: 10 });
  await entered.promise;
  try {
    const before = await f.db("work").where({ tenant_id: tenant.id }).first(); await delay(30);
    assert.ok((await f.db("work").where({ tenant_id: tenant.id }).first()).lease_until > before.lease_until);
    await f.db("work").where({ tenant_id: tenant.id }).update({ lease_owner: "replacement" });
  } finally { release.resolve(); await running; }
  assert.equal((await f.db("tenants").where({ id: tenant.id }).first()).name, tenant.name);
  assert.equal((await f.db("work").where({ tenant_id: tenant.id }).first()).lease_owner, "replacement");
});

test("a changed subscription revision discards staged evidence before a new scan", async (t) => {
  const f = await fixture(t, healthy), tenant = await f.publisher("revision");
  await f.billing(tenant).billing.enqueueReconcile(["sub_one"]);
  let services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 2 });
  assert.equal((await f.db("worker_continuations")).length, 1);
  await f.db("locks").where({ id: reconciliationLockId(tenant.id, "sub_one") }).increment("version", 1);
  await f.db("work").where({ tenant_id: tenant.id }).update({ available_at: 0 });
  services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 2 });
  assert.equal(f.requests.filter((url) => url.pathname === "/v1/subscriptions/sub_one").length, 2);
  assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
});

test("a capacity-held completed scan is discarded so later issuance observes fresh provider history", async (t) => {
  let reads = 0;
  const f = await fixture(t, (url) => {
    if (url.pathname.startsWith("/v1/subscriptions/")) reads++;
    return healthy(url);
  });
  const tenant = await f.publisher("held");
  await f.billing(tenant).billing.enqueueReconcile(["sub_one"]);
  await f.db("tenants").where({ id: tenant.id }).update({ suspended: 1 });
  let services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 20 });
  assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
  assert.equal((await f.db("worker_continuations")).length, 0);
  assert.equal((await f.db("worker_continuation_facts")).length, 0);
  const before = reads;
  await f.db("tenants").where({ id: tenant.id }).update({ suspended: 0 });
  await f.db("work").where({ tenant_id: tenant.id }).update({ available_at: 0 });
  services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 20 });
  assert.ok(reads > before, "resumed issuance must fetch canonical provider facts again");
  assert.ok(await f.db("licenses").where({ tenant_id: tenant.id }).first());
});

test("a completed scan is refreshed after a failed apply so corrected provider data can recover", async (t) => {
  let corrected = false;
  const f = await fixture(t, (url) => {
    if (url.pathname === "/v1/customers/cus_healthy")
      return { id: "cus_healthy", email: corrected ? "healthy@example.test" : null };
    return healthy(url);
  });
  const tenant = await f.publisher("retry");
  await f.billing(tenant).billing.enqueueReconcile(["sub_one"]);
  let services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 20 });
  assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
  assert.equal((await f.db("work").where({ tenant_id: tenant.id }).first()).state, "pending");
  const before = f.requests.length;
  corrected = true;
  await f.db("work").where({ tenant_id: tenant.id }).update({ available_at: 0 });
  services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 20 });
  assert.ok(f.requests.length > before, "an apply retry must refresh completed provider evidence");
  assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 1);
  assert.equal((await f.db("emails").where({ tenant_id: tenant.id })).length, 1);
});

test("a replacement lease refreshes completed evidence left by an interrupted apply", async (t) => {
  const { WorkerTurn } = await import("../src/worker-continuation.ts");
  let email = "before@example.test";
  const f = await fixture(t, (url) => url.pathname === "/v1/customers/cus_healthy"
    ? { id: "cus_healthy", email } : healthy(url));
  const tenant = await f.publisher("replacement");
  await f.billing(tenant).billing.enqueueReconcile(["sub_one"]);
  // Lose ownership after provider evidence is complete, before its SQL apply.
  const facts = WorkerTurn.prototype.facts;
  const fence = t.mock.method(WorkerTurn.prototype, "facts", async function<T>(this: InstanceType<typeof WorkerTurn>, slot: string, kind: string) {
    const result = await facts.call(this, slot, kind);
    if (kind === "invoices")
      await f.db("work").where({ tenant_id: tenant.id }).update({ lease_owner: "replacement" });
    return result as T[];
  });
  let services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 20 });
  assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
  assert.equal((await f.db("work").where({ tenant_id: tenant.id }).first()).lease_owner, "replacement");
  fence.mock.restore();
  email = "after@example.test";
  const before = f.requests.length;
  await f.db("work").where({ tenant_id: tenant.id }).update({ state: "pending", lease_until: 0, lease_owner: null, available_at: 0 });
  services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 20 });
  assert.ok(f.requests.length > before, "replacement workers must refresh a previous lease's completed evidence");
  assert.equal((await f.db("customers").where({ tenant_id: tenant.id }).first()).email, email);
});

test("shutdown cancels and settles provider work before the application closes", async (t) => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture(t, (url, res) => {
    if (url.pathname.startsWith("/v1/subscriptions/")) {
      res.writeHead(200); res.flushHeaders(); res.write("{"); entered.resolve(); return undefined;
    }
    return healthy(url);
  });
  const tenant = await f.publisher("shutdown");
  await f.billing(tenant).billing.enqueueReconcile(["sub_stuck"]);
  const ticking = f.tick();
  await entered.promise;
  await f.app.close();
  await ticking;
  await delay(10);
  assert.equal(f.active(), 0);
  const job = await f.db("work").where({ tenant_id: tenant.id }).first();
  assert.equal(job.state, "pending"); assert.equal(job.attempts, 0);
  assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
});

test("provider account changes discard the previous account's partial checkpoint", async (t) => {
  const f = await fixture(t, healthy), tenant = await f.publisher("identity");
  await f.billing(tenant).billing.enqueueReconcile(["sub_one"]);
  let services = f.billing(tenant);
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 2 });
  await f.db("work").where({ tenant_id: tenant.id }).update({ available_at: 0 });
  services = f.billing({ ...tenant, stripe_account_id: "acct_replaced" });
  await services.billing.run((event) => services.source.resolveSubscription(event), { budgetMs: 1000, maxRequests: 2 });
  assert.equal(f.requests.filter((url) => url.pathname === "/v1/subscriptions/sub_one").length, 2);
  assert.equal((await f.db("licenses").where({ tenant_id: tenant.id })).length, 0);
});

test("complete financial evidence can finish local reconstruction after its provider deadline", async (t) => {
  const { WorkerTurn } = await import("../src/worker-continuation.ts");
  const facts = WorkerTurn.prototype.facts;
  t.mock.method(WorkerTurn.prototype, "facts", async function<T>(this: InstanceType<typeof WorkerTurn>, slot: string, kind: string) {
    const result = await facts.call(this, slot, kind);
    if (kind === "grants") await delay(150);
    return result as T[];
  });
  const f = await fixture(t, healthy), tenant = await f.publisher("finalize");
  await f.billing(tenant).billing.enqueueReconcile(["sub_one"]);
  await f.tick();
  assert.ok(await f.db("licenses").where({ tenant_id: tenant.id }).first());
  assert.equal((await f.db("work").where({ tenant_id: tenant.id }).first()).state, "sent");
});
