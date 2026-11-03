import { freeLicenseRoutes } from "./free-license-api.ts";
import type { ReadCache } from "./read-cache.ts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DB, Tenant, License, Installation, Release, Plan } from "./db.ts";
import type { Config } from "./config.ts";
import type { Licenses } from "./licensing.ts";
import type { Artifacts } from "./artifacts.ts";
import type { Releases } from "./releases.ts";
import type { Billing } from "./billing.ts";
import { stripeConfigured } from "./config.ts";
import type { StripeBilling } from "./stripe.ts";
import { Auth, bearer } from "./auth.ts";
import { AppError, check } from "./errors.ts";

export interface TenantServices {
  reads: ReadCache;
  db: DB;
  config: Config;
  tenant: Tenant;
  licensing: Licenses;
  releases: Releases;
  artifacts: Artifacts;
  billing: Billing;
  stripe: StripeBilling;
  auth: Auth;
}
export type TenantContextFor = (req: FastifyRequest) => TenantServices;
export const apiLimit = (max: number) => ({
  rateLimit: { max, timeWindow: "1 minute" },
});
const bounded = z.string().min(1).max(200),
  empty = z.object({}).strict();

export async function buyerRoutes(
  api: FastifyInstance,
  context: TenantContextFor,
  successfulDownload: (
    req: FastifyRequest,
    reply: FastifyReply,
    releaseId: string,
    bytes: Buffer,
  ) => FastifyReply,
  reserveDownload: (
    req: FastifyRequest,
    reply: FastifyReply,
    size: number,
  ) => void,
) {
  await freeLicenseRoutes(api, context, successfulDownload, reserveDownload);
  api.get("/catalog", async (req) => {
    const { db, tenant, config } = context(req);
    const products = await db("products")
      .where({ tenant_id: tenant.id })
      .select("id", "name", "slug", "framework", "framework_config");
    const plans = Map.groupBy(
      await db("plans")
        .where({ tenant_id: tenant.id })
        .select("id", "product_id", "name", "site_allowance"),
      (plan) => plan.product_id,
    );
    for (const p of products) {
      p.frameworkConfig = JSON.parse(p.framework_config);
      delete p.framework_config;
      p.plans = (plans.get(p.id) ?? []).map(({ id, name, site_allowance }) => ({
        id,
        name,
        site_allowance,
      }));
    }
    return { tenant: { slug: tenant.slug, name: tenant.name }, products, billingAvailable: config.localBilling || (stripeConfigured(config) && (config.deploymentMode === "standalone" || tenant.stripe_status === "connected")) };
  });
  api.post("/checkout", { config: apiLimit(10) }, async (req, reply) => {
    check(context(req).config.localBilling || stripeConfigured(context(req).config), 503, "billing_unavailable", "Stripe billing is not configured.");
    const { db, tenant, auth, stripe } = context(req);
    const input = z
      .object({
        planId: bounded,
        email: z.email().max(254),
        uiMode: z.enum(["hosted", "elements"]).default("hosted"),
      })
      .strict()
      .parse(req.body);
    const plan = await db<Plan>("plans")
      .where({ tenant_id: tenant.id, id: input.planId })
      .first();
    check(plan, 404, "not_found", "Plan not found.");
    let customerId: string | undefined;
    if (req.cookies[auth.cookieName]) {
      try {
        customerId = (await auth.customer(req, false)).customer.id;
      } catch (error) {
        if (!(
          error instanceof AppError &&
          error.status === 401 &&
          error.code === "login_required"
        ))
          throw error;
      }
    }
    const guestCustomerId = auth.checkoutCustomer(req);
    return stripe.checkout(
      plan,
      input.email.toLowerCase(),
      customerId,
      input.uiMode,
      {
        ...(guestCustomerId ? { guestCustomerId } : {}),
        issueGuestClaim: (id) => auth.issueCheckoutClaim(id, reply),
      },
    );
  });
  api.post("/activate", { config: apiLimit(20) }, async (req) => {
    const b = z
      .object({
        key: z.string().min(1).max(200),
        installationId: z.string().min(8).max(150),
        siteUrl: z.url().max(500).optional(),
        installationLabel: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .regex(/^[^\p{Cc}]*$/u)
          .optional(),
        product: bounded,
      })
      .strict()
      .parse(req.body);
    return context(req).licensing.activate(
      b.key,
      b.installationId,
      b.siteUrl,
      b.product,
      b.installationLabel,
    );
  });
  api.get("/activation", { config: apiLimit(60) }, async (req) =>
    context(req).licensing.status(bearer(req)),
  );
  api.post("/deactivate", { config: apiLimit(30) }, async (req) => {
    empty.parse(req.body);
    await context(req).licensing.deactivate(bearer(req));
    return { ok: true };
  });
  api.get("/updates/:product", { config: apiLimit(60) }, async (req, reply) => {
    const { db, tenant, licensing, releases, config } = context(req);
    const { product } = z.object({ product: bounded }).parse(req.params);
    const { license } = await licensing.resolve(bearer(req));
    check(
      licensing.entitled(license),
      403,
      "not_entitled",
      "Downloads and updates are unavailable for this license.",
    );
    const p = await db("products")
      .where({ tenant_id: tenant.id, id: license.product_id, slug: product })
      .first();
    check(p, 403, "wrong_product", "License does not cover this product.");
    check(
      p.framework === "wordpress",
      409,
      "framework_mismatch",
      "Use this product's framework update feed.",
    );
    const release = await releases.latest(p.id);
    if (!release) return reply.code(204).send();
    return {
      name: p.name,
      slug: p.slug,
      version: release.version,
      download_url: `${config.origin}/api/v1/tenants/${tenant.slug}/packages/${release.id}`,
      requires: release.min_wp,
      requires_php: release.min_php,
      min_free: release.min_free,
      tested: release.tested,
      sections: { changelog: release.changelog },
      sha256: release.checksum,
    };
  });
  async function artifact(
    req: FastifyRequest,
    reply: FastifyReply,
    license: License,
    releaseId: string,
  ) {
    const { db, tenant, licensing, releases } = context(req);
    check(
      licensing.entitled(license),
      403,
      "not_entitled",
      "Downloads and updates are unavailable for this license.",
    );
    const product = await db("products")
      .where({ tenant_id: tenant.id, id: license.product_id })
      .first();
    check(
      product?.framework === "wordpress",
      409,
      "framework_mismatch",
      "Use an asset download for this product.",
    );
    const release = await db<Release>("releases")
      .where({
        tenant_id: tenant.id,
        id: releaseId,
        product_id: license.product_id,
        withdrawn: 0,
      })
      .andWhere("published_at", "<=", Date.now())
      .first();
    check(release, 404, "not_found", "Release not found or withdrawn.");
    reserveDownload(req, reply, Number(release.size));
    const bytes = await releases.read(release);
    reply
      .header("content-type", "application/zip")
      .header(
        "content-disposition",
        `attachment; filename="${release.version}.zip"`,
      )
      .header("content-length", bytes.length)
      .header("x-checksum-sha256", release.checksum);
    return successfulDownload(req, reply, release.id, bytes);
  }
  api.head("/packages/:id", async () => {
    throw new AppError(
      405,
      "method_not_allowed",
      "Use GET for artifact downloads.",
    );
  });
  api.get(
    "/packages/:id",
    { exposeHeadRoute: false, config: apiLimit(30) },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const { license } = await context(req).licensing.resolve(bearer(req));
      return artifact(req, reply, license, id);
    },
  );
  api.post("/auth/request", { config: apiLimit(5) }, async (req) => {
    const { auth } = context(req);
    auth.origin(req);
    const { email } = z
      .object({ email: z.email().max(254) })
      .strict()
      .parse(req.body);
    await auth.request(email.toLowerCase());
    return { ok: true };
  });
  api.post("/auth/consume", { config: apiLimit(10) }, async (req, reply) => {
    const { token } = z
      .object({ token: z.string().min(8).max(100) })
      .strict()
      .parse(req.body);
    await context(req).auth.consume(token, req, reply);
    return { ok: true };
  });
  api.post("/auth/logout", async (req, reply) => {
    empty.parse(req.body);
    const { auth, db, tenant, config } = context(req);
    const { sessionHash } = await auth.customer(req, true);
    await db("sessions")
      .where({ tenant_id: tenant.id, id: sessionHash })
      .delete();
    reply.clearCookie(auth.cookieName, {
      path: "/",
      httpOnly: true,
      secure: config.production,
      sameSite: "lax",
    });
    return { ok: true };
  });
  api.get("/me", async (req) => {
    const { db, auth, tenant, licensing, config } = context(req);
    const { customer, csrfToken } = await auth.customer(req, false);
    const ownedLicenses = () =>
      db<License>("licenses").where({
        tenant_id: tenant.id,
        customer_id: customer.id,
      });
    const rows = await ownedLicenses();
    if (!rows.length)
      return {
        customer: { id: customer.id, email: customer.email },
        csrfToken,
        billingAvailable: false,
        licenses: [],
      };
    const licenses = [];
    const effectiveRows: License[] = [];
    for (const row of rows) effectiveRows.push(await licensing.effective(row));
    // Read metadata after projection so concurrently added paid plans are present.
    // Subqueries keep parameter counts bounded even for accounts with many licenses.
    const products = new Map(
      (
        await db("products")
          .where({ tenant_id: tenant.id })
          .whereIn("id", ownedLicenses().select("product_id"))
      ).map((product) => [product.id, product]),
    );
    const plans = new Map(
      (
        await db("plans")
          .where({ tenant_id: tenant.id })
          .whereIn("product_id", ownedLicenses().select("product_id"))
      ).map((plan) => [plan.id, plan]),
    );
    const installations = Map.groupBy(
      await db<Installation>("installations")
        .where({ tenant_id: tenant.id })
        .whereIn("license_id", ownedLicenses().select("id"))
        .select(
          "license_id",
          "id",
          "installation_id",
          "site_url",
          "label",
          "active",
          "exempt",
        ),
      (installation) => installation.license_id,
    );
    const now = Date.now();
    const visibleReleases = () =>
      db("releases")
        .where({ tenant_id: tenant.id, withdrawn: 0 })
        .whereIn("product_id", ownedLicenses().select("product_id"))
        .andWhere("published_at", "<=", now);
    const availableReleases = await visibleReleases().select(
      "id",
      "product_id",
      "version",
      "changelog",
      "checksum",
      "min_wp",
      "min_php",
      "min_free",
    );
    const assets = Map.groupBy(
      await db("release_assets")
        .where({ tenant_id: tenant.id })
        .whereIn("release_id", visibleReleases().select("id")),
      (asset) => asset.release_id,
    );
    const releasesByProduct = Map.groupBy(
      availableReleases,
      (release) => release.product_id,
    );
    for (const release of availableReleases) {
      release.assets = assets.get(release.id) ?? [];
      delete release.product_id;
    }
    for (const l of effectiveRows) {
      const product = products.get(l.product_id)!;
      const plan = l.plan_id ? plans.get(l.plan_id) : undefined;
      licenses.push({
        id: l.id,
        product_id: l.product_id,
        product_name: product.name,
        framework: product.framework,
        frameworkConfig: JSON.parse(product.framework_config),
        plan_name: plan?.name ?? "Complimentary",
        provenance: l.provenance,
        expires_at: l.expires_at == null ? null : Number(l.expires_at),
        site_allowance: l.site_allowance,
        paid_through: Number(l.paid_through),
        billing_status: l.billing_status,
        revoked: !!l.revoked || !!l.refund_revoked,
        suspended: !!l.suspended,
        entitled: licensing.entitled(l),
        installations: (installations.get(l.id) ?? []).map((i) => ({
          id: i.id,
          installation_id: i.installation_id,
          site_url: i.site_url,
          label: i.label,
          active: !!i.active,
          exempt: !!i.exempt,
        })),
        releases: releasesByProduct.get(l.product_id) ?? [],
      });
    }
    return {
      customer: { id: customer.id, email: customer.email },
      billingAvailable: !!customer.stripe_id && (config.localBilling || stripeConfigured(config)),
      csrfToken,
      licenses,
    };
  });
  api.post("/licenses/:id/key", { config: apiLimit(5) }, async (req) => {
    empty.parse(req.body);
    const { id } = z.object({ id: bounded }).parse(req.params);
    const { auth, licensing } = context(req);
    return {
      key: await licensing.replaceKey(
        id,
        (await auth.customer(req, true)).customer.id,
      ),
    };
  });
  api.post("/installations/:id/deactivate", async (req) => {
    empty.parse(req.body);
    const { id } = z.object({ id: bounded }).parse(req.params);
    const { auth, licensing } = context(req);
    await licensing.deactivateOwned(
      id,
      (await auth.customer(req, true)).customer.id,
    );
    return { ok: true };
  });
  api.head("/licenses/:id/releases/:releaseId/download", async () => {
    throw new AppError(
      405,
      "method_not_allowed",
      "Use GET for artifact downloads.",
    );
  });
  api.get(
    "/licenses/:id/releases/:releaseId/download",
    { exposeHeadRoute: false, config: apiLimit(30) },
    async (req, reply) => {
      const p = z
        .object({ id: bounded, releaseId: z.string().uuid() })
        .parse(req.params);
      const { db, tenant, auth } = context(req);
      const { customer } = await auth.customer(req, false);
      const l = await db<License>("licenses")
        .where({ tenant_id: tenant.id, id: p.id, customer_id: customer.id })
        .first();
      check(l, 404, "not_found", "License not found.");
      return artifact(req, reply, l, p.releaseId);
    },
  );
  api.post("/portal", { config: apiLimit(10) }, async (req) => {
    empty.parse(req.body);
    const { auth, stripe } = context(req);
    const { customer } = await auth.customer(req, true);
    check(context(req).config.localBilling || stripeConfigured(context(req).config), 503, "billing_unavailable", "Stripe billing is not configured.");
    check(
      customer.stripe_id,
      409,
      "no_billing_customer",
      "No Stripe customer is attached.",
    );
    return stripe.portal(customer.stripe_id);
  });
}
