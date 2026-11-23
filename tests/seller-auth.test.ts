import test from "node:test";
import assert from "node:assert/strict";

test("seller identity service is available independently of buyer authentication", async () => {
  const identity = await import("../src/platform-auth.ts").catch(
    () => undefined,
  );
  assert.ok(
    identity?.PlatformAuth,
    "PlatformAuth seller identity service is required",
  );
});

import { before, after, beforeEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createDb, migrate, reset } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { hash, unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";
import { Window } from "happy-dom";
import type { FastifyRequest, FastifyReply } from "fastify";

const root = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/seller-auth-",
);
const db = createDb(`sqlite:${root}/db.sqlite`);
const config = loadConfig({ DEPLOYMENT_MODE: "hosted",
  APP_SECRET: "11".repeat(32),
  OPERATOR_TOKEN: "x".repeat(32),
});
let auth: InstanceType<typeof import("../src/platform-auth.ts").PlatformAuth>;
let tenants: InstanceType<typeof import("../src/tenants.ts").Tenants>;
let cookie = "";
let browserCookies: Record<string, string> = {};
let options: Record<string, unknown> = {};
const request = (
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
) => ({ headers, cookies }) as unknown as FastifyRequest;
const reply = {
  setCookie: (name: string, value: string, opts: Record<string, unknown>) => {
    browserCookies[name] = value;
    cookie = value;
    options = opts;
  },
} as unknown as FastifyReply;
const sameOrigin = () =>
  request({ origin: config.origin }, { ...browserCookies });
const send = (email: string) => auth.request(email, sameOrigin(), reply);
async function login(email = "owner@example.test") {
  const previous = await db("platform_emails").pluck("id");
  await send(email);
  const message = unseal<Message>(
    (await db("platform_emails").whereNotIn("id", previous).first()).payload,
    config.secret,
  );
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  await auth.consume(token, sameOrigin(), reply);
  const req = request({}, { [auth.cookieName]: cookie });
  const seller = await auth.seller(req, false);
  return { req, seller, token, cookie };
}
before(async () => {
  await migrate(db);
  const { PlatformAuth } = await import("../src/platform-auth.ts");
  const { Tenants } = await import("../src/tenants.ts");
  auth = new PlatformAuth(db, config);
  const defaults = { ...config };
  delete defaults.maxTenantsPerSeller;
  delete defaults.trialStorageBytes;
  tenants = new Tenants(db, defaults);
});
beforeEach(async () => {
  await reset(db);
  browserCookies = {};
});
after(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});

test("signup stores encrypted retryable credentials, verifies email only once and isolates seller cookies", async () => {
  await send(" OWNER@Example.Test ");
  const user = await db("seller_users").first();
  assert.equal(user.email, "owner@example.test");
  assert.equal(user.verified_at, null);
  const row = await db("platform_emails").first();
  const message = unseal<Message>(row.payload, config.secret);
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  assert.equal(message.to, user.email);
  assert.equal(row.state, "pending");
  assert.ok(!JSON.stringify(row).includes(user.email));
  assert.ok(!JSON.stringify(await db("seller_login_tokens")).includes(token));
  await assert.rejects(auth.consume(token, request(), reply), {
    code: "origin_denied",
  });
  await auth.consume(token, sameOrigin(), reply);
  assert.equal(auth.cookieName, "de-seller-session");
  assert.equal(options.httpOnly, true);
  assert.equal(options.path, "/");
  assert.equal(options.sameSite, "lax");
  assert.equal(options.secure, false);
  assert.ok((await db("seller_users").first()).verified_at > 0);
  assert.equal((await db("seller_sessions").first()).id, hash(cookie));
  assert.ok(!JSON.stringify(await db("audit_events")).includes(token));
  await assert.rejects(auth.consume(token, sameOrigin(), reply), {
    code: "invalid_login",
  });
  await assert.rejects(
    auth.seller(request({}, { "de-session": cookie }), false),
    {
      code: "seller_login_required",
    },
  );
  const { PlatformAuth } = await import("../src/platform-auth.ts");
  const productionAuth = new PlatformAuth(db, { ...config, production: true });
  assert.equal(productionAuth.cookieName, "__Host-de-seller-session");
});

