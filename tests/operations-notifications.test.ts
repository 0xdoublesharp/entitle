import test from "node:test";
import assert from "node:assert/strict";
import { operationsFixture, seedOperationLicense } from "./operations-fixtures.test.ts";
import { Operations } from "../src/operations.ts";

test("lifecycle notices dedupe concurrently, page by tenant, and exclude changed or dismissed rights",async()=>operationsFixture(async(db,tenant,other)=>{
  const now=1800000000000,a=await seedOperationLicense(db,tenant,now),b=await seedOperationLicense(db,other,now);
  const service=new Operations(db,tenant.id),foreign=new Operations(db,other.id);
  const scans=await Promise.all([service.scanNotifications(now,null,1),service.scanNotifications(now,null,1)]);
  assert.equal(scans[0]!.processed,1); assert.equal(scans[0]!.cursor,a.license);
  assert.deepEqual(await service.scanNotifications(now,scans[0]!.cursor),{cursor:null,processed:0});
  assert.equal((await service.notifications(a.customer,now)).length,1);
  assert.equal((await service.notifications(b.customer,now)).length,0);
  assert.equal((await foreign.notifications(a.customer,now)).length,0);
  const first=(await service.notifications(a.customer,now))[0]!;
  assert.equal(first.kind,"expiry_approaching");
  assert.equal(await foreign.dismissNotification(a.customer,first.id),false);
  assert.equal(await service.dismissNotification(b.customer,first.id),false);
  assert.equal(await service.dismissNotification(a.customer,first.id),true);
  await service.scanNotifications(now); assert.equal((await service.notifications(a.customer,now)).length,0);
  await db("licenses").where({tenant_id:tenant.id,id:a.license}).update({paid_through:now+2*86400000,billing_status:"canceled"});
  await service.scanNotifications(now); assert.equal((await service.notifications(a.customer,now))[0]!.kind,"canceled_no_autorenew");
  await db("licenses").where({tenant_id:tenant.id,id:a.license}).update({billing_status:"active"});
  assert.equal((await service.notifications(a.customer,now)).length,0);
  await service.scanNotifications(now); assert.equal((await service.notifications(a.customer,now))[0]!.kind,"expiry_approaching");
  assert.equal((await service.notifications(a.customer,now+3*86400000)).length,0);
  await service.scanNotifications(now+3*86400000); assert.equal((await service.notifications(a.customer,now+3*86400000))[0]!.kind,"expired");
  assert.equal((await service.notifications(a.customer,now))[0]!.kind,"expiry_approaching");
  // No stored address, text payload, email job or quota is created. Anonymization cannot send a stale address.
  await db("customers").where({tenant_id:tenant.id,id:a.customer}).update({email:"erased@anonymized.invalid",stripe_id:null});
  assert.equal((await db("emails").where({tenant_id:tenant.id})).length,0);
  const notice=await db("operation_notifications").where({tenant_id:tenant.id}).first();
  assert.equal("email" in notice,false); assert.equal("payload" in notice,false);
  await service.configure({notificationsEnabled:false});
  assert.equal((await service.notifications(a.customer,now)).length,0);
  assert.deepEqual(await service.scanNotifications(now),{cursor:null,processed:0});
  await assert.rejects(service.scanNotifications(now,null,0));
}));

test("notification scanner skips revoked, zero-duration, distant rights and never returns stale renewal state",async()=>operationsFixture(async(db,tenant)=>{
  const now=1800000000000,a=await seedOperationLicense(db,tenant,now),service=new Operations(db,tenant.id);
  for(const patch of [{revoked:1},{revoked:0,refund_revoked:1},{refund_revoked:0,suspended:1},{suspended:0,paid_through:0},{paid_through:now+100*86400000}]) {
    await db("licenses").where({tenant_id:tenant.id,id:a.license}).update(patch); await service.scanNotifications(now);
    assert.equal((await service.notifications(a.customer,now)).length,0);
  }
  await db("licenses").where({tenant_id:tenant.id,id:a.license}).update({paid_through:now-1});await service.scanNotifications(now);
  assert.equal((await service.notifications(a.customer,now))[0]!.kind,"expired");
  await db("licenses").where({tenant_id:tenant.id,id:a.license}).update({paid_through:now+100*86400000});
  assert.equal((await service.notifications(a.customer,now)).length,0);
  assert.deepEqual(await service.sellerNotifications(now),[]);
  await assert.rejects(new Operations(db,"missing").summary(now),/Tenant not found/);
}));

