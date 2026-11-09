import knex, { type Knex } from "knex";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export type DB = Knex;
export type Tx = Knex | Knex.Transaction;
export function createDb(url: string): DB {
  if (url.startsWith("sqlite:")) {
    const filename = url.slice(7);
    mkdirSync(dirname(filename), { recursive: true });
    return knex({
      client: "better-sqlite3",
      connection: { filename },
      useNullAsDefault: true,
      pool: {
        min: 1,
        max: 1,
        afterCreate(
          connection: { pragma: (v: string) => unknown },
          done: (e: Error | null, c: unknown) => void,
        ) {
          connection.pragma("foreign_keys = ON");
          connection.pragma("journal_mode = WAL");
          connection.pragma("busy_timeout = 10000");
          done(null, connection);
        },
      },
    });
  }
  return knex({
    client: url.startsWith("postgres") ? "pg" : "mysql2",
    connection: url,
    pool: { min: 0, max: 10 },
  });
}
const migrationNames = [
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
  "016_worker_continuations",
  "017_worker_grant_index",
  "018_worker_privacy_receipt_index",
] as const;

// Knex's migration listing can create its metadata tables. Serving roles only
// inspect the existing history, so even an uninitialized DB remains untouched.
export async function assertSchemaCurrent(db: DB): Promise<void> {
  if (!(await db.schema.hasTable("knex_migrations")))
    throw Error(
      "Database schema migrations are missing; run SERVER_ROLE=migrate",
    );
  const rows = await db("knex_migrations").select<{ name: string }[]>("name");
  const applied = new Set(rows.map(({ name }) => name));
  const expected = new Set<string>(migrationNames);
  if (
    rows.length !== applied.size ||
    [...applied].some((name) => !expected.has(name)) ||
    migrationNames.some((name) => !applied.has(name))
  )
    throw Error(
      "Database migration history does not match bundled schema migrations",
    );
}

export async function migrate(db: DB) {
  await db.migrate.latest({
    migrationSource: {
      getMigrations: async () => [...migrationNames],
      getMigrationName: (m: string) => m,
      getMigration: async (m: string) =>
        m === "001_initial"
          ? import("./migrations/001_initial.ts")
          : m === "002_plugin_identity"
            ? import("./migrations/002_plugin_identity.ts")
            : m === "003_tenants"
              ? import("./migrations/003_tenants.ts")
              : m === "004_stripe_status"
                ? import("./migrations/004_stripe_status.ts")
                : m === "005_security"
                  ? import("./migrations/005_security.ts")
                  : m === "006_checkout"
                    ? import("./migrations/006_checkout.ts")
                    : m === "007_frameworks"
                      ? import("./migrations/007_frameworks.ts")
                      : m === "008_commerce"
                        ? import("./migrations/008_commerce.ts")
                        : m === "009_accounts"
                          ? import("./migrations/009_accounts.ts")
                          : m === "010_operations"
                            ? import("./migrations/010_operations.ts")
                            : m === "011_sandboxes"
                              ? import("./migrations/011_sandboxes.ts")
                              : m === "012_business_events"
                                ? import("./migrations/012_business_events.ts")
                                : m === "013_platform_price_history"
                                  ? import("./migrations/013_platform_price_history.ts")
                                  : m === "014_complimentary_licenses"
                                    ? import("./migrations/014_complimentary_licenses.ts")
                                    : m === "015_workspace_archive"
                                      ? import("./migrations/015_workspace_archive.ts")
                                      : m === "016_worker_continuations"
                                        ? import("./migrations/016_worker_continuations.ts")
                                        : m === "017_worker_grant_index"
                                          ? import("./migrations/017_worker_grant_index.ts")
                                          : import("./migrations/018_worker_privacy_receipt_index.ts"),
    },
  });
}

