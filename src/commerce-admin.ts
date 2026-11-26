import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TenantContextFor } from "./tenant-api.ts";
import type { PlatformAuth } from "./platform-auth.ts";
import { lock } from "./db.ts";
import { check } from "./errors.ts";
import { featureEntitlements } from "./plan-features.ts";

const settingsSchema = z
  .object({
    automaticTax: z.boolean(),
    collectTaxId: z.boolean(),
    collectBillingAddress: z.boolean(),
    allowPromotionCodes: z.boolean().optional(),
  })
  .strict();
type CommerceContext = (
  req: FastifyRequest,
) => Pick<ReturnType<TenantContextFor>, "db" | "config" | "tenant" | "stripe">;

export async function commerceAdminRoutes(
  app: FastifyInstance,
  context: CommerceContext,
  auth: PlatformAuth,
) {
  const limit = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };
  async function authorize(req: FastifyRequest, mutation: boolean) {
    const services = context(req);
    const tenant = await auth.tenant(
      req,
      services.tenant.slug,
      mutation,
      false,
    );
    check(
      tenant.id === services.tenant.id,
      403,
      "tenant_denied",
      "Tenant context does not match the authenticated publisher.",
    );
    return { ...services, taxSettings: tenant };
  }
  const view = (
    tenant: ReturnType<CommerceContext>["tenant"],
    config: ReturnType<CommerceContext>["config"],
    taxSettings: Pick<typeof tenant, "automatic_tax" | "collect_tax_id" | "collect_billing_address" | "allow_promotion_codes">,
  ) => ({
    settings: {
      automaticTax: taxSettings.automatic_tax === 1,
      collectTaxId: taxSettings.collect_tax_id === 1,
      collectBillingAddress: taxSettings.collect_billing_address === 1,
      allowPromotionCodes: taxSettings.allow_promotion_codes === 1,
    },
    features: featureEntitlements(config, tenant),
  });
  app.get("/commerce/settings", limit, async (req) => {
    const { tenant, config, taxSettings } = await authorize(req, false);
    return view(tenant, config, taxSettings);
  });
  app.put("/commerce/settings", limit, async (req) => {
    const { db, tenant, config, stripe } = await authorize(req, true);
    const input = settingsSchema.parse(req.body);
    if (input.automaticTax) await stripe.validateTaxSettings();
    const { user } = await auth.seller(req, false);
    const update = {
      automatic_tax: Number(input.automaticTax),
      collect_tax_id: Number(input.collectTaxId),
      collect_billing_address: Number(input.collectBillingAddress),
      ...(input.allowPromotionCodes === undefined
        ? {}
        : { allow_promotion_codes: Number(input.allowPromotionCodes) }),
    };
    const settings = await db.transaction(async (tx) => {
      await lock(tx, "billing", tenant.id);
      await tx("tenants").where({ id: tenant.id }).update(update);
      await tx("audit_events").insert({
        id: randomUUID(),
        tenant_id: tenant.id,
        actor_type: "seller",
        actor_id: user.id,
        action: "commerce.settings_updated",
        details: JSON.stringify(input),
        created_at: Date.now(),
      });
      return (await tx("tenants").where({ id: tenant.id }).first())!;
    });
    return view(tenant, config, settings);
  });
  app.put("/commerce/products/:id/tax-code", limit, async (req) => {
    const { db, tenant, stripe } = await authorize(req, true);
    const { id } = z
      .object({ id: z.string().min(1).max(64) })
      .parse(req.params);
    const { taxCode } = z
      .object({
        taxCode: z
          .string()
          .regex(/^txcd_[0-9]{8}$/)
          .nullable(),
      })
      .strict()
      .parse(req.body);
    const { user } = await auth.seller(req, false);
    await stripe.syncProductTaxCode(id, taxCode);
    await db.transaction(async (tx) => {
      await lock(tx, "billing", tenant.id);
      const product = await tx("products")
        .where({ tenant_id: tenant.id, id })
        .first();
      check(product, 404, "not_found", "Product not found.");
      await tx("products")
        .where({ tenant_id: tenant.id, id })
        .update({ tax_code: taxCode });
      await tx("audit_events").insert({
        id: randomUUID(),
        tenant_id: tenant.id,
        actor_type: "seller",
        actor_id: user.id,
        action: "commerce.product_tax_code_updated",
        details: JSON.stringify({ productId: id, taxCode }),
        created_at: Date.now(),
      });
    });
    return { productId: id, taxCode };
  });
}
