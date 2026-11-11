import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate } from "../src/db.ts";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportJWK } from "jose";
import { oidcFixture, publisherInput } from "./helpers/oidc.ts";
import { zipBytes } from "./helpers/zip.ts";
import { createTenant } from "../src/db.ts";
import { OidcPublishing } from "../src/oidc-publishing.ts";
import { jwk } from "./helpers/oidc.ts";

test("OIDC exchange requires a CI identity before accepting publishing credentials", async () => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/oidc-");
  const { db, close } = await isolatedDatabase(`sqlite:${root}/db`);
  const config = loadConfig({
    APP_SECRET: "ab".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
    WORK_DIR: `${root}/work`,
    WEB_DIR: `${root}/web`,
  });
  await migrate(db);
  const app = await buildApp(config, db, undefined, {
    store: new InMemoryArtifactStore(),
  });
  try {
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/oidc/token",
      payload: { publisherId: "00000000-0000-4000-8000-000000000000" },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, "oidc_identity_required");
  } finally {
    await app.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub identity exchanges once, publishes a ZIP, and has no catalog, account or withdrawal authority", async () => {
  const f = await oidcFixture();
  try {
    const id = await f.seedPublisher(),
      identity = await f.token();
    const response = await f.exchange(id, identity);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    const { accessToken, expiresAt, scopes } = response.json();
    assert.match(accessToken, /^DE-CI-[A-Za-z0-9_-]{43}$/);
    assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 300000);
    assert.deepEqual(scopes, ["releases:write"]);
    assert.equal((await f.exchange(id, identity)).statusCode, 409);
    const headers = { authorization: `Bearer ${accessToken}` };
    const zip = zipBytes([
      {
        name: "plugin/plugin.php",
        data: "<?php\n/* Plugin Name: Plugin\nVersion: 1.0.0\n*/",
      },
    ]);
    const published = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/releases/plugin/1.0.0",
      headers: {
        ...headers,
        "content-type": "application/zip",
        "x-release-metadata": Buffer.from(
          '{"changelog":"CI release"}',
        ).toString("base64url"),
      },
      payload: zip,
    });
    assert.equal(published.statusCode, 200, published.body);
    for (const [method, path] of [
      ["GET", "/overview"],
      ["POST", "/products"],
      ["POST", `/releases/${published.json().id}/withdraw`],
      ["POST", "/keys"],
      ["POST", "/oidc/publishers"],
    ] as const) {
      const denied = await f.app.inject({
        method,
        url: `/api/v1/tenants/primary/seller${path}`,
        headers,
        ...(method === "POST" ? { payload: {} } : {}),
      });
      assert.ok(
        [401, 403].includes(denied.statusCode),
        `${path}: ${denied.body}`,
      );
    }
    const stored = await f.db("oidc_sessions").first();
    assert.ok(
      !JSON.stringify(stored).includes(accessToken) &&
        !JSON.stringify(stored).includes(identity),
    );
    assert.equal(
      (
        await f
          .db("audit_events")
          .where({ action: "release.published" })
          .first()
      ).actor_type,
      "oidc",
    );
    assert.equal(f.fetches(), 1, "JWKS is cached");
  } finally {
    await f.close();
  }
});

