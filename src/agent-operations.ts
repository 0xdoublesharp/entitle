import { z } from "zod";
import { genericApi } from "./cli-api.ts";
import { readRegularFile } from "./cli-files.ts";

const id = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9_-]+$/);
const uuid = z.string().uuid();
const slug = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const path = z.string().min(1).max(4096);
const version = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/);
const filename = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const queue = z.enum(["work", "emails"]);
const platformQueue = z.enum(["platform_work", "platform_emails"]);
const empty = z.object({}).strict();
const operationsSettings = z
  .object({
    failureThreshold: z.number().int().min(1).max(1000000).optional(),
    pendingAgeMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 86400000)
      .optional(),
    storageRatio: z.number().min(0.01).max(1).optional(),
    bandwidthBytes: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    cooldownMs: z
      .number()
      .int()
      .min(1000)
      .max(30 * 86400000)
      .optional(),
    notificationsEnabled: z.boolean().optional(),
    warningDays: z.number().int().min(1).max(90).optional(),
  })
  .strict();
const commerceSettings = z
  .object({
    automaticTax: z.boolean(),
    collectTaxId: z.boolean(),
    collectBillingAddress: z.boolean(),
  })
  .strict();
const event = z.enum([
  "license.created",
  "license.renewed",
  "license.revoked",
  "activation.changed",
  "release.published",
  "release.withdrawn",
  "alert.raised",
]);
type Input = Record<string, unknown>;
type Operation = {
  description: string;
  schema: z.ZodType;
  mode: "api" | "operator-api" | "request";
  method: string;
  route: (input: Input, env: NodeJS.ProcessEnv) => string;
  body?: (input: Input) => Input;
  output?: (input: Input) => string | undefined;
  upload?: (input: Input) => {
    file: string;
    contentType: string;
    metadata: Input;
  };
  textResponse?: boolean;
  readOnly?: boolean;
};
const tenantPath = (env: NodeJS.ProcessEnv) => {
  if (
    !env.TENANT_SLUG ||
    env.TENANT_SLUG.length > 100 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.TENANT_SLUG)
  )
    throw Error("A valid TENANT_SLUG is required.");
  return `/api/v1/tenants/${env.TENANT_SLUG}`;
};
const routeId = (input: Input, name: string) =>
  encodeURIComponent(String(input[name]));

