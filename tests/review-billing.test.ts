import { primaryTenant } from "./helpers/tenant.ts";
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createDb, migrate, reset, type Plan } from "../src/db.ts";
import {
  Billing,
  reconciliationLockId,
  type BillingSnapshot,
} from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { StripeBilling } from "../src/stripe.ts";
import { loadConfig } from "../src/config.ts";
import { randomUUID } from "node:crypto";
import { hash } from "../src/crypto.ts";
import { buildApp } from "../src/app.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";

const root = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/review-billing-",
);
const db = createDb(process.env.TEST_DATABASE_URL ?? `sqlite:${root}/db`);
const secret = "74".repeat(32);
const licenses = new Licenses(db, secret, [], primaryTenant);
const plan: Plan = {
  tenant_id: "primary",
  id: "plan",
  product_id: "product",
  name: "Plan",
  site_allowance: 1,
  stripe_price_id: "price",
};
const config = loadConfig({ DEPLOYMENT_MODE: "hosted",
  APP_SECRET: secret,
  OPERATOR_TOKEN: "review-operator-token".repeat(3),
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function snapshot(overrides: Partial<BillingSnapshot> = {}): BillingSnapshot {
  return {
    subscriptionId: "sub",
    customerId: "cus",
    email: "owner@example.test",
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "grant",
        invoiceId: "invoice",
        priceId: "price",
        periodStart: Date.now() - 1000,
        periodEnd: Date.now() + 86400000,
        paidAt: Date.now(),
        settled: true,
      },
    ],
    ...overrides,
  };
}
async function promptly<T>(promise: Promise<T>) {
  return Promise.race([promise.then(() => true), delay(250).then(() => false)]);
}
before(async () => {
  await migrate(db);
});
beforeEach(async () => {
  await reset(db);
  await db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert(plan);
});
after(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

test("concurrent scheduled passes reuse one pending job per subscription and rearm completed work", async () => {
  const billing = new Billing(db, licenses, {
    snapshot: async (subscriptionId) =>
      snapshot({ subscriptionId, grants: [] }),
  });
  const other = new Billing(db, licenses, billing.source);
  await Promise.all([
    billing.enqueueReconcile(["sub", "sub", "other"]),
    other.enqueueReconcile(["other", "sub"]),
    billing.enqueueReconcile(["sub"]),
  ]);
  const first = await db("work").orderBy("id");
  assert.equal(first.length, 2);
  assert.ok(first.every((job) => job.state === "pending"));
  await billing.run(async () => null);
  assert.ok((await db("work")).every((job) => job.state === "sent"));
  await billing.enqueueReconcile(["sub"]);
  assert.equal((await db("work")).length, 2);
  const pending = await db("work").where({ state: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 0);
  assert.equal(Number(pending[0].available_at), 0);
  assert.ok(first.some((job) => job.id === pending[0].id));
  await billing.run(async () => null);
  assert.ok((await db("work")).every((job) => job.state === "sent"));
  assert.equal((await db("licenses")).length, 0);
});

test("routine reconciliation scheduling preserves a failed resource-limit hold without executing provider work", async () => {
  let providerCalls = 0;
  const billing = new Billing(db, licenses, {
    snapshot: async (subscriptionId) => {
      providerCalls++;
      return snapshot({ subscriptionId, grants: [] });
    },
  });
  await billing.enqueueReconcile(["sub"]);
  await db("work").update({
    state: "failed",
    last_error: "resource_limit",
    attempts: 7,
    created_at: Date.now() - 4 * 86400000,
    available_at: Date.now() - 86400000,
  });
  const held = await db("work").first();
  for (let pass = 0; pass < 3; pass++) {
    await Promise.all([
      billing.enqueueReconcile(["sub", "sub"]),
      new Billing(db, licenses, billing.source).enqueueReconcile(["sub"]),
    ]);
  }
  assert.deepEqual(await db("work").first(), held,
    "routine scheduling must preserve the operator-held row, including payload and retry history");
  await billing.run(async () => null);
  assert.equal(providerCalls, 0);
  assert.deepEqual(await db("work").first(), held);
});

test("routine reconciliation scheduling still rearms ordinary failed jobs", async () => {
  let providerCalls = 0;
  const billing = new Billing(db, licenses, {
    snapshot: async (subscriptionId) => {
      providerCalls++;
      return snapshot({ subscriptionId, grants: [] });
    },
  });
  await billing.enqueueReconcile(["sub"]);
  await db("work").update({ state: "failed", last_error: "processing_failed", attempts: 3 });
  await billing.enqueueReconcile(["sub"]);
  const rearmed = await db("work").first();
  assert.equal(rearmed.state, "pending");
  assert.equal(rearmed.attempts, 0);
  assert.equal(rearmed.last_error, null);
  await billing.run(async () => null);
  assert.equal(providerCalls, 1);
  assert.equal((await db("work").first()).state, "sent");
});

test("an explicit authenticated retry releases a resource-limit hold and permits reconciliation", async () => {
  let providerCalls = 0;
  const billing = new Billing(db, licenses, {
    snapshot: async (subscriptionId) => {
      providerCalls++;
      return snapshot({ subscriptionId, grants: [] });
    },
  });
  await billing.enqueueReconcile(["sub"]);
  await db("work").update({
    state: "failed", last_error: "resource_limit", attempts: 7,
    created_at: Date.now() - 4 * 86400000,
  });
  const held = await db("work").first();
  const key = `DE-TK-${"R".repeat(43)}`;
  await db("tenant_api_keys").insert({
    id: randomUUID(), tenant_id: "primary", name: "Explicit job recovery",
    key_hash: hash(key), scopes: JSON.stringify(["billing:reconcile"]),
    display_prefix: key.slice(0, 14), created_at: Date.now(),
    expires_at: Date.now() + 60000, revoked_at: null, last_used_at: null,
  });
  const appConfig = {
    ...config, storage: `${root}/retry-storage`, staticDir: `${root}/retry-static`,
  };
  const app = await buildApp(appConfig, db, { send: async () => {} }, {
    store: new InMemoryArtifactStore(),
  });
  try {
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/tenants/primary/seller/jobs/work/${held.id}/retry`,
      headers: { authorization: `Bearer ${key}` },
      payload: {},
    });
    assert.equal(response.statusCode, 200, response.body);
    const released = await db("work").first();
    assert.equal(released.payload, held.payload);
    assert.equal(released.state, "pending");
    assert.equal(released.last_error, null);
    assert.equal(released.attempts, 0);
    assert.equal(Number(released.available_at), 0);
    assert.equal(Number(released.lease_until), 0);
    assert.equal(released.lease_owner, null);
    assert.ok(Number(released.created_at) > Number(held.created_at));
    assert.equal(providerCalls, 0);
    await billing.run(async () => null);
    assert.equal(providerCalls, 1);
    assert.equal((await db("work").first()).state, "sent");
  } finally {
    await app.close();
  }
});

test("scheduling during a running reconciliation preserves its live lease and does not create duplicate work", async () => {
  const entered = deferred<void>(),
    release = deferred<BillingSnapshot>();
  const billing = new Billing(db, licenses, {
    snapshot: async () => {
      entered.resolve();
      return release.promise;
    },
  });
  await billing.enqueueReconcile(["sub"]);
  const processing = billing.run(async () => null);
  await entered.promise;
  try {
    const running = await db("work").first();
    assert.equal(running.state, "running");
    await new Billing(db, licenses, billing.source).enqueueReconcile(["sub"]);
    const after = await db("work");
    assert.equal(after.length, 1);
    assert.equal(after[0].lease_owner, running.lease_owner);
    assert.equal(Number(after[0].lease_until), Number(running.lease_until));
    assert.equal(after[0].attempts, running.attempts);
  } finally {
    release.resolve(snapshot({ grants: [] }));
    await processing;
  }
  assert.equal((await db("work").first()).state, "sent");
});

test("Stripe snapshot waits never hold the only SQLite connection or block unrelated reads", async () => {
  const entered = deferred<void>(),
    release = deferred<BillingSnapshot>();
  const billing = new Billing(db, licenses, {
    snapshot: async () => {
      entered.resolve();
      return release.promise;
    },
  });
  const run = billing.reconcile("sub");
  await entered.promise;
  const query = db("licenses")
    .first()
    .then(() => undefined);
  try {
    assert.equal(
      await promptly(query),
      true,
      "an unrelated read must finish while Stripe is pending",
    );
  } finally {
    release.resolve(snapshot());
    await run;
    await query;
  }
});

test("a delayed old snapshot cannot overwrite a newer committed suspension across Billing instances", async () => {
  const entered = deferred<void>(),
    release = deferred<BillingSnapshot>();
  let calls = 0;
  const newer = snapshot({ suspended: true, billingStatus: "past_due" });
  const slow = new Billing(db, licenses, {
    snapshot: async () => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        return release.promise;
      }
      return newer;
    },
  });
  const fast = new Billing(db, licenses, { snapshot: async () => newer });
  const olderRun = slow.reconcile("sub");
  await entered.promise;
  const newerRun = fast.reconcile("sub");
  try {
    assert.equal(
      await promptly(newerRun),
      true,
      "new reconciliation must finish independently of the slow provider call",
    );
  } finally {
    release.resolve(snapshot());
    await Promise.all([olderRun, newerRun]);
  }
  const license = await db("licenses").first();
  assert.equal(license.suspended, 1);
  assert.equal(license.billing_status, "past_due");
  assert.equal(
    calls,
    2,
    "stale snapshot must be fetched again after a revision conflict",
  );
  assert.equal((await db("licenses")).length, 1);
  assert.equal((await db("grants")).length, 1);
});

test("continuous billing revision changes fail retryably after a bounded number of fresh snapshots", async () => {
  let calls = 0;
  const billing = new Billing(db, licenses, {
    snapshot: async () => {
      calls++;
      await db("locks")
        .where({ id: reconciliationLockId("primary", "sub") })
        .increment("version", 1);
      return snapshot();
    },
  });
  await assert.rejects(billing.reconcile("sub"), {
    status: 409,
    code: "billing_changed",
  });
  assert.equal(calls, 8);
  assert.equal((await db("licenses")).length, 0);
});

test("Stripe customer creation never blocks unrelated reads and persists a stable identity before external work", async (t) => {
  const entered = deferred<void>(),
    release = deferred<void>();
  const source = new StripeBilling(db, config, primaryTenant);
  t.mock.method(source.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  let idempotency = "";
  t.mock.method(
    source.stripe.customers,
    "create",
    async (_data: unknown, options: { idempotencyKey: string }) => {
      idempotency = options.idempotencyKey;
      entered.resolve();
      await release.promise;
      return { id: "cus_created" };
    },
  );
  t.mock.method(source.stripe.checkout.sessions, "create", async () => ({
    url: "https://checkout.stripe.test/session",
  }));
  const checkout = source.checkout(plan, "new@example.test");
  await entered.promise;
  const query = db("customers").where({ email: "new@example.test" }).first();
  let customer;
  try {
    assert.equal(
      await promptly(query),
      true,
      "customer HTTP must not hold the SQL connection",
    );
    customer = await query;
    assert.ok(customer);
    assert.equal(idempotency, `double-entitle-customer-primary-${customer.id}`);
    assert.equal(customer.stripe_id, null);
  } finally {
    release.resolve();
    await checkout;
    await query;
  }
  assert.equal(
    (await db("customers").where({ id: customer!.id }).first()).stripe_id,
    "cus_created",
  );
});

test("Stripe checkout session creation never blocks unrelated database reads", async (t) => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "known",
    email: "owner@example.test",
    stripe_id: "cus_known",
  });
  const entered = deferred<void>(),
    release = deferred<void>();
  const source = new StripeBilling(db, config, primaryTenant);
  t.mock.method(source.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  t.mock.method(source.stripe.checkout.sessions, "create", async () => {
    entered.resolve();
    await release.promise;
    return { url: "https://checkout.stripe.test/session" };
  });
  const checkout = source.checkout(plan, "owner@example.test", "known");
  await entered.promise;
  const query = db("licenses")
    .first()
    .then(() => undefined);
  try {
    assert.equal(
      await promptly(query),
      true,
      "checkout HTTP must not hold the SQL connection",
    );
  } finally {
    release.resolve();
    await checkout;
    await query;
  }
});

test("failed Stripe customer creation preserves the local identity and idempotency key for an authenticated retry", async (t) => {
  const source = new StripeBilling(db, config, primaryTenant);
  const keys: string[] = [];
  t.mock.method(source.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  t.mock.method(
    source.stripe.customers,
    "create",
    async (_data: unknown, options: { idempotencyKey: string }) => {
      keys.push(options.idempotencyKey);
      if (keys.length === 1) throw Error("provider interrupted");
      return { id: "cus_created" };
    },
  );
  t.mock.method(source.stripe.checkout.sessions, "create", async () => ({
    url: "https://checkout.stripe.test/session",
  }));
  await assert.rejects(
    source.checkout(plan, "new@example.test"),
    /provider interrupted/,
  );
  const customer = await db("customers")
    .where({ email: "new@example.test" })
    .first();
  assert.ok(customer, "local identity must survive provider failure");
  await source.checkout(plan, "new@example.test", customer.id);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal((await db("customers")).length, 1);
  assert.equal((await db("licenses")).length, 0);
});

test("valid authenticated email conflicts are 409 while anonymous existing-customer checkout still requires login", async (t) => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "owner",
    email: "owner@example.test",
    stripe_id: "cus_known",
  });
  const source = new StripeBilling(db, config, primaryTenant);
  t.mock.method(source.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  await assert.rejects(source.checkout(plan, "owner@example.test", "another"), {
    status: 409,
    code: "checkout_identity_conflict",
  });
  await assert.rejects(source.checkout(plan, "owner@example.test"), {
    status: 401,
    code: "login_required",
  });
});

test("concurrent provider mapping changes fail closed without overwriting another Stripe identity", async (t) => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "known",
    email: "owner@example.test",
    stripe_id: null,
  });
  const source = new StripeBilling(db, config, primaryTenant);
  t.mock.method(source.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  t.mock.method(source.stripe.customers, "create", async () => {
    await db("customers")
      .where({ id: "known" })
      .update({ stripe_id: "cus_other" });
    return { id: "cus_created" };
  });
  const sessions = t.mock.method(
    source.stripe.checkout.sessions,
    "create",
    async () => ({ url: "https://checkout.stripe.test/session" }),
  );
  await assert.rejects(source.checkout(plan, "owner@example.test", "known"), {
    status: 409,
    code: "billing_customer_conflict",
  });
  assert.equal(
    (await db("customers").where({ id: "known" }).first()).stripe_id,
    "cus_other",
  );
  assert.equal(sessions.mock.callCount(), 0);
});

test("same-customer authenticated retries share the persisted provider identity and idempotency key", async (t) => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "known",
    email: "owner@example.test",
    stripe_id: null,
  });
  const source = new StripeBilling(db, config, primaryTenant);
  const keys: string[] = [];
  t.mock.method(source.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  const first = deferred<void>(),
    release = deferred<void>();
  t.mock.method(
    source.stripe.customers,
    "create",
    async (_data: unknown, options: { idempotencyKey: string }) => {
      keys.push(options.idempotencyKey);
      first.resolve();
      await release.promise;
      return { id: "cus_created" };
    },
  );
  t.mock.method(source.stripe.checkout.sessions, "create", async () => ({
    url: "https://checkout.stripe.test/session",
  }));
  const one = source.checkout(plan, "owner@example.test", "known");
  await first.promise;
  const two = source.checkout(plan, "owner@example.test", "known");
  release.resolve();
  await Promise.all([one, two]);
  assert.ok(keys.length >= 1);
  assert.ok(
    keys.every((key) => key === "double-entitle-customer-primary-known"),
  );
  assert.equal((await db("customers")).length, 1);
  assert.equal(
    (await db("customers").where({ id: "known" }).first()).stripe_id,
    "cus_created",
  );
});

test("a failed checkout session preserves the committed Stripe customer mapping for retry", async (t) => {
  const source = new StripeBilling(db, config, primaryTenant);
  t.mock.method(source.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  const customers = t.mock.method(
    source.stripe.customers,
    "create",
    async () => ({ id: "cus_created" }),
  );
  let failSession = true;
  t.mock.method(source.stripe.checkout.sessions, "create", async () => {
    if (failSession) throw Error("session interrupted");
    return { url: "https://checkout.stripe.test/retry" };
  });
  await assert.rejects(
    source.checkout(plan, "new@example.test"),
    /session interrupted/,
  );
  const customer = await db("customers")
    .where({ email: "new@example.test" })
    .first();
  assert.equal(customer.stripe_id, "cus_created");
  failSession = false;
  assert.deepEqual(
    await source.checkout(plan, "new@example.test", customer.id),
    { url: "https://checkout.stripe.test/retry" },
  );
  assert.equal(customers.mock.callCount(), 1);
});

test("documented full-refund policy revokes the whole upgraded license and cannot be cleared by a later healthy snapshot", async () => {
  await db("plans").insert({
    tenant_id: "primary",
    id: "upgrade",
    product_id: "product",
    name: "Upgrade",
    site_allowance: 5,
    stripe_price_id: "price_upgrade",
  });
  const state = snapshot();
  const billing = new Billing(db, licenses, {
    snapshot: async () => structuredClone(state),
  });
  await billing.reconcile("sub");
  const baseEnd = state.grants[0]!.periodEnd;
  state.grants.push({
    ...state.grants[0]!,
    id: "upgrade_grant",
    invoiceId: "upgrade_invoice",
    priceId: "price_upgrade",
    paidAt: Date.now() + 1,
  });
  await billing.reconcile("sub");
  assert.equal((await db("licenses").first()).site_allowance, 5);
  state.fullyRefunded = true;
  await billing.reconcile("sub");
  let license = await db("licenses").first();
  assert.equal(Number(license.paid_through), baseEnd);
  assert.equal(license.refund_revoked, 1);
  assert.equal(licenses.entitled(license), false);
  state.fullyRefunded = false;
  await billing.reconcile("sub");
  license = await db("licenses").first();
  assert.equal(license.refund_revoked, 1);
  assert.equal(licenses.entitled(license), false);
});
