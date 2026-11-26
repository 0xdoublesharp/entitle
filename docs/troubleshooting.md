# Troubleshooting

Start with the request's HTTP status, structured error code and `requestId`.
Record the affected origin, workspace slug, product, framework, version and
target. Keep customer email, keys, cookies, account proofs, passphrases and
provider payloads out of shared logs. A generic infrastructure error needs
operator inspection; it is not a reason to retry a payment or reset a database.

## Sign-in and account security

| Symptom                            | Check                                                                                          | Recovery                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Emailed link fails                 | Check the deployment, sign-in page, and link expiration. Seller links also require the browser that requested them. | Request a fresh link from the seller or buyer sign-in page. |
| Standalone seller receives no link | Requested email matches normalized `STANDALONE_OWNER_EMAIL`; SMTP delivery and platform queue. | Operator corrects intended configuration or mail delivery. Other emails receive a generic response. |
| Seller link fails in another browser | Seller sign-in links are bound to the browser that requested them. | Request a fresh link in the browser where you want to sign in. |
| Mutation returns `csrf_denied`     | Correct seller/buyer `/me`, matching CSRF token, active session.                              | Refresh identity/CSRF in that session and retry the intended action.                                |
| Mutation returns `origin_denied`   | Request Origin exactly matches the deployment origin.                                        | Correct the request origin or intended deployment configuration before retrying.                   |
| Sensitive action rejects proof     | Purpose/session match, five-minute lifetime, proof not previously consumed.                    | Request and consume a fresh action-specific email confirmation.                                     |
| Recovery code fails                | Start and consume recovery in the same browser; code unused and from latest set.               | Use another current code or normal verified email recovery.                                         |

Seller cookies and tenant-specific buyer cookies cannot substitute for each
other. A checkout claim cookie only permits retry for its unpaid guest customer;
it is not a buyer session. Existing buyer email at checkout requires buyer sign-in.

## Automation authorization

