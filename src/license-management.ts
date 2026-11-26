import { randomUUID } from "node:crypto";
import { z } from "zod";
import { recordBusinessEvent } from "./business-events.ts";
import { lock, type DB, type License, type Plan } from "./db.ts";
import { check } from "./errors.ts";
import {
  effectiveLicense,
  entitlementEnd,
  type Licenses,
} from "./licensing.ts";

const day = 86400000;
const statuses = [
  "active",
  "expiring",
  "expired",
  "pending",
  "canceled",
  "revoked",
  "suspended",
  "lifetime",
] as const;
type LicenseStatus = (typeof statuses)[number];
// Filters can overlap. The display status prioritizes access restrictions.
const displayOrder: readonly LicenseStatus[] = [
  "revoked",
  "suspended",
  "lifetime",
  "expired",
  "canceled",
  "expiring",
  "active",
];

export const licenseFilterSchema = z
  .object({
    productId: z.string().min(1).max(64).optional(),
    provenance: z.enum(["paid", "complimentary"]).optional(),
    status: z.enum(statuses).optional(),
    expiringWithinDays: z.coerce.number().int().min(1).max(90).default(30),
    q: z.string().trim().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    after: z.string().min(1).max(64).optional(),
  })
  .strict();

export const licenseUpdateSchema = z
  .object({
    internalNote: z.string().trim().max(2000).nullable().optional(),
    expiresAt: z.number().int().positive().max(8640000000000000).optional(),
    siteAllowance: z.number().int().min(1).max(100000).optional(),
  })
  .strict()
  .refine(
    ({ internalNote, expiresAt, siteAllowance }) =>
      internalNote !== undefined ||
      expiresAt !== undefined ||
      siteAllowance !== undefined,
    "Provide at least one license update.",
  );

type LicenseFilters = z.infer<typeof licenseFilterSchema>;
type LicenseUpdate = z.infer<typeof licenseUpdateSchema>;
type LicenseActor = { type: "seller" | "api_key"; id: string };
type SellerLicenseRow = License & {
  customer_email: string;
  product_name: string;
  plan_name: string | null;
};

function sellerLicenseRows(db: DB, tenantId: string) {
  return db<SellerLicenseRow>("licenses as l")
    .join("customers as c", function () {
      this.on("c.id", "=", "l.customer_id").andOn(
        "c.tenant_id",
        "=",
        "l.tenant_id",
      );
    })
    .join("products as p", function () {
      this.on("p.id", "=", "l.product_id").andOn(
        "p.tenant_id",
        "=",
        "l.tenant_id",
      );
    })
    .leftJoin("plans as pl", function () {
      this.on("pl.id", "=", "l.plan_id").andOn(
        "pl.tenant_id",
        "=",
        "l.tenant_id",
      );
    })
    .where("l.tenant_id", tenantId)
    .select<SellerLicenseRow[]>("l.*", {
      customer_email: "c.email",
      product_name: "p.name",
      plan_name: "pl.name",
    });
}

function licenseState(
  license: License,
  now: number,
  expiringWithinDays: number,
) {
  const end = entitlementEnd(license);
  const revoked = !!license.revoked || !!license.refund_revoked;
  const suspended = !!license.suspended;
  const lifetime = license.billing_status === "lifetime";
  const canceled = license.billing_status === "canceled";
  const entitled = end > now && !revoked && !suspended;
  return {
    active: entitled,
    expiring: entitled && !lifetime && end <= now + expiringWithinDays * day,
    expired: !revoked && !suspended && !lifetime && end <= now,
    pending: !revoked && !suspended && !lifetime && end <= 0,
    canceled,
    revoked,
    suspended,
    lifetime,
  };
}