test("lifecycle email notices require verified current recipients, dedupe atomically and use quota-controlled encrypted outbox",async()=>operationsFixture(async(db,tenant,other)=>{
  const now=Date.now(),a=await seedOperationLicense(db,tenant,now),b=await seedOperationLicense(db,other,now);
  const service=new Operations(db,tenant.id),foreign=new Operations(db,other.id),secret="42".repeat(32);
  await service.scanNotifications(now);assert.equal(await service.enqueueLifecycleEmails(secret,now),0);
  await db("login_tokens").insert({tenant_id:tenant.id,id:"verified",customer_id:a.customer,used:1,expires_at:now-1});
  const counts=await Promise.all([service.enqueueLifecycleEmails(secret,now),service.enqueueLifecycleEmails(secret,now)]);
  assert.equal(counts.reduce((a,b)=>a+b,0),1);assert.equal(await foreign.enqueueLifecycleEmails(secret,now),0);
  const job=await db("emails").where({tenant_id:tenant.id,kind:"lifecycle"}).first();assert.ok(job);assert.equal(job.payload.includes("buyer@example.test"),false);
  const {Outbox}=await import("../src/email.ts");const {unseal}=await import("../src/crypto.ts");
  assert.equal(unseal<{to:string}>(job.payload,secret).to,"buyer@example.test");
  const message = unseal<import("../src/email.ts").Message>(job.payload, secret);
  assert.match(message.html ?? "", /email-content/);
  assert.ok(message.html?.includes(new Date(now + 86400000).toISOString()));
  let sent=0;await new Outbox(db,secret,{send:async()=>{sent++;}},tenant,0).run();assert.equal(sent,0);
  assert.equal((await db("emails").where({tenant_id:tenant.id,id:job.id}).first()).attempts,0);
  await db("emails").where({tenant_id:tenant.id,id:job.id}).update({available_at:0});
  await new Outbox(db,secret,{send:async()=>{sent++;}},tenant,1).run();assert.equal(sent,1);
  assert.equal((await db("emails").where({tenant_id:tenant.id,id:job.id}).first()).payload,"");
  await service.scanNotifications(now);assert.equal(await service.enqueueLifecycleEmails(secret,now),0);
  await db("licenses").where({id:a.license}).update({paid_through:now-1});await service.scanNotifications(now);
  assert.equal(await service.enqueueLifecycleEmails(secret,now),1);
  const expired=await db("emails").where({tenant_id:tenant.id,kind:"lifecycle",state:"pending"}).first();assert.ok(expired);
  await db("emails").where({tenant_id:tenant.id,id:expired.id}).update({state:"failed"});await service.enqueueLifecycleEmails(secret,now);
  assert.equal((await db("emails").where({tenant_id:tenant.id,id:expired.id}).first()).payload,"");
  await db("licenses").where({id:a.license}).update({paid_through:now+2*86400000,billing_status:"canceled"});await service.scanNotifications(now);
  assert.equal(await service.enqueueLifecycleEmails(secret,now),1);
  await db("customers").where({id:a.customer}).update({email:"closed-user@invalid.invalid",stripe_id:null});
  await db("licenses").where({id:a.license}).update({paid_through:now+3*86400000});await service.scanNotifications(now);
  assert.equal(await service.enqueueLifecycleEmails(secret,now),0);
  await foreign.scanNotifications(now);assert.equal((await foreign.notifications(b.customer,now)).length,1);
  await service.configure({notificationsEnabled:false});assert.equal(await service.enqueueLifecycleEmails(secret,now),0);
  await assert.rejects(service.enqueueLifecycleEmails(secret,now,0));
}));
