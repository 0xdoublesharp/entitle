import { primaryTenant, testTenantKey } from "./helpers/tenant.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import filesystem from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createServer as createSmtpServer, type Socket } from "node:net";
import Stripe from "stripe";
import { buildApp } from "../src/app.ts";
import { createDb, migrate, reset } from "../src/db.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { StripeBilling } from "../src/stripe.ts";
import { csrf, hash, unseal } from "../src/crypto.ts";
import type { Mailer, Message } from "../src/email.ts";
import { Auth } from "../src/auth.ts";
import { AppError } from "../src/errors.ts";

process.env.NODE_ENV = "test";
const scratch = "/Volumes/Scratch/entitle/tmp/";
const metadata = {
  changelog: "<p>Coverage release</p>",
  minWp: "6.0",
  minPhp: "7.4",
  minFree: "0.0.0",
  tested: "7.0",
};
const metadataHeader = Buffer.from(JSON.stringify(metadata)).toString(
  "base64url",
);
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
async function stripeFixture() {
  const requests: { method: string; path: string; body: URLSearchParams }[] =
    [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const url = new URL(req.url!, "http://fixture");
    requests.push({
      method: req.method!,
      path: url.pathname,
      body: new URLSearchParams(Buffer.concat(chunks).toString()),
    });
    res.setHeader("content-type", "application/json");
    let data: unknown;
    if (url.pathname === "/v1/prices/price_base")
      data = {
        id: "price_base",
        active: true,
        type: "recurring",
        recurring: { interval: "year", interval_count: 1 },
      };
    else if (url.pathname === "/v1/checkout/sessions")
      data = {
        id: "cs_coverage",
        url: "https://checkout.stripe.test/coverage",
        client_secret:"cs_coverage_secret_fixture",
      };
    else if (url.pathname === "/v1/billing_portal/sessions")
      data = {
        id: "bps_coverage",
        url: "https://billing.stripe.test/coverage",
      };
    else if (url.pathname === "/v1/customers" && req.method === "POST")
      data = {
        id: `cus_created_${requests.length}`,
        email: requests.at(-1)!.body.get("email"),
      };
    else if (url.pathname === "/v1/subscriptions")
      data = { object: "list", data: [{ id: "sub_alice" }], has_more: false };
    else if (url.pathname === "/v1/subscriptions/sub_alice")
      data = { id: "sub_alice", customer: "cus_alice", status: "past_due" };
    else if (url.pathname === "/v1/customers/cus_alice")
      data = { id: "cus_alice", email: "alice@example.test" };
    else if (url.pathname === "/v1/invoices")
      data = { object: "list", data: [], has_more: false };
    else {
      res.statusCode = 404;
      data = {
        error: {
          type: "invalid_request_error",
          message: "Unexpected fixture request",
        },
      };
    }
    res.end(JSON.stringify(data));
  });
  const port = await listen(server);
  return {
    requests,
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
async function fixture(
  options: {
    local?: boolean;
    production?: boolean;
    mailer?: Mailer;
    smtpPort?: number;
    smtpUser?: string;
    static?: boolean;
    databaseUrl?: string;
    provider?: Awaited<ReturnType<typeof stripeFixture>>;
  } = {},
) {
  const root = await mkdtemp(scratch + "api-coverage-");
  const databaseUrl = options.databaseUrl ?? process.env.TEST_API_DATABASE_URL;
  const config: Config = loadConfig({ DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "66".repeat(32),
    OPERATOR_TOKEN: "coverage-operator-token-1234567890123456789",
    DATA_DIR: root,
    WEB_DIR: root + "/web",
    NODE_ENV: options.production ? "production" : "test",
    PUBLIC_ORIGIN: options.production
      ? "https://coverage.example.test"
      : "http://coverage.example.test",
    S3_BUCKET: "fixture-private-bucket",
    S3_REGION: "us-east-1",
    STRIPE_SECRET_KEY: "sk_test_coverage",
    STRIPE_WEBHOOK_SECRET: "whsec_coverage",
    STRIPE_PUBLISHABLE_KEY:"pk_test_coverage",
    STRIPE_CONNECT_CLIENT_ID:"ca_coverage",
    STRIPE_CONNECT_WEBHOOK_SECRET:"whsec_connect_coverage",
    PLATFORM_STRIPE_PRICE_ID:"price_platform_coverage",
    SMTP_HOST: "127.0.0.1",
    MAIL_FROM:"licenses@example.com",
    TRUST_PROXY:"172.30.81.2",
    SMTP_PORT: String(options.smtpPort ?? 1025),
    SMTP_USER: options.smtpUser ?? "",
    SMTP_PASS: options.smtpUser ? "fixture-password" : "",
    LOCAL_BILLING: options.local ? "true" : "false",
    ...(databaseUrl ? { DATABASE_URL: databaseUrl } : {}),
  });
  const db = createDb(config.databaseUrl);
  await migrate(db);
  if (databaseUrl) await reset(db);
  if (options.static) {
    await mkdir(config.staticDir);
    await writeFile(
      config.staticDir + "/index.html",
      "<!doctype html><title>Coverage customer</title>",
    );
  }
  const sent: Message[] = [];
  const mailer = options.smtpPort
    ? undefined
    : (options.mailer ?? {
        send: async (message: Message) => {
          sent.push(message);
        },
      });
  await seedTenantKey(db);
  await db("tenants")
    .where({ id: "primary" })
    .update({ stripe_account_id: "acct_primary", stripe_status: "connected" });
  const store = new InMemoryArtifactStore();
  const stripe = new StripeBilling(db, config, primaryTenant);
  if (!options.provider)
    mock.method(stripe.stripe.prices, "retrieve", async () => ({
      active: true,
      type: "recurring",
      recurring: { interval: "year", interval_count: 1 },
    }));
  if (options.provider)
    stripe.stripe = new Stripe(config.stripeSecret, {
      host: "127.0.0.1",
      port: options.provider!.port,
      protocol: "http",
      maxNetworkRetries: 0,
    });
  const app = await buildApp(config, db, mailer, {
    store,
    ...(stripe ? { stripeFactory: () => stripe } : {}),
  });
  const cookieName = new Auth(db, config, primaryTenant).cookieName;
  const operator = { authorization: `Bearer ${testTenantKey}` };
  const close = async () => {
    await app.close();
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  };
  const post = (
    url: string,
    payload: object = {},
    headers: Record<string, string> = operator,
  ) =>
    app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary" + url,
      headers: {
        ...(url === "/auth/request" ? { origin: config.origin } : {}),
        ...headers,
      },
      payload,
    });
  return {
    root,
    config,
    db,
    app,
    operator,
    sent,
    post,
    close,
    store,
    cookieName,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function seed(f: Fixture) {
  await f.db("customers").insert([
    {
      tenant_id: "primary",
      id: "alice",
      email: "alice@example.test",
      stripe_id: "cus_alice",
    },
    {
      tenant_id: "primary",
      id: "bob",
      email: "bob@example.test",
      stripe_id: null,
    },
  ]);
  const created = await f.post("/seller/products", {
    slug: "coverage-pro",
    name: "Coverage Pro",
    plans: [{ name: "One site", siteAllowance: 1, priceId: "price_base" }],
  });
  assert.equal(created.statusCode, 200, created.body);
  const { product, plans } = created.json();
  await f.db("licenses").insert({
    tenant_id: "primary",
    id: "license-alice",
    customer_id: "alice",
    product_id: product.id,
    plan_id: plans[0].id,
    site_allowance: 1,
    paid_through: Date.now() + 86400000,
    billing_status: "active",
    subscription_id: "sub_alice",
    key_hash: hash("DE-coverage-key"),
  });
  return { product, plan: plans[0] };
}
async function session(f: Fixture, customer = "alice") {
  const secret = "session-" + customer;
  await f.db("sessions").insert({
    tenant_id: "primary",
    id: hash(secret),
    customer_id: customer,
    expires_at: Date.now() + 86400000,
  });
  return {
    cookie: `${f.cookieName}=${secret}`,
    origin: f.config.origin,
    "x-csrf-token": csrf(secret, f.config.secret),
  };
}
async function activate(f: Fixture, id = "coverage-installation") {
  const reply = await f.post("/activate", {
    key: "DE-coverage-key",
    installationId: id,
    siteUrl: "https://alice.example.test",
    product: "coverage-pro",
  });
  assert.equal(reply.statusCode, 200, reply.body);
  return { authorization: `Bearer ${reply.json().token}` };
}
async function zip(f: Fixture) {
  await mkdir(f.root + "/coverage-pro", { recursive: true });
  await writeFile(
    f.root + "/coverage-pro/coverage-pro.php",
    "<?php\n/*\nPlugin Name: Coverage\nVersion: 1.0.0\n*/",
  );
  execFileSync(
    "zip",
    ["-q", f.root + "/release.zip", "coverage-pro/coverage-pro.php"],
    {
      cwd: f.root,
      env: { ...process.env, TMPDIR: f.root },
    },
  );
  return readFile(f.root + "/release.zip");
}

test("operator changes retain immutable plan mappings, expose safe job views and restore revoked downloads", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const { product, plan } = await seed(f);
  let result = await f.post("/seller/products", {
    slug: "coverage-pro",
    name: "Renamed",
    plans: [
      { name: "Still one", siteAllowance: 1, priceId: "price_base" },
      { name: "Five", siteAllowance: 5, priceId: "price_five" },
    ],
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().product.id, product.id);
  assert.equal(result.json().product.name, "Renamed");
  assert.equal(result.json().plans.length, 2);
  assert.equal(
    result.json().plans.find((p: { id: string }) => p.id === plan.id)
      .site_allowance,
    1,
  );
  result = await f.post("/seller/products", {
    slug: "coverage-pro",
    name: "Must roll back",
    plans: [
      { name: "Changed allowance", siteAllowance: 9, priceId: "price_base" },
    ],
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error.code, "plan_immutable");
  assert.equal(
    (await f.db("products").where({ id: product.id }).first()).name,
    "Renamed",
  );
  result = await f.post("/seller/products", {
    slug: "different-pro",
    name: "Other",
    plans: [{ name: "Conflict", siteAllowance: 1, priceId: "price_base" }],
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().error.code, "price_conflict");
  assert.equal(
    await f.db("products").where({ slug: "different-pro" }).first(),
    undefined,
  );
  const activation = await activate(f);
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/tenants/primary/activation",
        headers: activation,
      })
    ).json().entitled,
    true,
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/tenants/primary/updates/coverage-pro",
        headers: activation,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/tenants/primary/updates/foreign-product",
        headers: activation,
      })
    ).json().error.code,
    "wrong_product",
  );
  for (const revoked of [true, false]) {
    assert.equal(
      (await f.post("/seller/licenses/license-alice/revoke", { revoked }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/v1/tenants/primary/activation",
          headers: activation,
        })
      ).json().entitled,
      !revoked,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/v1/tenants/primary/updates/coverage-pro",
          headers: activation,
        })
      ).statusCode,
      revoked ? 403 : 204,
    );
  }
  assert.equal(
    (await f.post("/seller/licenses/missing/revoke", { revoked: true }))
      .statusCode,
    404,
  );
  const list = await f.app.inject({
    url: "/api/v1/tenants/primary/seller/overview",
    headers: f.operator,
  });
  assert.equal(list.json().licenses.length, 1);
  assert.ok(!Object.hasOwn(list.json().licenses[0], "key_hash"));
  await f.db("work").insert({
    tenant_id: "primary",
    id: "private-work",
    kind: "reconcile",
    payload: "secret-work",
    created_at: Date.now(),
  });
  await f.db("emails").insert({
    tenant_id: "primary",
    id: "private-email",
    kind: "login",
    customer_id: "alice",
    payload: "secret-email",
    created_at: Date.now(),
  });
  const jobs = await f.app.inject({
    url: "/api/v1/tenants/primary/seller/jobs",
    headers: f.operator,
  });
  assert.equal(jobs.json().work[0].id, "private-work");
  assert.equal(jobs.json().emails[0].id, "private-email");
  assert.ok(!jobs.body.includes("secret-work"));
  assert.ok(!jobs.body.includes("secret-email"));
});

