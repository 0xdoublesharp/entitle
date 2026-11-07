import type { Knex } from "knex";

export async function up(db: Knex) {
  for (const name of ["worker_continuations", "worker_continuation_facts"]) {
    if (await db.schema.hasTable(name)) continue;
    await db.schema.createTable(name, (table) => {
      if (db.client.config.client === "mysql2") {
        table.charset("utf8mb4");
        table.collate("utf8mb4_bin");
      }
      table.string("scope", 64).notNullable();
      table.string("slot", 64).notNullable();
      table.text("payload", "mediumtext").notNullable();
      if (name === "worker_continuations") {
        table.double("updated_at").notNullable();
        table.integer("completed").notNullable().defaultTo(0);
        table.string("lease_owner", 64).nullable();
        table.primary(["scope", "slot"]);
      } else {
        table.string("kind", 32).notNullable();
        table.string("id", 150).notNullable();
        table.double("position").notNullable();
        table.primary(["scope", "slot", "kind", "id"]);
      }
    });
  }
}

export async function down(): Promise<void> {
  throw Error("Worker checkpoint rollback requires restoring a matching backup");
}
