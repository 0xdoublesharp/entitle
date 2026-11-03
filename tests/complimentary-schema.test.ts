import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createTenant, migrate, type DB } from "../src/db.ts";
import { isolatedDatabase } from "./helpers/database.ts";

const predecessors = [
  "001_initial",
  "002_plugin_identity",
  "003_tenants",
  "004_stripe_status",
  "005_security",
  "006_checkout",
  "007_frameworks",
  "008_commerce",
  "009_accounts",
  "010_operations",
  "011_sandboxes",
  "012_business_events",
  "013_platform_price_history",
];
async function fixture(run: (db: DB) => Promise<void>) {
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/complimentary-schema-",
  );
  const database = await isolatedDatabase(`sqlite:${directory}/db`);
  try {
    await database.db.migrate.latest({
      migrationSource: {
        getMigrations: async () => predecessors,
        getMigrationName: (name: string) => name,
        getMigration: async (name: string) =>
          import(`../src/migrations/${name}.ts`),
      },
    });
    await run(database.db);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function seedPaid(db: DB) {
  await db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Paid",
    site_allowance: 1,
    stripe_price_id: "price_paid",
  });
  await db("customers").insert({
    tenant_id: "primary",
    id: "customer",
    email: "customer@example.test",
    stripe_id: "cus_paid",
  });
  await db("licenses").insert({
    tenant_id: "primary",
    id: "paid",
    product_id: "product",
    plan_id: "plan",
    customer_id: "customer",
    subscription_id: "sub_paid",
    key_hash: "1".repeat(64),
    site_allowance: 1,
    paid_through: 2000000000000,
    billing_status: "active",
  });
  await db("grants").insert({
    tenant_id: "primary",
    id: "grant",
    license_id: "paid",
    plan_id: "plan",
    invoice_id: "in_paid",
    period_start: 1,
    period_end: 2000000000000,
    paid_at: 1,
  });
  await db("installations").insert({
    tenant_id: "primary",
    id: "installation",
    license_id: "paid",
    installation_id: "site",
    site_url: "example.test",
    active: 1,
    exempt: 0,
    token_hash: "2".repeat(64),
    token_cipher: "encrypted",
  });
  await db("emails").insert({
    tenant_id: "primary",
    id: "email",
    customer_id: "customer",
    license_id: "paid",
    kind: "license_key",
    payload: "encrypted",
    created_at: 1,
  });
}

test("complimentary migration rejects a preexisting nonunique request index", async () => fixture(async (db) => {
  await migrate(db);
  await db.raw("DROP INDEX licenses_complimentary_request_unique");
  await db.raw("CREATE INDEX licenses_complimentary_request_unique ON licenses(tenant_id, complimentary_request_id)");
  const { up } = await import("../src/migrations/014_complimentary_licenses.ts");
  await assert.rejects(up(db), /Complimentary issuance request constraint mismatch/);
}));

test("complimentary migration preserves paid licenses and dependent rows, accepts provider-free licenses and enforces workspace request uniqueness", async () =>
  fixture(async (db) => {
    await seedPaid(db);
    const paid = await db("licenses").where({ id: "paid" }).first();
    await migrate(db);
    assert.equal(await db.schema.hasColumn("licenses", "provenance"), true);
    const migrated = await db("licenses").where({ id: "paid" }).first();
    for (const [key, value] of Object.entries(paid))
      assert.equal(migrated[key], value, key);
    assert.equal(migrated.provenance, "paid");
    assert.equal(migrated.expires_at, null);
    for (const table of ["grants", "installations", "emails"])
      assert.equal((await db(table)).length, 1, table);
    const complimentary = {
      tenant_id: "primary",
      id: "comp",
      product_id: "product",
      plan_id: null,
      customer_id: "customer",
      subscription_id: null,
      key_hash: "3".repeat(64),
      site_allowance: 3,
      paid_through: 0,
      billing_status: "complimentary",
      provenance: "complimentary",
      expires_at: 2000000000000,
      complimentary_request_id: "request",
      complimentary_request_hash: "4".repeat(64),
      issued_by: "seller",
      issued_at: 1,
      internal_note: "Pilot",
    };
    await db("licenses").insert(complimentary);
    await db("licenses").insert({
      ...complimentary,
      id: "comp-two",
      key_hash: "5".repeat(64),
      complimentary_request_id: "request-two",
    });
    await assert.rejects(
      db("licenses").insert({
        ...complimentary,
        id: "duplicate-request",
        key_hash: "6".repeat(64),
      }),
    );
    await assert.rejects(
      db("licenses").insert({
        ...complimentary,
        id: "orphan",
        key_hash: "7".repeat(64),
        complimentary_request_id: "orphan",
        product_id: "missing",
      }),
    );
    await createTenant(db, { id: "other", slug: "other", name: "Other" });
    await db("products").insert({
      tenant_id: "other",
      id: "other-product",
      slug: "product",
      name: "Product",
    });
    await db("customers").insert({
      tenant_id: "other",
      id: "other-customer",
      email: "customer@example.test",
    });
    await db("licenses").insert({
      ...complimentary,
      tenant_id: "other",
      id: "other-license",
      customer_id: "other-customer",
      product_id: "other-product",
    });
    await assert.rejects(
      db("licenses").insert({
        ...complimentary,
        tenant_id: "other",
        id: "cross-workspace",
        product_id: "other-product",
        key_hash: "8".repeat(64),
        complimentary_request_id: "cross",
      }),
    );
    await assert.rejects(
      db("licenses").insert({
        ...paid,
        id: "duplicate-subscription",
        key_hash: "9".repeat(64),
      }),
    );
    const { up, down } =
      await import("../src/migrations/014_complimentary_licenses.ts");
    await up(db);
    await up(db);
    await migrate(db);
    assert.equal((await db("licenses")).length, 4);
    assert.equal((await db("installations").first()).license_id, "paid");
    await assert.rejects(db("licenses").where({ id: "paid" }).delete());
    await assert.rejects(down(), /Restore a backup/);
    if (db.client.config.client === "better-sqlite3") {
      assert.deepEqual(await db.raw("PRAGMA foreign_key_check"), []);
      assert.equal((await db.raw("PRAGMA foreign_keys"))[0].foreign_keys, 1);
    }
  }));

