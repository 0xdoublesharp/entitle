/** Feed rendering only. The caller selects authorized releases and constructs asset URLs. */
export interface UpdateAsset {
  id: string;
  target: string;
  filename: string;
  size: number;
  checksum: string;
  sha512: string;
  signature: string | null;
  min_system_version: string | null;
  url: string;
}

export interface UpdateInput {
  framework:
    | "wordpress"
    | "joomla"
    | "electron"
    | "tauri"
    | "sparkle"
    | "jetbrains"
    | "generic";
  product: {
    slug: string;
    name: string;
    frameworkConfig: Record<string, unknown>;
  };
  release: { version: string; changelog: string; published_at: number };
  assets: readonly UpdateAsset[];
  /** Credential-free immutable Joomla metadata reload URL. */
  detailsUrl?: string;
}

export interface RenderedUpdate {
  contentType: string;
  body: string | Record<string, unknown>;
}

function xml(value: unknown): string {
  // XML 1.0 forbids these code points even when entity-escaped.
  return (
    String(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu, "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;")
  );
}

function xmlFeed(body: string): RenderedUpdate {
  return {
    contentType: "application/xml; charset=utf-8",
    body: '<?xml version="1.0" encoding="UTF-8"?>\n' + body,
  };
}

function joomla(input: UpdateInput, asset: UpdateAsset): RenderedUpdate {
  const c = input.product.frameworkConfig;
  const client =
    c.client ?? (c.extensionType === "plugin" ? "site" : undefined);
  if (input.detailsUrl)
    return xmlFeed(
      `<extensionset><extension name="${xml(input.product.name)}" element="${xml(c.element)}" type="${xml(c.extensionType)}" client="${xml(client ?? "administrator")}"` +
        (c.folder ? ` folder="${xml(c.folder)}"` : "") +
        ` version="${xml(input.release.version)}" detailsurl="${xml(input.detailsUrl)}" targetplatform="joomla" targetplatformversion="${xml(c.joomlaMajor)}\\..*"/></extensionset>`,
    );
  return xmlFeed(
    `<updates><update><name>${xml(input.product.name)}</name><description>${xml(input.release.changelog)}</description>` +
      `<element>${xml(c.element)}</element><type>${xml(c.extensionType)}</type>` +
      (c.folder ? `<folder>${xml(c.folder)}</folder>` : "") +
      (client ? `<client>${xml(client)}</client>` : "") +
      `<version>${xml(input.release.version)}</version><downloads><downloadurl type="full" format="zip">${xml(asset.url)}</downloadurl></downloads>` +
      `<sha256>${xml(asset.checksum)}</sha256><targetplatform name="joomla" version="${xml(c.joomlaMajor)}\\..*"/></update></updates>`,
  );
}

function electron(input: UpdateInput, first: UpdateAsset): RenderedUpdate {
  const quote = (value: string) =>
    JSON.stringify(value).replace(
      /[\u007f-\u009f\ufffe\uffff]/g,
      (character) =>
        "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"),
    );
  const files = input.assets
    .map(
      (a) =>
        `  - url: ${quote(a.url)}\n    sha512: ${quote(a.sha512)}\n    size: ${a.size}`,
    )
    .join("\n");
  return {
    contentType: "application/yaml; charset=utf-8",
    body:
      `version: ${quote(input.release.version)}\nfiles:\n${files}\npath: ${quote(first.url)}\nsha512: ${quote(first.sha512)}\n` +
      `releaseDate: ${quote(new Date(input.release.published_at).toISOString())}\nreleaseNotes: ${quote(input.release.changelog)}\n`,
  };
}

function signature(asset: UpdateAsset): string {
  if (!asset.signature) throw new Error("Native update signature is required");
  return asset.signature;
}

function sparkle(input: UpdateInput, asset: UpdateAsset): RenderedUpdate {
  return xmlFeed(
    '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel>' +
      `<title>${xml(input.product.name)}</title><item><title>${xml(input.release.version)}</title>` +
      `<sparkle:version>${xml(input.release.version)}</sparkle:version><description>${xml(input.release.changelog)}</description>` +
      `<pubDate>${new Date(input.release.published_at).toUTCString()}</pubDate>` +
      (asset.min_system_version
        ? `<sparkle:minimumSystemVersion>${xml(asset.min_system_version)}</sparkle:minimumSystemVersion>`
        : "") +
      `<enclosure url="${xml(asset.url)}" sparkle:edSignature="${xml(signature(asset))}" length="${asset.size}" type="application/octet-stream"/>` +
      "</item></channel></rss>",
  );
}

function jetbrains(input: UpdateInput, asset: UpdateAsset): RenderedUpdate {
  const c = input.product.frameworkConfig;
  return xmlFeed(
    `<plugins><plugin id="${xml(c.pluginId)}" version="${xml(input.release.version)}" url="${xml(asset.url)}">` +
      `<idea-version since-build="${xml(c.sinceBuild)}"` +
      (c.untilBuild ? ` until-build="${xml(c.untilBuild)}"` : "") +
      `/><name>${xml(input.product.name)}</name></plugin></plugins>`,
  );
}

export function renderUpdate(input: UpdateInput): RenderedUpdate {
  const asset = input.assets[0];
  if (!asset) throw new Error("At least one update asset is required");
  switch (input.framework) {
    case "joomla":
      return joomla(input, asset);
    case "electron":
      return electron(input, asset);
    case "sparkle":
      return sparkle(input, asset);
    case "jetbrains":
      return jetbrains(input, asset);
    case "tauri":
      return {
        contentType: "application/json; charset=utf-8",
        body: {
          version: input.release.version,
          notes: input.release.changelog,
          pub_date: new Date(input.release.published_at).toISOString(),
          url: asset.url,
          signature: signature(asset),
        },
      };
    case "generic":
      return {
        contentType: "application/json; charset=utf-8",
        body: {
          version: input.release.version,
          notes: input.release.changelog,
          publishedAt: new Date(input.release.published_at).toISOString(),
          assets: input.assets.map((a) => ({
            target: a.target,
            filename: a.filename,
            size: a.size,
            sha256: a.checksum,
            sha512: a.sha512,
            signature: a.signature,
            minSystemVersion: a.min_system_version,
            url: a.url,
          })),
        },
      };
    default:
      throw new Error("Unsupported update framework");
  }
}
