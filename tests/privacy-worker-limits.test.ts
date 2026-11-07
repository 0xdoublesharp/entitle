import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { isolatedDatabase } from "./helpers/database.ts";
import { migrate } from "../src/db.ts";
import { seal } from "../src/crypto.ts";
import { completedCustomerClosure, completedSubscriptionClosure } from "../src/account-management.ts";
import { privacyReferenceDigest, sealPrivacyAttribution } from "../src/privacy-attribution.ts";
import { runQueue, type WorkerQueueOptions } from "../src/queue.ts";
import { withWorkerTurn, workerTurn } from "../src/worker-continuation.ts";

async function fixture(t: TestContext, count: number, padding = 0, references = 1) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/privacy-worker-");
  const database = await isolatedDatabase(`sqlite:${root}/db`), db = database.db;
  t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  await migrate(db);
  const secret = "49".repeat(32);
  await db("customers").insert({ tenant_id: "primary", id: "closed", email: "closed@example.test", stripe_id: null });
  await db("products").insert({ tenant_id: "primary", id: "product", slug: "product", name: "Product" });
  await db("plans").insert({ tenant_id: "primary", id: "plan", product_id: "product", name: "Plan", site_allowance: 1, stripe_price_id: "price" });
  await db("licenses").insert({ tenant_id: "primary", id: "license", customer_id: "closed", product_id: "product", plan_id: "plan", site_allowance: 1,
    paid_through: 1, billing_status: "canceled", subscription_id: "sub_closed", key_hash: "a".repeat(64), revoked: 1 });
  await db("account_closures").insert({ tenant_id: "primary", customer_id: "closed", id: "closure", status: "completed", blockers: "[]", requested_at: 1, completed_at: 2 });
  const details = JSON.stringify({ privacyMarker: "worker-receipt", padding: "x".repeat(padding),
    referenceDigests: Array.from({ length: references }, (_, index) => privacyReferenceDigest(secret, index ? `other_${index}` : "cus_target")),
    stripeLiveMode: false, stripeCustomerAttribution: sealPrivacyAttribution({ tenantId: "primary", customerId: "closed", requestId: "closure", stripeLiveMode: false }, "cus_target", secret) });
  if (count) await db.batchInsert("account_privacy_receipts", Array.from({ length: count }, (_, i) => ({
    id: `receipt_${i}`, tenant_id: "primary", customer_id: "closed", request_id: "closure", details, created_at: i,
  })), 100);
  await db("work").insert({ tenant_id: "primary", id: "job", kind: "privacy", payload: seal({ eventId: "evt_privacy" }, secret), created_at: Date.now() });
  return { db, secret, details };
}

