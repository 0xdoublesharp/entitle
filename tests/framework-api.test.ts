import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createTenant, migrate } from "../src/db.ts";
import { hash, unseal } from "../src/crypto.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { zipBytes } from "./helpers/zip.ts";
import type { Config } from "../src/config.ts";
import { isolatedDatabase } from "./helpers/database.ts";

process.env.NODE_ENV = "test";
const prefix = "/api/v1/tenants/primary";
const configurations = {
  wordpress: {},
  joomla: {
    extensionType: "plugin",
    element: "example",
    folder: "system",
    joomlaMajor: 6,
  },
  electron: {},
  tauri: {},
  sparkle: {},
  jetbrains: {
    pluginId: "com.example.plugin",
    sinceBuild: "243",
    untilBuild: "253.*",
  },
  generic: { activationKind: "device" },
};
async function fixture(
  t: TestContext,
  overrides: Partial<Config> = {},
  providedStore?: import("../src/storage.ts").ArtifactStore,
) {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/framework-api-",
  );
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "ef".repeat(32),
    OPERATOR_TOKEN: "framework-operator-fixture-1234567890",
    DATA_DIR: root,
    LOCAL_BILLING: "true",
  });
  Object.assign(config, overrides);
  const database = await isolatedDatabase(config.databaseUrl);
  const db = database.db;
  await migrate(db);
  const key = `DE-TK-${"F".repeat(43)}`;
  await db("tenant_api_keys").insert({
    id: randomUUID(),
    tenant_id: "primary",
    name: "Framework fixture",
    key_hash: hash(key),
    scopes: JSON.stringify([
      "read",
      "catalog:write",
      "releases:write",
      "licenses:write",
    ]),
    display_prefix: key.slice(0, 14),
    created_at: Date.now(),
    expires_at: Date.now() + 86400000,
    revoked_at: null,
    last_used_at: null,
  });
  const store = providedStore ?? new InMemoryArtifactStore();
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {
    await app?.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  });
  app = await buildApp(config, db, { send: async () => {} }, { store });
  const readyApp = app;
  const headers = { authorization: `Bearer ${key}` };
  const post = (
    path: string,
    payload: object,
    requestHeaders: Record<string, string> = headers,
  ) =>
    readyApp.inject({
      method: "POST",
      url: `${prefix}${path}`,
      payload,
      headers: requestHeaders,
    });
  const product = (
    framework: keyof typeof configurations,
    slug = `${framework}-product`,
  ) =>
    post("/seller/products", {
      slug,
      name: `${framework} product`,
      framework,
      frameworkConfig: configurations[framework],
      plans: [{ name: "Annual", siteAllowance: 2, priceId: `price_${slug}` }],
    });
  const purchase = async (
    framework: keyof typeof configurations,
    slug = `${framework}-product`,
  ) => {
    const configured = await product(framework, slug);
    assert.equal(configured.statusCode, 200, configured.body);
    const planId = configured.json().plans[0].id;
    const paid = await post("/seller/local/purchase", {
      planId,
      email: `${slug}@example.test`,
    });
    assert.equal(paid.statusCode, 200, paid.body);
    const license = await db("licenses")
      .where({ tenant_id: "primary", product_id: configured.json().product.id })
      .first();
    const email = await db("emails")
      .where({
        tenant_id: "primary",
        license_id: license.id,
        kind: "license_key",
      })
      .first();
    const message = unseal<{ text: string }>(email.payload, config.secret);
    const key = /Your license key is (DE-[A-Za-z0-9_-]+)/.exec(
      message.text,
    )![1]!;
    return { product: configured.json().product, license, key };
  };
  return { app, db, root, config, store, headers, post, product, purchase };
}

test("seller product setup differentiates framework configuration and catalog exposes public product types", async (t) => {
  const f = await fixture(t);
  for (const framework of Object.keys(
    configurations,
  ) as (keyof typeof configurations)[]) {
    const response = await f.product(framework);
    assert.equal(response.statusCode, 200, `${framework}: ${response.body}`);
    assert.equal(response.json().product.framework, framework);
    assert.deepEqual(
      response.json().product.frameworkConfig,
      configurations[framework],
    );
  }
  const catalog = await f.app.inject(`${prefix}/catalog`);
  assert.equal(catalog.statusCode, 200);
  assert.deepEqual(
    catalog
      .json()
      .products.map((p: { framework: string }) => p.framework)
      .sort(),
    Object.keys(configurations).sort(),
  );
  for (const p of catalog.json().products) assert.ok(p.frameworkConfig);
  const overview = await f.app.inject({
    url: `${prefix}/seller/overview`,
    headers: f.headers,
  });
  assert.equal(overview.statusCode, 200);
  for (const p of overview.json().products) assert.ok(p.frameworkConfig);
});

