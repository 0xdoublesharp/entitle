# Doublesharp Entitle

Software licensing, subscriptions, and private updates for independent publishers.
Use **Entitle** for short. One TypeScript deployment serves the API, seller
dashboard, customer portal, and background jobs.

With Entitle you can:

- Ship private updates for WordPress, Joomla, Electron, Tauri, Sparkle, JetBrains,
  and generic clients. WordPress has first-class support.
- Start an invited pilot with complimentary licenses, expiration dates, and site
  or device allowances. No Stripe account is required.
- Sell monthly or annual subscriptions through your own Stripe account. The
  customer catalog shows each plan's price and billing interval.
- Automate with [MCP](docs/mcp.md), the [CLI](docs/cli.md), or
  [OIDC publishing from CI](docs/oidc-publishing.md).
- Once your verified Stripe merchant account is connected, export an encrypted
  copy of your workspace and [move to self-hosting](docs/portability.md).

Customers receive license keys by email, manage their installations, and download
entitled releases. Expiration stops new downloads and updates; installed software
keeps working.

Sign in with a passkey or FIDO2 security key, and choose whether email-link
sign-in stays available for your account. Sensitive publisher actions need a
fresh key approval under the server's
[privileged authentication policy](docs/authentication-policy.md).

## Choose how to run it

|                     | Hosted publisher                                                                | Self-hosted publisher                                                                             |
| ------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Setup               | Sign in at `/app/seller` and create a workspace; connect Stripe for paid sales | Start the two-container Compose stack with your database, private S3 storage, and SMTP; add Stripe for paid sales |
| Operations          | The service operator runs infrastructure and backups                            | You operate infrastructure, upgrades, and backups                                                 |
| Charges             | Operator-configured subscription and application fee, plus Stripe fees          | No Entitle platform subscription or application fee; provider costs apply                         |
| Paid buyer payments | Your Stripe account                                                             | Your Stripe account                                                                               |

The hosted origin is configured in [packages/shared/site.ts](packages/shared/site.ts).
Use the address your operator provides. See
[hosted tiers and fees](docs/hosted-pricing.md).

## Start here

1. Follow [Getting started](docs/getting-started.md) for hosted setup, a local
   fixture, or a self-hosted installation.
2. Create a product in the seller dashboard. Add a monthly or annual Stripe plan
   for paid sales, now or later.
3. Integrate a client and publish an immutable release.
4. Issue a [complimentary license](docs/seller-guide.md) for an invited pilot, or
   complete a purchase. Verify activation and a normal update before accepting customers.

Local development needs the Node and pnpm versions pinned in the repository, a
mail sink, and private S3. The optional source-built S3 fixture also needs its
exact Go version. Local billing fixtures need no payment credentials and make no
live charges. See [Development](docs/development.md) for tools and storage paths.

## Capabilities

- Complimentary licenses with explicit expiration, installation allowances, and
  emailed keys, usable in production before Stripe is configured.
- Monthly and annual plans, plan archiving, server-controlled Stripe Checkout and
  custom Stripe Elements forms, Billing reconciliation, and Customer Portal access.
- Tenant isolation, scoped automation keys, transactional seat limits, and
  expiring email-link sessions with CSRF protection.
- Private S3-compatible releases, package validation, checksums, withdrawal,
  compatibility metadata, and authenticated update feeds.
- Customer recovery, seller-side installation deactivation, account security,
  sandbox testing, tax settings, and encrypted publisher transfers.
- Operational metrics and durable jobs. Hosted Pro adds signed outgoing
  webhooks and advanced download reports.

SQLite is the default; PostgreSQL and MySQL use the same business services.
Redis caching is optional. For a self-hosted server,
[deploy/compose.standalone.yaml](deploy/compose.standalone.yaml) builds
[deploy/standalone.Dockerfile](deploy/standalone.Dockerfile) into one app
container behind a Caddy HTTPS proxy. The split layout uses the
[Dockerfile](Dockerfile) with [deploy/compose.yaml](deploy/compose.yaml). See
[Deployment](docs/deployment.md).

## Documentation

The [documentation index](docs/README.md) provides guides by task.

| Task                                        | Guide                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Manage products, customers, and releases    | [Seller guide](docs/seller-guide.md)                                                                            |
| Add licensing and updates to an application | [Client integration](docs/client-integration.md) and [framework support](docs/platform-support.md)              |
| Automate integrations                       | [API](docs/api.md), [CLI](docs/cli.md), [MCP](docs/mcp.md), and [webhooks](docs/webhooks.md)                   |
| Operate a server                            | [Deployment](docs/deployment.md), [configuration](docs/configuration.md), and [backup](docs/backup.md)          |
| Move a publisher or handle privacy requests | [Portability](docs/portability.md) and [operator maintenance](docs/operator-maintenance.md)                     |
| Develop or investigate a failure            | [Architecture](docs/architecture.md), [testing](docs/testing.md), and [troubleshooting](docs/troubleshooting.md) |

The application also serves a public `/docs` guide. Credentials come from
private environment configuration; never put seller API keys in distributed
clients or browser checkout forms.

The application and marketing site have independent frontend builds. The
standalone Compose stack builds the app into its image. The split layout uses
`pnpm build:server` and `pnpm build:web`; neither needs a marketing build. Hosted
publication uses `pnpm build:hosted-web` and mounts the app at `/app/`. The app
mount and marketing destination are configurable. See
[deployment](docs/deployment.md#independent-marketing-and-application-sites).

## License

The service and dashboard are source available under [Elastic License 2.0](LICENSE)
with the [Doublesharp Entitle Publisher Use Permission](ADDITIONAL-PERMISSION.md).
Client adapters use [MIT](examples/LICENSE); generated integration snippets also
have a [Zero-Clause BSD grant](examples/GENERATED-CODE-LICENSE). Read
[Licensing](docs/licensing.md) and [Contributing](.github/CONTRIBUTING.md) before
redistributing or contributing. Preserve [third-party notices](NOTICE).
