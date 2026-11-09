import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import type { DB } from "../src/db.ts";
const credentials = {
  APP_SECRET: "01".repeat(32),
  OPERATOR_TOKEN: "operator-".repeat(5),
};

test("billing worker limits accept bounded recovery settings and reject unsafe environment values", () => {
  assert.deepEqual(loadConfig(credentials).billingWorker, {
    maxFacts: 10000, maxBytes: 16 * 1048576, maxApplyRecords: 3000,
    maxApplyWork: 1000000, applyMs: 5000,
  });
  const settings = {
    BILLING_WORKER_MAX_FACTS: "50000", BILLING_WORKER_MAX_MIB: "64",
    BILLING_WORKER_MAX_APPLY_RECORDS: "20000", BILLING_WORKER_MAX_APPLY_WORK: "10000000",
    BILLING_WORKER_APPLY_MS: "30000",
  };
  assert.deepEqual(loadConfig({ ...credentials, ...settings }).billingWorker, {
    maxFacts: 50000, maxBytes: 64 * 1048576, maxApplyRecords: 20000,
    maxApplyWork: 10000000, applyMs: 30000,
  });
  for (const [name, ceiling] of Object.entries(settings))
    for (const value of ["0", "-1", "1.5", "Infinity", "NaN", String(Number(ceiling) + 1)])
      assert.throws(() => loadConfig({ ...credentials, [name]: value }), Error, `${name}=${value}`);
});

test("programmatic billing worker limits fail before the app reads its database", async () => {
  const config = loadConfig(credentials);
  const db = (() => { throw Error("Unexpected database access"); }) as unknown as DB;
  for (const limits of [{ maxFacts: 0 }, { maxBytes: Infinity }, { maxApplyRecords: 20001 },
    { maxApplyWork: NaN }, { applyMs: 30001 }]) {
    await assert.rejects(buildApp({ ...config, billingWorker: limits }, db), /billing worker .* limit/);
    await assert.rejects(buildApp(config, db, undefined, { billingWorker: limits }), /billing worker .* limit/);
  }
});

test("the published example operator token cannot authorize a deployment", () => {
  const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
  const token = /^OPERATOR_TOKEN=(.+)$/m.exec(example)?.[1];
  assert.ok(token);
  assert.throws(
    () => loadConfig({ ...credentials, OPERATOR_TOKEN: token }),
    /OPERATOR_TOKEN.*placeholder/i,
  );
  assert.equal(loadConfig(credentials).operatorToken, credentials.OPERATOR_TOKEN);
});

test("a public origin cannot contain paths, URL credentials, query strings or fragments", () => {
  for (const origin of [
    "https://licenses.example.test/customer",
    "https://licenses.example.test/?key=secret",
    "https://licenses.example.test/#fragment",
    "https://user:password@licenses.example.test",
    "https://:password@licenses.example.test",
    "ftp://licenses.example.test",
  ])
    assert.throws(
      () => loadConfig({ ...credentials, PUBLIC_ORIGIN: origin }),
      /origin/i,
    );
});
test("invalid listener and SMTP ports fail during configuration rather than leaving a broken running service", () => {
  for (const port of ["not-a-number", "-1", "65536", "3.5"])
    assert.throws(() => loadConfig({ ...credentials, PORT: port }), /port/i);
  for (const port of ["not-a-number", "0", "-1", "65536", "3.5"])
    assert.throws(
      () => loadConfig({ ...credentials, SMTP_PORT: port }),
      /port/i,
    );
});

