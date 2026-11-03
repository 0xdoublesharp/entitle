# Deployment

The independent frontend builds embed Open Graph and Twitter preview metadata.
Marketing includes home and documentation pages; the application includes
seller, customer and local documentation pages. Preview images are public PNG assets.
For a self-hosted domain, set `WEB_PUBLIC_ORIGIN=https://licenses.example.com`
when running `pnpm build:web`; it defaults to `https://entitle.doublesharp.com`.
This build setting controls metadata URLs only. Keep `PUBLIC_ORIGIN` configured
on the API for authentication and checkout. Customer previews are generic,
exclude account data and request no indexing.

Run the server and a static web runtime behind HTTPS. The server runs the API and database-backed jobs. The web runtime serves independently published Vue assets and forwards API requests on the same origin. SQLite needs persistent local storage; PostgreSQL/MySQL are alternatives. Artifacts live in a private S3-compatible bucket. Redis is an optional cache. Use the [configuration reference](configuration.md) for environment defaults and validation, [CLI reference](cli.md) for automation, and [troubleshooting](troubleshooting.md) for failed setup or delivery.

## Using the hosted service

As a hosted seller, you do not deploy this application or provide database,
storage, SMTP or server credentials. Sign in at `/app/seller`, open the emailed
link in the same browser and create a workspace. For an invited pilot, add a
product without a paid plan, publish its release and issue complimentary licenses
from Licenses. Connect your Stripe account from Billing when you are ready to
sell; create annual recurring prices and configure its Customer Portal before
adding paid plans. Copy the generated client setup for your product.
Buyers use `/app/t/YOUR_SLUG`; integrations use `/api/v1/tenants/YOUR_SLUG`.
Create scoped API keys for your own automation, never for distributed clients.

Review the platform subscription amount, application fee and workspace limits
before subscribing. The application fee defaults to 1% for new subscriptions
and their renewals, in addition to the platform subscription and separate Stripe
fees. Existing subscriptions retain their original fee. Application fees are
retained on refunds by default; see [hosted pricing](hosted-pricing.md).
Your Stripe account receives buyer payments. Entitle is not a merchant of record.

The operator runs application updates, infrastructure, email, backups and restore
procedures. This repository documents the implementation and planned hosted
address; it does not establish public launch availability, an SLA or backup
retention terms. The remaining sections are for the person operating a server.

## Self-hosted standalone

Use standalone to run the service for your own software business. You operate
its HTTPS host, database, private S3 bucket, email, monitoring, upgrades and
[backup/restore](backup.md). One publisher can sell multiple products through
the same dashboard, buyer portal and scoped APIs used by the hosted service.
There is no platform subscription or application fee; your infrastructure,
Stripe, storage and email providers may charge separately. Configured capacity
and security limits remain enforced.

Start from `.env.example` and supply all shared production settings below.
This fragment selects the mode and owner; it is not a complete environment:

```dotenv
DEPLOYMENT_MODE=standalone
STANDALONE_OWNER_EMAIL=owner@example.com
PUBLIC_ORIGIN=https://licenses.example.com
```

Choose DEPLOYMENT_MODE explicitly. The default is standalone: one publisher,
the existing primary workspace, multiple products and direct merchant Stripe
credentials. Set STANDALONE_OWNER_EMAIL; only this verified address may sign in
as publisher and it receives primary membership after verification. Use
`/t/primary` for buyers and `/api/v1/stripe/merchant-webhook` for signed merchant
events with STRIPE_WEBHOOK_SECRET. No Connect client ID, Connect webhook secret
or platform price is needed. Production requires SMTP, private S3 and the trusted
HTTPS proxy. For a complimentary pilot before configuring Stripe, set
`LOCAL_BILLING=false` and omit all Stripe, Connect and platform price settings.
Products and real complimentary licenses can be managed without a payment
provider. Paid checkout and billing remain unavailable. When enabling paid
billing, provide the complete matching Stripe key and webhook configuration.

