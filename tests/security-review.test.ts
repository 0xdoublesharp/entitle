import { isolatedDatabase } from "./helpers/database.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { FastifyRequest, FastifyReply } from "fastify";
import Stripe from "stripe";
import nodemailer from "nodemailer";
import { migrate } from "../src/db.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { StripeBilling } from "../src/stripe.ts";
import { PlatformAuth, PlatformOutbox } from "../src/platform-auth.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Licenses } from "../src/licensing.ts";
import { Releases } from "../src/releases.ts";
import { hash, seal, unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";
import { primaryTenant } from "./helpers/tenant.ts";
import { zipBytes } from "./helpers/zip.ts";

process.env.NODE_ENV = "test";
const base = "/api/v1/tenants/primary";
async function fixture(
  t: TestContext,
  overrides: Partial<Config> & { maxSellerSignupsPerHour?: number } = {},
) {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/security-review-",
  );
  const config = {
    ...loadConfig({ DEPLOYMENT_MODE: "hosted",
      APP_SECRET: "13".repeat(32),
      OPERATOR_TOKEN: "security-review-operator-token-123456",
      DATA_DIR: root,
      WEB_DIR: root + "/web",
      LOCAL_BILLING: "true",
    }),
    ...overrides,
  };
  const database = await isolatedDatabase(config.databaseUrl);
  const db = database.db;
  await migrate(db);
  const store = new InMemoryArtifactStore();
  const localStripe = () =>
    new Stripe("sk_test_fixture", {
      host: "127.0.0.1",
      port: 9,
      protocol: "http",
      maxNetworkRetries: 0,
    });
  const app = await buildApp(
    config,
    db,
    { send: async () => {} },
    {
      store,
      platformBilling: new PlatformBilling(db, config, localStripe()),
      stripeFactory: (tenant) => {
        const billing = new StripeBilling(db, config, tenant);
        billing.stripe = localStripe();
        return billing;
      },
    },
  );
  t.after(async () => {
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, config, db, store, app };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function purchase(f: Fixture) {
  await f.db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "plugin",
    name: "Plugin",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "One",
    site_allowance: 1,
    stripe_price_id: "price_one",
  });
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "customer",
    email: "buyer@example.test",
    stripe_id: "cus_one",
  });
  await f.db("licenses").insert({
    tenant_id: "primary",
    id: "license",
    customer_id: "customer",
    product_id: "product",
    plan_id: "plan",
    site_allowance: 1,
    paid_through: Date.now() + 86400000,
    billing_status: "active",
    subscription_id: "sub_one",
    key_hash: hash("DE-security-review"),
  });
  const licensing = new Licenses(f.db, f.config.secret, [], primaryTenant);
  const activation = await licensing.activate(
    "DE-security-review",
    "installation-001",
    "https://buyer.example.test",
    "plugin",
  );
  const file = f.root + "/plugin.zip";
  const bytes = zipBytes([
    {
      name: "plugin/plugin.php",
      data: "<?php\n/*\nPlugin Name: Plugin\nVersion: 1.0.0\n*/",
    },
  ]);
  await writeFile(file, bytes);
  const release = await new Releases(
    f.db,
    f.store,
    primaryTenant,
    f.config.storage,
  ).publish({
    product: "plugin",
    version: "1.0.0",
    file,
    changelog: "First",
    minWp: "6.0",
    minPhp: "8.0",
    minFree: "0.0.0",
    tested: "7.0",
  });
  return { token: activation.token, release, bytes };
}
function browser(auth: PlatformAuth, config: Config) {
  const cookies: Record<string, string> = {};
  let writes = 0;
  const req = () =>
    ({
      headers: { origin: config.origin },
      cookies: { ...cookies },
    }) as unknown as FastifyRequest;
  const reply = {
    setCookie: (name: string, value: string) => {
      cookies[name] = value;
      writes++;
    },
  } as unknown as FastifyReply;
  return {
    cookies,
    req,
    reply,
    writes: () => writes,
    send: (email: string) => auth.request(email, req(), reply),
  };
}

