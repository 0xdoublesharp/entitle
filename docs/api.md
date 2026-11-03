# API v1

Use the deployment's common `PUBLIC_ORIGIN` as the base for every route below.
See [deployment](deployment.md) for the planned hosted address and
[platform support](platform-support.md) for supported framework adapters and integration limits.

Errors use `{error:{code,message,requestId}}`. Credentials belong in Authorization headers or request JSON, never package URLs. Responses containing identity, client secrets or customer data are `Cache-Control: no-store`. Requests have IDs and rate limits. No legacy unscoped licensing routes exist.

For task walkthroughs, start with [client integration](client-integration.md),
[seller guide](seller-guide.md), [CLI](cli.md), or [outgoing webhooks](webhooks.md).
The route tables below are relative to their stated prefix. `:tenant` is a
public workspace slug; a route parameter such as `:id` is the returned resource
ID. Do not substitute an internal tenant ID for its public slug.

## Credential selection and scopes

| Credential           | Authentication                           | Applies to                                                      |
| -------------------- | ---------------------------------------- | --------------------------------------------------------------- |
| Customer license key | JSON `key` in activation request         | One product's activation; never a seller credential.            |
| Installation token   | `Authorization: Bearer ACTIVATION_TOKEN` | Status, native feeds, protected packages and self-deactivation. |
| Buyer session        | Tenant-specific HttpOnly cookie          | Own licenses, downloads, billing, notices and privacy.          |
| Seller session       | Seller HttpOnly cookie                   | Owned workspaces and interactive owner-only actions.            |
| Seller API key       | `Authorization: Bearer DE-TK-...`        | Explicit tenant-bound scopes, expiry and revocation.            |
| Operator token       | Independent Bearer token                 | `/api/v1/operator`, separate from tenant routes.                |

| Seller key scope    | Operations                                                                            |
| ------------------- | ------------------------------------------------------------------------------------- |
| `read`              | Overview, price picker, safe jobs, features and basic/eligible advanced health reads. |
| `catalog:write`     | Save products and plan mappings.                                                      |
| `releases:write`    | Publish ZIPs/assets and withdraw releases.                                            |
| `licenses:write`    | Issue complimentary licenses, set/clear seller revocation and enabled local purchase fixtures. |
| `billing:reconcile` | Queue reconciliation, run tenant jobs and retry work/email.                           |
| `operations:write`  | Update operating settings and manage eligible webhook endpoints/deliveries.           |
| `data:export`       | Create, download and delete encrypted workspace exports.                              |

An allowed scope does not bypass ownership, paid capability or interactive-only
requirements. Keys default to `read` plus `releases:write` for 90 days, with a
maximum lifetime of 365 days. The service returns a raw key once. Prefix, scope,
expiry and last-used metadata can be listed later; raw keys/hashes cannot.

Use `Origin: PUBLIC_ORIGIN` and `X-CSRF-Token` for authenticated browser
mutations, using the CSRF value from the matching seller or buyer `/me`.
Sensitive seller browser actions also require their purpose-specific proof.
API keys do not use cookie CSRF or browser proofs, but cannot call owner-only
endpoints. Export ciphertext GETs are an explicit cookie-CSRF exception described
under portability below.

## Requests, responses and failures

JSON requests use `Content-Type: application/json`. Schemas reject unsupported
fields on strict request objects. Uploads use the raw media types documented
below; they are not multipart form requests. Activation/status `paidThrough` and
most business timestamps are Unix milliseconds. Outgoing webhook timestamp
headers use seconds; report days are UTC `YYYY-MM-DD` strings.

| Status | Meaning                                                                     |
| ------ | --------------------------------------------------------------------------- |
| 204    | No update offer; do not parse a JSON body.                                  |
| 400    | Invalid request, metadata, target or activation input.                      |
| 401    | Missing/invalid/revoked credentials or required sign-in.                    |
| 403    | Scope, ownership, current entitlement, capacity or paid capability denied.  |
| 404    | Resource unavailable within the authorized workspace.                       |
| 409    | Identity binding, immutable publication or other state conflict.            |
| 413    | Body exceeds the configured artifact limit.                                 |
| 416    | Native single-byte-range request invalid/unsupported.                       |
| 429    | Rate or queue/admission limit; inspect the code and Retry-After if present. |
| 503    | Dependency, storage-integrity or shared-capacity failure.                   |