test("fourth service option uses the real Stripe SDK HTTP boundary for checkout, portal and reconciliation", async (t) => {
  const provider = await stripeFixture();
  t.after(provider.close);
  const f = await fixture({ provider });
  t.after(f.close);
  const { plan } = await seed(f);
  const headers = await session(f);
  const checkout = await f.post(
    "/checkout",
    { planId: plan.id, email: "ALICE@example.test" },
    headers,
  );
  assert.equal(checkout.statusCode, 200, checkout.body);
  assert.equal(checkout.json().url, "https://checkout.stripe.test/coverage");
  const elements=await f.post("/checkout",{planId:plan.id,email:"alice@example.test",uiMode:"elements"},headers);
  assert.equal(elements.statusCode,200,elements.body);
  assert.equal(elements.json().uiMode,"elements");
  assert.equal(elements.json().clientSecret,"cs_coverage_secret_fixture");
  assert.equal(elements.json().publishableKey,"pk_test_coverage");
  assert.equal(elements.json().stripeAccount,primaryTenant.stripe_account_id);
  assert.equal(elements.headers["cache-control"],"no-store");
  assert.equal(provider.requests.at(-1)!.body.get("ui_mode"),"elements");
  assert.equal(provider.requests.at(-1)!.body.get("line_items[0][price]"),plan.stripe_price_id);
  assert.equal((await f.post("/checkout",{planId:plan.id,email:"alice@example.test",uiMode:"elements",stripeAccount:"acct_attacker"},headers)).statusCode,400);
  assert.equal((await f.post("/checkout",{planId:plan.id,email:"alice@example.test",uiMode:"custom"},headers)).statusCode,400);
  const checkoutCount = provider.requests.filter(
    (request) => request.path === "/v1/checkout/sessions",
  ).length;
  const anonymousExisting = await f.post(
    "/checkout",
    { planId: plan.id, email: "alice@example.test" },
    {},
  );
  assert.equal(anonymousExisting.statusCode, 401);
  assert.equal(anonymousExisting.json().error.code, "login_required");
  const expiredSession = await f.post(
    "/checkout",
    { planId: plan.id, email: "alice@example.test" },
    { cookie: `${f.cookieName}=expired-session` },
  );
  assert.equal(expiredSession.statusCode, 401);
  assert.equal(
    provider.requests.filter(
      (request) => request.path === "/v1/checkout/sessions",
    ).length,
    checkoutCount,
    "Rejected ownership must not create a Stripe Checkout session.",
  );
  const portal = await f.post("/portal", {}, headers);
  assert.equal(portal.statusCode, 200, portal.body);
  assert.equal(portal.json().url, "https://billing.stripe.test/coverage");
  const newCheckout = await f.post(
    "/checkout",
    { planId: plan.id, email: "new@example.test" },
    {},
  );
  assert.equal(newCheckout.statusCode, 200, newCheckout.body);
  assert.equal(
    provider.requests
      .find((r) => r.path === "/v1/billing_portal/sessions")!
      .body.get("customer"),
    "cus_alice",
  );
  assert.equal(
    provider.requests
      .find((r) => r.path === "/v1/checkout/sessions")!
      .body.get("customer"),
    "cus_alice",
  );
  const noCustomer = await f.post("/portal", {}, await session(f, "bob"));
  assert.equal(noCustomer.statusCode, 409);
  assert.equal(noCustomer.json().error.code, "no_billing_customer");
  assert.equal(
    (await f.post("/seller/reconcile", { subscriptionId: "sub_alice" })).json()
      .queued,
    1,
  );
  assert.equal((await f.post("/seller/reconcile")).json().queued, 1);
  assert.equal((await f.post("/seller/jobs/run")).statusCode, 200);
  assert.equal(
    (await f.db("licenses").where({ id: "license-alice" }).first())
      .billing_status,
    "past_due",
  );
  assert.ok((await f.db("work")).every((job) => job.state === "sent"));
  assert.ok(provider.requests.some((r) => r.path === "/v1/subscriptions"));
  const event = {
    id: "evt_coverage_http",
    account: "acct_primary",
    livemode: false,
    type: "customer.subscription.updated",
    data: { object: { id: "sub_alice" } },
  };
  const payload = JSON.stringify(event);
  const signature = new Stripe(
    "sk_test_coverage",
  ).webhooks.generateTestHeaderString({
    payload,
    secret: f.config.stripeConnectWebhookSecret!,
  });
  const received = await f.app.inject({
    method: "POST",
    url: "/api/v1/stripe/connect-webhook",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signature,
    },
    payload,
  });
  assert.equal(received.statusCode, 200, received.body);
  assert.equal((await f.post("/seller/jobs/run")).statusCode, 200);
  assert.equal(
    (await f.db("work").where({ id: event.id }).first()).state,
    "sent",
  );
});
test("an unpaid guest can retry Elements checkout only with the issuing browser claim",async(t)=>{
  const provider=await stripeFixture();t.after(provider.close);
  const f=await fixture({provider});t.after(f.close);const {plan}=await seed(f);
  const body={planId:plan.id,email:"unpaid@example.test",uiMode:"elements"};
  const first=await f.post("/checkout",body);
  assert.equal(first.statusCode,200,first.body);
  const cookie=String(first.headers["set-cookie"]??"").split(";")[0]!;
  assert.ok(cookie.includes("de-checkout-"));
  assert.match(String(first.headers["set-cookie"]),/HttpOnly/i);
  const retry=await f.post("/checkout",body,{cookie});
  assert.equal(retry.statusCode,200,retry.body);
  assert.equal((await f.post("/checkout",body)).statusCode,401);
  assert.equal((await f.post("/checkout",body,{cookie:cookie+"corrupt"})).statusCode,401);
  const customer=await f.db("customers").where({tenant_id:"primary",email:body.email}).first();
  const source=await f.db("licenses").where({id:"license-alice"}).first();
  await f.db("licenses").insert({...source,id:"license-guest",key_hash:hash("guest-fixture-key"),customer_id:customer.id,subscription_id:"sub_guest"});
  assert.equal((await f.post("/checkout",body,{cookie})).statusCode,401,"guest claim must not replace buyer login after purchase");
});
test("platform recovery bulk retries are bounded, queue scoped, and restart the retry window",async(t)=>{
  const f=await fixture();t.after(f.close);
  for(const id of ["first","second"])await f.db("platform_work").insert({id,kind:"reconcile",payload:"{}",state:"failed",attempts:12,created_at:1});
  await f.db("platform_emails").insert({id:"first",kind:"login",payload:"encrypted",state:"failed",created_at:1});
  const call=(table:string,body:Record<string,unknown>)=>f.app.inject({method:"POST",url:`/api/v1/operator/jobs/${table}/retry-failed`,headers:{authorization:`Bearer ${f.config.operatorToken}`},payload:body});
  assert.equal((await call("platform_work",{limit:1})).json().queued,1);
  const one=await f.db("platform_work").where({state:"pending"}).first();
  assert.equal(one.attempts,0);assert.ok(Number(one.created_at)>Date.now()-10000);
  assert.equal((await f.db("platform_emails").where({id:"first"}).first()).state,"failed");
  assert.equal((await call("platform_work",{limit:0})).statusCode,400);
  assert.equal((await call("work",{})).statusCode,400);
  assert.equal((await call("platform_work",{})).json().queued,1);
  assert.equal((await call("platform_work",{})).json().queued,0);
  assert.equal((await call("platform_emails",{})).json().queued,1);
});

