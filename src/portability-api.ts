import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlatformAuth } from "./platform-auth.ts";
import type { AccountManagement } from "./account-management.ts";
import type { TenantContext } from "./db.ts";
import type { Portability } from "./portability.ts";
import { equal } from "./crypto.ts";
import { check } from "./errors.ts";
import { handlerOwnsSocketTimeout } from "./http-timeout.ts";
export interface PortabilityApiOptions {
  context: (req: FastifyRequest) => {
    tenant: TenantContext;
    portability: Portability;
  };
  auth: Pick<PlatformAuth, "tenant" | "seller">;
  accounts: Pick<AccountManagement, "requireStepUp">;
}
const tenantSlug = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const id = z.string().uuid(),
  empty = z.object({}).strict();
const rate = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });
// Register separately from sellerRoutes so its generic scope hook does not run.
export async function portabilityRoutes(
  api: FastifyInstance,
  options: PortabilityApiOptions,
) {
  async function authorize(req: FastifyRequest, stepUp = false) {
    const services = options.context(req);
    const mutation = req.method !== "GET";
    await options.auth.tenant(
      req,
      services.tenant.slug,
      mutation,
      true,
      "data:export",
    );
    if (!mutation && req.headers.authorization === undefined) {
      const { csrfToken } = await options.auth.seller(req, false);
      const supplied = req.headers["x-csrf-token"];
      check(
        typeof supplied === "string" && equal(supplied, csrfToken),
        403,
        "csrf_denied",
        "CSRF token is missing or invalid.",
      );
    }
    if (stepUp && req.headers.authorization === undefined)
      await options.accounts.requireStepUp(req, "tenant_transfer");
    return services;
  }
  api.get(
    "/exports",
    { exposeHeadRoute: false, config: rate(30) },
    async (req, reply) => {
      const { tenant, portability } = await authorize(req);
      reply.header("cache-control", "no-store");
      return { exports: portability.listExports(tenant.id) };
    },
  );
  api.post("/exports", { config: rate(2) }, async (req, reply) => {
    const input = z
      .object({ passphrase: z.string().min(12).max(1024) })
      .strict()
      .parse(req.body);
    const { tenant, portability } = await authorize(req, true);
    reply.header("cache-control", "no-store");
    handlerOwnsSocketTimeout(req, reply, api.server.timeout);
    const controller = new AbortController();
    let exported: Awaited<ReturnType<Portability["createExport"]>> | undefined;
    const detach = () => {
      req.raw.removeListener("aborted", disconnected);
      reply.raw.removeListener("close", disconnected);
      reply.raw.removeListener("finish", detach);
    };
    const disconnected = () => {
      detach();
      controller.abort();
      // Creation may have completed just before the JSON response was lost.
      if (exported)
        void portability.deleteExport(tenant.id, exported.id).catch(() => {});
    };
    req.raw.once("aborted", disconnected);
    reply.raw.once("close", disconnected);
    reply.raw.once("finish", detach);
    if (req.raw.aborted || reply.raw.destroyed) disconnected();
    try {
      exported = await portability.createExport(
        tenant.id,
        input.passphrase,
        controller.signal,
      );
      return exported;
    } catch (error) {
      detach();
      throw error;
    }
  });
  api.get(
    "/exports/:id/manifest",
    { exposeHeadRoute: false, config: rate(30) },
    async (req, reply) => {
      const params = z
          .object({ tenant: tenantSlug, id })
          .strict()
          .parse(req.params),
        { tenant, portability } = await authorize(req);
      reply
        .header("cache-control", "no-store")
        .type("application/octet-stream");
      return reply.send(
        await portability.openExport(tenant.id, params.id, "manifest"),
      );
    },
  );
  api.get(
    "/exports/:id/blobs/:blobId",
    { exposeHeadRoute: false, config: rate(30) },
    async (req, reply) => {
      const params = z
          .object({ tenant: tenantSlug, id, blobId: id })
          .strict()
          .parse(req.params),
        { tenant, portability } = await authorize(req);
      handlerOwnsSocketTimeout(req, reply, api.server.timeout);
      reply
        .header("cache-control", "no-store")
        .type("application/octet-stream");
      return reply.send(
        await portability.openExport(tenant.id, params.id, params.blobId),
      );
    },
  );
  api.delete("/exports/:id", { config: rate(10) }, async (req) => {
    empty.optional().parse(req.body);
    const params = z
        .object({ tenant: tenantSlug, id })
        .strict()
        .parse(req.params),
      { tenant, portability } = await authorize(req);
    await portability.deleteExport(tenant.id, params.id);
    return { ok: true };
  });
}
