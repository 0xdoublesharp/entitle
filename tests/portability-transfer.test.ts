import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  randomUUID,
  createHash,
  scryptSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  access,
  mkdtemp,
  rm,
  readFile,
  writeFile,
  readdir,
  mkdir,
} from "node:fs/promises";
import { join } from "node:path";
import { createTenant, migrate } from "../src/db.ts";
import { hash, seal, unseal } from "../src/crypto.ts";
import { Licenses } from "../src/licensing.ts";
import { InMemoryArtifactStore, type ArtifactStore } from "../src/storage.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import {
  Portability,
  importPortability,
  completePortabilityImport,
} from "../src/portability.ts";

const sourceSecret = "1".repeat(64),
  destinationSecret = "2".repeat(64),
  passphrase = "user held transfer phrase";
async function fixture(t: TestContext) {
  await access("/Volumes/Scratch");
  const temporary = process.env.TMPDIR ?? "/Volumes/Scratch/entitle/tmp";
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(join(temporary, "portability-"));
  const source = await isolatedDatabase(`sqlite:${root}/source.sqlite`);
  const destination = await isolatedDatabase(
    `sqlite:${root}/destination.sqlite`,
  );
  t.after(async () => {
    await source.close();
    await destination.close();
    await rm(root, { recursive: true, force: true });
  });
  await migrate(source.db);
  await migrate(destination.db);
  const tenant = await createTenant(source.db, {
    id: randomUUID(),
    slug: "portable-publisher",
    name: "Portable",
    stripe_account_id: "acct_merchant",
    billing_status: "past_due",
  });
  const product = randomUUID(),
    plan = randomUUID(),
    customer = randomUUID(),
    license = randomUUID(),
    installation = randomUUID();
  const key = "DE-original-key-kept",
    token = "original-activation-token";
  const owned = { tenant_id: tenant.id };
  await source.db("products").insert({
    ...owned,
    id: product,
    slug: "portable-product",
    name: "Portable",
  });
  await source.db("plans").insert({
    ...owned,
    id: plan,
    product_id: product,
    name: "Annual",
    site_allowance: 3,
    stripe_price_id: "price_paid",
  });
  await source.db("customers").insert({
    ...owned,
    id: customer,
    email: "buyer@example.test",
    stripe_id: "cus_paid",
  });
  await source.db("licenses").insert({
    ...owned,
    id: license,
    customer_id: customer,
    product_id: product,
    plan_id: plan,
    site_allowance: 3,
    paid_through: Date.now() + 86400000,
    billing_status: "active",
    subscription_id: "sub_paid",
    key_hash: hash(key),
  });
  await source.db("grants").insert({
    ...owned,
    id: "il_paid",
    license_id: license,
    invoice_id: "in_paid",
    plan_id: plan,
    period_start: 1,
    period_end: Date.now() + 86400000,
    paid_at: 2,
  });
  await source.db("installations").insert({
    ...owned,
    id: installation,
    license_id: license,
    installation_id: "installation-stable",
    site_url: "example.test",
    active: 1,
    exempt: 0,
    token_hash: hash(token),
    token_cipher: seal(token, sourceSecret),
  });
  await source.db("emails").insert({
    ...owned,
    id: "initial-key",
    customer_id: customer,
    license_id: license,
    kind: "license_key",
    payload: seal(
      {
        to: "buyer@example.test",
        subject: "License",
        text: key,
        messageId: "<initial-key@test>",
      },
      sourceSecret,
    ),
    created_at: 1,
  });
  await source.db("billing_events").insert({
    ...owned,
    id: "evt_processed",
    type: "invoice.paid",
    payload: seal({ pii: "remove processed PII" }, sourceSecret),
    received_at: 2,
    processed_at: 3,
  });
  await source.db("billing_events").insert({
    ...owned,
    id: "evt_pending",
    type: "invoice.paid",
    payload: seal(
      {
        id: "evt_pending",
        type: "invoice.paid",
        data: { object: { subscription: "sub_paid" } },
      },
      sourceSecret,
    ),
    received_at: 4,
  });
  await source.db("work").insert({
    ...owned,
    id: "evt_pending",
    kind: "stripe_event",
    payload: seal({ eventId: "evt_pending" }, sourceSecret),
    created_at: 4,
  });
  await source.db("invoice_metrics").insert({
    ...owned,
    invoice_id: "in_paid",
    currency: "usd",
    paid_minor: 1234,
    refunded_minor: 0,
  });
  const store: ArtifactStore = new InMemoryArtifactStore(),
    targetStore: ArtifactStore = new InMemoryArtifactStore();
  const bytes = Buffer.from("immutable withdrawn artifact");
  const release = randomUUID(),
    checksum = createHash("sha256").update(bytes).digest("hex");
  await source.db("releases").insert({
    ...owned,
    id: release,
    product_id: product,
    version: "1.0.0",
    changelog: "Old",
    published_at: 1,
    withdrawn: 1,
    size: bytes.length,
    checksum,
    min_wp: "",
    min_php: "",
    min_free: "",
    tested: "",
  });
  await store.put(tenant.id, release, bytes, checksum);
  await source.db("download_metrics").insert({
    ...owned,
    release_id: release,
    day: "2026-10-21",
    successful_responses: 4,
    served_bytes: 32,
    storage_read_bytes: 16,
    storage_reads: 2,
  });
  const portability = new Portability({
    db: source.db,
    store,
    secret: sourceSecret,
    directory: `${root}/exports`,
  });
  t.after(() => portability.close());
  async function bundle() {
    const exported = await portability.createExport(tenant.id, passphrase);
    const directory = `${root}/download-${exported.id}`;
    await mkdir(directory, { mode: 0o700 });
    for (const id of ["manifest", ...exported.blobs]) {
      const chunks: Buffer[] = [];
      for await (const chunk of await portability.openExport(
        tenant.id,
        exported.id,
        id,
      ))
        chunks.push(chunk as Buffer);
      await writeFile(
        join(directory, id === "manifest" ? "manifest.entitle" : `${id}.blob`),
        Buffer.concat(chunks),
        { mode: 0o600 },
      );
    }
    return { ...exported, directory };
  }
  const options = (bundleDirectory: string) => ({
    db: destination.db,
    store: targetStore,
    secret: destinationSecret,
    directory: `${root}/import-work`,
    bundleDirectory,
    passphrase,
    expectedStripeAccountId: "acct_merchant",
    deploymentMode: "standalone" as const,
    verifyDestinationEmpty: async () => {},
  });
  return {
    root,
    db: source.db,
    destination: destination.db,
    tenant,
    product,
    plan,
    customer,
    license,
    installation,
    key,
    token,
    store,
    targetStore,
    release,
    bytes,
    checksum,
    portability,
    bundle,
    options,
  };
}

test("tenant export imports paid rights and encrypted token/key email into fresh standalone", async (t) => {
  const f = await fixture(t);
  const exported = await f.bundle();
  const result = await importPortability(f.options(exported.directory));
  assert.equal(result.tenant.id, "primary");
  assert.equal(result.tenant.slug, f.tenant.slug);
  assert.equal(result.requiresReconciliation, true);
  assert.equal((await f.destination("licenses").first()).key_hash, hash(f.key));
  const installation = await f.destination("installations").first();
  assert.equal(installation.token_hash, hash(f.token));
  assert.equal(unseal(installation.token_cipher, destinationSecret), f.token);
  const mail = await f.destination("emails").first();
  assert.equal(mail.state, "held");
  assert.equal(
    unseal<{ text: string }>(mail.payload, destinationSecret).text,
    f.key,
  );
  assert.equal(
    (
      await f
        .destination("billing_events")
        .where({ id: "evt_processed" })
        .first()
    ).payload,
    "",
  );
  assert.equal((await f.destination("work").first()).state, "held");
  assert.deepEqual(
    await f.targetStore.get("primary", f.release, f.checksum, f.bytes.length),
    f.bytes,
  );
  assert.equal((await f.destination("releases").first()).withdrawn, 1);
  assert.equal(
    (await f.destination("invoice_metrics").first()).paid_minor,
    1234,
  );
  assert.equal(
    (await f.destination("download_metrics").first()).served_bytes,
    32,
  );
  await assert.rejects(
    completePortabilityImport({
      db: f.destination,
      secret: destinationSecret,
      expectedStripeAccountId: "acct_merchant",
      reconcile: async () => {},
    }),
    { code: "reconciliation_required" },
  );
  await completePortabilityImport({
    db: f.destination,
    secret: destinationSecret,
    expectedStripeAccountId: "acct_merchant",
    reconcile: async ({ subscriptionIds, pendingEventIds }) => {
      assert.deepEqual(subscriptionIds, ["sub_paid"]);
      assert.deepEqual(pendingEventIds, ["evt_pending"]);
      await f
        .destination("billing_events")
        .where({ id: "evt_pending" })
        .update({ processed_at: Date.now(), payload: "" });
    },
  });
  const tenant = await f
    .destination("tenants")
    .where({ id: "primary" })
    .first();
  assert.equal(tenant.suspended, 0);
  const licensing = new Licenses(f.destination, destinationSecret, [], tenant);
  const retried = await licensing.activate(
    f.key,
    "installation-stable",
    "https://example.test",
    "portable-product",
  );
  assert.equal(retried.token, f.token);
  assert.equal((await f.destination("emails").first()).state, "pending");
  assert.equal((await f.destination("work").first()).state, "canceled");
  assert.deepEqual(await readdir(`${f.root}/import-work`), []);
});

test("complimentary licenses transfer without fabricating subscription reconciliation", async (t) => {
  const f = await fixture(t);
  const id = randomUUID(),
    request = randomUUID(),
    expires = Date.now() + 86400000;
  await f.db("licenses").insert({
    tenant_id: f.tenant.id,
    id,
    customer_id: f.customer,
    product_id: f.product,
    plan_id: null,
    subscription_id: null,
    site_allowance: 2,
    paid_through: 0,
    provenance: "complimentary",
    expires_at: expires,
    billing_status: "complimentary",
    key_hash: hash("complimentary-key"),
    issued_by: "owner",
    issued_at: Date.now(),
    complimentary_request_id: request,
    complimentary_request_hash: hash("request"),
    internal_note: "Private invitation",
  });
  const bundle = await f.bundle();
  const imported = await importPortability(f.options(bundle.directory));
  assert.deepEqual(imported.subscriptionIds, ["sub_paid"]);
  const license = await f.destination("licenses").where({ id }).first();
  assert.equal(license.provenance, "complimentary");
  assert.equal(license.plan_id, null);
  assert.equal(license.subscription_id, null);
  assert.equal(Number(license.expires_at), expires);
  assert.equal(license.complimentary_request_id, request);
  assert.equal(license.internal_note, "Private invitation");
  await completePortabilityImport({
    db: f.destination,
    secret: destinationSecret,
    expectedStripeAccountId: "acct_merchant",
    reconcile: async (required) => {
      assert.deepEqual(required.subscriptionIds, ["sub_paid"]);
      await f
        .destination("billing_events")
        .whereNull("processed_at")
        .update({ processed_at: Date.now() });
    },
  });
  const tenant = await f
    .destination("tenants")
    .where({ id: "primary" })
    .first();
  const licensing = new Licenses(f.destination, destinationSecret, [], tenant);
  const activation = await licensing.activate(
    "complimentary-key",
    "pilot-installation",
    "https://pilot.example.test",
    "portable-product",
  );
  assert.equal(activation.siteAllowance, 2);
  assert.equal((await licensing.status(activation.token)).entitled, true);
});