test("customer mutations enforce ownership, Unicode CSRF safety, revocation and stable activation credentials", async (t) => {
  const f = await fixture({ local: true });
  t.after(f.close);
  await seed(f);
  const headers = await session(f);
  const bobHeaders = await session(f, "bob");
  let activation = await activate(f);
  const installation = await f
    .db("installations")
    .where({ license_id: "license-alice" })
    .first();
  const rejectForeign = await f.post(
    `/installations/${installation.id}/deactivate`,
    {},
    bobHeaders,
  );
  assert.equal(rejectForeign.statusCode, 404);
  assert.equal(
    (await f.db("installations").where({ id: installation.id }).first()).active,
    1,
  );
  const malformedCsrf = await f.post(
    "/portal",
    {},
    { ...headers, "x-csrf-token": "é".repeat(headers["x-csrf-token"].length) },
  );
  assert.equal(malformedCsrf.statusCode, 403, malformedCsrf.body);
  assert.equal(malformedCsrf.json().error.code, "csrf_denied");
  assert.equal(
    (await f.post(`/installations/${installation.id}/deactivate`, {}, headers))
      .statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/tenants/primary/activation",
        headers: activation,
      })
    ).statusCode,
    401,
  );
  activation = await activate(f);
  const replaced = await f.post("/licenses/license-alice/key", {}, headers);
  assert.equal(replaced.statusCode, 200);
  assert.match(replaced.json().key, /^DE-/);
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/tenants/primary/activation",
        headers: activation,
      })
    ).statusCode,
    401,
  );
  const staleKey = await f.post("/activate", {
    key: "DE-coverage-key",
    installationId: "coverage-installation",
    siteUrl: "https://alice.example.test",
    product: "coverage-pro",
  });
  assert.equal(staleKey.statusCode, 401);
  const retry = await f.post("/activate", {
    key: replaced.json().key,
    installationId: "coverage-installation",
    siteUrl: "https://alice.example.test",
    product: "coverage-pro",
  });
  assert.equal(retry.statusCode, 200);
  const auth = { authorization: `Bearer ${retry.json().token}` };
  assert.equal((await f.post("/deactivate", {}, auth)).statusCode, 200);
  assert.equal(
    (
      await f.app.inject({
        url: "/api/v1/tenants/primary/activation",
        headers: auth,
      })
    ).statusCode,
    401,
  );
  const me = (
    await f.app.inject({ url: "/api/v1/tenants/primary/me", headers })
  ).json();
  assert.equal(me.licenses[0].installations.length, 1);
  assert.equal(me.licenses[0].installations[0].active, false);
  assert.equal(me.licenses[0].installations[0].exempt, false);
  await f
    .db("licenses")
    .where({ id: "license-alice" })
    .update({ revoked: 1, suspended: 1 });
  const denied = (
    await f.app.inject({ url: "/api/v1/tenants/primary/me", headers })
  ).json().licenses[0];
  assert.equal(denied.revoked, true);
  assert.equal(denied.suspended, true);
  assert.equal(denied.entitled, false);
  await f
    .db("licenses")
    .where({ id: "license-alice" })
    .update({ revoked: 0, refund_revoked: 1, suspended: 0 });
  assert.equal(
    (await f.app.inject({ url: "/api/v1/tenants/primary/me", headers })).json()
      .licenses[0].revoked,
    true,
  );
});

