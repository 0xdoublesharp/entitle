import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, afterEach, beforeEach, test } from "node:test";
import { Window } from "happy-dom";
import type { App } from "vue";
import type { Tenant } from "../src/db.ts";
registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const dom = new Window({ url: "http://localhost:3211/" });
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
dom.document.body.innerHTML = '<div id="app"></div>';
const ui = await import("../web/main.ts");
const marketing = await import("../web/marketing.ts");
const { nextTick } = await import("vue");
let app: App | undefined;
const tenant: Tenant = {
  id: "tenant-a",
  slug: "alpha",
  name: "Alpha plugins",
  stripe_account_id: null,
  stripe_status: "unconnected",
  platform_customer_id: null,
  platform_subscription_id: null,
  billing_status: "trialing",
  paid_through: 0,
  trial_ends_at: 1792500000000,
  exempt: 0,
  suspended: 0,
  max_products: 20,
  max_storage_bytes: 1073741824,
  created_at: 1,
};
const overview = () => ({
  tenant,
  products: [
    {
      id: "p1",
      slug: "plugin",
      name: "My plugin",
      plugin_basename: "plugin/plugin.php",
      plans: [
        {
          id: "plan",
          name: "Annual",
          site_allowance: 5,
          stripe_price_id: "price_annual",
        },
      ],
    },
  ],
  licenses: [
    {
      id: "l1",
      product_id: "p1",
      customer_id: "c1",
      product_name: "My plugin",
      customer_email: "buyer@example.test",
      plan_name: "Annual",
      site_allowance: 5,
      paid_through: 1792500000000 as number | null,
      billing_status: "active",
      revoked: false,
      suspended: false,
    },
  ],
  releases: [
    { id: "r1", product_id: "p1", version: "1.0.0", withdrawn: false },
  ],
  metrics: {
    licenses: { issued: 4, entitled: 2, expired: 1, revoked: 1, suspended: 0 },
    installations: { active: 3, productionActive: 2, developmentActive: 1 },
    seats: { used: 2, allowance: 10, available: 8 },
    releases: { published: 1, withdrawn: 0 },
    storage: { usedBytes: 1024, reservedBytes: 0, limitBytes: 1073741824 },
    downloads: { successfulResponses: 7, last30Days: 5 },
    payments: [
      {
        currency: "usd",
        paidMinor: "900719925474099301",
        refundedMinor: "100",
        netMinor: "900719925474099201",
      },
      {
        currency: "jpy",
        paidMinor: "1234",
        refundedMinor: "0",
        netMinor: "1234",
      },
    ],
  },
});
interface Call {
  path: string;
  body: unknown;
  init: RequestInit;
}
let calls: Call[] = [];
let redirects: string[] = [];
let clipboard: string[] = [];
let signed = true;
let tenants = [tenant];
let getOverview = overview;
const keyMetadata = {
  display_prefix: "DE_build",
  scopes: JSON.stringify(["read", "releases:write"]),
  expires_at: 4102444800000 as number | null,
  last_used_at: null as number | null,
};
let keys = [
  {
    id: "k1",
    name: "Build pipeline",
    ...keyMetadata,
    created_at: 1,
    revoked_at: null as number | null,
  },
];
const routes = new Map<string, (call: Call) => Response | Promise<Response>>();
const denied = (status = 401, message = "Please sign in.", code?: string) =>
  Response.json(
    { error: { message, code, requestId: "request-ref" } },
    { status },
  );
const fetcher: typeof fetch = async (input, init = {}) => {
  const call = {
    path: String(input),
    body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
    init,
  };
  calls.push(call);
  const handler = routes.get(`${init.method || "GET"} ${call.path}`);
  if (handler) return handler(call);
  if (call.path.endsWith("/platform/info"))
    return Response.json({
      deploymentMode: "hosted",
      applicationFeePercent: 1,
      name: "Doublesharp Entitle",
      maxUploadBytes: 26214400,
      maxNativeUploadBytes: 104857600,
      storage: "s3",
      databaseEngines: ["SQLite", "PostgreSQL", "MySQL"],
      features: ["Tenant isolation", "Private releases"],
    });
  if (call.path.endsWith("/platform/me"))
    return signed
      ? Response.json({
          user: { id: "seller", email: "seller@example.test" },
          csrfToken: "seller-csrf",
          tenants,
        })
      : denied();
  if (call.path.endsWith("/seller/overview"))
    return Response.json(getOverview());
  if (
    call.path.endsWith("/seller/exports") &&
    (!call.init.method || call.init.method === "GET")
  )
    return Response.json({ exports: [] });
  if (call.path.endsWith("/seller/prices"))
    return Response.json({
      prices: [
        {
          id: "price_annual",
          productName: "My plugin",
          nickname: "Annual",
          unit_amount: 1200,
          currency: "usd",
          interval: "year",
        },
      ],
      localMode: true,
    });
  if (call.path.endsWith("/account/verification/consume"))
    return Response.json({ verification: "verified-grant" });
  if (call.path.endsWith("/account/sessions"))
    return Response.json({ sessions: [] });
  if (call.path.endsWith("/seller/keys")) return Response.json({ keys });
  return Response.json({ ok: true });
};
Object.defineProperty(dom, "fetch", { configurable: true, value: fetcher });
Object.defineProperty(dom.location, "assign", {
  configurable: true,
  value: (url: string) => redirects.push(url),
});
async function flush() {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    await nextTick();
  }
}
function text() {
  return dom.document.body.textContent || "";
}
function el<T extends Element = Element>(selector: string): T {
  const value = dom.document.querySelector(selector);
  assert.ok(value, selector);
  return value as unknown as T;
}
function button(label: string) {
  const value = [...dom.document.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  assert.ok(value, `button ${label}`);
  return value;
}
async function click(label: string) {
  button(label).click();
  await flush();
}
async function input(selector: string, value: string, event = "input") {
  const valueEl = el<HTMLInputElement>(selector);
  valueEl.value = value;
  valueEl.dispatchEvent(
    new dom.Event(event, { bubbles: true }) as unknown as Event,
  );
  await flush();
}
async function submit(id: string) {
  el(id).dispatchEvent(
    new dom.Event("submit", {
      bubbles: true,
      cancelable: true,
    }) as unknown as Event,
  );
  await flush();
}
async function mount(path = "/seller", configure?: () => void) {
  app?.unmount();
  calls = [];
  redirects = [];
  clipboard = [];
  routes.clear();
  signed = true;
  tenants = [tenant];
  getOverview = overview;
  keys = [
    {
      id: "k1",
      name: "Build pipeline",
      ...keyMetadata,
      created_at: 1,
      revoked_at: null,
    },
  ];
  configure?.();
  dom.history.replaceState(null, "", path);
  dom.document.body.innerHTML = '<div id="app"></div>';
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        clipboard.push(value);
      },
    },
  });
  app =
    path === "/"
      ? marketing.mountPublicSite("#app")
      : ui.mountSiteApp("#app", fetcher);
  await flush();
}
beforeEach(() => dom.sessionStorage.clear());
afterEach(() => app?.unmount());
after(() => dom.happyDOM.close());
test("complimentary issuance confirms the frozen request and reuses its ID after an ambiguous failure", async () => {
  let attempts = 0;
  await mount("/seller", () => {
    routes.set(
      "POST /api/v1/tenants/alpha/seller/licenses/complimentary",
      () => {
        attempts++;
        return attempts === 1
          ? denied(503, "Try this request again.")
          : Response.json({
              id: "comp-one",
              customerId: "buyer",
              emailQueued: true,
            });
      },
    );
  });
  await click("Licenses");
  await input("#complimentary-email", "pilot@example.test");
  await input("#complimentary-allowance", "2");
  await input("#complimentary-expiry", "2030-06-01T12:00");
  await input("#complimentary-note", "Invited pilot");
  await submit("#complimentary-issue");
  assert.equal(attempts, 0);
  assert.match(el("dialog").textContent || "", /pilot@example.test/);
  await click("Confirm complimentary license");
  assert.equal(attempts, 1);
  assert.match(text(), /Try this request again/);
  await submit("#complimentary-issue");
  await click("Confirm complimentary license");
  const submissions = calls.filter((call) =>
    call.path.endsWith("/licenses/complimentary"),
  );
  assert.deepEqual(submissions[1]!.body, submissions[0]!.body);
  const body = submissions[0]!.body as Record<string, unknown>;
  assert.equal(body.confirm, true);
  assert.equal(body.productId, "p1");
  assert.equal(body.siteAllowance, 2);
  assert.equal(body.note, "Invited pilot");
  assert.match(String(body.requestId), /^[a-f0-9-]{36}$/i);
  assert.equal(
    new Headers(submissions[0]!.init.headers).get("x-csrf-token"),
    "seller-csrf",
  );
  assert.match(text(), /License issued.*email queued/i);
});
test("Stripe-free workspaces can create products and clearly mark complimentary expiry", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      billingAvailable: false,
      licenses: [
        {
          ...overview().licenses[0]!,
          provenance: "complimentary",
          expires_at: 1900000000000,
          paid_through: 0,
          plan_name: "Complimentary",
          billing_status: "complimentary",
        },
      ],
    });
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      Response.json({ prices: [], localMode: false }),
    );
  });
  await click("Products");
  assert.equal(
    el<HTMLButtonElement>('#product-create button[type="submit"]').disabled,
    false,
  );
  await input("#product-name", "Pilot product");
  await input("#product-slug", "pilot-product");
  await input("#plugin-basename", "pilot-product/pilot.php");
  await submit("#product-create");
  assert.deepEqual(
    (
      calls.find((call) => call.path.endsWith("/seller/products"))!.body as {
        plans: unknown[];
      }
    ).plans,
    [],
  );
  await click("Licenses");
  assert.match(el("#seller-panel-licenses").textContent || "", /Complimentary/);
  assert.match(el("#seller-panel-licenses").textContent || "", /Expires/);
  assert.match(text(), /Paid checkout and billing are unavailable/);
});
test("a configured platform does not require a connected seller account or price to create a pilot product", async () => {
  await mount("/seller", () => {
    getOverview = () => ({ ...overview(), billingAvailable: true });
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      denied(409, "Connect a Stripe account first.", "stripe_not_connected"),
    );
  });
  await click("Products");
  assert.equal(
    el<HTMLButtonElement>('#product-create button[type="submit"]').disabled,
    false,
  );
  assert.equal(el<HTMLInputElement>("#include-paid-plan").checked, false);
  assert.equal(dom.document.querySelector("#price-id"), null);
  await input("#product-name", "Pilot product");
  await input("#product-slug", "pilot-product");
  await input("#plugin-basename", "pilot-product/pilot.php");
  await submit("#product-create");
  assert.deepEqual(
    (
      calls.find((call) => call.path.endsWith("/seller/products"))!.body as {
        plans: unknown[];
      }
    ).plans,
    [],
  );
});
test("paid plan setup is optional with configured prices and with an empty price catalog", async () => {
  await mount("/seller");
  await click("Products");
  assert.equal(el<HTMLInputElement>("#include-paid-plan").checked, true);
  el<HTMLInputElement>("#include-paid-plan").click();
  await flush();
  assert.equal(dom.document.querySelector("#price-id"), null);
  await submit("#product-create");
  assert.deepEqual(
    (
      calls.find((call) => call.path.endsWith("/seller/products"))!.body as {
        plans: unknown[];
      }
    ).plans,
    [],
  );

  await mount("/seller", () => {
    getOverview = () => ({ ...overview(), billingAvailable: true });
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      Response.json({ prices: [], localMode: false }),
    );
  });
  await click("Products");
  assert.equal(el<HTMLInputElement>("#include-paid-plan").checked, false);
  assert.equal(
    el<HTMLButtonElement>('#product-create button[type="submit"]').disabled,
    false,
  );
  await submit("#product-create");
  assert.deepEqual(
    (
      calls.find((call) => call.path.endsWith("/seller/products"))!.body as {
        plans: unknown[];
      }
    ).plans,
    [],
  );
});
test("complimentary confirmation can be canceled and pending issuance blocks duplicate submissions", async () => {
  let finish!: (response: Response) => void;
  await mount("/seller", () => {
    routes.set(
      "POST /api/v1/tenants/alpha/seller/licenses/complimentary",
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  });
  await click("Licenses");
  await input("#complimentary-email", "pilot@example.test");
  await input("#complimentary-expiry", "2030-06-01T12:00");
  await submit("#complimentary-issue");
  await click("Cancel");
  assert.equal(
    calls.filter((call) => call.path.endsWith("/licenses/complimentary"))
      .length,
    0,
  );
  await submit("#complimentary-issue");
  await click("Confirm complimentary license");
  assert.equal(
    el<HTMLButtonElement>('#complimentary-issue button[type="submit"]')
      .disabled,
    true,
  );
  await submit("#complimentary-issue");
  assert.equal(
    calls.filter((call) => call.path.endsWith("/licenses/complimentary"))
      .length,
    1,
  );
  finish(
    Response.json({ id: "comp-one", customerId: "buyer", emailQueued: true }),
  );
  await flush();
  assert.equal(el<HTMLInputElement>("#complimentary-email").value, "");
  assert.equal(
    el<HTMLButtonElement>('#complimentary-issue button[type="submit"]')
      .disabled,
    false,
  );
});
test("standalone dashboard hides hosted controls and discloses zero application fees", async () => {
  await mount("/seller", () =>
    routes.set("GET /api/v1/platform/info", () =>
      Response.json({
        deploymentMode: "standalone",
        applicationFeePercent: 0,
        maxUploadBytes: 26214400,
        databaseEngines: ["SQLite", "PostgreSQL", "MySQL"],
      }),
    ),
  );
  assert.doesNotMatch(
    text(),
    /Connect Stripe|New publisher workspace|Subscribe to Doublesharp Entitle|Platform trial ends/,
  );
  assert.match(
    text(),
    /Standalone.*no platform subscription or application fees/,
  );
  assert.equal(dom.document.querySelector("#tenant-select"), null);
});
test("hosted dashboard discloses its configured fee separately from Stripe charges", async () => {
  await mount("/seller");
  assert.match(text(), /1% application fee/);
  assert.match(text(), /Stripe.*fees.*separate/i);
});
test("unconnected Stripe accounts load without an error and keep optional billing available", async () => {
  await mount("/seller", () => {
    getOverview = () => ({ ...overview(), billingAvailable: true });
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      denied(409, "Connect a Stripe account first.", "stripe_not_connected"),
    );
    routes.set("POST /api/v1/tenants/alpha/seller/stripe/connect", () =>
      Response.json({ url: "https://stripe.example.test/connect" }),
    );
  });
  assert.match(text(), /Your workspace in numbers/);
  assert.equal(
    dom.document.querySelector('[role="alert"]')?.textContent ?? "",
    "",
  );
  assert.doesNotMatch(text(), /Connect a Stripe account first/);
  await click("Billing");
  assert.match(
    el("#seller-panel-billing").textContent || "",
    /Stripe is optional/,
  );
  await click("Connect Stripe");
  assert.deepEqual(redirects, ["https://stripe.example.test/connect"]);
  await click("Products");
  assert.ok(dom.document.querySelector("#product-create"));
  assert.equal(
    el<HTMLButtonElement>('#product-create button[type="submit"]').disabled,
    false,
  );
  assert.equal(el<HTMLInputElement>("#include-paid-plan").checked, false);
  await click("Licenses");
  assert.ok(dom.document.querySelector("#complimentary-issue"));
  routes.delete("GET /api/v1/tenants/alpha/seller/prices");
  await click("Refresh dashboard");
  await click("Products");
  assert.equal(el<HTMLInputElement>("#include-paid-plan").checked, true);
  assert.equal(el<HTMLSelectElement>("#price-id").value, "price_annual");
});