Existing SaaS databases must keep DEPLOYMENT_MODE=hosted. Standalone refuses
databases with additional tenants, a connected Stripe account or platform
customer/subscription mappings. It does not modify or delete them. Use a fresh
database for a new standalone installation; do not remove billing mappings to
bypass the guard. Keep the same Stripe account when restoring merchant data.

For production payments, set `LOCAL_BILLING=false`, matching
`STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY`, `STRIPE_LIVE_MODE` and
`STRIPE_WEBHOOK_SECRET`. Register the signed merchant webhook on your Stripe
account, using the events listed under buyer billing below. Configure annual
recurring prices and your account's Customer Portal. Do not reuse a Connect
webhook secret for the merchant endpoint.

| Standalone endpoint       | URL                                               |
| ------------------------- | ------------------------------------------------- |
| Seller sign-in            | `${PUBLIC_ORIGIN}/seller`                         |
| Buyer page                | `${PUBLIC_ORIGIN}/t/primary`                      |
| Software and customer API | `${PUBLIC_ORIGIN}/api/v1/tenants/primary`         |
| Merchant webhook          | `${PUBLIC_ORIGIN}/api/v1/stripe/merchant-webhook` |

After verifying `STANDALONE_OWNER_EMAIL` at `/seller`, the owner automatically
receives access to `primary`; no tenant creation or `tenant-owner` CLI action
is required. Standalone hides Connect onboarding and platform billing, and
those endpoints are unavailable. The initial workspace is exempt from platform
billing and defaults to 20 products / 1 GiB. Operators can change its allowances;
platform paid-plan settings do not automatically resize this exempt workspace.

## Operating a hosted platform

Set `DEPLOYMENT_MODE=hosted` explicitly. This enables independent seller signup,
workspace creation, Stripe Connect and platform subscriptions. Hosted mode
retains the Connect configuration below and defaults to
`HOSTED_APPLICATION_FEE_PERCENT=1`. The setting applies to newly created license
subscriptions and their renewals. It does not migrate existing subscriptions
or already-open Checkout Sessions. See [hosted pricing](hosted-pricing.md) for
fee configuration and the retained application-fee refund policy.

The technical mode is separate from licensing permission. The service is
source available under [Elastic License 2.0](../LICENSE) plus the
[publisher use permission](../ADDITIONAL-PERMISSION.md). Running it for your own
products is covered by that permission. Providing a licensing/distribution
platform to independent publishers requires separate permission where restricted
by those terms. Enabling hosted mode does not grant additional license rights.

## Independent marketing and application sites

Self-hosting needs only `pnpm build:server` and `pnpm build:web`. The app-only web
artifact opens the seller dashboard at `/`, provides customer routes under `/t/`,
and includes local documentation. It contains no marketing entry point. The
marketing site is optional and has its own `pnpm build:marketing` target and
`@entitle/marketing` dependency closure.

Hosted publication uses `pnpm build:hosted-web`. Marketing and public documentation
occupy `/` and `/docs`; the app occupies `/app/`. It independently builds the app
and marketing bundles, then assembles an atomic hosted archive. Existing `/seller`
and `/t/...` links redirect to the app while preserving query and browser fragment
context. API, update-feed, webhook and package endpoints remain under `/api/`.
Marketing documentation is static; deployment-specific limits are in app docs.
The API defaults to `/app` in hosted mode and `/` in standalone mode. An explicit
empty `APP_BASE_PATH` keeps hosted installations at the root.

| Setting                 | Standalone default              | Hosted value                      | Purpose                                                |
| ----------------------- | ------------------------------- | --------------------------------- | ------------------------------------------------------ |
| `PUBLIC_ORIGIN`         | Your origin                     | `https://entitle.doublesharp.com` | API origin and authentication checks                   |
| `APP_BASE_PATH`         | empty                           | `/app` (mode default)             | Server-generated account, login and Stripe return URLs |
| `WEB_APP_BASE_PATH`     | empty for `build:web`           | `/app` for `build:hosted-web`     | App bundle assets, metadata and navigation             |
| `WEB_APP_URL`           | `/app/` for marketing           | `/app/`                           | Marketing links to the application                     |
| `ENTITLE_APP_BASE_PATH` | `/app`, unused by root-only app | `/app`                            | Optional hosted mount in the web runtime               |