```json
{
  "error": {
    "code": "not_entitled",
    "message": "Downloads and updates are unavailable for this license.",
    "requestId": "REQUEST_ID"
  }
}
```

Keep the request ID for support and use bounded retry for transient errors.
Inspect state before repeating an ambiguous publication or checkout. Do not
assume every mutation supports a caller-supplied idempotency header. Activation
retries use the stable installation ID; immutable version/target publication
conflicts rather than overwriting. Reverse proxies can return non-JSON failures.

Public marketing: `/`. Public docs: `/docs` and `/docs/`. Seller UI: `/seller`. Buyer UI: `/t/:tenant`. Tenant slugs are immutable. The server resolves them before business logic; ownership, scoped credentials and database constraints enforce isolation.

## Deployment modes

The licensing, customer, activation, release and updater APIs are shared by both
versions. Use your own `PUBLIC_ORIGIN`; a hosted seller uses their workspace
slug, while self-hosted standalone uses `primary`.

| Capability                                  | Hosted                                           | Self-hosted standalone                                                                 |
| ------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Seller access                               | Verified sellers and their workspace memberships | Only the configured `STANDALONE_OWNER_EMAIL`, assigned to `primary` after verification |
| Workspace creation                          | `POST /api/v1/platform/tenants`                  | Unavailable; use the existing `primary` workspace                                      |
| Stripe account                              | Connected seller account                         | Direct merchant account configured on the server                                       |
| Buyer webhook                               | `/api/v1/stripe/connect-webhook`                 | `/api/v1/stripe/merchant-webhook`                                                      |
| Platform billing webhook                    | `/api/v1/stripe/platform-webhook`                | Unavailable                                                                            |
| Connect and platform subscription endpoints | Available with the required seller session       | Unavailable                                                                            |
| Customer and software APIs                  | `/api/v1/tenants/YOUR_SLUG/...`                  | `/api/v1/tenants/primary/...`                                                          |

`uiMode: "hosted"` on a checkout request selects the Stripe-hosted checkout
interface. It is independent of `DEPLOYMENT_MODE=hosted`; both deployment modes
support Stripe-hosted Checkout and Elements. Browser success never confirms
payment. Server-controlled Stripe mappings, scoped credentials and webhook
confirmation apply to both versions. See [deployment](deployment.md) for the
mode-specific setup and database safety checks.

## Platform identity

Prefix `/api/v1/platform`:

GET /info includes deploymentMode and applicationFeePercent. In standalone,
auth/request only issues links for STANDALONE_OWNER_EMAIL and silently ignores
other addresses; a verified owner receives primary membership. POST /tenants,
GET /stripe/callback and seller /stripe/connect, /platform/checkout and
/platform/portal are unavailable. Only /tenants/primary business routes are
served. Hosted mode retains the multitenant behavior below.

Standalone receives signed raw merchant events at
/api/v1/stripe/merchant-webhook using STRIPE_WEBHOOK_SECRET and rejects
connected-account scope. Hosted uses platform-webhook and connect-webhook;
these are unavailable in standalone, and merchant-webhook is unavailable in
hosted. Mode and signature checks precede event persistence. Test/live modes
cannot be mixed. No browser callback grants entitlement.

In hosted deployment mode, checkout uses the server's configured application_fee_percent for new
subscriptions in both Checkout interfaces; sellers cannot set a fee in request
JSON. Standalone uses direct merchant Stripe context and omits stripeAccount
from Elements configuration. Existing subscriptions are not updated.

| Method | Route            | Input / behavior                                                                      |
| ------ | ---------------- | ------------------------------------------------------------------------------------- |
| GET    | /info            | Public product facts and configured upload cap                                        |
| POST   | /auth/request    | `{email}`; generic response, same-origin, expiring link bound to requesting browser   |
| POST   | /auth/consume    | `{token}`; same-origin, single-use link and browser nonce; sets secure seller session |
| GET    | /me              | Seller identity, CSRF token and tenant memberships                                    |
| POST   | /auth/logout     | `{}`; removes session                                                                 |
| POST   | /tenants         | `{slug,name}`; owner-only, serialized creation and trial/cap checks                   |
| GET    | /stripe/callback | Stripe OAuth code/state; bound to owner/session and fixed return URI                  |

