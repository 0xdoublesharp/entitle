import test from "node:test";
import assert from "node:assert/strict";
import {
  oidcFixture,
  passkeyFixture,
  publisherInput,
  provisionTestPair,
  provisionTestHardware,
} from "./helpers/oidc.ts";
import { csrf, hash, random, unseal } from "../src/crypto.ts";

import { AuthProvisioner } from "../src/auth-recovery.ts";

const account = "/api/v1/platform/account";
const intent = {
  action: "oidc.create",
  tenant: "primary",
  publisher: publisherInput,
  provisionTestPair,
  provisionTestHardware,
};

test("AUTH-07: an email-bootstrap key labelled security_key cannot create publisher trust", async () => {
  const f = await oidcFixture();
  const post = (path: string, payload: object, extra = {}) =>
    f.app.inject({
      method: "POST",
      url: `${account}${path}`,
      headers: { ...f.ownerHeaders, ...extra },
      payload,
    });
  try {
    const key = passkeyFixture(f.config.origin);
    const start = await post(
      "/security/passkey/enroll",
      { name: "Label is not assurance", kind: "security_key" },
      { "x-account-verification": await f.emailProof() },
    );
    assert.equal(start.statusCode, 200, start.body);
    const done = await post("/security/passkey/confirm", {
      challengeId: start.json().challengeId,
      response: key.registration(start.json().options.challenge),
    });
    assert.equal(done.statusCode, 200, done.body);
    const options = await post("/reauth/options", intent);
    if (options.statusCode === 403) return;
    assert.equal(options.statusCode, 200, options.body);
    const proof = await post("/reauth/verify", {
      challengeId: options.json().challengeId,
      response: key.authentication(options.json().options.challenge),
    });
    if (proof.statusCode === 403) return;
    assert.equal(proof.statusCode, 200, proof.body);
    const result = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/oidc/publishers",
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": proof.json().verification,
      },
      payload: publisherInput,
    });
    assert.equal(
      result.statusCode,
      403,
      "Email bootstrap must not manufacture privileged assurance",
    );
  } finally {
    await f.close();
  }
});

test("AUTH-07: recovery codes begin restricted recovery, without exposing ordinary account data", async () => {
  const f = await oidcFixture();
  try {
    const code = random();
    await f.db("account_recovery_codes").insert({
      id: hash(`recovery:${f.userId}:${code}`),
      user_id: f.userId,
      created_at: Date.now(),
    });
    const started = await f.app.inject({
      method: "POST",
      url: `${account}/recovery/start`,
      headers: { origin: f.config.origin },
      payload: {},
    });
    const browser = started.cookies.find(
      (c) => c.name === "de-account-recovery",
    )!;
    const result = await f.app.inject({
      method: "POST",
      url: `${account}/recovery/consume`,
      headers: {
        origin: f.config.origin,
        cookie: `de-account-recovery=${browser.value}`,
      },
      payload: { email: "owner@example.test", code },
    });
    assert.equal(result.statusCode, 200, result.body);
    const session = result.cookies.find((c) => c.name === "de-seller-session")!;
    const read = await f.app.inject({
      url: "/api/v1/platform/me",
      headers: { cookie: `de-seller-session=${session.value}` },
    });
    assert.equal(
      read.statusCode,
      403,
      "A saved code alone must not mint a full account session",
    );
  } finally {
    await f.close();
  }
});

test("AUTH-07: a failed WebAuthn finish consumes its challenge", async () => {
  const f = await oidcFixture();
  try {
    const key = passkeyFixture(f.config.origin);
    await key.seed(f.db, f.userId, f.config.secret);
    const options = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers: f.ownerHeaders,
      payload: { action: "security.manage" },
    });
    assert.equal(options.statusCode, 200, options.body);
    const assertion = key.authentication(options.json().options.challenge);
    const wrong = {
      ...assertion,
      response: { ...assertion.response, signature: random() },
    };
    const verify = (response: object) =>
      f.app.inject({
        method: "POST",
        url: `${account}/reauth/verify`,
        headers: f.ownerHeaders,
        payload: { challengeId: options.json().challengeId, response },
      });
    assert.equal((await verify(wrong)).statusCode, 403);
    assert.equal(
      (await verify(assertion)).statusCode,
      403,
      "A failed finish cannot be replayed with a different assertion",
    );
  } finally {
    await f.close();
  }
});