test("private publication validates every transport layer, preserves immutable bytes, and withdraws downloads", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await seed(f);
  const headers = await session(f);
  const activation = await activate(f);
  const bytes = await zip(f);
  const upload = (
    version: string,
    body: Buffer | object = bytes,
    metadataValue: string | null = metadataHeader,
    contentType = "application/zip",
  ) =>
    f.app.inject({
      method: "POST",
      url: `/api/v1/tenants/primary/seller/releases/coverage-pro/${version}`,
      headers: {
        ...f.operator,
        "content-type": contentType,
        ...(metadataValue === null
          ? {}
          : { "x-release-metadata": metadataValue }),
      },
      payload: body,
    });
  let result = await upload("1.0.0", bytes, "not json");
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().error.code, "invalid_metadata");
  assert.equal((await upload("1.0.0", bytes, null)).statusCode, 400);
  assert.equal(
    (await upload("1.0.0", bytes, Buffer.from("{}").toString("base64url")))
      .statusCode,
    400,
  );
  result = await upload("1.0.0", {}, metadataHeader, "application/json");
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().error.code, "invalid_zip");
  result = await upload("invalid-version");
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().error.code, "invalid_version");
  result = await upload("1.0.0", Buffer.from("invalid ZIP bytes"));
  assert.equal(result.statusCode, 400);
  assert.equal(result.json().error.code, "invalid_zip");
  assert.deepEqual(
    (await readdir(f.config.storage)).filter((name) =>
      name.startsWith(".upload-"),
    ),
    [],
  );
  result = await upload("1.0.0");
  assert.equal(result.statusCode, 200, result.body);
  const release = result.json();
  const downloadUrl = `/api/v1/tenants/primary/licenses/license-alice/releases/${release.id}/download`;
  const download = await f.app.inject({ url: downloadUrl, headers });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, bytes);
  assert.equal(download.headers["x-checksum-sha256"], release.checksum);
  const beforeHeads=JSON.stringify(await f.db("download_metrics"));
  const reads=t.mock.method(f.store,"get");
  for(const url of [downloadUrl,`/api/v1/tenants/primary/packages/${release.id}`])assert.equal((await f.app.inject({method:"HEAD",url,headers})).statusCode,405);
  assert.equal(reads.mock.callCount(),0);
  assert.equal(JSON.stringify(await f.db("download_metrics")),beforeHeads);
  reads.mock.restore();
  const duplicate = await upload("1.0.0");
  assert.equal(duplicate.statusCode, 409);
  assert.equal((await f.db("releases")).length, 1);
  assert.equal(
    (
      await f.post(
        "/seller/releases/00000000-0000-4000-8000-000000000000/withdraw",
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.post(`/seller/releases/${release.id}/withdraw`)).statusCode,
    200,
  );
  assert.equal(
    (await f.app.inject({ url: downloadUrl, headers })).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `/api/v1/tenants/primary/packages/${release.id}`,
        headers: activation,
      })
    ).statusCode,
    404,
  );
  assert.deepEqual(
    await f.store.get("primary", release.id, release.checksum, release.size),
    bytes,
  );
  assert.deepEqual(
    (await readdir(f.config.storage)).filter((name) =>
      name.startsWith(".upload-"),
    ),
    [],
  );
});

