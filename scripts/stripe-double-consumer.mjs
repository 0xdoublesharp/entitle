import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { loadConfig } from "../src/config.ts";
import { createDb, migrate } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { StripeBilling } from "../src/stripe.ts";
import { hash } from "../src/crypto.ts";
import { runCli } from "../src/cli.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 16384) throw Error("Input too large");
}
const data = JSON.parse(raw);
const origin = new URL(data.origin);
if (
  origin.protocol !== "http:" ||
  origin.hostname !== "127.0.0.1" ||
  !/^sk_test_LocalSim[0-9a-f]{32}$/.test(data.apiKey) ||
  data.apiVersion !== "2026-09-30.endive"
)
  throw Error("Invalid simulator bootstrap");
const localFetch = async (url, options) => {
  const destination = new URL(url);
  if (destination.origin !== origin.origin)
    throw Error("Nonlocal provider destination refused");
  const headers = new Headers(options.headers);
  headers.set("X-Local-Simulator-Instance", data.instance);
  headers.set("X-Local-Simulator-Run", data.run);
  // StripeDouble requires idempotency on mutations. Preserve keys supplied by
  // Entitle and give otherwise unkeyed test requests their own one-shot key.
  if (options.method === "POST" && !headers.has("Idempotency-Key"))
    headers.set("Idempotency-Key", `entitle-test-${randomUUID()}`);
  return fetch(url, { ...options, headers, redirect: "error" });
};
const stripe = new Stripe(data.apiKey, {
  host: "127.0.0.1",
  port: Number(origin.port),
  protocol: "http",
  apiVersion: data.apiVersion,
  maxNetworkRetries: 0,
  httpClient: Stripe.createFetchHttpClient(localFetch),
});
const work = data.work;
process.env.NODE_ENV = "test";
let app;
let db;
let stage = "setup";
const hostedForm = async (url, fields) => {
  if (new URL(url).origin !== origin.origin)
    throw Error("Nonlocal hosted destination refused");
  const page = await fetch(url, { redirect: "error" });
  if (!page.ok) throw Error("Hosted page failed");
  const html = await page.text();
  const input = (name) => {
    const match = html.match(new RegExp(`name="${name}" value="([^"]+)"`));
    if (!match) throw Error("Hosted form field missing");
    return match[1];
  };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Origin: origin.origin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      _csrf: input("_csrf"),
      version: input("version"),
      ...fields,
    }),
    redirect: "manual",
  });
  if (response.status !== 303) throw Error("Hosted action failed");
  return response.headers.get("location");
};
try {
  await mkdir(join(work, "web"));
  await writeFile(
    join(work, "web", "index.html"),
    "<!doctype html><title>Fixture</title>",
  );
  const config = loadConfig({
    NODE_ENV: "test",
    DEPLOYMENT_MODE: "standalone",
    STANDALONE_OWNER_EMAIL: "owner@example.test",
    APP_SECRET: "12".repeat(32),
    OPERATOR_TOKEN: "operator-secret-for-simulator-tests",
    DATA_DIR: work,
    WORK_DIR: join(work, "storage"),
    WEB_DIR: join(work, "web"),
    STRIPE_SECRET_KEY: data.apiKey,
    STRIPE_PUBLISHABLE_KEY: data.publicKey,
    STRIPE_WEBHOOK_SECRET: data.webhookSecret,
  });
  db = createDb(config.databaseUrl);
  await migrate(db);
  const tenant = await db("tenants").where({ id: "primary" }).first();
  const billing = new StripeBilling(db, config, tenant);
  billing.stripe = stripe;
  const snapshot = await billing.snapshot(data.subscription);
  if (
    snapshot.billingStatus !== "active" ||
    snapshot.customerId !== data.customer ||
    snapshot.grants.length !== 1 ||
    snapshot.grants[0].priceId !== data.price ||
    snapshot.invoices.length !== 1 ||
    snapshot.invoices[0].paidMinor !== 1200 ||
    snapshot.invoices[0].refundedMinor !== 400
  )
    throw Error("Canonical subscription snapshot mismatch");
  const token = `DE-TK-${"t".repeat(43)}`;
  await db("tenant_api_keys").insert({
    id: "sim-test-key",
    tenant_id: "primary",
    name: "Fixture",
    key_hash: hash(token),
    created_at: Date.now(),
    revoked_at: null,
    scopes: JSON.stringify(["read", "catalog:write"]),
    expires_at: Date.now() + 60000,
    last_used_at: null,
    display_prefix: token.slice(0, 14),
  });
  app = await buildApp(
    config,
    db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore(), stripeFactory: () => billing },
  );
  const localOrigin = await app.listen({ port: 0, host: "127.0.0.1" });
  config.origin = localOrigin;
  const input = join(work, "product.json");
  await writeFile(
    input,
    JSON.stringify({
      slug: "simulated",
      name: "Simulated",
      framework: "generic",
      plans: [{ name: "Annual", siteAllowance: 1, priceId: data.price }],
    }),
    { mode: 0o600 },
  );
  const lines = [];
  const io = {
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
  if (
    (await runCli(
      ["product-save", input],
      {
        PUBLIC_ORIGIN: localOrigin,
        TENANT_SLUG: "primary",
        TENANT_API_KEY: token,
      },
      io,
    )) !== 0
  )
    throw Error("Structured CLI product creation failed");
  const product = await db("products")
    .where({ tenant_id: "primary", slug: "simulated" })
    .first();
  const plan =
    product &&
    (await db("plans")
      .where({
        tenant_id: "primary",
        product_id: product.id,
        stripe_price_id: data.price,
      })
      .first());
  if (!plan) throw Error("Simulated annual price mapping missing");
  stage = "hosted checkout";
  const checkout = await billing.checkout(plan, "buyer@example.test");
  const localCustomer = await db("customers")
    .where({ tenant_id: "primary", email: "buyer@example.test" })
    .first();
  if (!localCustomer?.stripe_id)
    throw Error("Checkout customer mapping missing");
  const success = await hostedForm(checkout.url, { action: "complete" });
  if (success !== `${localOrigin}/t/primary?checkout=success`)
    throw Error("Checkout return mismatch");
  const sessions = await stripe.checkout.sessions.list({
    customer: localCustomer.stripe_id,
    limit: 10,
  });
  const completed = sessions.data.find(
    (session) => session.status === "complete",
  );
  if (!completed?.subscription) throw Error("Completed subscription missing");
  const purchased = await billing.snapshot(completed.subscription);
  if (
    purchased.customerId !== localCustomer.stripe_id ||
    purchased.billingStatus !== "active" ||
    purchased.grants.length !== 1 ||
    purchased.grants[0].priceId !== data.price ||
    purchased.invoices.length !== 1 ||
    purchased.invoices[0].paidMinor !== 1200
  )
    throw Error("Completed purchase snapshot mismatch");
  stage = "customer portal";
  const portal = await billing.portal(localCustomer.stripe_id);
  const returned = await hostedForm(portal.url, {
    action: "cancel",
    subscription: completed.subscription,
  });
  if (returned !== `${localOrigin}/t/primary`)
    throw Error("Portal return mismatch");
  const subscription = await stripe.subscriptions.retrieve(
    completed.subscription,
  );
  if (subscription.status !== "active" || !subscription.cancel_at_period_end)
    throw Error("Portal cancellation was not scheduled");
  stage = "Elements session";
  const elements = await billing.checkout(
    plan,
    "elements@example.test",
    undefined,
    "elements",
  );
  if (
    elements.uiMode !== "elements" ||
    !elements.clientSecret ||
    elements.publishableKey !== data.publicKey ||
    elements.returnUrl !== `${localOrigin}/t/primary?checkout=return`
  )
    throw Error("Elements session mismatch");
  stage = "MCP product update";
  const agent = new Client({ name: "stripe-double-fixture", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp.ts"],
    env: {
      PATH: process.env.PATH ?? "",
      PUBLIC_ORIGIN: localOrigin,
      TENANT_SLUG: "primary",
      TENANT_API_KEY: token,
    },
    stderr: "pipe",
  });
  try {
    await agent.connect(transport);
    const update = await agent.callTool({
      name: "entitle_op_product_save",
      arguments: {
        slug: "simulated",
        name: "Simulated updated",
        framework: "generic",
        plans: [{ name: "Annual", siteAllowance: 1, priceId: data.price }],
      },
    });
    if (update.isError) throw Error("Structured MCP product update failed");
    if (
      (
        await db("products")
          .where({ tenant_id: "primary", id: product.id })
          .first()
      ).name !== "Simulated updated"
    )
      throw Error("MCP product update not persisted");
  } finally {
    await agent.close();
  }
  process.stdout.write("Entitle StripeDouble integration passed\n");
} catch (error) {
  process.stderr.write(
    `Consumer check failed at ${stage}: ${error?.name ?? "Error"} ${error?.code ?? ""}\n`,
  );
  process.exitCode = 1;
} finally {
  await app?.close();
  await db?.destroy();
}
