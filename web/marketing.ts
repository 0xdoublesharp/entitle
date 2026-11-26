import { createApp, defineComponent, h } from "vue";
import { site } from "../packages/shared/site.ts";
import { publicDocs } from "./docs.ts";
import { applicationHref } from "./navigation.ts";
import { icon as publicIcon, icons } from "./icons.ts";

const header = (docs = false) =>
  h("header", { class: "site-header" }, [
    h("a", { class: "brand", href: "/" }, [
      h("img", {
        class: "brand-mark",
        src: "/favicon.svg",
        alt: "",
        width: 36,
        height: 36,
        "aria-hidden": "true",
      }),
      site.name,
    ]),
    h("nav", { "aria-label": "Main navigation" }, [
      h("a", { href: "/#features" }, "Features"),
      h("a", { href: "/#hosting" }, "Hosting"),
      h(
        "a",
        { href: "/docs", "aria-current": docs ? "page" : undefined },
        "Docs",
      ),
      h("a", { href: "/docs#troubleshooting" }, "Help"),
      h(
        "a",
        { href: applicationHref("/seller"), "aria-label": "Seller dashboard" },
        [
          h("span", { class: "dashboard-label-wide" }, "Seller dashboard"),
          h("span", { class: "dashboard-label-short" }, "Dashboard"),
        ],
      ),
    ]),
  ]);
const frameworkMarks = {
  WordPress:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M5 9h4m-2 0 3 8 2-6 2 6 3-8m-6 0h3",
  Joomla:
    "M8 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z M20 6a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z M20 18a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z M8 19a2 2 0 1 0-4 0 2 2 0 0 0 4 0Z M6 7v3l4 4 M16 6h-3l-3 3 M18 16v-3l-4-4 M8 19h3l3-4",
  Electron:
    "M12 12h.01 M14 8c12 6 8 12-4 8S1 4 10 6m2 1C18-1 24 6 17 13S3 24 5 15m2-4C3 1 10 1 15 10s5 16-2 10",
  Tauri:
    "M15 8a5 5 0 1 0-7 5m1 3a5 5 0 1 0 7-5 M9 8h.01 M15 16h.01 M21 5h.01 M3 19h.01",
  Sparkle:
    "M12 2c0 6 4 10 10 10-6 0-10 4-10 10 0-6-4-10-10-10 6 0 10-4 10-10Z M19 3v4m-2-2h4",
  JetBrains: "M3 3h18v18H3Z M7 16h7 M7 8l3 2-3 2 M13 12h4",
  Generic: icons.box,
};
const documentationPreview = () =>
  h("div", { class: "home-resource-art" }, [
    h("div", { class: "resource-preview-heading" }, [
      publicIcon(icons.book),
      h("span", "Publisher documentation"),
    ]),
    h("div", { class: "resource-preview-content" }, [
      h("h3", "Integrate your software"),
      h("div", { class: "resource-preview-route" }, [
        publicIcon(icons.code),
        h("code", "POST /activate"),
      ]),
      h("ul", [
        h("li", [publicIcon(icons.check), "Activate a site or device"]),
        h("li", [publicIcon(icons.check), "Store its activation token"]),
        h("li", [publicIcon(icons.check), "Deliver private updates"]),
      ]),
      h("a", { href: "/docs#client-integration", class: "home-secondary" }, [
        "Read the integration guide",
        publicIcon(icons.arrow),
      ]),
    ]),
  ]);
