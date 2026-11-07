import test from "node:test";
import assert from "node:assert/strict";
import { up, down } from "../src/migrations/010_operations.ts";
import { recordDownload, recordStorageRead, tenantMetrics } from "../src/metrics.ts";
import { Operations } from "../src/operations.ts";
import { operationsFixture, seedOperationLicense } from "./operations-fixtures.test.ts";


test("reporting includes completed jobs and daily email cohorts without mixing workspaces or exposing payloads", async () => operationsFixture(async (db, tenant, other) => {
  const now = Date.UTC(2026, 10, 3, 12);
  await seedOperationLicense(db, tenant, now);
  await seedOperationLicense(db, other, now);
  await db("emails").insert([
    { tenant_id: tenant.id, id: "sent", kind: "license_key", payload: "private", state: "sent", created_at: now - 86400000, attempts: 1 },
    { tenant_id: tenant.id, id: "pending", kind: "lifecycle", payload: "private", state: "pending", created_at: now, attempts: 0 },
    { tenant_id: tenant.id, id: "failed", kind: "license_key", payload: "private", state: "failed", created_at: now, attempts: 12 },
    { tenant_id: tenant.id, id: "old", kind: "license_key", payload: "private", state: "sent", created_at: now - 40 * 86400000, attempts: 1 },
    { tenant_id: other.id, id: "foreign", kind: "license_key", payload: "secret", state: "sent", created_at: now, attempts: 1 },
  ].map(row => ({ ...row, customer_id: `${row.tenant_id}-customer` })));
  const operations = new Operations(db, tenant.id);
  const summary = await operations.summary(now);
  assert.equal(summary.queues.emails!.completed, 2);
  assert.equal(summary.queues.emails!.total, 4);
  assert.equal(summary.queues.emails!.failed, 1);
  const report = await operations.activity(7, now);
  assert.equal(report.days, 7);
  assert.equal(report.daily.length, 7);
  assert.deepEqual(report.daily.at(-2)!.emails, { total: 1, completed: 1, failed: 0, pending: 0 });
  assert.deepEqual(report.daily.at(-1)!.emails, { total: 2, completed: 0, failed: 1, pending: 1 });
  assert.deepEqual(report.emails.map(row => row.id), ["failed", "pending", "sent"]);
  assert.equal(JSON.stringify(report).includes("private"), false);
  assert.equal(JSON.stringify(report).includes("foreign"), false);
  assert.deepEqual((await new Operations(db, other.id).activity(1, now)).daily[0]!.emails, { total: 1, completed: 1, failed: 0, pending: 0 });
  await assert.rejects(operations.activity(0, now));
  await assert.rejects(operations.activity(366, now));
}));

test("migration resumes and preserves counters while refusing rollback", async () => operationsFixture(async db => {
  await up(db); await assert.rejects(down(), /Restore a backup/);
  assert.equal(await db.schema.hasColumn("download_metrics", "served_bytes"), true);
  await assert.rejects(db("outbound_endpoints").insert({ tenant_id: "missing", id: "orphan", url: "https://example.com/", events: "[]", secret_cipher: "cipher", created_at: 1 }));
}));

test("actual response bytes and storage reads count independently and isolate tenants", async () => operationsFixture(async (db, tenant, other) => {
  const now = 1800000000000;
  const a = await seedOperationLicense(db, tenant, now); const b = await seedOperationLicense(db, other, now);
  await recordDownload(db, tenant.id, a.release, now - 40 * 86400000, 100);
  await Promise.all([recordDownload(db, tenant.id, a.release, now, 30), recordDownload(db, tenant.id, a.release, now, 20)]);
  await recordDownload(db, tenant.id, a.release, now);
  await recordStorageRead(db, tenant.id, a.release, 100, now);
  await recordStorageRead(db, tenant.id, a.release, 40, now);
  await recordDownload(db, other.id, b.release, now, 900);
  const m = await tenantMetrics(db, tenant, now);
  assert.equal(m.downloads.successfulResponses, 4); assert.equal(m.downloads.servedBytes, 150);
  assert.equal(m.downloads.last30DaysServedBytes, 50); assert.equal(m.downloads.storageReadBytes, 140); assert.equal(m.downloads.storageReads, 2);
  const daily = await db("download_metrics").where({tenant_id: tenant.id, day: new Date(now).toISOString().slice(0,10)}).first();
  assert.equal(Number(daily.served_bytes), 50);
  await assert.rejects(recordDownload(db, tenant.id, a.release, now, -1));
  await assert.rejects(recordStorageRead(db, tenant.id, a.release, Number.NaN, now));
  await assert.rejects(recordStorageRead(db, other.id, a.release, 10, now));
}));