For a later subdomain move, publish the app-only artifact at the new origin,
leave `APP_BASE_PATH` and `WEB_APP_BASE_PATH` empty, set `PUBLIC_ORIGIN` to that
origin, and build marketing with `WEB_APP_URL=https://your-app-host/`. Serve app
and API on the same origin. No CORS or cookie-domain changes are required. Review
Stripe allowed return/callback URLs and email links when changing the public origin.

CI publishes `frontend-SHA` for the standalone app, `marketing-SHA` for marketing,
and `hosted-frontend-SHA` for the combined hosted layout. All use the same verified
manifest/immutable asset publication format. The private promotion workflow chooses
the hosted artifact and retains explicit compatibility with older single-site releases.

## Shared production infrastructure

Set `PUBLIC_ORIGIN` to your actual HTTPS service origin. Use your own domain for standalone; `https://entitle.doublesharp.com` is the planned hosted deployment. This is the common runtime origin for the application, HTTPS proxy, emailed links, Stripe callbacks and package URLs. There is no separate proxy hostname setting. Public brand text and the planned hosted link are shared in [../src/site.ts](../src/site.ts). Keep local development at `http://localhost:3211`. Recording this hostname does not provision DNS, certificates or a production deployment.

Create a private persistent directory owned by UID/GID 1000, copy `.env.example` to `.env`, and protect it with mode 0600. Set `ENTITLE_DATA_DIR`, `PUBLIC_ORIGIN`, `NODE_ENV=production`, `LOCAL_BILLING=false`, `DATA_DIR=/data`, `WORK_DIR=/data/work` and `WEB_DIR=/app/web`. Set `ENTITLE_PUBLIC_HOST` to the hostname in `PUBLIC_ORIGIN` and `ENTITLE_WEB_RELEASE_DIR` to the absolute frontend publication directory. The Compose network uses a fixed subnet; ensure it is unused. The API trusts only the web runtime at `TRUST_PROXY=172.30.81.4`; the web runtime trusts Caddy at `172.30.81.2/32` for client IPs. Production requires an explicit deliverable `MAIL_FROM` and matching Stripe secret/publishable key modes. SMTP requires TLS in production, including STARTTLS when `SMTP_SECURE=false`.

Generate independent `APP_SECRET` (64 hex) and `OPERATOR_TOKEN` (at least 32 random characters). Back up APP_SECRET permanently: outbox credentials and activation retry material depend on it. Supply SMTP host/port/user/password/from; port 587 uses STARTTLS, port 465 normally needs SMTP_SECURE=true. Mailpit is development-only.

Configure `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, and credentials through `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` or the AWS credential chain. Some providers require `S3_FORCE_PATH_STYLE=true`. Production rejects HTTP endpoints, embedded credentials, queries and fragments. Sellers cannot override storage settings or choose object keys. Block public bucket/object access; enable provider encryption, versioning and independent backups. Restrict the application credential to bucket metadata access and GetObject/PutObject/DeleteObject under `tenants/`. Test your provider's conditional `If-None-Match: *` behavior before use; the local MinIO result does not qualify every provider.

Shared defaults: MAX_UPLOAD_MIB=25 (hard 100), TRANSFER_MEMORY_MIB=256 and DAILY_EMAIL_LIMIT=1000. Hosted quota settings default to TRIAL_DAYS=14, GRACE_DAYS=7, MAX_TENANTS_PER_SELLER=3, TRIAL_STORAGE_MIB=100, PAID_MAX_PRODUCTS=20 and PAID_STORAGE_MIB=1024. Hosted trial or paid subscription periods do not apply to the exempt standalone workspace. Transfer memory must cover at least six times the upload cap. That budget covers transfer buffers only; reserve additional process memory for Node, database and request overhead. Increasing the ZIP cap requires a larger host/container budget. Archive security limits remain 2,000 entries, 250 MiB expanded and bounded compression ratio. Native packages use a separate 100 MiB default cap with a 2 GiB hard ceiling and bounded private disk spools. Their expanded archive limit is the greater of 250 MiB or package size. See [native transfer budgets](#native-artifact-disk-and-transfer-budgets) and [framework support](platform-support.md) before raising limits.

Build and activate a frontend artifact before starting the web runtime. Use an
absolute writable release directory owned by the publishing account. The runtime
mounts its parent read-only, so activation can change `current` without restarting
the container. For a local build, keep output on Scratch:

```sh
BUILD_DIR=/Volumes/Scratch/entitle/build/self-host pnpm build:web
node scripts/deployment/frontend-release.mjs pack \
  --input /Volumes/Scratch/entitle/build/self-host/web \
  --output /Volumes/Scratch/entitle/build/self-host/frontend.tar \
  --source-sha "$(git rev-parse HEAD)"
