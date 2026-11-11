import type { Knex } from "knex";

export const config = { transaction: false };
export async function up(db: Knex) {
  if (!(await db.schema.hasColumn("seller_users", "email_login_disabled")))
    await db.schema.alterTable("seller_users", (table) => {
      table.integer("email_login_disabled").notNullable().defaultTo(0);
    });
  if (db.client.config.client === "mysql2")
    await db.raw(`CREATE TABLE IF NOT EXISTS passkey_login_challenges (
      id varchar(64) PRIMARY KEY, challenge varchar(100) NOT NULL, expires_at double NOT NULL,
      INDEX passkey_login_challenges_expiry (expires_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  else if (!(await db.schema.hasTable("passkey_login_challenges")))
    await db.schema.createTable("passkey_login_challenges", (table) => {
      table.string("id", 64).primary();
      table.string("challenge", 100).notNullable();
      table.double("expires_at").notNullable();
      table.index(["expires_at"]);
    });
  for (const name of ["seller_factors", "seller_factor_challenges"]) {
    if (db.client.config.client === "mysql2") {
      const fields =
        name === "seller_factors"
          ? `name varchar(150) NOT NULL, credential_hash varchar(64) NULL UNIQUE, counter double NOT NULL DEFAULT 0`
          : `session_hash varchar(64) NOT NULL, expires_at double NOT NULL,
          FOREIGN KEY (session_hash, user_id) REFERENCES seller_sessions(id, user_id) ON DELETE CASCADE,
          INDEX seller_factor_challenges_expiry (user_id, expires_at)`;
      await db.raw(
        `CREATE TABLE IF NOT EXISTS ?? (
        id varchar(64) PRIMARY KEY, user_id varchar(64) NOT NULL,
        kind varchar(30) NOT NULL, payload text NOT NULL, created_at double NOT NULL,
        FOREIGN KEY (user_id) REFERENCES seller_users(id) ON DELETE CASCADE,
        ${fields}, INDEX security_factor_kind (user_id, kind)
      ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`,
        [name],
      );
      continue;
    }
    if (await db.schema.hasTable(name)) continue;
    await db.schema.createTable(name, (table) => {
      table.string("id", 64).primary();
      table
        .string("user_id", 64)
        .notNullable()
        .references("seller_users.id")
        .onDelete("CASCADE");
      table.string("kind", 30).notNullable();
      table.text("payload").notNullable();
      table.double("created_at").notNullable();
      if (name === "seller_factors") {
        table.string("name", 150).notNullable();
        // Hash prevents duplicate passkeys without indexing a potentially long credential ID.
        table.string("credential_hash", 64).nullable().unique();
        table.double("counter").notNullable().defaultTo(0);
      } else {
        table.string("session_hash", 64).notNullable();
        table
          .foreign(["session_hash", "user_id"])
          .references(["id", "user_id"])
          .inTable("seller_sessions")
          .onDelete("CASCADE");
        table.double("expires_at").notNullable();
        table.index(["user_id", "expires_at"]);
      }
      table.index(["user_id", "kind"]);
    });
  }
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
