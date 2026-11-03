import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as derive,
} from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  ListObjectsV2Command,
  GetBucketAclCommand,
  GetBucketPolicyCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { lock, tables, type DB, type Tenant, type Tx } from "./db.ts";
import { seal, unseal, hash } from "./crypto.ts";
import { AppError, check } from "./errors.ts";
import {
  exportPrivacyReceipt,
  importPrivacyReceipt,
  type PrivacyScope,
} from "./privacy-attribution.ts";
import {
  hashArtifactFile,
  artifactTransferBudget,
} from "./artifact-streams.ts";
import {
  MAX_ARTIFACT_BYTES,
  MAX_NATIVE_ARTIFACT_BYTES,
  type ArtifactStore,
} from "./storage.ts";
import { frameworks, validateFrameworkConfig } from "./frameworks.ts";

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const identifier = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[A-Za-z0-9_:.-]+$/);
const slug = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const text = z.string().max(1024 * 1024),
  small = z.string().max(500);
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  flag = z.union([z.literal(0), z.literal(1)]);
const checksum = z.string().regex(/^[a-f0-9]{64}$/),
  own = { tenant_id: z.union([uuid, z.literal("primary")]), id: identifier };
const queue = {
  ...own,
  kind: z.string().max(40),
  payload: text,
  state: z.enum(["pending", "running", "failed", "sent", "canceled", "held"]),
  attempts: number,
  available_at: number,
  lease_until: number,
  lease_owner: small.nullable(),
  last_error: small.nullable(),
  created_at: number,
};
const shapes = {
  products: z
    .object({
      ...own,
      id: uuid,
      slug,
      name: z.string().max(200),
      plugin_basename: small.nullable(),
      framework: z.enum(frameworks),
      framework_config: text,
      tax_code: small.nullable(),
    })
    .strict(),
  plans: z
    .object({
      ...own,
      id: uuid,
      product_id: uuid,
      name: z.string().max(150),
      site_allowance: number,
      stripe_price_id: identifier,
    })
    .strict(),
  customers: z
    .object({
      ...own,
      id: uuid,
      email: z.email().max(254),
      stripe_id: identifier.nullable(),
    })
    .strict(),
  licenses: z
    .object({
      ...own,
      id: uuid,
      customer_id: uuid,
      product_id: uuid,
      plan_id: uuid.nullable(),
      site_allowance: number,
      paid_through: number,
      billing_status: z.string().max(40),
      subscription_id: identifier.nullable(),
      provenance: z.enum(["paid", "complimentary"]).default("paid"),
      expires_at: number.positive().nullable().default(null),
      complimentary_request_id: uuid.nullable().default(null),
      complimentary_request_hash: checksum.nullable().default(null),
      issued_by: z.string().min(1).max(64).nullable().default(null),
      issued_at: number.nullable().default(null),
      internal_note: z.string().max(2000).nullable().default(null),
      key_hash: checksum,
      revoked: flag,
      refund_revoked: flag,
      suspended: flag,
      lock_version: number,
    })
    .strict(),
  grants: z
    .object({
      ...own,
      license_id: uuid,
      invoice_id: identifier,
      plan_id: uuid,
      period_start: number,
      period_end: number,
      paid_at: number,
    })
    .strict(),
  installations: z
    .object({
      ...own,
      id: uuid,
      license_id: uuid,
      installation_id: small,
      site_url: small,
      active: flag,
      exempt: flag,
      token_hash: checksum,
      token_cipher: text,
      label: z.string().max(200).nullable(),
    })
    .strict(),
  releases: z
    .object({
      ...own,
      id: uuid,
      product_id: uuid,
      version: z.string().max(60),
      changelog: text,
      published_at: number,
      withdrawn: flag,
      checksum,
      size: number,
      min_wp: z.string().max(60),
      min_php: z.string().max(60),
      min_free: z.string().max(60),
      tested: z.string().max(60),
    })
    .strict(),
  release_assets: z
    .object({
      ...own,
      id: uuid,
      release_id: uuid,
      target: z.string().max(100),
      filename: z.string().max(200),
      size: number,
      checksum,
      sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
      signature: text.nullable(),
      min_system_version: z.string().max(100).nullable(),
    })
    .strict(),
  billing_events: z
    .object({
      ...own,
      type: z.string().max(150),
      payload: text,
      received_at: number,
      processed_at: number.nullable(),
    })
    .strict(),
  work: z.object(queue).strict(),
  emails: z
    .object({
      ...queue,
      customer_id: uuid,
      license_id: uuid.nullable(),
      kind: z.literal("license_key"),
    })
    .strict(),
  invoice_metrics: z
    .object({
      tenant_id: own.tenant_id,
      invoice_id: identifier,
      currency: z.string().regex(/^[a-z]{3}$/),
      paid_minor: number,
      refunded_minor: number,
    })
    .strict(),
  download_metrics: z
    .object({
      tenant_id: own.tenant_id,
      release_id: uuid,
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      successful_responses: number,
      served_bytes: number,
      storage_read_bytes: number,
      storage_reads: number,
    })
    .strict(),
  account_closures: z
    .object({
      tenant_id: own.tenant_id,
      customer_id: uuid,
      id: identifier.max(64),
      status: z.enum(["awaiting_operator", "blocked", "completed"]),
      blockers: text,
      requested_at: number,
      completed_at: number.nullable(),
    })
    .strict(),
  account_privacy_receipts: z
    .object({
      tenant_id: own.tenant_id,
      customer_id: uuid,
      request_id: identifier.max(64),
      id: identifier.max(64),
      details: text,
      created_at: number,
    })
    .strict(),
};
type Table = keyof typeof shapes;
type Row = Record<string, string | number | null>;
const tableNames = Object.keys(shapes) as Table[];
const tenantShape = z
  .object({
    id: own.tenant_id,
    slug,
    name: z.string().max(200),
    stripe_account_id: z.string().regex(/^acct_[A-Za-z0-9]+$/),
    created_at: number,
    automatic_tax: flag,
    collect_tax_id: flag,
    collect_billing_address: flag,
  })
  .strict();