test("device activations use stable identifiers and enforce paid seat limits without invented site URLs", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("electron");
  const activate = (installationId: string, extra: object = {}) =>
    f.post(
      "/activate",
      { key: paid.key, product: paid.product.slug, installationId, ...extra },
      {},
    );
  const first = await activate("device-installation-one", {
    installationLabel: "Work laptop",
  });
  assert.equal(first.statusCode, 200, first.body);
  const again = await activate("device-installation-one");
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().token, first.json().token);
  const stored = await f
    .db("installations")
    .where({ installation_id: "device-installation-one" })
    .first();
  assert.equal(stored.site_url, "device:device-installation-one");
  assert.equal(stored.label, "Work laptop");
  assert.equal(stored.exempt, 0);
  const remaining = await Promise.all([
    activate("device-installation-two"),
    activate("device-installation-three"),
  ]);
  assert.deepEqual(remaining.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    (
      await activate("device-installation-four", {
        siteUrl: "https://staging.example.test",
      })
    ).statusCode,
    400,
  );
  const deactivated = await f.post(
    "/deactivate",
    {},
    { authorization: `Bearer ${first.json().token}` },
  );
  assert.equal(deactivated.statusCode, 200);
  assert.equal((await activate("device-installation-four")).statusCode, 200);
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/activation`,
        headers: { authorization: `Bearer ${first.json().token}` },
      })
    ).statusCode,
    401,
  );
});

test("invalid and unrelated framework configuration cannot silently retarget a product", async (t) => {
  const f = await fixture(t);
  const body = {
    slug: "guarded",
    name: "Guarded",
    framework: "electron",
    plans: [{ name: "Annual", siteAllowance: 1, priceId: "price_guarded" }],
  };
  for (const fields of [
    { framework: "unknown" },
    { frameworkConfig: { privateKey: "do-not-store" } },
    { pluginBasename: "guarded/guarded.php" },
    { framework: "joomla", frameworkConfig: {} },
    { framework: "jetbrains", frameworkConfig: { pluginId: "x" } },
  ]) {
    const response = await f.post("/seller/products", { ...body, ...fields });
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((await f.post("/seller/products", body)).statusCode, 200);
  const configured = await f
    .db("products")
    .where({ tenant_id: "primary", slug: "guarded" })
    .first();
  await f.db("releases").insert({
    tenant_id: "primary",
    id: randomUUID(),
    product_id: configured.id,
    version: "1.0.0",
    changelog: "Already published",
    published_at: Date.now(),
    withdrawn: 0,
    size: 1,
    checksum: "a".repeat(64),
    min_wp: "0.0.0",
    min_php: "0.0.0",
    min_free: "0.0.0",
    tested: "0.0.0",
  });
  const changed = await f.post("/seller/products", {
    ...body,
    framework: "tauri",
  });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal(changed.json().error.code, "framework_immutable");
  const retained = await f.post("/seller/products", {
    slug: body.slug,
    name: "Renamed",
    plans: body.plans,
  });
  assert.equal(retained.statusCode, 200, retained.body);
  assert.equal(retained.json().product.framework, "electron");
});

test("immutable asset upload, generic feed and authenticated single ranges preserve ownership", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("generic");
  const bytes = Buffer.from("verified immutable asset bytes");
  const metadata = {
    target: "portable",
    filename: "bundle.bin",
    changelog: "First native release",
  };
  const upload = (
    overrides: object = {},
    requestHeaders: Record<string, string> = f.headers,
    payload = bytes,
  ) =>
    f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/1.2.0`,
      headers: {
        ...requestHeaders,
        "content-type": "application/octet-stream",
        "x-release-metadata": Buffer.from(
          JSON.stringify({ ...metadata, ...overrides }),
        ).toString("base64url"),
      },
      payload,
    });
  assert.equal((await upload({}, {})).statusCode, 401);
  const published = await upload();
  assert.equal(published.statusCode, 200, published.body);
  const { release, asset } = published.json();
  assert.equal((await upload()).statusCode, 409);
  assert.equal(
    (await upload({ target: "other", changelog: "Changed" })).statusCode,
    409,
  );
  assert.equal(
    (await upload({ target: "other", filename: "../escape" })).statusCode,
    400,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `${prefix}/seller/assets/generic-product/1.3.0`,
        headers: {
          ...f.headers,
          "content-type": "application/octet-stream",
          "x-release-metadata": "not JSON",
        },
        payload: bytes,
      })
    ).statusCode,
    400,
  );
  const activated = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "native-device-123",
    },
    {},
  );
  assert.equal(activated.statusCode, 200, activated.body);
  const headers = { authorization: `Bearer ${activated.json().token}` };
  const feed = await f.app.inject({
    url: `${prefix}/updates/generic/generic-product/portable`,
    headers,
  });
  assert.equal(feed.statusCode, 200, feed.body);
  assert.equal(feed.json().version, "1.2.0");
  assert.equal(feed.headers["cache-control"], "no-store");
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/updates/generic/generic-product/portable?currentVersion=1.2.0`,
        headers,
      })
    ).statusCode,
    204,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/updates/generic/generic-product/missing`,
        headers,
      })
    ).statusCode,
    204,
  );
  const url = new URL(feed.json().assets[0].url).pathname;
  assert.equal(
    url,
    `${prefix}/packages/generic-product/assets/${asset.id}/bundle.bin`,
  );
  assert.equal((await f.app.inject(url)).statusCode, 401);
  const full = await f.app.inject({ url, headers });
  assert.equal(full.statusCode, 200, full.body);
  assert.deepEqual(full.rawPayload, bytes);
  for (const [range, expected] of [
    ["bytes=0-7", bytes.subarray(0, 8)],
    ["bytes=9-", bytes.subarray(9)],
    ["bytes=-5", bytes.subarray(-5)],
  ] as const) {
    const part = await f.app.inject({ url, headers: { ...headers, range } });
    assert.equal(part.statusCode, 206, part.body);
    assert.deepEqual(part.rawPayload, expected);
    assert.equal(part.headers["accept-ranges"], "bytes");
  }
  for (const range of [
    "bytes=999-",
    "bytes=4-2",
    "bytes=0-1,4-5",
    "items=1-2",
    "bytes=-0",
  ]) {
    const part = await f.app.inject({ url, headers: { ...headers, range } });
    assert.equal(part.statusCode, 416, part.body);
    assert.equal(part.headers["content-range"], `bytes */${bytes.length}`);
  }
  const head = await f.app.inject({ method: "HEAD", url, headers });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(head.headers["content-length"], String(bytes.length));
  assert.equal(
    (
      await f.app.inject({
        url: url.replace("bundle.bin", "other.bin"),
        headers,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        url: url.replace("generic-product", "wrong-product"),
        headers,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ url: `${prefix}/packages/${release.id}`, headers }))
      .statusCode,
    409,
  );
  const revoked = await f.post(`/seller/licenses/${paid.license.id}/revoke`, {
    revoked: true,
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal((await f.app.inject({ url, headers })).statusCode, 403);
});

test("each native feed selects the matching entitled product and target", async (t) => {
  const f = await fixture(t);
  const cases = [
    ["joomla", "any", "/updates/joomla/joomla-product.xml"],
    [
      "electron",
      "darwin-arm64",
      "/updates/electron/electron-product/darwin-arm64/latest-mac.yml",
    ],
    [
      "tauri",
      "darwin-aarch64",
      "/updates/tauri/tauri-product/darwin-aarch64/1.0.0",
    ],
    [
      "sparkle",
      "darwin-arm64",
      "/updates/sparkle/sparkle-product/darwin-arm64/appcast.xml",
    ],
    [
      "jetbrains",
      "any",
      "/updates/jetbrains/jetbrains-product/updatePlugins.xml?build=IU-253.1&os=linux&arch=x86_64",
    ],
  ] as const;
  for (const [framework, target, path] of cases) {
    const paid = await f.purchase(framework);
    const releaseId = randomUUID(),
      id = randomUUID(),
      bytes = Buffer.from("test native package");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await f.store.put("primary", id, bytes, checksum);
    await f.db("releases").insert({
      tenant_id: "primary",
      id: releaseId,
      product_id: paid.product.id,
      version: "1.2.0",
      changelog: "Native release",
      published_at: Date.now(),
      withdrawn: 0,
      size: bytes.length,
      checksum,
      min_wp: "",
      min_php: "",
      min_free: "",
      tested: "",
    });
    await f.db("release_assets").insert({
      tenant_id: "primary",
      id,
      release_id: releaseId,
      target,
      filename: "native.zip",
      size: bytes.length,
      checksum,
      sha512: createHash("sha512").update(bytes).digest("base64"),
      signature: "signed",
      min_system_version: null,
    });
    const activated = await f.post(
      "/activate",
      {
        key: paid.key,
        product: paid.product.slug,
        installationId: `${framework}-installation`,
        ...(framework === "joomla"
          ? { siteUrl: "https://joomla.example.test" }
          : {}),
      },
      {},
    );
    assert.equal(activated.statusCode, 200, activated.body);
    const headers = { authorization: `Bearer ${activated.json().token}` };
    assert.equal((await f.app.inject(`${prefix}${path}`)).statusCode, 401);
    const response = await f.app.inject({ url: `${prefix}${path}`, headers });
    assert.equal(response.statusCode, 200, `${framework}: ${response.body}`);
    assert.ok(response.body.includes("1.2.0"));
    assert.ok(response.body.includes(framework === "joomla" ? releaseId : id));
    assert.equal(
      (
        await f.app.inject({
          url: `${prefix}/updates/generic/${framework}-product/any`,
          headers,
        })
      ).statusCode,
      409,
    );
    if (framework === "joomla") {
      const detailsUrl = `${prefix}/updates/joomla/joomla-product/releases/${releaseId}.xml`;
      assert.ok(
        response.body.includes(`detailsurl="${f.config.origin}${detailsUrl}"`),
      );
      assert.ok(response.body.includes("<extensionset>"));
      const details = await f.app.inject(detailsUrl);
      assert.equal(details.statusCode, 200, details.body);
      assert.ok(details.body.includes(id));
      assert.ok(!details.body.includes(activated.json().token));
      assert.equal(details.headers["cache-control"], "no-store");
      for (const url of [
        detailsUrl.replace(releaseId, randomUUID()),
        detailsUrl.replace("joomla-product", "missing-product"),
        detailsUrl.replace("primary", "other"),
      ])
        assert.equal((await f.app.inject(url)).statusCode, 404);
      assert.equal(
        (await f.app.inject(detailsUrl + "?token=forbidden")).statusCode,
        400,
      );
      await f.db("releases").where({ id: releaseId }).update({ withdrawn: 1 });
      assert.equal((await f.app.inject(detailsUrl)).statusCode, 404);
      await f.db("releases").where({ id: releaseId }).update({ withdrawn: 0 });
      await f.db("release_assets").where({ release_id: releaseId }).delete();
      assert.equal((await f.app.inject(detailsUrl)).statusCode, 404);
    }
    if (framework === "electron") {
      for (const filename of ["latest.yml", "latest-linux.yml", "other.yml"]) {
        const altered = path.replace("latest-mac.yml", filename);
        const expected = filename === "latest.yml" ? 200 : 400;
        assert.equal(
          (await f.app.inject({ url: `${prefix}${altered}`, headers }))
            .statusCode,
          expected,
        );
      }
      assert.equal(
        (
          await f.app.inject({
            url: `${prefix}/updates/electron/electron-product/linux-x64/latest-linux.yml`,
            headers,
          })
        ).statusCode,
        204,
      );
      await f.db("release_assets").insert({
        tenant_id: "primary",
        id: randomUUID(),
        release_id: releaseId,
        target: "linux-arm64",
        filename: "arm64.AppImage",
        size: bytes.length,
        checksum,
        sha512: createHash("sha512").update(bytes).digest("base64"),
      });
      for (const [target, filename, status] of [
        ["linux-arm64", "latest-linux-arm64.yml", 200],
        ["linux-x64", "latest-linux-arm64.yml", 400],
        ["linux-arm64", "latest-linux.yml", 400],
      ] as const)
        assert.equal(
          (
            await f.app.inject({
              url: `${prefix}/updates/electron/electron-product/${target}/${filename}`,
              headers,
            })
          ).statusCode,
          status,
        );
      assert.equal(
        (
          await f.app.inject({
            url: `${prefix}/updates/electron/electron-product/unsupported/latest.yml`,
            headers,
          })
        ).statusCode,
        400,
      );
    }
    if (framework === "tauri")
      assert.equal(
        (
          await f.app.inject({
            url: `${prefix}${path.replace("1.0.0", "1.2.0")}`,
            headers,
          })
        ).statusCode,
        204,
      );
  }
});