test("invalid email, expired links and sessions, missing users and CSRF fail closed", async () => {
  await assert.rejects(send("bad address"), { code: "invalid_email" });
  const owner = await login();
  await db("seller_login_tokens").update({ created_at: Date.now() - 61000 });
  await send("owner@example.test");
  const latest = await db("seller_login_tokens").where({ used: 0 }).first();
  await db("seller_login_tokens")
    .where({ id: latest.id })
    .update({ expires_at: 0 });
  await assert.rejects(auth.consume("unknown", sameOrigin(), reply), {
    code: "invalid_login",
  });
  await assert.rejects(auth.seller(owner.req, true), { code: "origin_denied" });
  owner.req.headers.origin = config.origin;
  await assert.rejects(auth.seller(owner.req, true), { code: "csrf_denied" });
  owner.req.headers["x-csrf-token"] = "wrong";
  await assert.rejects(auth.seller(owner.req, true), { code: "csrf_denied" });
  owner.req.headers["x-csrf-token"] = owner.seller.csrfToken;
  assert.equal(
    (await auth.seller(owner.req, true)).user.id,
    owner.seller.user.id,
  );
  await db("seller_sessions").update({ expires_at: 0 });
  await assert.rejects(auth.seller(owner.req, false), {
    code: "seller_login_required",
  });
  await assert.rejects(
    auth.seller(request({}, { [auth.cookieName]: "unknown" }), false),
    { code: "seller_login_required" },
  );
});

test("owners create multiple immutable namespaces, cannot claim primary or another owner's tenant", async () => {
  const a = await login();
  const first = await tenants.create(a.seller, {
    slug: "alpha",
    name: "Alpha",
  });
  const second = await tenants.create(a.seller, { slug: "beta", name: "Beta" });
  assert.equal(first.exempt, 0);
  assert.equal(first.suspended, 0);
  assert.equal(first.stripe_account_id, null);
  assert.equal((await tenants.list(a.seller.user.id)).length, 2);
  assert.equal((await auth.tenant(a.req, "alpha", false)).id, first.id);
  assert.equal((await auth.tenant(a.req, "beta", false)).id, second.id);
  await assert.rejects(
    tenants.create(a.seller, { slug: "primary", name: "Steal primary" }),
    { code: "reserved_tenant" },
  );
  await assert.rejects(
    tenants.create(a.seller, { slug: "alpha", name: "Duplicate" }),
    { code: "tenant_exists" },
  );
  await assert.rejects(
    tenants.create(a.seller, { slug: "../bad", name: "Bad" }),
    { code: "invalid_tenant" },
  );
  await assert.rejects(tenants.create(a.seller, { slug: "valid", name: " " }), {
    code: "invalid_tenant",
  });
  await assert.rejects(auth.tenant(a.req, "absent", false), {
    code: "tenant_not_found",
  });
  const b = await login("other@example.test");
  await assert.rejects(auth.tenant(b.req, "alpha", false), {
    code: "tenant_denied",
  });
  await assert.rejects(tenants.createKey(b.seller, first.id, "Wrong owner"), {
    code: "tenant_denied",
  });
  await db("seller_memberships").where({ tenant_id: first.id }).delete();
  await assert.rejects(auth.tenant(a.req, "alpha", false), {
    code: "tenant_denied",
  });
});