Authenticated browser mutations require an exact `Origin: PUBLIC_ORIGIN` and `X-CSRF-Token` from the appropriate `/me`. Sessions are HttpOnly, SameSite=Lax, Secure in production. Seller and buyer credentials are separate; buyer cookies are tenant-specific. Email tokens in fragments are removed before submission and require explicit confirmation.

## Tenant buyer / software API

Prefix `/api/v1/tenants/:tenant`:

| Method   | Route                                            | Input / behavior                                                                                                                      |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| GET      | /catalog                                         | Tenant name, products and plan IDs/allowances                                                                                         |
| POST     | /checkout                                        | `{planId,email,uiMode?:"hosted"\|"elements"}`; server resolves price/account; existing email requires buyer sign-in                   |
| POST     | /activate                                        | `{key,installationId,siteUrl?,installationLabel?,product}`; stable installation ID, transactional allowance, retry returns same token |
| GET      | /activation                                      | Installation bearer token; current entitlement and billing status                                                                     |
| POST     | /deactivate                                      | Installation bearer token, `{}`                                                                                                       |
| GET      | /updates/:product                                | Installation bearer; WordPress metadata or 204; stable credential-free package URL                                                    |
| GET      | /packages/:releaseId                             | Installation bearer; rechecks entitlement, token, product and withdrawal; verified ZIP bytes                                          |
| POST     | /auth/request                                    | `{email}`; same-origin, generic response and per-address suppression                                                                  |
| POST     | /auth/consume                                    | `{token}`; same-origin, expiring single-use login; tenant buyer cookie                                                                |
| POST     | /auth/logout                                     | `{}` and buyer CSRF                                                                                                                   |
| GET      | /me                                              | Own licenses, effective paid allowances, installations, releases and CSRF token                                                       |
| POST     | /licenses/:id/key                                | `{}` and buyer CSRF; replaces key and revokes previous installation tokens                                                            |
| POST     | /installations/:id/deactivate                    | `{}` and buyer CSRF; own installation only                                                                                            |
| GET      | /licenses/:id/releases/:releaseId/download       | Buyer session; authorized WordPress ZIP download                                                                                      |
| GET/HEAD | /licenses/:id/assets/:assetId/download           | Buyer session; own license and entitled native asset                                                                                  |
| GET/HEAD | /packages/:product/assets/:assetId/:filename     | Activation bearer; native asset, exact tenant/product/filename, rechecks entitlement                                                  |
| GET      | /updates/joomla/:product.xml                     | Activation bearer; native Joomla discovery XML                                                                                        |
| GET      | /updates/joomla/:product/releases/:releaseId.xml | Public immutable details metadata required by Joomla's unauthenticated native reload; no credentials or artifact bytes                |
| GET      | /updates/electron/:product/:target/:filename     | Activation bearer; Electron YAML; see channel names below                                                                             |
| GET      | /updates/tauri/:product/:target/:currentVersion  | Activation bearer; signed native JSON or 204                                                                                          |
| GET      | /updates/sparkle/:product/:target/appcast.xml    | Activation bearer; signed enclosure XML                                                                                               |
| GET      | /updates/jetbrains/:product/updatePlugins.xml    | Activation bearer; custom repository XML                                                                                              |
| GET      | /updates/generic/:product/:target                | Activation bearer; JSON assets, optional currentVersion query; 204 if no newer release                                                |
| POST     | /portal                                          | `{}` and buyer CSRF; connected Stripe Customer Portal                                                                                 |

Hosted checkout returns `{url}`. Elements returns `{uiMode:"elements",clientSecret,publishableKey,stripeAccount,returnUrl}`. Initialize the official Stripe.js loader with that publishable key and `stripeAccount`, then `initCheckoutElementsSdk({clientSecret,elementsOptions:{appearance:...}})`. Mount the Payment Element, load actions, display Stripe's canonical total and confirm through Stripe. Keep secrets only in memory. Neither a successful confirmation nor the return URL grants entitlement. Card details go directly to Stripe. See [Elements design](architecture.md#checkout-and-billing).

A seller's independent website can proxy guest checkout and render its own Elements form if it relays the issuing browser's HttpOnly checkout cookie, including on a provider error response. That claim allows retries only for its unpaid, unlicensed customer; it is not a buyer session. Existing customers must sign in through the hosted buyer flow or a complete same-origin session proxy. No general cross-domain authentication bridge is included. Customer-session cross-origin CORS is intentionally disabled. Never put tenant automation keys into browsers or plugin ZIPs. The server controls the return URL.

