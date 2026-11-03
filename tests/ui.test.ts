import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import { ApiClient } from "../web/api.ts";
import type { Account, License, Product } from "../web/api.ts";
import type {
  CheckoutLoader,
  CheckoutSdk,
  CheckoutActions,
  CheckoutSession,
} from "../web/checkout.ts";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css"))
      return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const dom = new Window({ url: "http://localhost:3211/t/primary" });
for (const name of [
  "window",
  "document",
  "navigator",
  "Node",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Event",
  "FocusEvent",
  "HTMLDialogElement",
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value:
      name === "window"
        ? dom
        : (dom as unknown as Record<string, unknown>)[name],
  });
}

interface RequestRecord {
  path: string;
  method: string;
  body: unknown;
  headers: Headers;
}
type Handler = (request: RequestRecord) => Response | Promise<Response>;
const denied = (
  message = "Please sign in.",
  status = 401,
  requestId?: string,
) =>
  Response.json(
    { error: { message, ...(requestId ? { requestId } : {}) } },
    { status },
  );
const product = (): Product => ({
  id: "product-1",
  name: "Example plugin",
  slug: "example-plugin",
  plans: [
    { id: "plan-one", name: "Annual one", site_allowance: 1 },
    { id: "plan-five", name: "Annual five", site_allowance: 5 },
  ],
});
const license = (overrides: Partial<License> = {}): License => ({
  id: "license-one",
  product_id: "product-1",
  product_name: "Example plugin",
  plan_name: "Annual one",
  site_allowance: 1,
  paid_through: Date.UTC(2030, 5, 4),
  billing_status: "active",
  entitled: true,
  revoked: false,
  suspended: false,
  installations: [],
  releases: [],
  ...overrides,
});
const account = (licenses: License[] = [license()]): Account => ({
  customer: { id: "customer-1", email: "customer@example.test" },
  csrfToken: "csrf-from-session",
  licenses,
});

class Server {
  requests: RequestRecord[] = [];
  routes = new Map<string, Handler>();
  currentAccount: Account | null = null;
  products: Product[] = [product()];
  redirects: string[] = [];
  clipboard: string[] = [];
  fetch: typeof fetch = async (input, init) => {
    const request: RequestRecord = {
      path: String(input).replace("/api/v1/tenants/primary", ""),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    this.requests.push(request);
    const handler = this.routes.get(`${request.method} ${request.path}`);
    if (handler) return handler(request);
    if (request.method === "GET" && request.path === "/me")
      return this.currentAccount
        ? Response.json(this.currentAccount)
        : denied();
    if (request.method === "GET" && request.path === "/catalog")
      return Response.json({ products: this.products });
    throw Error(`Unexpected test request: ${request.method} ${request.path}`);
  };
  on(method: string, path: string, handler: Handler) {
    this.routes.set(`${method} ${path}`, handler);
  }
  calls(path: string) {
    return this.requests.filter((request) => request.path === path);
  }
}
let server = new Server();
Object.defineProperty(dom, "fetch", {
  configurable: true,
  value: (...args: Parameters<typeof fetch>) => server.fetch(...args),
});
Object.defineProperty(dom.location, "assign", {
  configurable: true,
  value: (url: string) => {
    server.redirects.push(url);
  },
});
dom.document.body.innerHTML = '<div id="app"></div>';
const ui = await import("../web/main.ts");
let mounted = ui.mountCustomerApp("#app");
const { nextTick } = await import("vue");

async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await nextTick();
  }
}
function find<T extends Element = Element>(selector: string): T {
  const element = dom.document.querySelector(selector);
  assert.ok(element, `Expected rendered element ${selector}`);
  return element as unknown as T;
}
function text() {
  return dom.document.body.textContent || "";
}
function findButton(
  label: string,
  root: Element = dom.document.body as unknown as Element,
): HTMLButtonElement {
  const element = [...root.querySelectorAll("button")].find(
    (button) => button.textContent === label,
  );
  assert.ok(element, `Expected button ${label}`);
  return element as HTMLButtonElement;
}
async function click(label: string, root?: Element) {
  findButton(label, root).click();
  await flush();
}
async function input(selector: string, value: string) {
  const element = find<HTMLInputElement>(selector);
  element.value = value;
  element.dispatchEvent(
    new dom.Event("input", { bubbles: true }) as unknown as Event,
  );
  await flush();
}
async function submit(selector: string) {
  find(selector).dispatchEvent(
    new dom.Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event,
  );
  await flush();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
async function mount(
  configure?: (fixture: Server) => void,
  hash = "",
  checkoutLoader?: CheckoutLoader,
) {
  mounted.unmount();
  server = new Server();
  configure?.(server);
  dom.history.replaceState(null, "", `http://localhost:3211/t/primary${hash}`);
  dom.document.body.innerHTML = '<div id="app"></div>';
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        server.clipboard.push(value);
      },
    },
  });
  mounted = ui.mountCustomerApp("#app", undefined, checkoutLoader);
  await nextTick();
  return server;
}
afterEach(async () => {
  mounted.unmount();
  await flush();
});
after(async () => {
  await dom.happyDOM.close();
});

test("complimentary customer licenses show expiry without offering unavailable billing", async () => {
  await mount((fixture) => {
    fixture.currentAccount = {
      ...account([
        license({
          provenance: "complimentary",
          expires_at: Date.UTC(2030, 5, 4),
          paid_through: 0,
          billing_status: "complimentary",
          plan_name: "Complimentary",
        }),
      ]),
      billingAvailable: false,
    };
    fixture.on("GET", "/catalog", () =>
      Response.json({ products: [], billingAvailable: false }),
    );
  });
  await flush();
  assert.match(text(), /Complimentary/);
  assert.match(text(), /Expires/);
  assert.doesNotMatch(text(), /Manage billing/);
  assert.match(text(), /Paid checkout is unavailable/);
});

test("a complimentary license with an unavailable expiry displays no invented paid-through date", async () => {
  await mount((fixture) => { fixture.currentAccount = account([license({ provenance: "complimentary", expires_at: null, paid_through: 0 })]); });
  await flush();
  assert.match(text(), /Expires/);
  assert.doesNotMatch(text(), /Paid through/);
});
test("Vue mounts and exposes genuine account and catalog loading states", async () => {
  const me = deferred<Response>();
  const catalog = deferred<Response>();
  await mount((fixture) => {
    fixture.on("GET", "/me", () => me.promise);
    fixture.on("GET", "/catalog", () => catalog.promise);
  });
  assert.match(text(), /Loading your account/);
  assert.match(text(), /Loading plans/);
  me.resolve(denied());
  catalog.resolve(Response.json({ products: [product()] }));
  await flush();
  assert.match(text(), /Sign in to your account/);
  assert.equal(find<HTMLInputElement>('input[value="plan-one"]').checked, true);
  assert.doesNotMatch(text(), /Loading/);
});

