import { appUrl, normalizeAppBasePath } from "../packages/shared/app-path.ts";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import type { DB, Tenant, Tx } from "./db.ts";
import { lock } from "./db.ts";
import type { Config } from "./config.ts";
import type { SellerSession } from "./platform-auth.ts";
import type { BillingEvent } from "./billing.ts";
import { hash, random, seal, unseal } from "./crypto.ts";
import { check } from "./errors.ts";
import {
  assertQueueLease,
  DeferredJob,
  runQueue,
  type WorkerQueueOptions,
} from "./queue.ts";
import {
  workerTurn,
  withWorkerTurn,
  stripeWorkerHttpClient,
  type WorkerTurn,
  type WorkerFact,
} from "./worker-continuation.ts";

type PlatformConfig = Config & {
  stripeConnectClientId?: string;
  stripeLiveMode?: boolean;
  platformPriceId?: string;
  platformProStripePriceId?: string;
  paidMaxProducts?: number;
  paidStorageBytes?: number;
};
interface PlatformTenant extends Tenant {
  platform_billing_revision?: number;
}
type PlatformTier = "starter" | "pro";
interface PriceHistory {
  tenant_id: string;
  livemode: number;
  price_id: string;
  tier: PlatformTier;
  verified_at: number;
}
interface PlatformGrant {
  tenant_id: string;
  id: string;
  subscription_id: string;
  invoice_id: string;
  price_id: string;
  tier: "starter" | "pro";
  period_start: number;
  period_end: number;
  revoked: number;
}
export type PlatformEvent = BillingEvent & {
  account?: string;
  livemode?: boolean;
};
const providerId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;

interface CheckoutGuard {
  tenant_id: string;
  id: string;
  customer_id: string;
  price_id: string;
  session_id: string | null;
  attempted_at: number | null;
  lease_owner: string | null;
  lease_until: number;
  created_at: number;
}
const terminal = (status: string) =>
  ["canceled", "incomplete_expired"].includes(status);

interface PlatformEvidence {
  invoice: Stripe.Invoice;
  subscriptionId: string;
  lines: Stripe.InvoiceLineItem[];
  cashRevoked?: boolean;
  creditApplied?: number;
}
interface PlatformTask {
  kind:
    | "price"
    | "current"
    | "selected"
    | "subscriptions"
    | "invoices"
    | "lines"
    | "payments"
    | "charges"
    | "charge"
    | "disputes"
    | "balances";
  id?: string;
  invoiceId?: string;
  after?: string;
  tier?: PlatformTier;
}
interface PlatformScan {
  identity: string;
  tenant: PlatformTenant;
  revision: number;
  prices: [string, PlatformTier][];
  phase: "selection" | "evidence" | "ready";
  head: number;
  tail: number;
  current?: Stripe.Subscription;
  selected?: Stripe.Subscription;
}
interface PlatformChargeFact {
  invoiceId: string;
  id: string;
  paid: boolean;
  refunded: number;
  disputed: boolean;
}
const platformSlot = "platform-reconcile";

// Persist only the fields used by entitlement calculation, never provider
// envelopes, metadata, customer contact details or checkout/payment secrets.
function subscriptionFact(sub: Stripe.Subscription): Stripe.Subscription {
  return {
    id: sub.id,
    customer: providerId(sub.customer),
    status: sub.status,
    livemode: sub.livemode,
    created: sub.created,
    items: {
      data: sub.items.data.map((item) => ({ price: { id: item.price.id } })),
    },
  } as Stripe.Subscription;
}
function invoiceFact(invoice: Stripe.Invoice): Stripe.Invoice {
  return {
    id: invoice.id,
    customer: providerId(invoice.customer),
    parent: {
      subscription_details: {
        subscription: providerId(
          invoice.parent?.subscription_details?.subscription,
        ),
      },
    },
    livemode: invoice.livemode,
    status: invoice.status,
    amount_paid: invoice.amount_paid,
    amount_due: invoice.amount_due,
    amount_remaining: invoice.amount_remaining,
    total: invoice.total,
    currency: invoice.currency,
    created: invoice.created,
    status_transitions: { paid_at: invoice.status_transitions?.paid_at },
  } as Stripe.Invoice;
}
function lineFact(line: Stripe.InvoiceLineItem): Stripe.InvoiceLineItem {
  const details = line.parent?.subscription_item_details;
  const credited = details?.proration_details?.credited_items;
  return {
    id: line.id,
    amount: line.amount,
    period: { start: line.period.start, end: line.period.end },
    pricing: {
      price_details: { price: providerId(line.pricing?.price_details?.price) },
    },
    parent: details
      ? {
          subscription_item_details: {
            proration: details.proration,
            proration_details: credited
              ? {
                  credited_items: {
                    invoice: credited.invoice,
                    invoice_line_items: [...credited.invoice_line_items],
                  },
                }
              : null,
          },
        }
      : null,
  } as Stripe.InvoiceLineItem;
}