test("unexpected price conflicts remain visible", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      denied(409, "Price catalog conflict.", "price_catalog_conflict"),
    );
  });
  assert.match(
    el('[role="alert"]').textContent || "",
    /Price catalog conflict.*request-ref/,
  );
  assert.match(text(), /Your workspace in numbers/);
});

test("a temporary price outage preserves workspace data and recovers on refresh", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      denied(503, "Price provider unavailable."),
    );
  });
  assert.match(text(), /Your workspace in numbers/);
  assert.match(text(), /Price provider unavailable.*request-ref/);
  await click("Licenses");
  assert.match(text(), /buyer@example.test/);
  routes.delete("GET /api/v1/tenants/alpha/seller/prices");
  await click("Refresh dashboard");
  assert.doesNotMatch(text(), /Price provider unavailable/);
  await click("Products");
  assert.equal(
    el<HTMLButtonElement>('#product-create button[type="submit"]').disabled,
    false,
  );
});

test("public marketing home explains the workflow and links signup and docs without fetching metrics or limits", async () => {
  await mount("/");
  assert.equal(
    el(".saas-hero h1").textContent,
    "Your software. Ready to sell.",
  );
  assert.match(text(), /Software licensing and updates/);
  assert.match(text(), /First-class WordPress support/);
  assert.equal(
    el('a.button[href="/seller"]').textContent,
    "Create your workspace",
  );
  assert.ok(dom.document.querySelector('nav a[href="/docs"]'));
  assert.ok(dom.document.querySelector('a[href="#how-it-works"]'));
  assert.equal(dom.document.querySelector("figure figcaption"), null);
  assert.equal(
    el("figure").getAttribute("aria-label"),
    "From purchase to update",
  );
  assert.equal(dom.document.querySelector("#server-limits"), null);
  assert.equal(calls.length, 0);
});
test("marketing explains hosting choices and points buyers to support without inventing prices", async () => {
  await mount("/");
  assert.ok(dom.document.querySelector('nav a[href="/#hosting"]'));
  const hosting = el("#hosting").textContent;
  assert.match(hosting, /Hosted service/);
  assert.match(hosting, /Self-hosted/);
  assert.match(hosting, /Starter/);
  assert.match(hosting, /Pro.*webhooks.*bandwidth/is);
  assert.match(hosting, /shown at checkout/);
  assert.match(hosting, /No platform subscription or application fee/);
  assert.doesNotMatch(hosting, /free trial|\$\d|guaranteed|unlimited/i);
  assert.equal(
    el('#hosting a.button[href="/seller"]').textContent,
    "Open seller dashboard",
  );
  assert.ok(
    dom.document.querySelector('#hosting a[href="/docs#self-hosting"]'),
  );
  const help = el("#questions");
  assert.match(help.textContent, /Installed software keeps working/);
  assert.ok(help.querySelector('a[href="/docs#customer-accounts"]'));
  assert.ok(
    dom.document.querySelector('footer a[href="/docs#troubleshooting"]'),
  );
  assert.equal(calls.length, 0);
});
test("public documentation offers task paths and safe buyer support steps", async () => {
  await mount("/docs");
  const paths = [
    ...el('[aria-label="Choose your documentation path"]').querySelectorAll(
      "a",
    ),
  ];
  assert.equal(paths.length, 4);
  for (const link of paths)
    assert.ok(dom.document.querySelector(link.getAttribute("href")!));
  const help = el("#troubleshooting");
  assert.match(help.textContent, /software publisher/);
  assert.match(help.textContent, /request ID/);
  assert.match(
    help.textContent,
    /Never share.*license key.*activation token/is,
  );
  assert.ok(help.querySelector('a[href="#customer-accounts"]'));
});
test("marketing navigation targets actual home and documentation sections", async () => {
  await mount("/");
  for (const hash of ["#how-it-works", "#features"])
    assert.ok(dom.document.querySelector(hash));
  const docsLinks = [...dom.document.querySelectorAll('a[href^="/docs#"]')].map(
    (link) => link.getAttribute("href")!.slice(5),
  );
  assert.ok(docsLinks.length > 0);
  await mount("/docs");
  for (const hash of docsLinks)
    assert.ok(dom.document.querySelector(hash), hash);
  assert.equal(el('nav a[href="/docs"]').getAttribute("aria-current"), "page");
});
test("public docs own the setup guide and current server limits for either direct URL", async () => {
  for (const path of ["/docs", "/docs/"]) {
    await mount(path);
    assert.equal(el("main h1").textContent, "Documentation");
    assert.match(
      el("#getting-started").textContent,
      /Create your publisher workspace/,
    );
    assert.match(
      el("#complimentary-licenses").textContent,
      /Issue complimentary license/,
    );
    assert.match(
      el("#complimentary-licenses").textContent,
      /never automatically charged or enrolled/,
    );
    assert.match(el("#server-limits").textContent, /25 MiB/);
    assert.match(text(), /SQLite/);
    assert.match(text(), /merchant of record/i);
    assert.match(
      el("#framework-support").textContent,
      /native runtime.*qualification/i,
    );
    assert.ok(calls.every((c) => c.path === "/api/v1/platform/info"));
    for (const link of dom.document.querySelectorAll('a[href^="#"]')) {
      assert.ok(
        dom.document.querySelector(link.getAttribute("href")!),
        link.outerHTML,
      );
    }
  }
});
test("public docs describe hosted and self-hosted setup even on a standalone server", async () => {
  await mount("/docs", () =>
    routes.set("GET /api/v1/platform/info", () =>
      Response.json({
        deploymentMode: "standalone",
        applicationFeePercent: 0,
        maxUploadBytes: 26214400,
        databaseEngines: ["SQLite", "PostgreSQL", "MySQL"],
      }),
    ),
  );
  const comparison = el("#hosting-options");
  assert.match(comparison.textContent, /Hosted service/);
  assert.match(comparison.textContent, /Self-hosted standalone/);
  assert.match(comparison.textContent, /backups/i);
  assert.match(
    comparison.textContent,
    /no platform subscription or application fee/i,
  );
  assert.equal(
    el('#hosting-options a[href="https://entitle.doublesharp.com"]')
      .textContent,
    "entitle.doublesharp.com",
  );
  assert.match(el("#hosted-setup").textContent, /Hosted/);
  assert.match(el("#self-hosted-setup").textContent, /Self-hosted/);
  assert.match(el("#getting-started").textContent, /STANDALONE_OWNER_EMAIL/);
  assert.match(
    el("#getting-started").textContent,
    /DEPLOYMENT_MODE=standalone/,
  );
  assert.match(el("#getting-started").textContent, /\/t\/primary/);
  assert.match(el("#getting-started").textContent, /merchant-webhook/);
  assert.match(
    el("#billing").textContent,
    /application fees.*retained.*refund/i,
  );
  assert.ok(calls.every((c) => c.path === "/api/v1/platform/info"));
});
test("seller overview displays real private metrics with exact separate currencies and guided configuration", async () => {
  await mount("/seller?tenant=alpha");
  assert.match(text(), /seller@example.test/);
  assert.match(text(), /Alpha plugins/);
  assert.match(text(), /9,007,199,254,740,993\.01/);
  assert.match(text(), /1,234/);
  assert.match(text(), /Successful downloads/);
  assert.match(text(), /Reserved storage/);
  assert.doesNotMatch(text(), /MRR|99.9%/);
  assert.match(text(), /Local fixture prices/);
  assert.match(
    el<HTMLTextAreaElement>("#php-config").value,
    /\/api\/v1\/tenants\/alpha/,
  );
  await click("Copy PHP configuration");
  assert.equal(clipboard.length, 1);
  assert.ok(
    calls
      .filter((c) => c.path.includes("/seller/"))
      .every((c) => c.path.startsWith("/api/v1/tenants/alpha/seller/")),
  );
});
test("publisher workspaces explain their products, sort business names and open the product list", async () => {
  for (const count of [0, 1, 4]) {
    await mount("/seller?tenant=alpha", () => {
      tenants = [
        { ...tenant, name: "Validated Field" },
        {
          ...tenant,
          id: "b",
          slug: "remote",
          name: "Remote Content Shortcode",
        },
        {
          ...tenant,
          id: "c",
          slug: "remote-sandbox",
          name: "Remote Content Shortcode · Sandbox",
        },
        {
          ...tenant,
          id: "d",
          slug: "validated-sandbox",
          name: "Validated Field · Sandbox",
        },
      ];
      getOverview = () => {
        const data = overview();
        return {
          ...data,
          tenant: { ...tenant, name: "Doublesharp" },
          products: Array.from({ length: count }, (_, index) => ({
            ...data.products[0]!,
            id: `p${index}`,
            name: `Plugin ${index + 1}`,
          })),
        };
      };
    });
    const selector = el<HTMLSelectElement>("#tenant-select");
    assert.equal(selector.value, "alpha");
    assert.deepEqual(
      [...selector.options].map((option) => option.textContent),
      [
        "Remote Content Shortcode",
        "Remote Content Shortcode · Sandbox",
        "Validated Field",
        "Validated Field · Sandbox",
      ],
    );
    assert.match(
      el("#workspace-selector-hint").textContent!,
      /business or brand/,
    );
    const hierarchy = el(".workspace-structure");
    assert.match(hierarchy.textContent!, /Publisher workspaceDoublesharp/);
    assert.match(hierarchy.textContent!, /Products · plugins & apps/);
    assert.match(
      hierarchy.textContent!,
      /All products share.*Stripe connection/,
    );
    if (count === 4)
      assert.match(
        hierarchy.textContent!,
        /Plugin 1 · Plugin 2 · Plugin 3 · \+1 more/,
      );
    const before = calls.length;
    el<HTMLButtonElement>(".workspace-structure button").click();
    await flush();
    assert.equal(el("h1").textContent, "Products");
    assert.match(
      el(".product-scope").textContent!,
      /Plugins and apps published by Doublesharp/,
    );
    assert.equal(calls.length, before);
  }
});

test("licenses with missing expiration dates remain pending and sort after known dates", async () => {
  await mount("/seller", () => {
    getOverview = () => {
      const data = overview(),
        base = data.licenses[0]!;
      return {
        ...data,
        licenses: [
          {
            ...base,
            id: "pending-a",
            provenance: "complimentary" as const,
            expires_at: null,
          },
          { ...base, id: "pending-b", paid_through: null },
          { ...base, id: "dated", paid_through: 4102444800000 },
        ],
      };
    };
  });
  await click("Licenses");
  await click("Paid through / Expires");
  const ids = () =>
    [
      ...dom.document.querySelectorAll("#licenses-table tr[data-license-id]"),
    ].map((row) => row.getAttribute("data-license-id"));
  assert.deepEqual(ids(), ["dated", "pending-a", "pending-b"]);
  await click("Paid through / Expires");
  assert.deepEqual(ids(), ["dated", "pending-a", "pending-b"]);
  await input("#license-access", "pending", "change");
  assert.equal(ids().length, 2);
});
test("authenticated sellers discard emailed sign-in links on arrival and hash changes", async () => {
  await mount("/seller#seller-login=old-secret");
  assert.equal(dom.location.hash, "");
  assert.match(text(), /seller@example.test/);
  assert.doesNotMatch(text(), /Confirm seller sign in/);
  dom.location.hash = "#seller-login=another-secret";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  await flush();
  assert.equal(dom.location.hash, "");
  assert.doesNotMatch(text(), /Confirm seller sign in/);
  assert.equal(
    calls.some((c) => c.path.endsWith("/auth/consume")),
    false,
  );
  await click("Sign out");
  assert.match(text(), /Sign in to sell/);
  assert.doesNotMatch(text(), /Confirm seller sign in/);
});

test("seller sign-in confirmation waits for the initial session lookup", async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  await mount("/seller#seller-login=pending-secret", () => {
    signed = false;
    routes.set("GET /api/v1/platform/me", () => pending);
  });
  assert.equal(dom.location.hash, "");
  assert.match(text(), /Loading seller session/);
  assert.doesNotMatch(text(), /Confirm seller sign in/);
  resolve(denied());
  await flush();
  assert.equal(button("Confirm seller sign in").disabled, false);
  assert.equal(
    calls.some((c) => c.path.endsWith("/auth/consume")),
    false,
  );
});

