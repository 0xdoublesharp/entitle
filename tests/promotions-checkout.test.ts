import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type Stripe from "stripe";
import { buildApp } from "../src/app.ts";
import { csrf, hash } from "../src/crypto.ts";
import { createDb, migrate, type Plan, type Tenant } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { StripeBilling } from "../src/stripe.ts";

const plan: Plan = {
  tenant_id: "primary",
  id: "plan",
  product_id: "product",
  name: "Annual",
  site_allowance: 1,
  stripe_price_id: "price_annual",
};

test("checkout reads current promotion settings and attaches only one discount mechanism", async (t) => {
  const db = createDb("sqlite::memory:");
  t.after(() => db.destroy());
  await migrate(db);
  const tenant = (await db<Tenant>("tenants")
    .where({ id: "primary" })
    .first())!;
  const source = new StripeBilling(
    db,
    loadConfig({
      DEPLOYMENT_MODE: "standalone",
      APP_SECRET: "22".repeat(32),
      OPERATOR_TOKEN: "x".repeat(32),
    }),
    tenant,
  );
  const customer = {
    tenant_id: tenant.id,
    id: "buyer",
    email: "buyer@example.test",
    stripe_id: "cus_buyer",
  };
  await db("customers").insert(customer);
  const sessions: Stripe.Checkout.SessionCreateParams[] = [];
  const price = {
    active: true,
    type: "recurring",
    unit_amount: 1000,
    recurring: { interval: "year", interval_count: 1 },
  };
  let coupon: object | null = {
    valid: true,
    percent_off: 30,
    amount_off: null,
  };
  let promotionReads = 0;
  source.stripe = {
    prices: { retrieve: async () => price },
    promotionCodes: {
      list: async (input: Stripe.PromotionCodeListParams) => {
        promotionReads++;
        assert.equal(input.active, true);
        assert.equal(input.limit, 1);
        assert.deepEqual(input.expand, ["data.promotion.coupon"]);
        return {
          data: [
            {
              id: "promo_sale",
              code: "SALE30",
              active: true,
              promotion: { coupon },
            },
          ],
        };
      },
    },
    checkout: {
      sessions: {
        create: async (input: Stripe.Checkout.SessionCreateParams) => {
          sessions.push(input);
          return { url: "https://checkout.stripe.com/local" };
        },
      },
    },
  } as unknown as Stripe;
  const checkout = (promotionCode?: string) =>
    source.checkout(
      plan,
      customer.email,
      customer.id,
      "hosted",
      {},
      { promotionCode },
    );
  await checkout();
  assert.equal(sessions.at(-1)?.allow_promotion_codes, false);
  await assert.rejects(checkout("SALE30"), {
    status: 409,
    code: "promotions_disabled",
  });
  assert.equal(promotionReads, 0);
  await db("tenants")
    .where({ id: tenant.id })
    .update({ allow_promotion_codes: 1 });
  await checkout();
  assert.equal(sessions.at(-1)?.allow_promotion_codes, true);
  await checkout("sale30");
  assert.deepEqual(sessions.at(-1)?.discounts, [
    { promotion_code: "promo_sale" },
  ]);
  assert.equal(Object.hasOwn(sessions.at(-1)!, "allow_promotion_codes"), false);
  await assert.rejects(checkout("OTHER"), {
    status: 400,
    code: "invalid_promotion_code",
  });
  coupon = { valid: false, percent_off: 30 };
  await assert.rejects(checkout("SALE30"), {
    status: 400,
    code: "invalid_promotion_code",
  });
  coupon = { valid: true, percent_off: 100 };
  await assert.rejects(checkout("SALE30"), {
    status: 409,
    code: "zero_amount_promotion",
  });
  coupon = { valid: true, amount_off: 1000 };
  await assert.rejects(checkout("SALE30"), {
    status: 409,
    code: "zero_amount_promotion",
  });
  assert.equal(sessions.length, 3);
});