Update metadata returns `{name,slug,version,download_url,requires,requires_php,min_free,tested,sections:{changelog},sha256}`. Package URLs never expire merely because cached metadata is old. Current expiry, revocation, suspension or withdrawal can still deny a cached offer. Authenticate only the exact configured tenant package path, reject redirects, and verify SHA-256. Status must never gate installed plugin features.

Framework feeds and package URLs are stable and contain no token. Native downloads support GET/HEAD, `Accept-Ranges: bytes`, a single byte range (206), and invalid-range responses (416). A cached offer does not grant future entitlement. An uncached request verifies the complete stored artifact into a bounded private disk cache before returning any bytes, even for a range. Cache hits reuse verified files, including leased entries after TTL expiry when their identity still matches. Every request rechecks access and withdrawal; native S3 range reads are deferred. A busy response returns ordinary JSON without attachment/checksum/range headers. Response/download metrics count completed served transfers and actual response bytes, including partial responses, rather than installed copies. Storage-read counters reflect full verification reads, not every cache hit. Joomla's public details document contains only the product identity, immutable version/notes/checksum and protected package URL; discovery and all package downloads still require the activation bearer. Withdrawal removes the details document too.

Electron channels are `latest.yml`, `latest-mac.yml` for Darwin targets, `latest-linux.yml` for linux-x64 and `latest-linux-arm64.yml` for linux-arm64. No deltas or blockmaps are generated. JetBrains may append bounded `build`, `os` and `arch` query values. Credentials in queries are rejected. Tauri and Sparkle assets require seller-generated signatures; public keys belong in each app, private signing keys remain in its build system.

WordPress and Joomla use site activations. Electron, Tauri, Sparkle and JetBrains use devices. Generic products default to devices and can explicitly select sites with `frameworkConfig.activationKind`. Device requests omit `siteUrl`, persist a random installation ID and may submit a label. Retry for the same installation returns the existing activation token. API fields named `siteAllowance` continue to represent paid seats for either kind. `GET /me` returns each license's framework/configuration and target-specific release assets; installation records include the optional label. Catalog and seller overview include product framework/configuration, and seller release records include asset inventories.

Site normalization lowercases hostname, removes scheme/default ports, query/fragment and trailing path slashes; paths and nondefault ports remain distinct. URLs are metadata and never fetched. Changed URLs require deactivation before reactivation. Development suffix exemptions are explicit operator configuration and match exact hosts or dot-separated suffixes.

## Tenant seller API

Prefix `/api/v1/tenants/:tenant/seller`. Interactive owners use seller sessions + CSRF. Automation uses scoped, expiring `Authorization: Bearer DE-TK-...`; keys are tenant-bound and returned once. Read requests require `read`. Key management, Connect and platform billing require an interactive owner.

| Method | Route                       | Scope / behavior                                                                                              |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| GET    | /overview                   | read; tenant, products/plans, safe licenses/releases and measured metrics                                     |
| GET    | /licenses/:id               | read; one tenant license and safe installation records, `limit` 1–500 (default 100), optional `after` cursor; returns `nextCursor` |
| GET    | /prices                     | read; active annual connected-account prices; local fixtures clearly labeled                                  |
| POST   | /products                   | catalog:write; `{slug,name,framework?,frameworkConfig?,pluginBasename?,plans:[{name,siteAllowance,priceId}]}` |
| POST   | /releases/:product/:version | releases:write; WordPress raw ZIP and base64url JSON `X-Release-Metadata`                                     |
| POST   | /assets/:product/:version   | releases:write; native raw bytes and base64url JSON `X-Release-Metadata`                                      |
| POST   | /releases/:id/withdraw      | releases:write; `{}`; retains private artifact                                                                |
| POST   | /licenses/:id/revoke        | licenses:write; `{revoked:boolean}`; does not clear refund/dispute restrictions                               |
| GET    | /keys                       | Interactive owner; prefix, scopes, expiry/last-used; no raw key/hash                                          |
| POST   | /keys                       | Interactive owner; `{name,scopes?,expiresInDays?}`; defaults read+releases:write,90 days,max365               |
| POST   | /keys/:id/revoke            | Interactive owner; `{}`                                                                                       |
| POST   | /stripe/connect             | Interactive owner; `{}`; Standard OAuth URL                                                                   |
| POST   | /platform/checkout          | Interactive owner; `{tier?:"starter"\|"pro"}`; separate SaaS subscription, defaults Starter                   |
| POST   | /platform/portal            | Interactive owner; `{}`                                                                                       |
| POST   | /reconcile                  | billing:reconcile; `{subscriptionId?:string}`; discovery or one subscription; no charge                       |
| GET    | /jobs                       | read; safe states/attempts/errors, no payloads                                                                |
| POST   | /jobs/run                   | billing:reconcile; `{}`; bounded tenant work only                                                             |
| POST   | /jobs/:table/:id/retry      | billing:reconcile; `{}`; failed work/emails in this tenant only                                               |
| POST   | /jobs/:table/retry-failed   | billing:reconcile; `{limit?:1..500}`; defaults to 100 failed work/emails in this tenant                       |
| POST   | /local/purchase             | licenses:write; `{planId,email,subscriptionId?}`; development fixtures only                                   |