test("OIDC signature and standard claims fail closed", async (t) => {
  const other = await generateKeyPair("RS256");
  const other512 = await generateKeyPair("RS512");
  const cases: [
    string,
    Record<string, unknown>,
    CryptoKey | undefined,
    { alg: string; kid: string } | undefined,
  ][] = [
    ["wrong issuer", { iss: "https://evil.test" }, undefined, undefined],
    ["wrong audience", { aud: "https://elsewhere.test" }, undefined, undefined],
    [
      "wrong subject",
      { sub: "repo:attacker/plugin:ref:refs/heads/main" },
      undefined,
      undefined,
    ],
    ["expired", { exp: 1 }, undefined, undefined],
    [
      "not yet valid",
      { nbf: Math.floor(Date.now() / 1000) + 60 },
      undefined,
      undefined,
    ],
    [
      "future issued",
      { iat: Math.floor(Date.now() / 1000) + 60 },
      undefined,
      undefined,
    ],
    [
      "stale",
      { iat: Math.floor(Date.now() / 1000) - 700 },
      undefined,
      undefined,
    ],
    ["missing expiry", { exp: undefined }, undefined, undefined],
    ["missing issue time", { iat: undefined }, undefined, undefined],
    ["missing token ID", { jti: undefined }, undefined, undefined],
    ["empty token ID", { jti: "" }, undefined, undefined],
    [
      "invalid lifetime",
      { exp: Math.floor(Date.now() / 1000) - 1 },
      undefined,
      undefined,
    ],
    ["bad signature", {}, other.privateKey, undefined],
    ["unknown key", {}, undefined, { alg: "RS256", kid: "unknown" }],
    [
      "algorithm confusion",
      {},
      other512.privateKey,
      { alg: "RS512", kid: "current" },
    ],
  ];
  for (const [label, claims, key, header] of cases)
    await t.test(label, async () => {
      const f = await oidcFixture();
      try {
        const result = await f.exchange(
          await f.seedPublisher(),
          await f.token(
            {
              ...claims,
              ...(label === "not yet valid"
                ? { nbf: Math.floor(Date.now() / 1000) + 60 }
                : {}),
              ...(label === "future issued"
                ? { iat: Math.floor(Date.now() / 1000) + 60 }
                : {}),
            },
            key,
            header,
          ),
        );
        assert.equal(result.statusCode, 401, result.body);
        assert.equal((await f.db("oidc_sessions")).length, 0);
      } finally {
        await f.close();
      }
    });
});

test("forks, renamed repository owners, pull requests and mismatched workflows cannot exchange", async (t) => {
  for (const claims of [
    { repository_id: "999" },
    { repository_owner_id: "999" },
    { ref: "refs/heads/untrusted" },
    { workflow_ref: "acme/plugin/.github/workflows/other.yml@refs/heads/main" },
    { event_name: "pull_request" },
    { event_name: "pull_request_target" },
    { event_name: undefined },
    { repository_id: ["123"] },
  ])
    await t.test(JSON.stringify(claims), async () => {
      const f = await oidcFixture();
      try {
        assert.equal(
          (await f.exchange(await f.seedPublisher(), await f.token(claims)))
            .statusCode,
          403,
        );
      } finally {
        await f.close();
      }
    });
});

test("credentials are product and tenant scoped, expire, and stop immediately on publisher revocation", async () => {
  const f = await oidcFixture();
  try {
    const id = await f.seedPublisher(),
      token = (await f.exchange(id, await f.token())).json().accessToken;
    const service = new OidcPublishing(f.db, f.config);
    assert.equal(await service.authorize(f.db, token, "primary", "plugin"), id);
    await assert.rejects(
      service.authorize(f.db, token, "primary", "other"),
      /do not permit/,
    );
    const other = await createTenant(f.db, {
      id: randomUUID(),
      slug: "other",
      name: "Other",
    });
    await assert.rejects(
      service.authorize(f.db, token, other.id, "plugin"),
      /do not permit/,
    );
    assert.equal(
      (await f.exchange(id, await f.token(), "other")).statusCode,
      403,
    );
    await f.db("oidc_sessions").update({ expires_at: Date.now() - 1 });
    await assert.rejects(
      service.authorize(f.db, token, "primary", "plugin"),
      /expired/,
    );
    await f.db("oidc_sessions").update({ expires_at: Date.now() + 300000 });
    await f
      .db("oidc_publishers")
      .where({ id })
      .update({ revoked_at: Date.now() });
    await assert.rejects(
      service.authorize(f.db, token, "primary", "plugin"),
      /revoked/,
    );
    assert.equal((await f.exchange(id, await f.token())).statusCode, 403);
    await assert.rejects(
      service.authorize(f.db, "DE-CI-bad", "primary", "plugin"),
      /Invalid CI/,
    );
  } finally {
    await f.close();
  }
});

test("publication rolls back when trust is revoked while storage is receiving the ZIP", async (t) => {
  const f = await oidcFixture();
  try {
    const id = await f.seedPublisher(),
      token = (await f.exchange(id, await f.token())).json().accessToken;
    const original = f.store.put.bind(f.store);
    t.mock.method(
      f.store,
      "put",
      async (...args: Parameters<typeof original>) => {
        await original(...args);
        await f
          .db("oidc_publishers")
          .where({ id })
          .update({ revoked_at: Date.now() });
      },
    );
    const result = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/releases/plugin/1.0.0",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/zip",
        "x-release-metadata": Buffer.from(
          '{"changelog":"CI release"}',
        ).toString("base64url"),
      },
      payload: zipBytes([
        {
          name: "plugin/plugin.php",
          data: "<?php\n/* Plugin Name: Plugin\nVersion: 1.0.0\n*/",
        },
      ]),
    });
    assert.equal(result.statusCode, 403, result.body);
    assert.equal((await f.db("releases")).length, 0);
    assert.equal((await f.db("upload_reservations")).length, 0);
  } finally {
    await f.close();
  }
});

