# CLI reference

Run commands from the source checkout with the pinned Node runtime. `pnpm cli`
runs `src/cli.ts` and reads `.env` when it exists. Remote publisher commands do
not need the server's application, storage, SMTP or Stripe secrets.

## Publisher connection

Supply these settings through a protected environment or secret manager:

| Variable         | Value                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`  | Deployment origin, default `http://localhost:3211`. No path, query, credentials or fragment. |
| `TENANT_SLUG`    | Required explicit public workspace slug; set `primary` for the default standalone workspace. No CLI default.                     |
| `TENANT_API_KEY` | Scoped, unexpired key created in the seller dashboard. Required.                             |

The CLI validates the slug and `DE-TK-...` key format before making requests.
API authorization still checks expiry, tenant ownership and scopes. Supply
credentials privately; never put them in command arguments, JSON metadata or
release packages. Output is JSON on success. Errors return exit 1; successful
commands return exit 0. Known configured credentials are redacted from messages,
but license/customer output still needs private handling.

## Publisher commands

| Command                                            | Required scope      | What it does                                                                              |
| -------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `product [FILE]`                                   | `catalog:write`     | Saves product/plans from JSON; defaults to `product.json`.                                |
| `publish PRODUCT VERSION ZIP METADATA_FILE`        | `releases:write`    | Publishes a WordPress ZIP.                                                                |
| `publish-asset PRODUCT VERSION FILE METADATA_FILE` | `releases:write`    | Streams one native asset with declared length.                                            |
| `licenses`                                         | `read`              | Returns seller overview, including safe license/release data and metrics.                 |
| `revoke LICENSE_ID`                                | `licenses:write`    | Sets the seller's manual revocation.                                                      |
| `restore LICENSE_ID`                               | `licenses:write`    | Clears that manual revocation; refund/dispute restrictions remain.                        |
| `withdraw RELEASE_ID`                              | `releases:write`    | Withdraws every target of a release; retains storage.                                     |
| `reconcile [SUBSCRIPTION_ID]`                      | `billing:reconcile` | Discovers merchant subscriptions or queues one subscription for canonical reconciliation. |
| `jobs`                                             | `read`              | Lists safe tenant work/email states, attempts and errors.                                 |
| `work`                                             | `billing:reconcile` | Runs a bounded batch of tenant work.                                                      |
| `demo-purchase PLAN_ID EMAIL`                      | `licenses:write`    | Creates entitlement in local billing mode only, without a real charge.                    |
| `features`, `prices`, `operations`, `webhooks`      | `read`              | Reads workspace capabilities, prices, operational status or webhook inventory.            |

