import test from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import Stripe from "stripe";
import {createDb,migrate,createTenant,type Plan} from "../src/db.ts";
import {loadConfig} from "../src/config.ts";
import {StripeBilling} from "../src/stripe.ts";

test("Elements sessions use canonical annual prices and the connected account without creating entitlement",async()=>{
  const directory=await mkdtemp("/Volumes/Scratch/entitle/tmp/elements-");
  const db=createDb(`sqlite:${directory}/db`),requests:{path:string;account:unknown;body:URLSearchParams}[]=[];
  let missingSecret=false;
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
    requests.push({path:req.url!,account:req.headers["stripe-account"],body:new URLSearchParams(Buffer.concat(chunks).toString())});
    res.setHeader("content-type","application/json");
    res.end(JSON.stringify(req.url!.startsWith("/v1/prices/")?{active:true,type:"recurring",unit_amount:1200,recurring:{interval:"year",interval_count:1}}:req.url==="/v1/customers"?{id:"cus_elements"}:{id:"cs_elements",client_secret:missingSecret?null:"cs_elements_secret_fixture"}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{
    await migrate(db);
    const tenant=await createTenant(db,{id:"elements-tenant",slug:"elements",name:"Elements",stripe_account_id:"acct_elements"});
    const config=loadConfig({ DEPLOYMENT_MODE: "hosted",APP_SECRET:"99".repeat(32),OPERATOR_TOKEN:"root".repeat(8),STRIPE_PUBLISHABLE_KEY:"pk_test_fixture"});
    const source=new StripeBilling(db,config,tenant);
    source.stripe=new Stripe("sk_test_fixture",{host:"127.0.0.1",port:(server.address() as {port:number}).port,protocol:"http",maxNetworkRetries:0});
    const plan:Plan={tenant_id:tenant.id,id:"plan-elements",product_id:"product-elements",name:"Annual",site_allowance:5,stripe_price_id:"price_elements"};
    const result=await source.checkout(plan,"buyer@example.test",undefined,"elements");
    assert.deepEqual(result,{uiMode:"elements",clientSecret:"cs_elements_secret_fixture",publishableKey:"pk_test_fixture",stripeAccount:"acct_elements",returnUrl:`${config.origin}/app/t/elements?checkout=return`});
    const session=requests.find(r=>r.path==="/v1/checkout/sessions")!;
    assert.equal(session.body.get("ui_mode"),"elements");
    assert.equal(session.body.get("mode"),"subscription");
    assert.equal(session.body.get("line_items[0][price]"),"price_elements");
    assert.equal(session.body.get("return_url"),result.returnUrl);
    assert.equal(session.body.has("success_url"),false);
    assert.equal(session.body.has("cancel_url"),false);
    assert.ok(requests.every(r=>r.account==="acct_elements"));
    assert.equal((await db("licenses")).length,0);
    assert.equal((await db("grants")).length,0);
    missingSecret=true;
    const buyer=await db("customers").where({tenant_id:tenant.id,email:"buyer@example.test"}).first();
    await assert.rejects(source.checkout(plan,"buyer@example.test",buyer.id,"elements"),{code:"stripe_session"});
    source.config.stripePublishableKey="";
    const count=requests.length;
    await assert.rejects(source.checkout(plan,"third@example.test",undefined,"elements"),{code:"stripe_elements_unconfigured"});
    assert.equal(requests.length,count);
  }finally{
    await new Promise<void>(resolve=>server.close(()=>resolve()));await db.destroy();await rm(directory,{recursive:true,force:true});
  }
});
