import {
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  type PropType,
} from "vue";
import { ApiClient, errorMessage, ApiError } from "./api.ts";
import { disclosureLabel, icon, icons } from "./icons.ts";
import { passkeyCeremony, hardwareVerification } from "./oidc.ts";

export const RecoveryPanel = defineComponent({
  props: { platform: { type: Object as PropType<ApiClient>, required: true } },
  emits: ["complete"],
  setup(props, { emit }) {
    const flow = ref<{
      id: string;
      mode: string;
      channelVerified: boolean;
      csrfToken: string;
      notBefore: number;
    } | null>(null);
    const email = ref(""),
      code = ref(""),
      channel = ref(""),
      operator = ref(""),
      name = ref("Replacement key"),
      pending = ref(false),
      message = ref<{ text: string; glyph: string } | null>(null);
    let alive = true;
    const current = () => {
      if (!alive)
        throw new ApiError("Recovery was closed. Resume it from sign-in.");
    };
    onUnmounted(() => {
      alive = false;
      code.value = "";
      channel.value = "";
      operator.value = "";
    });
    const load = async () => {
      const value = await props.platform.get<{
        id: string;
        mode: string;
        channelVerified: boolean;
        csrfToken: string;
        notBefore: number;
      }>("/account/recovery/status");
      if (
        !value ||
        typeof value.id !== "string" ||
        typeof value.csrfToken !== "string"
      )
        throw new ApiError("Recovery status could not be loaded.");
      current();
      flow.value = value;
      props.platform.csrfToken = value.csrfToken;
    };
    const run = async (action: () => Promise<void>) => {
      if (pending.value || !alive) return;
      pending.value = true;
      message.value = null;
      try {
        await action();
      } catch (e) {
        if (alive)
          message.value = { text: errorMessage(e), glyph: icons.warning };
      } finally {
        pending.value = false;
      }
    };
    onMounted(() => {
      void load().catch((e) => {
        if (
          alive &&
          (!(e instanceof ApiError) || ![401, 403].includes(e.status))
        )
          message.value = { text: errorMessage(e), glyph: icons.warning };
      });
    });
    const startOrdinary = async () => {
      const body = { email: email.value, code: code.value };
      code.value = "";
      await props.platform.post("/account/recovery/start", {}, false);
      current();
      await props.platform.post("/account/recovery/consume", body, false);
      await load();
    };
    const field = (label: string, value: { value: string }, type = "text") =>
      h("label", [
        label,
        h("input", {
          id:
            label === "Account email"
              ? "recovery-email"
              : label === "Saved recovery code"
                ? "recovery-code"
                : undefined,
          type,
          value: value.value,
          onInput: (e: Event) => {
            value.value = (e.target as HTMLInputElement).value;
          },
        }),
      ]);
    const button = (
      label: string,
      action: () => Promise<void>,
      glyph: string,
      className?: string,
    ) =>
      h(
        "button",
        {
          type: "button",
          class: className,
          disabled: pending.value,
          onClick: () => void run(action),
        },
        [icon(glyph), h("span", label)],
      );
    return () =>
      h("section", { class: "recovery-panel", "aria-busy": pending.value }, [
        h("h3", [icon(icons.shield), " Recover account access"]),
        message.value &&
          h(
            "div",
            {
              role: "status",
              class:
                message.value.glyph === icons.warning
                  ? "feature-attention"
                  : "seller-signin-sent",
            },
            [icon(message.value.glyph), h("span", message.value.text)],
          ),
        !flow.value
          ? [
              h(
                "form",
                {
                  id: "account-recovery",
                  class: "seller-form feature-form",
                  novalidate: true,
                  onSubmit: (e: Event) => {
                    e.preventDefault();
                    void run(startOrdinary);
                  },
                },
                [
                  h(
                    "p",
                    "Use a saved recovery code and confirm your existing email, or use authorization from your Entitle operator.",
                  ),
                  field("Account email", email, "email"),
                  field("Saved recovery code", code, "password"),
                  h("button", { type: "submit", disabled: pending.value }, [
                    icon(icons.key),
                    h("span", "Start ordinary recovery"),
                  ]),
                ],
              ),
              h("details", { class: "feature-disclosure" }, [
                h(
                  "summary",
                  disclosureLabel("Operator recovery", icons.shield),
                ),
                h("div", { class: "feature-disclosure-content" }, [
                  field("Operator authorization", operator, "password"),
                  button(
                    "Use operator authorization",
                    async () => {
                      const token = operator.value;
                      operator.value = "";
                      await props.platform.post(
                        "/account/recovery/operator",
                        { token },
                        false,
                      );
                      await load();
                    },
                    icons.key,
                    "button-secondary",
                  ),
                ]),
              ]),
            ]
          : [
              h(
                "p",
                "Recovery access is restricted to replacing your keys. Publisher trust and other privileges require independent operator recovery.",
              ),
              flow.value.mode === "ordinary" && !flow.value.channelVerified
                ? [
                    button(
                      "Send recovery confirmation email",
                      async () => {
                        await props.platform.post(
                          "/account/recovery/channel/request",
                          {},
                        );
                        message.value = {
                          text: "Check your existing email for the recovery confirmation.",
                          glyph: icons.mailCheck,
                        };
                      },
                      icons.mailCheck,
                      "button-secondary",
                    ),
                    field("Recovery email confirmation", channel, "password"),
                    button(
                      "Confirm recovery email",
                      async () => {
                        const token = channel.value;
                        channel.value = "";
                        await props.platform.post(
                          "/account/recovery/channel/consume",
                          { token },
                        );
                        await load();
                      },
                      icons.check,
                    ),
                  ]
                : [
                    field("Replacement key name", name),
                    button(
                      "Enroll replacement key",
                      async () => {
                        const start = await props.platform.post<{
                          challengeId: string;
                          options: unknown;
                        }>("/account/security/passkey/enroll", {
                          name: name.value,
                          kind: "security_key",
                        });
                        current();
                        const response = await passkeyCeremony(
                          "create",
                          start.options,
                        );
                        current();
                        await props.platform.post(
                          "/account/security/passkey/confirm",
                          { challengeId: start.challengeId, response },
                        );
                        message.value = {
                          text: "Replacement key enrolled.",
                          glyph: icons.key,
                        };
                      },
                      icons.key,
                    ),
                    flow.value.mode === "ordinary"
                      ? button(
                          "Verify new key and finish recovery",
                          async () => {
                            const proof = await hardwareVerification(
                              props.platform,
                              {
                                action: "security.recovery_complete",
                                flowId: flow.value!.id,
                              },
                            );
                            current();
                            await props.platform.request(
                              "/account/recovery/complete",
                              {
                                method: "POST",
                                headers: {
                                  "content-type": "application/json",
                                  "x-csrf-token": props.platform.csrfToken,
                                  "x-account-verification": proof,
                                },
                                body: "{}",
                              },
                            );
                            flow.value = null;
                            message.value = {
                              text: "Recovery complete. Sign in with your new key and save new recovery codes.",
                              glyph: icons.shield,
                            };
                            emit("complete");
                          },
                          icons.shield,
                        )
                      : h(
                          "p",
                          `Enroll two independent hardware keys, then ask your operator to inventory them and complete recovery after ${new Date(flow.value.notBefore).toLocaleString()}.`,
                        ),
                  ],
              button(
                "Cancel this recovery",
                async () => {
                  await props.platform.post("/account/recovery/cancel", {
                    flowId: flow.value!.id,
                  });
                  flow.value = null;
                  message.value = {
                    text: "Recovery canceled. Your original credentials remain available.",
                    glyph: icons.shield,
                  };
                  emit("complete");
                },
                icons.arrow,
                "button-secondary",
              ),
            ],
      ]);
  },
});
