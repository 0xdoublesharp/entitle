import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { csrf, hash } from "../src/crypto.ts";
import { createTenant, migrate } from "../src/db.ts";
import { csvCell } from "../src/license-management.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { isolatedDatabase } from "./helpers/database.ts";

const base = "/api/v1/tenants/primary/seller";
const day = 86400000;

async function fixture(t: TestContext) {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/license-management-",
  );
  const config = loadConfig({
    NODE_ENV: "test",
    APP_SECRET: "b1".repeat(32),
    OPERATOR_TOKEN: "operator-test-".repeat(4),
    DEPLOYMENT_MODE: "hosted",
    DATA_DIR: root,
    APP_BASE_PATH: "",
  });
  const { db, close } = await isolatedDatabase(config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    await app?.close();
    await close();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(db);
  app = await buildApp(
    config,
    db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore() },
  );
  await app.ready();
  const now = Date.now(),
    seller = randomUUID(),
    session = randomUUID();
  await db("seller_users").insert({
    id: seller,
    email: "seller@example.test",
    verified_at: now,
    created_at: now,
  });
  await db("seller_memberships").insert({
    tenant_id: "primary",
    user_id: seller,
    role: "owner",
    created_at: now,
  });
  await db("seller_sessions").insert({
    id: hash(session),
    user_id: seller,
    expires_at: now + day,
  });
  const headers = {
    cookie: `de-seller-session=${session}`,
    origin: config.origin,
    "x-csrf-token": csrf(session, config.secret),
  };
  const foreign = await createTenant(db, {
    id: "foreign",
    slug: "foreign",
    name: "Foreign",
  });
  for (const tenant_id of ["primary", foreign.id]) {
    await db("products").insert({
      tenant_id,
      id: tenant_id === "primary" ? "product" : "foreign-product",
      slug: "product",
      name: 'A "Product", Inc.',
    });
    if (tenant_id === "primary")
      await db("plans").insert({
        tenant_id,
        id: "plan",
        product_id: "product",
        name: "Standard",
        site_allowance: 4,
        stripe_price_id: "price",
      });
    await db("customers").insert({
      tenant_id,
      id: tenant_id === "primary" ? "buyer" : "foreign-buyer",
      email: "buyer@example.test",
    });
  }
  const license = {
    refund_revoked: 0,
    provenance: "paid",
    customer_id: "buyer",
    product_id: "product",
    plan_id: "plan",
    paid_through: now + day,
    billing_status: "active",
    site_allowance: 4,
  };
  const complimentary = {
    plan_id: null,
    paid_through: 0,
    billing_status: "complimentary",
    provenance: "complimentary",
    expires_at: now + 2 * day,
  };
  await db("licenses").insert([
    {
      ...license,
      tenant_id: "primary",
      id: "a-paid",
      subscription_id: "paid",
      key_hash: hash("a-paid"),
    },
    {
      ...license,
      ...complimentary,
      tenant_id: "primary",
      id: "b-complimentary",
      key_hash: hash("b-complimentary"),
      internal_note: "=SUM(1,2)\nVIP",
    },
    {
      ...license,
      tenant_id: "primary",
      id: "c-canceled",
      subscription_id: "canceled",
      key_hash: hash("c-canceled"),
      billing_status: "canceled",
      paid_through: now - day,
    },
    {
      ...license,
      tenant_id: "primary",
      id: "d-revoked",
      subscription_id: "revoked",
      key_hash: hash("d-revoked"),
      refund_revoked: 1,
      paid_through: now - day,
    },
    {
      ...license,
      ...complimentary,
      tenant_id: foreign.id,
      id: "foreign-license",
      product_id: "foreign-product",
      customer_id: "foreign-buyer",
      key_hash: hash("foreign-license"),
    },
  ]);
  await db("installations").insert(
    [
      { id: "live", site_url: "live.example.test", active: 1, exempt: 0 },
      { id: "staging", site_url: "staging.example.test", active: 1, exempt: 1 },
      {
        id: "inactive",
        site_url: "inactive.example.test",
        active: 0,
        exempt: 0,
      },
    ].map((row) => ({
      ...row,
      tenant_id: "primary",
      license_id: "a-paid",
      installation_id: row.id,
      token_hash: hash(row.id),
      token_cipher: "secret",
    })),
  );
  const key = async (scope: string) => {
    const token = `DE-TK-test-${scope}`;
    await db("tenant_api_keys").insert({
      tenant_id: "primary",
      id: randomUUID(),
      name: scope,
      key_hash: hash(token),
      scopes: JSON.stringify([scope]),
      created_at: now,
      expires_at: now + day,
      display_prefix: "DE-TK-test",
    });
    return { authorization: `Bearer ${token}` };
  };
  return { app, db, headers, key, now, seller };
}

