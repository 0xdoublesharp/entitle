import { appPath } from "../packages/shared/app-path.ts";
import { handlerOwnsSocketTimeout } from "./http-timeout.ts";
import { ReadCache } from "./read-cache.ts";
import Fastify, { LogController, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import staticPlugin from "@fastify/static";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdir,
  stat,
  statfs,
  access,
  writeFile,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { join, relative, sep, isAbsolute } from "node:path";
import { z } from "zod";
import type { DB, Tenant } from "./db.ts";
import type { Config } from "./config.ts";
import { stripeConfigured } from "./config.ts";
import { Licenses } from "./licensing.ts";
import { Artifacts } from "./artifacts.ts";
import {
  VerifiedArtifactCache,
  hashArtifactFile,
  artifactTransferBudget,
} from "./artifact-streams.ts";
import { Transform } from "node:stream";
import {
  frameworkRoutes,
  type DownloadSender,
  type DownloadAdmission,
} from "./framework-api.ts";
import { Releases } from "./releases.ts";
import { Billing, type BillingEvent } from "./billing.ts";
import type { WorkerQueueOptions } from "./queue.ts";
import { StripeBilling } from "./stripe.ts";
import { Auth } from "./auth.ts";
import { Outbox, type Mailer } from "./email.ts";
import { AppError, check } from "./errors.ts";
import { PlatformAuth, PlatformOutbox } from "./platform-auth.ts";
import { Tenants, tenantAvailable } from "./tenants.ts";
import { PlatformBilling, type PlatformEvent } from "./platform-billing.ts";
import {
  S3ArtifactStore,
  MAX_ARTIFACT_BYTES,
  type ArtifactStore,
} from "./storage.ts";
import { buyerRoutes, apiLimit, type TenantServices } from "./tenant-api.ts";
import { sellerRoutes } from "./seller-api.ts";
import { operatorRoutes } from "./operator.ts";
import { recordDownload, recordStorageRead } from "./metrics.ts";
import { hash } from "./crypto.ts";
import { createHmac } from "node:crypto";
import { PublisherSandboxes, SandboxStripeBilling } from "./sandboxes.ts";
import { sandboxRoutes } from "./sandbox-api.ts";
import { operationsRoutes, notificationRoutes } from "./operations-api.ts";
import { Operations } from "./operations.ts";
import { BusinessEvents } from "./business-events.ts";
import { OutboundWebhooks } from "./outbound-webhooks.ts";
import { WebhookDeliveryPool } from "./webhook-delivery.ts";
import { billingWorkerResourceLimits } from "./worker-continuation.ts";
import { featureEntitlements, businessEventPolicy } from "./plan-features.ts";
import { commerceAdminRoutes } from "./commerce-admin.ts";
import {
  AccountManagement,
  CustomerAccounts,
  registerAccountRoutes,
  registerCustomerAccountRoutes,
} from "./account-management.ts";
import { frameworks } from "./frameworks.ts";
import { Portability } from "./portability.ts";
import { portabilityRoutes } from "./portability-api.ts";
import { site } from "./site.ts";
const empty = z.object({}).strict();
export interface AppOptions {
  store?: ArtifactStore;
  stripeFactory?: (tenant: Tenant) => StripeBilling;
  platformBilling?: PlatformBilling;
  billingWorker?: {
    budgetMs?: number;
    maxRequests?: number;
    maxOwnersPerTick?: number;
    maxFacts?: number;
    maxBytes?: number;
    maxApplyRecords?: number;
    maxApplyWork?: number;
    applyMs?: number;
  };
}
export async function buildApp(
  config: Config,
  db: DB,
  mailer?: Mailer,
  options: AppOptions = {},
) {
  const billingBudgetMs = options.billingWorker?.budgetMs ?? 5000;
  const billingMaxRequests = options.billingWorker?.maxRequests ?? 8;
  const billingMaxOwners = options.billingWorker?.maxOwnersPerTick ?? 4;
  const billingResources = billingWorkerResourceLimits({ ...config.billingWorker, ...options.billingWorker });
  check(
    Number.isSafeInteger(billingBudgetMs) && billingBudgetMs >= 1 && billingBudgetMs <= 60000 &&
      Number.isSafeInteger(billingMaxRequests) && billingMaxRequests >= 1 && billingMaxRequests <= 100 &&
      Number.isSafeInteger(billingMaxOwners) && billingMaxOwners >= 1 && billingMaxOwners <= 100,
    500, "worker_configuration", "Invalid billing worker budget.",
  );
  const billingShutdown = new AbortController();
  const hosted = config.deploymentMode === "hosted";
  const sandboxes = new PublisherSandboxes(db, config);
  if (!hosted) {
    const configured = await db<Tenant>("tenants");
    const primary = configured.find((t) => t.id === "primary");
    const sandbox = await sandboxes.describe("primary");
    if (
      !primary ||
      configured.some(
        (t) => t.id !== "primary" && t.id !== sandbox?.sandboxId,
      ) ||
      primary.stripe_account_id ||
      primary.platform_customer_id ||
      primary.platform_subscription_id
    )
      throw Error(
        "Standalone requires a primary-only database without connected-account or platform billing state. Keep existing SaaS databases in DEPLOYMENT_MODE=hosted.",
      );
  }
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            level: "info",
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers['x-account-verification']",
              "res.headers.set-cookie",
            ],
          },
    logController: new LogController({ disableRequestLogging: true }),
    genReqId: () => randomUUID(),
    bodyLimit: 1024 * 1024,
    requestTimeout: artifactTransferBudget(
      config.maxNativeUploadBytes ?? 100 * 1024 ** 2,
      config.nativeUploadTimeoutMs ?? 120000,
    ),
    connectionTimeout: 15000,
    trustProxy: config.trustProxy ?? false,
  });
  const nativeLimit = config.maxNativeUploadBytes ?? 100 * 1024 ** 2;
  const streamMemory = 128 * 1024;
  const nativeDiskLimit = config.nativeSpoolBytes ?? 4 * 1024 ** 3;
  const storageRelative = relative(config.staticDir, config.storage);
  check(
    storageRelative.startsWith(".." + sep) || isAbsolute(storageRelative),
    500,
    "storage_configuration",
    "Artifact work directory must be outside public static files.",
  );
  check(
    Number.isSafeInteger(nativeDiskLimit) &&
      nativeDiskLimit >= 2 * nativeLimit &&
      nativeDiskLimit <= 64 * 1024 ** 3,
    500,
    "storage_configuration",
    "Native spool budget must cover two artifact copies.",
  );
  await mkdir(config.storage, { recursive: true, mode: 0o700 });
  let inFlightDiskBytes = 0;
  let inFlightReadDiskBytes = 0;
  const diskAllocations = new WeakMap<FastifyRequest, number>();
  const activeNativeUploads = new WeakSet<FastifyRequest>();
  const releaseDisk = (req: FastifyRequest) => {
    const amount = diskAllocations.get(req);
    if (amount !== undefined) {
      inFlightDiskBytes -= amount;
      diskAllocations.delete(req);
    }
  };
  const requireFreeDisk = async (amount: number) => {
    const space = await statfs(config.storage, { bigint: true });
    check(
      space.bavail * space.bsize >=
        BigInt(amount) + BigInt(config.minDiskFreeBytes ?? 64 * 1024 ** 2),
      503,
      "disk_capacity",
      "Artifact disk capacity is busy. Retry shortly.",
    );
  };
  const backend =
    options.store ??
    new S3ArtifactStore({
      ...config.s3!,
      maxBytes: config.maxUploadBytes ?? 25 * 1024 ** 2,
      maxNativeBytes: nativeLimit,
    });
  const nativeCache = new VerifiedArtifactCache({
    directory: join(config.storage, "verified-native-cache"),
    maxBytes: config.artifactCacheBytes ?? 4 * 1024 ** 3,
    maxInflightBytes: config.artifactCacheInflightBytes ?? 2 * 1024 ** 3,
    ttlMs: config.artifactCacheTtlMs ?? 300000,
    timeoutMs: config.artifactTransferTimeoutMs ?? 120000,
  });
  app.addHook("onClose", () => nativeCache.close());
  const storageRead = async (tenantId: string, id: string, size: number) => {
    // Publication readbacks use a new object ID and must not create metric rows
    // until a committed release/asset owns that object.
    try {
      const asset = await db("release_assets")
        .where({ tenant_id: tenantId, id })
        .first("release_id");
      const releaseId =
        asset?.release_id ??
        (await db("releases").where({ tenant_id: tenantId, id }).first("id"))
          ?.id;
      if (releaseId) await recordStorageRead(db, tenantId, releaseId, size);
    } catch {
      app.log.warn(
        { code: "storage_metric_failed" },
        "Storage metric could not be recorded",
      );
    }
  };
  const store: ArtifactStore = {
    put: (...args) => backend.put(...args),
    delete: (...args) => backend.delete(...args),
    ready: () => backend.ready(),
    ...(backend.putFile
      ? {
          putFile: (
            ...args: Parameters<NonNullable<ArtifactStore["putFile"]>>
          ) => backend.putFile!(...args),
        }
      : {}),
    async get(tenantId, id, checksum, size) {
      const bytes = await backend.get(tenantId, id, checksum, size);
      check(
        bytes.length === size &&
          createHash("sha256").update(bytes).digest("hex") === checksum,
        503,
        "artifact_integrity",
        "Stored artifact failed integrity verification.",
      );
      await storageRead(tenantId, id, size);
      return bytes;
    },
    async getToFile(
      tenantId,
      id,
      checksum,
      size,
      destination,
      signal,
      onProgress,
    ) {
      // Reserve before the first await: other cold reads and publications must
      // account for this file even while no bytes have reached the filesystem.
      inFlightReadDiskBytes += size;
      try {
        await requireFreeDisk(inFlightDiskBytes + inFlightReadDiskBytes);
        if (backend.getToFile)
          await backend.getToFile(
            tenantId,
            id,
            checksum,
            size,
            destination,
            signal,
            onProgress,
          );
        else {
          // Legacy test/custom stores return Buffers. Account their temporary RAM
          // separately rather than treating a buffered adapter as native streaming.
          check(
            size <= MAX_ARTIFACT_BYTES,
            503,
            "streaming_storage_required",
            "Streaming storage is required for this artifact.",
          );
          const extra = Math.max(0, 2 * size - streamMemory);
          check(
            inFlightBytes + extra <=
              (config.transferMemoryBytes ?? 256 * 1024 ** 2),
            503,
            "transfer_capacity",
            "Transfer capacity is busy. Retry shortly.",
          );
          inFlightBytes += extra;
          try {
            const bytes = await backend.get(tenantId, id, checksum, size);
            check(
              bytes.length === size,
              503,
              "artifact_integrity",
              "Stored artifact length mismatch.",
            );
            await writeFile(destination, bytes, {
              flag: "wx",
              mode: 0o600,
              signal,
            });
            onProgress?.(bytes.length);
          } finally {
            inFlightBytes -= extra;
          }
        }
        check(
          (await hashArtifactFile(destination, size, onProgress, signal))
            .checksum === checksum,
          503,
          "artifact_integrity",
          "Stored artifact failed integrity verification.",
        );
        await storageRead(tenantId, id, size);
      } finally {
        inFlightReadDiskBytes -= size;
      }
    },
  };
  const reads = new ReadCache({
    namespace: `${config.cacheNamespace ?? "entitle"}:${createHmac(
      "sha256",
      config.secret,
    )
      .update(config.origin + "\0" + config.databaseUrl)
      .digest("hex")
      .slice(0, 20)}:`,
    ...(config.cacheRedisUrl ? { redisUrl: config.cacheRedisUrl } : {}),
    ...(config.cacheMemoryBytes
      ? { memoryBytes: config.cacheMemoryBytes }
      : {}),
  });
  app.addHook("onClose", () => reads.close());
  const platformAuth = new PlatformAuth(db, config),
    tenants = new Tenants(db, config),
    platform = options.platformBilling ?? new PlatformBilling(db, config);
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    requireTLS: config.production && !config.smtpSecure,
    ...(config.smtpUser
      ? { auth: { user: config.smtpUser, pass: config.smtpPass } }
      : {}),
    connectionTimeout: 10000,
    socketTimeout: 20000,
  });
  const delivery =
    mailer ??
    ({
      send: async (message) => {
        await transport.sendMail({ from: config.mailFrom, ...message });
      },
    } satisfies Mailer);
  const platformOutbox = new PlatformOutbox(
    db,
    config.secret,
    delivery,
    config.platformDailyEmailLimit,
  );
  const accounts = new AccountManagement(db, platformAuth);
  const portability = new Portability({
    db,
    store,
    secret: config.secret,
    directory: join(config.storage, "tenant-exports"),
    maxExports: config.exportMaxExports ?? 4,
    maxBytes: config.exportMaxBytes ?? 10 * 1024 ** 3,
    onFailure: ({ operation, code }) =>
      app.log.error({ operation, code }, "Export cleanup will retry."),
    ...(!hosted && config.standaloneStripeAccountId
      ? { sourceStripeAccountId: config.standaloneStripeAccountId }
      : {}),
  });
  app.addHook("onClose", () => portability.close());
  const make = (
    tenant: Tenant,
    tenantConfig = config,
    sandbox = false,
  ): TenantServices => {
    const licensing = new Licenses(
        db,
        config.secret,
        config.exemptSuffixes,
        tenant,
      ),
      stripe =
        options.stripeFactory?.(tenant) ??
        (sandbox
          ? new SandboxStripeBilling(db, tenantConfig, tenant)
          : new StripeBilling(db, tenantConfig, tenant));
    return {
      db,
      config: tenantConfig,
      tenant,
      licensing,
      stripe,
      releases: new Releases(
        db,
        store,
        tenant,
        config.storage,
        config.maxUploadBytes ?? 25 * 1024 * 1024,
        {
          deploymentMode: tenantConfig.deploymentMode,
          graceDays: tenantConfig.graceDays,
        },
      ),
      artifacts: new Artifacts(
        db,
        store,
        tenant,
        nativeLimit,
        undefined,
        nativeCache,
        {
          deploymentMode: tenantConfig.deploymentMode,
          graceDays: tenantConfig.graceDays,
        },
      ),
      reads,
      billing: new Billing(db, licensing, stripe, {
        stripeLiveMode: tenantConfig.stripeLiveMode === true,
        purchasePolicy: {
          deploymentMode: tenantConfig.deploymentMode,
          graceDays: tenantConfig.graceDays,
        },
        resolveCustomer: (event) => stripe.resolveCustomer(event),
      }),
      auth: new Auth(db, tenantConfig, tenant),
    };
  };
  const makeEnvironment = async (tenant: Tenant, reconciliation = false) => {
    const runtime = await sandboxes.runtime(tenant, { reconciliation });
    return make(runtime.tenant, runtime.config, !!runtime.parentId);
  };
  const contexts = new WeakMap<FastifyRequest, TenantServices>();
  const context = (req: FastifyRequest) => {
    const s = contexts.get(req);
    check(s, 500, "tenant_context", "Tenant context is unavailable.");
    return s;
  };
  const downloadReceipts = new WeakMap<
    FastifyRequest,
    {
      tenantId: string;
      releaseId: string;
      bytes: () => number;
      finished: boolean;
    }
  >();
  const metricWrites = new Set<Promise<void>>();
  app.addHook("onClose", async () => {
    await Promise.allSettled(metricWrites);
  });
  const allocations = new WeakMap<FastifyRequest, number>();
  let inFlightBytes = 0;
  const reserve = (req: FastifyRequest, bytes: number) => {
    check(
      Number.isSafeInteger(bytes) &&
        bytes > 0 &&
        inFlightBytes + bytes <=
          (config.transferMemoryBytes ?? 256 * 1024 * 1024),
      503,
      "transfer_capacity",
      "Transfer capacity is busy. Retry shortly.",
    );
    allocations.set(req, (allocations.get(req) ?? 0) + bytes);
    inFlightBytes += bytes;
  };
  const release = (req: FastifyRequest) => {
    const bytes = allocations.get(req);
    if (bytes) {
      inFlightBytes -= bytes;
      allocations.delete(req);
    }
  };
  const notificationCursors = new Map<string, string | null>();
  let ticking = false,
    closing = false,
    tenantCursor = 0;
  let lastBillingOwner: string | undefined;
  let billingWindowDeadline = 0,
    billingWindowTurns = 0,
    billingBusy = false;
  let billingIdle: Promise<boolean> | undefined;
  let tickIdle: Promise<void> | undefined;
  let markTickIdle!: () => void;
  const deliveryPool = new WebhookDeliveryPool((tenantId) =>
    app.log.error(
      { tenantId, code: "webhook_worker_failed" },
      "Webhook work will retry later",
    ),
  );
  app.addHook("preClose", async () => {
    closing = true;
    billingShutdown.abort();
  });
  app.addHook("onClose", async () => {
    await Promise.allSettled([tickIdle, billingIdle]);
    await deliveryPool.close();
  });
  const workerPublishers = () => db<Tenant>("tenants")
    .orderBy("id")
    .modify((q) => {
      if (!hosted)
        q.where((owned) => owned.where({ id: "primary" }).orWhereIn(
            "id",
            db("publisher_sandboxes").select("sandbox_tenant_id")
              .where({ parent_tenant_id: "primary" }),
          ));
    });
  const readyBillingWork = (table: "work" | "platform_work") => db(table)
    .whereIn("state", ["pending", "running"])
    .andWhere("available_at", "<=", Date.now())
    .andWhere("lease_until", "<", Date.now());
  const billingTurn = async (requestedTenant?: string, deadline = Infinity): Promise<boolean> => {
    if (billingBusy || closing || performance.now() >= deadline) return false;
    // Admission is synchronous. Manual requests do not create another provider
    // lane or wait in an unbounded in-memory queue behind the scheduled worker.
    billingBusy = true;
    const work = (async () => {
      const now = performance.now();
      if (now >= billingWindowDeadline) {
        billingWindowDeadline = now + billingBudgetMs;
        billingWindowTurns = 0;
      }
      if (billingWindowTurns >= billingMaxOwners) return false;
      const turnDeadline = Math.min(deadline, billingWindowDeadline);
      const publishers = await workerPublishers().whereExists(
        readyBillingWork("work")
          .whereRaw("?? = ??", ["work.tenant_id", "tenants.id"]).select(db.raw("1")),
      );
      const owners: { key: string; tenant: Tenant | null }[] = [];
      if (hosted && (config.localBilling || stripeConfigured(config)) &&
          await readyBillingWork("platform_work").first("id"))
        owners.push({ key: "platform", tenant: null });
      for (const tenant of publishers) owners.push({ key: `tenant:${tenant.id}`, tenant });
      const owner = owners.find((entry) => lastBillingOwner === undefined || entry.key > lastBillingOwner) ?? owners[0];
      if (!owner || (requestedTenant !== undefined && owner.tenant?.id !== requestedTenant) ||
          closing || performance.now() >= turnDeadline) return false;
      let attempted = false;
      try {
        const s = owner.tenant === null ? undefined : await makeEnvironment(owner.tenant, true);
        const remaining = Math.floor(turnDeadline - performance.now());
        if (closing || remaining < 1) return false;
        lastBillingOwner = owner.key;
        billingWindowTurns++;
        attempted = true;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remaining);
        timer.unref();
        const worker: WorkerQueueOptions = {
          ...billingResources,
          signal: AbortSignal.any([billingShutdown.signal, controller.signal]),
          budgetMs: remaining,
          maxRequests: billingMaxRequests,
          onBeginApply: () => {
            // Local apply has its own finite deadline and aggregate ceilings.
            // Shutdown and lease cancellation remain armed throughout.
            if (performance.now() >= turnDeadline) controller.abort();
            clearTimeout(timer);
          },
          onResourceLimit: (details) => app.log.error(
            { code: "billing_resource_limit", tenantId: owner.tenant?.id, ...details },
            "Billing work requires operator resource-limit recovery",
          ),
        };
        try {
          if (owner.tenant === null) await platform.run(worker);
          else if (s && (s.config.localBilling || stripeConfigured(s.config)))
            await s.billing.run((event) => s.stripe.resolveSubscription(event), worker);
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        // An invalid owner's setup must not pin every later owner behind it.
        if (!attempted) {
          lastBillingOwner = owner.key;
          billingWindowTurns++;
        }
        app.log.error(
          { tenantId: owner.tenant?.id, code: "billing_worker_failed" },
          "Billing work will retry on a later turn",
        );
        if (requestedTenant !== undefined) throw error;
      }
      return true;
    })();
    billingIdle = work;
    try {
      return await work;
    } finally {
      billingIdle = undefined;
      billingBusy = false;
    }
  };
  const tenantTick = async (tenant: Tenant, runBilling = true) => {
    if (runBilling) {
      check(config.serverRole !== "api", 409, "jobs_disabled", "Job execution is disabled for the API server role.");
      await billingTurn(tenant.id);
    }
    if (closing) return;
    const s = await makeEnvironment(tenant, true);
    const operations = new Operations(db, tenant.id);
    let cursor = notificationCursors.get(tenant.id) ?? null;
    for (let page = 0; page < 5; page++) {
      const scanned = await operations.scanNotifications(
        Date.now(),
        cursor,
        100,
      );
      cursor = scanned.cursor;
      if (!cursor) break;
    }
    notificationCursors.set(tenant.id, cursor);
    await operations.enqueueLifecycleEmails(config.secret);
    const alerts = await operations.alerts();
    for (const alert of alerts)
      app.log.warn(
        { tenantId: tenant.id, code: "operation_alert", kind: alert.kind },
        "Publisher operational alert",
      );
    const outbound = new OutboundWebhooks(
      db,
      tenant.id,
      config.secret,
      config.outboundWebhookHosts?.length
        ? { allowHosts: config.outboundWebhookHosts }
        : {},
    );
    const policy = businessEventPolicy(s.config, s.tenant);
    const outboundEnabled = policy.enabled;
    await new BusinessEvents(db, tenant.id, outbound).dispatch(
      policy.enabled,
      100,
      policy.enabledSince,
      policy.pendingGrace,
    );
    await new Outbox(
      db,
      config.secret,
      delivery,
      tenant,
      config.dailyEmailLimit,
    ).run();
    await s.releases.cleanup();
    if (outboundEnabled)
      deliveryPool.start(tenant.id, async () => {
        // Refresh policy after core work. A queued background job grants no
        // entitlement and cannot keep delivery enabled after Pro is removed.
        const current = (await db<Tenant>("tenants")
          .where({ id: tenant.id })
          .first())!;
        const runtime = await sandboxes.runtime(current);
        if (
          !featureEntitlements(runtime.config, runtime.tenant).outboundWebhooks
        )
          return;
        await operations.forwardAlerts(outbound);
        await outbound.run(5, 5000);
      });
  };
  const tick = async () => {
    if (config.serverRole === "api" || ticking || closing) return;
    ticking = true;
    tickIdle = new Promise<void>((resolve) => {
      markTickIdle = resolve;
    });
    try {
      await platformOutbox.run();
      const publishers = await workerPublishers();
      // Every caller shares the owner cursor, admission lane and budget window.
      // A scheduled tick also stops at its own deadline if the window rolls over.
      const billingDeadline = performance.now() + billingBudgetMs;
      for (let attempted = 0; attempted < billingMaxOwners; attempted++)
        if (!(await billingTurn(undefined, billingDeadline))) break;
      const start = publishers.length ? tenantCursor % publishers.length : 0;
      tenantCursor = publishers.length ? (start + 4) % publishers.length : 0;
      for (const tenant of [
        ...publishers.slice(start),
        ...publishers.slice(0, start),
      ]) {
        try {
          await tenantTick(tenant, false);
        } catch {
          app.log.error(
            { tenantId: tenant.id, code: "tenant_worker_failed" },
            "Tenant work will retry on the next scheduled run",
          );
        }
      }
      // OAuth state references seller sessions, so remove expired states first.
      await db("oauth_states").where("expires_at", "<", Date.now()).delete();
      for (const table of [
        "sessions",
        "login_tokens",
        "seller_sessions",
        "seller_login_tokens",
      ])
        await db(table)
          .where("expires_at", "<", Date.now() - 86400000)
          .delete();
      await db("seller_users")
        .whereNull("verified_at")
        .andWhere("created_at", "<", Date.now() - 7 * 86400000)
        .whereNotIn("id", db("seller_login_tokens").select("user_id"))
        .delete();
      try {
        await portability.cleanupExpired();
      } catch {
        app.log.error(
          { code: "export_cleanup_failed" },
          "Export housekeeping will retry.",
        );
      }
    } finally {
      ticking = false;
      markTickIdle();
    }
  };
  app.decorate("tick", tick);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://js.stripe.com",
          "https://*.js.stripe.com",
        ],
        styleSrc: ["'self'"],
        connectSrc: [
          "'self'",
          "https://api.stripe.com",
          "https://checkout.stripe.com",
          "https://link.com",
          "https://*.link.com",
        ],
        frameSrc: [
          "https://js.stripe.com",
          "https://*.js.stripe.com",
          "https://hooks.stripe.com",
          "https://checkout.stripe.com",
          "https://link.com",
          "https://*.link.com",
        ],
        imgSrc: [
          "'self'",
          "data:",
          "https://*.stripe.com",
          "https://*.link.com",
        ],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.production ? [] : null,
      },
    },
    referrerPolicy: { policy: "no-referrer" },
  });
  const credentialRoutes = new Set([
    "/api/v1/tenants/:tenant/activation",
    "/api/v1/tenants/:tenant/deactivate",
    "/api/v1/tenants/:tenant/updates/:product",
    "/api/v1/tenants/:tenant/packages/:id",
    "/api/v1/tenants/:tenant/updates/joomla/:product.xml",
    "/api/v1/tenants/:tenant/updates/electron/:product/:target/:filename",
    "/api/v1/tenants/:tenant/updates/tauri/:product/:target/:currentVersion",
    "/api/v1/tenants/:tenant/updates/sparkle/:product/:target/appcast.xml",
    "/api/v1/tenants/:tenant/updates/jetbrains/:product/updatePlugins.xml",
    "/api/v1/tenants/:tenant/updates/generic/:product/:target",
    "/api/v1/tenants/:tenant/packages/:product/assets/:assetId/:filename",
  ]);
  const credentialRouteKey = (method: string, template: string) => JSON.stringify([method.toUpperCase(), template]);
  const activationAdmissions = new Map<string, ReturnType<typeof app.createRateLimit>>();
  // Route-specific keys are selected before the rate-limit plugin builds its hooks.
  app.addHook("onRoute", (route) => {
    if (!credentialRoutes.has(route.url)) return;
    const policy = route.config?.rateLimit;
    if (route.url === "/api/v1/tenants/:tenant/activation" && policy && typeof policy === "object") {
      const template = route.url;
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        const key = credentialRouteKey(method, template);
        activationAdmissions.set(key, app.createRateLimit({
          ...(policy.max === undefined ? {} : { max: policy.max }),
          ...(policy.timeWindow === undefined ? {} : { timeWindow: policy.timeWindow }),
          keyGenerator: (req) => JSON.stringify([rateLimit.normalizeIP(req.ip), key]),
        }));
      }
    }
    route.config = {
      ...route.config,
      rateLimit: {
        ...route.config?.rateLimit,
        keyGenerator: async (req) => {
          const ip = rateLimit.normalizeIP(req.ip);
          const authorization = req.headers.authorization;
          if (!authorization?.startsWith("Bearer ")) return ip;
          try {
            await context(req).licensing.resolve(authorization.slice(7));
            return `${ip}:activation:${hash(authorization)}`;
          } catch (error) {
            if (
              error instanceof AppError &&
              error.status === 401 &&
              error.code === "invalid_activation"
            )
              return ip;
            throw error;
          }
        },
      },
    };
  });
  // Native handlers own idle and size-scaled total deadlines so they can return
  // a structured error before closing the request. Other bodies retain 30 seconds.
  app.addHook("preParsing", async (req, reply, payload) => {
    if (
      ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
      req.routeOptions.url?.endsWith("/assets/:product/:version")
    )
      return payload;
    const timer = setTimeout(
      () =>
        payload.destroy(
          new AppError(408, "upload_timeout", "Request body upload timed out."),
        ),
      30000,
    );
    const clear = () => clearTimeout(timer);
    payload.once("end", clear);
    payload.once("close", clear);
    reply.raw.once("close", clear);
    return payload;
  });
  // Public and seller routes retain the plugin's normalized IP key, including IPv6 /64s.
  await app.register(rateLimit, { max: 1000, timeWindow: "1 minute" });
  // Status uses its registered route ceiling before credential resolution.
  // Other token routes retain a wider aggregate ceiling so installations sharing
  // an IP can use their independent feed and download budgets.
  // This root hook runs before the route limiter's database-backed key generator.
  const credentialAdmission = app.createRateLimit({
    max: 1000,
    timeWindow: "1 minute",
    keyGenerator: (req) => rateLimit.normalizeIP(req.ip),
  });
  app.addHook("onRequest", async (req, reply) => {
    const template = req.routeOptions.url ?? "";
    if (!credentialRoutes.has(template)) return;
    const admission = activationAdmissions.get(credentialRouteKey(req.method, template)) ?? credentialAdmission;
    const limit = await admission(req);
    if (!limit.isAllowed && limit.isExceeded) {
      reply.header("retry-after", limit.ttlInSeconds);
      throw new AppError(429, "rate_limited", "Too many requests. Please retry later.");
    }
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("x-request-id", req.id);
    if (req.url.startsWith("/api/")) reply.header("cache-control", "no-store");
  });
  app.addHook("onResponse", async (req, reply) => {
    req.log.info(
      {
        requestId: req.id,
        method: req.method,
        route: req.routeOptions.url ?? "unmatched",
        status: reply.statusCode,
      },
      "request",
    );
  });
  app.setErrorHandler((error, req, reply) => {
    const status =
      error instanceof AppError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : typeof (error as { statusCode?: number }).statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : 500;
    const code =
      error instanceof AppError
        ? error.code
        : status === 400
          ? "invalid_request"
          : status === 429
            ? "rate_limited"
            : "internal_error";
    const message =
      error instanceof AppError
        ? error.message
        : status === 400
          ? "Invalid request."
          : status === 429
            ? "Too many requests. Please retry later."
            : "The request could not be completed.";
    if (status >= 500)
      req.log.error({ requestId: req.id, code }, "request failed");
    void reply
      .code(status)
      .send({ error: { code, message, requestId: req.id } });
  });

  app.addHook("onError", async (req, _reply, _error) => {
    release(req);
    if (!activeNativeUploads.has(req)) releaseDisk(req);
  });
  app.addHook("onResponse", async (req, reply) => {
    release(req);
    if (!activeNativeUploads.has(req)) releaseDisk(req);
    const receipt = downloadReceipts.get(req);
    if (
      receipt &&
      receipt.finished &&
      !req.raw.aborted &&
      (reply.statusCode === 200 || reply.statusCode === 206)
    ) {
      const write = recordDownload(
        db,
        receipt.tenantId,
        receipt.releaseId,
        Date.now(),
        receipt.bytes(),
      ).catch(() => {
        req.log.warn(
          { code: "download_metric_failed" },
          "Download metric could not be recorded",
        );
      });
      metricWrites.add(write);
      try {
        await write;
      } finally {
        metricWrites.delete(write);
      }
    }
  });
  await mkdir(config.storage, { recursive: true, mode: 0o700 });
  app.get("/api/v1/health", async () => ({ ok: true }));
  app.get("/api/v1/ready", async () => {
    await db.raw("select 1");
    await store.ready();
    await access(config.storage, constants.R_OK | constants.W_OK);
    const probe = join(config.storage, `.ready-${randomUUID()}`);
    try {
      await writeFile(probe, "", { flag: "wx", mode: 0o600 });
    } finally {
      await unlink(probe).catch(() => {});
    }
    return { ok: true };
  });
  await app.register(
    async (api) => {
      api.get("/info", async () => ({
        appBasePath: config.appBasePath ?? "",
        deploymentMode: config.deploymentMode,
        applicationFeePercent: config.hostedApplicationFeePercent,
        name: site.name,
        maxUploadBytes: config.maxUploadBytes ?? 25 * 1024 * 1024,
        maxNativeUploadBytes: nativeLimit,
        storage: "s3",
        databaseEngines: ["SQLite", "PostgreSQL", "MySQL"],
        frameworks,
        hostedProConfigured: !!config.platformProStripePriceId,
        features: [
          "Tenant-scoped licensing",
          "Seller-owned Stripe payments",
          "Private S3-compatible releases",
          "WordPress updates",
          "Customer self-service",
          "Measured seller metrics",
        ],
      }));
      await api.register(
        async (account) => registerAccountRoutes(account, { accounts }),
        { prefix: "/account" },
      );
      api.post("/auth/request", { config: apiLimit(5) }, async (req, reply) => {
        const { email } = z
          .object({ email: z.email().max(254) })
          .strict()
          .parse(req.body);
        await platformAuth.request(email, req, reply);
        return { ok: true };
      });
      api.post(
        "/auth/consume",
        { config: apiLimit(10) },
        async (req, reply) => {
          const { token } = z
            .object({ token: z.string().min(8).max(100) })
            .strict()
            .parse(req.body);
          await platformAuth.consume(token, req, reply);
          return { ok: true };
        },
      );
      api.get("/me", async (req) => {
        const seller = await platformAuth.seller(req, false);
        return {
          user: { id: seller.user.id, email: seller.user.email },
          csrfToken: seller.csrfToken,
          tenants: await tenants.list(seller.user.id),
        };
      });
      api.post("/auth/logout", async (req, reply) => {
        empty.parse(req.body);
        const seller = await platformAuth.seller(req, true);
        await db("seller_sessions").where({ id: seller.sessionHash }).delete();
        reply.clearCookie(platformAuth.cookieName, {
          path: "/",
          httpOnly: true,
          secure: config.production,
          sameSite: "lax",
        });
        return { ok: true };
      });
      api.post("/tenants", async (req) => {
        check(hosted, 404, "not_found", "Route not found.");
        const input = z
          .object({
            slug: z.string().min(1).max(63),
            name: z.string().min(1).max(200),
          })
          .strict()
          .parse(req.body);
        return {
          tenant: await tenants.create(
            await platformAuth.seller(req, true),
            input,
          ),
        };
      });
      const workspaceId = (req: FastifyRequest) =>
        z.object({ id: z.string().min(1).max(64) }).parse(req.params).id;
      for (const action of ["archive", "restore"] as const)
        api.post(`/tenants/:id/${action}`, async (req) => {
          empty.parse(req.body);
          return {
            tenant: await tenants.archive(
              await platformAuth.seller(req, true),
              workspaceId(req),
              action === "archive",
            ),
          };
        });
      api.get("/tenants/:id/removal", async (req) =>
        tenants.removal(
          await platformAuth.seller(req, false),
          workspaceId(req),
        ),
      );
      api.post("/tenants/:id/remove", async (req) => {
        const seller = await platformAuth.seller(req, true);
        const { slug } = z
          .object({ slug: z.string().min(1).max(63) })
          .strict()
          .parse(req.body);
        await accounts.requireStepUp(req, "workspace_remove");
        await tenants.remove(seller, workspaceId(req), slug);
        return { ok: true };
      });
      api.get("/stripe/callback", async (req, reply) => {
        check(hosted, 404, "not_found", "Route not found.");
        const q = z
          .object({
            code: z.string().min(1).max(500),
            state: z.string().min(8).max(100),
          })
          .parse(req.query);
        const result = await platform.callback(
          q.code,
          q.state,
          await platformAuth.seller(req, false),
        );
        return reply.redirect(
          appPath(
            `/seller?tenant=${encodeURIComponent(result.tenant.slug)}&connect=success`,
            config.appBasePath,
          ),
        );
      });
    },
    { prefix: "/api/v1/platform" },
  );
  await app.register(
    async (api) => {
      api.removeContentTypeParser("application/json");
      api.addContentTypeParser(
        "application/json",
        { parseAs: "buffer" },
        (_req, body, done) => done(null, body),
      );
      const eventFor = (req: FastifyRequest, secret: string, sandbox = false) => {
        check(sandbox ? !!config.stripeTestSecret && !!config.stripeTestWebhookSecret : stripeConfigured(config), 503, "billing_unavailable", "Stripe billing is not configured.");
        const signature = req.headers["stripe-signature"];
        check(
          typeof signature === "string" && Buffer.isBuffer(req.body),
          400,
          "invalid_signature",
          "A signed raw Stripe request is required.",
        );
        let event: unknown;
        try {
          event = (sandbox ? Stripe.webhooks : platform.stripe.webhooks).constructEvent(
            req.body,
            signature,
            secret,
          );
        } catch {
          throw new AppError(
            400,
            "invalid_signature",
            "Invalid Stripe signature.",
          );
        }
        return z
          .object({
            id: z.string().min(1).max(150),
            type: z.string().min(1).max(150),
            livemode: z.boolean(),
            account: z.string().min(1).max(150).optional(),
            data: z.object({ object: z.record(z.string(), z.unknown()) }),
          })
          .passthrough()
          .parse(event) as PlatformEvent;
      };
      api.post("/platform-webhook", { config: apiLimit(300) }, async (req) => {
        check(hosted, 404, "not_found", "Route not found.");
        const event = eventFor(req, config.stripeWebhookSecret);
        check(
          !event.account,
          400,
          "stripe_scope",
          "Platform endpoint does not accept connected account events.",
        );
        await platform.receive(event);
        return { ok: true };
      });
      api.post("/connect-webhook", { config: apiLimit(1000) }, async (req) => {
        check(hosted, 404, "not_found", "Route not found.");
        const event = eventFor(
          req,
          config.stripeConnectWebhookSecret ?? "whsec_connect_local",
        );
        check(
          event.account,
          400,
          "stripe_scope",
          "A connected account event is required.",
        );
        if (event.livemode !== (config.stripeLiveMode ?? false))
          return { ok: true, ignored: true };
        const tenant = await db<Tenant>("tenants")
          .where({ stripe_account_id: event.account })
          .first();
        if (!tenant) return { ok: true, ignored: true };
        if (
          ["account.application.deauthorized", "account.updated"].includes(
            event.type,
          )
        )
          await platform.accountEvent(event);
        else await make(tenant).billing.receive(event as BillingEvent);
        return { ok: true };
      });
      api.post("/sandbox-webhook", { config: apiLimit(300) }, async (req) => {
        check(
          config.stripeTestWebhookSecret,
          404,
          "not_found",
          "Stripe test webhooks are not configured.",
        );
        const event = eventFor(req, config.stripeTestWebhookSecret, true);
        check(
          !event.livemode,
          400,
          "stripe_mode",
          "Sandbox webhooks require Stripe test mode.",
        );
        check(
          hosted ? !!event.account : !event.account,
          400,
          "stripe_scope",
          "Incorrect sandbox Stripe account scope.",
        );
        const tenant = hosted
          ? await sandboxes.forStripeAccount(event.account!)
          : await db<Tenant>("tenants")
              .where({
                id: (await sandboxes.describe("primary"))?.sandboxId ?? "",
              })
              .first();
        if (!tenant) return { ok: true, ignored: true };
        const state = await sandboxes.describe(tenant.id);
        if (state?.mode !== "stripe") return { ok: true, ignored: true };
        await (
          await makeEnvironment(tenant, true)
        ).billing.receive(event as BillingEvent);
        return { ok: true };
      });
      api.post("/merchant-webhook", { config: apiLimit(1000) }, async (req) => {
        check(!hosted, 404, "not_found", "Route not found.");
        const event = eventFor(req, config.stripeWebhookSecret);
        check(
          !event.account,
          400,
          "stripe_scope",
          "Merchant endpoint does not accept connected account events.",
        );
        if (event.livemode !== config.stripeLiveMode)
          return { ok: true, ignored: true };
        const tenant = (await db<Tenant>("tenants")
          .where({ id: "primary" })
          .first())!;
        await make(tenant).billing.receive(event as BillingEvent);
        return { ok: true };
      });
    },
    { prefix: "/api/v1/stripe" },
  );
  await app.register(
    async (api) => {
      api.addHook("onRequest", async (req) => {
        const { tenant: slug } = z
          .object({ tenant: z.string().min(1).max(150) })
          .parse(req.params);
        const tenant = await db<Tenant>("tenants").where({ slug }).first();
        const environment = tenant
          ? await sandboxes.describe(tenant.id)
          : undefined;
        check(
          tenant &&
            (hosted ||
              tenant.id === "primary" ||
              environment?.parentId === "primary"),
          404,
          "not_found",
          "Tenant not found.",
        );
        contexts.set(req, await makeEnvironment(tenant));
        const route = req.routeOptions.url!;
        const seller = route.includes("/seller/");
        if (!seller)
          check(
            tenantAvailable(tenant, "buyer"),
            403,
            "tenant_suspended",
            "This publisher's service is suspended.",
          );
        if (hosted && route.endsWith("/checkout") && !seller)
          check(
            tenantAvailable(
              context(req).tenant,
              "capacity",
              (config.graceDays ?? 7) * 86400000,
            ),
            403,
            "tenant_capacity",
            "New purchases are unavailable for this publisher.",
          );
      });
      // Every onRequest hook, including seller authorization and route limiting,
      // finishes before a ZIP is admitted to the shared in-flight memory budget.
      api.addHook("preParsing", async (req, reply, payload) => {
        if (req.routeOptions.url!.endsWith("/assets/:product/:version")) {
          const header = req.headers["content-length"];
          check(
            header !== undefined,
            411,
            "length_required",
            "Native uploads require Content-Length.",
          );
          const length = Number(header);
          check(
            typeof header === "string" &&
              /^[1-9][0-9]*$/.test(header) &&
              Number.isSafeInteger(length) &&
              length <= nativeLimit,
            413,
            "upload_limit",
            "Artifact exceeds the native upload limit or has an invalid Content-Length.",
          );
          const disk = 2 * length;
          check(
            inFlightDiskBytes + disk <= nativeDiskLimit,
            503,
            "disk_capacity",
            "Artifact disk capacity is busy. Retry shortly.",
          );
          inFlightDiskBytes += disk;
          diskAllocations.set(req, disk);
          reply.raw.once("close", () => {
            if (!activeNativeUploads.has(req)) releaseDisk(req);
          });
          await requireFreeDisk(inFlightDiskBytes + inFlightReadDiskBytes);
          reserve(
            req,
            backend.putFile && backend.getToFile
              ? streamMemory
              : Math.max(streamMemory, 6 * length),
          );
          reply.raw.once("close", () => release(req));
          handlerOwnsSocketTimeout(req, reply, app.server.timeout);
        } else if (
          req.routeOptions.url!.endsWith("/releases/:product/:version")
        ) {
          const length = Number(
            req.headers["content-length"] ??
              config.maxUploadBytes ??
              25 * 1024 ** 2,
          );
          check(
            Number.isSafeInteger(length) &&
              length > 0 &&
              length <= (config.maxUploadBytes ?? 25 * 1024 ** 2),
            413,
            "upload_limit",
            "Release ZIP exceeds the upload limit.",
          );
          reserve(req, 6 * length);
          reply.raw.once("close", () => release(req));
        }
        return payload;
      });
      const sendDownload: DownloadSender = (
        req,
        reply,
        releaseId,
        body,
        receipt,
      ) => {
        let sent = 0;
        if (Buffer.isBuffer(body)) sent = body.length;
        else {
          const source = body;
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              sent += chunk.length;
              if (sent > receipt!.size) {
                done(
                  new AppError(
                    503,
                    "artifact_integrity",
                    "Artifact stream exceeded its verified length.",
                  ),
                );
                return;
              }
              done(null, chunk);
            },
          });
          source.once("error", (error) => counter.destroy(error));
          counter.once("close", () => source.destroy());
          reply.raw.once("close", () => counter.destroy());
          body = source.pipe(counter);
        }
        const recorded = {
          tenantId: context(req).tenant.id,
          releaseId,
          bytes: () => sent,
          finished: false,
        };
        downloadReceipts.set(req, recorded);
        reply.raw.prependOnceListener("finish", () => {
          recorded.finished = true;
        });
        return reply.send(body);
      };
      const reserveDownload: DownloadAdmission = (
        req,
        reply,
        size,
        receipt,
      ) => {
        reserve(req, receipt?.streaming ? streamMemory : 2 * size);
        if (receipt?.streaming)
          handlerOwnsSocketTimeout(req, reply, app.server.timeout);
        reply.raw.once("close", () => release(req));
      };
      for (const register of [buyerRoutes, frameworkRoutes])
        await register(api, context, sendDownload, reserveDownload);
      await notificationRoutes(api, context);
      await registerCustomerAccountRoutes(api, {
        context: (req) => {
          const s = context(req);
          return new CustomerAccounts(s.db, s.auth);
        },
      });
      await api.register(
        async (seller) => {
          await sellerRoutes(
            seller,
            context,
            platformAuth,
            tenants,
            platform,
            tenantTick,
            config.maxUploadBytes ?? 25 * 1024 * 1024,
            nativeLimit,
            {
              begin: (req) => {
                activeNativeUploads.add(req);
              },
              end: (req) => {
                activeNativeUploads.delete(req);
                releaseDisk(req);
              },
            },
          );
          await commerceAdminRoutes(seller, context, platformAuth);
          await sandboxRoutes(seller, context, platformAuth, sandboxes);
          await operationsRoutes(seller, context, platformAuth);
        },
        { prefix: "/seller" },
      );
      await api.register(
        async (transfer) => {
          await portabilityRoutes(transfer, {
            context: (req) => ({ tenant: context(req).tenant, portability }),
            auth: platformAuth,
            accounts,
          });
        },
        { prefix: "/seller" },
      );
    },
    { prefix: "/api/v1/tenants/:tenant" },
  );
  await app.register(
    (operator) => operatorRoutes(operator, db, config, platform, tick),
    { prefix: "/api/v1/operator" },
  );
  if (
    await stat(join(config.staticDir, "index.html")).then(
      () => true,
      () => false,
    )
  ) {
    await app.register(staticPlugin, {
      root: config.staticDir,
      index: "index.html",
      wildcard: true,
    });
    for (const [route, file] of [
      ["/seller", "seller.html"],
      ["/seller/", "seller.html"],
      ["/t/:tenant", "customer.html"],
      ["/t/:tenant/", "customer.html"],
      ["/docs", "docs.html"],
      ["/docs/", "docs.html"],
    ] as const) {
      // The API may also serve a frontend release from before page-specific shells.
      const shell = await stat(join(config.staticDir, file)).then(
        () => file,
        () => "index.html",
      );
      app.get(route, (_req, reply) => reply.sendFile(shell));
    }
  }
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({
      error: {
        code: "not_found",
        message: "Route not found.",
        requestId: req.id,
      },
    }),
  );
  return app;
}
