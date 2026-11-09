import type { Knex } from "knex";

export const config = { transaction: false };
const index = "grants_worker_license_order";
export async function up(db: Knex) {
  // SQLite cannot interrupt synchronous SQL. Both the cardinality preflight
  // and the ordered apply read must seek directly to the requested license.
  if (db.client.config.client === "mysql2") {
    const exists = await db("information_schema.STATISTICS")
      .where("TABLE_SCHEMA", db.raw("database()"))
      .where({ TABLE_NAME: "grants", INDEX_NAME: index }).first();
    if (exists) return;
    await db.schema.alterTable("grants", (table) => {
      table.index(["tenant_id", "license_id", "period_start", "paid_at", "id"], index);
    });
  } else {
    await db.raw("CREATE INDEX IF NOT EXISTS ?? ON ?? (??, ??, ??, ??, ??)",
      [index, "grants", "tenant_id", "license_id", "period_start", "paid_at", "id"]);
  }
}

export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
