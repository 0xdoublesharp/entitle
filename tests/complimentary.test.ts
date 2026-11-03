import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { isolatedDatabase } from "./helpers/database.ts";
import { createTenant, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { csrf, hash, unseal } from "../src/crypto.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Outbox, type Message } from "../src/email.ts";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import Stripe from "stripe";

process.env.NODE_ENV = "test";
const base = "/api/v1/tenants/primary";
async function fixture(t: TestContext, production = false) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/complimentary-case-");
  const config = loadConfig({ APP_SECRET: "42".repeat(32), OPERATOR_TOKEN: "operator-test-".repeat(4), DATA_DIR: root,
    DEPLOYMENT_MODE: production ? "standalone" : "hosted", APP_BASE_PATH: "", LOCAL_BILLING: "false",
    ...(production ? { NODE_ENV: "production", PUBLIC_ORIGIN: "https://licenses.example.test", STANDALONE_OWNER_EMAIL: "owner@example.test",
      SMTP_HOST: "smtp.example.test", MAIL_FROM: "licenses@example.com", TRUST_PROXY: "127.0.0.1", S3_BUCKET: "private", S3_REGION: "us-east-1" } : {}) });
  config.stripeSecret = "";
  config.stripeWebhookSecret = "";
  const database = await isolatedDatabase(config.databaseUrl);
  const db = database.db;
  await migrate(db);
  const sent: Message[] = [];
  const store = new InMemoryArtifactStore();
  const app = await buildApp(config, db, { send: async message => { sent.push(message); } }, { store });
  t.after(async () => { await app.close(); await database.close(); await rm(root, { recursive: true, force: true }); });
  const now = Date.now(), owner = randomUUID(), session = randomUUID();
  await db("seller_users").insert({ id: owner, email: "owner@example.test", verified_at: now, created_at: now });
  await db("seller_memberships").insert({ tenant_id: "primary", user_id: owner, role: "owner", created_at: now });
  await db("seller_sessions").insert({ id: hash(session), user_id: owner, expires_at: now + 86400000 });
  const headers = { cookie: `${production ? "__Host-" : ""}de-seller-session=${session}`, origin: config.origin, "x-csrf-token": csrf(session, config.secret) };
  const productId = randomUUID();
  await db("products").insert({ tenant_id: "primary", id: productId, slug: "validated-field-pro", name: "Validated Field Pro" });
  const post = (path: string, payload: object, auth = headers) => app.inject({ method: "POST", url: `${base}${path}`, payload, headers: auth });
  const input = { email: " PILOT@Example.Test ", productId, siteAllowance: 1, expiresAt: now + 86400000,
    note: "Invited pilot", requestId: randomUUID(), confirm: true };
  const issue = async () => {
    const response = await post("/seller/licenses/complimentary", input);
    assert.equal(response.statusCode, 200, response.body);
    const license = await db("licenses").where({ id: response.json().id }).first();
    const job = await db("emails").where({ license_id: license.id, kind: "license_key" }).first();
    const message = unseal<Message>(job.payload, config.secret);
    const key = /DE-[A-Za-z0-9_-]+/.exec(message.text)![0];
    return { license, key, response, message };
  };
  const buyer = async (customerId: string) => {
    const session = randomUUID();
    await db("sessions").insert({ tenant_id: "primary", id: hash(session), customer_id: customerId, expires_at: now + 86400000 });
    return { cookie: `${production ? "__Host-" : ""}de-session-primary=${session}`, origin: config.origin, "x-csrf-token": csrf(session, config.secret) };
  };
  return { db, app, config, store, sent, headers, input, issue, post, buyer };
}