test("seller email token clears before requests and requires explicit confirmation; cancel and hash changes work", async () => {
  await mount("/seller#seller-login=first-secret", () => {
    signed = false;
    routes.set("POST /api/v1/platform/auth/consume", (c) => {
      assert.equal(dom.location.hash, "");
      assert.deepEqual(c.body, { token: "second-secret" });
      signed = true;
      return Response.json({ ok: true });
    });
  });
  assert.equal(dom.location.hash, "");
  assert.equal(
    calls.some((c) => c.path.endsWith("/consume")),
    false,
  );
  await click("Cancel sign in");
  dom.location.hash = "#seller-login=second-secret";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  await flush();
  await click("Confirm seller sign in");
  assert.match(text(), /seller@example.test/);
  assert.doesNotMatch(text(), /Confirm seller sign in/);
  await click("Sign out");
  assert.match(text(), /Sign in to sell/);
  await input("#seller-email", " person@example.test ");
  await submit("#seller-login");
  assert.deepEqual(calls.at(-1)?.body, { email: "person@example.test" });
  assert.match(text(), /Check your email/);
});
test("seller creates a tenant and selects only a membership returned by the server", async () => {
  await mount("/seller?tenant=not-owned", () => {
    tenants = [];
    routes.set("POST /api/v1/platform/tenants", (c) => {
      assert.deepEqual(c.body, { slug: "alpha", name: "Alpha plugins" });
      tenants = [tenant];
      return Response.json({ tenant });
    });
  });
  assert.equal(
    calls.some((c) => c.path.includes("not-owned")),
    false,
  );
  await input("#tenant-name", "Alpha plugins");
  await input("#tenant-slug", "alpha");
  await submit("#tenant-create");
  assert.equal(el("main h1").textContent, "Getting started");
  assert.equal(
    el<HTMLDetailsElement>("#workspace-create-disclosure").open,
    false,
  );
  assert.match(text(), /My plugin/);
  assert.equal(
    new Headers(
      calls.find((c) => c.path.endsWith("/platform/tenants"))?.init.headers,
    ).get("X-CSRF-Token"),
    "seller-csrf",
  );
  await input("#tenant-select", "alpha", "change");
  await click("Refresh dashboard");
});
test("seller product setup sends chosen Stripe annual price and site allowance", async () => {
  await mount();
  await input("#product-name", "A new plugin");
  await input("#product-slug", "new-plugin");
  await input("#plugin-basename", "new-plugin/plugin.php");
  await input("#plan-name", "Five sites");
  await input("#site-allowance", "5");
  await input("#price-id", "price_annual", "change");
  await submit("#product-create");
  const call = calls.find((c) => c.path.endsWith("/seller/products"));
  assert.deepEqual(call?.body, {
    name: "A new plugin",
    slug: "new-plugin",
    pluginBasename: "new-plugin/plugin.php",
    framework: "wordpress",
    frameworkConfig: {},
    plans: [{ name: "Five sites", siteAllowance: 5, priceId: "price_annual" }],
  });
  assert.equal(
    new Headers(call?.init.headers).get("X-CSRF-Token"),
    "seller-csrf",
  );
});
test("license, release and key revocations require explicit confirmation and support cancellation", async () => {
  await mount();
  for (const [start, confirm, path, body] of [
    [
      "Revoke license",
      "Confirm revoke license",
      "licenses/l1/revoke",
      { revoked: true },
    ],
    ["Withdraw release", "Confirm withdrawal", "releases/r1/withdraw", {}],
    ["Revoke API key", "Confirm revoke API key", "keys/k1/revoke", {}],
  ] as const) {
    await click(start);
    await click("Cancel");
    assert.equal(
      calls.some((c) => c.path.endsWith(path)),
      false,
    );
    await click(start);
    await click(confirm);
    assert.deepEqual(calls.find((c) => c.path.endsWith(path))?.body, body);
  }
});
test("API keys are shown once with explicit copy and dismissal, never cached", async () => {
  await mount("/seller", () => {
    routes.set("POST /api/v1/tenants/alpha/seller/keys", (c) => {
      assert.deepEqual(c.body, {
        name: "CI runner",
        scopes: ["read", "releases:write"],
        expiresInDays: 90,
      });
      return Response.json({
        id: "new",
        name: "CI runner",
        token: "DE_secret_once",
      });
    });
  });
  await input("#key-name", "CI runner");
  await submit("#key-create");
  assert.match(text(), /shown once/);
  assert.equal(el<HTMLInputElement>("#new-api-key").value, "DE_secret_once");
  await click("Copy API key");
  assert.deepEqual(clipboard, ["DE_secret_once"]);
  await click("I saved my API key");
  assert.equal(dom.document.querySelector("#new-api-key"), null);
});
test("API key scope controls send only selected permissions and chosen expiry", async () => {
  await mount();
  const checked = () =>
    (
      [
        ...dom.document.querySelectorAll('#key-create input[type="checkbox"]'),
      ] as unknown as HTMLInputElement[]
    )
      .filter((item) => item.checked)
      .map((item) => item.value);
  assert.deepEqual(checked(), ["read", "releases:write"]);
  assert.equal(el<HTMLSelectElement>("#key-expiry").value, "90");
  for (const scope of [
    "releases:write",
    "catalog:write",
    "licenses:write",
    "billing:reconcile",
  ]) {
    el<HTMLInputElement>(`#key-create input[value="${scope}"]`).click();
    await flush();
  }
  await input("#key-name", "Billing worker");
  await input("#key-expiry", "7", "change");
  routes.set("POST /api/v1/tenants/alpha/seller/keys", () =>
    Response.json({ token: "DE_custom_once" }),
  );
  await submit("#key-create");
  const call = calls.find(
    (item) => item.path.endsWith("/seller/keys") && item.init.method === "POST",
  )!;
  assert.deepEqual(call.body, {
    name: "Billing worker",
    scopes: ["read", "catalog:write", "licenses:write", "billing:reconcile"],
    expiresInDays: 7,
  });
  assert.equal(
    new Headers(call.init.headers).get("x-csrf-token"),
    "seller-csrf",
  );
  assert.equal(call.init.credentials, "same-origin");
});
test("API key list shows safe identifiers, permissions, expiry and last use with revoked precedence", async () => {
  await mount("/seller", () => {
    keys = [
      {
        id: "active",
        name: "Publisher",
        ...keyMetadata,
        created_at: 1,
        revoked_at: null,
        last_used_at: 1792500000000,
      },
      {
        id: "expired",
        name: "Past worker",
        ...keyMetadata,
        created_at: 1,
        revoked_at: null,
        expires_at: 1,
      },
      {
        id: "revoked",
        name: "Old worker",
        ...keyMetadata,
        created_at: 1,
        revoked_at: 2,
        expires_at: 1,
      },
      {
        id: "legacy",
        name: "Legacy worker",
        ...keyMetadata,
        created_at: 1,
        revoked_at: null,
        expires_at: null,
      },
    ];
  });
  const row = (name: string) =>
    [...dom.document.querySelectorAll("li")].find((item) =>
      item.textContent.includes(name),
    )!;
  assert.match(row("Publisher").textContent, /Active/);
  assert.match(row("Publisher").textContent, /DE_build/);
  assert.match(row("Publisher").textContent, /read, releases:write/);
  assert.match(
    row("Publisher").textContent,
    new RegExp(
      `Expires: ${new Date(keyMetadata.expires_at!).toLocaleDateString()}`,
    ),
  );
  assert.match(
    row("Publisher").textContent,
    new RegExp(`Last used: ${new Date(1792500000000).toLocaleDateString()}`),
  );
  assert.match(row("Past worker").textContent, /Expired/);
  assert.match(row("Past worker").textContent, /Last used: Never/);
  assert.match(row("Old worker").textContent, /Revoked/);
  assert.equal(row("Old worker").querySelector("button"), null);
  assert.match(row("Legacy worker").textContent, /Replace required/);
  assert.match(row("Legacy worker").textContent, /Expires: Unavailable/);
});
test("Stripe and platform billing buttons use interactive CSRF and server URLs", async () => {
  await mount("/seller", () => {
    for (const path of [
      "/api/v1/tenants/alpha/seller/stripe/connect",
      "/api/v1/tenants/alpha/seller/platform/checkout",
      "/api/v1/tenants/alpha/seller/platform/portal",
    ])
      routes.set(`POST ${path}`, () =>
        Response.json({
          url: "https://stripe.example.test/" + path.split("/").at(-1),
        }),
      );
  });
  for (const label of [
    "Connect Stripe",
    "Subscribe to Doublesharp Entitle",
    "Platform billing",
  ])
    await click(label);
  assert.deepEqual(redirects, [
    "https://stripe.example.test/connect",
    "https://stripe.example.test/checkout",
    "https://stripe.example.test/portal",
  ]);
  for (const c of calls.filter((c) => c.init.method === "POST")) {
    assert.equal(c.init.credentials, "same-origin");
    assert.equal(
      new Headers(c.init.headers).get("X-CSRF-Token"),
      "seller-csrf",
    );
  }
});
test("ZIP publication bounds files before upload and sends metadata and raw bytes", async () => {
  await mount();
  await input("#release-product", "p1", "change");
  await input("#release-version", "1.2.3");
  await input("#release-changelog", "Fixed an issue.");
  for (const [id, value] of [
    ["min-wp", "6.0"],
    ["min-php", "8.1"],
    ["min-free", "1.0"],
    ["tested", "6.9"],
  ])
    await input("#release-" + id, value!);
  const file = el<HTMLInputElement>("#release-file");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [new dom.File(["PKzip"], "plugin.zip", { type: "application/zip" })],
  });
  file.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await input("#release-verification-token", "release-mail-proof");
  await submit("#release-upload");
  const c = calls.find((c) => c.path.endsWith("/seller/releases/plugin/1.2.3"));
  assert.ok(c);
  assert.equal(
    new Headers(c.init.headers).get("Content-Type"),
    "application/zip",
  );
  const metadata = JSON.parse(
    Buffer.from(
      new Headers(c.init.headers).get("X-Release-Metadata")!,
      "base64url",
    ).toString(),
  );
  assert.deepEqual(metadata, {
    changelog: "Fixed an issue.",
    minWp: "6.0",
    minPhp: "8.1",
    minFree: "1.0",
    tested: "6.9",
  });
  assert.equal(c.init.body instanceof ArrayBuffer, true);
  assert.equal(
    new Headers(c.init.headers).get("X-Account-Verification"),
    "verified-grant",
  );
  assert.deepEqual(
    calls.find((call) => call.path.endsWith("/verification/consume"))?.body,
    { purpose: "release_publish", token: "release-mail-proof" },
  );
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [{ size: 26214401 }],
  });
  file.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await submit("#release-upload");
  assert.match(text(), /25 MiB/);
  assert.equal(
    calls.filter((c) => c.path.endsWith("/seller/releases/plugin/1.2.3"))
      .length,
    1,
  );
});
test("request errors retain references, retry works, and session expiry clears owner data and secrets", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/overview", () =>
      denied(503, "Dashboard unavailable."),
    );
  });
  assert.match(el('[role="alert"]').textContent!, /Dashboard unavailable/);
  assert.match(
    el('[role="alert"] details').textContent!,
    /Reference: request-ref/,
  );
  routes.delete("GET /api/v1/tenants/alpha/seller/overview");
  await click("Refresh dashboard");
  assert.match(text(), /buyer@example.test/);
  routes.set("POST /api/v1/tenants/alpha/seller/keys", () => denied());
  await input("#key-name", "CI");
  await submit("#key-create");
  assert.doesNotMatch(text(), /buyer@example.test/);
  assert.match(text(), /Sign in to sell/);
});

test("delayed price failures cannot replace authentication errors or a refreshed dashboard", async () => {
  for (const status of [401, 503]) {
    let finishPrices!: (response: Response) => void;
    const pendingPrices = new Promise<Response>((resolve) => {
      finishPrices = resolve;
    });
    await mount("/seller", () => {
      routes.set("GET /api/v1/tenants/alpha/seller/overview", () =>
        denied(status, "Critical dashboard failure."),
      );
      routes.set(
        "GET /api/v1/tenants/alpha/seller/prices",
        () => pendingPrices,
      );
    });
    assert.match(text(), /Critical dashboard failure/);
    if (status === 503) {
      routes.delete("GET /api/v1/tenants/alpha/seller/overview");
      routes.delete("GET /api/v1/tenants/alpha/seller/prices");
      await click("Refresh dashboard");
      assert.match(text(), /Your workspace in numbers/);
    }
    finishPrices(denied(503, "Obsolete price outage."));
    await flush();
    assert.doesNotMatch(text(), /Obsolete price outage/);
    if (status === 401) assert.match(text(), /Critical dashboard failure/);
  }
});

test("docs limits failures are retryable without hiding the setup guide", async () => {
  await mount("/docs", () =>
    routes.set("GET /api/v1/platform/info", () =>
      denied(503, "Limits unavailable."),
    ),
  );
  assert.match(text(), /Limits unavailable. Reference: request-ref/);
  assert.equal(el("main h1").textContent, "Documentation");
  assert.match(text(), /Create your publisher workspace/);
  routes.delete("GET /api/v1/platform/info");
  await click("Reload server limits");
  assert.match(text(), /25 MiB/);
  assert.doesNotMatch(text(), /Limits unavailable/);
});

test("malformed seller sessions remain signed out and can be retried", async () => {
  for (const response of [
    null,
    {},
    { user: { email: "" }, tenants: [], csrfToken: "x" },
    { user: { email: "a@test" }, tenants: null, csrfToken: "x" },
    { user: { email: "a@test" }, tenants: [], csrfToken: null },
  ]) {
    await mount("/seller", () =>
      routes.set("GET /api/v1/platform/me", () => Response.json(response)),
    );
    assert.match(text(), /Sign in to sell/);
    assert.equal(dom.document.querySelector("#php-config"), null);
  }
  routes.delete("GET /api/v1/platform/me");
  await click("Retry session");
  assert.match(text(), /My plugin/);
});

test("empty seller workspaces show setup guidance and keyboard copy fallback", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      products: [],
      releases: [],
      licenses: [],
      metrics: { ...overview().metrics, payments: [] },
    });
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      Response.json({ prices: [], localMode: false }),
    );
  });
  assert.match(text(), /create an active annual recurring price/);
  assert.match(el<HTMLTextAreaElement>("#php-config").value, /your-product/);
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  await click("Copy PHP configuration");
  assert.match(text(), /Copy it using your keyboard/);
  assert.equal(dom.document.activeElement?.id, "php-config");
});

test("owner view distinguishes suspended and revoked records and restores a revoked license", async () => {
  await mount("/seller", () => {
    getOverview = () => {
      const data = overview();
      return {
        ...data,
        tenant: {
          ...tenant,
          suspended: 1,
          stripe_account_id: "acct_test",
          stripe_status: "connected",
          trial_ends_at: 0,
        },
        licenses: [
          { ...data.licenses[0]!, revoked: true },
          { ...data.licenses[0]!, id: "l2", suspended: true },
        ],
        releases: [{ ...data.releases[0]!, withdrawn: true }],
        metrics: {
          ...data.metrics,
          payments: [
            {
              currency: "usd",
              paidMinor: "100",
              refundedMinor: "200",
              netMinor: "-100",
            },
          ],
        },
      };
    };
    keys = [
      {
        id: "k1",
        name: "Old key",
        ...keyMetadata,
        created_at: 1,
        revoked_at: 2,
      },
    ];
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      Response.json({
        prices: [
          {
            id: "p_custom",
            productName: "Custom",
            nickname: null,
            unit_amount: null,
            currency: "usd",
            interval: "year",
          },
        ],
        localMode: false,
      }),
    );
  });
  assert.match(text(), /Suspended/);
  assert.match(text(), /Connected/);
  assert.match(text(), /Not applicable/);
  assert.match(text(), /-\$1\.00/);
  assert.match(text(), /p_custom · Custom price/);
  await click("Restore license");
  await click("Confirm restore license");
  assert.deepEqual(
    calls.find((c) => c.path.endsWith("/licenses/l1/revoke"))?.body,
    { revoked: false },
  );
});

test("empty email fragments stay unusable and unmount removes the seller watcher", async () => {
  await mount("/seller#seller-login=", () => {
    signed = false;
  });
  assert.equal(dom.location.hash, "");
  assert.equal(button("Confirm seller sign in").disabled, true);
  await click("Cancel sign in");
  app?.unmount();
  dom.location.hash = "#seller-login=after-unmount";
  dom.dispatchEvent(new dom.HashChangeEvent("hashchange"));
  assert.equal(dom.location.hash, "#seller-login=after-unmount");
});

test("missing or cleared upload files never send publication bytes", async () => {
  await mount();
  await submit("#release-upload");
  assert.match(text(), /Choose a plugin ZIP/);
  const file = el<HTMLInputElement>("#release-file");
  Object.defineProperty(file, "files", { configurable: true, value: null });
  file.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await submit("#release-upload");
  assert.equal(
    calls.some((c) => c.init.method === "POST"),
    false,
  );
});

test("an in-flight seller request cannot be duplicated and a failed sign-in stays signed out", async () => {
  let resolve!: (value: Response) => void;
  const pending = new Promise<Response>((done) => {
    resolve = done;
  });
  await mount("/seller#seller-login=invalid", () => {
    signed = false;
    routes.set("POST /api/v1/platform/auth/request", () => pending);
  });
  routes.set("POST /api/v1/platform/auth/consume", () =>
    denied(401, "Invalid link."),
  );
  await click("Confirm seller sign in");
  assert.match(text(), /Sign in to sell/);
  assert.match(text(), /Invalid link/);
  await click("Cancel sign in");
  await input("#seller-email", "seller@example.test");
  const form = el("#seller-login");
  const submitEvent = () =>
    form.dispatchEvent(
      new dom.Event("submit", {
        bubbles: true,
        cancelable: true,
      }) as unknown as Event,
    );
  submitEvent();
  submitEvent();
  await flush();
  assert.equal(calls.filter((c) => c.path.endsWith("/auth/request")).length, 1);
  assert.match(text(), /Working/);
  resolve(Response.json({ ok: true }));
  await flush();
  assert.match(text(), /Check your email/);
});