// These use real signatures and explicit host approvals; no factor label establishes hardware.
async function proofFor(
  f: Awaited<ReturnType<typeof oidcFixture>>,
  key: ReturnType<typeof passkeyFixture>,
  action: object,
  headers = f.ownerHeaders,
  counter = 1,
) {
  const start = await f.app.inject({
    method: "POST",
    url: `${account}/reauth/options`,
    headers,
    payload: action,
  });
  assert.equal(start.statusCode, 200, start.body);
  return f.app.inject({
    method: "POST",
    url: `${account}/reauth/verify`,
    headers,
    payload: {
      challengeId: start.json().challengeId,
      response: key.authentication(start.json().options.challenge, counter),
    },
  });
}
async function enrollRecovery(
  f: Awaited<ReturnType<typeof oidcFixture>>,
  headers: typeof f.ownerHeaders,
  key = passkeyFixture(f.config.origin),
) {
  const start = await f.app.inject({
    method: "POST",
    url: `${account}/security/passkey/enroll`,
    headers,
    payload: { name: "Replacement", kind: "security_key" },
  });
  assert.equal(start.statusCode, 200, start.body);
  const done = await f.app.inject({
    method: "POST",
    url: `${account}/security/passkey/confirm`,
    headers,
    payload: {
      challengeId: start.json().challengeId,
      response: key.registration(start.json().options.challenge),
    },
  });
  assert.equal(done.statusCode, 200, done.body);
  return { key, factorId: done.json().id as string };
}
function recoveryHeaders(
  f: Awaited<ReturnType<typeof oidcFixture>>,
  response: { cookies: { name: string; value: string }[] },
) {
  const cookie = response.cookies.find(
    (c) => c.name === "de-seller-session",
  )!.value;
  return {
    origin: f.config.origin,
    cookie: `de-seller-session=${cookie}`,
    "x-csrf-token": csrf(cookie, f.config.secret),
  };
}
async function ordinaryRecovery(f: Awaited<ReturnType<typeof oidcFixture>>) {
  const code = random();
  await f.db("account_recovery_codes").insert({
    id: hash(`recovery:${f.userId}:${code}`),
    user_id: f.userId,
    created_at: Date.now(),
  });
  const start = await f.app.inject({
    method: "POST",
    url: `${account}/recovery/start`,
    headers: { origin: f.config.origin },
    payload: {},
  });
  const browser = start.cookies.find((c) => c.name === "de-account-recovery")!;
  const response = await f.app.inject({
    method: "POST",
    url: `${account}/recovery/consume`,
    headers: {
      origin: f.config.origin,
      cookie: `de-account-recovery=${browser.value}`,
    },
    payload: { email: "owner@example.test", code },
  });
  assert.equal(response.statusCode, 200, response.body);
  return recoveryHeaders(f, response);
}
async function verifyChannel(
  f: Awaited<ReturnType<typeof oidcFixture>>,
  headers: typeof f.ownerHeaders,
) {
  const post = (path: string, payload: object) =>
    f.app.inject({
      method: "POST",
      url: `${account}${path}`,
      headers,
      payload,
    });
  assert.equal((await post("/recovery/channel/request", {})).statusCode, 200);
  const emails = await f
    .db("platform_emails")
    .where({ kind: "account_verification" });
  const text = unseal<{ text: string }>(
    emails.at(-1)!.payload,
    f.config.secret,
  ).text;
  const token = text.split(": ").at(-1)!;
  assert.equal(
    (await post("/recovery/channel/consume", { token })).statusCode,
    200,
  );
  assert.equal(
    (await post("/recovery/channel/consume", { token })).statusCode,
    403,
  );
}

