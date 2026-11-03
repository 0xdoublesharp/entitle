import { randomUUID } from "node:crypto";
import type { DB, Tenant, Tx } from "./db.ts";
import { createTenant, lock } from "./db.ts";
import type { Config } from "./config.ts";
import type { SellerSession } from "./platform-auth.ts";
import { hash, random } from "./crypto.ts";
import { check } from "./errors.ts";

export const tenantApiKeyScopes = [
  "read",
  "catalog:write",
  "releases:write",
  "licenses:write",
  "billing:reconcile",
  "operations:write",
  "data:export",
] as const;
type TenantConfig = Config & {
  trialDays?: number;
  maxTenantsPerSeller?: number;
  trialStorageBytes?: number;
};
const reservedSlugs = new Set([
  "primary",
  "admin",
  "api",
  "operator",
  "platform",
  "seller",
  "stripe",
  "wordpress",
  "support",
  "entitle",
]);

// All durable business records block removal. Configuration and unused keys can
// be discarded, but exports and other retained audit history cannot.
const historyTables = [
  "products",
  "plans",
  "customers",
  "licenses",
  "grants",
  "installations",
  "releases",
  "release_assets",
  "billing_events",
  "work",
  "emails",
  "login_tokens",
  "sessions",
  "download_metrics",
  "invoice_metrics",
  "upload_reservations",
  "platform_grants",
  "platform_checkouts",
  "oauth_states",
  "platform_price_history",
  "business_events",
  "outbound_endpoints",
  "outbound_events",
  "outbound_deliveries",
  "operation_notifications",
  "account_closures",
  "account_privacy_receipts",
];
const baselineAlertIds = [
  "queue_failed",
  "queue_stalled",
  "storage_capacity",
  "bandwidth",
  "billing_capacity",
];
const disposableAuditActions = [
  "tenant.created",
  "membership.created",
  "tenant.archived",
  "tenant.restored",
  "api_key.created",
  "api_key.revoked",
];

export type TenantOperation = "capacity" | "buyer" | "recovery" | "reconcile";
export function tenantAvailable(
  tenant: Tenant,
  operation: TenantOperation,
  graceMs = 7 * 86400000,
  now = Date.now(),
): boolean {
  if (tenant.suspended) return false;
  if (operation !== "capacity" || tenant.exempt) return true;
  return Math.max(tenant.trial_ends_at, tenant.paid_through + graceMs) > now;
}

