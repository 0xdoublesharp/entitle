import { h } from "vue";
import { site } from "../packages/shared/site.ts";
import { icon, icons } from "./icons.ts";
import { applicationAsset, applicationHref } from "./navigation.ts";

export const sellerHelpLink = (placement: "header" | "mobile") =>
  h(
    "a",
    {
      class: placement === "header" ? "seller-header-help" : "seller-help-link",
      href: applicationHref(placement === "header" ? "/docs" : "/docs#concepts"),
      target: "_blank",
      rel: "noopener",
    },
    [icon(icons.book), "Help & guides", icon(icons.external)],
  );

export const appHeader = (docs = false, sellerMode?: "dashboard" | "sign-in") =>
  h(
    "header",
    {
      class: [
        "site-header",
        sellerMode === "sign-in" && "seller-signin-header",
      ],
    },
    [
      h("a", { class: "brand", href: applicationHref("/") }, [
        h("img", {
          class: "brand-mark",
          src: applicationAsset("/favicon.svg"),
          alt: "",
          width: 36,
          height: 36,
          "aria-hidden": "true",
        }),
        site.name,
      ]),
      sellerMode === "dashboard"
        ? sellerHelpLink("header")
        : h("nav", { "aria-label": "Main navigation" }, [
            sellerMode === "sign-in"
              ? h("a", { href: applicationHref("/") }, "Home")
              : h("a", { href: applicationHref("/seller") }, "Dashboard"),
            h(
              "a",
              {
                href: applicationHref("/docs"),
                "aria-current": docs ? "page" : undefined,
              },
              "Docs",
            ),
            h("a", { href: applicationHref("/docs#troubleshooting") }, "Help"),
          ]),
    ],
  );
