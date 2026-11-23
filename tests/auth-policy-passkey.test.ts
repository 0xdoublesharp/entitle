import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import {
  oidcFixture,
  passkeyFixture,
  provisionTestHardware,
  publisherInput,
} from "./helpers/oidc.ts";
import { hash, random } from "../src/crypto.ts";
import { canonicalAuth } from "../src/auth-policy.ts";
import { PlatformAuth } from "../src/platform-auth.ts";
import { AccountManagement } from "../src/account-management.ts";

// PRIVILEGED_AUTH_POLICY=passkey: self-serve deployments accept any user-verified
// passkey for privileged actions, without operator-provisioned hardware.
type Fixture = Awaited<ReturnType<typeof oidcFixture>>;
const account = "/api/v1/platform/account";
const keysPath = "/api/v1/tenants/primary/seller/keys";
const oidcCreate = {
  action: "oidc.create",
  tenant: "primary",
  publisher: publisherInput,
};
// UP | UV | BE | BS: a synced, backed-up multi-device passkey.
const syncedFlags = 0x1d;

async function synced(f: Fixture) {
  const key = passkeyFixture(f.config.origin);
  await key.seed(f.db, f.userId, f.config.secret);
  const factor = f
    .db("seller_factors")
    .where({ credential_hash: hash(key.id) });
  await factor.clone().update({ backup_eligible: 1, backed_up: 1 });
  let counter = 0;
  return {
    key,
    factorId: (await factor.first()).id as string,
    proof: (intent: object) => proof(f, key, intent, ++counter, syncedFlags),
  };
}
async function proof(
  f: Fixture,
  key: ReturnType<typeof passkeyFixture>,
  intent: object,
  counter: number,
  flags = 5,
) {
  const start = await f.app.inject({
    method: "POST",
    url: `${account}/reauth/options`,
    headers: f.ownerHeaders,
    payload: intent,
  });
  assert.equal(start.statusCode, 200, start.body);
  return f.app.inject({
    method: "POST",
    url: `${account}/reauth/verify`,
    headers: f.ownerHeaders,
    payload: {
      challengeId: start.json().challengeId,
      response: key.authentication(
        start.json().options.challenge,
        counter,
        {},
        flags,
      ),
    },
  });
}
async function status(f: Fixture) {
  const result = await f.app.inject({
    url: `${account}/security`,
    headers: f.ownerHeaders,
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
function sellerRequest(f: Fixture, url: string, verification: string) {
  return {
    url,
    cookies: { "de-seller-session": f.session },
    headers: { ...f.ownerHeaders, "x-account-verification": verification },
  } as unknown as FastifyRequest;
}
async function grant(f: Fixture, factorId: string, intent: object) {
  const value = random();
  await f.db("account_challenges").insert({
    id: randomUUID(),
    user_id: f.userId,
    session_hash: hash(f.session),
    purpose: "strong",
    token_hash: hash(value),
    second_hash: hash(canonicalAuth(intent)),
    auth_generation: 0,
    factor_id: factorId,
    created_at: Date.now(),
    expires_at: Date.now() + 300000,
  });
  return value;
}
const privileged = (purpose: string, path = keysPath) => ({
  action: "account.privileged",
  purpose,
  path,
});

test("hardware policy remains the default and reports itself", async () => {
  const f = await oidcFixture();
  try {
    assert.equal(f.config.privilegedAuthPolicy, "hardware");
    const key = await synced(f);
    const state = await status(f);
    assert.equal(state.privilegedPolicy, "hardware");
    assert.equal(state.privilegedReady, false);
    const denied = await key.proof(oidcCreate);
    assert.equal(denied.json().error.code, "hardware_required", denied.body);
    await assert.rejects(
      new PlatformAuth(f.db, f.config).capabilityAuthorization(
        {
          url: keysPath,
          cookies: { "de-seller-session": f.session },
          headers: f.ownerHeaders,
        } as unknown as FastifyRequest,
        "api_keys",
      ),
      {
        code: "reauth_required",
        message: "Fresh hardware verification is required.",
      },
    );
    delete f.config.privilegedAuthPolicy;
    assert.equal((await status(f)).privilegedPolicy, "hardware");
  } finally {
    await f.close();
  }
});

test("passkey policy lets a synced passkey authorize OIDC trust, API keys and publication", async () => {
  const f = await oidcFixture();
  try {
    f.config.privilegedAuthPolicy = "passkey";
    assert.equal((await status(f)).privilegedReady, false, "no credential yet");
    const key = await synced(f);
    const state = await status(f);
    assert.equal(state.privilegedPolicy, "passkey");
    assert.equal(state.privilegedReady, true);
    assert.equal(state.factors[0].hardwareApproved, false);

    const trust = await key.proof(oidcCreate);
    assert.equal(trust.statusCode, 200, trust.body);
    const created = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/oidc/publishers",
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": trust.json().verification,
      },
      payload: publisherInput,
    });
    assert.equal(created.statusCode, 200, created.body);

    const keyProof = await key.proof(privileged("api_keys"));
    assert.equal(keyProof.statusCode, 200, keyProof.body);
    const apiKey = await f.app.inject({
      method: "POST",
      url: keysPath,
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": keyProof.json().verification,
      },
      payload: { name: "CI" },
    });
    assert.equal(apiKey.statusCode, 200, apiKey.body);

    // Browser publication authorizes through PlatformAuth.capabilityAuthorization.
    const auth = new PlatformAuth(f.db, f.config);
    const path = "/api/v1/tenants/primary/seller/releases/plugin/1.0.0";
    const publish = await key.proof(privileged("release_publish", path));
    assert.equal(publish.statusCode, 200, publish.body);
    const authorize = await auth.capabilityAuthorization(
      sellerRequest(f, path, publish.json().verification),
      "release_publish",
    );
    await f.db.transaction((tx) => authorize(tx));
    // A missing proof names the factor this policy accepts, not hardware.
    await assert.rejects(
      auth.capabilityAuthorization(
        {
          url: path,
          cookies: { "de-seller-session": f.session },
          headers: f.ownerHeaders,
        } as unknown as FastifyRequest,
        "release_publish",
      ),
      {
        code: "reauth_required",
        message: "Fresh passkey or security-key verification is required.",
      },
    );

    // Account step-up for privileged purposes uses the same policy.
    const step = await key.proof(privileged("api_keys", "/step-up"));
    const accounts = new AccountManagement(f.db, auth);
    assert.equal(
      await accounts.withStepUp(
        sellerRequest(f, "/step-up", ""),
        "api_keys",
        step.json().verification,
        async () => "authorized",
      ),
      "authorized",
    );
  } finally {
    await f.close();
  }
});

