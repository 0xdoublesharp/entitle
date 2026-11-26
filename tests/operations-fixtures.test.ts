import { mkdtemp, rm } from "node:fs/promises";
import { createTenant, migrate, type DB, type Tenant } from "../src/db.ts";
import { isolatedDatabase } from "./helpers/database.ts";

export async function operationsFixture(run: (db: DB, tenant: Tenant, other: Tenant) => Promise<void>) {
  const directory = await mkdtemp("/Volumes/Scratch/entitle/tmp/operations-case-");
  const { db, close } = await isolatedDatabase(`sqlite:${directory}/db`);
  try {
    await migrate(db);
    const tenant = await createTenant(db, { id: "operations-a", slug: "operations-a", name: "A", trial_ends_at: Number.MAX_SAFE_INTEGER });
    const other = await createTenant(db, { id: "operations-b", slug: "operations-b", name: "B", trial_ends_at: Number.MAX_SAFE_INTEGER });
    await run(db, tenant, other);
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
}
export async function seedOperationLicense(db: DB, tenant: Tenant, now = 1800000000000) {
  const prefix = tenant.id;
  await db("products").insert({ tenant_id: prefix, id: `${prefix}-product`, slug: "product", name: "Product" });
  await db("plans").insert({ tenant_id: prefix, id: `${prefix}-plan`, product_id: `${prefix}-product`, name: "Plan", site_allowance: 1, stripe_price_id: "price" });
  await db("customers").insert({ tenant_id: prefix, id: `${prefix}-customer`, email: "buyer@example.test", stripe_id: "customer" });
  await db("licenses").insert({ tenant_id: prefix, id: `${prefix}-license`, customer_id: `${prefix}-customer`, product_id: `${prefix}-product`, plan_id: `${prefix}-plan`, paid_through: now + 86400000, site_allowance: 1, billing_status: "active", subscription_id: "subscription", key_hash: "a".repeat(64) });
  await db("releases").insert({ tenant_id: prefix, id: `${prefix}-release`, product_id: `${prefix}-product`, version: "1.0.0", changelog: "", published_at: now, checksum: "a".repeat(64), size: 100, min_wp: "6", min_php: "8", min_free: "0", tested: "7" });
  return { license: `${prefix}-license`, customer: `${prefix}-customer`, release: `${prefix}-release` };
}