test("seller confirmations use a native modal and Escape cancels without mutation", async () => {
  await mount();
  await click("Revoke license");
  const dialog = el<HTMLDialogElement>("dialog");
  assert.equal(dialog.open, true);
  dialog.dispatchEvent(
    new dom.Event("cancel", { cancelable: true }) as unknown as Event,
  );
  await flush();
  assert.equal(dom.document.querySelector("dialog"), null);
  assert.equal(
    calls.some((c) => c.path.endsWith("/licenses/l1/revoke")),
    false,
  );
});

test("switching seller workspaces clears upload bytes and resets tenant-specific form context", async () => {
  const second = {
    ...tenant,
    id: "tenant-b",
    slug: "beta",
    name: "Beta plugins",
  };
  await mount("/seller", () => {
    tenants = [tenant, second];
    routes.set("GET /api/v1/tenants/beta/seller/overview", () =>
      Response.json({
        ...overview(),
        tenant: second,
        products: [],
        releases: [],
        licenses: [],
      }),
    );
  });
  const upload = el<HTMLInputElement>("#release-file");
  Object.defineProperty(upload, "files", {
    configurable: true,
    value: [new dom.File(["old ZIP"], "alpha.zip")],
  });
  upload.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await input("#tenant-select", "beta", "change");
  await submit("#release-upload");
  assert.match(text(), /Choose a plugin ZIP/);
  assert.equal(
    calls.some(
      (c) =>
        c.path.includes("/beta/seller/releases/") && c.init.method === "POST",
    ),
    false,
  );
});

test("seller license inspection shows paid-through dates and the actual Stripe connection status", async () => {
  await mount("/seller", () => {
    getOverview = () => {
      const data = overview();
      return {
        ...data,
        tenant: {
          ...tenant,
          stripe_account_id: "acct_restricted",
          stripe_status: "restricted",
        },
        licenses: [
          { ...data.licenses[0]!, paid_through: null },
          {
            ...data.licenses[0]!,
            id: "paid",
            paid_through: Date.UTC(2030, 5, 4),
          },
        ],
      };
    };
  });
  assert.equal(
    el("#seller-panel-billing .feature-badge").textContent,
    "Action needed",
  );
  assert.match(text(), /Paid through/);
  assert.match(text(), /Not yet available/);
  assert.match(text(), /2030/);
});

test("release requirements omit blank optional values and reject invalid numeric versions before upload", async () => {
  await mount();
  await input("#release-version", "1.0.1");
  const chooseFile = () => {
    const file = el<HTMLInputElement>("#release-file");
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [new dom.File(["ZIP"], "plugin.zip")],
    });
    file.dispatchEvent(
      new dom.Event("change", { bubbles: true }) as unknown as Event,
    );
  };
  chooseFile();
  await input("#release-min-wp", "not-a-version");
  await submit("#release-upload");
  assert.match(text(), /numeric versions/);
  assert.equal(
    calls.some((c) => c.path.endsWith("/seller/releases/plugin/1.0.1")),
    false,
  );
  await input("#release-min-wp", "");
  await submit("#release-upload");
  const request = calls.find((c) =>
    c.path.endsWith("/seller/releases/plugin/1.0.1"),
  );
  assert.ok(request);
  const metadata = JSON.parse(
    Buffer.from(
      new Headers(request.init.headers).get("X-Release-Metadata")!,
      "base64url",
    ).toString(),
  );
  assert.deepEqual(metadata, { changelog: "" });
});

test("PHP configuration can select each published product without adding automation credentials", async () => {
  await mount("/seller", () => {
    getOverview = () => {
      const data = overview();
      return {
        ...data,
        products: [
          ...data.products,
          {
            ...data.products[0]!,
            id: "p2",
            slug: "second-plugin",
            name: "Second plugin",
          },
        ],
      };
    };
  });
  await input("#config-product", "second-plugin", "change");
  const config = el<HTMLTextAreaElement>("#php-config").value;
  assert.match(config, /\$product_slug = 'second-plugin'/);
  assert.doesNotMatch(config, /seller-csrf|DE_secret/);
  await click("Copy PHP configuration");
  assert.equal(clipboard[0], config);
});

test("a first seller visit treats an absent session as normal and keeps real session failures retryable", async () => {
  await mount("/seller", () => {
    signed = false;
  });
  assert.match(text(), /Sign in to sell/);
  assert.ok(dom.document.querySelector("#seller-login"));
  assert.equal(dom.document.querySelector('[role="alert"]') === null, true);
  assert.equal(
    [...dom.document.querySelectorAll("button")].some(
      (item) => item.textContent === "Retry session",
    ),
    false,
  );
  for (const response of [
    () => denied(503, "Session unavailable."),
    () =>
      new Response("invalid JSON", {
        headers: { "Content-Type": "application/json" },
      }),
  ]) {
    await mount("/seller", () =>
      routes.set("GET /api/v1/platform/me", response),
    );
    assert.ok(dom.document.querySelector('[role="alert"]'));
    assert.ok(button("Retry session"));
    routes.delete("GET /api/v1/platform/me");
    await click("Retry session");
    assert.match(text(), /My plugin/);
  }
});
test("restricted workspaces keep platform billing and API key revocation available without business controls", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/overview", () =>
      denied(403, "This publisher's service is suspended."),
    );
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      denied(403, "This publisher's service is suspended."),
    );
    for (const action of ["checkout", "portal"])
      routes.set(`POST /api/v1/tenants/alpha/seller/platform/${action}`, () =>
        Response.json({ url: `https://stripe.example.test/${action}` }),
      );
    routes.set("POST /api/v1/tenants/alpha/seller/keys/k1/revoke", () => {
      keys[0]!.revoked_at = 2;
      return Response.json({ ok: true });
    });
  });
  assert.match(text(), /Workspace recovery/);
  assert.equal(el("main h1").textContent, "Workspace recovery");
  assert.match(text(), /Billing and API key revocation remain available/);
  assert.equal(dom.document.querySelector("#product-create"), null);
  assert.equal(dom.document.querySelector("#key-create"), null);
  assert.match(text(), /DE_build/);
  await click("Subscribe to Doublesharp Entitle");
  await click("Platform billing");
  assert.deepEqual(redirects, [
    "https://stripe.example.test/checkout",
    "https://stripe.example.test/portal",
  ]);
  await click("Revoke API key");
  await click("Confirm revoke API key");
  assert.match(text(), /Revoked/);
  const mutation = calls.find((call) => call.path.endsWith("/keys/k1/revoke"))!;
  assert.equal(
    new Headers(mutation.init.headers).get("X-CSRF-Token"),
    "seller-csrf",
  );
  routes.delete("GET /api/v1/tenants/alpha/seller/overview");
  routes.delete("GET /api/v1/tenants/alpha/seller/prices");
  await click("Refresh dashboard");
  assert.doesNotMatch(text(), /Workspace recovery/);
  assert.match(text(), /Your workspace in numbers/);
});
test("recovery cannot expose keys when the recovery API denies tenant access", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/overview", () =>
      denied(403, "Workspace restricted."),
    );
    routes.set("GET /api/v1/tenants/alpha/seller/keys", () =>
      denied(403, "Workspace access denied."),
    );
  });
  assert.match(text(), /Workspace access denied/);
  assert.doesNotMatch(text(), /DE_build|Workspace recovery/);
});

test("framework selection shows only relevant identity fields and sends bounded configuration", async () => {
  await mount();
  for (const [framework, expected] of [
    ["electron", {}],
    ["tauri", {}],
    ["sparkle", {}],
    [
      "joomla",
      {
        extensionType: "plugin",
        element: "licensed",
        folder: "system",
        client: "administrator",
        joomlaMajor: 5,
      },
    ],
    [
      "jetbrains",
      {
        pluginId: "com.example.licensed",
        sinceBuild: "243",
        untilBuild: "251.*",
      },
    ],
    ["generic", { activationKind: "site" }],
  ] as const) {
    await input("#product-framework", framework, "change");
    assert.equal(dom.document.querySelector("#plugin-basename"), null);
    if (framework === "joomla") {
      await input("#joomla-extension-type", "plugin", "change");
      await input("#joomla-element", "licensed");
      await input("#joomla-folder", "system");
      await input("#joomla-client", "administrator", "change");
      await input("#joomla-major", "5");
    }
    if (framework === "jetbrains") {
      await input("#jetbrains-plugin-id", "com.example.licensed");
      await input("#jetbrains-since-build", "243");
      await input("#jetbrains-until-build", "251.*");
    }
    if (framework === "generic")
      await input("#activation-kind", "site", "change");
    await submit("#product-create");
    const body = calls
      .filter((c) => c.path.endsWith("/seller/products"))
      .at(-1)!.body as Record<string, unknown>;
    assert.equal(body.framework, framework);
    assert.deepEqual(body.frameworkConfig, expected);
    assert.equal("pluginBasename" in body, false);
  }
  assert.match(
    text(),
    /identity cannot change after licenses or releases exist/i,
  );
});

function nativeOverview(framework = "electron", frameworkConfig = {}) {
  const data = overview();
  return {
    ...data,
    products: data.products.map((p) => ({ ...p, framework, frameworkConfig })),
    releases: data.releases.map((r) => ({
      ...r,
      assets: [
        {
          id: "asset",
          target: "darwin-arm64",
          filename: "App.zip",
          size: 5,
          checksum: "abc",
          sha512: "def",
          signature: null,
          min_system_version: null,
        },
      ],
    })),
  };
}
function chooseFile(name = "App.zip", bytes = "PKzip") {
  const file = el<HTMLInputElement>("#release-file");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [new dom.File([bytes], name)],
  });
  file.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
}
test("native upload accepts a 50 MiB Electron asset under its separate 100 MiB limit", async () => {
  await mount("/seller", () => {
    getOverview = () => nativeOverview();
  });
  await input("#release-version", "2.0.0");
  let reads = 0;
  const file = el<HTMLInputElement>("#release-file");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [
      {
        name: "App.zip",
        size: 50 * 1048576,
        arrayBuffer: async () => {
          reads++;
          return new TextEncoder().encode("small fake asset").buffer;
        },
      },
    ],
  });
  file.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await input("#release-verification-token", "release-mail-proof");
  await submit("#release-upload");
  assert.equal(reads, 1);
  assert.ok(calls.find((call) => call.path.endsWith("/assets/plugin/2.0.0")));
  assert.match(text(), /Release published/);
});
for (const [framework, sizeMiB, limitMiB] of [
  ["electron", 101, 100],
  ["wordpress", 50, 25],
] as const) {
  test(`${framework} upload rejects ${sizeMiB} MiB before reading bytes or consuming proof`, async () => {
    await mount("/seller", () => {
      if (framework !== "wordpress")
        getOverview = () => nativeOverview(framework);
    });
    await input("#release-version", "2.0.0");
    let reads = 0;
    const file = el<HTMLInputElement>("#release-file");
    Object.defineProperty(file, "files", {
      configurable: true,
      value: [
        {
          name: "App.zip",
          size: sizeMiB * 1048576,
          arrayBuffer: async () => {
            reads++;
            return new ArrayBuffer(0);
          },
        },
      ],
    });
    file.dispatchEvent(
      new dom.Event("change", { bubbles: true }) as unknown as Event,
    );
    await submit("#release-upload");
    assert.match(text(), new RegExp(`no larger than ${limitMiB} MiB`));
    assert.equal(reads, 0);
    assert.equal(
      calls.some((call) =>
        /\/(?:assets|releases)\/|verification\/consume/.test(call.path),
      ),
      false,
    );
  });
}
test("upload guidance follows the selected product and configured native limit", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/platform/info", () =>
      Response.json({
        deploymentMode: "hosted",
        applicationFeePercent: 1,
        maxUploadBytes: 25 * 1048576,
        maxNativeUploadBytes: 37 * 1048576,
      }),
    );
    getOverview = () => ({
      ...overview(),
      products: [
        ...overview().products,
        ...nativeOverview().products.map((p) => ({ ...p, id: "native" })),
      ],
    });
  });
  assert.match(
    el("#seller-panel-releases").textContent!,
    /Maximum 25 MiB per asset/,
  );
  await input("#release-product", "native", "change");
  assert.match(
    el("#seller-panel-releases").textContent!,
    /Maximum 37 MiB per asset/,
  );
  await input("#release-product", "p1", "change");
  assert.match(
    el("#seller-panel-releases").textContent!,
    /Maximum 25 MiB per asset/,
  );
});
test("native release upload sends immutable target bytes and signature metadata without WordPress fields", async () => {
  for (const [framework, target, filename] of [
    ["electron", "darwin-arm64", "App.zip"],
    ["tauri", "darwin-aarch64", "App.app.tar.gz"],
    ["sparkle", "darwin-universal", "App.zip"],
    ["joomla", "any", "plugin.zip"],
    ["jetbrains", "any", "plugin.jar"],
    ["generic", "linux-custom", "App.bin"],
  ]) {
    await mount("/seller", () => {
      getOverview = () => nativeOverview(framework!);
    });
    assert.equal(dom.document.querySelector("#release-min-wp"), null);
    await input(
      "#release-target",
      target!,
      framework === "generic" ? "input" : "change",
    );
    await input("#release-version", "2.0.0");
    await input("#release-changelog", "Unicode release ✓");
    chooseFile(filename);
    if (framework === "tauri" || framework === "sparkle") {
      await submit("#release-upload");
      assert.match(text(), /signature is required/i);
      assert.equal(
        calls.some((c) => c.path.includes("/assets/")),
        false,
      );
      await input("#release-signature", "signed-detached-value");
    }
    await input("#release-min-system-version", "13.0");
    await submit("#release-upload");
    const call = calls.find((c) =>
      c.path.endsWith("/seller/assets/plugin/2.0.0"),
    );
    assert.ok(call);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("Content-Type"), "application/octet-stream");
    assert.equal(headers.get("X-CSRF-Token"), "seller-csrf");
    const metadata = JSON.parse(
      Buffer.from(headers.get("X-Release-Metadata")!, "base64url").toString(),
    );
    assert.deepEqual(metadata, {
      target,
      filename,
      changelog: "Unicode release ✓",
      minSystemVersion: "13.0",
      ...(["tauri", "sparkle"].includes(framework!)
        ? { signature: "signed-detached-value" }
        : {}),
    });
    assert.ok(call.init.body instanceof ArrayBuffer);
    assert.match(text(), /darwin-arm64.*App.zip/);
  }
});