test("local operator purchases use configured plans, normalize addresses and persist paid fixture grants", async (t) => {
  const f = await fixture({ local: true });
  t.after(f.close);
  const { plan } = await seed(f);
  const missing = await f.post("/seller/local/purchase", {
    planId: "missing",
    email: "local@example.test",
  });
  assert.equal(missing.statusCode, 404);
  const explicit = await f.post("/seller/local/purchase", {
    planId: plan.id,
    email: "LOCAL@example.test",
    subscriptionId: "sub_local_coverage",
  });
  assert.equal(explicit.statusCode, 200, explicit.body);
  assert.equal(explicit.json().subscriptionId, "sub_local_coverage");
  const generated = await f.post("/seller/local/purchase", {
    planId: plan.id,
    email: "another@example.test",
  });
  assert.equal(generated.statusCode, 200);
  assert.match(generated.json().subscriptionId, /^sub_local_/);
  const purchased = await f
    .db("licenses")
    .where({ subscription_id: "sub_local_coverage" })
    .first();
  assert.equal(purchased.plan_id, plan.id);
  assert.equal(purchased.site_allowance, 1);
  assert.ok(purchased.paid_through > Date.now() + 360 * 86400000);
  const customer = await f
    .db("customers")
    .where({ id: purchased.customer_id })
    .first();
  assert.equal(customer.email, "local@example.test");
  assert.equal(
    (await f.db("grants").where({ license_id: purchased.id })).length,
    1,
  );
  assert.equal(
    (
      await f.post("/seller/local/purchase", {
        planId: plan.id,
        email: "local@example.test",
        subscriptionId: "sub_local_coverage",
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.db("grants").where({ license_id: purchased.id })).length,
    1,
  );
  const portal = await f.post("/portal", {}, await session(f));
  assert.equal(portal.statusCode, 503);
  assert.equal(portal.json().error.code, "local_billing");
  assert.equal((await f.post("/seller/reconcile")).statusCode, 503);
});

test("worker skips overlapping ticks, delivers once, removes expired auth rows and recovers after storage errors", async (t) => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  const f = await fixture({
    local: true,
    mailer: {
      send: async () => {
        sends++;
        entered();
        await gate;
      },
    },
  });
  t.after(f.close);
  const globalTick = () =>
    f.app.inject({
      method: "POST",
      url: "/api/v1/operator/jobs/run",
      headers: { authorization: `Bearer ${f.config.operatorToken}` },
      payload: {},
    });
  await seed(f);
  const requested = await f.post(
    "/auth/request",
    { email: "ALICE@example.test" },
    {},
  );
  assert.equal(requested.statusCode, 200);
  await f.db("sessions").insert({
    tenant_id: "primary",
    id: hash("expired-session"),
    customer_id: "alice",
    expires_at: 1,
  });
  await f.db("login_tokens").insert({
    tenant_id: "primary",
    id: hash("expired-login"),
    customer_id: "alice",
    expires_at: 1,
  });
  const tick = f.app.getDecorator<() => Promise<void>>("tick");
  const first = tick();
  await started;
  const overlapping = await globalTick();
  assert.equal(overlapping.statusCode, 200);
  assert.equal(sends, 1);
  release();
  await first;
  assert.equal(
    (await f.db("emails").where({ kind: "login" }).first()).state,
    "sent",
  );
  assert.equal((await f.db("sessions")).length, 0);
  assert.equal(
    await f
      .db("login_tokens")
      .where({ id: hash("expired-login") })
      .first(),
    undefined,
  );
  const queued = await f.post("/seller/reconcile", {
    subscriptionId: "sub_alice",
  });
  assert.equal(queued.statusCode, 200);
  assert.equal((await globalTick()).statusCode, 200);
  const failed = await f.db("work").first();
  assert.equal(failed.state, "pending");
  assert.equal(failed.last_error, "processing_failed");
  assert.ok(failed.available_at > Date.now());
  assert.equal((await globalTick()).statusCode, 200);
  assert.equal((await f.db("work").first()).attempts, 1);
  await f.db.schema.renameTable("sessions", "sessions_unavailable");
  const unavailable = await globalTick();
  assert.equal(unavailable.statusCode, 500);
  assert.equal(unavailable.json().error.code, "internal_error");
  assert.ok(!unavailable.body.includes("sessions_unavailable"));
  await f.db.schema.renameTable("sessions_unavailable", "sessions");
  assert.equal(
    (await globalTick()).statusCode,
    200,
    "The worker must release its in-flight guard after a database failure.",
  );
});

async function smtpSink() {
  const messages: string[] = [];
  const authenticated: string[] = [];
  const sockets = new Set<Socket>();
  const server = createSmtpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost SMTP fixture\r\n");
    let pending = "";
    let data = false;
    let message = "";
    socket.on("data", (chunk) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            messages.push(message);
            message = "";
            socket.write("250 accepted\r\n");
          } else {
            message += line + "\r\n";
          }
          continue;
        }
        if (line.startsWith("EHLO") || line.startsWith("HELO"))
          socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH PLAIN ")) {
          authenticated.push(Buffer.from(line.slice(11), "base64").toString());
          socket.write("235 authenticated\r\n");
        } else if (line === "DATA") {
          data = true;
          socket.write("354 end with dot\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    messages,
    authenticated,
    port: address.port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
test("default Nodemailer transport authenticates to a real SMTP sink and drains encrypted login mail", async (t) => {
  const smtp = await smtpSink();
  t.after(smtp.close);
  const f = await fixture({ smtpPort: smtp.port, smtpUser: "fixture-user" });
  t.after(f.close);
  await seed(f);
  const request = await f.post(
    "/auth/request",
    { email: "alice@example.test" },
    {},
  );
  assert.equal(request.statusCode, 200);
  assert.equal((await f.post("/seller/jobs/run")).statusCode, 200);
  assert.equal(smtp.messages.length, 1);
  assert.match(smtp.messages[0]!, /To: alice@example.test/);
  assert.match(smtp.messages[0]!, /Subject: Primary: Sign in/);
  assert.match(smtp.messages[0]!, /Content-Type: multipart\/alternative;/);
  assert.match(smtp.messages[0]!, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(smtp.messages[0]!, /Content-Type: text\/html; charset=utf-8/);
  assert.match(smtp.messages[0]!, /#login=/);
  assert.deepEqual(smtp.authenticated, ["\0fixture-user\0fixture-password"]);
  const email = await f.db("emails").first();
  assert.equal(email.state, "sent");
  assert.equal(email.payload, "");
});

test("production headers and secure cookies work; framework failures never leak internal details", async (t) => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  const f = await fixture({ production: true, static: true });
  process.env.NODE_ENV = previous;
  t.after(f.close);
  await seed(f);
  const ready = await f.app.inject({ url: "/api/v1/ready" });
  assert.equal(ready.statusCode, 200);
  assert.equal(ready.headers["cache-control"], "no-store");
  assert.match(
    String(ready.headers["content-security-policy"]),
    /upgrade-insecure-requests/,
  );
  const home = await f.app.inject({ url: "/" });
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /Coverage customer/);
  const unknown = await f.app.inject({ url: "/unknown" });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error.requestId, unknown.headers["x-request-id"]);
  const unsupported = await f.app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/activate",
    headers: { "content-type": "application/octet-stream" },
    payload: "private body",
  });
  assert.equal(unsupported.statusCode, 415);
  assert.equal(unsupported.json().error.code, "internal_error");
  assert.equal(
    unsupported.json().error.message,
    "The request could not be completed.",
  );
  assert.ok(!unsupported.body.includes("private body"));
  const invalid = await f.app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/auth/request",
    headers: { "content-type": "application/json" },
    payload: "{invalid",
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.code, "invalid_request");
  assert.equal(
    (await f.post("/auth/request", { email: "alice@example.test" }, {}))
      .statusCode,
    200,
  );
  const job = await f.db("emails").where({ kind: "login" }).first();
  const message = unseal<Message>(job.payload, f.config.secret);
  const token = message.text.match(/#login=([A-Za-z0-9_-]+)/)![1]!;
  const login = await f.post(
    "/auth/consume",
    { token },
    { origin: f.config.origin },
  );
  assert.equal(login.statusCode, 200);
  assert.ok(String(login.headers["set-cookie"]).includes(`${f.cookieName}=`));
  assert.match(String(login.headers["set-cookie"]), /Secure/);
  assert.match(String(login.headers["set-cookie"]), /HttpOnly/);
  const noLocalRoute = await f.post("/seller/local/purchase", {
    planId: "missing",
    email: "x@example.test",
  });
  assert.equal(noLocalRoute.statusCode, 404);
  await rm(f.config.storage, { recursive: true });
  const unavailable = await f.app.inject({ url: "/api/v1/ready" });
  assert.equal(unavailable.statusCode, 500);
  assert.ok(!unavailable.body.includes(f.root));
});

