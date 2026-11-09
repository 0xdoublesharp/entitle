import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createTenant, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { seal } from "../src/crypto.ts";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { primaryTenant } from "./helpers/tenant.ts";
import { runQueue, WorkerResourceLimit } from "../src/queue.ts";
import { withWorkerTurn, workerTurn, workerContinuationScope } from "../src/worker-continuation.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp("/Volumes/Scratch/entitle/tmp/worker-resource-");
  const database = await isolatedDatabase(`sqlite:${directory}/db`);
  const db = database.db, secret = "63".repeat(32);
  t.after(async () => { await database.close(); await rm(directory, { recursive: true, force: true }); });
  await migrate(db);
  await db("work").insert({ tenant_id: "primary", id: "job", kind: "reconcile",
    payload: seal({ subscriptionId: "sub_limits" }, secret), created_at: Date.now() });
  const job = () => db("work").where({ tenant_id: "primary", id: "job" }).first();
  return { db, secret, job };
}
const snapshot = (): BillingSnapshot => ({ subscriptionId: "sub_limits", customerId: "cus_limits",
  email: "buyer@example.test", billingStatus: "active", suspended: false, fullyRefunded: false,
  grants: [0, 1, 2].map((i) => ({ id: `grant_${i}`, invoiceId: `invoice_${i}`, priceId: "price_limits",
    periodStart: 1000, periodEnd: Date.now() + 86400000, paidAt: 2000, settled: true })),
  invoices: [0, 1].map((i) => ({ invoiceId: `invoice_${i}`, currency: "usd", paidMinor: 100, refundedMinor: 0 })) });
async function merchant(t: TestContext) {
  const f = await fixture(t);
  await f.db("products").insert({ tenant_id: "primary", id: "product", slug: "product", name: "Product" });
  await f.db("plans").insert({ tenant_id: "primary", id: "plan", product_id: "product", name: "Plan", site_allowance: 1, stripe_price_id: "price_limits" });
  const billing = new Billing(f.db, new Licenses(f.db, f.secret, [], primaryTenant), {
    snapshot: async () => { workerTurn()!.beginApply(); return snapshot(); },
  });
  return { ...f, billing };
}

for (const dimension of ["facts", "bytes"] as const) {
  test(`aggregate staged ${dimension} ceiling holds the job instead of silently completing`, async (t) => {
    const f = await fixture(t);
    const originalPayload = (await f.job()).payload;
    const limits = dimension === "facts" ? { maxFacts: 2 } : { maxBytes: 128 };
    if (dimension === "bytes") {
      assert.ok(seal({ phase: "scan" }, f.secret).length < 128);
      assert.ok(seal(1, f.secret).length + seal(2, f.secret).length < 128);
    }
    await runQueue(f.db, "work", (job) => withWorkerTurn({
      db: f.db, secret: f.secret, job, table: "work", tenantId: "primary", ...limits,
    }, async () => {
      await workerTurn()!.save("limits", { phase: "scan" }, [
        { kind: "grant", id: "a", value: 1 }, { kind: "grant", id: "b", value: 2 },
      ]);
    }), 1, "primary", limits);
    assert.equal((await f.job()).state, "failed");
    assert.equal((await f.job()).last_error, "resource_limit");
    assert.equal((await f.job()).payload, originalPayload);
  });
}

