import {
  computed,
  createApp,
  defineComponent,
  h,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watch,
} from "vue";
import type { VNodeArrayChildren } from "vue";
import { ApiClient, ApiError, errorMessage, watchLoginTokens } from "./api.ts";
import type { Account, License, Plan, Product } from "./api.ts";
import "./style.css";
import { mountSellerApp } from "./site.ts";
import { mountDocumentation } from "./documentation.ts";
import {
  applicationRoute,
  applicationHref,
  applicationAsset,
} from "./navigation.ts";
import {
  frameworkInfo,
  frameworkOf,
  installationName,
  seatUnit,
} from "./frameworks.ts";
import { SellerFeaturePanel } from "./features.ts";
import { disclosureLabel, icon, icons } from "./icons.ts";
import { site } from "../packages/shared/site.ts";
import {
  CheckoutController,
  emptyCheckoutState,
  planInterval,
  planPrice,
  stripeLoader,
} from "./checkout.ts";
import type {
  CheckoutLoader,
  CheckoutState,
  ElementsCheckout,
  PlanPricing,
} from "./checkout.ts";

type CatalogPlan = Plan & PlanPricing;
type CatalogProduct = Omit<Product, "plans"> & { plans: CatalogPlan[] };

function canRenewLicense(license: License) {
  return (
    !license.revoked &&
    !license.suspended &&
    license.billing_status !== "lifetime" &&
    (license.provenance === "complimentary" ||
      ["canceled", "incomplete_expired", "unpaid"].includes(
        license.billing_status,
      ) ||
      !license.entitled)
  );
}

const tabularNumbers = { fontVariantNumeric: "tabular-nums" };
const date = (value: number | null) =>
  value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
        new Date(value),
      )
    : "Not yet available";
const button = (
  label: string | VNodeArrayChildren,
  action: () => void,
  options: Record<string, unknown> = {},
  leading?: string,
) =>
  h(
    "button",
    { type: "button", onClick: action, ...options },
    leading ? [icon(leading), label] : label,
  );

const Confirmation = defineComponent({
  props: {
    title: { type: String, required: true },
    description: { type: String, required: true },
    confirmLabel: { type: String, required: true },
  },
  emits: ["confirm", "cancel"],
  setup(props, { emit }) {
    const dialog = ref<HTMLDialogElement>();
    onMounted(() => {
      dialog.value?.showModal();
    });
    return () =>
      h(
        "dialog",
        {
          ref: dialog,
          class: "confirm-dialog",
          "aria-labelledby": "confirm-title",
          "aria-describedby": "confirm-description",
          onCancel: (event: Event) => {
            event.preventDefault();
            emit("cancel");
          },
        },
        [
          h("p", { class: "eyebrow" }, [
            icon(icons.warning),
            " Please confirm",
          ]),
          h("h2", { id: "confirm-title" }, props.title),
          h("p", { id: "confirm-description" }, props.description),
          h("div", { class: "button-row" }, [
            button("Cancel", () => emit("cancel"), {
              class: "button-secondary",
              autofocus: true,
            }),
            button(props.confirmLabel, () => emit("confirm"), {
              class: "button-danger",
            }),
          ]),
        ],
      );
  },
});