test("session and catalog failures offer independent retries and retain useful request references", async () => {
  await mount((fixture) => {
    fixture.on("GET", "/me", () =>
      denied("Account temporarily unavailable.", 503, "account-ref"),
    );
    fixture.on("GET", "/catalog", () =>
      denied("Plans temporarily unavailable.", 503, "catalog-ref"),
    );
  });
  await flush();
  assert.match(text(), /Your account could not be loaded/);
  assert.match(
    text(),
    /Account temporarily unavailable. Reference: account-ref/,
  );
  assert.match(text(), /Plans temporarily unavailable. Reference: catalog-ref/);
  const retry = deferred<Response>();
  server.on("GET", "/me", () => retry.promise);
  findButton("Try again").click();
  await flush();
  assert.match(text(), /Loading your account/);
  retry.resolve(denied());
  server.on("GET", "/catalog", () => Response.json({ products: [product()] }));
  await click("Reload plans");
  assert.match(text(), /Sign in to your account/);
  assert.doesNotMatch(text(), /temporarily unavailable/);
  assert.equal(find<HTMLInputElement>('input[value="plan-one"]').checked, true);
});

test("empty catalogs and products without configured plans never enable checkout", async () => {
  await mount((fixture) => {
    fixture.products = [];
  });
  await flush();
  assert.match(text(), /No plans are available yet/);
  assert.equal(dom.document.querySelector(".checkout-form"), null);
  await mount((fixture) => {
    fixture.products = [{ ...product(), plans: [] }];
  });
  await flush();
  assert.equal(findButton("Continue to payment").disabled, true);
  assert.equal(dom.document.querySelector('input[type="radio"]'), null);
});

test("login email submission trims input, prevents duplicate in-flight requests, and resets its notice on edits", async () => {
  const pending = deferred<Response>();
  await mount((fixture) => {
    fixture.on("POST", "/auth/request", () => pending.promise);
  });
  await flush();
  await input("#login-email", "  known@example.test  ");
  const form = find("#sign-in form");
  form.dispatchEvent(
    new dom.Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event,
  );
  form.dispatchEvent(
    new dom.Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event,
  );
  await flush();
  assert.equal(server.calls("/auth/request").length, 1);
  assert.deepEqual(server.calls("/auth/request")[0]?.body, {
    email: "known@example.test",
  });
  assert.equal(
    server.calls("/auth/request")[0]?.headers.has("X-CSRF-Token"),
    false,
  );
  assert.equal(findButton("Sending link…").disabled, true);
  pending.resolve(Response.json({ ok: true }));
  await flush();
  assert.match(
    find(".inline-notice").textContent || "",
    /If an account exists/,
  );
  await input("#login-email", "different@example.test");
  assert.equal(dom.document.querySelector(".inline-notice"), null);
  assert.equal(findButton("Email me a sign-in link").disabled, false);
});

test("login request failures stay recoverable and can be dismissed", async () => {
  await mount((fixture) => {
    fixture.on("POST", "/auth/request", () =>
      denied("Too many requests.", 429, "login-ref"),
    );
  });
  await flush();
  await input("#login-email", "person@example.test");
  await submit("#sign-in form");
  assert.match(
    find('[role="alert"]').textContent || "",
    /Too many requests. Reference: login-ref/,
  );
  assert.equal(findButton("Email me a sign-in link").disabled, false);
  await click("Dismiss");
  assert.equal(dom.document.querySelector(".error-banner"), null);
  server.on("POST", "/auth/request", () => {
    throw new TypeError("network unavailable");
  });
  await submit("#sign-in form");
  assert.match(
    find('[role="alert"]').textContent || "",
    /Check your connection/,
  );
});

test("email credentials are removed immediately and consumed only after confirmation and initial session lookup", async () => {
  const initial = deferred<Response>();
  const consume = deferred<Response>();
  await mount((fixture) => {
    fixture.on("GET", "/me", () => initial.promise);
    fixture.on("POST", "/auth/consume", () => consume.promise);
  }, "?from=email#login=token%2Bencoded");
  assert.equal(dom.location.hash, "");
  assert.equal(dom.location.search, "?from=email");
  assert.equal(findButton("Confirm sign in").disabled, true);
  assert.equal(server.calls("/auth/consume").length, 0);
  initial.resolve(denied());
  await flush();
  findButton("Confirm sign in").click();
  await flush();
  assert.equal(findButton("Signing in…").disabled, true);
  assert.deepEqual(server.calls("/auth/consume")[0]?.body, {
    token: "token+encoded",
  });
  assert.equal(
    server.calls("/auth/consume")[0]?.headers.has("X-CSRF-Token"),
    false,
  );
  server.routes.delete("GET /me");
  server.currentAccount = account();
  consume.resolve(Response.json({ ok: true }));
  await flush();
  assert.match(text(), /You are signed in/);
  assert.match(text(), /customer@example.test/);
  assert.equal(dom.document.querySelector(".login-confirm"), null);
  assert.equal(
    find<HTMLInputElement>("#checkout-email").value,
    "customer@example.test",
  );
});

test("fragment changes can be canceled, empty fragments cannot be consumed, and unmount removes the fragment watcher", async () => {
  await mount();
  await flush();
  dom.location.hash = "#login=";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  await flush();
  assert.equal(dom.location.hash, "");
  assert.equal(findButton("Confirm sign in").disabled, true);
  await click("Cancel");
  assert.equal(dom.document.querySelector(".login-confirm"), null);
  dom.location.hash = "#login=second-link";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  await flush();
  assert.equal(findButton("Confirm sign in").disabled, false);
  await click("Cancel");
  assert.equal(server.calls("/auth/consume").length, 0);
  mounted.unmount();
  dom.location.hash = "#login=after-unmount";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  await flush();
  assert.equal(dom.location.hash, "#login=after-unmount");
});

test("a consumed or expired sign-in link displays a useful error without creating an account", async () => {
  await mount((fixture) => {
    fixture.on("POST", "/auth/consume", () =>
      denied("This link expired.", 401),
    );
  }, "#login=expired-token");
  await flush();
  await click("Confirm sign in");
  assert.match(find(".error-banner").textContent || "", /This link expired/);
  assert.equal(dom.document.querySelector(".dashboard"), null);
  assert.equal(findButton("Confirm sign in").disabled, false);
  await click("Cancel");
});

