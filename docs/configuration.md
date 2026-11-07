# Configuration reference

The server reads environment variables through `loadConfig` in
[`src/config.ts`](../src/config.ts). Start from [`.env.example`](../.env.example)
and [deployment](deployment.md). This reference describes source defaults;
your running process can have different values. Boolean flags enable only on
the exact string `true`. Numeric settings must pass the bounds below.

Keep server secrets in a private environment or secret manager. Never send them
to clients, public source archives, logs or release packages. The local setup
helper refuses to overwrite `.env`. An omitted optional value can differ from
a present empty string; omit optional price/account IDs until configured.

## Deployment and identity

| Variable                    | Default                         | Constraint / purpose                                                                                                    |
| --------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `SERVER_ROLE`               | `all`                           | `all`, `api`, `worker` or `migrate`; see runtime roles below. Unknown values fail before opening the database.             |
| `DEPLOYMENT_SLOT`           | Omitted                         | Optional exact `blue` or `green`; readiness identity for the deployment router.                                          |
| `NODE_ENV`                  | Unset                           | Exact `production` enables production requirements.                                                                     |
| `DEPLOYMENT_MODE`           | `standalone`                    | `standalone` or `hosted`; does not migrate a database.                                                                  |
| `PUBLIC_ORIGIN`             | `http://localhost:3211`         | HTTP(S) origin only, no credentials/path/query/fragment; HTTPS in production. Also used by the Compose proxy.           |
| `APP_BASE_PATH`             | Empty standalone; `/app` hosted | Prefix generated account and billing links, for example `/app`. Match the frontend mount. API endpoints stay at `/api`. |
| `PORT`                      | `3211`                          | Integer 0-65535; 0 is useful for isolated tests.                                                                        |
| `STANDALONE_OWNER_EMAIL`    | Empty                           | Required in standalone production; normalized email allowed to sign in as owner.                                        |
| `APP_SECRET`                | Required                        | Exactly 64 hexadecimal characters. Protect and back up for encrypted retry/outbox state.                                |
| `OPERATOR_TOKEN`            | Required                        | At least 32 random characters; independent from seller keys and `APP_SECRET`. The published placeholder is rejected.     |
| `TRUST_PROXY`               | Disabled                        | Required in production; identify the exact trusted proxy/subnet. Blanket `true`, `0.0.0.0/0` and `::/0` are refused.    |
| `DEVELOPMENT_HOST_SUFFIXES` | Empty                           | Comma-separated explicit host/suffix exemptions for site seat accounting. Exact or dot-delimited matching.              |

Development exemptions follow the current suffix configuration for existing and
new site installations. Removing a suffix makes its existing installations count
toward the paid allowance. Active tokens and same-site retries continue to work,
as after a paid allowance reduction; new production activations are refused until
enough installations are deactivated. Buyer and seller views use the current
policy without rewriting installation records. A successful activation or retry
refreshes stored exemption flags under the license's seat-admission lock. Device
installations never receive development-host exemptions.

Standalone startup refuses a hosted database with unrelated tenants or connected
account/platform billing mappings. Keep hosted databases in hosted mode. Do not
delete records to bypass the guard. An isolated sandbox child is supported.

## Runtime roles

`SERVER_ROLE=all` preserves legacy startup: apply bundled migrations, serve HTTP,
and run the background tick every five seconds. Use this default for local or
single-service deployments.

`SERVER_ROLE=api` serves HTTP without the background timer. `SERVER_ROLE=worker`
serves HTTP for internal health checks and runs the background timer. Both roles
require the existing `knex_migrations` history to contain every bundled migration
exactly once, with no unknown names. They check it without applying migrations
or creating migration metadata tables. Missing or incompatible history refuses
startup and closes the database before opening a listener. These checks compare
migration names, not migration contents or deployment fingerprints.

`SERVER_ROLE=migrate` applies migrations once and closes the database without
building the app, opening HTTP, starting a timer or installing server signal
handlers. Invoke the server module directly, for example
`SERVER_ROLE=migrate node src/server.ts`, or call the exported `startRuntime()`
dispatcher. `startServer()` retains its listening-server result for legacy
callers and rejects `migrate` before opening a database. A successful migration
returns `{ role: "migrate" }` from `startRuntime()`.

`GET /api/v1/ready` keeps the existing response body and dependency checks. It
adds the nonsecret `X-Entitle-Server-Role` response header, including on failed
readiness, and `X-Entitle-Deployment-Slot` when configured. The router must check
HTTP success, role `api` and its expected slot together. A worker's readiness
always identifies it as `worker`; a matching slot alone does not qualify it as
an API candidate. Slots accept only `blue` or `green`; empty values are invalid.

