import { defineComponent, h, ref, type PropType } from "vue";
import { type Tenant, workspaceArchived } from "../packages/shared/tenant.ts";
import type { ApiClient } from "./api.ts";
import { verifiedRequest } from "./features.ts";

export const WorkspaceManager = defineComponent({
  props: {
    tenants: { type: Array as PropType<Tenant[]>, required: true },
    platform: { type: Object as PropType<ApiClient>, required: true },
    busy: Boolean,
    execute: {
      type: Function as PropType<(action: () => Promise<void>) => void>,
      required: true,
    },
    confirm: {
      type: Function as PropType<
        (title: string, label: string, action: () => Promise<void>) => void
      >,
      required: true,
    },
    refresh: {
      type: Function as PropType<(message: string) => Promise<void>>,
      required: true,
    },
  },
  emits: ["opened"],
  setup(props, { emit }) {
    const view = ref("active");
    const removal = ref<{
      tenant: Tenant;
      removable: boolean;
      blockers: string[];
    } | null>(null);
    const slug = ref("");
    const button = (label: string, action: () => void) =>
      h(
        "button",
        { type: "button", disabled: props.busy, onClick: action },
        label,
      );
    const changed = async (message: string) => {
      removal.value = null;
      await props.refresh(message);
    };
    const lifecycle = (tenant: Tenant, archive: boolean) => {
      const action = async () => {
        await props.platform.post(
          `/tenants/${encodeURIComponent(tenant.id)}/${archive ? "archive" : "restore"}`,
          {},
        );
        await changed(archive ? "Workspace archived." : "Workspace restored.");
      };
      if (archive)
        props.confirm(
          `Archive ${tenant.name}? Existing access and billing will continue.`,
          "Confirm archive",
          action,
        );
      else props.execute(action);
    };
    const checkRemoval = (tenant: Tenant) =>
      props.execute(async () => {
        removal.value = null;
        slug.value = "";
        const result = await props.platform.get<{
          removable: boolean;
          blockers: string[];
        }>(`/tenants/${encodeURIComponent(tenant.id)}/removal`);
        removal.value = { tenant, ...result };
      });
    return () => {
      const visible = props.tenants
        .filter(
          (tenant) => workspaceArchived(tenant) === (view.value === "archived"),
        )
        .toSorted((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        );
      const target = removal.value;
      return h(
        "section",
        {
          class: "panel seller-panel workspace-manager",
          "aria-busy": props.busy,
        },
        [
          h("div", { class: "feature-section-heading" }, [
            h("div", [
              h("h2", "Publisher workspaces"),
              h(
                "p",
                "Archiving keeps licenses, updates and billing running. Archived workspaces still count toward your account limit. Restore them here anytime.",
              ),
            ]),
            h("label", { class: "workspace-view-label" }, [
              "Show",
              h(
                "select",
                {
                  id: "workspace-view",
                  value: view.value,
                  disabled: props.busy,
                  onChange: (event: Event) => {
                    view.value = (event.target as HTMLSelectElement).value;
                    removal.value = null;
                  },
                },
                [
                  h("option", { value: "active" }, "Active workspaces"),
                  h("option", { value: "archived" }, "Archived workspaces"),
                ],
              ),
            ]),
          ]),
          h(
            "div",
            { class: "workspace-records" },
            visible.length
              ? visible.map((tenant) =>
                  h("article", { class: "workspace-record", key: tenant.id }, [
                    h("div", [
                      h("h3", tenant.name),
                      h("code", tenant.slug),
                      tenant.sandbox_parent_slug &&
                        h(
                          "p",
                          `Test workspace for ${tenant.sandbox_parent_slug}`,
                        ),
                      tenant.parent_archived_at &&
                        h(
                          "p",
                          { class: "muted" },
                          "Its publisher workspace is archived. Restore the publisher to return this sandbox to the active list.",
                        ),
                    ]),
                    h("div", { class: "button-row" }, [
                      button("Open workspace", () =>
                        emit("opened", tenant.slug),
                      ),
                      tenant.id !== "primary" && [
                        tenant.archived_at
                          ? button("Restore workspace", () =>
                              lifecycle(tenant, false),
                            )
                          : !tenant.parent_archived_at &&
                            button("Archive workspace", () =>
                              lifecycle(tenant, true),
                            ),
                        button("Check removal", () => checkRemoval(tenant)),
                      ],
                    ]),
                  ]),
                )
              : [
                  h(
                    "p",
                    { class: "feature-empty" },
                    view.value === "archived"
                      ? "No archived workspaces."
                      : "No active workspaces. Restore an archived workspace or create a new one.",
                  ),
                ],
          ),
          target &&
            h(
              "section",
              { class: "workspace-removal", "aria-label": "Workspace removal" },
              [
                h("h3", `Remove ${target.tenant.name}`),
                target.removable
                  ? [
                      h(
                        "p",
                        "This workspace is empty. Permanent removal deletes its settings and unused API keys, releases its address and frees an account slot. Security audit records are retained. This cannot be undone.",
                      ),
                      h(
                        "p",
                        "Confirm removal with an independently provisioned hardware key.",
                      ),
                      h(
                        "form",
                        {
                          id: "workspace-remove-form",
                          class: "seller-form",
                          onSubmit: (event: Event) => {
                            event.preventDefault();
                            const proof = "";
                            const address = slug.value;
                            const tenant = target.tenant;
                            props.confirm(
                              `Permanently remove ${tenant.name}? This cannot be undone.`,
                              "Permanently remove workspace",
                              async () => {
                                await verifiedRequest(
                                  props.platform,
                                  props.platform,
                                  "workspace_remove",
                                  proof,
                                  `/tenants/${encodeURIComponent(tenant.id)}/remove`,
                                  { slug: address },
                                );
                                await changed("Workspace removed.");
                              },
                            );
                          },
                        },
                        [
                          h("label", { for: "workspace-remove-slug" }, [
                            `Type ${target.tenant.slug} to confirm`,
                            h("input", {
                              id: "workspace-remove-slug",
                              required: true,
                              value: slug.value,
                              autocomplete: "off",
                              disabled: props.busy,
                              onInput: (event: Event) => {
                                slug.value = (
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
                                props.busy || slug.value !== target.tenant.slug,
                            },
                            "Review permanent removal",
                          ),
                        ],
                      ),
                    ]
                  : [
                      h(
                        "p",
                        "This workspace has history or linked services and cannot be removed. Archive it to keep that history.",
                      ),
                      h(
                        "ul",
                        target.blockers.map((reason) => h("li", reason)),
                      ),
                    ],
              ],
            ),
          h(
            "p",
            { class: "muted" },
            "Workspace removal is separate from personal-data deletion. Customers can request account closure from their buyer account; retained records follow the privacy and retention process.",
          ),
        ],
      );
    };
  },
});