test("AUTH-07: ordinary recovery completes with separate channel and new key; descendants remain privilege restricted", async () => {
  const f = await oidcFixture();
  try {
    const original = passkeyFixture(f.config.origin);
    await original.seed(f.db, f.userId, f.config.secret);
    await provisionTestPair(f, original);
    await f
      .db("seller_users")
      .where({ id: f.userId })
      .update({ email_login_disabled: 1 });
    const publisher = await f.seedPublisher();
    const headers = await ordinaryRecovery(f);
    const post = (path: string, payload: object, proof?: string) =>
      f.app.inject({
        method: "POST",
        url: `${account}${path}`,
        headers: {
          ...headers,
          ...(proof ? { "x-account-verification": proof } : {}),
        },
        payload,
      });
    assert.equal(
      (await post("/security/passkey/enroll", { name: "Too early" }))
        .statusCode,
      403,
    );
    assert.equal((await post("/recovery/complete", {})).statusCode, 403);
    await verifyChannel(f, headers);
    const { key, factorId } = await enrollRecovery(f, headers);
    assert.equal((await proofFor(f, key, intent, headers)).statusCode, 403);
    await assert.rejects(provisionTestHardware(f, key), /Ordinary recovery/);
    const status = await f.app.inject({
      url: `${account}/recovery/status`,
      headers,
    });
    const flowId = status.json().id;
    const proof = await proofFor(
      f,
      key,
      { action: "security.recovery_complete", flowId },
      headers,
      2,
    );
    assert.equal(proof.statusCode, 200, proof.body);
    const complete = await post(
      "/recovery/complete",
      {},
      proof.json().verification,
    );
    assert.equal(complete.statusCode, 200, complete.body);
    assert.equal((await f.db("seller_factors")).length, 1);
    assert.equal((await f.db("seller_factors").first()).id, factorId);
    assert.ok(
      (await f.db("oidc_publishers").where({ id: publisher }).first())
        .revoked_at,
    );
    assert.equal((await f.db("seller_sessions")).length, 0);
    assert.equal((await f.db("account_recovery_codes")).length, 0);
    // Sign in with the actual replacement credential while email remains disabled.
    const loginStart = await f.app.inject({
      method: "POST",
      url: "/api/v1/platform/auth/passkey/options",
      headers: { origin: f.config.origin },
      payload: {},
    });
    const loginCookie = loginStart.cookies[0]!;
    const login = await f.app.inject({
      method: "POST",
      url: "/api/v1/platform/auth/passkey/verify",
      headers: {
        origin: f.config.origin,
        cookie: `${loginCookie.name}=${loginCookie.value}`,
      },
      payload: {
        response: key.authentication(loginStart.json().options.challenge, 3),
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const ordinaryHeaders = recoveryHeaders(f, login);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/v1/platform/me",
          headers: ordinaryHeaders,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await proofFor(f, key, intent, ordinaryHeaders, 4)).statusCode,
      403,
    );
    assert.equal((await f.db("seller_users").first()).recovered_ordinary, 1);
  } finally {
    await f.close();
  }
});

test("AUTH-07: independent infrastructure recovery restores privileges after delay and two inventoried replacement keys", async () => {
  const f = await oidcFixture();
  try {
    const root = new AuthProvisioner(f.db, f.config.secret);
    const flow = await root.start(f.userId, "host-operator", "incident-123");
    const redeem = await f.app.inject({
      method: "POST",
      url: `${account}/recovery/operator`,
      headers: { origin: f.config.origin },
      payload: { token: flow.permit },
    });
    assert.equal(redeem.statusCode, 200, redeem.body);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${account}/recovery/operator`,
          headers: { origin: f.config.origin },
          payload: { token: flow.permit },
        })
      ).statusCode,
      401,
    );
    const headers = recoveryHeaders(f, redeem);
    const a = await enrollRecovery(f, headers),
      b = await enrollRecovery(f, headers);
    await provisionTestHardware(f, a.key, "physical-key-one");
    await assert.rejects(
      root.complete(flow.id, "host-operator", "incident-123"),
      /objection period/,
    );
    await f
      .db("auth_recoveries")
      .where({ id: flow.id })
      .update({ not_before: Date.now() - 1 });
    await assert.rejects(
      root.complete(flow.id, "host-operator", "incident-123"),
      /two independent/,
    );
    await assert.rejects(
      provisionTestHardware(f, b.key, "physical-key-one"),
      /distinct inventoried/,
    );
    await provisionTestHardware(f, b.key, "physical-key-two");
    const denied = await f.app.inject({
      method: "POST",
      url: `${account}/recovery/complete`,
      headers,
      payload: {},
    });
    assert.equal(denied.statusCode, 403);
    await root.complete(flow.id, "host-operator", "incident-123");
    const user = await f.db("seller_users").first();
    assert.equal(user.recovered_ordinary, 0);
    const session = random();
    await f.db("seller_sessions").insert({
      id: hash(session),
      user_id: f.userId,
      auth_generation: user.security_generation,
      expires_at: Date.now() + 3600000,
    });
    const newHeaders = {
      ...headers,
      cookie: `de-seller-session=${session}`,
      "x-csrf-token": csrf(session, f.config.secret),
    };
    const proof = await proofFor(f, a.key, intent, newHeaders);
    assert.equal(proof.statusCode, 200, proof.body);
    const create = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/oidc/publishers",
      headers: {
        ...newHeaders,
        "x-account-verification": proof.json().verification,
      },
      payload: publisherInput,
    });
    assert.equal(create.statusCode, 200, create.body);
    await assert.rejects(
      root.complete(flow.id, "host-operator", "replay"),
      /no longer active/,
    );
  } finally {
    await f.close();
  }
});

test("AUTH-07: hardware checks ignore labels, bind fingerprints and recheck assurance at commit", async () => {
  const f = await oidcFixture();
  try {
    const key = passkeyFixture(f.config.origin);
    await key.seed(f.db, f.userId, f.config.secret);
    const id = (
      await f
        .db("seller_factors")
        .where({ credential_hash: hash(key.id) })
        .first()
    ).id;
    const root = new AuthProvisioner(f.db, f.config.secret);
    const input = {
      userId: f.userId,
      factorId: id,
      publicKeyHash: hash(key.cose.toString("base64url")),
      inventoryId: "one",
      operator: "host",
      reference: "inventory",
    };
    await assert.rejects(
      root.approve({ ...input, publicKeyHash: "wrong" }),
      /fingerprint/,
    );
    for (const attrs of [
      { backup_eligible: null },
      { backup_eligible: 1 },
      { user_verified: 0 },
      { backed_up: 1 },
    ]) {
      await f
        .db("seller_factors")
        .where({ id })
        .update({
          backup_eligible: 0,
          backed_up: 0,
          user_verified: 1,
          ...attrs,
          kind: "security_key",
        });
      await assert.rejects(root.approve(input), /non-backup-eligible/);
    }
    await f.db("seller_factors").where({ id }).update({
      backup_eligible: 0,
      backed_up: 0,
      user_verified: 1,
      kind: "passkey",
    });
    await root.approve(input);
    assert.equal(
      (await proofFor(f, key, intent)).statusCode,
      403,
      "One approved key cannot activate publisher trust",
    );
    const backup = passkeyFixture(f.config.origin);
    await backup.seed(f.db, f.userId, f.config.secret);
    await provisionTestHardware(f, backup);
    const proof = await proofFor(f, key, intent, f.ownerHeaders, 2);
    assert.equal(proof.statusCode, 200, proof.body);
    await f
      .db("auth_hardware_approvals")
      .where({ factor_id: id })
      .update({ public_key_hash: "tampered" });
    const create = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/oidc/publishers",
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": proof.json().verification,
      },
      payload: publisherInput,
    });
    assert.equal(create.statusCode, 403);
    for (const purpose of ["api_keys", "release_publish", "workspace_remove"]) {
      const email = await f.app.inject({
        method: "POST",
        url: `${account}/verification/request`,
        headers: f.ownerHeaders,
        payload: { purpose },
      });
      assert.equal(email.statusCode, 403, purpose);
    }
  } finally {
    await f.close();
  }
});

test("AUTH-07: canceling recovery preserves original credentials and removes recovery credentials and grants", async () => {
  const f = await oidcFixture();
  try {
    const key = passkeyFixture(f.config.origin);
    await key.seed(f.db, f.userId, f.config.secret);
    const headers = await ordinaryRecovery(f);
    await verifyChannel(f, headers);
    const replacement = await enrollRecovery(f, headers);
    const status = await f.app.inject({
      url: `${account}/recovery/status`,
      headers,
    });
    const flowId = status.json().id;
    const proof = await proofFor(f, key, {
      action: "security.recovery_cancel",
      flowId,
    });
    assert.equal(proof.statusCode, 200, proof.body);
    const cancel = await f.app.inject({
      method: "POST",
      url: `${account}/recovery/cancel`,
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": proof.json().verification,
      },
      payload: { flowId },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(
      await f.db("seller_factors").where({ id: replacement.factorId }).first(),
      undefined,
    );
    assert.equal((await f.db("seller_factors")).length, 1);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/v1/platform/me",
          headers: f.ownerHeaders,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await f.app.inject({ url: `${account}/recovery/status`, headers }))
        .statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test("AUTH-07: a remaining independently provisioned key can revoke hardware; removed-key sessions and publishing grants end", async () => {
  const f = await oidcFixture();
  try {
    const key = passkeyFixture(f.config.origin);
    await key.seed(f.db, f.userId, f.config.secret);
    const backup = await provisionTestPair(f, key);
    const factor = await f
      .db("seller_factors")
      .where({ credential_hash: hash(key.id) })
      .first();
    await f
      .db("seller_sessions")
      .where({ id: hash(f.session) })
      .update({ auth_factor_id: factor.id });
    const publisher = await f.seedPublisher();
    const self = await proofFor(f, key, {
      action: "security.remove",
      factorId: factor.id,
    });
    assert.equal(self.statusCode, 403);
    const proof = await proofFor(f, backup, {
      action: "security.remove",
      factorId: factor.id,
    });
    assert.equal(proof.statusCode, 200, proof.body);
    const removed = await f.app.inject({
      method: "POST",
      url: `${account}/security/factors/${factor.id}/remove`,
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": proof.json().verification,
      },
      payload: {},
    });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(
      (
        await f.app.inject({
          url: "/api/v1/platform/me",
          headers: f.ownerHeaders,
        })
      ).statusCode,
      401,
    );
    assert.equal((await f.db("seller_factors")).length, 1);
    assert.ok(
      (await f.db("oidc_publishers").where({ id: publisher }).first())
        .revoked_at,
    );
  } finally {
    await f.close();
  }
});

test("AUTH-07: original-key changes cancel unfinished recovery; stale restricted ceremonies cannot resurrect it", async () => {
  const f = await oidcFixture();
  try {
    const original = passkeyFixture(f.config.origin);
    await original.seed(f.db, f.userId, f.config.secret);
    const headers = await ordinaryRecovery(f);
    await verifyChannel(f, headers);
    const replacement = await enrollRecovery(f, headers);
    const before = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers,
      payload: {
        action: "security.recovery_complete",
        flowId: (await f.db("auth_recoveries").first()).id,
      },
    });
    const proof = await proofFor(f, original, { action: "security.manage" });
    const start = await f.app.inject({
      method: "POST",
      url: `${account}/security/passkey/enroll`,
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": proof.json().verification,
      },
      payload: { name: "Original-holder replacement" },
    });
    const next = passkeyFixture(f.config.origin);
    const done = await f.app.inject({
      method: "POST",
      url: `${account}/security/passkey/confirm`,
      headers: f.ownerHeaders,
      payload: {
        challengeId: start.json().challengeId,
        response: next.registration(start.json().options.challenge),
      },
    });
    assert.equal(done.statusCode, 200, done.body);
    assert.equal((await f.db("auth_recoveries").first()).state, "canceled");
    assert.equal(
      await f.db("seller_factors").where({ id: replacement.factorId }).first(),
      undefined,
    );
    const stale = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/verify`,
      headers,
      payload: {
        challengeId: before.json().challengeId,
        response: replacement.key.authentication(
          before.json().options.challenge,
        ),
      },
    });
    assert.equal(stale.statusCode, 401);
    assert.equal((await f.db("seller_users").first()).privileged_suspended, 0);
  } finally {
    await f.close();
  }
});

