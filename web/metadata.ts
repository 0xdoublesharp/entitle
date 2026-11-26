import { site } from "../packages/shared/site.ts";
import { normalizeAppBasePath } from "../packages/shared/app-path.ts";

export const pageMetadata = {
  home: {
    title: `${site.name} · ${site.tagline}`,
    description:
      "License WordPress plugins, desktop apps, and other software. Start with complimentary licenses or sell subscriptions through your own Stripe account.",
    path: "/",
    imageAlt:
      "Doublesharp Entitle. License your software and ship private updates.",
  },
  docs: {
    title: `Documentation · ${site.name}`,
    description:
      "Set up licensing and private updates. Find guides for client adapters, release publishing, automation, and self-hosting.",
    path: "/docs",
    imageAlt:
      "Doublesharp Entitle documentation. Set up licensing and private updates.",
  },
  seller: {
    title: `Seller dashboard · ${site.name}`,
    description:
      "Sign in to manage products, issue licenses, and publish private releases from your Entitle workspace.",
    path: "/seller",
    imageAlt:
      "Doublesharp Entitle seller dashboard. Manage licenses and private releases.",
  },
  customer: {
    title: `Customer account · ${site.name}`,
    description:
      "Sign in to download releases, replace a license key, or manage your installations and subscriptions.",
    path: null,
    imageAlt:
      "Doublesharp Entitle customer account. Your software licenses and downloads.",
  },
} as const;

export type SitePage = keyof typeof pageMetadata;

export function renderPageMetadata(
  page: SitePage,
  origin: string = site.hostedOrigin,
  appBasePath = "",
) {
  const url = new URL(origin);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "WEB_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials, path, query or fragment.",
    );
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll('"', "&quot;");
  const metadata = pageMetadata[page];
  const basePath = normalizeAppBasePath(appBasePath);
  // Increment the revision when replacing the preview artwork.
  const image = `${url.origin}${basePath}/social/${page}.png?v=2`;
  const meta = (name: string, value: string, attribute = "property") =>
    `<meta ${attribute}="${name}" content="${escape(value)}" />`;
  return [
    `<title>${escape(metadata.title)}</title>`,
    meta("description", metadata.description, "name"),
    meta("og:type", "website"),
    meta("og:site_name", site.name),
    meta("og:locale", "en_US"),
    meta("og:title", metadata.title),
    meta("og:description", metadata.description),
    ...(metadata.path === null
      ? [meta("robots", "noindex, nofollow", "name")]
      : [
          `<link rel="canonical" href="${escape(url.origin + basePath + metadata.path)}" />`,
          meta("og:url", url.origin + basePath + metadata.path),
        ]),
    meta("og:image", image),
    meta("og:image:type", "image/png"),
    meta("og:image:width", "1200"),
    meta("og:image:height", "630"),
    meta("og:image:alt", metadata.imageAlt),
    meta("twitter:card", "summary_large_image", "name"),
    meta("twitter:title", metadata.title, "name"),
    meta("twitter:description", metadata.description, "name"),
    meta("twitter:image", image, "name"),
    meta("twitter:image:alt", metadata.imageAlt, "name"),
  ].join("\n    ");
}
