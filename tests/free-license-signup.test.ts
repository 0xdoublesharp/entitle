import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { isolatedDatabase } from "./helpers/database.ts";
import { createTenant, migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { hash, seal, unseal } from "../src/crypto.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Outbox, type Message } from "../src/email.ts";

process.env.NODE_ENV = "test";
const origin = "https://rcs.example.test";
const base = "/api/v1/tenants/primary/free-license/remote-content-shortcode-pro";
const credentials = { APP_SECRET: "42".repeat(32), OPERATOR_TOKEN: "operator-test-".repeat(4) };
const offer = () => ({ tenant: "primary", product: "remote-content-shortcode-pro", campaign: "feedback-pilot", siteAllowance: 1,
  expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(), origins: [origin], dailyLimit: 50 });
async function fixture(t: TestContext, patch: Record<string, unknown> = {}, standalone = false) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/free-signup-");
  const config = loadConfig({ ...credentials, DATA_DIR: root, DEPLOYMENT_MODE: standalone ? "standalone" : "hosted", STANDALONE_OWNER_EMAIL: "owner@example.test", LOCAL_BILLING: "false",
    FREE_LICENSE_OFFERS: JSON.stringify([{ ...offer(), ...patch }]) });
  config.stripeSecret = ""; config.stripeWebhookSecret = "";
  const database = await isolatedDatabase(config.databaseUrl), db = database.db;
  await migrate(db);
  const store = new InMemoryArtifactStore(), sent: Message[] = [];
  const app = await buildApp(config, db, { send: async message => { sent.push(message); } }, { store });
  await app.ready();
  t.after(async () => { await app.close(); await database.close(); await rm(root, { recursive: true, force: true }); });
  const productId = randomUUID(), releaseId = randomUUID(), bytes = Buffer.from("private Pro ZIP");
  await db("products").insert({ tenant_id: "primary", id: productId, slug: "remote-content-shortcode-pro", name: "Remote Content Shortcode Pro" });
  await db("releases").insert({ tenant_id: "primary", id: releaseId, product_id: productId, version: "2.0.0", published_at: Date.now() - 1000,
    checksum: hash(bytes.toString()), size: bytes.length, changelog: "Pro", min_wp: "6.6", min_php: "8.2", min_free: "2.0.0", tested: "7.0" });
  await store.put("primary", releaseId, bytes, hash(bytes.toString()));
  const post = (path: string, payload: object, headers = { origin }) => app.inject({ method: "POST", url: base + path, headers, payload });
  const issue = async () => {
    const response = await post("", { email: " PILOT@Example.Test ", consent: true });
    assert.equal(response.statusCode, 202, response.body);
    const job = await db("emails").where({ kind: "license_key" }).first();
    const message = unseal<Message>(job.payload, config.secret);
    return /DE-[A-Za-z0-9_-]+/.exec(message.text)![0];
  };
  return { app, db, config, post, issue, productId, releaseId, bytes, sent };
}

test("free offers are explicit, validated and disabled by default", () => {
  assert.deepEqual(loadConfig(credentials).freeLicenseOffers, []);
  for (const patch of [{ origins: ["https://evil.test/path"] }, { origins: ["https://user:pass@evil.test"] }, { origins: ["*"] },
    { siteAllowance: 0 }, { expiresAt: "invalid" }, { campaign: "" }, { dailyLimit: 0 }])
    assert.throws(() => loadConfig({ ...credentials, FREE_LICENSE_OFFERS: JSON.stringify([{ ...offer(), ...patch }]) }));
  const duplicate = offer();
  assert.throws(() => loadConfig({ ...credentials, FREE_LICENSE_OFFERS: JSON.stringify([duplicate, duplicate]) }));
});

