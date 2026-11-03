import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createDb, migrate, tables, type DB } from "../src/db.ts";
import { randomUUID } from "node:crypto";
import { down } from "../src/migrations/001_initial.ts";
import { down as downIdentity } from "../src/migrations/002_plugin_identity.ts";

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
