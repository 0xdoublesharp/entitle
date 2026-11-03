import { isolatedDatabase } from "./helpers/database.ts";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import Stripe from "stripe";
import { createTenant, migrate, type Tenant } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { StripeBilling } from "../src/stripe.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Releases } from "../src/releases.ts";
import { Licenses } from "../src/licensing.ts";
import { Auth } from "../src/auth.ts";
import { hash, unseal, csrf, seal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";
import { primaryTenant, testTenantKey } from "./helpers/tenant.ts";
import { zipBytes } from "./helpers/zip.ts";
import { runCli } from "../src/cli.ts";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

process.env.NODE_ENV = "test";
const prefix = "/api/v1/tenants/primary";
const metadata = Buffer.from(JSON.stringify({ changelog: "First" })).toString(
  "base64url",
);
async function fixture(
  t: TestContext,
  local = true,
  maxBytes = 25 * 1024 * 1024,
) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/saas-api-");
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_BASE_PATH: "",
    APP_SECRET: "12".repeat(32),
    OPERATOR_TOKEN: "root-operator-secret-for-tests-123456",
    DATA_DIR: root,
    WEB_DIR: `${root}/web`,
    LOCAL_BILLING: String(local),
    STRIPE_CONNECT_CLIENT_ID: "ca_fixture",
    PLATFORM_STRIPE_PRICE_ID: "price_platform",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_platform_fixture",
  });
  config.maxUploadBytes = maxBytes;
  await mkdir(config.staticDir);
  await writeFile(
    `${config.staticDir}/index.html`,
    "<!doctype html><title>Tenant application</title>",
  );
  const database = await isolatedDatabase(config.databaseUrl);
  const db = database.db;
  await migrate(db);
  await db("tenants")
    .where({ id: "primary" })
    .update({ stripe_account_id: "acct_primary", stripe_status: "connected" });
  const store = new InMemoryArtifactStore();
  const localStripe = () =>
    new Stripe("sk_test_fixture", {
      host: "127.0.0.1",
      port: 9,
      protocol: "http",
      maxNetworkRetries: 0,
    });
  const platform = new PlatformBilling(db, config, localStripe());
  const sources = new Map<string, StripeBilling>();
  const sent: Message[] = [];
  const app = await buildApp(
    config,
    db,
    {
      send: async (message) => {
        sent.push(message);
      },
    },
    {
      store,
      platformBilling: platform,
      stripeFactory: (tenant) => {
        let source = sources.get(tenant.id);
        if (!source) {
          source = new StripeBilling(db, config, tenant);
          source.stripe = localStripe();
          sources.set(tenant.id, source);
        }
        return source;
      },
    },
  );
  t.after(async () => {
    await app.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  const operator = { authorization: `Bearer ${config.operatorToken}` };
  const post = (
    url: string,
    payload: object = {},
    headers: Record<string, string> = {},
  ) => app.inject({ method: "POST", url, payload, headers });
  const key = async (
    tenantId = "primary",
    token = testTenantKey,
    scopes = [
      "read",
      "catalog:write",
      "releases:write",
      "licenses:write",
      "billing:reconcile",
    ],
  ) => {
    const id = randomUUID();
    await db("tenant_api_keys").insert({
      id,
      tenant_id: tenantId,
      name: "Fixture",
      key_hash: hash(token),
      created_at: Date.now(),
      revoked_at: null,
      scopes: JSON.stringify(scopes),
      expires_at: Date.now() + 86400000,
      last_used_at: null,
      display_prefix: token.slice(0, 14),
    });
    return { id, headers: { authorization: `Bearer ${token}` } };
  };
  return {
    root,
    config,
    db,
    store,
    platform,
    sources,
    app,
    operator,
    post,
    key,
    sent,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function seller(f: Fixture, email = "owner@example.test") {
  const requested = await f.post(
    "/api/v1/platform/auth/request",
    { email },
    { origin: f.config.origin },
  );
  assert.equal(requested.statusCode, 200, requested.body);
  const preauth = requested.cookies.find((c) => c.name.includes("preauth"))!;
  const cookie = `${preauth.name}=${preauth.value}`;
  const job = await f
    .db("platform_emails")
    .orderBy("created_at", "desc")
    .first();
  const message = unseal<Message>(job.payload, f.config.secret);
  const token = /#seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  const consumed = await f.post(
    "/api/v1/platform/auth/consume",
    { token },
    { origin: f.config.origin, cookie },
  );
  assert.equal(consumed.statusCode, 200, consumed.body);
  const session = consumed.cookies.find((c) =>
    c.name.includes("seller-session"),
  )!;
  const browserCookie = `${session.name}=${session.value}`;
  const me = await f.app.inject({
    url: "/api/v1/platform/me",
    headers: { cookie: browserCookie },
  });
  assert.equal(me.statusCode, 200, me.body);
  return {
    cookie: browserCookie,
    origin: f.config.origin,
    "x-csrf-token": me.json().csrfToken as string,
  };
}
async function verifiedHeaders(
  f: Fixture,
  browser: Record<string, string>,
  purpose = "api_keys",
) {
  const previous = (
    await f
      .db("platform_emails")
      .where({ kind: "account_verification" })
      .select("id")
  ).map((row) => row.id);
  const requested = await f.post(
    "/api/v1/platform/account/verification/request",
    { purpose },
    browser,
  );
  assert.equal(requested.statusCode, 200, requested.body);
  const job = await f
    .db("platform_emails")
    .where({ kind: "account_verification" })
    .whereNotIn("id", previous)
    .first();
  const token = /#account-verification=([A-Za-z0-9_-]+)/.exec(
    unseal<Message>(job.payload, f.config.secret).text,
  )![1]!;
  const consumed = await f.post(
    "/api/v1/platform/account/verification/consume",
    { purpose, token },
    browser,
  );
  assert.equal(consumed.statusCode, 200, consumed.body);
  return {
    ...browser,
    "x-account-verification": consumed.json().verification as string,
  };
}
async function merchant(f: Fixture, slug = "merchant") {
  return createTenant(f.db, {
    id: randomUUID(),
    slug,
    name: slug,
    stripe_account_id: `acct_${slug}`,
    exempt: 1,
  });
}
async function commerce(
  f: Fixture,
  tenant: Tenant = primaryTenant,
  activate = true,
) {
  const productId = randomUUID(),
    planId = randomUUID(),
    customerId = randomUUID(),
    licenseId = randomUUID();
  await f.db("products").insert({
    tenant_id: tenant.id,
    id: productId,
    slug: "plugin",
    name: "Plugin",
  });
  await f.db("plans").insert({
    tenant_id: tenant.id,
    id: planId,
    product_id: productId,
    name: "One",
    site_allowance: 1,
    stripe_price_id: "price_one",
  });
  await f.db("customers").insert({
    tenant_id: tenant.id,
    id: customerId,
    email: "buyer@example.test",
    stripe_id: "cus_buyer",
  });
  const licenseKey = `DE-${randomUUID()}`;
  await f.db("licenses").insert({
    tenant_id: tenant.id,
    id: licenseId,
    customer_id: customerId,
    product_id: productId,
    plan_id: planId,
    site_allowance: 1,
    paid_through: Date.now() + 86400000,
    billing_status: "active",
    subscription_id: "sub_paid",
    key_hash: hash(licenseKey),
  });
  const bytes = zipBytes([
    {
      name: "plugin/plugin.php",
      data: "<?php\n/*\nPlugin Name: Plugin\nVersion: 1.0.0\n*/",
    },
  ]);
  const file = `${f.root}/${randomUUID()}.zip`;
  await writeFile(file, bytes);
  const release = await new Releases(
    f.db,
    f.store,
    tenant,
    f.config.storage,
  ).publish({
    product: "plugin",
    version: "1.0.0",
    file,
    changelog: "First",
    minWp: "6.0",
    minPhp: "8.0",
    minFree: "0.0.0",
    tested: "7.0",
  });
  const activated = activate
    ? await f.post(`/api/v1/tenants/${tenant.slug}/activate`, {
        key: licenseKey,
        installationId: "installation-001",
        siteUrl: "https://buyer.example.test",
        product: "plugin",
      })
    : null;
  if (activated) assert.equal(activated.statusCode, 200, activated.body);
  const sessionToken = `buyer-${randomUUID()}`;
  await f.db("sessions").insert({
    tenant_id: tenant.id,
    id: hash(sessionToken),
    customer_id: customerId,
    expires_at: Date.now() + 86400000,
  });
  const cookieName = new Auth(f.db, f.config, tenant).cookieName;
  const browser = {
    cookie: `${cookieName}=${sessionToken}`,
    origin: f.config.origin,
    "x-csrf-token": csrf(sessionToken, f.config.secret),
  };
  return {
    productId,
    planId,
    customerId,
    licenseId,
    licenseKey,
    release,
    bytes,
    browser,
    token: activated ? (activated.json().token as string) : "",
  };
}

test("seller license detail requires read scope and never exposes another tenant or credential material", async (t) => {
  const f=await fixture(t);
  const item=await commerce(f);
  const reader=await f.key();
  const details=await f.app.inject({method:"GET",url:`/api/v1/tenants/primary/seller/licenses/${item.licenseId}`,headers:reader.headers});
  assert.equal(details.statusCode,200,details.body);
  assert.equal(details.json().license.id,item.licenseId);
  assert.equal(details.json().license.customer_email,"buyer@example.test");
  assert.equal(details.json().installations.length,1);
  assert.doesNotMatch(details.body,/key_hash|token_hash|token_cipher|subscription_id/);
  const original=await f.db("installations").where({license_id:item.licenseId}).first();
  await f.db("installations").insert({...original,id:randomUUID(),installation_id:"another-installation",token_hash:hash(randomUUID())});
  const first=await f.app.inject({method:"GET",url:`/api/v1/tenants/primary/seller/licenses/${item.licenseId}?limit=1`,headers:reader.headers});
  assert.equal(first.json().installations.length,1);
  const next=await f.app.inject({method:"GET",url:`/api/v1/tenants/primary/seller/licenses/${item.licenseId}?limit=1&after=${first.json().nextCursor}`,headers:reader.headers});
  assert.equal(next.json().installations.length,1);
  assert.notEqual(first.json().installations[0].id,next.json().installations[0].id);
  assert.equal(next.json().nextCursor,null);
  const tenant=await merchant(f,"other");
  const foreign=await f.key(tenant.id,`DE-TK-${"q".repeat(43)}`);
  const denied=await f.app.inject({method:"GET",url:`/api/v1/tenants/other/seller/licenses/${item.licenseId}`,headers:foreign.headers});
  assert.equal(denied.statusCode,404);
  const noRead=await f.key("primary",`DE-TK-${"r".repeat(43)}`,["releases:write"]);
  const scoped=await f.app.inject({method:"GET",url:`/api/v1/tenants/primary/seller/licenses/${item.licenseId}`,headers:noRead.headers});
  assert.equal(scoped.statusCode,403);
});

test("CLI owner sign-in, verification and API key creation honor real session binding", async (t) => {
  const f=await fixture(t);
  const origin=await f.app.listen({port:0,host:"127.0.0.1"});
  f.config.origin=origin;
  const env={PUBLIC_ORIGIN:origin,TENANT_SLUG:"cli-workspace"};
  const lines:string[]=[];
  const io={log:(line:string)=>lines.push(line),error:(line:string)=>lines.push(line)};
  const preauth=`${f.root}/preauth`,tokenFile=`${f.root}/login-token`,sessionFile=`${f.root}/session`;
  assert.equal(await runCli(["owner-login-start","owner@example.test",preauth],env,io),0,lines.join("\n"));
  const login=await f.db("platform_emails").where({kind:"seller_login"}).first();
  const token=/#seller-login=([A-Za-z0-9_-]+)/.exec(unseal<Message>(login.payload,f.config.secret).text)![1]!;
  await writeFile(tokenFile,token,{mode:0o600});
  assert.equal(await runCli(["owner-login-finish",preauth,tokenFile,sessionFile],env,io),0,lines.join("\n"));
  const ownerEnv={...env,ENTITLE_SESSION_FILE:sessionFile};
  assert.equal(await runCli(["owner-sessions"],ownerEnv,io),0,lines.join("\n"));
  assert.ok(JSON.parse(lines.at(-1)!).sessions.length>=1);
  assert.equal(await runCli(["owner-sessions-revoke-others"],ownerEnv,io),0,lines.join("\n"));
  const workspace=`${f.root}/workspace.json`;
  await writeFile(workspace,JSON.stringify({slug:"cli-workspace",name:"CLI Workspace"}));
  assert.equal(await runCli(["workspace-create",workspace],ownerEnv,io),0,lines.join("\n"));
  const purpose=`${f.root}/purpose.json`;
  await writeFile(purpose,JSON.stringify({purpose:"api_keys"}));
  assert.equal(await runCli(["owner-verification-request",purpose],ownerEnv,io),0,lines.join("\n"));
  const email=await f.db("platform_emails").where({kind:"account_verification"}).first();
  const verification=/#account-verification=([A-Za-z0-9_-]+)/.exec(unseal<Message>(email.payload,f.config.secret).text)![1]!;
  const input=`${f.root}/verification.json`,proof=`${f.root}/proof.json`;
  await writeFile(input,JSON.stringify({purpose:"api_keys",token:verification}),{mode:0o600});
  assert.equal(await runCli(["owner-verification-consume",input,proof],ownerEnv,io),0,lines.join("\n"));
  const keyFile=`${f.root}/key.json`;
  await writeFile(keyFile,JSON.stringify({name:"Agent",scopes:["read"]}));
  assert.equal(await runCli(["owner-key-create",keyFile],{...ownerEnv,ENTITLE_VERIFICATION_FILE:proof},io),0,lines.join("\n"));
  const created=JSON.parse(lines.at(-1)!);
  assert.match(created.token,/^DE-TK-/);
  const authorized=await f.app.inject({url:"/api/v1/tenants/cli-workspace/seller/features",headers:{authorization:`Bearer ${created.token}`}});
  assert.equal(authorized.statusCode,200,authorized.body);
  assert.equal(await runCli(["owner-key-create",keyFile],{...ownerEnv,ENTITLE_VERIFICATION_FILE:proof},io),1);
});

test("CLI client checks keep license and activation tokens in private files",async(t)=>{
  const f=await fixture(t), item=await commerce(f,primaryTenant,false);
  const origin=await f.app.listen({port:0,host:"127.0.0.1"});
  f.config.origin=origin;
  const env={PUBLIC_ORIGIN:origin,TENANT_SLUG:"primary"},lines:string[]=[];
  const io={log:(line:string)=>lines.push(line),error:(line:string)=>lines.push(line)};
  const input=`${f.root}/activation-input.json`,output=`${f.root}/activation-output.json`;
  await writeFile(input,JSON.stringify({key:item.licenseKey,installationId:"cli-install",siteUrl:"https://cli.example.test",product:"plugin"}),{mode:0o600});
  assert.equal(await runCli(["activation-create",input,output],env,io),0,lines.join("\n"));
  const result=JSON.parse(await readFile(output,"utf8"));
  assert.ok(result.token);
  assert.ok(lines.every((line)=>!line.includes(item.licenseKey)&&!line.includes(result.token)));
  assert.equal(await runCli(["activation-status"],{...env,ENTITLE_AUTHORIZATION:`Bearer ${result.token}`},io),0,lines.join("\n"));
  assert.equal(JSON.parse(lines.at(-1)!).entitled,true);
});

test("buyer agent session keeps tenant isolation, private output and key-replacement semantics", async (t) => {
  const f=await fixture(t), item=await commerce(f);
  const origin=await f.app.listen({port:0,host:"127.0.0.1"});
  f.config.origin=origin;
  const env={PUBLIC_ORIGIN:origin,TENANT_SLUG:"primary"},lines:string[]=[];
  const io={log:(line:string)=>lines.push(line),error:(line:string)=>lines.push(line)};
  assert.equal(await runCli(["buyer-login-start","buyer@example.test"],env,io),0,lines.join("\n"));
  const login=await f.db("emails").where({tenant_id:"primary",kind:"login"}).first();
  const loginToken=/#login=([A-Za-z0-9_-]+)/.exec(unseal<Message>(login.payload,f.config.secret).text)![1]!;
  const tokenFile=`${f.root}/buyer-token`,sessionFile=`${f.root}/buyer-session`;
  await writeFile(tokenFile,loginToken,{mode:0o600});
  assert.equal(await runCli(["buyer-login-finish",tokenFile,sessionFile],env,io),0,lines.join("\n"));
  const buyerEnv={...env,ENTITLE_BUYER_SESSION_FILE:sessionFile};
  assert.equal(await runCli(["buyer-me"],buyerEnv,io),0,lines.join("\n"));
  assert.equal(JSON.parse(lines.at(-1)!).customer.email,"buyer@example.test");
  const privateExport=`${f.root}/buyer-export.json`,exportInput=`${f.root}/buyer-export-input.json`;
  await writeFile(exportInput,JSON.stringify({output:privateExport}));
  assert.equal(await runCli(["buyer-data-export",exportInput],buyerEnv,io),0,lines.join("\n"));
  assert.equal(JSON.parse(await readFile(privateExport,"utf8")).customer.email,"buyer@example.test");
  const releaseOutput=`${f.root}/buyer-release.zip`,downloadInput=`${f.root}/download.json`;
  await writeFile(downloadInput,JSON.stringify({licenseId:item.licenseId,releaseId:item.release.id,output:releaseOutput}));
  assert.equal(await runCli(["buyer-release-download",downloadInput],buyerEnv,io),0,lines.join("\n"));
  assert.deepEqual(await readFile(releaseOutput),item.bytes);
  const rotateInput=`${f.root}/rotate.json`,keyOutput=`${f.root}/new-key.json`;
  const existingHeaders=`${f.root}/existing-headers.json`,reservedBody=`${f.root}/reserved-body.json`;
  await writeFile(existingHeaders,"existing",{mode:0o600});
  const originalHash=(await f.db("licenses").where({id:item.licenseId}).first()).key_hash;
  assert.equal(await runCli(["request","POST",`${prefix}/licenses/${item.licenseId}/key`,"--output",reservedBody,"--headers-output",existingHeaders],buyerEnv,io),1);
  await assert.rejects(readFile(reservedBody),{code:"ENOENT"});
  assert.equal((await f.db("licenses").where({id:item.licenseId}).first()).key_hash,originalHash);
  assert.equal((await f.app.inject({url:`${prefix}/activation`,headers:{authorization:`Bearer ${item.token}`}})).statusCode,200);
  await writeFile(rotateInput,JSON.stringify({id:item.licenseId,output:keyOutput}));
  await writeFile(keyOutput,"existing",{mode:0o600});
  assert.equal(await runCli(["buyer-key-replace",rotateInput],buyerEnv,io),1);
  assert.equal((await f.app.inject({url:`${prefix}/activation`,headers:{authorization:`Bearer ${item.token}`}})).statusCode,200);
  await rm(keyOutput);
  assert.equal(await runCli(["buyer-key-replace",rotateInput],buyerEnv,io),0,lines.join("\n"));
  const replacement=JSON.parse(await readFile(keyOutput,"utf8")).key;
  assert.ok(replacement && lines.every(line=>!line.includes(replacement)));
  assert.equal((await f.app.inject({url:`${prefix}/activation`,headers:{authorization:`Bearer ${item.token}`}})).statusCode,401);
  assert.equal(await runCli(["buyer-me"],{...buyerEnv,TENANT_SLUG:"another"},io),1);
  assert.equal(await runCli(["buyer-closure-request"],buyerEnv,io),0,lines.join("\n"));
  assert.equal(await runCli(["buyer-closure-status"],buyerEnv,io),0,lines.join("\n"));
  const client=new McpClient({name:"buyer-fixture",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:[process.env.ENTITLE_MCP_ENTRY??"src/mcp.ts"],env:{PATH:process.env.PATH??"",...buyerEnv},stderr:"pipe"});
  try {
    await client.connect(transport);
    assert.equal((await client.callTool({name:"entitle_op_buyer_me",arguments:{}})).isError,undefined);
    assert.equal((await client.callTool({name:"entitle_op_owner_sessions",arguments:{}})).isError,true);
    const mcpExport=`${f.root}/buyer-mcp-export.json`;
    assert.equal((await client.callTool({name:"entitle_op_buyer_data_export",arguments:{output:mcpExport}})).isError,undefined);
    assert.equal(JSON.parse(await readFile(mcpExport,"utf8")).customer.email,"buyer@example.test");
  } finally {await client.close();}
  assert.equal(await runCli(["buyer-logout"],buyerEnv,io),0,lines.join("\n"));
  assert.equal(await runCli(["buyer-me"],buyerEnv,io),1);
});

test("structured product and publication commands reach the real seller API", async (t) => {
  const f=await fixture(t), cliKey=`DE-TK-${"k".repeat(43)}`,key=await f.key("primary",cliKey);
  const origin=await f.app.listen({port:0,host:"127.0.0.1"});
  f.config.origin=origin;
  const env={PUBLIC_ORIGIN:origin,TENANT_SLUG:"primary",TENANT_API_KEY:cliKey},lines:string[]=[];
  const io={log:(line:string)=>lines.push(line),error:(line:string)=>lines.push(line)};
  const productFile=`${f.root}/product-input.json`;
  await writeFile(productFile,JSON.stringify({slug:"typed-plugin",name:"Typed Plugin",framework:"wordpress",plans:[]}));
  assert.equal(await runCli(["product-save",productFile],env,io),0,lines.join("\n"));
  const zip=zipBytes([{name:"typed-plugin/typed-plugin.php",data:"<?php\n/*\nPlugin Name: Typed Plugin\nVersion: 1.2.3\n*/"}]);
  const zipFile=`${f.root}/release.zip`,releaseFile=`${f.root}/release-input.json`;
  await writeFile(zipFile,zip);
  await writeFile(releaseFile,JSON.stringify({product:"typed-plugin",version:"1.2.3",file:zipFile,metadata:{changelog:"First release"}}));
  assert.equal(await runCli(["release-publish",releaseFile],env,io),0,lines.join("\n"));
  const overview=await f.app.inject({url:`${prefix}/seller/overview`,headers:key.headers});
  assert.equal(overview.statusCode,200);
  assert.equal(overview.json().releases[0].version,"1.2.3");
  assert.equal(await runCli(["release-publish",releaseFile],env,io),1);
  const generic=`${f.root}/generic.json`,asset=`${f.root}/asset.bin`,assetInput=`${f.root}/asset-input.json`;
  await writeFile(generic,JSON.stringify({slug:"typed-generic",name:"Typed Generic",framework:"generic",plans:[]}));
  assert.equal(await runCli(["product-save",generic],env,io),0,lines.join("\n"));
  await writeFile(asset,Buffer.from([0,1,2,255]));
  await writeFile(assetInput,JSON.stringify({product:"typed-generic",version:"2.0.0",file:asset,metadata:{target:"linux-x64",filename:"bundle.bin",changelog:"Native"}}));
  assert.equal(await runCli(["asset-publish",assetInput],env,io),0,lines.join("\n"));
  const published=JSON.parse(lines.at(-1)!);
  assert.equal(published.asset.filename,"bundle.bin");
  const product=await f.db("products").where({tenant_id:"primary",slug:"typed-generic"}).first();
  const complimentary=`${f.root}/complimentary.json`;
  await writeFile(complimentary,JSON.stringify({email:"native@example.test",productId:product.id,siteAllowance:1,expiresAt:Date.now()+86400000,requestId:randomUUID(),confirm:true}));
  assert.equal(await runCli(["license-complimentary",complimentary],env,io),0,lines.join("\n"));
  const email=await f.db("emails").where({tenant_id:"primary",kind:"license_key"}).first();
  const licenseKey=/DE-[A-Za-z0-9_-]+/.exec(unseal<Message>(email.payload,f.config.secret).text)![0];
  const activated=await f.post(`${prefix}/activate`,{key:licenseKey,installationId:"native-test-1",product:"typed-generic"});
  assert.equal(activated.statusCode,200,activated.body);
  const nativeEnv={PUBLIC_ORIGIN:origin,TENANT_SLUG:"primary",ENTITLE_AUTHORIZATION:`Bearer ${activated.json().token}`};
  const feedInput=`${f.root}/feed.json`,assetDownload=`${f.root}/asset-download.json`,assetOutput=`${f.root}/asset-output.bin`;
  await writeFile(feedInput,JSON.stringify({product:"typed-generic",target:"linux-x64"}));
  assert.equal(await runCli(["update-generic",feedInput],nativeEnv,io),0,lines.join("\n"));
  assert.equal(JSON.parse(lines.at(-1)!).version,"2.0.0");
  await writeFile(assetDownload,JSON.stringify({product:"typed-generic",assetId:published.asset.id,filename:"bundle.bin",output:assetOutput}));
  assert.equal(await runCli(["installation-asset-download",assetDownload],nativeEnv,io),0,lines.join("\n"));
  assert.deepEqual(await readFile(assetOutput),Buffer.from([0,1,2,255]));
  const client=new McpClient({name:"publisher-fixture",version:"1"});
  const transport=new StdioClientTransport({command:process.execPath,args:[process.env.ENTITLE_MCP_ENTRY??"src/mcp.ts"],env:{PATH:process.env.PATH??"",...env},stderr:"pipe"});
  try {
    await client.connect(transport);
    assert.equal((await client.callTool({name:"entitle_op_product_save",arguments:{slug:"mcp-generic",name:"MCP Generic",framework:"generic",plans:[]}})).isError,undefined);
    assert.equal((await client.callTool({name:"entitle_op_asset_publish",arguments:{product:"mcp-generic",version:"3.0.0",file:asset,metadata:{target:"linux-x64",filename:"bundle.bin",changelog:"MCP release"}}})).isError,undefined);
    const mcpProduct=await f.db("products").where({tenant_id:"primary",slug:"mcp-generic"}).first();
    assert.ok(await f.db("releases").where({tenant_id:"primary",product_id:mcpProduct.id,version:"3.0.0"}).first());
  } finally {await client.close();}
});

async function readGraph(f: Fixture) {
  const purchase = await commerce(f);
  const otherTenant = await merchant(f, "other-reads");
  await commerce(f, otherTenant);
  const originalPlan = await f
    .db("plans")
    .where({ id: purchase.planId })
    .first();
  const originalLicense = await f
    .db("licenses")
    .where({ id: purchase.licenseId })
    .first();
  const productIds = [purchase.productId];
  for (let index = 1; index <= 3; index++) {
    const productId = randomUUID(),
      planId = randomUUID(),
      licenseId = randomUUID();
    productIds.push(productId);
    await f.db("products").insert({
      tenant_id: "primary",
      id: productId,
      slug: `native-${index}`,
      name: `Native ${index}`,
      framework: "generic",
      framework_config: JSON.stringify({ activationKind: "device" }),
    });
    await f.db("plans").insert({
      ...originalPlan,
      id: planId,
      product_id: productId,
      stripe_price_id: `price_native_${index}`,
    });
    await f.db("licenses").insert({
      ...originalLicense,
      id: licenseId,
      product_id: productId,
      plan_id: planId,
      subscription_id: `sub_native_${index}`,
      key_hash: hash(`native-${index}`),
    });
    await f.db("installations").insert({
      tenant_id: "primary",
      id: randomUUID(),
      license_id: licenseId,
      installation_id: `device-${index}`,
      site_url: `device:device-${index}`,
      label: `Computer ${index}`,
      active: 1,
      exempt: 0,
      token_hash: hash(`device-${index}`),
      token_cipher: "",
    });
    for (const version of ["1.0.0", "2.0.0", "3.0.0", "4.0.0"]) {
      const releaseId = randomUUID();
      await f.db("releases").insert({
        tenant_id: "primary",
        id: releaseId,
        product_id: productId,
        version,
        changelog: version,
        published_at:
          version === "4.0.0" ? Date.now() + 86400000 : Date.now() - 1000,
        withdrawn: version === "3.0.0" ? 1 : 0,
        checksum: "a".repeat(64),
        size: 20,
        min_wp: "",
        min_php: "",
        min_free: "",
        tested: "",
      });
      for (const target of ["linux-x64", "windows-x64"])
        await f.db("release_assets").insert({
          tenant_id: "primary",
          id: randomUUID(),
          release_id: releaseId,
          target,
          filename: "app.bin",
          size: 10,
          checksum: "a".repeat(64),
          sha512: Buffer.alloc(64).toString("base64"),
          signature: null,
          min_system_version: null,
        });
    }
  }
  await f.db("products").insert({
    tenant_id: "primary",
    id: "no-plans",
    slug: "no-plans",
    name: "Coming soon",
  });
  const customerId = randomUUID();
  await f.db("customers").insert({
    tenant_id: "primary",
    id: customerId,
    email: "another@example.test",
  });
  await f.db("licenses").insert({
    ...originalLicense,
    id: "another-customers-license",
    customer_id: customerId,
    subscription_id: "sub_another",
    key_hash: hash("another-key"),
  });
  return { purchase, productIds };
}

async function measureReads(
  f: Fixture,
  url: string,
  headers: Record<string, string> = {},
) {
  const selects = new Map<string, number>();
  const record = ({ sql }: { sql: string }) => {
    const table = /^select\b.*?\bfrom ["`]?([a-z_]+)/i.exec(sql)?.[1];
    if (table) selects.set(table, (selects.get(table) ?? 0) + 1);
  };
  f.db.on("query", record);
  try {
    const response = await f.app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    return { response, selects };
  } finally {
    f.db.off("query", record);
  }
}

test("catalog reads plans once while preserving product and tenant boundaries", async (t) => {
  const f = await fixture(t);
  const { productIds } = await readGraph(f);
  const { response, selects } = await measureReads(f, `${prefix}/catalog`);
  const products = response.json().products;
  assert.equal(products.length, productIds.length + 1);
  for (const product of products) {
    assert.equal(product.framework_config, undefined);
    assert.equal(product.plans.length, product.id === "no-plans" ? 0 : 1);
    if (product.plans.length) assert.equal(product.plans[0].site_allowance, 1);
  }
  t.diagnostic(JSON.stringify(Object.fromEntries(selects)));
  assert.equal(selects.get("plans"), 1);
});

test("seller overview batches plans and assets for all owned products and releases", async (t) => {
  const f = await fixture(t);
  const { productIds } = await readGraph(f);
  const key = await f.key();
  const { response, selects } = await measureReads(
    f,
    `${prefix}/seller/overview`,
    key.headers,
  );
  const data = response.json();
  assert.equal(data.products.length, productIds.length + 1);
  assert.equal(data.licenses.length, productIds.length + 1);
  assert.equal(data.releases.length, 13);
  for (const release of data.releases) {
    assert.equal(
      release.assets.length,
      release.product_id === productIds[0] ? 0 : 2,
    );
    for (const asset of release.assets) {
      assert.equal(asset.tenant_id, "primary");
      assert.equal(asset.release_id, release.id);
    }
  }
  t.diagnostic(JSON.stringify(Object.fromEntries(selects)));
  assert.equal(selects.get("plans"), 1);
  assert.equal(selects.get("release_assets"), 1);
});

test("buyer account batches related rows without exposing hidden releases or other customers", async (t) => {
  const f = await fixture(t);
  const { purchase, productIds } = await readGraph(f);
  const { response, selects } = await measureReads(
    f,
    `${prefix}/me`,
    purchase.browser,
  );
  const data = response.json();
  assert.equal(data.customer.id, purchase.customerId);
  assert.equal(data.licenses.length, productIds.length);
  for (const license of data.licenses) {
    assert.ok(productIds.includes(license.product_id));
    assert.notEqual(license.id, "another-customers-license");
    assert.equal(license.site_allowance, 1);
    assert.equal(license.entitled, true);
    assert.equal(license.installations.length, 1);
    assert.equal(license.installations[0].active, true);
    assert.equal(
      license.releases.length,
      license.product_id === purchase.productId ? 1 : 2,
    );
    for (const release of license.releases) {
      assert.ok(["1.0.0", "2.0.0"].includes(release.version));
      assert.equal(
        release.assets.length,
        license.product_id === purchase.productId ? 0 : 2,
      );
      for (const asset of release.assets) {
        assert.equal(asset.tenant_id, "primary");
        assert.equal(asset.release_id, release.id);
      }
    }
  }
  t.diagnostic(JSON.stringify(Object.fromEntries(selects)));
  for (const table of [
    "products",
    "plans",
    "installations",
    "releases",
    "release_assets",
  ])
    assert.equal(
      selects.get(table),
      1,
      `${table} reads should not grow per license or release`,
    );
});

test("buyer account lists no installations until the first site activation", async (t) => {
  const f = await fixture(t);
  const purchase = await commerce(f, primaryTenant, false);
  const before = await f.app.inject({
    url: `${prefix}/me`,
    headers: purchase.browser,
  });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().licenses[0].id, purchase.licenseId);
  assert.equal(before.json().licenses[0].entitled, true);
  assert.deepEqual(before.json().licenses[0].installations, []);
  const activated = await f.post(`${prefix}/activate`, {
    key: purchase.licenseKey,
    installationId: "first-installation",
    siteUrl: "https://first.example.test",
    product: "plugin",
  });
  assert.equal(activated.statusCode, 200, activated.body);
  const after = await f.app.inject({
    url: `${prefix}/me`,
    headers: purchase.browser,
  });
  assert.equal(after.statusCode, 200, after.body);
  const installations = after.json().licenses[0].installations;
  assert.equal(installations.length, 1);
  assert.equal(installations[0].installation_id, "first-installation");
  assert.equal(installations[0].active, true);
  assert.equal(installations[0].license_id, undefined);
});

test("buyer account includes a paid plan created during effective license projection", async (t) => {
  const f = await fixture(t);
  const purchase = await commerce(f);
  const original = Licenses.prototype.effective;
  let upgraded = false;
  t.mock.method(
    Licenses.prototype,
    "effective",
    async function (
      this: Licenses,
      ...args: Parameters<Licenses["effective"]>
    ) {
      if (!upgraded && args[0].id === purchase.licenseId) {
        upgraded = true;
        const now = Date.now();
        await f.db("plans").insert({
          tenant_id: "primary",
          id: "concurrent-upgrade",
          product_id: purchase.productId,
          name: "Five seats",
          site_allowance: 5,
          stripe_price_id: "price_upgrade",
        });
        await f.db("grants").insert({
          tenant_id: "primary",
          id: "upgrade-grant",
          license_id: purchase.licenseId,
          plan_id: "concurrent-upgrade",
          invoice_id: "upgrade-invoice",
          period_start: now - 1000,
          period_end: now + 86400000,
          paid_at: now,
        });
      }
      return original.apply(this, args);
    },
  );
  const response = await f.app.inject({
    url: `${prefix}/me`,
    headers: purchase.browser,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().licenses[0].plan_name, "Five seats");
  assert.equal(response.json().licenses[0].site_allowance, 5);
});

test("public catalog requires an explicit tenant namespace and platform info exposes verified capabilities", async (t) => {
  const f = await fixture(t);
  const scoped = await f.app.inject(`${prefix}/catalog`);
  assert.equal(scoped.statusCode, 200);
  assert.deepEqual(scoped.json(), {
    tenant: { slug: "primary", name: "Primary" },
    products: [],
    billingAvailable: true,
  });
  for (const url of [
    "/api/v1/catalog",
    "/api/v1/auth/request",
    "/api/v1/operator/products",
    "/api/v1/stripe/webhook",
    "/api/v1/tenants/missing/catalog",
  ])
    assert.equal((await f.app.inject(url)).statusCode, 404, url);
  const info = await f.app.inject("/api/v1/platform/info");
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().storage, "s3");
  assert.equal(info.json().maxUploadBytes, 25 * 1024 * 1024);
  assert.deepEqual(info.json().databaseEngines, [
    "SQLite",
    "PostgreSQL",
    "MySQL",
  ]);
  for (const url of ["/seller", "/t/primary", "/docs", "/docs/"]) {
    const page = await f.app.inject(url);
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Tenant application/);
  }
});

