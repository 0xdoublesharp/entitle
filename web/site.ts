import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
} from "vue";
import { ApiClient, ApiError, errorMessage } from "./api.ts";
import {
  frameworkInfo,
  frameworkOf,
  seatUnit,
  setupConfiguration,
} from "./frameworks.ts";
import type { Framework, FrameworkProduct, ReleaseAsset } from "./api.ts";
import type { Tenant } from "../packages/shared/tenant.ts";
import { site } from "../packages/shared/site.ts";
import { SellerFeaturePanel, verifiedRequest } from "./features.ts";
import type { EmailChangeDraft } from "./features.ts";
import { appHeader } from "./chrome.ts";
import { applicationHref } from "./navigation.ts";

interface Info {
  deploymentMode: "standalone" | "hosted";
  applicationFeePercent: number;
  maxUploadBytes: number;
  maxNativeUploadBytes?: number;
  databaseEngines: string[];
}
interface Seller {
  user: { id: string; email: string };
  csrfToken: string;
  tenants: Tenant[];
}
interface SellerProduct extends FrameworkProduct {
  id: string;
  slug: string;
  name: string;
  plugin_basename: string;
  tax_code?: string | null;
  plans: {
    id: string;
    name: string;
    site_allowance: number;
    stripe_price_id: string;
  }[];
}
interface Overview {
  billingAvailable?: boolean;
  tenant: Tenant;
  sandbox?: {
    isSandbox: boolean;
    parentSlug: string;
    sandboxSlug: string;
    mode: "fixture" | "stripe";
  } | null;
  products: SellerProduct[];
  licenses: {
    id: string;
    product_id: string;
    product_name: string;
    customer_email: string;
    plan_name: string;
    site_allowance: number;
    paid_through: number | null;
    provenance?: "paid" | "complimentary";
    expires_at?: number | null;
    billing_status: string;
    revoked: boolean;
    suspended: boolean;
  }[];
  releases: {
    id: string;
    product_id: string;
    version: string;
    withdrawn: boolean;
    assets?: ReleaseAsset[];
  }[];
  metrics: {
    licenses: Record<string, number>;
    installations: Record<string, number>;
    seats: Record<string, number>;
    releases: Record<string, number>;
    storage: Record<string, number>;
    downloads: Record<string, number>;
    payments: {
      currency: string;
      paidMinor: string;
      refundedMinor: string;
      netMinor: string;
    }[];
  };
}
interface Price {
  id: string;
  productName: string;
  nickname: string | null;
  unit_amount: number | null;
  currency: string;
  interval: string;
}
interface Key {
  display_prefix: string;
  scopes: string;
  expires_at: number | null;
  last_used_at: number | null;
  id: string;
  name: string;
  created_at: number;
  revoked_at: number | null;
}

const emailChangeStorageKey = "entitle:email-change";
const emailChangePart = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const emailChangeDraft = (value: unknown): value is EmailChangeDraft => {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<EmailChangeDraft>;
  return (
    emailChangePart(draft.id) &&
    (draft.currentToken === "" || emailChangePart(draft.currentToken)) &&
    (draft.newToken === "" || emailChangePart(draft.newToken)) &&
    Array.isArray(draft.pendingTokens) &&
    draft.pendingTokens.length <= 2 &&
    draft.pendingTokens.every(emailChangePart)
  );
};

const sellerPages = [
  { id: "overview", label: "Overview" },
  { id: "onboarding", label: "Getting started" },
  { id: "products", label: "Products" },
  { id: "releases", label: "Releases" },
  { id: "licenses", label: "Licenses" },
  { id: "setup", label: "Client setup" },
  { id: "keys", label: "API keys" },
  { id: "billing", label: "Billing" },
  { id: "commerce", label: "Tax settings" },
  { id: "sandbox", label: "Sandbox" },
  { id: "operations", label: "Operations" },
  { id: "webhooks", label: "Webhooks" },
  { id: "security", label: "Account security" },
  { id: "export", label: "Export" },
] as const;
const sellerPageGroups = [
  {
    label: "Store",
    pages: ["products", "releases", "licenses", "billing", "commerce"],
  },
  { label: "Integrations", pages: ["setup", "keys", "webhooks", "sandbox"] },
  { label: "Workspace", pages: ["operations", "security", "export"] },
];
type SellerPage = (typeof sellerPages)[number]["id"];

const hasPlatformSubscription = (tenant: Tenant | undefined) =>
  !!tenant?.platform_subscription_id &&
  !["canceled", "incomplete_expired"].includes(tenant.billing_status);
const stripeStatusLabel = (status: string) =>
  (
    ({
      connected: "Connected",
      restricted: "Action needed",
      unconnected: "Not connected",
      disconnected: "Disconnected",
      platform: "Platform account",
    }) as Record<string, string>
  )[status] || status.replaceAll("_", " ");
const billingStatusLabel = (status: string) =>
  (
    ({
      active: "Active",
      trial: "Trial",
      trialing: "Trial",
      past_due: "Payment overdue",
      unpaid: "Payment required",
      canceled: "Canceled",
      incomplete: "Payment pending",
      incomplete_expired: "Payment expired",
      paused: "Paused",
    }) as Record<string, string>
  )[status] || status.replaceAll("_", " ");
const readableBytes = (bytes: number) => {
  const [size, unit] =
    bytes >= 1073741824
      ? ([1073741824, "GiB"] as const)
      : bytes >= 1048576
        ? ([1048576, "MiB"] as const)
        : bytes >= 1024
          ? ([1024, "KiB"] as const)
          : ([1, "B"] as const);
  return `${(bytes / size).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${unit}`;
};
const btn = (label: string, action: () => void, disabled = false) =>
  h("button", { type: "button", onClick: action, disabled }, label);
const workspaceSlug = (value: string) =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-/, "")
    .slice(0, 63);
const section = (title: string, children: unknown[]) =>
  h("section", { class: "panel seller-panel" }, [
    h("h2", title),
    ...children,
  ] as Parameters<typeof h>[2]);
const money = (currency: string, minor: string) => {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits!;
  const value = BigInt(minor),
    scale = 10n ** BigInt(digits),
    negative = value < 0n,
    absolute = negative ? -value : value;
  const whole = absolute / scale,
    fraction = (absolute % scale).toString().padStart(digits, "0");
  return (
    (negative ? "-" : "") +
    formatter
      .formatToParts(whole)
      .map((part) => (part.type === "fraction" ? fraction : part.value))
      .join("")
  );
};

const SellerConfirmation = defineComponent({
  props: {
    title: { type: String, required: true },
    label: { type: String, required: true },
  },
  emits: ["confirm", "cancel"],
  setup(props, { emit }) {
    const dialog = ref<HTMLDialogElement>();
    onMounted(() => dialog.value!.showModal());
    return () =>
      h(
        "dialog",
        {
          ref: dialog,
          class: "confirm-dialog",
          "aria-labelledby": "seller-confirm-title",
          onCancel: (event: Event) => {
            event.preventDefault();
            emit("cancel");
          },
        },
        [
          h("h2", { id: "seller-confirm-title" }, props.title),
          h("p", "This changes access immediately. Confirm to continue."),
          h("div", { class: "button-row" }, [
            h(
              "button",
              {
                type: "button",
                autofocus: true,
                class: "button-secondary",
                onClick: () => emit("cancel"),
              },
              "Cancel",
            ),
            btn(props.label, () => emit("confirm")),
          ]),
        ],
      );
  },
});

