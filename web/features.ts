import { applicationHref } from "./navigation.ts";
import {
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import type { PropType } from "vue";
import { ApiClient, ApiError, errorMessage } from "./api.ts";
import { RecoveryPanel } from "./auth-recovery.ts";
import { hardwareVerification, PublisherSecurity } from "./oidc.ts";

type Confirm = (
  title: string,
  label: string,
  action: () => Promise<void>,
) => void;
type Values = Record<string, string | number | boolean>;
export interface EmailChangeDraft {
  id: string;
  currentToken: string;
  newToken: string;
  pendingTokens: string[];
}
interface FeatureProduct {
  id: string;
  slug?: string;
  name: string;
  plans: { id: string; name: string }[];
  tax_code?: string | null;
}
interface Flags {
  features: { outboundWebhooks: boolean; advancedReports: boolean };
  hostedProConfigured: boolean;
}
interface Sandbox {
  isSandbox: boolean;
  parentSlug: string;
  sandboxSlug: string;
  mode: "fixture" | "stripe";
}
interface Health {
  summary: {
    queues?: Record<
      string,
      {
        failed?: number;
        pending?: number;
        completed?: number;
        total?: number;
        canceled?: number;
        oldestAgeMs?: number;
      }
    >;
    storage?: { usedBytes: number; reservedBytes: number; limitBytes: number };
    bandwidth?: {
      servedBytes: number;
      storageReadBytes?: number;
      storageReads?: number;
    };
    billingCapacityWarning?: boolean;
  };
  settings: Values;
  alerts: { kind: string }[];
  notifications: { kind?: string; message: string }[];
  features: Flags["features"];
}
interface Endpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
}
interface ActivityReport {
  days: number;
  generatedAt: number;
  daily: {
    day: string;
    work: { total: number; completed: number };
    emails: { total: number; completed: number };
    outbound_deliveries: { total: number; completed: number };
  }[];
  emails: {
    id: string;
    kind: string;
    state: string;
    attempts: number;
    createdAt: number;
  }[];
}
interface Delivery {
  id: string;
  endpointId?: string;
  eventId: string;
  state: string;
  attempts: number;
  lastError: string | null;
}
interface Session {
  id: string;
  current: boolean;
  expiresAt: number;
}
const eventTypes = [
  "license.created",
  "license.renewed",
  "license.revoked",
  "activation.changed",
  "release.published",
  "release.withdrawn",
  "alert.raised",
];
const eventTitles: Record<string, string> = {
  "license.created": "License created",
  "license.renewed": "License renewed",
  "license.revoked": "License revoked",
  "activation.changed": "Installations changed",
  "release.published": "Release published",
  "release.withdrawn": "Release withdrawn",
  "alert.raised": "Health alert",
};
const button = (label: string, action: () => void, disabled: boolean) =>
  h("button", { type: "button", disabled, onClick: action }, label);

const human = (value: string) => value.replaceAll("_", " ");
const numberText = (value: number | undefined) =>
  value === undefined ? "—" : value.toLocaleString("en-US");
const bytesText = (value: number) => {
  const index = Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10));
  return `${(value / 1024 ** index).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${["B", "KiB", "MiB", "GiB", "TiB"][index]}`;
};
const trendChart = (
  title: string,
  rows: { day: string; value: number }[],
  format: (value: number) => string = numberText,
) => {
  const width = 640,
    height = 180,
    inset = 24;
  const max = Math.max(1, ...rows.map((row) => row.value));
  const points = rows
    .map(
      (row, index) =>
        `${inset + (index * (width - inset * 2)) / Math.max(1, rows.length - 1)},${height - inset - (row.value / max) * (height - inset * 2)}`,
    )
    .join(" ");
  return h("figure", { class: "trend-chart" }, [
    h("figcaption", [
      h("span", title),
      h("strong", format(rows.reduce((sum, row) => sum + row.value, 0))),
    ]),
    h(
      "svg",
      {
        viewBox: `0 0 ${width} ${height}`,
        role: "img",
        "aria-label": `${title}. ${rows.map((row) => `${row.day}: ${format(row.value)}`).join("; ")}`,
      },
      [
        h("title", `${title} by day, UTC`),
        ...[0, 0.5, 1].map((ratio) =>
          h("line", {
            x1: inset,
            x2: width - inset,
            y1: inset + ratio * (height - 2 * inset),
            y2: inset + ratio * (height - 2 * inset),
            class: "chart-gridline",
          }),
        ),
        h("polygon", {
          points: `${inset},${height - inset} ${points} ${rows.length > 1 ? width - inset : inset},${height - inset}`,
          class: "chart-area",
        }),
        h("polyline", { points, class: "chart-line" }),
        ...rows.map((row, index) =>
          h(
            "circle",
            {
              cx:
                inset +
                (index * (width - inset * 2)) / Math.max(1, rows.length - 1),
              cy: height - inset - (row.value / max) * (height - inset * 2),
              r: 3,
              class: "chart-point",
            },
            [h("title", `${row.day}: ${format(row.value)}`)],
          ),
        ),
      ],
    ),
    h("div", { class: "chart-axis" }, [
      h("span", rows[0]?.day || ""),
      h(
        "span",
        `Daily · UTC · peak ${format(max === 1 && rows.every((row) => row.value === 0) ? 0 : max)}`,
      ),
      h("span", rows.at(-1)?.day || ""),
    ]),
  ]);
};
const card = (title: string, description: string, children: unknown[]) =>
  h("section", { class: "feature-card" }, [
    h("div", { class: "feature-card-heading" }, [
      h("h3", title),
      h("p", description),
    ]),
    ...children,
  ] as Parameters<typeof h>[2]);
const disclosure = (
  id: string,
  title: string,
  description: string,
  children: unknown[],
  open = false,
) =>
  h("details", { id, class: "feature-disclosure", open }, [
    h("summary", title),
    h("div", { class: "feature-disclosure-content" }, [
      h("p", { class: "feature-description" }, description),
      ...children,
    ] as Parameters<typeof h>[2]),
  ]);

// Every call consumes the email proof. Neither proof nor returned grant is persisted.
export async function verifiedRequest<T>(
  platform: ApiClient,
  api: ApiClient,
  purpose: string,
  token: string,
  path: string,
  body: unknown,
): Promise<T> {
  const privileged = [
    "api_keys",
    "workspace_remove",
    "release_publish",
  ].includes(purpose);
  const result = privileged
    ? {
        verification: await hardwareVerification(platform, {
          action: "account.privileged",
          purpose,
          path: `${api.basePath}${path}`,
        }),
      }
    : await platform.post<{ verification: string }>(
        "/account/verification/consume",
        { purpose, token },
      );
  return api.request<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": api.csrfToken,
      "X-Account-Verification": result.verification,
    },
    body: JSON.stringify(body),
  });
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

