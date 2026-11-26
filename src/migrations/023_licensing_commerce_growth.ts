import type { Knex } from "knex";

export const config = { transaction: false };

export async function up(db: Knex) {
  if (!(await db.schema.hasColumn("tenants", "allow_promotion_codes")))
    await db.schema.alterTable("tenants", (t) => {
      t.integer("allow_promotion_codes").notNullable().defaultTo(0);
    });
  if (!(await db.schema.hasColumn("licenses", "one_time_payment_id")))
    await db.schema.alterTable("licenses", (t) => {
      t.string("one_time_payment_id", 150).nullable();
    });
  const indexName = "licenses_tenant_one_time_payment_idx";
  if (db.client.config.client === "mysql2") {
    const index = await db("information_schema.STATISTICS")
      .where("TABLE_SCHEMA", db.raw("database()"))
      .where({ TABLE_NAME: "licenses", INDEX_NAME: indexName })
      .first("INDEX_NAME");
    if (!index)
      await db.schema.alterTable("licenses", (t) => {
        t.unique(["tenant_id", "one_time_payment_id"], { indexName });
      });
  } else {
    await db.raw("CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??, ??)", [
      indexName,
      "licenses",
      "tenant_id",
      "one_time_payment_id",
    ]);
  }
}

export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
