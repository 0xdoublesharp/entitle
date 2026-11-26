import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { after, afterEach, test } from "node:test";
import { Window } from "happy-dom";
import type { App } from "vue";
import type { License } from "../web/api.ts";
import type { CheckoutLoader, CheckoutSession } from "../web/checkout.ts";
import { planInterval, planPrice } from "../web/checkout.ts";

registerHooks({
  load(url, context, next) {
    return url.endsWith(".css")
      ? { format: "module", source: "", shortCircuit: true }
      : next(url, context);
  },
});
const dom = new Window({ url: "https://entitle.example.test/" });
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
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value:
      name === "window"
        ? dom
        : (dom as unknown as Record<string, unknown>)[name],
  });
}
const { createApp, h, nextTick } = await import("vue");
const { ApiClient } = await import("../web/api.ts");
const { mountCustomerApp, mountSiteApp } = await import("../web/main.ts");
const { SellerFeaturePanel } = await import("../web/features.ts");
let app: App | undefined;
afterEach(() => {
  app?.unmount();
  app = undefined;
  dom.document.head.innerHTML = "";
});
after(() => dom.happyDOM.close());

const reset = (path: string) => {
  dom.history.replaceState(null, "", path);
  dom.document.body.innerHTML = '<div id="app"></div>';
};
const flush = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await nextTick();
};
const element = <T extends Element = Element>(selector: string) => {
  const node = dom.document.querySelector(selector);
  assert.ok(node, selector);
  return node as unknown as T;
};
const click = async (title: string) => {
  const button = [...dom.document.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === title,
  );
  assert.ok(button, title);
  button.click();
  await flush();
};
const input = async (selector: string, value: string, event = "input") => {
  const node = element<HTMLInputElement>(selector);
  node.value = value;
  node.dispatchEvent(new Event(event, { bubbles: true }));
  await flush();
};
const submit = async (selector: string) => {
  element(selector).dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  await flush();
};

test("lifetime plans show a one-time price and no recurring renewal", () => {
  const plan = {
    unit_amount: 29900,
    currency: "usd",
    billing_interval: "lifetime",
  };
  assert.equal(planPrice(plan), "$299 one-time");
  assert.equal(planInterval(plan).label, "Lifetime license");
  assert.equal(
    planInterval(plan).renewal,
    "One-time purchase. No recurring renewal.",
  );
});

const products = [
  {
    id: "p-other",
    name: "Other product",
    plans: [{ id: "default-plan", name: "Annual", site_allowance: 1 }],
  },
  {
    id: "p-plugin",
    name: "Publisher plugin",
    plans: [
      { id: "plugin-annual", name: "Annual", site_allowance: 1 },
      {
        id: "plugin-lifetime",
        name: "Lifetime",
        site_allowance: 4,
        unit_amount: 29900,
        currency: "usd",
        billing_interval: "lifetime",
      },
    ],
  },
];
const license = (overrides: Partial<License>): License => ({
  id: "l-renew",
  product_id: "p-plugin",
  product_name: "Publisher plugin",
  site_allowance: 1,
  plan_name: "Annual",
  paid_through: 1,
  billing_status: "canceled",
  entitled: false,
  revoked: false,
  suspended: false,
  installations: [],
  releases: [],
  ...overrides,
});
const session: CheckoutSession = {
  currency: "usd",
  status: { type: "open" },
  canConfirm: false,
  total: { total: { amount: "$299.00", minorUnitsAmount: 29900 } },
};
const checkoutLoader: CheckoutLoader = async () => ({
  initCheckoutElementsSdk: () => ({
    on() {},
    createPaymentElement: () => ({ on() {}, mount() {}, destroy() {} }),
    loadActions: async () => ({
      type: "success",
      actions: {
        getSession: () => session,
        confirm: async () => ({ type: "success", session }),
      },
    }),
  }),
});
const mountBuyer = async (
  query: string,
  licenses: License[],
  allowPromotionCodes = false,
) => {
  reset(`/t/store?${query}`);
  const checkouts: unknown[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    switch (String(url).split("/").pop()) {
      case "me":
        return Response.json({
          customer: { id: "buyer", email: "buyer@example.test" },
          csrfToken: "buyer-csrf",
          licenses,
        });
      case "catalog":
        return Response.json({
          products,
          billingAvailable: true,
          allowPromotionCodes,
        });
      case "checkout":
        checkouts.push(JSON.parse(String(init?.body)));
        return Response.json({
          uiMode: "elements",
          clientSecret: "test-secret",
          publishableKey: "test-key",
          returnUrl: dom.location.href,
        });
      default:
        throw Error(`Unexpected request to ${url}`);
    }
  };
  app = mountCustomerApp("#app", fetcher, checkoutLoader);
  await flush();
  return checkouts;
};