test("buyer asset downloads enforce customer, tenant, entitlement and withdrawal after feed caching", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("generic");
  const bytes = Buffer.from("owned downloadable artifact");
  const uploaded = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/2.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "owned.bin",
          changelog: "Owned release",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const { asset, release } = uploaded.json();
  const session = "buyer-" + randomUUID();
  await f.db("sessions").insert({
    tenant_id: "primary",
    id: hash(session),
    customer_id: paid.license.customer_id,
    expires_at: Date.now() + 86400000,
  });
  const headers = { cookie: `de-session-primary=${session}` };
  const url = `${prefix}/licenses/${paid.license.id}/assets/${asset.id}/download`;
  assert.equal((await f.app.inject(url)).statusCode, 401);
  const response = await f.app.inject({ url, headers });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, bytes);
  assert.equal(
    (await f.app.inject({ url, headers: { ...headers, range: "bytes=1-3" } }))
      .statusCode,
    206,
  );
  assert.equal(
    (await f.app.inject({ method: "HEAD", url, headers })).statusCode,
    200,
  );
  assert.equal(
    (
      await f.app.inject({
        url: url.replace(paid.license.id, randomUUID()),
        headers,
      })
    ).statusCode,
    404,
  );
  const other = await f.purchase("generic", "other-customer");
  assert.equal(
    (
      await f.app.inject({
        url: url.replace(paid.license.id, other.license.id),
        headers,
      })
    ).statusCode,
    404,
  );
  const otherSession = "buyer-" + randomUUID();
  await f.db("sessions").insert({
    tenant_id: "primary",
    id: hash(otherSession),
    customer_id: other.license.customer_id,
    expires_at: Date.now() + 86400000,
  });
  assert.equal(
    (
      await f.app.inject({
        url,
        headers: { cookie: `de-session-primary=${otherSession}` },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/licenses/${other.license.id}/assets/${asset.id}/download`,
        headers: { cookie: `de-session-primary=${otherSession}` },
      })
    ).statusCode,
    404,
  );
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "delayed-download-install",
    },
    {},
  );
  const activationHeaders = {
    authorization: `Bearer ${activation.json().token}`,
  };
  const cached = await f.app.inject({
    url: `${prefix}/updates/generic/generic-product/any`,
    headers: activationHeaders,
  });
  assert.equal(cached.statusCode, 200, cached.body);
  const download = new URL(cached.json().assets[0].url).pathname;
  await f
    .db("releases")
    .where({ id: release.id })
    .update({ published_at: Date.now() - 30 * 86400000 });
  assert.equal(
    (await f.app.inject({ url: download, headers: activationHeaders }))
      .statusCode,
    200,
  );
  const sibling = await createTenant(f.db, {
    id: randomUUID(),
    slug: "other-tenant",
    name: "Other",
    exempt: 1,
  });
  assert.ok(sibling);
  assert.equal(
    (
      await f.app.inject({
        url: download.replace("/primary/", "/other-tenant/"),
        headers: activationHeaders,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        url: url.replace("/primary/", "/other-tenant/"),
        headers,
      })
    ).statusCode,
    401,
  );
  await f
    .db("licenses")
    .where({ id: paid.license.id })
    .update({ suspended: 1 });
  assert.equal((await f.app.inject({ url, headers })).statusCode, 403);
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/updates/generic/generic-product/any`,
        headers: activationHeaders,
      })
    ).statusCode,
    403,
  );
  await f
    .db("licenses")
    .where({ id: paid.license.id })
    .update({ suspended: 0 });
  await f.db("releases").where({ id: release.id }).update({ withdrawn: 1 });
  assert.equal((await f.app.inject({ url, headers })).statusCode, 404);
  assert.equal(
    (await f.app.inject({ url: download, headers: activationHeaders }))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/updates/generic/generic-product/any`,
        headers: activationHeaders,
      })
    ).statusCode,
    204,
  );
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  assert.equal(
    (await f.app.inject({ url: download, headers: activationHeaders }))
      .statusCode,
    403,
  );
});

test("asset upload authorizes scope before admission, bounds metadata and releases capacity", async (t) => {
  const f = await fixture(t, {
    maxUploadBytes: 1024,
    maxNativeUploadBytes: 1024,
    nativeSpoolBytes: 2048,
    transferMemoryBytes: 128 * 1024,
  });
  await f.product("generic");
  const metadata = Buffer.from(
    JSON.stringify({
      target: "any",
      filename: "small.bin",
      changelog: "Release",
    }),
  ).toString("base64url");
  const url = `${prefix}/seller/assets/generic-product/1.0.0`;
  const send = (payload: Buffer, extra: Record<string, string> = {}) =>
    f.app.inject({
      method: "POST",
      url,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-release-metadata": metadata,
        ...extra,
      },
      payload,
    });
  const key = "DE-TK-" + "G".repeat(43);
  await f.db("tenant_api_keys").insert({
    tenant_id: "primary",
    id: randomUUID(),
    name: "Read only",
    key_hash: hash(key),
    scopes: JSON.stringify(["read"]),
    expires_at: Date.now() + 86400000,
    created_at: Date.now(),
  });
  const denied = await send(Buffer.alloc(200), {
    authorization: `Bearer ${key}`,
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, "scope_denied");
  f.config.transferMemoryBytes = 128 * 1024 - 1;
  const busy = await send(Buffer.alloc(200));
  assert.equal(busy.statusCode, 503, busy.body);
  assert.equal(busy.json().error.code, "transfer_capacity");
  f.config.transferMemoryBytes = 128 * 1024;
  const huge = await send(Buffer.alloc(1025));
  assert.equal(huge.statusCode, 413, huge.body);
  const empty = await send(Buffer.alloc(0));
  assert.equal(empty.statusCode, 413, empty.body);
  const invalid = await send(Buffer.from("bad"), {
    "x-release-metadata": "e30",
  });
  assert.equal(invalid.statusCode, 400);
  const badJson = await send(Buffer.from("bad"), {
    "x-release-metadata": "YQ",
  });
  assert.equal(badJson.statusCode, 400);
  assert.equal(badJson.json().error.code, "invalid_metadata");
  const long = await send(Buffer.from("bad"), {
    "x-release-metadata": "a".repeat(12289),
  });
  assert.equal(long.statusCode, 400);
  const missing = await f.app.inject({
    method: "POST",
    url: url.replace("generic-product", "absent"),
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": metadata,
    },
    payload: Buffer.from("x"),
  });
  assert.equal(missing.statusCode, 404);
  const success = await send(Buffer.from("tiny"));
  assert.equal(success.statusCode, 200, success.body);
  assert.equal(
    await f
      .db("audit_events")
      .where({ action: "asset.published" })
      .count({ count: "id" })
      .first()
      .then((r) => Number(r!.count)),
    1,
  );
  const overview = await f.app.inject({
    url: `${prefix}/seller/overview`,
    headers: f.headers,
  });
  assert.equal(overview.json().releases[0].assets.length, 1);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({
      exempt: 0,
      trial_ends_at: Date.now() - 30 * 86400000,
      paid_through: 0,
    });
  const capacity = await send(Buffer.from("tiny"));
  assert.equal(capacity.statusCode, 403, capacity.body);
  assert.equal(capacity.json().error.code, "tenant_capacity");
});

test("platform information names every implemented framework", async (t) => {
  const f = await fixture(t);
  const info = await f.app.inject("/api/v1/platform/info");
  assert.deepEqual(info.json().frameworks, Object.keys(configurations));
});

test("WordPress metadata headers fit the same bounded transport budget", async (t) => {
  const f = await fixture(t);
  await f.product("wordpress");
  const bytes = zipBytes([
    {
      name: "wordpress-product/wordpress-product.php",
      data: "<?php\n/*\nPlugin Name: WordPress product\nVersion: 1.0.0\n*/",
    },
  ]);
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/releases/wordpress-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/zip",
      "x-release-metadata": Buffer.from(
        JSON.stringify({ changelog: "x".repeat(10000) }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(response.statusCode, 400, response.body);
});

test("native feed invalid Bearer tokens share the IP rate bucket while a paid activation retains its budget", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("generic");
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "rate-budget-installation",
    },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const url = `${prefix}/updates/generic/generic-product/any`;
  for (let i = 0; i < 60; i++) {
    const response = await f.app.inject({
      url,
      headers: { authorization: `Bearer invalid-native-${i}` },
    });
    assert.equal(response.statusCode, 401, response.body);
  }
  assert.equal(
    (
      await f.app.inject({
        url,
        headers: { authorization: "Bearer invalid-native-61" },
      })
    ).statusCode,
    429,
  );
  assert.equal(
    (
      await f.app.inject({
        url,
        headers: { authorization: `Bearer ${activation.json().token}` },
      })
    ).statusCode,
    204,
  );
});

test("asset downloads reserve 128 KiB through concurrent verified spools and recover capacity after errors", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("generic");
  const bytes = Buffer.from("bounded-download");
  const publication = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "bounded.bin",
          changelog: "Bounded",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(publication.statusCode, 200, publication.body);
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "bounded-installation",
    },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const headers = { authorization: `Bearer ${activation.json().token}` };
  const url = `${prefix}/packages/generic-product/assets/${publication.json().asset.id}/bounded.bin`;
  f.config.transferMemoryBytes = 128 * 1024;
  const original: (
    tenant: string,
    id: string,
    checksum: string,
    size: number,
  ) => Promise<Buffer> = f.store.get.bind(f.store);
  let unblock!: () => void, started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const mock = t.mock.method(
    f.store,
    "get",
    async (...args: Parameters<typeof original>) => {
      started();
      await pending;
      return original(...args);
    },
  );
  const first = f.app.inject({ url, headers });
  await ready;
  const second = await f.app.inject({
    url,
    headers: { ...headers, range: "bytes=0-3" },
  });
  assert.equal(second.statusCode, 503, second.body);
  assert.equal(second.json().error.code, "transfer_capacity");
  assert.equal(second.headers["content-disposition"], undefined);
  assert.equal(second.headers["x-checksum-sha256"], undefined);
  assert.equal(second.headers["content-range"], undefined);
  assert.match(String(second.headers["content-type"]), /application\/json/);
  unblock();
  assert.equal((await first).statusCode, 200);
  mock.mock.restore();
  const fresh = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.1.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "bounded.bin",
          changelog: "Bounded",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(fresh.statusCode, 200, fresh.body);
  const uncached = url.replace(
    publication.json().asset.id,
    fresh.json().asset.id,
  );
  const failure = t.mock.method(f.store, "get", async () => {
    throw new Error("storage unavailable");
  });
  const storageError = await f.app.inject({ url: uncached, headers });
  assert.equal(storageError.statusCode, 500);
  assert.equal(storageError.headers["content-disposition"], undefined);
  assert.equal(storageError.headers["x-checksum-sha256"], undefined);
  failure.mock.restore();
  assert.equal((await f.app.inject({ url, headers })).statusCode, 200);
  assert.equal(
    (await f.app.inject({ method: "HEAD", url, headers })).statusCode,
    200,
  );
  await f
    .db("licenses")
    .where({ id: paid.license.id })
    .update({ paid_through: Date.now() - 1 });
  assert.equal((await f.app.inject({ url, headers })).statusCode, 403);
  assert.equal(
    (
      await f.app.inject({
        url: `${prefix}/updates/generic/generic-product/any`,
        headers,
      })
    ).statusCode,
    403,
  );
});

test("concurrent cold downloads reserve disk before transfer while cache hits and released capacity remain available", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("generic");
  const bytes = Buffer.alloc(1024, 5);
  const urls: string[] = [];
  for (const version of ["1.0.0", "1.1.0"]) {
    const publication = await f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/${version}`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-release-metadata": Buffer.from(
          JSON.stringify({ target: "any", filename: "disk.bin", changelog: "" }),
        ).toString("base64url"),
      },
      payload: bytes,
    });
    assert.equal(publication.statusCode, 200, publication.body);
    urls.push(`${prefix}/packages/generic-product/assets/${publication.json().asset.id}/disk.bin`);
  }
  const activation = await f.post(
    "/activate",
    { key: paid.key, product: paid.product.slug, installationId: "disk-cache-installation" },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const headers = { authorization: `Bearer ${activation.json().token}` };
  const floor = 4096;
  f.config.minDiskFreeBytes = floor;
  let available = BigInt(floor + 1.5 * bytes.length);
  const actualSpace = await fs.statfs(f.config.storage, { bigint: true });
  const disk = t.mock.method(
    fs,
    "statfs",
    (async () => ({ ...actualSpace, bavail: available, bsize: 1n })) as unknown as typeof fs.statfs,
  );
  syncBuiltinESMExports();
  t.after(() => {
    disk.mock.restore();
    syncBuiltinESMExports();
  });
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let reads = 0;
  const original: InMemoryArtifactStore["get"] = f.store.get.bind(f.store);
  t.mock.method(f.store, "get", async (...args: Parameters<typeof original>) => {
    reads++;
    if (reads === 1) {
      started();
      await blocked;
    }
    return original(...args);
  });
  const first = f.app.inject({ url: urls[0]!, headers });
  await ready;
  try {
    const second = await f.app.inject({ url: urls[1]!, headers });
    assert.equal(second.statusCode, 503);
    assert.equal(second.json().error.code, "disk_capacity");
    assert.equal(reads, 1);
    available = BigInt(floor + 2.5 * bytes.length);
    const put = t.mock.method(f.store, "put", f.store.put.bind(f.store));
    const upload = await f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/1.2.0`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-release-metadata": Buffer.from(
          JSON.stringify({ target: "any", filename: "disk.bin", changelog: "" }),
        ).toString("base64url"),
      },
      payload: bytes,
    });
    assert.equal(upload.statusCode, 503, upload.body);
    assert.equal(upload.json().error.code, "disk_capacity");
    assert.equal(put.mock.callCount(), 0, "publication includes pending read copies before storing an object");
  } finally {
    release();
    assert.equal((await first).statusCode, 200);
  }
  available = BigInt(floor);
  assert.equal((await f.app.inject({ url: urls[0]!, headers })).statusCode, 200);
  assert.equal(reads, 1, "cached bytes do not reserve another disk copy");
  available = BigInt(floor + 1.5 * bytes.length);
  const retry = await f.app.inject({ url: urls[1]!, headers });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(reads, 2, "completed and rejected reservations are released");
});

test("native uploads use a separate file cap and public info reports it", async (t) => {
  const f = await fixture(t, {
    maxUploadBytes: 1024,
    maxNativeUploadBytes: 2048,
    nativeSpoolBytes: 4096,
  });
  await f.product("generic");
  const metadata = Buffer.from(
    JSON.stringify({ target: "any", filename: "native.bin", changelog: "" }),
  ).toString("base64url");
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": metadata,
    },
    payload: Buffer.alloc(1536, 5),
  });
  assert.equal(response.statusCode, 200, response.body);
  const info = await f.app.inject("/api/v1/platform/info");
  assert.equal(info.json().maxNativeUploadBytes, 2048);
  assert.equal(info.json().maxUploadBytes, 1024);
});
test("finished native ranges meter served bytes and only one committed storage read", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("generic");
  const bytes = Buffer.from("verified native range bytes");
  const publication = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "metered.bin",
          changelog: "",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(publication.statusCode, 200, publication.body);
  assert.equal((await f.db("download_metrics")).length, 0);
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "metered-native",
    },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const url = `${prefix}/packages/generic-product/assets/${publication.json().asset.id}/metered.bin`,
    headers = { authorization: `Bearer ${activation.json().token}` };
  for (const range of ["bytes=0-3", "bytes=-5"])
    assert.equal(
      (await f.app.inject({ url, headers: { ...headers, range } })).statusCode,
      206,
    );
  assert.equal(
    (await f.app.inject({ method: "HEAD", url, headers })).statusCode,
    200,
  );
  let metric = await f
    .db("download_metrics")
    .where({ release_id: publication.json().release.id })
    .first();
  const until = Date.now() + 2000;
  while (Number(metric.successful_responses) < 2) {
    assert.ok(Date.now() < until, "finished response metrics did not settle");
    await new Promise((resolve) => setTimeout(resolve, 5));
    metric = await f
      .db("download_metrics")
      .where({ release_id: publication.json().release.id })
      .first();
  }
  assert.equal(Number(metric.served_bytes), 9);
  assert.equal(Number(metric.storage_reads), 1);
  assert.equal(Number(metric.storage_read_bytes), bytes.length);
  assert.equal(Number(metric.successful_responses), 2);
});

test("native ingress rejects declared-length mismatch and cleans disk admission", async (t) => {
  const f = await fixture(t, {
    maxNativeUploadBytes: 1024,
    nativeSpoolBytes: 2048,
  });
  await f.product("generic");
  const { Readable } = await import("node:stream");
  const request = (length: string, payload: import("node:stream").Readable) =>
    f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/1.0.0`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "content-length": length,
        "x-release-metadata": Buffer.from(
          JSON.stringify({
            target: "any",
            filename: "length.bin",
            changelog: "",
          }),
        ).toString("base64url"),
      },
      payload,
    });
  const short = await request("8", Readable.from([Buffer.from("abc")]));
  assert.equal(short.statusCode, 400, short.body);
  assert.equal(short.json().error.code, "content_length_mismatch");
  const long = await request("2", Readable.from([Buffer.from("abc")]));
  assert.equal(long.statusCode, 400, long.body);
  assert.equal(long.json().error.code, "content_length_mismatch");
  const oversized = await request("8", Readable.from([Buffer.alloc(1025)]));
  assert.equal(oversized.statusCode, 413, oversized.body);
  const missing = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: { ...f.headers, "content-type": "application/octet-stream" },
    payload: Readable.from([Buffer.from("x")]),
  });
  assert.equal(missing.statusCode, 411, missing.body);
  const okay = await request("3", Readable.from([Buffer.from("abc")]));
  assert.equal(okay.statusCode, 200, okay.body);
  assert.equal((await f.db("upload_reservations")).length, 0);
});
test(
  "native end-to-end file streaming works with real local MinIO and a 128 KiB transfer budget",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => {
    const { S3Client, CreateBucketCommand, DeleteBucketCommand } =
      await import("@aws-sdk/client-s3");
    const { S3ArtifactStore } = await import("../src/storage.ts");
    const endpoint = process.env.TEST_S3_ENDPOINT!;
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname),
    );
    const credentials = {
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY!,
    };
    const bucket = "native-app-" + randomUUID();
    const client = new S3Client({
      endpoint,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const store = new S3ArtifactStore({
      endpoint,
      region: "us-east-1",
      credentials,
      bucket,
      forcePathStyle: true,
      allowInsecureLocalDevelopment: true,
      maxBytes: 1024,
      maxNativeBytes: 2048,
    });
    const f = await fixture(
      t,
      {
        maxUploadBytes: 1024,
        maxNativeUploadBytes: 2048,
        nativeSpoolBytes: 4096,
        transferMemoryBytes: 128 * 1024,
      },
      store,
    );
    const paid = await f.purchase("generic");
    let objectId: string | undefined;
    t.after(async () => {
      if (objectId) await store.delete("primary", objectId);
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    });
    const bytes = Buffer.alloc(1536, 7);
    const got = await f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/1.0.0`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-release-metadata": Buffer.from(
          JSON.stringify({
            target: "any",
            filename: "native.bin",
            changelog: "",
          }),
        ).toString("base64url"),
      },
      payload: bytes,
    });
    assert.equal(got.statusCode, 200, got.body);
    objectId = got.json().asset.id;
    assert.equal((await f.db("download_metrics")).length, 0);
    const activated = await f.post(
      "/activate",
      {
        key: paid.key,
        product: paid.product.slug,
        installationId: "file-native-minio",
      },
      {},
    );
    assert.equal(activated.statusCode, 200, activated.body);
    const url = `${prefix}/packages/generic-product/assets/${objectId}/native.bin`,
      headers = { authorization: `Bearer ${activated.json().token}` };
    const range = await f.app.inject({
      url,
      headers: { ...headers, range: "bytes=4-11" },
    });
    assert.equal(range.statusCode, 206, range.body);
    assert.deepEqual(range.rawPayload, bytes.subarray(4, 12));
    const cached = await f.app.inject({
      url,
      headers: { ...headers, range: "bytes=-4" },
    });
    assert.equal(cached.statusCode, 206, cached.body);
    let row = await f.db("download_metrics").first();
    const until = Date.now() + 2000;
    while (Number(row.successful_responses) < 2) {
      assert.ok(Date.now() < until, "finished response metrics did not settle");
      await new Promise((resolve) => setTimeout(resolve, 5));
      row = await f.db("download_metrics").first();
    }
    assert.equal(Number(row.storage_reads), 1);
    assert.equal(Number(row.storage_read_bytes), 1536);
    assert.equal(Number(row.served_bytes), 12);
  },
);

test("native publication holds two disk copies through commit and releases only after cleanup", async (t) => {
  const f = await fixture(t, {
    maxNativeUploadBytes: 1024,
    nativeSpoolBytes: 2048,
  });
  await f.product("generic");
  const bytes = Buffer.alloc(1024, 3),
    metadata = Buffer.from(
      JSON.stringify({ target: "any", filename: "disk.bin", changelog: "" }),
    ).toString("base64url");
  const send = (version: string) =>
    f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/${version}`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-release-metadata": metadata,
      },
      payload: bytes,
    });
  let release!: () => void, began!: () => void;
  const waiting = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      began = resolve;
    });
  const original: (
    tenant: string,
    id: string,
    bytes: Buffer,
    checksum: string,
  ) => Promise<void> = f.store.put.bind(f.store);
  const mock = t.mock.method(
    f.store,
    "put",
    async (...args: Parameters<typeof original>) => {
      began();
      await waiting;
      return original(...args);
    },
  );
  const first = send("1.0.0");
  await started;
  const busy = await send("1.1.0");
  assert.equal(busy.statusCode, 503, busy.body);
  assert.equal(busy.json().error.code, "disk_capacity");
  release();
  assert.equal((await first).statusCode, 200);
  mock.mock.restore();
  assert.equal((await send("1.1.0")).statusCode, 200);
  const { readdir } = await import("node:fs/promises");
  assert.ok(
    (await readdir(f.config.storage)).every(
      (name) => !name.startsWith(".upload-"),
    ),
  );
});
test("native ingress deadline returns a pre-header error and releases private spool and admission", async (t) => {
  const f = await fixture(t, {
    maxNativeUploadBytes: 1024,
    nativeSpoolBytes: 2048,
    nativeUploadTimeoutMs: 20,
  });
  await f.product("generic");
  const { Readable } = await import("node:stream");
  const input = new Readable({ read() {} });
  const metadata = Buffer.from(
    JSON.stringify({ target: "any", filename: "slow.bin", changelog: "" }),
  ).toString("base64url");
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "content-length": "10",
      "x-release-metadata": metadata,
    },
    payload: input,
  });
  input.destroy();
  assert.equal(response.statusCode, 408, response.body);
  assert.equal(response.headers["content-disposition"], undefined);
  const retry = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": metadata,
    },
    payload: Buffer.from("ok"),
  });
  assert.equal(retry.statusCode, 200, retry.body);
  const { readdir } = await import("node:fs/promises");
  assert.ok(
    (await readdir(f.config.storage)).every(
      (name) => !name.startsWith(".upload-"),
    ),
  );
});

