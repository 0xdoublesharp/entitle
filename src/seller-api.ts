import { Readable, Transform, PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { artifactTransferBudget } from "./artifact-streams.ts";
import { setLicenseRevoked } from "./business-events.ts";
import { PublisherSandboxes } from "./sandboxes.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { lock } from "./db.ts";
import type { Tenant } from "./db.ts";
import type { TenantContextFor } from "./tenant-api.ts";
import type { PlatformAuth } from "./platform-auth.ts";
import type { Tenants } from "./tenants.ts";
import { tenantAvailable } from "./tenants.ts";
import type { PlatformBilling } from "./platform-billing.ts";
import { AppError, check } from "./errors.ts";
import { hash } from "./crypto.ts";
import { tenantMetrics } from "./metrics.ts";
import { AccountManagement } from "./account-management.ts";
import { validateAssetMetadata } from "./package-validation.ts";
import { frameworks, validateFrameworkConfig } from "./frameworks.ts";
import { complimentaryInput } from "./licensing.ts";
import { stripeConfigured } from "./config.ts";
const slug = z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(100),
  empty = z.object({}).strict();

export async function sellerRoutes(
  app: FastifyInstance,
  context: TenantContextFor,
  auth: PlatformAuth,
  tenants: Tenants,
  payments: PlatformBilling,
  tick: (tenant: Tenant) => Promise<void>,
  maxUploadBytes = 25 * 1024 * 1024,
  maxNativeUploadBytes = 100 * 1024 * 1024,
  nativeLifecycle?: {
    begin(req: FastifyRequest): void;
    end(req: FastifyRequest): void;
  },
) {
  app.addHook("onRequest", async (req) => {
    const s = context(req),
      route = req.routeOptions.url!;
    check(
      s.config.deploymentMode === "hosted" ||
        (!route.includes("/stripe/") && !route.includes("/platform/")),
      404,
      "not_found",
      "Route not found.",
    );
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
    const interactive =
      route.includes("/keys") ||
      route.includes("/stripe/") ||
      route.includes("/platform/") ||
      route.includes("/commerce/") ||
      route.includes("/sandbox");
    const scope =
      route.includes("/operations/") ||
      route.includes("/webhooks") ||
      route.includes("/webhook-deliveries/")
        ? mutation
          ? "operations:write"
          : "read"
        : !mutation
          ? "read"
          : route.endsWith("/products")
            ? "catalog:write"
            : route.includes("/releases/") || route.includes("/assets/")
              ? "releases:write"
              : route.includes("/licenses/") || route.includes("/local/")
                ? "licenses:write"
                : "billing:reconcile";
    await auth.tenant(req, s.tenant.slug, mutation, !interactive, scope);
    if (
      !route.includes("/platform/") &&
      !route.includes("/keys") &&
      !route.includes("/commerce/")
    )
      check(
        tenantAvailable(s.tenant, "buyer"),
        403,
        "tenant_suspended",
        "This publisher's service is suspended.",
      );
    if (mutation && (route.endsWith("/keys") || route.includes("/keys/:id/")))
      await new AccountManagement(s.db, auth).requireStepUp(req, "api_keys");
    if (
      mutation &&
      !req.headers.authorization &&
      (route.endsWith("/releases/:product/:version") ||
        route.endsWith("/assets/:product/:version"))
    )
      await new AccountManagement(s.db, auth).requireStepUp(
        req,
        "release_publish",
      );
    const capacity =
      mutation &&
      (route.endsWith("/products") ||
        route.endsWith("/releases/:product/:version") ||
        route.endsWith("/assets/:product/:version") ||
        route.includes("/local/") || route.endsWith("/licenses/complimentary"));
    if (capacity && s.config.deploymentMode === "hosted")
      check(
        tenantAvailable(
          s.tenant,
          "capacity",
          (s.config.graceDays ?? 7) * 86400000,
        ),
        403,
        "tenant_capacity",
        "Renew the platform subscription or contact the operator before adding capacity.",
      );
  });
  async function audit(
    req: FastifyRequest,
    action: string,
    details: Record<string, string>,
  ) {
    const { db, tenant } = context(req);
    const header = req.headers.authorization;
    const key = header
      ? await db("tenant_api_keys")
          .where({ tenant_id: tenant.id, key_hash: hash(header.slice(7)) })
          .first("id")
      : undefined;
    const actor = key?.id ?? (await auth.seller(req, false)).user.id;
    await db("audit_events").insert({
      id: randomUUID(),
      tenant_id: tenant.id,
      actor_type: key ? "api_key" : "seller",
      actor_id: actor,
      action,
      details: JSON.stringify(details),
      created_at: Date.now(),
    });
  }
  app.get("/overview", async (req) => {
    const { db, tenant, config } = context(req);
    const products = await db("products").where({ tenant_id: tenant.id });
    const plans = Map.groupBy(
      await db("plans").where({ tenant_id: tenant.id }),
      (plan) => plan.product_id,
    );
    for (const p of products) {
      p.frameworkConfig = JSON.parse(p.framework_config);
      p.plans = plans.get(p.id) ?? [];
    }
    const licenses = await db("licenses")
      .join("customers", "customers.id", "licenses.customer_id")
      .join("products", "products.id", "licenses.product_id")
      .leftJoin("plans", "plans.id", "licenses.plan_id")
      .where("licenses.tenant_id", tenant.id)
      .select(
        "licenses.id",
        "licenses.customer_id",
        "licenses.product_id",
        "licenses.site_allowance",
        "licenses.paid_through",
        "licenses.billing_status",
        "licenses.provenance",
        "licenses.expires_at",
        "licenses.internal_note",
        "licenses.issued_at",
        "licenses.revoked",
        "licenses.refund_revoked",
        "licenses.suspended",
        {
          product_name: "products.name",
          plan_name: "plans.name",
          customer_email: "customers.email",
        },
      );
    const availableReleases = await db("releases")
      .where({ tenant_id: tenant.id })
      .select("id", "product_id", "version", "withdrawn");
    const assets = Map.groupBy(
      await db("release_assets").where({ tenant_id: tenant.id }),
      (asset) => asset.release_id,
    );
    for (const release of availableReleases)
      release.assets = assets.get(release.id) ?? [];
    return {
      tenant,
      billingAvailable: config.localBilling || stripeConfigured(config),
      products,
      licenses: licenses.map((l) => ({
        ...l,
        plan_name: l.plan_name ?? "Complimentary",
        expires_at: l.expires_at === null ? null : Number(l.expires_at),
        paid_through: Number(l.paid_through),
        revoked: !!l.revoked || !!l.refund_revoked,
        suspended: !!l.suspended,
      })),
      releases: availableReleases.map((r) => ({
        ...r,
        withdrawn: !!r.withdrawn,
      })),
      metrics: await tenantMetrics(db, tenant),
      sandbox:
        (await new PublisherSandboxes(db, config).describe(tenant.id)) ?? null,
    };
  });
  app.get("/licenses/:id", async (req) => {
    const { db, tenant } = context(req);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const { after, limit } = z.object({ after: z.string().min(1).max(64).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).strict().parse(req.query);
    const license = await db("licenses")
      .join("customers", function () { this.on("customers.id", "=", "licenses.customer_id").andOn("customers.tenant_id", "=", "licenses.tenant_id"); })
      .join("products", function () { this.on("products.id", "=", "licenses.product_id").andOn("products.tenant_id", "=", "licenses.tenant_id"); })
      .leftJoin("plans", function () { this.on("plans.id", "=", "licenses.plan_id").andOn("plans.tenant_id", "=", "licenses.tenant_id"); })
      .where({ "licenses.tenant_id": tenant.id, "licenses.id": id })
      .first("licenses.id", "licenses.customer_id", "licenses.product_id", "licenses.site_allowance", "licenses.paid_through", "licenses.billing_status", "licenses.provenance", "licenses.expires_at", "licenses.internal_note", "licenses.issued_at", "licenses.revoked", "licenses.refund_revoked", "licenses.suspended", {product_name:"products.name",plan_name:"plans.name",customer_email:"customers.email"});
    check(license, 404, "not_found", "License not found.");
    const query = db("installations").where({ tenant_id:tenant.id, license_id:id }).orderBy("id").limit(limit+1).select("id","site_url","label","active","exempt");
    if (after) query.andWhere("id", ">", after);
    const rows=await query;
    const page=rows.slice(0,limit);
    return {license:{...license,plan_name:license.plan_name??"Complimentary",expires_at:license.expires_at===null?null:Number(license.expires_at),paid_through:Number(license.paid_through),revoked:!!license.revoked||!!license.refund_revoked,suspended:!!license.suspended},installations:page.map((item)=>({...item,active:!!item.active,exempt:!!item.exempt})),nextCursor:rows.length>limit?page.at(-1)!.id:null};
  });
  app.get("/prices", async (req) => {
    const { tenant, stripe, config, reads } = context(req);
    if (config.localBilling)
      return {
        localMode: true,
        prices: [1, 5, 25].map((sites) => ({
          id: `price_local_${sites}`,
          productName: "Local test fixture",
          nickname: `${sites} sites`,
          unit_amount: 10000,
          currency: "usd",
          interval: "year",
        })),
      };
    check(stripeConfigured(config), 503, "billing_unavailable", "Stripe billing is not configured.");
    check(
      config.deploymentMode === "standalone" || tenant.stripe_account_id,
      409,
      "stripe_not_connected",
      "Connect a Stripe account first.",
    );
    const accountId = tenant.stripe_account_id;
    const prices = await reads.remember(
      "prices",
      tenant.id,
      { account: accountId, live: !!config.stripeLiveMode },
      async () => {
        const prices = [];
        for await (const p of stripe.stripe.prices.list(
          {
            active: true,
            type: "recurring",
            limit: 100,
            expand: ["data.product"],
          },
          stripe.options(),
        )) {
          if (
            p.recurring?.interval !== "year" ||
            p.recurring.interval_count !== 1
          )
            continue;
          prices.push({
            id: p.id,
            productName:
              typeof p.product === "string" || p.product.deleted
                ? p.product.toString()
                : p.product.name,
            nickname: p.nickname,
            unit_amount: p.unit_amount,
            currency: p.currency,
            interval: "year",
          });
          if (prices.length >= 100) break;
        }
        return prices;
      },
    );
    return { localMode: false, prices };
  });
  app.post("/products", async (req) => {
    const { db, tenant, config, stripe } = context(req);
    const input = z
      .object({
        slug,
        name: z.string().min(1).max(200),
        framework: z.enum(frameworks).optional(),
        frameworkConfig: z.unknown().optional(),
        pluginBasename: z
          .string()
          .max(255)
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9_-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.php$(?![\s\S])/,
          )
          .optional(),
        plans: z
          .array(
            z
              .object({
                name: z.string().min(1).max(150),
                siteAllowance: z.number().int().min(1).max(100000),
                priceId: z.string().min(1).max(150),
              })
              .strict(),
          )
          .max(50),
      })
      .strict()
      .parse(req.body);
    if (!config.localBilling && input.plans.length) {
      check(stripeConfigured(config), 503, "billing_unavailable", "Stripe billing is not configured.");
      check(
        config.deploymentMode === "standalone" || tenant.stripe_account_id,
        409,
        "stripe_not_connected",
        "Connect a Stripe account first.",
      );
      for (const plan of input.plans) {
        const p = await stripe.stripe.prices.retrieve(
          plan.priceId,
          {},
          stripe.options(),
        );
        check(
          p.active &&
            p.type === "recurring" &&
            p.recurring?.interval === "year" &&
            p.recurring.interval_count === 1,
          409,
          "invalid_price",
          "Choose an active annual price from the connected Stripe account.",
        );
      }
    }
    const result = await db.transaction(async (tx) => {
      await lock(tx, "schema", tenant.id);
      const currentTenant = await tx("tenants")
        .where({ id: tenant.id })
        .first();
      check(
        currentTenant &&
          tenantAvailable(
            currentTenant,
            "capacity",
            (config.graceDays ?? 7) * 86400000,
          ),
        403,
        "tenant_capacity",
        "Tenant cannot add capacity.",
      );
      const existing = await tx("products")
        .where({ tenant_id: tenant.id, slug: input.slug })
        .first();
      const framework = input.framework ?? existing?.framework ?? "wordpress";
      const frameworkConfig = validateFrameworkConfig(
        framework,
        input.frameworkConfig ??
          (existing && framework === existing.framework
            ? JSON.parse(existing.framework_config)
            : {}),
      );
      check(
        framework === "wordpress" || input.pluginBasename === undefined,
        400,
        "invalid_framework_config",
        "Plugin basename applies only to WordPress products.",
      );
      if (
        existing &&
        (framework !== existing.framework ||
          JSON.stringify(frameworkConfig) !==
            JSON.stringify(
              validateFrameworkConfig(
                existing.framework,
                JSON.parse(existing.framework_config),
              ),
            ))
      ) {
        const released = await tx("releases")
          .where({ tenant_id: tenant.id, product_id: existing.id })
          .first();
        const licensed = await tx("licenses")
          .where({ tenant_id: tenant.id, product_id: existing.id })
          .first();
        check(
          !released && !licensed,
          409,
          "framework_immutable",
          "Framework identity cannot change after a release or license exists.",
        );
      }
      if (!existing) {
        const count = await tx("products")
          .where({ tenant_id: tenant.id })
          .count({ count: "id" })
          .first();
        check(
          Number(count!.count) < currentTenant.max_products,
          409,
          "product_limit",
          "Tenant product allowance has been reached.",
        );
      }
      const basename =
        framework === "wordpress"
          ? (input.pluginBasename ?? existing?.plugin_basename ?? null)
          : null;
      if (existing?.plugin_basename && basename !== existing.plugin_basename)
        check(
          !(await tx("releases")
            .where({ tenant_id: tenant.id, product_id: existing.id })
            .first()),
          409,
          "plugin_identity_immutable",
          "Plugin basename cannot change after a release is published.",
        );
      const product = {
        tenant_id: tenant.id,
        id: existing?.id ?? randomUUID(),
        slug: input.slug,
        name: input.name,
        plugin_basename: basename,
        framework,
        framework_config: JSON.stringify(frameworkConfig),
      };
      if (existing)
        await tx("products")
          .where({ tenant_id: tenant.id, id: product.id })
          .update({
            name: product.name,
            plugin_basename: basename,
            framework,
            framework_config: product.framework_config,
          });
      else await tx("products").insert(product);
      for (const plan of input.plans) {
        const found = await tx("plans")
          .where({ tenant_id: tenant.id, stripe_price_id: plan.priceId })
          .first();
        check(
          !found || found.product_id === product.id,
          409,
          "price_conflict",
          "Stripe price is already mapped to another product.",
        );
        if (found) {
          check(
            found.site_allowance === plan.siteAllowance,
            409,
            "plan_immutable",
            "Create a new Stripe price to change a plan allowance.",
          );
          continue;
        }
        await tx("plans").insert({
          tenant_id: tenant.id,
          id: randomUUID(),
          product_id: product.id,
          name: plan.name,
          site_allowance: plan.siteAllowance,
          stripe_price_id: plan.priceId,
        });
      }
      return {
        product: { ...product, frameworkConfig },
        plans: await tx("plans").where({
          tenant_id: tenant.id,
          product_id: product.id,
        }),
      };
    });
    await audit(req, "product.configured", { product_id: result.product.id });
    return result;
  });
  app.post("/licenses/complimentary", async (req) => {
    const { db, tenant, licensing } = context(req);
    const input = complimentaryInput.parse(req.body);
    const header = req.headers.authorization;
    const key = header ? await db("tenant_api_keys").where({ tenant_id: tenant.id, key_hash: hash(header.slice(7)) }).first("id") : undefined;
    const actor = key ? { type: "api_key" as const, id: key.id as string } : { type: "seller" as const, id: (await auth.seller(req, false)).user.id };
    return licensing.issueComplimentary(input, actor);
  });
  app.post("/licenses/:id/revoke", async (req) => {
    const { db, tenant } = context(req),
      { id } = z.object({ id: z.string().max(64) }).parse(req.params),
      { revoked } = z.object({ revoked: z.boolean() }).strict().parse(req.body);
    await db.transaction((tx) => setLicenseRevoked(tx, tenant.id, id, revoked));
    await audit(req, revoked ? "license.revoked" : "license.restored", {
      license_id: id,
    });
    return { ok: true };
  });
  app.post("/releases/:id/withdraw", async (req) => {
    empty.parse(req.body);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await context(req).releases.withdraw(id);
    await audit(req, "release.withdrawn", { release_id: id });
    return { ok: true };
  });
  await app.register(async (upload) => {
    upload.addContentTypeParser(
      "application/zip",
      { parseAs: "buffer", bodyLimit: maxUploadBytes },
      (_req, body, done) => done(null, body),
    );
    upload.post(
      "/releases/:product/:version",
      { bodyLimit: maxUploadBytes },
      async (req) => {
        const { config, releases } = context(req),
          params = z
            .object({ product: slug, version: z.string().max(60) })
            .parse(req.params);
        check(
          Buffer.isBuffer(req.body),
          400,
          "invalid_zip",
          "ZIP body required.",
        );
        check(
          req.body.length <= (config.maxUploadBytes ?? 25 * 1024 * 1024),
          413,
          "upload_limit",
          "Release ZIP exceeds the upload limit.",
        );
        const header = z
          .string()
          .max(12288)
          .parse(req.headers["x-release-metadata"]);
        let decoded: unknown;
        try {
          decoded = JSON.parse(
            Buffer.from(header, "base64url").toString("utf8"),
          );
        } catch {
          throw new AppError(
            400,
            "invalid_metadata",
            "Release metadata must be base64url JSON.",
          );
        }
        const metadata = z
          .object({
            changelog: z.string().max(30000),
            minWp: z.string().max(60).default("6.0"),
            minPhp: z.string().max(60).default("8.0"),
            minFree: z.string().max(60).default("0.0.0"),
            tested: z.string().max(60).default("0.0.0"),
          })
          .strict()
          .parse(decoded);
        const directory = await mkdtemp(join(config.storage, ".upload-"));
        try {
          const file = join(directory, "release.zip");
          await writeFile(file, req.body, { mode: 0o600, flag: "wx" });
          const release = await releases.publish({
            ...params,
            ...metadata,
            file,
          });
          await audit(req, "release.published", {
            release_id: release.id,
            product_id: release.product_id,
          });
          return release;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  });
  await app.register(async (upload) => {
    upload.addContentTypeParser(
      "application/octet-stream",
      { bodyLimit: maxNativeUploadBytes },
      (_req, payload, done) => done(null, payload),
    );
    upload.post(
      "/assets/:product/:version",
      { bodyLimit: maxNativeUploadBytes },
      async (req, reply) => {
        nativeLifecycle?.begin(req);
        let retainReservation = false;
        try {
          const { db, tenant, config, artifacts } = context(req);
          const params = z
            .object({ product: slug, version: z.string().max(60) })
            .parse(req.params);
          check(
            req.body instanceof Readable,
            400,
            "invalid_artifact",
            "An artifact body is required.",
          );
          const header = z
            .string()
            .min(1)
            .max(12288)
            .regex(/^[A-Za-z0-9_-]+$/)
            .parse(req.headers["x-release-metadata"]);
          let decoded: unknown;
          try {
            decoded = JSON.parse(
              Buffer.from(header, "base64url").toString("utf8"),
            );
          } catch {
            throw new AppError(
              400,
              "invalid_metadata",
              "Release metadata must be base64url JSON.",
            );
          }
          const product = await db("products")
            .where({ tenant_id: tenant.id, slug: params.product })
            .first();
          check(product, 404, "not_found", "Product not found.");
          const metadata = validateAssetMetadata(product.framework, decoded);
          const directory = await mkdtemp(join(config.storage, ".upload-"));
          try {
            const file = join(directory, "artifact");
            const expected = Number(req.headers["content-length"]);
            const limit = config.maxNativeUploadBytes ?? maxNativeUploadBytes;
            let received = 0;
            const controller = new AbortController();
            const idleMs = config.nativeUploadTimeoutMs ?? 120000;
            const expire = () => controller.abort();
            const timer = setTimeout(
              expire,
              artifactTransferBudget(expected, idleMs),
            );
            let idle = setTimeout(expire, idleMs);
            const input = req.body as Readable;
            const bridge = new PassThrough({ highWaterMark: 64 * 1024 });
            const failed = (error: Error) => bridge.destroy(error);
            const aborted = () =>
              bridge.destroy(
                new AppError(
                  400,
                  "upload_aborted",
                  "Artifact upload was interrupted.",
                ),
              );
            input.once("error", failed);
            input.once("aborted", aborted);
            try {
              const writing = pipeline(
                bridge,
                new Transform({
                  transform(chunk: Buffer, _encoding, done) {
                    clearTimeout(idle);
                    idle = setTimeout(expire, idleMs);
                    received += chunk.length;
                    if (received > limit) {
                      done(
                        new AppError(
                          413,
                          "upload_limit",
                          "Artifact exceeds the native upload limit.",
                        ),
                      );
                      return;
                    }
                    if (received > expected) {
                      done(
                        new AppError(
                          400,
                          "content_length_mismatch",
                          "Artifact length does not match Content-Length.",
                        ),
                      );
                      return;
                    }
                    done(null, chunk);
                  },
                }),
                createWriteStream(file, { flags: "wx", mode: 0o600 }),
                { signal: controller.signal },
              );
              input.pipe(bridge);
              await writing;
              check(
                received === expected,
                400,
                "content_length_mismatch",
                "Artifact length does not match Content-Length.",
              );
            } catch (error) {
              reply.header("connection", "close");
              input.unpipe(bridge);
              input.resume();
              if (controller.signal.aborted)
                throw new AppError(
                  408,
                  "upload_timeout",
                  "Artifact upload timed out.",
                );
              throw error;
            } finally {
              clearTimeout(timer);
              clearTimeout(idle);
              input.off("error", failed);
              input.off("aborted", aborted);
            }
            const result = await artifacts.publish({
              ...params,
              ...metadata,
              file,
            });
            await audit(req, "asset.published", {
              release_id: result.release.id,
              asset_id: result.asset.id,
              product_id: result.release.product_id,
              target: result.asset.target,
            });
            return result;
          } finally {
            await rm(directory, { recursive: true, force: true }).catch(
              (error: unknown) => {
                retainReservation = true;
                throw error;
              },
            );
          }
        } finally {
          if (req.body instanceof Readable && !req.body.readableEnded) {
            reply.header("connection", "close");
            req.body.resume();
          }
          // Retain the process disk reservation if file deletion is uncertain.
          // Operator cleanup and restart are required before reusing that space.
          if (!retainReservation) nativeLifecycle?.end(req);
        }
      },
    );
  });
  app.get("/keys", async (req) => ({
    keys: await tenants.keys(
      await auth.seller(req, false),
      context(req).tenant.id,
    ),
  }));
  app.post("/keys", async (req) => {
    const b = z
      .object({
        name: z.string().min(1).max(150),
        scopes: z.array(z.string()).max(7).optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
      .strict()
      .parse(req.body);
    return tenants.createKey(
      await auth.seller(req, true),
      context(req).tenant.id,
      b.name,
      {
        ...(b.scopes ? { scopes: b.scopes } : {}),
        ...(b.expiresInDays ? { expiresInDays: b.expiresInDays } : {}),
      },
    );
  });
  app.post("/keys/:id/revoke", async (req) => {
    empty.parse(req.body);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await tenants.revokeKey(
      await auth.seller(req, true),
      context(req).tenant.id,
      id,
    );
    return { ok: true };
  });
  app.post("/stripe/connect", async (req) => {
    empty.parse(req.body);
    return payments.connect(context(req).tenant, await auth.seller(req, true));
  });
  app.post("/platform/checkout", async (req) => {
    const { tier } = z
      .object({ tier: z.enum(["starter", "pro"]).default("starter") })
      .strict()
      .parse(req.body);
    return payments.checkout(
      context(req).tenant,
      await auth.seller(req, true),
      tier,
    );
  });
  app.post("/platform/portal", async (req) => {
    empty.parse(req.body);
    await auth.seller(req, true);
    return payments.portal(context(req).tenant);
  });
  app.post("/reconcile", async (req) => {
    check(context(req).config.localBilling || stripeConfigured(context(req).config), 503, "billing_unavailable", "Stripe billing is not configured.");
    const { stripe, billing } = context(req),
      input = z
        .object({ subscriptionId: z.string().min(1).max(150).optional() })
        .strict()
        .parse(req.body);
    const ids = input.subscriptionId
      ? [input.subscriptionId]
      : await stripe.subscriptionIds();
    await billing.enqueueReconcile(ids);
    return { queued: ids.length };
  });
  app.get("/jobs", async (req) => {
    const { db, tenant } = context(req),
      columns = [
        "id",
        "kind",
        "state",
        "attempts",
        "last_error",
        "available_at",
      ];
    return {
      work: await db("work").where({ tenant_id: tenant.id }).select(columns),
      emails: await db("emails")
        .where({ tenant_id: tenant.id })
        .select(columns),
    };
  });
  app.post("/jobs/run", async (req) => {
    empty.parse(req.body);
    await tick(context(req).tenant);
    return { ok: true };
  });
  app.post("/jobs/:table/retry-failed", async (req) => {
    const { table } = z
      .object({ table: z.enum(["work", "emails"]) })
      .parse(req.params);
    const { limit } = z
      .object({ limit: z.number().int().min(1).max(500).default(100) })
      .strict()
      .parse(req.body);
    const { db, tenant } = context(req);
    const queued = await db.transaction(async (tx) => {
      await lock(tx, table === "work" ? "work" : "email", tenant.id);
      const ids = await tx(table)
        .where({ tenant_id: tenant.id, state: "failed" })
        .orderBy("created_at")
        .limit(limit)
        .pluck("id");
      if (!ids.length) return 0;
      return tx(table)
        .where({ tenant_id: tenant.id, state: "failed" })
        .whereIn("id", ids)
        .update({
          state: "pending",
          attempts: 0,
          available_at: 0,
          lease_until: 0,
          lease_owner: null,
          last_error: null,
          created_at: Date.now(),
        });
    });
    await audit(req, "jobs.retry_requested", {
      queue: table,
      queued: String(queued),
    });
    return { queued };
  });
  app.post("/jobs/:table/:id/retry", async (req) => {
    empty.parse(req.body);
    const { table, id } = z
        .object({
          table: z.enum(["work", "emails"]),
          id: z.string().min(1).max(150),
        })
        .parse(req.params),
      { db, tenant } = context(req);
    check(
      await db(table)
        .where({ tenant_id: tenant.id, id, state: "failed" })
        .update({
          state: "pending",
          attempts: 0,
          available_at: 0,
          lease_until: 0,
          lease_owner: null,
          last_error: null,
          created_at: Date.now(),
        }),
      404,
      "not_found",
      "Failed job not found.",
    );
    await audit(req, "job.retry_requested", { job_id: id, queue: table });
    return { ok: true };
  });
  app.post("/local/purchase", async (req) => {
    const { config, db, tenant, licensing } = context(req);
    check(
      config.localBilling && !config.production,
      404,
      "not_found",
      "Route not found.",
    );
    const b = z
      .object({
        planId: z.string().max(64),
        email: z.email(),
        subscriptionId: z
          .string()
          .max(100)
          .default(`sub_local_${randomUUID()}`),
      })
      .strict()
      .parse(req.body);
    const plan = await db("plans")
      .where({ tenant_id: tenant.id, id: b.planId })
      .first();
    check(plan, 404, "not_found", "Plan not found.");
    const { Billing } = await import("./billing.ts");
    await new Billing(db, licensing, {
      snapshot: async () => ({
        subscriptionId: b.subscriptionId,
        customerId: `cus_local_${hash(b.email.toLowerCase())}`,
        email: b.email.toLowerCase(),
        billingStatus: "active",
        fullyRefunded: false,
        suspended: false,
        grants: [
          {
            id: `il_${b.subscriptionId}`,
            invoiceId: `in_${b.subscriptionId}`,
            priceId: plan.stripe_price_id,
            periodStart: Date.now() - 1000,
            periodEnd: Date.now() + 365 * 86400000,
            paidAt: Date.now(),
            settled: true,
          },
        ],
      }),
    }).reconcile(b.subscriptionId);
    return { ok: true, subscriptionId: b.subscriptionId };
  });
}