Framework values: `wordpress` (default), `joomla`, `electron`, `tauri`, `sparkle`, `jetbrains`, `generic`. Configuration defaults to `{}` except Joomla and JetBrains, which need identity/compatibility fields. Joomla: `{extensionType,element,joomlaMajor,folder?,client?}`; plugins require folder, modules/templates/libraries/packages require client (`site` or `administrator`). JetBrains: `{pluginId,sinceBuild,untilBuild?}`. Generic: `{activationKind?:"site"|"device"}`. Other frameworks accept an empty configuration only. Once a product has a license or release its framework/configuration cannot change. `pluginBasename` applies only to WordPress.

Native asset upload uses `Content-Type: application/octet-stream`, required `Content-Length`, and metadata `{target,filename,changelog,signature?,minSystemVersion?}` in base64url JSON `X-Release-Metadata`. Native changelog is at most 6,000 characters. The default native cap is 100 MiB, hard ceiling 2 GiB, separate from WordPress. Bodies spool to private files and reserve two disk copies through publication/readback. Receive deadlines bound inactivity and total duration. The encoded header is capped at 12,288 bytes. Version is strict SemVer. Target/extension, archive content and product identity are validated for the framework. Filenames are safe display names, never storage paths. Publishing stores and verifies immutable bytes before committing an asset; duplicate targets fail and another target can join the same version only with identical release notes. Parent release size is the sum of its assets. All targets share withdrawal and count against quota. See [platform support](platform-support.md) for target names, formats and validation boundaries. New CLI examples live under `examples/generic/`.

WordPress release metadata: `{changelog,minWp?,minPhp?,minFree?,tested?}`. Defaults 6.0/8.0/0.0.0/0.0.0 respectively. Authentication precedes parsing. Default WordPress cap 25 MiB, hard ceiling 100 MiB. Changelog schema permits 30,000 characters, but the entire encoded metadata header must fit 12,288 bytes. Publication verifies paths, CRC, expansion/entries, plugin identity/version, SHA-256 and private storage before committing metadata. Withdrawn objects remain stored and count against quota.

Catalog setup preserves immutable price-to-product and allowance mappings. Add a new Stripe price to change seats. A future paid plan takes effect at its paid period start; overlapping paid grants retain the larger allowance through its paid period. No unpaid upgrade grants seats.

### Complimentary issuance

`POST /api/v1/tenants/:tenant/seller/licenses/complimentary` requires the workspace
owner's browser session with Origin/CSRF, or a workspace key with `licenses:write`.

```json
{
  "email": "pilot@example.com",
  "productId": "PRODUCT_ID",
  "siteAllowance": 2,
  "expiresAt": 1893456000000,
  "note": "Invited pilot",
  "requestId": "bc2ac459-fd7b-4f49-a6f6-f52b57c35c0b",
  "confirm": true
}
```

`expiresAt` is a future Unix millisecond timestamp, `siteAllowance` is 1–100000,
and the optional internal `note` is at most 2000 characters. The product must
belong to this workspace; it needs no paid plan or Stripe price. The response is
`{id,customerId,emailQueued:true}`. No raw key is returned. The existing encrypted
license-key outbox delivers it to the normalized customer email.