test("tenant keys authorize one tenant, remain hashed, revoke and cannot replace an interactive owner", async () => {
  const a = await login();
  const alpha = await tenants.create(a.seller, {
    slug: "alpha",
    name: "Alpha",
  });
  await tenants.create(a.seller, { slug: "beta", name: "Beta" });
  const key = await tenants.createKey(a.seller, alpha.id, "Release automation");
  assert.match(key.token, /^DE-TK-[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(await db("tenant_api_keys")).includes(key.token));
  assert.ok(!JSON.stringify(await db("audit_events")).includes(key.token));
  assert.ok(
    !JSON.stringify(await tenants.keys(a.seller, alpha.id)).includes(
      "key_hash",
    ),
  );
  const req = request({ authorization: `Bearer ${key.token}` });
  assert.equal(
    (await auth.tenant(req, "alpha", true, true, "releases:write")).id,
    alpha.id,
  );
  await assert.rejects(auth.tenant(req, "beta", false, true, "read"), {
    code: "tenant_denied",
  });
  await assert.rejects(auth.tenant(req, "alpha", true, false), {
    code: "seller_login_required",
  });
  await assert.rejects(auth.seller(req), { code: "seller_login_required" });
  await assert.rejects(
    auth.tenant(
      request({ authorization: "invalid" }),
      "alpha",
      false,
      true,
      "read",
    ),
    { code: "tenant_denied" },
  );
  await assert.rejects(tenants.createKey(a.seller, alpha.id, " "), {
    code: "invalid_key_name",
  });
  await assert.rejects(tenants.revokeKey(a.seller, alpha.id, "absent"), {
    code: "key_not_found",
  });
  await tenants.revokeKey(a.seller, alpha.id, key.id);
  await tenants.revokeKey(a.seller, alpha.id, key.id);
  await assert.rejects(auth.tenant(req, "alpha", false, true, "read"), {
    code: "tenant_denied",
  });
  await db("seller_sessions").update({ expires_at: 0 });
  await assert.rejects(
    tenants.create(a.seller, { slug: "expired", name: "Expired" }),
    { code: "seller_login_required" },
  );
});

test("SaaS delinquency blocks capacity but preserves paid buyer recovery and downloads", async () => {
  const { tenantAvailable } = await import("../src/tenants.ts");
  const a = await login();
  const tenant = await tenants.create(a.seller, {
    slug: "alpha",
    name: "Alpha",
  });
  const now = Date.now();
  assert.equal(tenantAvailable(tenant, "capacity", 100, now), true);
  assert.equal(
    tenantAvailable(
      { ...tenant, trial_ends_at: now - 1000, paid_through: now - 1000 },
      "capacity",
      100,
      now,
    ),
    false,
  );
  for (const operation of ["buyer", "recovery", "reconcile"] as const)
    assert.equal(
      tenantAvailable(
        { ...tenant, trial_ends_at: 0, paid_through: 0 },
        operation,
        100,
        now,
      ),
      true,
    );
  assert.equal(
    tenantAvailable(
      { ...tenant, trial_ends_at: 0, paid_through: now - 50 },
      "capacity",
      100,
      now,
    ),
    true,
  );
  assert.equal(
    tenantAvailable(
      { ...tenant, exempt: 1, trial_ends_at: 0 },
      "capacity",
      0,
      now,
    ),
    true,
  );
  assert.equal(
    tenantAvailable({ ...tenant, suspended: 1, exempt: 1 }, "buyer", 0, now),
    false,
  );
});

test("seller email outbox retries without storing SMTP errors and clears delivered credentials", async () => {
  const { PlatformOutbox } = await import("../src/platform-auth.ts");
  await send("owner@example.test");
  const delivered: Message[] = [];
  const outbox = new PlatformOutbox(db, config.secret, {
    send: async (message) => {
      delivered.push(message);
      if (delivered.length === 1) throw Error("password=PRIVATE");
    },
  });
  await outbox.run();
  const failed = await db("platform_emails").first();
  assert.equal(failed.state, "pending");
  assert.equal(failed.last_error, "processing_failed");
  assert.ok(!JSON.stringify(failed).includes("PRIVATE"));
  await db("platform_emails").update({ available_at: 0 });
  await outbox.run();
  assert.deepEqual(delivered[0], delivered[1]);
  assert.equal((await db("platform_emails").first()).payload, "");
  assert.equal((await db("platform_emails").first()).state, "sent");
});

test("revoked owner sessions and unverified users cannot retain seller authority", async () => {
  const owner = await login();
  const tenant = await tenants.create(owner.seller, {
    slug: "alpha",
    name: "Alpha",
  });
  await db("seller_users")
    .where({ id: owner.seller.user.id })
    .update({ verified_at: null });
  await assert.rejects(auth.seller(owner.req, false), {
    code: "seller_login_required",
  });
  await assert.rejects(
    tenants.createKey(owner.seller, tenant.id, "No verification"),
    { code: "seller_login_required" },
  );
  await db("seller_users")
    .where({ id: owner.seller.user.id })
    .update({ verified_at: Date.now() });
  await db("seller_sessions").where({ id: owner.seller.sessionHash }).delete();
  await assert.rejects(auth.seller(owner.req, false), {
    code: "seller_login_required",
  });
  await assert.rejects(tenants.keys(owner.seller, tenant.id), {
    code: "seller_login_required",
  });
  await assert.rejects(tenants.revokeKey(owner.seller, tenant.id, "unknown"), {
    code: "seller_login_required",
  });
});

test("expired valid seller links cannot establish sessions and production cookies are secure", async () => {
  await send("owner@example.test");
  const message = unseal<Message>(
    (await db("platform_emails").first()).payload,
    config.secret,
  );
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  await db("seller_login_tokens")
    .where({ id: hash(token) })
    .update({ expires_at: 0 });
  await assert.rejects(auth.consume(token, sameOrigin(), reply), {
    code: "invalid_login",
  });
  assert.equal((await db("seller_sessions")).length, 0);
  const { PlatformAuth } = await import("../src/platform-auth.ts");
  const production = new PlatformAuth(db, { ...config, production: true });
  const previous = await db("platform_emails").pluck("id");
  await db("seller_login_tokens").update({ created_at: Date.now() - 61000 });
  await production.request("owner@example.test", sameOrigin(), reply);
  const next = unseal<Message>(
    (await db("platform_emails").whereNotIn("id", previous).first()).payload,
    config.secret,
  );
  await production.consume(
    /seller-login=([A-Za-z0-9_-]+)/.exec(next.text)![1]!,
    sameOrigin(),
    reply,
  );
  assert.equal(options.secure, true);
  assert.equal(options.maxAge, 7 * 86400);
});

test("workspace creation takes the auth lock before the schema lock", async () => {
  const owner = await login();
  await db.raw("CREATE TABLE lock_trace (seq INTEGER PRIMARY KEY, id TEXT)");
  await db.raw(
    "CREATE TRIGGER trace_locks AFTER UPDATE OF version ON locks BEGIN INSERT INTO lock_trace (id) VALUES (NEW.id); END",
  );
  try {
    await tenants.create(owner.seller, { slug: "ordered", name: "Ordered" });
    assert.deepEqual(
      (await db("lock_trace").orderBy("seq").pluck("id")).slice(0, 2),
      ["auth", "schema"],
    );
  } finally {
    await db.raw("DROP TRIGGER trace_locks");
    await db.raw("DROP TABLE lock_trace");
  }
});

test("seller outbox does not send credentials canceled after queue claim", async () => {
  await send("owner@example.test");
  await db.raw(
    "CREATE TRIGGER cancel_seller_email AFTER UPDATE OF state ON platform_emails WHEN NEW.state = 'running' BEGIN UPDATE platform_emails SET state = 'canceled' WHERE id = NEW.id; END",
  );
  const { PlatformOutbox } = await import("../src/platform-auth.ts");
  let calls = 0;
  try {
    await new PlatformOutbox(db, config.secret, {
      send: async () => {
        calls++;
      },
    }).run();
    assert.equal(calls, 0);
    assert.equal((await db("platform_emails").first()).state, "canceled");
  } finally {
    await db.raw("DROP TRIGGER cancel_seller_email");
  }
});

test("seller auth defaults reject mutations and tenant API keys without explicit scope permission", async () => {
  const owner = await login();
  await assert.rejects(auth.seller(owner.req), { code: "origin_denied" });
  const tenant = await tenants.create(owner.seller, {
    slug: "alpha",
    name: "Alpha",
  });
  await assert.rejects(auth.tenant(owner.req, "alpha"), {
    code: "origin_denied",
  });
  const key = await tenants.createKey(owner.seller, tenant.id, "CI");
  const req = request({ authorization: `Bearer ${key.token}` });
  await assert.rejects(auth.tenant(req, "alpha"), {
    code: "seller_login_required",
  });
  await assert.rejects(auth.tenant(req, "alpha", true, true), {
    code: "scope_required",
  });
  await assert.rejects(
    auth.tenant(req, "alpha", true, true, "licenses:write"),
    { code: "scope_denied" },
  );
  assert.equal(
    (await auth.tenant(req, "alpha", true, true, "releases:write")).id,
    tenant.id,
  );
  assert.ok(
    (await db("tenant_api_keys").where({ id: key.id }).first()).last_used_at >
      0,
  );
  assert.deepEqual(key.scopes, ["read", "releases:write"]);
  assert.equal(
    key.expires_at -
      (await db("tenant_api_keys").where({ id: key.id }).first()).created_at,
    90 * 86400000,
  );
  await db("tenant_api_keys").where({ id: key.id }).update({ expires_at: 0 });
  await assert.rejects(auth.tenant(req, "alpha", true, true, "read"), {
    code: "tenant_denied",
  });
});

test("forwarded seller login links cannot replace the current authenticated browser session", async () => {
  const owner = await login();
  await send("attacker@example.test");
  const row = await db("platform_emails")
    .whereNot({ id: (await db("platform_emails").first()).id })
    .first();
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(
    unseal<Message>(row.payload, config.secret).text,
  )![1]!;
  const beforeCookie = browserCookies[auth.cookieName];
  await assert.rejects(
    auth.consume(
      token,
      request({ origin: config.origin }, { [auth.cookieName]: owner.cookie }),
      reply,
    ),
    { code: "invalid_login" },
  );
  assert.equal(browserCookies[auth.cookieName], beforeCookie);
  assert.equal(
    (await auth.seller(owner.req, false)).user.id,
    owner.seller.user.id,
  );
  const link = await db("seller_login_tokens")
    .where({ id: hash(token) })
    .first();
  assert.equal(link.used, 0);
  assert.ok(link.browser_hash);
  await auth.consume(token, sameOrigin(), reply);
});

test("seller login email throttles persist after used links and suppress generically without rotating browser binding", async () => {
  const owner = await login();
  const before = { ...browserCookies };
  assert.equal(await send(owner.seller.user.email), undefined);
  assert.deepEqual(browserCookies, before);
  assert.equal((await db("platform_emails")).length, 1);
  for (let i = 1; i < 10; i++) {
    await db("seller_login_tokens").decrement("created_at", 61000);
    await send(owner.seller.user.email);
  }
  assert.equal((await db("platform_emails")).length, 10);
  await db("seller_login_tokens").decrement("created_at", 61000);
  await send(owner.seller.user.email);
  assert.equal((await db("platform_emails")).length, 10);
  await assert.rejects(auth.request("other@example.test", request(), reply), {
    code: "origin_denied",
  });
});

test("tenant quota is serialized, trials cannot be restarted and reserved platform namespaces are rejected", async () => {
  const owner = await login();
  const verifiedAt = Date.now() - 3 * 86400000;
  await db("seller_users")
    .where({ id: owner.seller.user.id })
    .update({ verified_at: verifiedAt });
  const results = await Promise.allSettled(
    ["one", "two", "three", "four"].map((slug) =>
      tenants.create(owner.seller, { slug, name: slug }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 3);
  const failure = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.equal(failure.reason.code, "tenant_limit");
  for (const tenant of await tenants.list(owner.seller.user.id)) {
    assert.equal(tenant.trial_ends_at, verifiedAt + 14 * 86400000);
    assert.equal(tenant.max_products, 3);
    assert.equal(tenant.max_storage_bytes, 100 * 1024 * 1024);
  }
  for (const slug of [
    "primary",
    "admin",
    "api",
    "operator",
    "platform",
    "seller",
    "stripe",
    "wordpress",
    "support",
    "entitle",
  ])
    await assert.rejects(tenants.create(owner.seller, { slug, name: slug }), {
      code: "reserved_tenant",
    });
});

test("API key scope and expiration policy rejects invalid inputs and hides secret hashes", async () => {
  const owner = await login();
  const tenant = await tenants.create(owner.seller, {
    slug: "alpha",
    name: "Alpha",
  });
  for (const options of [
    { scopes: ["owner"] },
    { scopes: [] },
    { expiresInDays: 0 },
    { expiresInDays: 366 },
    { expiresInDays: 1.5 },
  ])
    await assert.rejects(
      tenants.createKey(owner.seller, tenant.id, "Invalid", options),
      { code: "invalid_key_policy" },
    );
  const key = await tenants.createKey(owner.seller, tenant.id, "Read only", {
    scopes: ["read", "read"],
    expiresInDays: 1,
  });
  assert.deepEqual(key.scopes, ["read"]);
  assert.equal(key.display_prefix, key.token.slice(0, 14));
  const listed = await tenants.keys(owner.seller, tenant.id);
  assert.equal(listed[0].display_prefix, key.display_prefix);
  assert.ok(!JSON.stringify(listed).includes(key.token));
  const req = request({ authorization: `Bearer ${key.token}` });
  await db("tenant_api_keys")
    .where({ id: key.id })
    .update({ scopes: "broken JSON" });
  await assert.rejects(auth.tenant(req, "alpha", false, true, "read"), {
    code: "scope_denied",
  });
  // Release publication parses scopes separately; corrupt JSON must still deny.
  const publish = await auth.publicationAuthorization(req, tenant.id);
  await assert.rejects(
    db.transaction((tx) => publish(tx)),
    { code: "scope_denied" },
  );
  await db("tenant_api_keys").where({ id: key.id }).update({ scopes: "null" });
  await assert.rejects(auth.tenant(req, "alpha", false, true, "read"), {
    code: "scope_denied",
  });
});

test("wrong-browser and migrated unbound seller links fail without consuming the valid token", async () => {
  await send("owner@example.test");
  const message = unseal<Message>(
    (await db("platform_emails").first()).payload,
    config.secret,
  );
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  const boundReq = sameOrigin();
  await assert.rejects(
    auth.consume(
      token,
      request(
        { origin: config.origin },
        { [auth.preauthCookieName]: "another-browser" },
      ),
      reply,
    ),
    { code: "invalid_login" },
  );
  await db("seller_login_tokens")
    .where({ id: hash(token) })
    .update({ browser_hash: null });
  await assert.rejects(auth.consume(token, boundReq, reply), {
    code: "invalid_login",
  });
  await db("seller_login_tokens")
    .where({ id: hash(token) })
    .update({ browser_hash: hash(boundReq.cookies[auth.preauthCookieName]!) });
  await auth.consume(token, boundReq, reply);
});

test("API keys require a recognized operation scope and legacy unbounded keys are denied", async () => {
  const owner = await login();
  const tenant = await tenants.create(owner.seller, {
    slug: "alpha",
    name: "Alpha",
  });
  const key = await tenants.createKey(owner.seller, tenant.id, "CI");
  const req = request({ authorization: `Bearer ${key.token}` });
  await assert.rejects(auth.tenant(req, "alpha", true, true, "owner"), {
    code: "scope_required",
  });
  await db("tenant_api_keys")
    .where({ id: key.id })
    .update({ expires_at: null });
  await assert.rejects(auth.tenant(req, "alpha", false, true, "read"), {
    code: "tenant_denied",
  });
});

test("operator-configured seller tenant and storage limits apply without renewing the seller trial", async () => {
  const owner = await login();
  const { Tenants } = await import("../src/tenants.ts");
  const operatorConfig = {
    ...config,
    maxTenantsPerSeller: 1,
    trialStorageBytes: 1024,
  };
  delete operatorConfig.trialDays;
  const limited = new Tenants(db, operatorConfig);
  const tenant = await limited.create(owner.seller, {
    slug: "tiny",
    name: "Tiny",
  });
  assert.equal(tenant.max_storage_bytes, 1024);
  assert.equal(
    tenant.trial_ends_at,
    owner.seller.user.verified_at! + 14 * 86400000,
  );
  await assert.rejects(
    limited.create(owner.seller, { slug: "another", name: "Another" }),
    { code: "tenant_limit" },
  );
});

test("seller sign-in email provides an accessible HTML action and matching text fallback", async () => {
  await send("owner@example.test");
  const row = await db("platform_emails").first();
  const message = unseal<Message>(row.payload, config.secret);
  assert.equal(typeof message.html, "string", "sign-in mail must include HTML");
  const window = new Window();
  try {
    window.document.write(message.html!);
    const document = window.document;
    assert.equal(document.documentElement.lang, "en");
    assert.equal(document.querySelectorAll("h1").length, 1);
    const action = Array.from(document.querySelectorAll("a")).find(
      (link) => link.textContent.trim() === "Sign in to Entitle",
    );
    assert.ok(action, "a clearly named sign-in action is required");
    const url = /https?:\/\/[^\s]+#seller-login=[A-Za-z0-9_-]+/.exec(
      message.text,
    )![0];
    assert.equal(action.getAttribute("href"), url);
    const fallback = Array.from(document.querySelectorAll("a")).find(
      (link) => link.textContent.trim() === url,
    );
    assert.equal(
      fallback?.getAttribute("href"),
      url,
      "the full URL must remain copyable",
    );
    for (const content of [document.body.textContent, message.text]) {
      assert.match(content, /same browser/i);
      assert.match(content, /latest.*link/i);
      assert.match(content, /15 minutes/);
      assert.match(content, /single.use/i);
      assert.match(content, /didn.t request|did not request/i);
    }
    assert.equal(document.querySelectorAll("img, script, form").length, 0);
    assert.ok(
      !JSON.stringify(row).includes(url),
      "HTML credentials stay encrypted in the queue",
    );
  } finally {
    await window.happyDOM.close();
  }
});
