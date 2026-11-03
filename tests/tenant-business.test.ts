import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createTenant, migrate, type Tenant, type DB, type License } from "../src/db.ts";
import { Licenses } from "../src/licensing.ts";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { unseal } from "../src/crypto.ts";
import { Outbox, type Message } from "../src/email.ts";
import { Auth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { tenantMetrics,recordDownload } from "../src/metrics.ts";
import {isolatedDatabase} from "./helpers/database.ts";
import { Operations } from "../src/operations.ts";

const secret = "13".repeat(32);
async function fixture(run: (db: DB, a: Tenant, b: Tenant) => Promise<void>) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/tenant-business-");
  const {db,close}=await isolatedDatabase(`sqlite:${root}/db`);
  try {
    await migrate(db);
    const a = await createTenant(db, { id: randomUUID(), slug: `a-${randomUUID()}`, name: "A", exempt: 1 });
    const b = await createTenant(db, { id: randomUUID(), slug: `b-${randomUUID()}`, name: "B", exempt: 1 });
    await run(db, a, b);
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
}
async function purchased(db: DB, tenant: Tenant) {
  const product = randomUUID(), plan = randomUUID();
  await db("products").insert({ tenant_id: tenant.id, id: product, slug: "same-plugin", name: tenant.name });
  await db("plans").insert({ tenant_id: tenant.id, id: plan, product_id: product, name: "Annual", site_allowance: 1, stripe_price_id: "price_same" });
  const licensing = new Licenses(db, secret, [], tenant);
  const snapshot: BillingSnapshot = {
    subscriptionId: "sub_same", customerId: "cus_same", email: "same@example.test", billingStatus: "active", suspended: false, fullyRefunded: false,
    grants: [{ id: "il_same", invoiceId: "in_same", priceId: "price_same", periodStart: Date.now() - 1000, periodEnd: Date.now() + 86400000, paidAt: Date.now(), settled: true }],
  };
  const billing = new Billing(db, licensing, { snapshot: async () => structuredClone(snapshot) });
  await billing.reconcile(snapshot.subscriptionId);
  const license = await db<License>("licenses").where({ tenant_id: tenant.id }).first();
  assert.ok(license);
  const email = await db("emails").where({ tenant_id: tenant.id, kind: "license_key" }).first();
  const key = /DE-[A-Za-z0-9_-]+/.exec(unseal<Message>(email.payload, secret).text)![0];
  return { licensing, billing, license, key };
}

test("customer emails identify the publisher and plugin without mixing tenants with shared product slugs", async () => fixture(async (db, a, b) => {
  const config = loadConfig({ APP_SECRET: secret, OPERATOR_TOKEN: "operator-".repeat(5) });
  for (const tenant of [a, b]) {
    const purchase = await purchased(db, tenant);
    await db("products").where({ tenant_id: tenant.id, id: purchase.license.product_id }).update({ name: `${tenant.name} Plugin` });
    await purchase.licensing.replaceKey(purchase.license.id, purchase.license.customer_id);
    await new Auth(db, config, tenant).request("same@example.test");
    // A live customer session makes this recipient eligible for lifecycle notices.
    await db("sessions").insert({ tenant_id: tenant.id, id: randomUUID(), customer_id: purchase.license.customer_id, expires_at: Date.now() + 86400000 });
    const operations = new Operations(db, tenant.id);
    await operations.scanNotifications();
    assert.equal(await operations.enqueueLifecycleEmails(secret), 1);
  }
  for (const tenant of [a, b]) {
    const foreign = tenant.id === a.id ? b : a;
    const rows = await db("emails").where({ tenant_id: tenant.id }).whereIn("state", ["pending"]);
    for (const kind of ["login", "license_key", "lifecycle"]) {
      const row = rows.find((row) => row.kind === kind)!;
      assert.ok(row, kind);
      const message = unseal<Message>(row.payload, secret);
      assert.ok(message.subject.startsWith(`${tenant.name}: `), message.subject);
      for (const content of [message.text, message.html!]) {
        assert.ok(content.includes(tenant.name));
        if (kind !== "login") {
          assert.ok(message.subject.includes(`${tenant.name} Plugin`));
          assert.ok(content.includes(`${tenant.name} Plugin`));
          assert.ok(!content.includes(`${foreign.name} Plugin`));
        }
      }
    }
  }
}));

test("identical provider IDs and emails produce independent seller licenses and seats", async () => fixture(async (db, a, b) => {
  const aa = await purchased(db, a), bb = await purchased(db, b);
  assert.notEqual(aa.license.customer_id, bb.license.customer_id);
  await assert.rejects(bb.licensing.activate(aa.key, "installation-one", "https://one.example", "same-plugin"), /Invalid license/);
  const activated = await aa.licensing.activate(aa.key, "installation-one", "https://one.example", "same-plugin");
  await assert.rejects(bb.licensing.status(activated.token), /invalid or revoked/);
  await assert.rejects(bb.licensing.replaceKey(aa.license.id, aa.license.customer_id), /not found/);
  const theirs = await bb.licensing.activate(bb.key, "installation-one", "https://one.example", "same-plugin");
  assert.notEqual(activated.token, theirs.token);
  await bb.licensing.deactivate(theirs.token);
  assert.equal((await aa.licensing.status(activated.token)).entitled, true);
}));
test("download counters increment repeatedly for one release and remain tenant scoped",async()=>fixture(async(db,a,b)=>{
  for(const tenant of [a,b]){
    const {license}=await purchased(db,tenant),release=randomUUID();
    await db("releases").insert({tenant_id:tenant.id,id:release,product_id:license.product_id,version:"1.0.0",changelog:"",published_at:Date.now(),checksum:"a".repeat(64),size:100,min_wp:"6.0",min_php:"8.0",min_free:"0.0.0",tested:"7.0"});
    await recordDownload(db,tenant.id,release);await recordDownload(db,tenant.id,release);
    assert.equal((await tenantMetrics(db,tenant)).downloads.successfulResponses,2);
  }
}));
test("seat metrics use the current paid allowance before a future plan takes effect",async()=>fixture(async(db,a)=>{
  const {license,licensing}=await purchased(db,a);
  const futurePlan=randomUUID();
  await db("plans").insert({tenant_id:a.id,id:futurePlan,product_id:license.product_id,name:"Future",site_allowance:25,stripe_price_id:"price_future"});
  await db("grants").insert({tenant_id:a.id,id:"future-line",license_id:license.id,plan_id:futurePlan,invoice_id:"future-invoice",period_start:Date.now()+86400000,period_end:Date.now()+2*86400000,paid_at:Date.now()});
  await db("licenses").where({id:license.id}).update({plan_id:futurePlan,site_allowance:25});
  const current=await db<License>("licenses").where({id:license.id}).first();
  assert.equal((await licensing.effective(current!)).site_allowance,1);
  await db("upload_reservations").insert({tenant_id:a.id,id:randomUUID(),bytes:123,expires_at:Date.now()+60000});
  assert.equal((await tenantMetrics(db,a)).seats.allowance,1);
  assert.equal((await tenantMetrics(db,a)).storage.reservedBytes,123);
}));
test("daily tenant email budget defers delivery without losing the only key or consuming retries",async()=>fixture(async(db,a)=>{
  await purchased(db,a);
  await new Auth(db,loadConfig({ DEPLOYMENT_MODE: "hosted",APP_SECRET:secret,OPERATOR_TOKEN:"operator".repeat(5)}),a).request("same@example.test");
  let sent=0;
  const outbox=new Outbox(db,secret,{send:async()=>{sent++;}},a,1);
  await outbox.run();
  assert.equal(sent,1);
  const deferred=await db("emails").where({tenant_id:a.id,state:"pending"}).first();
  assert.ok(deferred);
  assert.equal(deferred.attempts,0);
  assert.ok(deferred.payload);
  assert.equal(deferred.available_at,(Math.floor(Date.now()/86400000)+1)*86400000);
  const original=Date.now;
  try{
    Date.now=()=>deferred.available_at+1;
    await outbox.run();
    assert.equal(sent,2);
    assert.equal((await db("emails").where({tenant_id:a.id,state:"pending"})).length,0);
  }finally{Date.now=original;}
}));
test("buyer login requests are suppressed per address and tenant cookies coexist", async()=>fixture(async(db,a,b)=>{
  await purchased(db,a);await purchased(db,b);
  const config=loadConfig({ DEPLOYMENT_MODE: "hosted",APP_SECRET:secret,OPERATOR_TOKEN:"operator".repeat(5)});
  const aa=new Auth(db,config,a), bb=new Auth(db,config,b);
  assert.notEqual(aa.cookieName,bb.cookieName);
  await aa.request("same@example.test");await aa.request("same@example.test");
  assert.equal((await db("emails").where({tenant_id:a.id,kind:"login"})).length,1);
  await bb.request("same@example.test");
  assert.equal((await db("emails").where({tenant_id:b.id,kind:"login"})).length,1);
  await db("login_tokens").where({tenant_id:a.id}).update({expires_at:Date.now()+13*60000});
  await aa.request("same@example.test");
  assert.equal((await db("emails").where({tenant_id:a.id,kind:"login"})).length,2);
  await db("login_tokens").where({tenant_id:a.id}).update({expires_at:Date.now()-1000});
  const customer=await db("customers").where({tenant_id:a.id}).first();
  for(let n=0;n<8;n++)await db("login_tokens").insert({tenant_id:a.id,id:randomUUID(),customer_id:customer.id,expires_at:Date.now()-1000});
  await aa.request("same@example.test");
  assert.equal((await db("emails").where({tenant_id:a.id,kind:"login"})).length,2);
}));

test("workers and encrypted key deliveries stay in their persisted tenant namespace", async () => fixture(async (db, a, b) => {
  const aa = await purchased(db, a), bb = await purchased(db, b);
  const event = { id: "evt_same", type: "invoice.paid", data: { object: { id: "in_same" } } };
  await aa.billing.receive(event); await bb.billing.receive(event); await aa.billing.receive(event);
  await aa.billing.run(async () => "sub_same");
  assert.equal((await db("billing_events").where({ tenant_id: a.id }).first()).processed_at !== null, true);
  assert.equal((await db("billing_events").where({ tenant_id: b.id }).first()).processed_at, null);
  const delivered: Message[] = [];
  await new Outbox(db, secret, { send: async message => { delivered.push(message); } }, a).run();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!.text, new RegExp(aa.key));
  assert.equal((await db("emails").where({ tenant_id: b.id }).first()).state, "pending");
}));