test("complimentary issuance atomically creates real entitlement, customer, one encrypted email and audit without payment", async t => {
  const f = await fixture(t);
  const { license, key, response, message } = await f.issue();
  assert.equal(license.provenance, "complimentary");
  assert.equal(Number(license.expires_at), f.input.expiresAt);
  assert.equal(license.paid_through, 0);
  assert.equal(license.plan_id, null);
  assert.equal(license.subscription_id, null);
  assert.equal(license.billing_status, "complimentary");
  assert.equal(license.internal_note, "Invited pilot");
  assert.equal(license.key_hash, hash(key));
  assert.equal((await f.db("customers").first()).email, "pilot@example.test");
  assert.equal((await f.db("customers").first()).stripe_id, null);
  assert.match(message.text, /complimentary/i);
  assert.match(message.text, /not.*automatically|no.*subscription/i);
  for (const table of ["plans", "grants", "invoice_metrics", "platform_checkouts", "billing_events"])
    assert.equal((await f.db(table)).length, 0, table);
  const audit = await f.db("audit_events").where({ action: "license.complimentary_issued" });
  assert.equal(audit.length, 1);
  assert.equal(JSON.stringify(audit).includes(key), false);
  assert.equal(JSON.stringify(await f.db("licenses")).includes(key), false);
  assert.equal(response.body.includes(key), false);
  const overview = await f.app.inject({ url: `${base}/seller/overview`, headers: f.headers });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.equal(overview.json().licenses[0].provenance, "complimentary");
  assert.equal(overview.json().metrics.licenses.entitled, 1);
  assert.deepEqual(overview.json().metrics.payments, []);
  const account = await f.app.inject({ url: `${base}/me`, headers: await f.buyer(license.customer_id) });
  assert.equal(account.json().licenses[0].provenance, "complimentary");
  assert.equal(account.json().licenses[0].entitled, true);
  assert.equal(account.body.includes("Invited pilot"), false);
  await new Outbox(f.db, f.config.secret, { send: async m => { f.sent.push(m); } }, { id: "primary", slug: "primary", name: "Primary" }).run();
  assert.equal(f.sent.filter(m => m.text.includes(key)).length, 1);
});

test("complimentary license detail and retained Stripe customers remain readable with billing disabled", async t => {
  const f = await fixture(t);
  const { license } = await f.issue();
  const detail = await f.app.inject({ url: `${base}/seller/licenses/${license.id}`, headers: f.headers });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().license.plan_name, "Complimentary");
  assert.equal(detail.json().license.expires_at, f.input.expiresAt);
  await f.db("licenses").where({ id: license.id }).update({ refund_revoked: 1 });
  const revoked = await f.app.inject({ url: `${base}/seller/licenses/${license.id}`, headers: f.headers });
  assert.equal(revoked.json().license.revoked, true);
  await f.db("customers").where({ id: license.customer_id }).update({ stripe_id: "cus_retained" });
  const account = await f.app.inject({ url: `${base}/me`, headers: await f.buyer(license.customer_id) });
  assert.equal(account.statusCode, 200, account.body);
  assert.equal(account.json().billingAvailable, false);
});

test("complimentary retry identity survives concurrency, expiry and key replacement; conflicting reuse fails", async t => {
  const f = await fixture(t);
  const responses = await Promise.all([1, 2, 3].map(() => f.post("/seller/licenses/complimentary", f.input)));
  for (const r of responses) assert.equal(r.statusCode, 200, r.body);
  assert.equal(new Set(responses.map(r => r.json().id)).size, 1);
  assert.equal((await f.db("licenses")).length, 1);
  assert.equal((await f.db("customers")).length, 1);
  assert.equal((await f.db("emails")).length, 1);
  assert.equal((await f.db("audit_events").where({ action: "license.complimentary_issued" })).length, 1);
  assert.equal((await f.post("/seller/licenses/complimentary", { ...f.input, siteAllowance: 2 })).statusCode, 409);
  const license = await f.db("licenses").first();
  const replacement = await f.post(`/licenses/${license.id}/key`, {}, await f.buyer(license.customer_id));
  assert.equal(replacement.statusCode, 200, replacement.body);
  await f.db("licenses").where({ id: license.id }).update({ expires_at: 1 });
  assert.equal((await f.post("/seller/licenses/complimentary", f.input)).json().id, license.id);
  assert.equal((await f.db("emails")).length, 2);
  const next = await f.post("/seller/licenses/complimentary", { ...f.input, requestId: randomUUID() });
  assert.equal(next.statusCode, 200, next.body);
  assert.equal((await f.db("customers")).length, 1);
});

