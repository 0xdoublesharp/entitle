# Architecture

Entitle runs as one Fastify application. It serves the versioned API, built Vue
interfaces and database-backed jobs. A private S3-compatible bucket stores
release bytes. SQLite, PostgreSQL and MySQL share the Knex business layer;
Redis is an optional cache, not a prerequisite for licensing.

## Components and entrypoints

| Area | Responsibility |
| --- | --- |
| `src/app.ts`, `src/server.ts` | HTTP composition, tenant context, job scheduling and shutdown |
| `src/db.ts`, `src/migrations/` | Shared schema, migrations, constraints and transaction locking |
| `src/licensing.ts`, `src/billing.ts`, `src/stripe.ts` | Buyer rights, installations and canonical merchant billing |
| `src/platform-auth.ts`, `src/auth.ts`, `src/account-management.ts` | Seller/buyer sessions, proofs, recovery and privacy |
| `src/tenants.ts`, `src/platform-billing.ts`, `src/plan-features.ts` | Workspace boundaries, platform billing and hosted capabilities |
| `src/releases.ts`, `src/artifacts.ts`, `src/artifact-streams.ts`, `src/storage.ts` | Publication, integrity, private storage and bounded downloads |
| `src/frameworks.ts`, `src/update-adapters.ts`, `src/framework-api.ts` | Framework identity, native feeds and packages |
| `src/business-events.ts`, `src/operations.ts`, `src/outbound-webhooks.ts` | Durable business events, operational metrics and signed delivery |
| `src/portability.ts`, `src/privacy-attribution.ts`, `src/maintenance-cli.ts` | Encrypted transfer and offline maintenance |
| `web/`, `examples/` | Public/seller/buyer interfaces and client integration examples |

See [API](api.md) for exact routes and [configuration](configuration.md) for
limits. Internal module signatures are maintained in TypeScript, not copied here.

## Isolation and identity

A workspace owns its products, prices, customers, licenses, installations,
releases and jobs. Public routes select it through `/api/v1/tenants/:tenant`.
Services receive explicit tenant context; a caller-supplied object ID, provider
metadata or site URL does not establish ownership. Composite database constraints
also reject cross-tenant relationships.

Seller sessions require current workspace membership. Seller automation keys
are tenant-scoped, hashed and permission-limited. Buyer sessions, license keys
and activation tokens have separate authority. Operator credentials use separate
routes and are never distributed to clients.

Email links are single-use. Seller links are bound to the browser that requested
them. Sessions are server-side, and protected mutations require same-origin and
CSRF checks. Sensitive actions consume purpose-specific proofs. The
[seller guide](seller-guide.md) covers these workflows.

## Complimentary entitlement

Complimentary licenses are ordinary license rows with explicit provenance, an
expiration, allowance and issuance actor/time. Their plan/subscription references
are null and paid-through remains zero. Issuance serializes customer mapping with
billing and commits customer reuse/creation, the hashed key, encrypted outbox,
audit and business event together. A workspace-scoped request UUID and payload
digest make ambiguous retries safe. The raw key appears only in encrypted email
payloads and the existing authenticated key replacement response.

The common entitlement check reads complimentary expiry or paid-through, then
applies the same restrictions. Paid grant projection and Stripe reconciliation
cannot alter complimentary allowances or entitlement. Invoice metrics remain
provider-backed; complimentary licenses are never reported as revenue. Production
can run with primary Stripe settings omitted; provider jobs pause while email,
activation and private distribution continue. Installed software stays usable
after expiry. No client changes or automatic subscription enrollment are involved.

## Checkout and billing

Buyer checkout uses server-controlled product/price mappings in the publisher's
Stripe account. Both Stripe-hosted Checkout and Elements use Checkout Sessions.
The Elements client receives only the publishable configuration and short-lived
session secret needed by Stripe.js; card fields are Stripe-hosted.

Verified webhooks persist raw-body-authenticated event receipts. Durable jobs
retrieve canonical provider state and apply paid grants transactionally.
Redirects, browser payment confirmation and event arrival order do not grant
licenses. Reconciliation is idempotent and retryable.

Billing status, paid-through dates, explicit revocation and disputes remain
separate. Cancellation preserves purchased time; unpaid upgrades add no seats.
Full refunds revoke future download access, partial refunds preserve entitlement
unless explicitly revoked, and open disputes suspend access pending reconciliation.
No billing event remotely disables installed software.

Hosted platform subscriptions are separate from buyer licenses. Starter/Pro
capabilities follow paid grants; a bounded renewal-retention policy protects
eligible pending events without enabling unpaid Pro features. Platform delinquency
preserves buyers' existing paid download and recovery rights. See
[hosted billing](hosted-pricing.md) for the enforced plan-change policy.

## Activation and updates

A high-entropy license key is stored as a hash. Encrypted retry material and a
durable email outbox make initial issuance recoverable without duplicate licenses.
A stable installation ID receives a scoped token. Transactional locking enforces
seat limits on each supported database. Site URLs are metadata and are not fetched.

Clients discover updates through framework-specific feeds and download through
stable application URLs. Every download rechecks ownership, token validity,
entitlement and withdrawal state. Private storage credentials never reach clients.
Clients verify checksums and required platform signatures while preserving their
installed functionality through expiry and service outages.

## Storage and background work

Publication validates a package, reserves quota, stores immutable bytes and
verifies readback before committing a release. Withdrawal hides a release but
retains its artifacts and storage charge. Native downloads use bounded verified
disk spools; upload and transfer limits are operational controls, not promises
of unlimited streaming. [Deployment](deployment.md) documents the budgets.

Jobs use database leases, bounded batches and retries. Email and outgoing webhook
delivery are at least once; consumers must deduplicate stable event IDs. Tenant
admission and cleanup failures must not stall unrelated billing or delivery.

Entitlements, sessions and artifact bytes are not trusted to a presentation cache.
Redis caches provider price data; update-feed rendering stays local. Cache failure
falls back to the authoritative source. See deployment for TLS and ACL requirements.

## Change boundaries

Keep migrations forward and restart-safe across all three engines. Back up the
database, immutable objects and application secret together. Branding changes
must not silently change persisted encryption domains, transfer format markers
or provider idempotency keys; those require a deliberate protocol migration.

Publisher transfers preserve paid rights and reviewed privacy state while
rekeying customer attribution under the destination secret. Source application
secrets, sessions and automation credentials are excluded. Use the
[portability](portability.md) and [maintenance](operator-maintenance.md) procedures.
