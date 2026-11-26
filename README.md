# Doublesharp Entitle

Entitle gives independent software publishers a seller dashboard, customer
portal, and API for licensing software, selling subscriptions, and shipping
private updates. Publish updates for WordPress, Joomla, Electron, Tauri, Sparkle,
JetBrains, or a [generic client](docs/platform-support.md).

Start with [complimentary licenses](docs/seller-guide.md#issue-a-complimentary-license)
that set an expiration date and an installation allowance. To sell, add monthly
or annual plans through your own Stripe account. Customers receive their keys by
email and can manage their installations in the portal. Expiration stops new
activations, downloads, and updates while installed software keeps working.

## Choose how to run it

| | Hosted | Self-hosted standalone |
| --- | --- | --- |
| Start | Sign in at `/app/seller` on your operator's service and create a workspace. | Run the [two-container Compose stack](deploy/compose.standalone.yaml) and sign in at `/seller`. |
| Operations | The operator runs the infrastructure and backups. | You run HTTPS, a database, private S3-compatible storage, SMTP, upgrades, and backups. |
| Charges | Check the operator's subscription price and application fee. Stripe fees are separate. | You pay your infrastructure and payment providers. Entitle charges no platform subscription or application fee. |
| Paid sales | Connect your Stripe account from Billing. | Configure your Stripe credentials on the server. |

See [hosted tiers and fees](docs/hosted-pricing.md) or [deployment](docs/deployment.md)
for setup and operating requirements. After connecting and verifying your Stripe
merchant account, you can [export an encrypted workspace and move to standalone](docs/portability.md).

## Start here

1. Set up [hosted, self-hosted, or local Entitle](docs/getting-started.md).
2. Create a product and [integrate its client](docs/client-integration.md).
3. [Publish a release](docs/seller-guide.md#publish-a-release), then issue a
   complimentary license or complete a paid purchase.
4. Activate an installation with the emailed key. Publish a newer version and
   verify it installs through your client's normal updater.

The [local fixture](docs/getting-started.md#run-the-local-fixture) uses pinned
Node and pnpm, a mail sink, and private S3-compatible storage. The optional
source-built storage fixture also requires the pinned Go version. Local billing
uses synthetic purchases and makes no Stripe charges.

## Documentation

| Task | Guide |
| --- | --- |
| Manage products, licenses, releases, and customer support | [Seller guide](docs/seller-guide.md) |
| Add activation and verified updates to your app | [Client integration](docs/client-integration.md) and [framework adapters](docs/platform-support.md) |
| Automate publishing and operations | [API](docs/api.md), [CLI](docs/cli.md), [MCP](docs/mcp.md), [OIDC publishing](docs/oidc-publishing.md), and [webhooks](docs/webhooks.md) |
| Configure, back up, and troubleshoot a server | [Deployment](docs/deployment.md), [configuration](docs/configuration.md), [backup](docs/backup.md), and [troubleshooting](docs/troubleshooting.md) |
| Move a workspace or handle privacy requests | [Portability](docs/portability.md) and [operator maintenance](docs/operator-maintenance.md) |
| Develop or verify a change | [Development](docs/development.md), [architecture](docs/architecture.md), and [testing](docs/testing.md) |

See the [full documentation index](docs/README.md) or open the public guide at
`/docs` on a running deployment. The
[authentication policy](docs/authentication-policy.md) explains sign-in options
and which passkeys or hardware keys can approve sensitive actions. Keep seller
API keys in private automation environments.

## License

The service and dashboard are source available under [Elastic License 2.0](LICENSE)
with the [Doublesharp Entitle Publisher Use Permission](ADDITIONAL-PERMISSION.md).
Client adapters use [MIT](examples/LICENSE). Generated integration snippets also
have a [Zero-Clause BSD grant](examples/GENERATED-CODE-LICENSE). Read
[Licensing](docs/licensing.md) and [Contributing](.github/CONTRIBUTING.md) before
redistributing or contributing. Preserve [third-party notices](NOTICE).
