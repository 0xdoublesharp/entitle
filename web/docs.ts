import { h } from "vue";
import { applicationHref, applicationAsset } from "./navigation.ts";
import type { VNodeChild } from "vue";
import { site } from "../packages/shared/site.ts";

interface ServerInfo {
  maxUploadBytes: number;
  maxNativeUploadBytes?: number;
  databaseEngines: string[];
}

const groups = [
  {
    label: "Start here",
    links: [
      ["hosting-options", "Hosted or self-hosted"],
      ["getting-started", "Getting started"],
      ["concepts", "How it fits together"],
      ["products-and-plans", "Products and plans"],
    ],
  },
  {
    label: "Build and ship",
    links: [
      ["framework-support", "Framework adapters"],
      ["publishing", "Publishing releases"],
      ["client-integration", "Client integration"],
      ["cli", "CLI and CI publication"],
    ],
  },
  {
    label: "Sell and support",
    links: [
      ["complimentary-licenses", "Complimentary licenses"],
      ["checkout", "Checkout integration"],
      ["billing", "Billing and access"],
      ["customer-accounts", "Customer accounts"],
      ["hosted-tiers", "Hosted tiers"],
    ],
  },
  {
    label: "Protect and automate",
    links: [
      ["operating-your-business", "Security and operations"],
      ["sandbox", "Sandbox testing"],
      ["webhooks", "Signed webhooks"],
      ["portability", "Exports and transfers"],
    ],
  },
  {
    label: "Run the service",
    links: [
      ["self-hosting", "Deployment and configuration"],
      ["backup-and-recovery", "Backup and recovery"],
      ["server-limits", "Server limits"],
    ],
  },
  {
    label: "Reference and help",
    links: [
      ["api", "API and authentication"],
      ["troubleshooting", "Troubleshooting"],
      ["licensing", "Source and licenses"],
    ],
  },
];

const navigationGroups = () =>
  groups.map((group) =>
    h("div", { class: "docs-nav-group" }, [
      h("p", group.label),
      ...group.links.map(([id, label]) => h("a", { href: `#${id}` }, label)),
    ]),
  );

const paragraph = (text: string) => h("p", text);
const note = (title: string, text: string) =>
  h("aside", { class: "docs-note" }, [h("strong", title), paragraph(text)]);
const section = (
  id: string,
  label: string,
  title: string,
  children: VNodeChild[],
) =>
  h(
    "section",
    { id, class: "docs-section", "aria-labelledby": `${id}-title` },
    [
      h("p", { class: "eyebrow" }, label),
      h("h2", { id: `${id}-title` }, h("a", { href: `#${id}` }, title)),
      ...children,
    ],
  );
const table = (caption: string, headings: string[], rows: VNodeChild[][]) =>
  h(
    "div",
    {
      class: "docs-table-wrap",
      tabindex: 0,
      role: "region",
      "aria-label": caption,
    },
    [
      h("table", { class: "docs-table" }, [
        h("caption", { class: "sr-only" }, caption),
        h(
          "thead",
          h(
            "tr",
            headings.map((title) => h("th", { scope: "col" }, title)),
          ),
        ),
        h(
          "tbody",
          rows.map((row) =>
            h(
              "tr",
              row.map((cell, index) =>
                h(
                  index === 0 ? "th" : "td",
                  index === 0 ? { scope: "row" } : {},
                  [cell],
                ),
              ),
            ),
          ),
        ),
      ]),
    ],
  );
const code = (label: string, source: string) =>
  h("figure", { class: "docs-code" }, [
    h("figcaption", label),
    h("pre", { tabindex: 0, "aria-label": label }, h("code", source)),
  ]);