Keep the same UUID and identical details when retrying an uncertain submission.
The transaction reuses its committed result without issuing another key or
email, including after expiry or key replacement. Different details with the
same UUID return `409 idempotency_conflict`. A new intended license needs a new
UUID. The email queue uses the existing at-least-once SMTP transport and stable
message ID; a lost SMTP acknowledgement may still cause provider redelivery.

Seller overview and buyer `/me` license records include `provenance` (`paid` or
`complimentary`) and `expires_at` (milliseconds or null). Internal notes appear
only in authorized seller data. Complimentary rows have no plan, subscription,
invoice or paid grant and retain `paid_through:0`; activation/status `paidThrough`
continues to mean the access deadline for client compatibility. Expiration uses
the same activation, seat, private package and update checks as paid entitlement.
Existing revocation/restoration and buyer key replacement apply normally.

`billingAvailable` describes provider configuration in seller overview and paid
availability in buyer catalog/account responses. Without primary Stripe
configuration, paid checkout, price validation, portal and reconciliation return
`503 billing_unavailable`; webhook and billing workers cannot apply provider
state. Configure and verify Stripe before enabling paid operations. Complimentary
issuance never charges or enrolls the customer, including after Stripe is added.

## Platform operations and webhooks

`/api/v1/operator` requires the independent platform operator token: GET `/tenants`, POST `/tenants/:id/status` (`suspended`, `exempt`, `maxProducts`, `maxStorageBytes`), POST `/tenants/:id/owner` (`email`, verified seller), POST `/tenants/:id/reconcile`, GET `/jobs`, POST `/jobs/run`, POST `/jobs/:table/:id/retry` (platform_work/platform_emails). Local fixture configuration is POST `/local/tenants/:id` (`connected?`, `paidDays?`, at least one).

`POST /api/v1/stripe/platform-webhook` verifies the raw body with the platform signing secret and rejects connected events. `POST /api/v1/stripe/connect-webhook` uses the separate Connect secret, requires account+configured mode, and resolves the immutable account mapping. Events and work commit before acknowledgment. Duplicate and reordered events reconcile canonical state. Provider failures retry without erasing purchased grants.

After signature verification, Connect events from the other Stripe mode return `200 {ok:true,ignored:true}` without being persisted. Operator bulk recovery is `POST /api/v1/operator/jobs/:table/retry-failed` for platform_work/platform_emails, with the same optional limit. Explicit individual or bulk retry starts a new 72-hour retry window without discarding the retained payload.

`GET /api/v1/health` is process liveness. `GET /api/v1/ready` checks database, S3 bucket access and private working-directory access. Both return generic failures without credentials.

Platform delinquency blocks new capacity and purchases after grace, while existing buyers retain paid downloads, activation/recovery and billing reconciliation. Explicit abuse suspension blocks tenant business service; platform billing/key recovery and operator routes remain available. Neither state remotely disables installed software.

## Account security and sensitive actions

Seller account routes use `/api/v1/platform/account` with an interactive seller
session. Authenticated mutations require the normal same-origin Origin and CSRF
headers. `GET /sessions` lists only the current seller's sessions. POST
`/sessions/revoke` accepts `{id}`; `/sessions/revoke-others` and
`/sessions/revoke-all` accept `{}`. Revoking the current session requires signing
in again.

POST `/verification/request` accepts `{purpose}` and emails a browser-bound,
expiring token. POST `/verification/consume` accepts `{purpose,token}` and returns
`{verification,expiresIn}`. The returned proof lasts five minutes and can be used
once for that purpose and session. Send it in `X-Account-Verification` when
creating/revoking API keys (`api_keys`), publishing releases from the browser
(`release_publish`), or creating a workspace export (`tenant_transfer`). CI
publication remains authenticated by a scoped API key. A failed action requires
a new proof. Never save proofs in browser storage or URLs.

POST `/recovery-codes` accepts `{verification}` for purpose `recovery_codes` and
returns replacement one-use recovery codes once. Store them offline. Signed-out
recovery calls `/recovery/start` first, then `/recovery/consume` with `{email,code}`
in that same browser. Email changes call `/email-change/request` with `{email}`,
then `/email-change/confirm` with `{id,currentToken,newToken}`. Both mailboxes must
approve in the requesting session. Standalone email changes remain an operator
configuration procedure.

## Sandbox, commerce and operations

