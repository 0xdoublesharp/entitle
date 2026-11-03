# Getting started

This walkthrough ends with a product in the catalog, a licensed installation,
and an update delivered through its normal updater. Choose hosted setup,
standalone production setup, or the local fixture first.

## Choose who operates the service

| Path                  | You provide                                                                           | Start here                                                            |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Hosted publisher      | Your seller email, product builds and client integration; Stripe for paid sales       | Sign in at `/app/seller` on the hosted deployment.                    |
| Self-hosted publisher | HTTPS server, database, private S3 bucket, SMTP and backups; Stripe for paid sales     | Follow [standalone deployment](deployment.md#self-hosted-standalone). |
| Local development     | Pinned Node/pnpm, Docker for the mail fixture, and Go 1.27.1 for the source-built S3 fixture | Use the local procedure below. No paid services are required.         |

Use the deployment origin supplied by your operator. The shared hosted link
in the source is not a service-availability commitment.

Hosted sellers create a workspace and choose its permanent slug. Complimentary
licensing needs no connected Stripe account; connect Stripe from Billing when
offering paid plans. Hosted capacity and service limits still apply. Standalone
owners set `STANDALONE_OWNER_EMAIL` and sign in with
that address. Verification grants access to the existing `primary` workspace.
Standalone needs no Connect onboarding or platform subscription.

Email links are single-use and bound to the browser that requested them. Open
the link in that browser. Seller and buyer sign-ins are separate.

## Run the local fixture

Use the versions pinned in [Development](development.md#toolchain). In this macOS workspace,
confirm `/Volumes/Scratch` is mounted before creating disposable output. Do not
substitute the internal Data volume if it is missing.

```sh
export TMPDIR=/Volumes/Scratch/entitle/tmp/setup
mkdir -p "$TMPDIR"
pnpm install --frozen-lockfile \
  --store-dir /Volumes/Scratch/entitle/cache/pnpm \
  --virtual-store-dir /Volumes/Scratch/entitle/cache/virtual-store
node scripts/setup-local.ts
node scripts/local-s3.ts up
docker compose -p entitle-saas-test -f deploy/compose.test.yaml up -d mail
pnpm build
node --env-file=.env \
  --env-file=/Volumes/Scratch/entitle/data/local-s3/integration.env \
  src/server.ts
```

`setup-local.ts` creates a private `.env` and refuses to overwrite one. Reuse an
existing configuration rather than regenerating its secrets. The default owner
for this fixture is `owner@example.test`. The S3 helper uses the pinned source
fixture and requires exactly Go 1.27.1; `GO_BINARY` selects that executable.
Inspect or stop only its owned process with `node scripts/local-s3.ts status` or `stop`.

Open `http://localhost:3211/seller`, request a link for the configured owner,
then read the email in Mailpit at `http://localhost:8025`. The default buyer page
is `http://localhost:3211/t/primary`. The public guide is `/docs`.

This fixture uses `LOCAL_BILLING=true`, which blocks real Stripe Checkout and
Portal calls. Its purchase helper creates canonical test entitlement and queues
license email. It does not collect money. For a host without Scratch or with an existing private S3 service, use the
manual procedure below.

## Manual setup

1. Install the pinned Node/pnpm versions and copy `.env.example` to a private
   `.env`. Generate independent `APP_SECRET` and `OPERATOR_TOKEN` values; do not
   copy development placeholders into a deployed service.
2. Set `DEPLOYMENT_MODE=standalone`, `STANDALONE_OWNER_EMAIL`, `PUBLIC_ORIGIN`,
   `DATABASE_URL`, private `DATA_DIR` / `WORK_DIR`, and `BUILD_DIR` / `WEB_DIR`.
   Choose persistent paths for data and disposable paths for builds and caches.
3. Configure a private S3-compatible bucket and its access settings, plus SMTP
   or the local mail sink. Use `LOCAL_BILLING=true` only for disposable development.
   For a production complimentary pilot, use `LOCAL_BILLING=false` and omit all
   primary Stripe, Connect and platform price values. Keep the normal production
   HTTPS, secret, owner, private-storage, mail and trusted-proxy settings. Enabling
   paid billing later requires the complete mode-specific Stripe configuration.
4. Install with the frozen pnpm lockfile, run `pnpm build`, and start with
   `node --env-file=.env src/server.ts`. Skip `setup-local.ts`, `local-s3.ts`
   and their generated `integration.env` when using this procedure.

See [configuration](configuration.md) for the full environment reference and
[deployment](deployment.md) for HTTPS, production credentials and Compose. This
alternative does not need Go. Existing `.env` secrets and provider data should
be reused deliberately, not regenerated by a setup helper.

## Create a product

1. In Products, choose the framework your build actually uses. WordPress needs
   the exact `directory/main-file.php` plugin basename. Joomla and JetBrains
   need their extension/plugin identity. Generic defaults to device activation.
2. For a complimentary pilot, leave **Include annual paid plan** unchecked. No
   price or payment provider is needed. For paid sales, create an active annual
   recurring price in the correct merchant account and Stripe mode.
3. If adding a paid plan, select that price and its site/device allowance. The same API field,
   `siteAllowance`, counts seats for either activation type.
4. Save and check `/api/v1/tenants/YOUR_SLUG/catalog`. Confirm the product slug,
   framework and any paid plan IDs before adding checkout to another website.

Framework configuration locks after the first license or release. Price-to-product
and allowance mappings also persist. Add a new Stripe price when changing an
allowance. See [seller guide](seller-guide.md#products-and-plans).

## Publish version 1.0.0

Use Releases in the dashboard. Browser publication requires a fresh emailed
confirmation for that action. CI uses a scoped automation key instead.

For WordPress, publish a ZIP whose main plugin header and directory match the
product and version. For other frameworks, upload a package for an exact target
and include the metadata required by its adapter. Tauri and Sparkle signatures
come from your build system. Inspect [framework requirements](platform-support.md)
before packaging.

Publication validates the package, writes private immutable bytes, verifies
storage readback, then commits the release. A release offer never points at an
unfinished upload. The server reports separate WordPress and native upload caps
under `/docs#server-limits`.

## Issue a complimentary pilot license

Open **Licenses → Issue complimentary license**. Enter the customer email,
product, installation allowance and a future expiration date and time, plus an
optional internal note. The form uses your browser's local time zone. Review
the confirmation before issuing.

Entitle creates or reuses the customer within this workspace and queues a normal
license-key email. Retry an uncertain submission with unchanged form values to
reuse its request ID and avoid another license or email job. The success notice
confirms queuing, not SMTP delivery. The internal note stays private to the seller.

Complimentary licenses are labelled in seller and customer views and create no
invoice, subscription or revenue. They never automatically charge or enroll a
pilot customer, including after Stripe is enabled. Revocation/restoration and
customer key replacement use the normal controls. Restoration does not extend
expiration. Expiration stops new activations, downloads and updates while
installed plugin features continue working.

Follow [activation](#activate-the-client) below using the emailed key. The existing
WordPress client needs no changes. See the [seller guide](seller-guide.md#issue-a-complimentary-license)
for the workflow and [API contract](api.md#complimentary-issuance) for automation.

## Purchase a paid license

For real test-mode commerce, use the merchant's test prices, matching keys and
signed webhook endpoint from [deployment](deployment.md). A checkout redirect
does not create paid rights; wait for canonical payment reconciliation.

In the local fixture, create an API key in the seller dashboard with
`licenses:write`. Set `TENANT_SLUG=primary` and supply `TENANT_API_KEY` privately
through your environment or secret manager, then run:

```sh
pnpm cli demo-purchase PLAN_ID_FROM_CATALOG buyer@example.test
```

Read the license-key email in Mailpit when using the local fixture.

## Activate the client

In your client, enter the emailed complimentary or paid key and
activate one persisted installation ID. Site products also send `siteUrl`.
Store the returned activation token in protected client storage. The raw
license key is for activation; the installation token authenticates update
checks and downloads. See [client integration](client-integration.md).

For routine publisher testing on an existing deployment, use an isolated
[sandbox](seller-guide.md#test-in-a-sandbox). Do not enable local billing on a
production service.

## Deliver an update

Publish version 1.1.0 with changed bytes and the same framework identity. Run the
client's normal update flow. Check the following before shipping your adapter:

- Its feed selects the intended product and exact native target.
- The downloaded package matches the offered checksum and required signature.
- Installation preserves the installation ID and activation token.
- An activation retry returns the existing token without consuming another seat.
- Deactivation frees a seat; replacing a license key invalidates existing tokens.
- An unavailable licensing server leaves installed functionality usable.

Server tests and example compilation do not qualify native installation on every
OS. Follow the [release checks](testing.md#release-checks) for the actual
framework, provider and deployment you intend to ship.

Next, read the [seller guide](seller-guide.md), automate publication with the
[CLI](cli.md), or use the [API reference](api.md).
