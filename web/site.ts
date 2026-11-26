import {
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  toRaw,
  type PropType,
} from "vue";
import { ApiClient, ApiError, errorMessage } from "./api.ts";
import {
  frameworkInfo,
  frameworkOf,
  installationName,
  seatUnit,
  setupConfiguration,
} from "./frameworks.ts";
import type { Framework, FrameworkProduct, ReleaseAsset } from "./api.ts";
import { type Tenant, workspaceArchived } from "../packages/shared/tenant.ts";
import { WorkspaceManager } from "./workspaces.ts";
import { site } from "../packages/shared/site.ts";
import { saveBlob, SellerFeaturePanel, verifiedRequest } from "./features.ts";
import {
  hardwareVerification,
  passkeyCeremony,
  privilegedPolicyOf,
} from "./oidc.ts";
import type { PrivilegedPolicy } from "./oidc.ts";
import { formatMinorAmount as money, planPrice } from "./checkout.ts";
import type { EmailChangeDraft } from "./features.ts";
import { appHeader, sellerHelpLink } from "./chrome.ts";
import { applicationHref } from "./navigation.ts";
import { disclosureLabel, icon, icons } from "./icons.ts";

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
    unit_amount?: number | null;
    currency?: string | null;
    billing_interval?: string | null;
    archived_at?: number | null;
  }[];
}
interface SellerInstallation {
  id: string;
  site_url: string;
  label?: string | null;
  active: boolean;
  exempt: boolean;
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
    internal_note?: string | null;
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
type SellerLicense = Overview["licenses"][number];
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
  { id: "overview", label: "Overview", icon: icons.grid },
  { id: "onboarding", label: "Getting started", icon: icons.compass },
  { id: "products", label: "Products", icon: icons.box },
  { id: "releases", label: "Releases", icon: icons.upload },
  { id: "licenses", label: "Licenses", icon: icons.ticket },
  { id: "setup", label: "Client setup", icon: icons.code },
  { id: "keys", label: "API keys", icon: icons.key },
  { id: "billing", label: "Billing", icon: icons.card },
  { id: "commerce", label: "Tax settings", icon: icons.receipt },
  { id: "sandbox", label: "Sandbox", icon: icons.flask },
  { id: "operations", label: "Operations", icon: icons.pulse },
  { id: "webhooks", label: "Webhooks", icon: icons.webhook },
  { id: "security", label: "Account security", icon: icons.shield },
  { id: "export", label: "Export", icon: icons.download },
  { id: "workspaces", label: "Workspaces", icon: icons.workspace },
] as const;
const sellerPageGroups = [
  {
    label: "Products & sales",
    pages: ["products", "releases", "licenses", "billing", "commerce"],
  },
  { label: "Integrations", pages: ["setup", "keys", "webhooks", "sandbox"] },
  {
    label: "Administration",
    pages: ["operations", "security", "export", "workspaces"],
  },
];
type SellerPage = (typeof sellerPages)[number]["id"];
const licenseColumns = [
  "Customer",
  "Product and plan",
  "Seats",
  "Billing",
  "Paid through / Expires",
  "Access",
] as const;
const releaseVersions = new Intl.Collator("en", { numeric: true });
const copyIcon = "M8 8h12v12H8Z M16 8V4H4v12h4";

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
const licenseBillingLabel = (license: Overview["licenses"][number]) => {
  if (license.provenance === "complimentary") return "No subscription";
  const label =
    (
      ({
        active: "Active",
        canceled: "Canceled",
        cancelled: "Canceled",
        refunded: "Refunded",
        trialing: "Trial",
        trial: "Trial",
        past_due: "Past due",
        unpaid: "Unpaid",
        incomplete: "Incomplete",
        incomplete_expired: "Expired",
        paused: "Paused",
      }) as Record<string, string>
    )[license.billing_status] || license.billing_status.replaceAll("_", " ");
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : "";
};
const licenseExpiry = (license: SellerLicense) =>
  license.provenance === "complimentary"
    ? license.expires_at
    : license.paid_through;