# Use the sha256 from pack's JSON result and the ENTITLE_WEB_RELEASE_DIR path.
node scripts/deployment/frontend-release.mjs activate \
  --archive /Volumes/Scratch/entitle/build/self-host/frontend.tar \
  --sha256 ARCHIVE_SHA256 --root /srv/entitle/frontend
docker compose --env-file .env -f deploy/compose.yaml build
docker compose --env-file .env -f deploy/compose.yaml up -d
```

`pnpm build:server` and `pnpm build:web` have separate dependency closures under
`apps/server` and `apps/web`. Source stays in `src/` and `web/` to preserve existing
integration imports. `packages/shared` contains browser-safe shared definitions.
The server image contains no frontend assets, test code or browser dependencies.
`pnpm build` still produces both targets for local development.

Public CI checks and builds source without production credentials. It reuses
server and web-runtime images by hashes of their build inputs and publishes
frontend archives with checksums. Production configuration and promotion live in
a separate private repository. A frontend-only publication replaces files under
the stable runtime and does not restart either service. Failed promotion must
reconcile the observed container image and health, rather than assuming a saved
image setting was deployed. Database migrations require their own backup and
compatibility checks before promotion.

The root filesystem is read-only; only `/data` is writable. Only the proxy publishes ports. Readiness checks a database query, private S3 bucket access and working-directory read/write. Liveness is `/api/v1/health`. Observe readiness, memory, database/backlog sizes, oldest job age, failed jobs, object reservations and bucket cost. HTTP logs contain route templates and generic errors, never request URLs, bearer values or client secrets.

## Stripe Connect and platform billing, hosted only

For paid billing in `DEPLOYMENT_MODE=hosted`, supply platform `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_CONNECT_CLIENT_ID`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` and `PLATFORM_STRIPE_PRICE_ID`. Set STRIPE_LIVE_MODE explicitly. Use test mode until separately qualified. Hosted production accepts all these billing settings absent for complimentary licensing; once any are provided, the complete set is required. SMTP and private S3 remain required. Standalone does not require Connect credentials or a platform price. No live charge is needed to qualify the application locally.

Configure Connect Standard OAuth with fixed redirect `PUBLIC_ORIGIN/api/v1/platform/stripe/callback`. Sellers sign in and connect their own account. Account binding is immutable once established; reconnecting that account is supported. New accounts require a distinct tenant so historical price/customer references cannot silently move. Disconnection blocks new sales, preserves purchased time and keeps reconciliation failures retryable. It does not extend licenses indefinitely or disable installed software.

Use the common `PUBLIC_ORIGIN` value when configuring each endpoint:

| Purpose                | URL                                                |
| ---------------------- | -------------------------------------------------- |
| Connect OAuth redirect | `${PUBLIC_ORIGIN}/api/v1/platform/stripe/callback` |
| Platform webhook       | `${PUBLIC_ORIGIN}/api/v1/stripe/platform-webhook`  |
| Connect webhook        | `${PUBLIC_ORIGIN}/api/v1/stripe/connect-webhook`   |
| Customer page          | `${PUBLIC_ORIGIN}/t/SLUG`                          |
| Seller dashboard       | `${PUBLIC_ORIGIN}/seller`                          |
| Software API           | `${PUBLIC_ORIGIN}/api/v1/tenants/SLUG`             |

