# Getting started

Set up Entitle, publish a release, and license an installation. Then publish a
newer version and install it through your client's normal updater.

## Choose who operates the service

| Path                  | You provide                                                                           | Start here                                                            |
| --------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Hosted publisher      | Your seller email, product builds, and client integration. Connect Stripe for paid sales. | Sign in at `/app/seller` on the hosted deployment.                    |
| Self-hosted publisher | HTTPS server with Docker, private S3 bucket, SMTP, and backups; Stripe for paid sales  | Start the [two-container stack](#self-host-with-docker-compose) below. |
| Local development     | Pinned Node and pnpm, Docker for the mail fixture, and Go 1.27.1 for the source-built S3 fixture | [Run the local fixture](#run-the-local-fixture). No paid services are required. |

Use the deployment origin supplied by your operator.

On the hosted service, create a **publisher workspace** for your business or
brand and choose its permanent slug. On standalone, sign in with
`STANDALONE_OWNER_EMAIL` to access the existing `primary` workspace after
verification. Add each plugin or app as a **product**. Products share the
workspace's billing, access, API keys, and storage, and each has its own plans,
licenses, and releases.

You can issue complimentary licenses before configuring Stripe. Workspace
capacity limits still apply. For paid sales, connect Stripe from Billing on a
hosted deployment or configure your merchant account on the standalone server.

Open a seller sign-in link in the browser that requested it. Buyers can open
their sign-in links in any browser. Each link works once and expires after
15 minutes.

## Self-host with Docker Compose

The [standalone Compose stack](../deploy/compose.standalone.yaml) runs the API
and dashboard in one container and Caddy in another. Caddy obtains HTTPS
certificates for `PUBLIC_ORIGIN`. The app image includes the frontend.

1. Point your domain's DNS at the host and open ports 80 and 443.
2. Copy `.env.example` to `.env`, protect it with mode 0600, and set
   `PUBLIC_ORIGIN`, independent `APP_SECRET` and `OPERATOR_TOKEN` values,
   `DEPLOYMENT_MODE=standalone`, `STANDALONE_OWNER_EMAIL`, private S3 storage,
   SMTP, and `ENTITLE_DATA_DIR`, an absolute persistent host directory. The
   copied file sets `PRIVILEGED_AUTH_POLICY=passkey`, which lets you approve API
   key changes and browser releases with your own passkey. Set it to `hardware`
   if your operator will inventory and approve hardware keys. See
   [configuration](configuration.md#deployment-and-identity).
3. Create the app's data directory, then start the stack. This example uses
   `ENTITLE_DATA_DIR=/srv/entitle`:

   ```sh
   sudo install -d -o 1000 -g 1000 /srv/entitle/app
   docker compose --env-file .env -f deploy/compose.standalone.yaml up -d --build
   ```

4. Open `PUBLIC_ORIGIN/seller` and sign in with `STANDALONE_OWNER_EMAIL`.

The app mounts only `${ENTITLE_DATA_DIR}/app`. Caddy keeps its certificate keys
in the sibling `caddy-data` and `caddy-config` directories. Create the `app`
directory before startup.
If you are upgrading an installation that mounted `ENTITLE_DATA_DIR` itself, move
its files into `app/` first, as described in
[operator maintenance](operator-maintenance.md#move-data-into-the-app-subdirectory).
See [deployment](deployment.md#self-hosted-standalone) for production settings,
Stripe, and the split web-runtime layout.

## Run the local fixture

Use the versions pinned in [Development](development.md#toolchain). The helper
scripts below write disposable output to the `/Volumes/Scratch` volume used by
this macOS workspace and stop if it is not mounted. On Linux, Windows, or a Mac
without that volume, use the [manual setup](#manual-setup) instead.

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
fixture and requires Go 1.27.1. To select that executable, set `GO_BINARY`. Check
or stop the fixture with `node scripts/local-s3.ts status` or `node scripts/local-s3.ts stop`.

Open `http://localhost:3211/seller`, request a link for the configured owner,
then read the email in Mailpit at `http://localhost:8025`. The default buyer page
is `http://localhost:3211/t/primary`. The public guide is `/docs`.

This fixture sets `LOCAL_BILLING=true`. The purchase helper grants test access
and queues the license email without contacting Stripe Checkout or Customer Portal.

## Manual setup

1. Install the pinned Node/pnpm versions and copy `.env.example` to a private
   `.env`. Generate independent `APP_SECRET` and `OPERATOR_TOKEN` values; do not
   copy development placeholders into a deployed service.
2. Set `DEPLOYMENT_MODE=standalone`, `STANDALONE_OWNER_EMAIL`, `PUBLIC_ORIGIN`,
   `DATABASE_URL`, private `DATA_DIR` and `WORK_DIR`, and `BUILD_DIR` and `WEB_DIR`.
   Choose persistent paths for data and disposable paths for builds and caches.
   The example file's `DATA_DIR` and `BUILD_DIR` point at the macOS Scratch
   volume; elsewhere, use repository-relative paths such as `DATA_DIR=./.data`
   and `BUILD_DIR=./dist`.
3. Configure a private S3-compatible bucket and its access settings, plus SMTP
   or the local mail sink. Use `LOCAL_BILLING=true` only for disposable development.
   For a production complimentary pilot, use `LOCAL_BILLING=false` and omit all
   primary Stripe, Connect and platform price values. Keep the normal production
   HTTPS, secret, owner, private-storage, mail and trusted-proxy settings. Enabling
   paid billing later requires the complete mode-specific Stripe configuration.
4. Install with the frozen pnpm lockfile, run `pnpm build`, and start with
   `node --env-file=.env src/server.ts`. Skip `setup-local.ts`, `local-s3.ts`
   and their generated `integration.env` when using this procedure.

This setup uses your existing S3 service and needs no Go toolchain. See
[configuration](configuration.md) for the full environment reference and
[deployment](deployment.md) for HTTPS, production credentials, and Compose.

## Create a product

1. Open **Products & sales → Products** and choose your software's framework.
   WordPress needs the exact `directory/main-file.php` plugin basename. Joomla
   and JetBrains need their extension or plugin identity. Generic defaults to
   device activation.
2. For a complimentary pilot, leave **Include a paid plan (monthly or annual)**
   unchecked. To test a purchase in the local fixture, enable it and select a
   **Local test fixture** price. For paid sales through Stripe, create an
   active monthly or annual recurring price in the correct account and mode.
3. If adding a paid plan, select that price and its site/device allowance. The same API field,
   `siteAllowance`, counts seats for either activation type.
4. Save and check `/api/v1/tenants/YOUR_SLUG/catalog`. Confirm the product slug,
   framework, paid plan IDs, and each plan's `unit_amount`, `currency`, and
   `billing_interval` before adding checkout to another website.

To start selling a pilot product later, choose **Edit product** and add a monthly
or annual plan. Framework configuration locks after the first license or release.
Price-to-product and allowance mappings also persist. Add a new Stripe price when
changing an allowance, and archive a plan to stop new purchases. See
[seller guide](seller-guide.md#products-and-plans).

## Publish version 1.0.0

Open **Products & sales → Releases**, select the product, and enter `1.0.0`.
Approve the upload with a passkey or security key accepted by the server's
[privileged policy](authentication-policy.md). To publish from CI, use a scoped
automation key or a [trusted OIDC publisher](oidc-publishing.md).

For WordPress, publish a ZIP whose main plugin header and directory match the
product and version. For other frameworks, upload a package for an exact target
and include the metadata required by its adapter. Tauri and Sparkle signatures
come from your build system. Inspect [framework requirements](platform-support.md)
before packaging.

Publication validates the package and verifies the private stored bytes before
offering the release. The server reports separate WordPress and native upload
limits in the application guide's **Server limits** section.

## Issue a complimentary pilot license

Open **Products & sales → Licenses** and select **Issue complimentary license**.
Enter the customer's email, product, installation allowance, and a future
expiration date and time. The form uses your browser's local time zone. You can
add a private note. Review the confirmation before issuing.

Entitle creates or reuses the customer within this workspace and queues the
license-key email. The success notice confirms that the email is queued. If
you're unsure whether a submission succeeded, retry with the same values to
reuse its request ID and avoid issuing another license or queuing another email.

Seller and customer views label these licenses as complimentary. Customers keep
their complimentary licenses when you enable Stripe and can choose a paid plan
separately. Use the usual controls to revoke, restore, or replace a key.
Restoration preserves the original expiration. Expiration stops new activations,
downloads, and updates while installed software keeps working.

Follow [activation](#activate-the-client) below using the emailed key. The existing
WordPress client accepts it. See the [API contract](api.md#complimentary-issuance)
for automation.

## Purchase a paid license

To test a paid purchase with Stripe, configure the merchant's test prices,
matching keys, and signed webhook endpoint. Open `/app/t/YOUR_SLUG` on hosted or
`/t/YOUR_SLUG` on standalone, choose a plan, and complete checkout. Wait until
Entitle reconciles the payment and sends the license email. See
[deployment](deployment.md#buyer-checkout-and-billing-in-both-versions) for configuration.

In the local fixture, use the ID of the plan you created with a fixture price.
Open **Integrations → API keys** and create a key with `licenses:write`. Set
`TENANT_SLUG=primary` and supply `TENANT_API_KEY` privately through your
environment or secret manager, then run:

```sh
pnpm cli demo-purchase PLAN_ID_FROM_CATALOG buyer@example.test
```

Read the license-key email in Mailpit when using the local fixture.

## Activate the client

Open **Integrations → Client setup** in the seller dashboard and select the
product to get its workspace-specific settings. In your client, activate the
emailed license key with a persisted installation ID. Site products also send
`siteUrl`. Store the returned activation token in protected client storage and
use it for update checks and downloads. See [client integration](client-integration.md).

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
- Deactivation frees a seat, and replacing a license key invalidates existing tokens.
- An unavailable licensing server leaves installed functionality usable.

Follow the [release checks](testing.md#release-checks) on the operating systems,
framework versions, and deployment you intend to support.