test("a sale link preselects the lifetime plan, fills its code, and renews the eligible license", async () => {
  const checkouts = await mountBuyer(
    "promo=+BF30+&plan=plugin-lifetime&renew=l-renew",
    [
      license({}),
      license({
        id: "l-lifetime",
        billing_status: "lifetime",
        paid_through: Date.UTC(9999, 0, 1),
        entitled: true,
      }),
    ],
  );
  assert.equal(element<HTMLInputElement>("#promotion-code").value, "BF30");
  assert.equal(
    element<HTMLInputElement>('input[name="plan"]:checked').value,
    "plugin-lifetime",
  );
  assert.match(
    element("#renewal-notice").textContent!,
    /Renewing existing license for Publisher plugin/,
  );
  assert.equal(dom.document.querySelector('input[value="default-plan"]'), null);
  assert.match(
    element('article[aria-labelledby="license-l-lifetime"] .status')
      .textContent!,
    /Lifetime/,
  );
  assert.doesNotMatch(dom.document.body.textContent!, /9999/);
  await input("#promotion-code", "  WINTER  ");
  await submit(".checkout-form");
  assert.deepEqual(checkouts, [
    {
      planId: "plugin-lifetime",
      email: "buyer@example.test",
      uiMode: "elements",
      promotionCode: "WINTER",
      renewLicenseId: "l-renew",
    },
  ]);
  assert.match(
    element(".order-summary").textContent!,
    /One-time purchase\. No recurring renewal\./,
  );
  assert.doesNotMatch(
    element(".order-summary").textContent!,
    /Manage or cancel/,
  );
});

test("invalid plan and suspended renewal links fall back, and canceling an upgrade removes the renewal payload", async () => {
  const checkouts = await mountBuyer(
    "plan=unknown&renew=l-suspended",
    [
      license({ id: "l-suspended", suspended: true }),
      license({ provenance: "complimentary", entitled: true }),
    ],
    true,
  );
  assert.equal(
    element<HTMLInputElement>('input[name="plan"]:checked').value,
    "default-plan",
  );
  assert.equal(dom.document.querySelector("#renewal-notice"), null);
  assert.equal(element<HTMLInputElement>("#promotion-code").required, false);
  await click("Upgrade to paid");
  assert.equal(
    element<HTMLInputElement>('input[name="plan"]:checked').value,
    "plugin-annual",
  );
  await click("Cancel renewal");
  await input("#promotion-code", "   ");
  await submit(".checkout-form");
  assert.deepEqual(checkouts, [
    {
      planId: "plugin-annual",
      email: "buyer@example.test",
      uiMode: "elements",
    },
  ]);
});

const mountPanel = async (page: string, fetcher: typeof fetch) => {
  reset("/app/seller");
  const meta = dom.document.createElement("meta");
  meta.name = "entitle-app-base";
  meta.content = "/app";
  dom.document.head.append(meta);
  const api = new ApiClient(fetcher, "/seller");
  api.csrfToken = "seller-csrf";
  app = createApp({
    render: () =>
      h(SellerFeaturePanel, {
        page,
        tenantSlug: "store",
        api,
        platform: api,
        hosted: false,
        products: [],
        confirm: () => {},
      }),
  });
  app.mount("#app");
  await flush();
};

