import test from "node:test";
import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { createWebhookNetwork, OutboundWebhooks } from "../src/outbound-webhooks.ts";
import { operationsFixture } from "./operations-fixtures.test.ts";
const secret="42".repeat(32), publicAddress={address:"8.8.8.8",family:4};

test("resolver cancellation bounds a DNS query even when the injected resolver never settles",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let canceled=0;
  const network=createWebhookNetwork(undefined,{dnsTimeoutMs:50,resolverFactory:()=>({resolve4:()=>new Promise(()=>{}),resolve6:()=>new Promise(()=>{}),cancel:()=>{canceled++;}})});
  const result=network.resolve("blocked.example");const failed=assert.rejects(result,/DNS/);
  t.mock.timers.tick(50);await failed;assert.equal(canceled,1);
});
test("resolver uses both address families and refuses partial DNS failures",async()=>{
  let canceled=0;
  const missing=Object.assign(Error("not found"),{code:"ENODATA"});
  const options={resolverFactory:()=>({resolve4:async()=>["8.8.8.8"],resolve6:async():Promise<string[]>=>{throw missing;},cancel:()=>{canceled++;}})};
  assert.deepEqual(await createWebhookNetwork(undefined,options).resolve("public.example"),[publicAddress]);
  missing.code="ENOTFOUND";assert.deepEqual(await createWebhookNetwork(undefined,options).resolve("public.example"),[publicAddress]);
  missing.code="ETIMEOUT";await assert.rejects(createWebhookNetwork(undefined,options).resolve("public.example"));assert.equal(canceled,1);
  const controller=new AbortController();controller.abort();
  await assert.rejects(createWebhookNetwork(undefined,options).resolve("public.example",controller.signal),/DNS/);
  assert.equal(canceled,2);
});
test("default Resolver path avoids the OS lookup pool and preserves IPv6 answers",async t=>{
  t.mock.method(Resolver.prototype,"resolve4",async()=>["8.8.8.8"]);
  t.mock.method(Resolver.prototype,"resolve6",async()=>["2606:4700:4700::1111"]);
  assert.deepEqual(await createWebhookNetwork().resolve("public.example"),[publicAddress,{address:"2606:4700:4700::1111",family:6}]);
});
for(const phase of ["DNS","transport"] as const) test(`batch budget bounds blocked ${phase} and leaves unattempted rows durable`,async t=>operationsFixture(async(db,tenant)=>{
  let block=false,sent=0,entered:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const service=new OutboundWebhooks(db,tenant.id,secret,{runBudgetMs:50,network:{
    resolve:async()=>{if(block && phase==="DNS"){entered();await new Promise(()=>{});}return [publicAddress];},
    send:async()=>{sent++;if(block && phase==="transport"){entered();await new Promise(()=>{});}return 204;},
  }});
  await service.createEndpoint({url:"https://public.example/",events:["license.created"]});
  for(const id of ["one","two"]) await service.enqueue({id,type:"license.created",resourceId:"license",occurredAt:Date.now()});
  t.mock.timers.enable({apis:["setTimeout"]});block=true;
  const run=service.run();await started;t.mock.timers.tick(50);await run;
  const rows=await service.deliveries();assert.equal(rows.length,2);
  assert.equal(rows.reduce((sum,row)=>sum+row.attempts,0),0);
  assert.equal(rows.every(row=>row.state==="pending"),true);assert.equal(sent,phase==="DNS"?0:1);
  assert.ok(rows.every(row=>row.lastError===null));
  await assert.rejects(service.run(1,0));await assert.rejects(service.run(1,20001));
}));

