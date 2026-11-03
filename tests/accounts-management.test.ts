import test from "node:test";
import assert from "node:assert/strict";

test("account management exports seller and customer route contracts", async () => {
  const module = await import("../src/account-management.ts").catch(
    () => undefined,
  );
  assert.equal(typeof module?.AccountManagement, "function");
  assert.equal(typeof module?.CustomerAccounts, "function");
  assert.equal(typeof module?.registerAccountRoutes, "function");
  assert.equal(typeof module?.registerCustomerAccountRoutes, "function");
});

import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import { createDb, createTenant } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { PlatformAuth } from "../src/platform-auth.ts";
import { Auth } from "../src/auth.ts";
import { csrf, hash, seal, unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";
import { Window } from "happy-dom";
import {
  AccountManagement,
  CustomerAccounts,
  registerAccountRoutes,
  registerCustomerAccountRoutes,
} from "../src/account-management.ts";
import { up, down } from "../src/migrations/009_accounts.ts";
import { up as complimentarySchema } from "../src/migrations/014_complimentary_licenses.ts";

async function migrateAccountsDb(db: ReturnType<typeof createDb>) {
  await db.migrate.latest({
    migrationSource: {
      getMigrations: async () => [
        "001_initial",
        "002_plugin_identity",
        "003_tenants",
        "004_stripe_status",
        "005_security",
        "006_checkout",
        "007_frameworks",
      ],
      getMigrationName: (name: string) => name,
      getMigration: async (name: string) =>
        import(`../src/migrations/${name}.ts`),
    },
  });
  await complimentarySchema(db);
}

const closureApproval = {
  quiesced: true,
  stripeReconciled: true,
  retentionReviewed: true,
} as const;

async function fixture(t: test.TestContext, standalone = false) {
  await mkdir(
    "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r3-fixes/privacy",
    { recursive: true },
  );
  const path = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r3-fixes/privacy/accounts-case-",
  );
  const db = createDb(`sqlite:${path}/db`);
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await db.destroy();
    await rm(path, { recursive: true, force: true });
  });
  await migrateAccountsDb(db);
  await up(db);
  const config = loadConfig({
    APP_SECRET: "11".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
    DEPLOYMENT_MODE: standalone ? "standalone" : "hosted",
    STANDALONE_OWNER_EMAIL: "owner@example.test",
  });
  const auth = new PlatformAuth(db, config);
  const buyerAuth = new Auth(db, config, {
    id: "primary",
    slug: "primary",
    name: "Primary",
  });
  const accounts = new AccountManagement(db, auth);
  const customers = new CustomerAccounts(db, buyerAuth);
  await db("seller_users").insert([
    { id: "owner", email: "owner@example.test", verified_at: 1, created_at: 1 },
    { id: "other", email: "other@example.test", verified_at: 1, created_at: 1 },
  ]);
  for (const [token, user] of [
    ["current", "owner"],
    ["second", "owner"],
    ["foreign", "other"],
  ])
    await db("seller_sessions").insert({
      id: hash(token!),
      user_id: user!,
      expires_at: Date.now() + 86400000,
    });
  await db("customers").insert([
    {
      tenant_id: "primary",
      id: "buyer",
      email: "buyer@example.test",
      stripe_id: null,
    },
    {
      tenant_id: "primary",
      id: "stranger",
      email: "stranger@example.test",
      stripe_id: null,
    },
  ]);
  for (const [token, customer] of [
    ["buyer-session", "buyer"],
    ["stranger-session", "stranger"],
  ])
    await db("sessions").insert({
      tenant_id: "primary",
      id: hash(token!),
      customer_id: customer!,
      expires_at: Date.now() + 86400000,
    });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as Error & { status?: number; code?: string };
    reply.code(e.status ?? 400).send({ code: e.code, message: e.message });
  });
  await app.register(
    async (scope) => {
      await registerAccountRoutes(scope, { accounts });
    },
    { prefix: "/seller/account" },
  );
  await app.register(
    async (scope) => {
      await registerCustomerAccountRoutes(scope, { context: () => customers });
    },
    { prefix: "/buyer" },
  );
  const headers = (token = "current", seller = true) => ({
    origin: config.origin,
    cookie: `${seller ? auth.cookieName : buyerAuth.cookieName}=${token}`,
    "x-csrf-token": csrf(token, config.secret),
  });
  const post = (
    route: string,
    payload: Record<string, unknown> = {},
    token = "current",
    seller = true,
  ) =>
    app.inject({
      method: "POST",
      url: `${seller ? "/seller/account" : "/buyer/account"}${route}`,
      headers: headers(token, seller),
      payload,
    });
  const get = (route: string, token = "current", seller = true) =>
    app.inject({
      method: "GET",
      url: `${seller ? "/seller/account" : "/buyer/account"}${route}`,
      headers: headers(token, seller),
    });
  async function message(kind: string, to?: string) {
    const rows = await db("platform_emails")
      .where({ kind })
      .orderBy("created_at", "desc");
    const messages = rows.map((row) =>
      unseal<Message>(row.payload, config.secret),
    );
    return messages.find((m) => !to || m.to === to)!;
  }
  async function proof(purpose = "recovery_codes") {
    assert.equal(
      (await post("/verification/request", { purpose })).statusCode,
      200,
    );
    const token = /account-verification=([A-Za-z0-9_-]+)/.exec(
      (await message("account_verification")).text,
    )![1]!;
    const result = await post("/verification/consume", { purpose, token });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().verification as string;
  }
  return {
    db,
    app,
    auth,
    buyerAuth,
    accounts,
    customers,
    config,
    headers,
    post,
    get,
    message,
    proof,
  };
}

test("009 is repeatable and forward-only, and creates account tables", async (t) => {
  const { db } = await fixture(t);
  await up(db);
  for (const name of [
    "account_challenges",
    "account_recovery_codes",
    "account_attempts",
    "account_closures",
  ])
    assert.equal(await db.schema.hasTable(name), true);
  await assert.rejects(down(), /Restore a backup/);
});

test("sessions expose opaque handles and revoke only the authenticated seller's sessions", async (t) => {
  const f = await fixture(t);
  const list = (await f.get("/sessions")).json();
  assert.equal(list.sessions.length, 2);
  assert.equal(
    list.sessions.filter((s: { current: boolean }) => s.current).length,
    1,
  );
  assert.ok(!JSON.stringify(list).includes(hash("current")));
  const other = (await f.get("/sessions", "foreign")).json().sessions[0].id;
  assert.equal(
    (await f.post("/sessions/revoke", { id: other })).statusCode,
    404,
  );
  const second = list.sessions.find((s: { current: boolean }) => !s.current).id;
  assert.equal(
    (await f.post("/sessions/revoke", { id: second })).statusCode,
    200,
  );
  assert.equal((await f.get("/sessions", "second")).statusCode, 401);
  assert.equal((await f.get("/sessions", "foreign")).statusCode, 200);
  assert.equal(
    (
      await f.post("/sessions/revoke", {
        id: list.sessions.find((s: { current: boolean }) => s.current).id,
      })
    ).statusCode,
    200,
  );
  assert.equal((await f.get("/sessions")).statusCode, 401);
});

test("revoke others keeps this browser, revoke all invalidates it, and mutations enforce CSRF", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/seller/account/sessions/revoke-all",
        headers: { cookie: f.headers().cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal((await f.post("/sessions/revoke-others")).statusCode, 200);
  assert.equal((await f.get("/sessions")).statusCode, 200);
  assert.equal((await f.get("/sessions", "second")).statusCode, 401);
  assert.equal((await f.post("/sessions/revoke-all")).statusCode, 200);
  assert.equal((await f.get("/sessions")).statusCode, 401);
  assert.equal(
    (await f.db("audit_events").where({ action: "seller.sessions.revoked" }))
      .length,
    2,
  );
});

