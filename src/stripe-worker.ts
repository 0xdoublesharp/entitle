import type Stripe from "stripe";
import type { StripeBilling } from "./stripe.ts";
import { reconciliationLockId, type BillingEvent, type BillingSnapshot, type PaidGrant } from "./billing.ts";
import { hash } from "./crypto.ts";
import { check } from "./errors.ts";
import { workerTurn, type WorkerFact } from "./worker-continuation.ts";

const providerId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id;
type Source = Pick<StripeBilling, "db" | "tenant" | "stripe" | "options" | "config">;
const providerIdentity = (source: Source) => hash(JSON.stringify([
  source.options().stripeAccount ?? source.config.standaloneStripeAccountId ?? null,
  source.config.stripeLiveMode === true,
  hash(source.config.stripeSecret),
]));
interface Invoice { id: string; currency: string; amount: number; paidAt: number }
interface Payment { id: string; intent: string | null; charge: string | null }
interface Charge { id: string; paid: boolean; refunded: number; disputed: boolean }
type SnapshotPhase = "subscription" | "customer" | "invoices" | "invoice" |
  "payments" | "payment" | "charges" | "direct-charge" | "charge" | "disputes" |
  "lines" | "refresh-subscription" | "refresh-customer" | "done";
interface SnapshotState {
  version: 1; subscriptionId: string; revision: number; identity: string; phase: SnapshotPhase;
  customerId: string; email: string; billingStatus: string;
  invoicePage: Invoice[]; invoiceIndex: number; invoiceCursor: string | null;
  invoiceNext: string | null; invoiceMore: boolean;
  paymentPage: Payment[]; paymentIndex: number; paymentCursor: string | null;
  paymentNext: string | null; paymentMore: boolean;
  chargePage: Charge[]; chargeIndex: number; chargeCursor: string | null;
  chargeNext: string | null; chargeMore: boolean;
  disputeCursor: string | null; lineCursor: string | null; refunded: number;
  suspended: boolean; fullyRefunded: boolean;
}
const charge = (value: Stripe.Charge): Charge => ({
  id: value.id, paid: value.paid, refunded: value.amount_refunded, disputed: value.disputed,
});
const cursor = (value: string | null) => value ? { starting_after: value } : {};
function nextPage<T extends { id: string }>(page: Stripe.ApiList<T>) {
  check(!page.has_more || page.data.length > 0, 502, "billing_pagination", "Provider pagination did not advance.");
  return page.data.at(-1)?.id ?? null;
}

