import {
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  type PropType,
} from "vue";
import { ApiClient, errorMessage, ApiError } from "./api.ts";
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
      message = ref("");
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
      message.value = "";
      try {
        await action();
      } catch (e) {
        if (alive) message.value = errorMessage(e);
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
          message.value = errorMessage(e);
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
    const button = (label: string, action: () => Promise<void>) =>
      h(
        "button",
        {
          type: "button",
          disabled: pending.value,
          onClick: () => void run(action),
        },
        label,
      );
    return () =>
      h("section", { class: "recovery-panel", "aria-busy": pending.value }, [
        h("h3", "Recover account access"),
        message.value && h("p", { role: "status" }, message.value),
        !flow.value
          ? [
              h(
                "form",
                {
                  id: "account-recovery",
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
                  button("Start ordinary recovery", startOrdinary),
                ],
              ),
              h("details", [
                h("summary", "Operator recovery"),
                field("Operator authorization", operator, "password"),
                button("Use operator authorization", async () => {
                  const token = operator.value;
                  operator.value = "";
                  await props.platform.post(
                    "/account/recovery/operator",
                    { token },
                    false,
                  );
                  await load();
                }),
              ]),
            ]
          : [
              h(
                "p",
                "Recovery access is restricted to replacing your keys. Publisher trust and other privileges require independent operator recovery.",
              ),
              flow.value.mode === "ordinary" && !flow.value.channelVerified
                ? [
                    button("Send recovery confirmation email", async () => {
                      await props.platform.post(
                        "/account/recovery/channel/request",
                        {},
                      );
                      message.value =
                        "Check your existing email for the recovery confirmation.";
                    }),
                    field("Recovery email confirmation", channel, "password"),
                    button("Confirm recovery email", async () => {
                      const token = channel.value;
                      channel.value = "";
                      await props.platform.post(
                        "/account/recovery/channel/consume",
                        { token },
                      );
                      await load();
                    }),
                  ]
                : [
                    field("Replacement key name", name),
                    button("Enroll replacement key", async () => {
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
                      message.value = "Replacement key enrolled.";
                    }),
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
                            message.value =
                              "Recovery complete. Sign in with your new key and save new recovery codes.";
                            emit("complete");
                          },
                        )
                      : h(
                          "p",
                          `Enroll two independent hardware keys, then ask your operator to inventory them and complete recovery after ${new Date(flow.value.notBefore).toLocaleString()}.`,
                        ),
                  ],
              button("Cancel this recovery", async () => {
                await props.platform.post("/account/recovery/cancel", {
                  flowId: flow.value!.id,
                });
                flow.value = null;
                message.value =
                  "Recovery canceled. Your original credentials remain available.";
                emit("complete");
              }),
            ],
      ]);
  },
});