test("commerce saves an explicit disabled promo setting and copies a mounted sale link", async () => {
  const writes: unknown[] = [];
  const clipboard: string[] = [];
  Object.defineProperty(dom.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: async (value: string) => {
        clipboard.push(value);
      },
    },
  });
  await mountPanel("commerce", async (url, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return Response.json({});
    }
    if (String(url).endsWith("/promotions")) {
      const promo = {
        active: true,
        percentOff: 30,
        amountOff: null,
        currency: null,
        duration: "once",
        timesRedeemed: 2,
        maxRedemptions: 10,
        expiresAt: null,
      };
      return Response.json({
        localMode: false,
        promotions: [
          { ...promo, id: "a", code: "BF+30" },
          { ...promo, id: "b", code: "OLD", active: false },
        ],
      });
    }
    return Response.json({ settings: { allowPromotionCodes: true } });
  });
  const setting = element<HTMLInputElement>("#allowPromotionCodes");
  assert.equal(setting.checked, true);
  setting.click();
  await submit("#tax-settings");
  assert.deepEqual(writes, [{ allowPromotionCodes: false }]);
  await click("Load promotion codes");
  assert.match(
    dom.document.body.textContent!,
    /BF\+30 · 30% off.*2 of 10 redeemed/,
  );
  assert.doesNotMatch(dom.document.body.textContent!, /OLD/);
  await click("Copy sale link");
  assert.deepEqual(clipboard, [
    "https://entitle.example.test/app/t/store?promo=BF%2B30",
  ]);
});

test("operations handles unavailable analytics and renders currency and product figures after a retry", async () => {
  let loads = 0;
  await mountPanel("operations", async (url) => {
    if (String(url).endsWith("/analytics")) {
      if (++loads === 1) return Response.json({}, { status: 404 });
      return Response.json({
        generatedAt: Date.now(),
        recurringByCurrency: [
          {
            currency: "jpy",
            mrrMinor: "500",
            arrMinor: "6000",
            activeSubscriptions: 1,
          },
          {
            currency: "kwd",
            mrrMinor: "1020",
            arrMinor: "12240",
            activeSubscriptions: 1,
          },
          {
            currency: "usd",
            mrrMinor: "900719925474099301",
            arrMinor: "10808639105689191612",
            activeSubscriptions: 1,
          },
        ],
        retention: {
          activeSubscriptions: 2,
          canceledPendingExpiry: 3,
          expiredLicenses: 4,
          expiringIn30Days: 5,
          lifetimeLicenses: 6,
          complimentaryActive: 7,
        },
        byProduct: [
          {
            productId: "p-plugin",
            productName: "Publisher plugin",
            activeLicenses: 3,
            expiredLicenses: 4,
            lifetimeLicenses: 2,
            activeInstallations: 5,
            seatsUsed: 4,
            seatAllowance: 8,
          },
        ],
      });
    }
    return Response.json({
      summary: {},
      settings: {},
      alerts: [],
      notifications: [],
      features: {},
    });
  });
  await click("Load revenue and retention");
  assert.match(
    dom.document.body.textContent!,
    /Revenue and retention data is unavailable/,
  );
  assert.match(dom.document.body.textContent!, /Basic health/);
  await click("Load revenue and retention");
  assert.match(dom.document.body.textContent!, /MRR · JPYJPY\s+500/);
  assert.match(dom.document.body.textContent!, /ARR · KWDKWD\s+12\.240/);
  assert.match(
    dom.document.body.textContent!,
    /USD\s+9,007,199,254,740,993\.01/,
  );
  assert.match(dom.document.body.textContent!, /Lifetime licenses6/);
  assert.match(element("table tbody").textContent!, /Publisher plugin.*4 of 8/);
});