export async function workerSnapshot(source: Source, subscriptionId: string): Promise<BillingSnapshot> {
  const turn = workerTurn()!;
  const slot = "merchant.snapshot";
  const revision = Number((await source.db("locks")
    .where({ id: reconciliationLockId(source.tenant.id, subscriptionId) }).first())?.version ?? 0);
  const initial: SnapshotState = {
    version: 1, subscriptionId, revision, identity: providerIdentity(source), phase: "subscription", customerId: "", email: "", billingStatus: "",
    invoicePage: [], invoiceIndex: 0, invoiceCursor: null, invoiceNext: null, invoiceMore: false,
    paymentPage: [], paymentIndex: 0, paymentCursor: null, paymentNext: null, paymentMore: false,
    chargePage: [], chargeIndex: 0, chargeCursor: null, chargeNext: null, chargeMore: false,
    disputeCursor: null, lineCursor: null, refunded: 0, suspended: false, fullyRefunded: false,
  };
  let state = await turn.state(slot, initial);
  if (state.version !== 1 || state.subscriptionId !== subscriptionId || state.revision !== revision || state.identity !== initial.identity) {
    await turn.reset(slot);
    state = initial;
  }
  const read = <T>(call: (options: Stripe.RequestOptions) => Promise<T>) =>
    turn.read((options) => call({ ...source.options(), ...options }));
  while (true) {
    const invoice = state.invoicePage[state.invoiceIndex];
    const payment = state.paymentPage[state.paymentIndex];
    const selected = state.chargePage[state.chargeIndex];
    const facts: WorkerFact[] = [];
    switch (state.phase) {
      case "subscription":
      case "refresh-subscription": {
        const sub = await read((options) => source.stripe.subscriptions.retrieve(subscriptionId, {}, options));
        state.customerId = providerId(sub.customer)!;
        state.billingStatus = sub.status;
        state.phase = state.phase === "subscription" ? "customer" : "refresh-customer";
        break;
      }
      case "customer":
      case "refresh-customer": {
        const customer = await read((options) => source.stripe.customers.retrieve(state.customerId, {}, options));
        state.email = customer.deleted ? "" : customer.email ?? "";
        state.phase = state.phase === "customer" ? "invoices" : "done";
        break;
      }
      case "invoices": {
        const page = await read((options) => source.stripe.invoices.list({
          subscription: subscriptionId, limit: 100, ...cursor(state.invoiceCursor),
        }, options));
        state.invoiceNext = nextPage(page);
        state.invoiceMore = page.has_more;
        state.invoicePage = page.data.filter((item) => item.status === "paid" && item.amount_paid > 0).map((item) => ({
          id: item.id, currency: item.currency, amount: item.amount_paid,
          paidAt: (item.status_transitions.paid_at ?? item.created) * 1000,
        }));
        state.invoiceIndex = 0;
        state.phase = "invoice";
        break;
      }
      case "invoice":
        if (!invoice) {
          state.invoiceCursor = state.invoiceNext;
          state.phase = state.invoiceMore ? "invoices" : "refresh-subscription";
        } else {
          state.paymentCursor = null;
          state.refunded = 0;
          state.phase = "payments";
        }
        break;
      case "payments": {
        const page = await read((options) => source.stripe.invoicePayments.list({
          invoice: invoice!.id, status: "paid", limit: 100, ...cursor(state.paymentCursor),
        }, options));
        state.paymentNext = nextPage(page);
        state.paymentMore = page.has_more;
        state.paymentPage = page.data.map((item) => ({ id: item.id,
          intent: providerId(item.payment.payment_intent) ?? null,
          charge: providerId(item.payment.charge) ?? null }));
        state.paymentIndex = 0;
        state.phase = "payment";
        break;
      }
      case "payment":
        if (!payment) {
          if (state.paymentMore) {
            state.paymentCursor = state.paymentNext;
            state.phase = "payments";
          } else {
            state.fullyRefunded ||= state.refunded >= invoice!.amount;
            facts.push({ kind: "invoices", id: invoice!.id, value: {
              invoiceId: invoice!.id, currency: invoice!.currency,
              paidMinor: invoice!.amount, refundedMinor: Math.min(invoice!.amount, state.refunded),
            } });
            state.lineCursor = null;
            state.phase = "lines";
          }
        } else if (payment.intent) {
          state.chargeCursor = null;
          state.phase = "charges";
        } else if (payment.charge) state.phase = "direct-charge";
        else state.paymentIndex++;
        break;
      case "charges": {
        const page = await read((options) => source.stripe.charges.list({
          payment_intent: payment!.intent!, limit: 100, ...cursor(state.chargeCursor),
        }, options));
        state.chargeNext = nextPage(page);
        state.chargeMore = page.has_more;
        state.chargePage = page.data.map(charge);
        state.chargeIndex = 0;
        state.phase = "charge";
        break;
      }
      case "direct-charge": {
        const selected = await read((options) => source.stripe.charges.retrieve(payment!.charge!, {}, options));
        state.chargePage = [charge(selected)];
        state.chargeIndex = 0;
        state.chargeMore = false;
        state.phase = "charge";
        break;
      }
      case "charge":
        if (!selected) {
          if (state.chargeMore) {
            state.chargeCursor = state.chargeNext;
            state.phase = "charges";
          } else {
            state.paymentIndex++;
            state.phase = "payment";
          }
        } else {
          const seen = hash(JSON.stringify([invoice!.id, selected.id]));
          if (!selected.paid || await turn.fact(slot, "seen-charge", seen)) state.chargeIndex++;
          else {
            state.refunded += selected.refunded;
            facts.push({ kind: "seen-charge", id: seen, value: true });
            if (selected.disputed) {
              state.disputeCursor = null;
              state.phase = "disputes";
            } else state.chargeIndex++;
          }
        }
        break;
      case "disputes": {
        const page = await read((options) => source.stripe.disputes.list({
          charge: selected!.id, limit: 100, ...cursor(state.disputeCursor),
        }, options));
        const next = nextPage(page);
        state.suspended ||= page.data.some((item) => !["won", "warning_closed"].includes(item.status));
        if (page.has_more) state.disputeCursor = next;
        else { state.chargeIndex++; state.phase = "charge"; }
        break;
      }
      case "lines": {
        const page = await read((options) => source.stripe.invoices.listLineItems(invoice!.id, {
          limit: 100, ...cursor(state.lineCursor),
        }, options));
        const next = nextPage(page);
        for (const line of page.data) {
          const priceId = providerId(line.pricing?.price_details?.price);
          if (line.amount <= 0 || !line.parent?.subscription_item_details || !priceId) continue;
          const value: PaidGrant = { id: line.id, invoiceId: invoice!.id, priceId,
            periodStart: line.period.start * 1000, periodEnd: line.period.end * 1000,
            paidAt: invoice!.paidAt, settled: true };
          facts.push({ kind: "grants", id: line.id, value });
        }
        if (page.has_more) state.lineCursor = next;
        else { state.invoiceIndex++; state.phase = "invoice"; }
        break;
      }
      case "done":
        turn.beginApply();
        return { subscriptionId, customerId: state.customerId, email: state.email,
          billingStatus: state.billingStatus, suspended: state.suspended, fullyRefunded: state.fullyRefunded,
          grants: await turn.facts<PaidGrant>(slot, "grants"),
          invoices: await turn.facts<NonNullable<BillingSnapshot["invoices"]>[number]>(slot, "invoices") };
    }
    await turn.save(slot, state, facts, state.phase === "done");
  }
}

