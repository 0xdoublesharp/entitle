import {
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  type PropType,
} from "vue";
import { ApiClient, ApiError, errorMessage } from "./api.ts";

interface Factor {
  id: string;
  kind: "passkey" | "security_key";
  name: string;
}
interface Publisher {
  id: string;
  name: string;
  product_id: string;
  provider: string;
  subject: string;
  revoked_at: number | null;
}
interface PublisherList {
  audience: string;
  providers: { id: string; issuer: string }[];
  publishers: Publisher[];
}

export async function passkeyCeremony(
  kind: "create" | "get",
  options: unknown,
) {
  if (typeof PublicKeyCredential === "undefined")
    throw new ApiError(
      "Use a browser with WebAuthn support to verify with a passkey or security key.",
    );
  const credential = (await (kind === "create"
    ? navigator.credentials.create({
        publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(
          options as PublicKeyCredentialCreationOptionsJSON,
        ),
      })
    : navigator.credentials.get({
        publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(
          options as PublicKeyCredentialRequestOptionsJSON,
        ),
      }))) as PublicKeyCredential | null;
  if (!credential) throw new ApiError("Passkey verification was canceled.");
  return credential.toJSON();
}

export async function hardwareVerification(
  platform: ApiClient,
  intent: object,
) {
  const started = await platform.post<{
    challengeId: string;
    options: unknown;
  }>("/account/reauth/options", intent);
  const response = await passkeyCeremony("get", started.options);
  return (
    await platform.post<{ verification: string }>("/account/reauth/verify", {
      challengeId: started.challengeId,
      response,
    })
  ).verification;
}