test("portability rejects complimentary rows with payment bindings, paid grants or incomplete entitlement before destination writes", async (t) => {
  const f = await fixture(t),
    bundle = await f.bundle();
  const file = join(bundle.directory, "manifest.entitle"),
    original = await readFile(file);
  const changes: Array<
    (
      row: Record<string, unknown>,
      tables: Record<string, Array<Record<string, unknown>>>,
    ) => void
  > = [
    (row) => {
      row.plan_id = f.plan;
    },
    (row) => {
      row.subscription_id = "sub_unwanted";
    },
    (row) => {
      row.paid_through = Date.now();
    },
    (row) => {
      row.expires_at = null;
    },
    (row) => {
      row.expires_at = 1;
    },
    (row) => {
      row.complimentary_request_id = null;
    },
    (row) => {
      row.issued_by = null;
    },
    (_row, tables) => {
      tables.grants!.push({
        ...tables.grants![0],
        id: "comp-paid-grant",
        license_id: f.license,
      });
    },
  ];
  for (const change of changes) {
    await writeFile(file, original);
    await rewriteManifest(bundle.directory, (manifest) => {
      const tables = manifest.tables as Record<
        string,
        Array<Record<string, unknown>>
      >;
      const row = tables.licenses![0]!;
      Object.assign(row, {
        provenance: "complimentary",
        plan_id: null,
        subscription_id: null,
        paid_through: 0,
        expires_at: Date.now() + 86400000,
        billing_status: "complimentary",
        issued_by: "owner",
        issued_at: Date.now(),
        complimentary_request_id: randomUUID(),
        complimentary_request_hash: hash("request"),
      });
      const paidGrant = tables.grants![0]!;
      tables.grants = [];
      if (change === changes.at(-1)) tables.grants.push(paidGrant);
      change(row, tables);
    });
    await assert.rejects(importPortability(f.options(bundle.directory)), {
      code: "invalid_bundle",
    });
    assert.equal((await f.destination("licenses")).length, 0);
  }
});

test("legacy paid manifests acquire explicit paid provenance on import", async (t) => {
  const f = await fixture(t),
    bundle = await f.bundle();
  await rewriteManifest(bundle.directory, (manifest) => {
    const tables = manifest.tables as Record<
      string,
      Array<Record<string, unknown>>
    >;
    for (const license of tables.licenses!)
      for (const field of [
        "provenance",
        "expires_at",
        "complimentary_request_id",
        "complimentary_request_hash",
        "issued_by",
        "issued_at",
        "internal_note",
      ])
        delete license[field];
  });
  await importPortability(f.options(bundle.directory));
  const license = await f.destination("licenses").first();
  assert.equal(license.provenance, "paid");
  assert.equal(license.expires_at, null);
});

test("bad passphrase, corrupt ciphertext, foreign tenant handle and merchant mismatch fail before import", async (t) => {
  const f = await fixture(t);
  const exported = await f.bundle();
  await assert.rejects(
    f.portability.openExport(randomUUID(), exported.id, "manifest"),
    { code: "export_not_found" },
  );
  await assert.rejects(
    f.portability.openExport(f.tenant.id, "../x", "manifest"),
    { code: "invalid_export" },
  );
  await assert.rejects(
    importPortability({
      ...f.options(exported.directory),
      passphrase: "wrong passphrase value",
    }),
    { code: "invalid_bundle" },
  );
  await assert.rejects(
    importPortability({
      ...f.options(exported.directory),
      expectedStripeAccountId: "acct_other",
    }),
    { code: "merchant_mismatch" },
  );
  const file = join(exported.directory, `${f.release}.blob`);
  const bytes = await readFile(file);
  bytes[40] = bytes[40]! ^ 1;
  await writeFile(file, bytes);
  await assert.rejects(importPortability(f.options(exported.directory)), {
    code: "invalid_bundle",
  });
  assert.equal((await f.destination("licenses")).length, 0);
});

test("export routes require scoped tenant authorization, fresh transfer verification and cookie CSRF", async (t) => {
  const f = await fixture(t);
  const [
    { default: fastify },
    { default: cookie },
    { default: rateLimit },
    { portabilityRoutes },
    { PlatformAuth },
    { loadConfig },
    { AppError },
  ] = await Promise.all([
    import("fastify"),
    import("@fastify/cookie"),
    import("@fastify/rate-limit"),
    import("../src/portability-api.ts"),
    import("../src/platform-auth.ts"),
    import("../src/config.ts"),
    import("../src/errors.ts"),
  ]);
  const config = loadConfig({
    APP_SECRET: sourceSecret,
    PUBLIC_ORIGIN: "https://entitle.example",
    OPERATOR_TOKEN: "operator-test-secret-not-for-browser",
    DEPLOYMENT_MODE: "hosted",
  });
  const auth = new PlatformAuth(f.db, config),
    user = randomUUID(),
    session = "seller-session-portability";
  await f.db("seller_users").insert({
    id: user,
    email: "owner@example.test",
    verified_at: 1,
    created_at: 1,
  });
  await f.db("seller_sessions").insert({
    id: hash(session),
    user_id: user,
    expires_at: Date.now() + 60000,
  });
  await f.db("seller_memberships").insert({
    tenant_id: f.tenant.id,
    user_id: user,
    role: "owner",
    created_at: 1,
  });
  const app = fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  app.setErrorHandler((error, _req, reply) => {
    const e = error as { status?: number; statusCode?: number; code?: string };
    reply
      .code(e.status ?? e.statusCode ?? 400)
      .send({ code: e.code ?? "invalid_input" });
  });
  let verification = 0;
  const prefix = `/api/v1/tenants/${f.tenant.slug}/seller`;
  await app.register(
    async (api) => {
      await portabilityRoutes(api, {
        context: () => ({ tenant: f.tenant, portability: f.portability }),
        auth,
        accounts: {
          requireStepUp: async (req, purpose) => {
            assert.equal(purpose, "tenant_transfer");
            if (req.headers["x-account-verification"] !== "fresh-transfer")
              throw new AppError(
                403,
                "verification_required",
                "Fresh verification required",
              );
            verification++;
          },
        },
      });
    },
    { prefix: "/api/v1/tenants/:tenant/seller" },
  );
  const { csrf } = await import("../src/crypto.ts");
  const headers = {
    cookie: `${auth.cookieName}=${session}`,
    origin: config.origin,
    "x-csrf-token": csrf(session, sourceSecret),
    "x-account-verification": "fresh-transfer",
  };
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${prefix}/exports`,
        payload: { passphrase },
      })
    ).statusCode,
    401,
  );
  const created = await app.inject({
    method: "POST",
    url: `${prefix}/exports`,
    headers,
    payload: { passphrase },
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(verification, 1);
  assert.equal(created.headers["cache-control"], "no-store");
  let exported = created.json();
  const failedStepUp = await app.inject({
    method: "POST",
    url: `${prefix}/exports`,
    remoteAddress: "127.0.0.2",
    headers: { ...headers, "x-account-verification": "expired" },
    payload: { passphrase },
  });
  assert.equal(failedStepUp.statusCode, 403);
  assert.equal(failedStepUp.json().code, "verification_required");
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${prefix}/exports`,
        headers,
        payload: { passphrase },
      })
    ).statusCode,
    429,
  );
  for (const [key, scopes] of [
    ["DE-TK-read-only-portability", ["read"]],
    ["DE-TK-export-portability", ["data:export"]],
  ] as const)
    await f.db("tenant_api_keys").insert({
      tenant_id: f.tenant.id,
      id: randomUUID(),
      name: "Transfer key",
      key_hash: hash(key),
      scopes: JSON.stringify(scopes),
      created_at: 1,
      expires_at: Date.now() + 60000,
    });
  const readonly = await app.inject({
    method: "POST",
    url: `${prefix}/exports`,
    remoteAddress: "127.0.0.3",
    headers: { authorization: "Bearer DE-TK-read-only-portability" },
    payload: { passphrase },
  });
  assert.equal(readonly.statusCode, 403);
  assert.equal(readonly.json().code, "scope_denied");
  await f.portability.deleteExport(f.tenant.id, exported.id);
  const apiExport = await app.inject({
    method: "POST",
    url: `${prefix}/exports`,
    remoteAddress: "127.0.0.4",
    headers: { authorization: "Bearer DE-TK-export-portability" },
    payload: { passphrase },
  });
  assert.equal(apiExport.statusCode, 200, apiExport.body);
  assert.equal(verification, 1);
  const openDownload = f.portability.openExport.bind(f.portability);
  let descriptorClosed = Promise.resolve();
  t.mock.method(
    f.portability,
    "openExport",
    async (...args: Parameters<typeof openDownload>) => {
      const stream = await openDownload(...args);
      descriptorClosed = new Promise<void>((resolve) =>
        stream.once("close", resolve),
      );
      return stream;
    },
  );
  const apiDownload = await app.inject({
    url: `${prefix}/exports/${apiExport.json().id}/manifest`,
    headers: { authorization: "Bearer DE-TK-export-portability" },
  });
  assert.equal(apiDownload.statusCode, 200);
  await descriptorClosed;
  for (const [listHeaders, expected] of [
    [{}, 401],
    [{ authorization: "Bearer DE-TK-read-only-portability" }, 403],
    [{ cookie: headers.cookie }, 403],
    [{ cookie: headers.cookie, "x-csrf-token": headers["x-csrf-token"] }, 200],
    [{ authorization: "Bearer DE-TK-export-portability" }, 200],
  ] as const) {
    const listed = await app.inject({
      url: `${prefix}/exports`,
      headers: listHeaders,
    });
    assert.equal(listed.statusCode, expected, listed.body);
    if (expected === 200) {
      assert.equal(listed.headers["cache-control"], "no-store");
      assert.deepEqual(listed.json(), {
        exports: [{ ...apiExport.json(), status: "ready" }],
      });
    }
  }
  assert.equal(
    verification,
    1,
    "recovery metadata needs scoped auth, not a fresh mutation challenge",
  );
  const deniedScopeDownload = await app.inject({
    url: `${prefix}/exports/${apiExport.json().id}/manifest`,
    headers: { authorization: "Bearer DE-TK-read-only-portability" },
  });
  assert.equal(deniedScopeDownload.statusCode, 403);
  assert.equal(deniedScopeDownload.json().code, "scope_denied");
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `${prefix}/exports/${apiExport.json().id}`,
        headers: { authorization: "Bearer DE-TK-export-portability" },
        payload: {},
      })
    ).statusCode,
    200,
  );
  exported = await f.portability.createExport(f.tenant.id, passphrase);
  assert.equal(
    (
      await app.inject({
        url: `${prefix}/exports/${exported.id}/manifest`,
        headers: { cookie: headers.cookie },
      })
    ).statusCode,
    403,
  );
  const browserDownloadHeaders = {
    cookie: headers.cookie,
    "x-csrf-token": headers["x-csrf-token"],
  };
  const invalidCsrf = await app.inject({
    url: `${prefix}/exports/${exported.id}/manifest`,
    headers: {
      ...browserDownloadHeaders,
      "x-csrf-token": "incorrect-csrf-value",
    },
  });
  assert.equal(invalidCsrf.statusCode, 403);
  assert.equal(invalidCsrf.json().code, "csrf_denied");
  const manifest = await app.inject({
    url: `${prefix}/exports/${exported.id}/manifest`,
    headers: browserDownloadHeaders,
  });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.rawPayload.subarray(0, 8).toString(), "DEPORT01");
  await descriptorClosed;
  assert.equal(
    (
      await app.inject({
        url: `${prefix}/exports/${exported.id}/blobs/${f.release}`,
        headers: browserDownloadHeaders,
      })
    ).statusCode,
    200,
  );
  await descriptorClosed;
  assert.equal(
    (
      await app.inject({
        method: "HEAD",
        url: `${prefix}/exports/${exported.id}/manifest`,
        headers,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `${prefix}/exports`,
        remoteAddress: "127.0.0.5",
        headers: {
          ...browserDownloadHeaders,
          "x-account-verification": "fresh-transfer",
        },
        payload: { passphrase },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `${prefix}/exports/${exported.id}`,
        headers: browserDownloadHeaders,
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "DELETE",
        url: `${prefix}/exports/${exported.id}`,
        headers,
        payload: {},
      })
    ).statusCode,
    200,
  );
});

