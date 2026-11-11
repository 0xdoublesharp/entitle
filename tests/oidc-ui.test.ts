import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { ApiClient } from "../web/api.ts";
import { oidcFixture, passkeyFixture, provisionTestPair } from "./helpers/oidc.ts";
import { unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";

const dom = new Window({ url: "http://localhost/seller" });
for (const name of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value:
      name === "window"
        ? dom
        : (dom as unknown as Record<string, unknown>)[name],
  });
const { createApp, h, nextTick } = await import("vue");
const { PublisherSecurity, passkeyCeremony } = await import("../web/oidc.ts");
after(() => dom.happyDOM.abort());
async function flush() {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await nextTick();
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await flush();
  assert.ok(predicate(), dom.document.body.textContent ?? "");
}
function field(text: string, value: string, select = false) {
  const label = [...dom.document.querySelectorAll("label")].find((label) =>
    label.textContent.startsWith(text),
  );
  assert.ok(label, text);
  const input = label.querySelector(select ? "select" : "input")!;
  input.value = value;
  input.dispatchEvent(
    new dom.Event(select ? "change" : "input", { bubbles: true }),
  );
}
async function click(text: string) {
  const button = [...dom.document.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );
  assert.ok(button, text);
  button.click();
  await flush();
}
async function mountReal(
  prepare?: (f: Awaited<ReturnType<typeof oidcFixture>>) => Promise<void>,
) {
  const f = await oidcFixture();
  await prepare?.(f);
  const transport: typeof fetch = async (url, init = {}) => {
    const reply = await f.app.inject({
      method: (init.method ?? "GET") as "GET" | "POST",
      url: String(url),
      headers: {
        ...f.ownerHeaders,
        ...Object.fromEntries(new Headers(init.headers)),
      },
      ...(init.body ? { payload: String(init.body) } : {}),
    });
    return new Response(reply.body, {
      status: reply.statusCode,
      headers: reply.headers as Record<string, string>,
    });
  };
  const api = new ApiClient(transport, "/api/v1/tenants/primary/seller"),
    platform = new ApiClient(transport, "/api/v1/platform");
  api.csrfToken = platform.csrfToken = f.ownerHeaders["x-csrf-token"];
  dom.document.body.innerHTML = '<div id="root"></div>';
  const app = createApp({
    render: () =>
      h(PublisherSecurity, {
        api,
        platform,
        products: [{ id: f.productId, name: "Plugin", slug: "plugin" }],
      }),
  });
  app.mount("#root");
  await until(() => !!dom.document.querySelector("form"));
  return {
    ...f,
    close: async () => {
      app.unmount();
      await f.close();
    },
  };
}

test("seller UI enrolls a real passkey and verifies exact creation and revocation against the API", async (t) => {
  const f = await mountReal();
  try {
    const key = passkeyFixture(f.config.origin);
    Object.defineProperty(globalThis, "PublicKeyCredential", {
      configurable: true,
      value: {
        parseCreationOptionsFromJSON: (options: object) => options,
        parseRequestOptionsFromJSON: (options: object) => options,
      },
    });
    let counter = 0;
    Object.defineProperty(dom.navigator, "credentials", {
      configurable: true,
      value: {
        create: async ({
          publicKey,
        }: {
          publicKey: { challenge: string };
        }) => ({ toJSON: () => key.registration(publicKey.challenge) }),
        get: async ({ publicKey }: { publicKey: { challenge: string } }) => ({
          toJSON: () => key.authentication(publicKey.challenge, ++counter),
        }),
      },
    });
    t.after(() => {
      Reflect.deleteProperty(globalThis, "PublicKeyCredential");
    });
    await click("Send setup verification");
    await until(() => !!dom.document.querySelector('[role="status"]'));
    const message = unseal<Message>(
      (
        await f
          .db("platform_emails")
          .where({ kind: "account_verification" })
          .first()
      ).payload,
      f.config.secret,
    );
    const token = /account-verification=([A-Za-z0-9_-]+)/.exec(
      message.text,
    )![1]!;
    field("Email verification token", token);
    await click("Enroll passkey");
    await until(() =>
      dom.document.body.textContent!.includes("Passkey enrolled."),
    );
    await provisionTestPair(f, key);
    field("Product", "plugin", true);
    field("GitHub repository", "acme/plugin");
    field("Repository ID", "123");
    field("Repository owner ID", "456");
    dom.document
      .querySelector("form")!
      .dispatchEvent(
        new dom.Event("submit", { bubbles: true, cancelable: true }),
      );
    await until(() =>
      dom.document.body.textContent!.includes("Publisher trusted."),
    );
    assert.equal((await f.db("oidc_publishers")).length, 1);
    assert.equal(
      (await f.db("account_challenges").where({ purpose: "strong" })).length,
      0,
    );
    await click("Revoke publisher");
    await until(() =>
      dom.document.body.textContent!.includes("Publisher revoked."),
    );
    assert.ok((await f.db("oidc_publishers").first()).revoked_at);
    assert.equal(counter, 2);
  } finally {
    await f.close();
  }
});

