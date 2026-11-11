import type { Knex } from "knex";

export const config = { transaction: false };
export async function up(db: Knex) {
  const columns: Record<string, Record<string, "integer" | "time" | "text">> = {
    seller_users: {
      security_generation: "integer",
      recovered_ordinary: "integer",
      privileged_suspended: "integer",
    },
    seller_sessions: {
      auth_generation: "integer",
      auth_method: "text",
      auth_factor_id: "text",
      auth_verified_at: "time",
      recovery_id: "text",
      created_at: "time",
    },
    seller_factors: {
      provenance: "text",
      recovery_id: "text",
      backup_eligible: "integer",
      backed_up: "integer",
      user_verified: "integer",
    },
    account_challenges: { auth_generation: "integer", factor_id: "text" },
  };
  for (const [name, fields] of Object.entries(columns))
    for (const [column, type] of Object.entries(fields)) {
      if (await db.schema.hasColumn(name, column)) continue;
      await db.schema.alterTable(name, (t) => {
        if (type === "integer") {
          if (column === "backup_eligible" || column === "backed_up")
            t.integer(column).nullable();
          else t.integer(column).notNullable().defaultTo(0);
        } else if (type === "time") t.double(column).notNullable().defaultTo(0);
        else t.string(column, 64).nullable();
      });
    }
  if (db.client.config.client === "mysql2") {
    await db.raw(`CREATE TABLE IF NOT EXISTS auth_recoveries (
      id varchar(36) PRIMARY KEY, user_id varchar(64) NOT NULL,
      mode varchar(20) NOT NULL, state varchar(20) NOT NULL, generation int NOT NULL,
      permit_hash varchar(64) NULL, channel_verified_at double NULL,
      not_before double NOT NULL, expires_at double NOT NULL, created_at double NOT NULL,
      FOREIGN KEY(user_id) REFERENCES seller_users(id) ON DELETE CASCADE,
      INDEX auth_recoveries_user (user_id, state)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await db.raw(`CREATE TABLE IF NOT EXISTS auth_hardware_approvals (
      factor_id varchar(64) PRIMARY KEY, user_id varchar(64) NOT NULL,
      public_key_hash varchar(64) NOT NULL, inventory_id varchar(150) NOT NULL,
      operator_id varchar(150) NOT NULL, reference varchar(200) NOT NULL,
      recovery_id varchar(36) NULL, approved_at double NOT NULL,
      FOREIGN KEY(factor_id) REFERENCES seller_factors(id) ON DELETE CASCADE,
      FOREIGN KEY(user_id) REFERENCES seller_users(id) ON DELETE CASCADE,
      UNIQUE KEY auth_hardware_inventory (user_id, inventory_id)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    return;
  }
  if (!(await db.schema.hasTable("auth_recoveries")))
    await db.schema.createTable("auth_recoveries", (t) => {
      t.string("id", 36).primary();
      t.string("user_id", 64)
        .notNullable()
        .references("seller_users.id")
        .onDelete("CASCADE");
      t.string("mode", 20).notNullable();
      t.string("state", 20).notNullable();
      t.integer("generation").notNullable();
      t.string("permit_hash", 64).nullable();
      t.double("channel_verified_at").nullable();
      for (const field of ["not_before", "expires_at", "created_at"])
        t.double(field).notNullable();
      t.index(["user_id", "state"]);
    });
  if (!(await db.schema.hasTable("auth_hardware_approvals")))
    await db.schema.createTable("auth_hardware_approvals", (t) => {
      t.string("factor_id", 64)
        .primary()
        .references("seller_factors.id")
        .onDelete("CASCADE");
      t.string("user_id", 64)
        .notNullable()
        .references("seller_users.id")
        .onDelete("CASCADE");
      t.string("public_key_hash", 64).notNullable();
      t.string("inventory_id", 150).notNullable();
      t.string("operator_id", 150).notNullable();
      t.string("reference", 200).notNullable();
      t.string("recovery_id", 36).nullable();
      t.double("approved_at").notNullable();
      t.unique(["user_id", "inventory_id"]);
    });
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