Expand the variable before entering URLs in Stripe; its dashboard expects complete URLs.

On each connected account, create annual recurring prices and configure its Customer Portal for payment methods, invoices, cancellation and permitted plan changes. Map prices through the tenant seller UI/API/CLI. Downgrades should take effect at period end; upgrades require a paid invoice. Zero-payment invoices and trials never issue initial licenses. Browser success and Elements confirmation never grant entitlement.

## Buyer checkout and billing in both versions

Buyer forms use Stripe Payment Element with Checkout Sessions. Hosted mode uses the same connected account ID on server and browser; standalone uses the configured merchant account and omits the connected-account option. Styling uses Elements Appearance. Stripe.js loads directly from Stripe; our server receives no card data. The narrowly scoped CSP allows Stripe's script/frame/API and Link origins. Hosted Checkout remains available to API integrators; platform subscription checkout and Customer Portal remain Stripe-hosted. Independent seller websites can proxy guest checkout only if they relay the issuing browser's checkout cookie. Existing customers must use the hosted buyer sign-in flow, or an integration proxying the complete same-origin session flow. A general cross-domain customer authentication bridge is not included; see the Elements design.

Use Stripe API2026-09-30.endive. Standalone receives merchant events only at `/api/v1/stripe/merchant-webhook`, signed with STRIPE_WEBHOOK_SECRET. Include checkout.session.completed/async_payment_succeeded, invoice.paid/payment_failed, customer.subscription.created/updated/deleted, charge.refunded, refund.created/updated and charge.dispute.created/updated/closed.

Hosted mode instead registers two signed raw-body webhook endpoints:

- `/api/v1/stripe/platform-webhook`: events on the platform account, signed with `STRIPE_WEBHOOK_SECRET`. Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `charge.refunded`, `refund.created`, `refund.updated`, `charge.dispute.created`, `charge.dispute.updated` and `charge.dispute.closed`. Payments, refunds and disputes trigger canonical platform entitlement reconciliation as well as subscription changes.
- `/api/v1/stripe/connect-webhook`: connected account events, signed with STRIPE_CONNECT_WEBHOOK_SECRET. Include account.application.deauthorized/account.updated, checkout.session.completed/async_payment_succeeded, invoice.paid/payment_failed, customer.subscription.created/updated/deleted, charge.refunded, refund.created/updated and charge.dispute.created/updated/closed.

For normal test-mode merchant or platform billing, register the same endpoint
families in Stripe test mode with matching test keys and `STRIPE_LIVE_MODE=false`.
Use each endpoint's own signing secret in its corresponding setting; the
sandbox endpoint below has a separate test credential set and signing secret.

Events are durable and idempotent; jobs read canonical Stripe data outside SQL transactions, then compare-and-swap billing revision in a short transaction. Full refunds permanently revoke future downloads for the whole license, including an upgraded license; partial refunds leave entitlement unchanged. Open/lost disputes suspend downloads; resolution reconciles. Canceling renewal or failing a renewal payment preserves paid time.

In hosted mode, a paid positive configured-price platform invoice raises tenant quota. Subscription status/redirect/unpaid upgrade alone cannot. Platform delinquency after grace blocks new products/releases/purchases, while existing buyer paid rights, recovery and billing reconciliation continue. Explicit operator abuse suspension denies tenant business service, while operator and owner platform billing/key recovery remain available. Installed PHP features never depend on these states.

## CLI and reconciliation

Tenant commands require TENANT_SLUG and a scoped expiring TENANT_API_KEY. Remote commands need no server secret. Platform administration uses OPERATOR_TOKEN separately. Store credentials in a secret manager/protected environment, never command arguments or distributed ZIPs. See README and API docs for command names.

