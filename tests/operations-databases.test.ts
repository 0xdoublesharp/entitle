import test from "node:test";
import assert from "node:assert/strict";
import { operationsFixture,seedOperationLicense } from "./operations-fixtures.test.ts";
import { up } from "../src/migrations/010_operations.ts";
import { Operations } from "../src/operations.ts";
import { recordDownload,recordStorageRead } from "../src/metrics.ts";
import { OutboundWebhooks } from "../src/outbound-webhooks.ts";
for(const variable of ["TEST_POSTGRES_DATABASE_URL","TEST_MYSQL_DATABASE_URL"] as const) test(`operations/outbound real isolated ${variable} queries and migration repair`,{skip:!process.env[variable]},async()=>{
  const previous=process.env.TEST_SAAS_DATABASE_URL;process.env.TEST_SAAS_DATABASE_URL=process.env[variable]!;
  try {await operationsFixture(async(db,tenant)=>{
    await up(db); const now=Date.now(),ids=await seedOperationLicense(db,tenant,now);
    const operations=new Operations(db,tenant.id);await operations.configure({pendingAgeMs:1000});
    await recordDownload(db,tenant.id,ids.release,now,23);await recordStorageRead(db,tenant.id,ids.release,42,now);
    const summary=await operations.summary(now);assert.equal(summary.bandwidth.servedBytes,23);assert.equal(summary.bandwidth.storageReadBytes,42);
    await Promise.all([operations.scanNotifications(now),operations.scanNotifications(now)]);assert.equal((await operations.notifications(ids.customer,now)).length,1);
    await db("sessions").insert({tenant_id:tenant.id,id:"verified",customer_id:ids.customer,expires_at:now+100000});
    assert.equal(await operations.enqueueLifecycleEmails("42".repeat(32),now),1);
    assert.equal(await operations.enqueueLifecycleEmails("42".repeat(32)),0);
    const activity=await operations.activity(7);
    assert.equal(activity.daily.length,7);
    assert.equal(activity.daily.reduce((sum,day)=>sum+day.emails.total,0),1);
    assert.equal(activity.emails.length,1);
    let sent=0;const webhooks=new OutboundWebhooks(db,tenant.id,"42".repeat(32),{network:{resolve:async()=>[{address:"8.8.8.8",family:4}],send:async()=>{sent++;return 204;}}});
    await webhooks.createEndpoint({url:"https://example.com/",events:["license.renewed"]});
    const event={id:"renewal",type:"license.renewed",resourceId:ids.license,occurredAt:now};
    await Promise.all([webhooks.enqueue(event),webhooks.enqueue(event)]);await Promise.all([webhooks.run(),webhooks.run()]);assert.equal(sent,1);
    if(db.client.config.client==="mysql2") {
      await db.raw("ALTER TABLE ?? DROP FOREIGN KEY ??",["outbound_deliveries","outbound_deliveries_tenant_id_endpoint_id_foreign"]);
      await up(db);await assert.rejects(db("outbound_deliveries").where({tenant_id:tenant.id}).update({endpoint_id:"missing"}));
    }
  });} finally {if(previous===undefined) delete process.env.TEST_SAAS_DATABASE_URL;else process.env.TEST_SAAS_DATABASE_URL=previous;}
});
