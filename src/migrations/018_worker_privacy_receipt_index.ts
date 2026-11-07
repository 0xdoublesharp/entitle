import type { Knex } from "knex";

export const config = { transaction: false };
const index = "privacy_receipts_worker_scope";
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") {
    const exists = await db("information_schema.STATISTICS")
      .where("TABLE_SCHEMA", db.raw("database()"))
      .where({ TABLE_NAME: "account_privacy_receipts", INDEX_NAME: index }).first();
    if (exists) return;
    await db.schema.alterTable("account_privacy_receipts", (table) => {
      table.index(["tenant_id", "customer_id", "request_id", "id"], index);
    });
  } else {
    await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??, ??, ??)",
      [index, "account_privacy_receipts", "tenant_id", "customer_id", "request_id", "id"]);
  }
}

export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