test("concurrent operator setup is idempotent and rejects cross-product price races without server errors", async (t) => {
  const f = await fixture({
    local: true,
    ...(process.env.TEST_API_DATABASE_URL
      ? { databaseUrl: process.env.TEST_API_DATABASE_URL }
      : {}),
  });
  t.after(f.close);
  const setup = {
    slug: "raced-product",
    name: "Raced product",
    plans: [{ name: "One", siteAllowance: 1, priceId: "price_raced" }],
  };
  const duplicates = await Promise.all(
    Array.from({ length: 12 }, () => f.post("/seller/products", setup)),
  );
  assert.deepEqual(
    duplicates.map((response) => response.statusCode),
    Array(12).fill(200),
    "Concurrent retries must reuse the same product and plan.",
  );
  assert.equal(
    new Set(duplicates.map((response) => response.json().product.id)).size,
    1,
  );
  assert.equal((await f.db("products")).length, 1);
  assert.equal((await f.db("plans")).length, 1);
  const contenders = await Promise.all(
    ["first-product", "second-product"].map((slug) =>
      f.post("/seller/products", {
        slug,
        name: slug,
        plans: [
          {
            name: "Shared price",
            siteAllowance: 1,
            priceId: "price_conflicted",
          },
        ],
      }),
    ),
  );
  assert.deepEqual(
    contenders.map((response) => response.statusCode).sort(),
    [200, 409],
  );
  assert.equal(
    (await f.db("plans").where({ stripe_price_id: "price_conflicted" })).length,
    1,
  );
  assert.equal(
    (
      await f
        .db("products")
        .whereIn("slug", ["first-product", "second-product"])
    ).length,
    1,
    "The losing setup must roll back its product.",
  );
});