test("verification and grants bind browser, purpose, expiry and single use", async (t) => {
  const f = await fixture(t);
  const verification = await f.proof("billing");
  assert.equal(
    (await f.post("/recovery-codes", { verification })).statusCode,
    403,
  );
  const req = {
    headers: f.headers(),
    cookies: { [f.auth.cookieName]: "current" },
  } as never;
  await f.accounts.requireStepUp(req, "billing", verification);
  await assert.rejects(f.accounts.requireStepUp(req, "billing", verification), {
    code: "verification_required",
  });
  const next = await f.proof();
  assert.equal(
    (await f.post("/recovery-codes", { verification: next }, "second"))
      .statusCode,
    403,
  );
  await f.db("account_challenges").update({ expires_at: 0 });
  assert.equal(
    (await f.post("/recovery-codes", { verification: next })).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post("/verification/consume", {
        purpose: "billing",
        token: "missing",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.post("/verification/request", { purpose: "arbitrary" }))
      .statusCode,
    400,
  );
});

test("account emails include branded actions with the original browser-bound links", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post("/verification/request", { purpose: "api_keys" })).statusCode, 200);
  assert.equal((await f.post("/email-change/request", { email: "new@example.test" })).statusCode, 200);
  for (const [kind, to, expiry, label, fragment] of [
    ["account_verification", "owner@example.test", "10 minutes", "Confirm account action", "account-verification="],
    ["account_email_current", "owner@example.test", "15 minutes", "Approve email change", "account-email-change="],
    ["account_email_new", "new@example.test", "15 minutes", "Verify email address", "account-email-change="],
  ]) {
    const message = await f.message(kind!, to);
    assert.ok(message.html, `${kind} should include HTML`);
    const window = new Window();
    try {
      window.document.write(message.html);
      const document = window.document;
      assert.ok(document.querySelector(".email-content"));
      assert.ok(document.body.textContent.includes(expiry!));
      assert.match(document.body.textContent, /same signed-in browser/);
      assert.ok(document.body.textContent.includes(to!));
      const links = [...document.querySelectorAll("a")];
      assert.equal(links.length, 2);
      assert.equal(links[0]!.textContent, label);
      for (const link of links) {
        const href = link.getAttribute("href")!;
        assert.ok(href.includes(fragment!));
        assert.ok(message.text.includes(href));
      }
      assert.equal(links[0]!.getAttribute("href"), links[1]!.getAttribute("href"));
      assert.doesNotMatch(document.body.textContent, /api_keys/);
    } finally {
      await window.happyDOM.close();
    }
  }
});

test("a failed sensitive action rolls its grant back, a successful one consumes it", async (t) => {
  const f = await fixture(t);
  const verification = await f.proof("api_keys");
  const req = {
    headers: f.headers(),
    cookies: { [f.auth.cookieName]: "current" },
  } as never;
  await assert.rejects(
    f.accounts.withStepUp(req, "api_keys", verification, async () => {
      throw Error("action failed");
    }),
    /action failed/,
  );
  assert.equal(
    await f.accounts.withStepUp(
      req,
      "api_keys",
      verification,
      async () => "done",
    ),
    "done",
  );
  await assert.rejects(f.accounts.requireStepUp(req, "api_keys", verification));
});

test("proof email does not leak a usable secret through API, rows, or audit and expires", async (t) => {
  const f = await fixture(t);
  const result = await f.post("/verification/request", { purpose: "billing" });
  assert.deepEqual(result.json(), { ok: true });
  const token = /account-verification=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_verification")).text,
  )![1]!;
  assert.ok(!JSON.stringify(await f.db("account_challenges")).includes(token));
  assert.equal(
    (
      await f.post(
        "/verification/consume",
        { purpose: "billing", token },
        "second",
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.post("/verification/consume", { purpose: "api_keys", token }))
      .statusCode,
    403,
  );
  await f.db("account_challenges").update({ expires_at: 0 });
  assert.equal(
    (await f.post("/verification/consume", { purpose: "billing", token }))
      .statusCode,
    403,
  );
});

test("verified email change requires both proofs from this session and invalidates old credentials", async (t) => {
  const f = await fixture(t);
  const grant = await f.proof();
  const codes = (
    await f.post("/recovery-codes", { verification: grant })
  ).json().codes;
  await f.db("seller_login_tokens").insert({
    id: hash("old-login"),
    user_id: "owner",
    expires_at: Date.now() + 900000,
    browser_hash: hash("preauth"),
    created_at: Date.now(),
  });
  const result = await f.post("/email-change/request", {
    email: " NEW@Example.Test ",
  });
  assert.equal(result.statusCode, 200, result.body);
  const id = result.json().id;
  const currentToken = /token=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_email_current", "owner@example.test")).text,
  )![1]!;
  const newToken = /token=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_email_new", "new@example.test")).text,
  )![1]!;
  const payload = { id, currentToken, newToken };
  assert.equal(
    (await f.post("/email-change/confirm", payload, "second")).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post("/email-change/confirm", {
        ...payload,
        currentToken: newToken,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.post("/email-change/confirm", payload)).statusCode,
    200,
  );
  assert.equal(
    (await f.db("seller_users").where({ id: "owner" }).first()).email,
    "new@example.test",
  );
  assert.equal(
    (await f.db("seller_sessions").where({ user_id: "owner" })).length,
    0,
  );
  assert.equal(
    (await f.db("seller_login_tokens").where({ user_id: "owner" })).length,
    0,
  );
  assert.equal(
    (await f.db("account_recovery_codes").where({ user_id: "owner" })).length,
    0,
  );
  assert.equal(
    (await f.post("/email-change/confirm", payload)).statusCode,
    401,
  );
  const audit = JSON.stringify(await f.db("audit_events"));
  for (const token of [currentToken, newToken, ...codes])
    assert.ok(!audit.includes(token));
});

test("email conflict, expiry and standalone owner policy fail closed", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.post("/email-change/request", { email: "other@example.test" }))
      .statusCode,
    409,
  );
  assert.equal(
    (await f.post("/email-change/request", { email: "owner@example.test" }))
      .statusCode,
    409,
  );
  const result = await f.post("/email-change/request", {
    email: "new@example.test",
  });
  const currentToken = /token=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_email_current")).text,
  )![1]!;
  const newToken = /token=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_email_new")).text,
  )![1]!;
  await f.db("account_challenges").update({ expires_at: 0 });
  assert.equal(
    (
      await f.post("/email-change/confirm", {
        id: result.json().id,
        currentToken,
        newToken,
      })
    ).statusCode,
    403,
  );
  const standalone = await fixture(t, true);
  assert.equal(
    (
      await standalone.post("/email-change/request", {
        email: "new@example.test",
      })
    ).json().code,
    "operator_email_change_required",
  );
  assert.equal(
    (await standalone.db("seller_users").where({ id: "owner" }).first()).email,
    "owner@example.test",
  );
});

test("email ownership is rechecked at confirmation so concurrent claims cannot take over accounts", async (t) => {
  const f = await fixture(t);
  const result = await f.post("/email-change/request", {
    email: "new@example.test",
  });
  const currentToken = /token=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_email_current")).text,
  )![1]!;
  const newToken = /token=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_email_new")).text,
  )![1]!;
  await f
    .db("seller_users")
    .where({ id: "other" })
    .update({ email: "new@example.test" });
  assert.equal(
    (
      await f.post("/email-change/confirm", {
        id: result.json().id,
        currentToken,
        newToken,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.db("seller_users").where({ id: "owner" }).first()).email,
    "owner@example.test",
  );
});