test("AUTH-07: signed backup flags cannot relabel a synced credential as hardware or change enrolled eligibility", async () => {
  const f = await oidcFixture();
  try {
    const key = passkeyFixture(f.config.origin);
    await key.seed(f.db, f.userId, f.config.secret);
    await provisionTestPair(f, key);
    const options = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers: f.ownerHeaders,
      payload: intent,
    });
    const changed = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/verify`,
      headers: f.ownerHeaders,
      payload: {
        challengeId: options.json().challengeId,
        response: key.authentication(
          options.json().options.challenge,
          1,
          {},
          29,
        ),
      },
    });
    assert.equal(changed.statusCode, 403);
    assert.equal(changed.json().error.code, "credential_properties_changed");
    const factor = await f
      .db("seller_factors")
      .where({ credential_hash: hash(key.id) })
      .first();
    await f
      .db("seller_factors")
      .where({ id: factor.id })
      .update({ backup_eligible: 1, kind: "security_key" });
    assert.equal(
      (await proofFor(f, key, intent)).statusCode,
      403,
      "A non-backup assertion cannot downgrade a synced registration",
    );
    await f
      .db("seller_factors")
      .where({ id: factor.id })
      .update({ backup_eligible: 0, backed_up: null });
    const status = await f.app.inject({
      url: `${account}/security`,
      headers: f.ownerHeaders,
    });
    assert.equal(
      status.json().privilegedReady,
      false,
      "Unknown hardware backup state fails closed",
    );
  } finally {
    await f.close();
  }
});

test("AUTH-07: synced passkeys and migrated credentials retain ordinary sign-in without acquiring hardware assurance", async () => {
  const f = await oidcFixture();
  try {
    const key = passkeyFixture(f.config.origin);
    const start = await f.app.inject({
      method: "POST",
      url: `${account}/security/passkey/enroll`,
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": await f.emailProof(),
      },
      payload: { name: "Synced key", kind: "security_key" },
    });
    const done = await f.app.inject({
      method: "POST",
      url: `${account}/security/passkey/confirm`,
      headers: f.ownerHeaders,
      payload: {
        challengeId: start.json().challengeId,
        response: key.registration(
          start.json().options.challenge,
          {},
          false,
          0x5d,
        ),
      },
    });
    assert.equal(done.statusCode, 200, done.body);
    const factor = await f
      .db("seller_factors")
      .where({ id: done.json().id })
      .first();
    assert.equal(factor.backup_eligible, 1);
    assert.equal(factor.backed_up, 1);
    const assertion = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers: f.ownerHeaders,
      payload: { action: "security.manage" },
    });
    const ordinary = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/verify`,
      headers: f.ownerHeaders,
      payload: {
        challengeId: assertion.json().challengeId,
        response: key.authentication(
          assertion.json().options.challenge,
          1,
          {},
          29,
        ),
      },
    });
    assert.equal(ordinary.statusCode, 200, ordinary.body);
    await assert.rejects(provisionTestHardware(f, key), /non-backup-eligible/);
    // A pre-migration credential has unknown properties until a verified assertion.
    await f
      .db("seller_factors")
      .where({ id: factor.id })
      .update({ backup_eligible: null, backed_up: null });
    const options = await f.app.inject({
      method: "POST",
      url: "/api/v1/platform/auth/passkey/options",
      headers: { origin: f.config.origin },
      payload: {},
    });
    const cookie = options.cookies[0]!;
    const login = await f.app.inject({
      method: "POST",
      url: "/api/v1/platform/auth/passkey/verify",
      headers: {
        origin: f.config.origin,
        cookie: `${cookie.name}=${cookie.value}`,
      },
      payload: {
        response: key.authentication(
          options.json().options.challenge,
          2,
          {},
          29,
        ),
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.equal(
      (await f.db("seller_factors").where({ id: factor.id }).first())
        .backup_eligible,
      1,
    );
    const again = await f.app.inject({ method: "POST", url: "/api/v1/platform/auth/passkey/options", headers: { origin: f.config.origin }, payload: {} });
    const repeatCookie = again.cookies[0]!;
    const repeated = await f.app.inject({ method: "POST", url: "/api/v1/platform/auth/passkey/verify", headers: { origin: f.config.origin, cookie: `${repeatCookie.name}=${repeatCookie.value}` }, payload: { response: key.authentication(again.json().options.challenge, 3, {}, 29) } });
    assert.equal(repeated.statusCode, 200, repeated.body);

    assert.equal(
      (
        await f.app.inject({
          url: "/api/v1/platform/me",
          headers: recoveryHeaders(f, login),
        })
      ).statusCode,
      200,
    );
  } finally {
    await f.close();
  }
});

