import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { hash } from "./crypto.ts";
import { check } from "./errors.ts";
import {
  exportSellerLicenses,
  licenseFilterSchema,
  licenseUpdateSchema,
  listSellerLicenses,
  updateSellerLicense,
} from "./license-management.ts";
import { tenantAnalytics } from "./metrics.ts";
import type { PlatformAuth } from "./platform-auth.ts";
import { apiLimit, type TenantContextFor } from "./tenant-api.ts";

const exportQuery = licenseFilterSchema.extend({
  format: z.enum(["csv", "json"]).default("csv"),
});
const licenseParams = z.object({ id: z.string().min(1).max(64) });

export const licenseManagementRoutes: FastifyPluginAsync<{
  context: TenantContextFor;
  auth: PlatformAuth;
}> = async (app, { context, auth }) => {
  app.get("/licenses", { config: apiLimit(60) }, async (req) => {
    const { db, tenant, licensing } = context(req);
    return listSellerLicenses(
      db,
      tenant.id,
      licensing,
      licenseFilterSchema.parse(req.query),
    );
  });

  app.get("/licenses/export", { config: apiLimit(10) }, async (req, reply) => {
    const { db, tenant, licensing } = context(req);
    const { format, ...filters } = exportQuery.parse(req.query);
    const exported = await exportSellerLicenses(
      db,
      tenant.id,
      licensing,
      filters,
      format,
    );
    reply.header("Cache-Control", "no-store");
    if (typeof exported === "string")
      return reply
        .type("text/csv; charset=utf-8")
        .header(
          "Content-Disposition",
          'attachment; filename="licenses-export.csv"',
        )
        .send(exported);
    return exported;
  });

  app.patch("/licenses/:id", { config: apiLimit(30) }, async (req) => {
    const { db, tenant } = context(req);
    const { id } = licenseParams.parse(req.params);
    const header = req.headers.authorization;
    const key =
      header &&
      (await db("tenant_api_keys")
        .where({ tenant_id: tenant.id, key_hash: hash(header.slice(7)) })
        .first("id"));
    if (header)
      check(key, 403, "tenant_denied", "Tenant credentials are invalid.");
    const actor = key
      ? { type: "api_key" as const, id: key.id as string }
      : { type: "seller" as const, id: (await auth.seller(req, true)).user.id };
    return updateSellerLicense(
      db,
      tenant.id,
      id,
      licenseUpdateSchema.parse(req.body),
      actor,
    );
  });

  app.get("/analytics", { config: apiLimit(30) }, async (req) => {
    const { db, tenant, config } = context(req);
    const now = Date.now();
    return {
      generatedAt: now,
      ...(await tenantAnalytics(db, tenant, now, config.exemptSuffixes)),
    };
  });
};