test("seller email login binds its preauth browser, consumes once, and validates creation privileges", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.post("/api/v1/platform/auth/request", {
        email: "owner@example.test",
      })
    ).statusCode,
    403,
  );
  const requested = await f.post(
    "/api/v1/platform/auth/request",
    { email: "owner@example.test" },
    { origin: f.config.origin },
  );
  const preauth = requested.cookies.find((c) => c.name.includes("preauth"))!;
  const job = await f.db("platform_emails").first();
  const message = unseal<Message>(job.payload, f.config.secret);
  const token = /#seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  assert.equal(
    (
      await f.post(
        "/api/v1/platform/auth/consume",
        { token },
        { origin: f.config.origin },
      )
    ).statusCode,
    401,
  );
  const consumed = await f.post(
    "/api/v1/platform/auth/consume",
    { token },
    { origin: f.config.origin, cookie: `${preauth.name}=${preauth.value}` },
  );
  assert.equal(consumed.statusCode, 200);
  assert.equal(
    (
      await f.post(
        "/api/v1/platform/auth/consume",
        { token },
        { origin: f.config.origin, cookie: `${preauth.name}=${preauth.value}` },
      )
    ).statusCode,
    401,
  );
  const session = consumed.cookies.find((c) =>
    c.name.includes("seller-session"),
  )!;
  const cookie = `${session.name}=${session.value}`;
  const me = await f.app.inject({
    url: "/api/v1/platform/me",
    headers: { cookie },
  });
  const headers = {
    cookie,
    origin: f.config.origin,
    "x-csrf-token": me.json().csrfToken as string,
  };
  assert.equal(
    (
      await f.post(
        "/api/v1/platform/tenants",
        { slug: "owned", name: "Owned", exempt: true },
        headers,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/platform/tenants",
        { slug: "owned", name: "Owned" },
        { cookie },
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/platform/tenants",
        { slug: "primary", name: "Reserved" },
        headers,
      )
    ).statusCode,
    400,
  );
  const created = await f.post(
    "/api/v1/platform/tenants",
    { slug: "owned", name: "Owned" },
    headers,
  );
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().tenant.exempt, 0);
  assert.equal(
    (
      await f.post(
        "/api/v1/platform/tenants",
        { slug: "owned", name: "Owned" },
        headers,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.app.inject({ url: "/api/v1/platform/me", headers })).json().tenants
      .length,
    1,
  );
  assert.equal(
    (await f.post("/api/v1/platform/auth/logout", {}, headers)).statusCode,
    200,
  );
  assert.equal(
    (await f.app.inject({ url: "/api/v1/platform/me", headers })).statusCode,
    401,
  );
});

