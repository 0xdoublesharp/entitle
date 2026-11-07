import { recordBusinessEvent } from "./business-events.ts";
import { createHash, randomUUID } from "node:crypto";
import { stat, rm, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  hashArtifactFile,
  artifactFileIdentity,
  type VerifiedArtifactCache,
} from "./artifact-streams.ts";
import semver from "semver";
import {
  lock,
  type DB,
  type Tx,
  type TenantContext,
  type Release,
  type ReleaseAsset,
} from "./db.ts";
import { AppError, check } from "./errors.ts";
import {
  requirePublicationTenant,
  type PublicationPolicy,
} from "./publication-policy.ts";
import { validateFramework, validateFrameworkConfig } from "./frameworks.ts";
import {
  validateAssetMetadata,
  verifyArtifact,
  type AssetMetadata,
} from "./package-validation.ts";
import {
  DEFAULT_NATIVE_ARTIFACT_BYTES,
  MAX_NATIVE_ARTIFACT_BYTES,
  MAX_ARTIFACT_BYTES,
  type ArtifactStore,
} from "./storage.ts";
export interface AssetPublication extends AssetMetadata {
  product: string;
  version: string;
  file: string;
}
export class Artifacts {
  readonly db: DB;
  readonly store: ArtifactStore;
  readonly tenant: Readonly<TenantContext>;
  readonly maxBytes: number;
  readonly graceMs: number;
  readonly cache: VerifiedArtifactCache | undefined;
  readonly publicationPolicy: Readonly<PublicationPolicy>;
  constructor(
    db: DB,
    store: ArtifactStore,
    tenant: TenantContext,
    maxBytes = DEFAULT_NATIVE_ARTIFACT_BYTES,
    graceMs = 900000,
    cache?: VerifiedArtifactCache,
    publicationPolicy: PublicationPolicy = { deploymentMode: "hosted" },
  ) {
    check(
      Number.isSafeInteger(maxBytes) &&
        maxBytes > 0 &&
        maxBytes <= MAX_NATIVE_ARTIFACT_BYTES &&
        Number.isSafeInteger(graceMs) &&
        graceMs > 0 &&
        graceMs <= 86400000,
      500,
      "invalid_upload_limit",
      "Invalid artifact upload limit or reservation duration.",
    );
    this.cache = cache;
    this.db = db;
    this.store = store;
    this.tenant = Object.freeze({ ...tenant });
    this.maxBytes = maxBytes;
    this.graceMs = graceMs;
    this.publicationPolicy = Object.freeze({
      deploymentMode: publicationPolicy.deploymentMode,
      graceDays: publicationPolicy.graceDays,
    });
  }
  private async capacity(tx: Tx) {
    const tenant = await requirePublicationTenant(
      tx,
      this.tenant.id,
      this.publicationPolicy,
    );
    const stored = await tx("releases")
      .where({ tenant_id: this.tenant.id })
      .sum({ bytes: "size" })
      .first();
    const reserved = await tx("upload_reservations")
      .where({ tenant_id: this.tenant.id })
      .sum({ bytes: "bytes" })
      .first();
    return {
      used: Number(stored?.bytes ?? 0),
      reserved: Number(reserved?.bytes ?? 0),
      limit: Number(tenant.max_storage_bytes),
    };
  }
  async publish(
    input: AssetPublication,
    authorize?: (tx: Tx) => Promise<void>,
  ): Promise<{ release: Release; asset: ReleaseAsset }> {
    input = { ...input };
    check(
      semver.valid(input.version) === input.version &&
        semver.prerelease(input.version) === null,
      400,
      "invalid_version",
      "Release version must be stable semantic versioning.",
    );
    const product = await this.db("products")
      .where({ tenant_id: this.tenant.id, slug: input.product })
      .first();
    check(product, 404, "not_found", "Product not found.");
    const framework = validateFramework(product.framework);
    const config = validateFrameworkConfig(
      framework,
      JSON.parse(product.framework_config),
    );
    const metadata = validateAssetMetadata(framework, {
      target: input.target,
      filename: input.filename,
      changelog: input.changelog,
      ...(input.signature === undefined ? {} : { signature: input.signature }),
      ...(input.minSystemVersion === undefined
        ? {}
        : { minSystemVersion: input.minSystemVersion }),
    });
    const size = (await stat(input.file)).size;
    check(
      size > 0 && size <= this.maxBytes,
      413,
      "upload_limit",
      "Artifact exceeds the upload limit or is empty.",
    );
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await authorize?.(tx);
      await lock(tx, "schema", this.tenant.id);
      const capacity = await this.capacity(tx);
      check(
        capacity.used + capacity.reserved + size <= capacity.limit,
        409,
        "storage_limit",
        "Tenant storage allowance has been reached.",
      );
      await tx("upload_reservations").insert({
        tenant_id: this.tenant.id,
        id,
        bytes: size,
        expires_at:
          Date.now() +
          Math.min(
            86400000,
            this.graceMs + Math.ceil((6000 * size) / 1024 ** 2),
          ),
      });
    });
    let attempted = false;
    try {
      const originalIdentity = await artifactFileIdentity(input.file);
      const hashes = await hashArtifactFile(input.file, size);
      await verifyArtifact(
        framework,
        config,
        input.version,
        metadata,
        input.file,
      );
      check(
        (await artifactFileIdentity(input.file)) === originalIdentity,
        503,
        "artifact_integrity",
        "Artifact changed during validation.",
      );
      const { checksum, sha512 } = hashes;
      const streaming =
        this.store.putFile !== undefined && this.store.getToFile !== undefined;
      check(
        streaming || size <= MAX_ARTIFACT_BYTES,
        503,
        "streaming_storage_required",
        "Streaming storage is required for this artifact.",
      );
      attempted = true;
      try {
        if (streaming)
          await this.store.putFile!(
            this.tenant.id,
            id,
            input.file,
            checksum,
            size,
          );
        else {
          const bytes = await readFile(input.file);
          check(
            bytes.length === size &&
              createHash("sha256").update(bytes).digest("hex") === checksum,
            503,
            "artifact_integrity",
            "Artifact changed during publication.",
          );
          await this.store.put(this.tenant.id, id, bytes, checksum);
        }
      } catch (error) {
        if (error instanceof AppError && error.code === "artifact_exists")
          attempted = false;
        throw error;
      }
      if (streaming) {
        const readback = join(dirname(input.file), randomUUID() + ".readback");
        try {
          await this.store.getToFile!(
            this.tenant.id,
            id,
            checksum,
            size,
            readback,
          );
          const verified = await hashArtifactFile(readback, size);
          check(
            verified.checksum === checksum && verified.sha512 === sha512,
            503,
            "artifact_integrity",
            "Stored artifact failed integrity verification.",
          );
        } finally {
          await rm(readback, { force: true });
        }
      } else {
        const readback = await this.store.get(
          this.tenant.id,
          id,
          checksum,
          size,
        );
        check(
          readback.length === size &&
            createHash("sha256").update(readback).digest("hex") === checksum &&
            createHash("sha512").update(readback).digest("base64") === sha512,
          503,
          "artifact_integrity",
          "Stored artifact failed integrity verification.",
        );
      }
      check(
        (await artifactFileIdentity(input.file)) === originalIdentity,
        503,
        "artifact_integrity",
        "Artifact changed during publication.",
      );
      return await this.db.transaction(async (tx) => {
        await authorize?.(tx);
        await lock(tx, "schema", this.tenant.id);
        const capacity = await this.capacity(tx);
        const reservation = await tx("upload_reservations")
          .where({ tenant_id: this.tenant.id, id })
          .first();
        check(
          reservation && Number(reservation.expires_at) > Date.now(),
          409,
          "upload_expired",
          "Upload reservation expired; retry publication.",
        );
        check(
          capacity.used + capacity.reserved <= capacity.limit,
          409,
          "storage_limit",
          "Tenant storage allowance has been reached.",
        );
        const current = await tx("products")
          .where({ tenant_id: this.tenant.id, id: product.id })
          .first();
        check(
          current &&
            current.framework === framework &&
            current.framework_config === product.framework_config,
          409,
          "framework_identity_changed",
          "Framework identity changed during publication.",
        );
        let release = await tx<Release>("releases")
          .where({
            tenant_id: this.tenant.id,
            product_id: product.id,
            version: input.version,
          })
          .first();
        if (release) {
          check(
            !release.withdrawn,
            409,
            "release_withdrawn",
            "A withdrawn release cannot acquire new targets.",
          );
          check(
            release.changelog === input.changelog,
            409,
            "release_notes_changed",
            "Release notes are immutable.",
          );
          check(
            !(await tx("release_assets")
              .where({
                tenant_id: this.tenant.id,
                release_id: release.id,
                target: input.target,
              })
              .first()),
            409,
            "target_exists",
            "This release target already exists.",
          );
          release = { ...release, size: Number(release.size) + size };
          await tx("releases")
            .where({ tenant_id: this.tenant.id, id: release.id })
            .update({ size: release.size });
        } else {
          release = {
            tenant_id: this.tenant.id,
            id: randomUUID(),
            product_id: product.id,
            version: input.version,
            changelog: input.changelog,
            published_at: Date.now(),
            withdrawn: 0,
            checksum,
            size,
            min_wp: "",
            min_php: "",
            min_free: "",
            tested: "",
          };
          await tx("releases").insert(release);
        }
        const asset: ReleaseAsset = {
          tenant_id: this.tenant.id,
          id,
          release_id: release.id,
          target: input.target,
          filename: input.filename,
          size,
          checksum,
          sha512,
          signature: input.signature ?? null,
          min_system_version: input.minSystemVersion ?? null,
        };
        await tx("release_assets").insert(asset);
        // Native targets become available independently. Each asset is its own
        // publication transition; withdrawal remains scoped to the release.
        await recordBusinessEvent(
          tx,
          this.tenant.id,
          "release.published",
          asset.id,
          "published",
        );
        await tx("upload_reservations")
          .where({ tenant_id: this.tenant.id, id })
          .delete();
        return { release, asset };
      });
    } catch (error) {
      let removeReservation = true;
      if (attempted)
        try {
          await this.store.delete(this.tenant.id, id);
        } catch {
          removeReservation = false;
        }
      if (removeReservation)
        await this.db("upload_reservations")
          .where({ tenant_id: this.tenant.id, id })
          .delete();
      throw error;
    }
  }
  async latest(
    productId: string,
    target?: string,
  ): Promise<{ release: Release; assets: ReleaseAsset[] } | undefined> {
    const releases = await this.db<Release>("releases")
      .where({ tenant_id: this.tenant.id, product_id: productId, withdrawn: 0 })
      .andWhere("published_at", "<=", Date.now());
    for (const release of releases.sort((a, b) =>
      semver.rcompare(a.version, b.version),
    )) {
      const query = this.db<ReleaseAsset>("release_assets").where({
        tenant_id: this.tenant.id,
        release_id: release.id,
      });
      if (target !== undefined) query.andWhere({ target });
      const assets = await query.orderBy("target");
      if (assets.length) return { release, assets };
    }
    return undefined;
  }
  async open(asset: ReleaseAsset, start = 0, end = Number(asset.size) - 1) {
    check(
      asset.tenant_id === this.tenant.id,
      404,
      "not_found",
      "Asset belongs to another tenant.",
    );
    check(
      this.cache,
      503,
      "artifact_cache_configuration",
      "Verified artifact cache is not configured.",
    );
    return this.cache.open(
      this.store,
      {
        tenantId: this.tenant.id,
        id: asset.id,
        checksum: asset.checksum,
        size: Number(asset.size),
      },
      start,
      end,
    );
  }
  async read(asset: ReleaseAsset): Promise<Buffer> {
    check(
      asset.tenant_id === this.tenant.id,
      404,
      "not_found",
      "Asset belongs to another tenant.",
    );
    check(
      Number.isSafeInteger(Number(asset.size)) &&
        Number(asset.size) > 0 &&
        Number(asset.size) <= MAX_ARTIFACT_BYTES,
      400,
      "invalid_artifact",
      "Invalid artifact size.",
    );
    const bytes = await this.store.get(
      this.tenant.id,
      asset.id,
      asset.checksum,
      Number(asset.size),
    );
    check(
      bytes.length === Number(asset.size) &&
        createHash("sha256").update(bytes).digest("hex") === asset.checksum &&
        createHash("sha512").update(bytes).digest("base64") === asset.sha512,
      503,
      "artifact_integrity",
      "Asset failed integrity verification.",
    );
    return bytes;
  }
}