test("an invalid login link preserves an already signed-in account, visible key and session CSRF", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account();
    fixture.on("POST", "/licenses/license-one/key", () =>
      Response.json({ key: "DE-kept-secret" }),
    );
    fixture.on("POST", "/auth/consume", () =>
      denied("This link expired.", 401),
    );
    fixture.on("POST", "/portal", () =>
      denied("Billing temporarily unavailable.", 503),
    );
  });
  await flush();
  await rotate();
  dom.location.hash = "#login=expired-token";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  await flush();
  await click("Confirm sign in");
  assert.match(find(".error-banner").textContent || "", /This link expired/);
  assert.ok(dom.document.querySelector(".dashboard"));
  assert.match(
    find(".account-email").textContent || "",
    /customer@example.test/,
  );
  assert.equal(
    find<HTMLInputElement>("#new-license-key").value,
    "DE-kept-secret",
  );
  assert.equal(
    server.calls("/auth/consume")[0]?.headers.has("X-CSRF-Token"),
    false,
  );
  await click("Cancel");
  await click("Manage billing ↗");
  assert.equal(
    server.calls("/portal")[0]?.headers.get("X-CSRF-Token"),
    "csrf-from-session",
  );
  await click("Copy key");
  assert.deepEqual(server.clipboard, ["DE-kept-secret"]);
});

test("a successful consume followed by an unavailable or unauthorized account never claims sign-in succeeded", async () => {
  await mount((fixture) => {
    fixture.on("POST", "/auth/consume", () => Response.json({ ok: true }));
  }, "#login=one");
  await flush();
  await click("Confirm sign in");
  assert.doesNotMatch(text(), /You are signed in/);
  assert.match(text(), /Sign in to your account/);
  await mount((fixture) => {
    fixture.on("POST", "/auth/consume", () => {
      fixture.on("GET", "/me", () => denied("Read unavailable.", 503));
      return Response.json({ ok: true });
    });
  }, "#login=two");
  await flush();
  await click("Confirm sign in");
  assert.match(text(), /Your account could not be loaded/);
  assert.doesNotMatch(text(), /You are signed in/);
});

test("empty accounts can refresh newly confirmed licenses without a full page reload", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account([]);
  });
  await flush();
  assert.match(text(), /Your licenses will appear here/);
  const refresh = deferred<Response>();
  server.on("GET", "/me", () => refresh.promise);
  findButton("Refresh licenses").click();
  await flush();
  assert.equal(findButton("Refresh licenses").disabled, true);
  refresh.resolve(Response.json(account()));
  await flush();
  assert.match(text(), /Example plugin/);
  assert.equal(dom.document.querySelector(".empty-account"), null);
});

test("license cards show entitlement states, seat exemptions, requirements, and safe release text", async () => {
  const active = license({
    id: "license/encoded",
    site_allowance: 5,
    installations: [
      {
        id: "active",
        installation_id: "install-a",
        site_url: "active.example.test/path",
        active: true,
        exempt: false,
      },
      {
        id: "exempt",
        installation_id: "install-e",
        site_url: "local.example.test",
        active: true,
        exempt: true,
      },
      {
        id: "inactive",
        installation_id: "install-i",
        site_url: "old.example.test",
        active: false,
        exempt: false,
      },
    ],
    releases: [
      {
        id: "release/one",
        version: "1.2.0",
        changelog: "<script>untrusted()</script>\nFixed a field.",
        checksum: "abc123",
        min_wp: "6.0",
        min_php: "8.1",
        min_free: "2.0",
      },
      {
        id: "release-two",
        version: "1.1.0",
        changelog: "",
        checksum: "def456",
        min_wp: null,
        min_php: null,
        min_free: null,
      },
    ],
  });
  await mount((fixture) => {
    fixture.currentAccount = account([
      active,
      license({ id: "revoked", revoked: true, entitled: false }),
      license({ id: "suspended", suspended: true, entitled: false }),
      license({
        id: "expired",
        entitled: false,
        paid_through: null,
        billing_status: "past_due",
        releases: active.releases,
      }),
    ]);
  });
  await flush();
  assert.deepEqual(
    [...dom.document.querySelectorAll(".status")].map(
      (element) => element.textContent,
    ),
    ["Active", "Revoked", "Suspended", "Expired"],
  );
  assert.match(text(), /1 of 5 used/);
  assert.match(text(), /2 active/);
  assert.match(text(), /Does not use a seat/);
  assert.match(text(), /Inactive/);
  assert.match(text(), /2030/);
  assert.match(text(), /Not yet available/);
  assert.match(text(), /past due/);
  assert.match(text(), /Installed plugin features stay available/);
  assert.match(text(), /WordPress 6.0\+ · PHP 8.1\+ · Free plugin 2.0\+/);
  assert.match(text(), /No release notes provided/);
  assert.match(text(), /No releases are available yet/);
  assert.match(text(), /Your installations will appear here/);
  assert.equal(dom.document.querySelector("script"), null);
  const downloads = [...dom.document.querySelectorAll('a[href*="/download"]')];
  assert.equal(downloads.length, 2);
  assert.equal(
    downloads[0]?.getAttribute("href"),
    "/api/v1/tenants/primary/licenses/license%2Fencoded/releases/release%2Fone/download",
  );
  const expired = find("#license-expired").closest("article");
  assert.equal(expired?.querySelector('a[href*="/download"]'), null);
  assert.match(expired?.textContent || "", /Access unavailable/);
  const details = find<HTMLDetailsElement>(".release-details");
  details.open = true;
  assert.match(details.textContent || "", /abc123/);
  assert.match(details.textContent || "", /<script>untrusted\(\)<\/script>/);
});

async function rotate() {
  await click("Replace license key");
  const dialog = find<HTMLDialogElement>("dialog");
  assert.equal(dialog.open, true);
  assert.match(dialog.textContent || "", /all activation tokens/);
  assert.match(
    dialog.textContent || "",
    /Installed plugin features stay available/,
  );
  await click("Replace key", dialog);
}
function keyRoute(fixture: Server, key = "DE-unit-test-secret") {
  fixture.currentAccount = account();
  fixture.on("POST", "/licenses/license-one/key", () => Response.json({ key }));
}

test("key replacement requires confirmation, supports both cancel actions, and exposes one selectable copy once", async () => {
  const rotating = deferred<Response>();
  await mount((fixture) => {
    keyRoute(fixture);
    fixture.on("POST", "/licenses/license-one/key", () => rotating.promise);
  });
  await flush();
  await click("Replace license key");
  const canceled = new dom.Event("cancel", { cancelable: true });
  find("dialog").dispatchEvent(canceled as unknown as Event);
  await flush();
  assert.equal(canceled.defaultPrevented, true);
  assert.equal(dom.document.querySelector("dialog"), null);
  assert.equal(server.calls("/licenses/license-one/key").length, 0);
  await click("Replace license key");
  await click("Cancel", find("dialog"));
  assert.equal(dom.document.querySelector("dialog"), null);
  await rotate();
  assert.equal(findButton("Replacing…").disabled, true);
  assert.equal(
    server.calls("/licenses/license-one/key")[0]?.headers.get("X-CSRF-Token"),
    "csrf-from-session",
  );
  rotating.resolve(Response.json({ key: "DE-unit-test-secret" }));
  await flush();
  const field = find<HTMLInputElement>("#new-license-key");
  assert.equal(field.value, "DE-unit-test-secret");
  assert.equal(field.readOnly, true);
  assert.equal(dom.document.activeElement, field);
  assert.equal(field.selectionStart, 0);
  assert.equal(field.selectionEnd, field.value.length);
  assert.match(text(), /This key is shown once/);
  await click("Copy key");
  assert.deepEqual(server.clipboard, ["DE-unit-test-secret"]);
  assert.match(text(), /License key copied/);
  await click("I saved my key");
  assert.equal(dom.document.querySelector("#new-license-key"), null);
  assert.doesNotMatch(text(), /DE-unit-test-secret/);
});