test("complimentary issuance rolls customer, license, encrypted email and audit back together on failure", async t => {
  const f = await fixture(t);
  let fail = true;
  const fault = (query: { sql: string }) => {
    if (fail && /insert into ["`]audit_events["`]/.test(query.sql)) {
      fail = false;
      throw Error("Injected audit write failure");
    }
  };
  f.db.on("query", fault);
  try {
    assert.equal((await f.post("/seller/licenses/complimentary", f.input)).statusCode, 500);
  } finally { f.db.removeListener("query", fault); }
  for (const table of ["customers", "licenses", "emails", "audit_events", "business_events"])
    assert.equal((await f.db(table)).length, 0, table);
  await f.issue();
  assert.equal((await f.db("licenses")).length, 1);
  assert.equal((await f.db("emails")).length, 1);
});

test("complimentary uses normal activation, seats, authorized WordPress downloads/updates and lifecycle controls", async t => {
  const f = await fixture(t), { license, key } = await f.issue();
  const releaseId = randomUUID(), bytes = Buffer.from("private release");
  await f.db("releases").insert({ tenant_id: "primary", id: releaseId, product_id: f.input.productId, version: "1.0.0", published_at: Date.now()-1000, checksum: hash("private release"), size: bytes.length,
    changelog: "Pilot", min_wp: "6.0", min_php: "8.0", min_free: "0.0.0", tested: "7.0" });
  await f.store.put("primary", releaseId, bytes, hash("private release"));
  const activate = (installationId: string, licenseKey = key) => f.post("/activate", { key: licenseKey, installationId, siteUrl: `https://${installationId}.example.test`, product: "validated-field-pro" }, {} as typeof f.headers);
  const activated = await activate("site-first");
  assert.equal(activated.statusCode, 200, activated.body);
  const token = activated.json().token, auth = { authorization: `Bearer ${token}` };
  assert.equal((await activate("site-second")).json().error.code, "site_limit");
  const checkAccess = async (allowed: boolean) => {
    const update = await f.app.inject({ url: `${base}/updates/validated-field-pro`, headers: auth });
    assert.equal(update.statusCode, allowed ? 200 : 403, update.body);
    const download = await f.app.inject({ url: `${base}/packages/${releaseId}`, headers: auth });
    assert.equal(download.statusCode, allowed ? 200 : 403, download.body);
    if (allowed) assert.deepEqual(download.rawPayload, bytes);
  };
  await checkAccess(true);
  assert.equal((await f.app.inject({ url: `${base}/packages/${releaseId}` })).statusCode, 401);
  const buyer = await f.buyer(license.customer_id);
  assert.equal((await f.app.inject({ url: `${base}/licenses/${license.id}/releases/${releaseId}/download`, headers: buyer })).statusCode, 200);
  assert.equal((await f.post(`/seller/licenses/${license.id}/revoke`, { revoked: true })).statusCode, 200);
  await checkAccess(false);
  assert.equal((await activate("site-second")).statusCode, 403);
  await f.post(`/seller/licenses/${license.id}/revoke`, { revoked: false });
  await checkAccess(true);
  const replaced = await f.post(`/licenses/${license.id}/key`, {}, buyer);
  assert.equal(replaced.statusCode, 200, replaced.body);
  assert.equal((await activate("site-third", key)).statusCode, 401);
  assert.equal((await f.app.inject({ url: `${base}/activation`, headers: auth })).statusCode, 401);
  const reactivated = await activate("site-third", replaced.json().key);
  assert.equal(reactivated.statusCode, 200, reactivated.body);
  await f.db("licenses").where({ id: license.id }).update({ expires_at: Date.now() });
  const expiredToken = { authorization: `Bearer ${reactivated.json().token}` };
  assert.equal((await activate("site-fourth", replaced.json().key)).statusCode, 403);
  assert.equal((await f.app.inject({ url: `${base}/updates/validated-field-pro`, headers: expiredToken })).statusCode, 403);
  assert.equal((await f.app.inject({ url: `${base}/packages/${releaseId}`, headers: expiredToken })).statusCode, 403);
  const status = await f.app.inject({ url: `${base}/activation`, headers: expiredToken });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().entitled, false);
  assert.equal((await f.db("installations").where({ active: 1 })).length, 1);
  assert.equal((await f.app.inject({ url: `${base}/licenses/${license.id}/releases/${releaseId}/download`, headers: buyer })).statusCode, 403);
});

test("complimentary issuance enforces confirmation, validation, CSRF, scope and tenant ownership with no partial writes", async t => {
  const f = await fixture(t);
  const url = "/seller/licenses/complimentary";
  assert.equal((await f.post(url, f.input, {} as typeof f.headers)).statusCode, 401);
  assert.equal((await f.post(url, f.input, { ...f.headers, "x-csrf-token": "bad" })).statusCode, 403);
  for (const values of [{ confirm: false }, { email: "invalid" }, { siteAllowance: 0 }, { expiresAt: Date.now()-1 }, { note: "x".repeat(2001) }])
    assert.equal((await f.post(url, { ...f.input, ...values })).statusCode, 400);
  const other = await createTenant(f.db, { id: randomUUID(), slug: "other", name: "Other", exempt: 1 });
  const foreignId = randomUUID();
  await f.db("products").insert({ tenant_id: other.id, id: foreignId, slug: "foreign", name: "Foreign" });
  assert.equal((await f.post(url, { ...f.input, productId: foreignId })).statusCode, 404);
  assert.equal((await f.app.inject({ method: "POST", url: `/api/v1/tenants/other${url}`, payload: f.input, headers: f.headers })).statusCode, 403);
  const token = "DE-TK-test-read-only-key";
  await f.db("tenant_api_keys").insert({ tenant_id: "primary", id: randomUUID(), name: "Read", key_hash: hash(token), scopes: '["read"]', created_at: Date.now(), expires_at: Date.now()+86400000, display_prefix: "DE-TK-test" });
  assert.equal((await f.post(url, f.input, { authorization: `Bearer ${token}` } as unknown as typeof f.headers)).statusCode, 403);
  assert.equal((await f.db("licenses")).length, 0);
  assert.equal((await f.db("customers")).length, 0);
  assert.equal((await f.db("emails")).length, 0);
  await f.db("tenant_api_keys").where({ key_hash: hash(token) }).update({ scopes: '["licenses:write"]' });
  const scoped = { authorization: `Bearer ${token}` };
  const issued = await f.post(url, f.input, scoped as unknown as typeof f.headers);
  assert.equal(issued.statusCode, 200, issued.body);
  const customer = await f.db("customers").first();
  const buyer = await f.buyer(customer.id);
  const foreignBase = "/api/v1/tenants/other";
  assert.equal((await f.app.inject({ url: `${foreignBase}/me`, headers: buyer })).statusCode, 401);
  assert.equal((await f.app.inject({ method: "POST", url: `${foreignBase}/seller/licenses/complimentary`, headers: scoped, payload: f.input })).statusCode, 403);
  await f.db("customers").insert({ tenant_id: "primary", id: randomUUID(), email: "other@example.test", stripe_id: null });
  const stranger = await f.db("customers").where({ email: "other@example.test" }).first();
  assert.equal((await f.post(`/licenses/${issued.json().id}/key`, {}, await f.buyer(stranger.id))).statusCode, 404);
});

test("paid reconciliation coexists with complimentary customers and cannot overwrite complimentary entitlement", async t => {
  const f = await fixture(t), { license } = await f.issue();
  const planId = randomUUID(), now = Date.now();
  await f.db("plans").insert({ tenant_id: "primary", id: planId, product_id: f.input.productId, name: "Paid annual", site_allowance: 5, stripe_price_id: "price_paid" });
  const snapshot: BillingSnapshot = { subscriptionId: "sub_paid", customerId: "cus_paid", email: "pilot@example.test", billingStatus: "active", suspended: false, fullyRefunded: false,
    grants: [{ id: "line_paid", invoiceId: "in_paid", priceId: "price_paid", periodStart: now-1000, periodEnd: now+86400000, paidAt: now, settled: true }] };
  const licensing = new Licenses(f.db, f.config.secret, [], { id: "primary", slug: "primary", name: "Primary" });
  await new Billing(f.db, licensing, { snapshot: async () => snapshot }).reconcile("sub_paid");
  assert.equal((await f.db("customers")).length, 1);
  assert.equal((await f.db("licenses")).length, 2);
  assert.equal((await f.db("licenses").where({ id: license.id }).first()).site_allowance, 1);
  assert.equal((await f.db("grants").where({ license_id: license.id })).length, 0);
  const reused = await f.post("/seller/licenses/complimentary", { ...f.input, requestId: randomUUID() });
  assert.equal(reused.statusCode, 200, reused.body);
  assert.equal(reused.json().customerId, license.customer_id);
  assert.equal((await f.db("customers")).length, 1);
  assert.equal((await f.db("customers").first()).stripe_id, "cus_paid");
  assert.equal((await f.db("licenses").where({ id: reused.json().id }).first()).subscription_id, null);
  // Even corrupted/provider-bound rows must fail closed rather than accepting paid grants.
  await f.db("licenses").where({ id: license.id }).update({ subscription_id: "sub_poison" });
  snapshot.subscriptionId = "sub_poison";
  await assert.rejects(new Billing(f.db, licensing, { snapshot: async () => snapshot }).reconcile("sub_poison"), { code: "billing_provenance_conflict" });
  const after = await f.db("licenses").where({ id: license.id }).first();
  assert.equal(Number(after.expires_at), f.input.expiresAt);
  assert.equal(after.paid_through, 0);
  assert.equal(after.site_allowance, 1);
});

test("Stripe-free catalog administration permits products with no paid plans and paid operations stay unavailable", async t => {
  const f = await fixture(t);
  const created = await f.post("/seller/products", { slug: "new-product", name: "New product", plans: [] });
  assert.equal(created.statusCode, 200, created.body);
  assert.deepEqual(created.json().plans, []);
  assert.equal((await f.app.inject({ url: `${base}/seller/overview`, headers: f.headers })).json().billingAvailable, false);
  assert.equal((await f.app.inject({ url: `${base}/catalog` })).json().billingAvailable, false);
  assert.equal((await f.app.inject({ url: `${base}/seller/prices`, headers: f.headers })).statusCode, 503);
  assert.equal((await f.post("/seller/products", { slug: "paid", name: "Paid", plans: [{ name: "Annual", siteAllowance: 1, priceId: "price_unverified" }] })).statusCode, 503);
  assert.equal((await f.post("/seller/reconcile", { subscriptionId: "sub_no_provider" })).statusCode, 503);
  assert.equal((await f.post("/checkout", { planId: "not-a-plan", email: "pilot@example.test" })).statusCode, 503);
  const { license } = await f.issue();
  assert.equal((await f.post("/portal", {}, await f.buyer(license.customer_id))).statusCode, 503);
  assert.equal((await f.app.inject({ method: "POST", url: "/api/v1/stripe/platform-webhook", payload: {}, headers: { "stripe-signature": "invalid" } })).statusCode, 503);
});

test("production standalone issues a usable complimentary license with Stripe absent and LOCAL_BILLING off", async t => {
  const f = await fixture(t, true), { license, key } = await f.issue();
  assert.equal(f.config.production, true);
  assert.equal(f.config.localBilling, false);
  assert.equal(f.config.stripeSecret, "");
  const activated = await f.post("/activate", { key, product: "validated-field-pro", installationId: "production-fixture", siteUrl: "https://pilot.example.test" }, {} as typeof f.headers);
  assert.equal(activated.statusCode, 200, activated.body);
  assert.equal(activated.json().paidThrough, f.input.expiresAt);
  const account = await f.app.inject({ url: `${base}/me`, headers: await f.buyer(license.customer_id) });
  assert.equal(account.statusCode, 200, account.body);
  assert.equal(account.json().licenses[0].entitled, true);
  assert.equal(account.json().billingAvailable, false);
});

test("separately configured Stripe test webhooks remain usable while primary billing is absent", async t => {
  const f = await fixture(t);
  f.config.stripeTestSecret = "sk_test_separate";
  f.config.stripeTestPublishableKey = "pk_test_separate";
  f.config.stripeTestWebhookSecret = "whsec_separate";
  const payload = JSON.stringify({ id: "evt_sandbox", type: "customer.updated", livemode: false, account: "acct_unknown", data: { object: { id: "cus_unknown" } } });
  const response = await f.app.inject({ method: "POST", url: "/api/v1/stripe/sandbox-webhook", payload,
    headers: { "content-type": "application/json", "stripe-signature": Stripe.webhooks.generateTestHeaderString({ payload, secret: f.config.stripeTestWebhookSecret }) } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { ok: true, ignored: true });
});
