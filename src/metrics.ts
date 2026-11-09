import type { DB, License, Tenant } from "./db.ts";
import { check } from "./errors.ts";
import { effectiveLicense, entitlementEnd, installationExempt, productActivationKind } from "./licensing.ts";

export async function tenantMetrics(db: DB, tenant: Tenant, now = Date.now(), exemptSuffixes: readonly string[] = []) {
  const licenses = await db<License>("licenses").where({ tenant_id: tenant.id });
  const installations = (await db("installations")
    .join("licenses", function () { this.on("licenses.id", "=", "installations.license_id").andOn("licenses.tenant_id", "=", "installations.tenant_id"); })
    .join("products", function () { this.on("products.id", "=", "licenses.product_id").andOn("products.tenant_id", "=", "licenses.tenant_id"); })
    .where({ "installations.tenant_id": tenant.id, "installations.active": 1 })
    .select("installations.*", "products.framework", "products.framework_config"))
    .map((installation) => ({ ...installation, exempt: installationExempt(installation.site_url, productActivationKind(installation), exemptSuffixes) }));
  const releases = await db("releases").where({ tenant_id: tenant.id });
  const reservations = await db("upload_reservations").where({ tenant_id: tenant.id });
  const entitled = licenses.filter(l => entitlementEnd(l) > now && !l.revoked && !l.refund_revoked && !l.suspended);
  const entitledIds = new Set(entitled.map(l => l.id));
  const used = installations.filter(i => !i.exempt && entitledIds.has(i.license_id)).length;
  let allowance=0;
  for(const license of entitled)allowance+=(await effectiveLicense(license,db,tenant.id,now)).site_allowance;
  const downloads = await db("download_metrics").where({ tenant_id: tenant.id });
  const since = new Date(now - 30 * 86400000).toISOString().slice(0,10);
  const totals = new Map<string, {paid:bigint;refunded:bigint}>();
  for (const invoice of await db("invoice_metrics").where({ tenant_id: tenant.id })) {
    const paid = Number(invoice.paid_minor), refunded = Number(invoice.refunded_minor);
    check(/^[a-z]{3}$/.test(invoice.currency) && Number.isSafeInteger(paid) && paid >= 0 && Number.isSafeInteger(refunded) && refunded >= 0,
      503,"metrics_integrity","Billing metrics require reconciliation.");
    const total = totals.get(invoice.currency) ?? {paid:0n,refunded:0n};
    total.paid += BigInt(paid); total.refunded += BigInt(refunded);
    totals.set(invoice.currency,total);
  }
  return {
    licenses: {issued:licenses.length,entitled:entitled.length,
      expired:licenses.filter(l=>entitlementEnd(l)<=now).length,
      revoked:licenses.filter(l=>l.revoked || l.refund_revoked).length,
      suspended:licenses.filter(l=>l.suspended).length},
    installations: {active:installations.length,productionActive:installations.filter(i=>!i.exempt).length,developmentActive:installations.filter(i=>i.exempt).length},
    seats:{used,allowance,available:Math.max(0,allowance-used)},
    releases:{published:releases.filter(r=>!r.withdrawn && Number(r.published_at)<=now).length,withdrawn:releases.filter(r=>r.withdrawn).length},
    storage:{usedBytes:releases.reduce((sum,r)=>sum+Number(r.size),0),reservedBytes:reservations.reduce((sum,r)=>sum+Number(r.bytes),0),limitBytes:Number(tenant.max_storage_bytes)},
    downloads:{successfulResponses:downloads.reduce((sum,d)=>sum+Number(d.successful_responses),0),last30Days:downloads.filter(d=>d.day>=since).reduce((sum,d)=>sum+Number(d.successful_responses),0),servedBytes:downloads.reduce((sum,d)=>sum+Number(d.served_bytes),0),last30DaysServedBytes:downloads.filter(d=>d.day>=since).reduce((sum,d)=>sum+Number(d.served_bytes),0),storageReadBytes:downloads.reduce((sum,d)=>sum+Number(d.storage_read_bytes),0),storageReads:downloads.reduce((sum,d)=>sum+Number(d.storage_reads),0)},
    payments:[...totals.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([currency,total])=>({currency,paidMinor:String(total.paid),refundedMinor:String(total.refunded),netMinor:String(total.paid-total.refunded)})),
  };
}

export async function recordDownload(db: DB, tenantId: string, releaseId: string, now = Date.now(), bytes = 0) {
  check(Number.isSafeInteger(bytes) && bytes >= 0, 400, "invalid_bytes", "Bytes must be a nonnegative safe integer.");
  await db("download_metrics").insert({tenant_id:tenantId,release_id:releaseId,day:new Date(now).toISOString().slice(0,10),successful_responses:1,served_bytes:bytes})
    .onConflict(["tenant_id","release_id","day"]).merge({successful_responses:db.raw("??.?? + 1",["download_metrics","successful_responses"]),served_bytes:db.raw("??.?? + ?",["download_metrics","served_bytes",bytes])});
}

export async function recordStorageRead(db: DB, tenantId: string, releaseId: string, bytes: number, now = Date.now()) {
  check(Number.isSafeInteger(bytes) && bytes >= 0, 400, "invalid_bytes", "Bytes must be a nonnegative safe integer.");
  await db("download_metrics").insert({tenant_id:tenantId,release_id:releaseId,day:new Date(now).toISOString().slice(0,10),storage_reads:1,storage_read_bytes:bytes})
    .onConflict(["tenant_id","release_id","day"]).merge({storage_reads:db.raw("??.?? + 1",["download_metrics","storage_reads"]),storage_read_bytes:db.raw("??.?? + ?",["download_metrics","storage_read_bytes",bytes])});
}