test("security settings toggle email fallback and prevent removing the last usable key", async () => {
  let key: ReturnType<typeof passkeyFixture>;
  const f = await mountReal(async (f) => {
    key = passkeyFixture(f.config.origin);
    await key.seed(f.db, f.userId, f.config.secret);
  });
  let counter = 0;
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    configurable: true,
    value: { parseRequestOptionsFromJSON: (value: object) => value },
  });
  Object.defineProperty(dom.navigator, "credentials", {
    configurable: true,
    value: {
      get: async ({ publicKey }: { publicKey: { challenge: string } }) => ({
        toJSON: () => key!.authentication(publicKey.challenge, ++counter),
      }),
    },
  });
  try {
    await click("Disable email-link sign-in");
    await until(() =>
      dom.document.body.textContent!.includes("Email-link sign-in disabled."),
    );
    assert.equal(
      (await f.db("seller_users").where({ id: f.userId }).first())
        .email_login_disabled,
      1,
    );
    await click("Remove key");
    await until(() =>
      dom.document.body.textContent!.includes("before removing your last key"),
    );
    assert.equal((await f.db("seller_factors")).length, 1);
    await click("Enable email-link sign-in");
    await until(() =>
      dom.document.body.textContent!.includes("Email-link sign-in enabled."),
    );
    await click("Remove key");
    await until(() =>
      dom.document.body.textContent!.includes(
        "Verify your email to enroll your first",
      ),
    );
    assert.equal((await f.db("seller_factors")).length, 0);
  } finally {
    Reflect.deleteProperty(globalThis, "PublicKeyCredential");
    await f.close();
  }
});

test("publishing UI handles missing passkey support, canceled ceremonies and failed settings loads", async () => {
  Reflect.deleteProperty(globalThis, "PublicKeyCredential");
  await assert.rejects(passkeyCeremony("get", {}), /browser with WebAuthn/);
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    configurable: true,
    value: { parseRequestOptionsFromJSON: () => ({}) },
  });
  Object.defineProperty(dom.navigator, "credentials", {
    configurable: true,
    value: { get: async () => null },
  });
  await assert.rejects(passkeyCeremony("get", {}), /canceled/);
  Reflect.deleteProperty(globalThis, "PublicKeyCredential");
  const client = new ApiClient(
    async () => Response.json({}),
    "/api/v1/tenants/primary/seller",
  );
  dom.document.body.innerHTML = '<div id="root"></div>';
  const app = createApp({
    render: () =>
      h(PublisherSecurity, { api: client, platform: client, products: [] }),
  });
  app.mount("#root");
  try {
    await flush();
    assert.match(dom.document.body.textContent!, /could not be loaded/);
    await click("Load publishing settings");
    assert.match(dom.document.body.textContent!, /Try again/);
  } finally {
    app.unmount();
  }
});

async function mockPanel(
  handler: (
    path: string,
    body: Record<string, unknown>,
  ) => Promise<unknown> | unknown,
  events: { expired?: () => void } = {},
  tenantScoped = true,
) {
  const client = new ApiClient(
    async (url, init = {}) => {
      const result = await handler(
        String(url),
        init.body ? JSON.parse(String(init.body)) : {},
      );
      return result instanceof Response ? result : Response.json(result);
    },
    tenantScoped ? "/api/v1/tenants/primary/seller" : "/api/v1/platform",
  );
  dom.document.body.innerHTML = '<div id="root"></div>';
  const app = createApp({
    render: () =>
      h(PublisherSecurity, {
        api: client,
        platform: client,
        products: [{ id: "product", slug: "plugin", name: "Plugin" }],
        ...(events.expired ? { onExpired: events.expired } : {}),
      }),
  });
  app.mount("#root");
  await flush();
  return app;
}
const mockInventory = (
  providers = [
    { id: "github", issuer: "https://token.actions.githubusercontent.com" },
  ],
) => ({
  audience: "https://entitle.test/api/v1/tenants/primary/oidc",
  providers,
  publishers: [],
});

