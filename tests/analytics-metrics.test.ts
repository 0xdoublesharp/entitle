import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import assert from "node:assert/strict";
import { createTenant, migrate } from "../src/db.ts";
import { tenantAnalytics, tenantMetrics } from "../src/metrics.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { primaryTenant } from "./helpers/tenant.ts";

test("tenant metrics include recurring revenue, retention and per-product license and seat usage", async (t) => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/license-analytics-");
  const { db, close } = await isolatedDatabase(`sqlite:${root}/db`);
  t.after(async () => {
    await close();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(db);
  const { id: tenant_id } = primaryTenant,
    now = Date.now(),
    day = 86400000;
  await createTenant(db, { id: "foreign", slug: "foreign", name: "Foreign" });
  await db("products").insert([
    { tenant_id, id: "z", slug: "z", name: "Alpha" },
    { tenant_id, id: "a", slug: "a", name: "Zeta" },
    { tenant_id: "foreign", id: "foreign-product", slug: "z", name: "Foreign" },
  ]);
  await db("customers").insert([
    { tenant_id, id: "buyer", email: "buyer@example.test" },
    { tenant_id: "foreign", id: "foreign-buyer", email: "buyer@example.test" },
  ]);
  await db("plans").insert(
    [
      {
        id: "monthly",
        unit_amount: 203,
        currency: "usd",
        billing_interval: "month",
      },
      {
        id: "annual",
        unit_amount: 1005,
        currency: "eur",
        billing_interval: null,
      },
      {
        id: "lifetime-plan",
        unit_amount: 5000,
        currency: "usd",
        billing_interval: "lifetime",
      },
    ].map((row) => ({
      ...row,
      tenant_id,
      product_id: "z",
      name: row.id,
      site_allowance: 4,
      stripe_price_id: row.id,
    })),
  );
  const base = {
    revoked: 0,
    refund_revoked: 0,
    suspended: 0,
    provenance: "paid",
    tenant_id,
    customer_id: "buyer",
    product_id: "z",
    plan_id: "monthly",
    paid_through: now + day,
    billing_status: "active",
    site_allowance: 4,
  };
  await db("licenses").insert(
    [
      { id: "monthly" },
      {
        id: "annual",
        billing_status: "trialing",
        plan_id: "annual",
        paid_through: now + 60 * day,
      },
      {
        id: "lifetime",
        billing_status: "lifetime",
        plan_id: "lifetime-plan",
        paid_through: Number.MAX_SAFE_INTEGER,
      },
      { id: "canceled", billing_status: "canceled" },
      { id: "expired", paid_through: now },
      { id: "revoked", revoked: 1 },
      { id: "suspended", suspended: 1 },
      { id: "refund", refund_revoked: 1 },
      {
        id: "comp",
        plan_id: null,
        provenance: "complimentary",
        billing_status: "complimentary",
        paid_through: 0,
        expires_at: now + day,
      },
      {
        id: "foreign-license",
        tenant_id: "foreign",
        product_id: "foreign-product",
        customer_id: "foreign-buyer",
        plan_id: null,
      },
    ].map((row) => ({
      ...base,
      ...row,
      key_hash: row.id,
      subscription_id: row.id === "comp" ? null : row.id,
    })),
  );
  await db("installations").insert(
    [
      {
        id: "production",
        site_url: "production.example.test",
        active: 1,
        exempt: 1,
      },
      { id: "staging", site_url: "staging.example.test", active: 1, exempt: 0 },
      {
        id: "inactive",
        site_url: "inactive.example.test",
        active: 0,
        exempt: 0,
      },
    ].map((row) => ({
      ...row,
      tenant_id,
      license_id: "monthly",
      installation_id: row.id,
      token_hash: row.id,
      token_cipher: "secret",
    })),
  );
  const metrics = await tenantMetrics(db, primaryTenant, now, [
    "staging.example.test",
  ]);
  assert.deepEqual(metrics.seats, { used: 1, allowance: 20, available: 19 });
  assert.deepEqual(metrics.analytics, {
    recurringByCurrency: [
      {
        currency: "eur",
        mrrMinor: "84",
        arrMinor: "1005",
        activeSubscriptions: 1,
      },
      {
        currency: "usd",
        mrrMinor: "203",
        arrMinor: "2436",
        activeSubscriptions: 1,
      },
    ],
    retention: {
      activeSubscriptions: 2,
      canceledPendingExpiry: 1,
      expiredLicenses: 1,
      expiringIn30Days: 3,
      lifetimeLicenses: 1,
      complimentaryActive: 1,
    },
    byProduct: [
      {
        productId: "z",
        productName: "Alpha",
        activeLicenses: 5,
        expiredLicenses: 1,
        lifetimeLicenses: 1,
        activeInstallations: 2,
        seatsUsed: 1,
        seatAllowance: 20,
      },
      {
        productId: "a",
        productName: "Zeta",
        activeLicenses: 0,
        expiredLicenses: 0,
        lifetimeLicenses: 0,
        activeInstallations: 0,
        seatsUsed: 0,
        seatAllowance: 0,
      },
    ],
  });
  assert.deepEqual(
    await tenantAnalytics(db, primaryTenant, now, ["staging.example.test"]),
    metrics.analytics,
  );
});
