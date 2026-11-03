# Documentation

Start with the task you need to complete. These guides describe the current
application; pinned versions and validation rules live in source and configuration.
The public `/docs` guide is available without an account on a running deployment.

## Publish and sell

- [Getting started](getting-started.md): choose hosted, self-hosted or local
  development, then complete a purchase, activation and update.
- [Seller guide](seller-guide.md): products, plans, releases, buyer support,
  account security, sandboxes and tax collection.
- [Hosted tiers and fees](hosted-pricing.md): service charges, Pro capabilities,
  renewals, refunds and the separation from buyer licenses.

## Integrate software

- [Client integration](client-integration.md): installation identity, activation,
  status, update discovery, verified downloads and failure handling.
- [Framework support](platform-support.md): supported adapters and exact package
  requirements, with links to examples.
- [WordPress](wordpress.md): plugin setup, update hooks and local qualification.
- [API](api.md), [CLI](cli.md), [MCP](mcp.md) and [outgoing webhooks](webhooks.md): protocol and
  automation reference.

## Operate a deployment

- [Deployment](deployment.md) and [configuration](configuration.md): production
  setup, Stripe endpoints, private storage, capacity and optional Redis.
- [Backup and restore](backup.md): consistent database, artifact and secret recovery.
- [Portability](portability.md): encrypted workspace transfer and cutover.
- [Operator maintenance](operator-maintenance.md): offline import/finalize and
  reviewed customer-closure procedures.
- [Troubleshooting](troubleshooting.md): diagnose access, billing, publication,
  updates, email and infrastructure failures.

## Develop and maintain

- [Architecture](architecture.md): components, authority and data flow.
- [Development](development.md): toolchain, setup, build and repository layout.
- [Testing](testing.md): coverage, integration fixtures, fuzzing and release checks.
- [Branding](branding.md): shared name, links and presentation conventions.
- [Licensing](licensing.md) and [contributing](../.github/CONTRIBUTING.md): applicable
  terms and contribution paths.

## Vocabulary

| Term | Meaning |
| --- | --- |
| Workspace / tenant | An isolated publisher catalog, customers and releases. Public URLs use its immutable slug. |
| Product | An application or extension with a fixed framework identity. |
| Plan | An annual Stripe price mapped to an installation allowance. |
| License | A customer's product, paid or complimentary entitlement, allowance and access restrictions. |
| Installation | A registered site or device with a scoped activation token. |
| Release / asset | An immutable version and its package bytes; a native release can contain several targets. |
| Entitlement | Whether paid rights or complimentary expiry and current restrictions permit access. |
| Platform subscription | A hosted seller's service subscription, separate from buyer licenses. |

Use your deployment origin in examples. `primary` is the default standalone
workspace slug; an import can preserve another slug. Internal tenant IDs are
not public slugs.