async function rewriteManifest(
  directory: string,
  change: (manifest: Record<string, unknown>) => void,
) {
  const file = join(directory, "manifest.entitle"),
    bytes = await readFile(file),
    salt = bytes.subarray(8, 24);
  const key = scryptSync(passphrase, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 ** 2,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(24, 36));
  decipher.setAAD(Buffer.from("double-entitle:portability:1:manifest"));
  decipher.setAuthTag(bytes.subarray(-16));
  const value = JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(36, -16)),
      decipher.final(),
    ]).toString(),
  );
  change(value);
  const nonce = Buffer.alloc(12, 3),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("double-entitle:portability:1:manifest"));
  await writeFile(
    file,
    Buffer.concat([
      bytes.subarray(0, 24),
      nonce,
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]),
  );
  key.fill(0);
}

test("schema allowlist and relation preflight reject unlocked foreign records without writing destination", async (t) => {
  const f = await fixture(t);
  const bundle = await f.bundle(),
    file = join(bundle.directory, "manifest.entitle"),
    original = await readFile(file);
  const mutations: Array<(m: Record<string, unknown>) => void> = [
    (m) => {
      m.version = 2;
    },
    (m) => {
      m.extra = "unknown";
    },
    (m) => {
      (m.tables as Record<string, unknown>).seller_sessions = [];
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.products![0]!.extra = "unknown";
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.products![0]!.id = "../escape";
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.customers![0]!.tenant_id = randomUUID();
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.licenses![0]!.customer_id = randomUUID();
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.licenses![0]!.plan_id = randomUUID();
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.grants![0]!.license_id = randomUUID();
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.installations![0]!.token_cipher = JSON.stringify("wrong-token");
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.work![0]!.payload = JSON.stringify({ eventId: "evt_foreign" });
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.emails![0]!.customer_id = randomUUID();
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.billing_events![1]!.payload = JSON.stringify({
        id: "evt_foreign",
      });
    },
    (m) => {
      const tables = m.tables as Record<string, Array<Record<string, unknown>>>;
      tables.products!.push({ ...tables.products![0]! });
    },
    (m) => {
      (m.blobs as Array<Record<string, unknown>>)[0]!.checksum = "f".repeat(64);
    },
    (m) => {
      (m.blobs as Array<Record<string, unknown>>)[0]!.cipherSize = 1;
    },
    (m) => {
      m.blobs = [];
    },
  ];
  for (const mutation of mutations) {
    await writeFile(file, original);
    await rewriteManifest(bundle.directory, mutation);
    await assert.rejects(importPortability(f.options(bundle.directory)), {
      code: "invalid_bundle",
    });
    assert.equal((await f.destination("products")).length, 0);
  }
});

test("fresh destination and storage preflight preserve preexisting state", async (t) => {
  const f = await fixture(t);
  const bundle = await f.bundle();
  await f.destination("products").insert({
    tenant_id: "primary",
    id: randomUUID(),
    slug: "existing",
    name: "Existing",
  });
  await assert.rejects(importPortability(f.options(bundle.directory)), {
    code: "destination_busy",
  });
  assert.equal((await f.destination("products")).length, 1);
  await f.destination("products").delete();
  await assert.rejects(
    importPortability({
      ...f.options(bundle.directory),
      verifyDestinationEmpty: async () => {
        throw Error("bucket is not empty");
      },
    }),
    /bucket is not empty/,
  );
  await f.targetStore.put("primary", f.release, f.bytes, f.checksum);
  await assert.rejects(importPortability(f.options(bundle.directory)), {
    code: "artifact_exists",
  });
  assert.deepEqual(
    await f.targetStore.get("primary", f.release, f.checksum, f.bytes.length),
    f.bytes,
  );
  assert.equal((await f.destination("products")).length, 0);
});

test("failed storage readback rolls back database and only deletes successfully-created objects", async (t) => {
  const f = await fixture(t);
  const bundle = await f.bundle();
  let deletes = 0;
  const originalDelete = f.targetStore.delete.bind(f.targetStore);
  f.targetStore.delete = async (...args) => {
    deletes++;
    return originalDelete(...args);
  };
  f.targetStore.get = async () => {
    throw Error("failed readback");
  };
  await assert.rejects(
    importPortability(f.options(bundle.directory)),
    /failed readback/,
  );
  assert.equal(deletes, 1);
  assert.equal((await f.destination("licenses")).length, 0);
  f.targetStore.delete = async () => {
    throw Error("cleanup unavailable");
  };
  await assert.rejects(importPortability(f.options(bundle.directory)), {
    code: "import_cleanup_failed",
  });
  assert.deepEqual(await readdir(`${f.root}/import-work`), []);
});

test("exports stream multi-target assets including withdrawn releases through file-capable storage", async (t) => {
  const f = await fixture(t);
  await f
    .db("products")
    .where({ id: f.product })
    .update({ framework: "electron" });
  const targets = ["mac-arm64", "win-x64"];
  let reads = 0,
    writes = 0;
  f.store.getToFile = async (tenant, id, checksum, size, destination) => {
    reads++;
    await writeFile(
      destination,
      await f.store.get(tenant, id, checksum, size),
      { flag: "wx", mode: 0o600 },
    );
  };
  f.targetStore.putFile = async (tenant, id, file, checksum) => {
    writes++;
    await f.targetStore.put(tenant, id, await readFile(file), checksum);
  };
  f.targetStore.getToFile = async (tenant, id, checksum, size, destination) => {
    await writeFile(
      destination,
      await f.targetStore.get(tenant, id, checksum, size),
      { flag: "wx", mode: 0o600 },
    );
  };
  await f
    .db("releases")
    .where({ id: f.release })
    .update({ size: f.bytes.length * 2 });
  for (const target of targets) {
    const id = randomUUID();
    await f.db("release_assets").insert({
      tenant_id: f.tenant.id,
      id,
      release_id: f.release,
      target,
      filename: `${target}.zip`,
      size: f.bytes.length,
      checksum: f.checksum,
      sha512: createHash("sha512").update(f.bytes).digest("base64"),
      signature: null,
      min_system_version: null,
    });
    await f.store.put(f.tenant.id, id, f.bytes, f.checksum);
  }
  const bundle = await f.bundle();
  assert.equal(bundle.blobs.length, 2);
  await importPortability(f.options(bundle.directory));
  assert.equal(reads, 2);
  assert.equal(writes, 2);
  assert.equal((await f.destination("release_assets")).length, 2);
  assert.equal((await f.destination("releases").first()).withdrawn, 1);
});

test("expiry cleanup, explicit deletion, capacities and private directory rules are enforced", async (t) => {
  const f = await fixture(t);
  const options = {
    db: f.db,
    store: f.store,
    secret: sourceSecret,
    directory: `${f.root}/limited`,
    ttlMs: 20,
    maxExports: 2,
  };
  const portability = new Portability(options);
  t.after(() => portability.close());
  const created = await portability.createExport(f.tenant.id, passphrase);
  const stream = await portability.openExport(
    f.tenant.id,
    created.id,
    "manifest",
  );
  await assert.rejects(portability.deleteExport(f.tenant.id, created.id), {
    code: "export_busy",
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await portability.cleanupExpired();
  assert.equal((await readdir(options.directory)).length, 1);
  stream.destroy();
  await new Promise((resolve) => stream.once("close", resolve));
  await portability.cleanupExpired();
  assert.deepEqual(await readdir(options.directory), []);
  const next = await portability.createExport(f.tenant.id, passphrase);
  await assert.rejects(portability.createExport(f.tenant.id, passphrase), {
    code: "export_tenant_held",
  });
  await portability.deleteExport(f.tenant.id, next.id);
  await portability.close();
  await assert.rejects(portability.createExport(f.tenant.id, passphrase), {
    code: "export_capacity",
  });
  for (const overrides of [
    { maxBytes: 0 },
    { maxManifestBytes: 0 },
    { maxExports: 0 },
    { ttlMs: 0 },
    { directory: "relative" },
    { secret: "bad" },
  ])
    assert.throws(() => new Portability({ ...options, ...overrides }));
  const tiny = new Portability({
    ...options,
    ttlMs: 10000,
    maxBytes: 200,
    maxManifestBytes: 100,
  });
  t.after(() => tiny.close());
  await assert.rejects(tiny.createExport(f.tenant.id, passphrase), {
    code: "export_limit",
  });
  await assert.rejects(f.portability.createExport(f.tenant.id, "short"), {
    code: "invalid_passphrase",
  });
  await assert.rejects(f.portability.createExport("../escape", passphrase), {
    code: "invalid_export",
  });
  await f
    .db("tenants")
    .where({ id: f.tenant.id })
    .update({ stripe_account_id: null });
  await assert.rejects(f.portability.createExport(f.tenant.id, passphrase), {
    code: "merchant_required",
  });
});

test("inactive tokens, canceled/sent email records and reconcile jobs retain safe receipt state", async (t) => {
  const f = await fixture(t);
  await f
    .db("installations")
    .where({ id: f.installation })
    .update({ active: 0, token_cipher: "" });
  await f.db("work").insert({
    tenant_id: f.tenant.id,
    id: "reconcile-held",
    kind: "reconcile",
    payload: seal({ subscriptionId: "sub_paid" }, sourceSecret),
    state: "failed",
    created_at: 2,
  });
  await f.db("emails").insert({
    tenant_id: f.tenant.id,
    id: "sent-key",
    customer_id: f.customer,
    license_id: f.license,
    kind: "license_key",
    payload: "",
    state: "sent",
    created_at: 1,
  });
  const bundle = await f.bundle();
  await importPortability(f.options(bundle.directory));
  assert.equal((await f.destination("installations").first()).token_cipher, "");
  assert.equal(
    (await f.destination("work").where({ id: "reconcile-held" }).first()).state,
    "held",
  );
  assert.equal(
    (await f.destination("emails").where({ id: "sent-key" }).first()).payload,
    "",
  );
});

test("KDF resource failures and missing manifests remove private partial exports/imports", async (t) => {
  const f = await fixture(t);
  const { default: crypto } = await import("node:crypto"),
    { syncBuiltinESMExports } = await import("node:module");
  const original = crypto.scrypt;
  crypto.scrypt = ((...args: unknown[]) => {
    const callback = args.at(-1) as (e: Error, key: Buffer) => void;
    callback(Error("scrypt memory unavailable"), Buffer.alloc(0));
  }) as typeof crypto.scrypt;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      f.portability.createExport(f.tenant.id, passphrase),
      /scrypt memory unavailable/,
    );
  } finally {
    crypto.scrypt = original;
    syncBuiltinESMExports();
  }
  assert.deepEqual(await readdir(`${f.root}/exports`), []);
  await assert.rejects(importPortability(f.options(f.root)), {
    code: "invalid_bundle",
  });
  assert.deepEqual(await readdir(`${f.root}/import-work`), []);
});