test("seller keys enforce scope, expiry, tenant ownership, and interactive-only administration", async (t) => {
  const f = await fixture(t);
  const browser = await seller(f);
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/tenants/primary/owner",
        { email: "owner@example.test" },
        f.operator,
      )
    ).statusCode,
    200,
  );
  const defaults = await f.post(
    `${prefix}/seller/keys`,
    { name: "Publish" },
    await verifiedHeaders(f, browser),
  );
  assert.equal(defaults.statusCode, 200, defaults.body);
  assert.deepEqual(defaults.json().scopes, ["read", "releases:write"]);
  const keyHeaders = { authorization: `Bearer ${defaults.json().token}` };
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/seller/overview`,
        headers: keyHeaders,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.post(
        `${prefix}/seller/products`,
        { slug: "nope", name: "Denied", plans: [] },
        keyHeaders,
      )
    ).statusCode,
    403,
  );
  for (const route of [
    "keys",
    "stripe/connect",
    "platform/checkout",
    "platform/portal",
  ]) {
    const response =
      route === "keys"
        ? await f.app.inject({
            url: `${prefix}/seller/${route}`,
            headers: keyHeaders,
          })
        : await f.post(`${prefix}/seller/${route}`, {}, keyHeaders);
    assert.equal(response.statusCode, 401, route);
  }
  const listed = await f.app.inject({
    url: `${prefix}/seller/keys`,
    headers: browser,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().keys.length, 1);
  assert.ok(!listed.body.includes(defaults.json().token));
  assert.ok(!listed.body.includes("key_hash"));
  const other = await merchant(f, "other");
  assert.equal(
    (
      await f.app.inject({
        url: `/api/v1/tenants/${other.slug}/seller/overview`,
        headers: keyHeaders,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `/api/v1/tenants/${other.slug}/seller/overview`,
        headers: browser,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(
        `${prefix}/seller/keys`,
        { name: "Invalid", scopes: ["operator"] },
        await verifiedHeaders(f, browser),
      )
    ).statusCode,
    400,
  );
  const custom = await f.post(
    `${prefix}/seller/keys`,
    { name: "Catalog", scopes: ["read", "catalog:write"], expiresInDays: 1 },
    await verifiedHeaders(f, browser),
  );
  assert.equal(custom.statusCode, 200);
  assert.deepEqual(custom.json().scopes, ["read", "catalog:write"]);
  await f
    .db("tenant_api_keys")
    .where({ id: custom.json().id })
    .update({ expires_at: 1 });
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/seller/overview`,
        headers: { authorization: `Bearer ${custom.json().token}` },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(
        `${prefix}/seller/keys/${defaults.json().id}/revoke`,
        {},
        await verifiedHeaders(f, browser),
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/seller/overview`,
        headers: keyHeaders,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/operator/tenants",
        headers: keyHeaders,
      })
    ).statusCode,
    401,
  );
});

test("cross-tenant buyer credentials, license IDs, release IDs and seller keys cannot cross namespaces", async (t) => {
  const f = await fixture(t);
  const other = await merchant(f);
  const a = await commerce(f),
    b = await commerce(f, other);
  const key = await f.key();
  const foreign = `/api/v1/tenants/${other.slug}`;
  assert.equal(
    (
      await f.app.inject({
        url: `${foreign}/activation`,
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (await f.app.inject({ url: `${foreign}/me`, headers: a.browser }))
      .statusCode,
    401,
  );
  assert.equal(
    (await f.post(`${foreign}/licenses/${a.licenseId}/key`, {}, b.browser))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${foreign}/licenses/${a.licenseId}/releases/${a.release.id}/download`,
        headers: b.browser,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${foreign}/packages/${a.release.id}`,
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.post(
        `${foreign}/seller/releases/${b.release.id}/withdraw`,
        {},
        key.headers,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(
        `${prefix}/seller/licenses/${b.licenseId}/revoke`,
        { revoked: true },
        key.headers,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.db("licenses").where({ id: b.licenseId }).first()).revoked,
    0,
  );
});

test("tenant overview reports actual currencies, storage and successful downloads without storage URLs", async (t) => {
  const f = await fixture(t);
  const a = await commerce(f);
  const key = await f.key();
  const other = await merchant(f);
  await commerce(f, other);
  await f.db("invoice_metrics").insert([
    {
      tenant_id: "primary",
      invoice_id: "one",
      currency: "usd",
      paid_minor: 1200,
      refunded_minor: 200,
    },
    {
      tenant_id: "primary",
      invoice_id: "two",
      currency: "eur",
      paid_minor: 3000,
      refunded_minor: 0,
    },
    {
      tenant_id: other.id,
      invoice_id: "three",
      currency: "usd",
      paid_minor: 999999,
      refunded_minor: 0,
    },
  ]);
  const metadataReply = await f.app.inject({
    url: `${prefix}/updates/plugin`,
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(metadataReply.statusCode, 200);
  const url = new URL(metadataReply.json().download_url);
  assert.equal(url.origin, f.config.origin);
  assert.equal(url.search, "");
  assert.ok(!metadataReply.body.includes("s3"));
  assert.equal((await f.app.inject({ url: url.pathname })).statusCode, 401);
  const download = await f.app.inject({
    url: url.pathname,
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, a.bytes);
  const overview = await f.app.inject({
    url: `${prefix}/seller/overview`,
    headers: key.headers,
  });
  assert.equal(overview.statusCode, 200, overview.body);
  const metrics = overview.json().metrics;
  assert.deepEqual(metrics.payments, [
    {
      currency: "eur",
      paidMinor: "3000",
      refundedMinor: "0",
      netMinor: "3000",
    },
    {
      currency: "usd",
      paidMinor: "1200",
      refundedMinor: "200",
      netMinor: "1000",
    },
  ]);
  assert.equal(metrics.licenses.issued, 1);
  assert.equal(metrics.seats.used, 1);
  assert.equal(metrics.storage.usedBytes, a.bytes.length);
  assert.equal(metrics.downloads.successfulResponses, 1);
  for (const secret of ["key_hash", a.token, "X-Amz-", "s3://"])
    assert.ok(!overview.body.includes(secret), secret);
});

test("delinquency blocks new capacity while paid buyer recovery remains available; abuse suspension denies service", async (t) => {
  const f = await fixture(t);
  const a = await commerce(f);
  const key = await f.key();
  await f.db("tenants").where({ id: "primary" }).update({
    exempt: 0,
    trial_ends_at: 1,
    paid_through: 1,
    billing_status: "past_due",
  });
  assert.equal(
    (
      await f.post(
        `${prefix}/seller/products`,
        {
          slug: "new",
          name: "New",
          plans: [{ name: "One", siteAllowance: 1, priceId: "price_new" }],
        },
        key.headers,
      )
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.post(`${prefix}/checkout`, {
        planId: a.planId,
        email: "new@example.test",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/packages/${a.release.id}`,
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/seller/overview`,
        headers: key.headers,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/tenants/primary/status",
        { suspended: true },
        f.operator,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/packages/${a.release.id}`,
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/seller/overview`,
        headers: key.headers,
      })
    ).statusCode,
    403,
  );
});

test("release transport authenticates before parsing and applies the configured byte cap", async (t) => {
  const f = await fixture(t, true, 1024);
  const key = await f.key();
  const url = `${prefix}/seller/releases/plugin/1.0.0`;
  const unauth = await f.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json" },
    payload: "{invalid",
  });
  assert.equal(unauth.statusCode, 401, unauth.body);
  const capped = await f.app.inject({
    method: "POST",
    url,
    headers: {
      ...key.headers,
      "content-type": "application/zip",
      "x-release-metadata": metadata,
    },
    payload: Buffer.alloc(1025),
  });
  assert.equal(capped.statusCode, 413);
  assert.equal((await f.db("releases")).length, 0);
  assert.equal((await f.db("upload_reservations")).length, 0);
  const invalid = await f.app.inject({
    method: "POST",
    url,
    headers: {
      ...key.headers,
      "content-type": "application/zip",
      "x-release-metadata": metadata,
    },
    payload: Buffer.from("invalid zip"),
  });
  assert.equal(invalid.statusCode, 404);
});

test("signed platform and Connect webhooks enforce endpoint, mode and account binding independently", async (t) => {
  const f = await fixture(t);
  const other = await merchant(f);
  const event = {
    id: "evt_shared",
    type: "customer.subscription.updated",
    livemode: false,
    data: { object: { id: "sub_fixture" } },
  };
  const send = async (
    path: string,
    body: object,
    secret: string,
    signature?: string,
  ) => {
    const payload = JSON.stringify(body);
    return f.app.inject({
      method: "POST",
      url: `/api/v1/stripe/${path}`,
      headers: {
        "content-type": "application/json",
        "stripe-signature":
          signature ??
          Stripe.webhooks.generateTestHeaderString({ payload, secret }),
      },
      payload,
    });
  };
  assert.equal(
    (
      await send(
        "connect-webhook",
        { ...event, account: "acct_primary" },
        f.config.stripeConnectWebhookSecret!,
        "invalid",
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (await send("connect-webhook", event, f.config.stripeConnectWebhookSecret!))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await send(
        "platform-webhook",
        { ...event, account: "acct_primary" },
        f.config.stripeWebhookSecret,
      )
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await send(
        "connect-webhook",
        { ...event, livemode: true, account: "acct_primary" },
        f.config.stripeConnectWebhookSecret!,
      )
    ).statusCode,
    200,
  );
  const ignored = await send(
    "connect-webhook",
    { ...event, account: "acct_unknown" },
    f.config.stripeConnectWebhookSecret!,
  );
  assert.equal(ignored.statusCode, 200);
  assert.equal(ignored.json().ignored, true);
  assert.equal((await f.db("billing_events")).length, 0);
  for (const account of ["acct_primary", other.stripe_account_id])
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await send(
            "connect-webhook",
            { ...event, account },
            f.config.stripeConnectWebhookSecret!,
          )
        ).statusCode,
        200,
      );
  assert.equal((await f.db("billing_events")).length, 2);
  assert.equal((await f.db("work")).length, 2);
  const platform = await send(
    "platform-webhook",
    { ...event, id: "evt_platform", type: "customer.subscription.updated" },
    f.config.stripeWebhookSecret,
  );
  assert.equal(platform.statusCode, 200, platform.body);
  assert.equal((await f.db("platform_events")).length, 1);
  assert.equal((await f.db("platform_work")).length, 1);
  assert.equal(
    (
      await send(
        "platform-webhook",
        { ...event, id: "evt_live", livemode: true },
        f.config.stripeWebhookSecret,
      )
    ).statusCode,
    400,
  );
});

test("seller Stripe catalog selects annual prices and sends account context on each list page", async (t) => {
  const f = await fixture(t, false);
  const key = await f.key();
  // Build the per-tenant adapter before injecting a deterministic SDK boundary.
  assert.equal(
    (await f.app.inject({ url: `${prefix}/catalog` })).statusCode,
    200,
  );
  const source = f.sources.get("primary")!;
  const annual = {
    id: "price_annual",
    product: { name: "Plugin" },
    nickname: null,
    unit_amount: 1200,
    currency: "usd",
    recurring: { interval: "year", interval_count: 1 },
  };
  let calls = 0;
  t.mock.method(
    source.stripe.prices,
    "list",
    (params: unknown, options: { stripeAccount: string }) => {
      assert.ok(params);
      assert.equal(options.stripeAccount, "acct_primary");
      calls++;
      return (async function* () {
        yield {
          ...annual,
          id: "price_month",
          recurring: { interval: "month", interval_count: 1 },
        };
        yield annual;
        yield { ...annual, id: "price_string", product: "prod_one" };
        yield {
          ...annual,
          id: "price_deleted",
          product: { id: "prod_deleted", deleted: true },
        };
      })();
    },
  );
  const prices = await f.app.inject({
    url: `${prefix}/seller/prices`,
    headers: key.headers,
  });
  assert.equal(prices.statusCode, 200, prices.body);
  assert.equal(calls, 1);
  assert.equal(prices.json().localMode, false);
  assert.equal(prices.json().prices.length, 3);
  assert.equal(prices.json().prices[0].productName, "Plugin");
  const again = await f.app.inject({
    url: `${prefix}/seller/prices`,
    headers: key.headers,
  });
  assert.deepEqual(again.json(), prices.json());
  assert.equal(calls, 1, "price picker should reuse the provider result");
  assert.equal((await f.app.inject(`${prefix}/seller/prices`)).statusCode, 401);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ stripe_account_id: "acct_reconnected" });

  t.mock.method(source.stripe.prices, "list", () =>
    (async function* () {
      for (let i = 0; i < 101; i++) yield { ...annual, id: `price_${i}` };
    })(),
  );
  const bounded = await f.app.inject({
    url: `${prefix}/seller/prices`,
    headers: key.headers,
  });
  assert.equal(bounded.json().prices.length, 100);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ stripe_account_id: null, stripe_status: "unconnected" });
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/seller/prices`,
        headers: key.headers,
      })
    ).statusCode,
    409,
  );
  const local = await fixture(t);
  const localKey = await local.key();
  const fixtures = await local.app.inject({
    url: `${prefix}/seller/prices`,
    headers: localKey.headers,
  });
  assert.equal(fixtures.json().localMode, true);
  assert.equal(fixtures.json().prices.length, 3);
});

