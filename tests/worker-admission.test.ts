import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp, type AppOptions } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDb, createTenant, migrate } from "../src/db.ts";
import { Billing } from "../src/billing.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { hash, seal } from "../src/crypto.ts";
import type { WorkerQueueOptions } from "../src/queue.ts";

async function fixture(
  t: TestContext,
  run: (owner: string, worker?: WorkerQueueOptions) => Promise<void>,
  worker: AppOptions["billingWorker"] = {},
  role = "all",
) {
  const directory = await mkdtemp("/Volumes/Scratch/entitle/tmp/worker-admission-");
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted", APP_SECRET: "82".repeat(32),
    OPERATOR_TOKEN: "worker-admission-fixture".repeat(2),
    DATA_DIR: directory, LOCAL_BILLING: "true", SERVER_ROLE: role,
  });
  const db = createDb(config.databaseUrl);
  await migrate(db);
  const platform = new PlatformBilling(db, config);
  t.mock.method(platform, "run", async (options?: WorkerQueueOptions) => run("platform", options));
  t.mock.method(Billing.prototype, "run", async function (
    this: Billing,
    _resolve: Parameters<Billing["run"]>[0],
    options?: WorkerQueueOptions,
  ) { await run(this.licensing.tenant.id, options); });
  const app = await buildApp(config, db, { send: async () => {} }, {
    store: new InMemoryArtifactStore(), platformBilling: platform, billingWorker: worker,
  });
  t.after(async () => {
    await app.close();
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  const add = async (id: string) => {
    await createTenant(db, { id, slug: id, name: id, exempt: 1 });
    const key = `DE-TK-${id.padEnd(43, "x")}`;
    await db("tenant_api_keys").insert({
      tenant_id: id, id: `key_${id}`, name: "Fixture", key_hash: hash(key),
      scopes: '["billing:reconcile"]', display_prefix: key.slice(0, 14),
      created_at: Date.now(), expires_at: Date.now() + 86400000,
    });
    await db("work").insert({
      tenant_id: id, id: `job_${id}`, kind: "reconcile",
      payload: seal({ subscriptionId: `sub_${id}` }, config.secret), created_at: Date.now(),
    });
    return { authorization: `Bearer ${key}` };
  };
  const manual = (id: string, headers: Record<string, string>) => app.inject({
    method: "POST", url: `/api/v1/tenants/${id}/seller/jobs/run`, payload: {}, headers,
  });
  const tick = () => (app as typeof app & { tick: () => Promise<void> }).tick();
  return { app, db, config, add, manual, tick };
}

test("billing fairness resumes by owner identity after tenants are inserted before its old position", async (t) => {
  let now = 10000;
  t.mock.method(performance, "now", () => now);
  const calls: string[] = [];
  const f = await fixture(t, async (owner) => {
    calls.push(owner);
    if (owner === "platform") await f.db("platform_work").update({ state: "sent" });
  }, { maxOwnersPerTick: 1 });
  await f.add("b");
  await f.add("c");
  await f.db("platform_work").insert({ id: "platform-job", kind: "reconcile", payload: "{}", created_at: Date.now() });
  await f.tick();
  assert.deepEqual(calls, ["platform"]);
  await f.add("a");
  now += 5001;
  await f.tick();
  assert.deepEqual(calls, ["platform", "a"]);
  await f.add("0");
  now += 5001;
  await f.tick();
  assert.deepEqual(calls, ["platform", "a", "b"]);
  await f.db("work").where({ tenant_id: "b" }).delete();
  now += 5001;
  await f.tick();
  assert.deepEqual(calls, ["platform", "a", "b", "c"]);
});

test("manual billing shares one provider admission and the owner quota with scheduled work", async (t) => {
  let now = 10000;
  t.mock.method(performance, "now", () => now);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const f = await fixture(t, async (owner) => {
    calls.push(owner);
    if (calls.length === 1) { started.resolve(); await release.promise; }
  }, { maxOwnersPerTick: 1 });
  const a = await f.add("a"), b = await f.add("b");
  const first = f.manual("a", a);
  await started.promise;
  try {
    await Promise.all([f.manual("a", a), f.manual("b", b), f.tick()]);
    assert.deepEqual(calls, ["a"], "overlapping manual and scheduled requests do not start more provider scans");
  } finally { release.resolve(); await first; }
  await f.manual("a", a);
  await f.manual("b", b);
  await f.tick();
  assert.deepEqual(calls, ["a"], "manual requests cannot reset the current owner quota");
  now += 5001;
  await f.manual("a", a);
  assert.deepEqual(calls, ["a"], "a manual caller cannot take another owner's fair turn");
  await f.manual("b", b);
  assert.deepEqual(calls, ["a", "b"]);
});

test("manual billing leaves another tenant's eligible provider queue untouched", async (t) => {
  const calls: string[] = [];
  const f = await fixture(t, async (owner) => {
    calls.push(owner);
    await f.db("work").where({ tenant_id: owner }).update({ state: "sent" });
  });
  const a = await f.add("a"), b = await f.add("b");
  assert.equal((await f.manual("b", b)).statusCode, 200);
  assert.deepEqual(calls, [], "waiting for an earlier owner never processes its queue on the caller's behalf");
  assert.equal((await f.db("work").where({ tenant_id: "a" }).first()).state, "pending");
  assert.equal((await f.manual("a", a)).statusCode, 200);
  assert.deepEqual(calls, ["a"]);
  assert.equal((await f.db("work").where({ tenant_id: "b" }).first()).state, "pending");
});

test("API-only servers refuse manual tenant workers", async (t) => {
  const calls: string[] = [];
  const f = await fixture(t, async (owner) => { calls.push(owner); }, {}, "api");
  const headers = await f.add("a");
  const response = await f.manual("a", headers);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().error.code, "jobs_disabled");
  assert.deepEqual(calls, []);
});