export class Tenants {
  db: DB;
  config: TenantConfig;
  constructor(db: DB, config: TenantConfig) {
    this.db = db;
    this.config = config;
  }
  private async session(tx: Tx, seller: SellerSession) {
    const session = await tx("seller_sessions")
      .where({ id: seller.sessionHash, user_id: seller.user.id })
      .andWhere("expires_at", ">", Date.now())
      .first();
    const user = await tx("seller_users")
      .where({ id: seller.user.id })
      .whereNotNull("verified_at")
      .first();
    check(
      session && user,
      401,
      "seller_login_required",
      "An active verified seller session is required.",
    );
    return user;
  }
  private async owner(tx: Tx, seller: SellerSession, tenantId: string) {
    await this.session(tx, seller);
    const membership = await tx("seller_memberships")
      .where({ tenant_id: tenantId, user_id: seller.user.id, role: "owner" })
      .first();
    check(membership, 403, "tenant_denied", "You do not own this tenant.");
  }
  private async audit(
    tx: Tx,
    seller: SellerSession,
    tenantId: string,
    action: string,
    details: Record<string, string> = {},
  ) {
    await tx("audit_events").insert({
      id: randomUUID(),
      tenant_id: tenantId,
      actor_type: "seller",
      actor_id: seller.user.id,
      action,
      details: JSON.stringify(details),
      created_at: Date.now(),
    });
  }
  async list(userId: string): Promise<Tenant[]> {
    return this.db<Tenant>("tenants")
      .join("seller_memberships", "seller_memberships.tenant_id", "tenants.id")
      .leftJoin(
        "publisher_sandboxes",
        "publisher_sandboxes.sandbox_tenant_id",
        "tenants.id",
      )
      .leftJoin(
        "tenants as parent",
        "parent.id",
        "publisher_sandboxes.parent_tenant_id",
      )
      .where({
        "seller_memberships.user_id": userId,
        "seller_memberships.role": "owner",
      })
      .select(
        "tenants.*",
        "parent.archived_at as parent_archived_at",
        "parent.slug as sandbox_parent_slug",
      )
      .orderBy("tenants.created_at");
  }
  private async lifecycleTenant(tx: Tx, seller: SellerSession, id: string) {
    check(
      this.config.deploymentMode === "hosted",
      404,
      "not_found",
      "Workspace management is unavailable in standalone mode.",
    );
    await lock(tx, "schema");
    await lock(tx, "auth");
    for (const name of ["schema", "billing", "work", "email", "auth"])
      await tx("locks")
        .where({ id: `${id}:${name}` })
        .increment("version", 1);
    // Obtain the parent row's write lock before any consistent read. FK inserts
    // cannot race the empty check, including under MySQL repeatable-read.
    const changed = await tx("tenants")
      .where({ id })
      .update({ archived_at: tx.ref("archived_at") });
    check(changed, 404, "tenant_not_found", "Workspace was not found.");
    await this.owner(tx, seller, id);
    check(
      id !== "primary",
      409,
      "primary_workspace",
      "The primary workspace cannot be archived or removed.",
    );
    return (await tx<Tenant>("tenants").where({ id }).first())!;
  }
  async archive(seller: SellerSession, id: string, archived: boolean) {
    return this.db.transaction(async (tx) => {
      const tenant = await this.lifecycleTenant(tx, seller, id);
      if (archived ? tenant.archived_at == null : tenant.archived_at != null) {
        tenant.archived_at = archived ? Date.now() : null;
        await tx("tenants")
          .where({ id })
          .update({ archived_at: tenant.archived_at });
        await this.audit(
          tx,
          seller,
          id,
          archived ? "tenant.archived" : "tenant.restored",
        );
      }
      return tenant;
    });
  }
  private async removalBlockers(tx: Tx, tenant: Tenant) {
    const blockers: string[] = [];
    if (
      tenant.stripe_account_id ||
      tenant.platform_customer_id ||
      tenant.platform_subscription_id ||
      tenant.paid_through > 0 ||
      Number(tenant.pro_paid_through) > 0
    )
      blockers.push("Connected payment accounts or billing history");
    if (
      await tx("publisher_sandboxes")
        .where({ parent_tenant_id: tenant.id })
        .first()
    )
      blockers.push("Linked sandbox workspace");
    for (const table of historyTables)
      if (await tx(table).where({ tenant_id: tenant.id }).first())
        blockers.push(table.replaceAll("_", " "));
    if (
      await tx("operation_alerts")
        .where({ tenant_id: tenant.id })
        .where((query) =>
          query
            .whereNotIn("id", baselineAlertIds)
            .orWhereNot("active", 0)
            .orWhereNot("last_sent_at", 0),
        )
        .first()
    )
      blockers.push("Operational alert history");
    if (
      await tx("tenant_api_keys")
        .where({ tenant_id: tenant.id })
        .whereNotNull("last_used_at")
        .first()
    )
      blockers.push("API key usage history");
    if (
      await tx("audit_events")
        .where({ tenant_id: tenant.id })
        .whereNotIn("action", disposableAuditActions)
        .first()
    )
      blockers.push("Retained workspace activity or exports");
    return blockers;
  }
  async removal(seller: SellerSession, id: string) {
    return this.db.transaction(async (tx) => {
      const tenant = await this.lifecycleTenant(tx, seller, id);
      const blockers = await this.removalBlockers(tx, tenant);
      return { removable: blockers.length === 0, blockers };
    });
  }
  async remove(seller: SellerSession, id: string, slug: string) {
    await this.db.transaction(async (tx) => {
      const tenant = await this.lifecycleTenant(tx, seller, id);
      check(
        slug === tenant.slug,
        400,
        "workspace_confirmation",
        "Type the workspace address exactly to confirm removal.",
      );
      check(
        (await this.removalBlockers(tx, tenant)).length === 0,
        409,
        "workspace_has_history",
        "This workspace has retained history or linked services. Archive it instead.",
      );
      // Preserve security auditing without retaining a foreign key to the empty
      // namespace. Removal revokes unused keys and never deletes a seller account.
      await this.audit(tx, seller, id, "tenant.removed", {
        workspace_id: id,
        slug,
      });
      await tx("audit_events")
        .where({ tenant_id: id })
        .update({ tenant_id: null });
      for (const table of [
        "tenant_api_keys",
        "operation_settings",
        "seller_memberships",
      ])
        await tx(table).where({ tenant_id: id }).delete();
      await tx("publisher_sandboxes").where({ sandbox_tenant_id: id }).delete();
      // Routine health scans create these rows before a workspace has activity.
      // Only never-triggered baselines are disposable; forwarding and real alert
      // history were checked above while holding this workspace's work lock.
      await tx("operation_alerts")
        .where({ tenant_id: id, active: 0, last_sent_at: 0 })
        .whereIn("id", baselineAlertIds)
        .delete();
      await tx("locks")
        .whereIn(
          "id",
          ["auth", "billing", "email", "schema", "work"].map(
            (name) => `${id}:${name}`,
          ),
        )
        .delete();
      await tx("tenants").where({ id }).delete();
    });
  }
  async create(
    seller: SellerSession,
    input: { slug: string; name: string },
  ): Promise<Tenant> {
    check(
      this.config.deploymentMode === "hosted",
      404,
      "not_found",
      "Tenant creation is unavailable in standalone mode.",
    );
    const slug = input.slug;
    const name = input.name.trim();
    check(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) &&
        name.length > 0 &&
        name.length <= 200,
      400,
      "invalid_tenant",
      "Choose a lowercase tenant slug and a name of at most 200 characters.",
    );
    check(
      !reservedSlugs.has(slug),
      400,
      "reserved_tenant",
      "That tenant namespace is reserved for the platform.",
    );
    return this.db.transaction(async (tx) => {
      await lock(tx, "schema");
      const user = await this.session(tx, seller);
      check(
        !(await tx("tenants").where({ slug }).first()),
        409,
        "tenant_exists",
        "That tenant namespace is already registered.",
      );
      const membershipCount = await tx("seller_memberships")
        .where({ user_id: user.id, role: "owner" })
        .whereNotIn(
          "tenant_id",
          tx("publisher_sandboxes").select("sandbox_tenant_id"),
        )
        .count({ total: "tenant_id" })
        .first();
      check(
        Number(membershipCount!.total) < (this.config.maxTenantsPerSeller ?? 3),
        403,
        "tenant_limit",
        "Your seller account has reached its tenant limit. Contact the platform operator.",
      );
      const tenant = await createTenant(tx, {
        id: randomUUID(),
        slug,
        name,
        trial_ends_at:
          Number(user.verified_at) + (this.config.trialDays ?? 14) * 86400000,
        max_products: 3,
        max_storage_bytes: this.config.trialStorageBytes ?? 100 * 1024 * 1024,
      });
      await tx("seller_memberships").insert({
        tenant_id: tenant.id,
        user_id: seller.user.id,
        role: "owner",
        created_at: Date.now(),
      });
      await this.audit(tx, seller, tenant.id, "tenant.created");
      await this.audit(tx, seller, tenant.id, "membership.created");
      return tenant;
    });
  }
  async keys(seller: SellerSession, tenantId: string) {
    await this.owner(this.db, seller, tenantId);
    return this.db("tenant_api_keys")
      .where({ tenant_id: tenantId })
      .select(
        "id",
        "name",
        "created_at",
        "revoked_at",
        "scopes",
        "expires_at",
        "last_used_at",
        "display_prefix",
      )
      .orderBy("created_at");
  }
  async createKey(
    seller: SellerSession,
    tenantId: string,
    name: string,
    options: { scopes?: string[]; expiresInDays?: number } = {},
  ) {
    name = name.trim();
    check(
      name.length > 0 && name.length <= 150,
      400,
      "invalid_key_name",
      "Give this key a name of at most 150 characters.",
    );
    const scopes = [...new Set(options.scopes ?? ["read", "releases:write"])];
    const days = options.expiresInDays ?? 90;
    check(
      scopes.length > 0 &&
        scopes.every((scope) =>
          tenantApiKeyScopes.includes(
            scope as (typeof tenantApiKeyScopes)[number],
          ),
        ) &&
        Number.isInteger(days) &&
        days >= 1 &&
        days <= 365,
      400,
      "invalid_key_policy",
      "Choose valid API key scopes and an expiration between 1 and 365 days.",
    );
    const token = `DE-TK-${random()}`;
    const id = randomUUID();
    const created_at = Date.now();
    const expires_at = created_at + days * 86400000;
    const display_prefix = token.slice(0, 14);
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await this.owner(tx, seller, tenantId);
      await tx("tenant_api_keys").insert({
        id,
        tenant_id: tenantId,
        name,
        key_hash: hash(token),
        created_at,
        revoked_at: null,
        scopes: JSON.stringify(scopes),
        expires_at,
        last_used_at: null,
        display_prefix,
      });
      await this.audit(tx, seller, tenantId, "api_key.created", { key_id: id });
    });
    return { id, name, token, scopes, expires_at, display_prefix };
  }
  async revokeKey(seller: SellerSession, tenantId: string, keyId: string) {
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await this.owner(tx, seller, tenantId);
      const key = await tx("tenant_api_keys")
        .where({ id: keyId, tenant_id: tenantId })
        .first();
      check(key, 404, "key_not_found", "API key was not found.");
      if (key.revoked_at !== null) return;
      await tx("tenant_api_keys")
        .where({ id: keyId, tenant_id: tenantId })
        .update({ revoked_at: Date.now() });
      await this.audit(tx, seller, tenantId, "api_key.revoked", {
        key_id: keyId,
      });
    });
  }
}
