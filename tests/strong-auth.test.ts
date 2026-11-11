import test from "node:test";
import assert from "node:assert/strict";
import { oidcFixture, passkeyFixture, provisionTestPair, publisherInput } from "./helpers/oidc.ts";
import { csrf, hash, random } from "../src/crypto.ts";

const account = "/api/v1/platform/account";
const publishers = "/api/v1/tenants/primary/seller/oidc/publishers";
const intent = {
  action: "oidc.create",
  tenant: "primary",
  publisher: publisherInput,
};

test("publisher changes require strong reauthentication; email, API keys and CSRF bypass attempts fail", async () => {
  const f = await oidcFixture();
  try {
    for (const headers of [
      f.ownerHeaders,
      { ...f.ownerHeaders, "x-account-verification": await f.emailProof() },
      { ...f.ownerHeaders, "x-csrf-token": "wrong" },
      { authorization: `Bearer DE-TK-${random()}` },
    ]) {
      const result = await f.app.inject({
        method: "POST",
        url: publishers,
        headers,
        payload: publisherInput,
      });
      assert.ok([401, 403].includes(result.statusCode), result.body);
    }
    assert.equal((await f.db("oidc_publishers")).length, 0);
    const noFactor = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers: f.ownerHeaders,
      payload: intent,
    });
    assert.equal(noFactor.json().error.code, "factor_required");
    const email = await f.app.inject({
      method: "POST",
      url: `${account}/verification/request`,
      headers: f.ownerHeaders,
      payload: { purpose: "oidc_publishers" },
    });
    assert.equal(email.statusCode, 400);
  } finally {
    await f.close();
  }
});