test("offline recovery codes are hashed, rotated, single use and revoke existing sessions", async (t) => {
  const f = await fixture(t);
  const first = (
    await f.post("/recovery-codes", { verification: await f.proof() })
  ).json().codes as string[];
  assert.equal(first.length, 10);
  assert.equal(new Set(first).size, 10);
  assert.ok(
    !JSON.stringify(await f.db("account_recovery_codes")).includes(first[0]!),
  );
  const rotated = (
    await f.post("/recovery-codes", { verification: await f.proof() })
  ).json().codes as string[];
  const start = await f.post("/recovery/start");
  const recoveryCookie = start.cookies[0]!;
  const consume = (code: string) =>
    f.app.inject({
      method: "POST",
      url: "/seller/account/recovery/consume",
      headers: {
        origin: f.config.origin,
        cookie: `${recoveryCookie.name}=${recoveryCookie.value}`,
      },
      payload: { email: "owner@example.test", code },
    });
  assert.equal((await consume(first[0]!)).statusCode, 401);
  const success = await consume(rotated[0]!);
  assert.equal(success.statusCode, 200, success.body);
  assert.ok(success.cookies.some((c) => c.name === f.auth.cookieName));
  assert.equal((await consume(rotated[0]!)).statusCode, 401);
  assert.equal((await f.get("/sessions")).statusCode, 401);
  assert.equal((await f.get("/sessions", "second")).statusCode, 401);
  assert.equal((await f.get("/sessions", "foreign")).statusCode, 200);
  assert.equal(
    (await f.db("audit_events").where({ action: "seller.recovery.used" }))
      .length,
    1,
  );
});

test("recovery requires browser start, same origin and persists failed-attempt throttling", async (t) => {
  const f = await fixture(t);
  const body = { email: "owner@example.test", code: "bad" };
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/seller/account/recovery/start",
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal((await f.post("/recovery/consume", body)).statusCode, 401);
  const started = await f.post("/recovery/start");
  const browser = started.cookies[0]!;
  const headers = {
    origin: f.config.origin,
    cookie: `${browser.name}=${browser.value}`,
  };
  for (let i = 0; i < 5; i++)
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/seller/account/recovery/consume",
          headers,
          payload: body,
        })
      ).statusCode,
      401,
    );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/seller/account/recovery/consume",
        headers,
        payload: body,
      })
    ).statusCode,
    429,
  );
  assert.equal(
    (await f.db("audit_events").where({ action: "seller.recovery.failed" }))
      .length,
    5,
  );
});

test("failed recovery audit actor uses a keyed digest instead of an address dictionary hash", async (t) => {
  const f = await fixture(t);
  const started = await f.post("/recovery/start");
  const browser = started.cookies[0]!;
  await f.app.inject({
    method: "POST",
    url: "/seller/account/recovery/consume",
    headers: {
      origin: f.config.origin,
      cookie: `${browser.name}=${browser.value}`,
    },
    payload: { email: "owner@example.test", code: "bad" },
  });
  const row = await f
    .db("audit_events")
    .where({ action: "seller.recovery.failed" })
    .first();
  assert.equal(
    row.actor_id,
    createHmac("sha256", Buffer.from(f.config.secret, "hex"))
      .update("privacy-reference:recovery-address:owner@example.test")
      .digest("hex"),
  );
  assert.notEqual(row.actor_id, hash("recovery-address:owner@example.test"));
  assert.ok(!JSON.stringify(row).includes("owner@example.test"));
});

test("revocation between initial authentication and mutation denies the in-flight action", async (t) => {
  const f = await fixture(t);
  const original = f.auth.seller.bind(f.auth);
  f.auth.seller = async (...args) => {
    const session = await original(...args);
    await f.db("seller_sessions").where({ id: session.sessionHash }).delete();
    return session;
  };
  assert.equal(
    (await f.post("/verification/request", { purpose: "billing" })).statusCode,
    401,
  );
  assert.equal((await f.db("platform_emails")).length, 0);
});

async function license(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  await f.db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    site_allowance: 1,
    stripe_price_id: "price",
  });
  await f.db("licenses").insert({
    tenant_id: "primary",
    id: "license",
    customer_id: "buyer",
    product_id: "product",
    plan_id: "plan",
    site_allowance: 1,
    paid_through: Date.now() + 86400000,
    billing_status: "active",
    subscription_id: "sub_one",
    key_hash: hash("license-secret"),
    ...overrides,
  });
}

test("customer export uses an explicit field allowlist and excludes other buyers and tenants", async (t) => {
  const f = await fixture(t);
  await license(f);
  await f.db("grants").insert({
    tenant_id: "primary",
    id: "grant",
    license_id: "license",
    invoice_id: "invoice",
    plan_id: "plan",
    period_start: 1,
    period_end: 2,
    paid_at: 1,
  });
  await f.db("invoice_metrics").insert({
    tenant_id: "primary",
    invoice_id: "invoice",
    currency: "usd",
    paid_minor: 1000,
    refunded_minor: 0,
  });
  await f.db("installations").insert({
    tenant_id: "primary",
    id: "install",
    license_id: "license",
    installation_id: "site",
    site_url: "https://buyer.test",
    active: 1,
    exempt: 0,
    token_hash: hash("activation-secret"),
    token_cipher: "secret-cipher",
  });
  await createTenant(f.db, { id: "foreign", slug: "foreign", name: "Foreign" });
  await f.db("customers").insert({
    tenant_id: "foreign",
    id: "foreign-buyer",
    email: "foreign@example.test",
    stripe_id: "cus_foreign",
  });
  const result = await f.get("/export", "buyer-session", false);
  assert.equal(result.statusCode, 200, result.body);
  const data = result.json();
  assert.equal(data.customer.id, "buyer");
  assert.equal(data.licenses.length, 1);
  assert.equal(data.grants.length, 1);
  assert.equal(data.installations.length, 1);
  assert.equal(data.invoices.length, 1);
  for (const denied of [
    "key_hash",
    "token_hash",
    "token_cipher",
    "license-secret",
    "activation-secret",
    "stranger@example",
    "foreign@example",
    "buyer-session",
    "secret-cipher",
  ])
    assert.ok(!result.body.includes(denied), denied);
  assert.equal(
    (await f.app.inject({ url: "/buyer/account/export" })).statusCode,
    401,
  );
  assert.equal(
    (await f.get("/export?customerId=stranger", "buyer-session", false))
      .statusCode,
    400,
  );
  assert.equal(
    (await f.get("/export", "stranger-session", false)).json().licenses.length,
    0,
  );
});

test("complimentary customer export preserves entitlement and closure scrubs private seller notes without a subscription", async (t) => {
  const f = await fixture(t);
  f.config.stripeSecret = "";
  f.config.stripeWebhookSecret = "";
  const expires = Date.now() + 86400000;
  await license(f, {
    plan_id: null,
    subscription_id: null,
    provenance: "complimentary",
    paid_through: 0,
    expires_at: expires,
    billing_status: "complimentary",
    revoked: 1,
    issued_by: "owner",
    issued_at: 1,
    complimentary_request_id: randomUUID(),
    complimentary_request_hash: hash("issuance"),
    internal_note: "Invited by private-person@example.test",
  });
  const exported = await f.get("/export", "buyer-session", false);
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().licenses[0].provenance, "complimentary");
  assert.equal(Number(exported.json().licenses[0].expires_at), expires);
  assert.ok(!exported.body.includes("internal_note"));
  assert.ok(!exported.body.includes("private-person@example.test"));
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const inspection = await f.customers.inspectClosure("buyer", request.id);
  assert.deepEqual(JSON.parse(inspection.request.blockers), []);
  const reconciliation = {
    ...closureApproval,
    reference: "reviewed complimentary closure",
    stripeCustomerId: null,
    eventIds: [],
    workIds: [],
    auditIds: [],
    outgoingEventIds: [],
  };
  assert.equal(
    (
      await f.customers.reconcileClosure(
        "buyer",
        request.id,
        "operator",
        reconciliation,
      )
    ).reconciled,
    true,
  );
  const result = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.equal(result.status, "completed");
  const retained = await f.db("licenses").first();
  assert.equal(retained.provenance, "complimentary");
  assert.equal(retained.internal_note, null);
  assert.equal(retained.subscription_id, null);
  const receipt = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(receipt.details);
  delete details.stripeCustomerAttribution;
  await f
    .db("account_privacy_receipts")
    .where({ id: receipt.id })
    .update({ details: JSON.stringify(details) });
  assert.equal(
    (
      await f.customers.upgradeClosureAttribution(
        "buyer",
        request.id,
        "operator",
        reconciliation,
        false,
      )
    ).upgraded,
    true,
  );
});