test("setup URLs use this installation origin, specific feeds and no credentials", async () => {
  for (const [framework, feed] of [
    ["joomla", "/updates/joomla/plugin.xml"],
    ["electron", "/updates/electron/plugin/windows-x64/latest.yml"],
    ["tauri", "/updates/tauri/plugin/windows-x86_64/{currentVersion}"],
    ["sparkle", "/updates/sparkle/plugin/darwin-x64/appcast.xml"],
    ["jetbrains", "/updates/jetbrains/plugin/updatePlugins.xml"],
    ["generic", "/updates/generic/plugin/{target}"],
  ]) {
    await mount("/seller", () => {
      getOverview = () => nativeOverview(framework!);
    });
    const setup = el<HTMLTextAreaElement>("#php-config").value;
    assert.ok(
      setup.includes("http://localhost:3211/api/v1/tenants/alpha" + feed),
      setup,
    );
    assert.doesNotMatch(setup, /DE_secret|seller-csrf/);
    await click("Copy setup configuration");
    assert.equal(clipboard[0], setup);
  }
});

test("framework API errors retain seller authentication and explain immutable identity", async () => {
  await mount("/seller", () =>
    routes.set("POST /api/v1/tenants/alpha/seller/products", () =>
      denied(
        409,
        "Framework identity cannot change after licenses or releases exist.",
      ),
    ),
  );
  await input("#product-framework", "generic", "change");
  await submit("#product-create");
  assert.match(text(), /Framework identity cannot change.*request-ref/);
  assert.match(text(), /seller@example.test/);
  assert.ok(dom.document.querySelector("#key-create"));
});

test("public home names supported adapters and links to honest runtime qualification", async () => {
  await mount("/");
  for (const name of [
    "WordPress",
    "Joomla",
    "Electron",
    "Tauri",
    "Sparkle",
    "JetBrains",
    "Generic",
  ])
    assert.ok(text().includes(name));
  assert.ok(dom.document.querySelector('a[href="/docs#framework-support"]'));
  await mount("/docs");
  assert.match(text(), /native runtime.*qualification/i);
  assert.doesNotMatch(text(), /integrations are not included/);
});

test("optional framework identity fields stay absent and native uploads can omit optional metadata", async () => {
  await mount("/seller", () => {
    getOverview = () => {
      const data = nativeOverview("generic");
      data.products[0]!.plans[0]!.site_allowance = 1;
      return data;
    };
  });
  for (const framework of ["joomla", "jetbrains"]) {
    await input("#product-framework", framework, "change");
    if (framework === "joomla") {
      await input("#joomla-extension-type", "component", "change");
      assert.equal(el<HTMLInputElement>("#joomla-folder").required, false);
      await input("#joomla-element", "com_example");
    } else {
      await input("#jetbrains-plugin-id", "org.example.plugin");
      await input("#jetbrains-since-build", "243");
    }
    await submit("#product-create");
    const body = calls
      .filter((c) => c.path.endsWith("/seller/products"))
      .at(-1)!.body as { frameworkConfig: Record<string, unknown> };
    assert.equal("folder" in body.frameworkConfig, false);
    assert.equal("untilBuild" in body.frameworkConfig, false);
  }
  await input("#release-version", "1.0.1");
  await input("#release-target", "linux-custom");
  chooseFile("package.bin", "binary");
  await submit("#release-upload");
  const call = calls.find((c) =>
    c.path.endsWith("/seller/assets/plugin/1.0.1"),
  )!;
  const metadata = JSON.parse(
    Buffer.from(
      new Headers(call.init.headers).get("X-Release-Metadata")!,
      "base64url",
    ).toString(),
  );
  assert.deepEqual(metadata, {
    target: "linux-custom",
    filename: "package.bin",
    changelog: "",
  });
  assert.match(text(), /1 device/);
});

test("changing release products clears private bytes and signatures before another publication", async () => {
  await mount("/seller", () => {
    getOverview = () => {
      const data = nativeOverview("sparkle");
      data.products.push({
        ...data.products[0]!,
        id: "p2",
        slug: "second",
        framework: "tauri",
      });
      return data;
    };
  });
  chooseFile("App.zip");
  await input("#release-signature", "previous-product-signature");
  await input("#release-product", "p2", "change");
  assert.equal(el<HTMLInputElement>("#release-signature").value, "");
  assert.equal(
    el<HTMLSelectElement>("#release-target").value,
    "windows-x86_64",
  );
  await submit("#release-upload");
  assert.match(text(), /Choose a release asset/);
  assert.equal(
    calls.some((c) => c.path.includes("/seller/assets/")),
    false,
  );
});

test("oversized native assets are rejected before reading or sending their bytes", async () => {
  await mount("/seller", () => {
    getOverview = () => nativeOverview();
  });
  const file = el<HTMLInputElement>("#release-file");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [
      {
        size: 104857601,
        name: "App.zip",
        arrayBuffer: () => {
          throw Error("must not read oversized bytes");
        },
      },
    ],
  });
  file.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await submit("#release-upload");
  assert.match(text(), /Choose a release asset no larger than 100 MiB/);
  assert.equal(
    calls.some((c) => c.path.includes("/seller/assets/")),
    false,
  );
});

test("license table searches, combines filters, sorts numbers and dates, and resets for another workspace", async () => {
  await mount("/seller", () => {
    tenants = [
      tenant,
      { ...tenant, id: "tenant-b", slug: "beta", name: "Beta" },
    ];
    getOverview = () => {
      const data = overview();
      const base = data.licenses[0]!;
      return {
        ...data,
        licenses: [
          {
            ...base,
            id: "a",
            customer_email: "amy@example.test",
            site_allowance: 2,
            paid_through: 4102444800000,
          },
          {
            ...base,
            id: "b",
            customer_email: "zoe@example.test",
            site_allowance: 12,
            product_id: "p2",
            product_name: "Other app",
            provenance: "complimentary" as const,
            expires_at: 4102531200000,
            revoked: true,
          },
          {
            ...base,
            id: "c",
            customer_email: "bob@example.test",
            site_allowance: 5,
            provenance: "complimentary" as const,
            expires_at: 1,
          },
          {
            ...base,
            id: "d",
            customer_email: "sam@example.test",
            site_allowance: 1,
            paid_through: null,
            suspended: true,
          },
        ],
      };
    };
  });
  await click("Licenses");
  const rows = () =>
    [
      ...dom.document.querySelectorAll(
        "#licenses-table tbody tr[data-license-id]",
      ),
    ].map((row) => row.getAttribute("data-license-id"));
  assert.deepEqual(rows(), ["a", "c", "d", "b"]);
  await input("#license-search", "  AMY@  ");
  assert.deepEqual(rows(), ["a"]);
  await click("Clear filters");
  await input("#license-type", "complimentary", "change");
  await input("#license-access", "expired", "change");
  assert.deepEqual(rows(), ["c"]);
  await input("#license-product", "p2", "change");
  assert.deepEqual(rows(), []);
  assert.match(el("#licenses-table").textContent!, /No licenses match/);
  await click("Clear filters");
  await click("Seats");
  assert.deepEqual(rows(), ["d", "a", "c", "b"]);
  assert.equal(
    el('#licenses-table th[aria-sort="ascending"]').textContent,
    "Seats",
  );
  await click("Seats");
  assert.deepEqual(rows(), ["b", "c", "a", "d"]);
  await click("Paid through / Expires");
  assert.deepEqual(rows(), ["c", "a", "b", "d"]);
  await click("Paid through / Expires");
  assert.deepEqual(rows(), ["b", "a", "c", "d"]);
  await click("Product and plan");
  assert.deepEqual(rows(), ["a", "c", "d", "b"]);
  el<HTMLButtonElement>("#licenses-table th:nth-child(4) button").click();
  await flush();
  assert.deepEqual(rows(), ["a", "d", "b", "c"]);
  await click("Access");
  assert.deepEqual(rows(), ["a", "c", "b", "d"]);
  await click("Customer");
  await click("Customer");
  assert.deepEqual(rows(), ["b", "d", "c", "a"]);
  await input("#license-type", "paid", "change");
  await input("#license-access", "suspended", "change");
  assert.deepEqual(rows(), ["d"]);
  await click("Revoke license");
  assert.match(el("dialog").textContent!, /sam@example.test/);
  await click("Cancel");
  await click("Clear filters");
  await input("#license-search", "amy");
  await click("Products");
  await click("Licenses");
  assert.deepEqual(rows(), ["a"]);
  await click("Refresh dashboard");
  assert.deepEqual(rows(), ["a"]);
  await input("#tenant-select", "beta", "change");
  await click("Licenses");
  assert.equal(el<HTMLInputElement>("#license-search").value, "");
  assert.equal(rows().length, 4);
  routes.set("GET /api/v1/tenants/beta/seller/operations", () =>
    Response.json({
      summary: {},
      settings: {},
      alerts: [],
      notifications: [],
      features: { advancedReports: false },
    }),
  );
  await click("Overview");
  await click("View daily reports");
  assert.equal(el("h1").textContent, "Operations");
});

test("seller navigation shows one focused section and keeps creation forms out of the overview", async () => {
  await mount();
  const nav = el('nav[aria-label="Workspace navigation"]');
  assert.equal(nav.querySelectorAll("button").length, 14);
  assert.equal(el<HTMLElement>("#seller-panel-overview").hidden, false);
  assert.equal(el<HTMLElement>("#seller-panel-products").hidden, true);
  assert.equal(el(".overview-summary").querySelectorAll(".metric").length, 4);
  assert.equal(
    el<HTMLDetailsElement>("#workspace-create-disclosure").open,
    false,
  );
  assert.equal(el("#metrics-details").tagName, "SECTION");
  assert.equal(
    el("#metrics-details").querySelectorAll(".analytics-card").length,
    4,
  );
  assert.equal(el("#metrics-details").querySelectorAll("progress").length, 2);
  for (const [id, label] of [
    ["overview", "Overview"],
    ["products", "Products"],
    ["releases", "Releases"],
    ["licenses", "Licenses"],
    ["setup", "Client setup"],
    ["keys", "API keys"],
    ["billing", "Billing"],
  ]) {
    await click(label!);
    assert.equal(
      nav.querySelector('[aria-current="page"]')?.textContent,
      label,
    );
    const panel = el<HTMLElement>(`#seller-panel-${id}`);
    assert.equal(panel.hidden, false);
    assert.equal(panel.getAttribute("aria-labelledby"), `seller-nav-${id}`);
    assert.equal(
      dom.document.querySelectorAll(".seller-view:not([hidden])").length,
      1,
    );
  }
  for (const id of ["product-create", "release-upload", "key-create"])
    assert.equal(
      el<HTMLDetailsElement>(
        id === "product-create"
          ? "#product-create-disclosure"
          : `#${id}-disclosure`,
      ).open,
      false,
    );
});

test("navigation retains draft fields, refresh keeps context and workspace/session changes reset it", async () => {
  await mount("/seller", () => {
    tenants = [
      tenant,
      { ...tenant, id: "tenant-b", slug: "beta", name: "Beta apps" },
    ];
  });
  await click("Products");
  await input("#product-name", "Draft application");
  await click("Releases");
  await click("Products");
  assert.equal(
    el<HTMLInputElement>("#product-name").value,
    "Draft application",
  );
  await click("Refresh dashboard");
  assert.equal(el<HTMLElement>("#seller-panel-products").hidden, false);
  await input("#tenant-select", "beta", "change");
  assert.equal(el<HTMLElement>("#seller-panel-overview").hidden, false);
  await click("API keys");
  await click("Sign out");
  assert.equal(
    dom.document.querySelector('nav[aria-label="Workspace navigation"]'),
    null,
  );
});

test("pending seller mutations keep section navigation disabled until completion", async () => {
  let finish!: (response: Response) => void;
  await mount("/seller", () => {
    routes.set(
      "POST /api/v1/tenants/alpha/seller/products",
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
  });
  await click("Products");
  await submit("#product-create");
  assert.equal(el<HTMLButtonElement>("#seller-nav-keys").disabled, true);
  assert.equal(el<HTMLSelectElement>("#tenant-select").disabled, true);
  await click("API keys");
  assert.equal(el<HTMLElement>("#seller-panel-products").hidden, false);
  finish(Response.json({ ok: true }));
  await flush();
  assert.equal(el<HTMLButtonElement>("#seller-nav-keys").disabled, false);
  assert.equal(el<HTMLSelectElement>("#tenant-select").disabled, false);
  await click("API keys");
  assert.equal(el<HTMLElement>("#seller-panel-keys").hidden, false);
});

test("admin storage allowances use readable units without changing exact detailed metrics", async () => {
  for (const [size, label] of [
    [100, "100 B"],
    [1024, "1 KiB"],
    [1048576, "1 MiB"],
    [1073741824, "1 GiB"],
  ] as const) {
    await mount("/seller", () => {
      getOverview = () => ({
        ...overview(),
        tenant: { ...tenant, max_storage_bytes: size },
      });
    });
    await click("Billing");
    assert.match(
      el("#seller-panel-billing").textContent!,
      new RegExp(`Storage allowance${label}`),
    );
    await click("Overview");
    assert.match(el("#metrics-details").textContent!, /Storage allowance1 GiB/);
  }
});

test("first-time sellers can create a workspace directly in the onboarding card", async () => {
  await mount("/seller", () => {
    tenants = [];
  });
  const setup = el(".seller-content .seller-panel");
  assert.ok(setup.querySelector("#tenant-create"));
  assert.equal(setup.querySelector("details"), null);
  assert.equal(dom.document.querySelector(".seller-sidebar"), null);
  assert.equal(el("main h1").textContent, "Your software business");
  assert.match(
    el(".seller-content").textContent!,
    /Create your publisher workspace/,
  );
  assert.equal(dom.document.querySelector("#tenant-select"), null);
  assert.equal(dom.document.querySelector(".seller-nav"), null);
});

test("workspace slugs follow the name until edited and normalize manual input", async () => {
  await mount("/seller", () => {
    tenants = [];
  });
  await input("#tenant-name", "Validated Field");
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "validated-field");
  await input("#tenant-name", "Café & Field 2");
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "cafe-field-2");
  await input("#tenant-slug", "Custom Slug_42!/@");
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "custom-slug-42");
  await input("#tenant-name", "Renamed workspace");
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "custom-slug-42");
  await input("#tenant-slug", "");
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "");
  await input("#tenant-name", "Another name");
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "");
  await input("#tenant-slug", "custom-");
  el("#tenant-slug").dispatchEvent(new dom.Event("blur") as unknown as Event);
  await flush();
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "custom");
  Object.defineProperty(el("#tenant-slug"), "selectionStart", {
    configurable: true,
    value: null,
  });
  await input("#tenant-slug", "Another Workspace");
  assert.equal(el<HTMLInputElement>("#tenant-slug").value, "another-workspace");
});

test("new publisher workspace disclosure survives dashboard refresh and can be closed", async () => {
  await mount();
  const disclosure = el<HTMLDetailsElement>("#workspace-create-disclosure");
  disclosure.open = true;
  disclosure.dispatchEvent(new dom.Event("toggle") as unknown as Event);
  await input("#tenant-name", "Another publisher");
  await click("Refresh dashboard");
  assert.equal(
    el<HTMLDetailsElement>("#workspace-create-disclosure").open,
    true,
  );
  assert.equal(el<HTMLInputElement>("#tenant-name").value, "Another publisher");
  disclosure.open = false;
  disclosure.dispatchEvent(new dom.Event("toggle") as unknown as Event);
  await flush();
  assert.equal(
    el<HTMLDetailsElement>("#workspace-create-disclosure").open,
    false,
  );
  assert.equal(el(".seller-help-link").getAttribute("href"), "/docs#concepts");
});