Schedule `reconcile` with a billing:reconcile key for `primary` in standalone, or for each seller workspace in hosted mode. Hosted platform subscriptions additionally need `platform-reconcile TENANT_ID` with operator credentials. Standalone has no platform subscription to reconcile. For example run tenant reconciliation every six hours through a protected host script invoking the CLI. The process polls durable jobs every five seconds. `jobs`/`platform-jobs` show safe state. Failed work retries within a 72-hour window with backoff capped at one hour. Failed jobs remain recoverable through individual or bounded bulk retry APIs; explicit retry starts a fresh retry window. Daily mail budgets defer rather than consuming failure retries or discarding encrypted keys. Monitor failed counts and oldest pending jobs. Platform mail defaults to 1,000 attempts per UTC day and seller signup to 500 creations per hour; configure `PLATFORM_DAILY_EMAIL_LIMIT` and `MAX_SELLER_SIGNUPS_PER_HOUR` separately from each tenant's `DAILY_EMAIL_LIMIT`.

## Upgrade and migration

Back up database, objects and APP_SECRET together before migrations. Stop competing application versions. Migrations run under Knex's migration lock and retain populated pre-tenant data in tenant `primary`; prior buyer sessions/login tokens are invalidated. There are no old unscoped API aliases. Update PHP clients to `/api/v1/tenants/SLUG`.

Ship and apply the complete `src/migrations/` directory with each application release. Migrations cover framework identities, commerce, account security, operations, sandboxes, durable events and verified price history. Existing products retain their WordPress identity. Platform checkout attempts and leases prevent independent duplicate subscriptions. Tenant API keys predating migration005 with no expiry fail closed; replace them through the owner's key controls. Existing buyers' purchased time is preserved.

Withdraw a faulty release through the seller API/CLI; bytes remain immutable for recovery and continue counting against storage. Schema rollback requires restoring a matching backup. See backup.md and testing.md#release-checks for restore and qualification limits.

## Optional Redis cache

The default adaptive cache runs in process with `CACHE_MEMORY_MIB=8`, bounded to
256 MiB of configured cache memory and 256 KiB per entry. It requires no Redis.
To use your existing server, set `CACHE_REDIS_URL=redis://cache:6379/0` in the
protected environment; `rediss://` enables TLS with certificate verification.
Use private connectivity, Redis authentication/ACLs and an operator-controlled
maxmemory/eviction policy. The app never exposes the URL or Redis error details.
`CACHE_NAMESPACE` accepts 1–64 alphanumeric, colon, underscore or hyphen characters;
use a different value for separate deployments sharing Redis. Origin/database
identity and tenant/input hashes further scope keys.

Only annual Stripe price-picker data and already-authorized feed formatting are
cached. Feed formatting stays in trusted process memory, even when Redis is
configured, so remote cache values cannot replace update manifest bytes. With
Redis enabled, the feed cache has a separate bounded in-process allocation.
Initial freshness is 15 seconds, adapting up to 60 seconds; metadata is
retained for 300 seconds. Errors, negatives and stale results are not served.
Redis uses one owned connection with short command/connect deadlines, no offline
queue and source fallback on failure. Default in-memory mode uses clustered-LRU;
Redis mode uses the Redis-only backend for price data; feeds stay in process.
The pinned adaptive-cache 0.2.1 release fixes the earlier Redis/L1 shutdown leak.
Shutdown still disconnects the app-owned client, including when cache closure rejects.
Cache keys include an `adaptive-v2:` format namespace so pre-0.2 writers cannot
share entries during an upgrade. Old entries expire without a Redis flush.
The library defaults to a 30-second loader deadline and a five-second close deadline.

Redis contains disposable presentation data and needs no backup for licensing
correctness. It is neither a queue nor an entitlement store. Cache requests are
application-level, so all existing HTTP no-store, authentication, tenant capacity,
paid-through, refund/dispute, revocation, fresh release selection and download
integrity checks continue to run. Reconnecting a different Stripe account selects
a different price cache entry. Real TLS Redis qualification is separate from the
local plain-TCP Redis integration test.

## Source and license distribution

The image includes the service Elastic License 2.0, ADDITIONAL-PERMISSION.md and NOTICE. Its built web
assets provide `/legal/source.tar.gz`, `/legal/Elastic-2.0.txt`, `/legal/ADDITIONAL-PERMISSION.txt`, `/legal/MIT.txt`,
`/legal/0BSD.txt`, `/legal/NOTICE.txt` and `/legal/THIRD-PARTY.txt`. Source uses the reviewed file
allowlist; never add secrets or deployment data to it. Regenerate the build after
modification so the downloadable source matches the running code. Keep the source
links available for source inspection. Client
example packages include MIT license copies; third-party licenses are unchanged.

