import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import {
  createDb,
  migrate,
  type DB,
  type Plan,
  type Tenant,
} from "../src/db.ts";
import { StripeBilling } from "../src/stripe.ts";
import { PlatformBilling } from "../src/platform-billing.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";

const production = {
  APP_SECRET: "31".repeat(32),
  OPERATOR_TOKEN: "operator-".repeat(5),
  NODE_ENV: "production",
  PUBLIC_ORIGIN: "https://licenses.example.com",
  STANDALONE_OWNER_EMAIL: "owner@example.com",
  SMTP_HOST: "smtp.example.com",
  MAIL_FROM: "licenses@example.com",
  TRUST_PROXY: "127.0.0.1",
  S3_BUCKET: "private",
  S3_REGION: "us-east-1",
};

test("production can start without Stripe while paid services fail before writes", async (t) => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/stripe-optional-");
  let database: DB | undefined;
  t.after(async () => {
    await database?.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const config = loadConfig({
    ...production,
    DATA_DIR: root,
    WEB_DIR: `${root}/web`,
  });
  const db = (database = createDb(config.databaseUrl));
  await migrate(db);
  assert.equal(config.localBilling, false);
  assert.equal(config.stripeSecret, "");
  assert.equal(config.stripeWebhookSecret, "");
  assert.equal(config.stripeConnectWebhookSecret, "");
  const app = await buildApp(
    config,
    db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore() },
  );
  t.after(() => app.close());
  assert.equal(
    (await app.inject("/api/v1/tenants/primary/catalog")).statusCode,
    200,
  );
  const tenant = await db<Tenant>("tenants").where({ id: "primary" }).first();
  const billing = new StripeBilling(db, config, tenant!);
  const unavailable = { code: "billing_unavailable", status: 503 };
  await assert.rejects(
    billing.checkout({ tenant_id: "primary" } as Plan, "pilot@example.com"),
    unavailable,
  );
  await assert.rejects(billing.portal("cus_unknown"), unavailable);
  await assert.rejects(billing.snapshot("sub_unknown"), unavailable);
  await assert.rejects(billing.subscriptionIds(), unavailable);
  assert.equal((await db("customers")).length, 0);
  assert.equal((await db("licenses")).length, 0);
  await (app as typeof app & { tick: () => Promise<void> }).tick();
});

test("hosted production permits complimentary operation without enabling platform billing", async (t) => {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/stripe-optional-hosted-",
  );
  let database: DB | undefined;
  t.after(async () => {
    await database?.destroy();
    await rm(root, { recursive: true, force: true });
  });
  const config = loadConfig({
    ...production,
    DEPLOYMENT_MODE: "hosted",
    DATA_DIR: root,
  });
  const db = (database = createDb(config.databaseUrl));
  await migrate(db);
  const platform = new PlatformBilling(db, config);
  await assert.rejects(platform.reconcile("primary"), {
    code: "billing_unavailable",
    status: 503,
  });
  let platformRuns = 0;
  platform.run = async () => {
    ++platformRuns;
  };
  const app = await buildApp(
    config,
    db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore(), platformBilling: platform },
  );
  t.after(() => app.close());
  await (app as typeof app & { tick: () => Promise<void> }).tick();
  assert.equal(platformRuns, 0);
  assert.equal((await db("platform_work")).length, 0);
});

test("production still rejects fixture billing and incomplete Stripe activation", () => {
  assert.throws(
    () => loadConfig({ ...production, LOCAL_BILLING: "true" }),
    /forbidden/,
  );
  for (const partial of [
    { STRIPE_SECRET_KEY: "sk_test_fixture" },
    { STRIPE_PUBLISHABLE_KEY: "pk_test_fixture" },
    { STRIPE_WEBHOOK_SECRET: "whsec_fixture" },
  ])
    assert.throws(() => loadConfig({ ...production, ...partial }), /Stripe/);
});