type ResolvePhase = "event" | "charge" | "intent-payments" | "intent-invoice" |
  "customer-invoices" | "customer-invoice" | "legacy-payments" | "done";
interface ResolveState {
  version: 1; eventId: string; identity: string; phase: ResolvePhase; chargeId: string | null;
  customerId: string | null; intentId: string | null; result: string | null;
  cursor: string | null; next: string | null; more: boolean;
  invoices: { id: string; subscription: string | null }[]; index: number;
  payments: { id: string; invoice: string | null }[]; paymentIndex: number;
  paymentCursor: string | null;
}
export async function workerResolveSubscription(source: Source, event: BillingEvent): Promise<string | null> {
  const turn = workerTurn()!;
  const slot = "merchant.resolve";
  const initial: ResolveState = {
    version: 1, eventId: event.id, identity: providerIdentity(source), phase: "event", chargeId: null,
    customerId: null, intentId: null, result: null, cursor: null, next: null, more: false,
    invoices: [], index: 0, payments: [], paymentIndex: 0, paymentCursor: null,
  };
  let state = await turn.state<ResolveState>(slot, initial);
  if (state.eventId !== event.id || state.version !== 1 || state.identity !== initial.identity) {
    await turn.reset(slot);
    state = initial;
  }
  const read = <T>(call: (options: Stripe.RequestOptions) => Promise<T>) =>
    turn.read((options) => call({ ...source.options(), ...options }));
  while (true) {
    const objectId = String(event.data.object.id);
    switch (state.phase) {
      case "event":
        if (event.type.startsWith("customer.subscription.")) {
          state.result = objectId; state.phase = "done";
        } else if (event.type.startsWith("invoice.")) {
          const invoice = await read((options) => source.stripe.invoices.retrieve(objectId, {}, options));
          state.result = providerId(invoice.parent?.subscription_details?.subscription) ?? null;
          state.phase = "done";
        } else if (event.type.startsWith("checkout.session.")) {
          const session = await read((options) => source.stripe.checkout.sessions.retrieve(objectId, {}, options));
          state.result = providerId(session.subscription) ?? null; state.phase = "done";
        } else if (event.type.startsWith("charge.dispute.")) {
          const dispute = await read((options) => source.stripe.disputes.retrieve(objectId, {}, options));
          state.chargeId = providerId(dispute.charge) ?? null; state.phase = state.chargeId ? "charge" : "done";
        } else if (event.type.startsWith("charge.")) {
          state.chargeId = objectId; state.phase = "charge";
        } else if (event.type.startsWith("refund.")) {
          const refund = await read((options) => source.stripe.refunds.retrieve(objectId, {}, options));
          state.chargeId = providerId(refund.charge) ?? null; state.phase = state.chargeId ? "charge" : "done";
        } else state.phase = "done";
        break;
      case "charge": {
        const charge = await read((options) => source.stripe.charges.retrieve(state.chargeId!, {}, options));
        state.intentId = providerId(charge.payment_intent) ?? null;
        state.customerId = providerId(charge.customer) ?? null;
        state.phase = state.intentId ? "intent-payments" : state.customerId ? "customer-invoices" : "done";
        break;
      }
      case "intent-payments": {
        const page = await read((options) => source.stripe.invoicePayments.list({
          payment: { type: "payment_intent", payment_intent: state.intentId! },
          limit: 100, ...cursor(state.cursor),
        }, options));
        state.next = nextPage(page); state.more = page.has_more;
        state.payments = page.data.map((item) => ({ id: item.id, invoice: providerId(item.invoice) ?? null }));
        state.paymentIndex = 0; state.phase = "intent-invoice";
        break;
      }
      case "intent-invoice": {
        const selected = state.payments[state.paymentIndex];
        if (!selected) {
          state.cursor = state.next; state.phase = state.more ? "intent-payments" : "done";
        } else if (!selected.invoice) state.paymentIndex++;
        else {
          const invoice = await read((options) => source.stripe.invoices.retrieve(selected.invoice!, {}, options));
          state.result = providerId(invoice.parent?.subscription_details?.subscription) ?? null;
          if (state.result) state.phase = "done";
          else state.paymentIndex++;
        }
        break;
      }
      case "customer-invoices": {
        const page = await read((options) => source.stripe.invoices.list({
          customer: state.customerId!, limit: 100, ...cursor(state.cursor),
        }, options));
        state.next = nextPage(page); state.more = page.has_more;
        state.invoices = page.data.map((item) => ({ id: item.id,
          subscription: providerId(item.parent?.subscription_details?.subscription) ?? null }));
        state.index = 0; state.phase = "customer-invoice";
        break;
      }
      case "customer-invoice": {
        const selected = state.invoices[state.index];
        if (!selected) { state.cursor = state.next; state.phase = state.more ? "customer-invoices" : "done"; }
        else if (!selected.subscription) state.index++;
        else { state.paymentCursor = null; state.phase = "legacy-payments"; }
        break;
      }
      case "legacy-payments": {
        const selected = state.invoices[state.index]!;
        const page = await read((options) => source.stripe.invoicePayments.list({
          invoice: selected.id, limit: 100, ...cursor(state.paymentCursor),
        }, options));
        const next = nextPage(page);
        if (page.data.some((item) => providerId(item.payment.charge) === state.chargeId)) {
          state.result = selected.subscription; state.phase = "done";
        } else if (page.has_more) state.paymentCursor = next;
        else { state.index++; state.phase = "customer-invoice"; }
        break;
      }
      case "done": return state.result;
    }
    await turn.save(slot, state);
  }
}