export function mountSellerApp(
  target: string | Element = "#app",
  transport?: typeof fetch,
) {
  const platform = new ApiClient(transport, "/api/v1/platform");
  const app = createApp(
    defineComponent({
      setup() {
        const activePage = ref<SellerPage>("overview"),
          recoveryOpen = ref(false),
          accountProof = ref(""),
          emailChange = ref<EmailChangeDraft | null>(null),
          proofRound = ref(0),
          panelProof = ref<{ page: SellerPage; token: string } | null>(null),
          proofPurpose = ref("api_keys");
        const hosted = ref(true),
          applicationFeePercent = ref(0);
        const seller = ref<Seller | null>(null),
          selected = ref(""),
          overview = ref<Overview | null>(null),
          prices = ref<Price[]>([]),
          keys = ref<Key[]>([]),
          recovery = ref(false),
          localMode = ref(false),
          includePaidPlan = ref(false),
          keyScopes = ref(["read", "releases:write"]);
        const loading = ref(true),
          busy = ref(false),
          error = ref(""),
          notice = ref(""),
          token = ref<string | null>(null),
          secret = ref("");
        const setupProduct = ref("");
        const setupStep = ref<string | null>(null);
        const guidedSetup = ref(false);
        const integrationConfirmations = ref<Record<string, boolean>>({});
        const slugEdited = ref(false);
        const workspaceCreateOpen = ref(false);
        const errorReference = ref<string>();
        const stripeConnectionNeeded = ref(false);
        const reportError = (failure: unknown) => {
          error.value =
            failure instanceof ApiError
              ? failure.message
              : errorMessage(failure);
          errorReference.value =
            failure instanceof ApiError ? failure.requestId : undefined;
          stripeConnectionNeeded.value =
            failure instanceof ApiError &&
            (failure.code === "stripe_not_connected" ||
              failure.message === "Connect a Stripe account first.");
        };
        const maxUpload = ref(26214400),
          maxNativeUpload = ref(104857600),
          file = ref<File | null>(null),
          confirmation = ref<{
            title: string;
            label: string;
            run: () => Promise<void>;
          } | null>(null);
        const fields = ref<Record<string, string>>({
          "seller-email": "",
          "tenant-name": "",
          "tenant-slug": "",
          "product-name": "",
          "product-slug": "",
          "plugin-basename": "",
          "product-framework": "wordpress",
          "joomla-extension-type": "plugin",
          "joomla-element": "",
          "joomla-folder": "",
          "joomla-client": "site",
          "joomla-major": "5",
          "jetbrains-plugin-id": "",
          "jetbrains-since-build": "",
          "jetbrains-until-build": "",
          "activation-kind": "device",
          "release-target": "",
          "release-signature": "",
          "release-min-system-version": "",
          "plan-name": "Annual",
          "site-allowance": "1",
          "price-id": "",
          "release-product": "",
          "release-version": "",
          "release-changelog": "",
          "release-min-wp": "",
          "release-min-php": "",
          "release-min-free": "",
          "release-tested": "",
          "key-verification-token": "",
          "release-verification-token": "",
          "key-name": "",
          "key-expiry": "90",
          "config-product": "",
          "complimentary-email": "",
          "complimentary-product": "",
          "complimentary-allowance": "1",
          "complimentary-expiry": "",
          "complimentary-note": "",
        });
        let complimentaryDraft: {
          signature: string;
          requestId: string;
        } | null = null;
        let complimentaryWorkspace = "";
        const clearComplimentary = () => {
          complimentaryDraft = null;
          fields.value["complimentary-email"] = "";
          fields.value["complimentary-note"] = "";
          fields.value["complimentary-expiry"] = "";
          fields.value["complimentary-allowance"] = "1";
          fields.value["complimentary-product"] = "";
        };
        let receivedEmailChange: { id: string; token: string } | null = null;
        let emailChangeExpiresAt = 0;
        const retainEmailChange = (draft: EmailChangeDraft | null) => {
          if (draft && emailChange.value?.id !== draft.id)
            emailChangeExpiresAt = Date.now() + 900000;
          emailChange.value = draft;
          try {
            if (draft && seller.value)
              window.sessionStorage.setItem(
                emailChangeStorageKey,
                JSON.stringify({
                  sellerId: seller.value.user.id,
                  expiresAt: emailChangeExpiresAt,
                  draft,
                }),
              );
            else window.sessionStorage.removeItem(emailChangeStorageKey);
          } catch {
            // The current page can still collect both links when storage is disabled.
          }
        };
        const restoreEmailChange = () => {
          if (emailChange.value) return;
          try {
            const saved = JSON.parse(
              window.sessionStorage.getItem(emailChangeStorageKey) || "null",
            ) as Record<string, unknown> | null;
            if (
              saved?.sellerId === seller.value?.user.id &&
              typeof saved?.expiresAt === "number" &&
              saved.expiresAt > Date.now() &&
              saved.expiresAt <= Date.now() + 900000 &&
              emailChangeDraft(saved.draft)
            ) {
              emailChange.value = saved.draft;
              emailChangeExpiresAt = saved.expiresAt;
              return;
            }
          } catch {
            // Ignore unavailable storage and discard malformed saved proofs.
          }
          retainEmailChange(null);
        };
        const receiveEmailChange = () => {
          if (!receivedEmailChange || !seller.value) return;
          const { id, token } = receivedEmailChange;
          const draft =
            emailChange.value?.id === id
              ? emailChange.value
              : { id, currentToken: "", newToken: "", pendingTokens: [] };
          // Mailbox selection refers to the link just opened, never an older queue entry.
          const pendingTokens = [draft.currentToken, draft.newToken].includes(
            token,
          )
            ? []
            : [token];
          retainEmailChange({ ...draft, pendingTokens });
          receivedEmailChange = null;
        };
        const tenantApi = () => {
          const api = new ApiClient(
            transport,
            `/api/v1/tenants/${encodeURIComponent(selected.value)}/seller`,
          );
          api.csrfToken = platform.csrfToken;
          return api;
        };
        const clearSession = () => {
          activePage.value = "overview";
          guidedSetup.value = false;
          setupProduct.value = "";
          setupStep.value = null;
          integrationConfirmations.value = {};
          seller.value = null;
          platform.csrfToken = "";
          accountProof.value = "";
          receivedEmailChange = null;
          retainEmailChange(null);
          panelProof.value = null;
          recoveryOpen.value = false;
          overview.value = null;
          recovery.value = false;
          file.value = null;
          keys.value = [];
          prices.value = [];
          secret.value = "";
          fields.value["key-verification-token"] = "";
          fields.value["release-verification-token"] = "";
          selected.value = "";
          fields.value["tenant-name"] = "";
          fields.value["tenant-slug"] = "";
          slugEdited.value = false;
          workspaceCreateOpen.value = false;
          clearComplimentary();
          complimentaryWorkspace = "";
        };
        const run = async (action: () => Promise<void>, expire = true) => {
          if (busy.value) return;
          busy.value = true;
          error.value = "";
          errorReference.value = undefined;
          stripeConnectionNeeded.value = false;
          notice.value = "";
          try {
            await action();
          } catch (failure) {
            reportError(failure);
            if (expire && failure instanceof ApiError && failure.status === 401)
              clearSession();
          } finally {
            busy.value = false;
          }
        };
        const dashboard = async () => {
          if (complimentaryWorkspace !== selected.value) {
            guidedSetup.value = false;
            setupProduct.value = "";
            setupStep.value = null;
            clearComplimentary();
            complimentaryWorkspace = selected.value;
          }
          panelProof.value = null;
          overview.value = null;
          recovery.value = false;
          file.value = null;
          keys.value = [];
          prices.value = [];
          secret.value = "";
          fields.value["key-verification-token"] = "";
          fields.value["release-verification-token"] = "";
          if (!seller.value || !selected.value) return;
          const api = tenantApi();
          try {
            const [data, priceData, keyData] = await Promise.all([
              api.get<Overview>("/overview"),
              api
                .get<{ prices: Price[]; localMode: boolean }>("/prices")
                .then((data) => ({ ...data, warning: undefined }))
                .catch((failure: unknown) => {
                  if (
                    failure instanceof ApiError &&
                    [401, 403].includes(failure.status)
                  )
                    throw failure;
                  return {
                    prices: [],
                    localMode: false,
                    warning:
                      failure instanceof ApiError &&
                      failure.status === 409 &&
                      failure.code === "stripe_not_connected"
                        ? undefined
                        : failure,
                  };
                }),
              api.get<{ keys: Key[] }>("/keys"),
            ]);
            if (priceData.warning && data.billingAvailable !== false)
              reportError(priceData.warning);
            overview.value = data;
            prices.value = priceData.prices;
            localMode.value = priceData.localMode;
            includePaidPlan.value =
              data.billingAvailable !== false && priceData.prices.length > 0;
            keys.value = keyData.keys;
            fields.value["price-id"] = priceData.prices[0]?.id || "";
            fields.value["release-product"] = data.products[0]?.id || "";
            fields.value["release-target"] =
              frameworkInfo[frameworkOf(data.products[0])].targets[0] || "";
            fields.value["release-signature"] = "";
            fields.value["release-min-system-version"] = "";
            fields.value["config-product"] = data.products[0]?.slug || "";
            if (
              !data.products.some(
                (p) => p.id === fields.value["complimentary-product"],
              )
            )
              fields.value["complimentary-product"] =
                data.products[0]?.id || "";
          } catch (failure) {
            if (!(failure instanceof ApiError) || failure.status !== 403)
              throw failure;
            keys.value = (await api.get<{ keys: Key[] }>("/keys")).keys;
            recovery.value = true;
          }
        };
        const session = async () => {
          let value: Seller;
          try {
            value = await platform.get<Seller>("/me");
          } catch (failure) {
            if (!(failure instanceof ApiError) || failure.status !== 401)
              throw failure;
            clearSession();
            return;
          }
          if (
            !value.user.email ||
            !Array.isArray(value.tenants) ||
            typeof value.csrfToken !== "string"
          )
            throw new Error("Invalid seller session");
          if (seller.value && seller.value.user.id !== value.user.id)
            retainEmailChange(null);
          seller.value = value;
          token.value = null;
          platform.csrfToken = value.csrfToken;
          restoreEmailChange();
          receiveEmailChange();
          if (emailChange.value) activePage.value = "security";
          const requested = new URLSearchParams(window.location.search).get(
            "tenant",
          );
          selected.value =
            value.tenants.find((item) => item.slug === requested)?.slug ||
            value.tenants[0]?.slug ||
            "";
          await dashboard();
        };
        const readToken = () => {
          const fragment = new URLSearchParams(window.location.hash.slice(1));
          if (fragment.has("account-verification")) {
            panelProof.value = null;
            accountProof.value = fragment.get("account-verification") || "";
            notice.value =
              "Verification link received. Choose the action you requested below.";
            activePage.value = "keys";
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
          }
          if (fragment.has("account-email-change")) {
            const id = fragment.get("account-email-change"),
              proof = fragment.get("token");
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
            activePage.value = "security";
            if (
              fragment.getAll("account-email-change").length !== 1 ||
              fragment.getAll("token").length !== 1 ||
              !emailChangePart(id) ||
              !emailChangePart(proof)
            ) {
              error.value =
                "This email-change link is incomplete or invalid. Open a fresh link from each mailbox.";
            } else {
              receivedEmailChange = { id, token: proof };
              receiveEmailChange();
              error.value = "";
              notice.value =
                "Email-change link received. Choose which mailbox supplied it before confirming the change.";
            }
          }
          if (fragment.has("seller-login")) {
            token.value = seller.value
              ? null
              : fragment.get("seller-login") || "";
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
          }
        };
        readToken();
        window.addEventListener("hashchange", readToken);
        onUnmounted(() => window.removeEventListener("hashchange", readToken));
        onMounted(() => {
          void run(async () => {
            const info = await platform.get<Info>("/info");
            hosted.value = info.deploymentMode !== "standalone";
            applicationFeePercent.value = info.applicationFeePercent ?? 0;
            maxUpload.value = info.maxUploadBytes;
            maxNativeUpload.value = info.maxNativeUploadBytes ?? 104857600;
            await session();
          }).finally(() => {
            loading.value = false;
          });
        });
        const field = (
          id: string,
          label: string,
          type = "text",
          required = true,
        ) =>
          h("div", { class: "form-field" }, [
            h("label", { for: id }, label),
            h("input", {
              id,
              type,
              required,
              value: fields.value[id],
              min: type === "number" ? 1 : undefined,
              max: id === "complimentary-allowance" ? 100000 : undefined,
              maxlength:
                id === "tenant-slug"
                  ? 63
                  : id === "tenant-name"
                    ? 200
                    : id === "complimentary-note"
                      ? 2000
                      : id === "complimentary-email"
                        ? 254
                        : undefined,
              pattern:
                id === "tenant-slug"
                  ? "[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?"
                  : undefined,
              "aria-describedby":
                id === "tenant-slug" ? "tenant-slug-hint" : undefined,
              autocapitalize: id === "tenant-slug" ? "none" : undefined,
              spellcheck: id === "tenant-slug" ? false : undefined,
              onInput: (event: Event) => {
                const input = event.target as HTMLInputElement;
                if (id === "tenant-slug") {
                  slugEdited.value = true;
                  const position = input.selectionStart;
                  const value = workspaceSlug(input.value);
                  const caret =
                    position === null
                      ? value.length
                      : workspaceSlug(input.value.slice(0, position)).length;
                  input.value = value;
                  input.setSelectionRange(caret, caret);
                  fields.value[id] = value;
                } else {
                  fields.value[id] = input.value;
                  if (id === "tenant-name" && !slugEdited.value)
                    fields.value["tenant-slug"] = workspaceSlug(
                      input.value,
                    ).replace(/-$/, "");
                }
              },
              onBlur:
                id === "tenant-slug"
                  ? () => {
                      fields.value[id] = fields.value[id]!.replace(/-$/, "");
                    }
                  : undefined,
            }),
          ]);
        const select = (
          id: string,
          label: string,
          options: { value: string; label: string }[],
        ) =>
          h("div", { class: "form-field" }, [
            h("label", { for: id }, label),
            h(
              "select",
              {
                id,
                required: true,
                value:
                  id === "setup-product"
                    ? setupCurrentProduct()?.id || ""
                    : fields.value[id],
                onChange: (event: Event) => {
                  if (id === "setup-product") {
                    setupProduct.value = (
                      event.target as HTMLSelectElement
                    ).value;
                    setupStep.value = null;
                  } else
                    fields.value[id] = (
                      event.target as HTMLSelectElement
                    ).value;
                  if (guidedSetup.value && id === "config-product") {
                    setupProduct.value =
                      overview.value!.products.find(
                        (product) => product.slug === fields.value[id],
                      )?.id || "";
                  }
                  if (
                    guidedSetup.value &&
                    ["release-product", "complimentary-product"].includes(id)
                  )
                    setupProduct.value = fields.value[id]!;
                  if (id === "release-product") {
                    const product = overview.value!.products.find(
                      (p) => p.id === fields.value[id],
                    );
                    fields.value["release-target"] =
                      frameworkInfo[frameworkOf(product)].targets[0] || "";
                    fields.value["release-signature"] = "";
                    fields.value["release-min-system-version"] = "";
                    file.value = null;
                  }
                },
              },
              options.map((item) =>
                h("option", { value: item.value }, item.label),
              ),
            ),
          ]);
        const form = (
          id: string,
          action: () => Promise<void>,
          children: unknown[],
          label: string,
        ) => {
          const node = h(
            "form",
            {
              id,
              class: "seller-form",
              onSubmit: (event: Event) => {
                event.preventDefault();
                void run(action);
              },
            },
            [
              ...children,
              h(
                "button",
                {
                  type: "submit",
                  disabled:
                    busy.value ||
                    (id === "complimentary-issue" &&
                      !overview.value?.products.length),
                },
                label,
              ),
            ] as Parameters<typeof h>[2],
          );
          return [
            "product-create",
            "release-upload",
            "key-create",
            "complimentary-issue",
          ].includes(id)
            ? h("details", { id: `${id}-disclosure`, class: "seller-create" }, [
                h("summary", label),
                node,
              ])
            : node;
        };
        const workspaceForm = () =>
          form(
            "tenant-create",
            async () => {
              const result = await platform.post<{ tenant: Tenant }>(
                "/tenants",
                {
                  slug: fields.value["tenant-slug"]!.replace(/-$/, ""),
                  name: fields.value["tenant-name"],
                },
              );
              seller.value!.tenants.push(result.tenant);
              activePage.value = "overview";
              selected.value = result.tenant.slug;
              fields.value["tenant-name"] = "";
              fields.value["tenant-slug"] = "";
              slugEdited.value = false;
              workspaceCreateOpen.value = false;
              await dashboard();
              if (overview.value) activePage.value = "onboarding";
            },
            [
              field("tenant-name", "Workspace name"),
              h("div", { class: "workspace-slug-field" }, [
                field("tenant-slug", "Workspace slug"),
                h(
                  "p",
                  { id: "tenant-slug-hint", class: "field-hint" },
                  "Your workspace’s unique address. Use lowercase letters, numbers and hyphens, up to 63 characters. You can edit the suggested slug.",
                ),
              ]),
            ],
            "Create workspace",
          );
        const workspaceControls = () =>
          h(
            "section",
            { class: "workspace-toolbar", "aria-label": "Workspace controls" },
            [
              h("div", { class: "workspace-toolbar-row" }, [
                hosted.value &&
                  h("div", { class: "workspace-selector" }, [
                    h("label", { for: "tenant-select" }, "Selected workspace"),
                    h(
                      "select",
                      {
                        id: "tenant-select",
                        disabled: busy.value,
                        value: selected.value,
                        onChange: (event: Event) => {
                          activePage.value = "overview";
                          accountProof.value = "";
                          panelProof.value = null;
                          selected.value = (
                            event.target as HTMLSelectElement
                          ).value;
                          void run(dashboard);
                        },
                      },
                      seller.value!.tenants.map((item) =>
                        h("option", { value: item.slug }, item.name),
                      ),
                    ),
                  ]),
                btn("Refresh dashboard", () => void run(dashboard), busy.value),
              ]),
              hosted.value &&
                h(
                  "details",
                  {
                    id: "workspace-create-disclosure",
                    class: "workspace-create",
                    open: workspaceCreateOpen.value,
                    onToggle: (event: Event) => {
                      workspaceCreateOpen.value = (
                        event.target as HTMLDetailsElement
                      ).open;
                    },
                  },
                  [h("summary", "New workspace"), workspaceForm()],
                ),
            ],
          );
        const redirect = async (api: ApiClient, path: string) => {
          const result = await api.post<{ url: string }>(path, {});
          window.location.assign(result.url);
        };
        const confirm = (
          title: string,
          label: string,
          action: () => Promise<void>,
        ) => {
          confirmation.value = {
            title,
            label,
            run: async () => {
              await action();
              await dashboard();
            },
          };
        };
        const copy = async (value: string, id: string) => {
          if (navigator.clipboard) {
            await navigator.clipboard.writeText(value);
            notice.value = "Copied.";
          } else {
            const input = document.getElementById(id) as HTMLInputElement;
            input.focus();
            input.select();
            notice.value = "Selected. Copy it using your keyboard.";
          }
        };
        const releaseProduct = () =>
          overview.value!.products.find(
            (p) => p.id === fields.value["release-product"],
          );
        const releaseUploadLimit = () =>
          frameworkOf(releaseProduct()) === "wordpress"
            ? maxUpload.value
            : maxNativeUpload.value;
        const configProduct = () =>
          overview.value!.products.find(
            (p) => p.slug === fields.value["config-product"],
          );
        const config = () =>
          setupConfiguration(
            configProduct(),
            window.location.origin,
            selected.value,
            fields.value["config-product"] || "your-product",
          );
        const productConfig = () => {
          switch (fields.value["product-framework"]) {
            case "joomla":
              return {
                extensionType: fields.value["joomla-extension-type"],
                element: fields.value["joomla-element"],
                ...(fields.value["joomla-folder"]
                  ? { folder: fields.value["joomla-folder"] }
                  : {}),
                client: fields.value["joomla-client"],
                joomlaMajor: Number(fields.value["joomla-major"]),
              };
            case "jetbrains":
              return {
                pluginId: fields.value["jetbrains-plugin-id"],
                sinceBuild: fields.value["jetbrains-since-build"],
                ...(fields.value["jetbrains-until-build"]
                  ? { untilBuild: fields.value["jetbrains-until-build"] }
                  : {}),
              };
            case "generic":
              return { activationKind: fields.value["activation-kind"] };
            default:
              return {};
          }
        };
        const metric = (label: string, value: number | string) =>
          h("div", { class: "metric" }, [
            h("dt", label),
            h("dd", String(value)),
          ]);
        const keyVerification = () =>
          h("div", { class: "verification-proof" }, [
            h(
              "p",
              "API key changes require a fresh email verification token for purpose api_keys. Each token approves one action.",
            ),
            btn(
              "Email API key verification",
              () =>
                void run(async () => {
                  await platform.post("/account/verification/request", {
                    purpose: "api_keys",
                  });
                  notice.value =
                    "Check your email for the API key verification token.";
                }),
              busy.value,
            ),
            field(
              "key-verification-token",
              "API key email verification token",
              "password",
            ),
          ]);
        const renderKeyList = () =>
          h(
            "ul",
            { class: "record-list key-records" },
            keys.value.map((key) =>
              h("li", [
                `${key.name} · ${key.revoked_at ? "Revoked" : key.expires_at === null ? "Replace required" : key.expires_at <= Date.now() ? "Expired" : "Active"} `,
                h(
                  "p",
                  `Prefix: ${key.display_prefix} · Permissions: ${(JSON.parse(key.scopes) as string[]).join(", ")}`,
                ),
                h(
                  "p",
                  `Expires: ${key.expires_at === null ? "Unavailable" : new Date(key.expires_at).toLocaleDateString()} · Last used: ${key.last_used_at === null ? "Never" : new Date(key.last_used_at).toLocaleDateString()}`,
                ),
                !key.revoked_at &&
                  btn(
                    "Revoke API key",
                    () =>
                      confirm(
                        `Revoke API key ${key.name}?`,
                        "Confirm revoke API key",
                        async () => {
                          const proof =
                            fields.value["key-verification-token"] || "";
                          fields.value["key-verification-token"] = "";
                          await verifiedRequest(
                            platform,
                            tenantApi(),
                            "api_keys",
                            proof,
                            `/keys/${encodeURIComponent(key.id)}/revoke`,
                            {},
                          );
                        },
                      ),
                    busy.value,
                  ),
              ]),
            ),
          );
        const renderRecovery = () =>
          section("Workspace recovery", [
            h(
              "p",
              "Workspace access is restricted. Billing and API key revocation remain available. Contact the operator to restore business access.",
            ),
            hosted.value &&
              h("div", { class: "button-row" }, [
                btn(
                  `Subscribe to ${site.name}`,
                  () =>
                    void run(() => redirect(tenantApi(), "/platform/checkout")),
                  busy.value,
                ),
                btn(
                  "Platform billing",
                  () =>
                    void run(() => redirect(tenantApi(), "/platform/portal")),
                  busy.value,
                ),
              ]),
            keyVerification(),
            h("h3", "Tenant API keys"),
            renderKeyList(),
          ]);
        const panel = (id: SellerPage, title: string, children: unknown[]) =>
          h(
            "div",
            {
              id: `seller-panel-${id}`,
              class: "seller-view",
              role: "region",
              "aria-labelledby": `seller-nav-${id}`,
              hidden: activePage.value !== id,
            },
            [section(title, children)],
          );
        const setupCurrentProduct = () =>
          overview.value?.products.find(
            (product) => product.id === setupProduct.value,
          ) || overview.value?.products[0];
        const integrationKey = () => {
          const product = setupCurrentProduct();
          return product && seller.value && overview.value
            ? `entitle:setup:v1:${seller.value.user.id}:${overview.value.tenant.id}:${product.id}`
            : "";
        };
        const integrationConfirmed = () => {
          const key = integrationKey();
          if (!key) return false;
          if (integrationConfirmations.value[key]) return true;
          try {
            return window.sessionStorage.getItem(key) === "confirmed";
          } catch {
            return false;
          }
        };
        const setupSteps = () => {
          const data = overview.value!;
          const product = setupCurrentProduct();
          return [
            {
              id: "products",
              title: "Add a product",
              location: "Store → Products",
              description:
                "Name your software and choose its framework. Start with complimentary licensing; you can add paid plans later.",
              action: "Add your first product",
              complete: !!product,
              form: "product-create",
            },
            {
              id: "releases",
              title: "Publish a release",
              location: "Store → Releases",
              description:
                "Upload a versioned package or release asset for your product. Publication requires a fresh emailed verification link, so keep your inbox handy.",
              action: "Publish your first release",
              complete:
                !!product &&
                data.releases.some(
                  (release) =>
                    release.product_id === product.id && !release.withdrawn,
                ),
              form: "release-upload",
            },
            {
              id: "setup",
              title: "Connect your software",
              location: "Integrations → Client setup",
              description:
                "Copy your product’s configuration into your plugin or app, then confirm you’ve added it. Keep tenant API keys out of software distributed to customers. This checklist does not verify an installation.",
              action: "Open client setup",
              complete: integrationConfirmed(),
              form: "",
            },
            {
              id: "licenses",
              title: "Issue a license",
              location: "Store → Licenses",
              description:
                "Issue a complimentary license to yourself or an invited pilot. Choose an expiry and installation allowance, then use the emailed key in your software. No payment or subscription is created.",
              action: "Issue a complimentary license",
              complete:
                !!product &&
                data.licenses.some(
                  (license) =>
                    license.product_id === product.id &&
                    !license.revoked &&
                    !license.suspended &&
                    (license.provenance === "complimentary"
                      ? (license.expires_at ?? 0) > Date.now()
                      : (license.paid_through ?? 0) > Date.now()),
                ),
              form: "complimentary-issue",
            },
          ] as const;
        };
        const openSetup = () => {
          setupStep.value = null;
          guidedSetup.value = false;
          activePage.value = "onboarding";
          const workspace = selected.value;
          void nextTick(() => {
            if (
              activePage.value !== "onboarding" ||
              selected.value !== workspace
            )
              return;
            const panel = document.getElementById("seller-panel-onboarding");
            const heading = panel?.querySelector<HTMLElement>("h2");
            if (heading) {
              heading.tabIndex = -1;
              heading.focus({ preventScroll: true });
            }
            panel?.scrollIntoView?.({ block: "start" });
          });
        };
        const openSetupTask = (step: ReturnType<typeof setupSteps>[number]) => {
          const product = setupCurrentProduct();
          if (busy.value || (!product && step.id !== "products")) return;
          guidedSetup.value = true;
          setupStep.value = step.id;
          activePage.value = step.id;
          if (
            product &&
            step.id === "releases" &&
            fields.value["release-product"] !== product.id
          ) {
            file.value = null;
            fields.value["release-signature"] = "";
            fields.value["release-min-system-version"] = "";
            fields.value["release-product"] = product.id;
            fields.value["release-target"] =
              frameworkInfo[frameworkOf(product)].targets[0] || "";
          }
          if (product && step.id === "setup")
            fields.value["config-product"] = product.slug;
          if (product && step.id === "licenses")
            fields.value["complimentary-product"] = product.id;
          const workspace = selected.value;
          void nextTick(() => {
            if (selected.value !== workspace || activePage.value !== step.id)
              return;
            const panel = document.getElementById(`seller-panel-${step.id}`);
            if (step.complete && step.form) {
              const heading = panel?.querySelector<HTMLElement>("h2");
              if (heading) {
                heading.tabIndex = -1;
                heading.focus();
              }
              return;
            }
            const disclosure = panel?.querySelector<HTMLDetailsElement>(
              `#${step.form}-disclosure`,
            );
            if (disclosure) disclosure.open = true;
            panel
              ?.querySelector<HTMLElement>(
                step.form
                  ? `#${step.form} input, #${step.form} select`
                  : "#config-product",
              )
              ?.focus();
          });
        };
        const confirmIntegration = () => {
          const key = integrationKey();
          if (!key || busy.value) return;
          integrationConfirmations.value = {
            ...integrationConfirmations.value,
            [key]: true,
          };
          try {
            window.sessionStorage.setItem(key, "confirmed");
          } catch {
            /* Current-page progress still works when storage is unavailable. */
          }
          openSetup();
        };
        const renderSetupWizard = () => {
          const steps = setupSteps();
          const completed = steps.filter((step) => step.complete).length;
          const current =
            steps.find((step) => step.id === setupStep.value) ||
            steps.find((step) => !step.complete) ||
            steps[0];
          const index = steps.indexOf(current);
          const product = setupCurrentProduct();
          return h("div", { class: "setup-wizard" }, [
            h("div", { class: "setup-intro" }, [
              completed === steps.length &&
                h("h3", "Your setup checklist is complete"),
              h(
                "p",
                "Set up your first product, publish a release, and invite a customer. You can return to these steps anytime.",
              ),
              h(
                "p",
                { class: "setup-progress", role: "status" },
                `${completed} of ${steps.length} steps complete`,
              ),
              h("progress", {
                value: completed,
                max: steps.length,
                "aria-label": "Workspace setup progress",
              }),
            ]),
            overview.value!.products.length > 1 &&
              h("div", { class: "setup-product-picker" }, [
                select(
                  "setup-product",
                  "Set up a product",
                  overview.value!.products.map((item) => ({
                    value: item.id,
                    label: item.name,
                  })),
                ),
              ]),
            h("div", { class: "setup-layout" }, [
              h(
                "section",
                { class: "setup-task", "aria-labelledby": "setup-task-title" },
                [
                  h(
                    "p",
                    { class: "eyebrow" },
                    `Step ${index + 1} of ${steps.length}`,
                  ),
                  h("h3", { id: "setup-task-title" }, current.title),
                  h("p", current.description),
                  h("p", { class: "setup-location" }, [
                    h("span", "Find it anytime"),
                    h("strong", current.location),
                  ]),
                  product &&
                    h(
                      "p",
                      { class: "small muted" },
                      `Setting up ${product.name}`,
                    ),
                  !product &&
                    current.id !== "products" &&
                    h(
                      "p",
                      { class: "setup-prerequisite" },
                      "Add a product before continuing with this step.",
                    ),
                  h("div", { class: "button-row" }, [
                    btn(
                      current.complete && current.id !== "setup"
                        ? `Manage ${sellerPages.find((page) => page.id === current.id)!.label.toLowerCase()}`
                        : current.action,
                      () => openSetupTask(current),
                      busy.value || (!product && current.id !== "products"),
                    ),
                    index > 0 &&
                      btn(
                        "Previous step",
                        () => {
                          setupStep.value = steps[index - 1]!.id;
                        },
                        busy.value,
                      ),
                    current.complete &&
                      index < steps.length - 1 &&
                      btn(
                        "Next step",
                        () => {
                          setupStep.value = steps[index + 1]!.id;
                        },
                        busy.value,
                      ),
                  ]),
                ],
              ),
              h(
                "ol",
                { class: "setup-steps", "aria-label": "Setup steps" },
                steps.map((step, stepIndex) =>
                  h("li", [
                    h(
                      "button",
                      {
                        type: "button",
                        class: ["setup-step", step.complete && "is-complete"],
                        "aria-current":
                          current.id === step.id ? "step" : undefined,
                        disabled: busy.value,
                        onClick: () => {
                          setupStep.value = step.id;
                        },
                      },
                      [
                        h(
                          "span",
                          { class: "setup-step-number", "aria-hidden": "true" },
                          step.complete ? "✓" : String(stepIndex + 1),
                        ),
                        h("span", [
                          h("strong", step.title),
                          h(
                            "span",
                            { class: "setup-step-status" },
                            step.complete
                              ? step.id === "setup"
                                ? "Confirmed by you"
                                : "Complete"
                              : "To do",
                          ),
                        ]),
                      ],
                    ),
                  ]),
                ),
              ),
            ]),
            h("aside", { class: "setup-optional" }, [
              h("div", [
                h("h3", "Optional: offer paid plans"),
                h(
                  "p",
                  "Stripe is not required for this checklist or complimentary licenses. When you’re ready to charge customers, connect Stripe and configure paid plans in Billing.",
                ),
              ]),
              btn(
                "Explore Billing",
                () => {
                  guidedSetup.value = false;
                  activePage.value = "billing";
                },
                busy.value,
              ),
            ]),
          ]);
        };
        const renderSetupContext = () => {
          if (
            !guidedSetup.value ||
            !overview.value ||
            ["overview", "onboarding"].includes(activePage.value)
          )
            return null;
          const steps = setupSteps();
          const step = steps.find((item) => item.id === activePage.value);
          if (!step) return null;
          return h(
            "aside",
            { class: "setup-context", "aria-label": "Guided setup" },
            [
              h("div", [
                h(
                  "p",
                  { class: "eyebrow" },
                  `Setup · Step ${steps.indexOf(step) + 1} of ${steps.length}`,
                ),
                h("h2", step.title),
                h(
                  "p",
                  step.complete
                    ? "This step is complete. Return to the checklist for your next step."
                    : step.description,
                ),
              ]),
              h("div", { class: "button-row" }, [
                step.id === "setup" &&
                  !step.complete &&
                  btn(
                    "I’ve added the configuration",
                    confirmIntegration,
                    busy.value,
                  ),
                btn("Back to setup", openSetup, busy.value),
                btn(
                  "Exit guided setup",
                  () => {
                    guidedSetup.value = false;
                  },
                  busy.value,
                ),
              ]),
            ],
          );
        };
        const renderDashboard = () => {
          const data = overview.value!,
            m = data.metrics;
          return [
            panel("onboarding", "Your setup checklist", [renderSetupWizard()]),
            panel("billing", "Workspace status", [
              h("div", { class: "billing-layout" }, [
                h("section", { class: "feature-card" }, [
                  h("div", { class: "feature-section-heading" }, [
                    h("h3", "Customer payments"),
                    hosted.value &&
                      h(
                        "span",
                        { class: "feature-badge" },
                        stripeStatusLabel(data.tenant.stripe_status),
                      ),
                  ]),
                  h(
                    "p",
                    data.billingAvailable === false
                      ? "Paid checkout and billing are unavailable until Stripe is configured. You can issue complimentary licenses now."
                      : "Stripe is optional for product setup and complimentary licenses. Receive customer payments through your Stripe account when you are ready to sell paid plans.",
                  ),
                  hosted.value &&
                    h(
                      "p",
                      `${applicationFeePercent.value}% application fee on new customer subscriptions and their renewals. Stripe fees are separate.`,
                    ),
                  hosted.value
                    ? btn(
                        "Connect Stripe",
                        () =>
                          void run(() =>
                            redirect(tenantApi(), "/stripe/connect"),
                          ),
                        busy.value || data.billingAvailable === false,
                      )
                    : h(
                        "p",
                        "Standalone: no platform subscription or application fees.",
                      ),
                ]),
                h("section", { class: "feature-card" }, [
                  h("div", { class: "feature-section-heading" }, [
                    h(
                      "h3",
                      hosted.value
                        ? "Workspace subscription"
                        : "Your installation",
                    ),
                    hosted.value &&
                      h(
                        "span",
                        { class: "feature-badge" },
                        `${billingStatusLabel(data.tenant.billing_status)}${data.tenant.suspended ? " · Suspended" : ""}`,
                      ),
                  ]),
                  h("dl", { class: "billing-allowances" }, [
                    h("div", [
                      h("dt", "Products"),
                      h(
                        "dd",
                        `${data.products.length} of ${data.tenant.max_products}`,
                      ),
                    ]),
                    h("div", [
                      h("dt", "Storage allowance"),
                      h("dd", readableBytes(data.tenant.max_storage_bytes)),
                    ]),
                  ]),

                  hosted.value &&
                    h("div", { class: "button-row" }, [
                      !hasPlatformSubscription(data.tenant) &&
                        btn(
                          `Subscribe to ${site.name}`,
                          () =>
                            void run(() =>
                              redirect(tenantApi(), "/platform/checkout"),
                            ),
                          busy.value || data.billingAvailable === false,
                        ),
                      btn(
                        "Platform billing",
                        () =>
                          void run(() =>
                            redirect(tenantApi(), "/platform/portal"),
                          ),
                        busy.value || data.billingAvailable === false,
                      ),
                    ]),
                  hosted.value &&
                    h("details", { class: "billing-plan-details" }, [
                      h("summary", "Plan and billing details"),
                      h(
                        "p",
                        `Platform trial ends: ${data.tenant.trial_ends_at ? new Date(data.tenant.trial_ends_at).toLocaleDateString() : "Not applicable"}.`,
                      ),
                      h(
                        "p",
                        "To change tiers, cancel renewal in Platform billing, then choose a new tier after your paid subscription ends.",
                      ),
                      h(
                        "a",
                        {
                          href: applicationHref("/docs#hosted-tiers"),
                          target: "_blank",
                          rel: "noopener",
                        },
                        "View plans and billing guide",
                      ),
                    ]),
                ]),
              ]),
              h(
                "a",
                { href: applicationHref(`/t/${selected.value}`) },
                "Open buyer page",
              ),
            ]),
            activePage.value === "overview" &&
              h(
                "section",
                {
                  class: "panel setup-overview",
                  "aria-labelledby": "setup-overview-title",
                },
                [
                  h("div", [
                    h("p", { class: "eyebrow" }, "Getting started"),
                    h(
                      "h2",
                      { id: "setup-overview-title" },
                      setupSteps().every((step) => step.complete)
                        ? "Your workspace is set up"
                        : "Let’s get your software ready",
                    ),
                    h(
                      "p",
                      "A guided checklist for your first product, release, integration and license. Stripe is optional.",
                    ),
                  ]),
                  btn(
                    setupSteps().every((step) => step.complete)
                      ? "Review setup"
                      : setupSteps().some((step) => step.complete)
                        ? "Continue setup"
                        : "Start setup",
                    openSetup,
                    busy.value,
                  ),
                ],
              ),
            panel("overview", "Your workspace in numbers", [
              h(
                "p",
                { class: "muted" },
                "Your licenses, downloads and releases at a glance.",
              ),
              h("dl", { class: "overview-summary" }, [
                metric("Entitled licenses", m.licenses.entitled!),
                metric(
                  "Seats in use",
                  `${m.seats.used} / ${m.seats.allowance}`,
                ),
                metric("Downloads last 30 days", m.downloads.last30Days!),
                metric("Published releases", m.releases.published!),
              ]),
              h(
                "details",
                { id: "metrics-details", class: "metrics-details" },
                [
                  h("summary", "View all activity and storage metrics"),
                  h(
                    "p",
                    { class: "feature-description" },
                    "Downloads count successful server responses. Collected payments include taxes and exclude Stripe fees.",
                  ),
                  h("dl", { class: "metrics-grid" }, [
                    ...Object.entries(m.licenses).map(([label, value]) =>
                      metric(`Licenses ${label}`, value),
                    ),
                    ...Object.entries(m.installations).map(([label, value]) =>
                      metric(
                        `Installations ${label.replace(/([A-Z])/g, " $1").toLowerCase()}`,
                        value,
                      ),
                    ),
                    ...Object.entries(m.seats).map(([label, value]) =>
                      metric(`Seats ${label}`, value),
                    ),
                    ...Object.entries(m.releases).map(([label, value]) =>
                      metric(`Releases ${label}`, value),
                    ),
                    metric("Used storage bytes", m.storage.usedBytes!),
                    metric("Reserved storage bytes", m.storage.reservedBytes!),
                    metric("Storage limit bytes", m.storage.limitBytes!),
                    metric(
                      "Successful downloads",
                      m.downloads.successfulResponses!,
                    ),
                    metric("Downloads last 30 days", m.downloads.last30Days!),
                  ]),
                ],
              ),
              ...m.payments.map((payment) =>
                h("div", { class: "payment-totals" }, [
                  h("h3", payment.currency.toUpperCase()),
                  h("dl", { class: "metrics-grid" }, [
                    metric(
                      "Collected",
                      money(payment.currency, payment.paidMinor),
                    ),
                    metric(
                      "Refunded",
                      money(payment.currency, payment.refundedMinor),
                    ),
                    metric(
                      "Net collected",
                      money(payment.currency, payment.netMinor),
                    ),
                  ]),
                ]),
              ),
            ]),
            panel("products", "Products", [
              localMode.value &&
                h(
                  "p",
                  { class: "notice" },
                  "Local fixture prices. These are simulated, not live Stripe prices.",
                ),
              !prices.value.length &&
                h(
                  "p",
                  data.billingAvailable === false
                    ? "Create a product for complimentary licensing. Configure Stripe and an annual price before selling paid plans."
                    : "Create a product for complimentary licensing now. Connect Stripe and create an active annual recurring price to add a paid plan.",
                ),
              form(
                "product-create",
                async () => {
                  await tenantApi().post("/products", {
                    name: fields.value["product-name"],
                    slug: fields.value["product-slug"],
                    framework: fields.value["product-framework"],
                    frameworkConfig: productConfig(),
                    ...(fields.value["product-framework"] === "wordpress"
                      ? { pluginBasename: fields.value["plugin-basename"] }
                      : {}),
                    plans: !includePaidPlan.value
                      ? []
                      : [
                          {
                            name: fields.value["plan-name"],
                            siteAllowance: Number(
                              fields.value["site-allowance"],
                            ),
                            priceId: fields.value["price-id"],
                          },
                        ],
                  });
                  await dashboard();
                  notice.value = "Product created.";
                },
                [
                  field("product-name", "Product name"),
                  field("product-slug", "Product slug"),
                  select(
                    "product-framework",
                    "Framework",
                    Object.entries(frameworkInfo).map(([value, info]) => ({
                      value,
                      label: info.name,
                    })),
                  ),
                  fields.value["product-framework"] === "wordpress" &&
                    field("plugin-basename", "Plugin basename", "text", false),
                  fields.value["product-framework"] === "joomla" &&
                    h("div", [
                      select(
                        "joomla-extension-type",
                        "Extension type",
                        [
                          "plugin",
                          "component",
                          "module",
                          "template",
                          "package",
                          "library",
                        ].map((value) => ({ value, label: value })),
                      ),
                      field("joomla-element", "Extension element"),
                      field(
                        "joomla-folder",
                        "Plugin folder",
                        "text",
                        fields.value["joomla-extension-type"] === "plugin",
                      ),
                      select(
                        "joomla-client",
                        "Joomla client",
                        ["site", "administrator"].map((value) => ({
                          value,
                          label: value,
                        })),
                      ),
                      field("joomla-major", "Joomla major version", "number"),
                    ]),
                  fields.value["product-framework"] === "jetbrains" &&
                    h("div", [
                      field("jetbrains-plugin-id", "JetBrains plugin ID"),
                      field("jetbrains-since-build", "Since build"),
                      field(
                        "jetbrains-until-build",
                        "Until build",
                        "text",
                        false,
                      ),
                    ]),
                  fields.value["product-framework"] === "generic" &&
                    select(
                      "activation-kind",
                      "Activation kind",
                      ["device", "site"].map((value) => ({
                        value,
                        label: value,
                      })),
                    ),
                  h("div", { class: "form-field" }, [
                    h("label", { for: "include-paid-plan" }, [
                      h("input", {
                        id: "include-paid-plan",
                        type: "checkbox",
                        checked: includePaidPlan.value,
                        disabled:
                          data.billingAvailable === false ||
                          !prices.value.length,
                        onChange: (event: Event) => {
                          includePaidPlan.value = (
                            event.target as HTMLInputElement
                          ).checked;
                        },
                      }),
                      " Include annual paid plan",
                    ]),
                  ]),
                  includePaidPlan.value && field("plan-name", "Plan name"),
                  includePaidPlan.value &&
                    field(
                      "site-allowance",
                      seatUnit({
                        framework: fields.value[
                          "product-framework"
                        ] as Framework,
                        frameworkConfig: {
                          activationKind: fields.value["activation-kind"] as
                            "site" | "device",
                        },
                      }) === "site"
                        ? "Site allowance"
                        : "Device allowance",
                      "number",
                    ),
                  includePaidPlan.value &&
                    select(
                      "price-id",
                      "Annual Stripe price",
                      prices.value.map((price) => ({
                        value: price.id,
                        label: `${price.productName} · ${price.nickname || price.id} · ${price.unit_amount === null ? "Custom price" : money(price.currency, String(price.unit_amount))}/${price.interval}`,
                      })),
                    ),
                ],
                "Create product",
              ),
              h(
                "p",
                "Framework identity cannot change after licenses or releases exist. Create another product when its framework or identity changes.",
              ),
              h(
                "ul",
                { class: "record-list product-records" },
                data.products.map((product) =>
                  h("li", [
                    h("strong", product.name),
                    ` · ${product.slug} · ${frameworkInfo[frameworkOf(product)].name}${frameworkOf(product) === "wordpress" ? ` · ${product.plugin_basename}` : ""}`,
                    h(
                      "ul",
                      product.plans.map((plan) =>
                        h(
                          "li",
                          `${plan.name} · ${plan.site_allowance} ${seatUnit(product)}${plan.site_allowance === 1 ? "" : "s"} · ${plan.stripe_price_id}`,
                        ),
                      ),
                    ),
                  ]),
                ),
              ),
            ]),
            panel("releases", "Private releases", [
              h(
                "p",
                `Maximum ${releaseUploadLimit() / 1048576} MiB per asset. Framework package validation and tenant storage quotas are enforced by the server. Published version notes and target bytes cannot be replaced.`,
              ),
              form(
                "release-upload",
                async () => {
                  const framework = frameworkOf(releaseProduct());
                  if (!file.value)
                    throw new ApiError(
                      framework === "wordpress"
                        ? "Choose a plugin ZIP."
                        : "Choose a release asset.",
                    );
                  if (file.value.size > releaseUploadLimit())
                    throw new ApiError(
                      `Choose a ${framework === "wordpress" ? "ZIP" : "release asset"} no larger than ${releaseUploadLimit() / 1048576} MiB.`,
                    );
                  if (
                    frameworkInfo[framework].signature &&
                    !fields.value["release-signature"]!.trim()
                  )
                    throw new ApiError(
                      "A detached signature is required for this framework.",
                    );
                  const requirements = Object.fromEntries<string>(
                    (
                      [
                        ["minWp", fields.value["release-min-wp"]!.trim()],
                        ["minPhp", fields.value["release-min-php"]!.trim()],
                        ["minFree", fields.value["release-min-free"]!.trim()],
                        ["tested", fields.value["release-tested"]!.trim()],
                      ] as [string, string][]
                    ).filter(([, value]) => value),
                  );
                  if (
                    framework === "wordpress" &&
                    Object.values(requirements).some(
                      (value) => !/^\d+\.\d+(?:\.\d+)?$/.test(value),
                    )
                  )
                    throw new ApiError(
                      "Use numeric versions such as 6.0 or 8.1.2 for release requirements.",
                    );
                  const metadata = {
                    changelog: fields.value["release-changelog"],
                    ...(framework === "wordpress"
                      ? requirements
                      : {
                          target: fields.value["release-target"],
                          filename: file.value.name,
                          ...(fields.value["release-signature"]
                            ? { signature: fields.value["release-signature"] }
                            : {}),
                          ...(fields.value["release-min-system-version"]
                            ? {
                                minSystemVersion:
                                  fields.value["release-min-system-version"],
                              }
                            : {}),
                        }),
                  };
                  const encoded = btoa(
                    Array.from(
                      new TextEncoder().encode(JSON.stringify(metadata)),
                      (byte) => String.fromCharCode(byte),
                    ).join(""),
                  )
                    .replaceAll("+", "-")
                    .replaceAll("/", "_")
                    .replace(/=+$/, "");
                  const uploadApi = tenantApi();
                  const uploadPath = `/${framework === "wordpress" ? "releases" : "assets"}/${encodeURIComponent(releaseProduct()!.slug)}/${encodeURIComponent(fields.value["release-version"]!)}`;
                  const uploadBody = await file.value.arrayBuffer();
                  const proof =
                    fields.value["release-verification-token"] || "";
                  fields.value["release-verification-token"] = "";
                  const grant = await platform.post<{ verification: string }>(
                    "/account/verification/consume",
                    { purpose: "release_publish", token: proof },
                  );
                  await uploadApi.request(uploadPath, {
                    method: "POST",
                    headers: {
                      "Content-Type":
                        framework === "wordpress"
                          ? "application/zip"
                          : "application/octet-stream",
                      "X-CSRF-Token": platform.csrfToken,
                      "X-Release-Metadata": encoded,
                      "X-Account-Verification": grant.verification,
                    },
                    body: uploadBody,
                  });
                  await dashboard();
                  notice.value = "Release published.";
                },
                [
                  h(
                    "p",
                    "Browser publication requires a fresh email token for purpose release_publish. Scoped API keys can publish from CI.",
                  ),
                  btn(
                    "Email release verification",
                    () =>
                      void run(async () => {
                        await platform.post("/account/verification/request", {
                          purpose: "release_publish",
                        });
                        notice.value =
                          "Check your email for the release publication token.";
                      }),
                    busy.value,
                  ),
                  field(
                    "release-verification-token",
                    "Release publication email verification token",
                    "password",
                  ),
                  select(
                    "release-product",
                    "Release product",
                    data.products.map((product) => ({
                      value: product.id,
                      label: product.name,
                    })),
                  ),
                  field("release-version", "Version"),
                  field("release-changelog", "Release notes", "text", false),
                  ...(frameworkOf(releaseProduct()) === "wordpress"
                    ? [
                        field(
                          "release-min-wp",
                          "Minimum WordPress",
                          "text",
                          false,
                        ),
                        field("release-min-php", "Minimum PHP", "text", false),
                        field(
                          "release-min-free",
                          "Minimum free plugin",
                          "text",
                          false,
                        ),
                        field(
                          "release-tested",
                          "Tested WordPress",
                          "text",
                          false,
                        ),
                      ]
                    : [
                        frameworkOf(releaseProduct()) === "generic"
                          ? field("release-target", "Target")
                          : select(
                              "release-target",
                              "Target",
                              frameworkInfo[
                                frameworkOf(releaseProduct())
                              ].targets.map((value) => ({
                                value,
                                label: value,
                              })),
                            ),
                        field(
                          "release-signature",
                          "Detached signature",
                          "text",
                          frameworkInfo[frameworkOf(releaseProduct())]
                            .signature,
                        ),
                        field(
                          "release-min-system-version",
                          "Minimum system version",
                          "text",
                          false,
                        ),
                      ]),
                  h("div", { class: "form-field" }, [
                    h(
                      "label",
                      { for: "release-file" },
                      frameworkOf(releaseProduct()) === "wordpress"
                        ? "Plugin ZIP"
                        : "Release asset",
                    ),
                    h("input", {
                      id: "release-file",
                      key: fields.value["release-product"]!,
                      type: "file",
                      accept:
                        frameworkInfo[frameworkOf(releaseProduct())].accept,
                      required: true,
                      onChange: (event: Event) => {
                        file.value =
                          (event.target as HTMLInputElement).files?.[0] || null;
                      },
                    }),
                  ]),
                ],
                "Publish release",
              ),
              h(
                "ul",
                { class: "record-list release-records" },
                data.releases.map((release) =>
                  h("li", [
                    `Version ${release.version} · ${release.withdrawn ? "Withdrawn" : "Published"} `,
                    h(
                      "ul",
                      release.assets?.map((asset) =>
                        h(
                          "li",
                          `${asset.target} · ${asset.filename} · ${readableBytes(asset.size)} · SHA-256 ${asset.checksum}`,
                        ),
                      ),
                    ),
                    !release.withdrawn &&
                      btn(
                        "Withdraw release",
                        () =>
                          confirm(
                            `Withdraw version ${release.version}?`,
                            "Confirm withdrawal",
                            async () => {
                              await tenantApi().post(
                                `/releases/${encodeURIComponent(release.id)}/withdraw`,
                                {},
                              );
                            },
                          ),
                        busy.value,
                      ),
                  ]),
                ),
              ),
            ]),
            panel("setup", "Client setup", [
              select(
                "config-product",
                "Configuration product",
                data.products.map((product) => ({
                  value: product.slug,
                  label: product.name,
                })),
              ),
              h(
                "label",
                { for: "php-config" },
                frameworkOf(configProduct()) === "wordpress"
                  ? "Tenant-specific PHP configuration"
                  : "Tenant-specific setup configuration",
              ),
              h("textarea", {
                id: "php-config",
                readonly: true,
                rows: 5,
                value: config(),
              }),
              btn(
                frameworkOf(configProduct()) === "wordpress"
                  ? "Copy PHP configuration"
                  : "Copy setup configuration",
                () => void run(() => copy(config(), "php-config")),
                busy.value,
              ),
            ]),
            panel("licenses", "Licenses", [
              form(
                "complimentary-issue",
                async () => {
                  const input = {
                    email:
                      fields.value["complimentary-email"]!.trim().toLowerCase(),
                    productId: fields.value["complimentary-product"]!,
                    siteAllowance: Number(
                      fields.value["complimentary-allowance"],
                    ),
                    expiresAt: new Date(
                      fields.value["complimentary-expiry"]!,
                    ).getTime(),
                    note: fields.value["complimentary-note"]!.trim(),
                  };
                  if (
                    !Number.isSafeInteger(input.siteAllowance) ||
                    input.siteAllowance < 1 ||
                    input.siteAllowance > 100000 ||
                    !Number.isFinite(input.expiresAt) ||
                    input.expiresAt <= Date.now()
                  ) {
                    error.value =
                      "Choose an installation allowance from 1 to 100000 and a future expiration date.";
                    return;
                  }
                  const signature = JSON.stringify([selected.value, input]);
                  if (complimentaryDraft?.signature !== signature)
                    complimentaryDraft = {
                      signature,
                      requestId: crypto.randomUUID(),
                    };
                  const request = {
                    ...input,
                    requestId: complimentaryDraft.requestId,
                    confirm: true,
                  };
                  const api = tenantApi();
                  const product = data.products.find(
                    (p) => p.id === input.productId,
                  )!;
                  confirm(
                    `Issue a complimentary ${product.name} license to ${input.email}, allowing ${input.siteAllowance} installations until ${new Date(input.expiresAt).toLocaleString()}? No payment or subscription will be created.`,
                    "Confirm complimentary license",
                    async () => {
                      await api.post("/licenses/complimentary", request);
                      complimentaryDraft = null;
                      fields.value["complimentary-email"] = "";
                      fields.value["complimentary-note"] = "";
                      notice.value =
                        "License issued; license key email queued.";
                    },
                  );
                },
                [
                  h(
                    "p",
                    "Issue a normal license without a payment or subscription. Expiration stops new activations, downloads and updates; installed software keeps working.",
                  ),
                  field("complimentary-email", "Customer email", "email"),
                  select(
                    "complimentary-product",
                    "Product",
                    data.products.map((p) => ({ value: p.id, label: p.name })),
                  ),
                  field(
                    "complimentary-allowance",
                    "Installation allowance",
                    "number",
                  ),
                  field(
                    "complimentary-expiry",
                    "Expiration date and time (your local time)",
                    "datetime-local",
                  ),
                  field(
                    "complimentary-note",
                    "Internal note (optional)",
                    "text",
                    false,
                  ),
                ],
                "Issue complimentary license",
              ),
              h("div", { class: "table-scroll" }, [
                h("table", [
                  h("caption", "Customer entitlements for this workspace"),
                  h("thead", [
                    h(
                      "tr",
                      [
                        "Customer",
                        "Product and plan",
                        "Seats",
                        "Billing",
                        "Paid through / Expires",
                        "Access",
                        "Action",
                      ].map((label) => h("th", { scope: "col" }, label)),
                    ),
                  ]),
                  h(
                    "tbody",
                    data.licenses.map((license) =>
                      h("tr", [
                        h("td", license.customer_email),
                        h(
                          "td",
                          `${license.product_name} · ${license.provenance === "complimentary" ? "Complimentary" : license.plan_name}`,
                        ),
                        h("td", String(license.site_allowance)),
                        h(
                          "td",
                          license.provenance === "complimentary"
                            ? "Complimentary · no subscription"
                            : license.billing_status,
                        ),
                        h(
                          "td",
                          (
                            license.provenance === "complimentary"
                              ? license.expires_at
                              : license.paid_through
                          )
                            ? new Date(
                                (license.provenance === "complimentary"
                                  ? license.expires_at
                                  : license.paid_through)!,
                              ).toLocaleDateString()
                            : "Not yet available",
                        ),
                        h(
                          "td",
                          license.revoked
                            ? "Revoked"
                            : license.suspended
                              ? "Suspended"
                              : license.provenance === "complimentary"
                                ? "See expiration"
                                : "See paid through",
                        ),
                        h(
                          "td",
                          btn(
                            license.revoked
                              ? "Restore license"
                              : "Revoke license",
                            () =>
                              confirm(
                                `${license.revoked ? "Restore" : "Revoke"} ${license.product_name} for ${license.customer_email}?`,
                                license.revoked
                                  ? "Confirm restore license"
                                  : "Confirm revoke license",
                                async () => {
                                  await tenantApi().post(
                                    `/licenses/${encodeURIComponent(license.id)}/revoke`,
                                    { revoked: !license.revoked },
                                  );
                                },
                              ),
                            busy.value,
                          ),
                        ),
                      ]),
                    ),
                  ),
                ]),
              ]),
            ]),
            panel("keys", "API keys", [
              keyVerification(),
              h(
                "p",
                "Use tenant API keys for server automation. Never include them in distributed plugins or browser code.",
              ),
              form(
                "key-create",
                async () => {
                  const proof = fields.value["key-verification-token"] || "";
                  fields.value["key-verification-token"] = "";
                  const result = await verifiedRequest<{ token: string }>(
                    platform,
                    tenantApi(),
                    "api_keys",
                    proof,
                    "/keys",
                    {
                      name: fields.value["key-name"],
                      scopes: keyScopes.value,
                      expiresInDays: Number(fields.value["key-expiry"]),
                    },
                  );
                  secret.value = result.token;
                  keys.value = (
                    await tenantApi().get<{ keys: Key[] }>("/keys")
                  ).keys;
                },
                [
                  field("key-name", "API key name"),
                  h("fieldset", [
                    h("legend", "API key permissions"),
                    ...[
                      ["read", "Read workspace data"],
                      ["catalog:write", "Manage products and plans"],
                      ["releases:write", "Publish and withdraw releases"],
                      ["licenses:write", "Manage licenses"],
                      ["billing:reconcile", "Reconcile billing"],
                      ["data:export", "Export encrypted tenant data"],
                      ["operations:write", "Manage operations and webhooks"],
                    ].map(([scope, label]) =>
                      h("label", [
                        h("input", {
                          type: "checkbox",
                          value: scope,
                          checked: keyScopes.value.includes(scope!),
                          onChange: (event: Event) => {
                            keyScopes.value = (event.target as HTMLInputElement)
                              .checked
                              ? [...keyScopes.value, scope!]
                              : keyScopes.value.filter(
                                  (value) => value !== scope,
                                );
                          },
                        }),
                        label,
                      ]),
                    ),
                  ]),
                  select(
                    "key-expiry",
                    "API key expires after",
                    [1, 7, 30, 90, 180, 365].map((days) => ({
                      value: String(days),
                      label: `${days} ${days === 1 ? "day" : "days"}`,
                    })),
                  ),
                ],
                "Create API key",
              ),
              secret.value &&
                h("div", { class: "key-notice" }, [
                  h(
                    "p",
                    "This API key is shown once. Save it securely before dismissing it.",
                  ),
                  h("label", { for: "new-api-key" }, "New tenant API key"),
                  h("input", {
                    id: "new-api-key",
                    readonly: true,
                    type: "text",
                    value: secret.value,
                    autocomplete: "off",
                    spellcheck: false,
                  }),
                  h("div", { class: "button-row" }, [
                    btn(
                      "Copy API key",
                      () => void run(() => copy(secret.value, "new-api-key")),
                      busy.value,
                    ),
                    btn("I saved my API key", () => {
                      secret.value = "";
                    }),
                  ]),
                ]),
              renderKeyList(),
            ]),
          ];
        };
        const layoutClass = () =>
          seller.value?.tenants.length
            ? "seller-layout"
            : "seller-layout seller-onboarding";
        return () =>
          h("div", { class: "app seller-app" }, [
            h("a", { href: "#main", class: "skip-link" }, "Skip to content"),
            appHeader(),
            h("main", { id: "main", class: "page-main seller-main" }, [
              seller.value &&
                seller.value.tenants.length > 0 &&
                workspaceControls(),
              h("div", { class: "page-heading" }, [
                h("div", [
                  h("p", { class: "eyebrow" }, "Seller workspace"),
                  h(
                    "h1",
                    overview.value
                      ? sellerPages.find(
                          (page) => page.id === activePage.value,
                        )!.label
                      : recovery.value
                        ? "Workspace recovery"
                        : "Your software business",
                  ),
                  seller.value && h("p", seller.value.user.email),
                ]),
                seller.value &&
                  btn(
                    "Sign out",
                    () =>
                      void run(async () => {
                        await platform.post("/auth/logout", {});
                        clearSession();
                      }),
                    busy.value,
                  ),
              ]),
              overview.value?.sandbox?.isSandbox &&
                h("div", { class: "notice sandbox-badge", role: "status" }, [
                  h("strong", "TEST WORKSPACE"),
                  h(
                    "p",
                    `${overview.value.sandbox.mode} sandbox for ${overview.value.sandbox.parentSlug}. Test data is separate from the publisher's live workspace.`,
                  ),
                  h(
                    "p",
                    `API origin: ${window.location.origin}/api/v1/tenants/${encodeURIComponent(selected.value)}`,
                  ),
                  h(
                    "a",
                    {
                      href: applicationHref(
                        `/t/${encodeURIComponent(selected.value)}`,
                      ),
                    },
                    "Open test buyer page",
                  ),
                ]),
              error.value &&
                h(
                  "div",
                  {
                    role: "alert",
                    class: [
                      "seller-alert",
                      stripeConnectionNeeded.value && "seller-alert-warning",
                    ],
                  },
                  [
                    h("div", { class: "seller-alert-copy" }, [
                      h(
                        "h2",
                        stripeConnectionNeeded.value
                          ? "Stripe connection needed"
                          : "We couldn’t complete that request",
                      ),
                      h("p", error.value),
                      stripeConnectionNeeded.value &&
                        h(
                          "p",
                          "Open Billing to connect Stripe and load paid plans. You can keep setting up products and issuing complimentary licenses in the meantime.",
                        ),
                      errorReference.value &&
                        h("details", { class: "seller-alert-details" }, [
                          h("summary", "Support details"),
                          h("p", `Reference: ${errorReference.value}`),
                        ]),
                    ]),
                    h("div", { class: "button-row" }, [
                      stripeConnectionNeeded.value &&
                        overview.value &&
                        btn("Open Billing", () => {
                          activePage.value = "billing";
                          error.value = "";
                        }),
                      btn("Dismiss", () => {
                        error.value = "";
                      }),
                    ]),
                  ],
                ),
              notice.value &&
                h("p", { role: "status", class: "notice" }, notice.value),
              busy.value && h("p", { role: "status" }, "Working…"),
              !loading.value &&
                !seller.value &&
                token.value !== null &&
                section("Confirm seller sign in", [
                  h(
                    "p",
                    "Use your emailed link to sign in. The link is single-use.",
                  ),
                  h("div", { class: "button-row" }, [
                    btn(
                      "Confirm seller sign in",
                      () =>
                        void run(async () => {
                          await platform.post(
                            "/auth/consume",
                            { token: token.value },
                            false,
                          );
                          token.value = null;
                          clearSession();
                          await session();
                        }, false),
                      busy.value || !token.value,
                    ),
                    btn("Cancel sign in", () => {
                      token.value = null;
                    }),
                  ]),
                ]),
              loading.value
                ? h("p", { role: "status" }, "Loading seller session…")
                : !seller.value
                  ? section("Sign in to sell", [
                      h(
                        "p",
                        "Create your seller account or sign in with an email link.",
                      ),
                      form(
                        "seller-login",
                        async () => {
                          await platform.post(
                            "/auth/request",
                            { email: fields.value["seller-email"]!.trim() },
                            false,
                          );
                          notice.value = "Check your email for a sign-in link.";
                        },
                        [field("seller-email", "Email address", "email")],
                        "Email seller sign-in link",
                      ),
                      h(
                        "details",
                        {
                          class: "account-recovery",
                          onToggle: (event: Event) => {
                            recoveryOpen.value = (
                              event.target as HTMLDetailsElement
                            ).open;
                          },
                        },
                        [
                          h("summary", "Use a recovery code"),
                          recoveryOpen.value &&
                            h(SellerFeaturePanel, {
                              page: "recovery",
                              api: platform,
                              platform,
                              hosted: hosted.value,
                              products: [],
                              confirm,
                              onSignedOut: () => void run(session),
                            }),
                        ],
                      ),
                      error.value &&
                        btn(
                          "Retry session",
                          () => void run(session),
                          busy.value,
                        ),
                    ])
                  : h("div", { class: layoutClass() }, [
                      seller.value.tenants.length > 0 &&
                        h(
                          "aside",
                          {
                            class: "seller-sidebar",
                            "aria-label": "Workspace navigation",
                          },
                          [
                            overview.value &&
                              h(
                                "nav",
                                {
                                  "aria-label": "Workspace navigation",
                                  class: "seller-nav",
                                },
                                [
                                  h(
                                    "label",
                                    {
                                      class: "seller-mobile-nav",
                                      for: "seller-mobile-page",
                                    },
                                    [
                                      "Go to",
                                      h(
                                        "select",
                                        {
                                          id: "seller-mobile-page",
                                          value: activePage.value,
                                          disabled: busy.value,
                                          onChange: (event: Event) => {
                                            activePage.value = (
                                              event.target as HTMLSelectElement
                                            ).value as SellerPage;
                                          },
                                        },
                                        sellerPages.map((page) =>
                                          h(
                                            "option",
                                            { value: page.id },
                                            page.label,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                  h("div", { class: "seller-desktop-nav" }, [
                                    ...sellerPages
                                      .filter((page) =>
                                        ["overview", "onboarding"].includes(
                                          page.id,
                                        ),
                                      )
                                      .map((page) =>
                                        h(
                                          "button",
                                          {
                                            id: `seller-nav-${page.id}`,
                                            type: "button",
                                            class: "seller-nav-link",
                                            "aria-controls": `seller-panel-${page.id}`,
                                            "aria-current":
                                              activePage.value === page.id
                                                ? "page"
                                                : undefined,
                                            disabled: busy.value,
                                            onClick: () => {
                                              activePage.value = page.id;
                                            },
                                          },
                                          page.label,
                                        ),
                                      ),
                                    ...sellerPageGroups.map((group) =>
                                      h("div", { class: "seller-nav-group" }, [
                                        h("p", group.label),
                                        ...sellerPages
                                          .filter((page) =>
                                            group.pages.includes(page.id),
                                          )
                                          .map((page) =>
                                            h(
                                              "button",
                                              {
                                                id: `seller-nav-${page.id}`,
                                                type: "button",
                                                class: "seller-nav-link",
                                                "aria-controls": `seller-panel-${page.id}`,
                                                "aria-current":
                                                  activePage.value === page.id
                                                    ? "page"
                                                    : undefined,
                                                disabled: busy.value,
                                                onClick: () => {
                                                  activePage.value = page.id;
                                                },
                                              },
                                              page.label,
                                            ),
                                          ),
                                      ]),
                                    ),
                                  ]),
                                ],
                              ),
                          ],
                        ),
                      h("div", { class: "seller-content" }, [
                        renderSetupContext(),
                        seller.value.tenants.length === 0 &&
                          section("Create your first workspace", [
                            h(
                              "p",
                              "Use the form below to get started. Add a product, publish a release and issue complimentary licenses for an invited pilot. Connect Stripe when you’re ready to offer paid plans.",
                            ),
                            hosted.value && workspaceForm(),
                          ]),
                        recovery.value && renderRecovery(),
                        (recovery.value || seller.value.tenants.length === 0) &&
                          h(
                            "div",
                            { class: "button-row seller-account-actions" },
                            [
                              btn(
                                "Account security",
                                () => {
                                  activePage.value = "security";
                                },
                                busy.value,
                              ),
                            ],
                          ),
                        accountProof.value &&
                          h("div", { class: "panel verification-proof" }, [
                            h(
                              "p",
                              "Choose the purpose of the verification email you requested. The token can approve only that action in this browser.",
                            ),
                            h(
                              "select",
                              {
                                "aria-label": "Verification purpose",
                                value: proofPurpose.value,
                                onChange: (event: Event) => {
                                  proofPurpose.value = (
                                    event.target as HTMLSelectElement
                                  ).value;
                                },
                              },
                              [
                                h(
                                  "option",
                                  { value: "api_keys" },
                                  "API key change",
                                ),
                                h(
                                  "option",
                                  { value: "recovery_codes" },
                                  "Recovery codes",
                                ),
                                h(
                                  "option",
                                  { value: "release_publish" },
                                  "Publish a release",
                                ),
                                h(
                                  "option",
                                  { value: "tenant_transfer" },
                                  "Tenant export",
                                ),
                              ],
                            ),
                            btn(
                              "Continue with verification link",
                              () => {
                                if (proofPurpose.value === "api_keys") {
                                  fields.value["key-verification-token"] =
                                    accountProof.value;
                                  activePage.value = "keys";
                                } else if (
                                  proofPurpose.value === "release_publish"
                                ) {
                                  fields.value["release-verification-token"] =
                                    accountProof.value;
                                  activePage.value = "releases";
                                } else {
                                  const page =
                                    proofPurpose.value === "recovery_codes"
                                      ? "security"
                                      : "export";
                                  panelProof.value = {
                                    page,
                                    token: accountProof.value,
                                  };
                                  proofRound.value++;
                                  activePage.value = page;
                                }
                                accountProof.value = "";
                                notice.value = "";
                              },
                              busy.value,
                            ),
                          ]),
                        overview.value && renderDashboard(),
                        seller.value &&
                          [
                            "commerce",
                            "sandbox",
                            "operations",
                            "webhooks",
                            "security",
                            "export",
                          ].includes(activePage.value) &&
                          h(
                            "div",
                            {
                              id: `seller-panel-${activePage.value}`,
                              class: "seller-view",
                              role: "region",
                              "aria-labelledby": overview.value
                                ? `seller-nav-${activePage.value}`
                                : undefined,
                              "aria-label": sellerPages.find(
                                (page) => page.id === activePage.value,
                              )!.label,
                            },
                            [
                              h(SellerFeaturePanel, {
                                key: `${selected.value}:${activePage.value}:${proofRound.value}`,
                                page: activePage.value,
                                embedded: !!overview.value,
                                api: tenantApi(),
                                platform,
                                hosted: hosted.value,
                                subscribed: hasPlatformSubscription(
                                  overview.value?.tenant,
                                ),
                                products: overview.value?.products || [],
                                confirm: (
                                  title: string,
                                  label: string,
                                  action: () => Promise<void>,
                                ) => {
                                  confirmation.value = {
                                    title,
                                    label,
                                    run: action,
                                  };
                                },
                                emailChange:
                                  activePage.value === "security"
                                    ? emailChange.value
                                    : null,
                                "onUpdate:emailChange": retainEmailChange,
                                initialToken:
                                  panelProof.value?.page === activePage.value
                                    ? panelProof.value.token
                                    : "",
                                invalidateProof: (
                                  page: string,
                                  token: string,
                                ) => {
                                  if (
                                    panelProof.value?.page === page &&
                                    panelProof.value.token === token
                                  )
                                    panelProof.value = null;
                                },
                                onExpired: clearSession,
                                onSignedOut: () => {
                                  clearSession();
                                  void run(session);
                                },
                              }),
                            ],
                          ),
                      ]),
                    ]),
              confirmation.value &&
                h(SellerConfirmation, {
                  title: confirmation.value.title,
                  label: confirmation.value.label,
                  onCancel: () => {
                    confirmation.value = null;
                  },
                  onConfirm: () => {
                    const action = confirmation.value!.run;
                    confirmation.value = null;
                    void run(action);
                  },
                }),
            ]),
            h("footer", { class: "site-footer" }, [
              h(
                "a",
                { href: applicationHref("/docs#licensing") },
                "Source & licenses",
              ),
            ]),
          ]);
      },
    }),
  );
  app.mount(target);
  return app;
}