test("copy key uses a keyboard fallback when clipboard API is unavailable", async () => {
  await mount(keyRoute);
  await flush();
  await rotate();
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  await click("Copy key");
  assert.match(text(), /Key selected. Copy it using your keyboard/);
  const field = find<HTMLInputElement>("#new-license-key");
  assert.equal(dom.document.activeElement, field);
  assert.equal(field.selectionEnd, field.value.length);
});

test("clipboard rejection keeps the new key available and restores the copy action", async () => {
  const copied = deferred<void>();
  await mount(keyRoute);
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: { writeText: () => copied.promise },
  });
  await flush();
  await rotate();
  findButton("Copy key").click();
  await flush();
  assert.equal(findButton("Copying…").disabled, true);
  copied.reject(new Error("Clipboard permission refused."));
  await flush();
  assert.match(
    find(".error-banner").textContent || "",
    /Something went wrong. Please try again/,
  );
  assert.equal(
    find<HTMLInputElement>("#new-license-key").value,
    "DE-unit-test-secret",
  );
  assert.equal(findButton("Copy key").disabled, false);
  assert.match(text(), /Your licenses/);
});

test("a failed account refresh after rotation must preserve the newly issued one-time key", async () => {
  await mount((fixture) => {
    keyRoute(fixture);
    fixture.on("POST", "/licenses/license-one/key", () => {
      fixture.on("GET", "/me", () =>
        denied("Account refresh failed.", 503, "refresh-ref"),
      );
      return Response.json({ key: "DE-recovery-key" });
    });
  });
  await flush();
  await rotate();
  assert.equal(
    find<HTMLInputElement>("#new-license-key").value,
    "DE-recovery-key",
  );
  assert.match(
    find(".error-banner").textContent || "",
    /Account refresh failed. Reference: refresh-ref/,
  );
  assert.equal(dom.document.querySelector(".dashboard") !== null, true);
  await click("Copy key");
  assert.deepEqual(server.clipboard, ["DE-recovery-key"]);
});

test("expired session responses clear the account and any displayed key", async () => {
  await mount(keyRoute);
  await flush();
  await rotate();
  assert.ok(dom.document.querySelector("#new-license-key"));
  server.on("POST", "/licenses/license-one/key", () =>
    denied("Your session expired.", 401),
  );
  await rotate();
  assert.match(find(".error-banner").textContent || "", /Your session expired/);
  assert.equal(dom.document.querySelector(".dashboard"), null);
  assert.equal(dom.document.querySelector("#new-license-key"), null);
  assert.match(text(), /Sign in to your account/);
  assert.doesNotMatch(text(), /DE-unit-test-secret/);
});

test("installation deactivation is confirmed, sends CSRF, updates seats, and retains inactive history", async () => {
  const installation = {
    id: "installation/one",
    installation_id: "stable-id",
    site_url: "site.example.test",
    active: true,
    exempt: false,
  };
  const pending = deferred<Response>();
  await mount((fixture) => {
    fixture.currentAccount = account([
      license({ installations: [installation] }),
    ]);
    fixture.on(
      "POST",
      "/installations/installation%2Fone/deactivate",
      () => pending.promise,
    );
  });
  await flush();
  await click("Deactivate");
  assert.match(find("dialog").textContent || "", /site.example.test/);
  await click("Cancel", find("dialog"));
  assert.equal(
    server.calls("/installations/installation%2Fone/deactivate").length,
    0,
  );
  await click("Deactivate");
  await click("Deactivate installation", find("dialog"));
  assert.equal(findButton("Deactivating…").disabled, true);
  assert.equal(
    server
      .calls("/installations/installation%2Fone/deactivate")[0]
      ?.headers.get("X-CSRF-Token"),
    "csrf-from-session",
  );
  server.currentAccount = account([
    license({ installations: [{ ...installation, active: false }] }),
  ]);
  pending.resolve(Response.json({ ok: true }));
  await flush();
  assert.match(text(), /Installation deactivated/);
  assert.match(text(), /0 of 1 used/);
  assert.match(text(), /Inactive/);
  assert.equal(
    [...dom.document.querySelectorAll("button")].some(
      (button) => button.textContent === "Deactivate",
    ),
    false,
  );
});

test("deactivation failure leaves the installation active and exposes a retryable error", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account([
      license({
        installations: [
          {
            id: "installation",
            installation_id: "stable",
            site_url: "site.example.test",
            active: true,
            exempt: false,
          },
        ],
      }),
    ]);
    fixture.on("POST", "/installations/installation/deactivate", () =>
      denied("Deactivation failed.", 503),
    );
  });
  await flush();
  await click("Deactivate");
  await click("Deactivate installation", find("dialog"));
  assert.match(find(".error-banner").textContent || "", /Deactivation failed/);
  assert.equal(findButton("Deactivate").disabled, false);
  assert.match(text(), /1 of 1 used/);
  assert.doesNotMatch(text(), /Installation deactivated/);
});

test("checkout submits the selected plan and trimmed email, then follows the returned URL", async () => {
  const pending = deferred<Response>();
  await mount((fixture) => {
    fixture.on("POST", "/checkout", () => pending.promise);
  });
  await flush();
  const five = find<HTMLInputElement>('input[value="plan-five"]');
  five.checked = true;
  five.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await input("#checkout-email", "  buyer@example.test  ");
  await submit(".checkout-form");
  assert.deepEqual(server.calls("/checkout")[0]?.body, {
    planId: "plan-five",
    email: "buyer@example.test",
    uiMode: "elements",
  });
  assert.equal(
    server.calls("/checkout")[0]?.headers.has("X-CSRF-Token"),
    false,
  );
  assert.equal(findButton("Preparing secure payment…").disabled, true);
  pending.resolve(
    Response.json({ url: "https://checkout.example.test/session" }),
  );
  await flush();
  assert.deepEqual(server.redirects, ["https://checkout.example.test/session"]);
});

test("checkout errors do not redirect and leave the selection ready for another attempt", async () => {
  await mount((fixture) => {
    fixture.on("POST", "/checkout", () =>
      denied("Checkout is unavailable.", 503),
    );
  });
  await flush();
  await input("#checkout-email", "buyer@example.test");
  await submit(".checkout-form");
  assert.match(
    find(".error-banner").textContent || "",
    /Checkout is unavailable/,
  );
  assert.deepEqual(server.redirects, []);
  assert.equal(findButton("Continue to payment").disabled, false);
  assert.equal(find<HTMLInputElement>('input[value="plan-one"]').checked, true);
});