for (const helper of ["customer", "subscription"] as const) {
  for (const dimension of ["records", "bytes", "work", "deadline", "staged_bytes"] as const) {
    test(`${helper} closure receipts enforce ${dimension} before an early matching result can finish a worker`, async (t) => {
      const f = await fixture(t, dimension === "records" ? 1001 : dimension === "bytes" ? 2 : 1,
        dimension === "bytes" ? 512 : 0, dimension === "work" ? 100 : 1);
      const limits: WorkerQueueOptions = dimension === "records" ? { maxApplyRecords: 2 }
        : dimension === "bytes" ? { maxBytes: Buffer.byteLength(f.details) * 2 - 1 }
        : dimension === "work" ? { maxApplyWork: 50 }
        : dimension === "deadline" ? { applyMs: 10000 } : { maxBytes: Buffer.byteLength(f.details) + 50 };
      const original = (await f.db("work").first()).payload;
      const parse = JSON.parse; let parses = 0, clock = 1000;
      t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
        const value = parse(...args);
        if (args[0].includes('"privacyMarker":"worker-receipt"')) {
          parses++;
          if (dimension === "deadline") clock += 10001;
        }
        return value;
      });
      if (dimension === "deadline") t.mock.method(performance, "now", () => clock);
      let payloadReads = 0;
      const query = ({ sql }: { sql: string }) => {
        if (/^select\b/i.test(sql) && /account_privacy_receipts/i.test(sql) && !/octet_length|worker_record/i.test(sql)) payloadReads++;
      };
      f.db.on("query", query); t.after(() => f.db.removeListener("query", query));
      let matched = false;
      await runQueue(f.db, "work", (job) => withWorkerTurn({ db: f.db, secret: f.secret, job, table: "work", tenantId: "primary", ...limits }, async () => {
        const turn = workerTurn()!;
        if (dimension === "staged_bytes") await turn.save("prior", { padding: "s".repeat(100) });
        turn.beginApply();
        matched = helper === "customer"
          ? !!await completedCustomerClosure(f.db, "primary", f.secret, "cus_target", false)
          : await completedSubscriptionClosure(f.db, "primary", f.secret, "sub_closed", false);
      }), 1, "primary", limits);
      const job = await f.db("work").first();
      assert.equal(job.state, "failed"); assert.equal(job.last_error, "resource_limit");
      assert.equal(job.payload, original); assert.equal(matched, false);
      if (["records", "bytes", "staged_bytes"].includes(dimension)) {
        assert.equal(payloadReads, 0, "receipt text must not be fetched before its aggregate metadata fits");
        assert.equal(parses, 0);
      }
      if (dimension === "deadline") assert.ok(parses > 0, "the deadline advances while parsing the first matching receipt");
    });
  }
  test(`${helper} closure receipts retain within-budget matching and ignore an unrelated malformed receipt`, async (t) => {
    const f = await fixture(t, 1);
    await f.db("account_privacy_receipts").insert({ id: "irrelevant", tenant_id: "primary", customer_id: "closed", request_id: "old_request", details: "malformed", created_at: 0 });
    let matched = false;
    await runQueue(f.db, "work", (job) => withWorkerTurn({ db: f.db, secret: f.secret, job, table: "work", tenantId: "primary" }, async () => {
      workerTurn()!.beginApply();
      matched = helper === "customer"
        ? !!await completedCustomerClosure(f.db, "primary", f.secret, "cus_target", false)
        : await completedSubscriptionClosure(f.db, "primary", f.secret, "sub_closed", false);
    }), 1, "primary");
    assert.equal(matched, true);
    assert.equal((await f.db("work").first()).state, "sent");

    // A false result traverses every eligible receipt; the malformed row must
    // still be ignored because its request does not bind the completed closure.
    await f.db("account_privacy_receipts").where({ id: "receipt_0" }).update({
      details: JSON.stringify({ referenceDigests: [], stripeLiveMode: false }),
    });
    await f.db("work").update({ state: "pending", available_at: 0 });
    await runQueue(f.db, "work", (job) => withWorkerTurn({ db: f.db, secret: f.secret, job, table: "work", tenantId: "primary" }, async () => {
      workerTurn()!.beginApply();
      matched = helper === "customer"
        ? !!await completedCustomerClosure(f.db, "primary", f.secret, "cus_target", false)
        : await completedSubscriptionClosure(f.db, "primary", f.secret, "sub_closed", false);
    }), 1, "primary");
    assert.equal(matched, false);
    assert.equal((await f.db("work").first()).state, "sent");
  });
}

test("receipt text bytes remain charged when a worker subsequently grows its staged checkpoint", async (t) => {
  const f = await fixture(t, 1);
  const limits = { maxBytes: Buffer.byteLength(f.details) + 100 };
  const payload = (await f.db("work").first()).payload;
  await runQueue(f.db, "work", (job) => withWorkerTurn({ db: f.db, secret: f.secret, job, table: "work", tenantId: "primary", ...limits }, async () => {
    assert.ok(await completedCustomerClosure(f.db, "primary", f.secret, "cus_target", false));
    await workerTurn()!.save("after_receipt", { padding: "x".repeat(100) });
  }), 1, "primary", limits);
  const job = await f.db("work").first();
  assert.equal(job.state, "failed"); assert.equal(job.last_error, "resource_limit");
  assert.equal(job.payload, payload);
  assert.equal((await f.db("worker_continuations")).length, 0, "oversized staging rolls back");
});

test("an early privacy match after the provider-phase deadline defers without completing the job", async (t) => {
  const f = await fixture(t, 1);
  const parse = JSON.parse; let clock = 1000, matched = false, parses = 0;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => {
    const value = parse(...args);
    if (args[0].includes('"privacyMarker":"worker-receipt"')) { parses++; clock += 5001; }
    return value;
  });
  await runQueue(f.db, "work", (job) => withWorkerTurn({ db: f.db, secret: f.secret, job, table: "work", tenantId: "primary" }, async () => {
    matched = !!await completedCustomerClosure(f.db, "primary", f.secret, "cus_target", false);
  }), 1, "primary");
  const job = await f.db("work").first();
  assert.equal(job.state, "pending"); assert.equal(job.last_error, "resource_budget");
  assert.equal(Number(job.attempts), 0); assert.equal(matched, false); assert.equal(parses, 1);
});
