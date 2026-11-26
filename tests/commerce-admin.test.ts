import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { createServer } from "node:http";
import Stripe from "stripe";
import { StripeBilling } from "../src/stripe.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate, createTenant } from "../src/db.ts";
import { up } from "../src/migrations/008_commerce.ts";
import { loadConfig } from "../src/config.ts";
import { PlatformAuth } from "../src/platform-auth.ts";
import { hash, csrf } from "../src/crypto.ts";
import { AppError } from "../src/errors.ts";
import { isolatedDatabase } from "./helpers/database.ts";

for (const deploymentMode of ["standalone", "hosted"] as const)
  test(`${deploymentMode} commerce admin requires interactive tenant auth and CSRF, validates settings and isolates products`, async () => {
    const root = await mkdtemp(
      "/Volumes/Scratch/entitle/tmp/commerce-admin-",
    );
    const fixture = await isolatedDatabase(`sqlite:${root}/db`),
      db = fixture.db;
    const app = Fastify();
    let taxReady = false;
    const processor = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url!.startsWith("/v1/tax/settings")
            ? { status: taxReady ? "active" : "pending" }
            : { id: "txcd_10103000" },
        ),
      );
    });
    await new Promise<void>((resolve) =>
      processor.listen(0, "127.0.0.1", resolve),
    );
    try {
      await migrate(db);
      await up(db);
      const module = await import("../src/commerce-admin.ts").catch(
        () => undefined,
      );
      assert.ok(module?.commerceAdminRoutes, "commerce admin routes required");
      const config = loadConfig({
        DEPLOYMENT_MODE: deploymentMode,
        STANDALONE_OWNER_EMAIL: "owner@example.test",
        APP_SECRET: "44".repeat(32),
        OPERATOR_TOKEN: "x".repeat(32),
      });
      const tenant = await db("tenants").where({ id: "primary" }).first();
      await db("tenants")
        .where({ id: tenant.id })
        .update({ exempt: 0, paid_through: 0, trial_ends_at: 0, suspended: 1 });
      await createTenant(db, { id: "other", slug: "other", name: "Other" });
      for (const id of ["primary", "other"])
        await db("products").insert({
          tenant_id: id,
          id: `product-${id}`,
          slug: "p",
          name: "Product",
        });
      await db("seller_users").insert({
        id: "owner",
        email: "owner@example.test",
        verified_at: 1,
        created_at: 1,
      });
      await db("seller_sessions").insert({
        id: hash("fixture-session"),
        user_id: "owner",
        expires_at: Date.now() + 60000,
      });
      await db("seller_memberships").insert({
        tenant_id: "primary",
        user_id: "owner",
        role: "owner",
        created_at: 1,
      });
      if (deploymentMode === "hosted") {
        tenant.stripe_account_id = "acct_admin";
        // Sandbox middleware resolves the tier from the parent workspace.
        tenant.pro_period_start = Date.now() - 1000;
        tenant.pro_paid_through = Date.now() + 60000;
        await db("tenants")
          .where({ id: tenant.id })
          .update({ stripe_account_id: tenant.stripe_account_id });
      }
      const stripe = new StripeBilling(db, config, tenant);
      stripe.stripe = new Stripe("sk_test_fixture", {
        host: "127.0.0.1",
        port: (processor.address() as { port: number }).port,
        protocol: "http",
        maxNetworkRetries: 0,
      });
      const auth = new PlatformAuth(db, config);
      await app.register(cookie);
      await app.register(rateLimit, { global: false });
      app.setErrorHandler((error, _req, reply) => {
        const status =
          error instanceof AppError
            ? error.status
            : (error as { name: string }).name === "ZodError"
              ? 400
              : 500;
        reply.code(status).send({
          code: error instanceof AppError ? error.code : "validation",
        });
      });
      await module.commerceAdminRoutes(
        app,
        () => ({ db, config, tenant, stripe }),
        auth,
      );
      const headers = {
        cookie: `${auth.cookieName}=fixture-session`,
        origin: config.origin,
        "x-csrf-token": csrf("fixture-session", config.secret),
      };
      assert.equal(
        (await app.inject({ url: "/commerce/settings" })).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            url: "/commerce/settings",
            headers: { ...headers, authorization: "Bearer DE-TK-fixture" },
          })
        ).statusCode,
        401,
      );
      const payload = {
        automaticTax: true,
        collectTaxId: true,
        collectBillingAddress: true,
      };
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: "/commerce/settings",
            headers: { cookie: headers.cookie, origin: config.origin },
            payload,
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: "/commerce/settings",
            headers,
            payload: { ...payload, priceId: "price_untrusted" },
          })
        ).statusCode,
        400,
      );
      let response = await app.inject({
        method: "PUT",
        url: "/commerce/settings",
        headers,
        payload,
      });
      assert.equal(
        response.statusCode,
        409,
        "inactive Tax must fail at configuration time",
      );
      assert.equal(
        (await db("tenants").where({ id: tenant.id }).first()).automatic_tax,
        0,
      );
      taxReady = true;
      response = await app.inject({
        method: "PUT",
        url: "/commerce/settings",
        headers,
        payload,
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().settings, { ...payload, allowPromotionCodes: false });
      assert.equal(response.json().features.tax, true);
      response = await app.inject({ url: "/commerce/settings", headers });
      assert.deepEqual(response.json().settings, { ...payload, allowPromotionCodes: false });
      assert.equal(response.json().features.automations, true);
      assert.equal(response.body.includes(config.secret), false);
      assert.equal(response.body.includes("stripeSecret"), false);
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: "/commerce/products/product-other/tax-code",
            headers,
            payload: { taxCode: "txcd_10103000" },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: "PUT",
            url: "/commerce/products/product-primary/tax-code",
            headers,
            payload: { taxCode: "bad" },
          })
        ).statusCode,
        400,
      );
      response = await app.inject({
        method: "PUT",
        url: "/commerce/products/product-primary/tax-code",
        headers,
        payload: { taxCode: "txcd_10103000" },
      });
      assert.deepEqual(response.json(), {
        productId: "product-primary",
        taxCode: "txcd_10103000",
      });
      response = await app.inject({
        method: "PUT",
        url: "/commerce/products/product-primary/tax-code",
        headers,
        payload: { taxCode: null },
      });
      assert.deepEqual(response.json(), {
        productId: "product-primary",
        taxCode: null,
      });
      assert.equal(
        (await db("products").where({ tenant_id: "other" }).first()).tax_code,
        null,
      );
      assert.equal(
        (await db("audit_events").where({ tenant_id: "primary" })).length,
        3,
      );
      await db("seller_memberships").delete();
      assert.equal(
        (await app.inject({ url: "/commerce/settings", headers })).statusCode,
        403,
      );
    } finally {
      await app.close();
      await new Promise<void>((resolve) => processor.close(() => resolve()));
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  });