const licenseAccessLabel = (license: SellerLicense, now: number) => {
  if (license.revoked) return "Revoked";
  if (license.suspended) return "Suspended";
  if (license.billing_status === "lifetime") return "Active";
  const expires = licenseExpiry(license);
  if (!expires) return "Pending";
  return expires <= now ? "Expired" : "Active";
};
const matchesLicenseStatus = (
  license: SellerLicense,
  status: string,
  now: number,
) => {
  switch (status) {
    case "":
      return true;
    case "expiring": {
      const expires = licenseExpiry(license);
      return (
        license.billing_status !== "lifetime" &&
        licenseAccessLabel(license, now) === "Active" &&
        expires != null &&
        expires <= now + 30 * 86400000
      );
    }
    case "canceled":
      return license.billing_status === "canceled";
    case "lifetime":
      return license.billing_status === "lifetime";
    default:
      return licenseAccessLabel(license, now).toLowerCase() === status;
  }
};
const localDateTime = (timestamp: number | null | undefined) => {
  if (timestamp == null) return "";
  const value = new Date(timestamp);
  return new Date(timestamp - value.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
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
const btn = (
  label: string,
  action: () => void,
  disabled = false,
  options: { icon?: string; class?: string | undefined } = {},
) =>
  h(
    "button",
    { type: "button", onClick: action, disabled, class: options.class },
    options.icon ? [icon(options.icon), label] : label,
  );
const metadata = (value: string) =>
  h("code", { class: "metadata-chip" }, value);
const keyDate = (label: string, value: number | null, fallback: string) => {
  const date = value === null ? null : new Date(value);
  return h("span", { class: "key-fact" }, [
    `${label}: `,
    date && Number.isFinite(date.getTime())
      ? h(
          "time",
          { class: "metadata-chip", datetime: date.toISOString() },
          date.toLocaleDateString(),
        )
      : fallback,
  ]);
};
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
const policyCopy: Record<
  PrivilegedPolicy,
  { keys: string; release: string; browser: string }
> = {
  hardware: {
    keys: "API key changes require fresh hardware verification. Keep two independent keys provisioned with your Entitle operator.",
    release: "Publication requires fresh hardware verification.",
    browser:
      "Browser publication requires fresh hardware verification. Use trusted OIDC publishers from CI.",
  },
  passkey: {
    keys: "API key changes require fresh verification with a passkey or security key on this account.",
    release:
      "Publication requires fresh verification with a passkey or security key.",
    browser:
      "Browser publication requires fresh verification with a passkey or security key. Use trusted OIDC publishers from CI.",
  },
};

const SellerConfirmation = defineComponent({
  props: {
    title: { type: String, required: true },
    label: { type: String, required: true },
    description: { type: String as PropType<string | undefined> },
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
          props.description && h("p", props.description),
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
          panelProof = ref<{
            page: SellerPage;
            token: string;
          } | null>(null),
          proofPurpose = ref("security_enroll");
        const panelPurpose = ref("");
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
        const signInRecipient = ref("");
        const setupStep = ref<string | null>(null);
        const guidedSetup = ref(false);
        const integrationConfirmations = ref<Record<string, boolean>>({});
        const slugEdited = ref(false);
        const workspaceCreateOpen = ref(false);
        const licenseQuery = ref("");
        const licenseProduct = ref("");
        const licenseType = ref("");
        const licenseAccess = ref("");
        const editLicenseId = ref("");
        const licenseSort = ref<(typeof licenseColumns)[number]>("Customer");
        const licenseDescending = ref(false);
        const sortLicenses = (column: (typeof licenseColumns)[number]) => {
          licenseDescending.value =
            licenseSort.value === column && !licenseDescending.value;
          licenseSort.value = column;
        };
        const resetLicenseFilters = () => {
          licenseQuery.value = "";
          licenseProduct.value = "";
          licenseType.value = "";
          licenseAccess.value = "";
        };
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
            description?: string | undefined;
            run: () => Promise<void>;
          } | null>(null);
        const privilegedPolicy = ref<PrivilegedPolicy>("hardware"),
          editProduct = ref(""),
          addPlan = ref(false),
          inspected = ref<{
            license: Overview["licenses"][number];
            installations: SellerInstallation[];
            nextCursor: string | null;
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
          "key-name": "",
          "key-expiry": "90",
          "config-product": "",
          "complimentary-email": "",
          "complimentary-product": "",
          "complimentary-allowance": "1",
          "complimentary-expiry": "",
          "complimentary-note": "",
          "edit-product-name": "",
          "edit-plan-name": "",
          "edit-site-allowance": "1",
          "edit-price-id": "",
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
          includePaidPlan.value = false;
          secret.value = "";

          selected.value = "";
          fields.value["tenant-name"] = "";
          fields.value["tenant-slug"] = "";
          slugEdited.value = false;
          workspaceCreateOpen.value = false;
          signInRecipient.value = "";
          clearComplimentary();
          complimentaryWorkspace = "";
          privilegedPolicy.value = "hardware";
          editProduct.value = "";
          addPlan.value = false;
          inspected.value = null;
          editLicenseId.value = "";
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
            includePaidPlan.value = false;
            resetLicenseFilters();
            licenseSort.value = "Customer";
            licenseDescending.value = false;
            guidedSetup.value = false;
            setupProduct.value = "";
            setupStep.value = null;
            clearComplimentary();
            editProduct.value = "";
            addPlan.value = false;
            inspected.value = null;
            editLicenseId.value = "";
            complimentaryWorkspace = selected.value;
          }
          panelProof.value = null;
          overview.value = null;
          recovery.value = false;
          file.value = null;
          keys.value = [];
          prices.value = [];
          secret.value = "";

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
            if (data.billingAvailable === false || !priceData.prices.length)
              includePaidPlan.value = false;
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
        const session = async (keepRecovery = false) => {
          let value: Seller;
          try {
            value = await platform.get<Seller>("/me");
          } catch (failure) {
            if (
              failure instanceof ApiError &&
              failure.code === "recovery_restricted"
            ) {
              clearSession();
              recoveryOpen.value = true;
              return;
            }
            if (!(failure instanceof ApiError) || failure.status !== 401)
              throw failure;
            clearSession();
            // Set in the same tick so the recovery result is never unmounted.
            if (keepRecovery) recoveryOpen.value = true;
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
            value.tenants.find((item) => !workspaceArchived(item))?.slug ||
            value.tenants[0]?.slug ||
            "";
          await Promise.all([
            dashboard(),
            platform
              .get<{ privilegedPolicy?: string }>("/account/security")
              .then(
                (security) => {
                  privilegedPolicy.value = privilegedPolicyOf(
                    security.privilegedPolicy,
                  );
                },
                // Policy-specific guidance is optional; the hardware wording is the safe default.
                () => undefined,
              ),
          ]);
        };
        const refreshWorkspaces = async (message: string) => {
          const ownerId = seller.value!.user.id;
          const value = await platform.get<Seller>("/me");
          if (
            !seller.value ||
            seller.value.user.id !== ownerId ||
            value.user.id !== ownerId
          )
            return;
          seller.value.tenants = value.tenants;
          const current = value.tenants.find(
            (item) => item.slug === selected.value,
          );
          if (!current || workspaceArchived(current))
            selected.value =
              value.tenants.find((item) => !workspaceArchived(item))?.slug ||
              current?.slug ||
              value.tenants[0]?.slug ||
              "";
          await dashboard();
          notice.value = message;
        };
        const readToken = () => {
          const fragment = new URLSearchParams(window.location.hash.slice(1));
          if (fragment.has("account-verification")) {
            panelProof.value = null;
            // Remount an open panel so it drops any earlier, now-superseded proof.
            proofRound.value++;
            accountProof.value = fragment.get("account-verification") || "";
            notice.value =
              "Verification link received. Choose the action you requested below.";
            activePage.value = "security";
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
          // run() clears messages; keep those set by a link opened on this load.
          const linkNotice = notice.value,
            linkError = error.value;
          void run(async () => {
            const info = await platform.get<Info>("/info");
            hosted.value = info.deploymentMode !== "standalone";
            applicationFeePercent.value = info.applicationFeePercent ?? 0;
            maxUpload.value = info.maxUploadBytes;
            maxNativeUpload.value = info.maxNativeUploadBytes ?? 104857600;
            await session();
            if (seller.value) {
              notice.value = linkNotice;
              if (linkError) error.value = linkError;
            }
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
              max: [
                "complimentary-allowance",
                "edit-license-allowance",
              ].includes(id)
                ? 100000
                : undefined,
              maxlength:
                id === "tenant-slug"
                  ? 63
                  : id === "tenant-name"
                    ? 200
                    : ["complimentary-note", "edit-license-note"].includes(id)
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
                    ? setupCurrentProduct()!.id
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
                    (["complimentary-issue", "release-upload"].includes(id) &&
                      !overview.value?.products.length) ||
                    (id === "product-edit" &&
                      addPlan.value &&
                      !unmappedPrices().length),
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
                h("summary", disclosureLabel(label, icons.plus)),
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
              h(
                "p",
                { class: "workspace-form-intro" },
                "Create one workspace for the business or brand that publishes your apps or plugins.",
              ),
              h("div", { class: "form-field" }, [
                field("tenant-name", "Business or publisher name"),
                h(
                  "p",
                  { class: "field-hint" },
                  "For example, Doublesharp. You’ll name your plugins and apps when you add products.",
                ),
              ]),
              h("div", { class: "workspace-slug-field" }, [
                field("tenant-slug", "Workspace slug"),
                h(
                  "p",
                  { id: "tenant-slug-hint", class: "field-hint" },
                  "This permanent slug appears in buyer and API URLs. Use up to 63 lowercase letters, numbers, and hyphens. You can edit it before creating the workspace.",
                ),
              ]),
            ],
            "Create publisher workspace",
          );
        const signOut = () =>
          void run(async () => {
            await platform.post("/auth/logout", {});
            clearSession();
          });
        const closeMobileTools = () => {
          document
            .querySelector<HTMLDetailsElement>(".seller-mobile-tools")
            ?.removeAttribute("open");
        };
        const mobileTools = () =>
          h(
            "details",
            {
              class: "seller-mobile-tools",
              onKeydown: (event: KeyboardEvent) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                const menu = event.currentTarget as HTMLDetailsElement;
                menu.open = false;
                menu.querySelector("summary")?.focus();
              },
            },
            [
              h(
                "summary",
                { "aria-label": "Workspace and account actions" },
                disclosureLabel("More", icons.more),
              ),
              h("div", { class: "seller-mobile-tools-content" }, [
                h(
                  "p",
                  { class: "seller-account-email" },
                  seller.value!.user.email,
                ),
                btn(
                  "Refresh dashboard",
                  () => {
                    closeMobileTools();
                    void run(dashboard);
                  },
                  busy.value,
                  { icon: icons.refresh },
                ),
                btn(
                  "New workspace",
                  () => {
                    closeMobileTools();
                    workspaceCreateOpen.value = true;
                    void nextTick(() =>
                      document.getElementById("tenant-name")?.focus(),
                    );
                  },
                  busy.value,
                  { icon: icons.plus },
                ),
                btn("Sign out", signOut, busy.value, { icon: icons.logout }),
              ]),
            ],
          );
        const workspaceControls = () =>
          h(
            "section",
            { class: "workspace-toolbar", "aria-label": "Workspace controls" },
            [
              h("div", { class: "workspace-toolbar-row" }, [
                hosted.value &&
                  h("div", { class: "workspace-selector" }, [
                    h("div", { class: "workspace-selector-title" }, [
                      h("label", { for: "tenant-select" }, [
                        icon(icons.workspace),
                        "Publisher workspace",
                      ]),
                      h(
                        "p",
                        {
                          id: "workspace-selector-hint",
                          class: "workspace-selector-hint",
                        },
                        "Your business or brand",
                      ),
                    ]),
                    h(
                      "select",
                      {
                        id: "tenant-select",
                        "aria-describedby": "workspace-selector-hint",
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
                      seller
                        .value!.tenants.filter(
                          (item) =>
                            !workspaceArchived(item) ||
                            item.slug === selected.value,
                        )
                        .toSorted((a, b) =>
                          a.name.localeCompare(b.name, undefined, {
                            sensitivity: "base",
                          }),
                        )
                        .map((item) =>
                          h(
                            "option",
                            { value: item.slug },
                            `${item.name}${workspaceArchived(item) ? " · Archived" : ""}`,
                          ),
                        ),
                    ),
                  ]),
                btn(
                  "Refresh dashboard",
                  () => void run(dashboard),
                  busy.value,
                  {
                    icon: icons.refresh,
                  },
                ),
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
                  [
                    h("summary", disclosureLabel("New workspace", icons.plus)),
                    workspaceForm(),
                  ],
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
          description?: string,
        ) => {
          confirmation.value = {
            title,
            label,
            description,
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
        const sellerInstallationName = (item: SellerInstallation) =>
          installationName({ ...item, installation_id: item.id });
        const planSummary = (
          product: SellerProduct,
          plan: SellerProduct["plans"][number],
        ) => {
          const price = planPrice(plan);
          return [
            `${plan.name} · ${plan.site_allowance} ${seatUnit(product)}${plan.site_allowance === 1 ? "" : "s"} · `,
            metadata(plan.stripe_price_id),
            price && ` · ${price}`,
            plan.archived_at && " · Archived",
          ];
        };
        const startEdit = (product: SellerProduct) => {
          editProduct.value = product.id;
          addPlan.value = false;
          fields.value["edit-product-name"] = product.name;
          fields.value["edit-plan-name"] = "";
          fields.value["edit-site-allowance"] = "1";
          void nextTick(() =>
            document.getElementById("edit-product-name")?.focus(),
          );
        };
        const exportLicenses = async () => {
          const api = tenantApi();
          const query = new URLSearchParams({ format: "csv" });
          for (const [key, value] of Object.entries({
            productId: licenseProduct.value,
            provenance: licenseType.value,
            status: licenseAccess.value,
            q: licenseQuery.value.trim(),
          })) {
            if (value) query.set(key, value);
          }
          const csv = await api.request<Blob>(
            `/licenses/export?${query}`,
            { headers: { Accept: "text/csv" } },
            "blob",
          );
          saveBlob(csv, `${selected.value}-licenses.csv`);
        };
        const startLicenseEdit = (license: SellerLicense) => {
          editLicenseId.value = license.id;
          fields.value["edit-license-note"] = license.internal_note ?? "";
          fields.value["edit-license-expiry"] =
            license.provenance === "complimentary"
              ? localDateTime(license.expires_at)
              : "";
          fields.value["edit-license-allowance"] = String(
            license.site_allowance,
          );
          void nextTick(() =>
            document.getElementById("edit-license-note")?.focus(),
          );
        };
        const licenseEditor = (license: SellerLicense) => {
          const complimentary = license.provenance === "complimentary";
          return h(
            "tr",
            {
              key: `editor-${license.id}`,
              class: "license-edit-row",
              role: "row",
            },
            [
              h("td", { colspan: 7, role: "cell" }, [
                form(
                  "license-edit",
                  async () => {
                    const patch: {
                      internalNote: string;
                      expiresAt?: number;
                      siteAllowance?: number;
                    } = {
                      internalNote: fields.value["edit-license-note"]!.trim(),
                    };
                    if (complimentary) {
                      const expiration = fields.value["edit-license-expiry"]!;
                      const expirationChanged =
                        expiration !== localDateTime(license.expires_at);
                      const siteAllowance = Number(
                        fields.value["edit-license-allowance"],
                      );
                      const expiresAt = new Date(expiration).getTime();
                      if (
                        !Number.isSafeInteger(siteAllowance) ||
                        siteAllowance < 1 ||
                        siteAllowance > 100000 ||
                        (expirationChanged &&
                          (!Number.isFinite(expiresAt) ||
                            expiresAt <= Date.now()))
                      ) {
                        error.value =
                          "Choose a future expiration date and an installation allowance from 1 to 100000.";
                        return;
                      }
                      if (expirationChanged) patch.expiresAt = expiresAt;
                      if (siteAllowance !== license.site_allowance)
                        patch.siteAllowance = siteAllowance;
                    }
                    const api = tenantApi();
                    await api.request(
                      `/licenses/${encodeURIComponent(license.id)}`,
                      {
                        method: "PATCH",
                        headers: {
                          "Content-Type": "application/json",
                          "X-CSRF-Token": api.csrfToken,
                        },
                        body: JSON.stringify(patch),
                      },
                    );
                    editLicenseId.value = "";
                    await dashboard();
                    notice.value = "License updated.";
                  },
                  [
                    h("h3", `Edit license for ${license.customer_email}`),
                    field("edit-license-note", "Internal note", "text", false),
                    ...(complimentary
                      ? [
                          field(
                            "edit-license-expiry",
                            "Expiration date and time (your local time)",
                            "datetime-local",
                            Boolean(license.expires_at),
                          ),
                          field(
                            "edit-license-allowance",
                            "Installation allowance",
                            "number",
                          ),
                        ]
                      : [
                          h(
                            "p",
                            { class: "small muted" },
                            "Stripe manages expiration and installation allowance for paid licenses.",
                          ),
                        ]),
                    btn(
                      "Cancel edit",
                      () => {
                        editLicenseId.value = "";
                      },
                      busy.value,
                      { class: "button-secondary" },
                    ),
                  ],
                  "Save license",
                ),
              ]),
            ],
          );
        };
        const archivePlan = (plan: SellerProduct["plans"][number]) =>
          confirm(
            `${plan.archived_at ? "Restore" : "Archive"} the ${plan.name} plan?`,
            plan.archived_at ? "Confirm restore plan" : "Confirm archive plan",
            async () => {
              await tenantApi().post(
                `/plans/${encodeURIComponent(plan.id)}/archive`,
                { archived: !plan.archived_at },
              );
            },
            plan.archived_at
              ? "Buyers can choose this plan again at checkout."
              : "New buyers can no longer choose this plan. Existing licenses are not changed.",
          );
        const loadInstallations = async (
          license: Overview["licenses"][number],
          after = "",
        ) => {
          const result = await tenantApi().get<{
            installations: SellerInstallation[];
            nextCursor: string | null;
          }>(
            `/licenses/${encodeURIComponent(license.id)}${after ? `?after=${encodeURIComponent(after)}` : ""}`,
          );
          inspected.value = {
            license,
            installations: [
              ...(after ? inspected.value!.installations : []),
              ...result.installations,
            ],
            nextCursor: result.nextCursor,
          };
        };
        const deactivateInstallation = (
          license: Overview["licenses"][number],
          installation: SellerInstallation,
        ) =>
          confirm(
            `Deactivate ${sellerInstallationName(installation)}?`,
            "Confirm deactivation",
            async () => {
              await tenantApi().post(
                `/licenses/${encodeURIComponent(license.id)}/installations/${encodeURIComponent(installation.id)}/deactivate`,
                {},
              );
              await loadInstallations(license);
              notice.value = "Installation deactivated.";
            },
            "It stops receiving licensed updates and frees its seat. Installed software stays available, and the customer can activate it again with their license key.",
          );
        // A Stripe price maps to one plan per workspace, archived plans included.
        const unmappedPrices = () =>
          prices.value.filter(
            (price) =>
              !overview.value!.products.some((product) =>
                product.plans.some((plan) => plan.stripe_price_id === price.id),
              ),
          );
        const priceOptions = (list: Price[]) =>
          list.map((price) => ({
            value: price.id,
            label: `${price.productName} · ${price.nickname || price.id} · ${
              price.unit_amount === null
                ? "Custom price"
                : price.interval === "lifetime"
                  ? planPrice({ ...price, billing_interval: "lifetime" })
                  : `${money(price.currency, price.unit_amount)}/${price.interval}`
            }`,
          }));
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
        const renderClientSetup = () => {
          const product = configProduct();
          const origin = window.location.origin;
          const slug = fields.value["config-product"] || "your-product";
          const endpoint = `${origin}/api/v1/tenants/${encodeURIComponent(selected.value)}`;
          const framework = frameworkOf(product);
          const wordpress = framework === "wordpress";
          const configuration = setupConfiguration(
            product,
            origin,
            selected.value,
            slug,
          );
          return h("div", { class: "client-setup" }, [
            select(
              "config-product",
              "Configuration product",
              overview.value!.products.map((item) => ({
                value: item.slug,
                label: item.name,
              })),
            ),
            h("section", { class: "feature-card client-adapter" }, [
              h("h3", { class: "panel-icon-heading" }, [
                icon(icons.code),
                `${frameworkInfo[framework].name} adapter`,
              ]),
              h("dl", { class: "record-metadata client-adapter-metadata" }, [
                h("div", [
                  h("dt", "Tenant API endpoint"),
                  h("dd", metadata(endpoint)),
                ]),
                h("div", [h("dt", "Product slug"), h("dd", metadata(slug))]),
                wordpress && product?.plugin_basename
                  ? h("div", [
                      h("dt", "Plugin basename"),
                      h("dd", metadata(product.plugin_basename)),
                    ])
                  : null,
              ]),
              h("div", { class: "client-config" }, [
                h("div", { class: "client-config-heading" }, [
                  h(
                    "label",
                    { for: "php-config" },
                    wordpress
                      ? "Tenant-specific PHP configuration"
                      : "Tenant-specific setup configuration",
                  ),
                  btn(
                    wordpress
                      ? "Copy PHP configuration"
                      : "Copy setup configuration",
                    () => void run(() => copy(configuration, "php-config")),
                    busy.value,
                    { icon: copyIcon },
                  ),
                ]),
                h("textarea", {
                  id: "php-config",
                  readonly: true,
                  rows: 5,
                  value: configuration,
                }),
              ]),
            ]),
          ]);
        };
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
          h("p", policyCopy[privilegedPolicy.value].keys);
        const renderKeyList = () =>
          h(
            "ul",
            { class: "record-list key-records" },
            keys.value.map((key) => {
              const revoked = key.revoked_at !== null;
              const status = revoked
                ? "Revoked"
                : key.expires_at === null
                  ? "Replace required"
                  : key.expires_at <= Date.now()
                    ? "Expired"
                    : "Active";
              return h("li", { key: key.id }, [
                h("div", { class: "key-record-heading" }, [
                  h("h3", key.name),
                  h(
                    "span",
                    {
                      class: [
                        "feature-badge",
                        revoked
                          ? "is-revoked"
                          : status === "Active"
                            ? "is-active"
                            : "is-attention",
                      ],
                    },
                    status,
                  ),
                ]),
                h("div", { class: "record-metadata key-facts" }, [
                  h("span", { class: "key-fact" }, [
                    "Prefix: ",
                    metadata(key.display_prefix),
                  ]),
                  h("span", { class: "key-fact" }, [
                    "Permissions: ",
                    metadata((JSON.parse(key.scopes) as string[]).join(", ")),
                  ]),
                  keyDate("Created", key.created_at, "Unavailable"),
                  keyDate("Last used", key.last_used_at, "Never"),
                  keyDate("Expires", key.expires_at, "Unavailable"),
                ]),
                !revoked &&
                  btn(
                    "Revoke API key",
                    () =>
                      confirm(
                        `Revoke API key ${key.name}?`,
                        "Confirm revoke API key",
                        async () => {
                          const proof = "";

                          await verifiedRequest(
                            platform,
                            tenantApi(),
                            "api_keys",
                            proof,
                            `/keys/${encodeURIComponent(key.id)}/revoke`,
                            {},
                          );
                        },
                        "Automation that uses this key stops working immediately.",
                      ),
                    busy.value,
                    { class: "button-danger" },
                  ),
              ]);
            }),
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
        const sellerNavItem = (page: (typeof sellerPages)[number]) =>
          h(
            "button",
            {
              id: `seller-nav-${page.id}`,
              type: "button",
              class: "seller-nav-link",
              "aria-controls": `seller-panel-${page.id}`,
              "aria-current": activePage.value === page.id ? "page" : undefined,
              disabled: busy.value,
              onClick: () => {
                activePage.value = page.id;
              },
            },
            [icon(page.icon), page.label],
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
              location: "Products & sales → Products",
              description:
                "Add a plugin or app and choose its framework. The framework locks after the first license or release.",
              action: "Add your first product",
              complete: !!product,
              form: "product-create",
            },
            {
              id: "releases",
              title: "Publish a release",
              location: "Products & sales → Releases",
              description:
                `Upload a versioned package or release asset for your product. ${policyCopy[privilegedPolicy.value].release}`,
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
                "Copy the configuration into your plugin or app and mark this step complete. Test activation and an update in your software before inviting customers. Keep workspace API keys out of distributed builds.",
              action: "Open client setup",
              complete: integrationConfirmed(),
              form: "",
            },
            {
              id: "licenses",
              title: "Issue a license",
              location: "Products & sales → Licenses",
              description:
                "Choose the installation allowance and expiration, then issue a complimentary license to yourself or an invited customer. Use the emailed key to activate the software.",
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
        const setupStepStatus = (step: { id: string; complete: boolean }) =>
          step.complete
            ? step.id === "setup"
              ? "Confirmed by you"
              : "Complete"
            : "To do";
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
                completed === steps.length
                  ? "Test activation, downloads, and updates through your client before sharing the release."
                  : "Set up a product, publish a release, connect your client, and issue a license.",
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
              h("div", { class: "form-field setup-step-picker" }, [
                h("label", { for: "setup-current-step" }, "Current step"),
                h(
                  "select",
                  {
                    id: "setup-current-step",
                    value: current.id,
                    disabled: busy.value,
                    onChange: (event: Event) => {
                      setupStep.value = (
                        event.target as HTMLSelectElement
                      ).value;
                    },
                  },
                  steps.map((step, stepIndex) =>
                    h(
                      "option",
                      { value: step.id },
                      `${stepIndex + 1}. ${step.title} — ${setupStepStatus(step)}`,
                    ),
                  ),
                ),
              ]),
              h(
                "ol",
                { class: "setup-steps", "aria-label": "Setup steps" },
                steps.map((step, stepIndex) =>
                  h("li", { key: step.id }, [
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
                          step.complete
                            ? icon(icons.check)
                            : String(stepIndex + 1),
                        ),
                        h("span", [
                          h("strong", step.title),
                          h(
                            "span",
                            {
                              class: [
                                "setup-step-status",
                                "feature-badge",
                                step.complete && "is-active",
                              ],
                            },
                            setupStepStatus(step),
                          ),
                        ]),
                      ],
                    ),
                  ]),
                ),
              ),
              h(
                "section",
                { class: "setup-task", "aria-labelledby": "setup-task-title" },
                [
                  h(
                    "p",
                    { class: "eyebrow" },
                    `Step ${index + 1} of ${steps.length}`,
                  ),
                  h(
                    "h3",
                    { id: "setup-task-title", class: "panel-icon-heading" },
                    [
                      icon(sellerPages.find((page) => page.id === current.id)!.icon),
                      current.title,
                    ],
                  ),
                  h("p", current.description),
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
                      { icon: icons.arrow },
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
                        { icon: icons.arrow },
                      ),
                  ]),
                  h("p", { class: "setup-location" }, [
                    h("span", "Dashboard location"),
                    h("strong", current.location),
                  ]),
                ],
              ),
            ]),
            h("aside", { class: "setup-optional" }, [
              h("div", [
                h("h3", "Offer paid plans"),
                h(
                  "p",
                  hosted.value
                    ? "To sell, connect your Stripe account in Billing, then add a plan in Products. You can issue complimentary licenses before connecting Stripe."
                    : "To sell, configure Stripe on your server, then add a plan in Products. You can issue complimentary licenses before configuring Stripe.",
                ),
              ]),
              btn(
                "Open Billing",
                () => {
                  guidedSetup.value = false;
                  activePage.value = "billing";
                },
                busy.value,
                { icon: icons.card },
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
          const stripeStatus = data.tenant.stripe_status;
          const billingStatus = data.tenant.billing_status;
          const billingNeedsAttention =
            data.tenant.suspended ||
            ["past_due", "unpaid", "incomplete", "incomplete_expired", "paused"].includes(
              billingStatus,
            );
          const allDownloadsInWindow =
            m.downloads.successfulResponses === m.downloads.last30Days;
          const releasedProducts = new Set(
            data.releases
              .filter((release) => !release.withdrawn)
              .map((release) => release.product_id),
          ).size;
          const now = Date.now();
          const access = (license: SellerLicense) =>
            licenseAccessLabel(license, now);
          const sortValue = (
            license: SellerLicense,
          ): string | number | null | undefined => {
            switch (licenseSort.value) {
              case "Product and plan":
                return `${license.product_name} ${license.plan_name}`;
              case "Seats":
                return license.site_allowance;
              case "Billing":
                return license.provenance === "complimentary"
                  ? "Complimentary"
                  : license.billing_status;
              case "Paid through / Expires":
                return licenseExpiry(license);
              case "Access":
                return access(license);
              default:
                return license.customer_email;
            }
          };
          const editing = data.products.find(
            (product) => product.id === editProduct.value,
          );
          const activeFilterCount = [
            licenseProduct.value,
            licenseType.value,
            licenseAccess.value,
          ].filter(Boolean).length;
          const hasLicenseFilters = Boolean(
            licenseQuery.value.trim() || activeFilterCount,
          );
          const licenses = data.licenses
            .filter((license) => {
              const query = licenseQuery.value.trim().toLowerCase();
              return (
                (!query ||
                  [
                    license.customer_email,
                    license.product_name,
                    license.plan_name,
                    license.id,
                    license.billing_status,
                    licenseBillingLabel(license),
                    license.provenance === "complimentary"
                      ? "complimentary"
                      : "paid",
                  ]
                    .join(" ")
                    .toLowerCase()
                    .includes(query)) &&
                (!licenseProduct.value ||
                  license.product_id === licenseProduct.value) &&
                (!licenseType.value ||
                  (license.provenance === "complimentary"
                    ? "complimentary"
                    : "paid") === licenseType.value) &&
                matchesLicenseStatus(license, licenseAccess.value, now)
              );
            })
            .sort((a, b) => {
              const left = sortValue(a),
                right = sortValue(b);
              if (left == null || right == null)
                return left == null && right == null
                  ? a.id.localeCompare(b.id)
                  : left == null
                    ? 1
                    : -1;
              const result =
                typeof left === "number" && typeof right === "number"
                  ? left - right
                  : String(left).localeCompare(String(right), undefined, {
                      sensitivity: "base",
                      numeric: true,
                    });
              return (
                (licenseDescending.value ? -result : result) ||
                a.id.localeCompare(b.id)
              );
            });
          const filterSelect = (
            id: string,
            label: string,
            value: typeof licenseProduct,
            options: [string, string][],
          ) =>
            h("div", { class: "form-field" }, [
              h("label", { for: id }, label),
              h(
                "select",
                {
                  id,
                  value: value.value,
                  onChange: (event: Event) => {
                    value.value = (event.target as HTMLSelectElement).value;
                  },
                },
                options.map(([id, label]) => h("option", { value: id }, label)),
              ),
            ]);
          return [
            panel("onboarding", "Your setup checklist", [renderSetupWizard()]),
            panel("billing", "Workspace status", [
              h("div", { class: "billing-layout" }, [
                h("section", { class: "feature-card" }, [
                  h("div", { class: "feature-section-heading" }, [
                    h("h3", { class: "panel-icon-heading" }, [
                      icon(icons.card),
                      "Customer payments",
                    ]),
                    hosted.value &&
                      h(
                        "span",
                        {
                          class: [
                            "feature-badge",
                            ["connected", "platform"].includes(stripeStatus) &&
                              "is-active",
                            ["restricted", "disconnected"].includes(stripeStatus) &&
                              "is-attention",
                          ],
                        },
                        stripeStatusLabel(stripeStatus),
                      ),
                  ]),
                  h(
                    "p",
                    data.billingAvailable === false
                      ? hosted.value
                        ? "Paid checkout is unavailable on this deployment. You can still issue complimentary licenses."
                        : "Configure Stripe on your server to enable paid checkout. You can issue complimentary licenses now."
                      : hosted.value && stripeStatus !== "connected"
                        ? "Connect Stripe to accept payments. You can issue complimentary licenses before connecting."
                        : "Paid purchases go through your Stripe account. Add a monthly, annual, or lifetime plan in Products to offer it to buyers.",
                  ),
                  hosted.value &&
                    h("p", [
                      h(
                        "strong",
                        { class: "tabular-numbers" },
                        `${applicationFeePercent.value}%`,
                      ),
                      " application fee on new customer subscriptions and their renewals. Stripe fees are separate.",
                    ]),
                  hosted.value
                    ? btn(
                        "Connect Stripe",
                        () =>
                          void run(() =>
                            redirect(tenantApi(), "/stripe/connect"),
                          ),
                        busy.value || data.billingAvailable === false,
                        { icon: icons.external },
                      )
                    : h(
                        "p",
                        "Standalone: no platform subscription or application fees.",
                      ),
                ]),
                h("section", { class: "feature-card" }, [
                  h("div", { class: "feature-section-heading" }, [
                    h("h3", { class: "panel-icon-heading" }, [
                      icon(icons.receipt),
                      hosted.value
                        ? "Workspace subscription"
                        : "Your installation",
                    ]),
                    hosted.value &&
                      h(
                        "span",
                        {
                          class: [
                            "feature-badge",
                            billingNeedsAttention
                              ? "is-attention"
                              : ["active", "trial", "trialing"].includes(billingStatus) &&
                                "is-active",
                          ],
                        },
                        `${billingStatusLabel(billingStatus)}${data.tenant.suspended ? " · Suspended" : ""}`,
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
                          { icon: icons.external },
                        ),
                      btn(
                        "Platform billing",
                        () =>
                          void run(() =>
                            redirect(tenantApi(), "/platform/portal"),
                          ),
                        busy.value || data.billingAvailable === false,
                        { icon: icons.external },
                      ),
                    ]),
                  hosted.value &&
                    h("details", { class: "billing-plan-details" }, [
                      h(
                        "summary",
                        disclosureLabel("Plan and billing details", icons.card),
                      ),
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
                        ["View plans and billing guide", icon(icons.external)],
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
                  class: [
                    "panel setup-overview",
                    data.products.length
                      ? "setup-overview-compact"
                      : "setup-overview-empty",
                  ],
                  "aria-labelledby": "setup-overview-title",
                },
                [
                  icon(icons.compass, "ui-icon setup-overview-icon"),
                  h("div", { class: "setup-overview-copy" }, [
                    h("p", { class: "eyebrow" }, "Getting started"),
                    h(
                      "h2",
                      { id: "setup-overview-title" },
                      setupSteps().every((step) => step.complete)
                        ? "Setup checklist complete"
                        : "Set up your first product",
                    ),
                    h(
                      "p",
                      setupSteps().every((step) => step.complete)
                        ? "Test activation and updates in your software before sharing your release."
                        : "Publish a release, configure your client, and issue a license. You can start with a complimentary license.",
                    ),
                  ]),
                  data.products.length === 0 &&
                    h(
                      "ol",
                      {
                        class: "setup-overview-steps",
                        "aria-label": "Setup steps",
                      },
                      setupSteps().map((step, index) =>
                        h(
                          "li",
                          {
                            key: step.id,
                            class: step.complete && "setup-overview-done",
                          },
                          [
                            h(
                              "span",
                              {
                                class: "setup-overview-step-number",
                                "aria-hidden": "true",
                              },
                              step.complete ? icon(icons.check) : String(index + 1),
                            ),
                            h("span", step.title),
                          ],
                        ),
                      ),
                    ),
                  data.products.length === 0
                    ? h("div", { class: "setup-overview-actions" }, [
                        btn("Start setup", openSetup, busy.value, {
                          class: "setup-overview-primary",
                        }),
                        btn(
                          "Create your first product",
                          () => openSetupTask(setupSteps()[0]),
                          busy.value,
                          {
                            icon: icons.plus,
                            class: "button-secondary setup-overview-secondary",
                          },
                        ),
                      ])
                    : btn(
                        setupSteps().every((step) => step.complete)
                          ? "Review setup"
                          : setupSteps().some((step) => step.complete)
                            ? "Continue setup"
                            : "Start setup",
                        openSetup,
                        busy.value,
                        { class: "setup-overview-primary" },
                      ),
                ],
              ),
            panel("overview", "Your workspace in numbers", [
              h(
                "dl",
                {
                  class: [
                    "overview-summary",
                    data.products.length === 0 && "overview-summary-empty",
                  ],
                },
                [
                  metric("Entitled licenses", m.licenses.entitled!),
                  metric(
                    "Seats in use",
                    `${m.seats.used} / ${m.seats.allowance}`,
                  ),
                  metric("Downloads last 30 days", m.downloads.last30Days!),
                  metric("Published releases", m.releases.published!),
                ],
              ),
              h(
                "section",
                {
                  class: "workspace-structure",
                  "aria-label": "Workspace and products",
                },
                [
                  h("div", { class: "workspace-structure-publisher" }, [
                    h("p", { class: "eyebrow" }, "Publisher workspace"),
                    h("h3", data.tenant.name),
                  ]),
                  h("div", { class: "workspace-structure-products" }, [
                    h("p", { class: "eyebrow" }, "Products · plugins & apps"),
                    h(
                      "h3",
                      `${data.products.length} ${data.products.length === 1 ? "product" : "products"} in this workspace`,
                    ),
                    h(
                      "p",
                      data.products.length
                        ? data.products
                            .slice(0, 3)
                            .map((product) => product.name)
                            .join(" · ") +
                            (data.products.length > 3
                              ? ` · +${data.products.length - 3} more`
                              : "")
                        : "Add your first plugin or app as a product.",
                    ),
                    btn(
                      data.products.length
                        ? "Manage products"
                        : "Add a product",
                      () => {
                        activePage.value = "products";
                      },
                      busy.value,
                    ),
                  ]),
                  h(
                    "p",
                    { class: "workspace-shared-settings" },
                    "Products share the workspace’s Stripe connection, access, API keys, and storage allowance.",
                  ),
                ],
              ),
              h(
                "section",
                {
                  id: "metrics-details",
                  class: "analytics-overview",
                  "aria-label": "Activity and capacity",
                },
                [
                  h("div", { class: "analytics-section-heading" }, [
                    h("h3", "Activity & capacity"),
                    h(
                      "p",
                      "Reports cover the selected workspace. Open its sandbox to see test activity.",
                    ),
                  ]),
                  h("div", { class: "analytics-grid" }, [
                    h("section", { class: "analytics-card" }, [
                      h("h4", "Licenses"),
                      h(
                        "dl",
                        Object.entries(m.licenses)
                          .filter(([label]) => label !== "entitled")
                          .map(([label, value]) =>
                            metric(
                              label.charAt(0).toUpperCase() + label.slice(1),
                              value.toLocaleString(),
                            ),
                          ),
                      ),
                    ]),
                    h("section", { class: "analytics-card" }, [
                      h("h4", "Installations & seats"),
                      h("dl", [
                        metric("Active installations", m.installations.active!),
                        metric("Production", m.installations.productionActive!),
                        metric(
                          "Development",
                          m.installations.developmentActive!,
                        ),
                        metric("Seats available", m.seats.available!),
                      ]),
                      h("progress", {
                        class: "analytics-progress",
                        max: Math.max(1, m.seats.allowance!),
                        value: m.seats.used,
                        "aria-label": "Seat utilization",
                      }),
                    ]),
                    h("section", { class: "analytics-card" }, [
                      h("h4", "Downloads & releases"),
                      h("dl", [
                        !allDownloadsInWindow &&
                          metric(
                            "Successful downloads · all time",
                            m.downloads.successfulResponses!,
                          ),
                        metric(
                          "Products with a live release",
                          `${releasedProducts} / ${data.products.length}`,
                        ),
                        metric("Withdrawn releases", m.releases.withdrawn!),
                        m.licenses.entitled! > 1 &&
                          metric(
                            "Downloads per entitled license · 30 days",
                            (
                              m.downloads.last30Days! / m.licenses.entitled!
                            ).toLocaleString(undefined, {
                              maximumFractionDigits: 1,
                            }),
                          ),
                      ]),
                      allDownloadsInWindow &&
                        m.downloads.successfulResponses! > 0 &&
                        h(
                          "p",
                          { class: "analytics-footnote" },
                          "The 30-day count includes all successful downloads.",
                        ),
                      btn("View daily reports", () => {
                        activePage.value = "operations";
                      }),
                    ]),
                    h("section", { class: "analytics-card" }, [
                      h("h4", "Storage"),
                      h("dl", [
                        metric(
                          "Storage used",
                          readableBytes(m.storage.usedBytes!),
                        ),
                        metric(
                          "Reserved storage",
                          readableBytes(m.storage.reservedBytes!),
                        ),
                        metric(
                          "Storage allowance",
                          readableBytes(m.storage.limitBytes!),
                        ),
                      ]),
                      h("progress", {
                        class: "analytics-progress",
                        max: Math.max(1, m.storage.limitBytes!),
                        value: m.storage.usedBytes! + m.storage.reservedBytes!,
                        "aria-label":
                          "Storage utilization including reserved uploads",
                      }),
                      h(
                        "p",
                        { class: "analytics-footnote" },
                        "Includes space reserved for uploads.",
                      ),
                    ]),
                  ]),
                  h(
                    "p",
                    { class: "analytics-footnote" },
                    "Downloads count successful server responses. Payment totals include tax and show amounts before Stripe fees.",
                  ),
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
                      "Collected after refunds",
                      money(payment.currency, payment.netMinor),
                    ),
                  ]),
                ]),
              ),
            ]),
            panel("products", "Products", [
              h(
                "p",
                { class: "product-scope" },
                `Plugins and apps published by ${data.tenant.name}. Each product has its own plans, licenses, releases and client configuration.`,
              ),
              !data.products.length &&
                h(
                  "section",
                  {
                    class: "product-empty-state",
                    "aria-label": "Add your first product",
                  },
                  [
                    h("h3", "No products yet"),
                    h(
                      "p",
                      "Add your first plugin or app. You can issue complimentary licenses without Stripe.",
                    ),
                    btn(
                      "Create product",
                      () => {
                        (
                          document.getElementById(
                            "product-create-disclosure",
                          ) as HTMLDetailsElement
                        ).open = true;
                        document.getElementById("product-name")!.focus();
                      },
                      busy.value,
                    ),
                  ],
                ),
              !prices.value.length &&
                h(
                  "p",
                  data.billingAvailable === false
                    ? "Create a product for complimentary licensing. Configure Stripe and a monthly, annual, or lifetime price before selling paid plans."
                    : "Create a product for complimentary licensing now. Connect Stripe and create an active monthly or annual recurring price or a lifetime price to add a paid plan.",
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
                  h(
                    "p",
                    { class: "product-form-intro" },
                    `Add one plugin or app to ${data.tenant.name}. To publish another plugin or app, add another product here.`,
                  ),
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
                  h("div", { class: "form-field product-plan-choice" }, [
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
                      " Include a paid plan (monthly, annual, or lifetime)",
                    ]),
                  ]),
                  includePaidPlan.value &&
                    localMode.value &&
                    h(
                      "p",
                      { class: "notice product-price-note" },
                      "Local fixture prices. These are simulated, not live Stripe prices.",
                    ),
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
                      "Stripe price (monthly, annual, or lifetime)",
                      priceOptions(prices.value),
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
                  h("li", { key: product.id }, [
                    h("h3", product.name),
                    h("div", { class: "record-metadata" }, [
                      h("span", frameworkInfo[frameworkOf(product)].name),
                      metadata(product.slug),
                      frameworkOf(product) === "wordpress" &&
                        metadata(product.plugin_basename),
                    ]),
                    h(
                      "ul",
                      product.plans.map((plan) =>
                        h("li", planSummary(product, plan)),
                      ),
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        disabled: busy.value,
                        "aria-label": `Edit ${product.name}`,
                        onClick: () => startEdit(product),
                      },
                      "Edit product",
                    ),
                  ]),
                ),
              ),
              editing &&
                h(
                  "section",
                  {
                    id: "product-editor",
                    class: "product-editor",
                    "aria-labelledby": "product-edit-title",
                  },
                  [
                    h("h3", { id: "product-edit-title" }, `Edit ${editing.name}`),
                    h("h4", "Plans"),
                    editing.plans.length
                      ? h(
                          "ul",
                          { class: "record-list plan-records" },
                          editing.plans.map((plan) =>
                            h("li", { key: plan.id }, [
                              planSummary(editing, plan),
                              " ",
                              btn(
                                `${plan.archived_at ? "Restore" : "Archive"} ${plan.name}`,
                                () => archivePlan(plan),
                                busy.value,
                              ),
                            ]),
                          ),
                        )
                      : h(
                          "p",
                          "No paid plans yet, so this product offers complimentary licenses only. Add a monthly, annual, or lifetime plan to start selling it.",
                        ),
                    form(
                      "product-edit",
                      async () => {
                        if (
                          addPlan.value &&
                          !unmappedPrices().some(
                            (price) =>
                              price.id === fields.value["edit-price-id"],
                          )
                        )
                          throw new ApiError(
                            "That Stripe price is already used by a plan. Choose another price.",
                          );
                        await tenantApi().post("/products", {
                          slug: editing.slug,
                          name: fields.value["edit-product-name"],
                          plans: addPlan.value
                            ? [
                                {
                                  name: fields.value["edit-plan-name"],
                                  siteAllowance: Number(
                                    fields.value["edit-site-allowance"],
                                  ),
                                  priceId: fields.value["edit-price-id"],
                                },
                              ]
                            : [],
                        });
                        await dashboard();
                        addPlan.value = false;
                        notice.value = "Product updated.";
                      },
                      [
                        field("edit-product-name", "Product name"),
                        h("div", { class: "form-field product-plan-choice" }, [
                          h("label", { for: "edit-add-plan" }, [
                            h("input", {
                              id: "edit-add-plan",
                              type: "checkbox",
                              checked: addPlan.value,
                              // Stay enabled while checked so it can be cleared.
                              disabled:
                                !addPlan.value &&
                                (data.billingAvailable === false ||
                                  !unmappedPrices().length),
                              onChange: (event: Event) => {
                                addPlan.value = (
                                  event.target as HTMLInputElement
                                ).checked;
                                fields.value["edit-price-id"] =
                                  unmappedPrices()[0]?.id || "";
                              },
                            }),
                            " Add a paid plan (monthly, annual, or lifetime)",
                          ]),
                        ]),
                        prices.value.length > 0 &&
                          !unmappedPrices().length &&
                          h(
                            "p",
                            { id: "edit-price-note", role: "status" },
                            "Every Stripe price is already used by a plan. Create a new monthly, annual, or lifetime price in Stripe to add another plan.",
                          ),
                        addPlan.value && field("edit-plan-name", "Plan name"),
                        addPlan.value &&
                          field(
                            "edit-site-allowance",
                            seatUnit(editing) === "site"
                              ? "Site allowance"
                              : "Device allowance",
                            "number",
                          ),
                        addPlan.value &&
                          select(
                            "edit-price-id",
                            "Stripe price (monthly, annual, or lifetime)",
                            priceOptions(unmappedPrices()),
                          ),
                      ],
                      "Save product",
                    ),
                    btn(
                      "Close editor",
                      () => {
                        editProduct.value = "";
                      },
                      busy.value,
                    ),
                  ],
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
                  const product = releaseProduct();
                  if (!product)
                    throw new ApiError(
                      "Create a product before publishing a release.",
                    );
                  const framework = frameworkOf(product);
                  // fetch needs the File itself, not Vue's reactive proxy.
                  const upload = toRaw(file.value);
                  if (!upload)
                    throw new ApiError(
                      framework === "wordpress"
                        ? "Choose a plugin ZIP."
                        : "Choose a release asset.",
                    );
                  if (upload.size > releaseUploadLimit())
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
                          filename: upload.name,
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
                  const uploadPath = `/${framework === "wordpress" ? "releases" : "assets"}/${encodeURIComponent(product.slug)}/${encodeURIComponent(fields.value["release-version"]!)}`;

                  const grant = {
                    verification: await hardwareVerification(platform, {
                      action: "account.privileged",
                      purpose: "release_publish",
                      path: `${uploadApi.basePath}${uploadPath}`,
                    }),
                  };
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
                    // Stream the selected file instead of buffering it in memory.
                    body: upload,
                  });
                  await dashboard();
                  notice.value = "Release published.";
                },
                [
                  h("p", policyCopy[privilegedPolicy.value].browser),
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
                data.releases
                  .toSorted((a, b) =>
                    releaseVersions.compare(b.version, a.version),
                  )
                  .map((release) =>
                    h("li", { key: release.id }, [
                      h("div", { class: "release-record-heading" }, [
                        h(
                          "h3",
                          data.products.find(
                            (product) => product.id === release.product_id,
                          )?.name ?? "Product unavailable",
                        ),
                        h(
                          "span",
                          {
                            class: [
                              "license-access-badge",
                              release.withdrawn
                                ? "license-access-revoked"
                                : "license-access-active",
                            ],
                          },
                          release.withdrawn ? "Withdrawn" : "Published",
                        ),
                      ]),
                      h("div", { class: "record-metadata" }, [
                        "Version ",
                        h(
                          "code",
                          { class: "metadata-chip release-version" },
                          release.version,
                        ),
                      ]),
                      release.assets && release.assets.length > 0
                        ? h(
                            "ul",
                            { class: "release-assets" },
                            release.assets.map((asset) =>
                              h(
                                "li",
                                { class: "record-metadata", key: asset.target },
                                [
                                  metadata(asset.target),
                                  metadata(asset.filename),
                                  metadata(readableBytes(asset.size)),
                                  h("details", { class: "release-checksum" }, [
                                    h("summary", disclosureLabel("SHA-256")),
                                    metadata(asset.checksum),
                                  ]),
                                ],
                              ),
                            ),
                          )
                        : null,
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
                              "Customers can no longer download this version.",
                            ),
                          busy.value,
                          { class: "button-danger" },
                        ),
                    ]),
                  ),
              ),
            ]),
            panel("setup", "Client setup", [renderClientSetup()]),
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
                      notice.value = "License issued. License key email queued.";
                    },
                    "The customer receives the license key by email.",
                  );
                },
                [
                  h(
                    "p",
                    "Issue a license without payment. Expiration stops new activations, downloads, and updates. Installed software keeps working.",
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
                    "Private seller note (optional)",
                    "text",
                    false,
                  ),
                ],
                "Issue complimentary license",
              ),
              h(
                "div",
                {
                  class: "license-controls",
                  role: "search",
                  "aria-label": "Filter licenses",
                },
                [
                  h("div", { class: "form-field license-search" }, [
                    h("label", { for: "license-search" }, "Search licenses"),
                    h("input", {
                      id: "license-search",
                      type: "search",
                      placeholder: "Customer, product, plan or license ID",
                      value: licenseQuery.value,
                      onInput: (event: Event) => {
                        licenseQuery.value = (
                          event.target as HTMLInputElement
                        ).value;
                      },
                    }),
                  ]),
                  h("div", { class: "license-mobile-sort" }, [
                    h("div", { class: "form-field license-sort-field" }, [
                      h("label", { for: "license-sort" }, "Sort by"),
                      h(
                        "select",
                        {
                          id: "license-sort",
                          value: licenseSort.value,
                          onChange: (event: Event) => {
                            licenseSort.value = (
                              event.target as HTMLSelectElement
                            ).value as (typeof licenseColumns)[number];
                            licenseDescending.value = false;
                          },
                        },
                        licenseColumns.map((column) =>
                          h("option", { value: column }, column),
                        ),
                      ),
                    ]),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "license-sort-direction",
                        "aria-label": licenseDescending.value
                          ? "Sort order: Descending. Switch to ascending"
                          : "Sort order: Ascending. Switch to descending",
                        title: licenseDescending.value
                          ? "Descending"
                          : "Ascending",
                        onClick: () => sortLicenses(licenseSort.value),
                      },
                      [icon(licenseDescending.value ? icons.down : icons.up)],
                    ),
                  ]),
                  h(
                    "details",
                    { class: "license-filters", key: selected.value },
                    [
                      h(
                        "summary",
                        disclosureLabel(
                          activeFilterCount
                            ? `Filters (${activeFilterCount})`
                            : "Filters",
                          icons.filters,
                        ),
                      ),
                      h("div", { class: "license-filter-fields" }, [
                        filterSelect(
                          "license-product",
                          "Product",
                          licenseProduct,
                          [
                            ["", "All products"],
                            ...Array.from(
                              new Map(
                                data.licenses.map((license) => [
                                  license.product_id,
                                  license.product_name,
                                ]),
                              ).entries(),
                            ),
                          ],
                        ),
                        filterSelect(
                          "license-type",
                          "License type",
                          licenseType,
                          [
                            ["", "All types"],
                            ["paid", "Paid"],
                            ["complimentary", "Complimentary"],
                          ],
                        ),
                        filterSelect(
                          "license-access",
                          "Access",
                          licenseAccess,
                          [
                            ["", "All access states"],
                            ["expiring", "Expiring soon (30d)"],
                            ["canceled", "Canceled"],
                            ["lifetime", "Lifetime"],
                            ...[
                              "Active",
                              "Expired",
                              "Revoked",
                              "Suspended",
                              "Pending",
                            ].map(
                              (label) =>
                                [label.toLowerCase(), label] as [
                                  string,
                                  string,
                                ],
                            ),
                          ],
                        ),
                      ]),
                    ],
                  ),
                ],
              ),
              h("div", { class: "license-results" }, [
                h(
                  "p",
                  { role: "status", "aria-live": "polite" },
                  `${licenses.length} of ${data.licenses.length} licenses`,
                ),
                h(
                  "button",
                  {
                    type: "button",
                    class: "license-clear-filters",
                    hidden: !hasLicenseFilters,
                    disabled: !hasLicenseFilters,
                    onClick: resetLicenseFilters,
                  },
                  "Clear filters",
                ),
                btn("Export CSV", () => void run(exportLicenses), busy.value, {
                  class: "button-secondary",
                }),
              ]),
              h("div", { class: "table-scroll license-list" }, [
                h("table", { id: "licenses-table", role: "table" }, [
                  h("caption", "Customer entitlements for this workspace"),
                  h("thead", { role: "rowgroup" }, [
                    h(
                      "tr",
                      { role: "row" },
                      [...licenseColumns, "Action" as const].map((label) =>
                        h(
                          "th",
                          {
                            role: "columnheader",
                            scope: "col",
                            "aria-label": label,
                            "aria-sort":
                              label === "Action"
                                ? undefined
                                : licenseSort.value === label
                                  ? licenseDescending.value
                                    ? "descending"
                                    : "ascending"
                                  : "none",
                          },
                          label === "Action"
                            ? label
                            : h(
                                "button",
                                {
                                  type: "button",
                                  class: "table-sort",
                                  onClick: () => sortLicenses(label),
                                },
                                [
                                  label,
                                  icon(
                                    licenseSort.value !== label
                                      ? icons.sort
                                      : licenseDescending.value
                                        ? icons.down
                                        : icons.up,
                                  ),
                                ],
                              ),
                        ),
                      ),
                    ),
                  ]),
                  h(
                    "tbody",
                    { role: "rowgroup" },
                    licenses.length
                      ? licenses.flatMap((license) => [
                          h(
                            "tr",
                            {
                              key: license.id,
                              "data-license-id": license.id,
                              role: "row",
                            },
                            [
                              h(
                                "td",
                                { role: "cell", class: "license-customer" },
                                license.customer_email
                                  .split(/(?<=@)/)
                                  .flatMap((part, index) =>
                                    index ? [h("wbr"), part] : [part],
                                  ),
                              ),
                              h(
                                "td",
                                { role: "cell", class: "license-product" },
                                `${license.product_name} · ${license.provenance === "complimentary" ? "Complimentary" : license.plan_name}`,
                              ),
                              h(
                                "td",
                                { role: "cell", class: "license-seats" },
                                [
                                  h(
                                    "span",
                                    {
                                      class: "license-card-label",
                                      "aria-hidden": "true",
                                    },
                                    "Seats",
                                  ),
                                  String(license.site_allowance),
                                ],
                              ),
                              h(
                                "td",
                                { role: "cell", class: "license-billing" },
                                [
                                  h(
                                    "span",
                                    {
                                      class: "license-card-label",
                                      "aria-hidden": "true",
                                    },
                                    "Billing",
                                  ),
                                  licenseBillingLabel(license),
                                ],
                              ),
                              h(
                                "td",
                                { role: "cell", class: "license-expiry" },
                                [
                                  h(
                                    "span",
                                    {
                                      class: "license-card-label",
                                      "aria-hidden": "true",
                                    },
                                    license.provenance === "complimentary"
                                      ? "Expires"
                                      : "Paid through",
                                  ),
                                  license.billing_status === "lifetime"
                                    ? "Lifetime"
                                    : licenseExpiry(license)
                                      ? new Date(
                                          licenseExpiry(license)!,
                                        ).toLocaleDateString()
                                      : "Not yet available",
                                ],
                              ),
                              h(
                                "td",
                                { role: "cell", class: "license-access" },
                                h(
                                  "span",
                                  {
                                    class: [
                                      "license-access-badge",
                                      `license-access-${access(license).toLowerCase()}`,
                                    ],
                                  },
                                  access(license),
                                ),
                              ),
                              h(
                                "td",
                                { class: "license-actions", role: "cell" },
                                [
                                  h("div", [
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        disabled: busy.value,
                                        onClick: () =>
                                          startLicenseEdit(license),
                                        "aria-label": `Edit license for ${license.customer_email}`,
                                        "aria-expanded":
                                          editLicenseId.value === license.id,
                                      },
                                      "Edit",
                                    ),
                                    h(
                                      "button",
                                      {
                                        type: "button",
                                        disabled: busy.value,
                                        "aria-label": `View installations for ${license.customer_email}`,
                                        onClick: () =>
                                          void run(async () => {
                                            await loadInstallations(license);
                                            await nextTick();
                                            document
                                              .getElementById(
                                                "license-installations-title",
                                              )
                                              ?.focus();
                                          }),
                                      },
                                      "Installations",
                                    ),
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
                                          license.revoked
                                            ? "The customer regains downloads and updates for this license."
                                            : "The customer loses downloads and updates immediately. Installed software stays available.",
                                        ),
                                      busy.value,
                                      {
                                        class: license.revoked
                                          ? undefined
                                          : "button-danger",
                                      },
                                    ),
                                  ]),
                                ],
                              ),
                            ],
                          ),
                          ...(editLicenseId.value === license.id
                            ? [licenseEditor(license)]
                            : []),
                        ])
                      : [
                          h("tr", { role: "row" }, [
                            h(
                              "td",
                              {
                                colspan: 7,
                                class: "table-empty",
                                role: "cell",
                              },
                              data.licenses.length
                                ? "No licenses match your filters."
                                : "No licenses have been issued yet.",
                            ),
                          ]),
                        ],
                  ),
                ]),
              ]),
              inspected.value &&
                h(
                  "section",
                  {
                    id: "license-installations",
                    class: "license-installations",
                    "aria-labelledby": "license-installations-title",
                  },
                  [
                    h(
                      "h3",
                      { id: "license-installations-title", tabindex: -1 },
                      `Installations · ${inspected.value.license.product_name} · ${inspected.value.license.customer_email}`,
                    ),
                    inspected.value.installations.length
                      ? h(
                          "ul",
                          { class: "record-list installation-records" },
                          inspected.value.installations.map((item) =>
                            h("li", { key: item.id }, [
                              h("strong", sellerInstallationName(item)),
                              ` · ${item.active ? "Active" : "Inactive"}${item.exempt ? " · Does not use a seat" : ""} `,
                              item.active &&
                                btn(
                                  `Deactivate ${sellerInstallationName(item)}`,
                                  () =>
                                    deactivateInstallation(
                                      inspected.value!.license,
                                      item,
                                    ),
                                  busy.value,
                                ),
                            ]),
                          ),
                        )
                      : h(
                          "p",
                          "No installations have been activated with this license.",
                        ),
                    h("div", { class: "button-row" }, [
                      inspected.value.nextCursor &&
                        btn(
                          "Load more installations",
                          () =>
                            void run(() =>
                              loadInstallations(
                                inspected.value!.license,
                                inspected.value!.nextCursor!,
                              ),
                            ),
                          busy.value,
                        ),
                      btn(
                        "Close installations",
                        () => {
                          inspected.value = null;
                        },
                        busy.value,
                      ),
                    ]),
                  ],
                ),
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
                  const proof = "";

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
                      { icon: copyIcon },
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
            appHeader(false, seller.value ? "dashboard" : "sign-in"),
            h("main", { id: "main", class: "page-main seller-main" }, [
              h(
                "header",
                {
                  class: [
                    "seller-page-header",
                    seller.value?.tenants.length
                      ? hosted.value
                        ? "seller-header-publisher"
                        : "seller-header-standalone"
                      : "seller-header-simple",
                  ],
                },
                [
                  h(
                    "div",
                    {
                      class: [
                        "page-heading",
                        seller.value?.tenants.length && "sr-only",
                      ],
                    },
                    [
                      !(seller.value?.tenants.length && hosted.value) &&
                        h("p", { class: "eyebrow" }, "Publisher workspace"),
                      h(
                        "h1",
                        overview.value
                          ? sellerPages.find(
                              (page) => page.id === activePage.value,
                            )!.label
                          : recovery.value
                            ? "Workspace recovery"
                            : "Seller dashboard",
                      ),
                    ],
                  ),
                  seller.value &&
                    seller.value.tenants.length > 0 &&
                    workspaceControls(),
                  seller.value &&
                    h("div", { class: "seller-account" }, [
                      h(
                        "p",
                        { class: "seller-account-email" },
                        seller.value.user.email,
                      ),
                      btn("Sign out", signOut, busy.value, {
                        icon: icons.logout,
                      }),
                    ]),
                  seller.value &&
                  seller.value.tenants.length > 0 &&
                  hosted.value
                    ? mobileTools()
                    : null,
                ],
              ),
              seller.value?.tenants.some(
                (item) =>
                  item.slug === selected.value && workspaceArchived(item),
              ) &&
                h("aside", { class: "workspace-archive-notice" }, [
                  h("strong", "Archived workspace"),
                  h(
                    "p",
                    "Existing licenses, updates and billing remain active. Restore this workspace from Workspaces.",
                  ),
                  btn(
                    "Manage workspaces",
                    () => {
                      activePage.value = "workspaces";
                    },
                    busy.value,
                  ),
                ]),
              overview.value?.sandbox?.isSandbox &&
                h(
                  "aside",
                  { class: "sandbox-badge", "aria-label": "Test workspace" },
                  [
                    h("div", { class: "sandbox-badge-copy" }, [
                      h("strong", [icon(icons.flask), "TEST WORKSPACE"]),
                      h(
                        "p",
                        `${overview.value.sandbox.mode} sandbox for ${overview.value.sandbox.parentSlug}. Test data is separate from the publisher's live workspace.`,
                      ),
                    ]),
                    h(
                      "a",
                      {
                        class: "button button-secondary button-small",
                        href: applicationHref(
                          `/t/${encodeURIComponent(selected.value)}`,
                        ),
                      },
                      "Open test buyer page",
                    ),
                    h("details", { class: "sandbox-api-details" }, [
                      h("summary", disclosureLabel("API endpoint", icons.code)),
                      h(
                        "code",
                        `${window.location.origin}/api/v1/tenants/${encodeURIComponent(selected.value)}`,
                      ),
                    ]),
                  ],
                ),
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
                      h("h2", [
                        icon(icons.warning),
                        stripeConnectionNeeded.value
                          ? "Stripe connection needed"
                          : "We couldn’t complete that request",
                      ]),
                      h("p", error.value),
                      stripeConnectionNeeded.value &&
                        h(
                          "p",
                          "Open Billing to connect Stripe and load paid plans. You can keep setting up products and issuing complimentary licenses in the meantime.",
                        ),
                      errorReference.value &&
                        h("details", { class: "seller-alert-details" }, [
                          h("summary", disclosureLabel("Support details")),
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
                        hosted.value
                          ? "Use a passkey or security key to sign in. You can also request an email link to sign in or create an account."
                          : "Sign in with an enrolled passkey or security key, or request a link at the configured owner email.",
                      ),
                      btn(
                        "Sign in with a passkey or security key",
                        () =>
                          void run(async () => {
                            const started = await platform.post<{
                              options: unknown;
                            }>("/auth/passkey/options", {}, false);
                            const response = await passkeyCeremony(
                              "get",
                              started.options,
                            );
                            await platform.post(
                              "/auth/passkey/verify",
                              { response },
                              false,
                            );
                            clearSession();
                            await session();
                          }, false),
                        busy.value,
                        { icon: icons.key, class: "passkey-signin" },
                      ),
                      h("div", { class: "seller-email-signin" }, [
                        signInRecipient.value &&
                          h(
                            "div",
                            { class: "seller-signin-sent", role: "status" },
                            [
                              icon(icons.mailCheck),
                              h("div", [
                                h("h3", "Check your email"),
                                h("p", [
                                  "If the address can sign in, a link will arrive at ",
                                  h("strong", signInRecipient.value),
                                  ". Open it in this browser.",
                                ]),
                                h(
                                  "p",
                                  "Check your spam folder or use the form below to send another link.",
                                ),
                              ]),
                            ],
                          ),
                        form(
                          "seller-login",
                          async () => {
                            const email = fields.value["seller-email"]!.trim();
                            await platform.post(
                              "/auth/request",
                              { email },
                              false,
                            );
                            signInRecipient.value = email;
                          },
                          [field("seller-email", "Email address", "email")],
                          "Email seller sign-in link",
                        ),
                      ]),
                      h(
                        "details",
                        {
                          class: "account-recovery",
                          open: recoveryOpen.value,
                          onToggle: (event: Event) => {
                            recoveryOpen.value = (
                              event.target as HTMLDetailsElement
                            ).open;
                          },
                        },
                        [
                          h(
                            "summary",
                            disclosureLabel(
                              "Use a recovery code",
                              icons.shield,
                            ),
                          ),
                          recoveryOpen.value &&
                            h(SellerFeaturePanel, {
                              page: "recovery",
                              api: platform,
                              platform,
                              hosted: hosted.value,
                              products: [],
                              confirm,
                              onSignedOut: () => void run(() => session(true)),
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
                                        sellerPages
                                          .filter(
                                            (page) =>
                                              hosted.value ||
                                              page.id !== "workspaces",
                                          )
                                          .map((page) =>
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
                                      .map(sellerNavItem),
                                    ...sellerPageGroups.map((group) =>
                                      h("div", { class: "seller-nav-group" }, [
                                        h("p", group.label),
                                        ...sellerPages
                                          .filter(
                                            (page) =>
                                              group.pages.includes(page.id) &&
                                              (hosted.value ||
                                                page.id !== "workspaces"),
                                          )
                                          .map(sellerNavItem),
                                      ]),
                                    ),
                                  ]),
                                  sellerHelpLink("mobile"),
                                ],
                              ),
                          ],
                        ),
                      h("div", { class: "seller-content" }, [
                        renderSetupContext(),
                        seller.value.tenants.length === 0 &&
                          section(
                            hosted.value
                              ? "Create your publisher workspace"
                              : "Workspace access",
                            [
                              h(
                                "p",
                                hosted.value
                                  ? "Add each app or plugin as a product in this workspace. Set up Stripe later if you want to sell paid plans."
                                  : "Sign in with the owner email configured for this deployment. Ask your operator to check the owner setting if you expected access.",
                              ),
                              hosted.value && workspaceForm(),
                            ],
                          ),
                        recovery.value && renderRecovery(),
                        (recovery.value || seller.value.tenants.length === 0) &&
                          h(
                            "div",
                            { class: "button-row seller-account-actions" },
                            [
                              hosted.value &&
                                btn(
                                  "Manage workspaces",
                                  () => {
                                    activePage.value = "workspaces";
                                  },
                                  busy.value,
                                ),
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
                                  { value: "security_enroll" },
                                  "Add a passkey or security key",
                                ),
                                h(
                                  "option",
                                  { value: "recovery_codes" },
                                  "Recovery codes",
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
                                const page = [
                                  "recovery_codes",
                                  "security_enroll",
                                ].includes(proofPurpose.value)
                                  ? "security"
                                  : "export";
                                if (page === "export" && !selected.value) {
                                  error.value =
                                    "Create or select a workspace before exporting it.";
                                  return;
                                }
                                panelPurpose.value = proofPurpose.value;
                                panelProof.value = {
                                  page,
                                  token: accountProof.value,
                                };
                                proofRound.value++;
                                activePage.value = page;
                                accountProof.value = "";
                                notice.value = "";
                              },
                              busy.value,
                            ),
                          ]),
                        overview.value && renderDashboard(),
                        hosted.value &&
                          activePage.value === "workspaces" &&
                          h(
                            "div",
                            {
                              id: "seller-panel-workspaces",
                              class: "seller-view",
                              role: "region",
                              "aria-label": "Workspaces",
                            },
                            [
                              h(WorkspaceManager, {
                                tenants: seller.value.tenants,
                                platform,
                                busy: busy.value,
                                privilegedPolicy: privilegedPolicy.value,
                                execute: (action: () => Promise<void>) => {
                                  void run(action);
                                },
                                confirm: (
                                  title: string,
                                  label: string,
                                  action: () => Promise<void>,
                                  description?: string,
                                ) => {
                                  confirmation.value = {
                                    title,
                                    label,
                                    description,
                                    run: action,
                                  };
                                },
                                refresh: refreshWorkspaces,
                                onOpened: (slug: string) => {
                                  selected.value = slug;
                                  activePage.value = "overview";
                                  void run(dashboard);
                                },
                              }),
                            ],
                          ),
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
                                tenantSlug: selected.value,
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
                                  description?: string,
                                ) => {
                                  confirmation.value = {
                                    title,
                                    label,
                                    description,
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
                                initialPurpose: panelPurpose.value,
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
                  description: confirmation.value.description,
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
