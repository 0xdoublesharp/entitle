import { appUrl } from "../packages/shared/app-path.ts";
import { accountVerificationEmail, emailChangeEmail } from "./transactional-email.ts";
import type { Message } from "./email.ts";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DB, Customer, License, Tx } from "./db.ts";
import { lock } from "./db.ts";
import type {
  PlatformAuth,
  SellerSession,
  SellerUser,
} from "./platform-auth.ts";
import type { Auth } from "./auth.ts";
import { hash, random, seal, unseal } from "./crypto.ts";
import { check } from "./errors.ts";
import { recordBusinessEvent } from "./business-events.ts";
import { outboundEventTypes } from "./outbound-webhooks.ts";

export const sensitivePurposes = [
  "recovery_codes",
  "billing",
  "api_keys",
  "tenant_transfer",
  "workspace_remove",
  "release_publish",
] as const;
export type SensitivePurpose = (typeof sensitivePurposes)[number];
const empty = z.object({}).strict();
const secret = z.string().min(1).max(200);
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const purposeSchema = z.enum(sensitivePurposes);
const limit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });

export { privacyReferenceDigest } from "./privacy-attribution.ts";
import {
  privacyReferenceDigest,
  sealPrivacyAttribution,
  unsealPrivacyAttribution,
} from "./privacy-attribution.ts";

async function audit(
  tx: Tx,
  actor: string,
  action: string,
  tenant: string | null = null,
  details: Record<string, unknown> = {},
) {
  await tx("audit_events").insert({
    id: randomUUID(),
    tenant_id: tenant,
    actor_type: tenant === null ? "seller" : "customer",
    actor_id: actor,
    action,
    details: JSON.stringify(details),
    created_at: Date.now(),
  });
}