test("seller request errors can be dismissed without another request", async () => {
  await mount("/seller", () =>
    routes.set("GET /api/v1/tenants/alpha/seller/prices", () =>
      denied(503, "Price service is temporarily unavailable."),
    ),
  );
  assert.ok(dom.document.querySelector('[role="alert"]'));
  const before = calls.length;
  await click("Dismiss");
  assert.equal(dom.document.querySelector('[role="alert"]'), null);
  assert.equal(calls.length, before);
});

test("explicit Stripe action errors explain recovery without retrying the connection", async () => {
  await mount("/seller", () => {
    routes.set("POST /api/v1/tenants/alpha/seller/stripe/connect", () =>
      Response.json(
        {
          error: {
            code: "stripe_not_connected",
            message: "Connect a Stripe account first.",
            requestId: "stripe-reference",
          },
        },
        { status: 409 },
      ),
    );
  });
  await click("Connect Stripe");
  const alert = el('[role="alert"]');
  assert.match(alert.textContent!, /Stripe connection needed/);
  assert.match(alert.textContent!, /complimentary licenses/);
  assert.match(
    alert.querySelector("details")!.textContent!,
    /stripe-reference/,
  );
  await click("Open Billing");
  assert.equal(el("main h1").textContent, "Billing");
  assert.equal(el<HTMLElement>("#seller-panel-billing").hidden, false);
  assert.equal(
    calls.filter((call) => call.path.endsWith("/stripe/connect")).length,
    1,
  );
});

test("refresh headings describe loading then return to the retained section", async () => {
  await mount();
  await click("Products");
  let finish!: (response: Response) => void;
  routes.set(
    "GET /api/v1/tenants/alpha/seller/overview",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  button("Refresh dashboard").click();
  await flush();
  assert.equal(el("main h1").textContent, "Your software business");
  finish(Response.json(overview()));
  await flush();
  assert.equal(el("main h1").textContent, "Products");
});

test("source-available licensing is visible with downloadable source and distinct client terms", async () => {
  await mount("/");
  assert.match(text(), /Public source/);
  assert.ok(dom.document.querySelector('a[href="/docs#licensing"]'));
  await mount("/docs");
  assert.match(el("#licensing").textContent, /Elastic License 2.0/);
  assert.match(el("#licensing").textContent, /Publisher Use Permission/);
  assert.match(el("#licensing").textContent, /MIT/);
  for (const path of [
    "/legal/source.tar.gz",
    "/legal/Elastic-2.0.txt",
    "/legal/ADDITIONAL-PERMISSION.txt",
    "/legal/MIT.txt",
  ])
    assert.ok(dom.document.querySelector(`a[href="${path}"]`));
  await mount("/seller");
  assert.ok(dom.document.querySelector('a[href="/docs#licensing"]'));
});

test("seller dashboard safely handles a server with no fee metadata", async () => {
  await mount("/seller", () =>
    routes.set("GET /api/v1/platform/info", () =>
      Response.json({
        maxUploadBytes: 26214400,
        databaseEngines: ["SQLite"],
      }),
    ),
  );
  assert.match(text(), /0% application fee/);
});

test("new seller panels load only on navigation and use the existing confirmation dialog", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/commerce/settings", () =>
      Response.json({
        settings: {
          automaticTax: false,
          collectTaxId: false,
          collectBillingAddress: false,
        },
      }),
    );
    routes.set("GET /api/v1/tenants/alpha/seller/features", () =>
      Response.json({
        features: { outboundWebhooks: true },
        hostedProConfigured: true,
      }),
    );
    routes.set("GET /api/v1/tenants/alpha/seller/webhooks", () =>
      Response.json({
        endpoints: [
          {
            id: "hook",
            url: "https://example.test/hook",
            events: ["license.created"],
            active: true,
          },
        ],
        deliveries: [],
      }),
    );
  });
  assert.equal(
    calls.some((c) =>
      /commerce|features|webhooks|operations|sandbox|account\/sessions/.test(
        c.path,
      ),
    ),
    false,
  );
  await click("Tax settings");
  assert.ok(dom.document.querySelector("#tax-settings"));
  await click("Webhooks");
  await click("Disable webhook");
  assert.equal(el<HTMLDialogElement>("dialog").open, true);
  await click("Cancel");
  assert.equal(
    calls.some((c) => c.init.method === "DELETE"),
    false,
  );
  await click("Disable webhook");
  await click("Confirm action");
  assert.equal(
    calls.find((c) => c.init.method === "DELETE")?.path,
    "/api/v1/tenants/alpha/seller/webhooks/hook",
  );
});
test("API key email proof is purpose-specific, consumed once, and sent as an action header", async () => {
  await mount();
  await click("API keys");
  await click("Email API key verification");
  assert.deepEqual(calls.at(-1)?.body, { purpose: "api_keys" });
  await input("#key-verification-token", "email-proof");
  await input("#key-name", "Verified key");
  routes.set("POST /api/v1/tenants/alpha/seller/keys", () =>
    Response.json({ token: "one-time" }),
  );
  await submit("#key-create");
  const proof = calls.find((c) => c.path.endsWith("/verification/consume"))!;
  assert.deepEqual(proof.body, { purpose: "api_keys", token: "email-proof" });
  const action = calls.find(
    (c) => c.path.endsWith("/keys") && c.init.method === "POST",
  )!;
  assert.equal(
    new Headers(action.init.headers).get("x-account-verification"),
    "verified-grant",
  );
  assert.equal(el<HTMLInputElement>("#key-verification-token").value, "");
});
test("verification fragments are removed and require an explicit action purpose", async () => {
  await mount("/seller#account-verification=api-proof");
  assert.equal(dom.location.hash, "");
  await click("Continue with verification link");
  assert.equal(
    Boolean(dom.document.querySelector('[aria-label="Verification purpose"]')),
    false,
  );
  assert.doesNotMatch(text(), /Choose the action you requested below/);
  assert.equal(
    el<HTMLInputElement>("#key-verification-token").value,
    "api-proof",
  );
  for (const purpose of ["recovery_codes", "tenant_transfer"]) {
    routes.set("GET /api/v1/platform/account/sessions", () =>
      Response.json({ sessions: [] }),
    );
    routes.set("POST /api/v1/platform/account/recovery-codes", () =>
      Response.json({ codes: ["offline"] }),
    );
    routes.set("POST /api/v1/tenants/alpha/seller/exports", () =>
      Response.json({ id: "e", expiresAt: 4102444800000, blobs: [] }),
    );
    routes.set("GET /api/v1/tenants/alpha/seller/exports", () =>
      Response.json({
        exports: [
          {
            id: "existing",
            status: "ready",
            expiresAt: 4102444800000,
            blobs: [],
          },
        ],
      }),
    );
    dom.location.hash = "#account-verification=another-proof";
    dom.dispatchEvent(new dom.Event("hashchange"));
    await flush();
    await click(purpose === "recovery_codes" ? "Account security" : "Export");
    assert.equal(el<HTMLInputElement>("#verification-token").value, "");
    await input('[aria-label="Verification purpose"]', purpose, "change");
    await click("Continue with verification link");
    assert.equal(
      Boolean(
        dom.document.querySelector('[aria-label="Verification purpose"]'),
      ),
      false,
    );
    assert.doesNotMatch(text(), /Choose the action you requested below/);
    assert.equal(
      el<HTMLInputElement>("#verification-token").value,
      "another-proof",
    );
    assert.equal(
      el<HTMLDetailsElement>(
        purpose === "recovery_codes" ? "#security-recovery" : "#export-create",
      ).open,
      true,
    );
    if (purpose === "recovery_codes") {
      await submit("#recovery-codes");
      assert.match(text(), /offline/);
    } else {
      await input("#passphrase", "long enough passphrase");
      await submit("#tenant-export");
      assert.match(text(), /Download manifest.entitle/);
    }
    assert.equal(
      dom.document.querySelector('[aria-label="Verification purpose"]'),
      null,
    );
  }
  dom.location.hash = "#account-email-change=request&token=mail-proof";
  dom.dispatchEvent(new dom.Event("hashchange"));
  await flush();
  assert.equal(dom.location.hash, "");
  assert.match(text(), /Account security/);
});
for (const firstMailbox of ["current", "new"] as const) {
  test(`email change retains ${firstMailbox}-mailbox-first links across navigation and reload until explicit confirmation`, async () => {
    const id = "7adbbbd2-7638-4a9b-863a-5460cf9293e4";
    const proofs = {
      current: "current-mailbox-secret",
      new: "new-mailbox-secret",
    };
    const otherMailbox = firstMailbox === "current" ? "new" : "current";
    const link = (mailbox: "current" | "new") =>
      `/seller?tenant=alpha#account-email-change=${id}&token=${proofs[mailbox]}`;
    await mount(link(firstMailbox));
    assert.equal(dom.location.hash, "");
    assert.equal(dom.location.search, "?tenant=alpha");
    assert.equal(el<HTMLInputElement>("#changeId").value, id);
    assert.equal(el<HTMLDetailsElement>("#security-email").open, true);
    assert.equal(el<HTMLInputElement>("#currentToken").value, "");
    assert.equal(el<HTMLInputElement>("#newToken").value, "");
    assert.equal(
      calls.some((call) => call.init.method === "POST"),
      false,
    );
    assert.ok(calls.every((call) => !call.path.includes(proofs[firstMailbox])));
    await click(`Use link from ${firstMailbox} mailbox`);
    assert.equal(
      el<HTMLInputElement>(`#${firstMailbox}Token`).value,
      proofs[firstMailbox],
    );
    assert.equal(
      el<HTMLInputElement>(`#${firstMailbox}Token`).type,
      "password",
    );
    assert.doesNotMatch(text(), /current-mailbox-secret|new-mailbox-secret/);
    await click("API keys");
    await click("Account security");
    assert.equal(
      el<HTMLInputElement>(`#${firstMailbox}Token`).value,
      proofs[firstMailbox],
    );

    // A second email link can reload the app in the same signed-in tab.
    await mount(link(otherMailbox));
    assert.equal(dom.location.hash, "");
    assert.equal(
      el<HTMLInputElement>(`#${firstMailbox}Token`).value,
      proofs[firstMailbox],
    );
    await click(`Use link from ${otherMailbox} mailbox`);
    assert.equal(el<HTMLInputElement>("#currentToken").value, proofs.current);
    assert.equal(el<HTMLInputElement>("#newToken").value, proofs.new);
    assert.equal(
      calls.some((call) => call.init.method === "POST"),
      false,
    );
    routes.set("POST /api/v1/platform/account/email-change/confirm", (call) => {
      assert.equal(dom.location.hash, "");
      assert.deepEqual(call.body, {
        id,
        currentToken: proofs.current,
        newToken: proofs.new,
      });
      assert.equal(
        new Headers(call.init.headers).get("X-CSRF-Token"),
        "seller-csrf",
      );
      signed = false;
      return Response.json({ ok: true, signInRequired: true });
    });
    await submit("#email-change-confirm");
    assert.equal(
      calls.filter((call) => call.path.endsWith("/email-change/confirm"))
        .length,
      1,
    );
    assert.match(text(), /Sign in to sell/);
    assert.equal(dom.sessionStorage.length, 0);
  });
}
for (const firstMailbox of ["current", "new"] as const) {
  test(`email change binds mailbox selection to the latest link after opening ${firstMailbox} first without assigning it`, async () => {
    const proofs = { current: "current-proof", new: "new-proof" };
    const secondMailbox = firstMailbox === "current" ? "new" : "current";
    const link = (mailbox: "current" | "new") =>
      `/seller#account-email-change=request-id&token=${proofs[mailbox]}`;
    await mount(link(firstMailbox));
    await mount(link(secondMailbox));
    assert.equal(dom.location.hash, "");
    await click(`Use link from ${secondMailbox} mailbox`);
    assert.equal(
      el<HTMLInputElement>(`#${secondMailbox}Token`).value,
      proofs[secondMailbox],
    );
    assert.equal(dom.document.querySelector("#email-change-link"), null);
    dom.location.hash = link(firstMailbox).split("#")[1]!;
    dom.dispatchEvent(new dom.Event("hashchange"));
    await flush();
    await click(`Use link from ${firstMailbox} mailbox`);
    routes.set("POST /api/v1/platform/account/email-change/confirm", (call) => {
      assert.deepEqual(call.body, {
        id: "request-id",
        currentToken: proofs.current,
        newToken: proofs.new,
      });
      signed = false;
      return Response.json({ ok: true, signInRequired: true });
    });
    await submit("#email-change-confirm");
    assert.equal(
      calls.filter((call) => call.path.endsWith("/email-change/confirm"))
        .length,
      1,
    );
    assert.match(text(), /Sign in to sell/);
  });
}
test("email change rejects malformed fragments without leaking or replacing a retained mailbox proof", async () => {
  await mount("/seller#account-email-change=request-id&token=current-proof");
  await click("Use link from current mailbox");
  for (const fragment of [
    "account-email-change=request-id",
    "account-email-change=&token=secret",
    "account-email-change=request-id&token=",
    "account-email-change=request-id&token=one&token=two",
    "account-email-change=one&account-email-change=two&token=secret",
    `account-email-change=request-id&token=${"x".repeat(201)}`,
    "account-email-change=request-id&token=%3Cscript%3E",
  ]) {
    dom.location.hash = `#${fragment}`;
    dom.dispatchEvent(new dom.Event("hashchange"));
    await flush();
    assert.equal(dom.location.hash, "");
    assert.match(text(), /email.change link.*invalid/i);
    assert.equal(el<HTMLInputElement>("#currentToken").value, "current-proof");
    assert.equal(el<HTMLInputElement>("#newToken").value, "");
    assert.doesNotMatch(text(), /current-proof|<script>/);
  }
  await submit("#email-change-confirm");
  assert.equal(
    calls.some((call) => call.path.endsWith("/email-change/confirm")),
    false,
  );
});
test("email change deduplicates links and resets proofs for a different request", async () => {
  await mount("/seller#account-email-change=first-request&token=current-proof");
  await click("Use link from current mailbox");
  dom.location.hash = "#account-email-change=first-request&token=current-proof";
  dom.dispatchEvent(new dom.Event("hashchange"));
  await flush();
  assert.equal(dom.document.querySelector("#email-change-link"), null);
  assert.equal(el<HTMLInputElement>("#newToken").value, "");
  dom.location.hash =
    "#account-email-change=second-request&token=new-request-proof";
  dom.dispatchEvent(new dom.Event("hashchange"));
  await flush();
  assert.equal(el<HTMLInputElement>("#changeId").value, "second-request");
  assert.equal(el<HTMLInputElement>("#currentToken").value, "");
  assert.equal(el<HTMLInputElement>("#newToken").value, "");
  await click("Use link from new mailbox");
  await click("Sign out");
  assert.equal(dom.sessionStorage.length, 0);
});
test("email change remains usable when session storage cannot save proofs", async () => {
  const storage = dom.sessionStorage;
  const descriptor = Object.getOwnPropertyDescriptor(dom, "sessionStorage");
  Object.defineProperty(dom, "sessionStorage", {
    configurable: true,
    value: {
      getItem: storage.getItem.bind(storage),
      removeItem: storage.removeItem.bind(storage),
      setItem: () => {
        throw Error("Storage disabled");
      },
    },
  });
  try {
    await mount("/seller#account-email-change=request-id&token=current-proof");
    await click("Account security");
    await click("Use link from current mailbox");
    assert.equal(el<HTMLInputElement>("#changeId").value, "request-id");
    assert.equal(el<HTMLInputElement>("#currentToken").value, "current-proof");
  } finally {
    if (descriptor) Object.defineProperty(dom, "sessionStorage", descriptor);
    else Reflect.deleteProperty(dom, "sessionStorage");
  }
});