test("standalone primary can export with explicitly verified direct merchant identity", async (t) => {
  const f = await fixture(t),
    bundle = await f.bundle();
  await importPortability(f.options(bundle.directory));
  const exporter = new Portability({
    db: f.destination,
    store: f.targetStore,
    secret: destinationSecret,
    directory: `${f.root}/standalone-exports`,
    sourceStripeAccountId: "acct_merchant",
  });
  t.after(() => exporter.close());
  const exported = await exporter.createExport("primary", passphrase);
  assert.equal(exported.blobs.length, 1);
});

test("private S3 destination preflight rejects public grants, policies and occupied buckets", async () => {
  const { verifyEmptyPrivatePortabilityBucket } =
    await import("../src/portability.ts");
  assert.equal(typeof verifyEmptyPrivatePortabilityBucket, "function");
  const { S3Client } = await import("@aws-sdk/client-s3");
  let mode = "empty";
  const client = {
    send: async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "ListObjectsV2Command")
        return {
          KeyCount: mode === "occupied" ? 1 : 0,
          Contents: mode === "inconsistent" ? [{ Key: "unexpected" }] : [],
        };
      if (command.constructor.name === "GetBucketAclCommand")
        return {
          Owner: { ID: "owner" },
          Grants: [
            {
              Grantee:
                mode === "public"
                  ? {
                      Type: "Group",
                      URI: "http://acs.amazonaws.com/groups/global/AllUsers",
                    }
                  : { Type: "CanonicalUser", ...(mode === "missing-owner" ? {} : { ID: "owner" }) },
              Permission: "FULL_CONTROL",
            },
          ],
        };
      if (mode === "policy") return { Policy: '{"Statement":[]}' };
      const error = Object.assign(Error("no policy"), {
        name: mode === "outage" ? "Unavailable" : "NoSuchBucketPolicy",
      });
      throw error;
    },
  } as unknown as InstanceType<typeof S3Client>;
  await verifyEmptyPrivatePortabilityBucket(client, "portable-fresh");
  for (mode of ["occupied", "public", "policy", "outage", "inconsistent", "missing-owner"])
    await assert.rejects(
      verifyEmptyPrivatePortabilityBucket(client, "portable-fresh"),
    );
});

test(
  "private S3 preserves verified artifact bytes across tenant-to-primary import",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => {
    const f = await fixture(t);
    const sdk = await import("@aws-sdk/client-s3"),
      { S3ArtifactStore } = await import("../src/storage.ts"),
      { verifyEmptyPrivatePortabilityBucket } =
        await import("../src/portability.ts");
    const endpoint = process.env.TEST_S3_ENDPOINT!;
    assert.equal(new URL(endpoint).hostname, "127.0.0.1");
    const options = {
      endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      allowInsecureLocalDevelopment: true,
      credentials: {
        accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY!,
      },
    };
    const client = new sdk.S3Client(options),
      sourceBucket = `portable-src-${randomUUID()}`,
      destinationBucket = `portable-dst-${randomUUID()}`;
    for (const bucket of [sourceBucket, destinationBucket]) {
      await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
      t.after(async () => {
        const listing = await client.send(
          new sdk.ListObjectsV2Command({ Bucket: bucket }),
        );
        if (listing.Contents?.length)
          await client.send(
            new sdk.DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: listing.Contents.map((row) => ({ Key: row.Key! })),
              },
            }),
          );
        await client.send(new sdk.DeleteBucketCommand({ Bucket: bucket }));
      });
    }
    const source = new S3ArtifactStore({ ...options, bucket: sourceBucket }),
      destination = new S3ArtifactStore({
        ...options,
        bucket: destinationBucket,
      });
    await source.put(f.tenant.id, f.release, f.bytes, f.checksum);
    const exporter = new Portability({
      db: f.db,
      store: source,
      secret: sourceSecret,
      directory: `${f.root}/s3-exports`,
    });
    t.after(() => exporter.close());
    const exported = await exporter.createExport(f.tenant.id, passphrase),
      directory = `${f.root}/s3-download`;
    await mkdir(directory, { mode: 0o700 });
    for (const id of ["manifest", ...exported.blobs]) {
      const chunks: Buffer[] = [];
      for await (const chunk of await exporter.openExport(
        f.tenant.id,
        exported.id,
        id,
      ))
        chunks.push(chunk as Buffer);
      await writeFile(
        join(directory, id === "manifest" ? "manifest.entitle" : `${id}.blob`),
        Buffer.concat(chunks),
        { mode: 0o600 },
      );
    }
    await importPortability({
      ...f.options(directory),
      store: destination,
      verifyDestinationEmpty: () =>
        verifyEmptyPrivatePortabilityBucket(client, destinationBucket),
    });
    assert.deepEqual(
      await destination.get("primary", f.release, f.checksum, f.bytes.length),
      f.bytes,
    );
    await assert.rejects(
      verifyEmptyPrivatePortabilityBucket(client, destinationBucket),
      { code: "destination_storage_busy" },
    );
    const raw = await fetch(
      `${endpoint}/${destinationBucket}/tenants/primary/releases/${f.release}.zip`,
    );
    assert.equal(raw.status, 403);
    t.after(() => client.destroy());
  },
);