type ExportHandle = { id: string; blobs: string[] } & (
  | { status: "ready"; expiresAt: number }
  | { status: "creating" | "cleanup_pending"; expiresAt: number | null }
);
export const SellerFeaturePanel = defineComponent({
  props: {
    page: { type: String, required: true },
    initialToken: { type: String, default: "" },
    emailChange: {
      type: Object as PropType<EmailChangeDraft | null>,
      default: null,
    },
    invalidateProof: {
      type: Function as PropType<(page: string, token: string) => void>,
    },
    api: { type: Object as PropType<ApiClient>, required: true },
    platform: { type: Object as PropType<ApiClient>, required: true },
    hosted: { type: Boolean, required: true },
    subscribed: { type: Boolean, default: false },
    embedded: { type: Boolean, default: false },
    products: { type: Array as PropType<FeatureProduct[]>, required: true },
    confirm: { type: Function as PropType<Confirm>, required: true },
  },
  emits: ["expired", "signedOut", "update:emailChange"],
  setup(props, { emit }) {
    const loading = ref(true),
      pending = ref(false),
      loadError = ref(false),
      proofSent = ref(false),
      error = ref(""),
      notice = ref(""),
      oneTime = ref("");
    const values = ref<Values>({
      mode: "fixture",
      planId: "",
      webhookUrl: "",
      email: "",
      changeId: "",
      currentToken: "",
      newToken: "",
      passphrase: "",
      verificationToken: "",
    });
    const pendingEmailTokens = ref<string[]>([]);
    watch(
      () => props.emailChange,
      (draft) => {
        values.value.changeId = draft?.id || "";
        values.value.currentToken = draft?.currentToken || "";
        values.value.newToken = draft?.newToken || "";
        pendingEmailTokens.value = (draft?.pendingTokens || []).slice(-1);
      },
      { immediate: true },
    );
    const retainEmailChange = () =>
      emit("update:emailChange", {
        id: String(values.value.changeId || ""),
        currentToken: String(values.value.currentToken || ""),
        newToken: String(values.value.newToken || ""),
        pendingTokens: [...pendingEmailTokens.value],
      } satisfies EmailChangeDraft);
    const useEmailChangeLink = (mailbox: "currentToken" | "newToken") => {
      const proof = pendingEmailTokens.value[0];
      if (!proof) return;
      const other = mailbox === "currentToken" ? "newToken" : "currentToken";
      if (values.value[other] === proof) {
        error.value = "Use a link from the different mailbox for this proof.";
        return;
      }
      values.value[mailbox] = proof;
      pendingEmailTokens.value = pendingEmailTokens.value.slice(1);
      error.value = "";
      retainEmailChange();
    };
    const initialProof = props.initialToken;
    const proofArrived = Boolean(initialProof);
    values.value["verification-token"] = initialProof;
    const notifications = ref<
        { id: string; kind: string; paidThrough: number }[]
      >([]),
      closure = ref<{
        request?: {
          status: string;
          blockers: string[];
          requestedAt?: number;
        } | null;
      } | null>(null);
    const flags = ref<Flags>({
      features: { outboundWebhooks: false, advancedReports: false },
      hostedProConfigured: false,
    });
    const sandbox = ref<Sandbox | null>(null),
      stripeAvailable = ref(false),
      child = ref<{
        slug: string;
        customerUrl: string;
        apiBase: string;
      } | null>(null);
    const health = ref<Health | null>(null),
      reports = ref<{
        days?: number;
        generatedAt?: number;
        rows: {
          day: string;
          responses?: number;
          servedBytes: number;
          storageReadBytes?: number;
          storageReads?: number;
        }[];
      } | null>(null),
      endpoints = ref<Endpoint[]>([]),
      deliveries = ref<Delivery[]>([]),
      sessions = ref<Session[]>([]);
    const activity = ref<ActivityReport | null>(null);
    const activityDays = ref("30");
    const reportDays = ref("30");
    const retainedExports = ref<ExportHandle[]>([]);
    const proOptions = ref(false);
    const selectedEvents = ref(["license.created"]),
      bundle = ref<{ id: string; expiresAt: number; blobs: string[] } | null>(
        null,
      );
    let alive = true;
    const run = async (action: () => Promise<void>) => {
      if (pending.value) return;
      pending.value = true;
      error.value = "";
      notice.value = "";
      try {
        await action();
      } catch (failure) {
        if (alive) {
          error.value = errorMessage(failure);
          if (failure instanceof ApiError && failure.status === 401)
            emit("expired");
        }
      } finally {
        pending.value = false;
      }
    };
    const mutate = <T>(path: string, body: unknown, method = "POST") =>
      props.api.request<T>(path, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": props.api.csrfToken,
        },
        body: JSON.stringify(body),
      });
    const loadWebhooks = async () => {
      const result = await props.api.get<{
        endpoints: Endpoint[];
        deliveries: Delivery[];
      }>("/webhooks");
      endpoints.value = result.endpoints;
      deliveries.value = result.deliveries;
    };
    const loadExports = async () => {
      const result = await props.api.request<{ exports: ExportHandle[] }>(
        "/exports",
        {
          headers: { "X-CSRF-Token": props.api.csrfToken },
        },
      );
      if (alive) retainedExports.value = result.exports;
    };
    const load = async () => {
      loading.value = true;
      await run(async () => {
        switch (props.page) {
          case "commerce":
            Object.assign(
              values.value,
              (await props.api.get<{ settings: Values }>("/commerce/settings"))
                .settings,
            );
            for (const product of props.products)
              values.value[`tax-${product.id}`] = product.tax_code ?? "";
            break;
          case "sandbox": {
            const result = await props.api.get<{
              sandbox: Sandbox | null;
              stripeAvailable: boolean;
            }>("/sandbox");
            sandbox.value = result.sandbox;
            stripeAvailable.value = result.stripeAvailable;
            break;
          }
          case "operations":
            health.value = await props.api.get<Health>("/operations");
            Object.assign(values.value, health.value.settings);
            break;
          case "webhooks":
            flags.value = await props.api.get<Flags>("/features");
            if (!props.hosted || flags.value.features.outboundWebhooks)
              await loadWebhooks();
            break;
          case "customer":
            notifications.value = (
              await props.api.get<{
                notifications: {
                  id: string;
                  kind: string;
                  paidThrough: number;
                }[];
              }>("/notifications")
            ).notifications;
            closure.value = await props.api.get("/account/closure");
            break;
          case "export":
            await loadExports();
            break;
          case "security":
            sessions.value = (
              await props.platform.get<{ sessions: Session[] }>(
                "/account/sessions",
              )
            ).sessions;
            break;
        }
      });
      loadError.value = Boolean(error.value);
      loading.value = false;
    };
    onMounted(async () => {
      await load();
      await nextTick();
      if (proofArrived && alive) {
        const summary = document
          .getElementById(
            props.page === "security" ? "security-recovery" : "export-create",
          )
          ?.querySelector<HTMLElement>("summary");
        summary?.scrollIntoView({ block: "start" });
        summary?.focus({ preventScroll: true });
      }
    });
    onUnmounted(() => {
      alive = false;
      oneTime.value = "";
      values.value = {};
      bundle.value = null;
      retainedExports.value = [];
    });
    const field = (id: string, label: string, type = "text", required = true) =>
      h("label", { class: "form-field", for: id }, [
        label,
        h("input", {
          id,
          type,
          required,
          step: "any",
          minlength: id === "passphrase" ? 12 : undefined,
          pattern: id.startsWith("tax-") ? "txcd_[0-9]{8}" : undefined,
          autocomplete: "off",
          value: values.value[id],
          onInput: (event: Event) => {
            values.value[id] = (event.target as HTMLInputElement).value;
            if (["changeId", "currentToken", "newToken"].includes(id)) {
              if (id === "changeId") {
                values.value.currentToken = "";
                values.value.newToken = "";
                pendingEmailTokens.value = [];
              }
              retainEmailChange();
            }
          },
        }),
      ]);
    const check = (id: string, label: string) =>
      h("label", { class: "feature-checkbox" }, [
        h("input", {
          id,
          type: "checkbox",
          checked: values.value[id],
          onChange: (event: Event) => {
            values.value[id] = (event.target as HTMLInputElement).checked;
          },
        }),
        label,
      ]);
    const select = (
      id: string,
      label: string,
      options: { id: string; name: string }[],
    ) =>
      h("label", { class: "form-field", for: id }, [
        label,
        h(
          "select",
          {
            id,
            required: true,
            value: values.value[id],
            onChange: (event: Event) => {
              values.value[id] = (event.target as HTMLSelectElement).value;
            },
          },
          options.map((option) =>
            h("option", { value: option.id }, option.name),
          ),
        ),
      ]);
    const form = (
      id: string,
      label: string,
      fields: unknown[],
      action: () => Promise<void>,
    ) =>
      h(
        "form",
        {
          id,
          class: "seller-form feature-form",
          onSubmit: (event: Event) => {
            event.preventDefault();
            void run(action);
          },
        },
        [
          ...fields,
          h("button", { type: "submit", disabled: pending.value }, label),
        ] as Parameters<typeof h>[2],
      );
    const confirm = (title: string, action: () => Promise<void>) =>
      props.confirm(title, "Confirm action", async () => {
        await run(action);
      });
    const requestProof = (purpose: string) =>
      void run(async () => {
        await props.platform.post("/account/verification/request", { purpose });
        values.value["verification-token"] = "";
        props.invalidateProof?.(props.page, initialProof);
        proofSent.value = true;
      });
    const proofField = (purpose: string) =>
      ["workspace_remove", "api_keys", "release_publish"].includes(purpose)
        ? h(
            "p",
            "This action requires fresh verification with an independently provisioned hardware key.",
          )
        : h("div", { class: "verification-proof" }, [
            !proofSent.value &&
              h(
                "p",
                proofArrived && values.value["verification-token"]
                  ? "Verification link received. Complete the action below."
                  : "We'll email you a link. Open it in this browser to continue.",
              ),
            button(
              proofSent.value
                ? "Resend verification link"
                : "Send verification link",
              () => requestProof(purpose),
              pending.value,
            ),
            proofSent.value &&
              h(
                "p",
                { role: "status", class: "verification-sent" },
                "Link sent. Check your email and open it in this browser.",
              ),
            field("verification-token", "Email verification", "password"),
          ]);
    const consumeProof = async (purpose: string) => {
      const token = String(values.value["verification-token"] || "");
      values.value["verification-token"] = "";
      props.invalidateProof?.(props.page, initialProof);
      const result = await props.platform.post<{ verification: string }>(
        "/account/verification/consume",
        { purpose, token },
      );
      proofSent.value = false;
      return result;
    };
    const showSecret = (value: string) => {
      if (alive) oneTime.value = value;
    };
    const commerce = () => [
      h("p", "Choose the tax and billing details collected at checkout."),
      form(
        "tax-settings",
        "Save tax settings",
        [
          check("automaticTax", "Automatic tax"),
          check("collectTaxId", "Collect tax ID"),
          check("collectBillingAddress", "Collect billing address"),
        ],
        async () => {
          await mutate(
            "/commerce/settings",
            {
              automaticTax: values.value.automaticTax,
              collectTaxId: values.value.collectTaxId,
              collectBillingAddress: values.value.collectBillingAddress,
            },
            "PUT",
          );
          notice.value = "Tax settings saved.";
        },
      ),
      disclosure(
        "product-tax-overrides",
        "Product tax codes",
        "Optional Stripe tax codes. Leave blank to use your merchant default.",
        [
          ...props.products.map((product) =>
            form(
              `tax-code-${product.id}`,
              "Save product tax code",
              [
                field(
                  `tax-${product.id}`,
                  `${product.name} tax code`,
                  "text",
                  false,
                ),
              ],
              async () => {
                await mutate(
                  `/commerce/products/${encodeURIComponent(product.id)}/tax-code`,
                  { taxCode: values.value[`tax-${product.id}`] || null },
                  "PUT",
                );
                notice.value = "Product tax code saved.";
              },
            ),
          ),
        ],
      ),
    ];
    const renderSandbox = () => [
      h(
        "p",
        "Try purchases, licenses and updates in a separate test workspace.",
      ),
      sandbox.value?.isSandbox
        ? h("div", { class: "sandbox-workspace" }, [
            h("div", { class: "sandbox-workspace-heading" }, [
              h("div", [
                h("strong", { class: "sandbox-label" }, "TEST WORKSPACE"),
                h(
                  "p",
                  `Mode: ${sandbox.value.mode}. Parent: ${sandbox.value.parentSlug}`,
                ),
              ]),
              h(
                "a",
                {
                  class: "button button-secondary button-small",
                  href: applicationHref(
                    `/t/${encodeURIComponent(sandbox.value.sandboxSlug)}`,
                  ),
                },
                "Open test buyer page",
              ),
            ]),
            h("details", { class: "sandbox-api-details" }, [
              h("summary", "API endpoint"),
              h(
                "code",
                `${window.location.origin}${props.api.basePath.replace(/\/seller$/, "")}`,
              ),
            ]),
            sandbox.value.mode === "fixture" &&
              h(
                "section",
                {
                  class: "sandbox-license",
                  "aria-labelledby": "sandbox-license-title",
                },
                [
                  h(
                    "h3",
                    { id: "sandbox-license-title" },
                    "Issue a test license",
                  ),
                  h(
                    "p",
                    "Choose a plan. The license will be emailed to your verified seller address. No payment is collected.",
                  ),
                  form(
                    "sandbox-purchase",
                    "Issue test license",
                    [
                      select("planId", "Test plan", [
                        { id: "", name: "Select a plan" },
                        ...props.products.flatMap((p) => p.plans),
                      ]),
                    ],
                    async () => {
                      await mutate("/sandbox/purchase", {
                        planId: values.value.planId,
                      });
                      notice.value =
                        "Test license queued for your verified seller email.";
                    },
                  ),
                ],
              ),
          ])
        : sandbox.value
          ? h(
              "a",
              {
                "data-sandbox-open": "",
                href: applicationHref(
                  `/seller?tenant=${encodeURIComponent(sandbox.value.sandboxSlug)}`,
                ),
              },
              "Open Sandbox",
            )
          : form(
              "sandbox-create",
              "Create Sandbox",
              [
                select("mode", "Sandbox mode", [
                  { id: "fixture", name: "Fixture test data" },
                  ...(stripeAvailable.value
                    ? [{ id: "stripe", name: "Stripe test mode" }]
                    : []),
                ]),
                h(
                  "p",
                  "Choose test data or Stripe test mode. You can't change this later.",
                ),
              ],
              async () => {
                const result = await mutate<{
                  tenant: { slug: string };
                  customerUrl: string;
                  apiBase: string;
                }>("/sandbox", { mode: values.value.mode });
                child.value = {
                  slug: result.tenant.slug,
                  customerUrl: result.customerUrl,
                  apiBase: result.apiBase,
                };
              },
            ),
      child.value &&
        h("div", [
          h(
            "a",
            {
              "data-sandbox-open": "",
              href: applicationHref(
                `/seller?tenant=${encodeURIComponent(child.value.slug)}`,
              ),
            },
            "Open Sandbox",
          ),
          h("p", `Test API: ${window.location.origin}${child.value.apiBase}`),
          h("a", { href: child.value.customerUrl }, "Open test buyer page"),
        ]),
    ];
    const upgrade = () =>
      h("div", { class: "notice" }, [
        h(
          "p",
          flags.value.hostedProConfigured
            ? "Monthly Pro adds outgoing webhooks, automation and daily reports."
            : "Monthly Pro is not available on this server.",
        ),
        props.subscribed &&
          flags.value.hostedProConfigured &&
          h(
            "p",
            "Cancel renewal in billing. After the paid subscription ends, return here to choose a new tier.",
          ),
        flags.value.hostedProConfigured
          ? button(
              props.subscribed ? "Manage current subscription" : "Choose Pro",
              () =>
                void run(async () => {
                  const result = await mutate<{ url: string }>(
                    props.subscribed
                      ? "/platform/portal"
                      : "/platform/checkout",
                    props.subscribed ? {} : { tier: "pro" },
                  );
                  window.location.assign(result.url);
                }),
              pending.value,
            )
          : h(
              "a",
              {
                href: applicationHref("/docs#hosted-tiers"),
                target: "_blank",
                rel: "noopener",
              },
              "Feature guide",
            ),
        !flags.value.hostedProConfigured &&
          props.subscribed &&
          button(
            "Manage platform subscription",
            () =>
              void run(async () => {
                const result = await mutate<{ url: string }>(
                  "/platform/portal",
                  {},
                );
                window.location.assign(result.url);
              }),
            pending.value,
          ),
      ]);
    const operations = () => {
      const data = health.value!,
        summary = data.summary;
      const reportRows = reports.value?.rows || [];
      const reportDayCount = reports.value?.days || Number(reportDays.value);
      const reportEnd = Math.floor(
        (reports.value?.generatedAt || Date.now()) / 86400000,
      );
      const recordedDays = new Map(reportRows.map((row) => [row.day, row]));
      const chartRows = Array.from({ length: reportDayCount }, (_, index) => {
        const day = new Date(
          (reportEnd - reportDayCount + 1 + index) * 86400000,
        )
          .toISOString()
          .slice(0, 10);
        return (
          recordedDays.get(day) || {
            day,
            responses: 0,
            servedBytes: 0,
            storageReads: 0,
            storageReadBytes: 0,
          }
        );
      });
      const responseCount = reportRows.reduce(
        (sum, row) => sum + (row.responses || 0),
        0,
      );
      const deliveredBytes = reportRows.reduce(
        (sum, row) => sum + row.servedBytes,
        0,
      );
      const queueNames: Record<string, string> = {
        work: "Billing & licensing",
        emails: "Email delivery",
        outbound_deliveries: "Webhook delivery",
      };
      const alertNames: Record<string, string> = {
        queue_failed: "Background jobs need attention",
        queue_stalled: "Background jobs are taking longer than expected",
        storage_capacity: "Storage is nearly full",
        bandwidth: "Download traffic reached your alert threshold",
        billing_capacity: "Review your workspace subscription",
      };
      return [
        h("div", { class: "feature-section-heading" }, [
          h("h3", "Basic health"),
          h(
            "span",
            {
              class: {
                "feature-badge": true,
                "is-attention": data.alerts.length > 0,
              },
            },
            data.alerts.length ? "Needs attention" : "Monitoring active",
          ),
        ]),
        h("dl", { class: "feature-stats" }, [
          summary.storage &&
            h("div", [
              h("dt", "Storage used"),
              h("dd", bytesText(summary.storage.usedBytes)),
              h(
                "p",
                `of ${bytesText(summary.storage.limitBytes)}${summary.storage.reservedBytes ? ` · ${bytesText(summary.storage.reservedBytes)} reserved` : ""}`,
              ),
            ]),
          summary.bandwidth &&
            h("div", [
              h("dt", "Delivered in 30 days"),
              h("dd", bytesText(summary.bandwidth.servedBytes)),
              h("p", "Authenticated downloads"),
            ]),
          summary.bandwidth &&
            h("div", [
              h("dt", "Storage reads"),
              h("dd", numberText(summary.bandwidth.storageReads)),
              h(
                "p",
                summary.bandwidth.storageReadBytes === undefined
                  ? "Last 30 days"
                  : `${bytesText(summary.bandwidth.storageReadBytes)} read in 30 days`,
              ),
            ]),
        ]),
        ...data.alerts
          .filter(
            (alert) =>
              !data.notifications.some((item) => item.kind === alert.kind),
          )
          .map((alert) =>
            h(
              "p",
              { class: "feature-attention", role: "status" },
              alertNames[alert.kind] || human(alert.kind),
            ),
          ),
        ...data.notifications.map((item) =>
          h(
            "p",
            { class: "feature-attention" },
            item.kind === "billing_capacity"
              ? "Review your workspace subscription in Billing."
              : item.message,
          ),
        ),
        summary.queues &&
          card(
            "Background activity",
            "Jobs retained in this workspace. Completed includes successful email sends; pending includes jobs currently running. Sandbox jobs belong to their own workspace.",
            [
              h("div", { class: "table-scroll" }, [
                h("table", { class: "feature-queues" }, [
                  h("thead", [
                    h(
                      "tr",
                      [
                        "Queue",
                        "Completed",
                        "Failed",
                        "Pending",
                        "Canceled",
                        "Total",
                        "Oldest pending",
                      ].map((label) => h("th", { scope: "col" }, label)),
                    ),
                  ]),
                  h(
                    "tbody",
                    Object.entries(summary.queues).map(([name, queue]) =>
                      h("tr", [
                        h(
                          "th",
                          { scope: "row" },
                          queueNames[name] || human(name),
                        ),
                        h("td", numberText(queue.completed)),
                        h("td", numberText(queue.failed)),
                        h("td", numberText(queue.pending)),
                        h("td", numberText(queue.canceled)),
                        h("td", numberText(queue.total)),
                        h(
                          "td",
                          queue.oldestAgeMs
                            ? `${Math.ceil(queue.oldestAgeMs / 60000)} min`
                            : "—",
                        ),
                      ]),
                    ),
                  ),
                ]),
              ]),
            ],
          ),
        card(
          "Activity & email history",
          "Daily job activity and the latest 50 email jobs in the selected period. Dates use UTC; results reflect each job’s current state.",
          [
            h("div", { class: "report-toolbar" }, [
              h("div", { class: "form-field" }, [
                h("label", { for: "activity-days" }, "Activity period"),
                h(
                  "select",
                  {
                    id: "activity-days",
                    value: activityDays.value,
                    disabled: pending.value,
                    onChange: (event: Event) => {
                      activityDays.value = (
                        event.target as HTMLSelectElement
                      ).value;
                      activity.value = null;
                    },
                  },
                  [7, 30, 90].map((days) =>
                    h("option", { value: String(days) }, `Last ${days} days`),
                  ),
                ),
              ]),
              button(
                activity.value
                  ? "Refresh activity report"
                  : "Load activity report",
                () =>
                  void run(async () => {
                    activity.value = await props.api.get<ActivityReport>(
                      `/operations/activity?days=${activityDays.value}`,
                    );
                  }),
                pending.value,
              ),
            ]),
            activity.value &&
              h("div", { class: "activity-report" }, [
                h(
                  "p",
                  { class: "analytics-footnote" },
                  `Updated ${new Date(activity.value.generatedAt).toLocaleString()} · ${activity.value.days} UTC calendar days`,
                ),
                h("div", { class: "analytics-chart-grid" }, [
                  trendChart(
                    "Email jobs queued",
                    activity.value.daily.map((row) => ({
                      day: row.day,
                      value: row.emails.total,
                    })),
                  ),
                  trendChart(
                    "All background jobs queued",
                    activity.value.daily.map((row) => ({
                      day: row.day,
                      value:
                        row.emails.total +
                        row.work.total +
                        row.outbound_deliveries.total,
                    })),
                  ),
                ]),
                h(
                  "p",
                  { class: "analytics-footnote" },
                  "Charts group jobs by the day they were queued. Sent means the configured mail transport accepted the message.",
                ),
                h("details", { class: "report-data" }, [
                  h("summary", "View daily activity data"),
                  h("div", { class: "table-scroll" }, [
                    h("table", [
                      h("thead", [
                        h(
                          "tr",
                          [
                            "Date (UTC)",
                            "Email jobs",
                            "Emails sent",
                            "All jobs",
                            "Jobs completed",
                          ].map((label) => h("th", { scope: "col" }, label)),
                        ),
                      ]),
                      h(
                        "tbody",
                        activity.value.daily.map((row) =>
                          h(
                            "tr",
                            [
                              row.day,
                              row.emails.total,
                              row.emails.completed,
                              row.emails.total +
                                row.work.total +
                                row.outbound_deliveries.total,
                              row.emails.completed +
                                row.work.completed +
                                row.outbound_deliveries.completed,
                            ].map((value) => h("td", String(value))),
                          ),
                        ),
                      ),
                    ]),
                  ]),
                ]),
                h("h4", "Recent email history"),
                activity.value.emails.length
                  ? h("div", { class: "table-scroll" }, [
                      h("table", { class: "email-history" }, [
                        h("thead", [
                          h(
                            "tr",
                            ["Queued (UTC)", "Email", "Result", "Attempts"].map(
                              (label) => h("th", { scope: "col" }, label),
                            ),
                          ),
                        ]),
                        h(
                          "tbody",
                          activity.value.emails.map((email) =>
                            h("tr", { key: email.id }, [
                              h(
                                "td",
                                new Date(email.createdAt)
                                  .toISOString()
                                  .replace("T", " ")
                                  .slice(0, 19),
                              ),
                              h(
                                "td",
                                human(email.kind).replace(/^./, (value) =>
                                  value.toUpperCase(),
                                ),
                              ),
                              h(
                                "td",
                                h(
                                  "span",
                                  {
                                    class: [
                                      "license-access-badge",
                                      email.state === "sent"
                                        ? "license-access-active"
                                        : email.state === "failed"
                                          ? "license-access-revoked"
                                          : "",
                                    ],
                                  },
                                  human(email.state).replace(/^./, (value) =>
                                    value.toUpperCase(),
                                  ),
                                ),
                              ),
                              h("td", String(email.attempts)),
                            ]),
                          ),
                        ),
                      ]),
                    ])
                  : h(
                      "p",
                      { class: "feature-empty" },
                      "No email jobs were queued in this period.",
                    ),
              ]),
          ],
        ),
        disclosure(
          "health-settings-disclosure",
          "Alert settings",
          "Adjust when we flag a problem or notify your customers.",
          [
            form(
              "operation-settings",
              "Save health settings",
              [
                ...[
                  ["failureThreshold", "Failed queue threshold"],
                  ["pendingAgeMs", "Stalled queue age, milliseconds"],
                  ["storageRatio", "Storage warning ratio, 0.01 to 1"],
                  ["bandwidthBytes", "Bandwidth warning bytes, 0 disables"],
                  ["cooldownMs", "Alert cooldown, milliseconds"],
                  ["warningDays", "Expiry warning days"],
                ].map(([id, label]) => field(id!, label!, "number")),
                check(
                  "notificationsEnabled",
                  "License lifecycle notifications",
                ),
              ],
              async () => {
                const settings: Values = {
                  notificationsEnabled: values.value.notificationsEnabled!,
                };
                for (const key of [
                  "failureThreshold",
                  "pendingAgeMs",
                  "storageRatio",
                  "bandwidthBytes",
                  "cooldownMs",
                  "warningDays",
                ])
                  settings[key] = Number(values.value[key]);
                await mutate("/operations/settings", settings, "PUT");
                notice.value = "Health settings saved.";
              },
            ),
          ],
        ),
        card("Daily reports", "See download activity over time.", [
          (!props.hosted || data.features.advancedReports) &&
            h("div", { class: "form-field report-period" }, [
              h("label", { for: "download-report-days" }, "Download period"),
              h(
                "select",
                {
                  id: "download-report-days",
                  value: reportDays.value,
                  disabled: pending.value,
                  onChange: (event: Event) => {
                    reportDays.value = (
                      event.target as HTMLSelectElement
                    ).value;
                    reports.value = null;
                  },
                },
                [7, 30, 90].map((days) =>
                  h("option", { value: String(days) }, `Last ${days} days`),
                ),
              ),
            ]),
          !props.hosted || data.features.advancedReports
            ? button(
                "Load advanced daily reports",
                () =>
                  void run(async () => {
                    reports.value = await props.api.get(
                      `/operations/reports${reportDays.value === "30" ? "" : `?days=${reportDays.value}`}`,
                    );
                  }),
                pending.value,
              )
            : h("div", [
                h("p", "Explore daily download reports with monthly Pro."),
                button(
                  "View Pro options",
                  () =>
                    void run(async () => {
                      flags.value = await props.api.get<Flags>("/features");
                      proOptions.value = true;
                    }),
                  pending.value,
                ),
                proOptions.value && upgrade(),
              ]),
          reports.value &&
            reports.value.rows.length > 0 &&
            h("div", { class: "download-performance" }, [
              h("div", { class: "analytics-chart-grid" }, [
                trendChart(
                  "Successful download responses",
                  chartRows.map((row) => ({
                    day: row.day,
                    value: row.responses ?? 0,
                  })),
                ),
                trendChart(
                  "Data delivered",
                  chartRows.map((row) => ({
                    day: row.day,
                    value: row.servedBytes,
                  })),
                  bytesText,
                ),
                trendChart(
                  "Origin storage reads",
                  chartRows.map((row) => ({
                    day: row.day,
                    value: row.storageReads ?? 0,
                  })),
                ),
                trendChart(
                  "Origin data read",
                  chartRows.map((row) => ({
                    day: row.day,
                    value: row.storageReadBytes ?? 0,
                  })),
                  bytesText,
                ),
              ]),
              h("dl", { class: "feature-stats" }, [
                h("div", [
                  h("dt", "Successful responses"),
                  h("dd", numberText(responseCount)),
                ]),
                h("div", [
                  h("dt", "Average response size"),
                  h(
                    "dd",
                    responseCount
                      ? bytesText(deliveredBytes / responseCount)
                      : "—",
                  ),
                ]),
                h("div", [
                  h("dt", "Storage read operations"),
                  h(
                    "dd",
                    numberText(
                      reportRows.reduce(
                        (sum, row) => sum + (row.storageReads || 0),
                        0,
                      ),
                    ),
                  ),
                ]),
              ]),
              h(
                "p",
                { class: "analytics-footnote" },
                "Download responses and origin reads are measured separately. Bytes describe transferred data, including partial responses.",
              ),
            ]),
          reports.value &&
            (reports.value.rows.length
              ? h("div", { class: "table-scroll" }, [
                  h("table", { class: "feature-report-table" }, [
                    h("thead", [
                      h(
                        "tr",
                        [
                          ["Date", "Date"],
                          ["Download responses", "Served"],
                          ["Delivered bytes", "Data"],
                          ["Storage reads", "Reads"],
                        ].map(([label, short]) =>
                          h(
                            "th",
                            { scope: "col", "aria-label": label, title: label },
                            short,
                          ),
                        ),
                      ),
                    ]),
                    h(
                      "tbody",
                      reports.value.rows.map((row) =>
                        h("tr", [
                          h("th", { scope: "row" }, row.day),
                          h("td", numberText(row.responses)),
                          h("td", bytesText(row.servedBytes)),
                          h("td", numberText(row.storageReads)),
                        ]),
                      ),
                    ),
                  ]),
                ])
              : h(
                  "p",
                  { class: "feature-empty" },
                  "No downloads recorded in this period.",
                )),
        ]),
      ];
    };
    const webhooks = () =>
      props.hosted && !flags.value.features.outboundWebhooks
        ? [upgrade()]
        : [
            h("p", "Send license and release events to your app."),
            disclosure(
              "webhook-setup",
              "Add an endpoint",
              "Choose where events go and which events you want.",
              [
                form(
                  "webhook-create",
                  "Add webhook",
                  [
                    field("webhookUrl", "HTTPS endpoint URL", "url"),
                    h("fieldset", [
                      h("legend", "Events"),
                      ...eventTypes.map((event) =>
                        h("label", [
                          h("input", {
                            type: "checkbox",
                            value: event,
                            checked: selectedEvents.value.includes(event),
                            onChange: (change: Event) => {
                              selectedEvents.value = (
                                change.target as HTMLInputElement
                              ).checked
                                ? [...selectedEvents.value, event]
                                : selectedEvents.value.filter(
                                    (value) => value !== event,
                                  );
                            },
                          }),
                          eventTitles[event],
                        ]),
                      ),
                    ]),
                  ],
                  async () => {
                    const result = await mutate<{ secret: string }>(
                      "/webhooks",
                      {
                        url: values.value.webhookUrl,
                        events: selectedEvents.value,
                      },
                    );
                    showSecret(result.secret);
                    await loadWebhooks();
                  },
                ),
              ],
              !endpoints.value.some((endpoint) => endpoint.active),
            ),
            h("div", { class: "feature-endpoint-list" }, [
              ...endpoints.value.map((endpoint) =>
                h("article", { class: "feature-record" }, [
                  h("div", { class: "feature-record-heading" }, [
                    h("h3", endpoint.url),
                    h(
                      "span",
                      { class: "feature-badge" },
                      endpoint.active ? "Active" : "Disabled",
                    ),
                  ]),
                  h(
                    "p",
                    endpoint.events
                      .map((event) => eventTitles[event] || event)
                      .join(" · "),
                  ),
                  endpoint.active &&
                    h("div", { class: "button-row" }, [
                      button(
                        "Rotate signing secret",
                        () =>
                          confirm(
                            "Rotate signing secret? Queued deliveries will use the new secret.",
                            async () => {
                              const result = await mutate<{ secret: string }>(
                                `/webhooks/${encodeURIComponent(endpoint.id)}/rotate`,
                                {},
                              );
                              showSecret(result.secret);
                              await loadWebhooks();
                            },
                          ),
                        pending.value,
                      ),
                      button(
                        "Disable webhook",
                        () =>
                          confirm(
                            "Disable this webhook endpoint?",
                            async () => {
                              await mutate(
                                `/webhooks/${encodeURIComponent(endpoint.id)}`,
                                {},
                                "DELETE",
                              );
                              await loadWebhooks();
                            },
                          ),
                        pending.value,
                      ),
                    ]),
                ]),
              ),
            ]),
            h("h3", "Recent deliveries"),
            deliveries.value.length === 0 &&
              h(
                "p",
                { class: "feature-empty" },
                "No deliveries yet. New events will appear here.",
              ),
            ...deliveries.value.map((delivery) =>
              h("article", { class: "feature-delivery" }, [
                h("div", { class: "feature-delivery-body" }, [
                  h(
                    "strong",
                    (
                      {
                        pending: "Queued",
                        running: "Sending",
                        sent: "Delivered",
                        failed: "Failed",
                        canceled: "Canceled",
                      } as Record<string, string>
                    )[delivery.state] || human(delivery.state),
                  ),
                  h(
                    "p",
                    endpoints.value.find(
                      (endpoint) => endpoint.id === delivery.endpointId,
                    )?.url || "Webhook endpoint",
                  ),
                  h(
                    "p",
                    `${delivery.attempts} ${delivery.attempts === 1 ? "attempt" : "attempts"}`,
                  ),
                  delivery.lastError &&
                    h(
                      "p",
                      (
                        {
                          delivery_failed:
                            "The endpoint did not accept this delivery",
                          retry_expired: "The retry window ended",
                          endpoint_disabled: "The endpoint was disabled",
                          endpoint_changed: "The endpoint changed",
                        } as Record<string, string>
                      )[delivery.lastError] || human(delivery.lastError),
                    ),
                  h(
                    "code",
                    { class: "event-ref", title: delivery.eventId },
                    delivery.eventId.slice(0, 12),
                  ),
                ]),
                delivery.state === "failed" &&
                  button(
                    "Retry failed delivery",
                    () =>
                      void run(async () => {
                        await mutate(
                          `/webhook-deliveries/${encodeURIComponent(delivery.id)}/retry`,
                          {},
                        );
                        await loadWebhooks();
                      }),
                    pending.value,
                  ),
              ]),
            ),
          ];
    const security = () => [
      h(PublisherSecurity, {
        api: props.api,
        platform: props.platform,
        products: props.products,
        initialToken: props.initialToken,
        onExpired: () => emit("expired"),
        onConsumed: () => props.invalidateProof?.(props.page, initialProof),
      }),
      card(
        "Active sessions",
        "Manage the browsers signed in to your account.",
        [
          h("div", { class: "feature-session-list" }, [
            ...sessions.value.map((session) =>
              h("div", { class: "feature-session" }, [
                `${session.current ? "This browser" : "Other browser"}, expires ${new Date(session.expiresAt).toLocaleString()} `,
                button(
                  "Revoke session",
                  () =>
                    confirm("Revoke this session?", async () => {
                      await props.platform.post("/account/sessions/revoke", {
                        id: session.id,
                      });
                      if (session.current) emit("signedOut");
                      else
                        sessions.value = (
                          await props.platform.get<{ sessions: Session[] }>(
                            "/account/sessions",
                          )
                        ).sessions;
                    }),
                  pending.value,
                ),
              ]),
            ),
            ...["others", "all"].map((which) =>
              button(
                `Revoke ${which === "others" ? "other" : "all"} sessions`,
                () =>
                  confirm(
                    `Revoke ${which === "others" ? "other" : "all"} sessions?`,
                    async () => {
                      await props.platform.post(
                        `/account/sessions/revoke-${which}`,
                        {},
                      );
                      if (which === "all") emit("signedOut");
                      else
                        sessions.value = (
                          await props.platform.get<{ sessions: Session[] }>(
                            "/account/sessions",
                          )
                        ).sessions;
                    },
                  ),
                pending.value,
              ),
            ),
          ]),
        ],
      ),
      disclosure(
        "security-recovery",
        "Recovery codes",
        "Create a fresh set and save it somewhere safe. Replacing codes invalidates your previous set.",
        [
          form(
            "recovery-codes",
            "Generate replacement recovery codes",
            [proofField("recovery_codes")],
            async () => {
              const grant = await consumeProof("recovery_codes");
              const result = await props.platform.post<{ codes: string[] }>(
                "/account/recovery-codes",
                { verification: grant.verification },
              );
              showSecret(result.codes.join("\n"));
            },
          ),
        ],
        proofArrived,
      ),
      props.hosted &&
        disclosure(
          "security-email",
          "Change account email",
          "Confirm from both mailboxes in this browser. Open each mailbox link in this tab and identify which mailbox supplied it. If you opened both before choosing, reopen the other link next. You'll sign in again, and your current recovery codes will stop working. Create new ones afterward.",
          [
            pendingEmailTokens.value.length > 0 &&
              h(
                "div",
                { id: "email-change-link", class: "verification-proof" },
                [
                  h(
                    "p",
                    "Which mailbox supplied the link you most recently opened?",
                  ),
                  button(
                    "Use link from current mailbox",
                    () => useEmailChangeLink("currentToken"),
                    pending.value,
                  ),
                  button(
                    "Use link from new mailbox",
                    () => useEmailChangeLink("newToken"),
                    pending.value,
                  ),
                ],
              ),
            form(
              "email-change-request",
              "Request email change",
              [field("email", "New account email", "email")],
              async () => {
                const result = await props.platform.post<{ id: string }>(
                  "/account/email-change/request",
                  { email: values.value.email },
                );
                values.value.changeId = result.id;
                values.value.currentToken = "";
                values.value.newToken = "";
                pendingEmailTokens.value = [];
                retainEmailChange();
                notice.value =
                  "Check both mailboxes and open each link in this tab.";
              },
            ),
            form(
              "email-change-confirm",
              "Confirm email change",
              [
                field("changeId", "Email change request ID"),
                field("currentToken", "Token from current mailbox", "password"),
                field("newToken", "Token from new mailbox", "password"),
              ],
              async () => {
                const body = {
                  id: values.value.changeId,
                  currentToken: values.value.currentToken,
                  newToken: values.value.newToken,
                };
                if (
                  !body.id ||
                  !body.currentToken ||
                  !body.newToken ||
                  body.currentToken === body.newToken
                )
                  throw new ApiError(
                    "Proofs from both different mailboxes are required before confirming the email change.",
                  );
                values.value.currentToken = "";
                values.value.newToken = "";
                pendingEmailTokens.value = [];
                emit("update:emailChange", null);
                await props.platform.post(
                  "/account/email-change/confirm",
                  body,
                );
                emit("signedOut");
              },
            ),
          ],
          Boolean(props.emailChange),
        ),
    ];
    const portability = () => [
      h("p", "Download a private backup of your workspace and release files."),
      button("Refresh exports", () => void run(loadExports), pending.value),
      h(
        "div",
        { class: "feature-export-list" },
        retainedExports.value.map((saved) =>
          h("article", { class: "feature-record" }, [
            h("h3", "Saved export"),
            h(
              "p",
              {
                creating: "Creation in progress",
                ready: "Ready to download",
                cleanup_pending: "Cleanup pending",
              }[saved.status],
            ),
            saved.expiresAt !== null &&
              saved.expiresAt > 0 &&
              h("p", `Expires ${new Date(saved.expiresAt).toLocaleString()}`),
            saved.status === "ready" &&
              button(
                "Show downloads",
                () => {
                  bundle.value = {
                    id: saved.id,
                    expiresAt: saved.expiresAt!,
                    blobs: saved.blobs,
                  };
                },
                pending.value,
              ),
            button(
              "Delete saved export",
              () =>
                confirm("Delete this saved encrypted export?", async () => {
                  await mutate(
                    `/exports/${encodeURIComponent(saved.id)}`,
                    {},
                    "DELETE",
                  );
                  if (bundle.value?.id === saved.id) bundle.value = null;
                  await loadExports();
                }),
              pending.value || saved.status === "creating",
            ),
          ]),
        ),
      ),
      bundle.value &&
        h("div", [
          h(
            "p",
            `Export expires ${new Date(bundle.value.expiresAt).toLocaleString()}. Download every file and keep them together.`,
          ),
          ...[
            { id: "manifest", path: "manifest", name: "manifest.entitle" },
            ...bundle.value.blobs.map((id) => ({
              id,
              path: `blobs/${encodeURIComponent(id)}`,
              name: `${id}.blob`,
            })),
          ].map((file) =>
            button(
              `Download ${file.name}`,
              () =>
                void run(async () => {
                  const data = await props.api.request<Blob>(
                    `/exports/${encodeURIComponent(bundle.value!.id)}/${file.path}`,
                    { headers: { "X-CSRF-Token": props.api.csrfToken } },
                    "blob",
                  );
                  saveBlob(data, file.name);
                }),
              pending.value,
            ),
          ),
          button(
            "Delete export",
            () =>
              confirm("Delete this encrypted export?", async () => {
                await mutate(
                  `/exports/${encodeURIComponent(bundle.value!.id)}`,
                  {},
                  "DELETE",
                );
                bundle.value = null;
                await loadExports();
              }),
            pending.value,
          ),
        ]),
      disclosure(
        "export-create",
        "Create an encrypted export",
        "Choose a passphrase you can keep safely. You'll need it to restore this export.",
        [
          form(
            "tenant-export",
            "Create encrypted export",
            [
              proofField("tenant_transfer"),
              field(
                "passphrase",
                "Export passphrase, at least 12 characters",
                "password",
              ),
            ],
            async () => {
              const passphrase = String(values.value.passphrase);
              values.value.passphrase = "";
              const token = String(values.value["verification-token"] || "");
              values.value["verification-token"] = "";
              props.invalidateProof?.(props.page, initialProof);
              const result = await verifiedRequest<{
                id: string;
                expiresAt: number;
                blobs: string[];
              }>(
                props.platform,
                props.api,
                "tenant_transfer",
                token,
                "/exports",
                {
                  passphrase,
                },
              );
              proofSent.value = false;
              if (alive) bundle.value = result;
              await loadExports();
            },
          ),
        ],
        proofArrived || (retainedExports.value.length === 0 && !bundle.value),
      ),
    ];
    const customer = () => [
      h("h3", "License notifications"),
      ...notifications.value.map((item) =>
        h("p", [
          `${item.kind.replaceAll("_", " ")}. Paid access through ${new Date(item.paidThrough).toLocaleDateString()}. Installed software remains available. `,
          button(
            "Dismiss notification",
            () =>
              void run(async () => {
                await mutate(
                  `/notifications/${encodeURIComponent(item.id)}/dismiss`,
                  {},
                );
                notifications.value = notifications.value.filter(
                  (value) => value.id !== item.id,
                );
              }),
            pending.value,
          ),
        ]),
      ),
      h("h3", "Privacy and account data"),
      button(
        "Download my account data",
        () =>
          void run(async () => {
            const data = await props.api.get("/account/export");
            saveBlob(
              new Blob([JSON.stringify(data, null, 2)], {
                type: "application/json",
              }),
              "entitle-account.json",
            );
          }),
        pending.value,
      ),
      h(
        "p",
        "Request a review to close your account. Your subscriptions and licenses stay active while the request is reviewed.",
      ),
      closure.value?.request &&
        h("div", { class: "feature-request-status" }, [
          h("strong", human(closure.value.request.status)),
          ...closure.value.request.blockers.map((reason) =>
            h("p", human(reason)),
          ),
        ]),
      closure.value?.request?.requestedAt &&
        h(
          "p",
          `Requested ${new Date(closure.value.request.requestedAt).toLocaleDateString()}`,
        ),
      !closure.value?.request &&
        button(
          "Request account closure",
          () =>
            confirm("Request operator review of account closure?", async () => {
              await mutate("/account/closure", {});
              closure.value = await props.api.get("/account/closure");
            }),
          pending.value,
        ),
    ];
    const recovery = () => [
      h(RecoveryPanel, {
        platform: props.platform,
        onComplete: () => emit("signedOut"),
      }),
    ];
    return () =>
      h(
        "section",
        {
          class: "panel seller-panel feature-panel",
          "aria-busy": loading.value || pending.value,
        },
        [
          !props.embedded &&
            h(
              "h2",
              {
                commerce: "Tax settings",
                sandbox: "Sandbox",
                operations: "Operations",
                webhooks: "Outgoing webhooks",
                security: "Account security",
                export: "Tenant export",
                customer: "Account privacy and notifications",
                recovery: "Recover seller access",
              }[props.page],
            ),
          loading.value
            ? h("p", { role: "status" }, "Loading settings…")
            : error.value
              ? h("div", { role: "alert" }, [
                  h("p", error.value),
                  loadError.value
                    ? button("Retry panel", () => void load(), pending.value)
                    : button(
                        "Dismiss error",
                        () => {
                          error.value = "";
                        },
                        pending.value,
                      ),
                ])
              : null,
          notice.value && h("p", { role: "status" }, notice.value),
          !loading.value &&
            !loadError.value &&
            {
              commerce,
              sandbox: renderSandbox,
              operations,
              webhooks,
              security,
              export: portability,
              customer,
              recovery,
            }[props.page]!(),
          oneTime.value &&
            h("div", { class: "key-notice" }, [
              h(
                "p",
                "Shown once. Save these secrets securely before leaving this panel.",
              ),
              h("pre", oneTime.value),
              button(
                "Save secrets offline",
                () =>
                  saveBlob(
                    new Blob([oneTime.value], { type: "text/plain" }),
                    "entitle-secrets.txt",
                  ),
                pending.value,
              ),
              button(
                "I saved these secrets",
                () => {
                  oneTime.value = "";
                },
                pending.value,
              ),
            ]),
        ] as Parameters<typeof h>[2],
      );
  },
});