const publicHome = () => [
  h("section", { class: "saas-hero", "aria-labelledby": "home-title" }, [
    h("div", { class: "hero-copy" }, [
      h("h1", { id: "home-title" }, [
        "License your software and ",
        h("span", "ship private updates"),
      ]),
      h(
        "p",
        { class: "intro" },
        "Give invited customers complimentary licenses or sell monthly or annual subscriptions through your own Stripe account.",
      ),
      h("div", { class: "button-row hero-actions" }, [
        h(
          "a",
          { href: applicationHref("/seller"), class: "button" },
          "Create your workspace",
        ),
        h("a", { href: "#how-it-works", class: "home-secondary" }, [
          "See how it works",
          publicIcon(icons.arrow),
        ]),
      ]),
      h(
        "p",
        { class: "hero-note" },
        "Run Entitle on your own server or use the hosted service.",
      ),
    ]),
    h(
      "figure",
      {
        class: "release-illustration",
        "aria-label": "From pilot invite or purchase to update",
      },
      [
        h("div", { class: "illustration-top" }, [
          h(
            "span",
            { class: "illustration-dots", "aria-hidden": "true" },
            "● ● ●",
          ),
          h("span", "From pilot or sale to update"),
        ]),
        h("div", { class: "workflow-stack" }, [
          h("div", { class: "workflow-node" }, [
            h("span", { class: "workflow-icon" }, publicIcon(icons.invite)),
            h("div", [
              h("strong", "Invite customers or sell a plan"),
              h("span", "Complimentary licenses or paid checkout"),
            ]),
            h(
              "span",
              { class: "workflow-check", "aria-hidden": "true" },
              publicIcon(icons.check),
            ),
          ]),
          h("div", { class: "workflow-connector", "aria-hidden": "true" }, "↓"),
          h("div", { class: "workflow-node workflow-license" }, [
            h("span", { class: "workflow-icon" }, publicIcon(icons.key)),
            h("div", [
              h("strong", "Email a license key"),
              h("span", "Customers use it to activate a site or device"),
            ]),
            h(
              "span",
              { class: "workflow-check", "aria-hidden": "true" },
              publicIcon(icons.check),
            ),
          ]),
          h("div", { class: "workflow-connector", "aria-hidden": "true" }, "↓"),
          h("div", { class: "workflow-node" }, [
            h("span", { class: "workflow-icon" }, publicIcon(icons.box)),
            h("div", [
              h("strong", "Deliver a private update"),
              h("span", "Entitle checks access on every download"),
            ]),
            h(
              "span",
              { class: "workflow-check", "aria-hidden": "true" },
              publicIcon(icons.check),
            ),
          ]),
        ]),
      ],
    ),
  ]),
  h(
    "section",
    { class: "framework-strip", "aria-label": "Supported framework adapters" },
    [
      h("p", "Supported frameworks"),
      h(
        "ul",
        Object.entries(frameworkMarks).map(([name, mark]) =>
          h("li", [
            h("span", { class: "framework-glyph" }, publicIcon(mark)),
            name,
          ]),
        ),
      ),
      h(
        "a",
        { href: "/docs#framework-support", class: "small" },
        "Explore adapters and runtime requirements →",
      ),
    ],
  ),
  h(
    "section",
    {
      id: "ai-agents",
      class: "home-section",
      "aria-labelledby": "agents-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h(
          "h2",
          { id: "agents-title" },
          "Manage Entitle from your AI agent",
        ),
        h(
          "p",
          "Give an MCP-compatible agent a scoped API key for your workspace.",
        ),
      ]),
      h("div", { class: "home-feature-grid home-agent-grid" }, [
        h("article", { class: "home-feature" }, [
          h("span", { class: "feature-icon" }, publicIcon(icons.code)),
          h("h3", "Set up your plugin for sale"),
          h(
            "p",
            "Have your agent create a product, map an existing monthly or annual Stripe price to a paid plan, and publish your release. Or start with a complimentary pilot.",
          ),
          h(
            "p",
            { class: "agent-example" },
            "“Set up my WordPress plugin with this monthly price and publish version 1.0.0 from my build.”",
          ),
        ]),
        h("article", { class: "home-feature" }, [
          h("span", { class: "feature-icon" }, publicIcon(icons.chart)),
          h("h3", "Review workspace activity"),
          h(
            "p",
            "Ask for a workspace overview of licenses, seats, downloads, storage, and payments by currency. Daily download and bandwidth reports come with Hosted Pro or self-hosting.",
          ),
          h(
            "p",
            { class: "agent-example" },
            "“Summarize my workspace’s licenses, downloads and payments, with each currency shown separately.”",
          ),
        ]),
      ]),
      h("div", { class: "home-agent-actions" }, [
        h(
          "a",
          { href: "/docs#mcp", class: "button button-secondary" },
          "Connect your AI agent",
        ),
        h("a", { href: "/docs#dashboard-reports", class: "home-secondary" }, [
          "See available reports",
          publicIcon(icons.arrow),
        ]),
      ]),
    ],
  ),
  h(
    "section",
    {
      id: "how-it-works",
      class: "home-section",
      "aria-labelledby": "journey-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h("h2", { id: "journey-title" }, "From your first license to your next release"),
      ]),
      h(
        "ol",
        { class: "journey-grid" },
        [
          [
            "Start with a pilot",
            "Publish a private release and issue complimentary licenses to invited customers. Set an expiration date and a site or device allowance.",
          ],
          [
            "Add paid plans",
            "Connect your Stripe account to sell monthly or annual plans. Entitle issues paid licenses after it confirms payment. Pilot customers can buy a plan separately.",
          ],
          [
            "Ship the next version",
            "Publish a new release. Customers with active access can update through your integrated updater or download from their account.",
          ],
        ].map(([title, copy]) =>
          h("li", [
            h("h3", title),
            h("p", copy),
          ]),
        ),
      ),
    ],
  ),
  h(
    "section",
    {
      id: "features",
      class: "home-section",
      "aria-labelledby": "features-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h(
          "h2",
          { id: "features-title" },
          "Licensing, billing, and release tools",
        ),
      ]),
      h(
        "div",
        { class: "home-feature-grid" },
        [
          [
            icons.key,
            "Paid and complimentary licenses",
            "Set a site or device allowance for each license. Track expiration for complimentary licenses and paid access, renewals, refunds, and disputes for subscriptions.",
          ],
          [
            icons.box,
            "Private release packages",
            "Publish immutable packages with checksums and framework metadata. Withdraw a release to stop new update offers and downloads for that version.",
          ],
          [
            icons.card,
            "Checkout and customer billing",
            "Accept payments into your own Stripe account. Buyers can manage their subscriptions through Stripe Customer Portal.",
          ],
          [
            icons.chart,
            "Workspace reports",
            "See licenses, seats, storage, and successful download responses. Review payment totals by currency and get daily bandwidth reports with Hosted Pro or self-hosting.",
          ],
          [
            icons.layers,
            "Multiple products per workspace",
            "Manage several apps or plugins together. Each product has its own plans, licenses, and releases. Workspaces keep customer and release data separate.",
          ],
          [
            icons.code,
            "Release automation",
            "Use the API, CLI, or MCP with a scoped API key. Set up a trusted OIDC publisher to release from CI without storing an API key.",
          ],
        ].map(([icon, title, copy]) =>
          h("article", { class: "home-feature" }, [
            h("span", { class: "feature-icon" }, publicIcon(icon!)),
            h("h3", title),
            h("p", copy),
          ]),
        ),
      ),
    ],
  ),
  h(
    "section",
    { class: "wordpress-feature", "aria-labelledby": "wordpress-title" },
    [
      h("div", [
        h("h2", { id: "wordpress-title" }, "Private updates in WordPress"),
        h(
          "p",
          "Integrate the WordPress client so licensed sites can install private releases from the standard update screen. The adapter provides compatibility metadata and authenticated downloads. You can keep the free plugin on WordPress.org.",
        ),
        h("a", { href: "/docs#framework-support" }, [
          "Explore WordPress support",
          publicIcon(icons.arrow),
        ]),
      ]),
      h("div", { class: "wordpress-art", "aria-hidden": "true" }, [
        h("div", { class: "wordpress-orbit" }, [h("span", "W")]),
        h("div", { class: "wordpress-update" }, [
          publicIcon(icons.box),
          h("div", [
            h("strong", "A new release is available"),
            h("span", "Install it from WordPress Updates."),
          ]),
        ]),
      ]),
    ],
  ),
  h(
    "section",
    {
      class: "home-section home-confidence",
      "aria-labelledby": "confidence-title",
    },
    [
      h("div", [
        h(
          "h2",
          { id: "confidence-title" },
          "Installed software keeps working",
        ),
        h(
          "p",
          "When a license expires, Entitle stops new activations, downloads, and updates. The example clients keep installed features available after expiration and during a licensing-server outage.",
        ),
      ]),
      h("div", { class: "confidence-details" }, [
        h("p", [
          publicIcon(icons.check),
          "Scoped, revocable activation tokens",
        ]),
        h("p", [publicIcon(icons.check), "Private packages with checksums"]),
        h("p", [
          publicIcon(icons.check),
          "Customer-controlled keys and installations",
        ]),
        h(
          "a",
          { href: "/docs#server-limits" },
          "Read the operational details →",
        ),
      ]),
    ],
  ),
  h(
    "section",
    {
      class: "home-section home-resources",
      "aria-labelledby": "explore-title",
    },
    [
      h("div", [
        h("div", { class: "home-section-heading" }, [
          h("h2", { id: "explore-title" }, "Dashboard and guides"),
        ]),
        h(
          "ul",
          { class: "home-resource-links" },
          [
            {
              href: applicationHref("/seller"),
              title: "Open your seller dashboard",
              copy: "Manage products, licenses, and private releases.",
            },
            {
              href: "/docs#customer-accounts",
              title: "Explore customer accounts",
              copy: "See how buyers manage keys, downloads, and installations.",
            },
            {
              href: "/docs#getting-started",
              title: "Read the setup guide",
              copy: "Set up a product, activate a license, and publish an update.",
            },
          ].map(({ href, title, copy }) =>
            h("li", [
              h("a", { href }, [
                h("div", [h("h3", title), h("p", copy)]),
                publicIcon(icons.arrow),
              ]),
            ]),
          ),
        ),
      ]),
      documentationPreview(),
    ],
  ),
  h(
    "section",
    {
      id: "hosting",
      class: "home-section",
      "aria-labelledby": "hosting-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h("h2", { id: "hosting-title" }, "Hosted or self-hosted"),
        h("p", [
          "Once your verified Stripe account is connected, you can export an encrypted copy of your hosted workspace and import it into a fresh standalone installation. ",
          h("a", { href: "/docs#portability" }, "How exports work"),
        ]),
      ]),
      h("div", { class: "hosting-grid" }, [
        h("article", { class: "hosting-option" }, [
          h("h3", "Hosted service"),
          h(
            "p",
            "The service operator runs the app, private storage, email, and backups. Create a workspace and connect Stripe when you’re ready to sell.",
          ),
          h("ul", [
            h(
              "li",
              "Starter includes licensing, private updates, buyer accounts, recovery, and sandbox testing.",
            ),
            h(
              "li",
              "Hosted Pro adds signed webhooks and advanced daily bandwidth reports.",
            ),
          ]),
          h(
            "p",
            { class: "hosting-cost" },
            "Platform subscription prices are shown at checkout. The dashboard shows the application fee rate for new customer subscriptions and their renewals. Stripe fees are separate.",
          ),
          h("div", { class: "hosting-actions" }, [
            h(
              "a",
              { href: applicationHref("/seller"), class: "button" },
              "Open seller dashboard",
            ),
            h(
              "a",
              { href: "/docs#hosted-tiers" },
              "Compare hosted capabilities →",
            ),
          ]),
        ]),
        h("article", { class: "hosting-option" }, [
          h("h3", "Self-hosted standalone"),
          h(
            "p",
            "Run Entitle for your own software business. You manage hosting, the database, private storage, email, and backups.",
          ),
          h("ul", [
            h(
              "li",
              "Includes signed webhooks and daily bandwidth reports.",
            ),
            h(
              "li",
              "One app serves the API and dashboard. The Docker Compose setup adds an HTTPS proxy, and Redis is optional.",
            ),
          ]),
          h(
            "p",
            { class: "hosting-cost" },
            "No platform subscription or application fee. You pay your infrastructure and payment providers directly.",
          ),
          h("div", { class: "hosting-actions" }, [
            h(
              "a",
              { href: "/docs#self-hosting", class: "button button-secondary" },
              "Read the deployment guide",
            ),
            h(
              "a",
              { href: "/docs#licensing" },
              "View source and publisher license →",
            ),
          ]),
        ]),
      ]),
    ],
  ),
  h(
    "section",
    {
      id: "questions",
      class: "home-section home-questions",
      "aria-labelledby": "questions-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h(
          "h2",
          { id: "questions-title" },
          "Common questions",
        ),
      ]),
      ...[
        [
          "Can I run a pilot before setting up Stripe?",
          "Yes. Create a product without a paid plan, publish its release, and issue a complimentary license with an installation allowance and expiration. The customer receives a normal key by email and uses the same activation and update flow. No payment or subscription is created, and workspace limits still apply. Add monthly or annual plans to the same product when you’re ready to sell.",
          "/docs#complimentary-licenses",
          "Set up an invited pilot",
        ],
        [
          "Can I keep my own website and checkout design?",
          "Use Stripe-hosted Checkout or style an embedded Stripe payment form. To embed it on a separate site, follow the integration guide for checkout and customer sessions. Entitle verifies prices and payment before issuing paid access.",
          "/docs#checkout",
          "Explore checkout integration",
        ],
        [
          "What happens when a customer stops renewing?",
          "Canceling renewal keeps download access through the paid period. A full refund, dispute, or revocation can affect access sooner. Installed software keeps working after expiration.",
          "/docs#billing",
          "Understand billing and access",
        ],
        [
          "Can I use this beyond WordPress?",
          "Yes. Choose adapters for Joomla, Electron, Tauri, Sparkle, and JetBrains, or integrate a generic client through the API. WordPress has its own site activation and update flow.",
          "/docs#framework-support",
          "Find your framework",
        ],
        [
          "How do customers recover a key or move a site?",
          "Their customer page offers email sign-in, license replacement, installation deactivation, downloads, and billing management. Publishers can check access and payment state, and deactivate an installation for a customer, without asking for secret keys.",
          "/docs#customer-accounts",
          "Read the buyer support guide",
        ],
      ].map(([question, answer, href, label]) =>
        h("details", { class: "home-question" }, [
          h("summary", [
            publicIcon(icons.chevron, "ui-icon disclosure-chevron"),
            question,
          ]),
          h("p", answer),
          h("a", { href }, label),
        ]),
      ),
    ],
  ),
  h("section", { class: "home-cta", "aria-labelledby": "start-title" }, [
    h("div", [
      h("h2", { id: "start-title" }, "Publish your first product"),
    ]),
    h("div", { class: "home-cta-actions" }, [
      h(
        "a",
        { href: applicationHref("/seller"), class: "button" },
        "Create your workspace",
      ),
      h("a", { href: "/docs#getting-started", class: "home-secondary" }, [
        "Read the setup guide",
        publicIcon(icons.arrow),
      ]),
      h("a", { href: "/docs#licensing", class: "home-secondary" }, [
        "Public source and license terms",
        publicIcon(icons.arrow),
      ]),
    ]),
  ]),
];

export function mountPublicSite(target: string | Element = "#app") {
  const docs = /^\/docs\/?$/.test(window.location.pathname);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h("div", { class: docs ? "app docs-page" : "app home-page" }, [
            h("a", { href: "#main", class: "skip-link" }, "Skip to content"),
            header(docs),
            h(
              "main",
              { id: "main", class: "page-main" },
              docs ? publicDocs(null, "", undefined, true) : publicHome(),
            ),
            h("footer", { class: "site-footer" }, [
              h("span", site.name),
              h("nav", { class: "site-footer-links", "aria-label": "Footer" }, [
                h("a", { href: "/docs" }, "Documentation"),
                h("a", { href: "/docs#troubleshooting" }, "Support guide"),
                h("a", { href: "/docs#licensing" }, "Source & licenses"),
              ]),
            ]),
          ]);
      },
    }),
  );
  app.mount(target);
  return app;
}
