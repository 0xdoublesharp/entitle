import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import semver from "semver";
import type { Readable } from "node:stream";
import { z } from "zod";
import type { License, Release, ReleaseAsset } from "./db.ts";
import { bearer } from "./auth.ts";
import { check } from "./errors.ts";
import { frameworkTargets, type Framework } from "./frameworks.ts";
import { renderUpdate } from "./update-adapters.ts";
import { MAX_NATIVE_ARTIFACT_BYTES } from "./storage.ts";
import { apiLimit, type TenantContextFor } from "./tenant-api.ts";

const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const version = z
  .string()
  .max(60)
  .refine((v) => semver.valid(v) === v);
export type DownloadSender = (
  req: FastifyRequest,
  reply: FastifyReply,
  releaseId: string,
  bytes: Buffer | Readable,
  receipt?: { size: number },
) => FastifyReply;
export type DownloadAdmission = (
  req: FastifyRequest,
  reply: FastifyReply,
  size: number,
  receipt?: { streaming: boolean; transferBytes: number },
) => void;

export async function frameworkRoutes(
  api: FastifyInstance,
  context: TenantContextFor,
  successfulDownload: DownloadSender,
  reserveDownload: DownloadAdmission,
) {
  async function feed(
    req: FastifyRequest,
    reply: FastifyReply,
    framework: Framework,
  ) {
    const params = z
      .object({
        product: identifier,
        target: identifier.optional(),
        filename: z.string().max(30).optional(),
        currentVersion: version.optional(),
      })
      .parse(req.params);
    const query = (
      framework === "jetbrains"
        ? z
            .object({
              build: z.string().max(100).optional(),
              os: z.string().max(100).optional(),
              arch: z.string().max(100).optional(),
              uuid: z.string().max(100).optional(),
              mid: z.string().max(100).optional(),
              eap: z.string().max(100).optional(),
              pluginId: z.string().max(200).optional(),
            })
            .strict()
        : framework === "generic"
          ? z.object({ currentVersion: version.optional() }).strict()
          : z.object({}).strict()
    ).parse(req.query);
    const { db, tenant, licensing, artifacts } = context(req);
    const { license } = await licensing.resolve(bearer(req));
    check(
      licensing.entitled(license),
      403,
      "not_entitled",
      "Downloads and updates are unavailable for this license.",
    );
    const product = await db("products")
      .where({
        tenant_id: tenant.id,
        id: license.product_id,
        slug: params.product,
      })
      .first();
    check(
      product,
      403,
      "wrong_product",
      "License does not cover this product.",
    );
    check(
      product.framework === framework,
      409,
      "framework_mismatch",
      "Use this product's framework update feed.",
    );
    const target = params.target ?? "any";
    check(
      framework === "generic" ||
        (frameworkTargets[framework] as readonly string[]).includes(target),
      400,
      "invalid_target",
      "Unsupported framework target.",
    );
    if (framework === "electron")
      check(
        params.filename === "latest.yml" ||
          (params.filename === "latest-mac.yml" &&
            target.startsWith("darwin-")) ||
          (params.filename === "latest-linux.yml" && target === "linux-x64") ||
          (params.filename === "latest-linux-arm64.yml" &&
            target === "linux-arm64"),
        400,
        "invalid_feed",
        "Unsupported feed filename for this target.",
      );
    const latest = await artifacts.latest(product.id, target);
    const currentVersion =
      params.currentVersion ??
      ("currentVersion" in query
        ? (query.currentVersion as string | undefined)
        : undefined);
    if (
      !latest ||
      (currentVersion !== undefined &&
        semver.lte(latest.release.version, currentVersion))
    )
      return reply.code(204).send();
    return sendFeed(
      req,
      reply,
      framework,
      product,
      latest.release,
      latest.assets,
      framework === "joomla"
        ? `${context(req).config.origin}/api/v1/tenants/${tenant.slug}/updates/joomla/${product.slug}/releases/${latest.release.id}.xml`
        : undefined,
    );
  }
  async function sendFeed(
    req: FastifyRequest,
    reply: FastifyReply,
    framework: Framework,
    product: { slug: string; name: string; framework_config: string },
    release: Release,
    assets: ReleaseAsset[],
    detailsUrl?: string,
  ) {
    const { config, tenant, reads } = context(req);
    const input = {
      framework,
      product: {
        slug: product.slug,
        name: product.name,
        frameworkConfig: JSON.parse(product.framework_config),
      },
      release: { ...release, published_at: Number(release.published_at) },
      assets: assets.map((asset) => ({
        ...asset,
        size: Number(asset.size),
        url: `${config.origin}/api/v1/tenants/${tenant.slug}/packages/${product.slug}/assets/${asset.id}/${encodeURIComponent(asset.filename)}`,
      })),
      ...(detailsUrl ? { detailsUrl } : {}),
    };
    const rendered = await reads.remember("feed", tenant.id, input, async () =>
      renderUpdate(input),
    );
    return reply.type(rendered.contentType).send(rendered.body);
  }
  // Joomla's native details reload has no authentication hook. This exposes
  // only immutable public metadata; discovery and every artifact stay protected.
  api.get(
    "/updates/joomla/:product/releases/:releaseId.xml",
    { config: apiLimit(60) },
    async (req, reply) => {
      const params = z
        .object({ product: identifier, releaseId: z.string().uuid() })
        .parse(req.params);
      z.object({}).strict().parse(req.query);
      const { db, tenant } = context(req);
      const product = await db("products")
        .where({
          tenant_id: tenant.id,
          slug: params.product,
          framework: "joomla",
        })
        .first();
      check(product, 404, "not_found", "Update details not found.");
      const release = await db<Release>("releases")
        .where({
          tenant_id: tenant.id,
          id: params.releaseId,
          product_id: product.id,
          withdrawn: 0,
        })
        .andWhere("published_at", "<=", Date.now())
        .first();
      check(release, 404, "not_found", "Update details not found.");
      const assets = await db<ReleaseAsset>("release_assets")
        .where({ tenant_id: tenant.id, release_id: release.id, target: "any" })
        .orderBy("id");
      check(assets.length, 404, "not_found", "Update details not found.");
      return sendFeed(req, reply, "joomla", product, release, assets);
    },
  );

  api.get(
    "/updates/joomla/:product.xml",
    { config: apiLimit(60) },
    (req, reply) => feed(req, reply, "joomla"),
  );
  api.get(
    "/updates/electron/:product/:target/:filename",
    { config: apiLimit(60) },
    (req, reply) => feed(req, reply, "electron"),
  );
  api.get(
    "/updates/tauri/:product/:target/:currentVersion",
    { config: apiLimit(60) },
    (req, reply) => feed(req, reply, "tauri"),
  );
  api.get(
    "/updates/sparkle/:product/:target/appcast.xml",
    { config: apiLimit(60) },
    (req, reply) => feed(req, reply, "sparkle"),
  );
  api.get(
    "/updates/jetbrains/:product/updatePlugins.xml",
    { config: apiLimit(60) },
    (req, reply) => feed(req, reply, "jetbrains"),
  );
  api.get(
    "/updates/generic/:product/:target",
    { config: apiLimit(60) },
    (req, reply) => feed(req, reply, "generic"),
  );

  async function assetDownload(
    req: FastifyRequest,
    reply: FastifyReply,
    license: License,
    assetId: string,
    productSlug?: string,
    filename?: string,
  ) {
    const { db, tenant, licensing, artifacts } = context(req);
    license = await licensing.effective(license);
    check(
      licensing.entitled(license),
      403,
      "not_entitled",
      "Downloads and updates are unavailable for this license.",
    );
    const product = await db("products")
      .where({ tenant_id: tenant.id, id: license.product_id })
      .first();
    check(
      product && (productSlug === undefined || product.slug === productSlug),
      403,
      "wrong_product",
      "License does not cover this product.",
    );
    check(
      product.framework !== "wordpress",
      409,
      "framework_mismatch",
      "Use the WordPress package endpoint for this product.",
    );
    const asset = await db<ReleaseAsset>("release_assets")
      .where({ tenant_id: tenant.id, id: assetId })
      .first();
    const release =
      asset &&
      (await db<Release>("releases")
        .where({
          tenant_id: tenant.id,
          id: asset.release_id,
          product_id: license.product_id,
          withdrawn: 0,
        })
        .andWhere("published_at", "<=", Date.now())
        .first());
    check(
      asset &&
        release &&
        (filename === undefined || filename === asset.filename),
      404,
      "not_found",
      "Asset not found or withdrawn.",
    );
    const size = Number(asset.size);
    check(
      Number.isSafeInteger(size) &&
        size > 0 &&
        size <= MAX_NATIVE_ARTIFACT_BYTES,
      503,
      "artifact_integrity",
      "Invalid stored artifact size.",
    );
    let start = 0,
      end = size - 1;
    const range = req.headers.range;
    if (range !== undefined) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && (match[1] || match[2])) {
        if (match[1]) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        } else {
          const suffix = Number(match[2]);
          start = Math.max(0, size - suffix);
        }
      } else start = size;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start >= size ||
        end < start
      ) {
        return reply
          .code(416)
          .header("content-range", `bytes */${size}`)
          .header("content-length", 0)
          .send();
      }
    }
    // Do not advertise an attachment until admission and storage verification
    // succeed: error responses must remain ordinary JSON, including on ranges.
    let bytes: Buffer | Readable | undefined;
    if (req.method !== "HEAD") {
      reserveDownload(req, reply, artifacts.cache ? end - start + 1 : size, {
        streaming: artifacts.cache !== undefined,
        transferBytes: end - start + 1,
      });
      bytes = artifacts.cache
        ? (await artifacts.open(asset, start, end)).stream
        : (await artifacts.read(asset)).subarray(start, end + 1);
      if (!Buffer.isBuffer(bytes)) {
        const stream = bytes;
        const abort = () => stream.destroy();
        req.raw.once("aborted", abort);
        reply.raw.once("close", abort);
        stream.once("close", () => {
          req.raw.off("aborted", abort);
          reply.raw.off("close", abort);
        });
        if (req.raw.aborted || reply.raw.destroyed) {
          stream.destroy();
          check(false, 499, "download_aborted", "Download aborted.");
        }
      }
    }
    reply
      .header("accept-ranges", "bytes")
      .header("content-type", "application/octet-stream")
      .header("content-disposition", `attachment; filename="${asset.filename}"`)
      .header("x-checksum-sha256", asset.checksum);
    if (range !== undefined)
      reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`);
    reply.header("content-length", end - start + 1);
    if (req.method === "HEAD") return reply.send();
    return successfulDownload(req, reply, release.id, bytes!, {
      size: end - start + 1,
    });
  }
  api.route({
    method: ["GET", "HEAD"],
    url: "/packages/:product/assets/:assetId/:filename",
    config: apiLimit(30),
    handler: async (req, reply) => {
      const p = z
        .object({
          product: identifier,
          assetId: z.string().uuid(),
          filename: z.string().min(1).max(200),
        })
        .parse(req.params);
      const { license } = await context(req).licensing.resolve(bearer(req));
      return assetDownload(
        req,
        reply,
        license,
        p.assetId,
        p.product,
        p.filename,
      );
    },
  });
  api.route({
    method: ["GET", "HEAD"],
    url: "/licenses/:id/assets/:assetId/download",
    config: apiLimit(30),
    handler: async (req, reply) => {
      const p = z
        .object({ id: z.string().min(1).max(200), assetId: z.string().uuid() })
        .parse(req.params);
      const { db, tenant, auth } = context(req);
      const { customer } = await auth.customer(req, false);
      const license = await db<License>("licenses")
        .where({ tenant_id: tenant.id, id: p.id, customer_id: customer.id })
        .first();
      check(license, 404, "not_found", "License not found.");
      return assetDownload(req, reply, license, p.assetId);
    },
  });
}