export class PlatformBilling {
  readonly db: DB;
  readonly config: PlatformConfig;
  private client: Stripe | undefined;
  private portalConfigurationId: string | undefined;
  private portalConfigurationReturnUrl: string | undefined;
  constructor(db: DB, config: PlatformConfig, stripe?: Stripe) {
    this.db = db;
    this.config = config;
    this.client = stripe;
  }
  get stripe(): Stripe {
    check(
      this.client || this.config.stripeSecret,
      503,
      "billing_unavailable",
      "Stripe billing is not configured.",
    );
    return (this.client ??= new Stripe(this.config.stripeSecret, {
      apiVersion: "2026-09-30.endive",
      maxNetworkRetries: 2,
      timeout: 20000,
      httpClient: stripeWorkerHttpClient(),
    }));
  }
  set stripe(client: Stripe) {
    this.client = client;
  }
  private external() {
    check(
      this.config.deploymentMode === "hosted",
      404,
      "not_found",
      "Hosted billing is unavailable in standalone mode.",
    );
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe is disabled in local fixture mode.",
    );
    void this.stripe;
  }
  private mode(livemode: boolean | undefined) {
    check(
      livemode === (this.config.stripeLiveMode ?? false),
      400,
      "stripe_mode",
      "Stripe test and live modes cannot be mixed.",
    );
  }
  private callbackUri() {
    return `${this.config.origin}/api/v1/platform/stripe/callback`;
  }
  private async owner(tx: Tx, tenantId: string, seller: SellerSession) {
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
    const member = await tx("seller_memberships")
      .where({ tenant_id: tenantId, user_id: seller.user.id, role: "owner" })
      .first();
    check(member, 403, "tenant_denied", "You do not own this tenant.");
    return user as SellerSession["user"];
  }
  async connect(
    tenant: Tenant,
    seller: SellerSession,
  ): Promise<{ url: string }> {
    this.external();
    check(
      this.config.stripeConnectClientId,
      503,
      "stripe_connect_configuration",
      "Stripe Connect is not configured.",
    );
    const state = random();
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await this.owner(tx, tenant.id, seller);
      await tx("oauth_states").insert({
        id: hash(state),
        tenant_id: tenant.id,
        user_id: seller.user.id,
        session_id: seller.sessionHash,
        redirect_uri: this.callbackUri(),
        expires_at: Date.now() + 600000,
      });
    });
    const url = this.stripe.oauth.authorizeUrl({
      response_type: "code",
      client_id: this.config.stripeConnectClientId,
      scope: "read_write",
      state,
      redirect_uri: this.callbackUri(),
    });
    return { url };
  }
  async callback(
    code: string,
    state: string,
    seller: SellerSession,
  ): Promise<{ tenant: Tenant }> {
    this.external();
    const pending = await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const row = await tx("oauth_states")
        .where({
          id: hash(state),
          user_id: seller.user.id,
          session_id: seller.sessionHash,
          redirect_uri: this.callbackUri(),
          used: 0,
        })
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(
        row,
        400,
        "oauth_state",
        "OAuth state is invalid, expired, or already used.",
      );
      await this.owner(tx, row.tenant_id, seller);
      await tx("oauth_states")
        .where({ id: row.id, used: 0 })
        .update({ used: 1 });
      return row;
    });
    const token = await this.stripe.oauth.token({
      grant_type: "authorization_code",
      code,
    });
    this.mode(token.livemode);
    check(
      token.stripe_user_id && token.scope === "read_write",
      400,
      "stripe_account",
      "A writable Standard Stripe account is required.",
    );
    const account = await this.stripe.accounts.retrieve(token.stripe_user_id);
    check(
      account.id === token.stripe_user_id && account.type === "standard",
      400,
      "stripe_account",
      "A verified Standard Stripe account is required.",
    );
    const tenant = await this.db.transaction(async (tx) => {
      await lock(tx, "billing");
      await this.owner(tx, pending.tenant_id, seller);
      const current = await tx<Tenant>("tenants")
        .where({ id: pending.tenant_id })
        .first();
      check(current, 404, "tenant_not_found", "Tenant was not found.");
      const bound = await tx("tenants")
        .where({ stripe_account_id: account.id })
        .whereNot({ id: current.id })
        .first();
      check(
        !bound,
        409,
        "stripe_account_conflict",
        "Stripe account already belongs to another tenant.",
      );
      check(
        !current.stripe_account_id || current.stripe_account_id === account.id,
        409,
        "stripe_account_immutable",
        "A connected Stripe account cannot be replaced. Reconnect the same account.",
      );
      await tx("tenants")
        .where({ id: current.id })
        .update({
          stripe_account_id: account.id,
          stripe_status: account.charges_enabled ? "connected" : "restricted",
        });
      await tx("audit_events").insert({
        id: randomUUID(),
        tenant_id: current.id,
        actor_type: "seller",
        actor_id: seller.user.id,
        action: "stripe.connected",
        details: JSON.stringify({ account: account.id }),
        created_at: Date.now(),
      });
      return {
        ...current,
        stripe_account_id: account.id,
        stripe_status: account.charges_enabled ? "connected" : "restricted",
      };
    });
    return { tenant };
  }
  async checkout(
    tenant: Tenant,
    seller: SellerSession,
    tier: "starter" | "pro" = "starter",
  ): Promise<{ url: string }> {
    this.external();
    check(
      tier === "starter" || tier === "pro",
      400,
      "platform_tier",
      "Choose a configured platform tier.",
    );
    const priceId =
      tier === "pro"
        ? this.config.platformProStripePriceId
        : this.priceIds()[0];
    check(
      priceId,
      503,
      "platform_price",
      "Platform subscription price is not configured.",
    );
    check(
      !this.config.platformProStripePriceId ||
        this.config.platformProStripePriceId !== this.priceIds()[0],
      409,
      "platform_price",
      "Starter and Pro must use distinct Stripe prices.",
    );
    const user = await this.owner(this.db, tenant.id, seller);
    const price = await this.stripe.prices.retrieve(priceId);
    this.mode(price.livemode);
    check(
      price.active && price.type === "recurring",
      409,
      "platform_price",
      "An active recurring platform price is required.",
    );
    if (tier === "pro") this.proPrice(price);
    await this.db.transaction(async (tx) => {
      await lock(tx, "billing");
      await this.owner(tx, tenant.id, seller);
      await this.rememberPrice(tx, tenant.id, priceId, tier);
    });
    const prices = await this.knownPrices(tenant.id);
    let current = await this.db<Tenant>("tenants")
      .where({ id: tenant.id })
      .first();
    check(current, 404, "tenant_not_found", "Tenant was not found.");
    if (!current.platform_customer_id) {
      // Tenant identity is committed before HTTP and supplies a stable retry key.
      const customer = await this.stripe.customers.create(
        { email: user.email },
        { idempotencyKey: `double-entitle-platform-customer-${current.id}` },
      );
      await this.db.transaction(async (tx) => {
        await lock(tx, "billing");
        await this.owner(tx, tenant.id, seller);
        const mapped = await tx("tenants")
          .where({ id: tenant.id })
          .andWhere((q) =>
            q
              .whereNull("platform_customer_id")
              .orWhere({ platform_customer_id: customer.id }),
          )
          .update({ platform_customer_id: customer.id });
        check(
          mapped,
          409,
          "platform_customer_conflict",
          "Platform customer mapping changed.",
        );
      });
      current = { ...current, platform_customer_id: customer.id };
    }
    const claim = await this.db.transaction(async (tx) => {
      await lock(tx, "billing");
      await this.owner(tx, tenant.id, seller);
      const latest = await tx<Tenant>("tenants")
        .where({ id: tenant.id })
        .first();
      check(
        latest?.platform_customer_id === current.platform_customer_id,
        409,
        "platform_customer_conflict",
        "Platform customer mapping changed.",
      );
      let guard = await tx<CheckoutGuard>("platform_checkouts")
        .where({ tenant_id: tenant.id })
        .first();
      check(
        !guard || guard.lease_until <= Date.now(),
        409,
        "platform_checkout_pending",
        "A platform checkout request is already in progress. Retry shortly.",
      );
      if (!guard) {
        guard = {
          tenant_id: tenant.id,
          id: randomUUID(),
          customer_id: latest.platform_customer_id!,
          price_id: priceId,
          session_id: null,
          attempted_at: null,
          lease_owner: null,
          lease_until: 0,
          created_at: Date.now(),
        };
        await tx("platform_checkouts").insert(guard);
      }
      check(
        guard.customer_id === latest.platform_customer_id,
        409,
        "platform_checkout_changed",
        "The pending platform checkout configuration changed. Contact the operator.",
      );
      const lease = {
        lease_owner: randomUUID(),
        lease_until: Date.now() + 300000,
      };
      await tx("platform_checkouts")
        .where({ tenant_id: tenant.id })
        .update(lease);
      return { tenant: latest, guard: { ...guard, ...lease } };
    });
    let guard: CheckoutGuard = claim.guard;
    try {
      const selected = await this.subscription(claim.tenant, prices);
      check(
        !selected || terminal(selected.status),
        409,
        "platform_subscription_exists",
        "To change tiers, cancel at period end in Platform billing, then choose the new tier after cancellation.",
      );
      // Detect an older active subscription as well, even if a newer terminal
      // subscription is currently stored or appears first in provider history.
      for await (const candidate of this.stripe.subscriptions.list({
        customer: guard.customer_id,
        status: "all",
        limit: 100,
      })) {
        if (
          providerId(candidate.customer) === guard.customer_id &&
          candidate.items.data.some((item) => prices.has(item.price.id))
        )
          check(
            terminal(candidate.status),
            409,
            "platform_subscription_exists",
            "To change tiers, cancel at period end in Platform billing, then choose the new tier after cancellation.",
          );
      }
      let session: Stripe.Checkout.Session | undefined = guard.session_id
        ? await this.stripe.checkout.sessions.retrieve(guard.session_id)
        : undefined;
      if (!session && guard.attempted_at !== null) {
        for await (const candidate of this.stripe.checkout.sessions.list({
          customer: guard.customer_id,
          limit: 100,
        }))
          if (candidate.client_reference_id === guard.id) {
            session = candidate;
            break;
          }
      }
      if (session) {
        this.mode(session.livemode);
        check(
          providerId(session.customer) === guard.customer_id &&
            session.mode === "subscription",
          409,
          "platform_customer_conflict",
          "Checkout belongs to another platform customer.",
        );
        if (session.status === "open") {
          check(
            guard.price_id === priceId,
            409,
            "platform_checkout_changed",
            "Finish or expire the open Checkout before changing tiers.",
          );
          guard = await this.checkoutWrite(guard, claim.tenant, seller, {
            session_id: session.id,
          });
          check(
            session.url,
            502,
            "stripe_session",
            "Stripe did not return a checkout URL.",
          );
          return { url: session.url };
        }
        if (session.status === "complete") {
          const subscriptionId = providerId(session.subscription);
          check(
            subscriptionId,
            409,
            "platform_checkout_pending",
            "Checkout completion is awaiting provider reconciliation.",
          );
          const completed =
            await this.stripe.subscriptions.retrieve(subscriptionId);
          this.mode(completed.livemode);
          check(
            providerId(completed.customer) === guard.customer_id,
            409,
            "platform_customer_conflict",
            "Checkout subscription belongs to another customer.",
          );
          check(
            terminal(completed.status),
            409,
            "platform_subscription_exists",
            "To change tiers, cancel at period end in Platform billing, then choose the new tier after cancellation.",
          );
        } else
          check(
            session.status === "expired",
            409,
            "platform_checkout_pending",
            "Checkout status is awaiting provider reconciliation.",
          );
        guard = await this.checkoutWrite(guard, claim.tenant, seller, {
          id: randomUUID(),
          price_id: priceId,
          session_id: null,
          attempted_at: null,
          created_at: Date.now(),
        });
      }
      if (guard.price_id !== priceId) {
        check(
          guard.attempted_at === null,
          409,
          "platform_checkout_pending",
          "Reconcile the earlier Checkout attempt before changing tiers.",
        );
        guard = await this.checkoutWrite(guard, claim.tenant, seller, {
          id: randomUUID(),
          price_id: priceId,
          created_at: Date.now(),
        });
      }
      check(
        guard.attempted_at === null ||
          Date.now() - Number(guard.attempted_at) < 23 * 3600000,
        409,
        "platform_checkout_pending",
        "An earlier checkout response is unresolved. Contact the operator before creating another subscription.",
      );
      if (
        guard.attempted_at !== null &&
        Math.floor(Number(guard.attempted_at) / 1000) + 5 * 60 <=
          Math.floor(Date.now() / 1000)
      ) {
        // Only reached after a complete canonical scan found no session. The
        // persisted expiry is now too close for Stripe's 30-minute minimum.
        // Rotate both key and timestamp under the current lease so a fresh
        // create never changes the parameters of an earlier idempotency key.
        // Unknown sessions, failed scans and attempts >=23h stay fail-closed.
        guard = await this.checkoutWrite(guard, claim.tenant, seller, {
          id: randomUUID(),
          attempted_at: null,
          created_at: Date.now(),
        });
      }
      guard = await this.checkoutWrite(guard, claim.tenant, seller, {
        attempted_at: guard.attempted_at ?? Date.now(),
      });
      const created = await this.stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: guard.customer_id,
          client_reference_id: guard.id,
          line_items: [{ price: guard.price_id, quantity: 1 }],
          success_url: appUrl(this.config, "/seller?billing=success"),
          cancel_url: appUrl(this.config, "/seller?billing=canceled"),
          allow_promotion_codes: false,
          // Persisted attempt time keeps retries byte-identical for Stripe's
          // idempotency key. Allow five minutes beyond its 30-minute minimum.
          expires_at: Math.floor(Number(guard.attempted_at) / 1000) + 35 * 60,
        },
        {
          idempotencyKey: `double-entitle-platform-checkout-${guard.tenant_id}-${guard.id}`,
        },
      );
      check(
        created.id,
        502,
        "stripe_session",
        "Stripe did not return a checkout session ID.",
      );
      guard = await this.checkoutWrite(guard, claim.tenant, seller, {
        session_id: created.id,
      });
      check(
        created.url,
        502,
        "stripe_session",
        "Stripe did not return a checkout URL.",
      );
      return { url: created.url };
    } finally {
      await this.db("platform_checkouts")
        .where({
          tenant_id: guard.tenant_id,
          id: guard.id,
          lease_owner: guard.lease_owner,
        })
        .update({ lease_owner: null, lease_until: 0 });
    }
  }
  private async checkoutWrite(
    guard: CheckoutGuard,
    tenant: Tenant,
    seller: SellerSession,
    update: Partial<CheckoutGuard>,
  ): Promise<CheckoutGuard> {
    await this.db.transaction(async (tx) => {
      await lock(tx, "billing");
      await this.owner(tx, tenant.id, seller);
      const current = await tx<Tenant>("tenants")
        .where({ id: tenant.id })
        .first();
      check(
        current?.platform_customer_id === guard.customer_id &&
          current.platform_subscription_id === tenant.platform_subscription_id,
        409,
        "platform_checkout_changed",
        "Platform billing changed while preparing checkout. Retry after reconciliation.",
      );
      const written = await tx("platform_checkouts")
        .where({
          tenant_id: guard.tenant_id,
          id: guard.id,
          lease_owner: guard.lease_owner,
        })
        .andWhere("lease_until", ">", Date.now())
        .update({ ...update, lease_until: Date.now() + 300000 });
      check(
        written,
        409,
        "platform_checkout_pending",
        "Checkout ownership changed. Retry after reconciliation.",
      );
    });
    return { ...guard, ...update };
  }

  async portal(tenant: Tenant): Promise<{ url: string }> {
    this.external();
    const current = await this.db<Tenant>("tenants")
      .where({ id: tenant.id })
      .first();
    check(
      current?.platform_customer_id,
      409,
      "platform_customer_missing",
      "Start a platform subscription before opening billing.",
    );
    const configuration = await this.safePortalConfiguration();
    const session = await this.stripe.billingPortal.sessions.create({
      configuration,
      customer: current.platform_customer_id,
      return_url: appUrl(this.config, "/seller"),
    });
    return { url: session.url };
  }
  private async safePortalConfiguration(): Promise<string> {
    const returnUrl = appUrl(this.config, "/seller");
    if (this.portalConfigurationReturnUrl !== returnUrl) {
      this.portalConfigurationId = undefined;
      this.portalConfigurationReturnUrl = returnUrl;
    }
    if (!this.portalConfigurationId) {
      // Provider metadata and return URL identify this deployment's dedicated
      // policy across restarts, beyond create's idempotency retention window.
      // Exhaust pagination before creating; any failed read aborts the opening.
      for await (const candidate of this.stripe.billingPortal.configurations.list(
        {
          active: true,
          limit: 100,
        },
      )) {
        if (
          candidate.active &&
          !candidate.is_default &&
          candidate.livemode === (this.config.stripeLiveMode ?? false) &&
          candidate.metadata?.double_entitle_policy === "period_end_v1" &&
          candidate.default_return_url === returnUrl
        ) {
          this.portalConfigurationId = candidate.id;
          break;
        }
      }
    }
    if (!this.portalConfigurationId) {
      const created = await this.stripe.billingPortal.configurations.create(
        {
          features: {
            customer_update: { enabled: false },
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: {
              enabled: true,
              mode: "at_period_end",
              proration_behavior: "none",
            },
            subscription_update: { enabled: false },
          },
          login_page: { enabled: false },
          default_return_url: returnUrl,
          metadata: { double_entitle_policy: "period_end_v1" },
        },
        {
          idempotencyKey: `double-entitle-safe-portal-v1-${hash(
            `${this.config.origin}${normalizeAppBasePath(this.config.appBasePath)}`,
          )}`,
        },
      );
      check(
        created.id,
        502,
        "platform_portal_configuration",
        "Stripe did not return a portal configuration.",
      );
      this.portalConfigurationId = created.id;
    }
    // Always reread: create's idempotency response can predate a Dashboard edit.
    // Never fall back to the account's default portal or allow price switching.
    const configuration =
      await this.stripe.billingPortal.configurations.retrieve(
        this.portalConfigurationId,
      );
    this.mode(configuration.livemode);
    const features = configuration.features;
    check(
      configuration.id === this.portalConfigurationId &&
        configuration.active &&
        !configuration.is_default &&
        configuration.metadata?.double_entitle_policy === "period_end_v1" &&
        configuration.default_return_url === returnUrl &&
        !configuration.login_page.enabled &&
        features.subscription_update.enabled === false &&
        features.subscription_cancel.enabled === true &&
        features.subscription_cancel.mode === "at_period_end" &&
        features.subscription_cancel.proration_behavior === "none",
      409,
      "platform_portal_configuration",
      "Platform billing requires a dedicated portal with price switching disabled and period-end cancellation without prorations.",
    );
    return configuration.id;
  }
  private async subscription(
    tenant: Tenant,
    prices: Map<string, PlatformTier>,
  ): Promise<Stripe.Subscription | undefined> {
    let current: Stripe.Subscription | undefined =
      tenant.platform_subscription_id
        ? await this.stripe.subscriptions.retrieve(
            tenant.platform_subscription_id,
          )
        : undefined;
    if (current) {
      this.mode(current.livemode);
      check(
        providerId(current.customer) === tenant.platform_customer_id,
        409,
        "platform_customer_conflict",
        "Subscription belongs to another platform customer.",
      );
      if (!terminal(current.status)) return current;
    }
    let selected = current;
    for await (const candidate of this.stripe.subscriptions.list({
      customer: tenant.platform_customer_id!,
      status: "all",
      limit: 100,
    })) {
      if (
        providerId(candidate.customer) === tenant.platform_customer_id &&
        candidate.items.data.some((item) => prices.has(item.price.id)) &&
        (!selected ||
          (candidate.created ?? 0) > (selected.created ?? 0) ||
          ((candidate.created ?? 0) === (selected.created ?? 0) &&
            candidate.id !== selected.id &&
            terminal(selected.status) &&
            !terminal(candidate.status)))
      )
        selected = candidate;
    }
    if (selected && selected.id !== current?.id) {
      current = await this.stripe.subscriptions.retrieve(selected.id);
      this.mode(current.livemode);
      check(
        providerId(current.customer) === tenant.platform_customer_id,
        409,
        "platform_customer_conflict",
        "Subscription belongs to another platform customer.",
      );
    }
    return current;
  }
  private priceIds() {
    return [this.config.platformPriceId, this.config.platformProStripePriceId];
  }
  private async rememberPrice(
    tx: Tx,
    tenantId: string,
    priceId: string,
    tier: PlatformTier,
  ) {
    const key = {
      tenant_id: tenantId,
      livemode: Number(this.config.stripeLiveMode ?? false),
      price_id: priceId,
    };
    await tx("platform_price_history")
      .insert({ ...key, tier, verified_at: Date.now() })
      .onConflict(["tenant_id", "livemode", "price_id"])
      .ignore();
    const stored = await tx<PriceHistory>("platform_price_history")
      .where(key)
      .first();
    check(
      stored?.tier === tier,
      409,
      "platform_price_history",
      "An established platform price cannot change tiers.",
    );
  }
  private async knownPrices(
    tenantId: string,
  ): Promise<Map<string, PlatformTier>> {
    const prices = new Map<string, PlatformTier>();
    if (this.config.platformPriceId)
      prices.set(this.config.platformPriceId, "starter");
    if (
      this.config.platformProStripePriceId &&
      !prices.has(this.config.platformProStripePriceId)
    )
      prices.set(this.config.platformProStripePriceId, "pro");
    const history = await this.db<PriceHistory>("platform_price_history").where(
      {
        tenant_id: tenantId,
        livemode: Number(this.config.stripeLiveMode ?? false),
      },
    );
    for (const entry of history) prices.set(entry.price_id, entry.tier);
    const established = new Set(history.map((entry) => entry.price_id));
    const legacy = await this.db<PlatformGrant>("platform_grants")
      .where({ tenant_id: tenantId })
      .distinct("price_id", "tier");
    for (const grant of legacy) {
      if (established.has(grant.price_id)) continue;
      // Existing grants establish the tier, never the mode. An actual provider
      // price read proves mode; archival and current list price are irrelevant.
      const price = await this.stripe.prices.retrieve(grant.price_id);
      this.mode(price.livemode);
      await this.db.transaction(async (tx) => {
        await lock(tx, "billing");
        await this.rememberPrice(tx, tenantId, grant.price_id, grant.tier);
      });
      prices.set(grant.price_id, grant.tier);
    }
    return prices;
  }
  private proPrice(price: Stripe.Price) {
    this.mode(price.livemode);
    check(
      price.active &&
        price.type === "recurring" &&
        price.recurring?.interval === "month" &&
        price.recurring.interval_count === 1 &&
        (price.unit_amount ?? 0) > 0,
      409,
      "platform_price",
      "Pro requires an active paid monthly recurring Stripe price.",
    );
  }
  private async workerEvidence(tenantId: string, turn: WorkerTurn) {
    const identity = hash(
      JSON.stringify([
        tenantId,
        this.config.stripeSecret,
        this.config.stripeLiveMode ?? false,
        this.priceIds(),
        this.config.graceDays ?? 7,
        this.config.paidMaxProducts ?? 20,
        this.config.paidStorageBytes ?? 1024 ** 3,
      ]),
    );
    let state = await turn.state<PlatformScan | null>(platformSlot, null);
    if (state) turn.array(state.prices);
    const tenant = await this.db<PlatformTenant>("tenants")
      .where({ id: tenantId })
      .first();
    check(tenant, 404, "tenant_not_found", "Tenant was not found.");
    if (
      state &&
      (state.identity !== identity ||
        state.revision !== Number(tenant.platform_billing_revision) ||
        state.tenant.platform_customer_id !== tenant.platform_customer_id ||
        (state.tenant.platform_subscription_id !==
          tenant.platform_subscription_id &&
          state.selected?.id !== tenant.platform_subscription_id))
    ) {
      await turn.reset(platformSlot);
      throw new DeferredJob(Date.now() + 1000);
    }
    const save = async (
      tasks: PlatformTask[] = [],
      facts: WorkerFact[] = [],
    ) => {
      const queued = new Set<string>();
      for (const task of tasks) {
        const id = hash(JSON.stringify(task));
        if (queued.has(id) || (await turn.fact(platformSlot, "queued", id)))
          continue;
        queued.add(id);
        facts.push({ kind: "task", id: String(state!.tail++), value: task });
        facts.push({ kind: "queued", id, value: true });
      }
      await turn.save(platformSlot, state, facts, state!.phase === "ready");
    };
    if (!state) {
      const revision = tenant.platform_customer_id
        ? await this.db.transaction(async (tx) => {
            await lock(tx, "billing");
            await assertQueueLease(tx);
            await tx("tenants")
              .where({ id: tenantId })
              .increment("platform_billing_revision", 1);
            return Number(
              (await tx("tenants").where({ id: tenantId }).first())
                .platform_billing_revision,
            );
          })
        : Number(tenant.platform_billing_revision);
      const prices = new Map<string, PlatformTier>();
      if (this.config.platformPriceId)
        prices.set(this.config.platformPriceId, "starter");
      if (
        this.config.platformProStripePriceId &&
        !prices.has(this.config.platformProStripePriceId)
      )
        prices.set(this.config.platformProStripePriceId, "pro");
      const history = await turn.rows<PriceHistory>(this.db<PriceHistory>(
        "platform_price_history",
      ).where({
        tenant_id: tenantId,
        livemode: Number(this.config.stripeLiveMode ?? false),
      }));
      for (const entry of history) prices.set(entry.price_id, entry.tier);
      const established = new Set(history.map((entry) => entry.price_id));
      const legacy = await turn.rows<PlatformGrant>(this.db<PlatformGrant>("platform_grants")
        .where({ tenant_id: tenantId })
        .select("price_id", "tier"));
      state = {
        identity,
        tenant,
        revision,
        prices: [...prices],
        phase: "selection",
        head: 0,
        tail: 0,
      };
      if (tenant.platform_customer_id)
        await save([
          ...legacy
            .filter((grant) => !established.has(grant.price_id))
            .map((grant) => ({
              kind: "price" as const,
              id: grant.price_id,
              tier: grant.tier,
            })),
          tenant.platform_subscription_id
            ? { kind: "current", id: tenant.platform_subscription_id }
            : { kind: "subscriptions" },
        ]);
      else {
        state.phase = "ready";
        await save();
      }
    }
    const next = (
      task: PlatformTask,
      page: { data: { id: string }[]; has_more: boolean },
    ) => {
      if (!page.has_more) return [];
      const after = page.data.at(-1)?.id;
      check(
        after && after !== task.after,
        502,
        "platform_pagination",
        "Provider pagination did not advance.",
      );
      return [{ ...task, after }];
    };
    while (state.phase !== "ready") {
      if (state.head === state.tail) {
        if (state.phase === "selection" && state.selected) {
          state.phase = "evidence";
          const stored = await turn.rows<PlatformGrant>(this.db<PlatformGrant>("platform_grants")
            .where({ tenant_id: tenantId })
            .select("subscription_id"));
          await save(
            [
              ...new Set([
                state.selected.id,
                ...stored.map((grant) => grant.subscription_id),
              ]),
            ].map((id) => ({ kind: "invoices", id })),
          );
          continue;
        }
        state.phase = "ready";
        await save();
        break;
      }
      const task = await turn.fact<PlatformTask>(
        platformSlot,
        "task",
        String(state.head),
      );
      check(
        task,
        500,
        "platform_checkpoint",
        "Platform worker checkpoint is incomplete.",
      );
      const facts: WorkerFact[] = [];
      let tasks: PlatformTask[] = [];
      const page = {
        limit: 100,
        ...(task.after ? { starting_after: task.after } : {}),
      };
      switch (task.kind) {
        case "price": {
          const price = await turn.read(async (options) =>
            this.stripe.prices.retrieve(task.id!, {}, options),
          );
          this.mode(price.livemode);
          await this.db.transaction(async (tx) => {
            await lock(tx, "billing");
            await assertQueueLease(tx);
            await this.rememberPrice(tx, tenantId, task.id!, task.tier!);
          });
          const prices = new Map(state.prices);
          prices.set(task.id!, task.tier!);
          state.prices = [...prices];
          turn.array(state.prices);
          break;
        }
        case "current":
        case "selected": {
          const sub = await turn.read(async (options) =>
            this.stripe.subscriptions.retrieve(task.id!, {}, options),
          );
          this.mode(sub.livemode);
          check(
            providerId(sub.customer) === state.tenant.platform_customer_id,
            409,
            "platform_customer_conflict",
            "Subscription belongs to another platform customer.",
          );
          state.selected = subscriptionFact(sub);
          if (task.kind === "current") {
            state.current = state.selected;
            if (terminal(sub.status)) tasks.push({ kind: "subscriptions" });
          }
          break;
        }
        case "subscriptions": {
          const result = await turn.read(async (options) =>
            this.stripe.subscriptions.list(
              {
                customer: state.tenant.platform_customer_id!,
                status: "all",
                ...page,
              },
              options,
            ),
          );
          const prices = new Map(state.prices);
          for (const candidate of result.data) {
            const selected = state.selected;
            if (
              providerId(candidate.customer) ===
                state.tenant.platform_customer_id &&
              candidate.items.data.some((item) => prices.has(item.price.id)) &&
              (!selected ||
                (candidate.created ?? 0) > (selected.created ?? 0) ||
                ((candidate.created ?? 0) === (selected.created ?? 0) &&
                  candidate.id !== selected.id &&
                  terminal(selected.status) &&
                  !terminal(candidate.status)))
            )
              state.selected = subscriptionFact(candidate);
          }
          tasks = next(task, result);
          if (
            !result.has_more &&
            state.selected &&
            state.selected.id !== state.current?.id
          )
            tasks.push({ kind: "selected", id: state.selected.id });
          break;
        }
        case "invoices": {
          const result = await turn.read(async (options) =>
            this.stripe.invoices.list(
              { subscription: task.id!, ...page },
              options,
            ),
          );
          tasks = next(task, result);
          for (const invoice of result.data) {
            this.mode(invoice.livemode);
            if (
              providerId(invoice.customer) !==
                state.tenant.platform_customer_id ||
              providerId(invoice.parent?.subscription_details?.subscription) !==
                task.id
            )
              continue;
            facts.push({
              kind: "invoice",
              id: invoice.id,
              value: { invoice: invoiceFact(invoice), subscriptionId: task.id },
            });
            if (invoice.status !== "paid") continue;
            if (
              invoice.amount_paid > 0 ||
              (invoice.total !== undefined &&
                invoice.amount_due === 0 &&
                invoice.amount_remaining === 0)
            )
              tasks.push({ kind: "lines", id: invoice.id });
            if (invoice.amount_paid > 0)
              tasks.push({ kind: "payments", id: invoice.id });
            else if (
              invoice.total > 0 &&
              invoice.amount_due === 0 &&
              invoice.amount_remaining === 0
            )
              tasks.push({ kind: "balances", id: invoice.id });
          }
          break;
        }
        case "lines": {
          const result = await turn.read(async (options) =>
            this.stripe.invoices.listLineItems(task.id!, page, options),
          );
          tasks = next(task, result);
          for (const line of result.data)
            facts.push({
              kind: "line",
              id: hash(JSON.stringify([task.id, line.id])),
              value: { invoiceId: task.id, line: lineFact(line) },
            });
          break;
        }
        case "payments": {
          const result = await turn.read(async (options) =>
            this.stripe.invoicePayments.list(
              { invoice: task.id!, status: "paid", ...page },
              options,
            ),
          );
          tasks = next(task, result);
          for (const payment of result.data) {
            const intent = providerId(payment.payment.payment_intent);
            const charge = providerId(payment.payment.charge);
            if (intent)
              tasks.push({ kind: "charges", invoiceId: task.id!, id: intent });
            else if (charge)
              tasks.push({ kind: "charge", invoiceId: task.id!, id: charge });
          }
          break;
        }
        case "charges":
        case "charge": {
          const result =
            task.kind === "charges"
              ? await turn.read(async (options) =>
                  this.stripe.charges.list(
                    { payment_intent: task.id!, ...page },
                    options,
                  ),
                )
              : {
                  data: [
                    await turn.read(async (options) =>
                      this.stripe.charges.retrieve(task.id!, {}, options),
                    ),
                  ],
                  has_more: false,
                };
          tasks = next(task, result);
          for (const charge of result.data) {
            this.mode(charge.livemode);
            facts.push({
              kind: "charge",
              id: hash(JSON.stringify([task.invoiceId, charge.id])),
              value: {
                invoiceId: task.invoiceId!,
                id: charge.id,
                paid: charge.paid,
                refunded: charge.amount_refunded,
                disputed: charge.disputed,
              } satisfies PlatformChargeFact,
            });
            if (charge.paid && charge.disputed)
              tasks.push({
                kind: "disputes",
                invoiceId: task.invoiceId!,
                id: charge.id,
              });
          }
          break;
        }
        case "disputes": {
          const result = await turn.read(async (options) =>
            this.stripe.disputes.list({ charge: task.id!, ...page }, options),
          );
          tasks = next(task, result);
          for (const dispute of result.data)
            facts.push({
              kind: "dispute",
              id: hash(JSON.stringify([task.invoiceId, task.id, dispute.id])),
              value: {
                invoiceId: task.invoiceId,
                chargeId: task.id,
                status: dispute.status,
              },
            });
          break;
        }
        case "balances": {
          const result = await turn.read(async (options) =>
            this.stripe.customers.listBalanceTransactions(
              state.tenant.platform_customer_id!,
              page,
              options,
            ),
          );
          tasks = next(task, result);
          const invoice = await turn.fact<{ invoice: Stripe.Invoice }>(
            platformSlot,
            "invoice",
            task.id!,
          );
          check(
            invoice,
            500,
            "platform_checkpoint",
            "Platform invoice checkpoint is incomplete.",
          );
          for (const transaction of result.data) {
            if (
              providerId(transaction.customer) !==
                state.tenant.platform_customer_id ||
              providerId(transaction.invoice) !== task.id ||
              transaction.currency !== invoice.invoice.currency
            )
              continue;
            this.mode(transaction.livemode);
            if (
              ["applied_to_invoice", "unapplied_from_invoice"].includes(
                transaction.type,
              )
            )
              facts.push({
                kind: "balance",
                id: hash(JSON.stringify([task.id, transaction.id])),
                value: { invoiceId: task.id, amount: transaction.amount },
              });
          }
          break;
        }
      }
      state.head++;
      await save(tasks, facts);
    }
    turn.beginApply();
    const invoices = await turn.facts<{
      invoice: Stripe.Invoice;
      subscriptionId: string;
    }>(platformSlot, "invoice");
    const lines = await turn.facts<{
      invoiceId: string;
      line: Stripe.InvoiceLineItem;
    }>(platformSlot, "line");
    const charges = await turn.facts<PlatformChargeFact>(
      platformSlot,
      "charge",
    );
    const disputes = await turn.facts<{
      invoiceId: string;
      chargeId: string;
      status: string;
    }>(platformSlot, "dispute");
    const balances = await turn.facts<{ invoiceId: string; amount: number }>(
      platformSlot,
      "balance",
    );
    const group = <T>(values: T[], key: (value: T) => string) => {
      turn.work(values.length);
      const result = new Map<string, T[]>();
      for (const value of values) {
        turn.work();
        const id = key(value);
        const entries = result.get(id) ?? [];
        entries.push(value);
        result.set(id, entries);
      }
      return result;
    };
    const invoiceLines = group(lines, (line) => line.invoiceId);
    const invoiceCharges = group(
      charges.filter((charge) => charge.paid),
      (charge) => charge.invoiceId,
    );
    const chargeDisputes = group(disputes, (dispute) =>
      JSON.stringify([dispute.invoiceId, dispute.chargeId]),
    );
    const invoiceBalances = group(balances, (balance) => balance.invoiceId);
    const evidence: PlatformEvidence[] = invoices.map((entry) => {
      turn.work();
      const paidCharges = invoiceCharges.get(entry.invoice.id) ?? [];
      turn.work(paidCharges.length + (invoiceLines.get(entry.invoice.id)?.length ?? 0) +
        (invoiceBalances.get(entry.invoice.id)?.length ?? 0));
      const refunded = paidCharges.reduce(
        (sum, charge) => sum + charge.refunded,
        0,
      );
      const disputed = paidCharges.some((charge) => {
        turn.work();
        if (!charge.disputed) return false;
        const found =
          chargeDisputes.get(JSON.stringify([entry.invoice.id, charge.id])) ??
          [];
        turn.work(found.length);
        return (
          !found.length ||
          found.some(
            (dispute) => !["won", "warning_closed"].includes(dispute.status),
          )
        );
      });
      return {
        ...entry,
        lines: (invoiceLines.get(entry.invoice.id) ?? []).map(
          (line) => line.line,
        ),
        cashRevoked:
          disputed ||
          (refunded > 0 &&
            refunded >=
              Math.max(entry.invoice.amount_paid, entry.invoice.total ?? 0)),
        creditApplied: (invoiceBalances.get(entry.invoice.id) ?? []).reduce(
          (sum, balance) => sum + balance.amount,
          0,
        ),
      };
    });
    return {
      tenant: state.tenant,
      revision: state.revision,
      prices: new Map(state.prices),
      sub: state.selected,
      evidence,
    };
  }
  private async invoiceRevoked(invoice: Stripe.Invoice): Promise<boolean> {
    let refunded = 0,
      disputed = false;
    const seen = new Set<string>();
    for await (const payment of this.stripe.invoicePayments.list({
      invoice: invoice.id,
      status: "paid",
      limit: 100,
    })) {
      const charges: Stripe.Charge[] = [];
      const intent = providerId(payment.payment.payment_intent);
      if (intent)
        for await (const charge of this.stripe.charges.list({
          payment_intent: intent,
          limit: 100,
        }))
          charges.push(charge);
      else if (payment.payment.charge)
        charges.push(
          await this.stripe.charges.retrieve(
            providerId(payment.payment.charge)!,
          ),
        );
      for (const charge of charges) {
        if (!charge.paid || seen.has(charge.id)) continue;
        seen.add(charge.id);
        refunded += charge.amount_refunded;
        if (charge.disputed) {
          let found = false;
          for await (const dispute of this.stripe.disputes.list({
            charge: charge.id,
            limit: 100,
          })) {
            found = true;
            if (!["won", "warning_closed"].includes(dispute.status))
              disputed = true;
          }
          if (!found) disputed = true;
        }
      }
    }
    return (
      disputed ||
      (refunded > 0 &&
        refunded >= Math.max(invoice.amount_paid, invoice.total ?? 0))
    );
  }
  private creditedGrants(
    line: Stripe.InvoiceLineItem,
    subscriptionId: string,
    grants: Map<string, PlatformGrant>,
  ): PlatformGrant[] {
    const details = line.parent?.subscription_item_details;
    const credited = details?.proration_details?.credited_items;
    if (line.amount >= 0 || !details?.proration || !credited) return [];
    workerTurn()?.work(grants.size * Math.max(1, credited.invoice_line_items.length) + grants.size);
    const priceId = providerId(line.pricing?.price_details?.price);
    return [...grants.values()].filter(
      (grant) =>
        !grant.revoked &&
        grant.subscription_id === subscriptionId &&
        grant.invoice_id === credited.invoice &&
        credited.invoice_line_items.includes(grant.id) &&
        grant.price_id === priceId &&
        grant.period_start <= line.period.start * 1000 &&
        grant.period_end >= line.period.end * 1000 &&
        line.period.end > line.period.start,
    );
  }
  private async creditPaid(
    invoice: Stripe.Invoice,
    lines: Stripe.InvoiceLineItem[],
    subscriptionId: string,
    prices: Map<string, PlatformTier>,
    grants: Map<string, PlatformGrant>,
    appliedBalance?: number,
  ): Promise<boolean> {
    workerTurn()?.work(lines.length * 2);
    const positive = lines
      .filter(
        (line) =>
          line.amount > 0 &&
          prices.has(providerId(line.pricing?.price_details?.price)!) &&
          line.parent?.subscription_item_details,
      )
      .reduce((sum, line) => sum + line.amount, 0);
    if (!positive || invoice.amount_due !== 0 || invoice.amount_remaining !== 0)
      return false;
    if (invoice.total > 0) {
      if (appliedBalance !== undefined) return appliedBalance >= invoice.total;
      // This proves application, not the original cash provenance of the
      // customer's credit. Refund/dispute operations must inspect and remove
      // reusable credit, including proration/credit-note credit. Clearing a
      // remaining balance alone cannot revoke credit already spent on service.
      let applied = 0;
      for await (const transaction of this.stripe.customers.listBalanceTransactions(
        providerId(invoice.customer)!,
        { limit: 100 },
      )) {
        if (
          providerId(transaction.customer) !== providerId(invoice.customer) ||
          providerId(transaction.invoice) !== invoice.id ||
          transaction.currency !== invoice.currency
        )
          continue;
        this.mode(transaction.livemode);
        if (
          ["applied_to_invoice", "unapplied_from_invoice"].includes(
            transaction.type,
          )
        )
          applied += transaction.amount;
      }
      return applied >= invoice.total;
    }
    const returned = lines
      .filter(
        (line) => this.creditedGrants(line, subscriptionId, grants).length > 0,
      )
      .reduce((sum, line) => sum - line.amount, 0);
    return returned >= positive;
  }
  async reconcile(tenantId: string): Promise<void> {
    this.external();
    const turn = workerTurn();
    const collected = turn
      ? await this.workerEvidence(tenantId, turn)
      : undefined;
    const tenant =
      collected?.tenant ??
      (await this.db<PlatformTenant>("tenants")
        .where({ id: tenantId })
        .first());
    check(tenant, 404, "tenant_not_found", "Tenant was not found.");
    if (!tenant.platform_customer_id) return;
    // Claim before HTTP. A newer canonical snapshot owns the write even when an
    // older event's HTTP response arrives last. Provider calls never hold locks.
    const revision =
      collected?.revision ??
      (await this.db.transaction(async (tx) => {
        await lock(tx, "billing");
        await assertQueueLease(tx);
        await tx("tenants")
          .where({ id: tenantId })
          .increment("platform_billing_revision", 1);
        return Number(
          (await tx("tenants").where({ id: tenantId }).first())
            .platform_billing_revision,
        );
      }));
    const prices = collected?.prices ?? (await this.knownPrices(tenantId));
    const sub = collected
      ? collected.sub
      : await this.subscription(tenant, prices);
    if (!sub) return;
    const subscriptionId = sub.id;
    const storedQuery = this.db<PlatformGrant>("platform_grants").where({
      tenant_id: tenantId,
    });
    const stored = turn ? await turn.rows<PlatformGrant>(storedQuery) : await storedQuery;
    turn?.records(prices.size);
    turn?.work(stored.length);
    const subscriptions = new Set([
      subscriptionId,
      ...stored.map((g) => g.subscription_id),
    ]);
    const grants = new Map<string, PlatformGrant>();
    const evidence: PlatformEvidence[] = collected?.evidence ?? [];
    if (!collected)
      for (const selected of subscriptions) {
        for await (const invoice of this.stripe.invoices.list({
          subscription: selected,
          limit: 100,
        })) {
          this.mode(invoice.livemode);
          if (
            providerId(invoice.customer) !== tenant.platform_customer_id ||
            providerId(invoice.parent?.subscription_details?.subscription) !==
              selected
          )
            continue;
          const lines: Stripe.InvoiceLineItem[] = [];
          if (
            invoice.status === "paid" &&
            (invoice.amount_paid > 0 ||
              (invoice.total !== undefined &&
                invoice.amount_due === 0 &&
                invoice.amount_remaining === 0))
          )
            for await (const line of this.stripe.invoices.listLineItems(
              invoice.id,
              { limit: 100 },
            ))
              lines.push(line);
          evidence.push({ invoice, subscriptionId: selected, lines });
        }
      }
    // Cash settlements first. Credit-only invoices may refer to their original
    // paid debits, including debits returned later by the paginated invoice API.
    turn?.work(evidence.length * Math.max(1, Math.ceil(Math.log2(evidence.length + 1))));
    evidence.sort(
      (a, b) =>
        Number(b.invoice.amount_paid > 0) - Number(a.invoice.amount_paid > 0) ||
        a.invoice.created - b.invoice.created,
    );
    const canonical = new Map(stored.map((grant) => [grant.id, grant]));
    const qualificationStarts = new Map<string, number>();
    for (const { invoice } of evidence) {
      turn?.work(stored.length);
      for (const previous of stored.filter(
        (grant) => grant.invoice_id === invoice.id,
      ))
        canonical.set(previous.id, { ...previous, revoked: 1 });
    }
    for (const {
      invoice,
      subscriptionId: selected,
      lines,
      cashRevoked,
      creditApplied,
    } of evidence) {
      turn?.work(1 + stored.length + lines.length);
      const paid =
        invoice.status === "paid" &&
        (invoice.amount_paid > 0 ||
          (await this.creditPaid(
            invoice,
            lines,
            selected,
            prices,
            canonical,
            creditApplied,
          )));
      const revoked =
        !paid ||
        (invoice.amount_paid > 0 &&
          (cashRevoked ?? (await this.invoiceRevoked(invoice))));
      for (const previous of stored.filter(
        (grant) => grant.invoice_id === invoice.id,
      )) {
        const updated = { ...previous, revoked: Number(revoked) };
        grants.set(updated.id, updated);
        canonical.set(updated.id, updated);
      }
      if (!paid) continue;
      for (const line of lines) {
        turn?.work();
        const priceId = providerId(line.pricing?.price_details?.price);
        if (
          line.amount <= 0 ||
          !line.parent?.subscription_item_details ||
          !priceId ||
          !prices.has(priceId) ||
          line.period.end <= line.period.start
        )
          continue;
        const grant: PlatformGrant = {
          tenant_id: tenantId,
          id: line.id,
          subscription_id: selected,
          invoice_id: invoice.id,
          price_id: priceId,
          tier: prices.get(priceId)!,
          period_start: line.period.start * 1000,
          period_end: line.period.end * 1000,
          revoked: Number(revoked),
        };
        grants.set(line.id, grant);
        canonical.set(line.id, grant);
        const paidAt = (invoice.status_transitions?.paid_at ?? 0) * 1000;
        // A delayed payment cannot backfill an expired grace window, including
        // rows the bounded worker never scanned. Keep canonical grant dates;
        // only business-event qualification restarts at the late payment.
        if (
          paidAt >=
          grant.period_start + (this.config.graceDays ?? 7) * 86400000
        )
          qualificationStarts.set(grant.id, paidAt);
      }
    }
    // Returning unused service as a linked proration credit ends that service
    // at the returned interval's start. Ordinary cancellation keeps paid time.
    for (const { invoice, subscriptionId: selected, lines } of evidence) {
      turn?.work(1 + lines.length);
      if (invoice.status !== "paid") continue;
      for (const line of lines)
        for (const original of this.creditedGrants(line, selected, canonical)) {
          turn?.work();
          const updated = {
            ...original,
            period_end: Math.min(
              (grants.get(original.id) ?? original).period_end,
              line.period.start * 1000,
            ),
          };
          grants.set(updated.id, updated);
        }
    }
    let obsolete = false;
    await this.db.transaction(async (tx) => {
      await turn?.prepareTransaction(tx);
      await lock(tx, "billing");
      await assertQueueLease(tx);
      const current = await tx<PlatformTenant>("tenants")
        .where({ id: tenantId })
        .first();
      if (Number(current?.platform_billing_revision) !== revision) {
        obsolete = true;
        return;
      }
      check(
        current?.platform_customer_id === tenant.platform_customer_id &&
          (current.platform_subscription_id ===
            tenant.platform_subscription_id ||
            current.platform_subscription_id === subscriptionId),
        409,
        "platform_customer_conflict",
        "Platform subscription mapping changed.",
      );
      if (
        current.platform_subscription_id &&
        current.platform_subscription_id !== subscriptionId
      )
        await tx("audit_events").insert({
          id: randomUUID(),
          tenant_id: tenantId,
          actor_type: "system",
          actor_id: "stripe",
          action: "platform.subscription_changed",
          details: JSON.stringify({
            from: current.platform_subscription_id,
            to: subscriptionId,
          }),
          created_at: Date.now(),
        });
      for (const grant of grants.values()) {
        turn?.work();
        await this.rememberPrice(tx, tenantId, grant.price_id, grant.tier);
        await tx("platform_grants")
          .insert(grant)
          .onConflict(["tenant_id", "id"])
          .merge();
        turn?.work();
      }
      const allQuery = tx<PlatformGrant>("platform_grants").where({
        tenant_id: tenantId,
      });
      const all = turn ? await turn.rows<PlatformGrant>(allQuery) : await allQuery;
      turn?.work(all.length * (5 + Math.max(1, Math.ceil(Math.log2(all.length + 1)))));
      const valid = all.filter((g) => !g.revoked);
      // Keep the latest past/current nonrevoked interval after expiry so an
      // unpaid renewal can retain pending events. A refund removes its evidence.
      // Join only contiguous/overlapping intervals, never a lapse or future grant.
      const pro = valid
        .map((g) => ({
          ...g,
          period_start: qualificationStarts.get(g.id) ?? g.period_start,
        }))
        .filter((g) => g.tier === "pro" && g.period_start <= Date.now())
        .sort((a, b) => b.period_end - a.period_end);
      let proEnd = pro[0]?.period_end ?? 0;
      let proStart = pro[0]?.period_start ?? 0;
      for (const grant of pro)
        if (grant.period_end >= proStart)
          proStart = Math.min(proStart, grant.period_start);
      // A revoked renewal cannot fall back to an older expired interval's grace.
      // Independently paid, still-current coverage remains usable.
      if (
        proEnd <= Date.now() &&
        all.some(
          (g) =>
            g.tier === "pro" &&
            g.revoked &&
            g.period_start <= Date.now() &&
            g.period_end > proEnd,
        )
      ) {
        proEnd = 0;
        proStart = 0;
      }
      await tx("tenants")
        .where({ id: tenantId })
        .update({
          platform_subscription_id: subscriptionId,
          billing_status: sub.status,
          paid_through: all.length
            ? Math.max(0, ...valid.map((g) => g.period_end))
            : current.paid_through,
          pro_paid_through: proEnd,
          pro_period_start: proStart,
          ...(valid.length
            ? {
                max_products: Math.max(
                  current.max_products,
                  this.config.paidMaxProducts ?? 20,
                ),
                max_storage_bytes: Math.max(
                  current.max_storage_bytes,
                  this.config.paidStorageBytes ?? 1024 ** 3,
                ),
              }
            : {}),
        });
      turn?.work();
    });
    if (obsolete && turn) {
      await turn.reset(platformSlot);
      throw new DeferredJob(Date.now() + 1000);
    }
  }
  private async persist(event: PlatformEvent, kind: string) {
    await this.db.transaction(async (tx) => {
      await lock(tx, "work");
      if (await tx("platform_events").where({ id: event.id }).first()) return;
      await tx("platform_events").insert({
        id: event.id,
        type: event.type,
        payload: seal(event, this.config.secret),
        received_at: Date.now(),
      });
      await tx("platform_work").insert({
        id: event.id,
        kind,
        payload: seal({ eventId: event.id }, this.config.secret),
        created_at: Date.now(),
      });
    });
  }
  async receive(event: PlatformEvent): Promise<void> {
    this.mode(event.livemode);
    check(
      !event.account,
      400,
      "stripe_account",
      "Connected account events cannot enter platform billing.",
    );
    await this.persist(event, "platform_event");
  }
  async accountEvent(event: PlatformEvent): Promise<void> {
    this.mode(event.livemode);
    if (
      !event.account ||
      !(await this.db("tenants")
        .where({ stripe_account_id: event.account })
        .first())
    )
      return;
    await this.persist(event, "connect_account");
  }
  private async eventCustomer(
    event: PlatformEvent,
  ): Promise<string | undefined> {
    const turn = workerTurn();
    if (turn) {
      const slot = "platform-customer";
      const identity = hash(
        JSON.stringify([
          this.config.stripeSecret,
          this.config.stripeLiveMode ?? false,
          event.id,
          event.type,
          event.data.object.id,
        ]),
      );
      const state = await turn.state(slot, {
        identity,
        phase: "start",
        chargeId: null as string | null,
        customerId: null as string | null,
      });
      if (state.identity !== identity) {
        await turn.reset(slot);
        throw new DeferredJob(Date.now() + 1000);
      }
      if (state.phase === "start") {
        if (event.type.startsWith("charge.dispute.")) {
          this.external();
          const dispute = await turn.read(async (options) =>
            this.stripe.disputes.retrieve(
              String(event.data.object.id),
              {},
              options,
            ),
          );
          state.chargeId = providerId(dispute.charge) ?? null;
        } else if (event.type.startsWith("refund.")) {
          this.external();
          const refund = await turn.read(async (options) =>
            this.stripe.refunds.retrieve(
              String(event.data.object.id),
              {},
              options,
            ),
          );
          state.chargeId = providerId(refund.charge) ?? null;
        } else if (event.type.startsWith("charge."))
          state.chargeId = String(event.data.object.id);
        else
          state.customerId =
            providerId(
              event.data.object.customer as string | { id: string } | undefined,
            ) ?? null;
        state.phase = state.chargeId ? "charge" : "done";
        await turn.save(slot, state);
      }
      if (state.phase === "charge") {
        this.external();
        const charge = await turn.read(async (options) =>
          this.stripe.charges.retrieve(state.chargeId!, {}, options),
        );
        this.mode(charge.livemode);
        state.customerId = providerId(charge.customer) ?? null;
        state.phase = "done";
        await turn.save(slot, state);
      }
      return state.customerId ?? undefined;
    }
    let chargeId: string | undefined;
    if (event.type.startsWith("charge.dispute.")) {
      this.external();
      chargeId = providerId(
        (await this.stripe.disputes.retrieve(String(event.data.object.id)))
          .charge,
      );
    } else if (event.type.startsWith("refund.")) {
      this.external();
      chargeId = providerId(
        (await this.stripe.refunds.retrieve(String(event.data.object.id)))
          .charge,
      );
    } else if (event.type.startsWith("charge."))
      chargeId = String(event.data.object.id);
    else
      return providerId(
        event.data.object.customer as string | { id: string } | undefined,
      );
    if (!chargeId) return undefined;
    this.external();
    const charge = await this.stripe.charges.retrieve(chargeId);
    this.mode(charge.livemode);
    return providerId(charge.customer);
  }
  async run(worker?: WorkerQueueOptions): Promise<void> {
    await runQueue(
      this.db,
      "platform_work",
      async (job) => {
        const handle = async () => {
          const { eventId } = unseal<{ eventId: string }>(
            job.payload,
            this.config.secret,
          );
          const stored = await this.db("platform_events")
            .where({ id: eventId })
            .first();
          const event = unseal<PlatformEvent>(
            stored.payload,
            this.config.secret,
          );
          if (job.kind === "connect_account") {
            const tenant = await this.db<Tenant>("tenants")
              .where({ stripe_account_id: event.account! })
              .first();
            if (tenant) {
              let status: string | undefined;
              if (event.type === "account.application.deauthorized")
                status = "disconnected";
              else if (event.type === "account.updated") {
                this.external();
                const turn = workerTurn();
                const account = turn
                  ? await turn.read(async (options) =>
                      this.stripe.accounts.retrieve(
                        event.account!,
                        {},
                        options,
                      ),
                    )
                  : await this.stripe.accounts.retrieve(event.account!);
                status = account.charges_enabled ? "connected" : "restricted";
              }
              if (status)
                await this.db.transaction(async (tx) => {
                  await assertQueueLease(tx);
                  await tx("tenants")
                    .where({ id: tenant.id, stripe_account_id: event.account! })
                    .update({ stripe_status: status });
                });
            }
          } else {
            const customerId = await this.eventCustomer(event);
            const tenant = customerId
              ? await this.db<Tenant>("tenants")
                  .where({ platform_customer_id: customerId })
                  .first()
              : undefined;
            if (tenant) await this.reconcile(tenant.id);
          }
          await this.db.transaction(async (tx) => {
            await assertQueueLease(tx);
            await tx("platform_events")
              .where({ id: eventId })
              .update({ processed_at: Date.now() });
          });
        };
        if (worker)
          await withWorkerTurn(
            {
              db: this.db,
              secret: this.config.secret,
              job,
              table: "platform_work",
              budgetMs: worker.budgetMs,
              maxRequests: worker.maxRequests,
              onBeginApply: worker.onBeginApply,
              maxFacts: worker.maxFacts, maxBytes: worker.maxBytes,
              maxApplyRecords: worker.maxApplyRecords, maxApplyWork: worker.maxApplyWork, applyMs: worker.applyMs,
            },
            handle,
          );
        else await handle();
      },
      worker ? 1 : 20,
      undefined,
      worker,
    );
  }
}
