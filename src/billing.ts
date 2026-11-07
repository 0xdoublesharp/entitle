import {
  completedCustomerClosure,
  completedSubscriptionClosure,
  privacyReferenceDigest,
  retainedFinancial,
} from "./account-management.ts";
import { sealPrivacyAttribution } from "./privacy-attribution.ts";
import { recordBusinessEvent } from "./business-events.ts";
import { randomUUID } from "node:crypto";
import type { DB, License, Plan, Customer } from "./db.ts";
import { lock } from "./db.ts";
import { hash, random, seal, unseal } from "./crypto.ts";
import type { Licenses } from "./licensing.ts";
import { AppError, check } from "./errors.ts";
import { DeferredJob, runQueue } from "./queue.ts";
import {
  requireTenantCapacity,
  type PublicationPolicy,
} from "./publication-policy.ts";
export interface PaidGrant {
  id: string;
  invoiceId: string;
  priceId: string;
  periodStart: number;
  periodEnd: number;
  paidAt: number;
  settled: boolean;
}
export interface BillingSnapshot {
  subscriptionId: string;
  customerId: string;
  email: string;
  billingStatus: string;
  suspended: boolean;
  fullyRefunded: boolean;
  grants: PaidGrant[];
  invoices?: {
    invoiceId: string;
    currency: string;
    paidMinor: number;
    refundedMinor: number;
  }[];
}
export interface BillingSource {
  snapshot: (subscriptionId: string) => Promise<BillingSnapshot>;
}
export interface BillingEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  livemode?: boolean;
}
export interface BillingPrivacyContext {
  stripeLiveMode: boolean;
  purchasePolicy?: Readonly<PublicationPolicy>;
  /** Canonical provider attribution for events without a customer field. Called outside SQL transactions. */
  resolveCustomer?: (event: BillingEvent) => Promise<string | null>;
}
export function reconciliationLockId(tenantId: string, subscriptionId: string) {
  return `reconcile:${hash(JSON.stringify([tenantId, subscriptionId]))}`;
}
export class Billing {
  db: DB;
  licensing: Licenses;
  source: BillingSource;
  privacy: BillingPrivacyContext;
  readonly purchasePolicy: Readonly<PublicationPolicy>;
  constructor(
    db: DB,
    licensing: Licenses,
    source: BillingSource,
    privacy: BillingPrivacyContext = { stripeLiveMode: false },
  ) {
    this.db = db;
    this.licensing = licensing;
    this.source = source;
    this.privacy = privacy;
    this.purchasePolicy = Object.freeze({
      deploymentMode: privacy.purchasePolicy?.deploymentMode ?? "hosted",
      graceDays: privacy.purchasePolicy?.graceDays,
    });
  }
  async reconcile(subscriptionId: string) {
    if (
      await completedSubscriptionClosure(
        this.db,
        this.licensing.tenant.id,
        this.licensing.secret,
        subscriptionId,
        this.privacy.stripeLiveMode,
      )
    )
      return;
    // Only another apply for this subscription invalidates an in-flight snapshot.
    // Checkout still shares the short customer-mapping mutex inside the apply.
    const revisionId = reconciliationLockId(
      this.licensing.tenant.id,
      subscriptionId,
    );
    await this.db("locks")
      .insert({ id: revisionId, version: 0 })
      .onConflict("id")
      .ignore();
    for (let attempt = 0; attempt < 8; attempt++) {
      const revision = await this.db("locks").where({ id: revisionId }).first();
      const s = await this.source.snapshot(subscriptionId);
      const applied = await this.db.transaction(async (tx) => {
        await lock(tx, "billing", this.licensing.tenant.id);
        const acquired = await tx("locks")
          .where({ id: revisionId, version: revision.version })
          .increment("version", 1);
        if (!acquired) return false;
        check(
          s.subscriptionId === subscriptionId,
          502,
          "billing_mismatch",
          "Billing snapshot mismatch.",
        );
        if (
          await completedCustomerClosure(
            tx,
            this.licensing.tenant.id,
            this.licensing.secret,
            s.customerId,
            this.privacy.stripeLiveMode,
          )
        )
          return true;
        const plans = await tx<Plan>("plans").where({
          tenant_id: this.licensing.tenant.id,
        });
        const paid = s.grants.filter(
          (g) =>
            g.settled &&
            g.periodEnd > g.periodStart &&
            plans.some((p) => p.stripe_price_id === g.priceId),
        );
        let l = await tx<License>("licenses")
          .where({
            tenant_id: this.licensing.tenant.id,
            subscription_id: subscriptionId,
          })
          .first();
        check(!l || l.provenance !== "complimentary", 409, "billing_provenance_conflict", "Stripe cannot reconcile complimentary entitlement.");
        if (!l && !paid.length) return true;
        if (!l) {
          // An open checkout reserves no authority to issue a new license.
          // Existing subscriptions still reconcile renewals, refunds and disputes.
          // A hold rolls back this apply; the sealed paid event stays unprocessed
          // for recovery. It does not cancel or refund the provider payment.
          try {
            await requireTenantCapacity(
              tx,
              this.licensing.tenant.id,
              this.purchasePolicy,
            );
          } catch (error) {
            if (
              error instanceof AppError &&
              ["tenant_suspended", "tenant_capacity"].includes(error.code)
            )
              throw new DeferredJob(Date.now() + 60000);
            throw error;
          }
        }
        for (const invoice of s.invoices ?? []) {
          check(
            /^[a-z]{3}$/.test(invoice.currency) &&
              Number.isSafeInteger(invoice.paidMinor) &&
              invoice.paidMinor >= 0 &&
              Number.isSafeInteger(invoice.refundedMinor) &&
              invoice.refundedMinor >= 0,
            502,
            "billing_metrics",
            "Invalid invoice metrics.",
          );
          await tx("invoice_metrics")
            .insert({
              tenant_id: this.licensing.tenant.id,
              invoice_id: invoice.invoiceId,
              currency: invoice.currency,
              paid_minor: invoice.paidMinor,
              refunded_minor: invoice.refundedMinor,
            })
            .onConflict(["tenant_id", "invoice_id"])
            .merge(["currency", "paid_minor", "refunded_minor"]);
        }
        let c = await tx<Customer>("customers")
          .where({
            tenant_id: this.licensing.tenant.id,
            stripe_id: s.customerId,
          })
          .first();
        if (!c) {
          const email = s.email.trim().toLowerCase();
          check(
            email.includes("@"),
            502,
            "billing_email",
            "Stripe customer email is required.",
          );
          c = await tx<Customer>("customers")
            .where({ tenant_id: this.licensing.tenant.id, email })
            .first();
          if (c) {
            check(
              !c.stripe_id || c.stripe_id === s.customerId,
              409,
              "billing_customer_conflict",
              "Email belongs to another billing customer.",
            );
            await tx("customers")
              .where({ tenant_id: this.licensing.tenant.id, id: c.id })
              .update({ stripe_id: s.customerId });
          } else {
            c = {
              tenant_id: this.licensing.tenant.id,
              id: randomUUID(),
              email,
              stripe_id: s.customerId,
            };
            await tx("customers").insert(c);
          }
        }
        const created = !l;
        if (!l) {
          const first = paid[0]!;
          const plan = plans.find((p) => p.stripe_price_id === first.priceId)!;
          const key = `DE-${random()}`;
          l = {
            tenant_id: this.licensing.tenant.id,
            id: randomUUID(),
            customer_id: c.id,
            product_id: plan.product_id,
            plan_id: plan.id,
            site_allowance: plan.site_allowance,
            paid_through: 0,
            billing_status: s.billingStatus,
            subscription_id: subscriptionId,
            key_hash: hash(key),
            revoked: 0,
            refund_revoked: 0,
            suspended: 0,
            lock_version: 0,
          };
          await tx("licenses").insert(l);
          await this.licensing.keyEmail(tx, l, key);
        }
        check(
          l.customer_id === c.id,
          409,
          "billing_customer_conflict",
          "Billing customer cannot change license ownership.",
        );
        await tx("licenses")
          .where({ tenant_id: this.licensing.tenant.id, id: l.id })
          .increment("lock_version", 1);
        for (const g of paid) {
          const p = plans.find((p) => p.stripe_price_id === g.priceId)!;
          check(
            p.product_id === l.product_id,
            409,
            "billing_product_conflict",
            "A subscription cannot move across products.",
          );
          const existing = await tx("grants")
            .where({ tenant_id: this.licensing.tenant.id, id: g.id })
            .first();
          if (!existing)
            await tx("grants").insert({
              tenant_id: this.licensing.tenant.id,
              id: g.id,
              license_id: l.id,
              invoice_id: g.invoiceId,
              plan_id: p.id,
              period_start: g.periodStart,
              period_end: g.periodEnd,
              paid_at: g.paidAt,
            });
        }
        const grants = await tx("grants")
          .where({ tenant_id: this.licensing.tenant.id, license_id: l.id })
          .orderBy("period_start", "desc")
          .orderBy("paid_at", "desc")
          .orderBy("id", "desc");
        const current = grants[0];
        const p = current
          ? plans.find((p) => p.id === current.plan_id)
          : undefined;
        const projected = await this.licensing.effective(
          {
            ...l,
            plan_id: p?.id ?? l.plan_id,
            site_allowance: p?.site_allowance ?? l.site_allowance,
          },
          tx,
        );
        const paidThrough = Math.max(
          Number(l.paid_through),
          ...grants.map((g) => Number(g.period_end)),
        );
        await tx("licenses")
          .where({ tenant_id: this.licensing.tenant.id, id: l.id })
          .update({
            paid_through: paidThrough,
            plan_id: projected.plan_id,
            site_allowance: projected.site_allowance,
            billing_status: s.billingStatus,
            suspended: s.suspended ? 1 : 0,
            refund_revoked: l.refund_revoked || s.fullyRefunded ? 1 : 0,
          });
        if (created)
          await recordBusinessEvent(
            tx,
            this.licensing.tenant.id,
            "license.created",
            l.id,
            "created",
          );
        else if (paidThrough > Number(l.paid_through))
          await recordBusinessEvent(
            tx,
            this.licensing.tenant.id,
            "license.renewed",
            l.id,
            String(paidThrough),
          );
        if (s.fullyRefunded && !l.refund_revoked && !l.revoked)
          await recordBusinessEvent(
            tx,
            this.licensing.tenant.id,
            "license.revoked",
            l.id,
            "refund",
          );
        return true;
      });
      if (applied) return;
    }
    check(
      false,
      409,
      "billing_changed",
      "Billing changed during reconciliation. Retry with a fresh snapshot.",
    );
  }
  async receive(event: BillingEvent) {
    const tenant = this.licensing.tenant.id;
    check(
      event.livemode === undefined ||
        event.livemode === this.privacy.stripeLiveMode,
      409,
      "billing_mode_mismatch",
      "Provider event mode does not match this billing context.",
    );
    if (
      await this.db("billing_events")
        .where({ tenant_id: tenant, id: event.id })
        .first()
    )
      return;
    const object = event.data.object;
    const customer = object.customer;
    let customerId =
      typeof customer === "string"
        ? customer
        : customer &&
            typeof customer === "object" &&
            "id" in customer &&
            typeof customer.id === "string"
          ? customer.id
          : /^customer\.(created|updated|deleted)$/.test(event.type) &&
              typeof object.id === "string"
            ? object.id
            : null;
    let attributed = false;
    if (
      !customerId &&
      (await this.db("account_closures")
        .where({ tenant_id: tenant, status: "completed" })
        .first())
    ) {
      check(
        this.privacy.resolveCustomer,
        503,
        "billing_privacy_attribution_required",
        "Canonical provider customer attribution is required. Retry this event.",
      );
      customerId = await this.privacy.resolveCustomer(event);
      attributed = true;
    }
    await this.db.transaction(async (tx) => {
      await lock(tx, "billing", tenant);
      await lock(tx, "work", tenant);
      if (
        await tx("billing_events")
          .where({ tenant_id: tenant, id: event.id })
          .first()
      )
        return;
      check(
        customerId ||
          attributed ||
          !(await tx("account_closures")
            .where({ tenant_id: tenant, status: "completed" })
            .first()),
        503,
        "billing_privacy_attribution_required",
        "Canonical provider customer attribution is required. Retry this event.",
      );
      const closure = customerId
        ? await completedCustomerClosure(
            tx,
            tenant,
            this.licensing.secret,
            customerId,
            this.privacy.stripeLiveMode,
          )
        : undefined;
      const receivedAt = Date.now();
      if (closure) {
        await tx("account_privacy_receipts").insert({
          tenant_id: tenant,
          customer_id: closure.customer_id,
          request_id: closure.request_id,
          id: hash(
            JSON.stringify([
              tenant,
              closure.request_id,
              "late-provider-event",
              event.id,
            ]),
          ),
          details: JSON.stringify({
            referenceDigests: [],
            stripeLiveMode: this.privacy.stripeLiveMode,
            stripeCustomerAttribution: sealPrivacyAttribution(
              {
                tenantId: tenant,
                customerId: closure.customer_id,
                requestId: closure.request_id,
                stripeLiveMode: this.privacy.stripeLiveMode,
              },
              customerId!,
              this.licensing.secret,
            ),
            events: [
              {
                id: event.id,
                type: event.type,
                payloadHash: privacyReferenceDigest(
                  this.licensing.secret,
                  JSON.stringify(event),
                ),
                financial: retainedFinancial(event),
              },
            ],
          }),
          created_at: receivedAt,
        });
        await tx("billing_events").insert({
          tenant_id: tenant,
          id: event.id,
          type: event.type,
          payload: "{}",
          received_at: receivedAt,
          processed_at: receivedAt,
        });
        return;
      }
      await tx("billing_events").insert({
        tenant_id: tenant,
        id: event.id,
        type: event.type,
        payload: seal(event, this.licensing.secret),
        received_at: receivedAt,
      });
      await tx("work").insert({
        tenant_id: tenant,
        id: event.id,
        kind: "stripe_event",
        payload: seal({ eventId: event.id }, this.licensing.secret),
        created_at: receivedAt,
      });
    });
  }
  async run(
    resolveSubscription: (event: BillingEvent) => Promise<string | null>,
  ) {
    await runQueue(
      this.db,
      "work",
      async (job) => {
        if (job.kind === "reconcile") {
          const { subscriptionId } = unseal<{ subscriptionId: string }>(
            job.payload,
            this.licensing.secret,
          );
          await this.reconcile(subscriptionId);
          return;
        }
        const { eventId } = unseal<{ eventId: string }>(
          job.payload,
          this.licensing.secret,
        );
        const stored = await this.db("billing_events")
          .where({ tenant_id: this.licensing.tenant.id, id: eventId })
          .first();
        const event = unseal<BillingEvent>(
          stored.payload,
          this.licensing.secret,
        );
        const subscription = await resolveSubscription(event);
        if (subscription) await this.reconcile(subscription);
        await this.db("billing_events")
          .where({ tenant_id: this.licensing.tenant.id, id: eventId })
          .update({ processed_at: Date.now() });
      },
      20,
      this.licensing.tenant.id,
    );
  }
  async enqueueReconcile(subscriptionIds: string[]) {
    for (const subscriptionId of new Set(subscriptionIds))
      await this.db.transaction(async (tx) => {
        // Serialize scheduling with worker claims on all supported engines.
        // Keep one reusable job without changing a pending retry or live lease.
        await lock(tx, "work", this.licensing.tenant.id);
        const id = `reconcile:${hash(subscriptionId)}`;
        const existing = await tx("work")
          .where({ tenant_id: this.licensing.tenant.id, id })
          .first();
        if (existing && ["pending", "running"].includes(existing.state)) return;
        const row = {
          tenant_id: this.licensing.tenant.id,
          id,
          kind: "reconcile",
          payload: seal({ subscriptionId }, this.licensing.secret),
          created_at: Date.now(),
          state: "pending",
          attempts: 0,
          available_at: 0,
          lease_until: 0,
          lease_owner: null,
          last_error: null,
        };
        if (existing)
          await tx("work")
            .where({ tenant_id: this.licensing.tenant.id, id })
            .update(row);
        else await tx("work").insert(row);
      });
  }
}