export class AccountManagement {
  db: DB;
  auth: PlatformAuth;
  recoveryCookieName: string;
  constructor(db: DB, auth: PlatformAuth) {
    this.db = db;
    this.auth = auth;
    this.recoveryCookieName = `${auth.config.production ? "__Host-" : ""}de-account-recovery`;
  }
  private async throttle(scope: string, max: number, windowMs: number) {
    const allowed = await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const now = Date.now();
      await tx("account_attempts").where("expires_at", "<=", now).delete();
      const id = hash(scope);
      const previous = await tx("account_attempts").where({ id }).first();
      if (previous && previous.attempts >= max) return false;
      if (previous)
        await tx("account_attempts").where({ id }).increment("attempts", 1);
      else
        await tx("account_attempts").insert({
          id,
          attempts: 1,
          expires_at: now + windowMs,
        });
      return true;
    });
    check(
      allowed,
      429,
      "account_rate_limited",
      "Too many account attempts. Try again later.",
    );
  }
  private async sellerAction<T>(
    req: FastifyRequest,
    mutation: boolean,
    action: (tx: Tx, session: SellerSession) => Promise<T>,
  ) {
    const session = await this.auth.seller(req, mutation);
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const current = await tx("seller_sessions")
        .where({ id: session.sessionHash, user_id: session.user.id })
        .andWhere("expires_at", ">", Date.now())
        .first();
      const user = await tx<SellerUser>("seller_users")
        .where({ id: session.user.id })
        .whereNotNull("verified_at")
        .first();
      check(
        current &&
          user &&
          (this.auth.config.deploymentMode !== "standalone" ||
            user.email === this.auth.config.standaloneOwnerEmail),
        401,
        "seller_login_required",
        "Sign in again.",
      );
      return action(tx, { ...session, user });
    });
  }
  private sessionId(id: string) {
    return hash(`account-session:${this.auth.config.secret}:${id}`);
  }
  async sessions(req: FastifyRequest) {
    return this.sellerAction(req, false, async (tx, session) => ({
      sessions: (
        await tx("seller_sessions")
          .where({ user_id: session.user.id })
          .andWhere("expires_at", ">", Date.now())
          .orderBy("expires_at", "desc")
      ).map((row) => ({
        id: this.sessionId(row.id),
        current: row.id === session.sessionHash,
        expiresAt: Number(row.expires_at),
      })),
    }));
  }
  async revokeSessions(
    req: FastifyRequest,
    mode: "one" | "others" | "all",
    id?: string,
  ) {
    return this.sellerAction(req, true, async (tx, session) => {
      const sessions = await tx("seller_sessions").where({
        user_id: session.user.id,
      });
      const revoked = sessions.filter(
        (row) =>
          mode === "all" ||
          (mode === "others"
            ? row.id !== session.sessionHash
            : this.sessionId(row.id) === id),
      );
      check(
        mode !== "one" || revoked.length === 1,
        404,
        "session_not_found",
        "Session was not found.",
      );
      const ids = revoked.map((row) => row.id as string);
      await tx("account_challenges")
        .where({ user_id: session.user.id })
        .whereIn("session_hash", ids)
        .delete();
      await tx("seller_sessions")
        .where({ user_id: session.user.id })
        .whereIn("id", ids)
        .delete();
      await audit(tx, session.user.id, "seller.sessions.revoked", null, {
        mode,
        count: ids.length,
      });
      return { ok: true };
    });
  }
  private async send(tx: Tx, kind: string, message: Omit<Message, "messageId">) {
    const id = randomUUID();
    await tx("platform_emails").insert({
      id,
      kind,
      created_at: Date.now(),
      payload: seal(
        {
          ...message,
          messageId: `<${id}@entitle>`,
        },
        this.auth.config.secret,
      ),
    });
  }
  async requestVerification(req: FastifyRequest, purpose: SensitivePurpose) {
    const session = await this.auth.seller(req, true);
    await this.throttle(`verification-request:${session.user.id}`, 5, 3600000);
    return this.sellerAction(req, true, async (tx, s) => {
      await tx("account_challenges")
        .where({
          user_id: s.user.id,
          session_hash: s.sessionHash,
          purpose: `email:${purpose}`,
        })
        .delete();
      const token = random();
      await tx("account_challenges").insert({
        id: randomUUID(),
        user_id: s.user.id,
        session_hash: s.sessionHash,
        purpose: `email:${purpose}`,
        token_hash: hash(token),
        created_at: Date.now(),
        expires_at: Date.now() + 600000,
      });
      await this.send(
        tx,
        "account_verification",
        accountVerificationEmail(s.user.email, appUrl(this.auth.config, `/seller#account-verification=${token}`), purpose),
      );
      await audit(tx, s.user.id, "seller.verification.requested", null, {
        purpose,
      });
      return { ok: true };
    });
  }
  private async consumeChallenge(
    tx: Tx,
    s: SellerSession,
    purpose: string,
    token: string,
  ) {
    const challenge = await tx("account_challenges")
      .where({
        user_id: s.user.id,
        session_hash: s.sessionHash,
        purpose,
        token_hash: hash(token),
      })
      .andWhere("expires_at", ">", Date.now())
      .first();
    check(
      challenge,
      403,
      "verification_required",
      "Fresh verification in this browser is required for this action.",
    );
    await tx("account_challenges").where({ id: challenge.id }).delete();
    return challenge;
  }
  async consumeVerification(
    req: FastifyRequest,
    purpose: SensitivePurpose,
    token: string,
  ) {
    const session = await this.auth.seller(req, true);
    await this.throttle(`verification-consume:${session.user.id}`, 20, 900000);
    return this.sellerAction(req, true, async (tx, s) => {
      await this.consumeChallenge(tx, s, `email:${purpose}`, token);
      const verification = random();
      await tx("account_challenges").insert({
        id: randomUUID(),
        user_id: s.user.id,
        session_hash: s.sessionHash,
        purpose: `grant:${purpose}`,
        token_hash: hash(verification),
        created_at: Date.now(),
        expires_at: Date.now() + 300000,
      });
      return { verification, expiresIn: 300 };
    });
  }
  async withStepUp<T>(
    req: FastifyRequest,
    purpose: SensitivePurpose,
    verification: string,
    action: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.sellerAction(req, true, async (tx, s) => {
      await this.consumeChallenge(tx, s, `grant:${purpose}`, verification);
      const result = await action(tx);
      await audit(tx, s.user.id, "seller.verification.used", null, { purpose });
      return result;
    });
  }
  async requireStepUp(
    req: FastifyRequest,
    purpose: SensitivePurpose,
    verification?: string,
  ) {
    const supplied = verification ?? req.headers["x-account-verification"];
    check(
      typeof supplied === "string" &&
        supplied.length > 0 &&
        supplied.length <= 200,
      403,
      "verification_required",
      "Fresh verification is required for this action.",
    );
    await this.withStepUp(req, purpose, supplied, async () => undefined);
  }
  async recoveryCodes(req: FastifyRequest, verification: string) {
    return this.sellerAction(req, true, async (tx, s) => {
      await this.consumeChallenge(tx, s, "grant:recovery_codes", verification);
      const codes = Array.from({ length: 10 }, () => random());
      await tx("account_recovery_codes").where({ user_id: s.user.id }).delete();
      await tx("account_recovery_codes").insert(
        codes.map((code) => ({
          id: hash(`recovery:${s.user.id}:${code}`),
          user_id: s.user.id,
          created_at: Date.now(),
        })),
      );
      await audit(tx, s.user.id, "seller.recovery.rotated");
      return { codes };
    });
  }
  startRecovery(req: FastifyRequest, reply: FastifyReply) {
    this.auth.origin(req);
    reply.setCookie(
      this.recoveryCookieName,
      seal(
        { nonce: random(), expiresAt: Date.now() + 900000 },
        this.auth.config.secret,
      ),
      this.cookieOptions(900),
    );
    return { ok: true };
  }
  private cookieOptions(maxAge: number) {
    return {
      path: "/",
      httpOnly: true,
      secure: this.auth.config.production,
      sameSite: "lax" as const,
      maxAge,
    };
  }
  async recover(
    req: FastifyRequest,
    reply: FastifyReply,
    address: string,
    code: string,
  ) {
    this.auth.origin(req);
    let browser: { nonce: string; expiresAt: number } | undefined;
    try {
      browser = unseal(
        req.cookies[this.recoveryCookieName] ?? "",
        this.auth.config.secret,
      );
    } catch {
      /* Invalid cookies grant no recovery attempt. */
    }
    check(
      browser &&
        typeof browser.nonce === "string" &&
        browser.expiresAt > Date.now(),
      401,
      "invalid_recovery",
      "Start account recovery in this browser first.",
    );
    await this.throttle(`recovery:${address}`, 5, 900000);
    const token = random();
    const recovered = await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const user = await tx<SellerUser>("seller_users")
        .where({ email: address })
        .whereNotNull("verified_at")
        .first();
      const validOwner =
        this.auth.config.deploymentMode !== "standalone" ||
        address === this.auth.config.standaloneOwnerEmail;
      const recovery =
        user && validOwner
          ? await tx("account_recovery_codes")
              .where({
                user_id: user.id,
                id: hash(`recovery:${user.id}:${code}`),
              })
              .first()
          : undefined;
      if (!recovery) {
        await audit(
          tx,
          privacyReferenceDigest(
            this.auth.config.secret,
            `recovery-address:${address}`,
          ),
          "seller.recovery.failed",
        );
        return false;
      }
      await tx("account_recovery_codes").where({ id: recovery.id }).delete();
      await tx("seller_sessions").where({ user_id: user!.id }).delete();
      await tx("seller_login_tokens").where({ user_id: user!.id }).delete();
      await tx("account_challenges").where({ user_id: user!.id }).delete();
      await tx("seller_sessions").insert({
        id: hash(token),
        user_id: user!.id,
        expires_at: Date.now() + 7 * 86400000,
      });
      await audit(tx, user!.id, "seller.recovery.used");
      return true;
    });
    check(
      recovered,
      401,
      "invalid_recovery",
      "Recovery credentials are invalid or already used.",
    );
    reply.setCookie(this.auth.cookieName, token, this.cookieOptions(7 * 86400));
    return { ok: true };
  }
  private hostedEmailChange() {
    check(
      this.auth.config.deploymentMode === "hosted",
      409,
      "operator_email_change_required",
      "Standalone owner email changes require the operator to update the configured owner and account together during maintenance.",
    );
  }
  async requestEmailChange(req: FastifyRequest, address: string) {
    const session = await this.auth.seller(req, true);
    this.hostedEmailChange();
    await this.throttle(`email-change:${session.user.id}`, 5, 3600000);
    return this.sellerAction(req, true, async (tx, s) => {
      check(
        !(await tx("seller_users").where({ email: address }).first()),
        409,
        "email_conflict",
        "That email address is unavailable.",
      );
      await tx("account_challenges")
        .where({ user_id: s.user.id, purpose: "email_change" })
        .delete();
      const id = randomUUID(),
        currentToken = random(),
        newToken = random();
      await tx("account_challenges").insert({
        id,
        user_id: s.user.id,
        session_hash: s.sessionHash,
        purpose: "email_change",
        token_hash: hash(currentToken),
        second_hash: hash(newToken),
        email: address,
        old_email_hash: hash(s.user.email),
        created_at: Date.now(),
        expires_at: Date.now() + 900000,
      });
      await this.send(
        tx,
        "account_email_current",
        emailChangeEmail(s.user.email, appUrl(this.auth.config, `/seller#account-email-change=${id}&token=${currentToken}`), address, true),
      );
      await this.send(
        tx,
        "account_email_new",
        emailChangeEmail(address, appUrl(this.auth.config, `/seller#account-email-change=${id}&token=${newToken}`), address, false),
      );
      await audit(tx, s.user.id, "seller.email_change.requested");
      return { id, expiresIn: 900 };
    });
  }
  async confirmEmailChange(
    req: FastifyRequest,
    id: string,
    currentToken: string,
    newToken: string,
  ) {
    return this.sellerAction(req, true, async (tx, s) => {
      this.hostedEmailChange();
      const change = await tx("account_challenges")
        .where({
          id,
          user_id: s.user.id,
          session_hash: s.sessionHash,
          purpose: "email_change",
          token_hash: hash(currentToken),
          second_hash: hash(newToken),
          old_email_hash: hash(s.user.email),
        })
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(
        change,
        403,
        "verification_required",
        "Both email proofs in the requesting browser are required.",
      );
      check(
        !(await tx("seller_users").where({ email: change.email }).first()),
        409,
        "email_conflict",
        "That email address is unavailable.",
      );
      await tx("seller_users")
        .where({ id: s.user.id })
        .update({ email: change.email, verified_at: Date.now() });
      await tx("seller_login_tokens").where({ user_id: s.user.id }).delete();
      await tx("seller_sessions").where({ user_id: s.user.id }).delete();
      await tx("account_recovery_codes").where({ user_id: s.user.id }).delete();
      await tx("account_challenges").where({ user_id: s.user.id }).delete();
      await audit(tx, s.user.id, "seller.email_change.completed");
      return { ok: true, signInRequired: true };
    });
  }
}

