import { recordBusinessEvent } from "./business-events.ts";
import { randomUUID } from "node:crypto";
import type { DB, Tx, License, Installation, Customer, TenantContext } from "./db.ts";
import { hash, random, seal, unseal } from "./crypto.ts";
import { check } from "./errors.ts";
import { enqueueEmail } from "./email.ts";
import { licenseKeyEmail } from "./transactional-email.ts";
import { lock } from "./db.ts";
import { z } from "zod";
import { activationKind, validateFramework, validateFrameworkConfig } from "./frameworks.ts";
export function normalizeSite(input: string) {
  const url = new URL(input);
  check(
    ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password,
    400,
    "invalid_site",
    "Use an HTTP or HTTPS site URL without credentials.",
  );
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${path}`;
}
export async function effectiveLicense(
  l: License,
  tx: Tx,
  tenantId: string,
  now: number,
): Promise<License> {
  if (l.provenance === "complimentary") return l;
  // Overlapping paid grants retain the largest purchased allowance through
  // its paid period. In a gap, retain the most recent plan that has begun,
  // rather than a cached projection of a future plan from reconciliation.
  const grant = await tx("grants")
    .join("plans", "plans.id", "grants.plan_id")
    .where("grants.tenant_id", tenantId)
    .andWhere("grants.license_id", l.id)
    .andWhere("grants.period_start", "<=", now)
    .orderByRaw(
      "CASE WHEN grants.period_end > ? THEN 1 ELSE 0 END DESC",
      [now],
    )
    .orderByRaw(
      "CASE WHEN grants.period_end > ? THEN plans.site_allowance ELSE 0 END DESC",
      [now],
    )
    .orderBy("grants.period_start", "desc")
    .orderBy("grants.paid_at", "desc")
    .orderBy("grants.id", "desc")
    .first("plans.id", "plans.site_allowance");
  return grant
    ? { ...l, plan_id: grant.id, site_allowance: grant.site_allowance }
    : l;
}
export function entitlementEnd(l: Pick<License, "provenance" | "paid_through" | "expires_at">) {
  return Number(l.provenance === "complimentary" ? l.expires_at ?? 0 : l.paid_through);
}
export const complimentaryInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  productId: z.string().min(1).max(64),
  siteAllowance: z.number().int().min(1).max(100000),
  expiresAt: z.number().int().positive().max(8640000000000000),
  note: z.string().trim().max(2000).optional(),
  requestId: z.string().uuid(),
  confirm: z.literal(true),
}).strict();
export class Licenses {
  db: DB;
  secret: string;
  exemptSuffixes: string[];
  now: () => number;
  tenant: TenantContext;
  constructor(
    db: DB,
    secret: string,
    exemptSuffixes: string[],
    tenant: TenantContext,
    now = Date.now,
  ) {
    this.db = db;
    this.secret = secret;
    this.exemptSuffixes = exemptSuffixes;
    this.now = now;
    this.tenant = tenant;
  }
  entitled(l: License) {
    return (
      l.tenant_id === this.tenant.id &&
      entitlementEnd(l) > this.now() &&
      !l.revoked &&
      !l.refund_revoked &&
      !l.suspended
    );
  }
  async effective(l: License, tx: Tx = this.db): Promise<License> {
    return effectiveLicense(l,tx,this.tenant.id,this.now());
  }
  async issueComplimentary(
    input: z.infer<typeof complimentaryInput>,
    actor: { type: "seller" | "api_key"; id: string },
  ) {
    const request = complimentaryInput.parse(input);
    const requestHash = hash(JSON.stringify([request.email, request.productId, request.siteAllowance, request.expiresAt, request.note || null]));
    return this.db.transaction(async tx => {
      // Match customer recovery/closure lock order, and serialize with Stripe's
      // customer mapping. Retries never generate another key or outbox job.
      await lock(tx, "auth", this.tenant.id);
      await lock(tx, "billing", this.tenant.id);
      const existing = await tx<License>("licenses").where({ tenant_id: this.tenant.id, complimentary_request_id: request.requestId }).first();
      if (existing) {
        check(existing.complimentary_request_hash === requestHash, 409, "idempotency_conflict", "This request ID was already used with different license details.");
        return { id: existing.id, customerId: existing.customer_id, emailQueued: true };
      }
      check(request.expiresAt > this.now(), 400, "invalid_expiration", "Choose a future expiration date.");
      const product = await tx("products").where({ tenant_id: this.tenant.id, id: request.productId }).first();
      check(product, 404, "not_found", "Product not found.");
      let customer = await tx<Customer>("customers").where({ tenant_id: this.tenant.id, email: request.email }).first();
      if (!customer) {
        customer = { tenant_id: this.tenant.id, id: randomUUID(), email: request.email, stripe_id: null };
        await tx("customers").insert(customer);
      }
      const key = `DE-${random()}`, now = this.now();
      const license: License = {
        tenant_id: this.tenant.id, id: randomUUID(), customer_id: customer.id, product_id: product.id,
        plan_id: null, site_allowance: request.siteAllowance, paid_through: 0, billing_status: "complimentary",
        subscription_id: null, provenance: "complimentary", expires_at: request.expiresAt,
        complimentary_request_id: request.requestId, complimentary_request_hash: requestHash,
        issued_by: actor.id, issued_at: now, internal_note: request.note || null,
        key_hash: hash(key), revoked: 0, refund_revoked: 0, suspended: 0, lock_version: 0,
      };
      await tx("licenses").insert(license);
      await this.keyEmail(tx, license, key);
      await tx("audit_events").insert({ id: randomUUID(), tenant_id: this.tenant.id, actor_type: actor.type, actor_id: actor.id,
        action: "license.complimentary_issued", details: JSON.stringify({ license_id: license.id, product_id: product.id }), created_at: now });
      await recordBusinessEvent(tx, this.tenant.id, "license.created", license.id, "created", now);
      return { id: license.id, customerId: customer.id, emailQueued: true };
    });
  }
  async keyEmail(tx: Tx, l: License, key: string) {
    const c = await tx<Customer>("customers")
      .where({ tenant_id: this.tenant.id, id: l.customer_id })
      .first();
    check(c, 404, "not_found", "Customer not found.");
    const product = await tx("products")
      .where({ tenant_id: this.tenant.id, id: l.product_id })
      .first("name");
    check(product, 404, "not_found", "Product not found.");
    await enqueueEmail(
      tx,
      this.secret,
      randomUUID(),
      c.id,
      l.id,
      "license_key",
      licenseKeyEmail(c.email, key, { publisher: this.tenant.name, product: product.name }, l.provenance === "complimentary" ? new Date(entitlementEnd(l)).toISOString() : undefined),
      this.tenant.id,
    );
  }
  async activate(
    key: string,
    installationId: string,
    siteUrl: string | undefined,
    product: string,
    installationLabel?: string,
  ) {
    return this.db.transaction(async (tx) => {
      // First statement is a write. PostgreSQL/MySQL lock this license row;
      // SQLite takes its writer lock before reading the seat count.
      await tx("licenses")
        .where({ tenant_id: this.tenant.id, key_hash: hash(key) })
        .increment("lock_version", 1);
      const stored = await tx<License>("licenses")
        .where({ tenant_id: this.tenant.id, key_hash: hash(key) })
        .first();
      check(stored, 401, "invalid_license", "Invalid license key.");
      const l = await this.effective(stored, tx);
      const p = await tx("products")
        .where({ tenant_id: this.tenant.id, id: l.product_id, slug: product })
        .first();
      check(p, 403, "wrong_product", "License does not cover this product.");
      const framework = validateFramework(p.framework);
      const kind = activationKind(framework, validateFrameworkConfig(framework, JSON.parse(p.framework_config)));
      let normalized: string, exempt = false;
      if (kind === "site") {
        check(siteUrl, 400, "invalid_site", "A site URL is required for this product.");
        normalized = normalizeSite(siteUrl);
        const host = new URL(siteUrl).hostname.toLowerCase();
        exempt = this.exemptSuffixes.some(s => host === s || host.endsWith(`.${s}`));
      } else {
        check(siteUrl === undefined, 400, "invalid_activation_input", "Device activations do not accept a site URL.");
        normalized = `device:${installationId}`;
      }
      check(
        this.entitled(l),
        403,
        "not_entitled",
        "This license cannot authorize new activations or downloads.",
      );
      const existing = await tx<Installation>("installations")
        .where({ tenant_id: this.tenant.id, license_id: l.id, installation_id: installationId })
        .first();
      if (existing?.active) {
        check(
          existing.site_url === normalized,
          409,
          "site_changed",
          "Deactivate this installation before moving it to another site.",
        );
        return this.activationResult(l, existing);
      }
      const count = await tx("installations")
        .where({ tenant_id: this.tenant.id, license_id: l.id, active: 1, exempt: 0 })
        .count<{ count: number | string }>({ count: "id" })
        .first();
      // COUNT without GROUP BY always returns one row, including zero matches,
      // on every supported engine. Missing results must not imply free seats.
      check(
        exempt || Number(count!.count) < l.site_allowance,
        409,
        "site_limit",
        "The installation allowance has been reached. Deactivate another installation first.",
      );
      const token = random();
      const row: Installation = {
        tenant_id: this.tenant.id,
        id: existing?.id ?? randomUUID(),
        license_id: l.id,
        installation_id: installationId,
        site_url: normalized,
        active: 1,
        exempt: exempt ? 1 : 0,
        token_hash: hash(token),
        token_cipher: seal(token, this.secret),
        label: installationLabel ?? null,
      };
      if (existing)
        await tx("installations").where({ tenant_id: this.tenant.id, id: existing.id }).update(row);
      else await tx("installations").insert(row);
      await recordBusinessEvent(tx, this.tenant.id, "activation.changed", row.id);
      return this.activationResult(l, row);
    });
  }
  activationResult(l: License, i: Installation) {
    return {
      token: unseal<string>(i.token_cipher, this.secret),
      licenseId: l.id,
      installationId: i.installation_id,
      siteAllowance: l.site_allowance,
      paidThrough: entitlementEnd(l),
    };
  }
  async resolve(token: string, tx: Tx = this.db) {
    const i = await tx<Installation>("installations")
      .where({ tenant_id: this.tenant.id, token_hash: hash(token), active: 1 })
      .first();
    check(
      i,
      401,
      "invalid_activation",
      "Activation token is invalid or revoked.",
    );
    const l = await tx<License>("licenses").where({ tenant_id: this.tenant.id, id: i.license_id }).first();
    check(l, 401, "invalid_activation", "Activation token is invalid.");
    return { installation: i, license: await this.effective(l, tx) };
  }
  async status(token: string) {
    const { license: l, installation: i } = await this.resolve(token);
    return {
      licenseId: l.id,
      installationId: i.installation_id,
      siteAllowance: l.site_allowance,
      paidThrough: entitlementEnd(l),
      entitled: this.entitled(l),
      billingStatus: l.billing_status,
    };
  }
  async deactivate(token: string) {
    await this.db.transaction(async (tx) => {
      const { license, installation } = await this.resolve(token, tx);
      await tx("licenses")
        .where({ tenant_id: this.tenant.id, id: license.id })
        .increment("lock_version", 1);
      const changed = await tx("installations")
        .where({ tenant_id: this.tenant.id, token_hash: hash(token), active: 1 })
        .update({ active: 0, token_cipher: "" });
      if (changed)
        await recordBusinessEvent(tx, this.tenant.id, "activation.changed", installation.id);
    });
  }
  async deactivateOwned(installationId: string, customerId: string) {
    await this.db.transaction(async (tx) => {
      const i = await tx<Installation>("installations")
        .where({ tenant_id: this.tenant.id, id: installationId })
        .first();
      check(i, 404, "not_found", "Installation not found.");
      await tx("licenses")
        .where({ tenant_id: this.tenant.id, id: i.license_id })
        .increment("lock_version", 1);
      check(
        await tx("licenses")
          .where({ tenant_id: this.tenant.id, id: i.license_id, customer_id: customerId })
          .first(),
        404,
        "not_found",
        "Installation not found.",
      );
      const changed = await tx("installations")
        .where({ tenant_id: this.tenant.id, id: i.id, active: 1 })
        .update({ active: 0, token_cipher: "" });
      if (changed)
        await recordBusinessEvent(tx, this.tenant.id, "activation.changed", i.id);
    });
  }
  async replaceKey(id: string, customerId: string) {
    return this.db.transaction(async (tx) => {
      await tx("licenses")
        .where({ tenant_id: this.tenant.id, id, customer_id: customerId })
        .increment("lock_version", 1);
      const l = await tx<License>("licenses")
        .where({ tenant_id: this.tenant.id, id, customer_id: customerId })
        .first();
      check(l, 404, "not_found", "License not found.");
      const key = `DE-${random()}`;
      await tx("licenses")
        .where({ tenant_id: this.tenant.id, id })
        .update({ key_hash: hash(key) });
      const active = await tx<Installation>("installations")
        .where({ tenant_id: this.tenant.id, license_id: id, active: 1 });
      await tx("installations")
        .where({ tenant_id: this.tenant.id, license_id: id })
        .update({ active: 0, token_cipher: "" });
      for (const installation of active)
        await recordBusinessEvent(tx, this.tenant.id, "activation.changed", installation.id);
      await tx("emails")
        .where({ tenant_id: this.tenant.id, license_id: id, kind: "license_key" })
        .whereIn("state", ["pending", "running"])
        .update({ state: "canceled", payload: "" });
      await this.keyEmail(tx, l, key);
      return key;
    });
  }
}
