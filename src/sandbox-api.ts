import { appPath } from "../packages/shared/app-path.ts";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TenantContextFor } from "./tenant-api.ts";
import { apiLimit } from "./tenant-api.ts";
import type { PlatformAuth } from "./platform-auth.ts";
import type { PublisherSandboxes } from "./sandboxes.ts";
import { Billing } from "./billing.ts";
import { check } from "./errors.ts";
import { tenantAvailable } from "./tenants.ts";

export async function sandboxRoutes(
  api: FastifyInstance,
  context: TenantContextFor,
  auth: PlatformAuth,
  service: PublisherSandboxes,
) {
  api.get("/sandbox", { config: apiLimit(30) }, async (req) => {
    const s = context(req);
    await auth.tenant(req, s.tenant.slug, false, false, "read");
    return {
      sandbox: (await service.describe(s.tenant.id)) ?? null,
      stripeAvailable: !!service.config.stripeTestSecret,
    };
  });
  api.post("/sandbox", { config: apiLimit(5) }, async (req) => {
    const s = context(req);
    await auth.tenant(req, s.tenant.slug, true, false, "billing:reconcile");
    const seller = await auth.seller(req, true);
    const { mode } = z
      .object({ mode: z.enum(["fixture", "stripe"]).default("fixture") })
      .strict()
      .parse(req.body);
    const created = await service.create(s.tenant, seller, mode);
    return {
      ...created,
      customerUrl: appPath(
        `/t/${created.tenant.slug}`,
        service.config.appBasePath,
      ),
      apiBase: `/api/v1/tenants/${created.tenant.slug}`,
    };
  });
  api.post("/sandbox/purchase", { config: apiLimit(10) }, async (req) => {
    const s = context(req);
    await auth.tenant(req, s.tenant.slug, true, false, "licenses:write");
    const seller = await auth.seller(req, true);
    const sandbox = await service.describe(s.tenant.id);
    check(
      sandbox?.isSandbox && sandbox.mode === "fixture",
      404,
      "not_found",
      "Synthetic purchases require an isolated fixture sandbox.",
    );
    if (s.config.deploymentMode === "hosted")
      check(
        tenantAvailable(
          s.tenant,
          "capacity",
          (s.config.graceDays ?? 7) * 86400000,
        ),
        403,
        "tenant_capacity",
        "Renew the publisher subscription before adding sandbox capacity.",
      );
    const { planId } = z
      .object({ planId: z.string().min(1).max(64) })
      .strict()
      .parse(req.body);
    const plan = await s
      .db("plans")
      .where({ tenant_id: s.tenant.id, id: planId })
      .first();
    check(plan, 404, "not_found", "Plan not found.");
    const subscriptionId = `sub_sandbox_${randomUUID()}`;
    const now = Date.now();
    await new Billing(s.db, s.licensing, {
      snapshot: async () => ({
        subscriptionId,
        customerId: `cus_sandbox_${seller.user.id}`,
        email: seller.user.email,
        billingStatus: "active",
        suspended: false,
        fullyRefunded: false,
        grants: [
          {
            id: `il_${subscriptionId}`,
            invoiceId: `in_${subscriptionId}`,
            priceId: plan.stripe_price_id,
            periodStart: now - 1000,
            periodEnd: now + 365 * 86400000,
            paidAt: now,
            settled: true,
          },
        ],
      }),
    }, {
      stripeLiveMode: false,
      purchasePolicy: {
        deploymentMode: s.config.deploymentMode,
        graceDays: s.config.graceDays,
      },
    }).reconcile(subscriptionId);
    return { ok: true, test: true, subscriptionId, email: seller.user.email };
  });
}
