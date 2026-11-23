import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlatformAuth } from "./platform-auth.ts";
import { apiLimit, type TenantContextFor } from "./tenant-api.ts";
import { tenantAvailable } from "./tenants.ts";
import type { StrongAuth } from "./strong-auth.ts";
import { check } from "./errors.ts";
import { publisherInputSchema } from "./oidc-schema.ts";

export async function registerOidcRoutes(
  app: FastifyInstance,
  context: TenantContextFor,
  auth: PlatformAuth,
  strong: StrongAuth,
) {
  app.post(
    "/oidc/token",
    {
      bodyLimit: 1024,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const header = req.headers.authorization;
      check(
        typeof header === "string" &&
          header.startsWith("Bearer ") &&
          header.length <= 16391,
        401,
        "oidc_identity_required",
        "Supply a CI-issued OIDC ID token as a Bearer credential.",
      );
      const { publisherId } = z
        .object({ publisherId: z.uuid() })
        .strict()
        .parse(req.body);
      return auth.oidc.exchange(
        context(req).tenant,
        publisherId,
        header.slice(7),
      );
    },
  );
  const owner = (req: FastifyRequest, mutation: boolean) =>
    auth.tenant(req, context(req).tenant.slug, mutation);
  // Suspension blocks extending CI trust. Owners can still list publishers and
  // revoke compromised trust while suspended.
  const available = async (req: FastifyRequest) => {
    const tenant = await owner(req, true);
    check(
      tenantAvailable(tenant, "buyer"),
      403,
      "tenant_suspended",
      "This publisher's service is suspended.",
    );
    return tenant;
  };
  app.get("/seller/oidc/publishers", { config: apiLimit(30) }, async (req) =>
    auth.oidc.list(await owner(req, false)),
  );
  app.post("/seller/oidc/publishers", { config: apiLimit(20) }, async (req) => {
    const tenant = await available(req),
      session = await auth.seller(req, true);
    const publisher = publisherInputSchema.parse(req.body);
    return auth.oidc.create(tenant, session.user.id, publisher, (tx) =>
      strong.require(req, tx, session, {
        action: "oidc.create",
        tenant: tenant.slug,
        publisher,
      }),
    );
  });
  app.post(
    "/seller/oidc/publishers/:id/revoke",
    { config: apiLimit(20) },
    async (req) => {
      z.object({}).strict().parse(req.body);
      const { id } = z.object({ id: z.uuid() }).parse(req.params);
      const tenant = await owner(req, true),
        session = await auth.seller(req, true);
      await auth.oidc.revoke(tenant.id, session.user.id, id, (tx) =>
        strong.require(req, tx, session, {
          action: "oidc.revoke",
          tenant: tenant.slug,
          publisherId: id,
        }),
      );
      return { ok: true };
    },
  );
}
