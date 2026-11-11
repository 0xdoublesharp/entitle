import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createDb, migrate, tables, type DB } from "../src/db.ts";
import { randomUUID } from "node:crypto";
import { down } from "../src/migrations/001_initial.ts";
import { down as downIdentity } from "../src/migrations/002_plugin_identity.ts";
import { up as workerGrantIndex } from "../src/migrations/017_worker_grant_index.ts";
import { up as workerPrivacyReceiptIndex } from "../src/migrations/018_worker_privacy_receipt_index.ts";

test("worker privacy metadata seeks bounded tenant and exact closure receipt prefixes", async () => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/worker-privacy-index-");
  const db = createDb(`sqlite:${root}/db`);
  try {
    await db.schema.createTable("account_privacy_receipts", (table) => {
      table.string("id").primary();
      for (const name of ["tenant_id", "customer_id", "request_id"]) table.string(name).notNullable();
      table.text("details").notNullable();
    });
    await db.batchInsert("account_privacy_receipts", Array.from({ length: 1004 }, (_, i) => ({
      id: `receipt_${i}`, tenant_id: i < 1001 ? "foreign" : "target", customer_id: "customer", request_id: "request", details: "{}",
    })), 100);
    const query = () => db("account_privacy_receipts").where({ tenant_id: "target" })
      .select("id", db.raw("octet_length(details) as bytes")).limit(4);
    const plan = async (builder: ReturnType<typeof query>) => {
      const sql = builder.toSQL();
      const rows = await db.raw(`EXPLAIN QUERY PLAN ${sql.sql}`, sql.bindings);
      return rows.map((row: { detail: string }) => row.detail).join("\n");
    };
    assert.match(await plan(query()), /SCAN account_privacy_receipts/);
    await workerPrivacyReceiptIndex(db);
    await workerPrivacyReceiptIndex(db);
    assert.match(await plan(query()), /SEARCH account_privacy_receipts USING INDEX privacy_receipts_worker_scope \(tenant_id=\?\)/);
    assert.match(await plan(query().where({ customer_id: "customer", request_id: "request" })),
      /privacy_receipts_worker_scope \(tenant_id=\? AND customer_id=\? AND request_id=\?\)/);
    assert.equal((await query()).length, 3);
    assert.equal((await db("account_privacy_receipts").count({ count: "*" }).first())?.count, 1004);
  } finally {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker grant reads seek to one license without scanning unrelated grants or sorting its entire history", async () => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/worker-grant-index-");
  const db = createDb(`sqlite:${root}/db`);
  try {
    await db.schema.createTable("grants", (table) => {
      for (const name of ["tenant_id", "id", "license_id"]) table.string(name).notNullable();
      for (const name of ["period_start", "period_end", "paid_at"]) table.double(name).notNullable();
      table.primary(["tenant_id", "id"]);
    });
    await db.batchInsert("grants", Array.from({ length: 403 }, (_, i) => ({
      tenant_id: "tenant", id: String(i), license_id: i < 400 ? `unrelated_${i}` : "target",
      period_start: i, period_end: i + 1, paid_at: i,
    })), 100);
    const query = () => db("grants").where({ tenant_id: "tenant", license_id: "target" })
      .orderBy("period_start", "desc").orderBy("paid_at", "desc").orderBy("id", "desc").limit(4);
    const plan = async (builder: ReturnType<typeof query>) => {
      const sql = builder.toSQL();
      const rows = await db.raw(`EXPLAIN QUERY PLAN ${sql.sql}`, sql.bindings);
      return rows.map((row: { detail: string }) => row.detail).join("\n");
    };
    assert.match(await plan(query()), /TEMP B-TREE/, "the old index needs an unbounded sort");
    await workerGrantIndex(db);
    await workerGrantIndex(db);
    const ordered = await plan(query());
    assert.match(ordered, /SEARCH grants USING INDEX grants_worker_license_order \(tenant_id=\? AND license_id=\?\)/);
    assert.doesNotMatch(ordered, /TEMP B-TREE/);
    const preflight = await plan(query().clearOrder().clearSelect().select(db.raw("1 as worker_record")));
    assert.match(preflight, /COVERING INDEX grants_worker_license_order/);
    assert.deepEqual((await query()).map((row) => row.id), ["402", "401", "400"]);
  } finally {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test("database URLs select the actual dialect, and generated SQL uses that engine quoting", async () => {
  for (const [url, client, quote] of [
    ["postgresql://fixture:fixture@127.0.0.1/fixture", "pg", '"'],
    ["mysql://fixture:fixture@127.0.0.1/fixture", "mysql2", "`"],
  ]) {
    const db = createDb(url!);
    try {
      assert.equal(db.client.config.client, client);
      assert.match(
        db("licenses").where({ id: "license" }).toSQL().sql,
        new RegExp(`${quote}licenses${quote}`),
      );
    } finally {
      await db.destroy();
    }
  }
});
test("SQLite migration preserves constraints and reruns without deleting records; destructive rollback is refused", async () => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/migrations-");
  const db = createDb(`sqlite:${root}/database.sqlite`);
  try {
    await migrate(db);
    await db("products").insert({
      tenant_id: "primary",
      id: "prod",
      slug: "product",
      name: "Product",
    });
    assert.equal((await db("products").first()).plugin_basename, null);
    await db("products")
      .where({ id: "prod" })
      .update({ plugin_basename: "product/bootstrap.php" });
    await migrate(db);
    assert.equal((await db("products")).length, 1);
    assert.equal(
      (await db("products").first()).plugin_basename,
      "product/bootstrap.php",
    );
    assert.deepEqual(await db("knex_migrations").orderBy("id").pluck("name"), [
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
      "014_complimentary_licenses",
      "015_workspace_archive",
      "016_worker_continuations",
      "017_worker_grant_index",
      "018_worker_privacy_receipt_index",
      "019_oidc_publishing",
      "020_strong_reauthentication",
      "021_auth_capabilities",
    ]);
    await assert.rejects(
      db("plans").insert({
        tenant_id: "primary",
        id: "orphan",
        product_id: "missing",
        name: "Plan",
        site_allowance: 1,
        stripe_price_id: "price_missing",
      }),
      /FOREIGN KEY/,
    );
    await assert.rejects(down(), /Restore a backup/);
    await assert.rejects(downIdentity(), /Restore a backup/);
    assert.equal((await db("products")).length, 1);
  } finally {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "real MySQL migration preserves Unicode, case-sensitive provider IDs, constraints and rerun state",
  {
    skip: process.env.TEST_MYSQL_DATABASE_URL
      ? false
      : "Set TEST_MYSQL_DATABASE_URL to exercise the real MySQL migration.",
  },
  async () => {
    const connection = new URL(process.env.TEST_MYSQL_DATABASE_URL!);
    assert.equal(connection.protocol, "mysql:");
    const databaseName =
      "entitle_migration_" + randomUUID().replaceAll("-", "");
    const adminConnection = new URL(connection);
    adminConnection.pathname = "/mysql";
    const admin = createDb(adminConnection.href);
    let database: DB | undefined;
    let created = false;
    try {
      // A case-insensitive database default makes the migration's per-table
      // binary collation observable rather than inheriting the desired result.
      await admin.raw(
        "CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci",
        [databaseName],
      );
      created = true;
      connection.pathname = "/" + databaseName;
      database = createDb(connection.href);
      await migrate(database);
      const collations = await database("information_schema.tables")
        .select({ name: "TABLE_NAME", collation: "TABLE_COLLATION" })
        .where({ TABLE_SCHEMA: databaseName })
        .whereIn("TABLE_NAME", ["locks", "tenants", ...tables]);
      assert.equal(collations.length, tables.length + 2);
      for (const table of collations)
        assert.equal(table.collation, "utf8mb4_bin", table.name);
      assert.deepEqual(await database("locks").orderBy("id").pluck("id"), [
        "auth",
        "billing",
        "email",
        "primary:auth",
        "primary:billing",
        "primary:email",
        "primary:schema",
        "primary:work",
        "schema",
        "work",
      ]);
      await database("products").insert({
        tenant_id: "primary",
        id: "product",
        slug: "unicode-pro",
        name: "Pro 🎹",
      });
      await database("plans").insert([
        {
          tenant_id: "primary",
          id: "upper",
          product_id: "product",
          name: "Upper provider ID",
          site_allowance: 1,
          stripe_price_id: "price_Case",
        },
        {
          tenant_id: "primary",
          id: "lower",
          product_id: "product",
          name: "Lower provider ID",
          site_allowance: 5,
          stripe_price_id: "price_case",
        },
      ]);
      assert.equal(
        (await database("plans")).length,
        2,
        "Provider IDs with distinct case must remain distinct.",
      );
      await assert.rejects(
        database("plans").insert({
          tenant_id: "primary",
          id: "duplicate",
          product_id: "product",
          name: "Duplicate",
          site_allowance: 1,
          stripe_price_id: "price_Case",
        }),
        { code: "ER_DUP_ENTRY" },
      );
      await assert.rejects(
        database("plans").insert({
          tenant_id: "primary",
          id: "orphan",
          product_id: "missing",
          name: "Orphan",
          site_allowance: 1,
          stripe_price_id: "price_orphan",
        }),
        { code: "ER_NO_REFERENCED_ROW_2" },
      );
      await migrate(database);
      assert.equal(
        (await database("products").where({ id: "product" }).first()).name,
        "Pro 🎹",
      );
      assert.equal((await database("plans")).length, 2);
      assert.deepEqual(await database("knex_migrations").select("name"), [
        { name: "001_initial" },
        { name: "002_plugin_identity" },
        { name: "003_tenants" },
        { name: "004_stripe_status" },
        { name: "005_security" },
        { name: "006_checkout" },
        { name: "007_frameworks" },
        { name: "008_commerce" },
        { name: "009_accounts" },
        { name: "010_operations" },
        { name: "011_sandboxes" },
        { name: "012_business_events" },
        { name: "013_platform_price_history" },
        { name: "014_complimentary_licenses" },
        { name: "015_workspace_archive" },
        { name: "016_worker_continuations" },
        { name: "017_worker_grant_index" },
        { name: "018_worker_privacy_receipt_index" },
        { name: "019_oidc_publishing" },
        { name: "020_strong_reauthentication" },
        { name: "021_auth_capabilities" },
      ]);
    } finally {
      try {
        await database?.destroy();
        if (created) await admin.raw("DROP DATABASE ??", [databaseName]);
      } finally {
        await admin.destroy();
      }
    }
  },
);

test("migration002 upgrades existing products without changing original migration data", async () => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/migration-upgrade-");
  const db = createDb(`sqlite:${root}/db`);
  try {
    await db.migrate.latest({
      migrationSource: {
        getMigrations: async () => ["001_initial"],
        getMigrationName: (name: string) => name,
        getMigration: async () => import("../src/migrations/001_initial.ts"),
      },
    });
    await db("products").insert({
      id: "legacy",
      slug: "legacy",
      name: "Legacy",
    });
    await migrate(db);
    assert.deepEqual(await db("knex_migrations").orderBy("id").pluck("name"), [
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
      "014_complimentary_licenses",
      "015_workspace_archive",
      "016_worker_continuations",
      "017_worker_grant_index",
      "018_worker_privacy_receipt_index",
      "019_oidc_publishing",
      "020_strong_reauthentication",
      "021_auth_capabilities",
    ]);
    assert.equal(
      (await db("products").where({ id: "legacy" }).first()).plugin_basename,
      null,
    );
    await db("products")
      .where({ id: "legacy" })
      .update({ plugin_basename: "legacy/bootstrap.php" });
    await migrate(db);
    assert.equal(
      (await db("products").where({ id: "legacy" }).first()).plugin_basename,
      "legacy/bootstrap.php",
    );
  } finally {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  }
});
