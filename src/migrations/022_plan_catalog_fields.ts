import type { Knex } from "knex";

export const config = { transaction: false };

export async function up(db: Knex) {
  const columns = {
    unit_amount: (t: Knex.CreateTableBuilder) =>
      t.integer("unit_amount").nullable(),
    currency: (t: Knex.CreateTableBuilder) => t.string("currency", 3).nullable(),
    billing_interval: (t: Knex.CreateTableBuilder) =>
      t.string("billing_interval", 16).nullable(),
    archived_at: (t: Knex.CreateTableBuilder) =>
      t.double("archived_at").nullable(),
  };
  for (const [column, add] of Object.entries(columns)) {
    if (await db.schema.hasColumn("plans", column)) continue;
    await db.schema.alterTable("plans", add);
  }
}

export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