test("complimentary issuance rejects fractional seats and past expiration before confirmation", async () => {
  await mount("/seller");
  await click("Licenses");
  await input("#complimentary-email", "pilot@example.test");
  for (const [allowance, expiry] of [
    ["1.5", "2030-06-01T12:00"],
    ["100001", "2030-06-01T12:00"],
    ["1", "2020-01-01T12:00"],
  ]) {
    await input("#complimentary-allowance", allowance!);
    await input("#complimentary-expiry", expiry!);
    await submit("#complimentary-issue");
    assert.match(
      text(),
      /Choose an installation allowance from 1 to 100000 and a future expiration date/,
    );
    assert.ok(
      !calls.some((call) => call.path.endsWith("/licenses/complimentary")),
    );
  }
});

test("email change restores only unexpired proofs belonging to the current seller", async () => {
  const draft = {
    id: "request-id",
    currentToken: "current-proof",
    newToken: "",
    pendingTokens: [],
  };
  for (const stored of [
    "not-json",
    JSON.stringify({
      sellerId: "seller",
      expiresAt: Date.now() + 900000,
      draft: null,
    }),
    JSON.stringify({
      sellerId: "seller",
      expiresAt: Date.now() + 900000,
      draft: "invalid",
    }),
    JSON.stringify({ sellerId: "seller", expiresAt: Date.now() - 1, draft }),
    JSON.stringify({
      sellerId: "another-seller",
      expiresAt: Date.now() + 900000,
      draft,
    }),
    JSON.stringify({
      sellerId: "seller",
      expiresAt: Date.now() + 900000,
      draft: { ...draft, pendingTokens: ["<bad>"] },
    }),
  ]) {
    dom.sessionStorage.setItem("entitle:email-change", stored);
    await mount("/seller");
    await click("Account security");
    assert.equal(el<HTMLInputElement>("#changeId").value, "");
    assert.equal(el<HTMLInputElement>("#currentToken").value, "");
    assert.equal(dom.sessionStorage.length, 0);
  }
});

test("queued seller-session retries retain this seller's proofs and clear them after an identity change", async () => {
  await mount(
    "/seller#account-email-change=request-id&token=current-proof",
    () => {
      routes.set("GET /api/v1/platform/me", () =>
        denied(503, "Session unavailable"),
      );
    },
  );
  const retry = button("Retry session");
  let sellerId = "seller";
  routes.set("GET /api/v1/platform/me", () =>
    Response.json({
      user: { id: sellerId, email: `${sellerId}@example.test` },
      csrfToken: "csrf",
      tenants,
    }),
  );
  const retrySession = async () => {
    retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }));
    await flush();
  };
  await retrySession();
  assert.equal(el<HTMLInputElement>("#changeId").value, "request-id");
  await retrySession();
  assert.equal(el<HTMLInputElement>("#changeId").value, "request-id");
  sellerId = "another-seller";
  await retrySession();
  assert.match(text(), /another-seller@example.test/);
  assert.equal(dom.sessionStorage.length, 0);
  await click("Account security");
  assert.equal(el<HTMLInputElement>("#changeId").value, "");
});
test("security survives restricted workspace access and revoking the current session clears the seller", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/overview", () =>
      denied(403, "Restricted"),
    );
    routes.set("GET /api/v1/platform/account/sessions", () =>
      Response.json({
        sessions: [{ id: "current", current: true, expiresAt: 4102444800000 }],
      }),
    );
  });
  await click("Account security");
  assert.equal(el(".feature-panel h2").textContent, "Account security");
  assert.equal(
    el("#seller-panel-security").getAttribute("aria-label"),
    "Account security",
  );
  await click("Revoke session");
  signed = false;
  await click("Confirm action");
  assert.match(text(), /Sign in to sell/);
});
test("global security works before the first workspace and panel session expiry clears identity", async () => {
  await mount("/seller", () => {
    tenants = [];
    routes.set("GET /api/v1/platform/account/sessions", () =>
      Response.json({ sessions: [] }),
    );
  });
  await click("Account security");
  assert.equal(el(".feature-panel h2").textContent, "Account security");
  assert.equal(
    el("#seller-panel-security").getAttribute("aria-label"),
    "Account security",
  );
  assert.ok(dom.document.querySelector("#recovery-codes"));
  await mount("/seller", () => {
    routes.set("GET /api/v1/tenants/alpha/seller/sandbox", () => denied());
  });
  await click("Sandbox");
  assert.match(text(), /Sign in to sell/);
  assert.doesNotMatch(text(), /buyer@example.test/);
});
test("signed-out recovery binds a browser and reloads the seller session", async () => {
  await mount("/seller", () => {
    signed = false;
    routes.set("POST /api/v1/platform/account/recovery/consume", () => {
      signed = true;
      return Response.json({ ok: true });
    });
  });
  const details = el<HTMLDetailsElement>(".account-recovery");
  details.open = true;
  details.dispatchEvent(new dom.Event("toggle") as unknown as Event);
  await flush();
  await input("#recovery-email", "seller@example.test");
  await input("#recovery-code", "offline-code");
  await submit("#account-recovery");
  assert.match(text(), /Alpha plugins/);
});
test("release publication requests its own proof and includes both new API-key scopes", async () => {
  await mount();
  await click("Releases");
  await click("Email release verification");
  assert.deepEqual(calls.at(-1)?.body, { purpose: "release_publish" });
  dom.location.hash = "#account-verification=publication-proof";
  dom.dispatchEvent(new dom.Event("hashchange"));
  await flush();
  await input(
    '[aria-label="Verification purpose"]',
    "release_publish",
    "change",
  );
  await click("Continue with verification link");
  assert.doesNotMatch(text(), /Choose the action you requested below/);
  assert.equal(
    el<HTMLInputElement>("#release-verification-token").value,
    "publication-proof",
  );
  const scopes = [
    ...dom.document.querySelectorAll('#key-create input[type="checkbox"]'),
  ].map((n) => (n as unknown as HTMLInputElement).value);
  assert.equal(scopes.length, 7);
  assert.ok(scopes.includes("operations:write"));
  assert.ok(scopes.includes("data:export"));
  dom.location.hash = "#account-verification=";
  dom.dispatchEvent(new dom.Event("hashchange"));
  await flush();
  assert.equal(dom.location.hash, "");
});
test("failed publication verification clears its token and never sends release bytes", async () => {
  await mount("/seller", () =>
    routes.set("POST /api/v1/platform/account/verification/consume", () =>
      denied(403, "A fresh publication verification is required."),
    ),
  );
  await input("#release-verification-token", "wrong-proof");
  await input("#release-version", "9.0.0");
  const file = el<HTMLInputElement>("#release-file");
  Object.defineProperty(file, "files", {
    configurable: true,
    value: [new dom.File(["PKfixture"], "plugin.zip")],
  });
  file.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await submit("#release-upload");
  assert.match(text(), /fresh publication verification/);
  assert.equal(
    calls.some((c) => c.path.endsWith("/seller/releases/plugin/9.0.0")),
    false,
  );
  assert.equal(el<HTMLInputElement>("#release-verification-token").value, "");
});
test("server-confirmed sandbox identity stays visible across seller pages without extra dashboard requests", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      sandbox: {
        isSandbox: true,
        parentSlug: "publisher",
        sandboxSlug: "alpha",
        mode: "fixture",
      },
    });
  });
  assert.match(text(), /TEST WORKSPACE/);
  assert.match(text(), /http:\/\/localhost:3211\/api\/v1\/tenants\/alpha/);
  await click("Products");
  assert.match(text(), /TEST WORKSPACE/);
  assert.equal(
    calls.some((c) => c.path.endsWith("/seller/sandbox")),
    false,
  );
});

test("docs explain core account protection, sandbox testing, hosted Pro and separate native upload limits", async () => {
  await mount("/docs", () =>
    routes.set("GET /api/v1/platform/info", () =>
      Response.json({
        maxUploadBytes: 26214400,
        maxNativeUploadBytes: 38797312,
        databaseEngines: ["SQLite"],
      }),
    ),
  );
  assert.match(
    el("#operating-your-business").textContent,
    /offline recovery codes/i,
  );
  assert.match(el("#operating-your-business").textContent, /sandbox/i);
  assert.match(el("#hosted-tiers").textContent, /Hosted Pro/);
  assert.match(el("#hosted-tiers").textContent, /paid download rights/);
  assert.match(el("#server-limits").textContent, /37 MiB/);
  assert.match(el("#server-limits").textContent, /WordPress/);
  assert.match(
    el("#concepts").textContent!,
    /one Doublesharp workspace can contain Remote Content Shortcode and Validated Field/,
  );
  assert.match(el("#dashboard-reports").textContent!, /Clear filters restores/);
  assert.match(
    el("#dashboard-reports").textContent!,
    /successful sends appear under Completed/,
  );
  assert.match(el("#dashboard-reports").textContent!, /UTC calendar days/);
  assert.match(
    el("#dashboard-reports").textContent!,
    /Hosted Pro and self-hosted/,
  );
  assert.equal(
    el('a[href="#dashboard-reports"]').textContent,
    "Dashboard and reports",
  );
});

test("a terminal historical platform subscription offers fresh Pro checkout while active billing stays in Portal", async () => {
  for (const status of [
    "canceled",
    "incomplete_expired",
    "active",
    "past_due",
  ]) {
    await mount("/seller", () => {
      getOverview = () => ({
        ...overview(),
        tenant: {
          ...tenant,
          platform_subscription_id: "sub_historical",
          billing_status: status,
        },
      });
      routes.set("GET /api/v1/tenants/alpha/seller/features", () =>
        Response.json({
          features: { outboundWebhooks: false },
          hostedProConfigured: true,
        }),
      );
      routes.set("POST /api/v1/tenants/alpha/seller/platform/checkout", () =>
        Response.json({ url: "https://checkout.example.test/pro" }),
      );
      routes.set("POST /api/v1/tenants/alpha/seller/platform/portal", () =>
        Response.json({ url: "https://billing.example.test/current" }),
      );
    });
    await click("Webhooks");
    if (["canceled", "incomplete_expired"].includes(status)) {
      await click("Choose Pro");
      assert.deepEqual(calls.at(-1)?.body, { tier: "pro" });
      assert.equal(redirects.at(-1), "https://checkout.example.test/pro");
    } else {
      assert.ok(
        ![...dom.document.querySelectorAll("button")].some(
          (b) => b.textContent === "Choose Pro",
        ),
      );
      await click("Manage current subscription");
      assert.equal(
        calls.at(-1)?.path,
        "/api/v1/tenants/alpha/seller/platform/portal",
      );
    }
  }
});

test("workspace navigation groups new tools and offers a compact mobile page selector", async () => {
  await mount("/seller", () =>
    routes.set("GET /api/v1/platform/account/sessions", () =>
      Response.json({ sessions: [] }),
    ),
  );
  assert.deepEqual(
    [...dom.document.querySelectorAll(".seller-nav-group > p")].map(
      (n) => n.textContent,
    ),
    ["Products & sales", "Integrations", "Administration"],
  );
  const mobile = el<HTMLSelectElement>("#seller-mobile-page");
  assert.equal(mobile.value, "overview");
  mobile.value = "security";
  mobile.dispatchEvent(
    new dom.Event("change", { bubbles: true }) as unknown as Event,
  );
  await flush();
  assert.equal(el("h1").textContent, "Account security");
  assert.equal(mobile.value, "security");
  assert.equal(
    Boolean(dom.document.querySelector(".feature-panel > h2")),
    false,
  );
});

test("billing groups payment setup and allowances and avoids duplicate subscriptions", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      tenant: {
        ...tenant,
        platform_subscription_id: "sub_existing",
        billing_status: "active",
      },
    });
  });
  await click("Billing");
  assert.equal(
    el(".billing-layout").querySelectorAll(".feature-card").length,
    2,
  );
  assert.match(el(".billing-allowances").textContent!, /Products1 of 20/);
  assert.equal(
    Boolean(dom.document.querySelector(".billing-plan-details[open]")),
    false,
  );
  assert.equal(
    [...dom.document.querySelectorAll("#seller-panel-billing button")].some(
      (button) => button.textContent === "Subscribe to Doublesharp Entitle",
    ),
    false,
  );
});

test("standalone billing never presents platform and trial placeholders as badges", async () => {
  await mount("/seller", () => {
    routes.set("GET /api/v1/platform/info", () =>
      Response.json({ deploymentMode: "standalone", applicationFeePercent: 0 }),
    );
    getOverview = () => ({
      ...overview(),
      tenant: {
        ...tenant,
        exempt: 1,
        stripe_status: "platform",
        billing_status: "trial",
      },
    });
  });
  await click("Billing");
  assert.equal(
    dom.document.querySelectorAll("#seller-panel-billing .feature-badge")
      .length,
    0,
  );
});

test("hosted billing uses readable payment and subscription statuses and places fees on customer payments", async () => {
  for (const [status, label] of [
    ["connected", "Connected"],
    ["restricted", "Action needed"],
    ["unconnected", "Not connected"],
    ["disconnected", "Disconnected"],
    ["platform", "Platform account"],
    ["future_status", "future status"],
  ] as const) {
    await mount("/seller", () => {
      getOverview = () => ({
        ...overview(),
        tenant: {
          ...tenant,
          stripe_status: status,
          billing_status: "future_status",
        },
      });
    });
    assert.equal(
      el("#seller-panel-billing .feature-card:first-child .feature-badge")
        .textContent,
      label,
    );
    assert.match(
      el("#seller-panel-billing .feature-card:first-child").textContent!,
      /application fee on new customer subscriptions and their renewals/,
    );
    assert.doesNotMatch(
      el("#seller-panel-billing .feature-card:last-child").textContent!,
      /application fee/,
    );
  }
});

test("verification form tokens stay with their chosen action and clear on new links and workspace changes", async () => {
  await mount("/seller#account-verification=security-only", () => {
    tenants = [
      tenant,
      { ...tenant, id: "tenant-b", slug: "beta", name: "Beta" },
    ];
    routes.set("GET /api/v1/platform/account/sessions", () =>
      Response.json({ sessions: [] }),
    );
  });
  await input(
    '[aria-label="Verification purpose"]',
    "recovery_codes",
    "change",
  );
  await click("Continue with verification link");
  assert.equal(
    el<HTMLInputElement>("#verification-token").value,
    "security-only",
  );
  await click("Export");
  assert.equal(el<HTMLInputElement>("#verification-token").value, "");
  dom.location.hash = "#account-verification=export-only";
  dom.dispatchEvent(new dom.Event("hashchange"));
  await flush();
  await input(
    '[aria-label="Verification purpose"]',
    "tenant_transfer",
    "change",
  );
  await click("Continue with verification link");
  assert.equal(
    el<HTMLInputElement>("#verification-token").value,
    "export-only",
  );
  await click("Account security");
  assert.equal(el<HTMLInputElement>("#verification-token").value, "");
  await click("Export");
  assert.equal(
    el<HTMLInputElement>("#verification-token").value,
    "export-only",
  );
  await input("#tenant-select", "beta", "change");
  await click("Export");
  assert.equal(el<HTMLInputElement>("#verification-token").value, "");
  assert.equal(
    Boolean(dom.document.querySelector('[aria-label="Verification purpose"]')),
    false,
  );
});