test("seller license filters, CSV export, and inline edits use the selected workspace and license", async (t) => {
  reset("/seller");
  const downloads: string[] = [];
  t.mock.method(
    dom.HTMLAnchorElement.prototype,
    "click",
    function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    },
  );
  const tenant = {
    id: "store",
    slug: "store",
    name: "Example Store",
    stripe_status: "connected",
  };
  const base = {
    ...license({}),
    customer_email: "buyer@example.test",
    provenance: "paid",
    internal_note: "Original note",
  };
  const expires = Date.now() + 2 * 86400000;
  const licenses = [
    { ...base, id: "l-canceled" },
    {
      ...base,
      id: "l-life",
      billing_status: "lifetime",
      paid_through: Date.UTC(9999, 0, 1),
    },
    {
      ...base,
      id: "l-comp",
      provenance: "complimentary",
      billing_status: "active",
      expires_at: expires,
    },
  ];
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  app = mountSiteApp("#app", async (url, init) => {
    requests.push({ url: String(url), init });
    switch (
      new URL(String(url), dom.location.origin).pathname.split("/").pop()
    ) {
      case "info":
        return Response.json({
          deploymentMode: "standalone",
          databaseEngines: [],
        });
      case "me":
        return Response.json({
          user: { email: "seller@example.test" },
          csrfToken: "seller-csrf",
          tenants: [tenant],
        });
      case "overview":
        return Response.json({
          tenant,
          products,
          licenses,
          releases: [],
          metrics: {
            licenses: {},
            installations: {},
            seats: { used: 0, allowance: 1 },
            releases: {},
            storage: { usedBytes: 0, reservedBytes: 0, limitBytes: 1024 },
            downloads: {},
            payments: [],
          },
        });
      case "prices":
        return Response.json({
          prices: [
            {
              id: "price_lifetime",
              interval: "lifetime",
              productName: "Publisher plugin",
              nickname: "Lifetime",
              unit_amount: 29900,
              currency: "usd",
            },
          ],
        });
      case "keys":
        return Response.json({ keys: [] });
      case "export":
        return new Response("license\nl-comp\n", {
          headers: { "Content-Type": "text/csv" },
        });
      case "l-comp":
      case "l-canceled":
        return Response.json({ ok: true });
      default:
        throw Error(`Unexpected request to ${url}`);
    }
  });
  await flush();
  element<HTMLButtonElement>("#seller-nav-licenses").click();
  await flush();
  const ids = () =>
    [...dom.document.querySelectorAll("[data-license-id]")].map((row) =>
      row.getAttribute("data-license-id"),
    );
  await input("#license-access", "lifetime", "change");
  assert.deepEqual(ids(), ["l-life"]);
  assert.match(element(".license-expiry").textContent!, /Lifetime/);
  assert.doesNotMatch(element(".license-expiry").textContent!, /9999/);
  await input("#license-access", "canceled", "change");
  assert.deepEqual(ids(), ["l-canceled"]);
  await click("Edit");
  assert.equal(
    element<HTMLInputElement>("#edit-license-note").value,
    "Original note",
  );
  assert.equal(dom.document.querySelector("#edit-license-expiry"), null);
  assert.match(
    element("#license-edit").textContent!,
    /Stripe manages expiration/,
  );
  await input("#edit-license-note", "");
  await submit("#license-edit");
  const paidEdit = requests.find((call) => call.init?.method === "PATCH");
  assert.deepEqual(JSON.parse(String(paidEdit?.init?.body)), {
    internalNote: "",
  });
  assert.equal(
    new Headers(paidEdit?.init?.headers).get("X-CSRF-Token"),
    "seller-csrf",
  );

  await input("#license-access", "expiring", "change");
  assert.deepEqual(ids(), ["l-comp"]);
  await input("#license-product", "p-plugin", "change");
  await input("#license-type", "complimentary", "change");
  await input("#license-search", "  buyer@example.test  ");
  await click("Export CSV");
  const csv = requests.find((call) => call.url.includes("/licenses/export"));
  assert.ok(csv);
  const exported = new URL(csv.url, dom.location.origin);
  assert.equal(
    exported.pathname,
    "/api/v1/tenants/store/seller/licenses/export",
  );
  assert.deepEqual(Object.fromEntries(exported.searchParams), {
    format: "csv",
    productId: "p-plugin",
    provenance: "complimentary",
    status: "expiring",
    q: "buyer@example.test",
  });
  assert.equal(csv.init?.credentials, "same-origin");
  assert.deepEqual(downloads, ["store-licenses.csv"]);

  await click("Edit");
  await input("#edit-license-note", "Support extension");
  await input("#edit-license-allowance", "7");
  const newExpiration = "2035-05-02T09:30";
  await input("#edit-license-expiry", newExpiration);
  await submit("#license-edit");
  const complimentaryEdit = requests.find((call) =>
    call.url.endsWith("/licenses/l-comp"),
  );
  assert.deepEqual(JSON.parse(String(complimentaryEdit?.init?.body)), {
    internalNote: "Support extension",
    siteAllowance: 7,
    expiresAt: new Date(newExpiration).getTime(),
  });
  assert.equal(dom.document.querySelector("#license-edit"), null);
  element<HTMLInputElement>("#include-paid-plan").click();
  await flush();
  assert.match(element('select[id="price-id"]').textContent!, /\$299 one-time/);
});