test("random Bearer values cannot bypass seller signup, checkout, or IPv6-subnet rate limits", async (t) => {
  const f = await fixture(t);
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++)
    statuses.push(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/platform/auth/request",
          headers: {
            origin: f.config.origin,
            authorization: `Bearer random-${i}`,
          },
          payload: { email: `new-${i}@example.test` },
        })
      ).statusCode,
    );
  assert.ok(statuses.includes(429));
  assert.equal((await f.db("platform_emails")).length, 5);
  assert.equal((await f.db("seller_users")).length, 5);
  const checkout: number[] = [];
  for (let i = 0; i < 20; i++)
    checkout.push(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/checkout`,
          headers: { authorization: `Bearer checkout-${i}` },
          payload: { planId: "missing", email: `buyer-${i}@example.test` },
        })
      ).statusCode,
    );
  assert.equal(checkout.filter((status) => status === 404).length, 10);
  assert.equal(checkout.filter((status) => status === 429).length, 10);
  const ipv6 = await fixture(t);
  const six: number[] = [];
  for (let i = 1; i <= 6; i++)
    six.push(
      (
        await ipv6.app.inject({
          method: "POST",
          url: "/api/v1/platform/auth/request",
          remoteAddress: `2001:db8:abcd:1234::${i}`,
          headers: {
            origin: ipv6.config.origin,
            authorization: `Bearer six-${i}`,
          },
          payload: { email: `ipv6-${i}@example.test` },
        })
      ).statusCode,
    );
  assert.equal(six[5], 429);
});

test("random invalid activation credentials share the IP budget instead of allocating unlimited buckets", async (t) => {
  const f = await fixture(t);
  const statuses: number[] = [];
  for (let i = 0; i < 65; i++)
    statuses.push(
      (
        await f.app.inject({
          url: `${base}/activation`,
          headers: { authorization: `Bearer invalid-${i}` },
        })
      ).statusCode,
    );
  assert.equal(statuses.filter((status) => status === 401).length, 60);
  assert.equal(statuses.filter((status) => status === 429).length, 5);
});

test("activation admission stops database lookups when its registered IP budget is exhausted", async (t) => {
  const f = await fixture(t);
  let lookups = 0;
  const count = (query: { sql: string }) => {
    if (/select\b.*\binstallations\b/i.test(query.sql)) lookups++;
  };
  f.db.on("query", count);
  t.after(() => { f.db.removeListener("query", count); });
  const request = (i: number) => f.app.inject({
    url: `${base}/activation`,
    headers: { authorization: `Bearer ${Buffer.from(hash(`invalid-${i}`), "hex").toString("base64url")}` },
  });
  for (let i = 0; i < 60; i++) assert.equal((await request(i)).statusCode, 401);
  assert.ok(lookups > 0);
  const exhausted = lookups;
  for (let i = 60; i < 65; i++) {
    const response = await request(i);
    assert.equal(response.statusCode, 429);
    assert.ok(Number(response.headers["retry-after"]) > 0);
  }
  assert.equal(lookups, exhausted);
  const later = Date.now() + 60001;
  t.mock.method(Date, "now", () => later);
  assert.equal((await request(65)).statusCode, 401);
  assert.ok(lookups > exhausted, "credential resolution resumes after the registered time window");
});

test("activation pre-admission shares IPv6 subnet budgets before credential lookup", async (t) => {
  const f = await fixture(t);
  let lookups = 0;
  const count = (query: { sql: string }) => {
    if (/select\b.*\binstallations\b/i.test(query.sql)) lookups++;
  };
  f.db.on("query", count);
  t.after(() => { f.db.removeListener("query", count); });
  const request = (remoteAddress: string) => f.app.inject({
    url: `${base}/activation`, remoteAddress,
    headers: { authorization: `Bearer ${"A".repeat(43)}` },
  });
  for (let i = 1; i <= 60; i++)
    assert.equal((await request(`2001:db8:abcd:1234::${i}`)).statusCode, 401);
  const exhausted = lookups;
  assert.ok(exhausted > 0);
  for (let i = 61; i <= 65; i++)
    assert.equal((await request(`2001:db8:abcd:1234::${i}`)).statusCode, 429);
  assert.equal(lookups, exhausted);
  assert.equal((await request("2001:db8:abcd:5678::1")).statusCode, 401);
  assert.ok(lookups > exhausted, "another subnet retains its own admission budget");
});

test("durable platform SMTP reservations defer exhausted mail without dropping payloads or consuming attempts", async (t) => {
  const f = await fixture(t);
  for (const id of ["one", "two"])
    await f.db("platform_emails").insert({
      id,
      kind: "seller_login",
      payload: seal(
        {
          to: `${id}@example.test`,
          subject: "Login",
          text: "Private",
          messageId: `<${id}@fixture>`,
        },
        f.config.secret,
      ),
      created_at: Date.now(),
    });
  const delivered: Message[] = [];
  const worker = () =>
    new PlatformOutbox(
      f.db,
      f.config.secret,
      {
        send: async (message) => {
          delivered.push(message);
        },
      },
      1,
    );
  await worker().run();
  assert.equal(delivered.length, 1);
  const pending = await f
    .db("platform_emails")
    .where({ state: "pending" })
    .first();
  assert.ok(pending);
  assert.equal(pending.attempts, 0);
  assert.equal(pending.last_error, "resource_budget");
  assert.ok(pending.payload);
  assert.ok(Number(pending.available_at) > Date.now());
  await f
    .db("platform_emails")
    .where({ id: pending.id })
    .update({ available_at: 0 });
  await worker().run();
  assert.equal(
    delivered.length,
    1,
    "A new worker must retain the durable daily budget",
  );
  assert.equal(
    (await f.db("platform_emails").where({ id: pending.id }).first()).attempts,
    0,
  );
});

test("new unverified seller creation has an hourly durable ceiling and existing sellers can still request mail", async (t) => {
  const f = await fixture(t, { maxSellerSignupsPerHour: 2 });
  const auth = new PlatformAuth(f.db, f.config);
  for (let i = 0; i < 3; i++)
    await browser(auth, f.config).send(`signup-${i}@example.test`);
  assert.equal((await f.db("seller_users")).length, 2);
  assert.equal((await f.db("platform_emails")).length, 2);
  await browser(auth, f.config).send("signup-0@example.test");
  assert.equal((await f.db("seller_users")).length, 2);
  assert.equal((await f.db("platform_emails")).length, 3);
});

test("an attacker browser cannot exhaust a victim browser's bound seller login allowance", async (t) => {
  const f = await fixture(t);
  const auth = new PlatformAuth(f.db, f.config);
  const attacker = browser(auth, f.config),
    victim = browser(auth, f.config);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  for (let i = 0; i < 10; i++) {
    await attacker.send("victim@example.test");
    now += 61000;
  }
  assert.equal((await f.db("platform_emails")).length, 10);
  const before = attacker.writes();
  await attacker.send("victim@example.test");
  assert.equal(attacker.writes(), before);
  await victim.send("victim@example.test");
  assert.equal((await f.db("platform_emails")).length, 11);
  const row = await f
    .db("platform_emails")
    .orderBy("created_at", "desc")
    .first();
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(
    unseal<Message>(row.payload, f.config.secret).text,
  )![1]!;
  await auth.consume(token, victim.req(), victim.reply);
  assert.ok(victim.cookies[auth.cookieName]);
});

test("seller login retries reuse a valid browser nonce and suppressed requests preserve its cookie", async (t) => {
  const f = await fixture(t);
  const auth = new PlatformAuth(f.db, f.config),
    jar = browser(auth, f.config);
  await jar.send("owner@example.test");
  const nonce = jar.cookies[auth.preauthCookieName];
  const writes = jar.writes();
  await jar.send("owner@example.test");
  assert.equal(jar.writes(), writes);
  assert.equal(jar.cookies[auth.preauthCookieName], nonce);
  await f.db("seller_login_tokens").decrement("created_at", 61000);
  await jar.send("owner@example.test");
  assert.equal(jar.cookies[auth.preauthCookieName], nonce);
  assert.equal((await f.db("platform_emails")).length, 2);
});

test("valid-signature Connect events from the other Stripe mode are acknowledged without durable work", async (t) => {
  const f = await fixture(t, { stripeLiveMode: true });
  const payload = JSON.stringify({
    id: "evt_other_mode",
    type: "customer.subscription.updated",
    account: "acct_primary",
    livemode: false,
    data: { object: { id: "sub_one" } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: f.config.stripeConnectWebhookSecret!,
  });
  const reply = await f.app.inject({
    method: "POST",
    url: "/api/v1/stripe/connect-webhook",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    payload,
  });
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(reply.json(), { ok: true, ignored: true });
  for (const table of [
    "billing_events",
    "platform_events",
    "work",
    "platform_work",
  ])
    assert.equal((await f.db(table)).length, 0);
});

test("unauthenticated uploads waiting on auth never reserve the shared transfer budget", async (t) => {
  const f = await fixture(t, {
    maxUploadBytes: 1024 * 1024,
    transferMemoryBytes: 6 * 1024 * 1024,
  });
  const bought = await purchase(f);
  let entered!: () => void, release!: () => void;
  const blocked = new Promise<void>((r) => {
      entered = r;
    }),
    gate = new Promise<void>((r) => {
      release = r;
    });
  const original = PlatformAuth.prototype.tenant;
  t.mock.method(
    PlatformAuth.prototype,
    "tenant",
    async function (
      this: PlatformAuth,
      ...args: Parameters<PlatformAuth["tenant"]>
    ) {
      if (args[0].routeOptions.url?.endsWith("/releases/:product/:version")) {
        entered();
        await gate;
      }
      return original.apply(this, args);
    },
  );
  const upload = f.app.inject({
    method: "POST",
    url: `${base}/seller/releases/plugin/2.0.0`,
    headers: { "content-type": "application/zip" },
    payload: Buffer.alloc(1024 * 1024),
  });
  const pending = upload.then((reply) => reply);
  await blocked;
  try {
    const download = await f.app.inject({
      url: `${base}/packages/${bought.release.id}`,
      headers: { authorization: `Bearer ${bought.token}` },
    });
    assert.equal(download.statusCode, 200, download.body);
    assert.deepEqual(download.rawPayload, bought.bytes);
  } finally {
    release();
    assert.equal((await pending).statusCode, 401);
  }
});

test("seller signup default ceiling expires hourly and invalid preauth values are replaced only on issuance", async (t) => {
  const f = await fixture(t);
  delete f.config.maxSellerSignupsPerHour;
  const auth = new PlatformAuth(f.db, f.config),
    jar = browser(auth, f.config);
  jar.cookies[auth.preauthCookieName] = "not-a-valid-nonce";
  await jar.send("first@example.test");
  assert.match(jar.cookies[auth.preauthCookieName]!, /^[A-Za-z0-9_-]{43}$/);
  await f.db("seller_users").update({ created_at: Date.now() - 3600001 });
  f.config.maxSellerSignupsPerHour = 1;
  await browser(auth, f.config).send("second@example.test");
  assert.equal((await f.db("seller_users")).length, 2);
  await f
    .db("seller_users")
    .where({ email: "second@example.test" })
    .update({ verified_at: Date.now() });
  await browser(auth, f.config).send("third@example.test");
  assert.equal((await f.db("seller_users")).length, 2);
});

test("seller address-wide safety ceiling spans browser jars and expires without consuming suppressed requests", async (t) => {
  const f = await fixture(t);
  const auth = new PlatformAuth(f.db, f.config);
  await browser(auth, f.config).send("bounded@example.test");
  const user = await f.db("seller_users").first();
  const now = Date.now();
  const rows = Array.from({ length: 999 }, (_, index) => ({
    id: hash(`address-safety-${index}`),
    user_id: user.id,
    expires_at: now + 900000,
    browser_hash: hash("other-browser"),
    created_at: now,
    used: 0,
  }));
  for (let i = 0; i < rows.length; i += 200)
    await f.db("seller_login_tokens").insert(rows.slice(i, i + 200));
  const fresh = browser(auth, f.config);
  await fresh.send("bounded@example.test");
  assert.equal(fresh.writes(), 0);
  assert.equal((await f.db("platform_emails")).length, 1);
  await f.db("seller_login_tokens").update({ created_at: now - 86400001 });
  await fresh.send("bounded@example.test");
  assert.equal(fresh.writes(), 1);
  assert.equal((await f.db("platform_emails")).length, 2);
});

test("platform SMTP failures consume the shared daily attempt budget and retry with payload intact on the next day", async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const payload = seal(
    {
      to: "retry@example.test",
      subject: "Login",
      text: "Credential",
      messageId: "<retry@fixture>",
    },
    f.config.secret,
  );
  await f
    .db("platform_emails")
    .insert({ id: "retry", kind: "seller_login", payload, created_at: clock });
  let sends = 0;
  const outbox = new PlatformOutbox(
    f.db,
    f.config.secret,
    {
      send: async () => {
        sends++;
        if (sends === 1) throw Error("SMTP delivery ambiguous");
      },
    },
    1,
  );
  await outbox.run();
  assert.equal(sends, 1);
  await f
    .db("platform_emails")
    .where({ id: "retry" })
    .update({ available_at: 0 });
  await outbox.run();
  let job = await f.db("platform_emails").where({ id: "retry" }).first();
  assert.equal(sends, 1);
  assert.equal(job.payload, payload);
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, "resource_budget");
  clock = Number(job.available_at) + 1;
  await outbox.run();
  job = await f.db("platform_emails").where({ id: "retry" }).first();
  assert.equal(sends, 2);
  assert.equal(job.state, "sent");
  assert.equal(job.payload, "");
});

test("untrusted forwarded addresses cannot split public request budgets, while configured proxy addresses are honored", async (t) => {
  const f = await fixture(t, { trustProxy: false });
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++)
    statuses.push(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/platform/auth/request",
          remoteAddress: "127.0.0.1",
          headers: {
            origin: f.config.origin,
            "x-forwarded-for": `198.51.100.${i + 1}`,
          },
          payload: { email: `untrusted-${i}@example.test` },
        })
      ).statusCode,
    );
  assert.equal(statuses[5], 429);
  const trusted = await fixture(t, { trustProxy: "127.0.0.1" });
  for (let i = 0; i < 6; i++)
    assert.equal(
      (
        await trusted.app.inject({
          method: "POST",
          url: "/api/v1/platform/auth/request",
          remoteAddress: "127.0.0.1",
          headers: {
            origin: trusted.config.origin,
            "x-forwarded-for": `198.51.100.${i + 1}`,
          },
          payload: { email: `trusted-${i}@example.test` },
        })
      ).statusCode,
      200,
    );
});

test("production SMTP requires STARTTLS when direct TLS is disabled", async (t) => {
  const transport = t.mock.method(nodemailer, "createTransport");
  await fixture(t, { production: true, smtpSecure: false });
  assert.equal(
    (transport.mock.calls.at(-1)!.arguments[0] as { requireTLS: boolean })
      .requireTLS,
    true,
  );
  await fixture(t, { production: true, smtpSecure: true });
  assert.equal(
    (transport.mock.calls.at(-1)!.arguments[0] as { requireTLS: boolean })
      .requireTLS,
    false,
  );
  await fixture(t, { production: false, smtpSecure: false });
  assert.equal(
    (transport.mock.calls.at(-1)!.arguments[0] as { requireTLS: boolean })
      .requireTLS,
    false,
  );
});

test("tenant bulk failed-job recovery is bounded, scoped, payload-preserving and starts a fresh retry window", async (t) => {
  const f = await fixture(t);
  const token = "DE-TK-security-queue-fixture";
  await f.db("tenant_api_keys").insert({
    id: "queue-key",
    tenant_id: "primary",
    name: "Queue recovery",
    key_hash: hash(token),
    created_at: Date.now(),
    revoked_at: null,
    scopes: JSON.stringify(["billing:reconcile"]),
    expires_at: Date.now() + 86400000,
    last_used_at: null,
    display_prefix: token.slice(0, 14),
  });
  const { createTenant } = await import("../src/db.ts");
  await createTenant(f.db, {
    id: "queue-other",
    slug: "queue-other",
    name: "Other",
  });
  const payload = seal({ subscriptionId: "sub_one" }, f.config.secret),
    old = Date.now() - 7 * 86400000;
  for (const [tenantId, count] of [
    ["primary", 3],
    ["queue-other", 2],
  ] as const)
    for (let i = 0; i < count; i++)
      await f.db("work").insert({
        tenant_id: tenantId,
        id: `failed-${i}`,
        kind: "reconcile",
        payload,
        state: "failed",
        attempts: 50,
        created_at: old + i,
        last_error: "processing_failed",
      });
  const request = (suffix: string, body: object = {}) =>
    f.app.inject({
      method: "POST",
      url: `${base}/seller/jobs/${suffix}`,
      headers: { authorization: `Bearer ${token}` },
      payload: body,
    });
  const bounded = await request("work/retry-failed", { limit: 2 });
  assert.equal(bounded.statusCode, 200, bounded.body);
  assert.deepEqual(bounded.json(), { queued: 2 });
  const own = await f.db("work").where({ tenant_id: "primary" }).orderBy("id");
  assert.deepEqual(
    own.map((job) => job.state),
    ["pending", "pending", "failed"],
  );
  for (const row of own.slice(0, 2)) {
    assert.equal(row.attempts, 0);
    assert.equal(row.payload, payload);
    assert.ok(Number(row.created_at) > old + 86400000);
    assert.equal(row.last_error, null);
  }
  assert.ok(
    (await f.db("work").where({ tenant_id: "queue-other" })).every(
      (job) =>
        job.state === "failed" && Number(job.created_at) < old + 86400000,
    ),
  );
  assert.deepEqual((await request("work/retry-failed")).json(), { queued: 1 });
  assert.deepEqual((await request("work/retry-failed")).json(), { queued: 0 });
  assert.equal((await request("platform_work/retry-failed")).statusCode, 400);
  assert.equal(
    (await request("work/retry-failed", { limit: 501 })).statusCode,
    400,
  );
  assert.equal(
    (await request("work/retry-failed", { limit: 0 })).statusCode,
    400,
  );
  await f
    .db("work")
    .where({ tenant_id: "primary", id: "failed-0" })
    .update({ state: "failed", created_at: old });
  assert.equal((await request("work/failed-0/retry")).statusCode, 200);
  assert.ok(
    Number(
      (
        await f
          .db("work")
          .where({ tenant_id: "primary", id: "failed-0" })
          .first()
      ).created_at,
    ) >
      old + 86400000,
  );
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "queue-customer",
    email: "queue@example.test",
    stripe_id: null,
  });
  await f.db("emails").insert({
    tenant_id: "primary",
    id: "mail-failed",
    customer_id: "queue-customer",
    kind: "login",
    payload: seal(
      {
        to: "queue@example.test",
        subject: "Login",
        text: "Private",
        messageId: "<queue@fixture>",
      },
      f.config.secret,
    ),
    created_at: old,
    state: "failed",
    attempts: 50,
  });
  assert.deepEqual(
    (await request("emails/retry-failed", { limit: 1 })).json(),
    { queued: 1 },
  );
  const mail = await f
    .db("emails")
    .where({ tenant_id: "primary", id: "mail-failed" })
    .first();
  assert.equal(mail.state, "pending");
  assert.ok(Number(mail.created_at) > old + 86400000);
  assert.ok(mail.payload);
  assert.equal(
    (
      await f
        .db("audit_events")
        .where({ tenant_id: "primary", action: "jobs.retry_requested" })
    ).length,
    4,
  );
});