const blobShape = z
  .object({
    id: uuid,
    checksum,
    size: number.positive().max(MAX_NATIVE_ARTIFACT_BYTES),
    sha512: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
    cipherChecksum: checksum,
    cipherSize: number.positive(),
  })
  .strict();
const schema = z
  .object({
    format: z.literal("double-entitle-portability"),
    version: z.literal(1),
    id: uuid,
    createdAt: number,
    tenant: tenantShape,
    tables: z
      .object(
        Object.fromEntries(
          tableNames.map((name) => [name, z.array(shapes[name]).max(100000)]),
        ),
      )
      .strict(),
    blobs: z.array(blobShape).max(10000),
  })
  .strict();
interface Blob {
  id: string;
  checksum: string;
  size: number;
  sha512: string;
  cipherChecksum: string;
  cipherSize: number;
}
interface Manifest {
  format: "double-entitle-portability";
  version: 1;
  id: string;
  createdAt: number;
  tenant: z.infer<typeof tenantShape>;
  tables: Record<Table, Row[]>;
  blobs: Blob[];
}
const magic = Buffer.from("DEPORT01"),
  headerSize = 36,
  overhead = 52;
const bad = () =>
  new AppError(
    400,
    "invalid_bundle",
    "Invalid, altered, unsupported, or incorrectly unlocked portability bundle.",
  );
