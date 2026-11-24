import { createApp, defineComponent, h, onMounted, ref } from "vue";
import { ApiClient, errorMessage } from "./api.ts";
import { site } from "../packages/shared/site.ts";
import { publicDocs } from "./docs.ts";
import { appHeader } from "./chrome.ts";
import { icon, icons } from "./icons.ts";
import { applicationHref } from "./navigation.ts";
interface Info {
  maxUploadBytes: number;
  maxNativeUploadBytes?: number;
  databaseEngines: string[];
}
export function mountDocumentation(
  target: string | Element = "#app",
  transport?: typeof fetch,
) {
  const api = new ApiClient(transport, "/api/v1/platform");
  const app = createApp(
    defineComponent({
      setup() {
        const info = ref<Info | null>(null),
          error = ref("");
        const load = async () => {
          error.value = "";
          try {
            info.value = await api.get<Info>("/info");
          } catch (failure) {
            error.value = errorMessage(failure);
          }
        };
        onMounted(() => {
          void load();
        });
        return () =>
          h("div", { class: "app docs-page" }, [
            h("a", { href: "#main", class: "skip-link" }, "Skip to content"),
            appHeader(true),
            h(
              "main",
              { id: "main", class: "page-main" },
              publicDocs(info.value, error.value, () => void load()),
            ),
            h("footer", { class: "site-footer" }, [
              h("span", site.name),
              h(
                "nav",
                {
                  class: "site-footer-links",
                  "aria-label": "Footer navigation",
                },
                [
                  h("a", { href: applicationHref("/docs") }, "Documentation"),
                  h(
                    "a",
                    { href: applicationHref("/docs#troubleshooting") },
                    "Support guide",
                  ),
                  h(
                    "a",
                    { href: applicationHref("/docs#licensing") },
                    "Source & licenses",
                  ),
                  h("a", { href: site.hostedOrigin }, [
                    new URL(site.hostedOrigin).host,
                    " ",
                    icon(icons.external),
                  ]),
                ],
              ),
            ]),
          ]);
      },
    }),
  );
  app.mount(target);
  return app;
}