test("publishing UI emits expired on a 401 and handles an operator disabling every provider", async () => {
  let expired = 0;
  const bad = await mockPanel(
    () =>
      new Response('{"error":{"message":"Sign in again"}}', { status: 401 }),
    {
      expired: () => {
        expired++;
      },
    },
  );
  assert.ok(expired);
  bad.unmount();
  const disabled = await mockPanel((path) =>
    path.endsWith("/security") ? { factors: [] } : mockInventory([]),
  );
  try {
    assert.equal(
      (
        dom.document.querySelector(
          "select:last-of-type",
        )! as unknown as HTMLSelectElement
      ).value,
      "",
    );
  } finally {
    disabled.unmount();
  }
});

test("pending publishing verification blocks duplicate submissions and navigation cancels unfinished ceremonies", async (t) => {
  for (const stage of [
    "load",
    "options",
    "authentication",
    "enrollment",
    "registration",
    "failure",
  ] as const)
    await t.test(stage, async () => {
      let resolve: (value: unknown) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const waiting = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let writes = 0,
        options = 0;
      const app = await mockPanel((path) => {
        if (path.endsWith("/security"))
          return stage === "load"
            ? waiting
            : {
                factors:
                  stage === "enrollment" || stage === "registration"
                    ? []
                    : [{ id: "key", name: "Device", kind: "passkey" }],
              };
        if (path.endsWith("/oidc/publishers")) return mockInventory();
        if (path.endsWith("/reauth/options")) {
          options++;
          return stage === "options" || stage === "failure"
            ? waiting
            : { challengeId: "test", methods: ["passkey"], options: {} };
        }
        if (path.endsWith("/verification/consume"))
          return { verification: "bootstrap" };
        if (path.endsWith("/passkey/enroll"))
          return stage === "enrollment"
            ? waiting
            : { challengeId: "enroll", options: {} };
        writes++;
        return { verification: "proof" };
      });
      Object.defineProperty(globalThis, "PublicKeyCredential", {
        configurable: true,
        value: {
          parseRequestOptionsFromJSON: () => ({}),
          parseCreationOptionsFromJSON: () => ({}),
        },
      });
      Object.defineProperty(dom.navigator, "credentials", {
        configurable: true,
        value: { get: async () => waiting, create: async () => waiting },
      });
      try {
        if (["enrollment", "registration"].includes(stage))
          await click("Enroll passkey");
        else if (stage !== "load") {
          const form = dom.document.querySelector("form")!;
          form.dispatchEvent(
            new dom.Event("submit", { bubbles: true, cancelable: true }),
          );
          form.dispatchEvent(
            new dom.Event("submit", { bubbles: true, cancelable: true }),
          );
          await flush();
          assert.equal(options, 1);
        }
        app.unmount();
        if (stage === "failure") reject(Error("network closed"));
        else if (stage === "load") resolve({ factors: [] });
        else if (stage === "options")
          resolve({ challengeId: "test", methods: ["passkey"], options: {} });
        else if (stage === "enrollment")
          resolve({
            challengeId: "test",
            secret: "PRIVATE",
            uri: "otpauth://test",
          });
        else resolve({ toJSON: () => ({ id: "credential" }) });
        await flush();
        assert.equal(writes, 0);
        assert.ok(!dom.document.body.textContent!.includes("PRIVATE"));
      } finally {
        Reflect.deleteProperty(globalThis, "PublicKeyCredential");
      }
    });
});