export const agentOperations: Record<string, Operation> = {
  "product-save": {
    description:
      "Create or update a product and its annual plan mappings using structured fields.",
    schema: z
      .object({
        slug,
        name: z.string().min(1).max(200),
        framework: z
          .enum([
            "wordpress",
            "joomla",
            "electron",
            "tauri",
            "sparkle",
            "jetbrains",
            "generic",
          ])
          .optional(),
        frameworkConfig: z.record(z.string(), z.unknown()).optional(),
        pluginBasename: z.string().max(255).optional(),
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
      .strict(),
    mode: "api",
    method: "POST",
    route: () => "/products",
    body: (v) => v,
  },
  "release-publish": {
    description:
      "Publish a WordPress ZIP from a local file with structured metadata. Inspect release inventory after an uncertain response.",
    schema: z
      .object({
        product: slug,
        version,
        file: path,
        metadata: z
          .object({
            changelog: z.string().max(30000),
            minWp: z.string().max(60).optional(),
            minPhp: z.string().max(60).optional(),
            minFree: z.string().max(60).optional(),
            tested: z.string().max(60).optional(),
          })
          .strict(),
      })
      .strict(),
    mode: "api",
    method: "POST",
    route: (v) => `/releases/${routeId(v, "product")}/${routeId(v, "version")}`,
    upload: (v) => ({
      file: String(v.file),
      contentType: "application/zip",
      metadata: v.metadata as Input,
    }),
  },
  "asset-publish": {
    description:
      "Publish a native asset from a local file with structured metadata. Inspect release inventory after an uncertain response.",
    schema: z
      .object({
        product: slug,
        version,
        file: path,
        metadata: z
          .object({
            target: id,
            filename,
            changelog: z.string().max(6000),
            signature: z.string().min(1).max(2048).optional(),
            minSystemVersion: z.string().min(1).max(100).optional(),
          })
          .strict(),
      })
      .strict(),
    mode: "api",
    method: "POST",
    route: (v) => `/assets/${routeId(v, "product")}/${routeId(v, "version")}`,
    upload: (v) => ({
      file: String(v.file),
      contentType: "application/octet-stream",
      metadata: v.metadata as Input,
    }),
  },
  "owner-sessions": {
    description: "List the authenticated seller's sessions.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: () => "/api/v1/platform/account/sessions",
    readOnly: true,
  },
  "owner-session-revoke": {
    description:
      "Revoke a seller session; revoking the current session signs it out.",
    schema: z.object({ id }).strict(),
    mode: "request",
    method: "POST",
    route: () => "/api/v1/platform/account/sessions/revoke",
    body: (v) => v,
  },
  "owner-sessions-revoke-others": {
    description: "Revoke the seller's other sessions.",
    schema: empty,
    mode: "request",
    method: "POST",
    route: () => "/api/v1/platform/account/sessions/revoke-others",
    body: () => ({}),
  },
  "owner-sessions-revoke-all": {
    description: "Revoke all seller sessions, including the current session.",
    schema: empty,
    mode: "request",
    method: "POST",
    route: () => "/api/v1/platform/account/sessions/revoke-all",
    body: () => ({}),
  },
  "buyer-me": {
    description:
      "Inspect the signed-in buyer's licenses, installations and releases.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/me`,
    readOnly: true,
  },
  "buyer-notifications": {
    description: "Read the signed-in buyer's notices.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/notifications`,
    readOnly: true,
  },
  "buyer-notification-dismiss": {
    description: "Dismiss a buyer notice.",
    schema: z.object({ id }).strict(),
    mode: "request",
    method: "POST",
    route: (v, e) =>
      `${tenantPath(e)}/notifications/${routeId(v, "id")}/dismiss`,
    body: () => ({}),
  },
  "buyer-installation-deactivate": {
    description: "Deactivate an installation owned by the signed-in buyer.",
    schema: z.object({ id }).strict(),
    mode: "request",
    method: "POST",
    route: (v, e) =>
      `${tenantPath(e)}/installations/${routeId(v, "id")}/deactivate`,
    body: () => ({}),
  },
  "buyer-key-replace": {
    description:
      "Replace a buyer license key and revoke existing installation tokens. The new key is written to a new private file; do not retry after an uncertain response.",
    schema: z.object({ id, output: path }).strict(),
    mode: "request",
    method: "POST",
    route: (v, e) => `${tenantPath(e)}/licenses/${routeId(v, "id")}/key`,
    body: () => ({}),
    output: (v) => String(v.output),
  },
  "buyer-data-export": {
    description:
      "Write the buyer's private data export to a new owner-only file.",
    schema: z.object({ output: path }).strict(),
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/account/export`,
    output: (v) => String(v.output),
    readOnly: true,
  },
  "buyer-closure-status": {
    description: "Read the buyer's account closure request and blockers.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/account/closure`,
    readOnly: true,
  },
  "buyer-closure-request": {
    description:
      "Request account closure; completion remains an operator procedure.",
    schema: empty,
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/account/closure`,
    body: () => ({}),
  },
  "buyer-logout": {
    description: "Sign out the current buyer session.",
    schema: empty,
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/auth/logout`,
    body: () => ({}),
  },
  "buyer-release-download": {
    description:
      "Download a buyer's entitled WordPress release into a new private file.",
    schema: z.object({ licenseId: id, releaseId: uuid, output: path }).strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/licenses/${routeId(v, "licenseId")}/releases/${routeId(v, "releaseId")}/download`,
    output: (v) => String(v.output),
    readOnly: true,
  },
  "buyer-asset-download": {
    description:
      "Download a buyer's entitled native asset into a new private file.",
    schema: z.object({ licenseId: id, assetId: uuid, output: path }).strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/licenses/${routeId(v, "licenseId")}/assets/${routeId(v, "assetId")}/download`,
    output: (v) => String(v.output),
    readOnly: true,
  },
  "installation-release-download": {
    description:
      "Download an entitled WordPress release with an activation bearer token into a new private file.",
    schema: z.object({ releaseId: uuid, output: path }).strict(),
    mode: "request",
    method: "GET",
    route: (v, e) => `${tenantPath(e)}/packages/${routeId(v, "releaseId")}`,
    output: (v) => String(v.output),
    readOnly: true,
  },
  "installation-asset-download": {
    description:
      "Download an entitled native asset with an activation bearer token into a new private file.",
    schema: z
      .object({ product: slug, assetId: uuid, filename, output: path })
      .strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/packages/${routeId(v, "product")}/assets/${routeId(v, "assetId")}/${routeId(v, "filename")}`,
    output: (v) => String(v.output),
    readOnly: true,
  },
  "update-joomla": {
    description: "Read an authenticated Joomla update feed.",
    schema: z.object({ product: slug }).strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/updates/joomla/${routeId(v, "product")}.xml`,
    textResponse: true,
    readOnly: true,
  },
  "update-electron": {
    description: "Read an authenticated Electron update feed.",
    schema: z
      .object({
        product: slug,
        target: id,
        filename: z.enum([
          "latest.yml",
          "latest-mac.yml",
          "latest-linux.yml",
          "latest-linux-arm64.yml",
        ]),
      })
      .strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/updates/electron/${routeId(v, "product")}/${routeId(v, "target")}/${routeId(v, "filename")}`,
    textResponse: true,
    readOnly: true,
  },
  "update-tauri": {
    description: "Read an authenticated Tauri update feed.",
    schema: z
      .object({ product: slug, target: id, currentVersion: version })
      .strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/updates/tauri/${routeId(v, "product")}/${routeId(v, "target")}/${routeId(v, "currentVersion")}`,
    textResponse: true,
    readOnly: true,
  },
  "update-sparkle": {
    description: "Read an authenticated Sparkle appcast.",
    schema: z.object({ product: slug, target: id }).strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/updates/sparkle/${routeId(v, "product")}/${routeId(v, "target")}/appcast.xml`,
    textResponse: true,
    readOnly: true,
  },
  "update-jetbrains": {
    description: "Read an authenticated JetBrains update feed.",
    schema: z
      .object({
        product: slug,
        build: z.string().max(100).optional(),
        os: z.string().max(100).optional(),
        arch: z.string().max(100).optional(),
      })
      .strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/updates/jetbrains/${routeId(v, "product")}/updatePlugins.xml?${new URLSearchParams(Object.fromEntries(["build", "os", "arch"].filter((k) => v[k] !== undefined).map((k) => [k, String(v[k])])))}`,
    textResponse: true,
    readOnly: true,
  },
  "update-generic": {
    description: "Read an authenticated generic update feed.",
    schema: z
      .object({ product: slug, target: id, currentVersion: version.optional() })
      .strict(),
    mode: "request",
    method: "GET",
    route: (v, e) =>
      `${tenantPath(e)}/updates/generic/${routeId(v, "product")}/${routeId(v, "target")}${v.currentVersion === undefined ? "" : `?currentVersion=${encodeURIComponent(String(v.currentVersion))}`}`,
    textResponse: true,
    readOnly: true,
  },
  "license-detail": {
    description:
      "Inspect one license and a bounded page of installations. Pass nextCursor as after to continue.",
    schema: z
      .object({
        id,
        after: id.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    mode: "api",
    method: "GET",
    route: (v) =>
      `/licenses/${routeId(v, "id")}?${new URLSearchParams({ ...(v.after === undefined ? {} : { after: String(v.after) }), ...(v.limit === undefined ? {} : { limit: String(v.limit) }) })}`,
    readOnly: true,
  },
  "license-complimentary": {
    description:
      "Issue an emailed complimentary license; reuse requestId and identical details after an uncertain response.",
    schema: z
      .object({
        email: z.email().max(254),
        productId: id,
        siteAllowance: z.number().int().min(1).max(100000),
        expiresAt: z.number().int().positive(),
        note: z.string().max(2000).optional(),
        requestId: uuid,
        confirm: z.literal(true),
      })
      .strict(),
    mode: "api",
    method: "POST",
    route: () => "/licenses/complimentary",
    body: (v) => v,
  },
  "job-retry": {
    description: "Retry one failed seller work or email job.",
    schema: z.object({ table: queue, id }).strict(),
    mode: "api",
    method: "POST",
    route: (v) => `/jobs/${v.table}/${routeId(v, "id")}/retry`,
    body: () => ({}),
  },
  "jobs-retry-failed": {
    description:
      "Retry a bounded set of failed seller jobs after resolving the failure.",
    schema: z
      .object({
        table: queue,
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    mode: "api",
    method: "POST",
    route: (v) => `/jobs/${v.table}/retry-failed`,
    body: (v) => (v.limit === undefined ? {} : { limit: v.limit }),
  },
  "platform-job-retry": {
    description: "Retry one failed platform job.",
    schema: z.object({ table: platformQueue, id }).strict(),
    mode: "operator-api",
    method: "POST",
    route: (v) => `/jobs/${v.table}/${routeId(v, "id")}/retry`,
    body: () => ({}),
  },
  "platform-jobs-retry-failed": {
    description: "Retry a bounded set of failed platform jobs.",
    schema: z
      .object({
        table: platformQueue,
        limit: z.number().int().min(1).max(500).optional(),
      })
      .strict(),
    mode: "operator-api",
    method: "POST",
    route: (v) => `/jobs/${v.table}/retry-failed`,
    body: (v) => (v.limit === undefined ? {} : { limit: v.limit }),
  },
  reports: {
    description: "Read daily download and storage reports.",
    schema: z
      .object({ days: z.number().int().min(1).max(365).optional() })
      .strict(),
    mode: "api",
    method: "GET",
    route: (v) =>
      `/operations/reports${v.days === undefined ? "" : `?days=${v.days}`}`,
    readOnly: true,
  },
  "operations-settings": {
    description: "Update operating thresholds and notice settings.",
    schema: z.object({ settings: operationsSettings }).strict(),
    mode: "api",
    method: "PUT",
    route: () => "/operations/settings",
    body: (v) => v.settings as Input,
  },
  "webhook-create": {
    description:
      "Create a webhook. The signing secret is returned once and is sensitive.",
    schema: z
      .object({
        url: z.string().url().max(1000),
        events: z.array(event).min(1).max(7),
      })
      .strict(),
    mode: "api",
    method: "POST",
    route: () => "/webhooks",
    body: (v) => v,
  },
  "webhook-rotate": {
    description:
      "Rotate a webhook signing secret; the new secret is returned once.",
    schema: z.object({ id: uuid }).strict(),
    mode: "api",
    method: "POST",
    route: (v) => `/webhooks/${routeId(v, "id")}/rotate`,
    body: () => ({}),
  },
  "webhook-delete": {
    description: "Disable a webhook and cancel queued deliveries.",
    schema: z.object({ id: uuid }).strict(),
    mode: "api",
    method: "DELETE",
    route: (v) => `/webhooks/${routeId(v, "id")}`,
    body: () => ({}),
  },
  "webhook-retry": {
    description: "Retry a failed webhook delivery by its 64-character hash.",
    schema: z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    mode: "api",
    method: "POST",
    route: (v) => `/webhook-deliveries/${routeId(v, "id")}/retry`,
    body: () => ({}),
  },
  "export-list": {
    description: "List current workspace export handles.",
    schema: empty,
    mode: "api",
    method: "GET",
    route: () => "/exports",
    readOnly: true,
  },
  "export-delete": {
    description: "Delete a saved workspace export.",
    schema: z.object({ id: uuid }).strict(),
    mode: "api",
    method: "DELETE",
    route: (v) => `/exports/${routeId(v, "id")}`,
    body: () => ({}),
  },
  catalog: {
    description: "Read the public workspace catalog.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/catalog`,
    readOnly: true,
  },
  "activation-status": {
    description:
      "Read the current installation status using ENTITLE_AUTHORIZATION with an activation bearer token.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/activation`,
    readOnly: true,
  },
  "activation-deactivate": {
    description:
      "Deactivate the installation authenticated by ENTITLE_AUTHORIZATION.",
    schema: empty,
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/deactivate`,
    body: () => ({}),
  },
  "update-check": {
    description: "Check the WordPress update feed with an activation token.",
    schema: z.object({ product: id }).strict(),
    mode: "request",
    method: "GET",
    route: (v, e) => `${tenantPath(e)}/updates/${routeId(v, "product")}`,
    readOnly: true,
  },
  "owner-me": {
    description: "Inspect the interactive seller session and memberships.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: () => "/api/v1/platform/me",
    readOnly: true,
  },
  "owner-verification-request": {
    description:
      "Request fresh email verification for a sensitive owner action.",
    schema: z
      .object({
        purpose: z.enum([
          "recovery_codes",
          "billing",
          "api_keys",
          "tenant_transfer",
          "release_publish",
        ]),
      })
      .strict(),
    mode: "request",
    method: "POST",
    route: () => "/api/v1/platform/account/verification/request",
    body: (v) => v,
  },
  "workspace-create": {
    description:
      "Create a hosted workspace with an interactive seller session and CSRF token.",
    schema: z
      .object({
        slug: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        name: z.string().min(1).max(200),
      })
      .strict(),
    mode: "request",
    method: "POST",
    route: () => "/api/v1/platform/tenants",
    body: (v) => v,
  },
  "owner-keys": {
    description: "List automation keys using an interactive owner session.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/seller/keys`,
    readOnly: true,
  },
  "owner-key-create": {
    description:
      "Create a scoped automation key using an owner session, CSRF token, and fresh api_keys verification. The key is returned once.",
    schema: z
      .object({
        name: z.string().min(1).max(150),
        scopes: z
          .array(
            z.enum([
              "read",
              "catalog:write",
              "releases:write",
              "licenses:write",
              "billing:reconcile",
              "operations:write",
              "data:export",
            ]),
          )
          .min(1)
          .optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
      .strict(),
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/seller/keys`,
    body: (v) => v,
  },
  "owner-key-revoke": {
    description: "Revoke an automation key with fresh api_keys verification.",
    schema: z.object({ id }).strict(),
    mode: "request",
    method: "POST",
    route: (v, e) => `${tenantPath(e)}/seller/keys/${routeId(v, "id")}/revoke`,
    body: () => ({}),
  },
  "stripe-connect": {
    description:
      "Request a Stripe Connect URL using an interactive owner session; complete authorization in the same signed-in browser session.",
    schema: empty,
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/seller/stripe/connect`,
    body: () => ({}),
  },
  "platform-checkout": {
    description:
      "Request a platform subscription checkout URL using an owner session.",
    schema: z.object({ tier: z.enum(["starter", "pro"]).optional() }).strict(),
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/seller/platform/checkout`,
    body: (v) => v,
  },
  "platform-portal": {
    description:
      "Request the platform subscription portal URL using an owner session.",
    schema: empty,
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/seller/platform/portal`,
    body: () => ({}),
  },
  "sandbox-status": {
    description: "Inspect the sandbox using an interactive owner session.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/seller/sandbox`,
    readOnly: true,
  },
  "sandbox-create": {
    description:
      "Create a fixture or Stripe-test sandbox using an interactive owner session.",
    schema: z.object({ mode: z.enum(["fixture", "stripe"]) }).strict(),
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/seller/sandbox`,
    body: (v) => v,
  },
  "sandbox-purchase": {
    description:
      "Create a sandbox fixture purchase to the verified seller email.",
    schema: z.object({ planId: id }).strict(),
    mode: "request",
    method: "POST",
    route: (_v, e) => `${tenantPath(e)}/seller/sandbox/purchase`,
    body: (v) => v,
  },
  "commerce-settings": {
    description: "Read interactive owner commerce settings.",
    schema: empty,
    mode: "request",
    method: "GET",
    route: (_v, e) => `${tenantPath(e)}/seller/commerce/settings`,
    readOnly: true,
  },
  "commerce-settings-update": {
    description: "Update interactive owner commerce settings.",
    schema: z.object({ settings: commerceSettings }).strict(),
    mode: "request",
    method: "PUT",
    route: (_v, e) => `${tenantPath(e)}/seller/commerce/settings`,
    body: (v) => v.settings as Input,
  },
  "commerce-tax-code": {
    description: "Set a product Stripe tax code using an owner session.",
    schema: z
      .object({
        id,
        taxCode: z
          .string()
          .regex(/^txcd_\d{8}$/)
          .nullable(),
      })
      .strict(),
    mode: "request",
    method: "PUT",
    route: (v, e) =>
      `${tenantPath(e)}/seller/commerce/products/${routeId(v, "id")}/tax-code`,
    body: (v) => ({ taxCode: v.taxCode }),
  },
};

export async function runAgentOperation(
  name: string,
  value: unknown,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  const operation = agentOperations[name];
  if (!operation) throw Error("Unknown operation.");
  const input = operation.schema.parse(value) as Input;
  const upload = operation.upload?.(input);
  const output = operation.output?.(input);
  await genericApi(
    operation.mode,
    [
      operation.method,
      operation.route(input, env),
      ...(upload
        ? ["--upload", upload.file, "--content-type", upload.contentType]
        : []),
      ...(output ? ["--output", output] : []),
    ],
    env,
    io,
    operation.body?.(input),
    {
      ...(operation.textResponse ? { responseMode: "text" as const } : {}),
      ...(upload ? { inlineMetadata: upload.metadata } : {}),
    },
  );
}

export async function runAgentCli(
  name: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  if (name === "job-retry" && args.length === 2)
    return runAgentOperation(name, { table: args[0], id: args[1] }, env, io);
  if (args.length > 1)
    throw Error(
      "Supply one JSON input file, or omit it for an operation without arguments.",
    );
  const input = args[0]
    ? (JSON.parse((await readRegularFile(args[0])).toString("utf8")) as unknown)
    : {};
  return runAgentOperation(name, input, env, io);
}
