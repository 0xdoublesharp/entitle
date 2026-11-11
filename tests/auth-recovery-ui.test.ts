import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { ApiClient } from "../web/api.ts";
import { AuthProvisioner } from "../src/auth-recovery.ts";
import { oidcFixture, passkeyFixture } from "./helpers/oidc.ts";
import { hash, random, unseal } from "../src/crypto.ts";

const dom = new Window({ url: "http://localhost/seller" });
for (const key of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
])
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value:
      key === "window" ? dom : (dom as unknown as Record<string, unknown>)[key],
  });
const { createApp, h, nextTick } = await import("vue");
const { RecoveryPanel } = await import("../web/auth-recovery.ts");
after(() => dom.happyDOM.close());
async function flush() {
  for (let i = 0; i < 8; i++) {
    await new Promise<void>((r) => setImmediate(r));
    await nextTick();
  }
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await flush();
  assert.ok(predicate(), dom.document.body.textContent ?? "");
}
function field(label: string, value: string) {
  const el = [...dom.document.querySelectorAll("label")]
    .find((el) => el.textContent.startsWith(label))
    ?.querySelector("input");
  assert.ok(el, label);
  el.value = value;
  el.dispatchEvent(new dom.Event("input", { bubbles: true }));
}
async function click(label: string) {
  const el = [...dom.document.querySelectorAll("button")].find(
    (el) => el.textContent === label,
  );
  assert.ok(el, label);
  el.click();
  await flush();
}
async function setup() {
  const f = await oidcFixture();
  const jar = new Map<string, string>();
  const calls: string[] = [];
  let key = passkeyFixture(f.config.origin),
    counter = 0,
    complete = 0;
  Object.defineProperty(globalThis, "PublicKeyCredential", {
    configurable: true,
    value: {
      parseCreationOptionsFromJSON: (v: unknown) => v,
      parseRequestOptionsFromJSON: (v: unknown) => v,
    },
  });
  Object.defineProperty(dom.navigator, "credentials", {
    configurable: true,
    value: {
      create: async (options: { publicKey: { challenge: string } }) => ({
        toJSON: () => key.registration(options.publicKey.challenge),
      }),
      get: async (options: { publicKey: { challenge: string } }) => ({
        toJSON: () =>
          key.authentication(options.publicKey.challenge, ++counter),
      }),
    },
  });
  const platform = new ApiClient(async (url, init = {}) => {
    calls.push(String(url));
    const response = await f.app.inject({
      method: (init.method ?? "GET") as "POST" | "GET",
      url: String(url),
      headers: {
        origin: f.config.origin,
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...Object.fromEntries(new Headers(init.headers)),
      },
      ...(init.body ? { payload: String(init.body) } : {}),
    });
    for (const c of response.cookies) jar.set(c.name, c.value);
    return new Response(response.body, { status: response.statusCode });
  }, "/api/v1/platform");
  dom.document.body.innerHTML = '<div id="app"></div>';
  const app = createApp({
    render: () =>
      h(RecoveryPanel, {
        platform,
        onComplete: () => {
          complete++;
        },
      }),
  });
  app.mount("#app");
  await flush();
  return {
    ...f,
    platform,
    calls,
    completed: () => complete,
    setKey: () => {
      key = passkeyFixture(f.config.origin);
      counter = 0;
    },
    close: async () => {
      app.unmount();
      await f.close();
    },
  };
}

test("AUTH-07: recovery UI completes saved-code, separate email, replacement-key proof and sign-in-required journey", async () => {
  const f = await setup();
  try {
    const code = random();
    await f.db("account_recovery_codes").insert({
      id: hash(`recovery:${f.userId}:${code}`),
      user_id: f.userId,
      created_at: Date.now(),
    });
    field("Account email", "owner@example.test");
    field("Saved recovery code", code);
    await click("Start ordinary recovery");
    await until(() =>
      dom.document.body.textContent.includes("Recovery access is restricted"),
    );
    assert.equal(f.completed(), 0);
    assert.ok(!f.calls.includes("/api/v1/platform/me"));
    await click("Send recovery confirmation email");
    const job = await f
      .db("platform_emails")
      .where({ kind: "account_verification" })
      .first();
    const token = unseal<{ text: string }>(job.payload, f.config.secret)
      .text.split(": ")
      .at(-1)!;
    field("Recovery email confirmation", "wrong");
    await click("Confirm recovery email");
    await until(() =>
      dom.document.body.textContent.includes("Verify the recovery email"),
    );
    field("Recovery email confirmation", token);
    await click("Confirm recovery email");
    await until(() =>
      dom.document.body.textContent.includes("Enroll replacement key"),
    );
    field("Replacement key name", "Recovered laptop");
    await click("Enroll replacement key");
    await until(() =>
      dom.document.body.textContent.includes("Replacement key enrolled."),
    );
    await click("Verify new key and finish recovery");
    await until(() => f.completed() === 1);
    assert.match(dom.document.body.textContent, /Sign in with your new key/);
    assert.equal((await f.db("seller_users").first()).recovered_ordinary, 1);
    assert.equal((await f.db("seller_sessions")).length, 0);
  } finally {
    await f.close();
  }
});