test("complimentary MySQL upgrade resumes committed column and index DDL without losing paid rights", async (t) =>
  fixture(async (db) => {
    if (db.client.config.client !== "mysql2") {
      t.skip("Requires a real MySQL fixture");
      return;
    }
    await seedPaid(db);
    const { up } =
      await import("../src/migrations/014_complimentary_licenses.ts");
    const interruptColumn = (_result: unknown, query: { sql: string }) => {
      if (query.sql.startsWith("alter table `licenses` add `provenance`"))
        throw Error("Interrupted after complimentary provenance DDL");
    };
    db.on("query-response", interruptColumn);
    try {
      await assert.rejects(
        up(db),
        /Interrupted after complimentary provenance DDL/,
      );
    } finally {
      db.off("query-response", interruptColumn);
    }
    assert.equal(await db.schema.hasColumn("licenses", "provenance"), true);
    const interruptIndex = (_result: unknown, query: { sql: string }) => {
      if (query.sql.startsWith("alter table `licenses` add unique"))
        throw Error("Interrupted after complimentary index DDL");
    };
    db.on("query-response", interruptIndex);
    try {
      await assert.rejects(up(db), /Interrupted after complimentary index DDL/);
    } finally {
      db.off("query-response", interruptIndex);
    }
    await up(db);
    await migrate(db);
    assert.equal((await db("licenses").first()).subscription_id, "sub_paid");
    assert.equal((await db("licenses").first()).provenance, "paid");
    assert.equal((await db("installations").first()).license_id, "paid");
    await assert.rejects(db("licenses").where({ id: "paid" }).delete());
  }));

test("complimentary SQLite upgrade rolls back interrupted rebuilding and restores foreign key enforcement", async (t) =>
  fixture(async (db) => {
    if (db.client.config.client !== "better-sqlite3") {
      t.skip("Requires a real SQLite fixture");
      return;
    }
    await seedPaid(db);
    const { up } =
      await import("../src/migrations/014_complimentary_licenses.ts");
    const interrupt = (_result: unknown, query: { sql: string }) => {
      if (
        query.sql.startsWith("alter table `licenses` add column `provenance`")
      )
        throw Error("Interrupted complimentary SQLite upgrade");
    };
    db.on("query-response", interrupt);
    try {
      await assert.rejects(up(db), /Interrupted complimentary SQLite upgrade/);
    } finally {
      db.off("query-response", interrupt);
    }
    assert.equal((await db("licenses").first()).subscription_id, "sub_paid");
    assert.equal((await db("installations").first()).license_id, "paid");
    assert.equal((await db("licenses").columnInfo()).plan_id!.nullable, false);
    assert.equal(await db.schema.hasColumn("licenses", "provenance"), false);
    assert.equal((await db.raw("PRAGMA foreign_keys"))[0].foreign_keys, 1);
    await assert.rejects(db("licenses").where({ id: "paid" }).delete());
    await up(db);
    assert.equal((await db("licenses").columnInfo()).plan_id!.nullable, true);
  }));