test("portability API is mounted with data:export scope outside generic seller authorization", async (t) => {
  const f = await fixture(t);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({
      stripe_account_id: "acct_exportFixture",
      stripe_status: "connected",
    });
  const url = `${prefix}/seller/exports`,
    payload = { passphrase: "private fixture transfer passphrase" };
  const denied = await f.app.inject({
    method: "POST",
    url,
    headers: f.headers,
    payload,
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(denied.json().error.code, "scope_denied");
  await f
    .db("tenant_api_keys")
    .where({ tenant_id: "primary" })
    .update({ scopes: JSON.stringify(["data:export"]) });
  const created = await f.app.inject({
    method: "POST",
    url,
    headers: f.headers,
    payload,
  });
  assert.equal(created.statusCode, 200, created.body);
  const manifest = await f.app.inject({
    url: `${url}/${created.json().id}/manifest`,
    headers: f.headers,
  });
  assert.equal(manifest.statusCode, 200, manifest.body);
  assert.ok(manifest.rawPayload.length > 0);
  assert.equal(manifest.headers["cache-control"], "no-store");
});
test("client-aborted native download records a verified read and zero completed response bytes", async (t) => {
  const f = await fixture(t);
  const paid = await f.purchase("generic"),
    bytes = Buffer.alloc(8 * 1024 ** 2, 7);
  const publication = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({ target: "any", filename: "abort.bin", changelog: "" }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(publication.statusCode, 200, publication.body);
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "native-client-abort",
    },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 }),
    { get } = await import("node:http");
  await new Promise<void>((resolve, reject) => {
    const request = get(
      `${address}${prefix}/packages/generic-product/assets/${publication.json().asset.id}/abort.bin`,
      { headers: { authorization: `Bearer ${activation.json().token}` } },
      (response) => {
        response.once("data", () => request.destroy());
        response.once("close", resolve);
        response.once("error", () => resolve());
      },
    );
    request.once("error", reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const row = await f
    .db("download_metrics")
    .where({ release_id: publication.json().release.id })
    .first();
  assert.equal(Number(row.storage_reads), 1);
  assert.equal(Number(row.storage_read_bytes), bytes.length);
  assert.equal(Number(row.served_bytes), 0);
  assert.equal(Number(row.successful_responses), 0);
});

test("native uploads honor the volume free-space floor and release rejected reservations", async (t) => {
  const f = await fixture(t, {
    maxNativeUploadBytes: 1024,
    nativeSpoolBytes: 2048,
  });
  await f.product("generic");
  const send = () =>
    f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/1.0.0`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-release-metadata": Buffer.from(
          JSON.stringify({
            target: "any",
            filename: "space.bin",
            changelog: "",
          }),
        ).toString("base64url"),
      },
      payload: Buffer.from("ok"),
    });
  f.config.minDiskFreeBytes = Number.MAX_SAFE_INTEGER;
  const busy = await send();
  assert.equal(busy.statusCode, 503, busy.body);
  assert.equal(busy.json().error.code, "disk_capacity");
  f.config.minDiskFreeBytes = 0;
  assert.equal((await send()).statusCode, 200);
});
test("client-aborted native upload closes its file before releasing private disk admission", async (t) => {
  const f = await fixture(t, {
    maxNativeUploadBytes: 1024,
    nativeSpoolBytes: 2048,
  });
  await f.product("generic");
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 }),
    { request } = await import("node:http"),
    { readdir } = await import("node:fs/promises");
  const metadata = Buffer.from(
    JSON.stringify({
      target: "any",
      filename: "abort-upload.bin",
      changelog: "",
    }),
  ).toString("base64url");
  const client = request(
    `${address}${prefix}/seller/assets/generic-product/1.0.0`,
    {
      method: "POST",
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "content-length": "1024",
        "x-release-metadata": metadata,
      },
    },
  );
  client.on("error", () => {});
  client.write("partial");
  const deadline = Date.now() + 2000;
  while (
    !(await readdir(f.config.storage)).some((name) =>
      name.startsWith(".upload-"),
    )
  ) {
    assert.ok(Date.now() < deadline, "upload spool did not start");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  client.destroy();
  while (
    (await readdir(f.config.storage)).some((name) =>
      name.startsWith(".upload-"),
    )
  ) {
    assert.ok(Date.now() < deadline, "aborted spool was not cleaned");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const retry = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": metadata,
    },
    payload: Buffer.from("ok"),
  });
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal((await f.db("upload_reservations")).length, 0);
});
test("the app worker suppresses unqualified business history on every tenant tick", async (t) => {
  const f = await fixture(t);
  await f.product("generic");
  await f
    .db("tenant_api_keys")
    .where({ tenant_id: "primary" })
    .update({ scopes: JSON.stringify(["billing:reconcile"]) });
  await f
    .db("business_events")
    .insert({
      tenant_id: "primary",
      id: "a".repeat(64),
      type: "release.published",
      resource_id: "fixture",
      occurred_at: Date.now(),
    });
  const run = await f.post("/seller/jobs/run", {});
  assert.equal(run.statusCode, 200, run.body);
  assert.equal((await f.db("business_events").first()).state, "suppressed");
});
test("uncertain native spool deletion retains disk admission instead of admitting more files", async (t) => {
  const f = await fixture(t, {
    maxNativeUploadBytes: 1024,
    nativeSpoolBytes: 2048,
  });
  await f.product("generic");
  const fs = await import("node:fs/promises"),
    { syncBuiltinESMExports } = await import("node:module");
  const original = fs.default.rm;
  const failure = t.mock.method(
    fs.default,
    "rm",
    async (
      path: Parameters<typeof original>[0],
      options: Parameters<typeof original>[1],
    ) => {
      if (String(path).includes("/.upload-"))
        throw Error("simulated cleanup failure");
      return original(path, options);
    },
  );
  syncBuiltinESMExports();
  const send = (version: string) =>
    f.app.inject({
      method: "POST",
      url: `${prefix}/seller/assets/generic-product/${version}`,
      headers: {
        ...f.headers,
        "content-type": "application/octet-stream",
        "x-release-metadata": Buffer.from(
          JSON.stringify({
            target: "any",
            filename: "cleanup.bin",
            changelog: "",
          }),
        ).toString("base64url"),
      },
      payload: Buffer.alloc(1024),
    });
  try {
    assert.equal((await send("1.0.0")).statusCode, 500);
    const busy = await send("1.1.0");
    assert.equal(busy.statusCode, 503, busy.body);
    assert.equal(busy.json().error.code, "disk_capacity");
  } finally {
    failure.mock.restore();
    syncBuiltinESMExports();
  }
});
test("startup rejects insufficient publication disk budgets and work paths inside public static files", async (t) => {
  await assert.rejects(fixture(t, { nativeSpoolBytes: 1 }), {
    code: "storage_configuration",
  });
  await assert.rejects(
    fixture(t, {
      storage: "/Volumes/Scratch/entitle/build/main/web/private",
    }),
    { code: "storage_configuration" },
  );
});
test("standalone portability uses the configured operator-verified direct Stripe account identity", async (t) => {
  const f = await fixture(t, {
    deploymentMode: "standalone",
    standaloneStripeAccountId: "acct_standaloneFixture",
  });
  await f
    .db("tenant_api_keys")
    .where({ tenant_id: "primary" })
    .update({ scopes: JSON.stringify(["data:export"]) });
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/exports`,
    headers: f.headers,
    payload: { passphrase: "private standalone transfer fixture" },
  });
  assert.equal(response.statusCode, 200, response.body);
});
test("tenant queue recovery retains table and tenant scope and audits explicit retries", async (t) => {
  const f = await fixture(t);
  await f
    .db("tenant_api_keys")
    .where({ tenant_id: "primary" })
    .update({ scopes: JSON.stringify(["billing:reconcile"]) });
  await f.db("work").insert([
    {
      tenant_id: "primary",
      id: "retry-one",
      kind: "reconcile",
      payload: "{}",
      state: "failed",
      created_at: 1,
    },
    {
      tenant_id: "primary",
      id: "retry-two",
      kind: "reconcile",
      payload: "{}",
      state: "failed",
      created_at: 1,
    },
  ]);
  await f
    .db("customers")
    .insert({
      tenant_id: "primary",
      id: "queue-customer",
      email: "queue@example.test",
    });
  await f
    .db("emails")
    .insert({
      tenant_id: "primary",
      customer_id: "queue-customer",
      id: "retry-mail",
      kind: "login",
      payload: "{}",
      state: "failed",
      created_at: 1,
    });
  assert.equal(
    (await f.post("/seller/jobs/work/retry-failed", { limit: 1 })).json()
      .queued,
    1,
  );
  assert.equal(
    (await f.post("/seller/jobs/work/retry-failed", {})).json().queued,
    1,
  );
  assert.equal(
    (await f.post("/seller/jobs/work/retry-failed", {})).json().queued,
    0,
  );
  const email = await f.post("/seller/jobs/emails/retry-mail/retry", {});
  assert.equal(email.statusCode, 200, email.body);
  assert.equal(
    (await f.post("/seller/jobs/emails/retry-mail/retry", {})).statusCode,
    404,
  );
  await f.db("emails").where({ id: "retry-mail" }).update({ state: "failed" });
  assert.equal(
    (await f.post("/seller/jobs/emails/retry-failed", {})).json().queued,
    1,
  );
});
test("download integrity guards reject oversized or failed source streams without recording a completed response", async (t) => {
  const f = await fixture(t),
    paid = await f.purchase("generic"),
    bytes = Buffer.from("source guard");
  const publication = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({ target: "any", filename: "guard.bin", changelog: "" }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(publication.statusCode, 200, publication.body);
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "guard-native",
    },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const { VerifiedArtifactCache } = await import("../src/artifact-streams.ts"),
    { Readable } = await import("node:stream");
  let failed = false;
  t.mock.method(VerifiedArtifactCache.prototype, "open", async () => ({
    stream: failed
      ? new Readable({
          read() {
            this.destroy(Error("local source failure"));
          },
        })
      : Readable.from([Buffer.alloc(bytes.length + 1)]),
    size: bytes.length,
  }));
  for (const error of [false, true]) {
    failed = error;
    const result = await f.app
      .inject({
        url: `${prefix}/packages/generic-product/assets/${publication.json().asset.id}/guard.bin`,
        headers: { authorization: `Bearer ${activation.json().token}` },
      })
      .then(
        (response) => response.statusCode,
        () => 500,
      );
    assert.ok(result >= 500);
  }
  assert.equal((await f.db("download_metrics")).length, 0);
});
test("progressing native ingress exceeds its idle interval while staying inside its size-scaled total budget", async (t) => {
  const f = await fixture(t, { nativeUploadTimeoutMs: 100 });
  await f.product("generic");
  const { Readable } = await import("node:stream");
  const body = Readable.from(
    (async function* () {
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        yield Buffer.alloc(65536, 3);
      }
    })(),
  );
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "content-length": "262144",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "progress.bin",
          changelog: "",
        }),
      ).toString("base64url"),
    },
    payload: body,
  });
  assert.equal(response.statusCode, 200, response.body);
});

