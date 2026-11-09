import { recordBusinessEvent } from "./business-events.ts";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { crc32 } from "node:zlib";
import yauzl from "yauzl";
import semver from "semver";
import {
  lock,
  type DB,
  type Release,
  type TenantContext,
  type Tx,
} from "./db.ts";
import { AppError, check } from "./errors.ts";
import {
  requirePublicationTenant,
  type PublicationPolicy,
} from "./publication-policy.ts";
import {
  DEFAULT_ARTIFACT_BYTES,
  MAX_ARTIFACT_BYTES,
  type ArtifactStore,
} from "./storage.ts";
export interface Publication {
  product: string;
  version: string;
  file: string;
  changelog: string;
  minWp: string;
  minPhp: string;
  minFree: string;
  tested: string;
}
// Match WordPress get_file_data on the raw first 8 KiB, including header-shaped
// text in strings/templates: WordPress sees those headers too. Latin1 preserves
// byte-oriented matching and avoids treating Unicode separators as newlines.
function pluginHeaders(bytes: Buffer) {
  const source = bytes.toString("latin1").replace(/\r/g, "\n");
  const header = (label: string) => {
    const value = new RegExp(
      `^(?:[ \\t]*<\\?(?:php)?)?[ \\t/*#@]*${label}:(.*)$`,
      "mi",
    ).exec(source)?.[1];
    return (
      value
        ?.replace(/[ \t\r\n\v\f]*(?:\*\/|\?>).*$/, "")
        .replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, "") ?? ""
    );
  };
  return { name: header("Plugin Name"), version: header("Version") };
}
export async function verifyZip(
  file: string,
  basename: string,
  version: string,
  maxBytes = 25 * 1024 * 1024,
) {
  check(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= 100 * 1024 * 1024,
    400,
    "invalid_zip_limit",
    "ZIP limit must be between 1 byte and 100 MiB.",
  );
  const directory = basename.split("/")[0] + "/";
  const size = (await stat(file)).size;
  check(
    size > 0 && size <= maxBytes,
    400,
    "invalid_zip",
    "ZIP exceeds the configured upload limit or is empty.",
  );
  await new Promise<void>((res, rej) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) {
          rej(error ?? Error("Invalid ZIP"));
          return;
        }
        let count = 0,
          total = 0,
          plugins = 0;
        let expectedPlugin = false;
        const names = new Set<string>();
        const fail = (e: Error) => {
          zip.close();
          rej(e);
        };
        zip.on("error", fail);
        zip.on("end", () =>
          count && plugins === 1 && expectedPlugin
            ? res()
            : rej(Error("ZIP must contain the configured plugin and version")),
        );
        zip.on("entry", (entry: yauzl.Entry) => {
          count++;
          total += entry.uncompressedSize;
          const normalizedName = entry.fileName
            .normalize("NFC")
            .toLowerCase()
            .replace(/\/$/, "");
          const segments = entry.fileName.replace(/\/$/, "").split("/");
          if (
            !entry.fileName.startsWith(directory) ||
            count > 2000 ||
            total > 250 * 1024 * 1024 ||
            entry.isEncrypted() ||
            entry.uncompressedSize >
              Math.max(1024, entry.compressedSize * 100) ||
            entry.fileName.startsWith("/") ||
            entry.fileName.includes("\\") ||
            entry.fileName.includes("\0") ||
            entry.fileName.includes("//") ||
            entry.fileName.split("/").includes(".") ||
            entry.fileName.split("/").includes("..") ||
            /[\p{Cc}:]/u.test(entry.fileName) ||
            segments.some(
              (segment) =>
                /[. ]$/.test(segment) ||
                /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)[ .]*(?:\.|$)/i.test(
                  segment,
                ),
            ) ||
            names.has(normalizedName) ||
            ![0, entry.fileName.endsWith("/") ? 0x4000 : 0x8000].includes(
              (entry.externalFileAttributes >>> 16) & 0xf000,
            )
          ) {
            fail(Error("Unsafe ZIP contents"));
            return;
          }
          names.add(normalizedName);
          if (entry.fileName.endsWith("/")) {
            if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
              fail(Error("Invalid directory entry"));
              return;
            }
            zip.readEntry();
            return;
          }
          zip.openReadStream(entry, (err, stream) => {
            if (err || !stream) {
              fail(err ?? Error("Invalid entry"));
              return;
            }
            let checksum = 0,
              headerSize = 0;
            const headerChunks: Buffer[] = [];
            const rootPhp = /^[^/]+\.php$/.test(
              entry.fileName.slice(directory.length),
            );
            stream.on("data", (chunk: Buffer) => {
              checksum = crc32(chunk, checksum);
              if (rootPhp && headerSize < 8192) {
                const prefix = chunk.subarray(0, 8192 - headerSize);
                headerChunks.push(Buffer.from(prefix));
                headerSize += prefix.length;
              }
            });
            stream.on("error", fail);
            stream.on("end", () => {
              if (checksum !== entry.crc32) {
                fail(Error("ZIP CRC mismatch"));
                return;
              }
              if (rootPhp) {
                const header = pluginHeaders(Buffer.concat(headerChunks));
                if (header.name && header.name !== "0") {
                  plugins++;
                  expectedPlugin =
                    entry.fileName === basename && header.version === version;
                }
              }
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    ),
  );
}
export class Releases {
  db: DB;
  store: ArtifactStore;
  readonly tenant: Readonly<TenantContext>;
  root: string;
  maxBytes: number;
  readonly publicationPolicy: Readonly<PublicationPolicy>;
  constructor(
    db: DB,
    store: ArtifactStore,
    tenant: TenantContext,
    workDir: string,
    maxBytes = DEFAULT_ARTIFACT_BYTES,
    publicationPolicy: PublicationPolicy = { deploymentMode: "hosted" },
  ) {
    this.db = db;
    this.store = store;
    this.tenant = Object.freeze({ ...tenant });
    this.root = resolve(workDir);
    this.maxBytes = maxBytes;
    this.publicationPolicy = Object.freeze({
      deploymentMode: publicationPolicy.deploymentMode,
      graceDays: publicationPolicy.graceDays,
    });
    check(
      Number.isSafeInteger(maxBytes) &&
        maxBytes > 0 &&
        maxBytes <= MAX_ARTIFACT_BYTES,
      500,
      "invalid_upload_limit",
      "Invalid release upload limit.",
    );
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
    input: Publication,
    authorize?: (tx: Tx) => Promise<void>,
  ): Promise<Release> {
    input = { ...input };
    check(
      semver.valid(input.version) === input.version &&
        semver.prerelease(input.version) === null,
      400,
      "invalid_version",
      "Release version must be semantic versioning.",
    );
    for (const value of [
      input.minWp,
      input.minPhp,
      input.minFree,
      input.tested,
    ])
      check(
        /^\d+\.\d+(?:\.\d+)?$/.test(value),
        400,
        "invalid_compatibility",
        "Compatibility versions must be numeric versions.",
      );
    const product = await this.db("products")
      .where({ tenant_id: this.tenant.id, slug: input.product })
      .first();
    check(product, 404, "not_found", "Product not found.");
    check(
      product.framework === "wordpress",
      400,
      "framework_mismatch",
      "This product uses framework assets.",
    );
    check(
      !(await this.db("releases")
        .where({
          tenant_id: this.tenant.id,
          product_id: product.id,
          version: input.version,
        })
        .first()),
      409,
      "version_exists",
      "This product version already exists.",
    );
    const size = (await stat(input.file)).size;
    check(
      size > 0 && size <= this.maxBytes,
      413,
      "upload_limit",
      "Release ZIP exceeds the upload limit or is empty.",
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
        expires_at: Date.now() + 900000,
      });
    });
    let snapshot: string | undefined,
      attempted = false;
    try {
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of createReadStream(input.file)) {
          length += chunk.length;
          check(
            length <= this.maxBytes,
            413,
            "upload_limit",
            "Release ZIP exceeds the upload limit.",
          );
          chunks.push(chunk as Buffer);
        }
        const bytes = Buffer.concat(chunks);
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        snapshot = await mkdtemp(join(this.root, ".verify-"));
        const file = join(snapshot, "release.zip");
        await writeFile(file, bytes, { mode: 0o600, flag: "wx" });
        const basename: string =
          product.plugin_basename ?? `${product.slug}/${product.slug}.php`;
        try {
          await verifyZip(file, basename, input.version, this.maxBytes);
        } catch {
          throw new AppError(
            400,
            "invalid_zip",
            "ZIP integrity or safety validation failed.",
          );
        }
        const checksum = createHash("sha256").update(bytes).digest("hex");
        attempted = true;
        try {
          await this.store.put(this.tenant.id, id, bytes, checksum);
        } catch (error) {
          if (error instanceof AppError && error.code === "artifact_exists")
            attempted = false;
          throw error;
        }
        await this.store.get(this.tenant.id, id, checksum, bytes.length);
        const release: Release = {
          tenant_id: this.tenant.id,
          id,
          product_id: product.id,
          version: input.version,
          changelog: input.changelog,
          published_at: Date.now(),
          withdrawn: 0,
          checksum,
          size: bytes.length,
          min_wp: input.minWp,
          min_php: input.minPhp,
          min_free: input.minFree,
          tested: input.tested,
        };
        await this.db.transaction(async (tx) => {
          await authorize?.(tx);
          await lock(tx, "schema", this.tenant.id);
          const capacity = await this.capacity(tx);
          check(
            capacity.used + capacity.reserved - size + bytes.length <=
              capacity.limit,
            409,
            "storage_limit",
            "Tenant storage allowance has been reached.",
          );
          const current = await tx("products")
            .where({ tenant_id: this.tenant.id, id: product.id })
            .first();
          check(
            current &&
              current.framework === "wordpress" &&
              (current.plugin_basename ??
                `${current.slug}/${current.slug}.php`) === basename,
            409,
            "plugin_identity_changed",
            "Plugin identity changed during publication; retry with the configured plugin.",
          );
          if (current.plugin_basename === null)
            await tx("products")
              .where({ tenant_id: this.tenant.id, id: product.id })
              .update({ plugin_basename: basename });
          await tx("releases").insert(release);
          await recordBusinessEvent(tx, this.tenant.id, "release.published", release.id, "published", release.published_at);
          await tx("upload_reservations")
            .where({ tenant_id: this.tenant.id, id })
            .delete();
        });
        return release;
      } catch (error) {
        let removeReservation = true;
        if (attempted) {
          try {
            await this.store.delete(this.tenant.id, id);
          } catch {
            removeReservation = false;
          }
        }
        if (removeReservation)
          await this.db("upload_reservations")
            .where({ tenant_id: this.tenant.id, id })
            .delete();
        if (
          ["SQLITE_CONSTRAINT_UNIQUE", "23505", "ER_DUP_ENTRY"].includes(
            (error as { code?: string }).code ?? "",
          )
        )
          throw new AppError(
            409,
            "version_exists",
            "This product version already exists.",
          );
        throw error;
      }
    } finally {
      if (snapshot) await rm(snapshot, { recursive: true, force: true });
    }
  }
  async cleanup() {
    const expired = await this.db("upload_reservations")
      .where({ tenant_id: this.tenant.id })
      .andWhere("expires_at", "<", Date.now())
      .limit(20);
    for (const reservation of expired) {
      const published = await this.db("releases")
        .where({ tenant_id: this.tenant.id, id: reservation.id })
        .first();
      const asset = await this.db("release_assets")
        .where({ tenant_id: this.tenant.id, id: reservation.id })
        .first();
      if (!published && !asset)
        await this.store.delete(this.tenant.id, reservation.id);
      await this.db("upload_reservations")
        .where({ tenant_id: this.tenant.id, id: reservation.id })
        .delete();
    }
  }
  async latest(productId: string): Promise<Release | undefined> {
    const rows = await this.db<Release>("releases")
      .where({ tenant_id: this.tenant.id, product_id: productId, withdrawn: 0 })
      .andWhere("published_at", "<=", Date.now());
    return rows.sort((a, b) => semver.rcompare(a.version, b.version))[0];
  }
  async withdraw(id: string) {
    await this.db.transaction(async tx => {
      await lock(tx, "schema", this.tenant.id);
      const release = await tx<Release>("releases").where({ tenant_id: this.tenant.id, id }).first();
      check(release, 404, "not_found", "Release not found.");
      if (release.withdrawn) return;
      await tx("releases").where({ tenant_id: this.tenant.id, id }).update({ withdrawn: 1 });
      await recordBusinessEvent(tx, this.tenant.id, "release.withdrawn", id, "withdrawn");
    });
  }
  async read(release: Release) {
    check(
      release.tenant_id === this.tenant.id,
      404,
      "not_found",
      "Release belongs to another tenant.",
    );
    const product = await this.db("products")
      .where({ tenant_id: this.tenant.id, id: release.product_id })
      .first();
    check(
      product?.framework === "wordpress",
      400,
      "framework_mismatch",
      "This release uses framework assets.",
    );
    return this.store.get(
      this.tenant.id,
      release.id,
      release.checksum,
      Number(release.size),
    );
  }
}
