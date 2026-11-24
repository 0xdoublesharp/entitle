import {
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
  type PropType,
} from "vue";
import { ApiClient, ApiError, errorMessage } from "./api.ts";
import { disclosureLabel, icon, icons } from "./icons.ts";

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
  issuer?: string;
  subject: string;
  claims?: Record<string, string | boolean | number>;
  revoked_at: number | null;
}
interface PublisherList {
  audience: string;
  providers: { id: string; issuer: string }[];
  publishers: Publisher[];
}

type DescriptorJSON = { id: string; type: string; transports?: string[] };
type BinaryField =
  | "clientDataJSON"
  | "attestationObject"
  | "authenticatorData"
  | "signature"
  | "userHandle";
const fromBase64url = (value: string) =>
  Uint8Array.from(
    atob(
      value
        .replaceAll("-", "+")
        .replaceAll("_", "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    ),
    (character) => character.charCodeAt(0),
  );
const toBase64url = (value: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const descriptors = (list?: DescriptorJSON[]) =>
  list?.map((item) => ({ ...item, id: fromBase64url(item.id) }));
// Browsers without WebAuthn Level 3 JSON helpers (Safari before 18.4) need manual decoding.
const decodeOptions = {
  create: (json: PublicKeyCredentialCreationOptionsJSON) => ({
    ...json,
    challenge: fromBase64url(json.challenge),
    user: { ...json.user, id: fromBase64url(json.user.id) },
    excludeCredentials: descriptors(json.excludeCredentials),
  }) as unknown as PublicKeyCredentialCreationOptions,
  get: (json: PublicKeyCredentialRequestOptionsJSON) => ({
    ...json,
    challenge: fromBase64url(json.challenge),
    allowCredentials: descriptors(json.allowCredentials),
  }) as unknown as PublicKeyCredentialRequestOptions,
};
const credentialJSON = (credential: PublicKeyCredential) => {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const response = credential.response as unknown as Partial<
    Record<BinaryField, ArrayBuffer | null>
  > & { getTransports?: () => string[] };
  const fields: BinaryField[] = [
    "clientDataJSON",
    "attestationObject",
    "authenticatorData",
    "signature",
    "userHandle",
  ];
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    response: {
      ...Object.fromEntries(
        fields
          .filter((field) => response[field])
          .map((field) => [field, toBase64url(response[field]!)]),
      ),
      transports: response.getTransports?.(),
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
};
const ceremonyErrors = new Map([
  [
    "NotAllowedError",
    "Passkey verification was canceled or timed out. Try again when you are ready.",
  ],
  [
    "InvalidStateError",
    "This passkey or security key is already registered. Use a different key.",
  ],
  [
    "SecurityError",
    "Passkeys are unavailable on this page. Open the site at its configured HTTPS address.",
  ],
  ["AbortError", "Passkey verification was interrupted. Try again."],
  [
    "NotSupportedError",
    "This browser or key does not support the requested passkey type.",
  ],
  [
    "ConstraintError",
    "This key cannot meet the verification requirements. Use a key that supports a PIN or biometric check.",
  ],
]);

export async function passkeyCeremony(
  kind: "create" | "get",
  options: unknown,
) {
  if (typeof PublicKeyCredential === "undefined")
    throw new ApiError(
      "Use a browser with WebAuthn support to verify with a passkey or security key.",
    );
  let credential: PublicKeyCredential | null;
  try {
    credential = (await (kind === "create"
      ? navigator.credentials.create({
          publicKey:
            typeof PublicKeyCredential.parseCreationOptionsFromJSON ===
            "function"
              ? PublicKeyCredential.parseCreationOptionsFromJSON(
                  options as PublicKeyCredentialCreationOptionsJSON,
                )
              : decodeOptions.create(
                  options as PublicKeyCredentialCreationOptionsJSON,
                ),
        })
      : navigator.credentials.get({
          publicKey:
            typeof PublicKeyCredential.parseRequestOptionsFromJSON ===
            "function"
              ? PublicKeyCredential.parseRequestOptionsFromJSON(
                  options as PublicKeyCredentialRequestOptionsJSON,
                )
              : decodeOptions.get(
                  options as PublicKeyCredentialRequestOptionsJSON,
                ),
        }))) as PublicKeyCredential | null;
  } catch (failure) {
    throw new ApiError(
      ceremonyErrors.get((failure as Error).name) ??
        "Passkey verification failed. Try again or use another key.",
    );
  }
  if (!credential) throw new ApiError("Passkey verification was canceled.");
  return credentialJSON(credential);
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

const publisherPolicyCopy: Record<PrivilegedPolicy, string> = {
  hardware:
    "Trust a CI identity to publish releases for one product. Creating or revoking trust requires fresh verification with independently provisioned hardware. Enroll two physical keys and ask your operator to inventory them before configuring publishers.",
  passkey:
    "Trust a CI identity to publish releases for one product. Creating or revoking trust requires fresh verification with a passkey or security key on this account.",
};
const privilegedSetupCopy: Record<PrivilegedPolicy, string> = {
  hardware:
    "Privileged actions stay locked until your operator approves two of your hardware keys.",
  passkey:
    "Enroll a passkey or security key to approve API keys, browser releases, and trusted publishers.",
};
const parseClaims = (value: string): object => {
  try {
    const claims: unknown = JSON.parse(value);
    if (claims && typeof claims === "object" && !Array.isArray(claims))
      return claims;
  } catch {
    // Reported below with the same guidance as other invalid values.
  }
  throw new ApiError(
    'Required claims must be a JSON object, such as {"project_id":"123"}.',
  );
};
export type PrivilegedPolicy = "hardware" | "passkey";
export const privilegedPolicyOf = (value: unknown): PrivilegedPolicy =>
  value === "passkey" ? "passkey" : "hardware";

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
    const policy = ref<PrivilegedPolicy>("hardware"),
      privilegedReady = ref(true);
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
    const publisherError = ref("");
    // Workspace failures, such as a suspended workspace, must not hide passkey
    // management or recovery cancellation, so publishers load independently.
    const listPublishers = () =>
      props.api.get<PublisherList>("/oidc/publishers").then(
        (list) =>
          Array.isArray(list.publishers) && Array.isArray(list.providers)
            ? list
            : new ApiError(
                "Trusted publishers could not be loaded. Try again.",
              ),
        (failure: unknown) => failure as Error,
      );
    const load = async () => {
      const [security, trusted] = await Promise.all([
        props.platform.get<{
          factors: Factor[];
          emailLoginEnabled?: boolean;
          pendingRecoveries?: { id: string; mode: string }[];
          privilegedPolicy?: PrivilegedPolicy;
          privilegedReady?: boolean;
        }>("/account/security"),
        tenantScoped ? listPublishers() : null,
      ]);
      if (!Array.isArray(security.factors))
        throw new ApiError("Security settings could not be loaded. Try again.");
      if (alive) {
        factors.value = security.factors;
        pendingRecoveries.value = security.pendingRecoveries ?? [];
        emailLoginEnabled.value = security.emailLoginEnabled ?? true;
        policy.value = privilegedPolicyOf(security.privilegedPolicy);
        privilegedReady.value = security.privilegedReady !== false;
        loaded.value = true;
        if (trusted instanceof Error) {
          publishers.value = null;
          publisherError.value = errorMessage(trusted);
        } else if (trusted) {
          publishers.value = trusted;
          publisherError.value = "";
          if (!trusted.providers.some((p) => p.id === provider.value))
            provider.value = trusted.providers[0]?.id ?? "";
        }
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
    const button = (
      text: string,
      action: () => Promise<void>,
      className?: string,
      glyph?: string,
    ) =>
      h(
        "button",
        {
          type: "button",
          class: className,
          disabled: pending.value,
          onClick: () => void run(action),
        },
        glyph ? [icon(glyph), h("span", text)] : text,
      );
    const metadata = (value: string) =>
      h("code", { class: "metadata-chip" }, value);
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
          : parseClaims(customClaims.value),
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
          id: "security-passkeys",
          tabindex: -1,
          class: "feature-card publisher-security oidc-panel",
          "aria-busy": pending.value,
        },
        [
          h("h3", [icon(icons.shield), " Passkeys and sign-in"]),
          h("p", publisherPolicyCopy[policy.value]),
          loaded.value &&
            !privilegedReady.value &&
            h("p", { role: "status" }, privilegedSetupCopy[policy.value]),
          error.value && h("p", { role: "alert" }, error.value),
          notice.value && h("p", { role: "status" }, notice.value),
          !loaded.value
            ? button("Load publishing settings", load)
            : h("div", [
                h("h4", [icon(icons.key), " Passkeys and security keys"]),
                h(
                  "ul",
                  { class: "record-list" },
                  factors.value.map((f) =>
                    h("li", { key: f.id }, [
                      h("div", { class: "record-metadata" }, [
                        `${f.name} (${f.kind === "security_key" ? "security key" : "passkey"})`,
                        metadata(f.id),
                      ]),
                      button(
                        "Remove key",
                        async () => {
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
                        },
                        "button-danger",
                      ),
                    ]),
                  ),
                ),
                factors.value.length === 0
                  ? h("div", [
                      h(
                        "p",
                        "Verify your email to enroll your first security factor.",
                      ),
                      button(
                        "Send setup verification",
                        async () => {
                          await props.platform.post(
                            "/account/verification/request",
                            { purpose: "security_enroll" },
                          );
                          notice.value =
                            "Open the verification email in this browser.";
                        },
                        "button-secondary",
                        icons.mailCheck,
                      ),
                      field("Email verification token", emailToken, "password"),
                    ])
                  : null,
                field("Device name", label),
                h("div", { class: "feature-actions" }, [
                  button(
                    "Enroll passkey",
                    () => enroll("passkey"),
                    undefined,
                    icons.key,
                  ),
                  button(
                    "Enroll security key",
                    () => enroll("security_key"),
                    undefined,
                    icons.key,
                  ),
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
                h("h4", [icon(icons.mailCheck), " Email-link sign-in"]),
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
                factors.value.length > 0
                  ? button(
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
                      emailLoginEnabled.value
                        ? "button-danger"
                        : "button-secondary",
                    )
                  : null,
                tenantScoped && !publishers.value
                  ? h("div", [
                      h("h4", [icon(icons.code), " Trusted publishers"]),
                      h("p", { role: "alert" }, publisherError.value),
                      button("Retry loading publishers", load),
                    ])
                  : tenantScoped
                    ? h("div", [
                        h("h4", [icon(icons.code), " Trusted publishers"]),
                        h("p", { class: "record-metadata" }, [
                          "Audience: ",
                          metadata(publishers.value!.audience),
                        ]),
                        ...publishers.value!.publishers.map((p) =>
                          h("div", { class: "feature-session", key: p.id }, [
                            h("strong", p.name),
                            h("div", { class: "record-metadata" }, [
                              metadata(p.id),
                            ]),
                            h("p", { class: "record-metadata" }, [
                              `${p.provider}: `,
                              metadata(p.subject),
                              p.issuer ? metadata(p.issuer) : null,
                            ]),
                            p.claims && Object.keys(p.claims).length > 0
                              ? h(
                                  "div",
                                  { class: "record-metadata" },
                                  Object.entries(p.claims).map(
                                    ([claim, value]) =>
                                      metadata(`${claim}: ${value}`),
                                  ),
                                )
                              : null,
                            p.revoked_at !== null
                              ? h(
                                  "span",
                                  {
                                    class:
                                      "license-access-badge license-access-revoked",
                                  },
                                  "Revoked",
                                )
                              : button(
                                  "Revoke publisher",
                                  async () => {
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
                                  },
                                  "button-danger",
                                ),
                          ]),
                        ),
                        h(
                          "details",
                          {
                            class: "seller-create",
                            open: !publishers.value!.publishers.some(
                              (p) => p.revoked_at === null,
                            ),
                          },
                          [
                            h(
                              "summary",
                              disclosureLabel(
                                "Add a trusted publisher",
                                icons.plus,
                              ),
                            ),
                            h(
                              "form",
                              {
                                class: "seller-form",
                                onSubmit: (event: Event) => {
                                  event.preventDefault();
                                  void run(create);
                                },
                              },
                              [
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
                                      h(
                                        "option",
                                        { value: "" },
                                        "Choose a product",
                                      ),
                                      ...props.products
                                        .filter((p) => p.slug)
                                        .map((p) =>
                                          h(
                                            "option",
                                            { value: p.slug },
                                            p.name,
                                          ),
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
                                      field(
                                        "Required claims (JSON)",
                                        customClaims,
                                      ),
                                    ]),
                                h(
                                  "button",
                                  {
                                    type: "submit",
                                    disabled:
                                      pending.value || !factors.value.length,
                                  },
                                  "Verify and trust publisher",
                                ),
                              ],
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