export function publicDocs(
  info: ServerInfo | null,
  error: string,
  reload: (() => void) | undefined,
  staticSite = false,
) {
  const origin = new URL(applicationHref("/"), window.location.origin).origin;
  const base = `${origin}/api/v1/tenants/your-workspace`;
  return h("div", { class: "docs-layout" }, [
    h("nav", { class: "docs-nav", "aria-label": "Documentation sections" }, [
      h("p", { class: "docs-nav-title" }, "On this page"),
      ...navigationGroups(),
      h(
        "a",
        { href: applicationHref("/seller"), class: "docs-dashboard-link" },
        "Open seller dashboard ↗",
      ),
    ]),
    h("div", { class: "docs-content" }, [
      h("div", { class: "docs-heading" }, [
        h("p", { class: "eyebrow" }, "The developer guide"),
        h("h1", "Documentation"),
        h(
          "p",
          "Set up your first product, integrate its updater, automate releases and support your buyers. These guides cover hosted publishing and operating your own standalone installation.",
        ),
      ]),
      h("details", { class: "docs-mobile-nav" }, [
        h("summary", "Browse documentation"),
        h(
          "nav",
          {
            class: "docs-mobile-links",
            "aria-label": "Mobile documentation sections",
          },
          navigationGroups(),
        ),
      ]),
      h("aside", { class: "docs-start" }, [
        h("span", { class: "docs-start-icon", "aria-hidden": "true" }, "↗"),
        h("div", [
          h("h2", `New to ${site.name}?`),
          paragraph(
            "Choose who runs the service, bring a product build and start with a complimentary pilot or a paid plan. Stripe is needed only for paid billing.",
          ),
          h(
            "a",
            { href: "#hosting-options", class: "button" },
            "Compare hosting options →",
          ),
        ]),
      ]),
      h(
        "nav",
        { class: "docs-paths", "aria-label": "Choose your documentation path" },
        [
          ...[
            [
              "#getting-started",
              "Publish and sell",
              "Create a product, issue a pilot license or connect payments, and deliver an update.",
            ],
            [
              "#client-integration",
              "Integrate your software",
              "Choose an adapter, activate an installation and verify a package.",
            ],
            [
              "#customer-accounts",
              "Support a customer",
              "Recover access, move an installation and explain billing or renewals.",
            ],
            [
              "#self-hosting",
              "Operate Entitle",
              "Configure your server, protect data and plan backup and recovery.",
            ],
          ].map(([href, title, copy]) =>
            h("a", { href }, [h("strong", title), h("span", copy)]),
          ),
        ],
      ),
      section("hosting-options", "Before you start", "Hosted or self-hosted", [
        paragraph(
          `Both versions use the same ${site.name} application, licensing engine and framework adapters. Choose the hosted service to have the platform operated for you, or self-host standalone for your own software business.`,
        ),
        table(
          "Hosted and self-hosted comparison",
          ["What you manage", "Hosted service", "Self-hosted standalone"],
          [
            [
              "Infrastructure",
              "The service operator runs the app, database, private storage, email, backups and application upgrades.",
              "You run one app behind HTTPS, a persistent database, private S3-compatible storage, SMTP, backups and application upgrades. Redis is optional.",
            ],
            [
              "Publisher workspace",
              "Create your workspace for complimentary licensing; connect your own Stripe account for paid sales. Each publisher's customers and releases are isolated.",
              "One publisher, multiple products and the existing primary workspace. Only the configured owner email can sign in as seller.",
            ],
            [
              "Payments",
              "Stripe Connect routes buyer payments to your connected account.",
              "Your Stripe account is configured on your server. Connect onboarding is unnecessary.",
            ],
            [
              "Service costs",
              "A platform subscription plus the configured application fee, default 1% on new subscriptions and their renewals. Stripe fees are separate.",
              "No platform subscription or application fee. You pay your infrastructure, storage, email and Stripe providers.",
            ],
            [
              "Tools and limits",
              "Seller and customer dashboards, scoped APIs, licensing and framework adapters. Product and storage allowances follow your platform plan.",
              "The same core dashboards, scoped APIs, licensing and adapters. Configured product, storage, upload and transfer limits still apply.",
            ],
          ],
        ),
        h("p", [
          "Planned hosted address: ",
          h("a", { href: site.hostedOrigin }, new URL(site.hostedOrigin).host),
          ". This documentation does not confirm a public launch or production availability.",
        ]),
        h("div", { class: "button-row" }, [
          h("a", { href: "#hosted-setup" }, "Hosted setup →"),
          h("a", { href: "#self-hosted-setup" }, "Self-hosted setup →"),
        ]),
        note(
          "Using your own Stripe account",
          "When offering paid plans, you sell through your own Stripe account. The platform is not a merchant of record. Product prices are separate from hosted platform charges; complimentary issuance needs no payment provider.",
        ),
      ]),
      section(
        "getting-started",
        "Setup walkthrough",
        "Your first product, step by step",
        [
          h("h3", { id: "hosted-setup" }, "Hosted setup"),
          paragraph(
            "Create your seller workspace. Sign in through the seller dashboard and open the email link in the same browser that requested it. Choose your workspace's permanent slug. You can issue complimentary licenses without connecting Stripe; product and storage allowances still apply. Review platform charges and limits before subscribing to a hosted plan.",
          ),
          paragraph(
            "For paid sales, connect Stripe from Billing, create annual recurring prices and configure the Customer Portal. On the hosted service, buyers use /app/t/YOUR_WORKSPACE_SLUG and the seller dashboard is /app/seller. Your API base is /api/v1/tenants/YOUR_WORKSPACE_SLUG. Custom app mounts may use a different page prefix.",
          ),
          h("h3", { id: "self-hosted-setup" }, "Self-hosted standalone setup"),
          paragraph(
            "Run one application behind HTTPS with a persistent database, a private S3-compatible bucket and SMTP. SQLite is the default; PostgreSQL and MySQL are supported. You operate backups, monitoring and server upgrades. Redis is optional.",
          ),
          code(
            "Server configuration / mode selection, not a complete production environment",
            "DEPLOYMENT_MODE=standalone\nSTANDALONE_OWNER_EMAIL=owner@example.com\nPUBLIC_ORIGIN=https://licenses.example.com",
          ),
          paragraph(
            "Supply independent application secrets, private storage, email and the remaining production settings from .env.example and docs/deployment.md. For a complimentary pilot, use LOCAL_BILLING=false and omit all primary Stripe, Connect and platform price settings. When enabling paid sales, supply the complete mode-specific Stripe configuration, register /api/v1/stripe/merchant-webhook, create annual recurring prices and configure your Stripe Customer Portal.",
          ),
          paragraph(
            "Sign in at /seller with STANDALONE_OWNER_EMAIL. Email verification gives the owner access to the existing primary workspace. Buyers use /t/primary and client APIs use /api/v1/tenants/primary. No workspace creation, Connect onboarding, platform subscription or application fee is required. Product, storage and upload limits still apply.",
          ),
          note(
            "Keep deployment modes and databases separate",
            "Standalone accepts a primary-only database without connected-account or platform billing mappings. Keep an existing hosted database in DEPLOYMENT_MODE=hosted. Changing a flag does not migrate customer data, Stripe subscriptions, artifacts or client URLs. Back up the database, private objects and APP_SECRET together.",
          ),
          h("h3", "Continue with either version"),
          h(
            "ol",
            { class: "docs-steps" },
            [
              [
                "Add your product; a paid plan is optional.",
                "In Products, choose the framework that matches your software. Leave Include annual paid plan unchecked for complimentary licensing. To sell, select an annual recurring Stripe price and its installation allowance. WordPress needs the plugin's directory/main-file.php identity. Joomla and JetBrains need their extension or plugin identity too.",
              ],
              [
                "Publish your first release and configure the client.",
                "In Releases, choose your product, enter a version such as 1.0.0, add release notes and upload the package. Desktop apps need an asset for each supported target. In Client setup, select the product and copy its workspace-specific configuration into your client integration.",
              ],
              [
                "Issue a license, then test activation and an update.",
                "Issue a complimentary license from Licenses, or complete a paid checkout after configuring Stripe. The customer receives a normal license key by email. Activate a site or device, publish a newer version and check the native updater. Keep local purchase fixtures confined to disposable development or an isolated sandbox. Create scoped API keys for CI publication; keep them out of client software.",
              ],
            ].map(([title, description]) =>
              h("li", [h("h4", title), paragraph(description!)]),
            ),
          ),
          note(
            "Choose the framework before you publish",
            "A product's framework and configuration lock after its first license or release. Check its identity and activation type before you start distributing it.",
          ),
          h("h3", "Before inviting customers"),
          h("ul", { class: "docs-checklist" }, [
            h(
              "li",
              "Verify complimentary issuance or a paid purchase creates one license and delivers its key email. For disposable testing, use a sandbox.",
            ),
            h(
              "li",
              "Retry activation with the same installation ID and confirm it consumes no additional seat.",
            ),
            h(
              "li",
              "Publish a newer version and test the native download, checksum, installation and relaunch.",
            ),
            h(
              "li",
              "Test deactivation, key replacement and a licensing-server outage without losing installed functionality.",
            ),
          ]),
        ],
      ),
      section("concepts", "The basics", "How it fits together", [
        paragraph(
          "A workspace is called a tenant in the API. It keeps one seller’s products, customers and releases together.",
        ),
        h(
          "dl",
          { class: "docs-glossary" },
          [
            [
              "Product",
              "The plugin or app you sell. Its framework selects the package checks, updater feed and site or device activation.",
            ],
            [
              "Plan",
              "An annual Stripe price paired with an installation allowance. One product can have several plans, such as one site or five sites.",
            ],
            [
              "License",
              "A customer’s access to one product, with paid or complimentary entitlement and an installation allowance. Complimentary licenses use an explicit expiration date. Current entitlement permits new activations, downloads and updates.",
            ],
            [
              "Installation",
              "An activated site or device. Each installation has a stable ID and its own token for update checks and private package downloads.",
            ],
            [
              "Release",
              "A version of your product with immutable package bytes and release notes. Desktop releases can contain several target-specific assets.",
            ],
          ].map(([term, description]) =>
            h("div", [h("dt", term), h("dd", description)]),
          ),
        ),
        note(
          "Installed software keeps working",
          "Expiration, cancellation and licensing-server outages must not disable functionality your customer has already installed. Use license checks to control access to downloads and updates.",
        ),
      ]),
      section(
        "products-and-plans",
        "Catalog setup",
        "Products, optional paid plans and installations",
        [
          paragraph(
            "A product slug appears in activation requests and update feeds. Choose it alongside the framework identity before distributing your client. Products need no paid plan for complimentary licensing; leave Include annual paid plan unchecked, or use plans:[] in the API. A paid plan maps one annual recurring Stripe price to an installation allowance.",
          ),
          code(
            "JSON / Generic device product",
            JSON.stringify(
              {
                slug: "example-app",
                name: "Example application",
                framework: "generic",
                frameworkConfig: { activationKind: "device" },
                plans: [
                  {
                    name: "Personal annual",
                    siteAllowance: 1,
                    priceId: "price_REPLACE",
                  },
                ],
              },
              null,
              2,
            ),
          ),
          table(
            "Product configuration requirements",
            ["Framework", "Product identity"],
            [
              [
                "WordPress",
                "pluginBasename: exact directory/main-file.php. Framework configuration is empty.",
              ],
              [
                "Joomla",
                "extensionType, element and joomlaMajor. Plugins need folder; modules, templates, libraries and packages need client.",
              ],
              ["JetBrains", "pluginId and sinceBuild, optionally untilBuild."],
              [
                "Generic",
                "activationKind is device by default, or explicitly site.",
              ],
              [
                "Electron, Tauri, Sparkle",
                "Empty framework configuration. Targets and signatures belong to release assets.",
              ],
            ],
          ),
          paragraph(
            "Select prices from the merchant account and Stripe mode used by this workspace. Local fixture prices are labeled and cannot collect money. The API field siteAllowance counts sites or devices according to the product's activation kind.",
          ),
          note(
            "Change allowances with a new price",
            "Price-to-product and allowance mappings are retained for invoice reconciliation. Add a new Stripe price to change seats. A future paid period applies when it starts; overlapping paid grants preserve the larger allowance. An unpaid plan change adds no seats.",
          ),
          paragraph(
            "Use GET /catalog to find saved plan IDs for checkout. A plan ID is an Entitle identifier; it is distinct from the Stripe price ID and the product slug.",
          ),
        ],
      ),
      section(
        "framework-support",
        "Frameworks",
        "Choose your framework adapter",
        [
          paragraph(
            "Every adapter shares checkout, licenses and entitlement checks. Choose the updater format and activation type that fit your software.",
          ),
          table(
            "Framework adapters and setup requirements",
            ["Framework", "Seat", "Update format", "What to configure"],
            [
              [
                "WordPress",
                "Site",
                "Plugin ZIP + update metadata",
                "Exact plugin basename and compatibility versions.",
              ],
              [
                "Joomla",
                "Site",
                "Extension ZIP + XML",
                "Extension type, element, Joomla major version and installer plugin.",
              ],
              [
                "Electron",
                "Device",
                "Generic provider YAML",
                "Target-specific packages and authenticated updater requests.",
              ],
              [
                "Tauri",
                "Device",
                "Signed updater JSON",
                "Target, detached signature and the public key embedded in your app.",
              ],
              [
                "Sparkle",
                "Device",
                "Signed appcast XML",
                "macOS target, EdDSA signature and the public key embedded in your app.",
              ],
              [
                "JetBrains",
                "Device",
                "Custom repository XML",
                "Plugin ID, IDE build bounds and repository authentication.",
              ],
              [
                "Generic",
                "Device or site",
                "JSON + SHA-256 metadata",
                "A target name and your own HTTP update client. Devices are the default.",
              ],
            ],
          ),
          h("h3", "Using WordPress?"),
          paragraph(
            "The client integrates with the normal plugin update screen. Your free plugin can keep using WordPress.org. Load the updater before feature compatibility checks so customers can still receive an update that fixes a compatibility problem.",
          ),
          h("h3", "Using a desktop updater?"),
          paragraph(
            "Keep the installation ID across app updates. Send its activation token only to the configured tenant’s feed and package URLs. Tauri and Sparkle require signatures generated by your build system. Keep private signing keys there, and ship only public verification keys in your app.",
          ),
          table(
            "Native target names",
            ["Framework", "Exact targets"],
            [
              ["Joomla and JetBrains", "any"],
              [
                "Electron",
                "windows-x64, windows-arm64, darwin-x64, darwin-arm64, linux-x64, linux-arm64",
              ],
              [
                "Tauri",
                "windows-x86_64, windows-aarch64, windows-i686, darwin-x86_64, darwin-aarch64, linux-x86_64, linux-aarch64, linux-i686, linux-armv7",
              ],
              ["Sparkle", "darwin-x64, darwin-arm64, darwin-universal"],
              [
                "Generic",
                "Your own safe target name, up to 100 letters, digits, underscores or hyphens; start with a letter or digit.",
              ],
            ],
          ),
          paragraph(
            "Target spellings are framework-specific. Electron's darwin-arm64 and Tauri's darwin-aarch64 are different API values. Publish each target your clients request; a release for one architecture does not satisfy another.",
          ),
          paragraph(
            "The downloadable source includes examples/wordpress, examples/joomla, examples/electron, examples/tauri, examples/sparkle, examples/jetbrains and examples/generic. Each has its own integration instructions and qualification limits.",
          ),
          note(
            "Test your actual runtime",
            "Implemented feeds and client examples do not establish native runtime qualification. Test installation, operating-system signing, updater behavior and relaunch on every supported target. Code-signing services, delta updates and blockmap generation are not included.",
          ),
        ],
      ),
      section("publishing", "Releases", "Publish and verify a release", [
        paragraph(
          "Use Releases in the dashboard or a scoped automation key from your build pipeline. Package validation and private-storage verification finish before a release is offered to customers.",
        ),
        h("ol", { class: "docs-checklist" }, [
          h("li", [
            h("strong", "Prepare the package. "),
            "Use a strict semantic version such as 1.2.0. For WordPress, the plugin header version and basename must match the release. For native apps, select the exact framework target and include required signatures.",
          ]),
          h("li", [
            h("strong", "Upload and publish. "),
            "Add release notes and the package in Releases. Additional targets can join the same version if their release notes match. Existing assets cannot be replaced.",
          ]),
          h("li", [
            h("strong", "Verify the customer update. "),
            "Activate a licensed installation and check its feed. A client requesting an unpublished target receives no update. Verify the package checksum and any signatures required by the updater.",
          ]),
        ]),
        note(
          "Need to pull a release?",
          "Withdraw it in Releases. Withdrawal stops new offers and downloads for every target in that version. It preserves the private files, which still count toward storage. Publish a new version to deliver corrected bytes.",
        ),
        table(
          "Publication metadata",
          ["Package", "Fields"],
          [
            [
              "WordPress ZIP",
              "changelog, minWp, minPhp, minFree and tested. The main plugin header and basename must match the version and product.",
            ],
            [
              "Native asset",
              "target, filename and changelog; signature for Tauri/Sparkle, optional minSystemVersion where applicable.",
            ],
          ],
        ),
        paragraph(
          "Native assets use raw application/octet-stream bytes with Content-Length and base64url JSON in X-Release-Metadata. WordPress uses application/zip. The metadata header is limited to 12,288 bytes. The CLI performs the encoding for you.",
        ),
        paragraph(
          "A failed or disconnected upload may need investigation before retry. Read the release inventory to determine whether it committed. Never overwrite immutable objects or change the version just to hide an uncertain result.",
        ),
      ]),
      section(
        "client-integration",
        "Installed clients",
        "Keep activation stable across updates",
        [
          paragraph(
            "An installation is one site or device. Generate a random installation ID once and retain it across application updates. Device products omit siteUrl; site products send the full site URL. Store the returned activation token in protected client storage.",
          ),
          h("ol", { class: "docs-checklist" }, [
            h(
              "li",
              "Activate with the customer's key, product slug and stable installation ID. A retry returns the same token while that installation remains active.",
            ),
            h(
              "li",
              "Read status or the framework feed with Authorization: Bearer ACTIVATION_TOKEN. Never distribute seller keys with your client.",
            ),
            h(
              "li",
              "Validate the offered package URL against the configured origin and exact tenant package path, then download with the installation token. Reject redirects.",
            ),
            h(
              "li",
              "Verify checksum and required signatures before passing the package to the native updater. Keep installed features usable if the server is unavailable.",
            ),
          ]),
          table(
            "Client lifecycle routes",
            ["Request", "Behavior"],
            [
              [
                "POST /activate",
                "Customer key and stable installation ID; site products require siteUrl.",
              ],
              [
                "GET /activation",
                "Activation bearer; paidThrough, allowance, entitled and billingStatus.",
              ],
              [
                "POST /deactivate",
                "Activation bearer and {}; frees the seat and invalidates the token.",
              ],
              [
                "Buyer key replacement",
                "Creates a new license key and invalidates all existing installation tokens.",
              ],
            ],
          ),
          paragraph(
            "Site normalization lowercases the host, removes scheme/default ports and query/fragment, and trims trailing path slashes. Paths and nondefault ports remain distinct. Deactivate before moving an existing installation to a different normalized site. Site URLs are metadata and are never fetched.",
          ),
          note(
            "A cached offer still needs current access",
            "Every package request checks token, product, current paid or complimentary entitlement and withdrawal. Native ranges verify the complete object on a cold cache, then serve the requested bytes. Preserve the installed version and credentials during network errors; retry with bounded backoff.",
          ),
        ],
      ),
      section("cli", "Build pipelines", "Publish from your CLI or CI", [
        paragraph(
          "Run pnpm cli from the source checkout. Supply PUBLIC_ORIGIN, TENANT_SLUG and TENANT_API_KEY privately through the environment or CI secret store. Remote publisher commands do not need application, Stripe, storage or SMTP secrets.",
        ),
        code(
          "Shell / WordPress publication",
          "export PUBLIC_ORIGIN=" +
            origin +
            "\nexport TENANT_SLUG=your-workspace\n# The secret store supplies TENANT_API_KEY.\npnpm cli product examples/product.json\npnpm cli publish validated-field-pro 1.0.0 /private/build/pro.zip examples/release.json",
        ),
        code(
          "Shell / native publication",
          "pnpm cli product examples/generic/product.json\npnpm cli publish-asset example-app 1.0.0 /private/build/app.bin examples/generic/release.json",
        ),
        paragraph(
          "Replace the example Stripe price IDs before product creation. publish-asset streams a regular file with a declared length. WordPress publish uses its separate ZIP endpoint and cap. A duplicate target/version is a conflict, so inspect the existing release after an ambiguous upload.",
        ),
        table(
          "Publisher CLI commands",
          ["Command", "Required scope"],
          [
            ["product [FILE]", "catalog:write"],
            ["publish / publish-asset / withdraw RELEASE_ID", "releases:write"],
            ["licenses / jobs", "read"],
            ["revoke LICENSE_ID / restore LICENSE_ID", "licenses:write"],
            ["reconcile [SUBSCRIPTION_ID] / work", "billing:reconcile"],
          ],
        ),
        paragraph(
          "reconcile reads canonical billing state and does not create a charge. work runs one bounded batch; the normal server polls durable work every five seconds. Failed work can be retried through the authenticated job API after its cause is resolved. Commands return exit 0 on success and 1 on failure.",
        ),
        note(
          "Separate operator authority",
          "Platform commands use OPERATOR_TOKEN and internal tenant IDs. The offline maintenance CLI additionally requires stopped/drained services, a named operator and a quiescence attestation. Neither credential belongs in a publisher pipeline or distributed client.",
        ),
      ]),
      section(
        "complimentary-licenses",
        "Invited pilots",
        "Run a pilot without Stripe",
        [
          paragraph(
            "Complimentary licenses are real licenses with an expiration date and installation allowance. They need no Stripe account, price, checkout or payment. They use the same activation, seat enforcement, protected downloads and native updater APIs as paid licenses; existing WordPress clients need no changes.",
          ),
          h("ol", { class: "docs-steps" }, [
            h(
              "li",
              "Create a product in Products with Include annual paid plan unchecked, then publish its private release and configure the client.",
            ),
            h(
              "li",
              "Open Licenses → Issue complimentary license. Enter the customer email, product, installation allowance and future expiration date and time. An internal note is optional; it is private to the seller.",
            ),
            h(
              "li",
              "Review the confirmation and issue the license. Entitle creates or reuses the customer in this workspace and queues the normal license-key email. The date and time shown in the form use your browser’s local time zone.",
            ),
            h(
              "li",
              "Ask the invited customer to activate with the emailed key and verify their normal download and update flow. Seller revocation/restoration and customer key replacement remain available.",
            ),
          ]),
          note(
            "No automatic billing",
            "Complimentary licenses create no invoice, subscription or revenue. Pilot customers are never automatically charged or enrolled, including after Stripe is configured. A later paid purchase uses normal checkout and creates separate paid entitlement. Hosted workspace capacity and service limits still apply.",
          ),
          paragraph(
            "Expiration stops new activations, downloads and updates; installed plugin features continue working. Restoration does not extend expiration. Key replacement invalidates the old key and activation tokens and queues a replacement email. The license is labelled Complimentary in seller and customer views.",
          ),
          code(
            "HTTP / seller issuance · requires licenses:write",
            `POST ${base}/seller/licenses/complimentary\nAuthorization: Bearer SELLER_API_KEY\nContent-Type: application/json\n\n{\n  "email": "pilot@example.com",\n  "productId": "PRODUCT_ID",\n  "siteAllowance": 2,\n  "expiresAt": 1893456000000,\n  "note": "Invited pilot",\n  "requestId": "bc2ac459-fd7b-4f49-a6f6-f52b57c35c0b",\n  "confirm": true\n}`,
          ),
          paragraph(
            "expiresAt is a future Unix millisecond timestamp, siteAllowance is 1–100000 and the optional note is at most 2000 characters. Browser issuance requires the owner’s session, Origin and CSRF token. The response is {id,customerId,emailQueued:true}; it never returns the raw key. Queuing is distinct from successful SMTP delivery.",
          ),
          paragraph(
            "Retry an uncertain submission with the same requestId and identical details. The committed result is reused without another license or email job. Different details with that UUID return 409 idempotency_conflict. Use a new UUID for a new intended license. SMTP delivery retains the existing at-least-once transport behavior.",
          ),
          paragraph(
            "Integrations should read entitled from the customer license. Complimentary records expose provenance=complimentary and expires_at; paid_through remains 0 and there is no plan or subscription. Activation/status paidThrough remains the access deadline for client compatibility. Honor billingAvailable before offering checkout or billing. Seller credentials and internal notes never belong in a customer-facing bundle.",
          ),
        ],
      ),
      section(
        "checkout",
        "Your storefront",
        "Integrate checkout without exposing secrets",
        [
          paragraph(
            "The workspace customer page provides purchase and account flows. An independent storefront can use GET /catalog for Entitle plan IDs and POST /checkout with planId, email and uiMode. The server resolves the price, merchant, tax settings and return URL.",
          ),
          code(
            "HTTP / Stripe-hosted Checkout",
            `POST ${base}/checkout\nContent-Type: application/json\n\n{\n  "planId": "PLAN_ID_FROM_CATALOG",\n  "email": "buyer@example.com",\n  "uiMode": "hosted"\n}`,
          ),
          paragraph(
            "Stripe-hosted checkout returns a url. Elements returns uiMode, clientSecret, publishableKey and returnUrl, plus stripeAccount in connected-account mode. Use those exact values with the official Stripe.js loader; keep client secrets in memory. Card details go directly to Stripe.",
          ),
          note(
            "Checkout UI and deployment mode are independent",
            "uiMode: hosted means Stripe hosts the payment page. It works in both standalone and hosted deployments. In either mode, a redirect or successful browser confirmation never grants paid rights; canonical invoice reconciliation does.",
          ),
          paragraph(
            "A guest checkout retry is bound to an HttpOnly cookie for its unpaid customer. If you proxy checkout through your storefront, relay that issuing browser's cookie even on provider errors. An existing buyer email requires buyer sign-in through the workspace flow or a complete same-origin session proxy. A general cross-domain authentication bridge is not included.",
          ),
          paragraph(
            "Tax settings apply to both Checkout interfaces. Enable Stripe Tax and configure merchant registrations first, then choose automatic tax, tax-ID and billing-address collection in the dashboard. Configure the merchant's Customer Portal for recurring billing management.",
          ),
        ],
      ),
      section("billing", "Paid rights", "Billing and access", [
        paragraph(
          "Complimentary access is covered in Complimentary licenses. Paid checkout and billing remain unavailable until their required Stripe configuration exists; complimentary issuance never creates a subscription.",
        ),
        paragraph(
          `In both versions, your Stripe account collects customer payments. ${site.name} is not a merchant of record. Hosted service charges are separate from the price your buyers pay for licenses.`,
        ),
        h("div", { class: "docs-columns" }, [
          h("div", [
            h("h3", "Your customers’ subscription"),
            paragraph(
              "Your annual product plans pay for licenses and installation allowances. Customers can buy through Stripe Checkout or an integrated Stripe Elements form and manage billing through their customer page.",
            ),
          ]),
          h("div", [
            h("h3", "Hosted service charges"),
            paragraph(
              "Hosted sellers pay a platform subscription and a configured application fee, default 1%, plus separate Stripe fees. Review the actual subscription amount and rate in the dashboard and checkout. The rate is set when a new license subscription is created and retained for its renewals; changing the configured rate does not rewrite existing subscriptions. Hosted application fees are retained on refunds by default. A fee refund requires a separate operator action in Stripe. Self-hosted standalone has no platform subscription or application fee.",
            ),
          ]),
        ]),
        table(
          "Payment events and download access",
          ["What happened", "What changes"],
          [
            [
              "Confirmed paid invoice",
              "Creates or renews paid entitlement. The browser’s checkout return alone never grants access.",
            ],
            [
              "Renewal canceled or payment fails",
              "Purchased time remains available until the paid-through date.",
            ],
            [
              "Paid period expires",
              "New downloads and updates stop. Installed functionality continues.",
            ],
            [
              "Full refund",
              "Future downloads are revoked. A partial refund does not change entitlement.",
            ],
            [
              "Open or lost dispute",
              "Downloads are suspended. Resolution is reconciled with Stripe.",
            ],
          ],
        ),
        paragraph(
          "Hosted platform delinquency can block new purchases and releases while preserving existing buyers’ paid download rights. Explicit abuse suspension is separate. In both versions, license expiration and server outages must not remotely disable installed software.",
        ),
        paragraph(
          "In local billing mode, purchase fixtures create test entitlement and real Stripe checkout is disabled. Fixture purchases do not represent money received.",
        ),
      ]),
      section(
        "customer-accounts",
        "Buyer support",
        "Help customers manage their licenses",
        [
          paragraph(
            "Direct buyers to their workspace customer page, /app/t/YOUR_WORKSPACE_SLUG on the hosted service. A buyer email link is bound to that browser and workspace. Their account lists their own licenses, installation allowances, installations and available releases. Complimentary licenses show their expiration; Stripe billing is offered only when available for that customer.",
          ),
          table(
            "Buyer actions",
            ["Action", "Effect"],
            [
              [
                "Replace a lost key",
                "Returns a replacement key and invalidates every existing installation token. Activate clients again with the new key.",
              ],
              [
                "Deactivate an installation",
                "Releases that seat and invalidates its token; other installations remain available.",
              ],
              [
                "Cancel renewal in Stripe",
                "Stops future renewal according to the merchant's Portal settings. Already-paid time remains.",
              ],
              [
                "Download account data",
                "Exports allowlisted data for the current buyer only.",
              ],
              [
                "Request account closure",
                "Records a request for offline operator financial/retention review. Does not cancel subscriptions or erase paid rights.",
              ],
            ],
          ),
          paragraph(
            "Notifications and privacy shows lifecycle notices and closure status. Dismissing a notice changes its display, not the license's paid period. Keep support diagnostics to request IDs, product/version/target and safe state; customers should never send raw keys or tokens in public support threads.",
          ),
        ],
      ),
      section("hosted-tiers", "Editions", "Core tools and Hosted Pro", [
        paragraph(
          "Core tools include licensing and updates, account security and recovery, sandbox testing, Stripe tax settings, buyer privacy, encrypted workspace export, basic operating health and lifecycle notices.",
        ),
        paragraph(
          "Hosted Pro adds signed outgoing webhooks and advanced daily bandwidth reports. Monthly pricing is configured by the service operator and shown in Stripe before purchase. To change tiers, cancel renewal in the billing portal, wait until canonical cancellation at the paid period end, then choose the new tier in Checkout. Immediate tier switching is unavailable. An unpaid upgrade does not grant Pro.",
        ),
        note(
          "Paid rights stay independent",
          "Pro expiration preserves core security, recovery, exports and existing buyers' paid download rights. Self-hosted standalone includes all local capabilities without a platform subscription or a callback to the hosted service.",
        ),
      ]),
      section(
        "operating-your-business",
        "Daily use",
        "Protect accounts and keep updates running",
        [
          h("h3", "Account security"),
          paragraph(
            "Open Account security to review and revoke sessions, create offline recovery codes, or change a hosted seller email with approval from both mailboxes. API keys, browser release publication and workspace export need a fresh, single-use emailed confirmation for the specific action. Keep recovery codes offline; replacing them invalidates the previous set.",
          ),
          h("h3", "Test in a sandbox"),
          paragraph(
            "Create an isolated test workspace in Sandbox. It has separate customers, licenses, activation tokens and releases. Fixture purchases deliver only to your verified seller email and never charge money. Stripe test mode requires the operator's separate test credentials. The environment badge identifies test workspaces; production capacity and Pro entitlement follow the live parent.",
          ),
          h("h3", "Tax and operating health"),
          paragraph(
            "Tax settings control automatic tax, tax-ID and billing-address collection for both hosted Checkout and Elements. Activate Stripe Tax and configure registrations in your merchant account first. Operations shows queues, storage, served bytes and storage reads. Lifecycle notices remind buyers when download access is approaching expiry or has expired; installed functionality continues working.",
          ),
          h("h3", "Webhooks and data control"),
          paragraph(
            "Hosted Pro and standalone can send signed lifecycle events to HTTPS endpoints. Store the one-time signing secret, verify the timestamp and exact request body, and deduplicate event IDs. Advanced reports count served responses and bytes, not completed installations.",
          ),
          paragraph(
            "Buyers can export their own account data and request closure from Notifications and privacy. Closure waits for operator financial and retention review and does not cancel subscriptions or erase paid rights. Workspace export creates encrypted files for operator-controlled transfer to a fresh standalone installation. Download every file before expiry and keep the passphrase separately.",
          ),
          h("h3", "Confirm sensitive actions"),
          paragraph(
            "Emailed verification is purpose-specific and bound to your current session. After consumption, its proof lasts five minutes and works once. API-key changes use api_keys, browser publication uses release_publish, workspace export uses tenant_transfer and recovery-code replacement uses recovery_codes. A failed action requires a new proof.",
          ),
          h("h3", "Read health before retrying work"),
          table(
            "Default operating thresholds",
            ["Setting", "Default"],
            [
              ["Failed queue items", "Alert at one failed job."],
              ["Pending age", "Alert at one hour."],
              [
                "Storage capacity",
                "Alert at 90%, including active reservations.",
              ],
              [
                "Bandwidth",
                "Disabled until a nonzero byte threshold is configured.",
              ],
              ["Alert cooldown", "One hour."],
              ["Expiry notices", "Enabled; warning seven days before expiry."],
            ],
          ),
          paragraph(
            "GET /seller/operations returns queue/storage/read summaries, active alerts and settings. PUT /seller/operations/settings accepts bounded updates. Advanced reports accept days=1 through 365, default 30, and return recorded UTC daily aggregates. Missing days need not have zero-filled rows. Storage reads include complete verification for a cold range; cache hits avoid another remote read.",
          ),
        ],
      ),
      section(
        "sandbox",
        "Test before release",
        "Use an isolated publisher sandbox",
        [
          paragraph(
            "In Sandbox, choose fixture or Stripe test mode. The child has a distinct workspace slug, buyer URL, products, customers, licenses, activation tokens and private artifact namespace. Verify the server-confirmed environment badge and returned URLs before making requests.",
          ),
          h("ol", { class: "docs-checklist" }, [
            h(
              "li",
              "Create the sandbox from the live workspace and select its immutable mode. One child workspace is supported.",
            ),
            h(
              "li",
              "Switch to its returned buyer/API paths and create its test product and plan.",
            ),
            h(
              "li",
              "Publish a package in the child workspace. Live activation tokens do not authorize its downloads.",
            ),
            h(
              "li",
              "Run a fixture purchase delivered to your verified seller email, or a Stripe test checkout when configured.",
            ),
            h(
              "li",
              "Test activation, updates, deactivation and recovery with the child credentials.",
            ),
          ]),
          paragraph(
            "Fixture purchases never charge money and cannot target an arbitrary customer email. Stripe mode needs the operator's complete separate test keys and /api/v1/stripe/sandbox-webhook; only signed test events enter mapped sandboxes. The sandbox follows its live parent's capacity and Pro access without consuming another live-workspace slot.",
          ),
          note(
            "Keep local billing separate",
            "LOCAL_BILLING is a server development setting, forbidden in production. An isolated fixture sandbox is the supported publisher testing flow on a configured deployment; it does not require turning production payments into fixtures.",
          ),
        ],
      ),
      section("webhooks", "Automation", "Receive signed lifecycle events", [
        paragraph(
          "Hosted Pro and standalone can deliver signed JSON POSTs to your own public HTTPS endpoint. Use Webhooks in the dashboard or the seller API with operations:write. Save the returned signing secret once; list responses never expose it.",
        ),
        code(
          "HTTP / create a webhook endpoint",
          `POST ${base}/seller/webhooks\nAuthorization: Bearer SELLER_API_KEY\nContent-Type: application/json\n\n{\n  "url": "https://hooks.example.com/entitle",\n  "events": ["license.created", "license.renewed", "release.published"]\n}`,
        ),
        table(
          "Outgoing event types",
          ["Events", "Resource"],
          [
            [
              "license.created, license.renewed, license.revoked",
              "License ID.",
            ],
            ["activation.changed", "Installation record ID."],
            ["release.published, release.withdrawn", "Release ID."],
            ["alert.raised", "Operating alert kind."],
          ],
        ),
        code(
          "JSON / event envelope",
          JSON.stringify(
            {
              id: "OPAQUE_EVENT_ID",
              type: "license.renewed",
              resourceId: "LICENSE_ID",
              occurredAt: 1792627200000,
              tenantId: "INTERNAL_TENANT_ID",
            },
            null,
            2,
          ),
        ),
        paragraph(
          "The request carries X-Entitle-Timestamp in Unix seconds, X-Entitle-Event-Id and X-Entitle-Signature. The signature is v1= followed by hex HMAC-SHA256 over TIMESTAMP.EVENT_ID.RAW_BODY, using the literal signing secret as the key. occurredAt in the body is Unix milliseconds.",
        ),
        h("ol", { class: "docs-checklist" }, [
          h(
            "li",
            "Preserve the exact raw UTF-8 body before JSON parsing. Verify the HMAC in constant time and reject timestamps more than five minutes from your clock.",
          ),
          h(
            "li",
            "Parse and validate the body, including matching body/header event IDs, expected workspace and supported event type.",
          ),
          h(
            "li",
            "Durably deduplicate by event ID and record local work before returning 2xx. Process expensive work asynchronously.",
          ),
          h(
            "li",
            "Read current authorized resource state if needed. Delivery order is not guaranteed and an event is not an authoritative payment grant.",
          ),
        ]),
        paragraph(
          "Delivery is at least once. Lost acknowledgments can duplicate an event; a retry has a fresh timestamp/signature. Failures back off from five seconds to at most one hour, within 72 hours and at most 12 attempts. Inspect delivery state before explicit retry using its returned 64-character hashed delivery ID.",
        ),
        paragraph(
          "At most ten endpoints and 1,000 pending/running deliveries are admitted per workspace. URLs cannot contain credentials, queries or fragments. Every DNS answer must be public; redirects and private/mixed-address destinations are refused. The operator may apply an exact-host allowlist.",
        ),
        note(
          "Coordinate secret rotation",
          "Rotation returns a new secret once and moves undelivered events to the new generation. Failed rows stay failed for explicit retry. Deleting an endpoint cancels queued deliveries. Neither action can recall requests already received by your service.",
        ),
        paragraph(
          "Pro expiry pauses advanced delivery. Events can wait within the bounded grace window for a paid contiguous renewal; never-Pro workspaces have no historical backfill. The source package's docs/webhooks.md includes a runnable Node signature helper and the complete retry contract.",
        ),
      ]),
      section(
        "portability",
        "Data control",
        "Export a workspace for self hosting",
        [
          paragraph(
            "Encrypted workspace transfers are core and do not require Pro. An export preserves product/plan mappings, customer licenses and paid grants, installation token hashes, immutable releases and relevant billing receipts. It excludes seller/buyer sessions, automation keys, platform subscriptions, outgoing webhook credentials and the source application secret.",
          ),
          h("ol", { class: "docs-checklist" }, [
            h(
              "li",
              "Choose a private passphrase of 12-1024 characters. Browser creation needs fresh tenant_transfer confirmation; automation uses data:export.",
            ),
            h(
              "li",
              "Download manifest.entitle and every returned UUID.blob file before the one-hour expiry. Keep the passphrase separately.",
            ),
            h(
              "li",
              "Arrange an operator-controlled transfer to a fresh offline standalone database and empty private bucket with the same verified Stripe merchant.",
            ),
            h(
              "li",
              "Reconcile imported subscriptions and pending receipts before finalization. Import begins suspended and does not itself cut over Stripe or client URLs.",
            ),
          ]),
          paragraph(
            "One creating or retained bundle is admitted per tenant. Shared export count/disk limits also apply. A restart invalidates process-local export handles. Passphrases cannot be recovered. Export is distinct from a whole-service backup. Completed closure attribution is preserved and rekeyed at import; older receipts require the reviewed closure-attribution-upgrade command first.",
          ),
          note(
            "Preserve existing credentials during cutover",
            "Import preserves license and activation identities and re-encrypts retry material under a new destination secret. Do not rotate keys just to move the endpoint. A changed origin requires a planned adapter update; never forward Authorization across an origin-changing redirect.",
          ),
          paragraph(
            "The source package includes docs/portability.md and docs/operator-maintenance.md with the offline commands, merchant verification, shutdown/drain requirements and customer-closure retention and legacy-upgrade procedure. Import and closure approval have no unrestricted browser route.",
          ),
        ],
      ),
      section("self-hosting", "Operators", "Deploy and configure the service", [
        paragraph(
          "Build the API and Vue interfaces independently with pnpm build:server and pnpm build:web. The API runs database-backed jobs; a separate web runtime serves immutable frontend releases and proxies API requests. Static content changes can publish without rebuilding either runtime image. Run behind HTTPS with a persistent SQLite database or configured PostgreSQL/MySQL, private S3-compatible storage and SMTP. Redis is optional. The source package contains deploy/compose.yaml, .env.example and the full deployment/configuration guides.",
        ),
        note(
          "Production without Stripe",
          "For complimentary licensing, keep LOCAL_BILLING=false and omit all primary Stripe, Connect and platform price values. HTTPS, application secrets, private storage, SMTP and owner/proxy settings remain required. Partial primary Stripe configuration is refused in production. Paid operations return 503 billing_unavailable until configured; separate sandbox test credentials do not enable primary billing.",
        ),
        table(
          "Production settings and optional paid billing",
          ["Area", "Configure"],
          [
            [
              "Origin and proxy",
              "NODE_ENV=production, an HTTPS PUBLIC_ORIGIN and exact TRUST_PROXY address/subnet.",
            ],
            [
              "Private state",
              "Independent APP_SECRET with 64 hex characters, OPERATOR_TOKEN of at least 32 characters, persistent DATABASE_URL/DATA_DIR and private WORK_DIR.",
            ],
            [
              "Storage",
              "S3_BUCKET, S3_REGION, provider credentials and optional HTTPS S3_ENDPOINT. Public object access stays blocked.",
            ],
            [
              "Email",
              "SMTP_HOST/port/credentials, deliverable MAIL_FROM and TLS. LOCAL_BILLING=false.",
            ],
            [
              "Standalone",
              "STANDALONE_OWNER_EMAIL. Stripe settings are optional for complimentary licensing; enabling paid sales requires matching merchant keys/mode and STRIPE_WEBHOOK_SECRET.",
            ],
            [
              "Hosted",
              "For paid billing: complete primary Stripe, Connect OAuth/client configuration, separate Connect signing secret and configured platform subscription prices. Omit these together for a complimentary-only deployment.",
            ],
          ],
        ),
        table(
          "Incoming Stripe endpoints",
          ["Mode", "Path and secret"],
          [
            [
              "Standalone merchant",
              "/api/v1/stripe/merchant-webhook uses STRIPE_WEBHOOK_SECRET.",
            ],
            [
              "Hosted platform billing",
              "/api/v1/stripe/platform-webhook uses STRIPE_WEBHOOK_SECRET.",
            ],
            [
              "Hosted connected merchants",
              "/api/v1/stripe/connect-webhook uses STRIPE_CONNECT_WEBHOOK_SECRET.",
            ],
            [
              "Optional Stripe-test sandboxes",
              "/api/v1/stripe/sandbox-webhook uses the complete separate test key set.",
            ],
          ],
        ),
        paragraph(
          "Use the correct account, test/live mode, raw-body signature and event subscriptions. Configure the hosted OAuth redirect at PUBLIC_ORIGIN/api/v1/platform/stripe/callback. Browser returns do not replace signed events and canonical reconciliation.",
        ),
        h("h3", "Budget the work volume"),
        code(
          "Configuration / minimum pool relationships",
          "TRANSFER_MEMORY_MIB >= 6 * MAX_UPLOAD_MIB\nNATIVE_SPOOL_MIB >= 2 * MAX_NATIVE_UPLOAD_MIB\nARTIFACT_CACHE_MIB >= 2 * MAX_NATIVE_UPLOAD_MIB\nMAX_NATIVE_UPLOAD_MIB <= ARTIFACT_CACHE_INFLIGHT_MIB <= ARTIFACT_CACHE_MIB",
        ),
        paragraph(
          "Native publication defaults to a 4 GiB spool pool. Verified native downloads have a separate 4 GiB cache and 2 GiB in-flight fill budget, five-minute idle TTL and 120-second transfer inactivity window. Provision physical disk for both pools, encrypted exports, database and a free-space floor. Per-process reservations do not replace filesystem quotas.",
        ),
        h("h3", "Check health and durable work"),
        code(
          "Shell / public health probes",
          `curl --fail ${origin}/api/v1/health\ncurl --fail ${origin}/api/v1/ready`,
        ),
        paragraph(
          "Liveness checks that the process responds. Readiness checks a database query, S3 bucket access and private work-directory access. Neither qualifies email delivery, live Stripe, all storage permissions or backup recovery. Monitor queue failures/age, disk, storage reservations, served bytes and provider errors separately.",
        ),
      ]),
      section(
        "backup-and-recovery",
        "Recovery",
        "Back up matching state and rehearse restore",
        [
          paragraph(
            "The operator owns consistent database, private object and APP_SECRET backups. Hosted sellers can export a workspace but do not operate the platform's full backup. Standalone publishers operate both. Keep encrypted configuration and the deployed image identity with the recovery record.",
          ),
          h("ol", { class: "docs-checklist" }, [
            h(
              "li",
              "Stop and drain applications/workers so publications, activations and delivery cannot change state during the backup.",
            ),
            h(
              "li",
              "Snapshot the database and every private tenant artifact, including withdrawn releases and every native target. Preserve the original APP_SECRET.",
            ),
            h(
              "li",
              "Restore into isolated private infrastructure, verify object sizes/checksums against release/asset records and test an authenticated paid download.",
            ),
            h(
              "li",
              "Reapply later revocations/key rotations, reconcile current provider state and test recovery before directing traffic to the restored installation.",
            ),
          ]),
          paragraph(
            "For SQLite, do not copy only a live main database file; use the stopped persistent directory including WAL/SHM state. Provider ETags are not interchangeable with artifact SHA-256. Object versioning alone is not an independent backup. Keep the source package's docs/backup.md with your operating procedures.",
          ),
          note(
            "Do not regenerate APP_SECRET during recovery",
            "Encrypted installation retry tokens, outgoing secrets and retained outbox material depend on it. Restore matching state. A schema rollback requires a compatible backup, and switching deployment mode does not migrate existing accounts or payments.",
          ),
        ],
      ),
      section(
        "server-limits",
        "Capacity reference",
        "Server limits and storage",
        [
          paragraph(
            "The upload cap below comes from this server. Check your workspace’s current product and storage allowances in the dashboard before publishing a large release.",
          ),
          info
            ? h("dl", { class: "docs-limits" }, [
                h("div", [
                  h("dt", "Maximum WordPress ZIP"),
                  h(
                    "dd",
                    `${(info.maxUploadBytes / 1048576).toLocaleString("en-US", { maximumFractionDigits: 1 })} MiB`,
                  ),
                ]),
                h("div", [
                  h("dt", "Maximum native asset"),
                  h(
                    "dd",
                    `${((info.maxNativeUploadBytes ?? 104857600) / 1048576).toLocaleString("en-US", { maximumFractionDigits: 1 })} MiB`,
                  ),
                ]),
                h("div", [h("dt", "Release storage"), h("dd", "Private S3")]),
                h("div", [
                  h("dt", "Database options"),
                  h("dd", info.databaseEngines.join(", ")),
                ]),
              ])
            : staticSite
              ? h(
                  "a",
                  { href: applicationHref("/docs#server-limits") },
                  "View live server limits in the app",
                )
              : !error && h("p", { role: "status" }, "Loading server limits…"),
          error &&
            h("div", { class: "docs-load-error" }, [
              h("p", { role: "alert" }, error),
              h(
                "button",
                { type: "button", class: "button-secondary", onClick: reload },
                "Reload server limits",
              ),
            ]),
          h("ul", { class: "docs-checklist" }, [
            h(
              "li",
              "WordPress ZIPs and native packages have separate configurable limits. Their hard ceilings are 100 MiB and 2 GiB respectively. Larger bundles are rejected before publication.",
            ),
            h(
              "li",
              "Uploads have finite receive deadlines and shared memory or disk admission budgets. A busy server can reject a transfer before publication; retry after capacity becomes available.",
            ),
            h(
              "li",
              "Archive validation bounds entry counts, expanded size, paths and processing time. WordPress ZIPs allow at most 2,000 entries and 250 MiB expanded. Native archive expansion is bounded by the greater of 250 MiB or compressed package size.",
            ),
            h(
              "li",
              "Native downloads support GET, HEAD and a single byte range. Multipart ranges and delta generation are not included.",
            ),
            h(
              "li",
              "Assets are immutable and private. Retained withdrawn artifacts still count toward storage allowances.",
            ),
          ]),
        ],
      ),
      section("api", "HTTP reference", "API and authentication", [
        paragraph(
          "All software and seller routes belong to a workspace. Replace your-workspace and example-app with your workspace and product slugs. The examples below use this server’s origin.",
        ),
        code("Workspace API base URL", base),
        table(
          "Credentials and where to use them",
          ["Credential", "Used by", "Purpose"],
          [
            [
              "Customer license key",
              "Your client’s activation form",
              "POST /activate to register a site or device.",
            ],
            [
              "Activation token",
              "One installed client",
              "Bearer authentication for status, updates and package downloads.",
            ],
            [
              "Seller API key",
              "Your private build pipeline",
              "Scoped, expiring access to /seller routes. Create it in API keys; it is shown once.",
            ],
          ],
        ),
        h("h3", "1. Activate a device"),
        paragraph(
          "The customer supplies their own license key. Generate a random installation ID once and persist it across updates. For WordPress, Joomla or a Generic site product, also send siteUrl with the site’s full URL.",
        ),
        code(
          "HTTP / device activation",
          `POST ${base}/activate\nContent-Type: application/json\n\n{\n  "key": "CUSTOMER_LICENSE_KEY",\n  "product": "example-app",\n  "installationId": "PERSISTED_RANDOM_INSTALLATION_ID",\n  "installationLabel": "My laptop"\n}`,
        ),
        paragraph(
          "The response’s token field is the activation token. Store it in protected client storage. Retrying with the same installation ID returns the existing token. Deactivate an installation before moving it to a different site.",
        ),
        h("h3", "2. Check for an update"),
        paragraph(
          "This example is for a Generic product with a linux-x64 asset. Other frameworks use their native feed paths from Client setup. A 204 response means no newer release is available.",
        ),
        code(
          "HTTP / Generic update check",
          `GET ${base}/updates/generic/example-app/linux-x64?currentVersion=1.0.0\nAuthorization: Bearer ACTIVATION_TOKEN`,
        ),
        paragraph(
          "Use the returned package URL and the same activation token to download. Downloads recheck access, even when the feed response is cached. Verify the SHA-256 checksum and your updater’s signatures before installation.",
        ),
        h("h3", "3. Read seller data from your build system"),
        code(
          "HTTP / seller overview · requires the read scope",
          `GET ${base}/seller/overview\nAuthorization: Bearer SELLER_API_KEY`,
        ),
        paragraph(
          "Give each automation key only the scopes it needs, such as read or releases:write. Browser sessions use their own cookies and CSRF protection. Seller keys and platform operator credentials never belong in a distributed app, plugin, browser bundle or package URL.",
        ),
        table(
          "Automation scopes",
          ["Scope", "Permitted work"],
          [
            [
              "read",
              "Overview, price picker, safe jobs, current features and operating health.",
            ],
            ["catalog:write", "Product and plan configuration."],
            ["releases:write", "Publish and withdraw releases/assets."],
            [
              "licenses:write",
              "Issue complimentary licenses, set or clear seller revocation; local purchase fixtures when enabled.",
            ],
            [
              "billing:reconcile",
              "Queue reconciliation, run tenant work and retry work/email jobs.",
            ],
            [
              "operations:write",
              "Operating settings and eligible webhook creation, rotation, deletion and retry.",
            ],
            [
              "data:export",
              "Create, download and delete encrypted workspace exports.",
            ],
          ],
        ),
        paragraph(
          "API keys default to read plus releases:write and 90 days, with a 365-day maximum lifetime. Key management, Connect, platform billing, commerce and sandbox management require an interactive seller session. Some reads and writes can have stricter capability or account checks in addition to scopes.",
        ),
        h("h3", "Framework feed paths"),
        table(
          "Protected updater feeds relative to the tenant API base",
          ["Framework", "GET path"],
          [
            ["WordPress", "/updates/PRODUCT"],
            ["Joomla", "/updates/joomla/PRODUCT.xml"],
            ["Electron", "/updates/electron/PRODUCT/TARGET/FILENAME"],
            ["Tauri", "/updates/tauri/PRODUCT/TARGET/CURRENT_VERSION"],
            ["Sparkle", "/updates/sparkle/PRODUCT/TARGET/appcast.xml"],
            ["JetBrains", "/updates/jetbrains/PRODUCT/updatePlugins.xml"],
            ["Generic", "/updates/generic/PRODUCT/TARGET?currentVersion=1.0.0"],
          ],
        ),
        paragraph(
          "Electron uses latest.yml for Windows, latest-mac.yml for Darwin, latest-linux.yml for linux-x64 and latest-linux-arm64.yml for linux-arm64. Joomla's separate public immutable details reload contains no credentials or package bytes. JetBrains may append bounded build, os and arch query values; credentials never belong in queries.",
        ),
        h("h3", "Browser authentication"),
        paragraph(
          "Seller identity lives at /api/v1/platform/me; buyer identity lives at this workspace's /me. Browser mutations require the exact deployment Origin and X-CSRF-Token from the matching identity response. Sessions are HttpOnly, SameSite=Lax and Secure in production. Export ciphertext GETs additionally require the seller CSRF header.",
        ),
        paragraph(
          "Email sign-in is a request/consume flow bound to the browser that requested the link. Do not move cookies between buyers and sellers or treat a guest checkout cookie as an authenticated account. Cross-origin customer session CORS is disabled.",
        ),
        table(
          "HTTP results",
          ["Status", "Meaning and next step"],
          [
            ["204", "No update offer. Keep the installed version."],
            [
              "400 / 409",
              "Read the error code for invalid input or an identity, seat-binding or immutable-publication conflict.",
            ],
            [
              "401 / 403",
              "Check credential, scope, workspace and current paid access; do not retry with a broader secret.",
            ],
            ["413", "Body exceeds the configured artifact cap."],
            ["416", "Native byte range is invalid or unsupported."],
            [
              "429 / 503",
              "Rate limit, shared capacity or dependency unavailable. Respect Retry-After when supplied and use bounded backoff.",
            ],
          ],
        ),
        note(
          "When a request fails",
          "Errors use {error:{code,message,requestId}}. Keep the request ID when investigating a failure. A feed response is not a promise of future download access; expiration, revocation or withdrawal can deny a later request.",
        ),
      ]),
      section("troubleshooting", "Help", "Diagnose a failed workflow", [
        h("h3", "Bought a plugin or app? Start here."),
        paragraph(
          "Open the customer page linked in your purchase email. Each software publisher has its own workspace and handles questions about its products, invoices and refunds.",
        ),
        h("ol", { class: "docs-checklist" }, [
          h(
            "li",
            "Request a fresh sign-in link and open it in the same browser that requested it.",
          ),
          h(
            "li",
            "Check your license's paid-through date and installations. Deactivate an old site or device to free a seat.",
          ),
          h(
            "li",
            "Open the billing portal from your account for invoices, payment details or cancellation. Replacing a key does not cancel a subscription.",
          ),
        ]),
        h("p", [
          h(
            "a",
            { href: "#customer-accounts" },
            "Customer account and key recovery guide →",
          ),
        ]),
        note(
          "Share diagnostics safely",
          "Give your software publisher the request ID, product, version and what you were trying to do. Never share your license key, activation token, session cookie or export passphrase in a support thread.",
        ),
        h("h3", "Publishing or operating the service?"),
        paragraph(
          "Keep the HTTP status, error code and request ID, plus the workspace, product, framework, target and version. Exclude keys, tokens, cookies, passphrases and provider payloads from shared diagnostics. The source package's docs/troubleshooting.md has the full operator checklist.",
        ),
        ...[
          [
            "My sign-in link does not work",
            "Open the email link in the browser that requested it. Links are expiring and single-use. Request another from the relevant seller or customer sign-in page. In local development, emails are delivered to the configured mail fixture.",
          ],
          [
            "A customer has run out of sites or devices",
            "Deactivate an old installation in the customer page to free its seat. Keep the installation ID stable across updates; generating a new ID each time consumes additional seats.",
          ],
          [
            "A paid customer cannot download",
            "Check the paid-through date, revocation and dispute state, and whether the release was withdrawn. An old update offer does not bypass current access checks. If payment has not appeared, inspect billing jobs and reconciliation rather than creating another charge.",
          ],
          [
            "The updater finds no new version",
            "Check the product slug, framework feed, target and current version. Confirm a newer release exists for that exact target. A 204 response is an expected no-update result.",
          ],
          [
            "My release upload is rejected",
            "Check the live size cap above, upload duration, target, package identity and version. Tauri and Sparkle also require signature metadata. Correct the build or publish a new version; published bytes cannot be overwritten.",
          ],
          [
            "My API key works for reads but cannot publish",
            "Check tenant, expiry and releases:write scope. An interactive browser also needs a fresh release_publish proof. Owner-only actions reject automation keys regardless of scopes; do not substitute an operator credential.",
          ],
          [
            "A sensitive action fails after email confirmation",
            "Confirm the proof's purpose and current session. It lasts five minutes after consumption and can be used once. A failed action needs a new proof. Browser mutations also require matching Origin and CSRF headers.",
          ],
          [
            "Checkout asks an existing customer to sign in",
            "Existing buyer emails require the workspace buyer session. A guest checkout cookie permits retry only for its unpaid customer; it is not a buyer login. A storefront proxy must relay the issuing browser's cookie, including on provider errors.",
          ],
          [
            "Native downloads are busy or slow on the first request",
            "A cold download verifies a complete private object into the bounded disk cache before serving bytes, even for a range. Check disk, publication/cache/export reservations and transfer deadlines. A warm cache still checks entitlement. Retry transient JSON capacity errors with bounded backoff.",
          ],
          [
            "License email is delayed while the server is ready",
            "Readiness does not send email. Inspect pending/failed mail, SMTP credentials/TLS/deliverability, backoff and UTC daily budgets. Budget deferral preserves the key. Resolve the cause before explicit retry; do not create another purchase.",
          ],
          [
            "My outgoing webhook signature does not match",
            "Verify exact raw body bytes before JSON parsing, the literal secret and TIMESTAMP.EVENT_ID.RAW_BODY with HMAC-SHA256. Check v1= prefix and clock skew within five minutes. Rotation changes the signing generation; deduplicate by event ID across attempts.",
          ],
          [
            "A sandbox purchase uses the wrong customer page",
            "Use the server-returned child workspace slug and its own product/plan IDs. Fixture delivery goes only to your verified seller email. Live tokens do not authenticate sandbox packages; confirm the environment badge before checkout.",
          ],
          [
            "My encrypted export is unavailable",
            "Download the manifest and every blob before one-hour expiry. A restart invalidates export handles. One retained or creating bundle per tenant and shared disk/count limits apply. Keep the passphrase separately; it cannot be recovered.",
          ],
          [
            "A restored or imported workspace cannot resume",
            "Restore matching database, objects and APP_SECRET. Imports require a fresh offline standalone destination, verified merchant and canonical reconciliation before finalization. Inspect the operator guide and retained receipt IDs; never erase mappings or manually unsuspend to bypass checks.",
          ],
        ].map(([title, description]) =>
          h("details", { class: "docs-faq" }, [
            h("summary", title),
            paragraph(description!),
          ]),
        ),
      ]),
      section("licensing", "Public source", "Source and licenses", [
        paragraph(
          `The service and dashboard are source available under Elastic License 2.0 plus the ${site.name} Publisher Use Permission. Client adapters and examples use MIT; generated client setup snippets also have an attribution-free Zero-Clause BSD grant. Third-party software keeps its own license. Copyright © 2026 Justin Silver. The software is provided without warranty.`,
        ),
        paragraph(
          "Use and modify the service for your own software business, including paid products, buyer portals, activation and downloads. The publisher permission does not cover offering a licensing or distribution platform as a hosted or managed service to independent publishers. Such services remain subject to the license restrictions. Deployment flags do not grant license rights.",
        ),
        h(
          "ul",
          { class: "docs-source-links" },
          (
            [
              ["/legal/source.tar.gz", "Download this build’s source"],
              ["/legal/Elastic-2.0.txt", "Elastic License 2.0"],
              ["/legal/ADDITIONAL-PERMISSION.txt", "Publisher use permission"],
              ["/legal/MIT.txt", "MIT client license"],
              ["/legal/0BSD.txt", "Generated client code license"],
              ["/legal/NOTICE.txt", "Project notices"],
              ["/legal/THIRD-PARTY.txt", "Browser dependency notices"],
            ] as const
          ).map(([href, label]) =>
            h("li", h("a", { href: applicationAsset(href) }, label)),
          ),
        ),
        paragraph(
          "The source package contains reviewed project files and build instructions. Deployment secrets, customer records and private software releases are not included. Self-hosting does not require a platform subscription or a Redis server; your payment, storage and email providers may charge separately.",
        ),
      ]),
      h("div", { class: "docs-end" }, [
        paragraph("Ready to publish your first release?"),
        h(
          "a",
          { href: applicationHref("/seller") },
          "Open your seller dashboard →",
        ),
        h("a", { href: "#main" }, "Back to top ↑"),
      ]),
    ]),
  ]);
}