test("seller license listing filters by entitlement and paginates matching, tenant-owned rows", async (t) => {
  const { app, db, key, now } = await fixture(t);
  const headers = await key("read");
  const get = (query: string) =>
    app.inject({ url: `${base}/licenses?${query}`, headers });
  const first = await get(
    "status=expiring&limit=1&expiringWithinDays=3&productId=product",
  );
  assert.equal(first.statusCode, 200, first.body);
  const { licenses, nextCursor } = first.json();
  assert.equal(nextCursor, "a-paid");
  assert.equal(licenses[0].active_installations, 2);
  assert.equal(licenses[0].seats_used, 1);
  assert.equal(licenses[0].plan_name, "Standard");
  assert.equal(licenses[0].entitled, true);
  assert.doesNotMatch(first.body, /key_hash|token_cipher|subscription_id/);
  const second = await get(
    `status=expiring&limit=1&expiringWithinDays=3&after=${nextCursor}`,
  );
  assert.equal(second.json().nextCursor, null);
  assert.equal(second.json().licenses[0].id, "b-complimentary");
  assert.equal(
    second.json().licenses[0].access_ends_at,
    second.json().licenses[0].expires_at,
  );
  assert.deepEqual(
    (await get("status=expired"))
      .json()
      .licenses.map((row: { id: string }) => row.id),
    ["c-canceled"],
  );
  assert.deepEqual(
    (await get("status=revoked"))
      .json()
      .licenses.map((row: { id: string }) => row.id),
    ["d-revoked"],
  );
  assert.deepEqual(
    (await get("provenance=complimentary&q=%20vip%20"))
      .json()
      .licenses.map((row: { id: string }) => row.id),
    ["b-complimentary"],
  );
  assert.equal((await get("unknown=true")).statusCode, 400);
  await db("plans").insert({
    tenant_id: "primary",
    id: "upgrade",
    product_id: "product",
    name: "Upgraded",
    site_allowance: 9,
    stripe_price_id: "price-upgrade",
  });
  await db("grants").insert({
    tenant_id: "primary",
    id: "grant",
    invoice_id: "invoice",
    license_id: "a-paid",
    plan_id: "upgrade",
    period_start: now - 1000,
    period_end: now + day,
    paid_at: now - 1000,
  });
  const upgraded = await get("q=upGRADED");
  assert.deepEqual(
    upgraded.json().licenses.map((row: { id: string }) => row.id),
    ["a-paid"],
  );
  assert.equal(upgraded.json().licenses[0].site_allowance, 9);
  assert.equal(upgraded.json().licenses[0].plan_id, "upgrade");
  const analytics = await app.inject({ url: `${base}/analytics`, headers });
  assert.equal(analytics.statusCode, 200, analytics.body);
  assert.ok(analytics.json().generatedAt >= now);
  assert.equal(analytics.json().retention.complimentaryActive, 1);
});

test("CSV neutralizes all formula prefixes and preserves numeric values", () => {
  for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
    const safe = "'" + prefix + "cell";
    assert.equal(
      csvCell(prefix + "cell"),
      prefix === "\r" ? `"${safe}"` : safe,
    );
  }
  assert.equal(csvCell(-1), "-1");
});

test("exports require data scope and escape CSV for spreadsheets", async (t) => {
  const { app, headers, key } = await fixture(t);
  const url = `${base}/licenses/export`;
  assert.equal(
    (await app.inject({ url, headers: await key("read") })).statusCode,
    403,
  );
  const csv = await app.inject({
    url: `${url}?format=csv&provenance=complimentary`,
    headers,
  });
  assert.equal(csv.statusCode, 200, csv.body);
  assert.equal(csv.headers["cache-control"], "no-store");
  assert.equal(
    csv.headers["content-disposition"],
    'attachment; filename="licenses-export.csv"',
  );
  assert.match(
    csv.body,
    /b-complimentary,buyer@example\.test,"A ""Product"", Inc\.",Complimentary,/,
  );
  assert.match(csv.body, /"'=SUM\(1,2\)\nVIP"/);
  assert.doesNotMatch(csv.body, /foreign-license|key_hash/);
  const json = await app.inject({
    url: `${url}?format=json&limit=1`,
    headers: await key("data:export"),
  });
  assert.equal(json.statusCode, 200, json.body);
  assert.equal(json.headers["cache-control"], "no-store");
  assert.equal(json.json().count, 4);
});

test("support updates validate scope, keep paid rights immutable and record complimentary renewal atomically", async (t) => {
  const { app, db, headers, key, now, seller } = await fixture(t);
  const reader = await key("read"),
    writer = await key("licenses:write");
  const patch = (
    id: string,
    payload: object,
    auth: Record<string, string> = headers,
  ) =>
    app.inject({
      method: "PATCH",
      url: `${base}/licenses/${id}`,
      headers: auth,
      payload,
    });
  assert.equal(
    (await patch("a-paid", { internalNote: "support" }, reader)).statusCode,
    403,
  );
  assert.equal(
    (await patch("a-paid", { siteAllowance: 8 }, writer)).json().error.code,
    "paid_license_immutable",
  );
  assert.equal(
    (await patch("b-complimentary", { expiresAt: now - 1 })).json().error.code,
    "invalid_expiration",
  );
  assert.equal((await patch("b-complimentary", {})).statusCode, 400);
  assert.equal(
    (await patch("foreign-license", { internalNote: "cross-tenant" }))
      .statusCode,
    404,
  );
  const paid = await patch("a-paid", { internalNote: "  support  " }, writer);
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().internal_note, "support");
  const expiresAt = now + 4 * day;
  const updated = await patch("b-complimentary", {
    expiresAt,
    siteAllowance: 8,
    internalNote: null,
  });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.equal(updated.json().access_ends_at, expiresAt);
  assert.equal(updated.json().site_allowance, 8);
  assert.equal(updated.json().internal_note, null);
  assert.equal((await patch("b-complimentary", { expiresAt })).statusCode, 200);
  assert.equal(
    (await db("licenses").where({ id: "b-complimentary" }).first())
      .lock_version,
    2,
  );
  const events = await db("business_events").where({ type: "license.renewed" });
  assert.deepEqual(
    events.map((row) => row.resource_id),
    ["b-complimentary"],
  );
  const audit = await db("audit_events").where({ action: "license.updated" });
  assert.equal(audit.length, 3);
  assert.ok(
    audit.some((row) => row.actor_type === "seller" && row.actor_id === seller),
  );
  assert.ok(audit.some((row) => row.actor_type === "api_key"));
  assert.doesNotMatch(
    JSON.stringify(audit),
    /buyer@example\.test|support|SUM|key_hash/,
  );
});