## Sandbox and Pro configuration

Hosted Starter and Pro share one app and database. Set
`PLATFORM_PRO_STRIPE_PRICE_ID` only when a positive monthly recurring Pro price
exists on the platform Stripe account. It is distinct from the Starter price.
Archived prices and verified historical mappings remain relevant to reconciliation;
changing new-sale pricing must not erase an existing seller's paid grant.
Self-hosted standalone requires no platform subscription for local capabilities.
See [hosted tiers](hosted-pricing.md) for fees, credits and downgrade policy.

Optional Stripe sandbox mode uses a complete separate test set:
`STRIPE_TEST_SECRET_KEY`, `STRIPE_TEST_PUBLISHABLE_KEY` and
`STRIPE_TEST_WEBHOOK_SECRET`. Configure the signed test endpoint at
`${PUBLIC_ORIGIN}/api/v1/stripe/sandbox-webhook` in Stripe test mode, using that
endpoint's signing secret as `STRIPE_TEST_WEBHOOK_SECRET`. Subscribe to
`checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`invoice.paid`, `invoice.payment_failed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`charge.refunded`, `refund.created`, `refund.updated`, `charge.dispute.created`,
`charge.dispute.updated` and `charge.dispute.closed`. In standalone mode, select
merchant-account events without a connected-account field. In hosted mode,
select connected-account events for the mapped test accounts; omit `account.*`
events from this sandbox subscription. The endpoint routes only to mapped
Stripe-test sandboxes and never accepts live-mode events. With no test
credentials, fixture sandboxes still work without external payments. Test and
live customer/license/artifact namespaces remain separate, while sandbox capacity
and Pro capabilities follow the publisher parent.

`OUTBOUND_WEBHOOK_HOSTS`, when configured, restricts destinations to exact public
DNS names. It is an additional restriction; private IPs, mixed public/private
answers, redirects and credential-bearing URLs remain forbidden. Receivers verify
the timestamp, event ID and raw-body HMAC, deduplicate event IDs and acknowledge
quickly. Preserve a signing secret securely; rotation retains undelivered events
under the new generation, and failed deliveries remain explicitly retryable.

Offline transfer and customer privacy commands use `pnpm maintenance`, not an
unrestricted web approval endpoint. Read [operator maintenance](operator-maintenance.md)
before stopping services or preparing an import. Exported ciphertext and its
passphrase must be kept separately. An encrypted workspace transfer does not
replace a whole-service backup or automatically change Stripe, webhooks or client
update origins.

## Native artifact disk and transfer budgets

WordPress retains `MAX_UPLOAD_MIB`, default 25 MiB and hard ceiling 100 MiB.
Native packages use `MAX_NATIVE_UPLOAD_MIB`, default 100 MiB and hard ceiling
2048 MiB. Set `NATIVE_UPLOAD_TIMEOUT_MS` to an inactivity window appropriate for
your publisher uplink when raising that cap. Its default is 120 seconds and its
maximum is one hour. The total receive budget also scales with declared size. Bodies are spooled privately, counted by actual bytes and
checked against Content-Length. Native uploads reserve two disk copies through
publication/readback and cleanup, rather than buffering large requests in RAM.

The publication pool uses `NATIVE_SPOOL_MIB`, default 4096. The shared verified
native-download cache uses `ARTIFACT_CACHE_MIB`, default 4096, and
`ARTIFACT_CACHE_INFLIGHT_MIB`, default 2048. Configure at least two maximum native
objects in the cache. A leased immutable object is reused after TTL expiry only
when its local identity still matches; new openers do not allocate duplicate
copies. Idle entries expire normally. The in-flight cache budget must fit the total and admit a maximum object.
`ARTIFACT_CACHE_TTL_MS` defaults to five minutes. `ARTIFACT_TRANSFER_TIMEOUT_MS`
is the inactivity window; total transfer limits scale with object size. Current
entitlement and withdrawal are checked on every request, including cache hits.

