# Documentation

Use your deployment's origin in the examples. The public `/docs` guide on a
running deployment is available without an account.

## Publish and sell

- [Getting started](getting-started.md) walks through setup, your first
  product, licensing an installation, and delivering an update.
- [Seller guide](seller-guide.md) covers products, plans, releases, buyer
  support, sandbox testing, and tax collection.
- [Hosted tiers and fees](hosted-pricing.md) explains service charges, Pro
  capabilities, renewals, and refunds.

## Integrate software

- [Client integration](client-integration.md) covers installation identity,
  activation, update feeds, verified downloads, and failure handling.
- [Framework adapters](platform-support.md) lists package and metadata
  requirements and links to example clients.
- [WordPress](wordpress.md) explains plugin setup, update hooks, and local testing.
- [API](api.md), [CLI](cli.md), [MCP](mcp.md), and [outgoing webhooks](webhooks.md)
  document the automation interfaces.

## Operate a deployment

- [Deployment](deployment.md) and [configuration](configuration.md) cover setup,
  Stripe, private storage, capacity, and optional Redis.
- [Backup and restore](backup.md) covers database, artifact, and secret recovery.
- [Portability](portability.md) explains how to export and move a workspace.
- [Operator maintenance](operator-maintenance.md) documents offline import,
  billing reconciliation, and customer account closure.
- [Troubleshooting](troubleshooting.md) covers access, billing, publication,
  updates, email, and infrastructure failures.

## Develop and maintain

- [Architecture](architecture.md) maps the components, tenant boundaries, and data flow.
- [Development](development.md) covers the toolchain, setup, build, and repository layout.
- [Testing](testing.md) lists checks, fixtures, and release verification steps.
- [Branding](branding.md) lists naming and presentation conventions.
- [Licensing](licensing.md) and [contributing](../.github/CONTRIBUTING.md) explain
  the applicable terms and contribution paths.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Workspace / tenant | An isolated publisher catalog with its own customers and releases. Public URLs use the workspace slug. |
| Product | An app or extension whose framework identity locks after its first license or release. |
| Plan | A monthly or annual recurring Stripe price mapped to an installation allowance. |
| License | Paid or complimentary access to a product for one customer, with an installation allowance and any access restrictions. |
| Installation | A registered site or device with a scoped activation token. |
| Release / asset | A release is a published version with immutable packages. A native release can have an asset for each target. |
| Entitlement | Whether a license's paid period or complimentary term and access restrictions allow an action. |
| Platform subscription | A hosted publisher's subscription to Entitle. Buyers purchase product licenses separately. |

The default standalone workspace slug is `primary`. An imported workspace can
retain a different slug. Use the public slug in URLs.

## CI identity publishing

Use [OIDC publishing](oidc-publishing.md) to configure trusted GitHub Actions,
GitLab, and other CI identities. The [authentication policy](authentication-policy.md)
covers which keys can approve trusted publishers and how to recover account access.
