import { randomUUID, generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { AuthProvisioner } from "../../src/auth-recovery.ts";
import { migrate, type DB } from "../../src/db.ts";
import { loadConfig } from "../../src/config.ts";
import { buildApp, type AppOptions } from "../../src/app.ts";
import { InMemoryArtifactStore } from "../../src/storage.ts";
import { pathToFileURL } from "node:url";
import { csrf, hash, random, seal } from "../../src/crypto.ts";
import { oidcAudience } from "../../src/oidc-schema.ts";
import { isolatedDatabase } from "./database.ts";

export const keys = await generateKeyPair("RS256");
export const jwk = {
  ...(await exportJWK(keys.publicKey)),
  kid: "current",
  alg: "RS256",
  use: "sig",
};
export const publisherInput = {
  name: "Release workflow",
  provider: "github",
  product: "plugin",
  subject: "repo:acme/plugin:ref:refs/heads/main",
  claims: {
    repository_id: "123",
    repository_owner_id: "456",
    ref: "refs/heads/main",
    workflow_ref: "acme/plugin/.github/workflows/release.yml@refs/heads/main",
  },
};

export async function oidcFixture(
  options: AppOptions = {},
  parent = process.env.TEST_SAAS_DATABASE_URL,
) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/oidc-case-");
  const { db, close } = await isolatedDatabase(`sqlite:${root}/db`, parent);
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "ab".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
    WORK_DIR: `${root}/work`,
    WEB_DIR: `${root}/web`,
  });
  await migrate(db);
  const userId = randomUUID(),
    session = random();
  await db("seller_users").insert({
    id: userId,
    email: "owner@example.test",
    verified_at: Date.now(),
    created_at: Date.now(),
  });
  await db("seller_sessions").insert({
    id: hash(session),
    user_id: userId,
    expires_at: Date.now() + 3600000,
  });
  await db("seller_memberships").insert({
    tenant_id: "primary",
    user_id: userId,
    role: "owner",
    created_at: Date.now(),
  });
  const productId = randomUUID();
  await db("products").insert({
    tenant_id: "primary",
    id: productId,
    slug: "plugin",
    name: "Plugin",
  });
  const store = new InMemoryArtifactStore();
  let fetches = 0;
  const factory: typeof buildApp = process.env.ENTITLE_TEST_SERVER_DIR
    ? (
        await import(
          pathToFileURL(`${process.env.ENTITLE_TEST_SERVER_DIR}/src/app.js`)
            .href
        )
      ).buildApp
    : buildApp;
  const app = await factory(config, db, undefined, {
    store,
    oidcFetch: async (url, init) => {
      fetches++;
      if (
        String(url) !==
          "https://token.actions.githubusercontent.com/.well-known/jwks" ||
        init?.redirect !== "error"
      )
        throw Error("Unexpected key request");
      return Response.json({ keys: [jwk] });
    },
    ...options,
  });
  await app.ready();
  const ownerHeaders = {
    cookie: `de-seller-session=${session}`,
    origin: config.origin,
    "x-csrf-token": csrf(session, config.secret),
  };
  const token = async (
    claims: Record<string, unknown> = {},
    signingKey = keys.privateKey,
    header: { alg: string; kid: string; jku?: string } = {
      alg: "RS256",
      kid: "current",
    },
  ) => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      iss: "https://token.actions.githubusercontent.com",
      sub: publisherInput.subject,
      aud: oidcAudience(config.origin, "primary"),
      iat: now,
      nbf: now - 1,
      exp: now + 300,
      jti: randomUUID(),
      event_name: "push",
      ...publisherInput.claims,
      ...claims,
    })
      .setProtectedHeader(header)
      .sign(signingKey);
  };
  const seedPublisher = async (values: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db("oidc_publishers").insert({
      id,
      tenant_id: "primary",
      product_id: productId,
      name: publisherInput.name,
      provider: "github",
      issuer: "https://token.actions.githubusercontent.com",
      subject: publisherInput.subject,
      claims: JSON.stringify(publisherInput.claims),
      created_at: Date.now(),
      ...values,
    });
    return id;
  };
  let ip = 0;
  const exchange = async (
    publisherId: string,
    identity: string,
    tenant = "primary",
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/tenants/${tenant}/oidc/token`,
      remoteAddress: `192.0.2.${++ip}`,
      headers: { authorization: `Bearer ${identity}` },
      payload: { publisherId },
    });
  const emailProof = async () => {
    const proof = random();
    await db("account_challenges").insert({
      id: randomUUID(),
      user_id: userId,
      session_hash: hash(session),
      purpose: "grant:security_enroll",
      token_hash: hash(proof),
      created_at: Date.now(),
      expires_at: Date.now() + 300000,
    });
    return proof;
  };
  return {
    db,
    root,
    app,
    store,
    config,
    userId,
    session,
    productId,
    ownerHeaders,
    token,
    seedPublisher,
    exchange,
    emailProof,
    fetches: () => fetches,
    close: async () => {
      await app.close();
      await close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

// CBOR subset for a real "none" attestation and a COSE EC2 public key.
function cbor(value: unknown): Buffer {
  const length = (major: number, size: number) =>
    size < 24
      ? Buffer.from([major * 32 + size])
      : size < 256
        ? Buffer.from([major * 32 + 24, size])
        : Buffer.from([major * 32 + 25, size >> 8, size & 255]);
  if (typeof value === "number")
    return length(value < 0 ? 1 : 0, value < 0 ? -1 - value : value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([length(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value))
    return Buffer.concat([length(2, value.length), value]);
  const entries =
    value instanceof Map ? [...value] : Object.entries(value as object);
  return Buffer.concat([
    length(5, entries.length),
    ...entries.flatMap(([key, v]) => [cbor(key), cbor(v)]),
  ]);
}
export function passkeyFixture(origin: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const cose = cbor(
    new Map<unknown, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  const id = random();
  const rpHash = createHash("sha256").update(new URL(origin).hostname).digest();
  function clientData(type: string, challenge: string, custom: object = {}) {
    return Buffer.from(JSON.stringify({ type, challenge, origin, ...custom }));
  }
  return {
    id,
    cose,
    registration(
      challenge: string,
      custom: object = {},
      badAttestation = false,
      flags = 0x45,
    ) {
      const data = clientData("webauthn.create", challenge, custom),
        credentialId = Buffer.from(id, "base64url");
      const len = Buffer.alloc(2);
      len.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        rpHash,
        Buffer.from([flags]),
        Buffer.alloc(4),
        Buffer.alloc(16),
        len,
        credentialId,
        cose,
      ]);
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: data.toString("base64url"),
          attestationObject: cbor({
            fmt: badAttestation ? "packed" : "none",
            attStmt: badAttestation
              ? {
                  alg: -7,
                  sig: sign(
                    "sha256",
                    Buffer.from("incorrect attestation message"),
                    privateKey,
                  ),
                }
              : {},
            authData,
          }).toString("base64url"),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      };
    },
    authentication(
      challenge: string,
      counter = 1,
      custom: object = {},
      flags = 5,
    ) {
      const data = clientData("webauthn.get", challenge, custom),
        count = Buffer.alloc(4);
      count.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([flags]), count]);
      const signed = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(data).digest()]),
        privateKey,
      );
      return {
        id,
        rawId: id,
        type: "public-key",
        response: {
          clientDataJSON: data.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: signed.toString("base64url"),
        },
        clientExtensionResults: {},
      };
    },
    async seed(db: DB, userId: string, secret: string) {
      await db("seller_factors").insert({
        id: randomUUID(),
        user_id: userId,
        kind: "passkey",
        name: "Test passkey",
        provenance: "ordinary",
        backup_eligible: 0,
        backed_up: 0,
        user_verified: 1,
        counter: 0,
        credential_hash: hash(id),
        payload: seal({ id, publicKey: cose.toString("base64url") }, secret),
        created_at: Date.now(),
      });
    },
  };
}

// Explicitly models the independently authenticated, physical-inventory provisioning step.
export async function provisionTestHardware(
  f: Awaited<ReturnType<typeof oidcFixture>>,
  key: ReturnType<typeof passkeyFixture>,
  inventoryId: string = randomUUID(),
) {
  const factor = await f
    .db("seller_factors")
    .where({ user_id: f.userId, credential_hash: hash(key.id) })
    .first();
  assertFactor(factor);
  await new AuthProvisioner(f.db, f.config.secret).approve({
    userId: f.userId,
    factorId: factor.id,
    publicKeyHash: hash(key.cose.toString("base64url")),
    inventoryId,
    operator: "fixture-host-operator",
    reference: "fixture-physical-inventory",
  });
  return factor.id as string;
}
function assertFactor(factor: unknown): asserts factor is { id: string } {
  if (!factor) throw Error("Seed or enroll the credential before provisioning");
}
export async function provisionTestPair(
  f: Awaited<ReturnType<typeof oidcFixture>>,
  key: ReturnType<typeof passkeyFixture>,
) {
  await provisionTestHardware(f, key);
  const backup = passkeyFixture(f.config.origin);
  await backup.seed(f.db, f.userId, f.config.secret);
  await provisionTestHardware(f, backup);
  return backup;
}

const capabilityKeys = new WeakMap<
  DB,
  Map<string, { key: ReturnType<typeof passkeyFixture>; counter: number }>
>();
export async function hardwareHeaders(
  f: {
    db: DB;
    config: { origin: string; secret: string };
    app: Awaited<ReturnType<typeof oidcFixture>>["app"];
  },
  headers: Record<string, string>,
  path: string,
  purpose = "api_keys",
) {
  const cookie = headers.cookie!.split("=").at(-1)!;
  const session = await f
    .db("seller_sessions")
    .where({ id: hash(cookie) })
    .first();
  let users = capabilityKeys.get(f.db);
  if (!users) {
    users = new Map();
    capabilityKeys.set(f.db, users);
  }
  let entry = users.get(session.user_id);
  if (!entry) {
    entry = { key: passkeyFixture(f.config.origin), counter: 0 };
    users.set(session.user_id, entry);
    for (const key of [entry.key, passkeyFixture(f.config.origin)]) {
      await key.seed(f.db, session.user_id, f.config.secret);
      const factor = await f
        .db("seller_factors")
        .where({ credential_hash: hash(key.id) })
        .first();
      await new AuthProvisioner(f.db, f.config.secret).approve({
        userId: session.user_id,
        factorId: factor.id,
        publicKeyHash: hash(key.cose.toString("base64url")),
        inventoryId: randomUUID(),
        operator: "fixture-host",
        reference: "fixture-inventory",
      });
    }
  }
  const options = await f.app.inject({
    method: "POST",
    url: "/api/v1/platform/account/reauth/options",
    headers,
    payload: { action: "account.privileged", purpose, path },
  });
  if (options.statusCode !== 200) throw Error(options.body);
  const result = await f.app.inject({
    method: "POST",
    url: "/api/v1/platform/account/reauth/verify",
    headers,
    payload: {
      challengeId: options.json().challengeId,
      response: entry.key.authentication(
        options.json().options.challenge,
        ++entry.counter,
      ),
    },
  });
  if (result.statusCode !== 200) throw Error(result.body);
  return {
    ...headers,
    "x-account-verification": result.json().verification as string,
  };
}