test("ordinary mutation bodies retain the finite 30-second ingress deadline", async (t) => {
  const f = await fixture(t);
  const { Readable } = await import("node:stream");
  const payload = new Readable({ read() {} });
  let started!: () => void;
  const parsing = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.app.addHook("preParsing", async (_req, _reply, body) => {
    started();
    return body;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = f.app.inject({
    method: "POST",
    url: `${prefix}/seller/products`,
    headers: {
      ...f.headers,
      "content-type": "application/json",
      "content-length": "2",
    },
    payload,
  });
  await parsing;
  t.mock.timers.tick(30001);
  await assert.rejects(response, /Request body upload timed out/);
  payload.destroy();
});

test("optional legacy configuration defaults preserve native upload and verified download admission", async (t) => {
  const f = await fixture(t, { cacheMemoryBytes: 1024 ** 2 });
  const paid = await f.purchase("generic");
  delete f.config.maxNativeUploadBytes;
  delete f.config.nativeUploadTimeoutMs;
  delete f.config.minDiskFreeBytes;
  delete f.config.transferMemoryBytes;
  const bytes = Buffer.from("legacy defaults");
  const publication = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "default.bin",
          changelog: "",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(publication.statusCode, 200, publication.body);
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "optional-native-defaults",
    },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const download = await f.app.inject({
    url: `${prefix}/packages/generic-product/assets/${publication.json().asset.id}/default.bin`,
    headers: { authorization: `Bearer ${activation.json().token}` },
  });
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, bytes);
});
test("a progressing partial native body still expires when its response becomes idle", async (t) => {
  const f = await fixture(t, { nativeUploadTimeoutMs: 20 });
  await f.product("generic");
  const { Readable } = await import("node:stream");
  const body = new Readable({
    read() {
      this.push("x");
      this._read = () => {};
    },
  });
  const response = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "content-length": "1000000",
      "x-release-metadata": Buffer.from(
        JSON.stringify({ target: "any", filename: "idle.bin", changelog: "" }),
      ).toString("base64url"),
    },
    payload: body,
  });
  body.destroy();
  assert.equal(response.statusCode, 408, response.body);
  assert.equal(response.headers["content-disposition"], undefined);
});
test("hosted sandbox checkout admission inherits parent capacity instead of the stored exempt child row", async (t) => {
  const f = await fixture(t);
  const child = await createTenant(f.db, {
    id: randomUUID(),
    slug: "sandbox-capacity-fixture",
    name: "Sandbox capacity fixture",
    exempt: 1,
  });
  await f
    .db("publisher_sandboxes")
    .insert({
      parent_tenant_id: "primary",
      sandbox_tenant_id: child.id,
      mode: "fixture",
      created_at: Date.now(),
    });
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({ exempt: 0, paid_through: 0, trial_ends_at: 0 });
  const response = await f.app.inject({
    method: "POST",
    url: `/api/v1/tenants/${child.slug}/checkout`,
    headers: { origin: f.config.origin },
    payload: {},
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(response.json().error.code, "tenant_capacity");
  assert.equal(
    (await f.db("tenants").where({ id: child.id }).first()).exempt,
    1,
  );
});

test("native publication survives a silent storage phase beyond the ordinary socket timeout", async (t) => {
  const f = await fixture(t);
  await f.product("generic");
  const put = f.store.put.bind(f.store);
  t.mock.method(f.store, "put", async (...args: Parameters<typeof put>) => {
    await new Promise((r) => setTimeout(r, 120));
    return put(args[0], args[1], args[2], args[3]);
  });
  f.app.server.setTimeout(40);
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(
      `${address}${prefix}/seller/assets/generic-product/1.0.0`,
      {
        method: "POST",
        headers: {
          ...f.headers,
          "content-type": "application/octet-stream",
          "x-release-metadata": Buffer.from(
            JSON.stringify({
              target: "any",
              filename: "silent.bin",
              changelog: "",
            }),
          ).toString("base64url"),
        },
        body: Buffer.from("silent publication"),
        signal: AbortSignal.timeout(3000),
      },
    );
    assert.equal(response.status, 200, await response.text());
  } finally {
    await new Promise((r) => setTimeout(r, 160));
  }
});

test("cold native download survives silent verification beyond the ordinary socket timeout", async (t) => {
  const f = await fixture(t),
    paid = await f.purchase("generic"),
    bytes = Buffer.from("cold verified artifact");
  const published = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "silent.bin",
          changelog: "",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(published.statusCode, 200, published.body);
  const activation = await f.post(
    "/activate",
    {
      key: paid.key,
      product: paid.product.slug,
      installationId: "silent-download",
    },
    {},
  );
  assert.equal(activation.statusCode, 200, activation.body);
  const get = f.store.get.bind(f.store);
  t.mock.method(f.store, "get", async (...args: Parameters<typeof get>) => {
    await new Promise((r) => setTimeout(r, 120));
    return get(args[0], args[1], args[2], args[3]);
  });
  f.app.server.setTimeout(40);
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(
      `${address}${prefix}/packages/generic-product/assets/${published.json().asset.id}/silent.bin`,
      {
        headers: { authorization: `Bearer ${activation.json().token}` },
        signal: AbortSignal.timeout(3000),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    await new Promise((r) => setTimeout(r, 160));
  }
});

test("tenant export returns its handle after silent encryption beyond the ordinary socket timeout", async (t) => {
  const f = await fixture(t);
  await f.product("generic");
  const published = await f.app.inject({
    method: "POST",
    url: `${prefix}/seller/assets/generic-product/1.0.0`,
    headers: {
      ...f.headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "silent.bin",
          changelog: "",
        }),
      ).toString("base64url"),
    },
    payload: Buffer.from("export verified artifact"),
  });
  assert.equal(published.statusCode, 200, published.body);
  await f
    .db("tenants")
    .where({ id: "primary" })
    .update({
      stripe_account_id: "acct_silentExport",
      stripe_status: "connected",
    });
  await f
    .db("tenant_api_keys")
    .where({ tenant_id: "primary" })
    .update({ scopes: JSON.stringify(["data:export"]) });
  const get = f.store.get.bind(f.store);
  t.mock.method(f.store, "get", async (...args: Parameters<typeof get>) => {
    await new Promise((r) => setTimeout(r, 120));
    return get(args[0], args[1], args[2], args[3]);
  });
  f.app.server.setTimeout(40);
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch(`${address}${prefix}/seller/exports`, {
      method: "POST",
      headers: { ...f.headers, "content-type": "application/json" },
      body: JSON.stringify({ passphrase: "private delayed export passphrase" }),
      signal: AbortSignal.timeout(3000),
    });
    assert.equal(response.status, 200);
    const exported = (await response.json()) as { id: string };
    assert.match(exported.id, /^[a-f0-9-]{36}$/);
    const download = await f.app.inject({
      url: `${prefix}/seller/exports/${exported.id}/manifest`,
      headers: f.headers,
    });
    assert.equal(download.statusCode, 200, download.body);
  } finally {
    await new Promise((r) => setTimeout(r, 200));
  }
});

