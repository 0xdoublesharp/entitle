import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { License, Release } from "./db.ts";
import type { TenantContextFor } from "./tenant-api.ts";
import { apiLimit } from "./tenant-api.ts";
import { hash, seal, unseal } from "./crypto.ts";
import { AppError, check } from "./errors.ts";
import { tenantAvailable } from "./tenants.ts";

const ticketSchema = z.object({
  kind: z.literal("free-license-download"), tenantId: z.string(), productId: z.string(),
  licenseId: z.string(), keyHash: z.string(), releaseId: z.string(), expiresAt: z.number(),
}).strict();

// These opt-in public routes use no cookies or seller credentials. CORS is
// restricted to the configured product origins; account and seller CORS stays closed.
export async function freeLicenseRoutes(
  api: FastifyInstance,
  context: TenantContextFor,
  sendDownload: (req: FastifyRequest, reply: FastifyReply, releaseId: string, bytes: Buffer) => FastifyReply,
  reserveDownload: (req: FastifyRequest, reply: FastifyReply, size: number) => void,
) {
  await api.register(async signup => {
    const offerFor = (req: FastifyRequest) => {
      const { product } = z.object({ product: z.string().max(100) }).parse(req.params);
      const { config, tenant } = context(req);
      const offer = config.freeLicenseOffers?.find(value => value.tenant === tenant.slug && value.product === product);
      check(offer, 404, "not_found", "Free access is not available for this product.");
      return offer;
    };
    signup.addHook("onRequest", async (req, reply) => {
      const offer = offerFor(req);
      check(typeof req.headers.origin === "string" && offer.origins.includes(req.headers.origin),
        403, "origin_denied", "This website is not allowed to request free access.");
      reply.header("access-control-allow-origin", req.headers.origin).header("vary", "Origin");
    });
    for (const path of ["", "/unlock", "/download"])
      signup.options(path, { config: apiLimit(60) }, async (_req, reply) => reply
        .header("access-control-allow-methods", "GET, POST, OPTIONS")
        .header("access-control-allow-headers", "Content-Type")
        .code(204).send());
    const productFor = async (req: FastifyRequest) => {
      const { db, tenant } = context(req), offer = offerFor(req);
      const product = await db("products").where({ tenant_id: tenant.id, slug: offer.product, framework: "wordpress" }).first();
      check(product, 503, "signup_unavailable", "Pro access is temporarily unavailable.");
      return product;
    };
    const releaseFor = async (req: FastifyRequest, productId: string) => {
      const release = await context(req).releases.latest(productId);
      check(release, 503, "release_unavailable", "A Pro download is not available yet. Please try again later.");
      return release;
    };
    const activeOffer = (req: FastifyRequest) => {
      const offer = offerFor(req);
      check(offer.expiresAt === undefined || offer.expiresAt > Date.now(), 410, "offer_ended", "This free access offer has ended.");
      return offer;
    };
    signup.get("", { config: apiLimit(60) }, async req => {
      const offer = activeOffer(req), product = await productFor(req);
      await releaseFor(req, product.id);
      const { config, tenant } = context(req);
      return { product: product.name, siteAllowance: offer.siteAllowance, expiresAt: offer.expiresAt, durationDays: offer.durationDays,
        licensingApi: `${config.origin}/api/v1/tenants/${tenant.slug}` };
    });
    signup.post("", { bodyLimit: 2048, config: apiLimit(5) }, async (req, reply) => {
      const { email } = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)), consent: z.literal(true) }).strict().parse(req.body);
      const offer = activeOffer(req), product = await productFor(req);
      await releaseFor(req, product.id);
      const { licensing, tenant, config } = context(req);
      check(config.deploymentMode !== "hosted" || tenantAvailable(tenant, "capacity", (config.graceDays ?? 7) * 86400000),
        403, "tenant_capacity", "Free access is unavailable for this publisher.");
      // Stable identity includes the operator's campaign and normalized email.
      // Retries across processes, key replacements, revocation and expiry cannot
      // mint another license, extend access or enqueue another email.
      const identity = hash(JSON.stringify([tenant.id, product.id, offer.campaign, email]));
      const requestId = `${identity.slice(0,8)}-${identity.slice(8,12)}-4${identity.slice(13,16)}-8${identity.slice(17,20)}-${identity.slice(20,32)}`;
      await licensing.issueComplimentary({ email, productId: product.id, siteAllowance: offer.siteAllowance,
        expiresAt: offer.expiresAt ?? Date.now() + offer.durationDays! * 86400000, requestId, confirm: true },
        { type: "public_signup", id: `signup:${hash(JSON.stringify([product.id, offer.campaign])).slice(0,40)}`, dailyLimit: offer.dailyLimit, ...(offer.durationDays === undefined ? {} : { durationDays: offer.durationDays }) });
      return reply.code(202).send({ accepted: true });
    });
    signup.post("/unlock", { bodyLimit: 2048, config: apiLimit(10) }, async req => {
      const { key } = z.object({ key: z.string().trim().min(1).max(200) }).strict().parse(req.body);
      const product = await productFor(req), { db, tenant, licensing, config } = context(req);
      const license = await db<License>("licenses").where({ tenant_id: tenant.id, product_id: product.id, key_hash: hash(key) }).first();
      check(license && licensing.entitled(license), 403, "invalid_license", "This key does not have Pro download access. Check the key and its expiry.");
      const release = await releaseFor(req, product.id);
      const expiresAt = Date.now() + 5 * 60000;
      const token = seal({ kind: "free-license-download", tenantId: tenant.id, productId: product.id,
        licenseId: license.id, keyHash: license.key_hash, releaseId: release.id, expiresAt }, config.secret);
      return { token, version: release.version, expiresAt, licensingApi: `${config.origin}/api/v1/tenants/${tenant.slug}` };
    });
    signup.post("/download", { bodyLimit: 4096, config: apiLimit(10) }, async (req, reply) => {
      const { token } = z.object({ token: z.string().min(1).max(3000) }).strict().parse(req.body);
      const product = await productFor(req), { db, tenant, config, licensing, releases } = context(req);
      let ticket: z.infer<typeof ticketSchema>;
      try { ticket = ticketSchema.parse(unseal(token, config.secret)); }
      catch { throw new AppError(403, "invalid_download", "Unlock your download again with your license key."); }
      check(ticket.kind === "free-license-download" && ticket.tenantId === tenant.id && ticket.productId === product.id && ticket.expiresAt > Date.now(),
        403, "invalid_download", "Unlock your download again with your license key.");
      const license = await db<License>("licenses").where({ tenant_id: tenant.id, product_id: product.id, id: ticket.licenseId, key_hash: ticket.keyHash }).first();
      check(license && licensing.entitled(license), 403, "invalid_license", "This key does not have Pro download access.");
      const release = await db<Release>("releases").where({ tenant_id: tenant.id, product_id: product.id, id: ticket.releaseId, withdrawn: 0 })
        .andWhere("published_at", "<=", Date.now()).first();
      check(release, 404, "release_unavailable", "This Pro download is no longer available. Unlock the latest release.");
      reserveDownload(req, reply, Number(release.size));
      const bytes = await releases.read(release);
      reply.header("content-type", "application/zip").header("content-length", bytes.length)
        .header("content-disposition", `attachment; filename="${product.slug}-${release.version}.zip"`)
        .header("x-checksum-sha256", release.checksum);
      return sendDownload(req, reply, release.id, bytes);
    });
  }, { prefix: "/free-license/:product" });
}