async function sellerLicenseSummary(
  db: DB,
  tenantId: string,
  row: SellerLicenseRow,
  state: ReturnType<typeof licenseState>,
  now: number,
) {
  const license = await effectiveLicense(row, db, tenantId, now);
  const plan =
    license.plan_id !== null && license.plan_id !== row.plan_id
      ? (
          await db<Plan>("plans")
            .where({ tenant_id: tenantId, id: license.plan_id })
            .first("name")
        )?.name
      : row.plan_name;
  return {
    id: row.id,
    customer_id: row.customer_id,
    customer_email: row.customer_email,
    product_id: row.product_id,
    product_name: row.product_name,
    plan_id: license.plan_id,
    plan_name: plan ?? "Complimentary",
    provenance: row.provenance ?? "paid",
    billing_status: row.billing_status,
    status: displayOrder.find((status) => state[status]) ?? "expired",
    entitled: state.active,
    site_allowance: license.site_allowance,
    active_installations: 0,
    seats_used: 0,
    paid_through: Number(row.paid_through),
    expires_at: row.expires_at == null ? null : Number(row.expires_at),
    access_ends_at: entitlementEnd(row),
    revoked: state.revoked,
    refund_revoked: row.refund_revoked,
    suspended: state.suspended,
    issued_at: row.issued_at == null ? null : Number(row.issued_at),
    internal_note: row.internal_note ?? null,
  };
}

type SellerLicense = Awaited<ReturnType<typeof sellerLicenseSummary>>;

async function addInstallationCounts(
  db: DB,
  tenantId: string,
  licenses: SellerLicense[],
) {
  if (!licenses.length) return;
  const counts = await db("installations")
    .where({ tenant_id: tenantId, active: 1 })
    .whereIn(
      "license_id",
      licenses.map((row) => row.id),
    )
    .groupBy("license_id")
    .select<
      {
        license_id: string;
        active_installations: number | string;
        seats_used: number | string;
      }[]
    >(
      "license_id",
      db.raw("COUNT(*) AS ??", ["active_installations"]),
      db.raw("SUM(CASE WHEN ?? = 0 THEN 1 ELSE 0 END) AS ??", [
        "exempt",
        "seats_used",
      ]),
    );
  const byId = new Map(counts.map((row) => [row.license_id, row]));
  for (const license of licenses) {
    const count = byId.get(license.id);
    license.active_installations = Number(count?.active_installations ?? 0);
    license.seats_used = Number(count?.seats_used ?? 0);
  }
}

export async function listSellerLicenses(
  db: DB,
  tenantId: string,
  licensing: Pick<Licenses, "tenant">,
  filters: LicenseFilters,
  now = Date.now(),
) {
  check(
    licensing.tenant.id === tenantId,
    500,
    "license_tenant",
    "License tenant mismatch.",
  );
  const query = sellerLicenseRows(db, tenantId).orderBy("l.id");
  if (filters.productId) query.where("l.product_id", filters.productId);
  if (filters.provenance) query.where("l.provenance", filters.provenance);
  const search = filters.q?.toLowerCase();
  const matches: SellerLicense[] = [];
  const batchSize =
    search || filters.status
      ? Math.max(100, filters.limit + 1)
      : filters.limit + 1;
  let cursor = filters.after;
  // Scan bounded batches until there is one matching row beyond the page.
  // Applying the cursor before search also allows matches on the effective plan.
  do {
    const batch = query.clone().limit(batchSize);
    if (cursor !== undefined) batch.where("l.id", ">", cursor);
    const rows = await batch;
    for (const row of rows) {
      const state = licenseState(row, now, filters.expiringWithinDays);
      if (filters.status && !state[filters.status]) continue;
      const license = await sellerLicenseSummary(db, tenantId, row, state, now);
      if (
        search &&
        ![
          license.customer_email,
          license.id,
          license.product_name,
          license.plan_name,
          license.internal_note,
        ].some((value) => value?.toLowerCase().includes(search))
      )
        continue;
      matches.push(license);
      if (matches.length > filters.limit) break;
    }
    cursor = rows.length === batchSize ? rows.at(-1)!.id : undefined;
  } while (cursor !== undefined && matches.length <= filters.limit);
  const licenses = matches.slice(0, filters.limit);
  await addInstallationCounts(db, tenantId, licenses);
  return {
    licenses,
    nextCursor: matches.length > filters.limit ? licenses.at(-1)!.id : null,
  };
}

