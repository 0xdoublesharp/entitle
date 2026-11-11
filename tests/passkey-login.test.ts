import test from "node:test";
import assert from "node:assert/strict";
import { oidcFixture, passkeyFixture, publisherInput } from "./helpers/oidc.ts";
import { random, unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";

const platform = "/api/v1/platform";
const account = `${platform}/account`;
async function fixture() {
  const f = await oidcFixture(),
    key = passkeyFixture(f.config.origin);
  await key.seed(f.db, f.userId, f.config.secret);
  let counter = 0;
  const approval = async (intent: object) => {
    const options = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/options`,
      headers: f.ownerHeaders,
      payload: intent,
    });
    assert.equal(options.statusCode, 200, options.body);
    const result = await f.app.inject({
      method: "POST",
      url: `${account}/reauth/verify`,
      headers: f.ownerHeaders,
      payload: {
        challengeId: options.json().challengeId,
        response: key.authentication(
          options.json().options.challenge,
          ++counter,
        ),
      },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().verification as string;
  };
  const settings = async (enabled: boolean) => {
    const proof = await approval({ action: "security.email_login", enabled });
    return f.app.inject({
      method: "POST",
      url: `${account}/security/email-login`,
      headers: { ...f.ownerHeaders, "x-account-verification": proof },
      payload: { enabled },
    });
  };
  const loginStart = async () => {
    const result = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/passkey/options`,
      headers: { origin: f.config.origin },
      payload: {},
    });
    assert.equal(result.statusCode, 200, result.body);
    const cookie = result.cookies.find((c) => c.name === "de-passkey-login")!;
    assert.ok(cookie);
    return {
      options: result.json().options,
      cookie: `de-passkey-login=${cookie.value}`,
      response: result,
    };
  };
  return {
    ...f,
    key,
    approval,
    settings,
    loginStart,
    nextCounter: () => ++counter,
  };
}

test("an enrolled key signs in with a browser-bound single-use challenge and an ordinary seller session", async () => {
  const f = await fixture();
  try {
    const start = await f.loginStart();
    assert.equal(start.options.userVerification, "required");
    assert.ok(
      !start.options.allowCredentials?.length,
      "login does not disclose credential IDs",
    );
    const payload = {
      response: f.key.authentication(start.options.challenge, f.nextCounter()),
    };
    const verified = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/passkey/verify`,
      headers: { origin: f.config.origin, cookie: start.cookie },
      payload,
    });
    assert.equal(verified.statusCode, 200, verified.body);
    const cookie = verified.cookies.find(
      (c) => c.name === "de-seller-session",
    )!;
    assert.ok(cookie.httpOnly);
    assert.equal(cookie.sameSite, "Lax");
    const me = await f.app.inject({
      url: `${platform}/me`,
      headers: { cookie: `de-seller-session=${cookie.value}` },
    });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().user.id, f.userId);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${platform}/auth/passkey/verify`,
          headers: { origin: f.config.origin, cookie: start.cookie },
          payload,
        })
      ).statusCode,
      401,
    );
    assert.equal((await f.db("passkey_login_challenges")).length, 0);
    assert.equal(
      (await f.db("account_challenges").where({ purpose: "strong" })).length,
      0,
      "login does not approve security mutations",
    );
  } finally {
    await f.close();
  }
});