test("native transfer socket override restores ordinary timeout on the same keep-alive connection", async (t) => {
  const f = await fixture(t);
  f.app.get("/ordinary-silent", async () => {
    await new Promise((r) => setTimeout(r, 120));
    return { ok: true };
  });
  await f.product("generic");
  const put = f.store.put.bind(f.store);
  t.mock.method(f.store, "put", async (...args: Parameters<typeof put>) => {
    await new Promise((r) => setTimeout(r, 120));
    return put(args[0], args[1], args[2], args[3]);
  });
  f.app.server.setTimeout(40);
  const address = await f.app.listen({ host: "127.0.0.1", port: 0 }),
    { request, Agent } = await import("node:http");
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const body = Buffer.from("same socket artifact");
  const send = (path: string, payload?: Buffer) =>
    new Promise<{ status: number; socket: unknown }>((resolve, reject) => {
      const req = request(
        `${address}${path}`,
        {
          agent,
          method: payload ? "POST" : "GET",
          headers: payload
            ? {
                ...f.headers,
                "content-type": "application/octet-stream",
                "content-length": String(payload.length),
                "x-release-metadata": Buffer.from(
                  JSON.stringify({
                    target: "any",
                    filename: "reuse.bin",
                    changelog: "",
                  }),
                ).toString("base64url"),
              }
            : {},
        },
        (res) => {
          const socket = res.socket;
          res.resume();
          res.once("end", () => resolve({ status: res.statusCode!, socket }));
          res.once("error", reject);
        },
      );
      req.once("error", reject);
      req.end(payload);
    });
  const published = await send(
    `${prefix}/seller/assets/generic-product/1.0.0`,
    body,
  );
  assert.equal(published.status, 200);
  await assert.rejects(
    send("/ordinary-silent"),
    (error: NodeJS.ErrnoException) => error.code === "ECONNRESET",
  );
  await new Promise((r) => setTimeout(r, 140));
});

test("programmatic app configuration can omit optional export admission fields", async (t) => {
  const f = await fixture(t);
  delete f.config.exportMaxExports;
  delete f.config.exportMaxBytes;
  const app = await buildApp(
    f.config,
    f.db,
    { send: async () => {} },
    { store: f.store },
  );
  try {
    const ready = await app.inject("/api/v1/ready");
    assert.equal(ready.statusCode, 200, ready.body);
  } finally {
    await app.close();
  }
});