test(
  "PostgreSQL and MySQL independently import preserved rights into isolated fresh databases",
  {
    skip:
      !process.env.TEST_POSTGRES_DATABASE_URL ||
      !process.env.TEST_MYSQL_DATABASE_URL,
  },
  async (t) => {
    const previous = process.env.TEST_SAAS_DATABASE_URL;
    try {
      for (const parent of [
        process.env.TEST_POSTGRES_DATABASE_URL!,
        process.env.TEST_MYSQL_DATABASE_URL!,
      ]) {
        process.env.TEST_SAAS_DATABASE_URL = parent;
        const f = await fixture(t),
          bundle = await f.bundle();
        await importPortability(f.options(bundle.directory));
        assert.equal(
          (await f.destination("licenses").first()).key_hash,
          hash(f.key),
        );
        assert.equal(
          unseal(
            (await f.destination("installations").first()).token_cipher,
            destinationSecret,
          ),
          f.token,
        );
        assert.equal((await f.destination("grants")).length, 1);
        assert.deepEqual(
          await f.targetStore.get(
            "primary",
            f.release,
            f.checksum,
            f.bytes.length,
          ),
          f.bytes,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.TEST_SAAS_DATABASE_URL;
      else process.env.TEST_SAAS_DATABASE_URL = previous;
    }
  },
);

test("finalization requires reconciliation of queued subscriptions without licenses", async (t) => {
  const f = await fixture(t);
  await f.db("work").insert({
    tenant_id: f.tenant.id,
    id: "reconcile-new",
    kind: "reconcile",
    payload: seal({ subscriptionId: "sub_not_yet_materialized" }, sourceSecret),
    created_at: 1,
  });
  const bundle = await f.bundle();
  const imported = await importPortability(f.options(bundle.directory));
  assert.deepEqual(imported.subscriptionIds, [
    "sub_not_yet_materialized",
    "sub_paid",
  ]);
  await completePortabilityImport({
    db: f.destination,
    secret: destinationSecret,
    expectedStripeAccountId: "acct_merchant",
    reconcile: async (required) => {
      assert.deepEqual(required.subscriptionIds, [
        "sub_not_yet_materialized",
        "sub_paid",
      ]);
      await f
        .destination("billing_events")
        .whereNull("processed_at")
        .update({ processed_at: Date.now() });
    },
  });
  assert.equal(
    (await f.destination("billing_events").where({ id: "evt_pending" }).first())
      .payload,
    "",
  );
});

test("export excludes another tenant and all authentication/platform secrets", async (t) => {
  const f = await fixture(t),
    other = await createTenant(f.db, {
      id: randomUUID(),
      slug: "other-publisher",
      name: "Other",
      stripe_account_id: "acct_other",
    });
  await f.db("products").insert({
    tenant_id: other.id,
    id: randomUUID(),
    slug: "secret-other-product",
    name: "Other tenant confidential",
  });
  await f.db("tenant_api_keys").insert({
    tenant_id: f.tenant.id,
    id: randomUUID(),
    name: "secret API key name",
    key_hash: hash("secret source API key"),
    scopes: '["data:export"]',
    created_at: 1,
    expires_at: Date.now() + 100000,
  });
  await f.db("tenants").where({ id: f.tenant.id }).update({
    platform_customer_id: "cus_platform_private",
    platform_subscription_id: "sub_platform_private",
    pro_paid_through: 12345,
  });
  const bundle = await f.bundle();
  let clear = "";
  await rewriteManifest(bundle.directory, (m) => {
    clear = JSON.stringify(m);
  });
  for (const denied of [
    "secret-other-product",
    "Other tenant confidential",
    "secret API key name",
    "cus_platform_private",
    "sub_platform_private",
    sourceSecret,
    "tenant_api_keys",
    "seller_sessions",
    "platform_subscription_id",
  ])
    assert.equal(clear.includes(denied), false, denied);
  await importPortability(f.options(bundle.directory));
  assert.equal((await f.destination("products")).length, 1);
  assert.equal((await f.destination("tenant_api_keys")).length, 0);
});

test("manifest cost is bounded before any artifact download and symlink bundles are rejected", async (t) => {
  const f = await fixture(t);
  let downloads = 0;
  const original = f.store.get.bind(f.store);
  f.store.get = async (...args) => {
    downloads++;
    return original(...args);
  };
  const small = new Portability({
    db: f.db,
    store: f.store,
    secret: sourceSecret,
    directory: `${f.root}/small-manifest`,
    maxManifestBytes: 1024,
  });
  t.after(() => small.close());
  await assert.rejects(small.createExport(f.tenant.id, passphrase), {
    code: "export_limit",
  });
  assert.equal(downloads, 0);
  const bundle = await f.bundle(),
    { symlink } = await import("node:fs/promises");
  const file = join(bundle.directory, "manifest.entitle"),
    saved = `${f.root}/saved-manifest`;
  await writeFile(saved, await readFile(file));
  await rm(file);
  await symlink(saved, file);
  await assert.rejects(importPortability(f.options(bundle.directory)), {
    code: "invalid_bundle",
  });
  assert.equal((await f.destination("licenses")).length, 0);
});

test("an imported empty workspace is not a fresh destination for a second import", async (t) => {
  const f = await fixture(t),
    empty = await createTenant(f.db, {
      id: randomUUID(),
      slug: "empty-publisher",
      name: "Empty",
      stripe_account_id: "acct_empty",
    });
  const exported = await f.portability.createExport(empty.id, passphrase),
    directory = `${f.root}/empty-bundle`;
  await mkdir(directory, { mode: 0o700 });
  const chunks: Buffer[] = [];
  for await (const chunk of await f.portability.openExport(
    empty.id,
    exported.id,
    "manifest",
  ))
    chunks.push(chunk as Buffer);
  await writeFile(join(directory, "manifest.entitle"), Buffer.concat(chunks), {
    mode: 0o600,
  });
  const options = {
    ...f.options(directory),
    expectedStripeAccountId: "acct_empty",
  };
  const imported = await importPortability(options);
  assert.deepEqual(imported.subscriptionIds, []);
  assert.deepEqual(exported.blobs, []);
  await assert.rejects(importPortability(options), {
    code: "destination_busy",
  });
});

test("one tenant cannot occupy both global export slots while another tenant exports", async (t) => {
  const f = await fixture(t);
  const other = await createTenant(f.db, {
    id: randomUUID(),
    slug: "other-exporter",
    name: "Other",
    stripe_account_id: "acct_other",
  });
  const first = await f.portability.createExport(f.tenant.id, passphrase);
  await assert.rejects(f.portability.createExport(f.tenant.id, passphrase), {
    code: "export_tenant_held",
  });
  const second = await f.portability.createExport(other.id, passphrase);
  assert.notEqual(first.id, second.id);
  await f.portability.deleteExport(f.tenant.id, first.id);
  assert.ok(await f.portability.createExport(f.tenant.id, passphrase));
});

test("aborted export creation cleans private files and releases its tenant and global reservation", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const original = f.store.get.bind(f.store);
  f.store.get = async (...args) => {
    const bytes = await original(...args);
    controller.abort();
    return bytes;
  };
  await assert.rejects(
    f.portability.createExport(f.tenant.id, passphrase, controller.signal),
    {
      code: "export_aborted",
    },
  );
  assert.deepEqual(await readdir(`${f.root}/exports`), []);
  f.store.get = original;
  assert.ok(await f.portability.createExport(f.tenant.id, passphrase));
});

test("export configuration preserves at least two global slots and a combined 10 GiB ceiling", async (t) => {
  const f = await fixture(t);
  for (const extra of [{ maxExports: 1 }, { maxBytes: 10 * 1024 ** 3 + 1 }])
    assert.throws(
      () =>
        new Portability({
          db: f.db,
          store: f.store,
          secret: sourceSecret,
          directory: `${f.root}/configuration`,
          ...extra,
        }),
      { code: "portability_configuration" },
    );
});

async function exportApi(
  t: TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const [{ default: fastify }, { portabilityRoutes }] = await Promise.all([
    import("fastify"),
    import("../src/portability-api.ts"),
  ]);
  const app = fastify({ connectionTimeout: 30 });
  t.after(() => app.close());
  app.setErrorHandler((error, _req, reply) => {
    const e = error as { code?: string; status?: number };
    reply.code(e.status ?? 500).send({ code: e.code });
  });
  await app.register(
    async (api) => {
      await portabilityRoutes(api, {
        context: () => ({ tenant: f.tenant, portability: f.portability }),
        auth: {
          tenant: async () => ({ tenant: f.tenant }),
          seller: async () => {
            throw Error("API key only");
          },
        } as unknown as import("../src/portability-api.ts").PortabilityApiOptions["auth"],
        accounts: { requireStepUp: async () => {} },
      });
    },
    { prefix: "/api/v1/tenants/:tenant/seller" },
  );
  const path = `/api/v1/tenants/${f.tenant.slug}/seller/exports`;
  return { app, path };
}

test("export creation survives a real socket idle timeout and restores ordinary route policy", async (t) => {
  const f = await fixture(t);
  const { app, path } = await exportApi(t, f);
  f.store.getToFile = async (_t, _i, _c, _s, file) => {
    await new Promise((resolve) => setTimeout(resolve, 90));
    await writeFile(file, f.bytes, { flag: "wx", mode: 0o600 });
  };
  app.get("/ordinary", async () => {
    await new Promise((resolve) => setTimeout(resolve, 90));
    return { ok: true };
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const { request, Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true });
  t.after(() => agent.destroy());
  const call = (url: string, body?: string) =>
    new Promise<string>((resolve, reject) => {
      const req = request(
        address + url,
        {
          agent,
          method: body ? "POST" : "GET",
          headers: {
            authorization: "Bearer scoped-export-key",
            ...(body
              ? {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => resolve(Buffer.concat(chunks).toString()));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  const exported = JSON.parse(await call(path, JSON.stringify({ passphrase })));
  assert.ok(exported.id);
  assert.ok(
    await f.portability
      .openExport(f.tenant.id, exported.id, "manifest")
      .then(async (stream) => {
        let bytes = 0;
        for await (const chunk of stream) bytes += chunk.length;
        assert.ok(bytes > 0);
        return true;
      }),
  );
  await assert.rejects(call("/ordinary"), { code: "ECONNRESET" });
});

test("disconnect during real export creation aborts storage and removes the undisclosed bundle", async (t) => {
  const f = await fixture(t);
  const { app, path } = await exportApi(t, f);
  const entered = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  app.addHook("onError", (_req, _reply, error, done) => {
    if ((error as { code?: string }).code === "export_aborted")
      failed.resolve();
    done();
  });
  f.store.getToFile = async (_t, _i, _c, _s, file, signal) => {
    await writeFile(file, f.bytes, { flag: "wx", mode: 0o600 });
    entered.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), {
        once: true,
      }),
    );
  };
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const { request } = await import("node:http");
  const body = JSON.stringify({ passphrase });
  const req = request(address + path, {
    method: "POST",
    headers: {
      authorization: "Bearer scoped-export-key",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  req.on("error", () => {});
  req.end(body);
  await entered.promise;
  req.destroy();
  await failed.promise;
  assert.deepEqual(await readdir(`${f.root}/exports`), []);
  delete f.store.getToFile;
  assert.ok(await f.portability.createExport(f.tenant.id, passphrase));
});

test("creation reserves tenant admission before storage, cannot expire mid-build, and close drains it", async (t) => {
  const f = await fixture(t);
  const entered = Promise.withResolvers<void>();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  f.store.getToFile = async (_t, _i, _c, _s, file, signal) => {
    await writeFile(file, f.bytes, { flag: "wx" });
    entered.resolve();
    await new Promise<void>((_resolve, reject) =>
      signal!.addEventListener("abort", () => reject(signal!.reason), {
        once: true,
      }),
    );
  };
  const creating = f.portability.createExport(f.tenant.id, passphrase);
  void creating.catch(() => {});
  await entered.promise;
  now += 3600001;
  await f.portability.cleanupExpired();
  assert.equal((await readdir(`${f.root}/exports`)).length, 1);
  assert.deepEqual(f.portability.listExports(f.tenant.id), [
    {
      id: (await readdir(`${f.root}/exports`))[0],
      status: "creating",
      expiresAt: null,
      blobs: [],
    },
  ]);
  await assert.rejects(
    f.portability.deleteExport(
      f.tenant.id,
      (await readdir(`${f.root}/exports`))[0]!,
    ),
    { code: "export_busy" },
  );
  await assert.rejects(f.portability.createExport(f.tenant.id, passphrase), {
    code: "export_tenant_held",
  });
  const other = await createTenant(f.db, {
    id: randomUUID(),
    slug: "concurrent-exporter",
    name: "Other",
    stripe_account_id: "acct_other",
  });
  assert.ok(await f.portability.createExport(other.id, passphrase));
  await f.portability.close();
  await assert.rejects(creating, { code: "export_aborted" });
  assert.deepEqual(await readdir(`${f.root}/exports`), []);
});

test("global disk admission counts combined reservations and releases them on deletion", async (t) => {
  const f = await fixture(t);
  const other = await createTenant(f.db, {
    id: randomUUID(),
    slug: "disk-exporter",
    name: "Other",
    stripe_account_id: "acct_other",
  });
  const portability = new Portability({
    db: f.db,
    store: f.store,
    secret: sourceSecret,
    directory: `${f.root}/global-budget`,
    maxBytes: 14000,
    maxManifestBytes: 10000,
  });
  t.after(() => portability.close());
  const first = await portability.createExport(f.tenant.id, passphrase);
  await assert.rejects(portability.createExport(other.id, passphrase), {
    code: "export_limit",
  });
  assert.equal((await readdir(`${f.root}/global-budget`)).length, 1);
  await portability.deleteExport(f.tenant.id, first.id);
  assert.ok(await portability.createExport(other.id, passphrase));
});

test("already aborted creation never allocates a directory or consumes admission", async (t) => {
  const f = await fixture(t);
  const signal = AbortSignal.abort();
  await assert.rejects(
    f.portability.createExport(f.tenant.id, passphrase, signal),
    { code: "export_aborted" },
  );
  await assert.rejects(readdir(`${f.root}/exports`), { code: "ENOENT" });
  assert.ok(await f.portability.createExport(f.tenant.id, passphrase));
});

test("export creation idle and size-scaled total deadlines terminate stalled or endlessly progressing storage", async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const progressing of [false, true]) {
    const portability = new Portability({
      db: f.db,
      store: f.store,
      secret: sourceSecret,
      directory: `${f.root}/deadline-${progressing}`,
      maxBytes: 20000,
      maxManifestBytes: 10000,
      timeoutMs: 10,
    });
    t.after(() => portability.close());
    f.store.getToFile = async (_t, _i, _c, _s, file, signal, progress) => {
      await writeFile(file, f.bytes, { flag: "wx" });
      if (progressing)
        for (let n = 0; n < 4; n++) {
          progress!(_s);
          t.mock.timers.tick(9);
        }
      else t.mock.timers.tick(11);
      signal!.throwIfAborted();
    };
    await assert.rejects(portability.createExport(f.tenant.id, passphrase), {
      code: "export_aborted",
    });
    assert.deepEqual(await readdir(`${f.root}/deadline-${progressing}`), []);
  }
});

test("failed aborted-export unlink remains recoverable by the next cleanup pass", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const { default: fs } = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.rm;
  const denied = t.mock.method(
    fs,
    "rm",
    async (...args: Parameters<typeof original>) => {
      if (String(args[0]).startsWith(`${f.root}/exports/`))
        throw Error("unlink denied");
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  f.store.getToFile = async (_t, _i, _c, _s, file) => {
    await writeFile(file, f.bytes, { flag: "wx" });
    controller.abort();
  };
  try {
    await assert.rejects(
      f.portability.createExport(f.tenant.id, passphrase, controller.signal),
      { code: "export_aborted" },
    );
    assert.equal((await readdir(`${f.root}/exports`)).length, 1);
  } finally {
    denied.mock.restore();
    syncBuiltinESMExports();
  }
  await f.portability.cleanupExpired();
  assert.deepEqual(await readdir(`${f.root}/exports`), []);
  delete f.store.getToFile;
  assert.ok(await f.portability.createExport(f.tenant.id, passphrase));
});

test("a request already aborted during authorization never leaves a private export", async (t) => {
  const f = await fixture(t);
  const { app, path } = await exportApi(t, f);
  app.addHook("preHandler", (req, _reply, done) => {
    req.raw.aborted = true;
    done();
  });
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { authorization: "Bearer scoped-export-key" },
    payload: { passphrase },
  });
  assert.equal(response.statusCode, 408, response.body);
  assert.equal(response.json().code, "export_aborted");
  await assert.rejects(readdir(`${f.root}/exports`), { code: "ENOENT" });
});

test("a completed export whose JSON response disconnects is deleted or recoverable after unlink failure", async (t) => {
  for (const denied of [false, true]) {
    const f = await fixture(t);
    const { app, path } = await exportApi(t, f);
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const deleted = Promise.withResolvers<void>();
    const originalDelete = f.portability.deleteExport.bind(f.portability);
    t.mock.method(
      f.portability,
      "deleteExport",
      async (...args: Parameters<typeof originalDelete>) => {
        try {
          await originalDelete(...args);
        } finally {
          deleted.resolve();
        }
      },
    );
    app.addHook("onSend", async (_req, _reply, payload) => {
      reached.resolve();
      await release.promise;
      return payload;
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const { request } = await import("node:http");
    const body = JSON.stringify({ passphrase });
    const req = request(address + path, {
      method: "POST",
      headers: {
        authorization: "Bearer scoped-export-key",
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    });
    req.on("error", () => {});
    req.end(body);
    await reached.promise;
    const { default: fs } = await import("node:fs/promises");
    const { syncBuiltinESMExports } = await import("node:module");
    const original = fs.rm;
    const mocked = t.mock.method(
      fs,
      "rm",
      async (...args: Parameters<typeof original>) => {
        if (denied && String(args[0]).startsWith(`${f.root}/exports/`))
          throw Error("unlink denied");
        return original(...args);
      },
    );
    syncBuiltinESMExports();
    try {
      req.destroy();
      await deleted.promise;
      assert.equal((await readdir(`${f.root}/exports`)).length, denied ? 1 : 0);
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
      release.resolve();
    }
    await f.portability.cleanupExpired();
    assert.deepEqual(await readdir(`${f.root}/exports`), []);
  }
});

test("cleanup failure remains charged, observable and tenant-isolated while unrelated exports continue", async (t) => {
  const f = await fixture(t);
  const other = await createTenant(f.db, {
    id: randomUUID(),
    slug: "cleanup-neighbor",
    name: "Neighbor",
    stripe_account_id: "acct_neighbor",
  });
  const failures: unknown[] = [];
  const portability = new Portability({
    db: f.db,
    store: f.store,
    secret: sourceSecret,
    directory: `${f.root}/cleanup-isolated`,
    maxBytes: 20000,
    maxManifestBytes: 10000,
    maxExports: 2,
    onFailure: (failure) => {
      failures.push(failure);
      throw Error("logging failed");
    },
  });
  t.after(() => portability.close());
  const first = await portability.createExport(f.tenant.id, passphrase);
  const { default: fs } = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.rm;
  const denied = t.mock.method(
    fs,
    "rm",
    async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === `${f.root}/cleanup-isolated/${first.id}`)
        throw Error("private path secret tenant ID");
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(portability.deleteExport(f.tenant.id, first.id), {
      code: "export_cleanup_failed",
    });
    await portability.cleanupExpired();
    assert.deepEqual(portability.listExports(f.tenant.id), [
      { id: first.id, status: "cleanup_pending", expiresAt: 0, blobs: [] },
    ]);
    await assert.rejects(portability.createExport(f.tenant.id, passphrase), {
      code: "export_tenant_held",
    });
    const next = await portability.createExport(other.id, passphrase);
    assert.ok(next.id);
    assert.deepEqual(portability.listExports(randomUUID()), []);
    assert.ok(failures.length > 0);
    for (const event of failures)
      assert.deepEqual(Object.keys(event as object).sort(), [
        "code",
        "operation",
      ]);
    assert.ok(!JSON.stringify(failures).includes("private"));
  } finally {
    denied.mock.restore();
    syncBuiltinESMExports();
  }
  await portability.deleteExport(f.tenant.id, first.id);
  assert.deepEqual(portability.listExports(f.tenant.id), []);
});

test("GET exports recovers only authenticated tenant handles with no-store and no internal metadata", async (t) => {
  const f = await fixture(t);
  const { app, path } = await exportApi(t, f);
  const exported = await f.portability.createExport(f.tenant.id, passphrase);
  const response = await app.inject({
    method: "GET",
    url: path,
    headers: { authorization: "Bearer scoped-export-key" },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), {
    exports: [{ ...exported, status: "ready" }],
  });
});

test("multi-artifact peak reservation admits sum ciphertext plus largest plaintext then shrinks to exact retained bytes", async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.alloc(10000, 7),
    checksum = createHash("sha256").update(bytes).digest("hex");
  await f
    .db("releases")
    .where({ tenant_id: f.tenant.id, id: f.release })
    .update({ size: bytes.length, checksum });
  await f.store.delete(f.tenant.id, f.release);
  await f.store.put(f.tenant.id, f.release, bytes, checksum);
  for (const version of ["2.0.0", "3.0.0"]) {
    const row = {
      ...(await f.db("releases").where({ id: f.release }).first()),
      id: randomUUID(),
      version,
    };
    await f.db("releases").insert(row);
    await f.store.put(f.tenant.id, row.id, bytes, checksum);
  }
  const portability = new Portability({
    db: f.db,
    store: f.store,
    secret: sourceSecret,
    directory: `${f.root}/peak`,
    maxBytes: 60156 + 52,
    maxManifestBytes: 20000,
  });
  t.after(() => portability.close());
  const exported = await portability.createExport(f.tenant.id, passphrase);
  assert.equal(exported.blobs.length, 3);
  const directory = `${f.root}/peak-download`;
  await mkdir(directory, { mode: 0o700 });
  for (const id of ["manifest", ...exported.blobs]) {
    const chunks: Buffer[] = [];
    for await (const chunk of await portability.openExport(
      f.tenant.id,
      exported.id,
      id,
    ))
      chunks.push(chunk as Buffer);
    await writeFile(
      join(directory, id === "manifest" ? "manifest.entitle" : `${id}.blob`),
      Buffer.concat(chunks),
      { mode: 0o600 },
    );
  }
  await importPortability({
    ...f.options(directory),
    maxBytes: 60208,
    maxManifestBytes: 20000,
  });
  const other = await createTenant(f.db, {
    id: randomUUID(),
    slug: "peak-neighbor",
    name: "Peak",
    stripe_account_id: "acct_peak",
  });
  assert.ok(await portability.createExport(other.id, passphrase));
});

async function closeFixtureCustomer(f: Awaited<ReturnType<typeof fixture>>) {
  const [{ CustomerAccounts }, { Auth }, { loadConfig }] = await Promise.all([
    import("../src/account-management.ts"),
    import("../src/auth.ts"),
    import("../src/config.ts"),
  ]);
  await f
    .db("licenses")
    .where({ tenant_id: f.tenant.id, id: f.license })
    .update({ revoked: 1, billing_status: "canceled" });
  await f
    .db("billing_events")
    .where({ tenant_id: f.tenant.id, id: "evt_pending" })
    .update({ processed_at: 5 });
  await f
    .db("work")
    .where({ tenant_id: f.tenant.id })
    .update({ state: "canceled" });
  await f
    .db("emails")
    .where({ tenant_id: f.tenant.id })
    .update({ state: "canceled" });
  const closureId = randomUUID();
  await f.db("account_closures").insert({
    tenant_id: f.tenant.id,
    customer_id: f.customer,
    id: closureId,
    status: "awaiting_operator",
    blockers: "[]",
    requested_at: 1,
  });
  const accounts = new CustomerAccounts(
    f.db,
    new Auth(
      f.db,
      loadConfig({ APP_SECRET: sourceSecret, OPERATOR_TOKEN: "x".repeat(32) }),
      f.tenant,
    ),
  );
  const approval = {
    quiesced: true,
    stripeReconciled: true,
    retentionReviewed: true,
  } as const;
  await accounts.reconcileClosure(f.customer, closureId, "operator", {
    ...approval,
    reference: "reviewed-transfer",
    stripeCustomerId: "cus_paid",
    eventIds: ["evt_pending"],
    workIds: ["evt_pending"],
    auditIds: [],
    outgoingEventIds: [],
  });
  assert.equal(
    (await accounts.approveClosure(f.customer, closureId, "operator", approval))
      .status,
    "completed",
  );
  return closureId;
}

async function transferStores(
  f: Awaited<ReturnType<typeof fixture>>,
  t: TestContext,
  privateS3: boolean,
) {
  let exporter = f.portability,
    targetStore = f.targetStore,
    verifyDestinationEmpty = async () => {};
  if (privateS3) {
    const sdk = await import("@aws-sdk/client-s3"),
      { S3ArtifactStore } = await import("../src/storage.ts"),
      { verifyEmptyPrivatePortabilityBucket } =
        await import("../src/portability.ts");
    const options = {
      endpoint: process.env.TEST_S3_ENDPOINT!,
      region: "us-east-1",
      forcePathStyle: true,
      allowInsecureLocalDevelopment: true,
      credentials: {
        accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY!,
      },
    };
    assert.equal(new URL(options.endpoint).hostname, "127.0.0.1");
    const client = new sdk.S3Client(options),
      buckets = [`closure-src-${randomUUID()}`, `closure-dst-${randomUUID()}`];
    t.after(() => client.destroy());
    for (const bucket of buckets) {
      await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
      t.after(async () => {
        const listing = await client.send(
          new sdk.ListObjectsV2Command({ Bucket: bucket }),
        );
        if (listing.Contents?.length)
          await client.send(
            new sdk.DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: listing.Contents.map((item) => ({ Key: item.Key! })),
              },
            }),
          );
        await client.send(new sdk.DeleteBucketCommand({ Bucket: bucket }));
      });
    }
    const sourceStore = new S3ArtifactStore({
      ...options,
      bucket: buckets[0]!,
    });
    targetStore = new S3ArtifactStore({ ...options, bucket: buckets[1]! });
    await sourceStore.put(f.tenant.id, f.release, f.bytes, f.checksum);
    exporter = new Portability({
      db: f.db,
      store: sourceStore,
      secret: sourceSecret,
      directory: `${f.root}/closure-s3-exports`,
    });
    t.after(() => exporter.close());
    verifyDestinationEmpty = () =>
      verifyEmptyPrivatePortabilityBucket(client, buckets[1]!);
  }
  return { exporter, targetStore, verifyDestinationEmpty };
}

async function completedClosureTransfer(t: TestContext, privateS3: boolean) {
  const f = await fixture(t);
  await closeFixtureCustomer(f);
  const { Billing } = await import("../src/billing.ts");
  const sourceClosures = await f
    .db("account_closures")
    .where({ tenant_id: f.tenant.id });
  const sourceReceipts = await f
    .db("account_privacy_receipts")
    .where({ tenant_id: f.tenant.id });
  const { exporter, targetStore, verifyDestinationEmpty } =
    await transferStores(f, t, privateS3);
  const exported = await exporter.createExport(f.tenant.id, passphrase),
    directory = `${f.root}/closed-download`;
  await mkdir(directory, { mode: 0o700 });
  for (const id of ["manifest", ...exported.blobs]) {
    const chunks: Buffer[] = [];
    for await (const chunk of await exporter.openExport(
      f.tenant.id,
      exported.id,
      id,
    ))
      chunks.push(chunk as Buffer);
    await writeFile(
      join(directory, id === "manifest" ? "manifest.entitle" : `${id}.blob`),
      Buffer.concat(chunks),
      { mode: 0o600 },
    );
  }
  const imported = await importPortability({
    ...f.options(directory),
    store: targetStore,
    verifyDestinationEmpty,
  });
  assert.deepEqual(
    imported.subscriptionIds,
    [],
    "completed closure must skip provider lookup even if Stripe customer was deleted",
  );
  assert.deepEqual(
    await f.destination("account_closures"),
    sourceClosures.map((row) => ({ ...row, tenant_id: "primary" })),
  );
  const destinationReceipts = await f.destination("account_privacy_receipts");
  assert.equal(destinationReceipts.length, sourceReceipts.length);
  assert.notEqual(destinationReceipts[0].details, sourceReceipts[0].details);
  const { completedCustomerClosure } =
    await import("../src/account-management.ts");
  assert.ok(
    await completedCustomerClosure(
      f.destination,
      "primary",
      destinationSecret,
      "cus_paid",
      false,
    ),
  );
  assert.equal(
    await completedCustomerClosure(
      f.destination,
      "primary",
      sourceSecret,
      "cus_paid",
      false,
    ),
    undefined,
  );
  assert.equal(
    await completedCustomerClosure(
      f.destination,
      "primary",
      destinationSecret,
      "cus_paid",
      true,
    ),
    undefined,
  );
  await completePortabilityImport({
    db: f.destination,
    secret: destinationSecret,
    expectedStripeAccountId: "acct_merchant",
    reconcile: async ({ subscriptionIds, pendingEventIds }) => {
      assert.deepEqual(subscriptionIds, []);
      assert.deepEqual(pendingEventIds, []);
    },
  });
  const tenant = (await f
    .destination("tenants")
    .where({ id: "primary" })
    .first())!;
  const licensing = new Licenses(f.destination, destinationSecret, [], tenant);
  const billing = new Billing(f.destination, licensing, {
    snapshot: async () => {
      throw Error("deleted provider customer must not be read");
    },
  });
  const customers = await f.destination("customers"),
    licenses = await f.destination("licenses"),
    grants = await f.destination("grants");
  for (const type of ["charge.refunded", "customer.updated"]) {
    const id = `evt_late_${type.replaceAll(".", "_")}`;
    await billing.receive({
      id,
      livemode: false,
      type,
      data: {
        object:
          type === "customer.updated"
            ? {
                id: "cus_paid",
                email: "resurrect@example.test",
                name: "Private Buyer",
              }
            : {
                id: "ch_late",
                customer: "cus_paid",
                amount_refunded: 1234,
                currency: "usd",
                billing_details: {
                  email: "resurrect@example.test",
                  name: "Private Buyer",
                },
              },
      },
    });
    const event = await f
      .destination("billing_events")
      .where({ tenant_id: "primary", id })
      .first();
    assert.equal(event.payload, "{}");
    assert.ok(event.processed_at !== null);
    assert.equal(
      (await f.destination("work").where({ tenant_id: "primary", id })).length,
      0,
    );
  }
  const allReceipts = await f.destination("account_privacy_receipts");
  assert.equal(allReceipts.length, sourceReceipts.length + 2);
  for (const pii of [
    "resurrect@example.test",
    "buyer@example.test",
    "Private Buyer",
    "cus_paid",
    sourceSecret,
  ])
    assert.ok(!JSON.stringify(allReceipts).includes(pii));
  assert.deepEqual(await f.destination("customers"), customers);
  assert.deepEqual(await f.destination("licenses"), licenses);
  assert.deepEqual(await f.destination("grants"), grants);
  assert.deepEqual(
    await targetStore.get("primary", f.release, f.checksum, f.bytes.length),
    f.bytes,
  );
  assert.equal(tenant.suspended, 0);
}

test("completed subscription-backed closure transfers and finalizes without resurrecting late provider PII or grants", async (t) =>
  completedClosureTransfer(t, false));
test(
  "private S3 completed closure export import finalize retains minimal destination late-event receipts",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => completedClosureTransfer(t, true),
);

test("closed Stripe-backed exports require upgraded attribution and retain every completed closure receipt", async (t) => {
  const f = await fixture(t);
  await closeFixtureCustomer(f);
  const original = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(original.details);
  delete details.stripeCustomerAttribution;
  await f
    .db("account_privacy_receipts")
    .where({ id: original.id })
    .update({ details: JSON.stringify(details) });
  await assert.rejects(f.portability.createExport(f.tenant.id, passphrase), {
    code: "privacy_attribution_upgrade_required",
  });
  assert.equal((await f.destination("customers")).length, 0);
  await f.db("account_privacy_receipts").delete();
  await assert.rejects(f.portability.createExport(f.tenant.id, passphrase), {
    code: "privacy_attribution_upgrade_required",
  });
  await f.db("account_privacy_receipts").insert(original);
  const next = { ...original, id: randomUUID() };
  await f.db("account_privacy_receipts").insert(next);
  const other = randomUUID();
  await f.db("customers").insert({
    tenant_id: f.tenant.id,
    id: other,
    email: "no-provider@invalid.invalid",
    stripe_id: null,
  });
  await f.db("account_closures").insert({
    tenant_id: f.tenant.id,
    customer_id: other,
    id: randomUUID(),
    status: "completed",
    blockers: "[]",
    requested_at: 1,
    completed_at: 2,
  });
  const noProvider = randomUUID();
  await f.db("customers").insert({
    tenant_id: f.tenant.id,
    id: noProvider,
    email: "manual@invalid.invalid",
    stripe_id: null,
  });
  await f.db("licenses").insert({
    ...(await f.db("licenses").where({ id: f.license }).first()),
    id: randomUUID(),
    customer_id: noProvider,
    subscription_id: "manual_closed",
    key_hash: hash("manual_key"),
  });
  await f.db("account_closures").insert({
    tenant_id: f.tenant.id,
    customer_id: noProvider,
    id: randomUUID(),
    status: "completed",
    blockers: "[]",
    requested_at: 1,
    completed_at: 2,
  });
  const manualClosure = await f
    .db("account_closures")
    .where({ customer_id: noProvider })
    .first();
  const { sealPrivacyAttribution } =
    await import("../src/privacy-attribution.ts");
  const manualReceipt = {
    tenant_id: f.tenant.id,
    customer_id: noProvider,
    request_id: manualClosure.id,
    id: randomUUID(),
    created_at: 2,
    details: JSON.stringify({
      referenceDigests: [],
      stripeLiveMode: false,
      events: [],
      stripeCustomerAttribution: sealPrivacyAttribution(
        {
          tenantId: f.tenant.id,
          customerId: noProvider,
          requestId: manualClosure.id,
          stripeLiveMode: false,
        },
        null,
        sourceSecret,
      ),
    }),
  };
  await f.db("account_privacy_receipts").insert(manualReceipt);
  const open = randomUUID(),
    request = randomUUID();
  await f.db("customers").insert({
    tenant_id: f.tenant.id,
    id: open,
    email: "pending@example.test",
    stripe_id: null,
  });
  await f.db("account_closures").insert({
    tenant_id: f.tenant.id,
    customer_id: open,
    id: request,
    status: "awaiting_operator",
    blockers: "[]",
    requested_at: 1,
  });
  const bundle = await f.bundle();
  await importPortability(f.options(bundle.directory));
  assert.equal((await f.destination("account_closures")).length, 4);
  assert.equal(
    (
      await f
        .destination("account_closures")
        .where({ customer_id: open })
        .first()
    ).status,
    "awaiting_operator",
  );
  assert.deepEqual(
    (await f.destination("account_privacy_receipts"))
      .map((row) => row.id)
      .sort(),
    [original.id, next.id, manualReceipt.id].sort(),
  );
});

test("portable closure relationships, financial allowlist and completed rights are validated before any destination writes", async (t) => {
  const f = await fixture(t);
  await closeFixtureCustomer(f);
  const bundle = await f.bundle(),
    original = await readFile(join(bundle.directory, "manifest.entitle"));
  const changes = [
    (v: any) => {
      v.tables.account_closures[0].status = "unknown";
    },
    (v: any) => {
      v.tables.account_closures[0].completed_at = null;
    },
    (v: any) => {
      v.tables.account_closures[0].blockers = '["active_subscription"]';
    },
    (v: any) => {
      v.tables.account_closures[0].blockers = "{}";
    },
    (v: any) => {
      v.tables.account_closures[0].blockers = "malformed";
    },
    (v: any) => {
      v.tables.account_privacy_receipts[0].request_id = "wrong";
    },
    (v: any) => {
      v.tables.account_privacy_receipts[0].customer_id = randomUUID();
    },
    (v: any) => {
      v.tables.account_privacy_receipts[0].tenant_id = randomUUID();
    },
    (v: any) => {
      const r = v.tables.account_privacy_receipts[0];
      const d = JSON.parse(r.details);
      d.email = "private@example.test";
      r.details = JSON.stringify(d);
    },
    (v: any) => {
      const r = v.tables.account_privacy_receipts[0];
      const d = JSON.parse(r.details);
      d.stripeLiveMode = "false";
      r.details = JSON.stringify(d);
    },
    (v: any) => {
      const r = v.tables.account_privacy_receipts[0];
      const d = JSON.parse(r.details);
      d.stripeCustomerId = null;
      r.details = JSON.stringify(d);
    },
    (v: any) => {
      v.tables.licenses[0].revoked = 0;
    },
    (v: any) => {
      v.tables.licenses[0].revoked = 0;
      v.tables.licenses[0].refund_revoked = 1;
      v.tables.licenses[0].billing_status = "active";
    },
    (v: any) => {
      v.tables.account_closures[0].customer_id = randomUUID();
    },
    (v: any) => {
      v.tables.account_closures[0].status = "blocked";
    },
  ];
  for (const change of changes) {
    await writeFile(join(bundle.directory, "manifest.entitle"), original);
    await rewriteManifest(bundle.directory, change);
    await assert.rejects(importPortability(f.options(bundle.directory)), {
      code: "invalid_bundle",
    });
    assert.equal((await f.destination("customers")).length, 0);
    assert.equal((await f.destination("account_closures")).length, 0);
  }
});

test("import reauthenticates operator bundle after storage preflight before destination writes", async (t) => {
  const f = await fixture(t),
    bundle = await f.bundle();
  const file = join(bundle.directory, `${f.release}.blob`);
  await assert.rejects(
    importPortability({
      ...f.options(bundle.directory),
      verifyDestinationEmpty: async () => {
        const bytes = await readFile(file);
        bytes[40] = bytes[40]! ^ 1;
        await writeFile(file, bytes);
      },
    }),
    { code: "invalid_bundle" },
  );
  assert.equal((await f.destination("customers")).length, 0);
  assert.equal((await f.destination("licenses")).length, 0);
  await assert.rejects(
    f.targetStore.get("primary", f.release, f.checksum, f.bytes.length),
    { code: "storage_unavailable" },
  );
});

test("opening download reserves its lease before file open so deletion cannot release pinned disk blocks", async (t) => {
  const f = await fixture(t),
    exported = await f.portability.createExport(f.tenant.id, passphrase);
  const { default: fs } = await import("node:fs/promises"),
    { syncBuiltinESMExports } = await import("node:module");
  const entered = Promise.withResolvers<void>(),
    proceed = Promise.withResolvers<void>();
  const original = fs.open;
  const mocked = t.mock.method(
    fs,
    "open",
    async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (
        String(args[0]) === `${f.root}/exports/${exported.id}/manifest.entitle`
      ) {
        entered.resolve();
        await proceed.promise;
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  const opening = f.portability.openExport(
    f.tenant.id,
    exported.id,
    "manifest",
  );
  await entered.promise;
  try {
    await assert.rejects(f.portability.deleteExport(f.tenant.id, exported.id), {
      code: "export_busy",
    });
  } finally {
    proceed.resolve();
    mocked.mock.restore();
    syncBuiltinESMExports();
    const stream = await opening;
    stream.destroy();
    await new Promise((resolve) => stream.once("close", resolve));
  }
  await f.portability.deleteExport(f.tenant.id, exported.id);
});

test("failed download file open rolls back its reserved lease and permits deletion", async (t) => {
  const f = await fixture(t),
    exported = await f.portability.createExport(f.tenant.id, passphrase);
  await rm(`${f.root}/exports/${exported.id}/manifest.entitle`);
  await assert.rejects(
    f.portability.openExport(f.tenant.id, exported.id, "manifest"),
    { code: "ENOENT" },
  );
  await f.portability.deleteExport(f.tenant.id, exported.id);
  assert.deepEqual(f.portability.listExports(f.tenant.id), []);
});

async function pendingClosureTransfer(t: TestContext, privateS3: boolean) {
  const f = await fixture(t);
  const closures = [
    {
      tenant_id: f.tenant.id,
      customer_id: f.customer,
      id: randomUUID(),
      status: "awaiting_operator",
      blockers: "[]",
      requested_at: 123,
      completed_at: null,
    },
  ];
  for (const withProvider of [true, false]) {
    const customer = randomUUID();
    await f.db("customers").insert({
      tenant_id: f.tenant.id,
      id: customer,
      email: `${customer}@example.test`,
      stripe_id: withProvider ? "cus_blocked" : null,
    });
    closures.push({
      tenant_id: f.tenant.id,
      customer_id: customer,
      id: randomUUID(),
      status: "blocked",
      blockers: JSON.stringify(["active_subscription", "paid_entitlement"]),
      requested_at: 456,
      completed_at: null,
    });
    if (withProvider)
      await f.db("licenses").insert({
        ...(await f.db("licenses").first()),
        id: randomUUID(),
        customer_id: customer,
        subscription_id: "sub_blocked",
        key_hash: hash("blocked-key"),
      });
  }
  await f.db("account_closures").insert(closures);
  const { exporter, targetStore, verifyDestinationEmpty } =
    await transferStores(f, t, privateS3);
  const exported = await exporter.createExport(f.tenant.id, passphrase),
    directory = `${f.root}/pending-download`;
  await mkdir(directory, { mode: 0o700 });
  for (const id of ["manifest", ...exported.blobs]) {
    const chunks: Buffer[] = [];
    for await (const chunk of await exporter.openExport(
      f.tenant.id,
      exported.id,
      id,
    ))
      chunks.push(chunk as Buffer);
    await writeFile(
      join(directory, id === "manifest" ? "manifest.entitle" : `${id}.blob`),
      Buffer.concat(chunks),
      { mode: 0o600 },
    );
  }
  const imported = await importPortability({
    ...f.options(directory),
    store: targetStore,
    verifyDestinationEmpty,
  });
  assert.deepEqual(imported.subscriptionIds, ["sub_blocked", "sub_paid"]);
  const expected = closures
    .map((row) => ({ ...row, tenant_id: "primary" }))
    .sort((a, b) => a.customer_id.localeCompare(b.customer_id));
  assert.deepEqual(
    (await f.destination("account_closures")).sort((a, b) =>
      a.customer_id.localeCompare(b.customer_id),
    ),
    expected,
  );
  const [
    { Billing },
    { Auth },
    { CustomerAccounts, registerCustomerAccountRoutes },
    { loadConfig },
    { default: Fastify },
    { default: cookie },
    { default: rateLimit },
  ] = await Promise.all([
    import("../src/billing.ts"),
    import("../src/auth.ts"),
    import("../src/account-management.ts"),
    import("../src/config.ts"),
    import("fastify"),
    import("@fastify/cookie"),
    import("@fastify/rate-limit"),
  ]);
  const tenant = await f
    .destination("tenants")
    .where({ id: "primary" })
    .first();
  const reads: string[] = [];
  const billing = new Billing(
    f.destination,
    new Licenses(f.destination, destinationSecret, [], tenant),
    {
      snapshot: async (subscriptionId) => {
        reads.push(subscriptionId);
        const customer = await f
          .destination("customers")
          .where({
            stripe_id:
              subscriptionId === "sub_paid" ? "cus_paid" : "cus_blocked",
          })
          .first();
        return {
          subscriptionId,
          customerId: customer.stripe_id,
          email: customer.email,
          billingStatus: "active",
          suspended: false,
          fullyRefunded: false,
          grants: [],
        };
      },
    },
  );
  await completePortabilityImport({
    db: f.destination,
    secret: destinationSecret,
    expectedStripeAccountId: "acct_merchant",
    reconcile: async (required) => {
      assert.deepEqual(required.subscriptionIds, ["sub_blocked", "sub_paid"]);
      for (const id of required.subscriptionIds) await billing.reconcile(id);
      await f
        .destination("billing_events")
        .where({ id: "evt_pending" })
        .update({ processed_at: 1 });
    },
  });
  assert.deepEqual(reads, ["sub_blocked", "sub_paid"]);
  assert.deepEqual(
    (await f.destination("account_closures")).sort((a, b) =>
      a.customer_id.localeCompare(b.customer_id),
    ),
    expected,
  );
  const auth = new Auth(
    f.destination,
    loadConfig({
      APP_SECRET: destinationSecret,
      OPERATOR_TOKEN: "x".repeat(32),
    }),
    tenant,
  );
  const accounts = new CustomerAccounts(f.destination, auth),
    app = Fastify();
  t.after(() => app.close());
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await registerCustomerAccountRoutes(app, { context: () => accounts });
  for (const closure of closures) {
    const token = `session-${closure.customer_id}`;
    await f.destination("sessions").insert({
      tenant_id: "primary",
      id: hash(token),
      customer_id: closure.customer_id,
      expires_at: Date.now() + 60000,
    });
    const response = await app.inject({
      method: "GET",
      url: "/account/closure",
      headers: { cookie: `${auth.cookieName}=${token}` },
    });
    assert.equal(response.statusCode, 200);
    const request = response.json().request;
    assert.equal(request.id, closure.id);
    assert.equal(request.status, closure.status);
    assert.deepEqual(request.blockers, JSON.parse(closure.blockers));
    assert.equal(request.requestedAt, closure.requested_at);
    assert.equal(request.completedAt, null);
  }
  assert.equal((await f.destination("account_privacy_receipts")).length, 0);
  assert.deepEqual(
    await targetStore.get("primary", f.release, f.checksum, f.bytes.length),
    f.bytes,
  );
}

test("pending awaiting_operator and blocked closures survive transfer finalize and customer GET", async (t) =>
  pendingClosureTransfer(t, false));
test(
  "private S3 pending closures survive transfer finalize and customer GET",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => pendingClosureTransfer(t, true),
);

test("partly reconciled pending closures refuse export before artifact I/O and destination writes", async (t) => {
  const f = await fixture(t);
  await closeFixtureCustomer(f);
  const original = await f.db("account_privacy_receipts").first();
  for (const status of ["awaiting_operator", "blocked"]) {
    await f.db("account_closures").update({ status, completed_at: null });
    let io = 0;
    const get = t.mock.method(f.store, "get", async () => {
      io++;
      throw Error("artifact read before privacy preflight");
    });
    await assert.rejects(f.portability.createExport(f.tenant.id, passphrase), {
      status: 409,
      code: "closure_reconciliation_pending",
      message: /operator.*privacy review/i,
    });
    assert.equal(io, 0);
    assert.equal((await f.destination("customers")).length, 0);
    assert.equal((await f.destination("account_closures")).length, 0);
    assert.deepEqual(await f.db("account_privacy_receipts").first(), original);
    assert.deepEqual(f.portability.listExports(f.tenant.id), []);
    get.mock.restore();
  }
});

test("pending requests reject foreign or open-closure receipts without silently dropping source evidence", async (t) => {
  const f = await fixture(t);
  await closeFixtureCustomer(f);
  const receipt = await f.db("account_privacy_receipts").first();
  await f
    .db("account_privacy_receipts")
    .update({ request_id: "foreign_request" });
  await assert.rejects(f.portability.createExport(f.tenant.id, passphrase), {
    code: "privacy_attribution_mismatch",
  });
  await f
    .db("account_privacy_receipts")
    .update({ request_id: receipt.request_id });
  const bundle = await f.bundle();
  await rewriteManifest(bundle.directory, (v: any) => {
    v.tables.account_closures[0].status = "blocked";
    v.tables.account_closures[0].completed_at = null;
  });
  await assert.rejects(importPortability(f.options(bundle.directory)), {
    code: "invalid_bundle",
  });
  assert.equal((await f.destination("account_closures")).length, 0);
});
