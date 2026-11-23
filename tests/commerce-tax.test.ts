import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import { migrate, createTenant, type Plan } from "../src/db.ts";
import { up } from "../src/migrations/008_commerce.ts";
import { loadConfig } from "../src/config.ts";
import { StripeBilling } from "../src/stripe.ts";
import { isolatedDatabase } from "./helpers/database.ts";

for (const deploymentMode of ["standalone", "hosted"] as const)
  for (const uiMode of ["hosted", "elements"] as const)
    test(`seller tax settings govern ${deploymentMode} ${uiMode} Checkout requests`, async () => {
      const root = await mkdtemp(
        "/Volumes/Scratch/entitle/tmp/commerce-tax-",
      );
      const fixture = await isolatedDatabase(`sqlite:${root}/db`),
        db = fixture.db;
      const requests: {
        path: string;
        method: string;
        account: unknown;
        body: URLSearchParams;
      }[] = [];
      let processorTaxCode: string | null = null;
      let ready = true,
        customers = 0;
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const path = new URL(req.url!, "http://fixture").pathname;
        requests.push({
          path,
          method: req.method!,
          account: req.headers["stripe-account"],
          body: new URLSearchParams(Buffer.concat(chunks).toString()),
        });
        res.setHeader("content-type", "application/json");
        const submitted = requests.at(-1)!.body;
        if (path.startsWith("/v1/products/") && req.method === "POST")
          processorTaxCode = submitted.get("tax_code") || null;
        const result = path.startsWith("/v1/prices/")
          ? {
              id: "price_annual",
              active: true,
              type: "recurring",
              unit_amount: 1200,
              currency: "usd",
              product: "prod_tax",
              recurring: { interval: "year", interval_count: 1 },
            }
          : path === "/v1/customers"
            ? { id: `cus_tax_${++customers}` }
            : path === "/v1/tax/settings"
              ? { status: ready ? "active" : "pending" }
              : path.startsWith("/v1/tax_codes/")
                ? { id: "txcd_10103000" }
                : path.startsWith("/v1/products/")
                  ? { id: "prod_tax", tax_code: processorTaxCode }
                  : {
                      id: "cs_tax",
                      url: "https://checkout.stripe.test/tax",
                      client_secret: "cs_tax_secret_fixture",
                    };
        res.end(JSON.stringify(result));
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        await migrate(db);
        await up(db);
        const tenant =
          deploymentMode === "standalone"
            ? await db("tenants").where({ id: "primary" }).first()
            : await createTenant(db, {
                id: "tax",
                slug: "tax",
                name: "Tax",
                stripe_account_id: "acct_tax",
              });
        await db("products").insert({
          tenant_id: tenant.id,
          id: "p",
          slug: "p",
          name: "Product",
        });
        const config = loadConfig({
          DEPLOYMENT_MODE: deploymentMode,
          APP_SECRET: "33".repeat(32),
          OPERATOR_TOKEN: "x".repeat(32),
          STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
        });
        const source = new StripeBilling(db, config, tenant);
        source.stripe = new Stripe("sk_test_fixture", {
          host: "127.0.0.1",
          port: (server.address() as { port: number }).port,
          protocol: "http",
          maxNetworkRetries: 0,
        });
        const plan: Plan = {
          tenant_id: tenant.id,
          id: "plan_tax",
          product_id: "p",
          name: "Annual",
          site_allowance: 1,
          stripe_price_id: "price_annual",
        };
        await db("plans").insert(plan);
        await db("plans").insert({
          ...plan,
          id: "plan_tax_duplicate",
          stripe_price_id: "price_annual_second",
        });
        await source.checkout(plan, "off@example.test", undefined, uiMode);
        const off = requests.find(
          (r) => r.path === "/v1/checkout/sessions",
        )!.body;
        for (const key of [
          "automatic_tax[enabled]",
          "tax_id_collection[enabled]",
          "billing_address_collection",
          "customer_update[address]",
          "customer_update[name]",
        ])
          assert.equal(off.has(key), false);
        await db("tenants").where({ id: tenant.id }).update({
          automatic_tax: 1,
          collect_tax_id: 1,
          collect_billing_address: 1,
        });
        await db("products")
          .where({ tenant_id: tenant.id, id: "p" })
          .update({ tax_code: "txcd_10103000" });
        await source.syncProductTaxCode(plan.product_id, "txcd_10103000");
        assert.equal(processorTaxCode, "txcd_10103000");
        requests.length = 0;
        await source.syncProductTaxCode(plan.product_id, "txcd_10103000");
        assert.equal(
          requests.some(
            (r) => r.path.startsWith("/v1/products/") && r.method === "POST",
          ),
          false,
        );
        requests.length = 0;
        await source.checkout(plan, "on@example.test", undefined, uiMode);
        const on = requests.find(
          (r) => r.path === "/v1/checkout/sessions",
        )!.body;
        assert.equal(on.get("automatic_tax[enabled]"), "true");
        assert.equal(on.get("tax_id_collection[enabled]"), "true");
        assert.equal(on.get("billing_address_collection"), "required");
        assert.equal(on.get("customer_update[address]"), "auto");
        assert.equal(on.get("customer_update[name]"), "auto");
        assert.equal(on.get("line_items[0][price]"), "price_annual");
        assert.equal(
          requests.some(
            (r) =>
              r.path.startsWith("/v1/products/") ||
              r.path.startsWith("/v1/tax_codes/"),
          ),
          false,
          "buyer Checkout must not mutate or reconcile merchant product tax codes",
        );
        assert.ok(
          requests.every(
            (r) =>
              r.account ===
              (deploymentMode === "hosted" ? "acct_tax" : undefined),
          ),
        );
        assert.equal((await db("licenses")).length, 0);
        await source.syncProductTaxCode(plan.product_id, null);
        assert.equal(
          processorTaxCode,
          null,
          "clearing the seller override syncs the explicit processor tax-code reset",
        );
        source.config.localBilling = true;
        await assert.rejects(
          source.syncProductTaxCode(plan.product_id, "txcd_10103000"),
          { code: "local_billing" },
        );
        await assert.rejects(source.validateTaxSettings(), {
          code: "local_billing",
        });
        source.config.localBilling = false;
        ready = false;
        requests.length = 0;
        await assert.rejects(
          source.checkout(plan, "bad@example.test", undefined, uiMode),
          { code: "tax_configuration" },
        );
        assert.equal(
          requests.some((r) => r.path === "/v1/checkout/sessions"),
          false,
        );
        ready = true;
        await db("tenants")
          .where({ id: tenant.id })
          .update({ automatic_tax: 7 });
        await assert.rejects(
          source.checkout(plan, "bad-flag@example.test", undefined, uiMode),
          { code: "tax_configuration" },
        );
        await db("tenants").where({ id: tenant.id }).update({
          automatic_tax: 0,
          collect_tax_id: 0,
          collect_billing_address: 0,
        });
        await db("products")
          .where({ tenant_id: tenant.id, id: "p" })
          .update({ tax_code: "bad" });
        await assert.rejects(
          source.checkout(plan, "bad-code@example.test", undefined, uiMode),
          { code: "tax_configuration" },
        );
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await fixture.close();
        await rm(root, { recursive: true, force: true });
      }
    });