test("the shared billing deadline cancels an admitted turn even before its provider helper starts", async (t) => {
  let cancelled = false;
  const f = await fixture(t, async (_owner, worker) => {
    await delay(worker!.budgetMs! + 5);
    cancelled = worker!.signal!.aborted;
  }, { budgetMs: 100 });
  const headers = await f.add("a");
  assert.equal((await f.manual("a", headers)).statusCode, 200);
  assert.equal(cancelled, true, "claim/setup delays do not grant a fresh provider deadline");
});

test("shutdown aborts and awaits an admitted manual provider turn", async (t) => {
  const started = Promise.withResolvers<void>();
  let cleaned = false;
  const f = await fixture(t, async (_owner, worker) => {
    started.resolve();
    await new Promise<void>((resolve) => worker!.signal!.addEventListener("abort", () => resolve(), { once: true }));
    await delay(10);
    cleaned = true;
  });
  const headers = await f.add("a");
  const manual = f.manual("a", headers);
  await started.promise;
  try {
    await f.app.close();
    assert.equal(cleaned, true, "close waits for provider cancellation cleanup");
  } finally { await manual; }
});

test("real HTTP shutdown aborts a manual provider before waiting for its connection to drain", async (t) => {
  const started = Promise.withResolvers<void>();
  const forced = Promise.withResolvers<void>();
  let cancelledBeforeDrain = false;
  const f = await fixture(t, async (_owner, worker) => {
    started.resolve();
    const cancelled = new Promise<void>((resolve) => worker!.signal!.addEventListener("abort", () => resolve(), { once: true }));
    await Promise.race([cancelled, forced.promise]);
    cancelledBeforeDrain = worker!.signal!.aborted;
    await delay(10);
  });
  const headers = await f.add("a");
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  const requestAbort = new AbortController();
  const request = fetch(`${address}/api/v1/tenants/a/seller/jobs/run`, {
    method: "POST", headers: { ...headers, "content-type": "application/json", connection: "close" }, body: "{}", signal: requestAbort.signal,
  });
  const escape = setTimeout(() => forced.resolve(), 1000);
  let admissionTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const admission = await Promise.race([
      started.promise.then(() => "started"),
      request.then(async (response) => `${response.status} ${await response.text()}`),
      new Promise<string>((resolve) => { admissionTimeout = setTimeout(() => resolve("provider admission timed out"), 500); }),
    ]);
    assert.equal(admission, "started");
    await f.app.close();
    assert.equal(cancelledBeforeDrain, true, "preClose cancels active providers before server.close waits for HTTP requests");
  } finally {
    clearTimeout(escape);
    clearTimeout(admissionTimeout);
    forced.resolve();
    requestAbort.abort();
    await request.catch(() => {});
  }
});