export const PublisherSecurity = defineComponent({
  props: {
    api: { type: Object as PropType<ApiClient>, required: true },
    platform: { type: Object as PropType<ApiClient>, required: true },
    products: {
      type: Array as PropType<{ id: string; name: string; slug?: string }[]>,
      required: true,
    },
    initialToken: { type: String, default: "" },
  },
  emits: ["expired", "consumed"],
  setup(props, { emit }) {
    const tenantScoped = /\/tenants\/[^/]+\/seller$/.test(props.api.basePath);
    const factors = ref<Factor[]>([]),
      publishers = ref<PublisherList | null>(null),
      pending = ref(false),
      error = ref(""),
      loaded = ref(false),
      notice = ref("");
    const emailToken = ref(props.initialToken);
    const emailLoginEnabled = ref(true);
    const pendingRecoveries = ref<{ id: string; mode: string }[]>([]);
    const label = ref("My device"),
      publisherName = ref("Release workflow"),
      provider = ref("github"),
      product = ref(""),
      subject = ref("");
    const repository = ref(""),
      ownerId = ref(""),
      repositoryId = ref(""),
      gitRef = ref("refs/heads/main"),
      workflow = ref(".github/workflows/release.yml"),
      customClaims = ref("{}");
    let alive = true;
    onUnmounted(() => {
      alive = false;
      emailToken.value = "";
    });
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
          if ((failure as { status?: number }).status === 401) emit("expired");
        }
      } finally {
        pending.value = false;
      }
    };
    const load = async () => {
      const [security, trusted] = await Promise.all([
        props.platform.get<{
          factors: Factor[];
          emailLoginEnabled?: boolean;
          pendingRecoveries?: { id: string; mode: string }[];
        }>("/account/security"),
        tenantScoped
          ? props.api.get<PublisherList>("/oidc/publishers")
          : Promise.resolve({
              audience: "",
              providers: [],
              publishers: [],
            } as PublisherList),
      ]);
      if (
        !Array.isArray(security.factors) ||
        !Array.isArray(trusted.publishers) ||
        !Array.isArray(trusted.providers)
      )
        throw new ApiError(
          "Publishing settings could not be loaded. Try again.",
        );
      if (alive) {
        factors.value = security.factors;
        pendingRecoveries.value = security.pendingRecoveries ?? [];
        emailLoginEnabled.value = security.emailLoginEnabled ?? true;
        publishers.value = trusted;
        if (!trusted.providers.some((p) => p.id === provider.value))
          provider.value = trusted.providers[0]?.id ?? "";
        loaded.value = true;
      }
    };
    onMounted(() => void run(load));
    const verify = async (intent: object) => {
      const started = await props.platform.post<{
        challengeId: string;
        options: unknown;
      }>("/account/reauth/options", intent);
      if (!alive) throw new ApiError("Verification was canceled.");
      const response = await passkeyCeremony("get", started.options);
      if (!alive) throw new ApiError("Verification was canceled.");
      const proof = await props.platform.post<{ verification: string }>(
        "/account/reauth/verify",
        { challengeId: started.challengeId, response },
      );
      return proof.verification;
    };
    const approved = <T>(
      client: ApiClient,
      path: string,
      body: object,
      proof: string,
    ) =>
      client.request<T>(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": client.csrfToken,
          "x-account-verification": proof,
        },
        body: JSON.stringify(body),
      });
    const enroll = async (kind: "passkey" | "security_key") => {
      let proof: string;
      if (factors.value.length)
        proof = await verify({ action: "security.manage" });
      else {
        const token = emailToken.value;
        emailToken.value = "";
        emit("consumed");
        proof = (
          await props.platform.post<{ verification: string }>(
            "/account/verification/consume",
            { purpose: "security_enroll", token },
          )
        ).verification;
      }
      const started = await approved<{ challengeId: string; options: unknown }>(
        props.platform,
        "/account/security/passkey/enroll",
        { name: label.value, kind },
        proof,
      );
      if (!alive) return;
      const response = await passkeyCeremony("create", started.options);
      if (!alive) return;
      await props.platform.post("/account/security/passkey/confirm", {
        challengeId: started.challengeId,
        response,
      });
      await load();
      notice.value =
        kind === "security_key"
          ? "Security key enrolled."
          : "Passkey enrolled.";
    };
    const field = (title: string, value: { value: string }, type = "text") =>
      h("label", [
        title,
        h("input", {
          type,
          value: value.value,
          disabled: pending.value,
          autocomplete: type === "password" ? "off" : undefined,
          onInput: (event: Event) => {
            value.value = (event.target as HTMLInputElement).value;
          },
        }),
      ]);
    const button = (text: string, action: () => Promise<void>) =>
      h(
        "button",
        {
          type: "button",
          disabled: pending.value,
          onClick: () => void run(action),
        },
        text,
      );
    const tenant = () => props.api.basePath.split("/").at(-2)!;
    const create = async () => {
      const github =
        publishers.value?.providers.find((p) => p.id === provider.value)
          ?.issuer === "https://token.actions.githubusercontent.com";
      const publisher = {
        name: publisherName.value,
        provider: provider.value,
        product: product.value,
        subject: github
          ? `repo:${repository.value}:ref:${gitRef.value}`
          : subject.value,
        claims: github
          ? {
              repository_id: repositoryId.value,
              repository_owner_id: ownerId.value,
              ref: gitRef.value,
              workflow_ref: `${repository.value}/${workflow.value}@${gitRef.value}`,
            }
          : (JSON.parse(customClaims.value) as object),
      };
      const proof = await verify({
        action: "oidc.create",
        tenant: tenant(),
        publisher,
      });
      await approved(props.api, "/oidc/publishers", publisher, proof);
      await load();
      notice.value = "Publisher trusted. Use its ID in your CI job.";
    };
    return () =>
      h(
        "section",
        {
          class: "feature-card publisher-security",
          "aria-busy": pending.value,
        },
        [
          h("h3", "Passkeys and sign-in"),
          h(
            "p",
            "Trust a CI identity to publish releases for one product. Creating or revoking trust requires fresh verification with independently provisioned hardware. Enroll two physical keys and ask your operator to inventory them before configuring publishers.",
          ),
          error.value && h("p", { role: "alert" }, error.value),
          notice.value && h("p", { role: "status" }, notice.value),
          !loaded.value
            ? button("Load publishing settings", load)
            : h("div", [
                h("h4", "Passkeys and security keys"),
                h(
                  "ul",
                  factors.value.map((f) =>
                    h("li", { key: f.id }, [
                      `${f.name} (${f.kind === "security_key" ? "security key" : "passkey"})`,
                      button("Remove key", async () => {
                        const proof = await verify({
                          action: "security.remove",
                          factorId: f.id,
                        });
                        await approved(
                          props.platform,
                          `/account/security/factors/${f.id}/remove`,
                          {},
                          proof,
                        );
                        await load();
                      }),
                    ]),
                  ),
                ),
                !factors.value.length &&
                  h("div", [
                    h(
                      "p",
                      "Verify your email to enroll your first security factor.",
                    ),
                    button("Send setup verification", async () => {
                      await props.platform.post(
                        "/account/verification/request",
                        { purpose: "security_enroll" },
                      );
                      notice.value =
                        "Open the verification email in this browser.";
                    }),
                    field("Email verification token", emailToken, "password"),
                  ]),
                field("Device name", label),
                h("div", { class: "feature-actions" }, [
                  button("Enroll passkey", () => enroll("passkey")),
                  button("Enroll security key", () => enroll("security_key")),
                ]),
                ...pendingRecoveries.value.map((flow) =>
                  h("div", { class: "recovery-notice", role: "status" }, [
                    h(
                      "p",
                      "Account recovery is underway. Publisher privileges are suspended.",
                    ),
                    button(
                      "Verify original key and cancel recovery",
                      async () => {
                        const proof = await verify({
                          action: "security.recovery_cancel",
                          flowId: flow.id,
                        });
                        await approved(
                          props.platform,
                          "/account/recovery/cancel",
                          { flowId: flow.id },
                          proof,
                        );
                        await load();
                        notice.value = "Recovery canceled.";
                      },
                    ),
                  ]),
                ),
                h("h4", "Email-link sign-in"),
                h(
                  "p",
                  emailLoginEnabled.value
                    ? "Email links are available as a sign-in fallback."
                    : "Email-link sign-in is disabled. Use an enrolled passkey or security key to sign in.",
                ),
                h(
                  "p",
                  "Enroll a backup key before disabling email sign-in. Your last key cannot be removed while email sign-in is disabled.",
                ),
                factors.value.length > 0 &&
                  button(
                    emailLoginEnabled.value
                      ? "Disable email-link sign-in"
                      : "Enable email-link sign-in",
                    async () => {
                      const enabled = !emailLoginEnabled.value;
                      const proof = await verify({
                        action: "security.email_login",
                        enabled,
                      });
                      await approved(
                        props.platform,
                        "/account/security/email-login",
                        { enabled },
                        proof,
                      );
                      await load();
                      notice.value = enabled
                        ? "Email-link sign-in enabled."
                        : "Email-link sign-in disabled.";
                    },
                  ),
                tenantScoped
                  ? h("div", [
                      h("h4", "Trusted publishers"),
                      h("p", [
                        "Audience: ",
                        h("code", publishers.value!.audience),
                      ]),
                      ...publishers.value!.publishers.map((p) =>
                        h("div", { class: "feature-session", key: p.id }, [
                          h("strong", p.name),
                          h("code", p.id),
                          h("p", `${p.provider}: ${p.subject}`),
                          p.revoked_at !== null
                            ? h("span", "Revoked")
                            : button("Revoke publisher", async () => {
                                const proof = await verify({
                                  action: "oidc.revoke",
                                  tenant: tenant(),
                                  publisherId: p.id,
                                });
                                await approved(
                                  props.api,
                                  `/oidc/publishers/${p.id}/revoke`,
                                  {},
                                  proof,
                                );
                                await load();
                                notice.value = "Publisher revoked.";
                              }),
                        ]),
                      ),
                      h(
                        "form",
                        {
                          class: "seller-form feature-form",
                          onSubmit: (event: Event) => {
                            event.preventDefault();
                            void run(create);
                          },
                        },
                        [
                          h("h4", "Add a trusted publisher"),
                          field("Publisher name", publisherName),
                          h("label", [
                            "Product",
                            h(
                              "select",
                              {
                                value: product.value,
                                required: true,
                                disabled: pending.value,
                                onChange: (e: Event) => {
                                  product.value = (
                                    e.target as HTMLSelectElement
                                  ).value;
                                },
                              },
                              [
                                h("option", { value: "" }, "Choose a product"),
                                ...props.products
                                  .filter((p) => p.slug)
                                  .map((p) =>
                                    h("option", { value: p.slug }, p.name),
                                  ),
                              ],
                            ),
                          ]),
                          h("label", [
                            "CI provider",
                            h(
                              "select",
                              {
                                value: provider.value,
                                disabled: pending.value,
                                onChange: (e: Event) => {
                                  provider.value = (
                                    e.target as HTMLSelectElement
                                  ).value;
                                },
                              },
                              publishers.value!.providers.map((p) =>
                                h("option", { value: p.id }, p.id),
                              ),
                            ),
                          ]),
                          publishers.value!.providers.find(
                            (p) => p.id === provider.value,
                          )?.issuer ===
                          "https://token.actions.githubusercontent.com"
                            ? h("div", [
                                field(
                                  "GitHub repository (owner/repo)",
                                  repository,
                                ),
                                field("Repository ID", repositoryId),
                                field("Repository owner ID", ownerId),
                                field("Git ref", gitRef),
                                field("Workflow path", workflow),
                              ])
                            : h("div", [
                                field("Exact OIDC subject", subject),
                                field("Required claims (JSON)", customClaims),
                              ]),
                          h(
                            "button",
                            {
                              type: "submit",
                              disabled: pending.value || !factors.value.length,
                            },
                            "Verify and trust publisher",
                          ),
                        ],
                      ),
                      h(
                        "p",
                        "In CI, set ENTITLE_OIDC_PUBLISHER_ID to the publisher ID and use the publish or publish-asset command. GitHub jobs need id-token: write. Other providers supply ENTITLE_OIDC_TOKEN.",
                      ),
                    ])
                  : h(
                      "p",
                      "Create or select a workspace to configure CI publishing.",
                    ),
              ]),
        ],
      );
  },
});