export function mountCustomerApp(
  target: string | Element = "#app",
  transport?: typeof fetch,
  checkoutLoader: CheckoutLoader = stripeLoader,
) {
  const tenant = /^\/t\/([a-z0-9][a-z0-9-]*)(?:\/)?$/.exec(
    applicationRoute(),
  )?.[1];
  if (!tenant) {
    const invalid = createApp({
      render: () =>
        h("main", { id: "main", class: "page-main" }, [
          h("section", { class: "panel", role: "alert" }, [
            h("h1", "Invalid workspace address."),
            h(
              "p",
              "Check the link from the publisher and try again. Workspace addresses use lowercase letters, numbers, and hyphens.",
            ),
            h("a", { href: applicationHref("/") }, `Go to ${site.name}`),
          ]),
        ]),
    });
    invalid.mount(target);
    return invalid;
  }
  const api = new ApiClient(transport, `/api/v1/tenants/${tenant}`);
  const App = defineComponent({
    setup() {
      const account = ref<Account | null>(null);
      const privacyOpen = ref(false);
      const products = ref<CatalogProduct[]>([]);
      const billingAvailable = ref(true);
      const allowPromotionCodes = ref(false);
      const loading = ref(true);
      const catalogLoading = ref(true);
      const sessionError = ref("");
      const catalogError = ref("");
      const error = ref("");
      const notice = ref("");
      const busy = ref("");
      const returnUrl = new URL(window.location.href);
      const checkoutReturn = returnUrl.searchParams.get("checkout");
      if (["return", "success", "canceled"].includes(checkoutReturn!)) {
        notice.value =
          checkoutReturn === "canceled"
            ? "Checkout was canceled. You can choose a plan and try again."
            : "Payment submitted. Confirmation is pending. After payment is confirmed, check your email for the license key or sign in to view your licenses.";
        returnUrl.searchParams.delete("checkout");
        window.history.replaceState(
          null,
          "",
          returnUrl.pathname + returnUrl.search + returnUrl.hash,
        );
      }

      const checkoutOpen = ref(false);
      const checkoutState = ref<CheckoutState>({ ...emptyCheckoutState });
      const payment = new CheckoutController(checkoutLoader, (state) => {
        checkoutState.value = state;
      });
      const interactionBusy = () =>
        !!busy.value || checkoutState.value.phase === "submitting";
      let checkoutRevision = 0;
      const closeCheckout = () => {
        checkoutRevision++;
        checkoutOpen.value = false;
        payment.dispose();
      };
      onUnmounted(closeCheckout);
      const loginToken = ref<string | null>(null);
      const stopLoginWatcher = watchLoginTokens(
        window.location,
        window.history,
        window,
        (token) => {
          loginToken.value = token;
        },
      );
      onUnmounted(stopLoginWatcher);
      const email = ref("");
      const checkoutEmail = ref("");
      const selectedPlan = ref("");
      const query = new URLSearchParams(window.location.search);
      const prefilledPromotionCode = query.get("promo")?.trim() ?? "";
      const promotionCode = ref(prefilledPromotionCode);
      const renewLicenseId = ref("");
      let requestedRenewal = query.get("renew");
      const renewalProduct = (license: License) =>
        billingAvailable.value && canRenewLicense(license)
          ? products.value.find(
              (product) =>
                product.id === license.product_id && product.plans.length > 0,
            )
          : undefined;
      const renewingLicense = computed(() =>
        account.value?.licenses.find(
          (license) =>
            license.id === renewLicenseId.value && renewalProduct(license),
        ),
      );
      const checkoutProducts = computed(() =>
        products.value.filter(
          (product) =>
            product.plans.length > 0 &&
            (!renewingLicense.value ||
              product.id === renewingLicense.value.product_id),
        ),
      );
      const selectRenewal = (license: License) => {
        const product = renewalProduct(license);
        if (!product) return;
        if (!product.plans.some((plan) => plan.id === selectedPlan.value))
          selectedPlan.value = product.plans[0]!.id;
        renewLicenseId.value = license.id;
        requestedRenewal = null;
      };
      watch([account, products, billingAvailable], () => {
        if (renewLicenseId.value && !renewingLicense.value)
          renewLicenseId.value = "";
        if (!requestedRenewal || checkoutOpen.value) return;
        const license = account.value?.licenses.find(
          (item) => item.id === requestedRenewal,
        );
        if (license) selectRenewal(license);
      });
      const loginSentTo = ref("");
      const newKey = ref<{ licenseId: string; value: string } | null>(null);
      const keyInput = ref<HTMLInputElement>();
      const confirmation = ref<{
        title: string;
        description: string;
        label: string;
        run: () => Promise<void>;
      } | null>(null);

      const fetchAccount = async () => {
        sessionError.value = "";
        try {
          const value = await api.get<Account>("/me");
          const address = value.customer.email;
          if (
            typeof address !== "string" ||
            !Array.isArray(value.licenses) ||
            typeof value.csrfToken !== "string"
          ) {
            throw new Error("Invalid account response.");
          }
          api.csrfToken = value.csrfToken;
          account.value = value;
          checkoutEmail.value = address;
        } catch (failure) {
          if (failure instanceof ApiError && failure.status === 401) {
            account.value = null;
            privacyOpen.value = false;
            api.csrfToken = "";
            newKey.value = null;
            closeCheckout();
          } else if (account.value) {
            error.value = errorMessage(failure);
          } else {
            sessionError.value = errorMessage(failure);
          }
        } finally {
          loading.value = false;
        }
      };
      const fetchCatalog = async () => {
        catalogLoading.value = true;
        catalogError.value = "";
        try {
          const catalog = await api.get<{
            products: CatalogProduct[];
            billingAvailable?: boolean;
            allowPromotionCodes?: boolean;
          }>("/catalog");
          billingAvailable.value = catalog.billingAvailable !== false;
          allowPromotionCodes.value = catalog.allowPromotionCodes === true;
          products.value = catalog.products;
          const plans = products.value.flatMap((product) => product.plans);
          if (!plans.some((plan) => plan.id === selectedPlan.value))
            selectedPlan.value =
              plans.find((plan) => plan.id === query.get("plan"))?.id ??
              plans[0]?.id ??
              "";
        } catch (failure) {
          catalogError.value = errorMessage(failure);
        } finally {
          catalogLoading.value = false;
        }
      };
      const run = async (
        name: string,
        action: () => Promise<void>,
        expireSessionOnUnauthorized = true,
      ) => {
        if (interactionBusy()) return;
        busy.value = name;
        error.value = "";
        notice.value = "";
        try {
          await action();
        } catch (failure) {
          error.value = errorMessage(failure);
          if (
            expireSessionOnUnauthorized &&
            failure instanceof ApiError &&
            failure.status === 401
          ) {
            account.value = null;
            privacyOpen.value = false;
            api.csrfToken = "";
            newKey.value = null;
            closeCheckout();
          }
        } finally {
          busy.value = "";
        }
      };
      const requestLogin = (event: Event) => {
        event.preventDefault();
        void run("login-request", async () => {
          const address = email.value.trim();
          await api.post("/auth/request", { email: address }, false);
          loginSentTo.value = address;
        });
      };
      const consumeLogin = () =>
        void run(
          "login-confirm",
          async () => {
            await api.post("/auth/consume", { token: loginToken.value }, false);
            loginToken.value = null;
            newKey.value = null;
            account.value = null;
            privacyOpen.value = false;
            api.csrfToken = "";
            checkoutEmail.value = "";
            closeCheckout();
            await fetchAccount();
            if (account.value) notice.value = "You are signed in.";
          },
          false,
        );
      const logout = () =>
        void run("logout", async () => {
          await api.post("/auth/logout", {});
          account.value = null;
          privacyOpen.value = false;
          api.csrfToken = "";
          newKey.value = null;
          checkoutEmail.value = "";
          closeCheckout();
          notice.value = "You are signed out.";
        });
      const beginCheckout = () =>
        void run("checkout", async () => {
          const promo = promotionCode.value.trim();
          const revision = ++checkoutRevision;
          payment.dispose();
          checkoutOpen.value = true;
          checkoutState.value = { ...emptyCheckoutState, phase: "loading" };
          let result: ElementsCheckout | { url: string };
          try {
            result = await api.post<ElementsCheckout | { url: string }>(
              "/checkout",
              {
                planId: selectedPlan.value,
                email: checkoutEmail.value.trim(),
                uiMode: "elements",
                ...(promo ? { promotionCode: promo } : {}),
                ...(renewingLicense.value
                  ? { renewLicenseId: renewLicenseId.value }
                  : {}),
              },
              false,
            );
          } catch (failure) {
            closeCheckout();
            throw failure;
          }
          await nextTick();
          if (revision !== checkoutRevision) {
            if ("clientSecret" in result) result.clientSecret = "";
            return;
          }
          if ("url" in result) {
            closeCheckout();
            window.location.assign(result.url);
          } else {
            void payment.start(
              result,
              document.getElementById("stripe-payment")!,
              checkoutEmail.value.trim(),
            );
          }
        });
      const checkout = (event: Event) => {
        event.preventDefault();
        if (loading.value || checkoutOpen.value) return;
        beginCheckout();
      };
      const portal = () =>
        void run("portal", async () => {
          const result = await api.post<{ url: string }>("/portal", {});
          window.location.assign(result.url);
        });
      const rotateKey = (license: License) => {
        confirmation.value = {
          title: "Replace this license key?",
          description: `The current key and all activation tokens for ${license.product_name} will be revoked. Reconnect your ${seatUnit(license)}s with the new key to receive updates. ${frameworkOf(license) === "wordpress" ? "Installed plugin features stay available." : "Installed software stays available."} A recovery email will also be sent.`,
          label: "Replace key",
          run: async () => {
            await run(`key-${license.id}`, async () => {
              const result = await api.post<{ key: string }>(
                `/licenses/${encodeURIComponent(license.id)}/key`,
                {},
              );
              newKey.value = { licenseId: license.id, value: result.key };
              await fetchAccount();
              await nextTick();
              keyInput.value?.focus();
            });
          },
        };
      };
      const deactivate = (id: string, site: string) => {
        confirmation.value = {
          title: "Deactivate this installation?",
          description: `${site} will stop receiving licensed updates and free its seat. Installed software stays available. You can activate the installation again using your license key.`,
          label: "Deactivate installation",
          run: async () => {
            await run(`deactivate-${id}`, async () => {
              await api.post(
                `/installations/${encodeURIComponent(id)}/deactivate`,
                {},
              );
              await fetchAccount();
              notice.value = "Installation deactivated.";
            });
          },
        };
      };
      const copyKey = () =>
        void run("copy-key", async () => {
          if (!newKey.value) return;
          if (!navigator.clipboard) {
            keyInput.value?.focus();
            keyInput.value?.select();
            notice.value = "Key selected. Copy it using your keyboard.";
            return;
          }
          await navigator.clipboard.writeText(newKey.value.value);
          notice.value = "License key copied.";
        });
      onMounted(() => {
        void fetchAccount();
        void fetchCatalog();
      });

      // Checkout opens only for a selected catalog plan, so the lookup always succeeds.
      const selectedPlanDetails = () =>
        products.value
          .flatMap((product) => product.plans)
          .find((plan) => plan.id === selectedPlan.value)!;
      const renderCheckout = () => {
        const state = checkoutState.value;
        const plan = selectedPlanDetails();
        const renewal = planInterval(plan).renewal;
        const finished =
          state.phase === "complete" || state.phase === "pending";
        return h(
          "section",
          {
            class: "payment-panel panel",
            "aria-labelledby": "payment-title",
            "aria-busy":
              state.phase === "loading" || state.phase === "submitting",
          },
          [
            h("p", { class: "eyebrow" }, [
              icon(icons.shield),
              " Secure checkout",
            ]),
            h("h2", { id: "payment-title" }, "Complete your purchase"),
            state.amount &&
              h("div", { class: "order-summary" }, [
                h("span", "Total due today"),
                h(
                  "strong",
                  { style: tabularNumbers },
                  `${state.amount} ${state.currency.toUpperCase()}`,
                ),
                h(
                  "p",
                  plan.billing_interval === "lifetime"
                    ? renewal
                    : `${renewal} Manage or cancel your subscription from your account billing page.`,
                ),
              ]),
            state.phase === "loading" &&
              h("p", { role: "status" }, "Loading secure payment form…"),
            state.error &&
              h("p", { class: "payment-error", role: "alert" }, [
                icon(icons.warning),
                " " + state.error,
              ]),
            finished
              ? h("div", { class: "payment-result", role: "status" }, [
                  h("h3", [
                    icon(
                      state.phase === "complete" ? icons.check : icons.receipt,
                    ),
                    state.phase === "complete"
                      ? " Payment completed"
                      : " Payment submitted. Confirmation is pending.",
                  ]),
                  h(
                    "p",
                    account.value
                      ? "Your license appears after payment is confirmed. Check your email for the key or refresh your licenses."
                      : "Check your email for the license key after payment is confirmed.",
                  ),
                  account.value &&
                    button(
                      busy.value === "refresh"
                        ? "Refreshing licenses…"
                        : "Refresh licenses",
                      () => void run("refresh", fetchAccount),
                      {
                        class: "button-secondary",
                        disabled: interactionBusy(),
                      },
                      icons.refresh,
                    ),
                ])
              : h(
                  "form",
                  {
                    class: "payment-form",
                    onSubmit: (event: Event) => {
                      event.preventDefault();
                      void payment.confirm();
                    },
                  },
                  [
                    h("div", {
                      id: "stripe-payment",
                      class: "payment-element",
                      "aria-label": "Payment details",
                    }),
                    h("p", { class: "small muted" }, [
                      icon(icons.shield),
                      " Your payment details are sent directly to Stripe.",
                    ]),
                    h(
                      "button",
                      {
                        type: "submit",
                        disabled: state.phase !== "ready" || !state.canConfirm,
                      },
                      [
                        icon(icons.card),
                        state.phase === "submitting"
                          ? "Submitting payment…"
                          : "Pay now",
                      ],
                    ),
                  ],
                ),
            h("div", { class: "button-row" }, [
              state.phase === "error" &&
                button(
                  "Retry secure checkout",
                  beginCheckout,
                  {},
                  icons.refresh,
                ),
              button(
                finished ? "Close checkout" : "Cancel checkout",
                closeCheckout,
                {
                  class: "button-secondary",
                  disabled: state.phase === "submitting",
                },
              ),
            ]),
          ],
        );
      };

      const stateLabel = (license: License) =>
        license.revoked
          ? "Revoked"
          : license.suspended
            ? "Suspended"
            : license.billing_status === "lifetime"
              ? "Lifetime"
              : license.entitled
                ? "Active"
                : "Expired";
      const renderLicense = (license: License) => {
        const lifetime = license.billing_status === "lifetime";
        const active = license.installations.filter(
          (item) => item.active && !item.exempt,
        ).length;
        return h(
          "article",
          {
            class: "license-card",
            key: license.id,
            "aria-labelledby": `license-${license.id}`,
          },
          [
            h("div", { class: "card-heading" }, [
              h("div", [
                h(
                  "p",
                  { class: "eyebrow" },
                  license.provenance === "complimentary"
                    ? "Complimentary"
                    : license.plan_name,
                ),
                h("h3", { id: `license-${license.id}` }, [
                  icon(icons.box),
                  " " + license.product_name,
                ]),
              ]),
              h(
                "span",
                {
                  class: [
                    "status",
                    license.entitled ? "status-active" : "status-inactive",
                  ],
                },
                [
                  icon(license.entitled ? icons.check : icons.warning),
                  stateLabel(license),
                ],
              ),
            ]),
            h("dl", { class: "license-facts" }, [
              h("div", [
                h(
                  "dt",
                  lifetime
                    ? "Access"
                    : license.provenance === "complimentary"
                      ? "Expires"
                      : "Paid through",
                ),
                h(
                  "dd",
                  { style: tabularNumbers },
                  lifetime
                    ? "Lifetime"
                    : date(
                        license.provenance === "complimentary"
                          ? (license.expires_at ?? null)
                          : license.paid_through,
                      ),
                ),
              ]),
              h("div", [
                h(
                  "dt",
                  seatUnit(license) === "site" ? "Site seats" : "Device seats",
                ),
                h(
                  "dd",
                  { style: tabularNumbers },
                  `${active} of ${license.site_allowance} used`,
                ),
              ]),
              h("div", [
                h(
                  "dt",
                  license.provenance === "complimentary"
                    ? "License type"
                    : "Billing",
                ),
                h(
                  "dd",
                  { class: "capitalize" },
                  license.provenance === "complimentary"
                    ? "Complimentary · no subscription"
                    : license.billing_status.replaceAll("_", " "),
                ),
              ]),
            ]),
            renewalProduct(license) &&
              button(
                license.provenance === "complimentary"
                  ? "Upgrade to paid"
                  : "Renew license",
                () => {
                  selectRenewal(license);
                  void nextTick(() =>
                    document.getElementById("renewal-notice")?.focus(),
                  );
                },
                {
                  class: "button-secondary",
                  disabled: interactionBusy() || checkoutOpen.value,
                },
              ),
            !license.entitled &&
              h("p", { class: "access-note" }, [
                icon(icons.warning),
                frameworkOf(license) === "wordpress"
                  ? " Downloads and updates are unavailable for this license. Installed plugin features stay available."
                  : " Downloads and updates are unavailable for this license. Installed software stays available.",
              ]),
            newKey.value?.licenseId === license.id &&
              h(
                "section",
                {
                  class: "key-notice",
                  "aria-labelledby": `key-title-${license.id}`,
                },
                [
                  h("h4", { id: `key-title-${license.id}` }, [
                    icon(icons.key),
                    " Save your new license key",
                  ]),
                  h(
                    "p",
                    "This key is shown once. Save it somewhere secure before dismissing it. Use it to reconnect each installation.",
                  ),
                  h(
                    "label",
                    { class: "sr-only", for: "new-license-key" },
                    "New license key",
                  ),
                  h("input", {
                    ref: keyInput,
                    id: "new-license-key",
                    class: "key-input",
                    type: "text",
                    readonly: true,
                    value: newKey.value.value,
                    autocomplete: "off",
                    spellcheck: false,
                    onFocus: (event: FocusEvent) =>
                      (event.target as HTMLInputElement).select(),
                  }),
                  h("div", { class: "button-row" }, [
                    button(
                      busy.value === "copy-key" ? "Copying…" : "Copy key",
                      copyKey,
                      { disabled: interactionBusy() },
                      icons.key,
                    ),
                    button(
                      "I saved my key",
                      () => {
                        newKey.value = null;
                      },
                      {
                        class: "button-secondary",
                        disabled: interactionBusy(),
                      },
                      icons.check,
                    ),
                  ]),
                ],
              ),
            h(
              "section",
              { class: "license-section", "aria-label": "Downloads" },
              [
                h("div", { class: "section-heading" }, [
                  h("h4", [icon(icons.download), " Downloads"]),
                  h(
                    "span",
                    { class: "muted small" },
                    frameworkOf(license) === "wordpress"
                      ? "WordPress plugin ZIP"
                      : `${frameworkInfo[frameworkOf(license)].name} target assets`,
                  ),
                ]),
                license.releases.length === 0
                  ? h(
                      "p",
                      { class: "empty-message" },
                      "No releases are available yet.",
                    )
                  : h(
                      "ul",
                      { class: "release-list" },
                      license.releases.map((release) =>
                        h("li", { key: release.id }, [
                          h("div", { class: "release-row" }, [
                            h("div", [
                              h("strong", { class: "record-metadata" }, [
                                "Version ",
                                h(
                                  "code",
                                  { class: "metadata-chip" },
                                  release.version,
                                ),
                              ]),
                              h(
                                "p",
                                { class: "muted small requirements" },
                                [
                                  release.min_wp &&
                                    `WordPress ${release.min_wp}+`,
                                  release.min_php && `PHP ${release.min_php}+`,
                                  release.min_free &&
                                    `Free plugin ${release.min_free}+`,
                                ]
                                  .filter(Boolean)
                                  .join(" · "),
                              ),
                            ]),
                            frameworkOf(license) === "wordpress" &&
                              (license.entitled
                                ? h(
                                    "a",
                                    {
                                      class:
                                        "button button-secondary button-small",
                                      href: `${api.basePath}/licenses/${encodeURIComponent(license.id)}/releases/${encodeURIComponent(release.id)}/download`,
                                    },
                                    [icon(icons.download), "Download"],
                                  )
                                : h(
                                    "span",
                                    { class: "muted small" },
                                    "Access unavailable",
                                  )),
                          ]),
                          frameworkOf(license) !== "wordpress" &&
                            (release.assets?.length
                              ? h(
                                  "ul",
                                  { class: "asset-list" },
                                  release.assets.map((asset) =>
                                    h("li", { key: asset.id }, [
                                      h("div", { class: "record-metadata" }, [
                                        h(
                                          "code",
                                          { class: "metadata-chip" },
                                          asset.target,
                                        ),
                                        ` · ${asset.filename} · ${asset.size} bytes`,
                                      ]),
                                      asset.min_system_version &&
                                        h(
                                          "p",
                                          `Minimum system version ${asset.min_system_version}`,
                                        ),
                                      h("p", { class: "record-metadata" }, [
                                        "SHA-256 ",
                                        h(
                                          "code",
                                          { class: "checksum metadata-chip" },
                                          asset.checksum,
                                        ),
                                      ]),
                                      license.entitled
                                        ? h(
                                            "a",
                                            {
                                              class:
                                                "button button-secondary button-small",
                                              href: `${api.basePath}/licenses/${encodeURIComponent(license.id)}/assets/${encodeURIComponent(asset.id)}/download`,
                                            },
                                            [
                                              icon(icons.download),
                                              "Download " + asset.target,
                                            ],
                                          )
                                        : h("span", "Access unavailable"),
                                    ]),
                                  ),
                                )
                              : h("p", "No target assets are available.")),
                          h("details", { class: "release-details" }, [
                            h(
                              "summary",
                              disclosureLabel(
                                `Release notes and checksum for ${release.version}`,
                              ),
                            ),
                            h(
                              "p",
                              { class: "changelog" },
                              release.changelog || "No release notes provided.",
                            ),
                            h("p", { class: "small muted" }, "SHA-256"),
                            h("div", { class: "record-metadata" }, [
                              h(
                                "code",
                                { class: "checksum metadata-chip" },
                                release.checksum,
                              ),
                            ]),
                          ]),
                        ]),
                      ),
                    ),
              ],
            ),
            h(
              "section",
              { class: "license-section", "aria-label": "Installations" },
              [
                h("div", { class: "section-heading" }, [
                  h("h4", [icon(icons.layers), " Installations"]),
                  h(
                    "span",
                    { class: "muted small", style: tabularNumbers },
                    `${license.installations.filter((item) => item.active).length} active`,
                  ),
                ]),
                license.installations.length === 0
                  ? h(
                      "p",
                      { class: "empty-message" },
                      frameworkOf(license) === "wordpress"
                        ? "Activate the plugin on your WordPress site using your license key. Your installations will appear here."
                        : `Activate your ${seatUnit(license) === "site" ? "extension on your site" : "app on your device"} using your license key. Your installations will appear here.`,
                    )
                  : h(
                      "ul",
                      { class: "installation-list" },
                      license.installations.map((installation) =>
                        h("li", { key: installation.id }, [
                          h("div", { class: "site-info" }, [
                            h("div", { class: "record-metadata" }, [
                              h(
                                installation.label ? "span" : "code",
                                {
                                  class: installation.label
                                    ? "site-url"
                                    : "metadata-chip",
                                },
                                installationName(installation),
                              ),
                            ]),
                            h(
                              "span",
                              { class: "muted small" },
                              `${installation.active ? "Active" : "Inactive"}${installation.exempt ? " · Does not use a seat" : ""}`,
                            ),
                          ]),
                          installation.active &&
                            button(
                              busy.value === `deactivate-${installation.id}`
                                ? "Deactivating…"
                                : "Deactivate",
                              () =>
                                deactivate(
                                  installation.id,
                                  installationName(installation),
                                ),
                              {
                                class: "button-danger button-small",
                                disabled: interactionBusy(),
                                "aria-label": `Deactivate ${installationName(installation)}`,
                              },
                            ),
                        ]),
                      ),
                    ),
              ],
            ),
            h("div", { class: "license-footer" }, [
              h(
                "p",
                { class: "muted small" },
                "Lost your license key? Replace it to get a new one.",
              ),
              button(
                busy.value === `key-${license.id}`
                  ? "Replacing…"
                  : "Replace license key",
                () => rotateKey(license),
                {
                  class: "button-danger button-small",
                  disabled: interactionBusy(),
                },
                icons.key,
              ),
            ]),
          ],
        );
      };

      return () =>
        h("div", { class: "app" }, [
          h("a", { href: "#main", class: "skip-link" }, "Skip to content"),
          h("header", { class: "site-header" }, [
            h(
              "a",
              {
                href: applicationHref("/"),
                class: "brand",
                "aria-label": `${site.name} home`,
              },
              [
                h("img", {
                  class: "brand-mark",
                  src: applicationAsset("/favicon.svg"),
                  alt: "",
                  width: 36,
                  height: 36,
                  "aria-hidden": "true",
                }),
                h("span", site.name),
              ],
            ),
            h("nav", { "aria-label": "Main navigation" }, [
              h("a", { href: "#plans" }, "Plans"),
              account.value
                ? button(
                    busy.value === "logout" ? "Signing out…" : "Sign out",
                    logout,
                    { class: "button-text", disabled: interactionBusy() },
                    icons.logout,
                  )
                : h("a", { href: "#sign-in" }, "Sign in"),
            ]),
          ]),
          h("main", { id: "main", class: "page-main" }, [
            h(
              "div",
              {
                class: "global-messages",
                "aria-live": "polite",
                "aria-atomic": "true",
              },
              [notice.value && h("p", { class: "notice" }, notice.value)],
            ),
            error.value &&
              h("div", { class: "error-banner", role: "alert" }, [
                h("p", error.value),
                button(
                  "Dismiss",
                  () => {
                    error.value = "";
                  },
                  { class: "button-text" },
                ),
              ]),
            loginToken.value !== null &&
              h(
                "section",
                {
                  class: "login-confirm panel",
                  "aria-labelledby": "login-confirm-title",
                },
                [
                  h("div", { class: "panel-icon" }, [icon(icons.shield)]),
                  h("div", [
                    h(
                      "h1",
                      { id: "login-confirm-title" },
                      account.value
                        ? "Switch to the account from this link?"
                        : "Continue to your account",
                    ),
                    h(
                      "p",
                      `${account.value ? `You are signed in as ${account.value.customer.email}. Confirm to sign in with the emailed link instead, or cancel to stay signed in. ` : "Confirm below to use your emailed sign-in link. "}Links expire after 15 minutes and can only be used once.`,
                    ),
                    h("div", { class: "button-row" }, [
                      button(
                        busy.value === "login-confirm"
                          ? "Signing in…"
                          : "Confirm sign in",
                        consumeLogin,
                        {
                          disabled:
                            loading.value ||
                            interactionBusy() ||
                            !loginToken.value,
                        },
                        icons.key,
                      ),
                      button(
                        "Cancel",
                        () => {
                          loginToken.value = null;
                        },
                        {
                          class: "button-secondary",
                          disabled: interactionBusy(),
                        },
                      ),
                    ]),
                  ]),
                ],
              ),
            loading.value
              ? h(
                  "div",
                  { class: "loading-panel", role: "status" },
                  "Loading your account…",
                )
              : sessionError.value
                ? h("section", { class: "panel" }, [
                    h("h1", "Your account could not be loaded"),
                    h("p", { role: "alert" }, sessionError.value),
                    button(
                      "Try again",
                      () => {
                        loading.value = true;
                        void fetchAccount();
                      },
                      { disabled: interactionBusy() },
                    ),
                  ])
                : account.value
                  ? h(
                      "section",
                      {
                        class: "dashboard",
                        "aria-labelledby": "dashboard-title",
                      },
                      [
                        h("div", { class: "page-heading" }, [
                          h("div", [
                            h("p", { class: "eyebrow" }, "Customer account"),
                            h("h1", { id: "dashboard-title" }, "Your licenses"),
                            h(
                              "p",
                              { class: "muted account-email" },
                              account.value.customer.email,
                            ),
                          ]),
                          h("div", { class: "button-row account-actions" }, [
                            account.value.licenses.length > 0 &&
                              button(
                                busy.value === "refresh"
                                  ? "Refreshing licenses…"
                                  : "Refresh licenses",
                                () => void run("refresh", fetchAccount),
                                {
                                  class: "button-secondary",
                                  disabled: interactionBusy(),
                                },
                                icons.refresh,
                              ),
                            account.value.billingAvailable !== false &&
                              button(
                                [
                                  icon(icons.card),
                                  busy.value === "portal"
                                    ? "Opening billing…"
                                    : "Manage billing",
                                  // Retain the existing button text for portal integrations.
                                  busy.value !== "portal" &&
                                    h("span", { hidden: true }, " ↗"),
                                ],
                                portal,
                                {
                                  class: "button-secondary",
                                  disabled: interactionBusy(),
                                },
                              ),
                          ]),
                        ]),
                        h(
                          "details",
                          {
                            class: "account-privacy",
                            onToggle: (event: Event) => {
                              privacyOpen.value = (
                                event.target as HTMLDetailsElement
                              ).open;
                            },
                          },
                          [
                            h(
                              "summary",
                              disclosureLabel(
                                "Notifications and privacy",
                                icons.shield,
                              ),
                            ),
                            privacyOpen.value &&
                              h(SellerFeaturePanel, {
                                key: account.value.customer.id,
                                page: "customer",
                                api,
                                platform: api,
                                hosted: false,
                                products: [],
                                confirm: (
                                  title: string,
                                  label: string,
                                  run: () => Promise<void>,
                                ) => {
                                  confirmation.value = {
                                    title,
                                    description:
                                      "The service operator will review your request. Manage subscription renewals separately in billing.",
                                    label,
                                    run,
                                  };
                                },
                                onExpired: () => {
                                  account.value = null;
                                  privacyOpen.value = false;
                                  api.csrfToken = "";
                                },
                              }),
                          ],
                        ),
                        account.value.licenses.length
                          ? h(
                              "div",
                              { class: "license-grid" },
                              account.value.licenses.map(renderLicense),
                            )
                          : h("div", { class: "panel empty-account" }, [
                              h("h2", "No licenses in this account"),
                              h(
                                "p",
                                "If you just paid, wait for the license email, then refresh. If you expected a license, sign in with the address that received it.",
                              ),
                              button(
                                "Refresh licenses",
                                () => void run("refresh", fetchAccount),
                                {
                                  class: "button-secondary",
                                  disabled: interactionBusy(),
                                },
                                icons.refresh,
                              ),
                            ]),
                      ],
                    )
                  : h(
                      "section",
                      { class: "welcome", "aria-labelledby": "welcome-title" },
                      [
                        h("div", { class: "welcome-copy" }, [
                          h("h1", { id: "welcome-title" }, "Your software licenses"),
                          h(
                            "p",
                            { class: "intro" },
                            "Sign in to download releases, replace a license key, or manage your installations.",
                          ),
                          h(
                            "p",
                            { class: "small muted" },
                            "Purchases and accounts are specific to this seller.",
                          ),
                        ]),
                        h(
                          "section",
                          {
                            id: "sign-in",
                            class: "sign-in-card",
                            "aria-labelledby": "sign-in-title",
                          },
                          [
                            h("span", { class: "panel-icon" }, [
                              icon(icons.key),
                            ]),
                            h(
                              "h2",
                              { id: "sign-in-title" },
                              "Sign in to your account",
                            ),
                            h(
                              "p",
                              "Enter the email address you used for your license.",
                            ),
                            h("form", { onSubmit: requestLogin }, [
                              h(
                                "label",
                                { for: "login-email" },
                                "Email address",
                              ),
                              h("input", {
                                id: "login-email",
                                type: "email",
                                required: true,
                                autocomplete: "email",
                                placeholder: "you@example.com",
                                value: email.value,
                                onInput: (event: Event) => {
                                  email.value = (
                                    event.target as HTMLInputElement
                                  ).value;
                                  loginSentTo.value = "";
                                },
                              }),
                              h(
                                "button",
                                { type: "submit", disabled: interactionBusy() },
                                [
                                  icon(icons.arrow),
                                  busy.value === "login-request"
                                    ? "Sending link…"
                                    : "Email me a sign-in link",
                                ],
                              ),
                            ]),
                            loginSentTo.value &&
                              h(
                                "div",
                                {
                                  class: "inline-notice seller-signin-sent",
                                  role: "status",
                                },
                                [
                                  icon(icons.mailCheck),
                                  h("div", [
                                    h("h3", "Check your email"),
                                    h("p", [h("strong", loginSentTo.value)]),
                                    h(
                                      "p",
                                      "If an account exists for this address, check your inbox or spam folder for a sign-in link. The link works once and expires after 15 minutes.",
                                    ),
                                  ]),
                                ],
                              ),
                          ],
                        ),
                      ],
                    ),
            h(
              "section",
              {
                id: "plans",
                class: "catalog",
                "aria-labelledby": "plans-title",
              },
              [
                h("div", { class: "page-heading" }, [
                  h("div", [
                    h(
                      "h2",
                      { id: "plans-title" },
                      "Available plans",
                    ),
                  ]),
                ]),
                catalogLoading.value
                  ? h("p", { role: "status" }, "Loading plans…")
                  : catalogError.value
                    ? h("div", { class: "panel" }, [
                        h("p", { role: "alert" }, catalogError.value),
                        button(
                          "Reload plans",
                          () => {
                            void fetchCatalog();
                          },
                          { class: "button-secondary" },
                        ),
                      ])
                    : !billingAvailable.value
                      ? h(
                          "p",
                          { class: "empty-message" },
                          "Paid checkout is unavailable. Contact the publisher about purchase options.",
                        )
                      : products.value.length === 0
                        ? h(
                            "p",
                            { class: "empty-message" },
                            "No plans are available yet. Please check back soon.",
                          )
                        : checkoutProducts.value.length === 0
                          ? h(
                              "p",
                              { class: "empty-message" },
                              "No paid plans are available yet.",
                            )
                          : h(
                              "form",
                              { onSubmit: checkout, class: "checkout-form" },
                              [
                                renewingLicense.value &&
                                  h(
                                    "div",
                                    { class: "access-note renewal-notice" },
                                    [
                                      h(
                                        "p",
                                        { id: "renewal-notice", tabindex: -1 },
                                        `Renewing existing license for ${renewingLicense.value.product_name} — your current license key and active installations stay intact.`,
                                      ),
                                      button(
                                        "Cancel renewal",
                                        () => {
                                          renewLicenseId.value = "";
                                        },
                                        {
                                          class:
                                            "button-secondary button-small",
                                          disabled: checkoutOpen.value,
                                        },
                                      ),
                                    ],
                                  ),
                                ...checkoutProducts.value.map((product) =>
                                  h(
                                    "fieldset",
                                    { key: product.id, class: "product-plans" },
                                    [
                                      h("legend", [
                                        icon(icons.box),
                                        " " + product.name,
                                      ]),
                                      h(
                                        "div",
                                        { class: "plans-grid" },
                                        product.plans.map((plan) => {
                                          const price = planPrice(plan);
                                          return h(
                                            "label",
                                            {
                                              class: [
                                                "plan-card",
                                                selectedPlan.value ===
                                                  plan.id && "plan-selected",
                                              ],
                                              key: plan.id,
                                            },
                                            [
                                              h("input", {
                                                type: "radio",
                                                name: "plan",
                                                value: plan.id,
                                                checked:
                                                  selectedPlan.value ===
                                                  plan.id,
                                                onChange: () => {
                                                  selectedPlan.value = plan.id;
                                                },
                                                required: true,
                                                disabled: checkoutOpen.value,
                                              }),
                                              h(
                                                "span",
                                                { class: "plan-name" },
                                                plan.name,
                                              ),
                                              h(
                                                "span",
                                                {
                                                  class: "plan-seats",
                                                  style: tabularNumbers,
                                                },
                                                [
                                                  String(plan.site_allowance),
                                                  h(
                                                    "span",
                                                    ` ${seatUnit(product)}${plan.site_allowance === 1 ? "" : "s"}`,
                                                  ),
                                                ],
                                              ),
                                              price &&
                                                h(
                                                  "span",
                                                  {
                                                    class: "plan-price",
                                                    style: tabularNumbers,
                                                  },
                                                  price,
                                                ),
                                              h(
                                                "span",
                                                { class: "muted small" },
                                                [
                                                  icon(icons.card),
                                                  " " +
                                                    planInterval(plan).label,
                                                ],
                                              ),
                                            ],
                                          );
                                        }),
                                      ),
                                    ],
                                  ),
                                ),
                                h("div", { class: "checkout-bar" }, [
                                  h("div", { class: "checkout-email" }, [
                                    h(
                                      "label",
                                      { for: "checkout-email" },
                                      "Purchase email",
                                    ),
                                    h("input", {
                                      id: "checkout-email",
                                      disabled: checkoutOpen.value,
                                      type: "email",
                                      autocomplete: "email",
                                      required: true,
                                      placeholder: "you@example.com",
                                      value: checkoutEmail.value,
                                      onInput: (event: Event) => {
                                        checkoutEmail.value = (
                                          event.target as HTMLInputElement
                                        ).value;
                                      },
                                    }),
                                  ]),
                                  (allowPromotionCodes.value ||
                                    prefilledPromotionCode) &&
                                    h("div", { class: "checkout-email" }, [
                                      h(
                                        "label",
                                        { for: "promotion-code" },
                                        "Promotion code",
                                      ),
                                      h("input", {
                                        id: "promotion-code",
                                        type: "text",
                                        placeholder: "BF30",
                                        disabled: checkoutOpen.value,
                                        value: promotionCode.value,
                                        onInput: (event: Event) => {
                                          promotionCode.value = (
                                            event.target as HTMLInputElement
                                          ).value;
                                        },
                                      }),
                                    ]),
                                  h(
                                    "button",
                                    {
                                      type: "submit",
                                      disabled:
                                        loading.value ||
                                        interactionBusy() ||
                                        !selectedPlan.value ||
                                        checkoutOpen.value,
                                    },
                                    [
                                      icon(icons.arrow),
                                      busy.value === "checkout"
                                        ? "Preparing secure payment…"
                                        : "Continue to payment",
                                    ],
                                  ),
                                ]),
                                h(
                                  "p",
                                  { class: "small muted checkout-note" },
                                  "Your license becomes available after payment is confirmed. Expired licenses do not disable installed software.",
                                ),
                              ],
                            ),
              ],
            ),
            checkoutOpen.value && renderCheckout(),
          ]),
          h("footer", { class: "site-footer" }, [
            h("span", site.name),
            h("span", "Software licenses by doublesharp"),
            h(
              "a",
              { href: applicationHref("/docs#licensing") },
              "Source & licenses",
            ),
          ]),
          confirmation.value &&
            h(Confirmation, {
              title: confirmation.value.title,
              description: confirmation.value.description,
              confirmLabel: confirmation.value.label,
              onCancel: () => {
                confirmation.value = null;
              },
              onConfirm: () => {
                const action = confirmation.value?.run;
                confirmation.value = null;
                void action?.();
              },
            }),
        ]);
    },
  });

  const app = createApp(App);
  app.mount(target);
  return app;
}

export function mountSiteApp(
  target: string | Element = "#app",
  transport?: typeof fetch,
) {
  const route = applicationRoute();
  if (route.startsWith("/t/")) return mountCustomerApp(target, transport);
  if (/^\/docs\/?$/.test(route)) return mountDocumentation(target, transport);
  return mountSellerApp(target, transport);
}