test("email fallback can be disabled with fresh key approval, invalidates pending links, and can be restored", async () => {
  const f = await fixture();
  try {
    const sent = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/request`,
      headers: { origin: f.config.origin },
      payload: { email: "owner@example.test" },
    });
    const browser = sent.cookies.find((c) => c.name === "de-seller-preauth")!;
    const mail = unseal<Message>(
      (await f.db("platform_emails").where({ kind: "seller_login" }).first())
        .payload,
      f.config.secret,
    );
    const token = /seller-login=([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const denied = await f.app.inject({
      method: "POST",
      url: `${account}/security/email-login`,
      headers: f.ownerHeaders,
      payload: { enabled: false },
    });
    assert.equal(denied.statusCode, 403);
    const disabled = await f.settings(false);
    assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal((await f.db("seller_login_tokens")).length, 0);
    const link = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/consume`,
      headers: {
        origin: f.config.origin,
        cookie: `de-seller-preauth=${browser.value}`,
      },
      payload: { token },
    });
    assert.equal(link.statusCode, 401);
    const emails = (await f.db("platform_emails")).length;
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${platform}/auth/request`,
          headers: { origin: f.config.origin },
          payload: { email: "owner@example.test" },
        })
      ).statusCode,
      200,
    );
    assert.equal((await f.db("platform_emails")).length, emails);
    const status = await f.app.inject({
      url: `${account}/security`,
      headers: f.ownerHeaders,
    });
    assert.equal(status.json().emailLoginEnabled, false);
    const start = await f.loginStart();
    const login = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/passkey/verify`,
      headers: { origin: f.config.origin, cookie: start.cookie },
      payload: {
        response: f.key.authentication(
          start.options.challenge,
          f.nextCounter(),
        ),
      },
    });
    assert.equal(login.statusCode, 200, login.body);
    const enabled = await f.settings(true);
    assert.equal(enabled.statusCode, 200, enabled.body);
    await f.app.inject({
      method: "POST",
      url: `${platform}/auth/request`,
      headers: { origin: f.config.origin },
      payload: { email: "owner@example.test" },
    });
    assert.equal((await f.db("platform_emails")).length, emails + 1);
  } finally {
    await f.close();
  }
});

test("last-key removal is blocked while email fallback is disabled and old approval cannot change the setting", async () => {
  const f = await fixture();
  try {
    const proof = await f.approval({
      action: "security.email_login",
      enabled: true,
    });
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${account}/security/email-login`,
          headers: { ...f.ownerHeaders, "x-account-verification": proof },
          payload: { enabled: false },
        })
      ).statusCode,
      403,
    );
    assert.equal((await f.settings(false)).statusCode, 200);
    const factor = await f.db("seller_factors").first();
    const remove = await f.approval({
      action: "security.remove",
      factorId: factor.id,
    });
    const denied = await f.app.inject({
      method: "POST",
      url: `${account}/security/factors/${factor.id}/remove`,
      headers: { ...f.ownerHeaders, "x-account-verification": remove },
      payload: {},
    });
    assert.equal(denied.statusCode, 409, denied.body);
    assert.equal(denied.json().error.code, "login_lockout");
    assert.equal((await f.db("seller_factors")).length, 1);
  } finally {
    await f.close();
  }
});

test("public key login rejects cross-browser, expired, wrong-origin, unknown and revoked credentials", async (t) => {
  for (const mode of [
    "browser",
    "expired",
    "origin",
    "unknown",
    "revoked",
    "signature",
    "user",
    "unverified",
  ] as const)
    await t.test(mode, async () => {
      const f = await fixture();
      try {
        const start = await f.loginStart();
        const assertion = f.key.authentication(
          start.options.challenge,
          f.nextCounter(),
          mode === "origin" ? { origin: "https://evil.test" } : {},
        );
        if (mode === "unknown") assertion.id = random();
        if (mode === "signature")
          assertion.response.signature = passkeyFixture(
            f.config.origin,
          ).authentication(start.options.challenge).response.signature;
        if (mode === "expired")
          await f
            .db("passkey_login_challenges")
            .update({ expires_at: Date.now() - 1 });
        if (mode === "revoked") await f.db("seller_factors").delete();
        if (mode === "unverified")
          await f
            .db("seller_users")
            .where({ id: f.userId })
            .update({ verified_at: null });
        const result = await f.app.inject({
          method: "POST",
          url: `${platform}/auth/passkey/verify`,
          headers: {
            origin: f.config.origin,
            ...(mode === "browser" ? {} : { cookie: start.cookie }),
          },
          payload: {
            response: {
              ...assertion,
              response: {
                ...assertion.response,
                ...(mode === "user"
                  ? {
                      userHandle:
                        Buffer.from("other-user").toString("base64url"),
                    }
                  : {}),
              },
            },
          },
        });
        assert.equal(result.statusCode, 401, result.body);
        assert.ok(!result.cookies.some((c) => c.name === "de-seller-session"));
      } finally {
        await f.close();
      }
    });
});

test("key removal with email fallback enabled is authorized once and retires pending enrollment", async () => {
  const f = await fixture();
  try {
    const staleApproval = await f.approval({ action: "security.email_login", enabled: false });
    const factor = await f.db("seller_factors").first();
    const proof = await f.approval({
      action: "security.remove",
      factorId: factor.id,
    });
    const result = await f.app.inject({
      method: "POST",
      url: `${account}/security/factors/${factor.id}/remove`,
      headers: { ...f.ownerHeaders, "x-account-verification": proof },
      payload: {},
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal((await f.db("seller_factors")).length, 0);
    assert.equal((await f.db("seller_factor_challenges")).length, 0);
    const stale = await f.app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/seller/oidc/publishers",
      headers: { ...f.ownerHeaders, "x-account-verification": staleApproval },
      payload: publisherInput,
    });
    assert.equal(
      stale.statusCode,
      403,
      "key removal invalidates pending security approvals",
    );
    const anonymous = await f.loginStart();
    const denied = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/passkey/verify`,
      headers: { origin: f.config.origin, cookie: anonymous.cookie },
      payload: {
        response: f.key.authentication(
          anonymous.options.challenge,
          f.nextCounter(),
        ),
      },
    });
    assert.equal(denied.statusCode, 401);
  } finally {
    await f.close();
  }
});