export const customerRetentionPlan =
  "Closure requires operator approval after Stripe and billing reconciliation. Paid and installed license rights are preserved until explicitly resolved. Minimal billing totals, event identifiers, audit history and hash revocations remain for reconciliation. Customer email, site addresses, encrypted mail, login links and sessions are removed only after blockers are cleared. Remote Stripe customers and subscriptions are never deleted automatically. Backups follow the operator's documented retention schedule; external provider and delivered email copies require separate handling.";
export interface ClosureApproval {
  quiesced: true;
  stripeReconciled: true;
  retentionReviewed: true;
}
export interface ClosureReconciliation extends ClosureApproval {
  reference: string;
  stripeCustomerId: string | null;
  eventIds: string[];
  workIds: string[];
  auditIds: string[];
  outgoingEventIds: string[];
}
const reconciliationSchema = z
  .object({
    quiesced: z.literal(true),
    stripeReconciled: z.literal(true),
    retentionReviewed: z.literal(true),
    reference: z.string().min(1).max(200),
    stripeCustomerId: z.string().max(150).nullable(),
    eventIds: z.array(secret).max(1000),
    workIds: z.array(secret).max(1000),
    auditIds: z.array(secret).max(1000),
    outgoingEventIds: z.array(secret).max(1000),
  })
  .strict();
function containsReference(
  value: unknown,
  references: ReadonlySet<string>,
  encode: (value: string) => string,
): boolean {
  if (typeof value === "string") return references.has(encode(value));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((item) =>
      containsReference(item, references, encode),
    );
  return false;
}
export function retainedFinancial(event: unknown) {
  const parsed = z
    .object({ data: z.object({ object: z.record(z.string(), z.unknown()) }) })
    .parse(event);
  const financial: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(parsed.data.object)) {
    if (
      value === null &&
      ["ending_balance", "application_fee_amount", "tax"].includes(key)
    )
      continue;
    if (key === "currency")
      financial[key] = z
        .string()
        .regex(/^[a-z]{3}$/)
        .parse(value);
    if (
      [
        "amount",
        "amount_paid",
        "amount_refunded",
        "amount_due",
        "total",
        "subtotal",
        "tax",
        "starting_balance",
        "ending_balance",
        "application_fee_amount",
      ].includes(key)
    )
      financial[key] = z.number().int().safe().parse(value);
  }
  return financial;
}
interface ClosureRow {
  tenant_id: string;
  customer_id: string;
  id: string;
  status: "awaiting_operator" | "blocked" | "completed";
  blockers: string;
  requested_at: number;
  completed_at: number | null;
}

/** Match only a canonical Stripe customer ID, never arbitrary event metadata. */
export async function completedCustomerClosure(
  db: DB | Tx,
  tenantId: string,
  secret: string,
  stripeCustomerId: string,
  stripeLiveMode: boolean,
) {
  const digest = privacyReferenceDigest(secret, stripeCustomerId);
  const receipts = await db("account_privacy_receipts")
    .join("account_closures", function () {
      this.on(
        "account_closures.tenant_id",
        "account_privacy_receipts.tenant_id",
      )
        .andOn(
          "account_closures.customer_id",
          "account_privacy_receipts.customer_id",
        )
        .andOn("account_closures.id", "account_privacy_receipts.request_id");
    })
    .where({
      "account_closures.tenant_id": tenantId,
      "account_closures.status": "completed",
    })
    .select("account_privacy_receipts.*");
  return receipts.find((receipt) => {
    const details = JSON.parse(receipt.details);
    const matches = z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .max(10000)
      .parse(details.referenceDigests)
      .includes(digest);
    if (!matches) return false;
    check(
      typeof details.stripeLiveMode === "boolean",
      503,
      "billing_privacy_mode_required",
      "Establish the retained receipt's provider mode before replay.",
    );
    if (details.stripeLiveMode !== stripeLiveMode) return false;
    if (details.stripeCustomerAttribution !== undefined) {
      unsealPrivacyAttribution(
        details.stripeCustomerAttribution,
        {
          tenantId,
          customerId: receipt.customer_id,
          requestId: receipt.request_id,
          stripeLiveMode,
        },
        secret,
      );
      // Each reconciliation retains all earlier HMAC bindings for this exact
      // closure. Authenticated null or a later provider binding cannot undo them.
    }
    return true;
  });
}