test("RCS signup queues one real key without payment, exposes no key, and deduplicates concurrent email requests", async t => {
  const f = await fixture(t);
  const metadata = await f.app.inject({ url: base, headers: { origin } });
  assert.equal(metadata.statusCode, 200, metadata.body);
  assert.equal(metadata.json().siteAllowance, 1);
  assert.equal(metadata.json().licensingApi, f.config.origin + "/api/v1/tenants/primary");
  assert.equal(metadata.headers["access-control-allow-origin"], origin);
  assert.equal(metadata.headers["access-control-allow-credentials"], undefined);
  assert.equal(metadata.headers["cache-control"], "no-store");
  const first = await Promise.all([1,2,3].map(() => f.post("", { email: "pilot@example.test", consent: true })));
  for (const response of first) assert.equal(response.statusCode, 202, response.body);
  const job = await f.db("emails").where({ kind: "license_key" }).first();
  const key = /DE-[A-Za-z0-9_-]+/.exec(unseal<Message>(job.payload, f.config.secret).text)![0];
  const replies = await Promise.all([1,2].map(() => f.post("", { email: "pilot@example.test", consent: true })));
  for (const reply of replies) { assert.equal(reply.statusCode, 202, reply.body); assert.equal(reply.body.includes(key), false); }
  const licenses = await f.db("licenses");
  assert.equal(licenses.length, 1); assert.equal(licenses[0].provenance, "complimentary");
  assert.equal(licenses[0].site_allowance, 1); assert.equal(licenses[0].subscription_id, null);
  assert.equal((await f.db("emails")).length, 1);
  assert.equal((await f.db("customers")).length, 1);
  assert.equal((await f.db("plans")).length, 0);
  assert.equal((await f.db("audit_events").where({ actor_type: "public_signup" })).length, 1);
  await new Outbox(f.db, f.config.secret, { send: async message => { f.sent.push(message); } }, { id: "primary", slug: "primary", name: "Primary" }).run();
  assert.equal(f.sent.filter(message => message.text.includes(key)).length, 1);
});

test("Pro downloads unlock only with an entitled product key and recheck access without consuming a site seat", async t => {
  const f = await fixture(t), key = await f.issue();
  assert.equal((await f.post("/unlock", { key: "DE-wrong" })).statusCode, 403);
  const unlocked = await f.post("/unlock", { key });
  assert.equal(unlocked.statusCode, 200, unlocked.body);
  assert.equal(unlocked.json().version, "2.0.0");
  assert.equal(unlocked.body.includes(key), false);
  const token = unlocked.json().token;
  const downloaded = await f.post("/download", { token });
  assert.equal(downloaded.statusCode, 200, downloaded.body);
  assert.deepEqual(downloaded.rawPayload, f.bytes);
  assert.equal((await f.db("installations")).length, 0);
  const activated = await f.app.inject({ method: "POST", url: "/api/v1/tenants/primary/activate",
    payload: { key, product: "remote-content-shortcode-pro", installationId: "rcs-site-one", siteUrl: "https://wordpress.example.test" } });
  assert.equal(activated.statusCode, 200, activated.body);
  const update = await f.app.inject({ url: "/api/v1/tenants/primary/updates/remote-content-shortcode-pro", headers: { authorization: `Bearer ${activated.json().token}` } });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().version, "2.0.0");
  assert.equal((await f.app.inject({ url: `/api/v1/tenants/primary/packages/${f.releaseId}` })).statusCode, 401);
  await f.db("licenses").update({ revoked: 1 });
  assert.equal((await f.post("/download", { token })).statusCode, 403);
  assert.equal((await f.post("/unlock", { key })).statusCode, 403);
  await f.db("licenses").update({ revoked: 0, expires_at: 1 });
  assert.equal((await f.post("/download", { token })).statusCode, 403);
  await f.db("licenses").update({ expires_at: Date.now() + 86400000, key_hash: hash("replacement") });
  assert.equal((await f.post("/download", { token })).statusCode, 403);
});