API and worker shutdown remains idempotent, handles SIGINT and SIGTERM, and
closes the database after HTTP and in-flight worker work finish. Keep exactly
one worker active across slot transitions; role selection does not coordinate
worker ownership between processes.

## Database and filesystem

| Variable               | Default                               | Purpose                                                                                                                       |
| ---------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`             | `/Volumes/Scratch/entitle/data/local` | Base for default SQLite and work paths. Set explicitly outside local macOS development.                                       |
| `DATABASE_URL`         | `sqlite:DATA_DIR/entitle.sqlite`      | SQLite, PostgreSQL or MySQL connection. Use a persistent private database.                                                    |
| `WORK_DIR`             | `DATA_DIR/work`                       | Private artifact spools, verified cache and export work; must be outside public static files.                                 |
| `BUILD_DIR`            | `/Volumes/Scratch/entitle/build/main` | Build output and fallback base for built web assets.                                                                          |
| `WEB_DIR`              | `BUILD_DIR/web`                       | Static frontend directory served by the app.                                                                                  |
| `ENTITLE_DATA_DIR`     | Required by Compose interpolation     | Host persistent volume path; Compose setting, not a `loadConfig` variable.                                                    |
| `ENTITLE_MEMORY_LIMIT` | `768m`                                | Compose application container memory limit; reserve enough for Node/database overhead as well as configured transfer buffers. |

The Docker deployment uses `DATA_DIR=/data`, `WORK_DIR=/data/work`,
`WEB_DIR=/app/dist/web` and a writable host volume owned by UID/GID 1000.
Inspect [compose.yaml](../deploy/compose.yaml) before selecting its subnet and paths.
Reserve enough filesystem capacity for publication, downloads, exports and the
database together. Per-process reservations are not filesystem quotas.

## Stripe and deployment modes

| Variable                         | Default                                  | Constraint / purpose                                                                                                   |
| -------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `LOCAL_BILLING`                  | `false`                                  | Synthetic local purchases; blocks real Checkout/Portal and is forbidden in production.                                 |
| `STRIPE_SECRET_KEY`              | Empty production; `sk_test_local` development | Merchant secret in standalone, platform secret in hosted. Required when enabling paid billing; test/live prefix must match mode. |
| `STRIPE_PUBLISHABLE_KEY`         | Empty                                    | Required for paid production; matching `pk_test_` or `pk_live_` key for browser Checkout.                              |
| `STRIPE_LIVE_MODE`               | `false`                                  | Exact `true` selects live mode.                                                                                        |
| `STRIPE_WEBHOOK_SECRET`          | Empty production; `whsec_local` development | Merchant webhook secret in standalone; platform subscription webhook secret in hosted. Required for paid production.  |
| `STRIPE_CONNECT_CLIENT_ID`       | Empty                                    | Hosted Connect OAuth application; required when enabling hosted paid billing.                                          |
| `STRIPE_CONNECT_WEBHOOK_SECRET`  | Empty production; `whsec_connect_local` development | Separate Connect event endpoint secret; required when enabling hosted paid billing.                           |
| `PLATFORM_STRIPE_PRICE_ID`       | Empty                                    | Hosted Starter subscription price; required when enabling hosted paid billing.                                         |
| `PLATFORM_PRO_STRIPE_PRICE_ID`   | Omitted                                  | Distinct `price_...` ID for a positive monthly recurring Pro price. Omit until configured.                             |
| `HOSTED_APPLICATION_FEE_PERCENT` | `1` hosted; `0` standalone               | 0-100 with at most two decimal places. Nonzero is refused in standalone. Applies to newly created buyer subscriptions. |
| `STANDALONE_STRIPE_ACCOUNT_ID`   | Omitted                                  | Explicit operator-verified `acct_...` merchant identity for standalone export. Does not change direct charge routing.  |

Do not confuse Stripe-hosted checkout `uiMode: "hosted"` with deployment mode.
Both deployment modes support that checkout interface and Elements. See
[hosted pricing](hosted-pricing.md) for paid Pro grants, fee retention and price
history. Changing an environment price does not rewrite historical grants or
existing buyer subscription fee percentages.

Production can issue complimentary licenses before Stripe is configured. Set
`LOCAL_BILLING=false` and omit or leave empty all primary Stripe, Connect and
platform price settings. Keep the normal HTTPS, owner, secret, SMTP, private S3
and trusted-proxy configuration. Complimentary issuance does not create a payment
or subscription. Paid checkout, billing and Stripe reconciliation stay unavailable.
Providing any primary Stripe/Connect/platform price value enables the existing
complete production validation for that deployment mode; partial configuration
is refused. Separate sandbox test credentials do not enable primary billing.
Development's placeholder key/signing-secret defaults are local fixtures and
are never supplied as production defaults.

| Optional sandbox variable     | Requirement                                       |
| ----------------------------- | ------------------------------------------------- |
| `STRIPE_TEST_SECRET_KEY`      | `sk_test_...` key.                                |
| `STRIPE_TEST_PUBLISHABLE_KEY` | Matching `pk_test_...` key.                       |
| `STRIPE_TEST_WEBHOOK_SECRET`  | `whsec_...` for `/api/v1/stripe/sandbox-webhook`. |

Supply the complete separate test set or omit it. A partially configured set
fails validation. Fixture sandboxes need no Stripe test keys.

## Private S3 storage

| Variable               | Default         | Constraint / purpose                                                                   |
| ---------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `S3_BUCKET`            | `entitle-local` | Explicitly required in production. Keep bucket and objects private.                    |
| `S3_REGION`            | `us-east-1`     | Explicitly required in production.                                                     |
| `S3_ENDPOINT`          | Omitted         | Custom HTTP(S) endpoint without credentials/query/fragment. Production requires HTTPS. |
| `S3_ACCESS_KEY_ID`     | Omitted         | Supply together with secret, or use the SDK credential chain.                          |
| `S3_SECRET_ACCESS_KEY` | Omitted         | Private credential; must accompany access key when explicitly configured.              |
| `S3_FORCE_PATH_STYLE`  | `false`         | Enable only when required by the provider.                                             |
| `S3_ALLOW_HTTP`        | `false`         | Allows an HTTP fixture endpoint only outside production.                               |

Publication depends on conditional immutable writes and verified readback.
Validate those semantics with the actual provider. The readiness check verifies
bucket access, not every permission, privacy policy or billing operation. Offline
portability import has a stricter empty/private-bucket preflight.

## Mail and signup

| Variable                      | Default                 | Constraint / purpose                                                                            |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `SMTP_HOST`                   | `127.0.0.1`             | Explicitly required in production.                                                              |
| `SMTP_PORT`                   | `1025`                  | Integer 1-65535. Common provider ports are 587 for STARTTLS and 465 for implicit TLS.           |
| `SMTP_SECURE`                 | `false`                 | `true` selects implicit TLS; production otherwise requires STARTTLS through the mail transport. |
| `SMTP_USER`, `SMTP_PASS`      | Empty                   | Provider credentials when needed.                                                               |
| `MAIL_FROM`                   | `licenses@example.test` | Explicit valid deliverable address in production; `.test` is refused there.                     |
| `DAILY_EMAIL_LIMIT`           | `1000`                  | Tenant SMTP attempts per UTC day, 1-1,000,000.                                                  |
| `PLATFORM_DAILY_EMAIL_LIMIT`  | `1000`                  | Platform SMTP attempts per UTC day, 1-1,000,000.                                                |
| `MAX_SELLER_SIGNUPS_PER_HOUR` | `500`                   | 1-1,000,000 new seller creations per hour.                                                      |

Mail budgets defer queued work without discarding encrypted keys. A healthy
server does not establish email deliverability. Monitor queued/failed mail and
exercise login and recovery through the configured SMTP provider.

## Workspace capacity

| Variable                 | Default | Accepted range                          |
| ------------------------ | ------- | --------------------------------------- |
| `MAX_TENANTS_PER_SELLER` | `3`     | 1-100.                                  |
| `TRIAL_DAYS`             | `14`    | 0-365. Hosted trial is seller-anchored. |
| `GRACE_DAYS`             | `7`     | 0-90. Does not extend buyer licenses.   |
| `TRIAL_STORAGE_MIB`      | `100`   | 1-102400 MiB.                           |
| `PAID_MAX_PRODUCTS`      | `20`    | 1-10000.                                |
| `PAID_STORAGE_MIB`       | `1024`  | 1-1048576 MiB.                          |

Hosted trials default to three products. The initial exempt standalone workspace
has no platform subscription requirement; existing per-workspace quotas do not
automatically resize when a paid-plan environment default changes. Operators
can deliberately update allowances through the authenticated status API.

## Upload, disk and transfer budgets

All MiB values use 1,048,576 bytes. GiB values use 1,073,741,824 bytes.

| Variable                       | Default  | Accepted range / purpose                                                              |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------- |
| `MAX_UPLOAD_MIB`               | `25`     | 1-100; WordPress ZIP cap.                                                             |
| `TRANSFER_MEMORY_MIB`          | `256`    | 6-65536; transfer buffers, not whole-process memory.                                  |
| `MAX_NATIVE_UPLOAD_MIB`        | `100`    | 1-2048; native asset cap.                                                             |
| `NATIVE_SPOOL_MIB`             | `4096`   | 2-65536; native publication disk reservation pool.                                    |
| `NATIVE_UPLOAD_TIMEOUT_MS`     | `120000` | 1000-3600000; native receive inactivity window.                                       |
| `ARTIFACT_CACHE_MIB`           | `4096`   | 1-65536; verified native-download disk cache.                                         |
| `ARTIFACT_CACHE_INFLIGHT_MIB`  | `2048`   | 1-65536; concurrent cache-fill reservation.                                           |
| `ARTIFACT_CACHE_TTL_MS`        | `300000` | 1000-86400000; idle entry lifetime.                                                   |
| `ARTIFACT_TRANSFER_TIMEOUT_MS` | `120000` | 1000-3600000; native transfer inactivity window.                                      |
| `MIN_DISK_FREE_MIB`            | `64`     | 0-1048576; free-space floor in addition to reservations.                              |
| `EXPORT_MAX_EXPORTS`           | `4`      | 2-10 creating or retained exports, at most one per tenant.                            |
| `EXPORT_MAX_GIB`               | `10`     | 1-10 GiB shared export reservation, including plaintext/ciphertext/manifest overhead. |

Startup enforces these relationships:

```text
TRANSFER_MEMORY_MIB >= 6 * MAX_UPLOAD_MIB
NATIVE_SPOOL_MIB >= 2 * MAX_NATIVE_UPLOAD_MIB
ARTIFACT_CACHE_MIB >= 2 * MAX_NATIVE_UPLOAD_MIB
MAX_NATIVE_UPLOAD_MIB <= ARTIFACT_CACHE_INFLIGHT_MIB <= ARTIFACT_CACHE_MIB
```

For a 2 GiB native cap, the publication pool and verified cache each need at
least 4096 MiB, with at least 2048 MiB cache-fill admission. Those pools are
separate. Provision the volume for both plus exports, database and free space.
WordPress memory budgeting remains independent.

Native operations have progress-based idle limits plus finite size-scaled total
limits. The transfer total is the idle window plus `ceil(size / 1 MiB per second)`
in milliseconds. An uncached range request verifies a full object first; cache
hits still authorize every request. See [deployment transfer details](deployment.md#native-artifact-disk-and-transfer-budgets).

## Billing worker resource limits

These ceilings apply to queued billing work, including explicit job runs. Each
job must supply complete canonical evidence before licenses, emails or platform
capacity change. Oversized jobs remain recoverable in the failed queue with
`resource_limit`; see [operator recovery](deployment.md#cli-and-reconciliation).

| Variable | Default | Hard maximum | Budget |
| --- | ---: | ---: | --- |
| `BILLING_WORKER_MAX_FACTS` | 10,000 | 50,000 | Combined checkpoint and normalized fact records for one queue job. |
| `BILLING_WORKER_MAX_MIB` | 16 | 64 | MiB of encrypted checkpoint and fact payloads for one job. |
| `BILLING_WORKER_MAX_APPLY_RECORDS` | 3,000 | 20,000 | Aggregate records materialized per turn, including existing plans, prices and grants. Reads stop before loading an oversized set. |
| `BILLING_WORKER_MAX_APPLY_WORK` | 1,000,000 | 10,000,000 | Conservative local operation units, including nested comparisons and query boundaries. |
| `BILLING_WORKER_APPLY_MS` | 5,000 | 30,000 | Separate finite local reconstruction/apply deadline, checked throughout the apply. |

All values are positive integers. The existing single-checkpoint 512 KiB and
single-fact 64 KiB bounds still apply. Check the reported budget before changing
a limit; raising one does not raise the others. Deadline checks occur between
SQL calls, with cancellation where the database driver supports it. A failed
apply completes rollback before its queue lease is released.

## Optional caches and outbound destinations

| Variable                 | Default   | Constraint / purpose                                                                                                                     |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_REDIS_URL`        | Omitted   | `redis://` or `rediss://`, no query/fragment; only price-picker cache uses Redis.                                                        |
| `CACHE_MEMORY_MIB`       | `8`       | 1-256 MiB bounded presentation cache.                                                                                                    |
| `CACHE_NAMESPACE`        | `entitle` | 1-64 alphanumeric, colon, underscore or hyphen characters. Separate deployments should use distinct namespaces.                          |
| `OUTBOUND_WEBHOOK_HOSTS` | Omitted   | Optional restriction. When set, only these exact public DNS names are accepted, comma-separated; no wildcards or private-address bypass. |

Presentation caching never supplies entitlement. Feed formatting stays in trusted
process memory; verified native bytes use the separate disk cache above. A Redis
failure falls back to source operations. No Redis service is required.

## CLI and fixture-only settings

`TENANT_SLUG`, `TENANT_API_KEY` and `OPERATOR_ORIGIN` configure remote
[CLI calls](cli.md). `TMPDIR` and pnpm's explicit store paths keep disposable
output on Scratch. `GO_BINARY` selects Go for the local S3 helper. `TEST_*` and
integration variables belong to isolated [verification](testing.md#release-checks), not
production service configuration.