test("seller OAuth callback binds the browser session and redirects only after connecting its Standard account", async (t) => {
  const f = await fixture(t, false);
  const browser = await seller(f);
  const created = await f.post(
    "/api/v1/platform/tenants",
    { slug: "oauth-merchant", name: "OAuth merchant" },
    browser,
  );
  assert.equal(created.statusCode, 200, created.body);
  const slug = created.json().tenant.slug as string;
  const route = `/api/v1/tenants/${slug}/seller`;
  const connected = await f.post(`${route}/stripe/connect`, {}, browser);
  assert.equal(connected.statusCode, 200, connected.body);
  const authorization = new URL(connected.json().url);
  const state = authorization.searchParams.get("state")!;
  t.mock.method(f.platform.stripe.oauth, "token", async () => ({
    stripe_user_id: "acct_oauth",
    scope: "read_write",
    livemode: false,
  }));
  t.mock.method(f.platform.stripe.accounts, "retrieve", async () => ({
    id: "acct_oauth",
    type: "standard",
    charges_enabled: true,
  }));
  const callback = await f.app.inject({
    url: `/api/v1/platform/stripe/callback?code=fixture&state=${state}`,
    headers: browser,
  });
  assert.equal(callback.statusCode, 302, callback.body);
  assert.equal(
    callback.headers.location,
    "/seller?tenant=oauth-merchant&connect=success",
  );
  const stored = await f.db("tenants").where({ slug }).first();
  assert.equal(stored.stripe_account_id, "acct_oauth");
  assert.equal(stored.stripe_status, "connected");
  assert.equal(
    (
      await f.app.inject({
        url: `/api/v1/platform/stripe/callback?code=fixture&state=${state}`,
        headers: browser,
      })
    ).statusCode,
    400,
  );
  t.mock.method(f.platform.stripe.prices, "retrieve", async () => ({
    active: true,
    type: "recurring",
    livemode: false,
  }));
  t.mock.method(f.platform.stripe.customers, "create", async () => ({
    id: "cus_platform_fixture",
  }));
  t.mock.method(f.platform.stripe.subscriptions, "list", () =>
    (async function* () {
      yield* [];
    })(),
  );
  t.mock.method(f.platform.stripe.checkout.sessions, "list", () =>
    (async function* () {
      yield* [];
    })(),
  );
  t.mock.method(f.platform.stripe.checkout.sessions, "create", async () => ({
    id: "cs_platform_fixture",
    url: "https://checkout.stripe.test/platform",
  }));
  const checkout = await f.post(`${route}/platform/checkout`, {}, browser);
  assert.equal(checkout.statusCode, 200, checkout.body);
  assert.equal(checkout.json().url, "https://checkout.stripe.test/platform");
  t.mock.method(
    f.platform.stripe.billingPortal.sessions,
    "create",
    async () => ({ url: "https://billing.stripe.test/platform" }),
  );
  t.mock.method(f.platform.stripe.billingPortal.configurations, "list", () =>
    (async function* () {
      yield* [];
    })(),
  );
  t.mock.method(
    f.platform.stripe.billingPortal.configurations,
    "create",
    async () => ({ id: "bpc_api_safe" }),
  );
  t.mock.method(
    f.platform.stripe.billingPortal.configurations,
    "retrieve",
    async () => ({
      id: "bpc_api_safe",
      metadata: { double_entitle_policy: "period_end_v1" },
      default_return_url: `${f.config.origin}/seller`,
      active: true,
      is_default: false,
      livemode: false,
      login_page: { enabled: false },
      features: {
        subscription_update: { enabled: false },
        subscription_cancel: {
          enabled: true,
          mode: "at_period_end",
          proration_behavior: "none",
        },
      },
    }),
  );
  const portal = await f.post(`${route}/platform/portal`, {}, browser);
  assert.equal(portal.statusCode, 200, portal.body);
  assert.equal(portal.json().url, "https://billing.stripe.test/platform");
  f.config.appBasePath = "/app";
  const reconnect = await f.post(`${route}/stripe/connect`, {}, browser);
  const nextState = new URL(reconnect.json().url).searchParams.get("state")!;
  const mountedCallback = await f.app.inject({
    url: `/api/v1/platform/stripe/callback?code=fixture&state=${nextState}`,
    headers: browser,
  });
  assert.equal(mountedCallback.statusCode, 302, mountedCallback.body);
  assert.equal(
    mountedCallback.headers.location,
    "/app/seller?tenant=oauth-merchant&connect=success",
  );
});

