import { site } from "../packages/shared/site.ts";
import { normalizeAppBasePath } from "../packages/shared/app-path.ts";

export const pageMetadata = {
  home: {
    title: `${site.name} · ${site.tagline}`,
    description: site.description,
    path: "/",
    imageAlt:
      "Doublesharp Entitle. Software licensing and private updates for independent developers.",
  },
  docs: {
    title: `Documentation · ${site.name}`,
    description:
      "Set up complimentary licenses, paid plans and private updates with Entitle. Start an invited pilot before Stripe; integrate WordPress, desktop apps and custom clients.",
    path: "/docs",
    imageAlt:
      "Doublesharp Entitle documentation. From your first license to your next release.",
  },
  seller: {
    title: `Seller dashboard · ${site.name}`,
    description:
      "Sign in to manage your software products, licenses, subscriptions and private releases with Doublesharp Entitle.",
    path: "/seller",
    imageAlt:
      "Doublesharp Entitle seller dashboard. Your software business, in one place.",
  },
  customer: {
    title: `Customer account · ${site.name}`,
    description:
      "Sign in to manage your software licenses, installations, subscriptions and downloads securely with Doublesharp Entitle.",
    path: null,
    imageAlt:
      "Doublesharp Entitle customer account. Your licenses and downloads, together.",
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
  const image = `${url.origin}${basePath}/social/${page}.png`;
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