export const tables = [
  "worker_continuation_facts",
  "worker_continuations",
  "platform_price_history",
  "business_events",
  "publisher_sandboxes",
  "outbound_deliveries",
  "outbound_events",
  "outbound_endpoints",
  "operation_notifications",
  "operation_alerts",
  "operation_settings",
  "account_privacy_receipts",
  "account_closures",
  "account_challenges",
  "account_recovery_codes",
  "account_attempts",
  "platform_grants",
  "platform_checkouts",
  "oauth_states",
  "seller_sessions",
  "seller_login_tokens",
  "tenant_api_keys",
  "seller_memberships",
  "audit_events",
  "seller_users",
  "platform_emails",
  "platform_work",
  "platform_events",
  "download_metrics",
  "invoice_metrics",
  "upload_reservations",
  "sessions",
  "login_tokens",
  "emails",
  "work",
  "billing_events",
  "installations",
  "grants",
  "licenses",
  "release_assets",
  "releases",
  "customers",
  "plans",
  "products",
];
export async function reset(db: DB) {
  for (const t of tables) await db(t).delete();
  await db("tenants").whereNot({ id: "primary" }).delete();
  await db("tenants")
    .where({ id: "primary" })
    .update({
      pro_paid_through: 0,
      pro_period_start: 0,
      platform_billing_revision: 0,
      automatic_tax: 0,
      collect_tax_id: 0,
      collect_billing_address: 0,
      archived_at: null,
      slug: "primary",
      name: "Primary",
      stripe_account_id: null,
      platform_customer_id: null,
      platform_subscription_id: null,
      billing_status: "trial",
      stripe_status: "platform",
      paid_through: 0,
      trial_ends_at: 0,
      exempt: 1,
      suspended: 0,
      max_products: 20,
      max_storage_bytes: 1024 ** 3,
    });
  await db("locks").where("id", "like", "%:%").delete();
  await db("locks").insert(tenantLocks("primary"));
}
export async function lock(tx: Tx, name: string, tenantId?: string) {
  const id = tenantId === undefined ? name : `${tenantId}:${name}`;
  const count = await tx("locks").where({ id }).increment("version", 1);
  if (count !== 1) throw Error(`missing lock ${id}`);
}
export type { Tenant } from "../packages/shared/tenant.ts";
import type { Tenant } from "../packages/shared/tenant.ts";
export type TenantContext = Pick<Tenant, "id" | "slug" | "name">;
function tenantLocks(id: string) {
  return ["auth", "billing", "email", "schema", "work"].map((name) => ({
    id: `${id}:${name}`,
    version: 0,
  }));
}
export async function createTenant(
  db: DB | Knex.Transaction,
  input: TenantContext & Partial<Omit<Tenant, keyof TenantContext>>,
): Promise<Tenant> {
  const now = Date.now();
  const tenant: Tenant = {
    stripe_account_id: null,
    stripe_status: input.stripe_account_id ? "connected" : "unconnected",
    platform_customer_id: null,
    platform_subscription_id: null,
    billing_status: "trial",
    paid_through: 0,
    trial_ends_at: now + 14 * 86400000,
    exempt: 0,
    suspended: 0,
    max_products: 20,
    max_storage_bytes: 1024 ** 3,
    created_at: now,
    ...input,
  };
  await db.transaction(async (tx) => {
    await tx("tenants").insert(tenant);
    await tx("locks").insert(tenantLocks(tenant.id));
  });
  return tenant;
}
export interface License {
  tenant_id: string;
  id: string;
  customer_id: string;
  product_id: string;
  plan_id: string | null;
  site_allowance: number;
  paid_through: number;
  billing_status: string;
  subscription_id: string | null;
  provenance?: "paid" | "complimentary";
  expires_at?: number | null;
  complimentary_request_id?: string | null;
  complimentary_request_hash?: string | null;
  issued_by?: string | null;
  issued_at?: number | null;
  internal_note?: string | null;
  key_hash: string;
  revoked: number;
  refund_revoked: number;
  suspended: number;
  lock_version: number;
}
export interface Installation {
  tenant_id: string;
  id: string;
  license_id: string;
  installation_id: string;
  site_url: string;
  active: number;
  exempt: number;
  token_hash: string;
  token_cipher: string;
  label?: string | null;
}
export interface Customer {
  tenant_id: string;
  id: string;
  email: string;
  stripe_id: string | null;
}
export interface Plan {
  tenant_id: string;
  id: string;
  product_id: string;
  name: string;
  site_allowance: number;
  stripe_price_id: string;
}
export interface Release {
  tenant_id: string;
  id: string;
  product_id: string;
  version: string;
  changelog: string;
  published_at: number;
  withdrawn: number;
  checksum: string;
  size: number;
  min_wp: string;
  min_php: string;
  min_free: string;
  tested: string;
}
export interface Job {
  tenant_id: string;
  id: string;
  kind: string;
  payload: string;
  state: string;
  attempts: number;
  available_at: number;
  lease_until: number;
  lease_owner: string | null;
  last_error: string | null;
  created_at: number;
  customer_id?: string;
  license_id?: string | null;
}

export interface ReleaseAsset {
  id: string;
  tenant_id: string;
  release_id: string;
  target: string;
  filename: string;
  size: number;
  checksum: string;
  sha512: string;
  signature: string | null;
  min_system_version: string | null;
}