test("platform operator administration validates targets and audits status, owner, job recovery and local fixtures", async (t) => {
  const f = await fixture(t);
  const browser = await seller(f);
  assert.equal(
    (await f.app.inject("/api/v1/operator/tenants")).statusCode,
    401,
  );
  const listed = await f.app.inject({
    url: "/api/v1/operator/tenants",
    headers: f.operator,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().tenants.length, 1);
  assert.equal(
    (await f.post("/api/v1/operator/tenants/primary/status", {}, f.operator))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/tenants/missing/status",
        { exempt: true },
        f.operator,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/tenants/primary/status",
        {
          exempt: false,
          maxProducts: 7,
          maxStorageBytes: 100000,
          suspended: false,
        },
        f.operator,
      )
    ).statusCode,
    200,
  );
  const tenant = await f.db("tenants").where({ id: "primary" }).first();
  assert.equal(tenant.max_products, 7);
  assert.equal(tenant.max_storage_bytes, 100000);
  assert.equal(tenant.exempt, 0);
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/tenants/missing/owner",
        { email: "owner@example.test" },
        f.operator,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/tenants/primary/owner",
        { email: "unverified@example.test" },
        f.operator,
      )
    ).statusCode,
    409,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await f.post(
          "/api/v1/operator/tenants/primary/owner",
          { email: "OWNER@example.test" },
          f.operator,
        )
      ).statusCode,
      200,
    );
  assert.equal((await f.db("seller_memberships")).length, 1);
  assert.equal(
    (await f.post("/api/v1/operator/tenants/primary/reconcile", {}, f.operator))
      .statusCode,
    503,
  );
  const external = await fixture(t, false);
  assert.equal(
    (
      await external.post(
        "/api/v1/operator/tenants/primary/reconcile",
        {},
        external.operator,
      )
    ).statusCode,
    200,
  );
  for (const table of ["platform_work", "platform_emails"]) {
    await f.db(table).insert({
      id: `failed-${table}`,
      kind: "fixture",
      payload: "private encrypted payload",
      created_at: Date.now(),
      state: "failed",
      attempts: 10,
      last_error: "processing_failed",
    });
  }
  const jobs = await f.app.inject({
    url: "/api/v1/operator/jobs",
    headers: f.operator,
  });
  assert.equal(jobs.statusCode, 200);
  assert.equal(jobs.json().work.length, 1);
  assert.equal(jobs.json().emails.length, 2);
  assert.ok(!jobs.body.includes("private encrypted payload"));
  for (const table of ["platform_work", "platform_emails"]) {
    assert.equal(
      (
        await f.post(
          `/api/v1/operator/jobs/${table}/failed-${table}/retry`,
          {},
          f.operator,
        )
      ).statusCode,
      200,
    );
    const job = await f
      .db(table)
      .where({ id: `failed-${table}` })
      .first();
    assert.equal(job.state, "pending");
    assert.equal(job.attempts, 0);
    assert.equal(
      (
        await f.post(
          `/api/v1/operator/jobs/${table}/failed-${table}/retry`,
          {},
          f.operator,
        )
      ).statusCode,
      404,
    );
  }
  assert.equal(
    (await f.post("/api/v1/operator/jobs/run", {}, f.operator)).statusCode,
    200,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/local/tenants/missing",
        { connected: true },
        f.operator,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/local/tenants/primary",
        { connected: false, paidDays: 0 },
        f.operator,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.db("tenants").where({ id: "primary" }).first()).stripe_status,
    "disconnected",
  );
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ stripe_account_id: null });
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/local/tenants/primary",
        { connected: true, paidDays: 3 },
        f.operator,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.post("/api/v1/operator/local/tenants/primary", {}, f.operator))
      .statusCode,
    400,
  );
  const fixed = await f.db("tenants").where({ id: "primary" }).first();
  assert.equal(fixed.stripe_status, "connected");
  assert.match(fixed.stripe_account_id, /^acct_[A-Za-z0-9]+$/);
  assert.equal(fixed.billing_status, "active");
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/local/tenants/primary",
        { connected: true },
        f.operator,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.post(
        "/api/v1/operator/local/tenants/primary",
        { paidDays: 3 },
        f.operator,
      )
    ).statusCode,
    200,
  );
  const actions = new Set(
    (await f.db("audit_events").where({ actor_type: "operator" })).map(
      (event) => event.action,
    ),
  );
  assert.deepEqual([...actions].sort(), [
    "job.retry_requested",
    "local.tenant_fixture",
    "membership.granted",
    "tenant.status_changed",
  ]);
  assert.equal(
    (await f.app.inject({ url: `${prefix}/seller/overview`, headers: browser }))
      .statusCode,
    200,
  );
  const product = await f.post(
    `${prefix}/seller/products`,
    {
      slug: "interactive",
      name: "Interactive",
      plans: [{ name: "One", siteAllowance: 1, priceId: "price_interactive" }],
    },
    browser,
  );
  assert.equal(product.statusCode, 200, product.body);
  const audit = await f
    .db("audit_events")
    .where({ action: "product.configured" })
    .first();
  assert.equal(audit.actor_type, "seller");
  assert.equal(audit.actor_id, (await f.db("seller_users").first()).id);
});