test("closure requests are durable, idempotent, customer scoped, audited and CSRF protected", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.get("/closure", "buyer-session", false)).json().request,
    null,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/buyer/account/closure",
        headers: { cookie: f.headers("buyer-session", false).cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(
        "/closure",
        { customerId: "stranger" },
        "buyer-session",
        false,
      )
    ).statusCode,
    400,
  );
  const first = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const again = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  assert.equal(first.id, again.id);
  assert.equal(first.status, "awaiting_operator");
  assert.ok(first.retentionPlan);
  assert.equal(
    (await f.get("/closure", "stranger-session", false)).json().request,
    null,
  );
  assert.equal(
    (await f.db("audit_events").where({ action: "customer.closure.requested" }))
      .length,
    1,
  );
  await assert.rejects(
    f.customers.approveClosure(
      "stranger",
      first.id,
      "operator",
      closureApproval,
    ),
    { code: "closure_not_found" },
  );
});

test("paid and installed rights survive a closure request and block operator completion", async (t) => {
  const f = await fixture(t);
  await license(f, { paid_through: 1, billing_status: "canceled" });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const result = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.equal(result.status, "blocked");
  assert.ok(result.blockers.includes("paid_or_installed_rights"));
  assert.equal((await f.db("licenses").first()).revoked, 0);
  assert.equal(
    (await f.db("customers").where({ id: "buyer" }).first()).email,
    "buyer@example.test",
  );
  assert.equal(
    (await f.get("/export", "buyer-session", false)).statusCode,
    200,
  );
});

