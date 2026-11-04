import { createApp, defineComponent, h } from "vue";
import { site } from "../packages/shared/site.ts";
import { publicDocs } from "./docs.ts";
import { applicationHref } from "./navigation.ts";

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
// Public illustrations are native SVG/HTML, never fetched customer records.
const publicIcon = (path: string) =>
  h(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    [h("path", { d: path })],
  );
const icons = {
  key: "M14 5a5 5 0 1 1-2 8L5 20H2v-3l7-7a5 5 0 0 1 5-5Z M16 7h.01",
  box: "m3 7 9-5 9 5v10l-9 5-9-5Z m0 0 9 5 9-5 M12 12v10 M7.5 4.5l9 5",
  card: "M3 4h18v16H3Z M3 9h18 M7 15h4",
  invite:
    "M15 20a6 6 0 0 0-12 0 M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M19 8v6 M16 11h6",
  chart: "M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4",
  layers: "m2 7 10-5 10 5-10 5Z M2 12l10 5 10-5 M2 17l10 5 10-5",
  code: "m8 5-6 7 6 7 m8-14 6 7-6 7 M14 3l-4 18",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
  check: "m5 12 4 4 10-10",
};
const publicHome = () => [
  h("section", { class: "saas-hero", "aria-labelledby": "home-title" }, [
    h("div", { class: "hero-copy" }, [
      h("p", { class: "eyebrow" }, "Software licensing and updates"),
      h("h1", { id: "home-title" }, [
        "Your software. ",
        h("span", "Ready to sell."),
      ]),
      h(
        "p",
        { class: "intro" },
        "Use your AI agent through MCP to set up a plugin, publish updates and track sales stats. Start with complimentary pilot licenses, then connect Stripe when you’re ready to sell.",
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
        "Start an invited pilot before configuring Stripe.",
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
              h("span", { class: "workflow-overline" }, "01 / ACCESS"),
              h("strong", "Invite a pilot or sell"),
              h("span", "No charge for pilots. Checkout\u00a0for\u00a0buyers."),
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
              h("span", { class: "workflow-overline" }, "02 / LICENSE"),
              h("strong", "License key, delivered"),
              h("span", "Complimentary or paid, with site or device seats"),
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
              h("span", { class: "workflow-overline" }, "03 / UPDATE"),
              h("strong", "Your next release arrives"),
              h("span", "Private package. Entitlement checked."),
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
      h("p", "For the software you ship"),
      h(
        "ul",
        [
          "WordPress",
          "Joomla",
          "Electron",
          "Tauri",
          "Sparkle",
          "JetBrains",
          "Generic",
        ].map((name) =>
          h("li", [
            h(
              "span",
              { class: "framework-glyph", "aria-hidden": "true" },
              name.slice(0, 1),
            ),
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
        h("p", { class: "eyebrow" }, "Works with your AI agent"),
        h(
          "h2",
          { id: "agents-title" },
          "From plugin setup to your next sales check.",
        ),
        h(
          "p",
          "Connect an MCP-compatible AI agent to Entitle. Set up products, publish private releases and check your workspace’s stats from the conversation where you already build.",
        ),
      ]),
      h("div", { class: "home-feature-grid home-agent-grid" }, [
        h("article", { class: "home-feature" }, [
          h("span", { class: "feature-icon" }, publicIcon(icons.code)),
          h("h3", "Set up your plugin for sale"),
          h(
            "p",
            "Have your agent create a product, map an existing annual Stripe price to a paid plan and publish your release. Or start with a complimentary pilot.",
          ),
          h(
            "p",
            { class: "agent-example" },
            "“Set up my WordPress plugin with this annual price and publish version 1.0.0 from my build.”",
          ),
        ]),
        h("article", { class: "home-feature" }, [
          h("span", { class: "feature-icon" }, publicIcon(icons.chart)),
          h("h3", "Ask how your business is doing"),
          h(
            "p",
            "Ask for a workspace overview of licenses, seats, downloads, storage and payments by currency. Daily download and bandwidth reports are available with Hosted Pro or self-hosting.",
          ),
          h(
            "p",
            { class: "agent-example" },
            "“Summarize my workspace’s licenses, downloads and payments, with each currency shown separately.”",
          ),
        ]),
      ]),
      h("div", { class: "button-row" }, [
        h(
          "a",
          { href: "/docs#mcp", class: "button-secondary" },
          "Connect your AI agent",
        ),
        h("a", { href: "/docs#dashboard-reports" }, "Explore the stats →"),
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
        h("p", { class: "eyebrow" }, "Less admin. More building."),
        h("h2", { id: "journey-title" }, "One connected customer journey."),
        h(
          "p",
          "From an invited pilot or a first purchase to the next release, give your customers a clear path forward.",
        ),
      ]),
      h(
        "ol",
        { class: "journey-grid" },
        [
          [
            "01",
            "Start with your product",
            "Publish a private release and issue complimentary licenses to invited customers. No Stripe account, price or payment is required.",
          ],
          [
            "02",
            "Add payments when you’re ready",
            "Connect Stripe for hosted checkout or an embedded payment form. Confirmed payments create separate paid licenses; pilot customers are never enrolled automatically.",
          ],
          [
            "03",
            "Keep good software moving",
            "Publish private releases. Customers get eligible updates and manage their keys, downloads and installations.",
          ],
        ].map(([number, title, copy]) =>
          h("li", [
            h(
              "span",
              { class: "journey-number", "aria-hidden": "true" },
              number,
            ),
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
        h("p", { class: "eyebrow" }, "The tools behind your business"),
        h(
          "h2",
          { id: "features-title" },
          "A lot to manage. One place to do it.",
        ),
        h(
          "p",
          "Keep the connection between payments, people and software without stitching together a storefront and a licensing server.",
        ),
      ]),
      h(
        "div",
        { class: "home-feature-grid" },
        [
          [
            icons.key,
            "Paid and complimentary licenses",
            "Set expiration dates and site or device allowances for invited pilots. Paid plans add annual renewals, refunds and dispute handling. Installed software stays available after expiry.",
          ],
          [
            icons.box,
            "Private releases, ready to ship",
            "Immutable packages, checksums and framework metadata. Each download checks current entitlement before the bytes leave private storage.",
          ],
          [
            icons.card,
            "Your customers, your payments",
            "Connect your own Stripe account when you’re ready for buyer checkout and billing. Complimentary issuance needs no payment provider. Hosted platform charges are separate.",
          ],
          [
            icons.chart,
            "See what is happening",
            "See licenses, seats, storage and served downloads. Complimentary licenses are separate from payment revenue. Track payments by currency and review daily bandwidth with Hosted Pro.",
          ],
          [
            icons.layers,
            "Room for your next product",
            "Manage different plugins, apps, plans and purchase flows. Isolated workspaces keep each seller's customers and releases separate.",
          ],
          [
            icons.code,
            "Your AI agent, dashboard or build pipeline",
            "Use MCP tools to configure products, publish releases and read stats with your AI agent. The dashboard, API and scoped CI keys keep the same workflows within reach.",
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
        h("p", { class: "eyebrow" }, "Built to feel at home"),
        h("h2", { id: "wordpress-title" }, "First-class WordPress support"),
        h(
          "p",
          "Sell your Pro plugin with the update experience your customers already know. Site activations, compatibility checks and authenticated packages work with the normal WordPress update screen. Your free plugin can stay on WordPress.org.",
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
            h("span", "Same familiar update experience."),
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
        h("p", { class: "eyebrow" }, "Built around trust"),
        h(
          "h2",
          { id: "confidence-title" },
          "Protect access. Respect your customers.",
        ),
        h(
          "p",
          "License expiration stops new activations, downloads and updates. It never remotely disables installed functionality. Paid and complimentary customers keep using the software they already installed, including during server outages.",
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
          h("p", { class: "eyebrow" }, "Explore Entitle"),
          h("h2", { id: "explore-title" }, "Find your next step."),
        ]),
        h(
          "ul",
          { class: "home-resource-links" },
          [
            {
              href: applicationHref("/seller"),
              title: "Open your seller dashboard",
              copy: "Manage products, licenses and private releases.",
            },
            {
              href: "/docs#customer-accounts",
              title: "Explore customer accounts",
              copy: "See how buyers manage keys, downloads and installations.",
            },
            {
              href: "/docs#getting-started",
              title: "Read the setup guide",
              copy: "Connect your first product and publish an update.",
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
      h("img", {
        class: "home-resource-art",
        src: "/social/docs.png",
        alt: "",
        width: 1200,
        height: 630,
        loading: "lazy",
        decoding: "async",
      }),
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
        h("p", { class: "eyebrow" }, "Choose who runs it"),
        h("h2", { id: "hosting-title" }, "Your business. Your way to run it."),
        h(
          "p",
          "Use the same licensing engine and framework adapters with hosted publishing or your own standalone installation.",
        ),
      ]),
      h("div", { class: "hosting-grid" }, [
        h("article", { class: "hosting-option" }, [
          h("p", { class: "eyebrow" }, "Focus on your products"),
          h("h3", "Hosted service"),
          h(
            "p",
            "Create a publisher workspace for your products and invited pilots. Connect payments when you’re ready to sell. The service operator runs the app, private storage and backups.",
          ),
          h("ul", [
            h(
              "li",
              "Starter includes licensing, private updates, buyer accounts, recovery and sandbox testing.",
            ),
            h(
              "li",
              "Hosted Pro adds signed webhooks and advanced daily bandwidth reports.",
            ),
          ]),
          h(
            "p",
            { class: "hosting-cost" },
            "Platform subscription and configured application fee, plus separate payment processing fees. Subscription amounts are shown at checkout; the dashboard shows the fee rate.",
          ),
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
        h("article", { class: "hosting-option" }, [
          h("p", { class: "eyebrow" }, "Run your own infrastructure"),
          h("h3", "Self-hosted standalone"),
          h(
            "p",
            "Run Entitle for your own software business. Manage multiple products with your own billing, database and private storage.",
          ),
          h("ul", [
            h(
              "li",
              "All local capabilities, including signed events and advanced reports.",
            ),
            h("li", "One app serves the API and dashboard. Redis is optional."),
          ]),
          h(
            "p",
            { class: "hosting-cost" },
            "No platform subscription or application fee. You supply hosting, storage, email and backups, and pay your infrastructure and payment processing costs.",
          ),
          h(
            "a",
            { href: "/docs#self-hosting", class: "button-secondary" },
            "Read the deployment guide",
          ),
          h(
            "a",
            { href: "/docs#licensing" },
            "View source and publisher license →",
          ),
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
        h("p", { class: "eyebrow" }, "Before your first release"),
        h(
          "h2",
          { id: "questions-title" },
          "A few things you might be wondering.",
        ),
      ]),
      ...[
        [
          "Can I run a pilot before setting up Stripe?",
          "Yes. Create a product without a paid plan, publish its release and issue a complimentary license with an installation allowance and expiration. The customer receives a normal key by email and uses the same activation and updater flow. No payment or subscription is created; workspace limits still apply.",
          "/docs#complimentary-licenses",
          "Set up an invited pilot",
        ],
        [
          "Can I keep my own website and checkout design?",
          "Yes. Use hosted checkout or embed a payment form styled to fit your storefront. Entitle controls prices and paid access on the server.",
          "/docs#checkout",
          "Explore checkout integration",
        ],
        [
          "What happens when a customer stops renewing?",
          "They keep access to downloads through their paid period. Installed software keeps working after expiry and during licensing-server outages.",
          "/docs#billing",
          "Understand billing and access",
        ],
        [
          "Can I use this beyond WordPress?",
          "Yes. Choose adapters for Joomla, Electron, Tauri, Sparkle and JetBrains, or integrate a generic client through the API. WordPress has its own site activation and update flow.",
          "/docs#framework-support",
          "Find your framework",
        ],
        [
          "How do customers recover a key or move a site?",
          "Their workspace customer page provides email sign-in, license replacement, installation deactivation, downloads and billing management. Publishers can check access and payment state without asking for secret keys.",
          "/docs#customer-accounts",
          "Read the buyer support guide",
        ],
      ].map(([question, answer, href, label]) =>
        h("details", { class: "home-question" }, [
          h("summary", question),
          h("p", answer),
          h("a", { href }, label),
        ]),
      ),
    ],
  ),
  h("section", { class: "home-cta", "aria-labelledby": "start-title" }, [
    h("div", [
      h("p", { class: "eyebrow" }, "Your next release starts here"),
      h("h2", { id: "start-title" }, "Build the software. Grow the business."),
      h(
        "p",
        "Give your customers a better way to buy, activate and stay up to date.",
      ),
    ]),
    h("div", { class: "home-cta-actions" }, [
      h(
        "a",
        { href: applicationHref("/seller"), class: "button" },
        "Create your workspace",
      ),
      h("a", { href: "/docs#getting-started" }, "Read the setup guide →"),
      h("a", { href: "/docs#licensing" }, "Public source and license terms →"),
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
              h("a", { href: "/docs" }, "Documentation"),
              h("a", { href: "/docs#troubleshooting" }, "Support guide"),
              h("a", { href: "/docs#licensing" }, "Source & licenses"),
            ]),
          ]);
      },
    }),
  );
  app.mount(target);
  return app;
}