function valid(value: unknown, code = "invalid_bundle"): asserts value {
  check(value, 400, code, "Invalid portability input or bundle.");
}
function limits(maxBytes: number, maxManifestBytes: number) {
  valid(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= 100 * 1024 ** 3 &&
      Number.isSafeInteger(maxManifestBytes) &&
      maxManifestBytes > 0 &&
      maxManifestBytes <= 64 * 1024 ** 2,
    "portability_configuration",
  );
}
function password(passphrase: string) {
  valid(
    typeof passphrase === "string" &&
      passphrase.length >= 12 &&
      passphrase.length <= 1024,
    "invalid_passphrase",
  );
}
async function keyFor(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    derive(
      passphrase,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}
async function privateRoot(directory: string) {
  valid(isAbsolute(directory), "portability_configuration");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  valid(
    info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0,
    "portability_configuration",
  );
  return directory;
}
function makeCipher(key: Buffer, salt: Buffer, aad: string) {
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`double-entitle:portability:1:${aad}`));
  return { cipher, header: Buffer.concat([magic, salt, nonce]) };
}
async function digestFile(
  file: string,
  max: number,
  progress = () => {},
  signal?: AbortSignal,
) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    valid(before.isFile() && before.size <= max);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal?.throwIfAborted();
      progress();
      size += chunk.length;
      valid(size <= max);
      hash.update(chunk);
    }
    const after = await handle.stat();
    valid(
      size === before.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
    );
    return { checksum: hash.digest("hex"), size };
  } finally {
    await handle.close();
  }
}
async function encryptFile(
  file: string,
  destination: string,
  key: Buffer,
  salt: Buffer,
  id: string,
  progress: () => void,
  signal: AbortSignal,
) {
  const { cipher, header } = makeCipher(key, salt, id);
  await writeFile(destination, header, { flag: "wx", mode: 0o600 });
  cipher.on("data", progress);
  await pipeline(
    createReadStream(file),
    cipher,
    createWriteStream(destination, { flags: "a", mode: 0o600 }),
    { signal },
  );
  const handle = await open(destination, "a");
  try {
    await handle.write(cipher.getAuthTag());
  } finally {
    await handle.close();
  }
}
async function decryptFile(
  file: string,
  destination: string,
  key: Buffer,
  salt: Buffer,
  id: string,
  max: number,
) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    valid(
      info.isFile() && info.size >= overhead && info.size <= max + overhead,
    );
    const header = Buffer.alloc(headerSize),
      tag = Buffer.alloc(16);
    await handle.read(header, 0, headerSize, 0);
    await handle.read(tag, 0, 16, info.size - 16);
    valid(
      header.subarray(0, 8).equals(magic) &&
        header.subarray(8, 24).equals(salt),
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      header.subarray(24, 36),
    );
    decipher.setAAD(Buffer.from(`double-entitle:portability:1:${id}`));
    decipher.setAuthTag(tag);
    await pipeline(
      handle.createReadStream({
        start: headerSize,
        end: info.size - 17,
        autoClose: false,
      }),
      decipher,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
  } finally {
    await handle.close();
  }
}
function validateManifest(input: unknown, maxBytes: number): Manifest {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw bad();
  const manifest = parsed.data as unknown as Manifest;
  let count = 0;
  const sets = {} as Record<Table, Map<string, Row>>;
  for (const table of tableNames) {
    const rows = manifest.tables[table];
    sets[table] = new Map();
    for (const row of rows) {
      valid(row.tenant_id === manifest.tenant.id);
      const id = JSON.stringify(
        table === "account_closures"
          ? [row.customer_id]
          : table === "download_metrics"
            ? [row.release_id, row.day]
            : table === "invoice_metrics"
              ? [row.invoice_id]
              : [row.id],
      );
      valid(!sets[table].has(id));
      sets[table].set(id, row);
      count++;
    }
  }
  valid(count <= 100000);
  const find = (table: Table, id: string | number | null | undefined) =>
    sets[table].get(JSON.stringify([id]));
  for (const row of manifest.tables.products)
    validateFrameworkConfig(
      row.framework as (typeof frameworks)[number],
      JSON.parse(String(row.framework_config)),
    );
  for (const row of manifest.tables.plans)
    valid(find("products", row.product_id));
  for (const row of manifest.tables.licenses) {
    valid(
      find("customers", row.customer_id) && find("products", row.product_id),
    );
    if (row.provenance === "complimentary")
      valid(
        row.plan_id === null &&
          row.subscription_id === null &&
          row.paid_through === 0 &&
          row.billing_status === "complimentary" &&
          Number(row.site_allowance) > 0 &&
          row.expires_at !== null &&
          row.issued_at !== null &&
          row.issued_at! < row.expires_at! &&
          row.issued_by !== null &&
          row.complimentary_request_id !== null &&
          row.complimentary_request_hash !== null,
      );
    else
      valid(
        row.plan_id !== null &&
          row.subscription_id !== null &&
          find("plans", row.plan_id)?.product_id === row.product_id &&
          row.expires_at === null &&
          row.complimentary_request_id === null &&
          row.complimentary_request_hash === null &&
          row.issued_by === null &&
          row.issued_at === null &&
          row.internal_note === null,
      );
  }
  for (const row of manifest.tables.grants)
    valid(
      find("licenses", row.license_id)?.product_id ===
        find("plans", row.plan_id)?.product_id &&
        find("licenses", row.license_id)?.provenance === "paid",
    );
  for (const row of manifest.tables.installations) {
    valid(find("licenses", row.license_id));
    valid(
      row.token_cipher === ""
        ? row.active === 0
        : typeof JSON.parse(String(row.token_cipher)) === "string" &&
            hash(JSON.parse(String(row.token_cipher))) === row.token_hash,
    );
  }
  for (const row of manifest.tables.releases)
    valid(find("products", row.product_id));
  for (const row of manifest.tables.release_assets)
    valid(find("releases", row.release_id));
  for (const row of manifest.tables.emails) {
    valid(
      find("customers", row.customer_id) &&
        find("licenses", row.license_id)?.customer_id === row.customer_id,
    );
    if (row.payload !== "") {
      const message = JSON.parse(String(row.payload));
      valid(
        message &&
          message.to === find("customers", row.customer_id)!.email &&
          typeof message.text === "string",
      );
    }
  }
  for (const row of manifest.tables.download_metrics)
    valid(find("releases", row.release_id));
  for (const row of manifest.tables.work) {
    valid(row.kind === "stripe_event" || row.kind === "reconcile");
    if (row.payload !== "") {
      const payload = JSON.parse(String(row.payload));
      valid(
        row.kind === "stripe_event"
          ? find("billing_events", payload.eventId)
          : identifier.safeParse(payload.subscriptionId).success,
      );
    }
  }
  for (const row of manifest.tables.billing_events)
    valid(
      row.processed_at === null
        ? JSON.parse(String(row.payload)).id === row.id
        : row.payload === "",
    );
  for (const row of manifest.tables.account_privacy_receipts) {
    const closure = find("account_closures", row.customer_id);
    valid(
      closure &&
        closure.id === row.request_id &&
        closure.status === "completed",
    );
    const details = JSON.parse(String(row.details));
    valid(
      typeof details.stripeLiveMode === "boolean" &&
        (details.stripeCustomerId === null ||
          /^cus_[A-Za-z0-9_]{1,146}$/.test(details.stripeCustomerId)),
    );
  }
  for (const row of manifest.tables.account_closures) {
    valid(find("customers", row.customer_id));
    valid(
      z
        .array(small)
        .max(10000)
        .safeParse(JSON.parse(String(row.blockers))).success,
    );
    if (row.status !== "completed") {
      valid(row.completed_at === null);
      continue;
    }
    valid(row.blockers === "[]" && row.completed_at !== null);
    const licenses = manifest.tables.licenses.filter(
      (license) => license.customer_id === row.customer_id,
    );
    valid(
      licenses.every(
        (license) =>
          (license.revoked === 1 || license.refund_revoked === 1) &&
          (!String(license.subscription_id).startsWith("sub_") ||
            ["canceled", "incomplete_expired"].includes(
              String(license.billing_status),
            )),
      ),
    );
    check(
      !licenses.some((license) =>
        String(license.subscription_id).startsWith("sub_"),
      ) ||
        manifest.tables.account_privacy_receipts.some(
          (receipt) =>
            receipt.customer_id === row.customer_id &&
            JSON.parse(String(receipt.details)).stripeCustomerId !== null,
        ),
      409,
      "privacy_attribution_upgrade_required",
      "Run the reviewed closure-attribution-upgrade maintenance command before transfer.",
    );
  }
  const artifacts = artifactRows(manifest.tables),
    ids = new Set<string>();
  let bytes = 0;
  valid(artifacts.length === manifest.blobs.length);
  for (const blob of manifest.blobs) {
    valid(!ids.has(blob.id));
    ids.add(blob.id);
    bytes += blob.cipherSize;
    const row = artifacts.find((row) => row.id === blob.id);
    valid(
      row &&
        row.checksum === blob.checksum &&
        row.size === blob.size &&
        blob.cipherSize === blob.size + overhead,
    );
    if (row.sha512 !== undefined) valid(row.sha512 === blob.sha512);
  }
  valid(
    bytes + Math.max(0, ...manifest.blobs.map((blob) => blob.size)) <= maxBytes,
  );
  return manifest;
}
function artifactRows(rows: Record<Table, Row[]>) {
  const native = new Set(rows.release_assets.map((row) => row.release_id));
  return [
    ...rows.releases.filter((row) => !native.has(row.id)),
    ...rows.release_assets,
  ];
}
function receiptScope(
  row: Row,
  tenantId = String(row.tenant_id),
): PrivacyScope {
  return {
    tenantId,
    customerId: String(row.customer_id),
    requestId: String(row.request_id),
    stripeLiveMode: JSON.parse(String(row.details)).stripeLiveMode,
  };
}
function decryptState(rows: Record<Table, Row[]>, secret: string) {
  for (const row of rows.installations)
    if (row.token_cipher !== "")
      row.token_cipher = JSON.stringify(
        unseal(String(row.token_cipher), secret),
      );
  for (const row of rows.account_privacy_receipts) {
    const details = JSON.parse(String(row.details));
    check(
      details.stripeCustomerAttribution &&
        typeof details.stripeLiveMode === "boolean",
      409,
      "privacy_attribution_upgrade_required",
      "Run the reviewed closure-attribution-upgrade maintenance command before transfer.",
    );
    row.details = exportPrivacyReceipt(
      String(row.details),
      receiptScope(row),
      secret,
    );
  }
  for (const table of ["emails", "work", "billing_events"] as const)
    for (const row of rows[table]) {
      if (
        table === "billing_events"
          ? row.processed_at !== null
          : ["sent", "canceled"].includes(String(row.state))
      )
        row.payload = "";
      else row.payload = JSON.stringify(unseal(String(row.payload), secret));
    }
}
interface ExportEntry {
  tenantId: string;
  directory: string;
  expiresAt: number;
  blobs: string[];
  bytes: number;
  leases: number;
  ready: boolean;
}
export interface PortabilityFailure {
  operation: "cleanup" | "delete" | "create_cleanup" | "close";
  code: "export_cleanup_failed";
}
export interface PortabilityOptions {
  db: DB;
  store: ArtifactStore;
  secret: string;
  directory: string;
  maxBytes?: number;
  maxManifestBytes?: number;
  maxExports?: number;
  ttlMs?: number;
  /** Creation no-progress budget; total also permits maxBytes at 1 MiB/s. */
  timeoutMs?: number;
  sourceStripeAccountId?: string;
  /** Bounded, generic diagnostics. Never receives paths, IDs, secrets or raw errors. */
  onFailure?: (failure: PortabilityFailure) => void;
}
export class Portability {
  private readonly options: Required<PortabilityOptions>;
  private readonly entries = new Map<string, ExportEntry>();
  private closed = false;
  private readonly creations = new Map<
    AbortController,
    Promise<{ id: string; expiresAt: number; blobs: string[] }>
  >();
  constructor(options: PortabilityOptions) {
    this.options = {
      sourceStripeAccountId: "",
      onFailure: () => {},
      maxBytes: 10 * 1024 ** 3,
      maxManifestBytes: 16 * 1024 ** 2,
      maxExports: 4,
      ttlMs: 3600000,
      timeoutMs: 120000,
      ...options,
    };
    limits(this.options.maxBytes, this.options.maxManifestBytes);
    valid(
      isAbsolute(options.directory) &&
        /^[a-f0-9]{64}$/.test(options.secret) &&
        Number.isInteger(this.options.maxExports) &&
        this.options.maxExports >= 2 &&
        this.options.maxBytes <= 10 * 1024 ** 3 &&
        Number.isInteger(this.options.timeoutMs) &&
        this.options.timeoutMs > 0 &&
        this.options.timeoutMs <= 3600000 &&
        this.options.maxExports <= 10 &&
        Number.isInteger(this.options.ttlMs) &&
        this.options.ttlMs > 0 &&
        this.options.ttlMs <= 86400000,
      "portability_configuration",
    );
  }
  createExport(
    tenantId: string,
    passphrase: string,
    signal = new AbortController().signal,
  ) {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const work = this.buildExport(
      tenantId,
      passphrase,
      combined,
      controller,
    ).catch((error: unknown) => {
      check(
        !combined.aborted,
        408,
        "export_aborted",
        "Export creation was interrupted.",
      );
      throw error;
    });
    this.creations.set(controller, work);
    void work.finally(() => this.creations.delete(controller)).catch(() => {});
    return work;
  }
  private async buildExport(
    tenantId: string,
    passphrase: string,
    signal: AbortSignal,
    controller: AbortController,
  ) {
    signal.throwIfAborted();
    password(passphrase);
    valid(own.tenant_id.safeParse(tenantId).success, "invalid_export");
    await this.cleanupExpired();
    check(
      !Array.from(this.entries.values()).some(
        (entry) => entry.tenantId === tenantId,
      ),
      429,
      "export_tenant_held",
      "This tenant already has an export. Recover or delete it from the export list.",
    );
    check(
      !this.closed && this.entries.size < this.options.maxExports,
      429,
      "export_capacity",
      "Export capacity has been reached.",
    );
    const id = randomUUID(),
      entry: ExportEntry = {
        tenantId,
        directory: join(this.options.directory, id),
        expiresAt: Infinity,
        blobs: [],
        bytes: 0,
        leases: 0,
        ready: false,
      };
    signal.throwIfAborted();
    this.entries.set(id, entry);
    const total = setTimeout(
      () => controller.abort(),
      artifactTransferBudget(this.options.maxBytes, this.options.timeoutMs),
    );
    let idle: ReturnType<typeof setTimeout>;
    const progress = () => {
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), this.options.timeoutMs);
    };
    const checkpoint = () => {
      signal.throwIfAborted();
      progress();
    };
    let key: Buffer | undefined;
    let result: { id: string; expiresAt: number; blobs: string[] };
    try {
      checkpoint();
      await privateRoot(this.options.directory);
      await mkdir(entry.directory, { mode: 0o700 });
      const manifest = await this.options.db.transaction(
        async (tx) => {
          for (const name of ["schema", "billing", "work", "email", "auth"])
            await lock(tx, name, tenantId);
          const tenant = await tx("tenants").where({ id: tenantId }).first();
          check(tenant, 404, "tenant_not_found", "Tenant not found.");
          await tx("audit_events").insert({
            id: randomUUID(),
            tenant_id: tenantId,
            actor_type: "system",
            actor_id: null,
            action: "tenant.export.requested",
            details: "{}",
            created_at: Date.now(),
          });
          // Refuse partly reconciled requests before decrypting state or reading
          // artifacts. Finalize must never restore a binding already redacted.
          const pendingReceipt = await tx("account_closures as closure")
            .join("account_privacy_receipts as receipt", function () {
              this.on("closure.tenant_id", "receipt.tenant_id")
                .andOn("closure.customer_id", "receipt.customer_id")
                .andOn("closure.id", "receipt.request_id");
            })
            .where({ "closure.tenant_id": tenantId })
            .whereNot("closure.status", "completed")
            .first("receipt.id");
          check(
            !pendingReceipt,
            409,
            "closure_reconciliation_pending",
            "An operator must finish the pending customer closure privacy review before exporting this tenant.",
          );
          const selected = Object.keys(tenantShape.shape),
            source = Object.fromEntries(
              selected.map((name) => [name, tenant[name]]),
            );
          source.stripe_account_id =
            tenant.stripe_account_id ??
            (tenantId === "primary" ? this.options.sourceStripeAccountId : "");
          check(
            source.stripe_account_id,
            409,
            "merchant_required",
            "A verified source Stripe merchant account is required for portability.",
          );
          const rows = {} as Record<Table, Row[]>;
          let metadataBytes = Buffer.byteLength(JSON.stringify(source)) + 1024,
            totalRows = 0;
          for (const table of tableNames) {
            checkpoint();
            rows[table] = [];
            const keys =
              table === "account_closures"
                ? ["customer_id"]
                : table === "download_metrics"
                  ? ["release_id", "day"]
                  : table === "invoice_metrics"
                    ? ["invoice_id"]
                    : ["id"];
            let previous: Row | undefined;
            for (;;) {
              checkpoint();
              const query = tx(table)
                .where({ tenant_id: tenantId })
                .select(Object.keys(shapes[table].shape))
                .orderBy(keys)
                .first();
              if (table === "emails") query.andWhere({ kind: "license_key" });
              if (previous) {
                const cursor = previous;
                query.andWhere(function () {
                  this.where(keys[0]!, ">", cursor[keys[0]!]!);
                  if (keys.length === 2)
                    this.orWhere(function () {
                      this.where(keys[0]!, cursor[keys[0]!]!).andWhere(
                        keys[1]!,
                        ">",
                        cursor[keys[1]!]!,
                      );
                    });
                });
              }
              const row = await query;
              if (!row) break;
              metadataBytes += Buffer.byteLength(JSON.stringify(row)) + 1;
              totalRows++;
              check(
                metadataBytes <= this.options.maxManifestBytes &&
                  totalRows <= 100000,
                413,
                "export_limit",
                "Export manifest exceeds the configured limit.",
              );
              rows[table].push(row);
              previous = row;
            }
          }
          const artifactCount = artifactRows(rows).length;
          check(
            metadataBytes + artifactCount * 512 <=
              this.options.maxManifestBytes,
            413,
            "export_limit",
            "Export manifest exceeds the configured limit.",
          );
          decryptState(rows, this.options.secret);
          return {
            format: "double-entitle-portability",
            version: 1,
            id,
            createdAt: Date.now(),
            tenant: source,
            tables: rows,
            blobs: [],
          } as unknown as Manifest;
        },
        this.options.db.client.config.client === "better-sqlite3"
          ? {}
          : { isolationLevel: "repeatable read" },
      );
      checkpoint();
      const artifacts = artifactRows(manifest.tables);
      valid(artifacts.length <= 10000);
      const allocation =
        artifacts.reduce((sum, row) => sum + Number(row.size) + overhead, 0) +
        Math.max(0, ...artifacts.map((row) => Number(row.size))) +
        this.options.maxManifestBytes +
        overhead;
      check(
        Number.isSafeInteger(allocation) &&
          allocation +
            Array.from(this.entries.values()).reduce(
              (sum, item) => sum + item.bytes,
              0,
            ) <=
            this.options.maxBytes,
        413,
        "export_limit",
        "Export exceeds the configured storage budget.",
      );
      entry.bytes = allocation;
      const salt = randomBytes(16);
      key = await keyFor(passphrase, salt);
      checkpoint();
      for (const row of artifacts) {
        valid(
          uuid.safeParse(row.id).success &&
            checksum.safeParse(row.checksum).success &&
            number.positive().max(MAX_NATIVE_ARTIFACT_BYTES).safeParse(row.size)
              .success,
        );
        const plain = join(entry.directory, randomUUID() + ".plain"),
          encrypted = join(entry.directory, `${row.id}.blob`);
        if (this.options.store.getToFile)
          await this.options.store.getToFile(
            tenantId,
            String(row.id),
            String(row.checksum),
            Number(row.size),
            plain,
            signal,
            progress,
          );
        else {
          check(
            Number(row.size) <= MAX_ARTIFACT_BYTES,
            503,
            "streaming_storage_required",
            "Streaming storage is required for large artifacts.",
          );
          await writeFile(
            plain,
            await this.options.store.get(
              tenantId,
              String(row.id),
              String(row.checksum),
              Number(row.size),
            ),
            { flag: "wx", mode: 0o600 },
          );
        }
        checkpoint();
        const verified = await hashArtifactFile(
          plain,
          Number(row.size),
          progress,
          signal,
        );
        valid(verified.checksum === row.checksum);
        await encryptFile(
          plain,
          encrypted,
          key,
          salt,
          String(row.id),
          progress,
          signal,
        );
        await rm(plain);
        const cipher = await digestFile(
          encrypted,
          Number(row.size) + overhead,
          progress,
          signal,
        );
        manifest.blobs.push({
          id: String(row.id),
          size: Number(row.size),
          checksum: verified.checksum,
          sha512: verified.sha512,
          cipherChecksum: cipher.checksum,
          cipherSize: cipher.size,
        });
      }
      checkpoint();
      validateManifest(manifest, this.options.maxBytes);
      const bytes = Buffer.from(JSON.stringify(manifest));
      check(
        bytes.length <= this.options.maxManifestBytes,
        413,
        "export_limit",
        "Export manifest exceeds the configured limit.",
      );
      const { cipher, header } = makeCipher(key, salt, "manifest");
      await writeFile(
        join(entry.directory, "manifest.entitle"),
        Buffer.concat([
          header,
          cipher.update(bytes),
          cipher.final(),
          cipher.getAuthTag(),
        ]),
        { flag: "wx", mode: 0o600 },
      );
      checkpoint();
      entry.bytes =
        manifest.blobs.reduce((sum, blob) => sum + blob.cipherSize, 0) +
        bytes.length +
        overhead;
      entry.blobs = manifest.blobs.map((blob) => blob.id);
      entry.expiresAt = Date.now() + this.options.ttlMs;
      entry.ready = true;
      result = { id, expiresAt: entry.expiresAt, blobs: [...entry.blobs] };
    } catch (error) {
      // Keep failed cleanup charged and eligible for the next cleanup pass.
      if (!(await this.removeEntry(id, entry, "create_cleanup")))
        throw new AppError(
          503,
          "export_cleanup_failed",
          "Export cleanup requires an operator retry.",
        );
      throw error;
    } finally {
      clearTimeout(total);
      clearTimeout(idle!);
      key?.fill(0);
    }
    return result;
  }
  private entry(tenantId: string, id: string) {
    valid(uuid.safeParse(id).success, "invalid_export");
    const entry = this.entries.get(id);
    check(
      entry?.tenantId === tenantId &&
        entry.ready &&
        entry.expiresAt > Date.now(),
      404,
      "export_not_found",
      "Export is unavailable or expired.",
    );
    return entry;
  }
  async openExport(tenantId: string, id: string, fileId: string) {
    const entry = this.entry(tenantId, id);
    check(
      fileId === "manifest" || entry.blobs.includes(fileId),
      404,
      "export_not_found",
      "Export file not found.",
    );
    // Count pending opens before yielding so unlink cannot release pinned bytes.
    entry.leases++;
    let handle;
    try {
      handle = await open(
        join(
          entry.directory,
          fileId === "manifest" ? "manifest.entitle" : `${fileId}.blob`,
        ),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      entry.leases--;
      throw error;
    }
    const stream = handle.createReadStream();
    // Only close releases the descriptor's disk blocks; end can precede close.
    stream.once("close", () => {
      entry.leases--;
    });
    return stream;
  }
  listExports(tenantId: string) {
    return Array.from(this.entries, ([id, entry]) => ({ id, entry }))
      .filter(({ entry }) => entry.tenantId === tenantId)
      .map(({ id, entry }) => ({
        id,
        status:
          entry.expiresAt === 0
            ? ("cleanup_pending" as const)
            : !entry.ready
              ? ("creating" as const)
              : ("ready" as const),
        expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : null,
        blobs:
          entry.ready && entry.expiresAt > Date.now() ? [...entry.blobs] : [],
      }));
  }
  private async removeEntry(
    id: string,
    entry: ExportEntry,
    operation: PortabilityFailure["operation"],
  ) {
    entry.expiresAt = 0;
    try {
      await rm(entry.directory, { recursive: true, force: true });
      this.entries.delete(id);
      return true;
    } catch {
      try {
        this.options.onFailure({ operation, code: "export_cleanup_failed" });
      } catch {
        /* Diagnostics cannot interrupt shared maintenance. */
      }
      return false;
    }
  }
  async deleteExport(tenantId: string, id: string) {
    valid(uuid.safeParse(id).success, "invalid_export");
    const entry = this.entries.get(id);
    check(
      entry?.tenantId === tenantId,
      404,
      "export_not_found",
      "Export is unavailable or expired.",
    );
    check(
      entry.leases === 0 && Number.isFinite(entry.expiresAt),
      409,
      "export_busy",
      "Export is still being created or downloaded.",
    );
    check(
      await this.removeEntry(id, entry, "delete"),
      503,
      "export_cleanup_failed",
      "Export cleanup requires an operator retry.",
    );
  }
  async cleanupExpired() {
    for (const [id, entry] of this.entries)
      if (entry.expiresAt <= Date.now() && entry.leases === 0)
        await this.removeEntry(id, entry, "cleanup");
  }
  async close() {
    this.closed = true;
    for (const controller of this.creations.keys()) controller.abort();
    await Promise.allSettled(this.creations.values());
    for (const [id, entry] of this.entries)
      await this.removeEntry(id, entry, "close");
  }
}
export interface PortabilityImportOptions {
  db: DB;
  store: ArtifactStore;
  secret: string;
  directory: string;
  bundleDirectory: string;
  passphrase: string;
  expectedStripeAccountId: string;
  deploymentMode: "standalone";
  verifyDestinationEmpty: () => Promise<void>;
  maxBytes?: number;
  maxManifestBytes?: number;
}
export interface PortabilityImportResult {
  tenant: Tenant;
  requiresReconciliation: true;
  subscriptionIds: string[];
  pendingEventIds: string[];
  sourceStripeAccountId: string;
}
async function fresh(tx: Tx) {
  check(
    !(await tx("locks").where("id", "like", "primary:portability:%").first()),
    409,
    "destination_busy",
    "An imported database cannot be imported again.",
  );
  const tenants = await tx("tenants");
  check(
    tenants.length === 1 &&
      tenants[0].id === "primary" &&
      !tenants[0].stripe_account_id &&
      !tenants[0].platform_customer_id &&
      !tenants[0].platform_subscription_id,
    409,
    "destination_busy",
    "Import requires a fresh standalone database.",
  );
  for (const table of tables)
    check(
      !(await tx(table).first()),
      409,
      "destination_busy",
      "Import requires an empty standalone database.",
    );
}
const marker = (account: string) => `primary:portability:${hash(account)}`;
function subscriptionIds(licenses: Row[], work: Row[], closures: Row[]) {
  const closedCustomers = new Set(
    closures
      .filter((row) => row.status === "completed")
      .map((row) => row.customer_id),
  );
  const closedSubscriptions = new Set(
    licenses
      .filter((row) => closedCustomers.has(row.customer_id))
      .map((row) => row.subscription_id),
  );
  return [
    ...new Set([
      ...licenses
        .filter(
          (row) =>
            row.provenance !== "complimentary" &&
            !closedCustomers.has(row.customer_id),
        )
        .map((row) => row.subscription_id),
      ...work
        .filter((row) => row.kind === "reconcile" && row.payload !== "")
        .map((row) => JSON.parse(String(row.payload)).subscriptionId as string),
    ]),
  ]
    .filter(
      (id): id is string =>
        typeof id === "string" && id.length > 0 && !closedSubscriptions.has(id),
    )
    .sort();
}
async function unpackBlob(
  directory: string,
  working: string,
  blob: Blob,
  key: Buffer,
  salt: Buffer,
) {
  try {
    const source = join(directory, `${blob.id}.blob`),
      digest = await digestFile(source, blob.cipherSize);
    valid(
      digest.checksum === blob.cipherChecksum &&
        digest.size === blob.cipherSize,
    );
    const file = join(working, blob.id);
    await decryptFile(source, file, key, salt, blob.id, blob.size);
    const verified = await hashArtifactFile(file, blob.size);
    valid(
      verified.checksum === blob.checksum && verified.sha512 === blob.sha512,
    );
    return file;
  } catch {
    throw bad();
  }
}
export async function importPortability(
  options: PortabilityImportOptions,
): Promise<PortabilityImportResult> {
  const maxBytes = options.maxBytes ?? 10 * 1024 ** 3,
    maxManifestBytes = options.maxManifestBytes ?? 16 * 1024 ** 2;
  limits(maxBytes, maxManifestBytes);
  password(options.passphrase);
  valid(
    options.deploymentMode === "standalone" &&
      /^[a-f0-9]{64}$/.test(options.secret) &&
      /^acct_[A-Za-z0-9]+$/.test(options.expectedStripeAccountId),
    "portability_configuration",
  );
  await privateRoot(options.directory);
  const folder = await lstat(options.bundleDirectory);
  valid(folder.isDirectory() && !folder.isSymbolicLink());
  const working = await mkdtemp(join(options.directory, "import-")),
    created: string[] = [];
  let key: Buffer | undefined, salt: Buffer | undefined;
  let result: PortabilityImportResult;
  try {
    let manifest: Manifest;
    try {
      const file = join(options.bundleDirectory, "manifest.entitle");
      const handle = await open(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        valid(info.isFile() && info.size <= maxManifestBytes + overhead);
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          valid(bytesRead > 0);
          offset += bytesRead;
        }
        const after = await handle.stat();
        valid(
          after.size === info.size &&
            after.mtimeMs === info.mtimeMs &&
            after.ctimeMs === info.ctimeMs,
        );
      } finally {
        await handle.close();
      }
      valid(bytes.length >= overhead && bytes.subarray(0, 8).equals(magic));
      salt = bytes.subarray(8, 24);
      key = await keyFor(options.passphrase, salt);
      // Manifest plaintext stays in bounded memory; artifact staging holds one file.
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(24, 36),
      );
      decipher.setAAD(Buffer.from("double-entitle:portability:1:manifest"));
      decipher.setAuthTag(bytes.subarray(-16));
      manifest = validateManifest(
        JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(headerSize, -16)),
            decipher.final(),
          ]).toString("utf8"),
        ),
        maxBytes - bytes.length,
      );
      check(
        manifest.tenant.stripe_account_id === options.expectedStripeAccountId,
        409,
        "merchant_mismatch",
        "Destination direct Stripe account must match the exported merchant account.",
      );
      for (const row of manifest.tables.account_privacy_receipts)
        row.details = importPrivacyReceipt(
          String(row.details),
          receiptScope(row, "primary"),
          options.secret,
        );
      for (const blob of manifest.blobs) {
        const file = await unpackBlob(
          options.bundleDirectory,
          working,
          blob,
          key,
          salt,
        );
        await rm(file);
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "merchant_mismatch")
        throw error;
      throw bad();
    }
    await options.db.transaction(async (tx) => {
      await lock(tx, "schema", "primary");
      await fresh(tx);
    });
    await options.store.ready();
    await options.verifyDestinationEmpty();
    const tenant = await options.db.transaction(async (tx) => {
      await lock(tx, "schema", "primary");
      await fresh(tx);
      for (const blob of manifest.blobs) {
        // Reauthenticate on use: the operator's bundle may have changed after preflight.
        const file = await unpackBlob(
          options.bundleDirectory,
          working,
          blob,
          key!,
          salt!,
        );
        if (options.store.putFile)
          await options.store.putFile(
            "primary",
            blob.id,
            file,
            blob.checksum,
            blob.size,
          );
        else {
          check(
            blob.size <= MAX_ARTIFACT_BYTES,
            503,
            "streaming_storage_required",
            "Streaming storage is required for large artifacts.",
          );
          await options.store.put(
            "primary",
            blob.id,
            await readFile(file),
            blob.checksum,
          );
        }
        created.push(blob.id);
        await rm(file);
        const verify = join(working, `${blob.id}.verify`);
        if (options.store.getToFile)
          await options.store.getToFile(
            "primary",
            blob.id,
            blob.checksum,
            blob.size,
            verify,
          );
        else
          await writeFile(
            verify,
            await options.store.get(
              "primary",
              blob.id,
              blob.checksum,
              blob.size,
            ),
            { flag: "wx", mode: 0o600 },
          );
        const digest = await hashArtifactFile(verify, blob.size);
        valid(
          digest.checksum === blob.checksum && digest.sha512 === blob.sha512,
        );
        await rm(verify);
      }
      const source = manifest.tenant;
      await tx("tenants")
        .where({ id: "primary" })
        .update({
          slug: source.slug,
          name: source.name,
          created_at: source.created_at,
          automatic_tax: source.automatic_tax,
          collect_tax_id: source.collect_tax_id,
          collect_billing_address: source.collect_billing_address,
          stripe_account_id: null,
          stripe_status: "platform",
          exempt: 1,
          suspended: 1,
          max_products: Math.max(20, manifest.tables.products.length),
          max_storage_bytes: Math.max(
            1024 ** 3,
            manifest.blobs.reduce((n, b) => n + b.size, 0),
          ),
          billing_status: "active",
        });
      for (const table of tableNames)
        for (const original of manifest.tables[table]) {
          const row: Row = { ...original, tenant_id: "primary" };
          if (table === "installations" && row.token_cipher !== "")
            row.token_cipher = seal(
              JSON.parse(String(row.token_cipher)),
              options.secret,
            );
          if (
            ["emails", "work", "billing_events"].includes(table) &&
            row.payload !== ""
          )
            row.payload = seal(JSON.parse(String(row.payload)), options.secret);
          if (table === "work" || table === "emails") {
            if (!["sent", "canceled"].includes(String(row.state)))
              row.state = "held";
            row.lease_owner = null;
            row.lease_until = 0;
          }
          await tx(table).insert(row);
        }
      await tx("locks").insert({
        id: marker(options.expectedStripeAccountId),
        version: 1,
      });
      return (await tx<Tenant>("tenants").where({ id: "primary" }).first())!;
    });
    result = {
      tenant,
      requiresReconciliation: true,
      subscriptionIds: subscriptionIds(
        manifest.tables.licenses,
        manifest.tables.work,
        manifest.tables.account_closures,
      ),
      pendingEventIds: manifest.tables.billing_events
        .filter((row) => row.processed_at === null)
        .map((row) => String(row.id)),
      sourceStripeAccountId: manifest.tenant.stripe_account_id,
    };
  } catch (error) {
    const failed: string[] = [];
    for (const id of created)
      try {
        await options.store.delete("primary", id);
      } catch {
        failed.push(id);
      }
    if (failed.length)
      throw new AppError(
        503,
        "import_cleanup_failed",
        `Import failed. Operator must remove task-created primary artifact IDs: ${failed.join(", ")}`,
      );
    throw error;
  } finally {
    key?.fill(0);
    await rm(working, { recursive: true, force: true });
  }
  return result;
}
export interface PortabilityReconciliation {
  subscriptionIds: string[];
  pendingEventIds: string[];
}
export async function completePortabilityImport(options: {
  db: DB;
  secret: string;
  expectedStripeAccountId: string;
  reconcile: (required: PortabilityReconciliation) => Promise<void>;
}) {
  const status = await options
    .db("locks")
    .where({ id: marker(options.expectedStripeAccountId), version: 1 })
    .first();
  check(
    status,
    409,
    "import_not_pending",
    "No import is awaiting reconciliation for this merchant.",
  );
  const licenses = await options.db("licenses").where({ tenant_id: "primary" }),
    events = await options
      .db("billing_events")
      .where({ tenant_id: "primary", processed_at: null });
  const work = await options
    .db("work")
    .where({ tenant_id: "primary", state: "held" });
  for (const row of work)
    row.payload = JSON.stringify(unseal(row.payload, options.secret));
  const closures = await options
    .db("account_closures")
    .where({ tenant_id: "primary", status: "completed" });
  await options.reconcile({
    subscriptionIds: subscriptionIds(licenses, work, closures),
    pendingEventIds: events.map((row) => row.id).sort(),
  });
  await options.db.transaction(async (tx) => {
    await lock(tx, "schema", "primary");
    check(
      !(await tx("billing_events")
        .where({ tenant_id: "primary", processed_at: null })
        .first()),
      409,
      "reconciliation_required",
      "Reconcile every pending billing receipt before enabling traffic.",
    );
    check(
      await tx("locks")
        .where({ id: status.id, version: 1 })
        .update({ version: 2 }),
      409,
      "import_not_pending",
      "Import has already been finalized.",
    );
    await tx("billing_events")
      .where({ tenant_id: "primary" })
      .update({ payload: "" });
    await tx("work")
      .where({ tenant_id: "primary", state: "held" })
      .update({ state: "canceled", payload: "", last_error: null });
    await tx("emails")
      .where({ tenant_id: "primary", state: "held" })
      .update({ state: "pending", available_at: 0, last_error: null });
    await tx("tenants").where({ id: "primary" }).update({ suspended: 0 });
  });
}