test("a FIDO2 security key enrolls with user verification and approves only the exact change once", async () => {
  const f = await oidcFixture(),
    key = passkeyFixture(f.config.origin);
  const post = (path: string, payload: object, proof?: string) =>
    f.app.inject({
      method: "POST",
      url: `${account}${path}`,
      headers: {
        ...f.ownerHeaders,
        ...(proof ? { "x-account-verification": proof } : {}),
      },
      payload,
    });
  try {
    assert.equal(
      (
        await post("/security/passkey/enroll", {
          name: "Hardware key",
          kind: "security_key",
        })
      ).statusCode,
      403,
    );
    const start = await post(
      "/security/passkey/enroll",
      { name: "Hardware key", kind: "security_key" },
      await f.emailProof(),
    );
    assert.equal(start.statusCode, 200, start.body);
    assert.equal(
      start.json().options.authenticatorSelection.authenticatorAttachment,
      "cross-platform",
    );
    assert.equal(
      start.json().options.authenticatorSelection.userVerification,
      "required",
    );
    const registration = key.registration(start.json().options.challenge);
    registration.response.transports = ["usb"];
    const registered = await post("/security/passkey/confirm", {
      challengeId: start.json().challengeId,
      response: registration,
    });
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal(registered.json().kind, "security_key");
    await provisionTestPair(f, key);
    const options = await post("/reauth/options", intent);
    const proof = await post("/reauth/verify", {
      challengeId: options.json().challengeId,
      response: key.authentication(options.json().options.challenge),
    });
    const headers = {
      ...f.ownerHeaders,
      "x-account-verification": proof.json().verification,
    };
    const changed = await f.app.inject({
      method: "POST",
      url: publishers,
      headers,
      payload: {
        ...publisherInput,
        subject: "repo:changed/plugin:ref:refs/heads/main",
      },
    });
    assert.equal(changed.statusCode, 403);
    const created = await f.app.inject({
      method: "POST",
      url: publishers,
      headers,
      payload: publisherInput,
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: publishers,
          headers,
          payload: publisherInput,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await post("/reauth/verify", {
          challengeId: options.json().challengeId,
          code: "123456",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await post("/security/totp/enroll", { name: "Rejected" })).statusCode,
      404,
    );
    const status = await f.app.inject({
      url: `${account}/security`,
      headers: f.ownerHeaders,
    });
    assert.equal(status.json().factors.find((f: { kind: string }) => f.kind === "security_key").kind, "security_key");
    assert.ok(!status.body.includes("publicKey"));
  } finally {
    await f.close();
  }
});

test("WebAuthn challenges bind sessions and expiry, and failed assertions have an account-wide attempt budget", async () => {
  const f = await oidcFixture(),
    key = passkeyFixture(f.config.origin);
  try {
    await key.seed(f.db, f.userId, f.config.secret);
    const options = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers: f.ownerHeaders,
      payload: intent,
    });
    const other = random();
    await f.db("seller_sessions").insert({
      id: hash(other),
      user_id: f.userId,
      expires_at: Date.now() + 300000,
    });
    const assertion = {
      challengeId: options.json().challengeId,
      response: key.authentication(options.json().options.challenge),
    };
    const wrong = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/verify`,
      headers: {
        ...f.ownerHeaders,
        cookie: `de-seller-session=${other}`,
        "x-csrf-token": csrf(other, f.config.secret),
      },
      payload: assertion,
    });
    assert.equal(wrong.statusCode, 403);
    await f
      .db("seller_factor_challenges")
      .update({ expires_at: Date.now() - 1 });
    for (let i = 0; i < 8; i++) {
      const invalid = await f.app.inject({
        method: "POST",
        url: `${account}/reauth/verify`,
        remoteAddress: `198.51.100.${i + 1}`,
        headers: f.ownerHeaders,
        payload: assertion,
      });
      assert.equal(invalid.statusCode, 403);
    }
    const limited = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers: f.ownerHeaders,
      payload: intent,
    });
    assert.equal(limited.statusCode, 429);
    await f
      .db("seller_sessions")
      .where({ id: hash(f.session) })
      .delete();
    assert.equal(
      (
        await f.app.inject({
          url: `${account}/security`,
          headers: f.ownerHeaders,
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test("real signed passkey registration and authentication protect publisher creation and revocation", async () => {
  const f = await oidcFixture();
  const post = (path: string, payload: object, proof?: string) =>
    f.app.inject({
      method: "POST",
      url: `${account}${path}`,
      headers: {
        ...f.ownerHeaders,
        ...(proof ? { "x-account-verification": proof } : {}),
      },
      payload,
    });
  try {
    const key = passkeyFixture(f.config.origin);
    const start = await post(
      "/security/passkey/enroll",
      { name: "Laptop" },
      await f.emailProof(),
    );
    assert.equal(start.statusCode, 200, start.body);
    let { challengeId, options } = start.json();
    assert.equal(options.authenticatorSelection.userVerification, "required");
    const bad = await post("/security/passkey/confirm", {
      challengeId,
      response: key.registration(options.challenge, {
        origin: "https://evil.test",
      }),
    });
    assert.equal(bad.statusCode, 403, bad.body);
    ({ challengeId, options } = (await post("/security/passkey/enroll", { name: "Laptop" }, await f.emailProof())).json());
    const badAttestation = await post("/security/passkey/confirm", {
      challengeId,
      response: key.registration(options.challenge, {}, true),
    });
    assert.equal(badAttestation.statusCode, 403, badAttestation.body);
    ({ challengeId, options } = (await post("/security/passkey/enroll", { name: "Laptop" }, await f.emailProof())).json());
    const enrolled = await post("/security/passkey/confirm", {
      challengeId,
      response: key.registration(options.challenge),
    });
    assert.equal(enrolled.statusCode, 200, enrolled.body);
    await provisionTestPair(f, key);
    const verify = async (action: object, count: number) => {
      const options = await post("/reauth/options", action);
      assert.equal(options.statusCode, 200, options.body);
      const proof = await post("/reauth/verify", {
        challengeId: options.json().challengeId,
        response: key.authentication(options.json().options.challenge, count),
      });
      assert.equal(proof.statusCode, 200, proof.body);
      return proof.json().verification;
    };
    const proof = await verify(intent, 1);
    const created = await f.app.inject({
      method: "POST",
      url: publishers,
      headers: { ...f.ownerHeaders, "x-account-verification": proof },
      payload: publisherInput,
    });
    assert.equal(created.statusCode, 200, created.body);
    const id = created.json().id;
    const before = (await f.exchange(id, await f.token())).json().accessToken;
    const revokeProof = await verify(
      { action: "oidc.revoke", tenant: "primary", publisherId: id },
      2,
    );
    const revoked = await f.app.inject({
      method: "POST",
      url: `${publishers}/${id}/revoke`,
      headers: { ...f.ownerHeaders, "x-account-verification": revokeProof },
      payload: {},
    });
    assert.equal(revoked.statusCode, 200, revoked.body);
    assert.equal((await f.exchange(id, await f.token())).statusCode, 403);
    const denied = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/releases/plugin/1.0.0",
      headers: {
        authorization: `Bearer ${before}`,
        "content-type": "application/zip",
      },
      payload: Buffer.from("bad"),
    });
    assert.equal(denied.statusCode, 403);
  } finally {
    await f.close();
  }
});

test("passkey verification rejects wrong origin, challenge, signature, missing user verification, and cloned counters", async (t) => {
  for (const failure of [
    "origin",
    "challenge",
    "signature",
    "foreign-signature",
    "uv",
    "counter",
    "foreign",
  ] as const)
    await t.test(failure, async () => {
      const f = await oidcFixture();
      try {
        const key = passkeyFixture(f.config.origin);
        await key.seed(f.db, f.userId, f.config.secret);
        const opts = await f.app.inject({
          method: "POST",
          url: `${account}/reauth/options`,
          headers: f.ownerHeaders,
          payload: intent,
        });
        const assertion = key.authentication(
          failure === "challenge" ? "wrong" : opts.json().options.challenge,
          failure === "counter" ? 0 : 1,
          failure === "origin" ? { origin: "https://evil.test" } : {},
          failure === "uv" ? 1 : 5,
        );
        if (failure === "signature") assertion.response.signature = random();
        if (failure === "foreign-signature")
          assertion.response.signature = passkeyFixture(
            f.config.origin,
          ).authentication(opts.json().options.challenge).response.signature;
        if (failure === "foreign") assertion.id = random();
        // A nonzero stored counter makes returning zero a clone signal.
        if (failure === "counter")
          await f.db("seller_factors").update({ counter: 1 });
        const result = await f.app.inject({
          method: "POST",
          url: `${account}/reauth/verify`,
          headers: f.ownerHeaders,
          payload: {
            challengeId: opts.json().challengeId,
            response: assertion,
          },
        });
        assert.equal(result.statusCode, 403, result.body);
        assert.equal(
          (await f.db("account_challenges").where({ purpose: "strong" }))
            .length,
          0,
        );
      } finally {
        await f.close();
      }
    });
});

test("security factor additions require an existing factor and proofs expire, bind the session and cannot approve another action", async () => {
  const f = await oidcFixture();
  const key = passkeyFixture(f.config.origin);
  const post = (path: string, payload: object, proof?: string) =>
    f.app.inject({
      method: "POST",
      url: `${account}${path}`,
      headers: {
        ...f.ownerHeaders,
        ...(proof ? { "x-account-verification": proof } : {}),
      },
      payload,
    });
  try {
    await key.seed(f.db, f.userId, f.config.secret);
    const emailProof = await f.emailProof();
    assert.equal(
      (
        await post(
          "/security/passkey/enroll",
          { name: "New device" },
          emailProof,
        )
      ).statusCode,
      403,
    );
    const options = await post("/reauth/options", {
      action: "security.manage",
    });
    const payload = {
      challengeId: options.json().challengeId,
      response: key.authentication(options.json().options.challenge),
    };
    const proof = await post("/reauth/verify", payload);
    assert.equal(proof.statusCode, 200, proof.body);
    assert.equal((await post("/reauth/verify", payload)).statusCode, 403);
    const wrong = await f.app.inject({
      method: "POST",
      url: publishers,
      headers: {
        ...f.ownerHeaders,
        "x-account-verification": proof.json().verification,
      },
      payload: publisherInput,
    });
    assert.equal(wrong.statusCode, 403);
    const enroll = await post(
      "/security/passkey/enroll",
      { name: "New device" },
      proof.json().verification,
    );
    assert.equal(enroll.statusCode, 200, enroll.body);
    const second = passkeyFixture(f.config.origin);
    const done = await post("/security/passkey/confirm", {
      challengeId: enroll.json().challengeId,
      response: second.registration(enroll.json().options.challenge),
    });
    assert.equal(done.statusCode, 200, done.body);
    await provisionTestPair(f, key);
    const fresh = await post("/reauth/options", intent);
    const approval = await post("/reauth/verify", {
      challengeId: fresh.json().challengeId,
      response: key.authentication(fresh.json().options.challenge, 2),
    });
    assert.equal(approval.statusCode, 200, approval.body);
    await f
      .db("account_challenges")
      .where({ purpose: "strong" })
      .update({ expires_at: Date.now() - 1 });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: publishers,
          headers: {
            ...f.ownerHeaders,
            "x-account-verification": approval.json().verification,
          },
          payload: publisherInput,
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});
