import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import {
  appPath,
  appUrl,
  normalizeAppBasePath,
} from "../packages/shared/app-path.ts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import Stripe from "stripe";
import { createDb, createTenant, migrate, type Plan } from "../src/db.ts";
import { Auth } from "../src/auth.ts";
import { PlatformAuth } from "../src/platform-auth.ts";
import { AccountManagement } from "../src/account-management.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { StripeBilling } from "../src/stripe.ts";
import { csrf, hash, unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";

const credentials = {
  APP_SECRET: "03".repeat(32),
  OPERATOR_TOKEN: "fixture-operator-".repeat(3),
};

const invalidBasePaths = [
  "app",
  "//",
  "//app",
  "/app//",
  "/app//nested",
  "/app/./nested",
  "/app/../nested",
  "/.",
  "/..",
  "/app%2Fnested",
  "/%2e%2e",
  "/app%20name",
  "/app\\nested",
  "/app?query=1",
  "/app#fragment",
  "https://app.example.test",
  "/https://app.example.test",
  " /app",
  "/app ",
  "/appliqué",
  "/app.name",
  "/app:name",
  "/app\n",
  "/app\r",
  "/app\t",
  "/app\u0000",
  "/app\u007f",
  "/app\u0085",
  `/${"a".repeat(128)}`,
];

test("application base paths normalize root, app and nested deployments", () => {
  for (const [input, expected] of [
    [undefined, ""],
    ["", ""],
    ["/", ""],
    ["/app", "/app"],
    ["/app/", "/app"],
    ["/my-app/v2_tools/", "/my-app/v2_tools"],
    ["/APP_2/-/_/", "/APP_2/-/_"],
    [`/${"a".repeat(127)}`, `/${"a".repeat(127)}`],
  ])
    assert.equal(normalizeAppBasePath(input), expected);
});

test("application base paths reject malformed or ambiguous values", () => {
  for (const value of invalidBasePaths)
    assert.throws(() => normalizeAppBasePath(value), /APP_BASE_PATH/);
});

test("application paths retain internal queries, fragments and encoded tokens", () => {
  for (const base of [undefined, "", "/", "/app", "/app/", "/tools/app"])
    for (const path of [
      "/",
      "/seller",
      "/t/alpha?checkout=return",
      "/seller#seller-login=fixture_token-1",
      "/seller?next=%2Ft%2Falpha#account-email-change=id&token=a%2Fb%3D",
      "/seller?next=https%3A%2F%2Fother.example.test",
    ]) {
      const prefix = base === "/" ? "" : (base ?? "").replace(/\/$/, "");
      assert.equal(appPath(path, base), `${prefix}${path}`);
    }
});

test("application paths reject external, relative, backslash and control inputs", () => {
  for (const path of [
    "",
    "seller",
    "https://other.example.test/seller",
    "//other.example.test/seller",
    "///seller",
    "/\\other.example.test",
    "/seller?token=\\value",
    "/seller\n",
    "/seller#token=\r",
    "/seller?token=\u0000",
    "/seller\u007f",
    "/seller\u0085",
  ])
    assert.throws(() => appPath(path, "/app"), /path/i);
  for (const base of invalidBasePaths)
    assert.throws(() => appPath("/seller", base), /APP_BASE_PATH/);
});

test("application URLs use the configured origin without resolving internal tokens", () => {
  assert.equal(
    appUrl(
      { origin: "https://app.example.test", appBasePath: "/app" },
      "/seller#seller-login=token",
    ),
    "https://app.example.test/app/seller#seller-login=token",
  );
  assert.equal(
    appUrl(
      {
        origin: "https://separate-app.example.test",
        appBasePath: "/tools/app/",
      },
      "/t/alpha?checkout=return",
    ),
    "https://separate-app.example.test/tools/app/t/alpha?checkout=return",
  );
  assert.equal(
    appUrl({ origin: "http://localhost:3211" }, "/seller"),
    "http://localhost:3211/seller",
  );
});

test("configuration selects app defaults by deployment mode and normalizes explicit base paths", () => {
  assert.equal(loadConfig(credentials).appBasePath, "");
  assert.equal(
    loadConfig({ ...credentials, DEPLOYMENT_MODE: "hosted" }).appBasePath,
    "/app",
  );
  for (const APP_BASE_PATH of ["", "/"])
    assert.equal(
      loadConfig({ ...credentials, DEPLOYMENT_MODE: "hosted", APP_BASE_PATH })
        .appBasePath,
      "",
    );
  for (const [value, expected] of [
    ["", ""],
    ["/", ""],
    ["/app/", "/app"],
    ["/nested/app", "/nested/app"],
  ]) {
    const config = loadConfig({
      ...credentials,
      PUBLIC_ORIGIN: "https://app.example.test/",
      APP_BASE_PATH: value,
    });
    assert.equal(config.origin, "https://app.example.test");
    assert.equal(config.appBasePath, expected);
  }
});

test("invalid APP_BASE_PATH values fail during startup configuration", () => {
  for (const APP_BASE_PATH of invalidBasePaths)
    assert.throws(
      () => loadConfig({ ...credentials, APP_BASE_PATH }),
      /APP_BASE_PATH/,
    );
  assert.throws(
    () =>
      loadConfig({
        ...credentials,
        PUBLIC_ORIGIN: "https://app.example.test/app",
        APP_BASE_PATH: "/app",
      }),
    /PUBLIC_ORIGIN/,
  );
});

async function backendFixture(t: test.TestContext, basePath?: string) {
  const directory = await mkdtemp(
    `${process.env.TMPDIR ?? "/Volumes/Scratch/entitle/tmp"}/app-path-`,
  );
  const db = createDb(`sqlite:${directory}/db`);
  t.after(async () => {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  });
  await migrate(db);
  const config = loadConfig({
    ...credentials,
    DEPLOYMENT_MODE: "hosted",
    PUBLIC_ORIGIN: "https://app.example.test",
    APP_BASE_PATH: basePath,
    STRIPE_CONNECT_CLIENT_ID: "ca_fixture",
    PLATFORM_STRIPE_PRICE_ID: "price_platform",
    STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
  });
  // Older integrations construct Config objects without the optional property.
  if (basePath === undefined) delete config.appBasePath;
  const tenant = await createTenant(db, {
    id: "alpha",
    slug: "alpha",
    name: "Alpha",
    stripe_account_id: "acct_alpha",
  });
  const user = {
    id: "owner",
    email: "owner@example.test",
    verified_at: 1,
    created_at: 1,
  };
  await db("seller_users").insert(user);
  const sessionToken = "fixture-seller-session";
  const sessionHash = hash(sessionToken);
  await db("seller_sessions").insert({
    id: sessionHash,
    user_id: user.id,
    expires_at: Date.now() + 86400000,
  });
  await db("seller_memberships").insert({
    tenant_id: tenant.id,
    user_id: user.id,
    role: "owner",
    created_at: Date.now(),
  });
  await db("customers").insert({
    tenant_id: tenant.id,
    id: "buyer",
    email: "buyer@example.test",
    stripe_id: "cus_buyer",
  });
  const seller = {
    user,
    sessionHash,
    csrfToken: csrf(sessionToken, config.secret),
  };
  const platformMessage = async (kind: string) => {
    const row = await db("platform_emails").where({ kind }).first();
    assert.ok(row);
    return unseal<Message>(row.payload, config.secret);
  };
  return { db, config, tenant, seller, platformMessage };
}

function messageUrl(message: Message) {
  const link = /https?:\/\/\S+/.exec(message.text)?.[0];
  assert.ok(link, "The queued email must include an application URL");
  return new URL(link);
}

for (const basePath of [undefined, "/app", "/tools/app"])
  test(`auth and account email flows use ${basePath ?? "the legacy root"}`, async (t) => {
    const f = await backendFixture(t, basePath);
    const prefix = basePath ?? "";
    const cookies: Record<string, string> = {};
    const cookieOptions: Record<string, unknown>[] = [];
    const reply = {
      setCookie(name: string, value: string, options: Record<string, unknown>) {
        cookies[name] = value;
        cookieOptions.push(options);
      },
    } as unknown as FastifyReply;
    const request = (headers: Record<string, string> = {}) =>
      ({
        headers: { origin: f.config.origin, ...headers },
        cookies: { ...cookies },
      }) as unknown as FastifyRequest;
    const buyerAuth = new Auth(f.db, f.config, f.tenant);
    await buyerAuth.request("buyer@example.test");
    const row = await f
      .db("emails")
      .where({ tenant_id: f.tenant.id, kind: "login" })
      .first();
    const buyerMessage = unseal<Message>(row.payload, f.config.secret);
    const buyerLink = messageUrl(buyerMessage);
    assert.equal(buyerLink.origin, f.config.origin);
    assert.equal(buyerLink.pathname, `${prefix}/t/alpha`);
    assert.match(buyerLink.hash, /^#login=[A-Za-z0-9_-]+$/);
    assert.ok(buyerMessage.text.startsWith(`Open ${buyerLink.href}\n\n`));
    const buyerToken = buyerLink.hash.slice("#login=".length);
    await assert.rejects(
      buyerAuth.consume(
        buyerToken,
        request({ origin: `${f.config.origin}/app` }),
        reply,
      ),
      { code: "origin_denied" },
    );
    await buyerAuth.consume(buyerToken, request(), reply);
    const buyerCsrf = csrf(cookies[buyerAuth.cookieName]!, f.config.secret);
    assert.equal(
      (await buyerAuth.customer(request({ "x-csrf-token": buyerCsrf }), true))
        .customer.id,
      "buyer",
    );
    await assert.rejects(buyerAuth.customer(request(), true), {
      code: "csrf_denied",
    });

    const sellerAuth = new PlatformAuth(f.db, f.config);
    await sellerAuth.request(f.seller.user.email, request(), reply);
    const sellerMessage = await f.platformMessage("seller_login");
    const sellerLink = messageUrl(sellerMessage);
    assert.equal(sellerLink.origin, f.config.origin);
    assert.equal(sellerLink.pathname, `${prefix}/seller`);
    assert.match(sellerLink.hash, /^#seller-login=[A-Za-z0-9_-]+$/);
    assert.ok(sellerMessage.text.startsWith(`Open ${sellerLink.href}\n\n`));
    const sellerToken = sellerLink.hash.slice("#seller-login=".length);
    await assert.rejects(
      sellerAuth.consume(
        sellerToken,
        request({ origin: `${f.config.origin}/app` }),
        reply,
      ),
      { code: "origin_denied" },
    );
    await sellerAuth.consume(sellerToken, request(), reply);
    const sellerCsrf = csrf(cookies[sellerAuth.cookieName]!, f.config.secret);
    const sellerRequest = () => request({ "x-csrf-token": sellerCsrf });
    assert.equal(
      (await sellerAuth.seller(sellerRequest())).user.id,
      f.seller.user.id,
    );
    await assert.rejects(sellerAuth.seller(request()), { code: "csrf_denied" });
    assert.ok(cookieOptions.length >= 3);
    for (const options of cookieOptions) {
      assert.equal(options.path, "/");
      assert.equal(options.httpOnly, true);
      assert.equal(options.sameSite, "lax");
      assert.equal(options.domain, undefined);
    }

    const accounts = new AccountManagement(f.db, sellerAuth);
    await accounts.requestVerification(sellerRequest(), "billing");
    const verificationLink = messageUrl(
      await f.platformMessage("account_verification"),
    );
    assert.equal(verificationLink.origin, f.config.origin);
    assert.equal(verificationLink.pathname, `${prefix}/seller`);
    assert.match(
      verificationLink.hash,
      /^#account-verification=[A-Za-z0-9_-]+$/,
    );
    const proof = await accounts.consumeVerification(
      sellerRequest(),
      "billing",
      verificationLink.hash.slice("#account-verification=".length),
    );
    assert.equal(typeof proof.verification, "string");

    const change = await accounts.requestEmailChange(
      sellerRequest(),
      "new@example.test",
    );
    const currentLink = messageUrl(
      await f.platformMessage("account_email_current"),
    );
    const newLink = messageUrl(await f.platformMessage("account_email_new"));
    for (const link of [currentLink, newLink]) {
      assert.equal(link.origin, f.config.origin);
      assert.equal(link.pathname, `${prefix}/seller`);
      assert.equal(
        new URLSearchParams(link.hash.slice(1)).get("account-email-change"),
        change.id,
      );
    }
    const currentToken = new URLSearchParams(currentLink.hash.slice(1)).get(
      "token",
    )!;
    const newToken = new URLSearchParams(newLink.hash.slice(1)).get("token")!;
    assert.notEqual(currentToken, newToken);
    await accounts.confirmEmailChange(
      sellerRequest(),
      change.id,
      currentToken,
      newToken,
    );
    assert.equal(
      (await f.db("seller_users").where({ id: f.seller.user.id }).first())
        .email,
      "new@example.test",
    );
  });

interface StripeRequest {
  path: string;
  body: URLSearchParams;
  key: string | undefined;
  account: string | undefined;
}

async function stripeFixture(t: test.TestContext) {
  const requests: StripeRequest[] = [];
  const configurations = new Map<string, Record<string, unknown>>();
  const configurationKeys = new Map<string, string>();
  let checkoutCount = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const path = new URL(req.url!, "http://localhost").pathname;
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    const key = req.headers["idempotency-key"] as string | undefined;
    requests.push({
      path,
      body,
      key,
      account: req.headers["stripe-account"] as string | undefined,
    });
    let result: unknown;
    if (req.method === "GET" && path.startsWith("/v1/prices/"))
      result = {
        id: path.split("/").at(-1),
        active: true,
        type: "recurring",
        unit_amount: 1000,
        currency: "usd",
        livemode: false,
        recurring: { interval: "year", interval_count: 1 },
      };
    else if (req.method === "GET" && path === "/v1/subscriptions")
      result = { object: "list", url: path, has_more: false, data: [] };
    else if (req.method === "POST" && path === "/v1/customers")
      result = { id: "cus_platform" };
    else if (req.method === "POST" && path === "/v1/checkout/sessions") {
      const id = `cs_fixture_${++checkoutCount}`;
      result = {
        id,
        url: `https://checkout.stripe.test/${id}`,
        client_secret: `${id}_secret_fixture`,
        status: "open",
        mode: "subscription",
        customer: body.get("customer"),
        client_reference_id: body.get("client_reference_id"),
        livemode: false,
      };
    } else if (
      req.method === "GET" &&
      path === "/v1/billing_portal/configurations"
    )
      result = {
        object: "list",
        url: path,
        has_more: false,
        data: [...configurations.values()],
      };
    else if (
      req.method === "POST" &&
      path === "/v1/billing_portal/configurations"
    ) {
      const priorId = key && configurationKeys.get(key);
      if (priorId) result = configurations.get(priorId);
      else {
        const id = `bpc_fixture_${configurations.size + 1}`;
        result = {
          id,
          active: true,
          is_default: false,
          livemode: false,
          default_return_url: body.get("default_return_url"),
          metadata: {
            double_entitle_policy: body.get("metadata[double_entitle_policy]"),
          },
          login_page: { enabled: body.get("login_page[enabled]") === "true" },
          features: {
            subscription_update: {
              enabled:
                body.get("features[subscription_update][enabled]") === "true",
            },
            subscription_cancel: {
              enabled:
                body.get("features[subscription_cancel][enabled]") === "true",
              mode: body.get("features[subscription_cancel][mode]"),
              proration_behavior: body.get(
                "features[subscription_cancel][proration_behavior]",
              ),
            },
          },
        };
        configurations.set(id, result as Record<string, unknown>);
        if (key) configurationKeys.set(key, id);
      }
    } else if (
      req.method === "GET" &&
      path.startsWith("/v1/billing_portal/configurations/")
    )
      result = configurations.get(path.split("/").at(-1)!);
    else if (req.method === "POST" && path === "/v1/billing_portal/sessions")
      result = {
        id: "bps_fixture",
        url: "https://billing.stripe.test/fixture",
      };
    res.setHeader("content-type", "application/json");
    if (result === undefined) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: {
            type: "invalid_request_error",
            message: "Unexpected fixture route",
          },
        }),
      );
    } else res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const stripe = new Stripe("sk_test_fixture", {
    host: "127.0.0.1",
    port: (server.address() as { port: number }).port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  return { stripe, requests, configurations };
}

for (const basePath of [undefined, "/app", "/tools/app"])
  test(`Stripe checkout and portal URLs use ${basePath ?? "the legacy root"}`, async (t) => {
    const f = await backendFixture(t, basePath);
    const provider = await stripeFixture(t);
    const prefix = `${f.config.origin}${basePath ?? ""}`;
    const platform = new PlatformBilling(f.db, f.config, provider.stripe);
    const connect = new URL((await platform.connect(f.tenant, f.seller)).url);
    assert.equal(
      connect.searchParams.get("redirect_uri"),
      `${f.config.origin}/api/v1/platform/stripe/callback`,
    );
    assert.equal(
      (await f.db("oauth_states").first()).redirect_uri,
      `${f.config.origin}/api/v1/platform/stripe/callback`,
    );
    await platform.checkout(f.tenant, f.seller);
    const platformCheckout = provider.requests.find(
      (r) => r.path === "/v1/checkout/sessions",
    )!;
    assert.equal(
      platformCheckout.body.get("success_url"),
      `${prefix}/seller?billing=success`,
    );
    assert.equal(
      platformCheckout.body.get("cancel_url"),
      `${prefix}/seller?billing=canceled`,
    );
    assert.equal(platformCheckout.account, undefined);
    await platform.portal(f.tenant);
    const configuration = provider.requests.find((r) =>
      r.body.has("default_return_url"),
    )!;
    assert.equal(
      configuration.body.get("default_return_url"),
      `${prefix}/seller`,
    );
    assert.equal(
      configuration.key,
      `double-entitle-safe-portal-v1-${hash(prefix)}`,
    );
    const platformPortal = provider.requests.find(
      (r) => r.path === "/v1/billing_portal/sessions",
    )!;
    assert.equal(platformPortal.body.get("return_url"), `${prefix}/seller`);
    assert.equal(platformPortal.body.get("configuration"), "bpc_fixture_1");

    const buyer = new StripeBilling(f.db, f.config, f.tenant);
    buyer.stripe = provider.stripe;
    const plan: Plan = {
      tenant_id: f.tenant.id,
      id: "plan_alpha",
      product_id: "product_alpha",
      name: "Annual",
      site_allowance: 1,
      stripe_price_id: "price_annual",
    };
    await buyer.checkout(plan, "buyer@example.test", "buyer");
    const hosted = provider.requests.at(-1)!;
    assert.equal(hosted.path, "/v1/checkout/sessions");
    assert.equal(hosted.account, "acct_alpha");
    assert.equal(
      hosted.body.get("success_url"),
      `${prefix}/t/alpha?checkout=success`,
    );
    assert.equal(
      hosted.body.get("cancel_url"),
      `${prefix}/t/alpha?checkout=canceled`,
    );
    const elements = await buyer.checkout(
      plan,
      "buyer@example.test",
      "buyer",
      "elements",
    );
    assert.ok("returnUrl" in elements);
    assert.equal(elements.returnUrl, `${prefix}/t/alpha?checkout=return`);
    const embedded = provider.requests.at(-1)!;
    assert.equal(embedded.body.get("return_url"), elements.returnUrl);
    assert.equal(embedded.body.has("success_url"), false);
    assert.equal(embedded.body.has("cancel_url"), false);
    await buyer.portal("cus_buyer");
    const buyerPortal = provider.requests.at(-1)!;
    assert.equal(buyerPortal.body.get("return_url"), `${prefix}/t/alpha`);
    assert.equal(buyerPortal.account, "acct_alpha");
    assert.equal((await f.db("licenses")).length, 0);
  });

test("portal configuration cache and idempotency follow base-path and origin changes", async (t) => {
  const f = await backendFixture(t);
  const provider = await stripeFixture(t);
  await f
    .db("tenants")
    .where({ id: f.tenant.id })
    .update({ platform_customer_id: "cus_platform" });
  const platform = new PlatformBilling(f.db, f.config, provider.stripe);
  await platform.portal(f.tenant);
  await platform.portal(f.tenant);
  const creates = () =>
    provider.requests.filter((r) => r.body.has("default_return_url"));
  assert.equal(creates().length, 1);
  assert.equal(
    creates()[0]!.key,
    `double-entitle-safe-portal-v1-${hash(f.config.origin)}`,
  );

  // Legacy configurations with no explicit mode still match test-mode policies.
  delete f.config.stripeLiveMode;
  // A restarted process must skip the old root configuration and use a new key.
  const restarted = new PlatformBilling(
    f.db,
    { ...f.config, appBasePath: "/app" },
    provider.stripe,
  );
  await restarted.portal(f.tenant);
  assert.equal(creates().length, 2);
  assert.equal(
    creates()[1]!.key,
    `double-entitle-safe-portal-v1-${hash(`${f.config.origin}/app`)}`,
  );
  assert.notEqual(creates()[0]!.key, creates()[1]!.key);
  assert.equal(
    creates()[1]!.body.get("default_return_url"),
    `${f.config.origin}/app/seller`,
  );

  // A retained service must discard its old cache and find the app configuration.
  f.config.appBasePath = "/app";
  await platform.portal(f.tenant);
  assert.equal(creates().length, 2);
  assert.equal(
    provider.requests.at(-1)!.body.get("configuration"),
    "bpc_fixture_2",
  );
  f.config.appBasePath = "/app/";
  await platform.portal(f.tenant);
  assert.equal(creates().length, 2);
  f.config.appBasePath = "/tools/app";
  await platform.portal(f.tenant);
  assert.equal(creates().length, 3);
  assert.equal(
    creates()[2]!.body.get("default_return_url"),
    `${f.config.origin}/tools/app/seller`,
  );
  f.config.origin = "https://separate-app.example.test";
  await platform.portal(f.tenant);
  assert.equal(creates().length, 4);
  assert.equal(
    creates()[3]!.key,
    `double-entitle-safe-portal-v1-${hash(`${f.config.origin}/tools/app`)}`,
  );
  assert.equal(
    provider.requests.at(-1)!.body.get("return_url"),
    `${f.config.origin}/tools/app/seller`,
  );
});
