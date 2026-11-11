import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import {
  defaultOidcProviders,
  oidcProvidersSchema,
  publisherInputSchema,
} from "../src/oidc-schema.ts";
import {
  up as publishersUp,
  down as publishersDown,
} from "../src/migrations/019_oidc_publishing.ts";
import {
  up as factorsUp,
  down as factorsDown,
} from "../src/migrations/020_strong_reauthentication.ts";
import {
  up as policyUp,
  down as policyDown,
} from "../src/migrations/021_auth_capabilities.ts";
import { oidcFixture, publisherInput } from "./helpers/oidc.ts";
import { createTenant } from "../src/db.ts";
import { OidcPublishing } from "../src/oidc-publishing.ts";

test("operator provider configuration requires unique HTTPS issuers and asymmetric algorithm allowlists", () => {
  const credentials = {
    APP_SECRET: "ab".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
  };
  assert.deepEqual(loadConfig(credentials).oidcProviders, defaultOidcProviders);
  assert.deepEqual(
    loadConfig({ ...credentials, OIDC_PROVIDERS: "[]" }).oidcProviders,
    [],
  );
  const provider = defaultOidcProviders[0]!;
  for (const values of [
    [{ ...provider, issuer: "http://example.test" }],
    [{ ...provider, jwksUrl: "https://example.test/?secret=yes" }],
    [{ ...provider, issuer: "https://user:pass@example.test" }],
    [{ ...provider, issuer: "https://example.test/#fragment" }],
    [{ ...provider, algorithms: ["HS256"] }],
    [{ ...provider, algorithms: ["none"] }],
    [provider, provider],
    [provider, { ...provider, id: "another" }],
    [{ ...provider, id: "other", jwksUrl: "file:///keys" }],
  ])
    assert.throws(() => oidcProvidersSchema.parse(values));
  assert.throws(() =>
    loadConfig({ ...credentials, OIDC_PROVIDERS: "invalid" }),
  );
  assert.deepEqual(
    oidcProvidersSchema.parse([
      {
        id: "custom",
        issuer: "https://issuer.test",
        jwksUrl: "https://issuer.test/keys",
      },
    ])[0]!.algorithms,
    ["RS256"],
  );
});

test("publisher policies require exact subjects and bounded typed claims", () => {
  for (const values of [
    { subject: "repo:acme/*" },
    { subject: " padded " },
    { subject: "bad\nsubject" },
    { claims: { iss: "https://attacker.test" } },
    { claims: { aud: "anything" } },
    { claims: { repo: ["acme"] } },
    {
      claims: Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => [`claim${i}`, "value"]),
      ),
    },
    { jwksUrl: "https://attacker.test" },
  ])
    assert.throws(() =>
      publisherInputSchema.parse({ ...publisherInput, ...values }),
    );
  assert.deepEqual(
    publisherInputSchema.parse({
      name: "Generic",
      provider: "custom",
      product: "plugin",
      subject: "exact",
    }).claims,
    {},
  );
  assert.deepEqual(
    publisherInputSchema.parse({
      ...publisherInput,
      claims: { numeric: 123, protected: true },
    }).claims,
    { numeric: 123, protected: true },
  );
});

async function securitySchema(parent?: string) {
  const f = await oidcFixture({}, parent);
  try {
    const config = { ...f.config };
    delete config.oidcProviders;
    assert.deepEqual(
      new OidcPublishing(f.db, config).providers,
      defaultOidcProviders,
    );
    await publishersUp(f.db);
    await factorsUp(f.db);
    await policyUp(f.db);
    await assert.rejects(policyDown(), /Restore a backup/);
    const id = await f.seedPublisher();
    const other = await createTenant(f.db, {
      id: randomUUID(),
      slug: "other",
      name: "Other",
    });
    await assert.rejects(
      f.db("oidc_sessions").insert({
        id: "a".repeat(64),
        tenant_id: other.id,
        publisher_id: id,
        identity_hash: "b".repeat(64),
        expires_at: Date.now() + 300000,
        replay_until: Date.now() + 300000,
        created_at: Date.now(),
      }),
    );
    await assert.rejects(
      f.db("seller_factor_challenges").insert({
        id: randomUUID(),
        user_id: f.userId,
        session_hash: "wrong-session",
        kind: "enroll:passkey",
        payload: "sealed",
        created_at: Date.now(),
        expires_at: Date.now() + 300000,
      }),
    );
    await assert.rejects(publishersDown(), /backup/);
    await assert.rejects(factorsDown(), /backup/);
    assert.equal((await f.db("oidc_publishers")).length, 1);
  } finally {
    await f.close();
  }
}
test("additive security migrations are replayable, enforce tenant boundaries, and require backup reversal", () =>
  securitySchema());
for (const [engine, parent] of [
  ["PostgreSQL", process.env.TEST_OIDC_POSTGRES_DATABASE_URL],
  ["MySQL", process.env.TEST_OIDC_MYSQL_DATABASE_URL],
] as const)
  test(
    `OIDC security migrations preserve constraints on ${engine}`,
    { skip: !parent },
    () => securitySchema(parent),
  );