The `licenses` command is an overview, not a paginated all-history export. Use
the dedicated [encrypted export API](portability.md#export) for a workspace
transfer. Automation keys cannot perform interactive owner-only actions.

## Named management commands

The following commands accept one JSON file containing the stated fields; omit
the file when no fields are required. MCP exposes the same operations as typed
`entitle_op_...` tools. Existing server scopes, tenant checks and hosted feature
requirements still apply.

| Command | Input and purpose |
| --- | --- |
| `license-detail` | `{id, after?, limit?}`; a license and a page of installations. Follow `nextCursor` until null. |
| `license-complimentary` | `{email, productId, siteAllowance, expiresAt, requestId, confirm:true, note?}`; issue an emailed key. Reuse the same request ID and details on an uncertain result. |
| `job-retry` / `jobs-retry-failed` | `{table, id}` / `{table, limit?}` with `table` of `work` or `emails`. `job-retry TABLE ID` also works. |
| `platform-job-retry` / `platform-jobs-retry-failed` | The same inputs with `platform_work` or `platform_emails` and the operator token. |
| `reports` / `operations-settings` | `{days?}` / `{settings:{...}}`; read reports or change thresholds. |
| `webhook-create` / `webhook-rotate` / `webhook-delete` / `webhook-retry` | `{url, events}` / `{id}`; manage endpoints and retry deliveries. Signing secrets are returned once. |
| `export-list` / `export-delete` | No input / `{id}`; inspect or remove export handles. |
| `catalog` / `activation-status` / `activation-deactivate` / `update-check` | No input, except `{product}` for updates. Status and update checks use `ENTITLE_AUTHORIZATION=Bearer …`. |
| `product-save` / `release-publish` / `asset-publish` | Structured product, plan and release metadata. Release and asset inputs include a local `file` path; the API performs package and identity validation. |
| `update-joomla`, `update-electron`, `update-tauri`, `update-sparkle`, `update-jetbrains`, `update-generic` | Native feeds for an installation bearer; XML and YAML return bounded text and 204 means no update. |
| `installation-release-download` / `installation-asset-download` | Save an entitled package to a new owner-only `output` file using an installation bearer. |
| `owner-sessions`, `owner-session-revoke`, `owner-sessions-revoke-others`, `owner-sessions-revoke-all` | Inspect or revoke seller sessions; use an interactive owner session. |

`pnpm cli export-create PRIVATE_BODY_JSON_FILE` creates an export using an
owner-only file containing `{"passphrase":"..."}`. `pnpm cli export-download
EXPORT_ID NEW_DIRECTORY` retrieves the manifest and all returned blobs into a
new private directory. On failure the partial directory remains for inspection;
the command does not delete the server export or silently repeat mutations.

`pnpm cli activation-create PRIVATE_INPUT_JSON_FILE NEW_ACTIVATION_FILE` reads
the activation request, including its license key, from an owner-only file and
saves the response, including the installation token, to a new owner-only file.
Use a stable installation ID when retrying an uncertain activation.

## Guided owner session

1. Run `pnpm cli owner-login-start EMAIL NEW_PREAUTH_FILE`. Retrieve the login
   token from the emailed link and place only that token in an owner-only file.
2. Run `pnpm cli owner-login-finish PREAUTH_FILE TOKEN_FILE NEW_SESSION_FILE`.
   Set `ENTITLE_SESSION_FILE` to that private session file. It is bound to the
   configured origin; protect it like a password. CSRF is fetched from the API
   when needed without rewriting the saved session. If validation fails after
   login, run `pnpm cli owner-session-refresh SESSION_FILE`.
3. Use `owner-me`, `workspace-create`, `owner-keys`, `sandbox-status`,
   `sandbox-create`, `sandbox-purchase`, `commerce-settings`,
   `commerce-settings-update`, `commerce-tax-code`, `platform-checkout`, and
   `platform-portal` with the documented structured inputs. These use the owner
   session, not the workspace API key.
4. For a sensitive action, call `owner-verification-request` with a JSON file
   such as `{"purpose":"api_keys"}`. Save the emailed token and purpose as an
   owner-only JSON file, then run `owner-verification-consume PRIVATE_JSON_FILE
   NEW_PROOF_FILE`. Set `ENTITLE_VERIFICATION_FILE` to the proof file before
   calling `owner-key-create` or `owner-key-revoke`. The proof is session-bound,
   expires, and is consumed once. The API key is returned once and needs private
   handling.

`stripe-connect` requests the authorization URL with the owner session. The
OAuth callback requires the *same* seller session in the browser. Use the
dashboard flow when the browser does not share the CLI session; the CLI does
not transfer its private cookie into a browser. Stripe approval remains with the
account owner. Browser-bound email links must likewise be consumed with the
pre-authentication session that requested them, as in the steps above.

## Buyer session and actions

Set `PUBLIC_ORIGIN` and `TENANT_SLUG`, run `buyer-login-start EMAIL`, and place
the emailed buyer login token in an owner-only file. Run `buyer-login-finish
TOKEN_FILE NEW_SESSION_FILE`, then set `ENTITLE_BUYER_SESSION_FILE` to that
file. The session is private and bound to the configured origin and tenant.
Do not combine it with seller-session or bearer credentials. CSRF is fetched
from the API when needed without rewriting the saved session. If validation
fails after login, `buyer-session-refresh SESSION_FILE` can recheck it.

`buyer-me`, `buyer-notifications`, `buyer-notification-dismiss`,
`buyer-installation-deactivate`, `buyer-release-download`,
`buyer-asset-download`, `buyer-data-export`, `buyer-closure-status`,
`buyer-closure-request`, and `buyer-logout` operate within the signed-in
customer's permissions. Downloads and data export require an `output` field
pointing to a new private file. `buyer-key-replace` takes `{id, output}` and
stores the new key in that file; replacement revokes prior installation tokens.
The output path is reserved before the request. Do not repeat an uncertain key
replacement: inspect the account and use its recovery flow. A closure request
records intent; completion remains the separate operator maintenance procedure.

## Other API operations

`pnpm cli api METHOD /PATH` accesses seller endpoints relative to
`/api/v1/tenants/$TENANT_SLUG/seller`. `operator-api` uses the operator token and
the `/api/v1/operator` prefix. Methods are `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, and
`DELETE`. The API enforces its usual scopes and interactive-only restrictions.

```sh
pnpm cli api GET '/operations/reports?days=30'
pnpm cli api POST /licenses/complimentary --body private-license-request.json
pnpm cli api POST /jobs/work/JOB_ID/retry
pnpm cli api PUT /operations/settings --body settings.json
pnpm cli api DELETE /webhooks/ENDPOINT_ID
pnpm cli operator-api POST /jobs/platform_work/JOB_ID/retry
pnpm cli api GET /exports/EXPORT_ID/manifest --output /private/path/manifest.entitle
```

`--body` reads JSON from a regular file; omitted mutation bodies default to
`{}`. `--upload FILE` streams raw bytes, with optional `--content-type TYPE`
and `--metadata JSON_FILE` (encoded as the release metadata header). `--output`
streams the response to a new owner-only file and refuses to overwrite an
existing path. Use `--range` for a byte-range request and `--headers-output FILE`
to save response headers, including cookies, to a new owner-only file. Protect
those headers as credentials. Non-JSON responses require `--output`; JSON output without it is
limited to 4 MiB. On an error the command reports the HTTP status and request
ID where available. Paths remain on the configured origin and redirects fail.

For export creation, `--body` must point to an owner-only JSON file containing
the passphrase; keep it out of arguments, environment and logs. Exported data
and one-time webhook secrets require private handling. Delete temporary private
input files when finished.

For other API namespaces, `pnpm cli request METHOD /api/v1/PATH` uses the same
options. It sends `ENTITLE_AUTHORIZATION` as the authorization header, or
`ENTITLE_COOKIE` as the cookie header, with `ENTITLE_CSRF_TOKEN` and optional
`ENTITLE_VERIFICATION` for session routes. Supply these in a protected
environment. It does not establish a browser-bound session or capture login
cookies; owner-only and buyer routes still need the appropriate interactive
session, CSRF and verification. Public routes need no credentials. Avoid
putting tokens in paths or query strings.

The generic commands do not change API authorization or make browser-only
onboarding autonomous. See the [MCP guide](mcp.md) for agent access.

## Publish from CI

Keep product and release metadata in source control; keep private packages and
credentials out of public artifacts. Replace the example Stripe price IDs with
prices from the intended account/mode before product creation.

```sh
export PUBLIC_ORIGIN=https://licenses.example.com
export TENANT_SLUG=primary
# The CI secret store supplies TENANT_API_KEY without printing it.
pnpm cli product examples/product.json
pnpm cli publish validated-field-pro 1.0.0 \
  /absolute/private/path/validated-field-pro.zip examples/release.json
```

Native publication uses a different endpoint and metadata shape:

```sh
pnpm cli product examples/generic/product.json
pnpm cli publish-asset example-app 1.0.0 \
  /absolute/private/path/app.bin examples/generic/release.json
```

`publish-asset` opens a regular file without following symlinks, sends
`Content-Length`, and encodes metadata into `X-Release-Metadata` as base64url
JSON. It permits 1 byte through 2 GiB locally, but the server's configured cap,
disk admission and workspace quota can be smaller. WordPress `publish` reads
the ZIP into memory and uses the separate WordPress limit.

A duplicate version/target is a conflict, not an overwrite. If an upload times
out after the server may have committed, inspect the release inventory and
checksum first. Do not generate a new version merely to hide an ambiguous
publication result.

## Recover billing and jobs

```sh
pnpm cli reconcile sub_REPLACE
pnpm cli jobs
pnpm cli work
```

Reconciliation retrieves canonical provider state; it does not charge a customer.
The normal server worker runs every five seconds. `work` is a bounded manual
batch, not a persistent worker or scheduler. Discovery with `reconcile` and no
subscription should be scheduled separately according to your operating policy.

Failed work/email retries use the API because the CLI has no retry command:

```http
POST /api/v1/tenants/primary/seller/jobs/work/JOB_ID/retry
Authorization: Bearer SELLER_API_KEY
Content-Type: application/json

{}
```

Replace `work` with `emails` for email jobs. Bulk retry uses
`POST /seller/jobs/:table/retry-failed` with `{ "limit": 100 }`; the accepted
range is 1-500. Both require `billing:reconcile`. Inspect the failure and resolve
its cause before retry. Explicit retry starts a fresh retry window; mail-budget
deferral does not discard encrypted keys.

## Platform operator commands

These commands require the independent `OPERATOR_TOKEN`, at least 32 characters.
They use `OPERATOR_ORIGIN` when supplied, otherwise `PUBLIC_ORIGIN`, and target
`/api/v1/operator`. A publisher key cannot substitute for that token.

| Command                             | Behavior                                                      |
| ----------------------------------- | ------------------------------------------------------------- |
| `tenants`                           | Lists platform tenants.                                       |
| `tenant-status TENANT_ID JSON_FILE` | Applies reviewed status/capacity settings.                    |
| `tenant-owner TENANT_ID EMAIL`      | Assigns ownership to a verified seller.                       |
| `platform-reconcile TENANT_ID`      | Queues hosted platform-subscription reconciliation.           |
| `platform-jobs`                     | Lists safe platform job/email state.                          |
| `platform-work`                     | Runs a bounded batch of platform work.                        |
| `local-tenant TENANT_ID JSON_FILE`  | Development-only fixture state; unavailable for real billing. |

Use internal tenant IDs, not public slugs. A status file can contain `suspended`,
`exempt`, `maxProducts` and `maxStorageBytes` within server validation limits.
An exemption covers platform billing capacity, not hosted Pro or application
fees. Standalone ownership is assigned automatically on verified owner sign-in.

## Local database and offline maintenance

`pnpm cli migrate` opens the locally configured database, applies migrations and
closes it. It requires full server configuration and does not contact the HTTP
API. Normal server startup also migrates. Back up matching database, private
objects and `APP_SECRET` before an upgrade; do not run competing app versions.

Encrypted imports and customer closure review use `pnpm maintenance`, a separate
offline tool with mandatory named operator and quiescence attestations. Read
[operator maintenance](operator-maintenance.md) before using it. Do not treat
an HTTP queue action or tenant suspension as proof that all workers have drained.

`closure-attribution-upgrade` adds encrypted, scope-bound attribution to older completed-closure receipts using a private reviewed receipt with explicit Stripe mode and proven provider customer ID. See [operator maintenance](operator-maintenance.md#upgrade-legacy-closure-attribution).