test("download telemetry failure preserves verified bytes and transfer limits reject oversized stored metadata", async (t) => {
  const f = await fixture(t);
  f.config.transferMemoryBytes = 1024 * 1024;
  const a = await commerce(f);
  const key = await f.key();
  const url = `${prefix}/packages/${a.release.id}`,
    headers = { authorization: `Bearer ${a.token}` };
  const fail = (query: { sql: string }) => {
    if (/^insert into ["`]download_metrics["`]/.test(query.sql))
      throw Error("Metrics unavailable");
  };
  f.db.on("query", fail);
  try {
    const response = await f.app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.rawPayload, a.bytes);
  } finally {
    f.db.off("query", fail);
  }
  assert.equal((await f.db("download_metrics")).length, 0);
  await f
    .db("releases")
    .where({ id: a.release.id })
    .update({ size: 200 * 1024 * 1024 });
  const limited = await f.app.inject({ url, headers });
  assert.equal(limited.statusCode, 503);
  assert.equal(limited.json().error.code, "transfer_capacity");
  await f
    .db("releases")
    .where({ id: a.release.id })
    .update({ size: a.bytes.length });
  assert.equal(
    (await f.app.inject({ url, headers })).statusCode,
    200,
    "A rejected allocation must not pin transfer capacity",
  );
  for (const patch of [
    { revoked: 1, refund_revoked: 0, suspended: 1 },
    { revoked: 0, refund_revoked: 1, suspended: 0 },
  ]) {
    await f.db("licenses").where({ id: a.licenseId }).update(patch);
    const overview = await f.app.inject({
      url: `${prefix}/seller/overview`,
      headers: key.headers,
    });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().licenses[0].revoked, true);
    assert.equal(overview.json().licenses[0].suspended, !!patch.suspended);
  }
});

test("default S3 configuration and chunked upload admission preserve limits and durable account-event receipts", async (t) => {
  const f = await fixture(t);
  const config = { ...f.config };
  delete config.maxUploadBytes;
  delete config.stripeConnectWebhookSecret;
  // Construction exercises the real S3 adapter configuration without a storage request.
  const app = await buildApp(config, f.db);
  t.after(() => app.close());
  assert.equal(
    (await app.inject("/api/v1/platform/info")).json().maxUploadBytes,
    25 * 1024 * 1024,
  );
  const upload = await app.inject({
    method: "POST",
    url: `${prefix}/seller/releases/plugin/1.0.0`,
    headers: {
      "content-type": "application/zip",
      "transfer-encoding": "chunked",
    },
    payload: Readable.from([Buffer.from("not a zip")]),
  });
  assert.equal(upload.statusCode, 401, upload.body);
  const event = {
    id: "evt_account_update",
    type: "account.updated",
    account: "acct_primary",
    livemode: false,
    data: { object: { id: "acct_primary", charges_enabled: false } },
  };
  const payload = JSON.stringify(event);
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/stripe/connect-webhook",
    headers: {
      "content-type": "application/json",
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({
        payload,
        secret: "whsec_connect_local",
      }),
    },
    payload,
  });
  assert.equal(response.statusCode, 200, response.body);
  const receipt = await f.db("platform_events").where({ id: event.id }).first();
  assert.ok(receipt);
  assert.equal(receipt.processed_at, null);
  assert.equal(
    (await f.db("platform_work").where({ id: event.id }).first()).kind,
    "connect_account",
  );
  assert.equal(
    (await f.db("tenants").where({ id: "primary" }).first()).stripe_status,
    "connected",
  );
});

test("authenticated WordPress installations sharing an IP retain separate rate budgets", async (t) => {
  const f = await fixture(t);
  const a = await commerce(f);
  await f
    .db("licenses")
    .where({ id: a.licenseId })
    .update({ site_allowance: 2 });
  const second = await f.post(`${prefix}/activate`, {
    key: a.licenseKey,
    installationId: "installation-002",
    siteUrl: "https://second.example.test",
    product: "plugin",
  });
  assert.equal(second.statusCode, 200, second.body);
  const request = (token: string) =>
    f.app.inject({
      url: `${prefix}/updates/plugin`,
      headers: { authorization: `Bearer ${token}` },
    });
  for (const token of [a.token, second.json().token as string])
    for (let i = 0; i < 35; i++) {
      const response = await request(token);
      assert.equal(
        response.statusCode,
        200,
        `A separate installation budget was exhausted at request ${i + 1}`,
      );
    }
  for (let i = 0; i < 25; i++)
    assert.equal((await request(a.token)).statusCode, 200);
  const denied = await request(a.token);
  assert.equal(denied.statusCode, 429);
  assert.equal(denied.json().error.code, "rate_limited");
  assert.equal(
    (await request(second.json().token)).statusCode,
    200,
    "Exhausting one installation must not consume another installation's budget",
  );
});

test("tenant job recovery requeues only its failed jobs and tenant workers do not run another publisher's queue", async (t) => {
  const f = await fixture(t);
  const other = await merchant(f);
  const a = await commerce(f),
    b = await commerce(f, other);
  const key = await f.key();
  for (const [tenantId, customerId, suffix] of [
    ["primary", a.customerId, "own"],
    [other.id, b.customerId, "foreign"],
  ]) {
    await f.db("work").insert({
      tenant_id: tenantId,
      id: `work-${suffix}`,
      kind: "reconcile",
      payload: seal({ subscriptionId: "sub_invalid" }, f.config.secret),
      created_at: Date.now(),
      state: "failed",
      attempts: 12,
      last_error: "processing_failed",
    });
    await f.db("emails").insert({
      tenant_id: tenantId,
      id: `email-${suffix}`,
      customer_id: customerId,
      kind: "login",
      payload: seal(
        {
          to: "buyer@example.test",
          subject: "Fixture",
          text: "Hello",
          messageId: `<email-${suffix}@fixture>`,
        },
        f.config.secret,
      ),
      created_at: Date.now(),
      state: "failed",
      attempts: 12,
      last_error: "processing_failed",
    });
  }
  for (const [table, id] of [
    ["work", "work-own"],
    ["emails", "email-own"],
  ] as const) {
    const reply = await f.post(
      `${prefix}/seller/jobs/${table}/${id}/retry`,
      {},
      key.headers,
    );
    assert.equal(reply.statusCode, 200, reply.body);
    const row = await f.db(table).where({ tenant_id: "primary", id }).first();
    assert.equal(row.state, "pending");
    assert.equal(row.attempts, 0);
    assert.equal(row.lease_until, 0);
    assert.equal(row.last_error, null);
    assert.equal(
      (
        await f.post(
          `${prefix}/seller/jobs/${table}/${id}/retry`,
          {},
          key.headers,
        )
      ).statusCode,
      404,
    );
  }
  assert.equal(
    (
      await f.post(
        `${prefix}/seller/jobs/work/work-foreign/retry`,
        {},
        key.headers,
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.post(
        `${prefix}/seller/jobs/platform_work/missing/retry`,
        {},
        key.headers,
      )
    ).statusCode,
    400,
  );
  // A pending job in the other tenant must remain untouched by this manual run.
  await f
    .db("emails")
    .where({ tenant_id: other.id, id: "email-foreign" })
    .update({ state: "pending", attempts: 0 });
  assert.equal(
    (await f.post(`${prefix}/seller/jobs/run`, {}, key.headers)).statusCode,
    200,
  );
  assert.equal(
    (
      await f
        .db("emails")
        .where({ tenant_id: "primary", id: "email-own" })
        .first()
    ).state,
    "sent",
  );
  const foreign = await f
    .db("emails")
    .where({ tenant_id: other.id, id: "email-foreign" })
    .first();
  assert.equal(foreign.state, "pending");
  assert.equal(foreign.attempts, 0);
  assert.ok(
    (
      await f
        .db("audit_events")
        .where({ tenant_id: "primary", action: "job.retry_requested" })
    ).length === 2,
  );
});

test("global workers isolate failed tenant cleanup and continue another tenant's email delivery", async (t) => {
  const f = await fixture(t);
  const other = await merchant(f);
  const b = await commerce(f, other);
  const reservation = randomUUID();
  await f
    .db("upload_reservations")
    .insert({ tenant_id: "primary", id: reservation, bytes: 1, expires_at: 1 });
  await f.db("emails").insert({
    tenant_id: other.id,
    id: "delivered-after-failure",
    customer_id: b.customerId,
    kind: "login",
    payload: seal(
      {
        to: "buyer@example.test",
        subject: "Isolated",
        text: "Hello",
        messageId: "<isolated@fixture>",
      },
      f.config.secret,
    ),
    created_at: Date.now(),
  });
  const remove = f.store.delete.bind(f.store);
  t.mock.method(f.store, "delete", async (tenantId: string, id: string) => {
    if (tenantId === "primary") throw Error("Transient cleanup failure");
    await remove(tenantId, id);
  });
  const result = await f.post("/api/v1/operator/jobs/run", {}, f.operator);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(
    (
      await f
        .db("emails")
        .where({ tenant_id: other.id, id: "delivered-after-failure" })
        .first()
    ).state,
    "sent",
  );
  assert.ok(
    await f
      .db("upload_reservations")
      .where({ tenant_id: "primary", id: reservation })
      .first(),
  );
  assert.ok(
    f.sent.some((message) => message.messageId === "<isolated@fixture>"),
  );
});

test("hosted deployment never accepts merchant-scope webhook ingress", async (t) => {
  const f = await fixture(t);
  const result = await f.post("/api/v1/stripe/merchant-webhook");
  assert.equal(result.statusCode, 404);
});