test("key login respects standalone owner identity, secure cookies, and replacement of browser challenges", async () => {
  const f = await fixture();
  try {
    f.config.production = true;
    f.config.deploymentMode = "standalone";
    f.config.standaloneOwnerEmail = "owner@example.test";
    const start = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/passkey/options`,
      headers: { origin: f.config.origin },
      payload: {},
    });
    const cookie = start.cookies.find(
      (c) => c.name === "__Host-de-passkey-login",
    )!;
    assert.ok(cookie.secure && cookie.httpOnly);
    const replaced = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/passkey/options`,
      headers: {
        origin: f.config.origin,
        cookie: `__Host-de-passkey-login=${cookie.value}`,
      },
      payload: {},
    });
    assert.equal((await f.db("passkey_login_challenges")).length, 1);
    const current = replaced.cookies.find(
      (c) => c.name === "__Host-de-passkey-login",
    )!;
    let response = f.key.authentication(
      replaced.json().options.challenge,
      f.nextCounter(),
    );
    f.config.standaloneOwnerEmail = "other@example.test";
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${platform}/auth/passkey/verify`,
          headers: {
            origin: f.config.origin,
            cookie: `__Host-de-passkey-login=${current.value}`,
          },
          payload: { response },
        })
      ).statusCode,
      401,
    );
    f.config.standaloneOwnerEmail = "owner@example.test";
    const retry = await f.app.inject({ method: "POST", url: `${platform}/auth/passkey/options`, headers: { origin: f.config.origin }, payload: {} });
    const retryCookie = retry.cookies.find(c => c.name === "__Host-de-passkey-login")!;
    response = f.key.authentication(retry.json().options.challenge, f.nextCounter());
    const result = await f.app.inject({
      method: "POST",
      url: `${platform}/auth/passkey/verify`,
      headers: {
        origin: f.config.origin,
        cookie: `__Host-de-passkey-login=${retryCookie.value}`,
      },
      payload: {
        response: {
          ...response,
          response: {
            ...response.response,
            userHandle: Buffer.from(f.userId).toString("base64url"),
          },
        },
      },
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(result.cookies.some((cookie) => cookie.secure));
  } finally {
    await f.close();
  }
});