test("verification requests preserve other purposes and invalidate a same-purpose handoff after navigation", async () => {
  await mount("/seller#account-verification=export-proof", () => {
    routes.set("GET /api/v1/platform/account/sessions", () =>
      Response.json({ sessions: [] }),
    );
  });
  await input(
    '[aria-label="Verification purpose"]',
    "tenant_transfer",
    "change",
  );
  await click("Continue with verification link");
  await click("Account security");
  await click("Send verification link");
  await click("Export");
  assert.equal(
    el<HTMLInputElement>("#verification-token").value,
    "export-proof",
  );
  let resolve!: (value: Response) => void;
  routes.set(
    "POST /api/v1/platform/account/verification/request",
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  await click("Send verification link");
  await click("Account security");
  resolve(Response.json({ ok: true }));
  await flush();
  await click("Export");
  assert.equal(el<HTMLInputElement>("#verification-token").value, "");
});
test("a late resend response cannot clear a newer proof from another link", async () => {
  let resolve!: (value: Response) => void;
  await mount("/seller#account-verification=old-proof", () => {
    routes.set(
      "POST /api/v1/platform/account/verification/request",
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
  });
  await input(
    '[aria-label="Verification purpose"]',
    "tenant_transfer",
    "change",
  );
  await click("Continue with verification link");
  await click("Send verification link");
  dom.location.hash = "#account-verification=new-proof";
  dom.dispatchEvent(new dom.Event("hashchange"));
  await flush();
  await input(
    '[aria-label="Verification purpose"]',
    "tenant_transfer",
    "change",
  );
  await click("Continue with verification link");
  resolve(Response.json({ ok: true }));
  await flush();
  await click("Billing");
  await click("Export");
  assert.equal(el<HTMLInputElement>("#verification-token").value, "new-proof");
});

test("a resend completed after its form unmounts clears that exact stale handoff", async () => {
  let resolve!: (value: Response) => void;
  await mount("/seller#account-verification=stale-export-proof", () => {
    routes.set("GET /api/v1/platform/account/sessions", () =>
      Response.json({ sessions: [] }),
    );
    routes.set(
      "POST /api/v1/platform/account/verification/request",
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
  });
  await input(
    '[aria-label="Verification purpose"]',
    "tenant_transfer",
    "change",
  );
  await click("Continue with verification link");
  await click("Send verification link");
  await click("Account security");
  resolve(Response.json({ ok: true }));
  await flush();
  await click("Export");
  assert.equal(el<HTMLInputElement>("#verification-token").value, "");
});

test("hosted seller routes use the configured application mount and keep API paths unchanged", async () => {
  const meta = dom.document.createElement("meta");
  meta.name = "entitle-app-base";
  meta.content = "/app";
  dom.document.head.append(meta);
  try {
    await mount("/app/seller");
    assert.match(text(), /Your workspace in numbers/);
    assert.ok(dom.document.querySelector('header a[href="/app/"]'));
    assert.ok(dom.document.querySelector('header a[href="/app/docs"]'));
    assert.ok(calls.some((call) => call.path === "/api/v1/platform/me"));
    assert.ok(calls.every((call) => !call.path.startsWith("/app/api/")));
    await mount("/app/docs");
    assert.ok(
      dom.document.querySelector('a[href="/app/legal/THIRD-PARTY.txt"]'),
    );
  } finally {
    meta.remove();
  }
});

test("marketing documentation is static and points account actions to the configured app", async () => {
  await mount("/");
  app?.unmount();
  dom.history.replaceState(null, "", "/docs");
  calls = [];
  const meta = dom.document.createElement("meta");
  meta.name = "entitle-app-url";
  meta.content = "/app/";
  dom.document.head.append(meta);
  try {
    app = marketing.mountPublicSite("#app");
    await flush();
    assert.equal(calls.length, 0);
    assert.match(text(), /Documentation/);
    assert.doesNotMatch(text(), /Loading server limits/);
    assert.ok(dom.document.querySelector('a[href="/app/seller"]'));
    assert.ok(dom.document.querySelector('a[href="/app/docs#server-limits"]'));
    app.unmount();
    meta.content = "https://app.example.test/";
    app = marketing.mountPublicSite("#app");
    await flush();
    assert.ok(dom.document.querySelector('a[href="/legal/THIRD-PARTY.txt"]'));
    assert.match(
      el('pre[aria-label="Shell / WordPress publication"]').textContent ?? "",
      /export PUBLIC_ORIGIN=https:\/\/app.example.test/,
    );
    assert.match(
      el('pre[aria-label="Shell / public health probes"]').textContent ?? "",
      /curl --fail https:\/\/app.example.test\/api\/v1\/ready/,
    );
  } finally {
    meta.remove();
  }
});

test("setup wizard guides an empty workspace to the product form without creating data", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      products: [],
      releases: [],
      licenses: [],
    });
  });
  await click("Start setup");
  assert.equal(el("main h1").textContent, "Getting started");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /0 of 4 steps complete/,
  );
  assert.match(
    el(".setup-step[aria-current='step']").textContent!,
    /Add a product/,
  );
  await click("Add your first product");
  assert.equal(el("main h1").textContent, "Products");
  assert.equal(el<HTMLDetailsElement>("#product-create-disclosure").open, true);
  assert.equal(dom.document.activeElement?.id, "product-name");
  assert.equal(
    calls.some((call) => call.init.method === "POST"),
    false,
  );
  await input("#product-name", "My draft");
  await click("Back to setup");
  await click("Add your first product");
  assert.equal(el<HTMLInputElement>("#product-name").value, "My draft");
});

test("setup step navigation explains prerequisites and supports next, previous and exit", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      products: [],
      releases: [],
      licenses: [],
    });
  });
  await click("Getting started");
  el<HTMLButtonElement>(".setup-steps li:nth-child(2) button").click();
  await flush();
  assert.match(el(".setup-prerequisite").textContent!, /Add a product/);
  assert.equal(button("Publish your first release").disabled, true);
  button("Publish your first release").dispatchEvent(
    new dom.MouseEvent("click", { bubbles: true }),
  );
  await flush();
  assert.equal(el("main h1").textContent, "Getting started");
  await mount();
  await click("Getting started");
  el<HTMLButtonElement>(".setup-steps li:first-child button").click();
  await flush();
  await click("Next step");
  assert.equal(el("#setup-task-title").textContent, "Publish a release");
  await click("Previous step");
  assert.equal(el("#setup-task-title").textContent, "Add a product");
  el<HTMLButtonElement>(".setup-steps li:nth-child(3) button").click();
  await flush();
  await click("Open client setup");
  await click("Exit guided setup");
  assert.equal(dom.document.querySelector(".setup-context"), null);
  assert.equal(el("main h1").textContent, "Client setup");
});

test("queued setup navigation cannot steal focus after the seller chooses another page", async () => {
  await mount();
  button("Continue setup").click();
  button("Products").click();
  await flush();
  assert.equal(el("main h1").textContent, "Products");
  assert.notEqual(
    dom.document.activeElement?.closest("#seller-panel-onboarding")?.id,
    "seller-panel-onboarding",
  );
  await click("Getting started");
  button("Open client setup").click();
  button("Licenses").click();
  await flush();
  assert.equal(el("main h1").textContent, "Licenses");
  assert.notEqual(dom.document.activeElement?.id, "config-product");
  await click("Billing");
  assert.equal(dom.document.querySelector(".setup-context"), null);
});

test("guided setup follows product changes in release and license forms", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      products: [
        ...overview().products,
        {
          ...overview().products[0]!,
          id: "p2",
          slug: "second",
          name: "Second",
        },
      ],
    });
  });
  await click("Getting started");
  el<HTMLButtonElement>(".setup-steps li:nth-child(2) button").click();
  await flush();
  await click("Manage releases");
  await input("#release-product", "p2", "change");
  await click("Back to setup");
  assert.equal(el<HTMLSelectElement>("#setup-product").value, "p2");
  el<HTMLButtonElement>(".setup-steps li:nth-child(4) button").click();
  await flush();
  await click("Issue a complimentary license");
  await input("#complimentary-product", "p1", "change");
  await click("Back to setup");
  assert.equal(el<HTMLSelectElement>("#setup-product").value, "p1");
});

test("setup actions ignore stale clicks while a dashboard refresh is pending", async () => {
  let finish!: (response: Response) => void;
  await mount();
  await click("Getting started");
  const task = button("Open client setup");
  await click("Open client setup");
  const confirm = button("I’ve added the configuration");
  routes.set(
    "GET /api/v1/tenants/alpha/seller/overview",
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  button("Refresh dashboard").click();
  task.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }));
  confirm.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }));
  await flush();
  finish(Response.json(overview()));
  await flush();
  assert.equal(el("main h1").textContent, "Client setup");
  await click("Getting started");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /2 of 4 steps complete/,
  );
});

test("setup confirmation stays usable when browser storage is unavailable", async () => {
  const get = dom.sessionStorage.getItem,
    set = dom.sessionStorage.setItem;
  Object.defineProperty(dom.sessionStorage, "getItem", {
    configurable: true,
    value: () => {
      throw Error("Storage unavailable");
    },
  });
  Object.defineProperty(dom.sessionStorage, "setItem", {
    configurable: true,
    value: () => {
      throw Error("Storage unavailable");
    },
  });
  try {
    await mount();
    await click("Getting started");
    await click("Open client setup");
    await click("I’ve added the configuration");
    assert.match(
      el("#seller-panel-onboarding").textContent!,
      /3 of 4 steps complete/,
    );
  } finally {
    Object.defineProperty(dom.sessionStorage, "getItem", {
      configurable: true,
      value: get,
    });
    Object.defineProperty(dom.sessionStorage, "setItem", {
      configurable: true,
      value: set,
    });
  }
});

test("setup progress uses the chosen product and confirms integration explicitly", async () => {
  await mount("/seller", () => {
    getOverview = () => ({ ...overview(), licenses: [] });
  });
  await click("Getting started");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /2 of 4 steps complete/,
  );
  assert.match(
    el(".setup-step[aria-current='step']").textContent!,
    /Connect your software/,
  );
  await click("Open client setup");
  assert.equal(el("main h1").textContent, "Client setup");
  assert.equal(el<HTMLSelectElement>("#config-product").value, "plugin");
  await click("I’ve added the configuration");
  assert.equal(el("main h1").textContent, "Getting started");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /3 of 4 steps complete/,
  );
  await click("Issue a complimentary license");
  assert.equal(
    el<HTMLDetailsElement>("#complimentary-issue-disclosure").open,
    true,
  );
  assert.equal(el<HTMLSelectElement>("#complimentary-product").value, "p1");
  assert.equal(
    calls.some((call) => call.init.method === "POST"),
    false,
  );
  await mount("/seller", () => {
    getOverview = () => ({ ...overview(), licenses: [] });
  });
  await click("Getting started");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /3 of 4 steps complete/,
  );
});

test("setup does not count another product's release or an expired or revoked license", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      products: [
        ...overview().products,
        {
          ...overview().products[0]!,
          id: "p2",
          slug: "second",
          name: "Second product",
        },
      ],
      licenses: [{ ...overview().licenses[0]!, paid_through: Date.now() - 1 }],
    });
  });
  await click("Getting started");
  await input("#setup-product", "p2", "change");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /1 of 4 steps complete/,
  );
  assert.match(
    el(".setup-step[aria-current='step']").textContent!,
    /Publish a release/,
  );
  await click("Publish your first release");
  assert.equal(el<HTMLSelectElement>("#release-product").value, "p2");
  assert.equal(el<HTMLDetailsElement>("#release-upload-disclosure").open, true);
  await click("Back to setup");
  await input("#setup-product", "p1", "change");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /2 of 4 steps complete/,
  );
});

test("Stripe remains optional in setup and Billing navigation never starts OAuth", async () => {
  await mount("/seller", () => {
    getOverview = () => ({ ...overview(), billingAvailable: false });
  });
  await click("Getting started");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /Optional.*paid plans/,
  );
  assert.equal(dom.document.querySelectorAll(".setup-steps > li").length, 4);
  await click("Explore Billing");
  assert.equal(el("main h1").textContent, "Billing");
  assert.equal(
    calls.some((call) => call.init.method === "POST"),
    false,
  );
});

test("setup confirmation stays with its product and workspace, and completed setup can be reviewed", async () => {
  const beta = { ...tenant, id: "tenant-b", slug: "beta", name: "Beta" };
  const data = () => ({
    ...overview(),
    licenses: [{ ...overview().licenses[0]!, paid_through: 4102444800000 }],
  });
  await mount("/seller", () => {
    getOverview = data;
    tenants = [tenant, beta];
    routes.set("GET /api/v1/tenants/beta/seller/overview", () =>
      Response.json({ ...data(), tenant: beta }),
    );
  });
  await click("Getting started");
  await click("Open client setup");
  await click("I’ve added the configuration");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /4 of 4 steps complete/,
  );
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /Your setup checklist is complete/,
  );
  await click("Overview");
  await click("Review setup");
  assert.equal(el("main h1").textContent, "Getting started");
  await click("Manage products");
  assert.equal(el("main h1").textContent, "Products");
  assert.equal(
    el<HTMLDetailsElement>("#product-create-disclosure").open,
    false,
  );
  await input("#tenant-select", "beta", "change");
  await click("Getting started");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /3 of 4 steps complete/,
  );
  assert.match(
    el(".setup-step[aria-current='step']").textContent!,
    /Connect your software/,
  );
});

test("guided integration confirmation follows a changed configuration product", async () => {
  await mount("/seller", () => {
    getOverview = () => ({
      ...overview(),
      licenses: [],
      products: [
        ...overview().products,
        {
          ...overview().products[0]!,
          id: "p2",
          slug: "second",
          name: "Second product",
        },
      ],
    });
  });
  await click("Getting started");
  await click("Open client setup");
  await input("#config-product", "second", "change");
  await click("I’ve added the configuration");
  assert.equal(el<HTMLSelectElement>("#setup-product").value, "p2");
  assert.match(
    el("#seller-panel-onboarding").textContent!,
    /2 of 4 steps complete/,
  );
  await input("#setup-product", "p1", "change");
  assert.match(
    el(".setup-step[aria-current='step']").textContent!,
    /Connect your software/,
  );
  await click("Open client setup");
  getOverview = overview;
  await click("Refresh dashboard");
  const before = calls.length;
  await input("#config-product", "second", "change");
  assert.equal(el<HTMLSelectElement>("#config-product").value, "");
  assert.match(el<HTMLTextAreaElement>("#php-config").value, /your-product/);
  assert.equal(calls.length, before);
});