All paths below are relative to `/api/v1/tenants/:tenant/seller`.

| Method    | Path                              | Behavior                                                                                     |
| --------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| GET       | `/features`                       | Current core and Pro capabilities; exemptions never grant hosted Pro                         |
| GET       | `/sandbox`                        | Server-confirmed environment and Stripe-test availability                                    |
| POST      | `/sandbox`                        | `{mode:'fixture'\|'stripe'}`; one isolated child workspace, immutable mode |
| POST      | `/sandbox/purchase`               | `{planId}`; fixture child only, delivery to the verified seller's email                      |
| GET / PUT | `/commerce/settings`              | Server-controlled automatic tax, tax-ID and address collection                               |
| PUT       | `/commerce/products/:id/tax-code` | `{taxCode:null\|'txcd_########'}` on the seller's Stripe product         |
| GET       | `/operations`                     | Basic queue, storage, byte/read counters, persisted alerts and settings                      |
| PUT       | `/operations/settings`            | Bounded threshold, cooldown and lifecycle-notice settings                                    |
| GET       | `/operations/reports?days=30`     | Hosted Pro or standalone; daily served-response and byte/read aggregates                     |
| GET       | `/webhooks`                       | Hosted Pro or standalone; endpoints and safe delivery states                                 |
| POST      | `/webhooks`                       | `{url,events}`; returns a signing secret once                                                |
| POST      | `/webhooks/:id/rotate`            | `{}`; returns replacement secret once, preserves undelivered events under the new generation |
| DELETE    | `/webhooks/:id`                   | Disables endpoint and cancels queued deliveries                                              |
| POST      | `/webhook-deliveries/:id/retry`   | `{}`; retries a failed delivery using its 64-character hashed ID                             |
| POST      | `/platform/checkout`              | `{tier?:'starter'\|'pro'}`; optional tier defaults to `starter`; server-selected platform price                  |

Operations mutations accept `operations:write` API keys and reads use `read`. That scope can create and rotate endpoint signing secrets, which are returned once; grant it only to trusted automation.
Commerce and sandbox management require interactive owner sessions. A sandbox
has a distinct tenant, buyer URL, customers, licenses, activation tokens and
artifact namespace. Its capacity and Pro entitlement follow the live parent;
the test workspace does not consume another live-workspace slot. Fixture
purchases do not charge money and cannot target an arbitrary customer email.
Stripe test mode requires a separate complete operator-configured test key set.
Only signed test events enter mapped Stripe-test sandboxes.

Automatic tax is opt-in. The merchant must activate Stripe Tax and configure its
registrations. Tax codes and all checkout settings are validated against that
merchant's account. The service is not a merchant of record or a substitute for
accounting/tax advice. Hosted Checkout and Elements use the same server mappings.

## Customer notices and privacy

Relative to `/api/v1/tenants/:tenant`, authenticated buyers can GET `/notifications`
and POST `/notifications/:id/dismiss` with `{}`. A foreign notice is never changed;
the response does not disclose whether it exists. GET `/account/export` returns
an allowlisted JSON export of the current customer. POST `/account/closure`
records an idempotent closure request; GET returns its status, blockers and
retention plan. These requests never cancel subscriptions, revoke paid rights,
or disable installed software. Completion is an operator maintenance procedure
after explicit financial reconciliation and retention review. Minimal financial
and security receipts remain retained. See the operator guide before erasure.

Encrypted publisher transfers are core, not Pro. See [portability](portability.md)
for `POST /exports` creation, `GET /exports` recovery metadata, ciphertext downloads,
`DELETE /exports/:id` cleanup, expiration and fresh standalone import. Recovery metadata
contains only the authenticated workspace's export IDs, statuses, expiry times and blob IDs. Cookie-authenticated ciphertext GETs require `X-CSRF-Token` but do not
require an Origin header; mutations retain both Origin and CSRF checks. Scoped
`data:export` API keys authorize export operations without an interactive proof.

Completed customer closures retain minimal, mode-scoped attribution receipts.
Matching late provider events are stored without their full payload and do not
create reconciliation jobs or restore customer identity. Missing canonical
customer attribution is retryable. Operator `closure-inspect` and blocked approval
list the exact record IDs by table needed for reviewed reconciliation; neither
returns decrypted provider payloads. See [operator maintenance](operator-maintenance.md).