// A conservative preflight: private owner-only ACL, no bucket policy, no objects.
// The operator supplies a configured SDK client; no request URL is accepted.
export async function verifyEmptyPrivatePortabilityBucket(
  client: Pick<S3Client, "send">,
  bucket: string,
) {
  valid(
    /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket),
    "portability_configuration",
  );
  const acl = await client.send(new GetBucketAclCommand({ Bucket: bucket }));
  check(
    typeof acl.Owner?.ID === "string" &&
      acl.Grants?.length &&
      acl.Grants.every(
        (grant) =>
          grant.Grantee?.Type === "CanonicalUser" &&
          (grant.Grantee.ID ?? "") === acl.Owner!.ID &&
          grant.Permission === "FULL_CONTROL",
      ),
    409,
    "destination_storage_public",
    "Destination bucket must have a private owner-only ACL.",
  );
  try {
    await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
  } catch (error) {
    if ((error as { name?: string }).name !== "NoSuchBucketPolicy") throw error;
    const listing = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }),
    );
    check(
      listing.KeyCount === 0 && !listing.Contents?.length,
      409,
      "destination_storage_busy",
      "Destination bucket must be empty.",
    );
    return;
  }
  throw new AppError(
    409,
    "destination_storage_policy",
    "Use an empty private bucket without a bucket policy for import.",
  );
}
