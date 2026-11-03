# Doublesharp Entitle

Software licensing, subscriptions and private updates for independent publishers.
Use **Entitle** for short. The application serves the API, seller dashboard,
customer portal and background jobs from one TypeScript deployment.

Start an invited pilot with complimentary licenses, expiration dates and site or
device allowances. Add annual Stripe plans when you are ready to sell. Customers
receive license keys by email, manage installations and download entitled
releases. WordPress has first-class support alongside Joomla, Electron, Tauri,
Sparkle, JetBrains and generic clients. Expiration limits new downloads and
updates; installed software keeps working.

## Choose how to run it

|                | Hosted publisher                                                       | Self-hosted publisher                                                               |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Setup          | Sign in at `/app/seller` and create a workspace; connect Stripe for paid sales | Run the application with your database, private S3 storage and SMTP; add Stripe for paid sales |
| Operations     | The service operator runs infrastructure and backups                   | You operate infrastructure, upgrades and backups                                    |
| Charges        | Operator-configured subscription and application fee, plus Stripe fees | No Entitle platform subscription or application fee; provider costs apply           |
| Paid buyer payments | Your Stripe account                                                    | Your Stripe account                                                                 |

The hosted origin is configured in [src/site.ts](src/site.ts). Use the address
provided by your operator; the repository itself is not a service availability
or pricing commitment. See [hosted tiers and fees](docs/hosted-pricing.md).

## Start here

1. Follow [Getting started](docs/getting-started.md) for hosted setup, a local
   fixture or a self-hosted installation.
2. Create a product in the seller dashboard; add an annual Stripe plan for paid sales.
3. Integrate a client and publish an immutable release.
4. Issue a [complimentary license](docs/seller-guide.md) for an invited pilot, or
   complete a purchase. Verify activation and a normal update before accepting customers.

Local development needs the Node/pnpm versions pinned in the repository, a mail
sink and private S3. The optional source-built S3 fixture also needs its exact
Go version. Local billing fixtures require no payment credentials or live charges.
See [Development](docs/development.md) for tools and storage paths.

## Capabilities

- Complimentary licenses with explicit expiration, installation allowances and
  emailed keys, usable in production before Stripe is configured.
- Server-controlled Stripe Checkout and custom Stripe Elements forms, Billing
  reconciliation and Customer Portal access.
- Tenant isolation, scoped automation keys, transactional seat limits and
  expiring email-link sessions with CSRF protection.
- Private S3-compatible releases, package validation, checksums, withdrawal,
  compatibility metadata and authenticated update feeds.
- Customer recovery, account security, sandbox testing, tax settings and
  encrypted publisher transfers.
- Operational metrics and durable jobs. Hosted Pro adds signed outgoing
  webhooks and advanced download reports.

SQLite is the default; PostgreSQL and MySQL use the same business services.
Redis caching is optional. Production uses the [Dockerfile](Dockerfile) with
[deployment configuration](deploy/compose.yaml) behind HTTPS.

## Documentation

The [documentation index](docs/README.md) provides guides by task.

| Task                                        | Guide                                                                                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Manage products, customers and releases     | [Seller guide](docs/seller-guide.md)                                                                            |
| Add licensing and updates to an application | [Client integration](docs/client-integration.md) and [framework support](docs/platform-support.md)              |
| Automate integrations                       | [API](docs/api.md), [CLI](docs/cli.md), [MCP](docs/mcp.md) and [webhooks](docs/webhooks.md)                    |
| Operate a server                            | [Deployment](docs/deployment.md), [configuration](docs/configuration.md) and [backup](docs/backup.md)           |
| Move a publisher or handle privacy requests | [Portability](docs/portability.md) and [operator maintenance](docs/operator-maintenance.md)                     |
| Develop or investigate a failure            | [Architecture](docs/architecture.md), [testing](docs/testing.md) and [troubleshooting](docs/troubleshooting.md) |

The application also serves a public `/docs` guide. Credentials come from
private environment configuration; never put seller API keys in distributed
clients or browser checkout forms.

The application and marketing site have independent frontend builds. Self-hosters
use `pnpm build:server` and `pnpm build:web`; no marketing build is required. Hosted
publication uses `pnpm build:hosted-web` and mounts the app at `/app/`. The app mount
and marketing destination are configurable. See [deployment](docs/deployment.md#independent-marketing-and-application-sites).

## License

The service and dashboard are source available under [Elastic License 2.0](LICENSE)
with the [Doublesharp Entitle Publisher Use Permission](ADDITIONAL-PERMISSION.md).
Client adapters use [MIT](examples/LICENSE); generated integration snippets also
have a [Zero-Clause BSD grant](examples/GENERATED-CODE-LICENSE). Read
[Licensing](docs/licensing.md) and [Contributing](.github/CONTRIBUTING.md) before
redistributing or contributing. Preserve [third-party notices](NOTICE).
