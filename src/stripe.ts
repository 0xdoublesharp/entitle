import { appUrl } from "../packages/shared/app-path.ts";
import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import type {
  BillingSnapshot,
  BillingEvent,
  BillingSource,
  PaidGrant,
} from "./billing.ts";
import type { DB, Plan, Tenant } from "./db.ts";
import { lock } from "./db.ts";
import type { Config } from "./config.ts";
import { check } from "./errors.ts";
import { stripeWorkerHttpClient, workerTurn } from "./worker-continuation.ts";
import { workerSnapshot, workerResolveSubscription } from "./stripe-worker.ts";
const id = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;
export interface GuestCheckout {
  guestCustomerId?: string;
  issueGuestClaim?: (customerId: string) => void;
}
export class StripeBilling implements BillingSource {
  private client: Stripe | undefined;
  db: DB;
  config: Config;
  readonly tenant: Readonly<Tenant>;
  constructor(db: DB, config: Config, tenant: Tenant) {
    this.tenant = Object.freeze({ ...tenant });
    this.db = db;
    this.config = config;
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
  options(): Stripe.RequestOptions {
    void this.stripe;
    if (this.config.deploymentMode === "standalone") {
      check(
        this.tenant.id === "primary" && !this.tenant.stripe_account_id,
        409,
        "standalone_tenant",
        "Standalone commerce requires the primary merchant account.",
      );
      return {};
    }
    check(
      this.tenant.stripe_account_id,
      409,
      "stripe_not_connected",
      "Connect a Stripe account before starting commerce.",
    );
    return { stripeAccount: this.tenant.stripe_account_id };
  }
  async snapshot(subscriptionId: string): Promise<BillingSnapshot> {
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe reconciliation is disabled in local fixture mode.",
    );
    if (workerTurn()) return workerSnapshot(this, subscriptionId);
    const sub = await this.stripe.subscriptions.retrieve(
      subscriptionId,
      {},
      this.options(),
    );
    const customerId = id(sub.customer)!;
    const customer = await this.stripe.customers.retrieve(
      customerId,
      {},
      this.options(),
    );
    const grants: PaidGrant[] = [];
    const invoices: NonNullable<BillingSnapshot["invoices"]> = [];
    let suspended = false,
      fullyRefunded = false;
    for await (const invoice of this.stripe.invoices.list(
      {
        subscription: subscriptionId,
        limit: 100,
      },
      this.options(),
    )) {
      if (invoice.status !== "paid" || invoice.amount_paid <= 0) continue;
      let refunded = 0;
      const seenCharges = new Set<string>();
      for await (const payment of this.stripe.invoicePayments.list(
        {
          invoice: invoice.id,
          status: "paid",
          limit: 100,
        },
        this.options(),
      )) {
        const charges: Stripe.Charge[] = [];
        const pi = id(payment.payment.payment_intent);
        if (pi) {
          for await (const charge of this.stripe.charges.list(
            {
              payment_intent: pi,
              limit: 100,
            },
            this.options(),
          ))
            charges.push(charge);
        } else if (payment.payment.charge)
          charges.push(
            await this.stripe.charges.retrieve(
              id(payment.payment.charge)!,
              {},
              this.options(),
            ),
          );
        for (const charge of charges) {
          if (!charge.paid || seenCharges.has(charge.id)) continue;
          seenCharges.add(charge.id);
          refunded += charge.amount_refunded;
          if (charge.disputed) {
            for await (const dispute of this.stripe.disputes.list(
              {
                charge: charge.id,
                limit: 100,
              },
              this.options(),
            )) {
              if (!["won", "warning_closed"].includes(dispute.status))
                suspended = true;
            }
          }
        }
      }
      invoices.push({
        invoiceId: invoice.id,
        currency: invoice.currency,
        paidMinor: invoice.amount_paid,
        refundedMinor: Math.min(invoice.amount_paid, refunded),
      });
      if (refunded >= invoice.amount_paid) fullyRefunded = true;
      for await (const line of this.stripe.invoices.listLineItems(
        invoice.id,
        {
          limit: 100,
        },
        this.options(),
      )) {
        const priceId = id(line.pricing?.price_details?.price);
        if (
          line.amount <= 0 ||
          !line.parent?.subscription_item_details ||
          !priceId
        )
          continue;
        grants.push({
          id: line.id,
          invoiceId: invoice.id,
          priceId,
          periodStart: line.period.start * 1000,
          periodEnd: line.period.end * 1000,
          paidAt:
            (invoice.status_transitions.paid_at ?? invoice.created) * 1000,
          settled: true,
        });
      }
    }
    return {
      subscriptionId,
      customerId,
      // Missing provider email must not prevent unrelated subscriptions or an
      // already-known customer from reconciling. New issuance validates it.
      email: customer.deleted ? "" : (customer.email ?? ""),
      billingStatus: sub.status,
      grants,
      invoices,
      suspended,
      fullyRefunded,
    };
  }
  async validateTaxSettings(): Promise<void> {
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe Tax configuration cannot be verified in local fixture mode.",
    );
    const settings = await this.stripe.tax.settings.retrieve(
      {},
      this.options(),
    );
    check(
      settings.status === "active",
      409,
      "tax_configuration",
      "Complete Stripe Tax settings in the merchant account before enabling automatic tax.",
    );
  }
  async syncProductTaxCode(
    productId: string,
    taxCode: string | null,
  ): Promise<void> {
    const product = await this.db("products")
      .where({ tenant_id: this.tenant.id, id: productId })
      .first();
    check(product, 404, "not_found", "Product not found.");
    check(
      taxCode === null || /^txcd_[0-9]{8}$/.test(taxCode),
      409,
      "tax_configuration",
      "Product tax code is invalid.",
    );
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe product tax configuration cannot be verified in local fixture mode.",
    );
    void this.stripe;
    if (taxCode)
      await this.stripe.taxCodes.retrieve(taxCode, {}, this.options());
    const plans = await this.db<Plan>("plans").where({
      tenant_id: this.tenant.id,
      product_id: productId,
    });
    const seen = new Set<string>();
    for (const plan of plans) {
      const price = await this.stripe.prices.retrieve(
        plan.stripe_price_id,
        {},
        this.options(),
      );
      const processorId = id(price.product);
      check(
        processorId,
        409,
        "tax_configuration",
        "The canonical Stripe price must identify a product.",
      );
      if (seen.has(processorId)) continue;
      seen.add(processorId);
      const processor = await this.stripe.products.retrieve(
        processorId,
        {},
        this.options(),
      );
      if ((id(processor.tax_code) ?? null) !== taxCode)
        await this.stripe.products.update(
          processorId,
          { tax_code: taxCode ?? "" },
          this.options(),
        );
    }
  }
  private async checkoutTax(
    plan: Plan,
  ): Promise<Partial<Stripe.Checkout.SessionCreateParams>> {
    const tenant = await this.db("tenants")
      .where({ id: this.tenant.id })
      .first();
    check(tenant, 404, "tenant_not_found", "Tenant was not found.");
    const flags = [
      tenant.automatic_tax,
      tenant.collect_tax_id,
      tenant.collect_billing_address,
    ];
    check(
      flags.every((flag) => flag === 0 || flag === 1),
      409,
      "tax_configuration",
      "Tax collection settings are invalid.",
    );
    const [automatic, taxId, address] = flags;
    const product = await this.db("products")
      .where({ tenant_id: this.tenant.id, id: plan.product_id })
      .first();
    if (product?.tax_code != null) {
      check(
        /^txcd_[0-9]{8}$/.test(product.tax_code),
        409,
        "tax_configuration",
        "Product tax code is invalid.",
      );
    }
    if (automatic) await this.validateTaxSettings();
    return {
      ...(automatic ? { automatic_tax: { enabled: true } } : {}),
      ...(taxId ? { tax_id_collection: { enabled: true } } : {}),
      ...(address ? { billing_address_collection: "required" } : {}),
      ...(automatic || taxId || address
        ? {
            customer_update: {
              ...(automatic || address ? { address: "auto" } : {}),
              ...(taxId ? { name: "auto" } : {}),
            },
          }
        : {}),
    };
  }
  async checkout(
    plan: Plan,
    email: string,
    authenticatedCustomerId?: string,
    uiMode: "hosted" | "elements" = "hosted",
    guest: GuestCheckout = {},
  ) {
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe checkout is disabled in local fixture mode. Configure Stripe test credentials to exercise checkout.",
    );
    // Reject unavailable billing before creating a local customer or guest claim.
    void this.stripe;
    check(
      !["disconnected", "restricted"].includes(this.tenant.stripe_status),
      409,
      "stripe_not_connected",
      "Reconnect an enabled Stripe account before starting commerce.",
    );
    check(
      plan.tenant_id === this.tenant.id,
      403,
      "tenant_denied",
      "Plan belongs to another tenant.",
    );
    if (uiMode === "elements")
      check(
        this.config.stripePublishableKey,
        503,
        "stripe_elements_unconfigured",
        "Stripe Elements checkout is not configured.",
      );
    // Commit the local identity before HTTP so retries retain the same provider
    // idempotency key even if the network response or subsequent database write fails.
    const { customer, created } = await this.db.transaction(async (tx) => {
      await lock(tx, "billing", this.tenant.id);
      let c = await tx("customers")
        .where({ tenant_id: this.tenant.id, email })
        .first();
      const created = !c;
      if (c) {
        const ownsGuest =
          !authenticatedCustomerId &&
          guest.guestCustomerId === c.id &&
          !(await tx("licenses")
            .where({ tenant_id: this.tenant.id, customer_id: c.id })
            .first());
        check(
          authenticatedCustomerId === c.id || ownsGuest,
          authenticatedCustomerId ? 409 : 401,
          authenticatedCustomerId
            ? "checkout_identity_conflict"
            : "login_required",
          "Sign in with this email address before purchasing another license.",
        );
      } else {
        c = {
          tenant_id: this.tenant.id,
          id: randomUUID(),
          email,
          stripe_id: null,
        };
        await tx("customers").insert(c);
      }
      return { customer: c, created };
    });
    if (created) guest.issueGuestClaim?.(customer.id);
    const price = await this.stripe.prices.retrieve(
      plan.stripe_price_id,
      {},
      this.options(),
    );
    check(
      price.active &&
        price.type === "recurring" &&
        price.recurring?.interval === "year" &&
        price.recurring.interval_count === 1,
      409,
      "invalid_price",
      "Plan must use an active annual Stripe price.",
    );
    const tax = await this.checkoutTax(plan);
    let stripeId = customer.stripe_id;
    if (!stripeId) {
      const external = await this.stripe.customers.create(
        { email },
        {
          ...this.options(),
          idempotencyKey: `double-entitle-customer-${this.tenant.id}-${customer.id}`,
        },
      );
      await this.db.transaction(async (tx) => {
        await lock(tx, "billing", this.tenant.id);
        const mapped = await tx("customers")
          .where({ tenant_id: this.tenant.id, id: customer.id })
          .andWhere((q) =>
            q.whereNull("stripe_id").orWhere("stripe_id", external.id),
          )
          .update({ stripe_id: external.id });
        check(
          mapped,
          409,
          "billing_customer_conflict",
          "Billing customer mapping changed. Retry after signing in.",
        );
      });
      stripeId = external.id;
    }
    if (!authenticatedCustomerId)
      await this.db.transaction(async (tx) => {
        await lock(tx, "billing", this.tenant.id);
        check(
          !(await tx("licenses")
            .where({ tenant_id: this.tenant.id, customer_id: customer.id })
            .first()),
          401,
          "login_required",
          "Sign in before purchasing another license.",
        );
      });
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "subscription",
        ...tax,
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        customer: stripeId,
        ...(uiMode === "elements"
          ? {
              ui_mode: "elements",
              return_url: appUrl(
                this.config,
                `/t/${this.tenant.slug}?checkout=return`,
              ),
            }
          : {
              success_url: appUrl(
                this.config,
                `/t/${this.tenant.slug}?checkout=success`,
              ),
              cancel_url: appUrl(
                this.config,
                `/t/${this.tenant.slug}?checkout=canceled`,
              ),
            }),
        subscription_data: {
          ...(this.config.deploymentMode === "hosted" &&
          this.config.hostedApplicationFeePercent > 0
            ? {
                application_fee_percent:
                  this.config.hostedApplicationFeePercent,
              }
            : {}),
          metadata: { product_id: plan.product_id, plan_id: plan.id },
        },
        allow_promotion_codes: false,
      },
      this.options(),
    );
    if (uiMode === "elements") {
      check(
        session.client_secret,
        502,
        "stripe_session",
        "Stripe did not return an Elements session.",
      );
      return {
        uiMode: "elements" as const,
        clientSecret: session.client_secret,
        publishableKey: this.config.stripePublishableKey!,
        ...(this.config.deploymentMode === "hosted"
          ? { stripeAccount: this.tenant.stripe_account_id! }
          : {}),
        returnUrl: appUrl(
          this.config,
          `/t/${this.tenant.slug}?checkout=return`,
        ),
      };
    }
    check(
      session.url,
      502,
      "stripe_session",
      "Stripe did not return a checkout URL.",
    );
    return { url: session.url };
  }

  async portal(customerId: string) {
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe portal is disabled in local fixture mode.",
    );
    const session = await this.stripe.billingPortal.sessions.create(
      {
        customer: customerId,
        return_url: appUrl(this.config, `/t/${this.tenant.slug}`),
      },
      this.options(),
    );
    return { url: session.url };
  }
  // Privacy attribution must not depend on local subscription/license history:
  // one-off payments and old closed customers can have neither. All reads stay
  // in this merchant account. Null means the canonical object has no customer;
  // unknown event families and unavailable provider evidence must retry.
  async resolveCustomer(event: BillingEvent): Promise<string | null> {
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe attribution is disabled in local fixture mode.",
    );
    const options = this.options();
    const mode = this.config.stripeLiveMode ?? false;
    check(
      event.livemode === undefined || event.livemode === mode,
      400,
      "stripe_mode",
      "Stripe test and live modes cannot be mixed.",
    );
    const objectId = event.data.object.id;
    check(
      typeof objectId === "string" && objectId.length > 0,
      503,
      "billing_privacy_attribution_required",
      "Canonical event identity is required.",
    );
    const verify = <T extends { id: string; livemode: boolean }>(
      object: T,
      expected: string,
    ): T => {
      check(
        object.id === expected && object.livemode === mode,
        503,
        "billing_privacy_attribution_required",
        "Canonical provider identity or mode did not match.",
      );
      return object;
    };
    const customerId = (
      customer: string | Stripe.Customer | Stripe.DeletedCustomer | null,
    ): string | null => {
      const value = id(customer);
      check(
        customer === null || (typeof value === "string" && value.length > 0),
        503,
        "billing_privacy_attribution_required",
        "Canonical customer attribution is malformed.",
      );
      return value ?? null;
    };
    const chargeCustomer = async (chargeId: string) =>
      customerId(
        verify(
          await this.stripe.charges.retrieve(chargeId, {}, options),
          chargeId,
        ).customer,
      );
    const intentCustomer = async (intentId: string) =>
      customerId(
        verify(
          await this.stripe.paymentIntents.retrieve(intentId, {}, options),
          intentId,
        ).customer,
      );
    if (event.type.startsWith("charge.dispute.")) {
      const dispute = verify(
        await this.stripe.disputes.retrieve(objectId, {}, options),
        objectId,
      );
      const chargeId = id(dispute.charge);
      check(
        chargeId,
        503,
        "billing_privacy_attribution_required",
        "Canonical dispute charge is required.",
      );
      return chargeCustomer(chargeId);
    }
    if (
      event.type.startsWith("refund.") ||
      event.type.startsWith("charge.refund.")
    ) {
      const refund = await this.stripe.refunds.retrieve(objectId, {}, options);
      // Refund has no livemode in Stripe's schema. Its exact identity, the
      // signed envelope mode and the merchant-scoped canonical read prove
      // its context. Charge/PaymentIntent relations additionally verify mode.
      check(
        refund.id === objectId && event.livemode === mode,
        503,
        "billing_privacy_attribution_required",
        "Canonical refund identity and signed event mode are required.",
      );
      const customer = customerId(refund.customer);
      if (customer) return customer;
      const chargeId = id(refund.charge);
      if (chargeId) return chargeCustomer(chargeId);
      const intentId = id(refund.payment_intent);
      if (intentId) return intentCustomer(intentId);
      check(
        refund.charge === null && refund.payment_intent === null,
        503,
        "billing_privacy_attribution_required",
        "Canonical refund payment attribution is malformed.",
      );
      return null;
    }
    if (event.type.startsWith("charge.")) return chargeCustomer(objectId);
    if (event.type.startsWith("payment_intent."))
      return intentCustomer(objectId);
    let canonical:
      Stripe.Invoice | Stripe.Subscription | Stripe.Checkout.Session;
    if (event.type.startsWith("invoice."))
      canonical = await this.stripe.invoices.retrieve(objectId, {}, options);
    else if (event.type.startsWith("customer.subscription."))
      canonical = await this.stripe.subscriptions.retrieve(
        objectId,
        {},
        options,
      );
    else {
      check(
        event.type.startsWith("checkout.session."),
        503,
        "billing_privacy_attribution_required",
        "This event family requires canonical customer attribution support.",
      );
      canonical = await this.stripe.checkout.sessions.retrieve(
        objectId,
        {},
        options,
      );
    }
    return customerId(verify(canonical, objectId).customer);
  }
  async resolveSubscription(event: BillingEvent): Promise<string | null> {
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe reconciliation is disabled in local fixture mode.",
    );
    this.options();
    if (workerTurn()) return workerResolveSubscription(this, event);
    const obj = event.data.object;
    if (event.type.startsWith("customer.subscription.")) return String(obj.id);
    if (event.type.startsWith("invoice.")) {
      const invoice = await this.stripe.invoices.retrieve(
        String(obj.id),
        {},
        this.options(),
      );
      return id(invoice.parent?.subscription_details?.subscription) ?? null;
    }
    if (event.type.startsWith("checkout.session.")) {
      const session = await this.stripe.checkout.sessions.retrieve(
        String(obj.id),
        {},
        this.options(),
      );
      return id(session.subscription) ?? null;
    }
    let charge: Stripe.Charge | undefined;
    if (event.type.startsWith("charge.dispute.")) {
      const dispute = await this.stripe.disputes.retrieve(
        String(obj.id),
        {},
        this.options(),
      );
      charge = await this.stripe.charges.retrieve(
        id(dispute.charge)!,
        {},
        this.options(),
      );
    } else if (event.type.startsWith("charge."))
      charge = await this.stripe.charges.retrieve(
        String(obj.id),
        {},
        this.options(),
      );
    else if (event.type.startsWith("refund.")) {
      const refund = await this.stripe.refunds.retrieve(
        String(obj.id),
        {},
        this.options(),
      );
      if (refund.charge)
        charge = await this.stripe.charges.retrieve(
          id(refund.charge)!,
          {},
          this.options(),
        );
    }
    if (charge) {
      const pi = id(charge.payment_intent);
      if (pi)
        for await (const payment of this.stripe.invoicePayments.list(
          {
            payment: { type: "payment_intent", payment_intent: pi },
            limit: 100,
          },
          this.options(),
        )) {
          const invoice = await this.stripe.invoices.retrieve(
            id(payment.invoice)!,
            {},
            this.options(),
          );
          const sub = id(invoice.parent?.subscription_details?.subscription);
          if (sub) return sub;
        }
      if (!pi && charge.customer) {
        // Legacy direct-charge invoice payments cannot be filtered by charge in
        // Stripe's list API. Inspect this customer's invoices with pagination.
        for await (const invoice of this.stripe.invoices.list(
          {
            customer: id(charge.customer)!,
            limit: 100,
          },
          this.options(),
        )) {
          const subscription = id(
            invoice.parent?.subscription_details?.subscription,
          );
          if (!subscription) continue;
          for await (const payment of this.stripe.invoicePayments.list(
            {
              invoice: invoice.id,
              limit: 100,
            },
            this.options(),
          )) {
            if (id(payment.payment.charge) === charge.id) return subscription;
          }
        }
      }
    }
    return null;
  }
  async subscriptionIds() {
    check(
      !this.config.localBilling,
      503,
      "local_billing",
      "Stripe reconciliation is disabled in local fixture mode.",
    );
    const result: string[] = [];
    for await (const s of this.stripe.subscriptions.list(
      {
        status: "all",
        limit: 100,
      },
      this.options(),
    ))
      result.push(s.id);
    return result;
  }
}
