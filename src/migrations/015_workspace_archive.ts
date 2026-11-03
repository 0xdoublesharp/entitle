import type { Knex } from "knex";

// One additive DDL statement; safe to replay after MySQL commits it separately.
export const config = { transaction: false };
export async function up(db: Knex) {
  if (!(await db.schema.hasColumn("tenants", "archived_at")))
    await db.schema.alterTable("tenants", (t) => {
      t.double("archived_at").nullable();
    });
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