test("custom operator providers support exact GitLab-style subjects and disabled providers fail closed", async () => {
  const f = await oidcFixture();
  try {
    const provider = {
      id: "gitlab",
      issuer: "https://gitlab.example.test",
      jwksUrl: "https://gitlab.example.test/oauth/discovery/keys",
      algorithms: ["RS256" as const],
    };
    const service = new OidcPublishing(
      f.db,
      { ...f.config, oidcProviders: [provider] },
      async () =>
        Response.json({
          keys: [await import("./helpers/oidc.ts").then((m) => m.jwk)],
        }),
    );
    const id = await f.seedPublisher({
      provider: provider.id,
      issuer: provider.issuer,
      subject: "project_path:acme/plugin:ref_type:branch:ref:main",
      claims: '{"project_id":"123","ref_protected":true}',
    });
    const identity = await f.token({
      iss: provider.issuer,
      sub: "project_path:acme/plugin:ref_type:branch:ref:main",
      project_id: "123",
      ref_protected: true,
    });
    const result = await service.exchange(
      (await f.db("tenants").where({ id: "primary" }).first())!,
      id,
      identity,
    );
    assert.equal(
      await service.authorize(f.db, result.accessToken, "primary", "plugin"),
      id,
    );
    const disabled = new OidcPublishing(f.db, {
      ...f.config,
      oidcProviders: [],
    });
    await assert.rejects(
      disabled.authorize(f.db, result.accessToken, "primary", "plugin"),
      /revoked/,
    );
    await assert.rejects(
      disabled.exchange(
        (await f.db("tenants").where({ id: "primary" }).first())!,
        id,
        identity,
      ),
      /disabled/,
    );
    assert.equal(publisherInput.provider, "github");
  } finally {
    await f.close();
  }
});

test("publisher policy validation, replacement and inventory preserve explicit trust boundaries", async () => {
  const f = await oidcFixture();
  try {
    const service = new OidcPublishing(f.db, f.config),
      tenant = (await f.db("tenants").where({ id: "primary" }).first())!;
    const allow = async () => {};
    await assert.rejects(
      service.create(
        tenant,
        f.userId,
        { ...publisherInput, provider: "unknown" },
        allow,
      ),
      { code: "oidc_provider" },
    );
    await assert.rejects(
      service.create(
        tenant,
        f.userId,
        { ...publisherInput, claims: {} },
        allow,
      ),
      { code: "oidc_github_claims" },
    );
    await assert.rejects(
      service.create(
        tenant,
        f.userId,
        { ...publisherInput, product: "missing" },
        allow,
      ),
      { code: "not_found" },
    );
    const { workflow_ref, ...claims } = publisherInput.claims;
    const created = await service.create(
      tenant,
      f.userId,
      {
        ...publisherInput,
        claims: { ...claims, job_workflow_ref: workflow_ref },
      },
      allow,
    );
    assert.equal(created.product_id, f.productId);
    const listed = await service.list(tenant);
    assert.equal(listed.publishers.length, 1);
    assert.equal(listed.publishers[0]!.claims.job_workflow_ref, workflow_ref);
    await service.revoke(tenant.id, f.userId, created.id, allow);
    await service.revoke(tenant.id, f.userId, created.id, allow);
    assert.equal(
      (await f.db("audit_events").where({ action: "oidc.publisher.revoked" }))
        .length,
      1,
    );
    await assert.rejects(
      service.revoke(tenant.id, f.userId, randomUUID(), allow),
      { code: "not_found" },
    );
    const stored = await f.db("oidc_publishers").first();
    await f.db.batchInsert(
      "oidc_publishers",
      Array.from({ length: 99 }, () => ({ ...stored, id: randomUUID() })),
      20,
    );
    await assert.rejects(
      service.create(tenant, f.userId, publisherInput, allow),
      { code: "oidc_publisher_limit" },
    );
  } finally {
    await f.close();
  }
});