test("billing portal uses session CSRF and follows the server URL only after success", async () => {
  const pending = deferred<Response>();
  await mount((fixture) => {
    fixture.currentAccount = account();
    fixture.on("POST", "/portal", () => pending.promise);
  });
  await flush();
  findButton("Manage billing ↗").click();
  await flush();
  assert.equal(findButton("Opening billing…").disabled, true);
  assert.deepEqual(server.calls("/portal")[0]?.body, {});
  assert.equal(
    server.calls("/portal")[0]?.headers.get("X-CSRF-Token"),
    "csrf-from-session",
  );
  pending.resolve(
    Response.json({ url: "https://billing.example.test/portal" }),
  );
  await flush();
  assert.deepEqual(server.redirects, ["https://billing.example.test/portal"]);
});

test("logout waits for server acknowledgement and hides the account only after success", async () => {
  const pending = deferred<Response>();
  await mount((fixture) => {
    fixture.currentAccount = account();
    fixture.on("POST", "/auth/logout", () => pending.promise);
  });
  await flush();
  findButton("Sign out").click();
  await flush();
  assert.equal(findButton("Signing out…").disabled, true);
  assert.ok(dom.document.querySelector(".dashboard"));
  assert.equal(
    server.calls("/auth/logout")[0]?.headers.get("X-CSRF-Token"),
    "csrf-from-session",
  );
  pending.resolve(Response.json({ ok: true }));
  await flush();
  assert.equal(dom.document.querySelector(".dashboard"), null);
  assert.equal(find<HTMLInputElement>("#checkout-email").value, "");
  assert.match(text(), /You are signed out/);
  assert.match(text(), /Sign in to your account/);
});

test("logout errors preserve the account and restore the sign-out action", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account();
    fixture.on("POST", "/auth/logout", () =>
      denied("Please retry sign out.", 503),
    );
  });
  await flush();
  await click("Sign out");
  assert.match(
    find(".error-banner").textContent || "",
    /Please retry sign out/,
  );
  assert.ok(dom.document.querySelector(".dashboard"));
  assert.equal(findButton("Sign out").disabled, false);
});

test("malformed account responses cannot leave the header pretending a customer is signed in", async () => {
  for (const payload of [
    null,
    {},
    { customer: {} },
    {
      customer: { email: "person@example.test" },
      licenses: null,
      csrfToken: "token",
    },
    { ...account(), csrfToken: null },
  ]) {
    await mount((fixture) => {
      fixture.on("GET", "/me", () => Response.json(payload));
    });
    await flush();
    assert.match(text(), /Your account could not be loaded/);
    assert.match(text(), /Something went wrong. Please try again/);
    assert.equal(
      [...dom.document.querySelectorAll("button")].some(
        (button) => button.textContent === "Sign out",
      ),
      false,
    );
    assert.equal(dom.document.querySelector(".dashboard"), null);
  }
  server.routes.delete("GET /me");
  await click("Try again");
  assert.match(text(), /Sign in to your account/);
});

test("pending account requests may settle after unmount without remounting or consuming later email links", async () => {
  const pending = deferred<Response>();
  await mount((fixture) => {
    fixture.on("GET", "/me", () => pending.promise);
  });
  mounted.unmount();
  pending.resolve(Response.json(account()));
  dom.location.hash = "#login=must-not-be-consumed";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  await flush();
  assert.equal(dom.document.querySelector(".app"), null);
  assert.equal(dom.location.hash, "#login=must-not-be-consumed");
  assert.equal(server.calls("/auth/consume").length, 0);
});

test("an expired session discovered during the post-rotation refresh clears the one-time key and account", async () => {
  await mount((fixture) => {
    keyRoute(fixture);
    fixture.on("POST", "/licenses/license-one/key", () => {
      fixture.on("GET", "/me", () => denied());
      return Response.json({ key: "DE-no-longer-visible" });
    });
  });
  await flush();
  await rotate();
  assert.equal(dom.document.querySelector(".dashboard"), null);
  assert.equal(dom.document.querySelector("#new-license-key"), null);
  assert.match(text(), /Sign in to your account/);
});

test("switching accounts never retains the previous identity or CSRF after the new sign-in succeeds but reload fails", async (t) => {
  const csrfAtAccountReads: string[] = [];
  const get = ApiClient.prototype.get;
  t.mock.method(ApiClient.prototype, "get", function <
    T,
  >(this: ApiClient, path: string): Promise<T> {
    if (path === "/me") csrfAtAccountReads.push(this.csrfToken);
    return get.call(this, path) as Promise<T>;
  });
  await mount((fixture) => {
    fixture.currentAccount = {
      ...account(),
      customer: { id: "customer-a", email: "customer-a@example.test" },
      csrfToken: "csrf-for-customer-a",
    };
    fixture.on("POST", "/auth/consume", (request) => {
      assert.deepEqual(request.body, { token: "customer-b-link" });
      fixture.on("GET", "/me", () =>
        denied("New account temporarily unavailable.", 503),
      );
      return Response.json({ ok: true });
    });
    fixture.on("POST", "/portal", () =>
      denied("No valid new-session CSRF.", 403),
    );
  }, "#login=customer-b-link");
  await flush();
  assert.match(text(), /customer-a@example.test/);
  await click("Confirm sign in");
  assert.doesNotMatch(text(), /customer-a@example.test/);
  assert.doesNotMatch(text(), /You are signed in/);
  assert.equal(dom.document.querySelector(".dashboard"), null);
  assert.match(text(), /Your account could not be loaded/);
  assert.equal(find<HTMLInputElement>("#checkout-email").value, "");
  assert.equal(
    [...dom.document.querySelectorAll("button")].some(
      (button) => button.textContent === "Sign out",
    ),
    false,
  );
  assert.deepEqual(csrfAtAccountReads, ["", ""]);
});

test("a failed sign-in confirmation preserves a manually entered unauthenticated purchase email", async () => {
  await mount((fixture) => {
    fixture.on("POST", "/auth/consume", () => denied("Link expired.", 401));
  }, "#login=expired");
  await flush();
  await input("#checkout-email", "typed-before-sign-in@example.test");
  await click("Confirm sign in");
  assert.equal(
    find<HTMLInputElement>("#checkout-email").value,
    "typed-before-sign-in@example.test",
  );
  assert.match(text(), /Link expired/);
});

test("dismissing a one-time key wins over a copy action queued before the DOM rerenders", async () => {
  await mount(keyRoute);
  await flush();
  await rotate();
  const copy = findButton("Copy key");
  const dismiss = findButton("I saved my key");
  // State changes synchronously; Vue removes the controls at the next render.
  // A competing action must not copy a dismissed secret or report a false error.
  dismiss.click();
  copy.click();
  await flush();
  assert.equal(dom.document.querySelector("#new-license-key"), null);
  assert.deepEqual(server.clipboard, []);
  assert.equal(dom.document.querySelector(".error-banner"), null);
  assert.doesNotMatch(text(), /License key copied/);
  assert.equal(findButton("Replace license key").disabled, false);
});