export function csvCell(value: unknown): string {
  let cell = value == null ? "" : String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(cell)) cell = "'" + cell;
  return /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

export async function exportSellerLicenses(
  db: DB,
  tenantId: string,
  licensing: Pick<Licenses, "tenant">,
  filters: LicenseFilters,
  format: "csv" | "json",
  now = Date.now(),
) {
  const maxRows = 10000;
  const rows: SellerLicense[] = [];
  let after = filters.after;
  do {
    const page = await listSellerLicenses(
      db,
      tenantId,
      licensing,
      { ...filters, after, limit: Math.min(500, maxRows - rows.length) },
      now,
    );
    rows.push(...page.licenses);
    after = page.nextCursor ?? undefined;
  } while (after !== undefined && rows.length < maxRows);
  if (format === "json")
    return { generatedAt: now, count: rows.length, licenses: rows };
  const columns = [
    "id",
    "customer_email",
    "product_name",
    "plan_name",
    "provenance",
    "status",
    "billing_status",
    "site_allowance",
    "active_installations",
    "seats_used",
    "access_ends_at",
    "internal_note",
  ] as const satisfies readonly (keyof SellerLicense)[];
  const header = columns
    .map((column) => csvCell(column === "id" ? "license_id" : column))
    .join(",");
  return (
    [
      header,
      ...rows.map((row) =>
        columns.map((column) => csvCell(row[column])).join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}

export async function updateSellerLicense(
  db: DB,
  tenantId: string,
  licenseId: string,
  input: LicenseUpdate,
  actor: LicenseActor,
  now = Date.now(),
) {
  const { internalNote, expiresAt, siteAllowance } =
    licenseUpdateSchema.parse(input);
  return db.transaction(async (tx) => {
    await lock(tx, "billing", tenantId);
    const scope = { tenant_id: tenantId, id: licenseId };
    const license = await tx<License>("licenses").where(scope).first();
    check(license, 404, "not_found", "License not found.");
    if (expiresAt !== undefined || siteAllowance !== undefined) {
      check(
        license.provenance === "complimentary",
        409,
        "paid_license_immutable",
        "Paid license expiration and allowance are managed by Stripe billing.",
      );
      check(
        expiresAt === undefined || expiresAt > now,
        400,
        "invalid_expiration",
        "License expiration must be in the future.",
      );
    }
    const changes: Partial<License> = {};
    if (internalNote !== undefined) changes.internal_note = internalNote;
    if (expiresAt !== undefined) changes.expires_at = expiresAt;
    if (siteAllowance !== undefined) changes.site_allowance = siteAllowance;
    await tx("licenses")
      .where(scope)
      .increment("lock_version", 1)
      .update(changes);
    await tx("audit_events").insert({
      id: randomUUID(),
      tenant_id: tenantId,
      actor_type: actor.type,
      actor_id: actor.id,
      action: "license.updated",
      details: JSON.stringify({
        license_id: licenseId,
        fields: Object.keys(changes),
      }),
      created_at: now,
    });
    if (expiresAt !== undefined && expiresAt > Number(license.expires_at ?? 0))
      await recordBusinessEvent(
        tx,
        tenantId,
        "license.renewed",
        licenseId,
        `complimentary:${expiresAt}`,
        now,
      );
    const row = await sellerLicenseRows(tx, tenantId)
      .where("l.id", licenseId)
      .first();
    check(row, 404, "not_found", "License not found.");
    const summary = await sellerLicenseSummary(
      tx,
      tenantId,
      row,
      licenseState(row, now, 30),
      now,
    );
    await addInstallationCounts(tx, tenantId, [summary]);
    return summary;
  });
}