test("AUTH-07: operator recovery UI enrolls independent replacements and cancels without deleting original keys", async () => {
  const f = await setup();
  try {
    const original = passkeyFixture(f.config.origin);
    await original.seed(f.db, f.userId, f.config.secret);
    const flow = await new AuthProvisioner(f.db, f.config.secret).start(
      f.userId,
      "host",
      "incident",
    );
    field("Operator authorization", flow.permit);
    await click("Use operator authorization");
    await until(() =>
      dom.document.body.textContent.includes(
        "Enroll two independent hardware keys",
      ),
    );
    await click("Enroll replacement key");
    await until(() =>
      dom.document.body.textContent.includes("Replacement key enrolled."),
    );
    f.setKey();
    await click("Enroll replacement key");
    await until(() =>
      dom.document.body.textContent.includes("Replacement key enrolled."),
    );
    assert.equal((await f.db("seller_factors")).length, 3);
    await click("Cancel this recovery");
    await until(() => f.completed() === 1);
    assert.match(dom.document.body.textContent, /Recovery canceled/);
    assert.equal((await f.db("seller_factors")).length, 1);
    assert.equal((await f.db("auth_recoveries").first()).state, "canceled");
  } finally {
    await f.close();
  }
});

test("AUTH-07: malformed recovery status stays closed; pending submissions are single-flight and navigation stops dependent mutations", async () => {
  for (const value of [
    null,
    { id: 12, csrfToken: "csrf" },
    { id: "flow", csrfToken: null },
  ]) {
    dom.document.body.innerHTML = '<div id="app"></div>';
    const platform = new ApiClient(
      async () => Response.json(value),
      "/api/v1/platform",
    );
    const app = createApp({ render: () => h(RecoveryPanel, { platform }) });
    app.mount("#app");
    await until(() =>
      dom.document.body.textContent.includes(
        "Recovery status could not be loaded",
      ),
    );
    assert.ok(dom.document.querySelector("#account-recovery"));
    app.unmount();
  }
  let resolve!: (response: Response) => void;
  const calls: string[] = [];
  const platform = new ApiClient(async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/status"))
      return new Response("{}", { status: 401 });
    return new Promise<Response>((r) => {
      resolve = r;
    });
  }, "/api/v1/platform");
  dom.document.body.innerHTML = '<div id="app"></div>';
  const app = createApp({ render: () => h(RecoveryPanel, { platform }) });
  app.mount("#app");
  await flush();
  const form = dom.document.querySelector("#account-recovery")!;
  form.dispatchEvent(
    new dom.Event("submit", { bubbles: true, cancelable: true }),
  );
  form.dispatchEvent(
    new dom.Event("submit", { bubbles: true, cancelable: true }),
  );
  await flush();
  assert.equal(calls.filter((p) => p.endsWith("/start")).length, 1);
  app.unmount();
  resolve(Response.json({ ok: true }));
  await flush();
  assert.equal(
    calls.some((p) => p.endsWith("/consume")),
    false,
    "Navigating away cannot consume recovery material in another screen",
  );
  dom.document.body.innerHTML = '<div id="app"></div>';
  const broken = new ApiClient();
  broken.get = async () => {
    throw Error("Recovery unavailable");
  };
  const failure = createApp({
    render: () => h(RecoveryPanel, { platform: broken }),
  });
  failure.mount("#app");
  await until(() =>
    dom.document.body.textContent.includes("Something went wrong"),
  );
  failure.unmount();
});