test("concurrent exchanges serialize replay protection and expired markers can be reclaimed", async () => {
  const f = await oidcFixture();
  try {
    const id = await f.seedPublisher(),
      identity = await f.token();
    const results = await Promise.all([
      f.exchange(id, identity),
      f.exchange(id, identity),
    ]);
    assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 409]);
    await f
      .db("oidc_sessions")
      .update({ replay_until: Date.now() - 1, expires_at: Date.now() - 1 });
    assert.equal((await f.exchange(id, await f.token())).statusCode, 200);
    assert.equal((await f.db("oidc_sessions")).length, 1);
  } finally {
    await f.close();
  }
});

test("unavailable, oversized, empty or malformed JWKS responses fail without issuing credentials", async (t) => {
  for (const make of [
    () => new Response("redirect", { status: 302 }),
    () => new Response("x".repeat(256 * 1024 + 1)),
    () => new Response(null),
    () => Response.json({ keys: [] }),
    () => {
      throw Error("offline");
    },
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(Error("connection lost"));
          },
        }),
      ),
  ])
    await t.test(String(make).slice(0, 80), async () => {
      const f = await oidcFixture({ oidcFetch: async () => make() });
      try {
        const response = await f.exchange(
          await f.seedPublisher(),
          await f.token(),
        );
        assert.ok([401, 503].includes(response.statusCode), response.body);
        assert.equal((await f.db("oidc_sessions")).length, 0);
      } finally {
        await f.close();
      }
    });
});

test("token-supplied key URLs are ignored and revocation during key retrieval prevents exchange", async () => {
  let revoke: () => Promise<unknown> = async () => {};
  const f = await oidcFixture({
    oidcFetch: async (url, options) => {
      assert.equal(
        String(url),
        "https://token.actions.githubusercontent.com/.well-known/jwks",
      );
      assert.equal(options?.redirect, "error");
      await revoke();
      return Response.json({ keys: [jwk] });
    },
  });
  try {
    const id = await f.seedPublisher();
    revoke = () =>
      f.db("oidc_publishers").where({ id }).update({ revoked_at: Date.now() });
    const result = await f.exchange(
      id,
      await f.token({}, undefined, {
        alg: "RS256",
        kid: "current",
        jku: "https://attacker.test/keys",
      }),
    );
    assert.equal(result.statusCode, 403, result.body);
    assert.equal((await f.db("oidc_sessions")).length, 0);
  } finally {
    await f.close();
  }
});

test("native assets use the same scoped CI credentials and final authorization", async () => {
  const f = await oidcFixture();
  try {
    await f
      .db("products")
      .where({ id: f.productId })
      .update({ framework: "generic", framework_config: "{}" });
    const id = await f.seedPublisher(),
      accessToken = (await f.exchange(id, await f.token())).json().accessToken;
    const bytes = Buffer.from("native package bytes");
    const response = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/assets/plugin/1.0.0",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "x-release-metadata": Buffer.from(
          JSON.stringify({
            target: "linux-x64",
            filename: "plugin.bin",
            changelog: "CI build",
          }),
        ).toString("base64url"),
      },
      payload: bytes,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await f.db("release_assets")).length, 1);
  } finally {
    await f.close();
  }
});

test("issuer signing-key rotation refreshes the bounded cache without changing publisher trust", async (t) => {
  const rotated = await generateKeyPair("RS256");
  let served = [jwk],
    fetches = 0;
  const f = await oidcFixture({
    oidcFetch: async () => {
      fetches++;
      return Response.json({ keys: served });
    },
  });
  try {
    const id = await f.seedPublisher();
    assert.equal((await f.exchange(id, await f.token())).statusCode, 200);
    const newKey = {
      ...(await exportJWK(rotated.publicKey)),
      kid: "rotated",
      alg: "RS256",
      use: "sig",
    };
    served = [newKey];
    const identity = await f.token({}, rotated.privateKey, {
      alg: "RS256",
      kid: "rotated",
    });
    assert.equal((await f.exchange(id, identity)).statusCode, 401);
    assert.equal(
      fetches,
      1,
      "unknown key IDs cannot repeatedly fetch the provider within cooldown",
    );
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 31000);
    const refreshed = await f.exchange(id, identity);
    assert.equal(refreshed.statusCode, 200, refreshed.body);
    assert.equal(fetches, 2);
    assert.equal((await f.db("oidc_publishers")).length, 1);
  } finally {
    await f.close();
  }
});
