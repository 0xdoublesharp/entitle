import type { Knex } from "knex";

export const config = { transaction: false };
export async function up(db: Knex) {
  // Keep each MySQL table and its constraints in one atomic DDL statement.
  // Knex otherwise emits foreign keys and indexes as later ALTER statements.
  if (db.client.config.client === "mysql2") {
    await db.raw(`CREATE TABLE IF NOT EXISTS oidc_publishers (
      id varchar(36) PRIMARY KEY, tenant_id varchar(64) NOT NULL,
      product_id varchar(64) NOT NULL, name varchar(150) NOT NULL,
      provider varchar(50) NOT NULL, issuer text NOT NULL, subject text NOT NULL,
      claims text NOT NULL, created_at double NOT NULL, revoked_at double NULL,
      UNIQUE KEY oidc_publishers_tenant_id (tenant_id, id),
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (tenant_id, product_id) REFERENCES products(tenant_id, id),
      INDEX oidc_publishers_tenant_created (tenant_id, created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await db.raw(`CREATE TABLE IF NOT EXISTS oidc_sessions (
      id varchar(64) PRIMARY KEY, tenant_id varchar(64) NOT NULL,
      publisher_id varchar(36) NOT NULL, identity_hash varchar(64) NOT NULL UNIQUE,
      expires_at double NOT NULL, replay_until double NOT NULL, created_at double NOT NULL,
      FOREIGN KEY (tenant_id) REFERENCES tenants(id),
      FOREIGN KEY (tenant_id, publisher_id) REFERENCES oidc_publishers(tenant_id, id),
      INDEX oidc_sessions_publisher (tenant_id, publisher_id),
      INDEX oidc_sessions_replay (replay_until)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    return;
  }
  if (!(await db.schema.hasTable("oidc_publishers")))
    await db.schema.createTable("oidc_publishers", (table) => {
      table.string("id", 36).primary();
      table.unique(["tenant_id", "id"]);
      table.string("tenant_id", 64).notNullable().references("tenants.id");
      table.string("product_id", 64).notNullable();
      table
        .foreign(["tenant_id", "product_id"])
        .references(["tenant_id", "id"])
        .inTable("products");
      table.string("name", 150).notNullable();
      table.string("provider", 50).notNullable();
      table.text("issuer").notNullable();
      table.text("subject").notNullable();
      table.text("claims").notNullable();
      table.double("created_at").notNullable();
      table.double("revoked_at").nullable();
      table.index(["tenant_id", "created_at"]);
    });
  if (!(await db.schema.hasTable("oidc_sessions")))
    await db.schema.createTable("oidc_sessions", (table) => {
      table.string("id", 64).primary(); // Only a hash of the short-lived credential.
      table.string("tenant_id", 64).notNullable().references("tenants.id");
      table.string("publisher_id", 36).notNullable();
      table
        .foreign(["tenant_id", "publisher_id"])
        .references(["tenant_id", "id"])
        .inTable("oidc_publishers");
      table.string("identity_hash", 64).notNullable().unique();
      table.double("expires_at").notNullable();
      table.double("replay_until").notNullable();
      table.double("created_at").notNullable();
      table.index(["tenant_id", "publisher_id"]);
      table.index(["replay_until"]);
    });
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