/** A transferred closed subscription needs no provider snapshot, even if Stripe deleted its customer. */
export async function completedSubscriptionClosure(
  db: DB | Tx,
  tenantId: string,
  secret: string,
  subscriptionId: string,
  stripeLiveMode: boolean,
) {
  const rows = await db("account_privacy_receipts as receipt")
    .join("account_closures as closure", function () {
      this.on("closure.tenant_id", "receipt.tenant_id")
        .andOn("closure.customer_id", "receipt.customer_id")
        .andOn("closure.id", "receipt.request_id");
    })
    .join("licenses as license", function () {
      this.on("license.tenant_id", "closure.tenant_id").andOn(
        "license.customer_id",
        "closure.customer_id",
      );
    })
    .where({
      "closure.tenant_id": tenantId,
      "closure.status": "completed",
      "license.subscription_id": subscriptionId,
    })
    .select("receipt.*");
  for (const row of rows) {
    const details = JSON.parse(row.details);
    if (
      details.stripeLiveMode !== stripeLiveMode ||
      details.stripeCustomerAttribution === undefined
    )
      continue;
    if (
      unsealPrivacyAttribution(
        details.stripeCustomerAttribution,
        {
          tenantId,
          customerId: row.customer_id,
          requestId: row.request_id,
          stripeLiveMode,
        },
        secret,
      ) !== null
    )
      return true;
  }
  return false;
}