Provision disk for the publication pool, cache, encrypted workspace exports,
database and other processes on the volume together. `MIN_DISK_FREE_MIB` defaults
to a 64 MiB free-space floor; it supplements per-process reservations and does
not replace a filesystem quota. Private working folders belong on the persistent
`/data/work` volume in Docker. A process owns only its random verification/export
folders and does not trust crash leftovers. After confirming the former process
has stopped, review ownership before removing abandoned files. Keep shared caches
and all release objects intact.

Native download counters measure completed served responses and their actual
response bytes. Storage-read counters measure verified committed artifact reads,
including full reads needed for an uncached range, while cache hits avoid another
remote read. They do not claim completed software installations, network-layer
billing, or exact provider billable bytes for failed transfers. No native S3
range forwarding, CDN or differential update generation is included.

## Long operations and tenant export admission

Authenticated, admitted native transfers and export creation suspend the ordinary
15-second socket inactivity timer while explicit operation deadlines apply.
The socket timer is restored on response finish or close. Ordinary requests keep
the default timer; slow uploads and downloads still have their own idle and total
limits. No download headers precede complete private artifact verification.

`EXPORT_MAX_EXPORTS` defaults to 4 and accepts 2 through 10. One tenant may hold
one creating or retained export. `EXPORT_MAX_GIB` defaults to 10 and accepts
1 through 10; it bounds the shared disk reservation for plaintext, encrypted blobs
and the encrypted manifest across all exports. A disconnected creation aborts and
cleans its private work. The per-process limits do not replace filesystem quotas
or fair scheduling across tenants with different bundle sizes.

Development startup binds to `127.0.0.1`. Production uses `0.0.0.0` inside its container behind the configured HTTPS proxy; do not publish that application port directly on the host.

## Blue/green API deployment

Use two independent API resources with `SERVER_ROLE=api` and distinct
`DEPLOYMENT_SLOT=blue` or `green` values. API instances check migration history
at startup and never apply migrations or run background work. A separate
`SERVER_ROLE=worker` resource owns the job timer and has no public route.
Leave `DEPLOYMENT_SLOT` unset for the worker. The default `SERVER_ROLE=all`
preserves the single-process self-hosted setup.

The stable internal router uses the same runtime image with
`ENTITLE_RUNTIME_MODE=api-router`, listens on port 3211, and reads
`/routing/active-slot` from a read-only mount of its parent directory. Only
`blue` and `green` are accepted. It verifies readiness and the backend role and
slot headers before reloading Nginx. Existing requests drain through the previous
workers; keep the previous API container running until its next reuse.
Use writable UID/GID 101 tmpfs mounts at `/runtime` and `/cache`, as with the
frontend runtime. Its health check uses `http://127.0.0.1:3211/healthz`.

Promotion verifies the exact successful source CI and immutable digests, warms
the inactive slot, stops and confirms clean exit of the old worker, switches
traffic, then starts the new worker. Public smoke checks and a second observed
image/role/slot check precede the healthy receipt. The private deployment
repository owns the durable transaction journal, recovery, provisioning and
operator runbook. A failed or interrupted worker stop retains the journal and
refuses to start another worker.

Automatic blue/green releases require the same migration fingerprint as the
current healthy receipt. API rollback has the same schema guard. For a schema
change, take a matching backup, stop API/worker writers, apply the explicit
`SERVER_ROLE=migrate` entry point, and qualify the new version before restoring
traffic. Never run down migrations as part of automated rollback. Startup
migration-name checks supplement the deployment fingerprint; they do not prove
that old code can use a changed schema.

CI runs three independent test shards and constructs a per-run candidate image
concurrently. Only successful checks may publish reusable input tags and the
immutable release artifact. Frontend files still publish atomically without
restarting API or frontend containers. Changed runtime code also runs real
container routing checks. Measure accepted GitHub runs to compare wall time;
local unit tests do not establish production availability or deployment speed.