test("production rejects insecure origins, fixture billing and every missing external credential", () => {
  const valid = {
    DEPLOYMENT_MODE: "hosted",
    ...credentials,
    NODE_ENV: "production",
    PUBLIC_ORIGIN: "https://licenses.example.test",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
    STRIPE_CONNECT_CLIENT_ID: "ca_fixture",
    STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect_fixture",
    PLATFORM_STRIPE_PRICE_ID: "price_platform_fixture",
    SMTP_HOST: "smtp.example.test",
    MAIL_FROM: "licenses@example.com",
    TRUST_PROXY: "172.30.81.2",
    S3_BUCKET: "private-releases",
    S3_REGION: "us-east-1",
  };
  assert.equal(loadConfig(valid).production, true);
  assert.throws(
    () =>
      loadConfig({ ...valid, PUBLIC_ORIGIN: "http://licenses.example.test" }),
    /HTTPS/,
  );
  assert.throws(
    () => loadConfig({ ...valid, LOCAL_BILLING: "true" }),
    /forbidden/,
  );
  for (const field of [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SMTP_HOST",
  ]) {
    assert.throws(
      () => loadConfig({ ...valid, [field]: "" }),
      /requires Stripe and SMTP/,
    );
  }
  assert.throws(() => loadConfig({ ...valid, APP_SECRET: "not-a-key" }));
  assert.throws(() => loadConfig({ ...valid, OPERATOR_TOKEN: "short" }));
  assert.throws(() => loadConfig({ ...valid, PUBLIC_ORIGIN: "not-a-url" }));
  for (const field of [
    "STRIPE_CONNECT_CLIENT_ID",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
    "PLATFORM_STRIPE_PRICE_ID",
    "STRIPE_PUBLISHABLE_KEY",
  ])
    assert.throws(
      () => loadConfig({ ...valid, [field]: "" }),
      /Connect and platform/,
    );
  assert.throws(() => loadConfig({ ...valid, TRUST_PROXY: "" }), /TRUST_PROXY/);
  assert.throws(() => loadConfig({ ...valid, MAIL_FROM: "" }), /MAIL_FROM/);
  assert.throws(
    () => loadConfig({ ...valid, MAIL_FROM: "licenses@example.test" }),
    /MAIL_FROM/,
  );
});
test("configuration honors explicit database, storage, assets, SMTP and exemption settings", () => {
  const value = loadConfig({
    ...credentials,
    PUBLIC_ORIGIN: "http://localhost:4567/",
    DATABASE_URL: "postgresql://localhost/test",
    DATA_DIR: "/Volumes/Scratch/entitle/data/config-test",
    WORK_DIR: "/Volumes/Scratch/entitle/data/config-artifacts",
    WEB_DIR: "/Volumes/Scratch/entitle/build/config-web",
    BUILD_DIR: "/Volumes/Scratch/entitle/build/config",
    PORT: "4567",
    SMTP_HOST: "smtp.example.test",
    SMTP_PORT: "465",
    SMTP_USER: "test",
    SMTP_PASS: "fixture-password",
    SMTP_SECURE: "true",
    MAIL_FROM: "test@example.test",
    STRIPE_SECRET_KEY: "sk_test_key",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    LOCAL_BILLING: "true",
    DEVELOPMENT_HOST_SUFFIXES: " STAGING.example.test, ,local.test ",
  });
  assert.equal(value.origin, "http://localhost:4567");
  assert.equal(value.port, 4567);
  assert.equal(value.databaseUrl, "postgresql://localhost/test");
  assert.equal(
    value.storage,
    "/Volumes/Scratch/entitle/data/config-artifacts",
  );
  assert.equal(
    value.staticDir,
    "/Volumes/Scratch/entitle/build/config-web",
  );
  assert.equal(value.smtpPort, 465);
  assert.equal(value.smtpUser, "test");
  assert.equal(value.smtpPass, "fixture-password");
  assert.equal(value.smtpSecure, true);
  assert.equal(value.mailFrom, "test@example.test");
  assert.deepEqual(value.exemptSuffixes, [
    "staging.example.test",
    "local.test",
  ]);
  assert.equal(value.localBilling, true);
  assert.equal(value.stripeSecret, "sk_test_key");
  assert.equal(value.stripeWebhookSecret, "whsec_test");
  const withBuild = loadConfig({
    ...credentials,
    BUILD_DIR: "/Volumes/Scratch/entitle/build/config",
  });
  assert.equal(
    withBuild.staticDir,
    "/Volumes/Scratch/entitle/build/config/web",
  );
});
test("SaaS transfer and storage limits reject unsafe configuration", () => {
  const base = { ...credentials, S3_BUCKET: "private", S3_REGION: "us-east-1" };
  for (const setting of [
    { MAX_UPLOAD_MIB: "101" },
    { MAX_UPLOAD_MIB: "0" },
    { TRANSFER_MEMORY_MIB: "100", MAX_UPLOAD_MIB: "25" },
    { TRIAL_DAYS: "-1" },
    { GRACE_DAYS: "91" },
    { S3_ACCESS_KEY_ID: "unpaired" },
    { S3_SECRET_ACCESS_KEY: "unpaired" },
    { S3_ENDPOINT: "http://localhost:9000" },
    { S3_ENDPOINT: "https://user:secret@storage.example.test" },
    { S3_ENDPOINT: "https://storage.example.test/?secret=x" },
    { S3_ENDPOINT: "https://storage.example.test/#secret" },
    { STRIPE_PUBLISHABLE_KEY: "sk_test_never_public" },
    { STRIPE_PUBLISHABLE_KEY: "pk_live_wrongmode" },
    { STRIPE_PUBLISHABLE_KEY: "pk_test_wrongmode", STRIPE_LIVE_MODE: "true" },
    { STRIPE_SECRET_KEY: "sk_live_wrongmode" },
    { STRIPE_SECRET_KEY: "rk_test_wrongmode", STRIPE_LIVE_MODE: "true" },
    { TRUST_PROXY: "true" },
    { TRUST_PROXY: "0.0.0.0/0" },
    { TRUST_PROXY: "::/0" },
  ])
    assert.throws(() => loadConfig({ ...base, ...setting }));
  for (const field of ["S3_BUCKET", "S3_REGION"])
    assert.throws(
      () =>
        loadConfig({
          ...base,
          NODE_ENV: "production",
          PUBLIC_ORIGIN: "https://de.example.test",
          STRIPE_SECRET_KEY: "sk_test",
          STRIPE_WEBHOOK_SECRET: "whsec",
          SMTP_HOST: "smtp.test",
          [field]: "",
        }),
      /S3/,
    );
  const c = loadConfig({
    ...base,
    S3_ENDPOINT: "http://localhost:9000",
    S3_ALLOW_HTTP: "true",
    S3_FORCE_PATH_STYLE: "true",
    S3_ACCESS_KEY_ID: "local",
    S3_SECRET_ACCESS_KEY: "local-secret",
    MAX_UPLOAD_MIB: "100",
    TRANSFER_MEMORY_MIB: "768",
    MAX_TENANTS_PER_SELLER: "2",
    TRIAL_STORAGE_MIB: "50",
    PAID_MAX_PRODUCTS: "30",
    PAID_STORAGE_MIB: "2048",
  });
  assert.equal(c.transferMemoryBytes, 768 * 1024 * 1024);
  assert.equal(c.maxUploadBytes, 100 * 1024 * 1024);
  assert.equal(c.s3?.allowInsecureLocalDevelopment, true);
  assert.equal(c.s3?.forcePathStyle, true);
  assert.equal(c.s3?.credentials?.accessKeyId, "local");
  assert.equal(c.maxTenantsPerSeller, 2);
  assert.equal(c.trialStorageBytes, 50 * 1024 * 1024);
  assert.equal(c.paidMaxProducts, 30);
  assert.equal(c.paidStorageBytes, 2048 * 1024 * 1024);
});
test("default environment lookup produces the documented development defaults", () => {
  const original = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, credentials);
    const value = loadConfig();
    assert.equal(value.port, 3211);
    assert.equal(value.production, false);
    assert.equal(value.localBilling, false);
    assert.equal(value.smtpHost, "127.0.0.1");
    assert.equal(value.smtpPort, 1025);
    assert.equal(value.smtpSecure, false);
    assert.equal(value.smtpUser, "");
    assert.equal(value.smtpPass, "");
    assert.equal(value.mailFrom, "licenses@example.test");
    assert.equal(value.stripeSecret, "sk_test_local");
    assert.equal(value.stripeWebhookSecret, "whsec_local");
    assert.deepEqual(value.exemptSuffixes, []);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, original);
  }
});