export class CustomerAccounts {
  db: DB;
  auth: Auth;
  constructor(db: DB, auth: Auth) {
    this.db = db;
    this.auth = auth;
  }
  private async referenceMatcher(
    tx: Tx,
    customerId: string,
    requestId: string,
    values: ReadonlySet<string>,
  ) {
    const encode = (value: string) =>
      privacyReferenceDigest(this.auth.config.secret, value);
    const digests = new Set([...values].map(encode));
    for (const receipt of await tx("account_privacy_receipts").where({
      tenant_id: this.auth.tenant.id,
      customer_id: customerId,
      request_id: requestId,
    })) {
      const details = JSON.parse(receipt.details);
      for (const value of z
        .array(z.string().regex(/^[a-f0-9]{64}$/))
        .max(10000)
        .parse(details.referenceDigests))
        digests.add(value);
    }
    return {
      digests,
      add: (value: string) => digests.add(encode(value)),
      contains: (value: unknown) => containsReference(value, digests, encode),
    };
  }
  private async customerAction<T>(
    req: FastifyRequest,
    mutation: boolean,
    action: (tx: Tx, customer: Customer) => Promise<T>,
  ) {
    const session = await this.auth.customer(req, mutation);
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth", this.auth.tenant.id);
      const current = await tx("sessions")
        .where({
          tenant_id: this.auth.tenant.id,
          id: session.sessionHash,
          customer_id: session.customer.id,
        })
        .andWhere("expires_at", ">", Date.now())
        .first();
      const customer = await tx<Customer>("customers")
        .where({ tenant_id: this.auth.tenant.id, id: session.customer.id })
        .first();
      check(current && customer, 401, "login_required", "Sign in again.");
      return action(tx, customer);
    });
  }
  private scope(customerId: string) {
    return { tenant_id: this.auth.tenant.id, customer_id: customerId };
  }
  private result(row: ClosureRow) {
    return {
      id: row.id,
      status: row.status,
      blockers: JSON.parse(row.blockers) as string[],
      requestedAt: Number(row.requested_at),
      completedAt: row.completed_at === null ? null : Number(row.completed_at),
      retentionPlan: customerRetentionPlan,
    };
  }
  async export(req: FastifyRequest) {
    return this.customerAction(req, false, async (tx, customer) => {
      await lock(tx, "billing", this.auth.tenant.id);
      const licenses = await tx("licenses")
        .where(this.scope(customer.id))
        .select(
          "id",
          "product_id",
          "plan_id",
          "site_allowance",
          "paid_through",
          "billing_status",
          "subscription_id",
          "revoked",
          "refund_revoked",
          "suspended",
          "provenance",
          "expires_at",
          "issued_at",
        );
      const licenseIds = licenses.map((row) => row.id as string);
      const grants = await tx("grants")
        .where({ tenant_id: this.auth.tenant.id })
        .whereIn("license_id", licenseIds)
        .select(
          "id",
          "license_id",
          "invoice_id",
          "plan_id",
          "period_start",
          "period_end",
          "paid_at",
        );
      const installations = await tx("installations")
        .where({ tenant_id: this.auth.tenant.id })
        .whereIn("license_id", licenseIds)
        .select(
          "id",
          "license_id",
          "installation_id",
          "site_url",
          "label",
          "active",
          "exempt",
        );
      const invoices = await tx("invoice_metrics")
        .where({ tenant_id: this.auth.tenant.id })
        .whereIn(
          "invoice_id",
          grants.map((row) => row.invoice_id as string),
        )
        .select("invoice_id", "currency", "paid_minor", "refunded_minor");
      await audit(
        tx,
        customer.id,
        "customer.data.exported",
        this.auth.tenant.id,
      );
      return {
        exportedAt: Date.now(),
        customer: {
          id: customer.id,
          email: customer.email,
          stripeId: customer.stripe_id,
        },
        licenses,
        grants,
        installations,
        invoices,
      };
    });
  }
  async requestClosure(req: FastifyRequest) {
    return this.customerAction(req, true, async (tx, customer) => {
      let row = await tx<ClosureRow>("account_closures")
        .where(this.scope(customer.id))
        .first();
      if (!row) {
        row = {
          ...this.scope(customer.id),
          id: randomUUID(),
          status: "awaiting_operator",
          blockers: "[]",
          requested_at: Date.now(),
          completed_at: null,
        };
        await tx("account_closures").insert(row);
        await audit(
          tx,
          customer.id,
          "customer.closure.requested",
          this.auth.tenant.id,
          { requestId: row.id },
        );
      }
      return { request: this.result(row) };
    });
  }
  async closure(req: FastifyRequest) {
    return this.customerAction(req, false, async (tx, customer) => {
      const row = await tx<ClosureRow>("account_closures")
        .where(this.scope(customer.id))
        .first();
      return { request: row ? this.result(row) : null };
    });
  }
  // Call only during operator maintenance after external subscriptions and
  // transactions have been reconciled. No provider calls or cancellations occur.
  async reconcileClosure(
    customerId: string,
    requestId: string,
    operatorId: string,
    input: ClosureReconciliation,
  ) {
    check(
      operatorId.trim().length > 0,
      403,
      "operator_required",
      "An authenticated operator is required.",
    );
    const approval = reconciliationSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const tenant = this.auth.tenant.id;
      for (const name of ["auth", "billing", "work", "email"])
        await lock(tx, name, tenant);
      const scope = this.scope(customerId);
      const request = await tx<ClosureRow>("account_closures")
        .where({ ...scope, id: requestId })
        .first();
      check(
        request && request.status !== "completed",
        409,
        "closure_reconciliation_conflict",
        "An open closure request is required.",
      );
      const receiptId = hash(
        JSON.stringify([tenant, requestId, approval.reference]),
      );
      if (
        await tx("account_privacy_receipts")
          .where({ ...scope, id: receiptId, request_id: requestId })
          .first()
      )
        return { reconciled: true, receiptId };
      const customer = (await tx<Customer>("customers")
        .where({ tenant_id: tenant, id: customerId })
        .first())!;
      check(
        customer.stripe_id === approval.stripeCustomerId,
        409,
        "closure_reconciliation_conflict",
        "Reconcile the customer's current Stripe binding before redaction.",
      );
      const licenses = await tx<License>("licenses").where(scope);
      check(
        licenses.every(
          (l) =>
            (l.revoked || l.refund_revoked) &&
            (!l.subscription_id?.startsWith("sub_") ||
              ["canceled", "incomplete_expired"].includes(l.billing_status)),
        ),
        409,
        "closure_record_unresolved",
        "Resolve paid rights and subscriptions explicitly before redaction.",
      );
      const grants = await tx("grants")
        .where({ tenant_id: tenant })
        .whereIn(
          "license_id",
          licenses.map((l) => l.id),
        );
      const references = new Set([
        customer.id,
        customer.email,
        ...licenses.flatMap((l) =>
          l.subscription_id ? [l.id, l.subscription_id] : [l.id],
        ),
        ...grants.map((g) => g.invoice_id as string),
      ]);
      if (customer.stripe_id) references.add(customer.stripe_id);
      const matcher = await this.referenceMatcher(
        tx,
        customerId,
        requestId,
        references,
      );
      const events: {
        id: string;
        type: string;
        payloadHash: string;
        financial: Record<string, string | number>;
      }[] = [];
      for (const id of new Set(approval.eventIds)) {
        const row = await tx("billing_events")
          .where({ tenant_id: tenant, id })
          .first();
        check(
          row,
          403,
          "closure_record_denied",
          "A selected record does not belong to this customer's closure.",
        );
        check(
          row.processed_at !== null,
          409,
          "closure_record_unresolved",
          "Process and reconcile provider events before redaction.",
        );
        const event = unseal<unknown>(row.payload, this.auth.config.secret);
        check(
          matcher.contains(event),
          403,
          "closure_record_denied",
          "A selected record does not belong to this customer's closure.",
        );
        events.push({
          id,
          type: row.type,
          payloadHash: hash(row.payload),
          financial: retainedFinancial(event),
        });
        matcher.add(id);
      }
      for (const id of new Set(approval.workIds)) {
        const row = await tx("work").where({ tenant_id: tenant, id }).first();
        check(
          row,
          403,
          "closure_record_denied",
          "A selected record does not belong to this customer's closure.",
        );
        check(
          !["pending", "running"].includes(row.state) &&
            Number(row.lease_until) <= Date.now(),
          409,
          "closure_record_unresolved",
          "Drain active work before redaction.",
        );
        check(
          matcher.contains(
            unseal<unknown>(row.payload, this.auth.config.secret),
          ),
          403,
          "closure_record_denied",
          "A selected record does not belong to this customer's closure.",
        );
        await tx("work").where({ tenant_id: tenant, id }).update({
          payload: "{}",
          state: "canceled",
          last_error: "privacy_redacted",
        });
      }
      for (const id of new Set(approval.auditIds)) {
        const row = await tx("audit_events")
          .where({ tenant_id: tenant, id })
          .first();
        check(
          row &&
            (row.actor_id === customerId ||
              matcher.contains(JSON.parse(row.details))),
          403,
          "closure_record_denied",
          "A selected audit record does not belong to this customer's closure.",
        );
        await tx("audit_events")
          .where({ tenant_id: tenant, id })
          .update({ details: "{}" });
      }
      for (const id of new Set(approval.outgoingEventIds)) {
        const row = await tx("outbound_events")
          .where({ tenant_id: tenant, id })
          .first();
        check(
          row && matcher.contains(JSON.parse(row.payload)),
          403,
          "closure_record_denied",
          "A selected outgoing record does not belong to this customer's closure.",
        );
        const active = await tx("outbound_deliveries")
          .where({ tenant_id: tenant, event_id: id })
          .andWhere((q) =>
            q
              .whereIn("state", ["pending", "running"])
              .orWhere("lease_until", ">", Date.now()),
          )
          .first();
        check(
          !active,
          409,
          "closure_record_unresolved",
          "Drain outgoing deliveries before redaction.",
        );
        await tx("outbound_events")
          .where({ tenant_id: tenant, id })
          .update({ payload: "{}" });
      }
      for (const event of events)
        await tx("billing_events")
          .where({ tenant_id: tenant, id: event.id })
          .update({ payload: "{}" });
      const invoices = await tx("invoice_metrics")
        .where({ tenant_id: tenant })
        .whereIn(
          "invoice_id",
          grants.map((g) => g.invoice_id as string),
        )
        .select("invoice_id", "currency", "paid_minor", "refunded_minor");
      await tx("account_privacy_receipts").insert({
        id: receiptId,
        ...scope,
        request_id: requestId,
        details: JSON.stringify({
          referenceDigests: [...matcher.digests],
          stripeLiveMode: this.auth.config.stripeLiveMode === true,
          stripeCustomerAttribution: sealPrivacyAttribution(
            {
              tenantId: tenant,
              customerId,
              requestId,
              stripeLiveMode: this.auth.config.stripeLiveMode === true,
            },
            customer.stripe_id,
            this.auth.config.secret,
          ),
          events,
          invoices,
          workIds: approval.workIds,
          auditIds: approval.auditIds,
          outgoingEventIds: approval.outgoingEventIds,
        }),
        created_at: Date.now(),
      });
      await tx("customers")
        .where({ tenant_id: tenant, id: customerId })
        .update({ stripe_id: null });
      await audit(tx, customerId, "customer.closure.reconciled", tenant, {
        requestId,
        receiptId,
        operatorId,
      });
      return { reconciled: true, receiptId };
    });
  }

  /** Reviewed operator-only upgrade. Proves existing attribution; never restores identity columns. */
  async upgradeClosureAttribution(
    customerId: string,
    requestId: string,
    operatorId: string,
    input: ClosureReconciliation,
    stripeLiveMode: boolean,
  ) {
    check(
      operatorId.trim().length > 0,
      403,
      "operator_required",
      "An authenticated operator is required.",
    );
    const approval = reconciliationSchema.parse(input);
    check(
      typeof stripeLiveMode === "boolean" &&
        stripeLiveMode === (this.auth.config.stripeLiveMode === true),
      409,
      "privacy_attribution_mismatch",
      "Reviewed provider mode must match this maintenance runtime.",
    );
    check(
      [
        approval.eventIds,
        approval.workIds,
        approval.auditIds,
        approval.outgoingEventIds,
      ].every((ids) => ids.length === 0),
      409,
      "privacy_attribution_mismatch",
      "Attribution upgrades do not redact records. Supply empty record selections.",
    );
    return this.db.transaction(async (tx) => {
      const tenantId = this.auth.tenant.id;
      for (const name of ["auth", "billing", "work", "email"])
        await lock(tx, name, tenantId);
      const scope = this.scope(customerId);
      const closure = await tx<ClosureRow>("account_closures")
        .where({ ...scope, id: requestId, status: "completed" })
        .first();
      check(
        closure,
        409,
        "closure_reconciliation_conflict",
        "A completed scoped closure is required for attribution upgrade.",
      );
      const rows = await tx("account_privacy_receipts").where({
        ...scope,
        request_id: requestId,
      });
      check(
        rows.length > 0,
        409,
        "privacy_attribution_mismatch",
        "Retained reconciliation evidence is required.",
      );
      const binding = { tenantId, customerId, requestId, stripeLiveMode };
      const parsed = rows.map((row) => ({
        row,
        details: JSON.parse(row.details),
      }));
      for (const { details } of parsed) {
        check(
          details.stripeLiveMode === undefined ||
            details.stripeLiveMode === stripeLiveMode,
          409,
          "privacy_attribution_mismatch",
          "Every existing receipt mode must match the explicitly reviewed provider mode.",
        );
        z.array(z.string().regex(/^[a-f0-9]{64}$/))
          .max(10000)
          .parse(details.referenceDigests);
        if (details.stripeCustomerAttribution !== undefined) {
          const current = unsealPrivacyAttribution(
            details.stripeCustomerAttribution,
            binding,
            this.auth.config.secret,
          );
          check(
            current === null || current === approval.stripeCustomerId,
            409,
            "privacy_attribution_mismatch",
            "Reviewed attribution conflicts with an authenticated receipt.",
          );
        }
      }
      if (approval.stripeCustomerId !== null) {
        const digest = privacyReferenceDigest(
          this.auth.config.secret,
          approval.stripeCustomerId,
        );
        check(
          parsed.some(({ details }) =>
            details.referenceDigests.includes(digest),
          ),
          409,
          "privacy_attribution_mismatch",
          "The reviewed provider identifier must match retained keyed evidence.",
        );
      } else {
        const licenses = await tx<License>("licenses").where(scope);
        check(
          !licenses.some((license) =>
            license.subscription_id?.startsWith("sub_"),
          ),
          409,
          "privacy_attribution_mismatch",
          "Stripe-backed closures require verified customer attribution.",
        );
      }
      for (const { row, details } of parsed) {
        // Only the mandatory private reviewed document may establish a legacy missing mode.
        details.stripeLiveMode = stripeLiveMode;
        details.stripeCustomerAttribution = sealPrivacyAttribution(
          binding,
          approval.stripeCustomerId,
          this.auth.config.secret,
        );
        await tx("account_privacy_receipts")
          .where({ ...scope, request_id: requestId, id: row.id })
          .update({ details: JSON.stringify(details) });
      }
      await audit(
        tx,
        customerId,
        "customer.closure.attribution_upgraded",
        tenantId,
        { requestId, operatorId, receipts: rows.length },
      );
      return { upgraded: true, receipts: rows.length };
    });
  }

  private async closureBlockers(tx: Tx, customerId: string, requestId: string) {
    const tenant = this.auth.tenant.id;
    const scope = this.scope(customerId);
    const customer = (await tx<Customer>("customers")
      .where({ tenant_id: tenant, id: customerId })
      .first())!;
    const licenses = await tx<License>("licenses").where(scope);
    const blockers: string[] = [];
    const blockerRecords: Record<string, string[]> = {
      customers: [],
      licenses: [],
      emails: [],
      billing_events: [],
      work: [],
      audit_events: [],
      outbound_events: [],
      outbound_deliveries: [],
    };
    blockerRecords.customers = customer.stripe_id ? [customerId] : [];
    blockerRecords.licenses = licenses
      .filter(
        (l) =>
          (!l.revoked && !l.refund_revoked) ||
          (l.subscription_id?.startsWith("sub_") &&
            !["canceled", "incomplete_expired"].includes(l.billing_status)),
      )
      .map((l) => l.id);
    if (licenses.some((l) => !l.revoked && !l.refund_revoked))
      blockers.push("paid_or_installed_rights");
    if (customer.stripe_id) blockers.push("stripe_customer_reconciliation");
    if (
      licenses.some(
        (l) =>
          l.subscription_id?.startsWith("sub_") &&
          !["canceled", "incomplete_expired"].includes(l.billing_status),
      )
    )
      blockers.push("stripe_subscription");
    const pendingMail = await tx("emails")
      .where(scope)
      .andWhere((q) =>
        q
          .whereIn("state", ["pending", "running"])
          .orWhere("lease_until", ">", Date.now()),
      )
      .select("id");
    blockerRecords.emails = pendingMail.map((r) => r.id as string);
    if (pendingMail.length) blockers.push("pending_customer_email");
    // Scope retained data to the closing identity, including event-ID jobs.
    // Corrupt/unattributable encrypted data stays blocked for operator repair;
    // known other-customer and seller records remain untouched.
    const grants = await tx("grants")
      .where({ tenant_id: tenant })
      .whereIn(
        "license_id",
        licenses.map((l) => l.id),
      );
    const ownedInstallations = await tx("installations")
      .where({ tenant_id: tenant })
      .whereIn(
        "license_id",
        licenses.map((l) => l.id),
      );
    const references = new Set([
      customerId,
      customer.email,
      ...licenses.flatMap((l) =>
        l.subscription_id ? [l.id, l.subscription_id] : [l.id],
      ),
      ...grants.map((g) => g.invoice_id as string),
      ...ownedInstallations.map((i) => i.id as string),
    ]);
    if (customer.stripe_id) references.add(customer.stripe_id);
    const matcher = await this.referenceMatcher(
      tx,
      customerId,
      requestId,
      references,
    );
    const decoded = (raw: string, encrypted: boolean): unknown => {
      if (raw === "" || raw === "{}") return {};
      try {
        return encrypted
          ? unseal<unknown>(raw, this.auth.config.secret)
          : JSON.parse(raw);
      } catch {
        return null;
      }
    };
    const belongs = (value: unknown) =>
      value === null || matcher.contains(value);
    const events = await tx("billing_events").where({ tenant_id: tenant });
    const ownedEvents = events.filter((row) =>
      belongs(decoded(row.payload, true)),
    );
    for (const event of ownedEvents) matcher.add(event.id);
    const work = await tx("work").where({ tenant_id: tenant });
    const ownedWork = work.filter(
      (row) => belongs(decoded(row.payload, true)) || matcher.contains(row.id),
    );
    const unknownActiveWork = work.filter(
      (row) =>
        ["pending", "running"].includes(row.state) &&
        ["", "{}"].includes(row.payload),
    );
    blockerRecords.work = [
      ...new Set(
        [
          ...ownedWork.filter(
            (row) =>
              !["", "{}"].includes(row.payload) ||
              ["pending", "running"].includes(row.state) ||
              Number(row.lease_until) > Date.now(),
          ),
          ...unknownActiveWork,
        ].map((r) => r.id as string),
      ),
    ];
    blockerRecords.billing_events = ownedEvents.map((r) => r.id as string);
    if (
      ownedWork.some(
        (row) =>
          ["pending", "running"].includes(row.state) ||
          Number(row.lease_until) > Date.now(),
      ) ||
      unknownActiveWork.length > 0
    )
      blockers.push("pending_billing_work");
    const audits = await tx("audit_events")
      .where({ tenant_id: tenant })
      .whereNot({ details: "{}" })
      .whereNotIn("action", [
        "customer.closure.requested",
        "customer.closure.blocked",
        "customer.closure.completed",
        "customer.closure.reconciled",
      ]);
    blockerRecords.audit_events = audits
      .filter(
        (row) =>
          row.actor_id === customerId || belongs(decoded(row.details, false)),
      )
      .map((r) => r.id as string);
    if (
      ownedEvents.some((row) => !["", "{}"].includes(row.payload)) ||
      ownedWork.some((row) => !["", "{}"].includes(row.payload)) ||
      audits.some(
        (row) =>
          row.actor_id === customerId || belongs(decoded(row.details, false)),
      )
    )
      blockers.push("retained_provider_payloads");
    if (await tx.schema.hasTable("outbound_events")) {
      const safeEvent = z
        .object({
          id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          type: z.enum(outboundEventTypes),
          tenantId: z.literal(tenant),
          resourceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
          occurredAt: z.number().int().nonnegative(),
        })
        .strict();
      const outgoing = await tx("outbound_events").where({
        tenant_id: tenant,
      });
      const retained = outgoing.filter((row) => {
        if (["", "{}"].includes(row.payload)) return false;
        const value = decoded(row.payload, false);
        // Valid versioned webhook payloads contain opaque IDs only. Their
        // durable deduplication history is financial/security metadata.
        return !safeEvent.safeParse(value).success && belongs(value);
      });
      blockerRecords.outbound_events = retained.map((r) => r.id as string);
      if (retained.length) blockers.push("retained_outgoing_payloads");
      if (await tx.schema.hasTable("outbound_deliveries")) {
        const deliveries = await tx("outbound_deliveries")
          .where({ tenant_id: tenant })
          .whereIn(
            "event_id",
            retained.map((row) => row.id),
          )
          .andWhere((q) =>
            q
              .whereIn("state", ["pending", "running"])
              .orWhere("lease_until", ">", Date.now()),
          )
          .select("id");
        blockerRecords.outbound_deliveries = deliveries.map(
          (r) => r.id as string,
        );
        if (deliveries.length) blockers.push("pending_outgoing_delivery");
      }
    }
    for (const ids of Object.values(blockerRecords)) ids.sort();
    return { blockers, blockerRecords, licenses };
  }
  async inspectClosure(customerId: string, requestId: string) {
    return this.db.transaction(async (tx) => {
      const row = await tx<ClosureRow>("account_closures")
        .where({ ...this.scope(customerId), id: requestId })
        .first();
      check(row, 404, "closure_not_found", "Closure request was not found.");
      const { blockers, blockerRecords } = await this.closureBlockers(
        tx,
        customerId,
        requestId,
      );
      return {
        request: { ...row, blockers: JSON.stringify(blockers) },
        blockerRecords,
        retentionPlan: customerRetentionPlan,
      };
    });
  }

  // Internal operator API only. No HTTP approval route is registered. Operator
  // identity and external Stripe reconciliation must be established by caller.
  async approveClosure(
    customerId: string,
    requestId: string,
    operatorId: string,
    approval: ClosureApproval,
  ) {
    check(
      operatorId.trim().length > 0,
      403,
      "operator_required",
      "An authenticated operator is required.",
    );
    check(
      approval?.quiesced === true &&
        approval.stripeReconciled === true &&
        approval.retentionReviewed === true,
      409,
      "closure_approval_required",
      "The operator must pause tenant writers and external calls, reconcile Stripe, and review retention before approval.",
    );
    return this.db.transaction(async (tx) => {
      const tenant = this.auth.tenant.id;
      for (const name of ["auth", "billing", "work", "email"])
        await lock(tx, name, tenant);
      const scope = this.scope(customerId);
      const row = await tx<ClosureRow>("account_closures")
        .where({ ...scope, id: requestId })
        .first();
      check(row, 404, "closure_not_found", "Closure request was not found.");
      if (row.status === "completed") return this.result(row);
      const { blockers, blockerRecords, licenses } = await this.closureBlockers(
        tx,
        customerId,
        requestId,
      );
      if (blockers.length) {
        await tx("account_closures")
          .where(scope)
          .update({ status: "blocked", blockers: JSON.stringify(blockers) });
        await audit(tx, customerId, "customer.closure.blocked", tenant, {
          requestId,
          blockers,
          operatorId,
        });
        return {
          ...this.result({
            ...row,
            status: "blocked",
            blockers: JSON.stringify(blockers),
          }),
          blockerRecords,
        };
      }
      const licenseIds = licenses.map((l) => l.id);
      const installations = await tx("installations")
        .where({ tenant_id: tenant })
        .whereIn("license_id", licenseIds)
        .select("id", "active");
      for (const installation of installations) {
        await tx("installations")
          .where({ tenant_id: tenant, id: installation.id })
          .update({
            site_url: "",
            label: null,
            installation_id: random(),
            token_cipher: "",
            active: 0,
          });
        if (installation.active)
          await recordBusinessEvent(
            tx,
            tenant,
            "activation.changed",
            installation.id,
            `closure:${requestId}`,
          );
      }
      await tx("emails").where(scope).delete();
      await tx("login_tokens").where(scope).delete();
      await tx("sessions").where(scope).delete();
      await tx("licenses").where(scope).update({ internal_note: null });
      await tx("customers")
        .where({ tenant_id: tenant, id: customerId })
        .update({
          email: `closed-${hash(`${tenant}:${customerId}`)}@invalid.invalid`,
          stripe_id: null,
        });
      const completed_at = Date.now();
      await tx("account_closures")
        .where(scope)
        .update({ status: "completed", blockers: "[]", completed_at });
      await audit(tx, customerId, "customer.closure.completed", tenant, {
        requestId,
        operatorId,
      });
      return this.result({
        ...row,
        status: "completed",
        blockers: "[]",
        completed_at,
      });
    });
  }
}

