import { resolve } from "node:path";
import { z } from "zod";
import { normalizeAppBasePath } from "../packages/shared/app-path.ts";
import type { WorkerResourceLimits } from "./queue.ts";
import { defaultOidcProviders, oidcProvidersSchema, type OidcProvider } from "./oidc-schema.ts";
export type ServerRole = "all" | "api" | "worker" | "migrate";
export type DeploymentSlot = "blue" | "green";

// Validate programmatic Config callers as well as environment configuration.
export function serverIdentity(config: {
  serverRole?: ServerRole;
  deploymentSlot?: DeploymentSlot;
}) {
  const role = config.serverRole ?? "all";
  if (!["all", "api", "worker", "migrate"].includes(role))
    throw Error("SERVER_ROLE must be all, api, worker or migrate");
  const slot = config.deploymentSlot;
  if (slot !== undefined && slot !== "blue" && slot !== "green")
    throw Error("DEPLOYMENT_SLOT must be blue or green");
  return { role, slot };
}

export const freeLicenseOffersSchema = z.array(z.object({
  tenant: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  product: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100),
  campaign: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  siteAllowance: z.number().int().min(1).max(100),
  expiresAt: z.iso.datetime().transform(value => Date.parse(value)).optional(),
  durationDays: z.number().int().min(1).max(365).optional(),
  origins: z.array(z.url().refine(value => {
    const url = new URL(value);
    return url.origin === value && url.protocol === "https:";
  }, "Use an exact HTTPS origin without a path or credentials.")).min(1).max(10),
  dailyLimit: z.number().int().min(1).max(1000).default(50),
}).strict().refine(offer => (offer.expiresAt !== undefined) !== (offer.durationDays !== undefined),
  "Choose either expiresAt or durationDays for an offer.")).max(100).refine(offers => new Set(offers.map(offer => `${offer.tenant}/${offer.product}`)).size === offers.length,
  "Only one free offer per tenant/product is allowed.");
export type FreeLicenseOffer = z.infer<typeof freeLicenseOffersSchema>[number];