test("AUTH-07: recovery-key sign-in stays restricted and exposes only its replacement credential", async () => {
  const f = await oidcFixture();
  try {
    const original = passkeyFixture(f.config.origin);
    await original.seed(f.db, f.userId, f.config.secret);
    const headers = await ordinaryRecovery(f);
    await verifyChannel(f, headers);
    const replacement = await enrollRecovery(f, headers);
    const start = await f.app.inject({
      method: "POST",
      url: "/api/v1/platform/auth/passkey/options",
      headers: { origin: f.config.origin },
      payload: {},
    });
    const cookie = start.cookies[0]!;
    const login = await f.app.inject({
      method: "POST",
      url: "/api/v1/platform/auth/passkey/verify",
      headers: {
        origin: f.config.origin,
        cookie: `${cookie.name}=${cookie.value}`,
      },
      payload: {
        response: replacement.key.authentication(
          start.json().options.challenge,
        ),
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const recovered = recoveryHeaders(f, login);
    assert.equal(
      (await f.app.inject({ url: "/api/v1/platform/me", headers: recovered }))
        .statusCode,
      403,
    );
    const status = await f.app.inject({
      url: `${account}/security`,
      headers: recovered,
    });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().factors.length, 1);
    assert.equal(status.json().factors[0].id, replacement.factorId);
    assert.equal(status.json().privilegedReady, false);
  } finally {
    await f.close();
  }
});

test("AUTH-07: recovery supersession and standalone owner boundaries preserve the independent trust root", async () => {
  const f = await oidcFixture();
  try {
    const root = new AuthProvisioner(f.db, f.config.secret);
    const first = await root.start(f.userId, "host", "one");
    const second = await root.start(f.userId, "host", "two");
    assert.equal(
      (await f.db("auth_recoveries").where({ id: first.id }).first()).state,
      "canceled",
    );
    await assert.rejects(
      ordinaryRecovery(f),
      (e: unknown) => (e as { actual?: number }).actual === 409,
    ); // a saved code cannot supersede operator authorization
    f.config.deploymentMode = "standalone";
    f.config.standaloneOwnerEmail = "other@example.test";
    const redeem = () =>
      f.app.inject({
        method: "POST",
        url: `${account}/recovery/operator`,
        headers: { origin: f.config.origin },
        payload: { token: second.permit },
      });
    assert.equal((await redeem()).statusCode, 401);
    f.config.standaloneOwnerEmail = "owner@example.test";
    const valid = await redeem();
    assert.equal(valid.statusCode, 200, valid.body);
    const cancel = await f.app.inject({
      method: "POST",
      url: `${account}/recovery/cancel`,
      headers: recoveryHeaders(f, valid),
      payload: { flowId: second.id },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    // Two independently proved ordinary flows supersede only prior recovery material.
    await ordinaryRecovery(f);
    await ordinaryRecovery(f);
    assert.equal(
      (await f.db("auth_recoveries").where({ state: "restricted" })).length,
      1,
    );
  } finally {
    await f.close();
  }
});