Check the API key's tenant, expiry, revocation and scopes. `read` cannot publish;
`releases:write` cannot change plans; `billing:reconcile` cannot manage keys.
Owner-only endpoints reject API keys even when another scope seems relevant.
Export uses the dedicated `data:export` scope, and operations changes use
`operations:write`. Consult [credential selection](api.md#credential-selection-and-scopes).

For CLI failures before an HTTP request, check `TENANT_SLUG`, the key format and
the origin. `PUBLIC_ORIGIN` must be an origin without a path. Operator commands
use `OPERATOR_ORIGIN` when set and require `OPERATOR_TOKEN` instead of a tenant
key. Never switch to an operator credential to work around a publisher scope.

## Activation and seats

| Symptom                                     | Likely cause                                                     | What to do                                                                                |
| ------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `invalid_license`                           | Wrong/replaced key or wrong workspace.                           | Buyer verifies workspace and current key through their account.                           |
| `invalid_activation`                        | Token missing, deactivated or invalidated by key replacement.    | Activate again with the current key and stable installation ID.                           |
| `wrong_product`                             | License or token belongs to another product.                     | Correct the product configuration; do not share one token across products.                |
| `invalid_site` / `invalid_activation_input` | Missing site URL or site URL sent for a device.                  | Use the product's configured activation kind.                                             |
| Site binding conflict                       | Installation ID reused on a different normalized site.           | Deactivate the old binding before moving it.                                              |
| Allowance exhausted                         | All paid seats used, or the client generates a new ID each time. | Deactivate an unused installation and persist IDs across updates.                         |
| Allowance upgrade missing                   | Invoice unpaid or future paid period not started.                | Inspect canonical invoice/grant timing; reconcile instead of manually increasing history. |

Development hostnames are exempt only when explicitly configured by the
operator. Renaming a production host to resemble staging does not create an
exemption. Installed functionality must remain usable while license settings
and download access are being resolved.

## Payment and entitlement

A browser success page, Elements confirmation or active subscription status is
not enough to grant paid rights. Check the matching merchant account, Stripe
mode, configured price, canonical invoice settlement and durable work state.

1. Confirm which deployment mode receives the payment. Standalone uses the
   merchant webhook; hosted uses separate platform and Connect webhooks.
2. Verify the webhook destination, event mode and signing secret. A secret for
   a different endpoint does not authenticate this one.
3. Inspect safe tenant job state with `pnpm cli jobs` or the dashboard.
4. Reconcile the known subscription with `pnpm cli reconcile sub_REPLACE`.
5. Resolve provider/authentication failures before explicitly retrying failed
   work. Check the resulting license paid-through and allowance.

Do not open another Checkout Session or create another charge to repair missing
local state. If a customer funded a purchase with provider credit, reconciliation
must validate the qualifying canonical ledger; a zero cash amount alone does
not decide paid entitlement.

Canceled renewal preserves purchased time. Full refunds revoke future downloads;
partial refunds do not. Open/lost disputes suspend access. Clearing a seller's
manual revocation cannot clear independent refund/dispute restrictions.

Hosted platform delinquency can block new capacity and purchases while existing
buyers retain paid rights. Explicit abuse suspension is separate. Pro access
requires reconciled paid grants; a trial or operator capacity exemption is not
Pro. Tier changes follow the cancellation/paid-period policy in
[hosted pricing](hosted-pricing.md).

## Publication

| Failure                           | Inspect                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 413 or size validation            | Separate WordPress/native cap from `/api/v1/platform/info`, proxy body cap, quota and actual file size.                     |
| Archive/package rejected          | Framework target, filename extension, path safety, expansion/entry limits and embedded product/version identity.            |
| Signature rejected                | Tauri signature encoding/format or Sparkle base64 EdDSA metadata; sign the exact uploaded artifact.                         |
| Immutable target/version conflict | Existing release inventory and identical release notes for additional targets. Publish corrected bytes under a new version. |
| Timeout or disconnect             | Uplink progress, configured idle/total deadlines and proxy timeout; inspect release state before retry.                     |
| Storage admission busy            | Active publication/cache/export reservations, free-space floor and host filesystem capacity.                                |
| Workspace capacity                | Existing and reserved storage, retained withdrawn releases, product count and hosted platform state.                        |

Native upload requires `Content-Length` and a regular source file for the CLI.
Do not use chunked publication as a substitute for declaring length. Raising
the native cap also requires compatible spool/cache budgets and enough actual
disk. Raising WordPress ZIP limits requires at least six times the cap in
transfer-memory budget. See [configuration](configuration.md#upload-disk-and-transfer-budgets).

Do not delete release objects, clear reservations blindly or replace immutable
bytes to make a publication succeed. A timeout can leave an ambiguous storage
operation. Inspect task ownership and provider state before any cleanup.

## Update checks and package downloads

A 204 is an expected no-offer result. Check the exact product, framework,
target, current version and availability of a newer target-specific release.
WordPress can return the latest metadata even when that version is installed;
the client performs its own version comparison.

For a failed package request, inspect current license state, token validity,
withdrawal and package-path scope. Old feed metadata does not bypass those
checks. A direct unauthenticated S3 request should fail because objects are
private. Clients should use the protected application URL rather than signing
their own storage requests.

Native range downloads first verify a complete object when the disk cache is
cold. A range can therefore cause a full storage read. Valid single ranges
return 206; malformed/multipart ranges return 416. Capacity errors remain JSON,
not truncated package bytes. Do not treat a JSON error body as an installer.

Check client origin/path verification and redirect rejection if authentication
works on status but fails on a native updater. Joomla needs its installer plugin
for protected discovery/package requests. Tauri/Sparkle must use the public key
corresponding to the build's private signing key. Electron's channel filename
must match the target. See [client integration](client-integration.md).

## Mail and background work

The server polls durable jobs every five seconds. Inspect pending/failed counts,
attempts, available time and oldest age. A pending item can be waiting for
backoff, a lease, or the daily mail budget. SMTP refusal and provider failure
need different remedies.

Check host/port, TLS mode, credentials, sender authorization and provider
deliverability. Production requires implicit TLS or STARTTLS. The ordinary
readiness probe does not send mail. Missing email with a healthy probe is possible.

Failed billing/email work retries within 72 hours, then remains for explicit
individual or bounded bulk retry. Mail budget deferral preserves keys. SMTP
delivery is at least once when an acknowledgment is lost; a duplicate key email
does not imply another license or charge.

## Outgoing webhooks

Check Pro/standalone eligibility, subscribed event type, endpoint active state,
queue state, public DNS, TLS and a direct 2xx acknowledgment. Redirects and
private/mixed-address DNS are refused. The operator's exact-host allowlist may
further restrict destinations.

For signature mismatches, verify the exact raw request bytes, literal secret,
timestamp in seconds, event-ID header and `v1=` prefix. Check clock skew within
five minutes. JSON parsing/reserialization before verification changes the signed
bytes. A rotated secret applies to later delivery generations. Keep event-ID
deduplication durable across retries and rotation.

See [webhooks](webhooks.md) for the full signature helper and retry policy.

## Export, import and closure

An active export blocks a second one for that tenant until deletion/expiry. Refresh exports lists saved handles after a reload; resume or delete your own bundle there.
Shared export reservations, free disk or the manifest cap can block admission.
Download every blob and the manifest before its one-hour expiry; restart
invalidates the process-local handles. Missing passphrases cannot be recovered.

Import requires a fresh offline standalone database, empty private bucket,
matching actual Stripe merchant and named/quiesced operator. A blocked
finalization leaves the tenant suspended. Read the exact codes and receipt IDs
in [operator maintenance](operator-maintenance.md); do not manually unsuspend
or erase receipts to bypass reconciliation.

A customer closure request may remain blocked by paid rights, active
installations, financial/provider state or retained work. Closure is a reviewed
maintenance procedure, not immediate erasure. It does not cancel payments.
For `closure_reconciliation_pending`, an operator must complete the partially reconciled closure before exporting. Receipt-free pending requests transfer normally.
For privacy_attribution_upgrade_required, use the reviewed closure-attribution-upgrade procedure before export. Current completed-closure attribution transfers encrypted and is rekeyed at the destination.

## Service health

```sh
curl --fail --silent --show-error https://licenses.example.com/api/v1/health
curl --fail --silent --show-error https://licenses.example.com/api/v1/ready
```

Liveness means the process responds. Readiness checks a database query, S3 bucket
access and private working-directory access. It does not qualify live Stripe,
SMTP, restore recovery or every storage permission. Check proxy reachability,
origin/trusted-proxy configuration, volume ownership, remaining disk and database
connectivity separately.

Before a restore or schema upgrade, preserve matching database, private objects
and `APP_SECRET`. Follow [backup and restore](backup.md). Do not change
deployment mode or regenerate secrets as an infrastructure troubleshooting step.