test("download tickets expire, reject tampering, bind tenant/product and reject withdrawn releases", async t => {
  const f = await fixture(t), key = await f.issue();
  const token = (await f.post("/unlock", { key })).json().token;
  const ticket = unseal<Record<string, unknown>>(token, f.config.secret);
  for (const patch of [{ expiresAt: 1 }, { tenantId: "other" }, { productId: "other" }, { kind: "other" }]) {
    const bad = seal({ ...ticket, ...patch }, f.config.secret);
    assert.equal((await f.post("/download", { token: bad })).statusCode, 403);
  }
  assert.equal((await f.post("/download", { token: "corrupted-ticket" })).statusCode, 403);
  await f.db("releases").update({ withdrawn: 1 });
  assert.equal((await f.post("/download", { token })).statusCode, 404);
  assert.equal((await f.post("/unlock", { key })).statusCode, 503);
});

test("public issuance rejects unapproved origins, extra privileges, missing consent and other tenants", async t => {
  const f = await fixture(t);
  for (const headers of [{}, { origin: "https://evil.test" }, { origin: "null" }])
    assert.equal((await f.post("", { email: "pilot@example.test", consent: true }, headers as { origin: string })).statusCode, 403);
  const preflight = await f.app.inject({ method: "OPTIONS", url: base, headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], origin);
  for (const patch of [{ consent: false }, { email: "bad" }, { siteAllowance: 1000 }, { expiresAt: Date.now() + 1e12 }, { productId: f.productId }])
    assert.equal((await f.post("", { email: "pilot@example.test", consent: true, ...patch })).statusCode, 400);
  const other = await createTenant(f.db, { id: randomUUID(), slug: "other", name: "Other", exempt: 1 });
  assert.ok(other);
  assert.equal((await f.app.inject({ method: "POST", url: base.replace("primary", "other"), headers: { origin }, payload: { email: "pilot@example.test", consent: true } })).statusCode, 404);
  assert.equal((await f.db("licenses")).length, 0);
  const unrelated = await f.app.inject({ method: "OPTIONS", url: "/api/v1/tenants/primary/seller/licenses/complimentary", headers: { origin } });
  assert.equal(unrelated.headers["access-control-allow-origin"], undefined);
});

test("expired, unpublished, unavailable and capped offers fail without creating new licenses", async t => {
  const expired = await fixture(t, { expiresAt: new Date(Date.now() - 86400000).toISOString() });
  assert.equal((await expired.post("", { email: "new@example.test", consent: true })).statusCode, 410);
  const f = await fixture(t, { dailyLimit: 1 });
  await f.issue();
  assert.equal((await f.post("", { email: "second@example.test", consent: true })).statusCode, 429);
  assert.equal((await f.post("", { email: "pilot@example.test", consent: true })).statusCode, 202);
  assert.equal((await f.db("licenses")).length, 1);
  await f.db("releases").update({ withdrawn: 1 });
  assert.equal((await f.post("", { email: "third@example.test", consent: true })).statusCode, 503);
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  assert.equal((await f.post("", { email: "fourth@example.test", consent: true })).statusCode, 403);
});

test("free signup is unavailable without explicit configuration, correct products or publisher capacity; standalone works", async t => {
  const f = await fixture(t);
  await f.db("tenants").where({ id: "primary" }).update({ exempt: 0, trial_ends_at: 1, paid_through: 0 });
  assert.equal((await f.post("", { email: "new@example.test", consent: true })).statusCode, 403);
  await f.db("products").where({ id: f.productId }).update({ slug: "different-product" });
  assert.equal((await f.post("", { email: "new@example.test", consent: true })).statusCode, 503);
  delete f.config.freeLicenseOffers;
  assert.equal((await f.post("", { email: "new@example.test", consent: true })).statusCode, 404);
  const standalone = await fixture(t, {}, true);
  await standalone.issue();
  assert.equal((await standalone.db("licenses")).length, 1);
});
