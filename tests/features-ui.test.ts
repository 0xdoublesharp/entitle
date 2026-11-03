import assert from "node:assert/strict";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import type { App } from "vue";
import type { EmailChangeDraft } from "../web/features.ts";
import { ApiClient } from "../web/api.ts";
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
  "HTMLDialogElement",
])
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value:
      name === "window"
        ? dom
        : (dom as unknown as Record<string, unknown>)[name],
  });
const { createApp, h, nextTick, ref } = await import("vue");
const ui = await import("../web/features.ts");
let app: App | undefined;
let emailChangeState = ref<EmailChangeDraft | null>(null);
const redirects: string[] = [];
const confirmations: string[] = [];
Object.defineProperty(dom.location, "assign", {
  value: (url: string) => redirects.push(url),
});
const downloads: { filename: string; url: string }[] = [];
const revoked: string[] = [];
Object.defineProperty(URL, "createObjectURL", {
  configurable: true,
  value: () => "blob:download",
});
Object.defineProperty(URL, "revokeObjectURL", {
  configurable: true,
  value: (url: string) => revoked.push(url),
});
Object.defineProperty(dom.HTMLAnchorElement.prototype, "click", {
  configurable: true,
  value: function (this: HTMLAnchorElement) {
    downloads.push({ filename: this.download, url: this.href });
  },
});
const calls: { path: string; init: RequestInit; body: unknown }[] = [];
let handler: (path: string, body: unknown) => unknown = () => ({});
const fetcher: typeof fetch = async (input, init = {}) => {
  const path = String(input);
  const body = init.body
    ? (JSON.parse(String(init.body)) as unknown)
    : undefined;
  calls.push({ path, init, body });
  const result = await handler(path, body);
  return result instanceof Response ? result : Response.json(result);
};
const api = new ApiClient(fetcher, "/seller");
api.csrfToken = "csrf";
const platform = new ApiClient(fetcher, "/platform");
platform.csrfToken = "csrf";
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((r) => setImmediate(r));
    await nextTick();
  }
}
function element(selector: string) {
  const node = dom.document.querySelector(selector);
  assert.ok(node, selector);
  return node as unknown as HTMLElement;
}
async function click(label: string) {
  const node = [...dom.document.querySelectorAll("button")].find(
    (n) => n.textContent === label,
  );
  assert.ok(node, label);
  node.click();
  await flush();
}
async function input(id: string, value: string) {
  const node = element(`#${id}`) as HTMLInputElement;
  node.value = value;
  node.dispatchEvent(
    new dom.Event("input", { bubbles: true }) as unknown as Event,
  );
  await flush();
}
async function submit(id: string) {
  element(`#${id}`).dispatchEvent(
    new dom.Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event,
  );
  await flush();
}
async function mount(
  page: string,
  hosted = true,
  subscribed = false,
  taxCode?: string,
  initialToken = "",
  emailChange: EmailChangeDraft | null = null,
) {
  app?.unmount();
  calls.length = 0;
  emailChangeState = ref(emailChange);
  dom.document.body.innerHTML = '<div id="app"></div>';
  app = createApp({
    render: () =>
      h(ui.SellerFeaturePanel, {
        page,
        initialToken,
        emailChange: emailChangeState.value,
        "onUpdate:emailChange": (value: EmailChangeDraft | null) => {
          emailChangeState.value = value;
        },
        api,
        platform,
        hosted,
        subscribed,
        products: [
          {
            id: "p1",
            name: "Plugin",
            ...(taxCode === undefined ? {} : { tax_code: taxCode }),
            plans: [{ id: "plan1", name: "Annual" }],
          },
        ],
        confirm: (
          title: string,
          _label: string,
          action: () => Promise<void>,
        ) => {
          confirmations.push(title);
          return action();
        },
      }),
  });
  app.mount("#app");
  await flush();
}
afterEach(() => app?.unmount());
after(() => dom.happyDOM.close());
test("tax controls load only their own settings and save with CSRF", async () => {
  handler = () => ({
    settings: {
      automaticTax: true,
      collectTaxId: false,
      collectBillingAddress: true,
    },
  });
  await mount("commerce");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.path, "/seller/commerce/settings");
  assert.equal((element("#automaticTax") as HTMLInputElement).checked, true);
  await submit("tax-settings");
  assert.deepEqual(calls[1]?.body, {
    automaticTax: true,
    collectTaxId: false,
    collectBillingAddress: true,
  });
  assert.equal(new Headers(calls[1]?.init.headers).get("X-CSRF-Token"), "csrf");
  await input("tax-p1", "txcd_12345678");
  await submit("tax-code-p1");
  assert.deepEqual(calls[2]?.body, { taxCode: "txcd_12345678" });
});
test("hosted advanced features explain monthly Pro without inventing a price", async () => {
  handler = () => ({
    features: { outboundWebhooks: false, advancedReports: false },
    hostedProConfigured: true,
  });
  await mount("webhooks");
  assert.match(dom.document.body.textContent!, /Monthly Pro/);
  assert.equal(calls.length, 1);
  handler = () => ({ url: "http://localhost/billing" });
  await click("Choose Pro");
  assert.deepEqual(calls.at(-1)?.body, { tier: "pro" });
});
test("sandbox creates a child and allows fixture purchase only in its test workspace", async () => {
  handler = (path, body) =>
    path.endsWith("/sandbox") && !body
      ? { sandbox: null, stripeAvailable: true }
      : {
          tenant: { slug: "alpha-sandbox" },
          mode: "fixture",
          created: true,
          customerUrl: "/t/alpha-sandbox",
          apiBase: "/api/v1/tenants/alpha-sandbox",
        };
  await mount("sandbox");
  await submit("sandbox-create");
  assert.deepEqual(calls.at(-1)?.body, { mode: "fixture" });
  assert.match(element("a[data-sandbox-open]").getAttribute("href")!, /./);
});
test("basic health and settings are available without Pro", async () => {
  handler = () => ({
    summary: { bandwidth: { servedBytes: 42 } },
    settings: {
      failureThreshold: 1,
      pendingAgeMs: 1000,
      storageRatio: 0.9,
      bandwidthBytes: 0,
      cooldownMs: 1000,
      notificationsEnabled: true,
      warningDays: 7,
    },
    alerts: [],
    notifications: [],
    features: { advancedReports: false },
  });
  await mount("operations");
  await input("failureThreshold", "2");
  await submit("operation-settings");
  assert.equal(
    (calls.at(-1)?.body as { failureThreshold: number }).failureThreshold,
    2,
  );
  assert.match(dom.document.body.textContent!, /42/);
});
test("security requests purpose-specific proof and returns recovery codes once", async () => {
  handler = (path) =>
    path.endsWith("/sessions")
      ? {
          sessions: [
            { id: "session", current: true, expiresAt: 4102444800000 },
          ],
        }
      : path.endsWith("/verification/consume")
        ? { verification: "grant" }
        : path.endsWith("/recovery-codes")
          ? { codes: ["save-offline"] }
          : { ok: true };
  await mount("security");
  await click("Send verification link");
  assert.deepEqual(calls.at(-1)?.body, { purpose: "recovery_codes" });
  await input("verification-token", "mail-token");
  await submit("recovery-codes");
  assert.deepEqual(calls.at(-1)?.body, { verification: "grant" });
  assert.match(dom.document.body.textContent!, /save-offline/);
  await click("I saved these secrets");
  assert.doesNotMatch(dom.document.body.textContent!, /save-offline/);
});
test("buyer privacy and notices load on demand and preserve paid-rights blockers", async () => {
  let requested = false;
  handler = (path, body) => {
    if (path.endsWith("/notifications"))
      return { notifications: [{ id: "n1", kind: "expired", paidThrough: 1 }] };
    if (body && path.endsWith("/account/closure")) {
      requested = true;
      return { ok: true };
    }
    return {
      request: requested
        ? {
            id: "r",
            status: "awaiting_operator",
            requestedAt: 1,
            blockers: ["paid rights retained"],
            retentionPlan: { financial: "retained" },
          }
        : null,
    };
  };
  await mount("customer");
  await click("Dismiss notification");
  assert.equal(calls.at(-1)?.path, "/seller/notifications/n1/dismiss");
  await click("Request account closure");
  assert.match(dom.document.body.textContent!, /paid rights retained/);
  assert.match(dom.document.body.textContent!, /Requested/);
  assert.equal(
    Array.from(dom.document.querySelectorAll("button")).some(
      (button) => button.textContent === "Request account closure",
    ),
    false,
  );
});
test("recovery binds this browser before consuming an offline code", async () => {
  handler = () => ({ ok: true });
  await mount("recovery");
  await input("recovery-email", "seller@example.test");
  await input("recovery-code", "offline-code");
  await submit("account-recovery");
  assert.deepEqual(
    calls.slice(-2).map((call) => call.path),
    ["/platform/account/recovery/start", "/platform/account/recovery/consume"],
  );
  assert.deepEqual(calls.at(-1)?.body, {
    email: "seller@example.test",
    code: "offline-code",
  });
});
test("tax inputs clear merchant override and update checkbox values", async () => {
  handler = () => ({
    settings: {
      automaticTax: false,
      collectTaxId: false,
      collectBillingAddress: false,
    },
  });
  await mount("commerce");
  element("#collectTaxId").click();
  await flush();
  await submit("tax-settings");
  assert.equal(
    (calls.at(-1)?.body as { collectTaxId: boolean }).collectTaxId,
    true,
  );
  await submit("tax-code-p1");
  assert.deepEqual(calls.at(-1)?.body, { taxCode: null });
});
test("Pro configuration and existing subscriptions select appropriate billing action", async () => {
  handler = () => ({
    features: { outboundWebhooks: false },
    hostedProConfigured: false,
  });
  await mount("webhooks");
  assert.equal(
    element('a[href="/docs#hosted-tiers"]').textContent,
    "Feature guide",
  );
  assert.equal(
    [...dom.document.querySelectorAll("button")].some(
      (button) => button.textContent === "Manage platform subscription",
    ),
    false,
  );
  await mount("webhooks", true, true);
  assert.doesNotMatch(
    dom.document.body.textContent!,
    /return here to choose a new tier/,
  );
  handler = () => ({ url: "/billing" });
  await click("Manage platform subscription");
  assert.equal(calls.at(-1)?.path, "/seller/platform/portal");
  handler = () => ({
    features: { outboundWebhooks: false },
    hostedProConfigured: true,
  });
  await mount("webhooks", true, true);
  handler = () => ({ url: "/billing" });
  assert.match(
    dom.document.body.textContent!,
    /After the paid subscription ends/,
  );
  assert.doesNotMatch(dom.document.body.textContent!, /Choose Pro/);
  await click("Manage current subscription");
  assert.equal(calls.at(-1)?.path, "/seller/platform/portal");
  assert.deepEqual(calls.at(-1)?.body, {});
});
test("sandbox details label fixture and Stripe test environments and never issue in live workspace", async () => {
  handler = () => ({
    sandbox: {
      isSandbox: false,
      sandboxSlug: "child",
      parentSlug: "alpha",
      mode: "fixture",
    },
    stripeAvailable: false,
  });
  await mount("sandbox");
  assert.equal(
    element("[data-sandbox-open]").getAttribute("href"),
    "/seller?tenant=child",
  );
  assert.equal(dom.document.querySelector("#sandbox-purchase"), null);
  for (const mode of ["fixture", "stripe"]) {
    handler = () => ({
      sandbox: {
        isSandbox: true,
        sandboxSlug: "child",
        parentSlug: "alpha",
        mode,
      },
      stripeAvailable: false,
    });
    await mount("sandbox");
    assert.match(dom.document.body.textContent!, /TEST WORKSPACE/);
    if (mode === "fixture") {
      const select = element("#planId") as HTMLSelectElement;
      select.value = "plan1";
      select.dispatchEvent(
        new dom.Event("change", { bubbles: true }) as unknown as Event,
      );
      await flush();
      await submit("sandbox-purchase");
      assert.deepEqual(calls.at(-1)?.body, { planId: "plan1" });
    } else assert.equal(dom.document.querySelector("#sandbox-purchase"), null);
  }
  handler = () => ({ sandbox: null, stripeAvailable: false });
  await mount("sandbox");
  assert.equal(element("#mode").querySelectorAll("option").length, 1);
});
test("advanced health reports stay lazy and settings preserve lifecycle boolean", async () => {
  handler = (path) =>
    path.endsWith("/operations")
      ? {
          summary: {
            queues: { emails: { failed: 1 } },
            bandwidth: { servedBytes: 42 },
          },
          settings: {
            failureThreshold: 1,
            pendingAgeMs: 1000,
            storageRatio: 0.9,
            bandwidthBytes: 0,
            cooldownMs: 1000,
            notificationsEnabled: true,
            warningDays: 7,
          },
          alerts: [{ kind: "queue_failed" }],
          notifications: [{ message: "Capacity warning" }],
          features: { advancedReports: true },
        }
      : { rows: [{ day: "2026-10-21", servedBytes: 42 }] };
  await mount("operations");
  assert.match(
    dom.document.body.textContent!,
    /Background jobs need attention/,
  );
  assert.equal(calls.length, 1);
  await click("Load advanced daily reports");
  assert.match(dom.document.body.textContent!, /2026-10-21/);
  await mount("operations", false);
  assert.match(dom.document.body.textContent!, /Basic health/);
});
test("webhook event selection, signing secret, rotation, deletion and failed retry use protected routes", async () => {
  handler = (path) =>
    path.endsWith("/features")
      ? { features: { outboundWebhooks: true }, hostedProConfigured: true }
      : path.endsWith("/webhooks")
        ? {
            endpoints: [
              {
                id: "hook",
                url: "https://example.test/hook",
                events: ["license.created"],
                active: true,
              },
              {
                id: "inactive",
                url: "https://example.test/old",
                events: [],
                active: false,
              },
            ],
            deliveries: [
              {
                id: "d1",
                eventId: "event",
                state: "failed",
                attempts: 2,
                lastError: "timeout",
              },
              {
                id: "d2",
                eventId: "done",
                state: "succeeded",
                attempts: 1,
                lastError: null,
              },
            ],
          }
        : { secret: "rotated-once" };
  await mount("webhooks");
  await input("webhookUrl", "https://example.test/new");
  const check = element('input[value="license.renewed"]');
  check.click();
  await flush();
  element('input[value="license.created"]').click();
  await flush();
  // POST receives the secret; GET receives endpoint metadata only.
  const original = handler;
  handler = (path, body) =>
    path.endsWith("/webhooks") && body
      ? { secret: "signing-once" }
      : original(path, body);
  await submit("webhook-create");
  assert.deepEqual(calls.find((call) => call.init.method === "POST")?.body, {
    url: "https://example.test/new",
    events: ["license.renewed"],
  });
  assert.match(dom.document.body.textContent!, /signing-once/);
  await click("Save secrets offline");
  assert.equal(downloads.at(-1)?.filename, "entitle-secrets.txt");
  assert.equal(revoked.at(-1), "blob:download");
  await click("I saved these secrets");
  await click("Rotate signing secret");
  assert.equal(
    confirmations.at(-1),
    "Rotate signing secret? Queued deliveries will use the new secret.",
  );
  assert.match(dom.document.body.textContent!, /rotated-once/);
  await click("Disable webhook");
  assert.equal(
    calls.find((call) => call.init.method === "DELETE")?.path,
    "/seller/webhooks/hook",
  );
  await click("Retry failed delivery");
  assert.equal(
    calls.find((call) => call.path.endsWith("/retry"))?.path,
    "/seller/webhook-deliveries/d1/retry",
  );
  handler = (path) =>
    path.endsWith("/features")
      ? { features: { outboundWebhooks: false }, hostedProConfigured: false }
      : { endpoints: [], deliveries: [] };
  await mount("webhooks", false);
  assert.equal(calls.at(-1)?.path, "/seller/webhooks");
  assert.doesNotMatch(dom.document.body.textContent!, /Choose Pro/);
});
test("session revocation and mailbox changes keep proof fields explicit", async () => {
  handler = (path) =>
    path.endsWith("/sessions")
      ? {
          sessions: [
            { id: "current", current: true, expiresAt: 4102444800000 },
            { id: "other", current: false, expiresAt: 4102444800000 },
          ],
        }
      : path.endsWith("/email-change/request")
        ? { id: "change-id" }
        : { ok: true };
  await mount("security");
  const buttons = [...dom.document.querySelectorAll("button")].filter(
    (node) => node.textContent === "Revoke session",
  );
  buttons[1]!.click();
  await flush();
  assert.deepEqual(
    calls.find((call) => call.path.endsWith("/sessions/revoke"))?.body,
    { id: "other" },
  );
  await click("Revoke session");
  await click("Revoke other sessions");
  assert.equal(confirmations.at(-1), "Revoke other sessions?");
  await click("Revoke all sessions");
  await input("email", "new@example.test");
  await submit("email-change-request");
  assert.equal((element("#changeId") as HTMLInputElement).value, "change-id");
  await input("currentToken", "old-mail-proof");
  await input("newToken", "new-mail-proof");
  await submit("email-change-confirm");
  assert.deepEqual(calls.at(-1)?.body, {
    id: "change-id",
    currentToken: "old-mail-proof",
    newToken: "new-mail-proof",
  });
  assert.equal((element("#currentToken") as HTMLInputElement).value, "");
});
test("tenant export consumes tenant_transfer proof then downloads only encrypted handles and deletes", async () => {
  handler = (path, body) =>
    path.endsWith("/verification/consume")
      ? { verification: "single-use-grant" }
      : path.endsWith("/exports")
        ? body
          ? { id: "export-id", expiresAt: 4102444800000, blobs: ["blob-id"] }
          : { exports: [] }
        : path.endsWith("/manifest") || path.endsWith("/blobs/blob-id")
          ? new Response("ciphertext")
          : { ok: true };
  await mount("export");
  assert.equal(calls.length, 1);
  await click("Send verification link");
  assert.deepEqual(calls.at(-1)?.body, { purpose: "tenant_transfer" });
  await input("verification-token", "email-proof");
  await input("passphrase", "strong export passphrase");
  await submit("tenant-export");
  assert.doesNotMatch(
    element("#export-create").textContent!,
    /Link sent|Resend verification link/,
  );
  const created = calls.find(
    (call) => call.path === "/seller/exports" && call.init.method === "POST",
  )!;
  assert.deepEqual(created.body, { passphrase: "strong export passphrase" });
  assert.equal(
    new Headers(created.init.headers).get("x-account-verification"),
    "single-use-grant",
  );
  assert.equal((element("#passphrase") as HTMLInputElement).value, "");
  await click("Download manifest.entitle");
  await click("Download blob-id.blob");
  assert.equal(downloads.at(-1)?.filename, "blob-id.blob");
  await click("Delete export");
  assert.ok(
    calls.some(
      (call) =>
        call.path === "/seller/exports/export-id" &&
        call.init.method === "DELETE",
    ),
  );
  assert.doesNotMatch(dom.document.body.textContent!, /Download manifest/);
});
test("buyer own-data export creates a JSON download and revokes its object URL", async () => {
  handler = (path) =>
    path.endsWith("/notifications")
      ? { notifications: [] }
      : path.endsWith("/account/closure")
        ? { request: null }
        : { customer: { email: "buyer@example.test" } };
  await mount("customer");
  await click("Download my account data");
  assert.equal(downloads.at(-1)?.filename, "entitle-account.json");
  assert.equal(revoked.at(-1), "blob:download");
});
test("panel errors are recoverable and duplicate submissions are blocked", async () => {
  handler = () =>
    Response.json(
      { error: { message: "Unavailable", requestId: "ref" } },
      { status: 503 },
    );
  await mount("commerce");
  assert.match(dom.document.body.textContent!, /Unavailable Reference: ref/);
  handler = () => ({
    settings: {
      automaticTax: false,
      collectTaxId: false,
      collectBillingAddress: false,
    },
  });
  await click("Retry panel");
  assert.ok(dom.document.querySelector("#tax-settings"));
  let resolve!: (value: unknown) => void;
  handler = () =>
    new Promise((r) => {
      resolve = r;
    });
  const form = element("#tax-settings");
  for (let i = 0; i < 2; i++)
    form.dispatchEvent(
      new dom.Event("submit", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
  await flush();
  assert.equal(calls.filter((call) => call.init.method === "PUT").length, 1);
  resolve({ ok: true });
  await flush();
  handler = () =>
    Response.json({ error: { message: "Sign in again" } }, { status: 401 });
  await submit("tax-settings");
  assert.match(dom.document.body.textContent!, /Sign in again/);
});
test("late secrets and request failures after unmount do not expose state in another workspace", async () => {
  let resolve!: (value: unknown) => void;
  handler = (path, body) =>
    body
      ? new Promise((r) => {
          resolve = r;
        })
      : path.endsWith("/features")
        ? { features: { outboundWebhooks: true }, hostedProConfigured: true }
        : { endpoints: [], deliveries: [] };
  await mount("webhooks");
  await input("webhookUrl", "https://example.test/hook");
  element("#webhook-create").dispatchEvent(
    new dom.Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event,
  );
  await flush();
  app!.unmount();
  dom.document.body.innerHTML = "other workspace";
  resolve({ secret: "late-secret" });
  await flush();
  assert.equal(dom.document.body.textContent, "other workspace");
  handler = () =>
    new Promise((r) => {
      resolve = r;
    });
  const pendingMount = mount("commerce");
  await flush();
  app!.unmount();
  resolve(
    Response.json({ error: { message: "Late failure" } }, { status: 503 }),
  );
  await pendingMount;
  await flush();
  assert.doesNotMatch(dom.document.body.textContent!, /Late failure/);
});
test("empty or missing verification tokens remain purpose-bound and cannot persist grants", async () => {
  handler = (path, body) =>
    path.endsWith("/exports") && !body
      ? { exports: [] }
      : path.endsWith("/sessions")
        ? { sessions: [] }
        : path.endsWith("/verification/consume")
          ? { verification: "grant" }
          : path.endsWith("/recovery-codes")
            ? { codes: [] }
            : { id: "bundle", expiresAt: 4102444800000, blobs: [] };
  await mount("security");
  await submit("recovery-codes");
  assert.deepEqual(
    calls.find((c) => c.path.endsWith("/verification/consume"))?.body,
    { purpose: "recovery_codes", token: "" },
  );
  await mount("export");
  await input("passphrase", "long passphrase");
  await submit("tenant-export");
  assert.deepEqual(
    calls.find((c) => c.path.endsWith("/verification/consume"))?.body,
    { purpose: "tenant_transfer", token: "" },
  );
});
test("basic reports offer hosted Pro choices only when requested", async () => {
  handler = (path) =>
    path.endsWith("/features")
      ? { features: { advancedReports: false }, hostedProConfigured: true }
      : {
          summary: {},
          settings: { notificationsEnabled: true },
          alerts: [],
          notifications: [],
          features: { advancedReports: false },
        };
  await mount("operations");
  assert.equal(calls.length, 1);
  await click("View Pro options");
  assert.equal(calls.at(-1)?.path, "/seller/features");
  assert.match(dom.document.body.textContent!, /Choose Pro/);
});
test("existing product tax codes are visible before an explicit edit", async () => {
  handler = () => ({
    settings: {
      automaticTax: false,
      collectTaxId: false,
      collectBillingAddress: false,
    },
  });
  await mount("commerce", true, false, "txcd_12345678");
  assert.equal((element("#tax-p1") as HTMLInputElement).value, "txcd_12345678");
});

test("reloading export panel restores saved handles and lets the owner resume or remove them", async () => {
  let retained = true;
  handler = (path, body) =>
    path.endsWith("/exports") && !body
      ? {
          exports: retained
            ? [
                {
                  id: "saved-bundle",
                  status: "ready",
                  expiresAt: 4102444800000,
                  blobs: ["saved-blob"],
                },
              ]
            : [],
        }
      : path.endsWith("/saved-bundle")
        ? ((retained = false), { ok: true })
        : path.endsWith("/manifest")
          ? new Response("ciphertext")
          : { ok: true };
  await mount("export");
  assert.equal(calls[0]?.path, "/seller/exports");
  assert.equal(new Headers(calls[0]?.init.headers).get("X-CSRF-Token"), "csrf");
  await click("Show downloads");
  await click("Download manifest.entitle");
  assert.equal(downloads.at(-1)?.filename, "manifest.entitle");
  await click("Delete saved export");
  assert.ok(
    calls.some(
      (c) =>
        c.path === "/seller/exports/saved-bundle" && c.init.method === "DELETE",
    ),
  );
  assert.doesNotMatch(
    dom.document.body.textContent!,
    /Show downloads|Download manifest/,
  );
});

test("export recovery distinguishes creating and cleanup-pending entries and refreshes safely", async () => {
  let status = "creating",
    retained = true;
  handler = (path, body) =>
    path.endsWith("/exports") && !body
      ? {
          exports: retained
            ? [
                {
                  id: "recoverable",
                  status,
                  expiresAt: status === "creating" ? null : 0,
                  blobs: [],
                },
              ]
            : [],
        }
      : path.endsWith("/recoverable")
        ? ((retained = false), { ok: true })
        : { ok: true };
  await mount("export");
  assert.match(dom.document.body.textContent!, /Creation in progress/);
  assert.equal(
    [...dom.document.querySelectorAll("button")].find(
      (b) => b.textContent === "Delete saved export",
    )?.disabled,
    true,
  );
  status = "cleanup_pending";
  await click("Refresh exports");
  assert.match(dom.document.body.textContent!, /Cleanup pending/);
  await click("Delete saved export");
  assert.doesNotMatch(
    dom.document.body.textContent!,
    /Saved export|Cleanup pending/,
  );
});

test("an export list resolving after navigation cannot restore a discarded panel", async () => {
  let resolve!: (value: unknown) => void;
  handler = () =>
    new Promise((r) => {
      resolve = r;
    });
  await mount("export");
  app?.unmount();
  resolve({
    exports: [
      {
        id: "old-workspace",
        status: "ready",
        expiresAt: 4102444800000,
        blobs: [],
      },
    ],
  });
  await flush();
  assert.doesNotMatch(
    dom.document.body.textContent!,
    /Saved encrypted export|Show downloads/,
  );
});

test("operations presents readable metrics and keeps configuration collapsed", async () => {
  handler = (path) =>
    path.endsWith("/operations/reports")
      ? {
          rows: [
            {
              day: "2026-10-22",
              responses: 12,
              servedBytes: 1048576,
              storageReadBytes: 2097152,
              storageReads: 3,
            },
          ],
        }
      : {
          summary: {
            queues: {
              work: { failed: 0, pending: 0, oldestAgeMs: 0 },
              emails: { failed: 1, pending: 3, oldestAgeMs: 300000 },
              outbound_deliveries: { failed: 0, pending: 0, oldestAgeMs: 0 },
            },
            storage: {
              usedBytes: 1048576,
              reservedBytes: 0,
              limitBytes: 1073741824,
            },
            bandwidth: {
              servedBytes: 2097152,
              storageReadBytes: 3145728,
              storageReads: 3,
            },
            billingCapacityWarning: false,
          },
          settings: { notificationsEnabled: true },
          alerts: [],
          notifications: [],
          features: { advancedReports: true },
        };
  await mount("operations");
  assert.equal(
    Boolean(dom.document.querySelector(".feature-panel > pre")),
    false,
  );
  assert.match(element(".feature-stats").textContent!, /1 MiB/);
  assert.match(element(".feature-queues").textContent!, /Email delivery/);
  assert.equal(
    (element("#health-settings-disclosure") as HTMLDetailsElement).open,
    false,
  );
  assert.equal(calls.length, 1);
  await click("Load advanced daily reports");
  assert.match(element(".feature-report-table").textContent!, /2026-10-22/);
  assert.deepEqual(
    [...element(".feature-report-table").querySelectorAll("thead th")].map(
      (cell) => [cell.textContent, cell.getAttribute("aria-label")],
    ),
    [
      ["Date", "Date"],
      ["Served", "Download responses"],
      ["Data", "Delivered bytes"],
      ["Reads", "Storage reads"],
    ],
  );
  assert.match(element(".feature-report-table").textContent!, /1 MiB/);
});

test("security separates sessions from optional recovery and email workflows", async () => {
  handler = (path) =>
    path.endsWith("/sessions")
      ? {
          sessions: [
            { id: "session", current: true, expiresAt: 4102444800000 },
          ],
        }
      : { ok: true };
  await mount("security");
  for (const id of ["security-recovery", "security-email"]) {
    assert.equal((element(`#${id}`) as HTMLDetailsElement).open, false);
  }
  assert.match(element(".feature-session-list").textContent!, /This browser/);
  assert.equal(
    element("#recovery-codes").closest("details")?.id,
    "security-recovery",
  );
  assert.equal(
    element("#email-change-confirm").closest("details")?.id,
    "security-email",
  );
});

test("webhook setup uses a disclosure and preserves one-time secrets outside it", async () => {
  handler = (path) =>
    path.endsWith("/features")
      ? { features: { outboundWebhooks: true } }
      : path.endsWith("/webhooks")
        ? {
            endpoints: [
              {
                id: "hook",
                url: "https://example.test/hook",
                events: ["license.created"],
                active: true,
              },
            ],
            deliveries: [],
          }
        : { ok: true };
  await mount("webhooks", false);
  assert.equal((element("#webhook-setup") as HTMLDetailsElement).open, false);
  assert.equal(
    element("#webhook-create").closest("details")?.id,
    "webhook-setup",
  );
  assert.match(element(".feature-endpoint-list").textContent!, /example.test/);
  assert.match(dom.document.body.textContent!, /No deliveries yet/);
});

test("export prioritizes saved downloads and collapses another creation form", async () => {
  handler = () => ({
    exports: [
      {
        id: "saved",
        status: "ready",
        expiresAt: 4102444800000,
        blobs: ["one"],
      },
    ],
  });
  await mount("export");
  assert.equal((element("#export-create") as HTMLDetailsElement).open, false);
  assert.equal(
    element("#tenant-export").closest("details")?.id,
    "export-create",
  );
  assert.match(
    element(".feature-export-list").textContent!,
    /Ready to download/,
  );
  assert.doesNotMatch(
    dom.document.body.textContent!,
    /browser filesystem paths|operator\/CLI only/,
  );
});

test("standalone security omits the hosted-only email change workflow", async () => {
  handler = () => ({ sessions: [] });
  await mount("security", false);
  assert.equal(Boolean(dom.document.querySelector("#security-email")), false);
  assert.ok(dom.document.querySelector("#security-recovery"));
});

test("operations explains capacity warnings, reserved storage and empty reports without inventing metrics", async () => {
  handler = (path) =>
    path.endsWith("/operations/reports")
      ? { rows: [] }
      : {
          summary: {
            storage: {
              usedBytes: 0,
              reservedBytes: 1048576,
              limitBytes: 1073741824,
            },
            bandwidth: { servedBytes: 0, storageReads: 0, storageReadBytes: 0 },
            queues: { future_queue: { failed: 0, pending: 0, oldestAgeMs: 0 } },
            billingCapacityWarning: true,
          },
          settings: { notificationsEnabled: false },
          alerts: [{ kind: "new_warning" }],
          notifications: [
            {
              kind: "billing_capacity",
              message:
                "Platform billing needs attention before adding capacity.",
            },
          ],
          features: { advancedReports: true },
        };
  await mount("operations");
  assert.match(element(".feature-stats").textContent!, /1 MiB reserved/);
  assert.match(
    dom.document.body.textContent!,
    /Review your workspace subscription in Billing/,
  );
  assert.match(dom.document.body.textContent!, /new warning/);
  assert.match(element(".feature-queues").textContent!, /future queue/);
  await click("Load advanced daily reports");
  assert.match(
    dom.document.body.textContent!,
    /No downloads recorded in this period/,
  );
});

test("webhook lists preserve unknown event identifiers for troubleshooting", async () => {
  handler = (path) =>
    path.endsWith("/features")
      ? { features: { outboundWebhooks: true } }
      : {
          endpoints: [
            {
              id: "unknown",
              url: "https://example.test/hooks",
              events: ["future.event"],
              active: true,
            },
          ],
          deliveries: [],
        };
  await mount("webhooks", false);
  assert.match(element(".feature-endpoint-list").textContent!, /future.event/);
});

test("irreversible sandbox and email choices are explained at the action", async () => {
  handler = () => ({ sandbox: null, stripeAvailable: true });
  await mount("sandbox");
  assert.match(
    element("#sandbox-create").textContent!,
    /can't change this later/i,
  );
  handler = () => ({ sessions: [] });
  await mount("security");
  assert.match(
    element("#security-email").textContent!,
    /both mailboxes in this browser/i,
  );
  assert.match(
    element("#security-email").textContent!,
    /recovery codes will stop working/i,
  );
});

test("a verification action failure preserves its open form and draft", async () => {
  handler = () => ({ sessions: [] });
  await mount("security");
  const details = element("#security-recovery") as HTMLDetailsElement;
  details.open = true;
  await input("verification-token", "draft-token");
  handler = () =>
    Response.json(
      { error: { message: "Please retry", requestId: "fixture" } },
      { status: 503 },
    );
  await click("Send verification link");
  assert.equal(Boolean(dom.document.querySelector("#recovery-codes")), true);
  assert.equal(
    (element("#security-recovery") as HTMLDetailsElement).open,
    true,
  );
  assert.equal(
    (element("#verification-token") as HTMLInputElement).value,
    "draft-token",
  );
  await click("Dismiss error");
  assert.equal(Boolean(dom.document.querySelector('[role="alert"]')), false);
  assert.equal(
    (element("#verification-token") as HTMLInputElement).value,
    "draft-token",
  );
  assert.equal(
    (element("#security-recovery") as HTMLDetailsElement).open,
    true,
  );
});

test("billing capacity produces one actionable message for the real DTO pairing", async () => {
  handler = () => ({
    summary: { billingCapacityWarning: true },
    settings: { notificationsEnabled: true },
    alerts: [{ kind: "billing_capacity" }],
    notifications: [
      {
        kind: "billing_capacity",
        message:
          "Platform billing needs attention before adding capacity. Existing buyer licenses and downloads remain available.",
      },
    ],
    features: { advancedReports: false },
  });
  await mount("operations");
  assert.equal(dom.document.querySelectorAll(".feature-attention").length, 1);
});

test("verification-link delivery feedback stays inside the action form", async () => {
  handler = (path) =>
    path.endsWith("/sessions") ? { sessions: [] } : { ok: true };
  await mount("security");
  await click("Send verification link");
  assert.match(
    element('.verification-proof [role="status"]').textContent!,
    /Link sent/,
  );
  assert.ok(
    [...dom.document.querySelectorAll("button")].some(
      (button) => button.textContent === "Resend verification link",
    ),
  );
});

test("webhook delivery states and errors read clearly while retaining exact event references", async () => {
  const eventId = "a".repeat(64);
  handler = (path) =>
    path.endsWith("/features")
      ? { features: { outboundWebhooks: true } }
      : {
          endpoints: [
            {
              id: "hook",
              url: "https://example.test/events",
              events: [],
              active: false,
            },
          ],
          deliveries: [
            {
              id: "d",
              endpointId: "hook",
              eventId,
              state: "sent",
              attempts: 1,
              lastError: null,
            },
            {
              id: "e",
              endpointId: "hook",
              eventId: "b".repeat(64),
              state: "future_state",
              attempts: 2,
              lastError: "delivery_failed",
            },
          ],
        };
  await mount("webhooks", false);
  assert.equal((element("#webhook-setup") as HTMLDetailsElement).open, true);
  assert.match(element(".feature-delivery").textContent!, /Delivered/);
  assert.match(element(".feature-delivery").textContent!, /1 attempt/);
  assert.match(element(".feature-delivery").textContent!, /example.test/);
  assert.equal(element(".event-ref").getAttribute("title"), eventId);
  assert.equal(element(".event-ref").textContent, "a".repeat(12));
  assert.match(dom.document.body.textContent!, /future state/);
  assert.match(dom.document.body.textContent!, /did not accept/);
});

test("resending a verification link discards the invalidated token and resets sent feedback after consumption", async () => {
  handler = (path) =>
    path.endsWith("/sessions")
      ? { sessions: [] }
      : path.endsWith("/verification/consume")
        ? { verification: "grant" }
        : { codes: ["offline-once"] };
  await mount("security", true, false, undefined, "old-token");
  assert.match(
    element(".verification-proof").textContent!,
    /Verification link received/,
  );
  await click("Send verification link");
  assert.equal((element("#verification-token") as HTMLInputElement).value, "");
  assert.doesNotMatch(
    element(".verification-proof").textContent!,
    /Verification link received/,
  );
  assert.match(element(".verification-proof").textContent!, /Link sent/);
  await input("verification-token", "fresh-token");
  await submit("recovery-codes");
  assert.doesNotMatch(
    element(".verification-proof").textContent!,
    /Link sent|Verification link received/,
  );
  assert.match(dom.document.body.textContent!, /offline-once/);
});

test("email change assigns only the most recently opened link to an explicitly selected mailbox", async () => {
  handler = (path) =>
    path.endsWith("/sessions") ? { sessions: [] } : { ok: true };
  await mount("security", true, false, undefined, "", {
    id: "request-id",
    currentToken: "",
    newToken: "",
    pendingTokens: ["current-proof", "new-proof"],
  });
  assert.equal((element("#changeId") as HTMLInputElement).value, "request-id");
  assert.equal((element("#security-email") as HTMLDetailsElement).open, true);
  assert.equal((element("#currentToken") as HTMLInputElement).value, "");
  assert.equal((element("#newToken") as HTMLInputElement).value, "");
  assert.equal(calls.length, 1);
  await click("Use link from new mailbox");
  assert.equal((element("#newToken") as HTMLInputElement).value, "new-proof");
  assert.equal(dom.document.querySelector("#email-change-link"), null);
  emailChangeState.value = {
    ...emailChangeState.value!,
    pendingTokens: ["current-proof"],
  };
  await flush();
  await click("Use link from current mailbox");
  assert.equal(
    (element("#currentToken") as HTMLInputElement).value,
    "current-proof",
  );
  assert.deepEqual(emailChangeState.value, {
    id: "request-id",
    currentToken: "current-proof",
    newToken: "new-proof",
    pendingTokens: [],
  });
  assert.doesNotMatch(
    dom.document.body.textContent!,
    /current-proof|new-proof/,
  );
  await submit("email-change-confirm");
  assert.deepEqual(calls.at(-1)?.body, {
    id: "request-id",
    currentToken: "current-proof",
    newToken: "new-proof",
  });
  assert.equal(emailChangeState.value, null);
  assert.equal((element("#currentToken") as HTMLInputElement).value, "");
  assert.equal((element("#newToken") as HTMLInputElement).value, "");
});
test("email change receives new link props without losing a previously assigned proof", async () => {
  handler = () => ({ sessions: [] });
  await mount("security", true, false, undefined, "", {
    id: "request-id",
    currentToken: "",
    newToken: "",
    pendingTokens: ["current-proof"],
  });
  await click("Use link from current mailbox");
  emailChangeState.value = {
    ...emailChangeState.value!,
    pendingTokens: ["new-proof"],
  };
  await flush();
  assert.equal(
    (element("#currentToken") as HTMLInputElement).value,
    "current-proof",
  );
  assert.equal((element("#newToken") as HTMLInputElement).value, "");
  await click("Use link from new mailbox");
  assert.equal((element("#newToken") as HTMLInputElement).value, "new-proof");
  await input("currentToken", "corrected-current-proof");
  assert.equal(emailChangeState.value?.currentToken, "corrected-current-proof");
});
test("email change keeps empty draft fields and ignores a second queued use of the same link", async () => {
  handler = () => ({ sessions: [] });
  await mount("security");
  await input("currentToken", "entered-proof");
  assert.equal(emailChangeState.value?.id, "");
  await mount("security", true, false, undefined, "", { id: "request-id", currentToken: "", newToken: "", pendingTokens: ["current-proof"] });
  const button = [...dom.document.querySelectorAll("button")].find((node) => node.textContent === "Use link from current mailbox")!;
  button.click(); button.click();
  await flush();
  assert.equal(emailChangeState.value?.currentToken, "current-proof");
  assert.deepEqual(emailChangeState.value?.pendingTokens, []);
});

test("email change requires distinct mailbox proofs and a replacement request clears old credentials", async () => {
  handler = (path) =>
    path.endsWith("/email-change/request")
      ? { id: "replacement-id" }
      : { sessions: [] };
  await mount("security", true, false, undefined, "", {
    id: "request-id",
    currentToken: "same-proof",
    newToken: "",
    pendingTokens: ["same-proof"],
  });
  await click("Use link from new mailbox");
  assert.equal((element("#newToken") as HTMLInputElement).value, "");
  assert.match(dom.document.body.textContent!, /different mailbox/i);
  await submit("email-change-confirm");
  assert.equal(
    calls.some((call) => call.path.endsWith("/email-change/confirm")),
    false,
  );
  await input("email", "replacement@example.test");
  await submit("email-change-request");
  assert.equal(
    (element("#changeId") as HTMLInputElement).value,
    "replacement-id",
  );
  assert.equal((element("#currentToken") as HTMLInputElement).value, "");
  assert.equal((element("#newToken") as HTMLInputElement).value, "");
  assert.equal(dom.document.querySelector("#email-change-link"), null);
});
