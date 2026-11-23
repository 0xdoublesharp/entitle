import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrate, createTenant, type Tenant } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { hash } from "../src/crypto.ts";
import { up, down } from "../src/migrations/011_sandboxes.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { PublisherSandboxes } from "../src/sandboxes.ts";
import { PlatformBilling } from "../src/platform-billing.ts";

async function fixture() {
  const database = await isolatedDatabase("sqlite::memory:");
  const db = database.db;
  await migrate(db);
  await up(db);
  const config = loadConfig({
    APP_SECRET: "12".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
    DEPLOYMENT_MODE: "hosted",
  });
  const owner = {
    id: randomUUID(),
    email: "owner@example.test",
    verified_at: Date.now(),
    created_at: Date.now(),
  };
  const sessionHash = hash("sandbox-owner-session");
  await db("seller_users").insert(owner);
  await db("seller_sessions").insert({
    id: sessionHash,
    user_id: owner.id,
    expires_at: Date.now() + 100000,
  });
  const parent = await createTenant(db, {
    id: randomUUID(),
    slug: "sandbox-parent",
    name: "Live software",
    stripe_account_id: "acct_parent",
  });
  await db("seller_memberships").insert({
    tenant_id: parent.id,
    user_id: owner.id,
    role: "owner",
    created_at: Date.now(),
  });
  const seller = { user: owner, sessionHash, csrfToken: "fixture" };
  return {
    db,
    close: database.close,
    config,
    parent,
    seller,
    sandboxes: new PublisherSandboxes(db, config),
  };
}

test("a publisher sandbox is isolated, repeatable and does not inherit live billing or customer data", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  delete f.config.graceDays;
  const a = await f.sandboxes.create(f.parent, f.seller, "fixture");
  const b = await f.sandboxes.create(f.parent, f.seller, "fixture");
  assert.equal(a.tenant.id, b.tenant.id);
  assert.notEqual(a.tenant.id, f.parent.id);
  assert.match(a.tenant.name, /Sandbox/);
  assert.equal(a.tenant.stripe_account_id, null);
  assert.equal(a.tenant.platform_subscription_id, null);
  const info = await f.sandboxes.describe(a.tenant.id);
  assert.equal(info?.parentSlug, f.parent.slug);
  assert.equal(info?.mode, "fixture");
  assert.equal(
    (await f.db("customers").where({ tenant_id: a.tenant.id })).length,
    0,
  );
  assert.equal(
    (
      await f
        .db("seller_memberships")
        .where({ tenant_id: a.tenant.id, user_id: f.seller.user.id })
    ).length,
    1,
  );
  assert.equal(
    (await f.db<Tenant>("tenants").where({ id: f.parent.id }).first())!
      .stripe_account_id,
    "acct_parent",
  );
  const runtime = await f.sandboxes.runtime(a.tenant);
  assert.equal(runtime.config.localBilling, true);
  assert.equal(runtime.config.stripeLiveMode, false);
  assert.equal(runtime.config.production, f.config.production);
  assert.equal(runtime.tenant.stripe_account_id, "acct_parent");
  assert.deepEqual(await f.sandboxes.runtime(f.parent), {
    tenant: f.parent,
    config: f.config,
  });
});

test("sandbox creation is transactional at one per publisher and rejects unauthorized or nested environments", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await assert.rejects(
    f.sandboxes.create(
      f.parent,
      { ...f.seller, sessionHash: hash("wrong") },
      "fixture",
    ),
    { code: "seller_login_required" },
  );
  const other = await createTenant(f.db, {
    id: randomUUID(),
    slug: "unowned",
    name: "Unowned",
  });
  await assert.rejects(f.sandboxes.create(other, f.seller, "fixture"), /own/i);
  const [a, b] = await Promise.all([
    f.sandboxes.create(f.parent, f.seller, "fixture"),
    f.sandboxes.create(f.parent, f.seller, "fixture"),
  ]);
  assert.equal(a.tenant.id, b.tenant.id);
  await assert.rejects(
    f.sandboxes.create(a.tenant, f.seller, "fixture"),
    /nested/i,
  );
  await assert.rejects(
    f.sandboxes.create(f.parent, f.seller, "stripe"),
    /configured|mode/i,
  );
  await f.db("tenants").where({ id: f.parent.id }).update({ suspended: 1 });
  await assert.rejects(f.sandboxes.runtime(a.tenant), /suspended/i);
});

test("sandbox mappings block platform billing before Stripe calls", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { tenant } = await f.sandboxes.create(f.parent, f.seller, "fixture");
  const platform = new PlatformBilling(f.db, {
    ...f.config,
    stripeSecret: "sk_test_fixture",
    stripeConnectClientId: "ca_fixture",
    platformPriceId: "price_starter",
  });
  await f.db("oauth_states").insert({
    id: hash("sandbox-state"),
    tenant_id: tenant.id,
    user_id: f.seller.user.id,
    session_id: f.seller.sessionHash,
    redirect_uri: `${f.config.origin}/api/v1/platform/stripe/callback`,
    expires_at: Date.now() + 60000,
  });
  await assert.rejects(platform.connect(tenant, f.seller), { code: "sandbox_unsupported" });
  await assert.rejects(platform.callback("code", "sandbox-state", f.seller), { code: "sandbox_unsupported" });
  await assert.rejects(platform.checkout(tenant, f.seller), { code: "sandbox_unsupported" });
  await assert.rejects(platform.portal(tenant), { code: "sandbox_unsupported" });
  assert.equal((await f.db("oauth_states").first()).used, 0);
});

