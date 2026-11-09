import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { createTenant, lock, type DB, type Tenant, type Tx } from "./db.ts";
import type { SellerSession } from "./platform-auth.ts";
import { check } from "./errors.ts";
import { StripeBilling } from "./stripe.ts";
import { tenantAvailable } from "./tenants.ts";

export interface SandboxConfig extends Config {
  stripeTestSecret?: string;
  stripeTestPublishableKey?: string;
  stripeTestWebhookSecret?: string;
}
export type SandboxMode = "fixture" | "stripe";
interface Mapping {
  parent_tenant_id: string;
  sandbox_tenant_id: string;
  mode: SandboxMode;
  created_at: number;
}
export interface SandboxRuntime {
  tenant: Tenant;
  config: SandboxConfig;
  parentId?: string;
}
/** Only constructed after a server-verified sandbox mapping, never from request flags. */
export class SandboxStripeBilling extends StripeBilling {
  options() {
    check(
      !this.config.stripeLiveMode &&
        this.config.stripeSecret.startsWith("sk_test_"),
      500,
      "sandbox_configuration",
      "Sandbox commerce requires test credentials.",
    );
    if (this.config.deploymentMode === "standalone") return {};
    check(
      this.tenant.stripe_account_id,
      409,
      "stripe_not_connected",
      "Connect the publisher's Stripe account before Stripe test purchases.",
    );
    return { stripeAccount: this.tenant.stripe_account_id };
  }
}
export class PublisherSandboxes {
  readonly db: DB;
  readonly config: SandboxConfig;
  constructor(db: DB, config: SandboxConfig) {
    this.db = db;
    this.config = config;
  }
  private stripeConfigured() {
    check(
      this.config.stripeTestSecret?.startsWith("sk_test_") &&
        this.config.stripeTestPublishableKey?.startsWith("pk_test_") &&
        this.config.stripeTestWebhookSecret?.startsWith("whsec_"),
      503,
      "sandbox_configuration",
      "Stripe test credentials must be configured by the operator.",
    );
  }
  private async owner(tx: Tx, parentId: string, seller: SellerSession) {
    const session = await tx("seller_sessions")
      .where({ id: seller.sessionHash, user_id: seller.user.id })
      .andWhere("expires_at", ">", Date.now())
      .first();
    check(
      session,
      401,
      "seller_login_required",
      "An active verified seller session is required.",
    );
    const member = await tx("seller_memberships")
      .join("seller_users", "seller_users.id", "seller_memberships.user_id")
      .where({ tenant_id: parentId, user_id: seller.user.id, role: "owner" })
      .whereNotNull("verified_at")
      .first();
    check(
      member,
      403,
      "tenant_denied",
      "You do not own this publisher workspace.",
    );
  }
  async create(parent: Tenant, seller: SellerSession, mode: SandboxMode) {
    check(
      mode === "fixture" || mode === "stripe",
      400,
      "sandbox_mode",
      "Choose fixture or Stripe test mode.",
    );
    if (mode === "stripe") this.stripeConfigured();
    return this.db.transaction(async (tx) => {
      await lock(tx, "schema");
      await this.owner(tx, parent.id, seller);
      check(
        !(await tx("publisher_sandboxes")
          .where({ sandbox_tenant_id: parent.id })
          .first()),
        409,
        "sandbox_nested",
        "Nested sandboxes are unavailable.",
      );
      const live = await tx<Tenant>("tenants").where({ id: parent.id }).first();
      check(
        live &&
          tenantAvailable(
            live,
            "capacity",
            (this.config.graceDays ?? 7) * 86400000,
          ),
        403,
        "tenant_capacity",
        "This publisher cannot create test capacity.",
      );
      const existing = await tx<Mapping>("publisher_sandboxes")
        .where({ parent_tenant_id: parent.id })
        .first();
      if (existing) {
        check(
          existing.mode === mode,
          409,
          "sandbox_mode",
          "The existing sandbox uses a different immutable mode.",
        );
        const tenant = (await tx<Tenant>("tenants")
          .where({ id: existing.sandbox_tenant_id })
          .first())!;
        return { tenant, mode, created: false };
      }
      const tenant = await createTenant(tx, {
        id: randomUUID(),
        slug: `sandbox-${randomUUID()}`,
        name: `${live.name} · Sandbox`,
        exempt: 1,
        max_products: Math.min(20, Number(live.max_products)),
        max_storage_bytes: Math.min(
          100 * 1024 * 1024,
          Number(live.max_storage_bytes),
        ),
      });
      await tx("publisher_sandboxes").insert({
        parent_tenant_id: parent.id,
        sandbox_tenant_id: tenant.id,
        mode,
        created_at: Date.now(),
      });
      await tx("seller_memberships").insert({
        tenant_id: tenant.id,
        user_id: seller.user.id,
        role: "owner",
        created_at: Date.now(),
      });
      const products = await tx("products").where({ tenant_id: parent.id });
      for (const product of products) {
        await tx("products").insert({
          ...product,
          id: randomUUID(),
          tenant_id: tenant.id,
        });
      }
      await tx("audit_events").insert({
        id: randomUUID(),
        tenant_id: parent.id,
        actor_type: "seller",
        actor_id: seller.user.id,
        action: "sandbox.created",
        details: JSON.stringify({ sandboxId: tenant.id, mode }),
        created_at: Date.now(),
      });
      return { tenant, mode, created: true };
    });
  }
  async describe(tenantId: string) {
    const mapping = await this.db<Mapping>("publisher_sandboxes")
      .where({ sandbox_tenant_id: tenantId })
      .orWhere({ parent_tenant_id: tenantId })
      .first();
    if (!mapping) return undefined;
    const parent = (await this.db<Tenant>("tenants")
      .where({ id: mapping.parent_tenant_id })
      .first())!;
    const sandbox = (await this.db<Tenant>("tenants")
      .where({ id: mapping.sandbox_tenant_id })
      .first())!;
    return {
      isSandbox: tenantId === sandbox.id,
      parentId: parent.id,
      parentSlug: parent.slug,
      sandboxId: sandbox.id,
      sandboxSlug: sandbox.slug,
      mode: mapping.mode,
    };
  }
  async runtime(
    tenant: Tenant,
    options: { reconciliation?: boolean } = {},
  ): Promise<SandboxRuntime> {
    const mapping = await this.db<Mapping>("publisher_sandboxes")
      .where({ sandbox_tenant_id: tenant.id })
      .first();
    if (!mapping) return { tenant, config: this.config };
    const parent = (await this.db<Tenant>("tenants")
      .where({ id: mapping.parent_tenant_id })
      .first())!;
    // Only internal signed-event ingestion and reconciliation may run while
    // suspended. HTTP tenant contexts retain the ordinary admission check.
    if (!options.reconciliation)
      check(
        !parent.suspended,
        403,
        "tenant_suspended",
        "This publisher's service is suspended.",
      );
    if (mapping.mode === "stripe") this.stripeConfigured();
    return {
      parentId: parent.id,
      tenant: {
        ...tenant,
        suspended: tenant.suspended || parent.suspended ? 1 : 0,
        stripe_account_id: parent.stripe_account_id,
        stripe_status: parent.stripe_status,
        exempt: parent.exempt,
        paid_through: parent.paid_through,
        trial_ends_at: parent.trial_ends_at,
        pro_paid_through: parent.pro_paid_through!,
        pro_period_start: parent.pro_period_start!,
      },
      config: {
        ...this.config,
        localBilling: mapping.mode === "fixture",
        stripeLiveMode: false,
        hostedApplicationFeePercent: 0,
        stripeSecret:
          mapping.mode === "stripe"
            ? this.config.stripeTestSecret!
            : "sk_test_sandbox_fixture",
        stripePublishableKey:
          mapping.mode === "stripe"
            ? this.config.stripeTestPublishableKey!
            : "pk_test_sandbox_fixture",
        stripeWebhookSecret:
          mapping.mode === "stripe"
            ? this.config.stripeTestWebhookSecret!
            : "whsec_sandbox_fixture",
      },
    };
  }
  async forStripeAccount(accountId: string) {
    const parent = await this.db<Tenant>("tenants")
      .where({ stripe_account_id: accountId })
      .first();
    if (!parent) return undefined;
    const mapping = await this.db<Mapping>("publisher_sandboxes")
      .where({ parent_tenant_id: parent.id, mode: "stripe" })
      .first();
    return mapping
      ? this.db<Tenant>("tenants")
          .where({ id: mapping.sandbox_tenant_id })
          .first()
      : undefined;
  }
}