test("an active batch signal immediately cancels its resolver and clears its timer",async()=>{
  let canceled=0;
  const controller=new AbortController();
  const network=createWebhookNetwork(undefined,{resolverFactory:()=>({resolve4:()=>new Promise(()=>{}),resolve6:()=>new Promise(()=>{}),cancel:()=>{canceled++;}})});
  const result=network.resolve("blocked.example",controller.signal),failed=assert.rejects(result,/DNS/);
  controller.abort();await failed;assert.equal(canceled,1);
  assert.throws(()=>createWebhookNetwork(undefined,{dnsTimeoutMs:0}),/DNS timeout/);
  assert.throws(()=>new OutboundWebhooks({} as never,"tenant",secret,{runBudgetMs:0}),/Run budget/);
});
test("a delivery deferred by the batch budget leaves the next delivery eligible", async t => operationsFixture(async (db, tenant) => {
  let now = Date.now();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const service = new OutboundWebhooks(db, tenant.id, secret, {
    now: () => now,
    network: {
      resolve: async () => [publicAddress],
      send: async ({ url, signal }) => {
        if (url.hostname === "slow.example") {
          entered();
          await new Promise<void>(resolve => signal!.addEventListener("abort", () => resolve(), { once: true }));
        }
        return 204;
      },
    },
  });
  const slow = await service.createEndpoint({ url: "https://slow.example/", events: ["license.created"] });
  const fast = await service.createEndpoint({ url: "https://fast.example/", events: ["license.renewed"] });
  await service.enqueue({ id: "slow", type: "license.created", resourceId: "license", occurredAt: now });
  now++;
  await service.enqueue({ id: "fast", type: "license.renewed", resourceId: "license", occurredAt: now });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  const run = service.run(1, 50);
  await started;
  t.mock.timers.tick(50);
  await run;
  const deferred = (await service.deliveries()).find(row => row.endpointId === slow.id)!;
  assert.equal(deferred.state, "pending");
  assert.equal(deferred.attempts, 0);
  assert.ok(deferred.availableAt > now);

  now = deferred.availableAt;
  await service.run(1, 50);
  const delivered = (await service.deliveries()).find(row => row.endpointId === fast.id)!;
  assert.equal(delivered.state, "sent");
  assert.equal(delivered.attempts, 1);
}));

test("a claim that exhausts the batch budget cannot start DNS or HTTP",async t=>operationsFixture(async(db,tenant)=>{
  let resolutions=0,sends=0;
  const service=new OutboundWebhooks(db,tenant.id,secret,{network:{resolve:async()=>{resolutions++;return [publicAddress];},send:async()=>{sends++;return 204;}}});
  await service.createEndpoint({url:"https://public.example/",events:["license.created"]});
  await service.enqueue({id:"slow-claim",type:"license.created",resourceId:"license",occurredAt:Date.now()});
  await db("outbound_deliveries").where({tenant_id:tenant.id}).update({attempts:11,last_error:"delivery_failed"});
  t.mock.timers.enable({apis:["setTimeout"]});
  const afterQuery=(_rows:unknown,query:{sql:string})=>{if(query.sql.startsWith("select") && query.sql.includes("outbound_events")) t.mock.timers.tick(50);};
  db.on("query-response",afterQuery);
  try {await service.run(1,50);} finally {db.removeListener("query-response",afterQuery);}
  assert.equal(resolutions,1);assert.equal(sends,0);
  const [row]=await service.deliveries();
  assert.equal(row!.state,"pending");assert.equal(row!.attempts,11);
  assert.equal(row!.lastError,"delivery_failed");
}));

test("a second delivery waits when less than 1500ms remains in the batch",async t=>operationsFixture(async(db,tenant)=>{
  let sends=0;
  const started=Date.now();
  let elapsed=0;
  t.mock.method(performance,"now",()=>elapsed);
  const service=new OutboundWebhooks(db,tenant.id,secret,{network:{
    resolve:async()=>[publicAddress],
    send:async()=>{sends++;elapsed+=501;return 204;},
  }});
  await service.createEndpoint({url:"https://public.example/",events:["license.created"]});
  for (const id of ["one","two"]) await service.enqueue({id,type:"license.created",resourceId:"license",occurredAt:started});
  await service.run(20,2000);
  const rows=await service.deliveries();
  assert.equal(sends,1);
  assert.equal(rows.filter(row=>row.state==="pending"&&row.attempts===0).length,1);
  await service.run(20,2000);
  assert.equal(sends,2);
}));