test("custom-provider publishing preserves typed claims and security-key enrollment uses fresh key approval", async () => {
  const intents: Record<string, unknown>[] = [],
    writes: Record<string, unknown>[] = [];
  let enrolled = false;
  const inventory = mockInventory([
    { id: "gitlab", issuer: "https://gitlab.test" },
    { id: "custom", issuer: "https://custom.test" },
  ]);
  const app = await mockPanel((path, body) => {
    if (path.endsWith("/security"))
      return {
        factors: [
          {
            id: "key",
            kind: enrolled ? "security_key" : "passkey",
            name: "Device",
          },
        ],
      };
    if (path.endsWith("/oidc/publishers") && Object.keys(body).length === 0)
      return inventory;
    if (path.endsWith("/reauth/options")) {
      intents.push(body);
      return { challengeId: "challenge", options: {} };
    }
    if (path.endsWith("/reauth/verify")) return { verification: "approval" };
    if (path.endsWith("/passkey/enroll")) {
      assert.equal(body.kind, "security_key");
      return { challengeId: "enroll", options: {} };
    }
    if (path.endsWith("/passkey/confirm")) {
      enrolled = true;
      return { id: "key", kind: "security_key" };
    }
    writes.push(body);
    return { id: "publisher" };
  });
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    configurable: true,
    value: {
      parseRequestOptionsFromJSON: () => ({}),
      parseCreationOptionsFromJSON: () => ({}),
    },
  });
  Object.defineProperty(dom.navigator, "credentials", {
    configurable: true,
    value: {
      create: async () => ({ toJSON: () => ({ id: "key" }) }),
      get: async () => ({ toJSON: () => ({ id: "key" }) }),
    },
  });
  try {
    field("Product", "plugin", true);
    field("CI provider", "custom", true);
    field("Exact OIDC subject", "project:123:ref:main");
    field("Required claims", '{"project_id":"123","ref_protected":true}');
    dom.document
      .querySelector("form")!
      .dispatchEvent(
        new dom.Event("submit", { bubbles: true, cancelable: true }),
      );
    await flush();
    assert.equal(writes[0]!.subject, "project:123:ref:main");
    assert.deepEqual(writes[0]!.claims, {
      project_id: "123",
      ref_protected: true,
    });
    await click("Enroll security key");
    assert.match(dom.document.body.textContent!, /Security key enrolled/);
    assert.ok(intents.some((intent) => intent.action === "security.manage"));
  } finally {
    app.unmount();
    Reflect.deleteProperty(globalThis, "PublicKeyCredential");
  }
});

test("account key setup works before creating a workspace and does not request tenant publishing settings", async () => {
  const paths: string[] = [];
  const app = await mockPanel(
    (path) => {
      paths.push(path);
      assert.ok(path.endsWith("/account/security"));
      return { factors: [], emailLoginEnabled: true };
    },
    {},
    false,
  );
  try {
    assert.match(
      dom.document.body.textContent!,
      /Create or select a workspace/,
    );
    assert.ok(
      [...dom.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Enroll passkey",
      ),
    );
    assert.equal(dom.document.querySelector("form"), null);
    assert.ok(!paths.some((path) => path.includes("/oidc/publishers")));
  } finally {
    app.unmount();
  }
});

test("existing-key holders can see and cancel pending recovery from security settings", async t => {
  const { AuthProvisioner } = await import("../src/auth-recovery.ts");
  let key: ReturnType<typeof passkeyFixture>;
  const f = await mountReal(async f => {
    key = passkeyFixture(f.config.origin); await key.seed(f.db, f.userId, f.config.secret);
    await new AuthProvisioner(f.db, f.config.secret).start(f.userId, "host", "incident");
  });
  try {
    Object.defineProperty(globalThis, "PublicKeyCredential", { configurable: true, value: { parseRequestOptionsFromJSON: (v: unknown) => v } });
    Object.defineProperty(dom.navigator, "credentials", { configurable: true, value: { get: async ({ publicKey }: { publicKey: { challenge: string } }) => ({ toJSON: () => key.authentication(publicKey.challenge) }) } });
    t.after(() => Reflect.deleteProperty(globalThis, "PublicKeyCredential"));
    assert.match(dom.document.body.textContent!, /Account recovery is underway/);
    await click("Verify original key and cancel recovery"); await until(() => dom.document.body.textContent!.includes("Recovery canceled."));
    assert.equal((await f.db("auth_recoveries").first()).state, "canceled");
    assert.equal((await f.db("seller_factors")).length, 1);
    assert.equal(dom.document.querySelector(".recovery-notice"), null);
  } finally { await f.close(); }
});