test("seller settings, lifetime prices, and promotion summaries reach the buyer catalog", async (t) => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/commerce-growth-");
  const db = createDb("sqlite::memory:");
  t.after(async () => {
    await db.destroy();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(db);
  const config = loadConfig({
    DEPLOYMENT_MODE: "standalone",
    APP_SECRET: "22".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
    STANDALONE_OWNER_EMAIL: "owner@example.test",
    DATA_DIR: root,
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  });
  const key = `DE-TK-${"P".repeat(43)}`;
  const now = Date.now();
  await db("tenant_api_keys").insert({
    id: "test-key",
    tenant_id: "primary",
    name: "Read and catalog",
    key_hash: hash(key),
    scopes: JSON.stringify(["read", "catalog:write"]),
    display_prefix: "test",
    created_at: now,
    expires_at: now + 60000,
  });
  await db("seller_users").insert({
    id: "owner",
    email: "owner@example.test",
    verified_at: now,
    created_at: now,
  });
  await db("seller_memberships").insert({
    tenant_id: "primary",
    user_id: "owner",
    role: "owner",
    created_at: now,
  });
  await db("seller_sessions").insert({
    id: hash("session"),
    user_id: "owner",
    expires_at: now + 60000,
  });
  const price = {
    id: "price_life",
    active: true,
    type: "one_time",
    unit_amount: 29900,
    currency: "usd",
    nickname: "Lifetime",
    product: { id: "prod_life", name: "Plugin" },
  };
  const app = await buildApp(
    config,
    db,
    { send: async () => {} },
    {
      store: new InMemoryArtifactStore(),
      stripeFactory: (tenant) => {
        const source = new StripeBilling(db, config, tenant);
        source.stripe = {
          prices: {
            list: async function* (params: Stripe.PriceListParams) {
              assert.equal(params.type, undefined);
              yield price;
              yield { ...price, id: "price_free", unit_amount: 0 };
            },
            retrieve: async () => price,
          },
          promotionCodes: {
            list: async (params: Stripe.PromotionCodeListParams) => {
              assert.deepEqual(params, {
                active: true,
                limit: 50,
                expand: ["data.promotion.coupon"],
              });
              return {
                data: [
                  {
                    id: "promo_sale",
                    active: true,
                    code: "SALE",
                    times_redeemed: 1,
                    max_redemptions: 30,
                    expires_at: 2000000000,
                    promotion: {
                      coupon: {
                        percent_off: 25,
                        duration: "repeating",
                        duration_in_months: 3,
                        metadata: { internal: "hidden" },
                      },
                    },
                  },
                ],
              };
            },
          },
        } as unknown as Stripe;
        return source;
      },
    },
  );
  t.after(() => app.close());
  await app.ready();
  const api = "/api/v1/tenants/primary";
  const seller = `${api}/seller`;
  const headers = { authorization: `Bearer ${key}` };
  const settingsHeaders = {
    cookie: "de-seller-session=session",
    origin: config.origin,
    "x-csrf-token": csrf("session", config.secret),
  };
  const settings = `${seller}/commerce/settings`;
  const tax = {
    automaticTax: false,
    collectTaxId: false,
    collectBillingAddress: false,
  };
  let response = await app.inject({ url: `${api}/catalog` });
  assert.equal(response.json().allowPromotionCodes, false);
  response = await app.inject({
    method: "PUT",
    url: settings,
    headers: settingsHeaders,
    payload: { ...tax, allowPromotionCodes: true },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().settings.allowPromotionCodes, true);
  response = await app.inject({
    method: "PUT",
    url: settings,
    headers: settingsHeaders,
    payload: tax,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().settings.allowPromotionCodes, true);
  assert.equal(
    (await app.inject({ url: `${api}/catalog` })).json().allowPromotionCodes,
    true,
  );
  assert.equal(
    (await app.inject({ url: `${seller}/promotions` })).statusCode,
    401,
  );
  response = await app.inject({ url: `${seller}/promotions`, headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    localMode: false,
    promotions: [
      {
        id: "promo_sale",
        active: true,
        code: "SALE",
        percentOff: 25,
        amountOff: null,
        currency: null,
        duration: "repeating",
        durationInMonths: 3,
        timesRedeemed: 1,
        maxRedemptions: 30,
        expiresAt: 2000000000,
      },
    ],
  });
  response = await app.inject({ url: `${seller}/prices`, headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response
      .json()
      .prices.map((p: { id: string; interval: string }) => [p.id, p.interval]),
    [["price_life", "lifetime"]],
  );
  response = await app.inject({
    method: "POST",
    url: `${seller}/products`,
    headers,
    payload: {
      name: "Plugin",
      slug: "plugin",
      plans: [{ name: "Lifetime", siteAllowance: 5, priceId: price.id }],
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const catalog = (await app.inject({ url: `${api}/catalog` })).json();
  assert.equal(catalog.products[0].plans[0].billing_interval, "lifetime");
  assert.equal(catalog.products[0].plans[0].unit_amount, 29900);
  config.localBilling = true;
  response = await app.inject({ url: `${seller}/prices`, headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(
    response
      .json()
      .prices.filter((p: { interval: string }) => p.interval === "lifetime")
      .map((p: { id: string; unit_amount: number }) => [p.id, p.unit_amount]),
    [1, 5, 25].map((sites) => [`price_local_lifetime_${sites}`, 29900]),
  );
  response = await app.inject({ url: `${seller}/promotions`, headers });
  assert.deepEqual(response.json(), {
    localMode: true,
    promotions: [
      {
        id: "promo_local_bf30",
        active: true,
        code: "BF30",
        percentOff: 30,
        amountOff: null,
        currency: null,
        duration: "once",
        durationInMonths: null,
        timesRedeemed: 0,
        maxRedemptions: null,
        expiresAt: null,
      },
    ],
  });
});