test("checkout identity conflicts retain the signed-in account, CSRF and visible replacement key", async () => {
  await mount((fixture) => {
    keyRoute(fixture);
    fixture.on("POST", "/checkout", () =>
      Response.json(
        {
          error: {
            code: "checkout_identity_conflict",
            message: "Sign in with this purchase email before checking out.",
            requestId: "checkout-conflict-ref",
          },
        },
        { status: 409 },
      ),
    );
    fixture.on("POST", "/portal", () =>
      denied("Billing temporarily unavailable.", 503),
    );
  });
  await flush();
  await rotate();
  await input("#checkout-email", "other-account@example.test");
  await submit(".checkout-form");
  assert.match(
    find(".error-banner").textContent || "",
    /Sign in with this purchase email before checking out. Reference: checkout-conflict-ref/,
  );
  assert.match(
    find(".account-email").textContent || "",
    /customer@example.test/,
  );
  assert.ok(dom.document.querySelector(".dashboard"));
  assert.equal(
    find<HTMLInputElement>("#new-license-key").value,
    "DE-unit-test-secret",
  );
  assert.equal(
    find<HTMLInputElement>("#checkout-email").value,
    "other-account@example.test",
  );
  assert.deepEqual(server.redirects, []);
  await click("Manage billing ↗");
  assert.equal(
    server.calls("/portal")[0]?.headers.get("X-CSRF-Token"),
    "csrf-from-session",
  );
  assert.equal(
    find<HTMLInputElement>("#new-license-key").value,
    "DE-unit-test-secret",
  );
  await click("Copy key");
  assert.deepEqual(server.clipboard, ["DE-unit-test-secret"]);
});

test("buyer mounting requires a tenant route and all requests use that tenant", async () => {
  dom.history.replaceState(null, "", "/");
  assert.throws(() => ui.mountCustomerApp("#app", server.fetch), /tenant/);
  dom.history.replaceState(null, "", "/t/another-seller");
  const paths: string[] = [];
  mounted = ui.mountCustomerApp("#app", async (input) => {
    paths.push(String(input));
    return String(input).endsWith("/catalog")
      ? Response.json({ products: [] })
      : denied();
  });
  await flush();
  assert.deepEqual(paths.sort(), [
    "/api/v1/tenants/another-seller/catalog",
    "/api/v1/tenants/another-seller/me",
  ]);
});