test("passkey policy still refuses email verification, restricted accounts and unverified credentials", async () => {
  const f = await oidcFixture();
  try {
    f.config.privilegedAuthPolicy = "passkey";
    const key = await synced(f);
    const auth = new PlatformAuth(f.db, f.config);
    const accounts = new AccountManagement(f.db, auth);
    const stepUp = (verification: string) =>
      accounts.withStepUp(
        sellerRequest(f, keysPath, verification),
        "api_keys",
        verification,
        async () => undefined,
      );
    // Email verification is never a strong capability proof.
    await assert.rejects(stepUp(await f.emailProof()), {
      code: "reauth_required",
    });
    const email = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/oidc/publishers",
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": await f.emailProof(),
      },
      payload: publisherInput,
    });
    assert.equal(email.json().error.code, "reauth_required", email.body);

    for (const restriction of ["recovered_ordinary", "privileged_suspended"]) {
      await f
        .db("seller_users")
        .where({ id: f.userId })
        .update({ [restriction]: 1 });
      assert.equal((await status(f)).privilegedReady, false, restriction);
      const denied = await key.proof(oidcCreate);
      assert.equal(
        denied.json().error.code,
        "recovery_restricted",
        restriction,
      );
      await assert.rejects(
        stepUp(await grant(f, key.factorId, privileged("api_keys"))),
        { code: "recovery_restricted" },
      );
      await f
        .db("seller_users")
        .where({ id: f.userId })
        .update({ [restriction]: 0 });
    }

    // A stored credential that never proved user verification is not eligible.
    await f
      .db("seller_factors")
      .where({ id: key.factorId })
      .update({ user_verified: 0 });
    assert.equal((await status(f)).privilegedReady, false);
    await assert.rejects(
      stepUp(await grant(f, key.factorId, privileged("api_keys"))),
      { code: "passkey_required" },
    );
  } finally {
    await f.close();
  }
});

test("passkey policy keeps an operator-approved hardware key removable only by another approved key", async () => {
  const f = await oidcFixture();
  try {
    f.config.privilegedAuthPolicy = "passkey";
    const key = await synced(f);
    const hardware = passkeyFixture(f.config.origin);
    await hardware.seed(f.db, f.userId, f.config.secret);
    const approvedId = await provisionTestHardware(f, hardware);
    const state = await status(f);
    assert.equal(state.privilegedReady, true);
    assert.deepEqual(
      state.factors
        .filter(
          (factor: { hardwareApproved: boolean }) => factor.hardwareApproved,
        )
        .map((factor: { id: string }) => factor.id),
      [approvedId],
    );
    const denied = await key.proof({
      action: "security.remove",
      factorId: approvedId,
    });
    assert.equal(denied.json().error.code, "hardware_required", denied.body);
    // The approved key itself also satisfies passkey-mode privileged actions.
    const trust = await proof(f, hardware, oidcCreate, 1);
    assert.equal(trust.statusCode, 200, trust.body);
    // Ordinary passkeys remain removable with any current credential.
    const removal = await proof(
      f,
      hardware,
      { action: "security.remove", factorId: key.factorId },
      2,
    );
    assert.equal(removal.statusCode, 200, removal.body);
  } finally {
    await f.close();
  }
});
