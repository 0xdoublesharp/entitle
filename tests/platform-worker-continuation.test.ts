import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import { createDb, createTenant, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { PlatformBilling } from "../src/platform-billing.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/platform-continuation-",
  );
  const db = createDb(`sqlite:${root}/db`);
  t.after(async () => {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(db);
  const config = {
    ...loadConfig({
      DEPLOYMENT_MODE: "hosted",
      APP_SECRET: "68".repeat(32),
      OPERATOR_TOKEN: "platform-continuation-operator".repeat(2),
      DATA_DIR: root,
      LOCAL_BILLING: "false",
    }),
    platformProStripePriceId: "price_pro",
  };
  const tenant = await createTenant(db, {
    id: "merchant",
    slug: "merchant",
    name: "Merchant",
    platform_customer_id: "cus",
    platform_subscription_id: "sub",
    max_products: 1,
    max_storage_bytes: 1,
  });
  const calls: {
    route: string;
    cursor?: string;
    options?: Stripe.RequestOptions;
  }[] = [];
  const now = Math.floor(Date.now() / 1000);
  let refunded = false;
  let onCall: ((route: string) => Promise<void>) | undefined;
  const list =
    (route: string, data: (parameters: any) => any[]) =>
    (parameters: any, options?: Stripe.RequestOptions) => {
      const page = async (cursor?: string) => {
        calls.push({
          route,
          ...(cursor ? { cursor } : {}),
          ...(options ? { options } : {}),
        });
        await onCall?.(route);
        const rows = data(parameters);
        const offset = cursor
          ? rows.findIndex((row) => row.id === cursor) + 1
          : 0;
        return {
          data: rows.slice(offset, offset + 1),
          has_more: offset + 1 < rows.length,
        };
      };
      const first = page(parameters.starting_after);
      return Object.assign(Promise.resolve(first), {
        async *[Symbol.asyncIterator]() {
          let current = await first;
          while (true) {
            yield* current.data;
            if (!current.has_more) return;
            current = await page(current.data.at(-1)?.id);
          }
        },
      });
    };
  const provider = {
    subscriptions: {
      list: list("subscriptions", () => [
        {
          id: "unrelated",
          customer: "cus",
          status: "active",
          livemode: false,
          created: now + 1,
          items: { data: [{ price: { id: "other" } }] },
        },
        {
          id: "sub",
          customer: "cus",
          status: "active",
          livemode: false,
          created: now,
          items: { data: [{ price: { id: "price_pro" } }] },
        },
      ]),
      retrieve: async (
        id: string,
        _parameters?: unknown,
        options?: Stripe.RequestOptions,
      ) => {
        calls.push({ route: "subscription", ...(options ? { options } : {}) });
        return {
          id,
          customer: "cus",
          status: "active",
          livemode: false,
          created: now,
          items: { data: [{ price: { id: "price_pro" } }] },
        };
      },
    },
    invoices: {
      list: list("invoices", () =>
        Array.from({ length: 12 }, (_, i) => ({
          id: `invoice_${i}`,
          customer: "cus",
          livemode: false,
          parent: { subscription_details: { subscription: "sub" } },
          status: "paid",
          amount_paid: 100,
          total: 100,
          amount_due: 100,
          amount_remaining: 0,
          currency: "usd",
          created: now - i,
          status_transitions: { paid_at: now - i },
        })),
      ),
      listLineItems: list("lines", (parameters) => [
        {
          id: `line_${parameters.__invoice}`,
          amount: 100,
          pricing: { price_details: { price: "price_pro" } },
          parent: { subscription_item_details: {} },
          period: { start: now - 100, end: now + 86400 },
        },
      ]),
    },
    invoicePayments: {
      list: list("payments", (parameters) => [
        {
          id: `payment_${parameters.invoice}`,
          payment: { payment_intent: `pi_${parameters.invoice}` },
        },
      ]),
    },
    charges: {
      list: list("charges", (parameters) => [
        {
          id: `charge_${parameters.payment_intent}`,
          paid: true,
          livemode: false,
          amount_refunded:
            refunded || parameters.payment_intent.endsWith("_11") ? 100 : 0,
          disputed: parameters.payment_intent.endsWith("_11"),
        },
      ]),
      retrieve: async (
        _id: string,
        _parameters?: unknown,
        options?: Stripe.RequestOptions,
      ) => {
        calls.push({
          route: "charge-customer",
          ...(options ? { options } : {}),
        });
        await onCall?.("charge-customer");
        return { id: "charge", customer: "cus", livemode: false };
      },
    },
    disputes: {
      list: list("disputes", () => [{ id: "late_dispute", status: "lost" }]),
      retrieve: async (
        _id: string,
        _parameters?: unknown,
        options?: Stripe.RequestOptions,
      ) => {
        calls.push({
          route: "dispute-customer",
          ...(options ? { options } : {}),
        });
        return { id: "dp", charge: "charge" };
      },
    },
  };
  const lines = provider.invoices.listLineItems;
  provider.invoices.listLineItems = ((
    invoice: string,
    parameters: any,
    options?: Stripe.RequestOptions,
  ) => lines({ ...parameters, __invoice: invoice }, options)) as any;
  const stripe = provider as unknown as Stripe;
  const billing = () => new PlatformBilling(db, config, stripe);
  return {
    db,
    config,
    tenant,
    calls,
    billing,
    provider,
    list,
    now,
    onCall: (callback: typeof onCall) => {
      onCall = callback;
    },
    setRefunded: (value: boolean) => {
      refunded = value;
    },
  };
}

async function finish(f: Awaited<ReturnType<typeof fixture>>, maxRequests = 2) {
  for (let turn = 0; turn < 150; turn++) {
    await f.db("platform_work").update({ available_at: 0 });
    const before = f.calls.length;
    await f.billing().run({ maxRequests });
    assert.ok(f.calls.length - before <= maxRequests);
    const job = await f.db("platform_work").first();
    if (job.state === "sent") return;
    assert.equal(job.state, "pending", job.last_error);
    assert.equal(job.attempts, 0);
  }
  assert.fail("platform continuation made no bounded progress");
}

test("failed platform apply refreshes completed evidence before retrying changed refunds", async (t) => {
  const f = await fixture(t);
  await f.billing().receive({
    id: "evt", type: "invoice.paid", livemode: false,
    data: { object: { customer: "cus" } },
  });
  const failApply = (query: { sql: string }) => {
    if (/insert into ["`]platform_grants["`]/.test(query.sql)) throw Error("apply unavailable");
  };
  f.db.on("query", failApply);
  try {
    for (let turn = 0; turn < 150; turn++) {
      await f.db("platform_work").update({ available_at: 0 });
      await f.billing().run({ maxRequests: 8 });
      if ((await f.db("platform_work").first()).last_error === "processing_failed") break;
    }
    assert.equal((await f.db("platform_work").first()).last_error, "processing_failed");
  } finally { f.db.removeListener("query", failApply); }
  assert.equal((await f.db("platform_grants")).length, 0);
  const before = f.calls.length;
  f.setRefunded(true);
  for (let turn = 0; turn < 150; turn++) {
    await f.db("platform_work").update({ available_at: 0 });
    await f.billing().run({ maxRequests: 8 });
    if ((await f.db("platform_work").first()).state === "sent") break;
  }
  assert.equal((await f.db("platform_work").first()).state, "sent");
  assert.ok(f.calls.length > before, "failed apply must not retain a completed provider snapshot");
  assert.ok((await f.db("platform_grants")).every(grant => grant.revoked === 1));
  assert.equal((await f.db("tenants").where({ id: f.tenant.id }).first()).max_products, 1);
});

test("platform worker resumes stable cursors across restarts and applies only complete payment history", async (t) => {
  const f = await fixture(t);
  await f.billing().receive({
    id: "evt",
    type: "invoice.paid",
    livemode: false,
    data: { object: { id: "invoice_0", customer: "cus" } },
  });
  let completed = false;
  for (let turn = 0; turn < 100; turn++) {
    const before = f.calls.length;
    await f.db("platform_work").update({ available_at: 0 });
    await f.billing().run({ budgetMs: 5000, maxRequests: 2 });
    assert.ok(
      f.calls.length - before <= 2,
      "a platform turn may issue at most two configured provider requests",
    );
    const job = await f.db("platform_work").first();
    if (job.state === "sent") {
      completed = true;
      break;
    }
    assert.equal(job.state, "pending");
    assert.equal(job.attempts, 0);
    assert.equal((await f.db("platform_events").first()).processed_at, null);
    assert.equal((await f.db("platform_grants")).length, 0);
    assert.equal(
      (await f.db("tenants").where({ id: f.tenant.id }).first()).max_products,
      1,
    );
  }
  assert.equal(
    completed,
    true,
    "the scan must eventually finish without replaying page one",
  );
  const grants = await f.db("platform_grants");
  assert.equal(grants.length, 12);
  assert.equal(
    grants.find((row) => row.invoice_id === "invoice_11")?.revoked,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.route === "invoices" && !call.cursor).length,
    1,
  );
  assert.ok(f.calls.every((call) => call.options?.maxNetworkRetries === 0));
  assert.equal((await f.db("worker_continuations")).length, 0);
  assert.equal((await f.db("worker_continuation_facts")).length, 0);
});

test("platform event attribution and subscription discovery resume with a one-request budget", async (t) => {
  const f = await fixture(t);
  await f
    .db("tenants")
    .where({ id: f.tenant.id })
    .update({ platform_subscription_id: null });
  await f.billing().receive({
    id: "evt",
    type: "charge.dispute.created",
    livemode: false,
    data: { object: { id: "dp" } },
  });
  await finish(f, 1);
  assert.equal(
    f.calls.filter((call) => call.route === "dispute-customer").length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.route === "charge-customer").length,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.route === "subscriptions" && !call.cursor)
      .length,
    1,
  );
  assert.equal(
    (await f.db("tenants").where({ id: f.tenant.id }).first())
      .platform_subscription_id,
    "sub",
  );
});

test("a newer canonical platform revision discards the partial scan before stale quota can apply", async (t) => {
  const f = await fixture(t);
  await f
    .billing()
    .receive({
      id: "evt",
      type: "invoice.paid",
      livemode: false,
      data: { object: { customer: "cus" } },
    });
  await f.billing().run({ maxRequests: 2 });
  assert.equal((await f.db("platform_events").first()).processed_at, null);
  f.setRefunded(true);
  await f.billing().reconcile(f.tenant.id);
  const before = f.calls.length;
  await f.db("platform_work").update({ available_at: 0 });
  await f.billing().run({ maxRequests: 2 });
  assert.equal(
    f.calls.length,
    before,
    "conflicting revision must reset before another provider read",
  );
  assert.equal((await f.db("platform_events").first()).processed_at, null);
  await finish(f);
  const tenant = await f.db("tenants").where({ id: f.tenant.id }).first();
  assert.equal(tenant.max_products, 1);
  assert.equal(tenant.pro_paid_through, 0);
  assert.ok(
    (await f.db("platform_grants")).every((grant) => grant.revoked === 1),
  );
});

test("lost platform job ownership cannot checkpoint evidence or apply quota and a replacement resumes safely", async (t) => {
  const f = await fixture(t);
  await f
    .billing()
    .receive({
      id: "evt",
      type: "invoice.paid",
      livemode: false,
      data: { object: { customer: "cus" } },
    });
  let stolen = false;
  f.onCall(async (route) => {
    if (stolen || route !== "charges") return;
    stolen = true;
    await f
      .db("platform_work")
      .update({ lease_owner: "replacement", lease_until: Date.now() + 60000 });
  });
  for (let turn = 0; turn < 50 && !stolen; turn++) {
    await f.db("platform_work").update({ available_at: 0 });
    await f.billing().run({ maxRequests: 2 });
  }
  assert.equal(stolen, true);
  assert.equal(
    (await f.db("platform_work").first()).lease_owner,
    "replacement",
  );
  assert.equal((await f.db("platform_events").first()).processed_at, null);
  assert.equal((await f.db("platform_grants")).length, 0);
  f.onCall(undefined);
  await f
    .db("platform_work")
    .update({
      lease_owner: null,
      lease_until: 0,
      state: "pending",
      attempts: 0,
    });
  await finish(f);
  assert.equal((await f.db("platform_grants")).length, 12);
});

test("platform continuation waits for the complete applied-credit ledger", async (t) => {
  const f = await fixture(t);
  const invoice = {
    id: "credit_invoice",
    customer: "cus",
    livemode: false,
    parent: { subscription_details: { subscription: "sub" } },
    status: "paid",
    amount_paid: 0,
    total: 100,
    amount_due: 0,
    amount_remaining: 0,
    currency: "usd",
    created: f.now,
    status_transitions: { paid_at: f.now },
  };
  f.provider.invoices.list = f.list("invoices", () => [invoice]);
  const ledger = f.list("balances", () => [
    {
      id: "wrong",
      customer: "other",
      invoice: invoice.id,
      currency: "usd",
      livemode: false,
      type: "applied_to_invoice",
      amount: 100,
    },
    {
      id: "applied",
      customer: "cus",
      invoice: invoice.id,
      currency: "usd",
      livemode: false,
      type: "applied_to_invoice",
      amount: 100,
    },
    {
      id: "unapplied",
      customer: "cus",
      invoice: invoice.id,
      currency: "usd",
      livemode: false,
      type: "unapplied_from_invoice",
      amount: -100,
    },
  ]);
  (f.provider as any).customers = {
    listBalanceTransactions: (
      _customer: string,
      parameters: any,
      options: Stripe.RequestOptions,
    ) => ledger(parameters, options),
  };
  await f
    .billing()
    .receive({
      id: "evt",
      type: "invoice.paid",
      livemode: false,
      data: { object: { customer: "cus" } },
    });
  await finish(f, 1);
  assert.equal((await f.db("platform_grants")).length, 0);
  assert.equal(
    (await f.db("tenants").where({ id: f.tenant.id }).first()).max_products,
    1,
  );
  assert.equal(
    f.calls.filter((call) => call.route === "balances" && !call.cursor).length,
    1,
  );
});

test("platform continuation retains linked proration credits returned by later invoice pages", async (t) => {
  const f = await fixture(t);
  f.config.platformPriceId = "price_starter";
  const invoice = (
    id: string,
    paid: number,
    total: number,
    created: number,
  ) => ({
    id,
    customer: "cus",
    livemode: false,
    parent: { subscription_details: { subscription: "sub" } },
    status: "paid",
    amount_paid: paid,
    total,
    amount_due: 0,
    amount_remaining: 0,
    currency: "usd",
    created,
    status_transitions: { paid_at: created },
  });
  f.provider.invoices.list = f.list("invoices", () => [
    invoice("downgrade", 0, -100, f.now - 1),
    invoice("upgrade", 0, 0, f.now - 50),
    invoice("starter", 100, 100, f.now - 100),
  ]);
  const debit = (id: string, price: string, start: number) => ({
    id,
    amount: 100,
    pricing: { price_details: { price } },
    parent: { subscription_item_details: {} },
    period: { start, end: f.now + 86400 },
  });
  const credit = (
    id: string,
    invoice: string,
    line: string,
    price: string,
    start: number,
  ) => ({
    ...debit(id, price, start),
    amount: -100,
    parent: {
      subscription_item_details: {
        proration: true,
        proration_details: {
          credited_items: { invoice, invoice_line_items: [line] },
        },
      },
    },
  });
  const lines = f.list("lines", (parameters) => {
    if (parameters.__invoice === "starter")
      return [debit("starter_line", "price_starter", f.now - 100)];
    if (parameters.__invoice === "upgrade")
      return [
        debit("pro_line", "price_pro", f.now - 50),
        credit(
          "starter_credit",
          "starter",
          "starter_line",
          "price_starter",
          f.now - 50,
        ),
      ];
    return [
      credit("pro_credit", "upgrade", "pro_line", "price_pro", f.now - 1),
    ];
  });
  f.provider.invoices.listLineItems = ((
    invoice: string,
    parameters: any,
    options: Stripe.RequestOptions,
  ) => lines({ ...parameters, __invoice: invoice }, options)) as any;
  await f
    .billing()
    .receive({
      id: "evt",
      type: "invoice.paid",
      livemode: false,
      data: { object: { customer: "cus" } },
    });
  await finish(f, 1);
  const grants = await f.db("platform_grants");
  assert.equal(grants.length, 2);
  assert.equal(
    Number(grants.find((grant) => grant.id === "pro_line")?.period_end),
    (f.now - 1) * 1000,
  );
  assert.ok(
    Number(
      (await f.db("tenants").where({ id: f.tenant.id }).first())
        .pro_paid_through,
    ) <= Date.now(),
  );
});

for (const cause of ["refund", "dispute"] as const) {
  test(`platform continuation includes a ${cause} on a later nested history page`, async (t) => {
    const f = await fixture(t);
    f.provider.invoices.list = f.list("invoices", () => [{
      id: "invoice", customer: "cus", livemode: false,
      parent: { subscription_details: { subscription: "sub" } },
      status: "paid", amount_paid: 100, total: 100, amount_due: 100,
      amount_remaining: 0, currency: "usd", created: f.now,
      status_transitions: { paid_at: f.now },
    }]);
    f.provider.invoicePayments.list = f.list("payments", () => [
      { id: "p1", payment: { payment_intent: "pi" } },
      { id: "p2", payment: { payment_intent: "pi" } },
    ]);
    f.provider.charges.list = f.list("charges", () => [
      { id: "early", paid: true, amount_refunded: 0, disputed: false, livemode: false },
      { id: "late", paid: true, amount_refunded: cause === "refund" ? 100 : 0,
        disputed: cause === "dispute", livemode: false },
    ]);
    f.provider.disputes.list = f.list("disputes", () => [
      { id: "resolved", status: "won" },
      { id: "late_loss", status: "lost" },
    ]);
    await f.billing().receive({
      id: "evt", type: "invoice.paid", livemode: false,
      data: { object: { customer: "cus" } },
    });
    await finish(f, 1);
    const grants = await f.db("platform_grants");
    assert.equal(grants.length, 1);
    assert.equal(grants[0].revoked, 1);
    assert.equal((await f.db("tenants").where({ id: f.tenant.id }).first()).max_products, 1);
    assert.equal(f.calls.filter(call => call.route === "charges" && !call.cursor).length, 1);
    if (cause === "dispute") assert.equal(f.calls.filter(call => call.route === "disputes").length, 2);
  });
}