export interface AccountRouteDependencies {
  accounts: AccountManagement;
}
export async function registerAccountRoutes(
  app: FastifyInstance,
  { accounts }: AccountRouteDependencies,
) {
  app.get("/sessions", { config: limit(30) }, (req) => {
    empty.parse(req.query);
    return accounts.sessions(req);
  });
  app.post("/sessions/revoke", { config: limit(10) }, (req) => {
    const { id } = z.object({ id: secret }).strict().parse(req.body);
    return accounts.revokeSessions(req, "one", id);
  });
  app.post("/sessions/revoke-others", { config: limit(10) }, (req) => {
    empty.parse(req.body);
    return accounts.revokeSessions(req, "others");
  });
  app.post("/sessions/revoke-all", { config: limit(10) }, (req) => {
    empty.parse(req.body);
    return accounts.revokeSessions(req, "all");
  });
  app.post("/verification/request", { config: limit(5) }, (req) => {
    const { purpose } = z
      .object({ purpose: purposeSchema })
      .strict()
      .parse(req.body);
    return accounts.requestVerification(req, purpose);
  });
  app.post("/verification/consume", { config: limit(10) }, (req) => {
    const { purpose, token } = z
      .object({ purpose: purposeSchema, token: secret })
      .strict()
      .parse(req.body);
    return accounts.consumeVerification(req, purpose, token);
  });
  app.post("/recovery-codes", { config: limit(5) }, (req) => {
    const { verification } = z
      .object({ verification: secret })
      .strict()
      .parse(req.body);
    return accounts.recoveryCodes(req, verification);
  });
  app.post("/recovery/start", { config: limit(5) }, (req, reply) => {
    empty.parse(req.body);
    return accounts.startRecovery(req, reply);
  });
  app.post("/recovery/consume", { config: limit(10) }, (req, reply) => {
    const input = z.object({ email, code: secret }).strict().parse(req.body);
    return accounts.recover(req, reply, input.email, input.code);
  });
  app.post("/email-change/request", { config: limit(5) }, (req) => {
    const input = z.object({ email }).strict().parse(req.body);
    return accounts.requestEmailChange(req, input.email);
  });
  app.post("/email-change/confirm", { config: limit(10) }, (req) => {
    const { id, currentToken, newToken } = z
      .object({ id: secret, currentToken: secret, newToken: secret })
      .strict()
      .parse(req.body);
    return accounts.confirmEmailChange(req, id, currentToken, newToken);
  });
}
export interface CustomerAccountRouteDependencies {
  context: (req: FastifyRequest) => CustomerAccounts;
}
export async function registerCustomerAccountRoutes(
  app: FastifyInstance,
  { context }: CustomerAccountRouteDependencies,
) {
  app.get("/account/export", { config: limit(5) }, (req) => {
    empty.parse(req.query);
    return context(req).export(req);
  });
  app.get("/account/closure", { config: limit(30) }, (req) => {
    empty.parse(req.query);
    return context(req).closure(req);
  });
  app.post("/account/closure", { config: limit(5) }, (req) => {
    empty.parse(req.body);
    return context(req).requestClosure(req);
  });
}