function paymentFixture() {
  let destroyed = 0,
    mountedCount = 0;
  const session: CheckoutSession = {
    currency: "usd",
    canConfirm: true,
    total: { total: { amount: "$120.00", minorUnitsAmount: 12000 } },
    status: { type: "open" },
  };
  const actions: CheckoutActions = {
    getSession: () => session,
    confirm: async () => ({
      type: "success",
      session: {
        ...session,
        status: { type: "complete", paymentStatus: "paid" },
      },
    }),
  };
  const sdk: CheckoutSdk = {
    on: () => {},
    loadActions: async () => ({ type: "success", actions }),
    createPaymentElement: () => ({
      on: () => {},
      mount: (container) => {
        mountedCount++;
        container.setAttribute("data-stripe-mounted", "true");
      },
      destroy: () => {
        destroyed++;
      },
    }),
  };
  const stripe = { initCheckoutElementsSdk: () => sdk };
  const loader: CheckoutLoader = async () => stripe;
  const response = () =>
    Response.json({
      uiMode: "elements",
      clientSecret: "cs_ui_secret",
      publishableKey: "pk_test_ui",
      stripeAccount: "acct_ui",
      returnUrl: "http://localhost:3211/t/primary?checkout=return",
    });
  return {
    actions,
    sdk,
    stripe,
    loader,
    response,
    destroyed: () => destroyed,
    mounted: () => mountedCount,
  };
}
test("Elements checkout mounts branded payment fields, shows canonical total, retries validation and prevents duplicate payment", async () => {
  const p = paymentFixture(),
    loading = deferred<Awaited<ReturnType<CheckoutSdk["loadActions"]>>>();
  p.sdk.loadActions = () => loading.promise;
  await mount(
    (fixture) => fixture.on("POST", "/checkout", p.response),
    "",
    p.loader,
  );
  await flush();
  await input("#checkout-email", "buyer@example.test");
  await submit(".checkout-form");
  assert.match(text(), /Loading secure payment form/);
  await submit(".checkout-form");
  assert.equal(server.calls("/checkout").length, 1);
  assert.ok(dom.document.querySelector('[data-stripe-mounted="true"]'));
  assert.equal(findButton("Pay now").disabled, true);
  loading.resolve({ type: "success", actions: p.actions });
  await flush();
  assert.match(text(), /\$120.00 USD/);
  assert.match(text(), /Renews annually until canceled/);
  assert.equal(find<HTMLInputElement>("#checkout-email").disabled, true);
  assert.equal(findButton("Pay now").disabled, false);
  p.actions.confirm = async () => ({
    type: "error",
    error: { message: "Check your payment details." },
  });
  await click("Pay now");
  assert.match(text(), /Check your payment details/);
  const pending = deferred<Awaited<ReturnType<CheckoutActions["confirm"]>>>();
  let attempts = 0;
  p.actions.confirm = () => {
    attempts++;
    return pending.promise;
  };
  const form = find(".payment-form");
  for (let index = 0; index < 2; index++)
    form.dispatchEvent(
      new dom.Event("submit", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
  await flush();
  assert.equal(attempts, 1);
  assert.equal(findButton("Submitting payment…").disabled, true);
  assert.equal(findButton("Cancel checkout").disabled, true);
  pending.resolve({
    type: "success",
    session: {
      ...p.actions.getSession(),
      status: { type: "complete", paymentStatus: "paid" },
    },
  });
  await flush();
  assert.match(text(), /Payment completed/);
  assert.match(text(), /after our server confirms payment/);
  assert.equal(p.destroyed(), 1);
  assert.equal(server.calls("/me").length, 1);
  assert.equal(dom.document.querySelector(".dashboard"), null);
  assert.doesNotMatch(dom.location.href, /secret/);
  assert.equal(dom.localStorage.length, 0);
  assert.equal(dom.sessionStorage.length, 0);
  await click("Close checkout");
  assert.equal(dom.document.querySelector(".payment-panel"), null);
});
test("Elements loader errors offer a fresh session retry and cancellation destroys mounted fields", async () => {
  const p = paymentFixture();
  let loads = 0;
  const loader: CheckoutLoader = async (...args) => {
    if (++loads === 1) throw Error("private details");
    return p.loader(...args);
  };
  await mount(
    (fixture) => fixture.on("POST", "/checkout", p.response),
    "",
    loader,
  );
  await flush();
  await input("#checkout-email", "buyer@example.test");
  await submit(".checkout-form");
  assert.match(text(), /Secure checkout could not load/);
  await click("Retry secure checkout");
  assert.equal(server.calls("/checkout").length, 2);
  assert.equal(p.mounted(), 1);
  await click("Cancel checkout");
  assert.equal(p.destroyed(), 1);
  assert.equal(dom.document.querySelector(".payment-panel"), null);
  assert.equal(findButton("Continue to payment").disabled, false);
});
test("Elements confirmation stays pending until the server confirms licensing", async () => {
  const p = paymentFixture();
  p.actions.confirm = async () => ({
    type: "success",
    session: p.actions.getSession(),
  });
  await mount(
    (fixture) => fixture.on("POST", "/checkout", p.response),
    "",
    p.loader,
  );
  await flush();
  await input("#checkout-email", "buyer@example.test");
  await submit(".checkout-form");
  await click("Pay now");
  assert.match(text(), /Payment submitted. Confirmation is pending/);
  assert.match(text(), /after our server confirms payment/);
  assert.equal(dom.document.querySelector(".payment-form"), null);
  assert.equal(server.calls("/me").length, 1);
});
test("Cancel, sign-out and unmount discard a delayed Stripe loader", async () => {
  for (const reason of ["cancel", "logout", "unmount"]) {
    const p = paymentFixture(),
      pending = deferred<Awaited<ReturnType<CheckoutLoader>>>();
    await mount(
      (fixture) => {
        fixture.currentAccount = account();
        fixture.on("POST", "/checkout", p.response);
        fixture.on("POST", "/auth/logout", () => Response.json({ ok: true }));
      },
      "",
      () => pending.promise,
    );
    await flush();
    await submit(".checkout-form");
    if (reason === "cancel") await click("Cancel checkout");
    else if (reason === "logout") await click("Sign out");
    else mounted.unmount();
    pending.resolve(p.stripe);
    await flush();
    assert.equal(p.mounted(), 0);
    assert.equal(dom.document.querySelector(".payment-panel"), null);
    assert.equal(server.redirects.length, 0);
  }
});
test("Cancel or unmount during session creation ignores late Elements and hosted responses", async () => {
  for (const reason of ["cancel", "unmount"])
    for (const mode of ["elements", "hosted"]) {
      const p = paymentFixture(),
        pending = deferred<Response>();
      await mount(
        (fixture) => fixture.on("POST", "/checkout", () => pending.promise),
        "",
        p.loader,
      );
      await flush();
      await input("#checkout-email", "buyer@example.test");
      await submit(".checkout-form");
      if (reason === "cancel") await click("Cancel checkout");
      else mounted.unmount();
      pending.resolve(
        mode === "elements"
          ? p.response()
          : Response.json({ url: "https://checkout.example.test/late" }),
      );
      await flush();
      assert.equal(p.mounted(), 0);
      assert.deepEqual(server.redirects, []);
      assert.equal(dom.document.querySelector(".payment-panel"), null);
    }
});

test("checkout return markers show non-authoritative notices and are removed without losing other URL context", async () => {
  for (const marker of ["return", "success", "canceled", "unknown"]) {
    await mount(undefined, `?checkout=${marker}&campaign=example#details`);
    await flush();
    if (marker === "unknown") {
      assert.equal(
        new URL(dom.location.href).searchParams.get("checkout"),
        "unknown",
      );
      assert.doesNotMatch(text(), /Confirmation is pending/);
    } else {
      assert.equal(
        new URL(dom.location.href).searchParams.has("checkout"),
        false,
      );
      assert.equal(
        new URL(dom.location.href).searchParams.get("campaign"),
        "example",
      );
      assert.equal(dom.location.hash, "#details");
      if (marker === "canceled") assert.match(text(), /Checkout was canceled/);
      else {
        assert.match(text(), /Confirmation is pending/);
        assert.match(text(), /Check your email/);
        assert.match(text(), /after our server confirms payment/);
      }
    }
    assert.equal(server.calls("/checkout").length, 0);
    assert.equal(dom.document.querySelector(".dashboard"), null);
    assert.equal(server.calls("/me").length, 1);
  }
});
test("payment submission disables identity changes and handler guards reject queued auth actions", async () => {
  for (const signedIn of [true, false]) {
    const p = paymentFixture(),
      pending = deferred<Awaited<ReturnType<CheckoutActions["confirm"]>>>();
    p.actions.confirm = () => pending.promise;
    await mount(
      (fixture) => {
        fixture.currentAccount = signedIn ? account() : null;
        fixture.on("POST", "/checkout", p.response);
      },
      "#login=other-identity",
      p.loader,
    );
    await flush();
    await input("#checkout-email", "buyer@example.test");
    await submit(".checkout-form");
    const authButtons = signedIn
      ? [findButton("Sign out"), findButton("Confirm sign in")]
      : [findButton("Email me a sign-in link"), findButton("Confirm sign in")];
    const pay = find(".payment-form");
    pay.dispatchEvent(
      new dom.Event("submit", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
    // Dispatch before Vue patches disabled controls, reproducing queued callbacks.
    for (const authButton of authButtons)
      authButton.dispatchEvent(
        new dom.Event("click", { bubbles: true }) as unknown as Event,
      );
    if (!signedIn) await submit("#sign-in form");
    await flush();
    for (const authButton of authButtons)
      assert.equal(authButton.disabled, true);
    assert.equal(
      server.requests.some((item) => item.path.startsWith("/auth/")),
      false,
    );
    assert.equal(p.destroyed(), 0);
    assert.ok(dom.document.querySelector(".payment-form"));
    pending.resolve({ type: "success", session: p.actions.getSession() });
    await flush();
    assert.match(text(), /Confirmation is pending/);
    assert.equal(p.destroyed(), 1);
    for (const authButton of authButtons)
      assert.equal(authButton.disabled, false);
  }
});
test("expired Elements sessions show a fresh-session retry and destroy payment fields", async () => {
  const p = paymentFixture();
  p.actions.getSession = () => ({
    currency: "usd",
    canConfirm: false,
    total: { total: { amount: "$120.00", minorUnitsAmount: 12000 } },
    status: { type: "expired" },
  });
  await mount(
    (fixture) => fixture.on("POST", "/checkout", p.response),
    "",
    p.loader,
  );
  await flush();
  await input("#checkout-email", "buyer@example.test");
  await submit(".checkout-form");
  assert.match(text(), /checkout session expired/);
  assert.equal(p.destroyed(), 1);
  assert.equal(findButton("Pay now").disabled, true);
  await click("Retry secure checkout");
  assert.equal(server.calls("/checkout").length, 2);
  assert.equal(p.destroyed(), 2);
});

test("checkout waits for the initial account lookup so a late auth response cannot interrupt confirmation", async () => {
  const me = deferred<Response>();
  await mount((fixture) => fixture.on("GET", "/me", () => me.promise));
  await flush();
  assert.equal(findButton("Continue to payment").disabled, true);
  await input("#checkout-email", "buyer@example.test");
  await submit(".checkout-form");
  assert.equal(server.calls("/checkout").length, 0);
  me.resolve(denied());
  await flush();
  assert.equal(findButton("Continue to payment").disabled, false);
});

test("device licenses show device seats and labels with target-specific authenticated downloads", async () => {
  await mount((fixture) => {
    fixture.products = [{ ...product(), framework: "electron" }];
    fixture.currentAccount = account([
      license({
        framework: "electron",
        installations: [
          {
            id: "device-row",
            installation_id: "stable-device-id",
            site_url: "device:stable-device-id",
            label: "Office Mac",
            active: true,
            exempt: false,
          },
        ],
        releases: [
          {
            id: "release",
            version: "2.0.0",
            changelog: "Updated.",
            checksum: "parent",
            min_wp: null,
            min_php: null,
            min_free: null,
            assets: [
              {
                id: "asset / one",
                target: "darwin-arm64",
                filename: "App.zip",
                size: 5,
                checksum: "asset-sum",
                sha512: "sha512",
                signature: null,
                min_system_version: "13.0",
              },
              {
                id: "asset-two",
                target: "windows-x64",
                filename: "App.exe",
                size: 10,
                checksum: "other",
                sha512: "sha512",
                signature: null,
                min_system_version: null,
              },
            ],
          },
        ],
      }),
    ]);
  });
  await flush();
  assert.match(text(), /Device seats/);
  assert.match(text(), /1 device/);
  assert.match(text(), /5 devices/);
  assert.match(text(), /Office Mac/);
  assert.doesNotMatch(text(), /device:stable-device-id|WordPress plugin ZIP/);
  assert.match(text(), /darwin-arm64.*App.zip/);
  assert.match(text(), /asset-sum/);
  const links = [...dom.document.querySelectorAll(".release-list a")];
  assert.equal(links.length, 2);
  assert.equal(
    links[0]!.getAttribute("href"),
    "/api/v1/tenants/primary/licenses/license-one/assets/asset%20%2F%20one/download",
  );
  await click("Deactivate");
  assert.match(text(), /Office Mac will stop receiving/);
});

test("native licenses with no assets never fall back to WordPress package URLs", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account([
      license({
        framework: "generic",
        releases: [
          {
            id: "native",
            version: "1.0.0",
            changelog: "",
            checksum: "",
            min_wp: null,
            min_php: null,
            min_free: null,
          },
        ],
      }),
    ]);
  });
  await flush();
  assert.equal(dom.document.querySelector(".release-list a"), null);
  assert.match(text(), /No target assets are available/);
  assert.match(text(), /Activate your app/);
});

test("expired native assets never expose downloads and site-based generic products retain site units", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account([
      license({
        framework: "electron",
        entitled: false,
        releases: [
          {
            id: "expired-release",
            version: "1.0.0",
            changelog: "",
            checksum: "parent",
            min_wp: null,
            min_php: null,
            min_free: null,
            assets: [
              {
                id: "private",
                target: "linux-x64",
                filename: "private.zip",
                size: 5,
                checksum: "checksum",
                sha512: "sha512",
                signature: null,
                min_system_version: null,
              },
            ],
          },
        ],
      }),
      license({
        id: "site-generic",
        framework: "generic",
        frameworkConfig: { activationKind: "site" },
      }),
    ]);
  });
  await flush();
  assert.equal(dom.document.querySelector(".asset-list a"), null);
  assert.match(text(), /Access unavailable/);
  assert.match(text(), /Installed software stays available/);
  assert.match(text(), /Activate your extension on your site/);
  await click("Replace license key");
  assert.match(text(), /Reconnect your devices/);
  assert.match(text(), /Installed software stays available/);
});