test("legacy oversized staged evidence is held before an unbounded payload SELECT or decryption", async (t) => {
  const f = await fixture(t), scope = workerContinuationScope("work", "primary", "job");
  await f.db("worker_continuation_facts").insert([0, 1, 2, 3].map((i) => ({
    scope, slot: "legacy", kind: "grant", id: String(i), position: i, payload: seal({ id: i }, f.secret),
  })));
  let payloadFetches = 0;
  const count = (query: { sql: string }) => {
    if (/^select\s+["`]?payload["`]?\s+from\s+["`]?worker_continuation_facts["`]?/i.test(query.sql)) payloadFetches++;
  };
  f.db.on("query", count); t.after(() => f.db.removeListener("query", count));
  await runQueue(f.db, "work", (job) => withWorkerTurn({
    db: f.db, secret: f.secret, job, table: "work", tenantId: "primary", maxApplyRecords: 2,
  }, async () => { workerTurn()!.beginApply(); await workerTurn()!.facts("legacy", "grant"); }), 1, "primary", { maxApplyRecords: 2 });
  assert.equal((await f.job()).state, "failed");
  assert.equal(payloadFetches, 0);
  assert.equal((await f.db("worker_continuation_facts").where({ scope })).length, 4, "operator evidence remains retained");
});

for (const dimension of ["records", "work", "deadline"] as const) {
  test(`merchant apply ${dimension} ceiling rolls back every partial license, email and metric`, async (t) => {
    const f = await merchant(t);
    const limits = dimension === "records" ? { maxApplyRecords: 2 } : dimension === "work" ? { maxApplyWork: 1 } : { applyMs: 10000 };
    let advanced = false;
    if (dimension === "deadline") {
      let clock = 1000;
      t.mock.method(performance, "now", () => clock);
      const advance = (_rows: unknown, query: { sql: string }) => {
        if (/^insert into ["`]?invoice_metrics\b/i.test(query.sql)) { clock += 10001; advanced = true; }
      };
      f.db.on("query-response", advance); t.after(() => f.db.removeListener("query-response", advance));
    }
    await f.billing.run(async () => null, limits);
    if (dimension === "deadline") assert.equal(advanced, true, "deadline must interrupt after an actual SQL write");
    assert.equal((await f.job()).state, "failed");
    assert.equal((await f.job()).last_error, "resource_limit");
    for (const table of ["licenses", "grants", "emails", "invoice_metrics", "business_events"])
      assert.equal((await f.db(table)).length, 0, table);
  });
}

test("a held Stripe event stays unprocessed while another owner progresses, then an explicit raised-limit retry applies all evidence", async (t) => {
  const f = await merchant(t), original = seal({ id: "evt_limits", type: "invoice.paid", data: { object: {} } }, f.secret);
  await f.db("billing_events").insert({ tenant_id: "primary", id: "evt_limits", type: "invoice.paid", payload: original, received_at: Date.now() });
  await f.db("work").where({ id: "job", tenant_id: "primary" }).update({ kind: "stripe_event", payload: seal({ eventId: "evt_limits" }, f.secret) });
  const originalJob = (await f.job()).payload;
  let snapshots = 0;
  const read = f.billing.source.snapshot;
  t.mock.method(f.billing.source, "snapshot", async (id: string) => { snapshots++; return read(id); });
  await f.billing.run(async () => "sub_limits", { maxApplyRecords: 2 });
  assert.equal((await f.job()).state, "failed");
  assert.equal((await f.job()).payload, originalJob);
  let event = await f.db("billing_events").where({ tenant_id: "primary", id: "evt_limits" }).first();
  assert.equal(event.processed_at, null); assert.equal(event.payload, original);
  await f.billing.run(async () => "sub_limits", { maxApplyRecords: 20 });
  assert.equal(snapshots, 1, "raising configuration alone does not hot-retry a held job");

  const other = await createTenant(f.db, { id: "healthy", slug: "healthy", name: "Healthy", exempt: 1 });
  await f.db("products").insert({ tenant_id: other.id, id: "healthy_product", slug: "product", name: "Product" });
  await f.db("plans").insert({ tenant_id: other.id, id: "healthy_plan", product_id: "healthy_product", name: "Plan", site_allowance: 1, stripe_price_id: "price_limits" });
  const healthy = new Billing(f.db, new Licenses(f.db, f.secret, [], other), {
    snapshot: async () => { workerTurn()!.beginApply(); return { ...snapshot(), subscriptionId: "sub_healthy", grants: [{ ...snapshot().grants[0]!, id: "healthy_grant" }], invoices: [] }; },
  });
  await healthy.enqueueReconcile(["sub_healthy"]);
  await healthy.run(async () => null, { maxApplyRecords: 20 });
  assert.ok(await f.db("licenses").where({ tenant_id: other.id }).first());
  assert.equal((await f.job()).state, "failed");

  // The existing explicit retry operation resets only the failed queue row.
  await f.db("work").where({ id: "job", tenant_id: "primary", state: "failed" }).update({ state: "pending", available_at: 0, attempts: 0 });
  await f.billing.run(async () => "sub_limits", { maxApplyRecords: 20 });
  assert.equal(snapshots, 2, "recovery reads canonical evidence again");
  assert.equal((await f.job()).state, "sent");
  assert.equal((await f.db("grants").where({ tenant_id: "primary" })).length, 3);
  event = await f.db("billing_events").where({ tenant_id: "primary", id: "evt_limits" }).first();
  assert.ok(event.processed_at);
});

test("platform nested credit work is held before quota changes and retains completed evidence", async (t) => {
  const f = await fixture(t);
  const config = loadConfig({ APP_SECRET: f.secret, OPERATOR_TOKEN: "operator-limits".repeat(3), DEPLOYMENT_MODE: "hosted" });
  const platform = new PlatformBilling(f.db, config);
  const credited = platform as unknown as { creditedGrants: (line: unknown, subscription: string, grants: Map<string, unknown>) => unknown[] };
  const grants = new Map(Array.from({ length: 50 }, (_, i) => [`g${i}`, { id: `g${i}`, revoked: 0, subscription_id: "sub", invoice_id: "invoice", price_id: "price", period_start: 0, period_end: 30000 }]));
  const line = { amount: -100, period: { start: 1, end: 2 }, pricing: { price_details: { price: "price" } },
    parent: { subscription_item_details: { proration: true, proration_details: { credited_items: { invoice: "invoice", invoice_line_items: [...grants.keys()] } } } } };
  const before = await f.db("tenants").where({ id: "primary" }).first();
  let checkpoint: string | undefined;
  await runQueue(f.db, "work", (job) => withWorkerTurn({ db: f.db, secret: f.secret, job, table: "work", tenantId: "primary", maxApplyWork: 1000 }, async () => {
    const turn = workerTurn()!;
    await turn.save("platform", { phase: "ready" }, [], true);
    checkpoint = (await f.db("worker_continuations").first()).payload;
    turn.beginApply();
    credited.creditedGrants(line, "sub", grants);
    await f.db("tenants").where({ id: "primary" }).update({ max_products: 999 });
  }), 1, "primary", { maxApplyWork: 1000 });
  assert.equal((await f.job()).state, "failed"); assert.equal((await f.job()).last_error, "resource_limit");
  assert.equal((await f.db("tenants").where({ id: "primary" }).first()).max_products, before.max_products);
  assert.equal((await f.db("worker_continuations").first()).payload, checkpoint);
});

test("an apply resource limit remains a retained hold when shutdown races its rollback", async (t) => {
  const f = await fixture(t), stopping = new AbortController();
  await runQueue(f.db, "work", (job) => withWorkerTurn({ db: f.db, secret: f.secret, job, table: "work", tenantId: "primary" }, async () => {
    await workerTurn()!.save("race", { phase: "ready" }, [], true);
    workerTurn()!.beginApply(); stopping.abort();
    throw new WorkerResourceLimit("maxApplyWork", 11, 10);
  }), 1, "primary", { signal: stopping.signal });
  assert.equal((await f.job()).state, "failed"); assert.equal((await f.job()).last_error, "resource_limit");
  assert.equal((await f.db("worker_continuations")).length, 1);
});