test("health aggregates queues and persists alert cooldowns without changing paid rights", async () => operationsFixture(async (db, tenant, other) => {
  const now = 1800000000000, ids = await seedOperationLicense(db, tenant, now);
  const service = new Operations(db, tenant.id), foreign = new Operations(db, other.id);
  const defaults = await service.settings(); assert.equal(defaults.notificationsEnabled, true);
  await service.configure({ failureThreshold: 1, pendingAgeMs: 1000, storageRatio: 0.5, bandwidthBytes: 50, cooldownMs: 1000 });
  await db("tenants").where({ id: tenant.id }).update({ max_storage_bytes: 100, billing_status: "past_due" });
  await db("work").insert([{ tenant_id: tenant.id, id: "failed", kind: "test", payload: "{}", state: "failed", created_at: now - 9000 }, { tenant_id: tenant.id, id: "pending", kind: "test", payload: "{}", state:"pending", created_at: now - 2000 }]);
  await db("work").insert({ tenant_id: other.id, id: "other", kind: "test", payload: "{}", state: "failed", created_at: now - 9000 });
  await db("upload_reservations").insert({ tenant_id: tenant.id, id: "reservation", bytes: 5, expires_at: now + 10 });
  await recordDownload(db, tenant.id, ids.release, now, 90); await recordStorageRead(db, tenant.id, ids.release, 100, now);
  const summary = await service.summary(now);
  assert.equal(summary.queues.work!.failed, 1); assert.equal(summary.queues.work!.pending, 1);
  assert.equal(summary.queues.work!.oldestAgeMs, 2000); assert.equal(summary.storage.usedBytes, 100); assert.equal(summary.storage.reservedBytes, 5);
  assert.equal(summary.bandwidth.servedBytes, 90); assert.equal(summary.bandwidth.storageReadBytes, 100);
  const alerts = await service.alerts(now); assert.equal(alerts.length, 5);
  assert.equal((await service.alerts(now + 1)).length, 0);
  await service.forwardAlerts({tenantId:tenant.id,enqueue:async()=>true});
  const races = await Promise.all([service.alerts(now + 1001), service.alerts(now + 1001)]);
  assert.equal(races.flat().length, 5);
  assert.equal((await foreign.alerts(now)).length, 1);
  await service.forwardAlerts({tenantId:tenant.id,enqueue:async()=>true});
  await db("work").where({ tenant_id: tenant.id }).update({state: "sent"});
  await service.configure({storageRatio: 1, bandwidthBytes: 0});
  await db("releases").where({tenant_id:tenant.id}).update({size:0});
  assert.equal((await service.alerts(now+2002)).length, 1);
  assert.equal((await db("licenses").where({id:ids.license}).first()).revoked, 0);
  assert.equal((await service.sellerNotifications(now)).some(n => n.kind === "billing_capacity"), true);
  await assert.rejects(service.configure({failureThreshold: -1})); await assert.rejects(service.configure({ unknown: true }));
}));

test("financial and seat summaries reconcile paid states while byte hooks support existing callers",async()=>operationsFixture(async(db,tenant)=>{
  const now=Date.now(),ids=await seedOperationLicense(db,tenant,now);
  const base=await db("licenses").where({tenant_id:tenant.id,id:ids.license}).first();
  for(const [id,patch] of [["expired",{paid_through:now-1}],["revoked",{revoked:1}],["refunded",{refund_revoked:1}],["suspended",{suspended:1}]] as const)
    await db("licenses").insert({...base,...patch,id,subscription_id:id,key_hash:id});
  for(const [id,exempt] of [["production",0],["development",1]] as const)
    await db("installations").insert({tenant_id:tenant.id,id,license_id:ids.license,installation_id:id,site_url:exempt?"staging.example.com":"example.com",active:1,exempt,token_hash:id,token_cipher:"encrypted"});
  await db("invoice_metrics").insert([{tenant_id:tenant.id,invoice_id:"one",currency:"usd",paid_minor:100,refunded_minor:10},{tenant_id:tenant.id,invoice_id:"two",currency:"usd",paid_minor:50,refunded_minor:0},{tenant_id:tenant.id,invoice_id:"three",currency:"eur",paid_minor:80,refunded_minor:20}]);
  await recordDownload(db,tenant.id,ids.release);await recordStorageRead(db,tenant.id,ids.release,100);
  await db("upload_reservations").insert({tenant_id:tenant.id,id:"reservation",bytes:12,expires_at:now+1000});
  let m=await tenantMetrics(db,tenant,undefined,["staging.example.com"]);
  assert.deepEqual(m.payments,[{currency:"eur",paidMinor:"80",refundedMinor:"20",netMinor:"60"},{currency:"usd",paidMinor:"150",refundedMinor:"10",netMinor:"140"}]);
  assert.equal(m.installations.productionActive,1);assert.equal(m.installations.developmentActive,1);assert.equal(m.licenses.entitled,1);
  await db("releases").where({id:ids.release}).update({withdrawn:1});m=await tenantMetrics(db,tenant);assert.equal(m.releases.withdrawn,1);
  await db("invoice_metrics").where({invoice_id:"two"}).update({paid_minor:-1});await assert.rejects(tenantMetrics(db,tenant),/reconciliation/);
}));