export interface Config {
  oidcProviders?: OidcProvider[];
  billingWorker?: WorkerResourceLimits;
  freeLicenseOffers?: FreeLicenseOffer[];
  serverRole?: ServerRole;
  deploymentSlot?: DeploymentSlot;
  deploymentMode: "standalone" | "hosted";
  standaloneOwnerEmail: string;
  standaloneStripeAccountId?: string;
  hostedApplicationFeePercent: number;
  origin: string;
  appBasePath?: string;
  cacheRedisUrl?: string;
  cacheMemoryBytes?: number;
  cacheNamespace?: string;
  secret: string;
  operatorToken: string;
  storage: string;
  staticDir: string;
  production: boolean;
  exemptSuffixes: string[];
  stripeSecret: string;
  stripePublishableKey?: string;
  stripeWebhookSecret: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: boolean;
  mailFrom: string;
  port: number;
  databaseUrl: string;
  localBilling: boolean;
  maxUploadBytes?: number;
  maxNativeUploadBytes?: number;
  nativeSpoolBytes?: number;
  nativeUploadTimeoutMs?: number;
  artifactCacheBytes?: number;
  artifactCacheInflightBytes?: number;
  artifactCacheTtlMs?: number;
  artifactTransferTimeoutMs?: number;
  minDiskFreeBytes?: number;
  exportMaxExports?: number;
  exportMaxBytes?: number;
  transferMemoryBytes?: number;
  maxTenantsPerSeller?: number;
  trialStorageBytes?: number;
  paidMaxProducts?: number;
  paidStorageBytes?: number;
  dailyEmailLimit?: number;
  platformDailyEmailLimit?: number;
  maxSellerSignupsPerHour?: number;
  trustProxy?: string | false;
  trialDays?: number;
  graceDays?: number;
  stripeConnectClientId?: string;
  stripeConnectWebhookSecret?: string;
  stripeLiveMode?: boolean;
  platformPriceId?: string;
  platformProStripePriceId?: string;
  stripeTestSecret?: string;
  stripeTestPublishableKey?: string;
  stripeTestWebhookSecret?: string;
  outboundWebhookHosts?: string[];
  s3?: {
    bucket: string;
    region: string;
    endpoint?: string;
    credentials?: { accessKeyId: string; secretAccessKey: string };
    forcePathStyle: boolean;
    allowInsecureLocalDevelopment: boolean;
  };
}
export function stripeConfigured(
  config: Pick<Config, "stripeSecret" | "stripeWebhookSecret">,
) {
  return !!config.stripeSecret && !!config.stripeWebhookSecret;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const { role: serverRole, slot: deploymentSlot } = serverIdentity({
    ...(env.SERVER_ROLE === undefined
      ? {}
      : { serverRole: env.SERVER_ROLE as ServerRole }),
    ...(env.DEPLOYMENT_SLOT === undefined
      ? {}
      : { deploymentSlot: env.DEPLOYMENT_SLOT as DeploymentSlot }),
  });
  const standaloneStripeAccountId = env.STANDALONE_STRIPE_ACCOUNT_ID;
  if (
    standaloneStripeAccountId !== undefined &&
    !/^acct_[A-Za-z0-9]+$/.test(standaloneStripeAccountId)
  )
    throw Error(
      "STANDALONE_STRIPE_ACCOUNT_ID must be an operator-verified Stripe account ID",
    );
  const platformProStripePriceId = env.PLATFORM_PRO_STRIPE_PRICE_ID;
  if (
    platformProStripePriceId !== undefined &&
    (!/^price_[A-Za-z0-9_]+$/.test(platformProStripePriceId) ||
      platformProStripePriceId === env.PLATFORM_STRIPE_PRICE_ID)
  )
    throw Error("Configure a distinct hosted Pro Stripe price ID");
  const sandboxValues = [
    env.STRIPE_TEST_SECRET_KEY,
    env.STRIPE_TEST_PUBLISHABLE_KEY,
    env.STRIPE_TEST_WEBHOOK_SECRET,
  ];
  if (
    sandboxValues.some((v) => v !== undefined && v !== "") &&
    (!env.STRIPE_TEST_SECRET_KEY?.startsWith("sk_test_") ||
      !env.STRIPE_TEST_PUBLISHABLE_KEY?.startsWith("pk_test_") ||
      !env.STRIPE_TEST_WEBHOOK_SECRET?.startsWith("whsec_"))
  )
    throw Error("Sandbox Stripe credentials must be a complete test-mode set");
  const outboundWebhookHosts = env.OUTBOUND_WEBHOOK_HOSTS?.split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (
    outboundWebhookHosts?.some(
      (v) => !/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(v),
    )
  )
    throw Error("Outbound webhook hosts must be exact public DNS names");
  const deploymentMode = z
    .enum(["standalone", "hosted"])
    .parse(env.DEPLOYMENT_MODE ?? "standalone");
  const standaloneOwnerEmail = env.STANDALONE_OWNER_EMAIL
    ? z.email().max(254).parse(env.STANDALONE_OWNER_EMAIL).toLowerCase()
    : "";
  const fee =
    env.HOSTED_APPLICATION_FEE_PERCENT ??
    (deploymentMode === "hosted" ? "1" : "0");
  if (!/^(?:\d{1,3})(?:\.\d{1,2})?$/.test(fee) || Number(fee) > 100)
    throw Error(
      "HOSTED_APPLICATION_FEE_PERCENT must be 0-100 with at most two decimal places",
    );
  if (deploymentMode === "standalone" && Number(fee) !== 0)
    throw Error("Application fees are unavailable in standalone mode");
  const production = env.NODE_ENV === "production";
  const publicUrl = new URL(
    z.url().parse(env.PUBLIC_ORIGIN ?? "http://localhost:3211"),
  );
  if (
    !["http:", "https:"].includes(publicUrl.protocol) ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.pathname !== "/" ||
    publicUrl.search ||
    publicUrl.hash
  )
    throw Error(
      "PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment",
    );
  if (env.CACHE_REDIS_URL) {
    let redisUrl: URL;
    try {
      redisUrl = new URL(env.CACHE_REDIS_URL);
    } catch {
      throw Error("CACHE_REDIS_URL must be a redis:// or rediss:// URL");
    }
    if (
      !["redis:", "rediss:"].includes(redisUrl.protocol) ||
      !redisUrl.hostname ||
      redisUrl.search ||
      redisUrl.hash
    )
      throw Error(
        "CACHE_REDIS_URL must be a redis:// or rediss:// URL without query or fragment",
      );
  }
  const origin = publicUrl.origin;
  const appBasePath = normalizeAppBasePath(
    env.APP_BASE_PATH ?? (deploymentMode === "hosted" ? "/app" : ""),
  );
  const ports = z
    .object({
      PORT: z.coerce.number().int().min(0).max(65535).default(3211),
      SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    })
    .parse(env);
  const secret = z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .parse(env.APP_SECRET);
  const operatorToken = z
    .string()
    .min(32)
    .refine((value) => value !== "REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS", {
      message: "OPERATOR_TOKEN must replace the published placeholder with a random secret",
    })
    .parse(env.OPERATOR_TOKEN);
  if (
    env.STRIPE_PUBLISHABLE_KEY &&
    !/^pk_(?:test|live)_[A-Za-z0-9]+$/.test(env.STRIPE_PUBLISHABLE_KEY)
  )
    throw Error("STRIPE_PUBLISHABLE_KEY must be a Stripe publishable key");
  if (
    env.STRIPE_PUBLISHABLE_KEY &&
    env.STRIPE_PUBLISHABLE_KEY.startsWith("pk_live_") !==
      (env.STRIPE_LIVE_MODE === "true")
  )
    throw Error("Stripe publishable key must match STRIPE_LIVE_MODE");
  const secretMode = /^(?:sk|rk)_(live|test)_/.exec(
    env.STRIPE_SECRET_KEY ?? "",
  );
  if (
    secretMode &&
    (secretMode[1] === "live") !== (env.STRIPE_LIVE_MODE === "true")
  )
    throw Error("Stripe secret key must match STRIPE_LIVE_MODE");
  if (["true", "0.0.0.0/0", "::/0"].includes(env.TRUST_PROXY ?? ""))
    throw Error("TRUST_PROXY must identify a specific trusted proxy or subnet");
  if (production && !origin.startsWith("https://"))
    throw Error("PUBLIC_ORIGIN must be HTTPS in production");
  const localBilling = env.LOCAL_BILLING === "true";
  if (production && localBilling)
    throw Error("LOCAL_BILLING is forbidden in production");
  const stripeEnabled = [
    env.STRIPE_SECRET_KEY,
    env.STRIPE_WEBHOOK_SECRET,
    env.STRIPE_PUBLISHABLE_KEY,
    env.STRIPE_CONNECT_CLIENT_ID,
    env.STRIPE_CONNECT_WEBHOOK_SECRET,
    env.PLATFORM_STRIPE_PRICE_ID,
    env.PLATFORM_PRO_STRIPE_PRICE_ID,
  ].some(Boolean);
  if (
    production &&
    (!env.SMTP_HOST ||
      (stripeEnabled && (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET)))
  )
    throw Error("Production requires Stripe and SMTP configuration");
  const data = env.DATA_DIR ?? "/Volumes/Scratch/entitle/data/local";
  const limits = z
    .object({
      BILLING_WORKER_MAX_FACTS: z.coerce.number().int().min(1).max(50000).default(10000),
      BILLING_WORKER_MAX_MIB: z.coerce.number().int().min(1).max(64).default(16),
      BILLING_WORKER_MAX_APPLY_RECORDS: z.coerce.number().int().min(1).max(20000).default(3000),
      BILLING_WORKER_MAX_APPLY_WORK: z.coerce.number().int().min(1).max(10000000).default(1000000),
      BILLING_WORKER_APPLY_MS: z.coerce.number().int().min(1).max(30000).default(5000),
      CACHE_MEMORY_MIB: z.coerce.number().int().min(1).max(256).default(8),
      CACHE_NAMESPACE: z
        .string()
        .regex(/^[a-zA-Z0-9:_-]{1,64}$/)
        .default("entitle"),
      MAX_NATIVE_UPLOAD_MIB: z.coerce
        .number()
        .int()
        .min(1)
        .max(2048)
        .default(100),
      NATIVE_SPOOL_MIB: z.coerce.number().int().min(2).max(65536).default(4096),
      NATIVE_UPLOAD_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .default(120000),
      ARTIFACT_CACHE_MIB: z.coerce
        .number()
        .int()
        .min(1)
        .max(65536)
        .default(4096),
      ARTIFACT_CACHE_INFLIGHT_MIB: z.coerce
        .number()
        .int()
        .min(1)
        .max(65536)
        .default(2048),
      ARTIFACT_CACHE_TTL_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(86400000)
        .default(300000),
      ARTIFACT_TRANSFER_TIMEOUT_MS: z.coerce
        .number()
        .int()
        .min(1000)
        .max(3600000)
        .default(120000),
      EXPORT_MAX_EXPORTS: z.coerce.number().int().min(2).max(10).default(4),
      EXPORT_MAX_GIB: z.coerce.number().int().min(1).max(10).default(10),
      MIN_DISK_FREE_MIB: z.coerce
        .number()
        .int()
        .min(0)
        .max(1048576)
        .default(64),
      MAX_UPLOAD_MIB: z.coerce.number().int().min(1).max(100).default(25),
      TRANSFER_MEMORY_MIB: z.coerce
        .number()
        .int()
        .min(6)
        .max(65536)
        .default(256),
      MAX_TENANTS_PER_SELLER: z.coerce
        .number()
        .int()
        .min(1)
        .max(100)
        .default(3),
      TRIAL_STORAGE_MIB: z.coerce
        .number()
        .int()
        .min(1)
        .max(102400)
        .default(100),
      PAID_MAX_PRODUCTS: z.coerce.number().int().min(1).max(10000).default(20),
      PAID_STORAGE_MIB: z.coerce
        .number()
        .int()
        .min(1)
        .max(1048576)
        .default(1024),
      DAILY_EMAIL_LIMIT: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000000)
        .default(1000),
      PLATFORM_DAILY_EMAIL_LIMIT: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000000)
        .default(1000),
      MAX_SELLER_SIGNUPS_PER_HOUR: z.coerce
        .number()
        .int()
        .min(1)
        .max(1000000)
        .default(500),
      TRIAL_DAYS: z.coerce.number().int().min(0).max(365).default(14),
      GRACE_DAYS: z.coerce.number().int().min(0).max(90).default(7),
    })
    .parse(env);
  if (limits.NATIVE_SPOOL_MIB < 2 * limits.MAX_NATIVE_UPLOAD_MIB)
    throw Error(
      "NATIVE_SPOOL_MIB must cover two copies of MAX_NATIVE_UPLOAD_MIB",
    );
  if (limits.ARTIFACT_CACHE_MIB < 2 * limits.MAX_NATIVE_UPLOAD_MIB)
    throw Error("ARTIFACT_CACHE_MIB must cover two native artifacts");
  if (
    limits.ARTIFACT_CACHE_INFLIGHT_MIB < limits.MAX_NATIVE_UPLOAD_MIB ||
    limits.ARTIFACT_CACHE_INFLIGHT_MIB > limits.ARTIFACT_CACHE_MIB
  )
    throw Error(
      "Artifact cache budgets must cover the native upload cap and fit within ARTIFACT_CACHE_MIB",
    );
  if (limits.TRANSFER_MEMORY_MIB < 6 * limits.MAX_UPLOAD_MIB)
    throw Error("TRANSFER_MEMORY_MIB must cover six times MAX_UPLOAD_MIB");
  if (production && (!env.S3_BUCKET || !env.S3_REGION))
    throw Error("Production requires private S3 storage configuration");
  if (
    production &&
    stripeEnabled &&
    deploymentMode === "hosted" &&
    (!env.STRIPE_CONNECT_CLIENT_ID ||
      !env.STRIPE_CONNECT_WEBHOOK_SECRET ||
      !env.PLATFORM_STRIPE_PRICE_ID ||
      !env.STRIPE_PUBLISHABLE_KEY)
  )
    throw Error(
      "Production requires Stripe Connect and platform subscription configuration",
    );
  if (production && deploymentMode === "standalone" && !standaloneOwnerEmail)
    throw Error("Production standalone requires STANDALONE_OWNER_EMAIL");
  if (
    production &&
    stripeEnabled &&
    deploymentMode === "standalone" &&
    !env.STRIPE_PUBLISHABLE_KEY
  )
    throw Error("Production standalone requires a Stripe publishable key");
  if (production && !env.TRUST_PROXY)
    throw Error("Production requires an explicit TRUST_PROXY");
  if (
    production &&
    (!env.MAIL_FROM ||
      !z.email().safeParse(env.MAIL_FROM).success ||
      env.MAIL_FROM.endsWith(".test"))
  )
    throw Error(
      "Production requires an explicit deliverable MAIL_FROM address",
    );
  if (!!env.S3_ACCESS_KEY_ID !== !!env.S3_SECRET_ACCESS_KEY)
    throw Error("Both S3 credential variables must be supplied together");
  const endpoint = env.S3_ENDPOINT;
  if (endpoint) {
    const url = new URL(endpoint);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          !production &&
          env.S3_ALLOW_HTTP === "true"
        ))
    )
      throw Error(
        "S3 endpoint must use HTTPS without credentials, query or fragment",
      );
  }
  return {
    oidcProviders: oidcProvidersSchema.parse(JSON.parse(env.OIDC_PROVIDERS ?? JSON.stringify(defaultOidcProviders))),
    freeLicenseOffers: freeLicenseOffersSchema.parse(JSON.parse(env.FREE_LICENSE_OFFERS ?? "[]")),
    serverRole,
    ...(deploymentSlot === undefined ? {} : { deploymentSlot }),
    ...(platformProStripePriceId ? { platformProStripePriceId } : {}),
    ...(env.STRIPE_TEST_SECRET_KEY
      ? {
          stripeTestSecret: env.STRIPE_TEST_SECRET_KEY,
          stripeTestPublishableKey: env.STRIPE_TEST_PUBLISHABLE_KEY!,
          stripeTestWebhookSecret: env.STRIPE_TEST_WEBHOOK_SECRET!,
        }
      : {}),
    ...(outboundWebhookHosts ? { outboundWebhookHosts } : {}),
    ...(standaloneStripeAccountId ? { standaloneStripeAccountId } : {}),
    deploymentMode,
    standaloneOwnerEmail,
    hostedApplicationFeePercent: Number(fee),
    origin,
    appBasePath,
    ...(env.CACHE_REDIS_URL
      ? {
          cacheRedisUrl: env.CACHE_REDIS_URL.replace(/^[^:]+/, (scheme) =>
            scheme.toLowerCase(),
          ),
        }
      : {}),
    cacheMemoryBytes: limits.CACHE_MEMORY_MIB * 1048576,
    cacheNamespace: limits.CACHE_NAMESPACE,
    secret,
    operatorToken,
    production,
    localBilling,
    databaseUrl: env.DATABASE_URL ?? `sqlite:${data}/entitle.sqlite`,
    storage: resolve(env.WORK_DIR ?? `${data}/work`),
    staticDir: resolve(
      env.WEB_DIR ??
        `${env.BUILD_DIR ?? "/Volumes/Scratch/entitle/build/main"}/web`,
    ),
    port: ports.PORT,
    stripeSecret: env.STRIPE_SECRET_KEY ?? (production ? "" : "sk_test_local"),
    stripePublishableKey: env.STRIPE_PUBLISHABLE_KEY ?? "",
    stripeWebhookSecret:
      env.STRIPE_WEBHOOK_SECRET ?? (production ? "" : "whsec_local"),
    exemptSuffixes: (env.DEVELOPMENT_HOST_SUFFIXES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    smtpHost: env.SMTP_HOST ?? "127.0.0.1",
    smtpPort: ports.SMTP_PORT,
    smtpUser: env.SMTP_USER ?? "",
    smtpPass: env.SMTP_PASS ?? "",
    smtpSecure: env.SMTP_SECURE === "true",
    mailFrom: env.MAIL_FROM ?? "licenses@example.test",
    maxNativeUploadBytes: limits.MAX_NATIVE_UPLOAD_MIB * 1048576,
    billingWorker: {
      maxFacts: limits.BILLING_WORKER_MAX_FACTS,
      maxBytes: limits.BILLING_WORKER_MAX_MIB * 1048576,
      maxApplyRecords: limits.BILLING_WORKER_MAX_APPLY_RECORDS,
      maxApplyWork: limits.BILLING_WORKER_MAX_APPLY_WORK,
      applyMs: limits.BILLING_WORKER_APPLY_MS,
    },
    nativeSpoolBytes: limits.NATIVE_SPOOL_MIB * 1048576,
    nativeUploadTimeoutMs: limits.NATIVE_UPLOAD_TIMEOUT_MS,
    artifactCacheBytes: limits.ARTIFACT_CACHE_MIB * 1048576,
    artifactCacheInflightBytes: limits.ARTIFACT_CACHE_INFLIGHT_MIB * 1048576,
    artifactCacheTtlMs: limits.ARTIFACT_CACHE_TTL_MS,
    artifactTransferTimeoutMs: limits.ARTIFACT_TRANSFER_TIMEOUT_MS,
    minDiskFreeBytes: limits.MIN_DISK_FREE_MIB * 1048576,
    exportMaxExports: limits.EXPORT_MAX_EXPORTS,
    exportMaxBytes: limits.EXPORT_MAX_GIB * 1024 ** 3,
    maxUploadBytes: limits.MAX_UPLOAD_MIB * 1024 * 1024,
    transferMemoryBytes: limits.TRANSFER_MEMORY_MIB * 1024 * 1024,
    maxTenantsPerSeller: limits.MAX_TENANTS_PER_SELLER,
    trialStorageBytes: limits.TRIAL_STORAGE_MIB * 1024 * 1024,
    paidMaxProducts: limits.PAID_MAX_PRODUCTS,
    paidStorageBytes: limits.PAID_STORAGE_MIB * 1024 * 1024,
    dailyEmailLimit: limits.DAILY_EMAIL_LIMIT,
    platformDailyEmailLimit: limits.PLATFORM_DAILY_EMAIL_LIMIT,
    maxSellerSignupsPerHour: limits.MAX_SELLER_SIGNUPS_PER_HOUR,
    trustProxy: env.TRUST_PROXY || false,
    trialDays: limits.TRIAL_DAYS,
    graceDays: limits.GRACE_DAYS,
    stripeConnectClientId: env.STRIPE_CONNECT_CLIENT_ID ?? "",
    stripeConnectWebhookSecret:
      env.STRIPE_CONNECT_WEBHOOK_SECRET ??
      (production ? "" : "whsec_connect_local"),
    stripeLiveMode: env.STRIPE_LIVE_MODE === "true",
    platformPriceId: env.PLATFORM_STRIPE_PRICE_ID ?? "",
    s3: {
      bucket: env.S3_BUCKET ?? "entitle-local",
      region: env.S3_REGION ?? "us-east-1",
      ...(endpoint ? { endpoint } : {}),
      ...(env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.S3_ACCESS_KEY_ID,
              secretAccessKey: env.S3_SECRET_ACCESS_KEY,
            },
          }
        : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      allowInsecureLocalDevelopment:
        !production && env.S3_ALLOW_HTTP === "true",
    },
  };
}
