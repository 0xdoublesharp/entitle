import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlatformAuth } from "./platform-auth.ts";
import type { TenantContextFor } from "./tenant-api.ts";
import { apiLimit } from "./tenant-api.ts";
import { Operations } from "./operations.ts";
import { OutboundWebhooks, outboundEventTypes } from "./outbound-webhooks.ts";
import { featureEntitlements } from "./plan-features.ts";
import { check } from "./errors.ts";

const id = z.string().uuid();
const empty = z.object({}).strict();
export async function operationsRoutes(
  api: FastifyInstance,
  context: TenantContextFor,
  auth: PlatformAuth,
) {
  const authorize = async (
    req: FastifyRequest,
    mutation = false,
    advanced = false,
  ) => {
    const s = context(req);
    await auth.tenant(
      req,
      s.tenant.slug,
      mutation,
      true,
      mutation ? "operations:write" : "read",
    );
    const features = featureEntitlements(s.config, s.tenant);
    check(
      !advanced || features.outboundWebhooks,
      403,
      "pro_required",
      "Hosted Pro is required for this automation.",
    );
    return { ...s, features, operations: new Operations(s.db, s.tenant.id) };
  };
  const hooks = (s: ReturnType<TenantContextFor>) =>
    new OutboundWebhooks(
      s.db,
      s.tenant.id,
      s.config.secret,
      s.config.outboundWebhookHosts?.length
        ? { allowHosts: s.config.outboundWebhookHosts }
        : {},
    );
  api.get("/features", { config: apiLimit(60) }, async (req) => {
    const s = await authorize(req);
    return {
      features: s.features,
      hostedProConfigured: !!s.config.platformProStripePriceId,
    };
  });
  api.get("/operations", { config: apiLimit(30) }, async (req) => {
    const s = await authorize(req);
    return {
      summary: await s.operations.summary(),
      settings: await s.operations.settings(),
      alerts: (
        await s
          .db("operation_alerts")
          .where({ tenant_id: s.tenant.id, active: 1 })
          .whereIn("id", [
            "queue_failed",
            "queue_stalled",
            "storage_capacity",
            "bandwidth",
            "billing_capacity",
          ])
          .orderBy("id")
      ).map((row) => ({
        id: row.id,
        kind: row.id,
        occurredAt: Number(row.last_sent_at),
      })),
      notifications: await s.operations.sellerNotifications(),
      features: s.features,
    };
  });
  api.put("/operations/settings", { config: apiLimit(10) }, async (req) => {
    const s = await authorize(req, true);
    const settings = await s.operations.configure(req.body);
    return { settings };
  });
  api.get("/operations/activity", { config: apiLimit(20) }, async (req) => {
    const s = await authorize(req);
    const { days } = z.object({ days:z.coerce.number().int().min(1).max(365).default(30) }).strict().parse(req.query);
    return s.operations.activity(days);
  });
  api.get("/operations/reports", { config: apiLimit(20) }, async (req) => {
    const s = await authorize(req);
    check(
      s.features.advancedReports,
      403,
      "pro_required",
      "Hosted Pro is required for advanced reporting.",
    );
    const { days } = z
      .object({ days: z.coerce.number().int().min(1).max(365).default(30) })
      .strict()
      .parse(req.query);
    const generatedAt = Date.now();
    const since = new Date(generatedAt - (days - 1) * 86400000)
      .toISOString()
      .slice(0, 10);
    const rows = await s
      .db("download_metrics")
      .where({ tenant_id: s.tenant.id })
      .andWhere("day", ">=", since)
      .andWhere("day", "<=", new Date(generatedAt).toISOString().slice(0, 10))
      .groupBy("day")
      .orderBy("day")
      .select("day")
      .sum<Record<string, string | number>[]>({
        responses: "successful_responses",
        servedBytes: "served_bytes",
        storageReadBytes: "storage_read_bytes",
        storageReads: "storage_reads",
      });
    return {
      days,
      generatedAt,
      rows: rows.map((r) => ({
        day: r.day,
        responses: Number(r.responses),
        servedBytes: Number(r.servedBytes),
        storageReadBytes: Number(r.storageReadBytes),
        storageReads: Number(r.storageReads),
      })),
    };
  });
  api.get("/webhooks", { config: apiLimit(30) }, async (req) => {
    const s = await authorize(req, false, true),
      outbound = hooks(s);
    return {
      endpoints: await outbound.listEndpoints(),
      deliveries: await outbound.deliveries(),
    };
  });
  api.post("/webhooks", { config: apiLimit(5) }, async (req) => {
    const s = await authorize(req, true, true);
    const input = z
      .object({
        url: z.string().min(1).max(1000),
        events: z.array(z.enum(outboundEventTypes)).min(1).max(7),
      })
      .strict()
      .parse(req.body);
    return hooks(s).createEndpoint(input);
  });
  api.post("/webhooks/:id/rotate", { config: apiLimit(5) }, async (req) => {
    empty.parse(req.body);
    const s = await authorize(req, true, true);
    return hooks(s).rotateSecret(z.object({ id }).parse(req.params).id);
  });
  api.delete("/webhooks/:id", { config: apiLimit(10) }, async (req) => {
    const s = await authorize(req, true, true);
    await hooks(s).deleteEndpoint(z.object({ id }).parse(req.params).id);
    return { ok: true };
  });
  api.post(
    "/webhook-deliveries/:id/retry",
    { config: apiLimit(10) },
    async (req) => {
      empty.parse(req.body);
      const s = await authorize(req, true, true);
      await hooks(s).retry(
        z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(req.params)
          .id,
      );
      return { ok: true };
    },
  );
}
export async function notificationRoutes(
  api: FastifyInstance,
  context: TenantContextFor,
) {
  api.get("/notifications", { config: apiLimit(30) }, async (req) => {
    const s = context(req),
      { customer } = await s.auth.customer(req, false);
    return {
      notifications: await new Operations(s.db, s.tenant.id).notifications(
        customer.id,
      ),
    };
  });
  api.post(
    "/notifications/:id/dismiss",
    { config: apiLimit(20) },
    async (req) => {
      empty.parse(req.body);
      const s = context(req),
        { customer } = await s.auth.customer(req, true);
      const notice = z
        .object({ id: z.string().min(1).max(64) })
        .parse(req.params).id;
      await new Operations(s.db, s.tenant.id).dismissNotification(
        customer.id,
        notice,
      );
      return { ok: true };
    },
  );
}