test("optional Redis cache configuration is explicit, bounded and never echoes credential-bearing URLs", () => {
  const defaults = loadConfig(credentials);
  assert.equal(defaults.cacheRedisUrl, undefined);
  assert.equal(defaults.cacheMemoryBytes, 8 * 1048576);
  for (const url of [
    "redis://cache:6379/1",
    "rediss://user:password@cache.example:6380/0",
  ])
    assert.equal(
      loadConfig({ ...credentials, CACHE_REDIS_URL: url }).cacheRedisUrl,
      url,
    );
  for (const url of [
    "not a URL secret",
    "redis:///0",
    "https://user:secret@example.test",
    "redis://cache/?secret=hidden",
    "redis://cache/#hidden",
  ])
    assert.throws(
      () => loadConfig({ ...credentials, CACHE_REDIS_URL: url }),
      (e: unknown) =>
        e instanceof Error &&
        /CACHE_REDIS_URL/.test(e.message) &&
        !e.message.includes("hidden") &&
        !e.message.includes("secret"),
    );
  assert.throws(() => loadConfig({ ...credentials, CACHE_MEMORY_MIB: "0" }));
  assert.throws(() =>
    loadConfig({ ...credentials, CACHE_NAMESPACE: "unsafe namespace" }),
  );
});

test("uppercase Redis TLS schemes normalize before reaching the Redis client", () => {
  assert.equal(
    loadConfig({
      ...credentials,
      CACHE_REDIS_URL: "REDISS://user:password@cache.example:6380/0",
    }).cacheRedisUrl,
    "rediss://user:password@cache.example:6380/0",
  );
});

test("export admission settings bound global disk and preserve cross-tenant slots", () => {
  const defaults = loadConfig({ ...credentials });
  assert.equal(defaults.exportMaxExports, 4);
  assert.equal(defaults.exportMaxBytes, 10 * 1024 ** 3);
  const custom = loadConfig({
    ...credentials,
    EXPORT_MAX_EXPORTS: "6",
    EXPORT_MAX_GIB: "2",
  });
  assert.equal(custom.exportMaxExports, 6);
  assert.equal(custom.exportMaxBytes, 2 * 1024 ** 3);
  for (const value of ["0", "1", "11", "1.5"])
    assert.throws(() =>
      loadConfig({ ...credentials, EXPORT_MAX_EXPORTS: value }),
    );
  for (const value of ["0", "11", "1.5"])
    assert.throws(() => loadConfig({ ...credentials, EXPORT_MAX_GIB: value }));
});