test("sandbox creation and platform Connect recheck seller recovery and session generation", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const platform = new PlatformBilling(f.db, {
    ...f.config,
    stripeSecret: "sk_test_fixture",
    stripeConnectClientId: "ca_fixture",
  });
  await f.db("seller_sessions").where({ id: f.seller.sessionHash }).update({ recovery_id: "recovery" });
  await assert.rejects(f.sandboxes.create(f.parent, f.seller, "fixture"), { code: "recovery_restricted" });
  await assert.rejects(platform.connect(f.parent, f.seller), { code: "recovery_restricted" });
  await f.db("seller_users").where({ id: f.seller.user.id }).update({ security_generation: 1 });
  await assert.rejects(f.sandboxes.create(f.parent, f.seller, "fixture"), { code: "seller_login_required" });
  await assert.rejects(platform.connect(f.parent, f.seller), { code: "seller_login_required" });
});

test("Stripe test sandboxes require explicit test credentials and always use fresh parent account state", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await assert.rejects(
    f.sandboxes.create(f.parent, f.seller, "stripe"),
    /test credentials/i,
  );
  const config = {
    ...f.config,
    stripeTestSecret: "sk_test_fixture",
    stripeTestPublishableKey: "pk_test_fixture",
    stripeTestWebhookSecret: "whsec_test_fixture",
  };
  const service = new PublisherSandboxes(f.db, config);
  const { tenant } = await service.create(f.parent, f.seller, "stripe");
  const runtime = await service.runtime(tenant);
  assert.equal(runtime.config.stripeSecret, "sk_test_fixture");
  assert.equal(runtime.config.stripePublishableKey, "pk_test_fixture");
  assert.equal(runtime.config.stripeLiveMode, false);
  assert.equal(runtime.config.localBilling, false);
  await f
    .db("tenants")
    .where({ id: f.parent.id })
    .update({ stripe_status: "disconnected" });
  assert.equal(
    (await service.runtime(tenant)).tenant.stripe_status,
    "disconnected",
  );
  assert.equal((await service.forStripeAccount("acct_parent"))?.id, tenant.id);
  assert.equal(await service.forStripeAccount("unknown"), undefined);
  await up(f.db);
  await assert.rejects(down(), /backup/);
});

test("sandbox options cannot use live credentials or bypass the merchant context", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const { SandboxStripeBilling } = await import("../src/sandboxes.ts");
  assert.throws(
    () =>
      new SandboxStripeBilling(
        f.db,
        { ...f.config, stripeSecret: "sk_live_no" },
        f.parent,
      ).options(),
    /test credentials/,
  );
  assert.throws(
    () =>
      new SandboxStripeBilling(
        f.db,
        { ...f.config, stripeLiveMode: true },
        f.parent,
      ).options(),
    /test credentials/,
  );
  const direct = new SandboxStripeBilling(
    f.db,
    { ...f.config, deploymentMode: "standalone" },
    f.parent,
  );
  assert.deepEqual(direct.options(), {});
  assert.throws(
    () =>
      new SandboxStripeBilling(f.db, f.config, {
        ...f.parent,
        stripe_account_id: null,
      }).options(),
    /Connect/,
  );
  assert.deepEqual(
    new SandboxStripeBilling(f.db, f.config, f.parent).options(),
    { stripeAccount: "acct_parent" },
  );
  await assert.rejects(
    f.sandboxes.create(f.parent, f.seller, "invalid" as "fixture"),
    /Choose fixture/,
  );
  const owner = f.seller.user;
  await f
    .db("seller_users")
    .where({ id: owner.id })
    .update({ verified_at: null });
  await assert.rejects(
    f.sandboxes.create(f.parent, f.seller, "fixture"),
    { code: "seller_login_required" },
  );
  await f
    .db("seller_users")
    .where({ id: owner.id })
    .update({ verified_at: Date.now() });
  await f
    .db("tenants")
    .where({ id: f.parent.id })
    .update({
      exempt: 0,
      paid_through: 0,
      trial_ends_at: 0,
      billing_status: "past_due",
    });
  await assert.rejects(
    f.sandboxes.create(f.parent, f.seller, "fixture"),
    /capacity/,
  );
});

test("sandbox copies only bounded product definitions and follows current parent tier instead of its exemption", async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f
    .db("products")
    .insert({
      tenant_id: f.parent.id,
      id: randomUUID(),
      slug: "copied",
      name: "Copied",
      framework: "generic",
      framework_config: JSON.stringify({ activationKind: "device" }),
      tax_code: "txcd_10000000",
    });
  const created = await f.sandboxes.create(f.parent, f.seller, "fixture");
  const copied = await f
    .db("products")
    .where({ tenant_id: created.tenant.id })
    .first();
  assert.equal(copied.slug, "copied");
  assert.equal(copied.tax_code, "txcd_10000000");
  assert.equal(
    (await f.db("plans").where({ tenant_id: created.tenant.id })).length,
    0,
  );
  assert.equal(
    await f.sandboxes.forStripeAccount("acct_parent"),
    undefined,
    "fixture sandbox cannot receive Stripe events",
  );
  await f
    .db("tenants")
    .where({ id: f.parent.id })
    .update({
      pro_paid_through: Date.now() + 100000,
      pro_period_start: Date.now() - 1000,
      exempt: 0,
    });
  const runtime = await f.sandboxes.runtime(created.tenant);
  assert.equal(runtime.tenant.exempt, 0);
  assert.ok(runtime.tenant.pro_paid_through! > Date.now());
  const missingCredentials = new PublisherSandboxes(f.db, f.config);
  await f
    .db("publisher_sandboxes")
    .where({ parent_tenant_id: f.parent.id })
    .update({ mode: "stripe" });
  await assert.rejects(
    missingCredentials.runtime(created.tenant),
    /test credentials/,
  );
});