test("public liveness and catalog expose current product plans without private Stripe or license fields", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const health = await f.app.inject({ url: "/api/v1/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { ok: true });
  const emptyCatalog = await f.app.inject({
    url: "/api/v1/tenants/primary/catalog",
  });
  assert.deepEqual(emptyCatalog.json(), {
    tenant: { slug: "primary", name: "Primary" },
    products: [],
    billingAvailable: true,
  });
  const { product, plan } = await seed(f);
  const catalog = await f.app.inject({
    url: "/api/v1/tenants/primary/catalog",
  });
  assert.equal(catalog.statusCode, 200);
  assert.equal(catalog.json().products[0].id, product.id);
  assert.deepEqual(catalog.json().products[0].plans, [
    { id: plan.id, name: "One site", site_allowance: 1 },
  ]);
  for (const secret of [
    "price_base",
    "key_hash",
    "DE-coverage-key",
    "cus_alice",
  ])
    assert.ok(!catalog.body.includes(secret));
  assert.equal(catalog.headers["cache-control"], "no-store");
  assert.match(String(catalog.headers["x-request-id"]), /^[a-f0-9-]{36}$/);
  assert.notEqual(
    catalog.headers["x-request-id"],
    health.headers["x-request-id"],
  );
});

test("readiness tolerates a transient probe cleanup failure and does not leave cleanup hooks patched", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const unlink = filesystem.unlink;
  const probes: string[] = [];
  const failure = t.mock.method(
    filesystem,
    "unlink",
    async (path: Parameters<typeof unlink>[0]) => {
      if (String(path).startsWith(f.config.storage + "/.ready-")) {
        probes.push(String(path));
        throw Object.assign(new Error("Temporary cleanup access denied"), {
          code: "EACCES",
        });
      }
      return unlink(path);
    },
  );
  syncBuiltinESMExports();
  try {
    const ready = await f.app.inject({ url: "/api/v1/ready" });
    assert.equal(ready.statusCode, 200);
    assert.deepEqual(ready.json(), { ok: true });
    assert.equal(
      probes.length,
      1,
      "Readiness must attempt to remove the write probe.",
    );
    assert.deepEqual((await readdir(f.config.storage)).filter(name=>name.startsWith(".ready-")), [
      probes[0]!.split("/").at(-1),
    ]);
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
  await filesystem.unlink(probes[0]!);
  const recovered = await f.app.inject({ url: "/api/v1/ready" });
  assert.equal(recovered.statusCode, 200);
  assert.deepEqual(
    (await readdir(f.config.storage)).filter(name=>name.startsWith(".ready-")),
    [],
    "The restored cleanup removes the next readiness probe.",
  );
});

test("production logout expires the host session cookie with its creation attributes", async (t) => {
  const f = await fixture({ production: true });
  t.after(f.close);
  await seed(f);
  const headers = await session(f);
  const logout = await f.post("/auth/logout", {}, headers);
  assert.equal(logout.statusCode, 200, logout.body);
  const cookie = String(logout.headers["set-cookie"]);
  assert.match(cookie, new RegExp(`^${f.cookieName}=;`));
  assert.match(cookie, /; Path=\//);
  assert.match(cookie, /; Secure(?:;|$)/);
  assert.match(cookie, /; HttpOnly(?:;|$)/);
  assert.match(cookie, /; SameSite=Lax(?:;|$)/);
  assert.match(cookie, /; Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.doesNotMatch(cookie, /; Domain=/);
  assert.equal((await f.db("sessions")).length, 0);
  const me = await f.app.inject({ url: "/api/v1/tenants/primary/me", headers });
  assert.equal(me.statusCode, 401);
});

test("public checkout treats missing, expired and malformed sessions as guests for new email addresses", async (t) => {
  const provider = await stripeFixture();
  t.after(provider.close);
  const f = await fixture({ provider });
  t.after(f.close);
  const { plan } = await seed(f);
  await f.db("sessions").insert({
    tenant_id: "primary",
    id: hash("expired-checkout"),
    customer_id: "alice",
    expires_at: 1,
  });
  const cookies = [
    undefined,
    `${f.cookieName}=expired-checkout`,
    `${f.cookieName}=missing-session`,
    `${f.cookieName}=%E0%A4%A`,
    `${f.cookieName}=`,
  ];
  for (const [index, cookie] of cookies.entries()) {
    const email = `guest-${index}@example.test`;
    const result = await f.post(
      "/checkout",
      { planId: plan.id, email },
      cookie === undefined ? {} : { cookie },
    );
    assert.equal(result.statusCode, 200, `${cookie}: ${result.body}`);
    assert.equal(result.json().url, "https://checkout.stripe.test/coverage");
    assert.ok(await f.db("customers").where({ email }).first());
  }
  assert.equal(
    provider.requests.filter(
      (request) => request.path === "/v1/checkout/sessions",
    ).length,
    cookies.length,
  );
  assert.equal((await f.db("sessions")).length, 1);
});

test("guest checkout with a stale session cannot purchase for an existing account", async (t) => {
  const provider = await stripeFixture();
  t.after(provider.close);
  const f = await fixture({ provider });
  t.after(f.close);
  const { plan } = await seed(f);
  await f.db("sessions").insert({
    tenant_id: "primary",
    id: hash("expired-checkout"),
    customer_id: "alice",
    expires_at: 1,
  });
  for (const cookie of [
    undefined,
    `${f.cookieName}=expired-checkout`,
    `${f.cookieName}=missing-session`,
    `${f.cookieName}=%E0%A4%A`,
  ]) {
    const result = await f.post(
      "/checkout",
      { planId: plan.id, email: "alice@example.test" },
      cookie === undefined ? {} : { cookie },
    );
    assert.equal(result.statusCode, 401, result.body);
    assert.equal(result.json().error.code, "login_required");
  }
  assert.equal(
    provider.requests.filter(
      (request) => request.path === "/v1/checkout/sessions",
    ).length,
    0,
  );
  assert.equal(
    provider.requests.filter((request) => request.path === "/v1/customers")
      .length,
    0,
  );
});

test("public checkout propagates session database failures instead of purchasing as a guest", async (t) => {
  const provider = await stripeFixture();
  t.after(provider.close);
  const f = await fixture({ provider });
  t.after(f.close);
  const { plan } = await seed(f);
  provider.requests.length = 0;
  const headers = await session(f);
  const request = () =>
    f.post(
      "/checkout",
      { planId: plan.id, email: "uncreated@example.test" },
      headers,
    );
  await f.db.schema.renameTable("sessions", "sessions_unavailable");
  const unavailable = await request();
  assert.equal(unavailable.statusCode, 500, unavailable.body);
  assert.equal(unavailable.json().error.code, "internal_error");
  assert.ok(!unavailable.body.includes("sessions_unavailable"));
  await f.db.schema.renameTable("sessions_unavailable", "sessions");
  for (const error of [
    new AppError(
      401,
      "session_database_unavailable",
      "Session storage unavailable.",
    ),
    new AppError(503, "login_required", "Session storage unavailable."),
  ]) {
    const failSessionQuery = (query: { sql: string }) => {
      if (query.sql.includes("sessions")) throw error;
    };
    f.db.on("query", failSessionQuery);
    try {
      const failed = await request();
      assert.equal(failed.statusCode, error.status, failed.body);
      assert.equal(failed.json().error.code, error.code);
    } finally {
      f.db.removeListener("query", failSessionQuery);
    }
  }
  assert.equal(
    await f.db("customers").where({ email: "uncreated@example.test" }).first(),
    undefined,
  );
  assert.equal(provider.requests.length, 0);
});

async function seedTenantKey(database: import("../src/db.ts").DB) {
  await database("tenant_api_keys").insert({
    id: "regression-key",
    tenant_id: "primary",
    name: "Regression key",
    key_hash: hash(testTenantKey),
    created_at: Date.now(),
    revoked_at: null,
    scopes: JSON.stringify([
      "read",
      "catalog:write",
      "releases:write",
      "licenses:write",
      "billing:reconcile",
    ]),
    expires_at: Date.now() + 86400000,
    last_used_at: null,
    display_prefix: testTenantKey.slice(0, 14),
  });
}