test("closure blocks subscriptions, Stripe binding, pending keys, in-flight work and retained provider PII", async (t) => {
  const f = await fixture(t);
  await license(f, { revoked: 1 });
  await f
    .db("customers")
    .where({ id: "buyer" })
    .update({ stripe_id: "cus_one" });
  await f.db("emails").insert({
    tenant_id: "primary",
    id: "key-mail",
    customer_id: "buyer",
    license_id: "license",
    kind: "key",
    payload: "sealed-key-and-email",
    created_at: 1,
    state: "running",
    lease_until: Date.now() + 300000,
  });
  await f.db("work").insert({
    tenant_id: "primary",
    id: "job",
    kind: "reconcile",
    payload: "{}",
    created_at: 1,
  });
  await f.db("billing_events").insert({
    tenant_id: "primary",
    id: "event",
    type: "invoice.paid",
    payload: seal(
      { customer: "cus_one", email: "buyer@example.test" },
      f.config.secret,
    ),
    received_at: 1,
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const result = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  for (const reason of [
    "stripe_customer_reconciliation",
    "stripe_subscription",
    "pending_customer_email",
    "pending_billing_work",
    "retained_provider_payloads",
  ])
    assert.ok(result.blockers.includes(reason), reason);
  assert.equal((await f.db("emails").first()).payload, "sealed-key-and-email");
});

test("safe closure anonymizes only this customer, scrubs retained email/site secrets, retains reconciliation and revocation tombstones", async (t) => {
  const f = await fixture(t);
  await license(f, { revoked: 1, billing_status: "canceled" });
  await f.db("installations").insert({
    tenant_id: "primary",
    id: "install",
    license_id: "license",
    installation_id: "site",
    site_url: "https://private.test",
    active: 0,
    exempt: 0,
    token_hash: hash("revoked-token"),
    token_cipher: "pii-secret",
  });
  await f.db("emails").insert({
    tenant_id: "primary",
    id: "old-mail",
    customer_id: "buyer",
    license_id: "license",
    kind: "key",
    payload: "retained-secret",
    created_at: 1,
    state: "failed",
  });
  await f.db("login_tokens").insert({
    tenant_id: "primary",
    id: hash("login"),
    customer_id: "buyer",
    expires_at: Date.now() + 900000,
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const closed = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.equal(closed.status, "completed");
  assert.deepEqual(
    await f.customers.approveClosure(
      "buyer",
      request.id,
      "operator",
      closureApproval,
    ),
    closed,
  );
  const customer = await f.db("customers").where({ id: "buyer" }).first();
  assert.match(customer.email, /^closed-[a-f0-9]+@invalid\.invalid$/);
  assert.equal(customer.stripe_id, null);
  assert.equal(
    (await f.db("customers").where({ id: "stranger" }).first()).email,
    "stranger@example.test",
  );
  assert.equal(
    (await f.db("emails").where({ customer_id: "buyer" })).length,
    0,
  );
  assert.equal(
    (await f.db("login_tokens").where({ customer_id: "buyer" })).length,
    0,
  );
  assert.equal(
    (await f.get("/export", "buyer-session", false)).statusCode,
    401,
  );
  const installation = await f.db("installations").first();
  assert.equal(installation.site_url, "");
  assert.equal(installation.token_cipher, "");
  assert.equal(installation.token_hash, hash("revoked-token"));
  assert.equal(
    (await f.db("licenses").first()).key_hash,
    hash("license-secret"),
  );
  assert.ok(
    !JSON.stringify(await f.db("audit_events")).includes("buyer@example.test"),
  );
});

test("production recovery cookies expire, reject tampering and enforce standalone owner binding", async (t) => {
  const f = await fixture(t, true);
  f.auth.config.production = true;
  const secureAccounts = new AccountManagement(f.db, f.auth);
  assert.equal(secureAccounts.recoveryCookieName, "__Host-de-account-recovery");
  const replies: {
    name: string;
    value: string;
    options: Record<string, unknown>;
  }[] = [];
  const reply = {
    setCookie: (
      name: string,
      value: string,
      options: Record<string, unknown>,
    ) => replies.push({ name, value, options }),
  } as never;
  const req = { headers: { origin: f.config.origin }, cookies: {} } as never;
  secureAccounts.startRecovery(req, reply);
  assert.equal(replies[0]!.options.secure, true);
  for (const value of [
    "tampered",
    seal({ nonce: "expired", expiresAt: 0 }, f.config.secret),
    seal({ nonce: 1, expiresAt: Date.now() + 10000 }, f.config.secret),
  ]) {
    const request = {
      headers: { origin: f.config.origin },
      cookies: { [secureAccounts.recoveryCookieName]: value },
    } as never;
    await assert.rejects(
      secureAccounts.recover(request, reply, "owner@example.test", "bad"),
      { code: "invalid_recovery" },
    );
  }
  const request = {
    headers: { origin: f.config.origin },
    cookies: { [secureAccounts.recoveryCookieName]: replies[0]!.value },
  } as never;
  await assert.rejects(
    secureAccounts.recover(request, reply, "missing@example.test", "bad"),
    { code: "invalid_recovery" },
  );
  await f.db("account_recovery_codes").insert({
    id: hash("recovery:other:code"),
    user_id: "other",
    created_at: 1,
  });
  await assert.rejects(
    secureAccounts.recover(request, reply, "other@example.test", "code"),
    { code: "invalid_recovery" },
  );
  assert.equal(
    (await f.db("account_recovery_codes").where({ user_id: "other" })).length,
    1,
  );
  await f.db("account_recovery_codes").insert({
    id: hash("recovery:owner:owner-code"),
    user_id: "owner",
    created_at: 1,
  });
  assert.deepEqual(
    await secureAccounts.recover(
      request,
      reply,
      "owner@example.test",
      "owner-code",
    ),
    { ok: true },
  );
  const active = replies.at(-1)!.value;
  assert.equal(
    (
      await secureAccounts.sessions({
        headers: {},
        cookies: { [f.auth.cookieName]: active },
      } as never)
    ).sessions.length,
    1,
  );
});

test("closure status can resume after blockers clear and operator identity is required", async (t) => {
  const f = await fixture(t);
  await f.db("work").insert({
    tenant_id: "primary",
    id: "work",
    kind: "reconcile",
    payload: "{}",
    created_at: 1,
    state: "running",
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  await assert.rejects(
    f.customers.approveClosure("buyer", request.id, "", closureApproval),
    { code: "operator_required" },
  );
  assert.equal(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).status,
    "blocked",
  );
  assert.equal(
    (await f.get("/closure", "buyer-session", false)).json().request.status,
    "blocked",
  );
  assert.equal(
    (await f.post("/closure", {}, "buyer-session", false)).json().request.id,
    request.id,
  );
  await f.db("work").update({ state: "sent", payload: "{}" });
  assert.equal(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).status,
    "completed",
  );
});

test("customer mutation rechecks revoked sessions after initial authentication", async (t) => {
  const f = await fixture(t);
  const original = f.buyerAuth.customer.bind(f.buyerAuth);
  f.buyerAuth.customer = async (...args) => {
    const session = await original(...args);
    await f.db("sessions").where({ id: session.sessionHash }).delete();
    return session;
  };
  assert.equal(
    (await f.post("/closure", {}, "buyer-session", false)).statusCode,
    401,
  );
  assert.equal((await f.db("account_closures")).length, 0);
});

for (const engine of ["POSTGRES", "MYSQL"]) {
  const url = process.env[`TEST_${engine}_DATABASE_URL`];
  test(
    `account schema ${engine} uses an isolated child database and resumes interrupted table creation`,
    { skip: !url },
    async () => {
      const { randomUUID } = await import("node:crypto");
      const connection = new URL(url!);
      const databaseName = `entitle_accounts_${randomUUID().replaceAll("-", "")}`;
      const adminConnection = new URL(connection);
      adminConnection.pathname = engine === "POSTGRES" ? "/postgres" : "/mysql";
      const admin = createDb(adminConnection.href);
      let db: ReturnType<typeof createDb> | undefined;
      let created = false;
      try {
        await admin.raw(
          engine === "MYSQL"
            ? "CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
            : "CREATE DATABASE ??",
          [databaseName],
        );
        created = true;
        connection.pathname = `/${databaseName}`;
        db = createDb(connection.href);
        await migrateAccountsDb(db);
        if (engine === "MYSQL") {
          const interrupt = (_result: unknown, query: { sql: string }) => {
            if (query.sql.startsWith("create table `account_challenges`"))
              throw Error("account migration interrupted");
          };
          db.on("query-response", interrupt);
          await assert.rejects(up(db), /account migration interrupted/);
          db.removeListener("query-response", interrupt);
        }
        await up(db);
        await up(db);
        await createTenant(db, { id: "one", slug: "one", name: "One" });
        await createTenant(db, { id: "two", slug: "two", name: "Two" });
        await db("customers").insert([
          { tenant_id: "one", id: "buyer-one", email: "one@example.test" },
          { tenant_id: "two", id: "buyer-two", email: "two@example.test" },
        ]);
        await db("seller_users").insert({
          id: "owner",
          email: "owner@example.test",
          verified_at: 1,
          created_at: 1,
        });
        await db("seller_sessions").insert({
          id: "session",
          user_id: "owner",
          expires_at: Date.now() + 86400000,
        });
        await assert.rejects(
          db("account_closures").insert({
            tenant_id: "one",
            customer_id: "buyer-two",
            id: "cross",
            status: "awaiting_operator",
            blockers: "[]",
            requested_at: 1,
          }),
        );
        if (engine === "MYSQL") {
          await db.raw(
            "alter table account_closures drop foreign key account_closures_customer_foreign",
          );
          const interrupt = (_result: unknown, query: { sql: string }) => {
            if (
              query.sql.includes(
                "add constraint `account_closures_customer_foreign`",
              )
            )
              throw Error("foreign key interrupted");
          };
          db.on("query-response", interrupt);
          await assert.rejects(up(db), /foreign key interrupted/);
          db.removeListener("query-response", interrupt);
          await up(db);
          await assert.rejects(
            db("account_closures").insert({
              tenant_id: "one",
              customer_id: "buyer-two",
              id: "cross",
              status: "awaiting_operator",
              blockers: "[]",
              requested_at: 1,
            }),
          );
        }
        await db("account_closures").insert({
          tenant_id: "one",
          customer_id: "buyer-one",
          id: "request-one",
          status: "awaiting_operator",
          blockers: "[]",
          requested_at: 1,
        });
        await db("account_closures").insert({
          tenant_id: "two",
          customer_id: "buyer-two",
          id: "request-two",
          status: "awaiting_operator",
          blockers: "[]",
          requested_at: 1,
        });
        await assert.rejects(
          db("account_closures").insert({
            tenant_id: "one",
            customer_id: "buyer-one",
            id: "duplicate",
            status: "awaiting_operator",
            blockers: "[]",
            requested_at: 1,
          }),
        );
        await db("account_challenges").insert([
          {
            id: "Case",
            user_id: "owner",
            session_hash: "session",
            purpose: "email:billing",
            token_hash: "hash",
            created_at: 1,
            expires_at: 2,
          },
          {
            id: "case",
            user_id: "owner",
            session_hash: "session",
            purpose: "email:billing",
            token_hash: "hash",
            created_at: 1,
            expires_at: 2,
          },
        ]);
        assert.equal((await db("account_challenges")).length, 2);
        await migrateAccountsDb(db);
        const config = loadConfig({
          APP_SECRET: "11".repeat(32),
          OPERATOR_TOKEN: "x".repeat(32),
          DEPLOYMENT_MODE: "hosted",
        });
        await db("seller_users").insert({
          id: "engine-owner",
          email: "engine@example.test",
          verified_at: 1,
          created_at: 1,
        });
        await db("seller_sessions").insert({
          id: hash("engine-session"),
          user_id: "engine-owner",
          expires_at: Date.now() + 86400000,
        });
        const auth = new PlatformAuth(db, config);
        const accounts = new AccountManagement(db, auth);
        const request = {
          headers: {
            origin: config.origin,
            "x-csrf-token": csrf("engine-session", config.secret),
          },
          cookies: { [auth.cookieName]: "engine-session" },
        } as never;
        await accounts.requestVerification(request, "recovery_codes");
        const mail = unseal<Message>(
          (
            await db("platform_emails")
              .where({ kind: "account_verification" })
              .first()
          ).payload,
          config.secret,
        );
        const token = /account-verification=([A-Za-z0-9_-]+)/.exec(
          mail.text,
        )![1]!;
        const { verification } = await accounts.consumeVerification(
          request,
          "recovery_codes",
          token,
        );
        const { codes } = await accounts.recoveryCodes(request, verification);
        assert.equal(codes.length, 10);
        assert.equal((await db("account_recovery_codes")).length, 10);
        await assert.rejects(accounts.recoveryCodes(request, verification), {
          code: "verification_required",
        });
        await db("customers").insert({
          tenant_id: "primary",
          id: "engine-buyer",
          email: "engine-buyer@example.test",
          stripe_id: null,
        });
        await db("sessions").insert({
          tenant_id: "primary",
          id: hash("engine-buyer-session"),
          customer_id: "engine-buyer",
          expires_at: Date.now() + 86400000,
        });
        const buyerAuth = new Auth(db, config, {
          id: "primary",
          slug: "primary",
          name: "Primary",
        });
        const customers = new CustomerAccounts(db, buyerAuth);
        const buyerRequest = {
          headers: {
            origin: config.origin,
            "x-csrf-token": csrf("engine-buyer-session", config.secret),
          },
          cookies: { [buyerAuth.cookieName]: "engine-buyer-session" },
        } as never;
        assert.equal(
          (await customers.export(buyerRequest)).customer.id,
          "engine-buyer",
        );
        const closure = await customers.requestClosure(buyerRequest);
        assert.equal(
          (
            await customers.approveClosure(
              "engine-buyer",
              closure.request.id,
              "operator",
              closureApproval,
            )
          ).status,
          "completed",
        );
        await assert.rejects(customers.export(buyerRequest), {
          code: "login_required",
        });
      } finally {
        await db?.destroy();
        if (created) await admin.raw("DROP DATABASE ??", [databaseName]);
        await admin.destroy();
      }
    },
  );
}

test("operator completion requires maintenance, external reconciliation and retention attestation", async (t) => {
  const f = await fixture(t);
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  for (const approval of [
    undefined,
    { ...closureApproval, quiesced: false },
    { ...closureApproval, stripeReconciled: false },
    { ...closureApproval, retentionReviewed: false },
  ]) {
    await assert.rejects(
      f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        approval as never,
      ),
      { code: "closure_approval_required" },
    );
  }
  assert.equal(
    (await f.db("customers").where({ id: "buyer" }).first()).email,
    "buyer@example.test",
  );
});

test("failed but leased customer mail still blocks privacy completion", async (t) => {
  const f = await fixture(t);
  await f.db("emails").insert({
    tenant_id: "primary",
    id: "leased",
    customer_id: "buyer",
    kind: "login",
    payload: "encrypted-private",
    created_at: 1,
    state: "failed",
    lease_until: Date.now() + 300000,
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  assert.ok(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).blockers.includes("pending_customer_email"),
  );
});

test("outgoing event payloads and pending deliveries block closure until operator review and drain", async (t) => {
  const f = await fixture(t);
  await (await import("../src/migrations/010_operations.ts")).up(f.db);
  await f.db("outbound_endpoints").insert({
    tenant_id: "primary",
    id: "endpoint",
    url: "https://publisher.example/hook",
    events: "[]",
    secret_cipher: "provider-secret",
    created_at: 1,
  });
  await f.db("outbound_events").insert({
    tenant_id: "primary",
    id: "event",
    payload: "retained-personal-data",
    created_at: 1,
  });
  await f.db("outbound_deliveries").insert({
    tenant_id: "primary",
    id: "delivery",
    event_id: "event",
    endpoint_id: "endpoint",
    generation: 1,
    available_at: 0,
    deadline_at: Date.now() + 3600000,
    created_at: 1,
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  let result = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.ok(result.blockers.includes("pending_outgoing_delivery"));
  assert.ok(result.blockers.includes("retained_outgoing_payloads"));
  await f.db("outbound_deliveries").update({ state: "sent" });
  await f.db("outbound_events").update({ payload: "{}" });
  result = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.equal(result.status, "completed");
});

test("account verification throttles across browsers durably, then permits retry after its window", async (t) => {
  const f = await fixture(t);
  const req = (token: string) =>
    ({
      headers: f.headers(token),
      cookies: { [f.auth.cookieName]: token },
    }) as never;
  for (let i = 0; i < 5; i++)
    await f.accounts.requestVerification(
      req(i % 2 ? "current" : "second"),
      "billing",
    );
  await assert.rejects(
    f.accounts.requestVerification(req("second"), "api_keys"),
    { code: "account_rate_limited" },
  );
  assert.equal((await f.db("platform_emails")).length, 5);
  await f.db("account_attempts").update({ expires_at: 0 });
  assert.deepEqual(
    await f.accounts.requestVerification(req("second"), "api_keys"),
    { ok: true },
  );
});

test("email verification cannot be consumed twice, and a new request replaces the older token", async (t) => {
  const f = await fixture(t);
  await f.post("/verification/request", { purpose: "billing" });
  const first = /account-verification=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_verification")).text,
  )![1]!;
  await f.post("/verification/request", { purpose: "billing" });
  const second = /account-verification=([A-Za-z0-9_-]+)/.exec(
    (await f.message("account_verification")).text,
  )![1]!;
  assert.notEqual(first, second);
  assert.equal(
    (
      await f.post("/verification/consume", {
        purpose: "billing",
        token: first,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post("/verification/consume", {
        purpose: "billing",
        token: second,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.post("/verification/consume", {
        purpose: "billing",
        token: second,
      })
    ).statusCode,
    403,
  );
});

test("operator reconciliation clears a resolved Stripe binding, redacts scoped PII, and preserves financial records before completion", async (t) => {
  const f = await fixture(t);
  await license(f, { revoked: 1, billing_status: "canceled" });
  await f
    .db("customers")
    .where({ id: "buyer" })
    .update({ stripe_id: "cus_buyer" });
  await f.db("grants").insert({
    tenant_id: "primary",
    id: "grant",
    license_id: "license",
    invoice_id: "in_buyer",
    plan_id: "plan",
    period_start: 1,
    period_end: 2,
    paid_at: 1,
  });
  await f.db("invoice_metrics").insert({
    tenant_id: "primary",
    invoice_id: "in_buyer",
    currency: "usd",
    paid_minor: 5000,
    refunded_minor: 1000,
  });
  await f.db("billing_events").insert({
    tenant_id: "primary",
    id: "evt_buyer",
    type: "invoice.paid",
    payload: seal(
      {
        id: "evt_buyer",
        type: "invoice.paid",
        data: {
          object: {
            id: "in_buyer",
            customer: "cus_buyer",
            customer_email: "buyer@example.test",
            customer_name: "Private Buyer",
            test_flag: true,
            nullable: null,
            count: 1,
            currency: "usd",
            amount_paid: 5000,
            amount_refunded: 1000,
          },
        },
      },
      f.config.secret,
    ),
    received_at: 1,
    processed_at: 2,
  });
  await f.db("work").insert({
    tenant_id: "primary",
    id: "evt_buyer",
    kind: "stripe_event",
    payload: seal({ eventId: "evt_buyer" }, f.config.secret),
    created_at: 1,
    state: "sent",
  });
  await f.db("audit_events").insert({
    id: "audit-buyer",
    tenant_id: "primary",
    actor_type: "customer",
    actor_id: "buyer",
    action: "billing.reconciled",
    details: JSON.stringify({ email: "buyer@example.test" }),
    created_at: 1,
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  assert.equal(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).status,
    "blocked",
  );
  const approval = {
    ...closureApproval,
    reference: "reconciliation-123",
    stripeCustomerId: "cus_buyer",
    eventIds: ["evt_buyer"],
    workIds: ["evt_buyer"],
    auditIds: ["audit-buyer"],
    outgoingEventIds: [],
  };
  const receipt = await f.customers.reconcileClosure(
    "buyer",
    request.id,
    "operator",
    approval,
  );
  assert.equal(receipt.reconciled, true);
  assert.deepEqual(
    await f.customers.reconcileClosure(
      "buyer",
      request.id,
      "operator",
      approval,
    ),
    receipt,
  );
  assert.equal(
    (await f.db("customers").where({ id: "buyer" }).first()).stripe_id,
    null,
  );
  assert.equal(
    (await f.db("billing_events").where({ id: "evt_buyer" }).first()).payload,
    "{}",
  );
  assert.equal(
    (await f.db("work").where({ id: "evt_buyer" }).first()).payload,
    "{}",
  );
  assert.equal(
    (await f.db("work").where({ id: "evt_buyer" }).first()).state,
    "canceled",
  );
  assert.equal(
    (await f.db("audit_events").where({ id: "audit-buyer" }).first()).details,
    "{}",
  );
  const ledger = await f.db("account_privacy_receipts").first();
  assert.ok(!ledger.details.includes("buyer@example.test"));
  assert.ok(!ledger.details.includes("Private Buyer"));
  const retained = JSON.parse(ledger.details);
  assert.equal(retained.events[0].financial.amount_paid, 5000);
  assert.equal(retained.events[0].financial.amount_refunded, 1000);
  assert.equal(retained.invoices[0].paid_minor, 5000);
  assert.equal((await f.db("invoice_metrics").first()).refunded_minor, 1000);
  assert.equal((await f.db("grants").first()).invoice_id, "in_buyer");
  assert.equal(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).status,
    "completed",
  );
});

test("operator redaction rejects other-customer records, stale Stripe binding, unprocessed events and in-flight work atomically", async (t) => {
  const f = await fixture(t);
  await f
    .db("customers")
    .where({ id: "buyer" })
    .update({ stripe_id: "cus_buyer" });
  await f.db("billing_events").insert([
    {
      tenant_id: "primary",
      id: "foreign",
      type: "invoice.paid",
      payload: seal(
        {
          data: {
            object: {
              customer: "cus_stranger",
              customer_email: "stranger@example.test",
            },
          },
        },
        f.config.secret,
      ),
      received_at: 1,
      processed_at: 2,
    },
    {
      tenant_id: "primary",
      id: "unprocessed",
      type: "invoice.paid",
      payload: seal(
        { data: { object: { customer: "cus_buyer" } } },
        f.config.secret,
      ),
      received_at: 1,
    },
  ]);
  await f.db("work").insert({
    tenant_id: "primary",
    id: "active",
    kind: "reconcile",
    payload: seal({ subscriptionId: "sub_buyer" }, f.config.secret),
    created_at: 1,
    state: "running",
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const approval = {
    ...closureApproval,
    reference: "reconcile",
    stripeCustomerId: "cus_buyer",
    eventIds: [] as string[],
    workIds: [] as string[],
    auditIds: [],
    outgoingEventIds: [],
  };
  await assert.rejects(
    f.customers.reconcileClosure("buyer", request.id, "operator", {
      ...approval,
      stripeCustomerId: "wrong",
    }),
    { code: "closure_reconciliation_conflict" },
  );
  await assert.rejects(
    f.customers.reconcileClosure("buyer", request.id, "operator", {
      ...approval,
      eventIds: ["foreign"],
    }),
    { code: "closure_record_denied" },
  );
  await assert.rejects(
    f.customers.reconcileClosure("buyer", request.id, "operator", {
      ...approval,
      eventIds: ["unprocessed"],
    }),
    { code: "closure_record_unresolved" },
  );
  await assert.rejects(
    f.customers.reconcileClosure("buyer", request.id, "operator", {
      ...approval,
      workIds: ["active"],
    }),
    { code: "closure_record_unresolved" },
  );
  assert.equal(
    (await f.db("customers").where({ id: "buyer" }).first()).stripe_id,
    "cus_buyer",
  );
  assert.equal((await f.db("account_privacy_receipts")).length, 0);
});

test("sensitive existing actions can consume purpose-bound proof from x-account-verification", async (t) => {
  const f = await fixture(t);
  const verification = await f.proof("tenant_transfer");
  const request = {
    headers: { ...f.headers(), "x-account-verification": verification },
    cookies: { [f.auth.cookieName]: "current" },
  } as never;
  await f.accounts.requireStepUp(request, "tenant_transfer");
  await assert.rejects(f.accounts.requireStepUp(request, "tenant_transfer"), {
    code: "verification_required",
  });
  for (const value of [undefined, [verification], "", "x".repeat(201)]) {
    await assert.rejects(
      f.accounts.requireStepUp(
        {
          headers: { ...f.headers(), "x-account-verification": value },
          cookies: { [f.auth.cookieName]: "current" },
        } as never,
        "api_keys",
      ),
      { code: "verification_required" },
    );
  }
});

test("account tables reject orphan seller identities, mismatched sessions and cross-tenant customer relationships", async (t) => {
  const f = await fixture(t);
  await createTenant(f.db, {
    id: "second-tenant",
    slug: "second-tenant",
    name: "Second",
  });
  await f.db("customers").insert({
    tenant_id: "second-tenant",
    id: "second-buyer",
    email: "second@example.test",
  });
  await assert.rejects(
    f.db("account_closures").insert({
      tenant_id: "primary",
      customer_id: "second-buyer",
      id: "bad",
      status: "awaiting_operator",
      blockers: "[]",
      requested_at: 1,
    }),
  );
  await assert.rejects(
    f.db("account_privacy_receipts").insert({
      id: "bad",
      tenant_id: "primary",
      customer_id: "second-buyer",
      request_id: "bad",
      details: "{}",
      created_at: 1,
    }),
  );
  await assert.rejects(
    f
      .db("account_recovery_codes")
      .insert({ id: "bad", user_id: "missing", created_at: 1 }),
  );
  await assert.rejects(
    f.db("account_challenges").insert({
      id: "bad",
      user_id: "other",
      session_hash: hash("current"),
      purpose: "email:billing",
      token_hash: "hash",
      created_at: 1,
      expires_at: 2,
    }),
  );
});

test("operator scoped redaction handles outgoing records and paid-rights checks before committing", async (t) => {
  const f = await fixture(t);
  await license(f);
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const approval = {
    ...closureApproval,
    reference: "outgoing-reconciled",
    stripeCustomerId: null,
    eventIds: [],
    workIds: [],
    auditIds: ["audit-detail"],
    outgoingEventIds: ["outgoing"],
  };
  await assert.rejects(
    f.customers.reconcileClosure("buyer", request.id, "operator", approval),
    { code: "closure_record_unresolved" },
  );
  await f
    .db("licenses")
    .update({ refund_revoked: 1, billing_status: "canceled" });
  await (await import("../src/migrations/010_operations.ts")).up(f.db);
  await f.db("audit_events").insert({
    id: "audit-detail",
    tenant_id: "primary",
    actor_type: "seller",
    actor_id: "owner",
    action: "support",
    details: JSON.stringify({
      customerId: "buyer",
      flag: true,
      empty: null,
      count: 1,
    }),
    created_at: 1,
  });
  await f.db("outbound_endpoints").insert({
    tenant_id: "primary",
    id: "endpoint",
    url: "https://publisher.example/hook",
    events: "[]",
    secret_cipher: "secret",
    created_at: 1,
  });
  await f.db("outbound_events").insert({
    tenant_id: "primary",
    id: "outgoing",
    payload: JSON.stringify({
      type: "license.revoked",
      flag: false,
      resourceId: "license",
    }),
    created_at: 1,
  });
  await f.db("outbound_deliveries").insert({
    tenant_id: "primary",
    id: "delivery",
    endpoint_id: "endpoint",
    event_id: "outgoing",
    generation: 1,
    available_at: 0,
    deadline_at: 1,
    created_at: 1,
  });
  await assert.rejects(
    f.customers.reconcileClosure("buyer", request.id, "operator", approval),
    { code: "closure_record_unresolved" },
  );
  assert.notEqual(
    (await f.db("audit_events").where({ id: "audit-detail" }).first()).details,
    "{}",
  );
  await f.db("outbound_deliveries").update({ state: "sent" });
  assert.equal(
    (
      await f.customers.reconcileClosure(
        "buyer",
        request.id,
        "operator",
        approval,
      )
    ).reconciled,
    true,
  );
  assert.equal((await f.db("outbound_events").first()).payload, "{}");
  assert.equal(
    (await f.db("audit_events").where({ id: "audit-detail" }).first()).details,
    "{}",
  );
  assert.equal(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).status,
    "completed",
  );
});

test("standalone email policy still authenticates and enforces CSRF before responding", async (t) => {
  const f = await fixture(t, true);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/seller/account/email-change/request",
        payload: { email: "new@example.test" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/seller/account/email-change/confirm",
        payload: { id: "change", currentToken: "old", newToken: "new" },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: "/seller/account/email-change/request",
        headers: { cookie: f.headers().cookie },
        payload: { email: "new@example.test" },
      })
    ).statusCode,
    403,
  );
});

test("privacy completion records only actual active-token invalidations in the same transaction", async (t) => {
  const f = await fixture(t);
  await (await import("../src/migrations/012_business_events.ts")).up(f.db);
  await license(f, { revoked: 1, billing_status: "canceled" });
  for (const [id, active] of [
    ["active-install", 1],
    ["inactive-install", 0],
  ] as const)
    await f.db("installations").insert({
      tenant_id: "primary",
      id,
      license_id: "license",
      installation_id: id,
      site_url: "private.example.test",
      label: "Private customer label",
      active,
      exempt: 0,
      token_hash: hash(id),
      token_cipher: "secret",
    });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  assert.ok(
    (await f.get("/export", "buyer-session", false)).body.includes(
      "Private customer label",
    ),
  );
  await f.db.raw(
    "CREATE TRIGGER fail_closure_event BEFORE INSERT ON business_events BEGIN SELECT RAISE(ABORT, 'event insert failed'); END",
  );
  await assert.rejects(
    f.customers.approveClosure(
      "buyer",
      request.id,
      "operator",
      closureApproval,
    ),
    /event insert failed/,
  );
  assert.equal(
    (await f.db("installations").where({ id: "active-install" }).first())
      .active,
    1,
  );
  assert.equal(
    (await f.db("customers").where({ id: "buyer" }).first()).email,
    "buyer@example.test",
  );
  await f.db.raw("DROP TRIGGER fail_closure_event");
  assert.equal(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).status,
    "completed",
  );
  const events = await f.db("business_events");
  assert.equal(events.length, 1);
  assert.equal(events[0].resource_id, "active-install");
  assert.equal(events[0].type, "activation.changed");
  assert.equal(
    (await f.db("installations").where({ id: "active-install" }).first()).label,
    null,
  );
  await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.equal((await f.db("business_events")).length, 1);
});

test("customer closure preserves unrelated customer and seller history without being blocked by it", async (t) => {
  const f = await fixture(t);
  await (await import("../src/migrations/010_operations.ts")).up(f.db);
  await f.db("billing_events").insert({
    tenant_id: "primary",
    id: "evt_stranger",
    type: "invoice.paid",
    payload: seal(
      {
        id: "evt_stranger",
        data: {
          object: {
            id: "in_stranger",
            customer: "stranger",
            customer_email: "stranger@example.test",
            currency: "usd",
            amount_paid: 500,
          },
        },
      },
      f.config.secret,
    ),
    received_at: 1,
    processed_at: 2,
  });
  await f.db("work").insert({
    tenant_id: "primary",
    id: "work-stranger",
    kind: "stripe_event",
    payload: seal({ eventId: "evt_stranger" }, f.config.secret),
    created_at: 1,
    state: "pending",
  });
  await f.db("audit_events").insert({
    id: "seller-product-setup",
    tenant_id: "primary",
    actor_type: "seller",
    actor_id: "owner",
    action: "product.configured",
    details: JSON.stringify({ productId: "public-product" }),
    created_at: 1,
  });
  const payload = JSON.stringify({
    id: "opaque_event",
    type: "license.created",
    tenantId: "primary",
    resourceId: "opaque-license",
    occurredAt: 1,
  });
  await f.db("outbound_events").insert({
    tenant_id: "primary",
    id: "opaque_event",
    payload,
    created_at: 1,
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const result = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.notEqual(
    (await f.db("billing_events").where({ id: "evt_stranger" }).first())
      .payload,
    "{}",
  );
  assert.notEqual(
    (await f.db("audit_events").where({ id: "seller-product-setup" }).first())
      .details,
    "{}",
  );
  assert.equal(
    (await f.db("work").where({ id: "work-stranger" }).first()).state,
    "pending",
  );
  assert.equal((await f.db("outbound_events").first()).payload, payload);
});

test("Stripe nullable financial fields do not prevent retaining a minimal closure reconciliation receipt", async (t) => {
  const f = await fixture(t);
  await license(f, { revoked: 1, billing_status: "canceled" });
  await f.db("billing_events").insert({
    tenant_id: "primary",
    id: "evt_nullable",
    type: "invoice.paid",
    payload: seal(
      {
        data: {
          object: {
            customer: "buyer",
            currency: "usd",
            amount_paid: 5000,
            ending_balance: null,
            application_fee_amount: null,
            tax: null,
          },
        },
      },
      f.config.secret,
    ),
    received_at: 1,
    processed_at: 2,
  });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  await f.customers.reconcileClosure("buyer", request.id, "operator", {
    ...closureApproval,
    reference: "nullable-fields",
    stripeCustomerId: null,
    eventIds: ["evt_nullable"],
    workIds: [],
    auditIds: [],
    outgoingEventIds: [],
  });
  const receipt = JSON.parse(
    (await f.db("account_privacy_receipts").first()).details,
  );
  assert.deepEqual(receipt.events[0].financial, {
    currency: "usd",
    amount_paid: 5000,
  });
});

test("a closure receipt retains private attribution after the raw Stripe customer binding is removed", async (t) => {
  const f = await fixture(t);
  await license(f, { revoked: 1, billing_status: "canceled" });
  await f
    .db("customers")
    .where({ id: "buyer" })
    .update({ stripe_id: "cus_only_reference" });
  for (const id of ["evt_selected", "evt_remaining"])
    await f.db("billing_events").insert({
      tenant_id: "primary",
      id,
      type: "charge.refunded",
      payload: seal(
        {
          data: {
            object: {
              customer: "cus_only_reference",
              currency: "usd",
              amount: 100,
              application_fee_amount: null,
            },
          },
        },
        f.config.secret,
      ),
      received_at: 1,
      processed_at: 2,
    });
  const request = (await f.post("/closure", {}, "buyer-session", false)).json()
    .request;
  const approval = {
    ...closureApproval,
    reference: "first-review",
    stripeCustomerId: "cus_only_reference",
    eventIds: ["evt_selected"],
    workIds: [],
    auditIds: [],
    outgoingEventIds: [],
  };
  await f.customers.reconcileClosure("buyer", request.id, "operator", approval);
  const result = await f.customers.approveClosure(
    "buyer",
    request.id,
    "operator",
    closureApproval,
  );
  assert.equal(
    result.status,
    "blocked",
    "unreviewed PII remains attributable after binding redaction",
  );
  assert.ok(result.blockers.includes("retained_provider_payloads"));
  await f.customers.reconcileClosure("buyer", request.id, "operator", {
    ...approval,
    reference: "second-review",
    stripeCustomerId: null,
    eventIds: ["evt_remaining"],
  });
  assert.equal(
    (
      await f.customers.approveClosure(
        "buyer",
        request.id,
        "operator",
        closureApproval,
      )
    ).status,
    "completed",
  );
  const receipts = await f.db("account_privacy_receipts");
  assert.ok(
    receipts.every((row) => !row.details.includes("cus_only_reference")),
  );
});