test("customer privacy and lifecycle notices load only when opened and closure uses native confirmation", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account();
    let closureRequested = false;
    fixture.on("GET", "/notifications", () =>
      Response.json({
        notifications: [
          { id: "n", kind: "expiry_approaching", paidThrough: 4102444800000 },
        ],
      }),
    );
    fixture.on("GET", "/account/closure", () =>
      Response.json({
        request: closureRequested
          ? {
              status: "awaiting_operator",
              blockers: ["Paid rights retained"],
              retentionPlan: "Financial receipts retained",
            }
          : null,
      }),
    );
    fixture.on("POST", "/account/closure", () => {
      closureRequested = true;
      return Response.json({ ok: true });
    });
  });
  await flush();
  assert.equal(server.calls("/notifications").length, 0);
  const details = find<HTMLDetailsElement>(".account-privacy");
  details.open = true;
  details.dispatchEvent(new dom.Event("toggle") as unknown as Event);
  await flush();
  assert.match(text(), /expiry approaching/);
  await click("Request account closure");
  assert.equal(find<HTMLDialogElement>("dialog").open, true);
  await click("Cancel");
  await click("Request account closure");
  await click("Confirm action");
});
test("privacy session expiry clears buyer identity and closing privacy resets its panel", async () => {
  await mount((fixture) => {
    fixture.currentAccount = account();
    fixture.on("GET", "/notifications", () =>
      Response.json({ notifications: [] }),
    );
    fixture.on("GET", "/account/closure", () =>
      Response.json({ request: null }),
    );
  });
  await flush();
  const details = find<HTMLDetailsElement>(".account-privacy");
  details.open = true;
  details.dispatchEvent(new dom.Event("toggle") as unknown as Event);
  await flush();
  details.open = false;
  details.dispatchEvent(new dom.Event("toggle") as unknown as Event);
  await flush();
  assert.equal(dom.document.querySelector(".feature-panel"), null);
  server.on("GET", "/notifications", () => denied());
  details.open = true;
  details.dispatchEvent(new dom.Event("toggle") as unknown as Event);
  await flush();
  assert.match(text(), /Sign in to your account/);
  assert.doesNotMatch(text(), /customer@example.test/);
});

test("hosted buyer routing uses app-local navigation and unprefixed tenant APIs", async () => {
  await mount();
  mounted.unmount();
  dom.history.replaceState(null, "", "/app/t/primary");
  const meta = dom.document.createElement("meta");
  meta.name = "entitle-app-base";
  meta.content = "/app";
  dom.document.head.append(meta);
  try {
    mounted = ui.mountSiteApp("#app");
    await flush();
    assert.ok(dom.document.querySelector('header a[href="/app/"]'));
    assert.ok(dom.document.querySelector('a[href="/app/docs#licensing"]'));
    assert.ok(server.requests.some((request) => request.path === "/me"));
    assert.ok(
      server.requests.every((request) => !request.path.includes("/app/api/")),
    );
  } finally {
    meta.remove();
  }
});
