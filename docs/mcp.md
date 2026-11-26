# MCP for agents

Run the stdio MCP server from the source checkout with the pinned Node and pnpm
versions: `pnpm mcp`. It loads `.env` if present, like the CLI. Configure the
client to start that command in the checkout and provide `PUBLIC_ORIGIN`,
`TENANT_SLUG` and a scoped `TENANT_API_KEY` through a protected environment.
Platform tools require the independent `OPERATOR_TOKEN`. Do not put credentials
in tool arguments or client configuration committed to source control.

For CI publishing, use `ENTITLE_OIDC_PUBLISHER_ID` instead of a tenant key.
GitHub Actions retrieves its identity automatically; other providers supply
`ENTITLE_OIDC_TOKEN` or a private `ENTITLE_OIDC_TOKEN_FILE`. The release and asset
publishing tools use the same scoped exchange as the CLI. Passkey/security-key
login, publisher trust and email fallback controls are described in the
[OIDC and passwordless guide](oidc-publishing.md#http-cli-and-mcp).

The server advertises named tools for the publisher and platform CLI commands,
plus `entitle_seller_request` and `entitle_operator_request` for JSON API calls.
The typed `entitle_op_...` tools accept structured fields for license issuance
and inspection, jobs, reports, webhooks, platform recovery, client checks, and
owner-session actions. Discover their schemas using `tools/list`. For example,
`entitle_op_job_retry` takes `{"table":"work","id":"JOB_ID"}`.
`entitle_op_product_save`, `entitle_op_release_publish`, and
`entitle_op_asset_publish` accept structured metadata; artifact file paths refer
to the MCP server's local filesystem.

Use these tools for catalog, checkout, and license support.

| Task | Tool and input |
| --- | --- |
| Add a monthly, annual, or lifetime plan | `entitle_op_product_save` with the `slug`, `name`, and new `plans`. Use `entitle_prices` to find a price ID with `interval` of `month`, `year`, or `lifetime`. |
| Archive or restore a plan | `entitle_op_plan_archive` with `{"id":"PLAN_ID","archived":true}` or `false`. Existing licenses are unchanged. |
| Find promotion codes | `entitle_op_promotions_list` with no arguments and a `read` key. Enable `allowPromotionCodes` with `entitle_op_commerce_settings_update` using an owner session. |
| Start checkout or renew in place | `entitle_op_checkout_create` with `planId`, `email`, and optional `uiMode`, `promotionCode`, and `renewLicenseId`. Promotions require a positive amount due. Supply `ENTITLE_BUYER_SESSION_FILE` to renew or convert an eligible license for the signed-in buyer. |
| Find licenses | `entitle_op_licenses_list` with optional `productId`, `provenance`, `status`, `expiringWithinDays`, `q`, `limit`, and `after`. Use a `read` key and pass `nextCursor` as `after` for the next page. |
| Save a filtered license export | `entitle_op_licenses_export` with `output`, optional `format` of `csv` or `json`, and the license filters. Use a `data:export` key and a new private output path on the MCP server. |
| Edit a license | `entitle_op_license_update` with `id` and at least one of `internalNote`, `expiresAt`, and `siteAllowance`. Use a `licenses:write` key. Only complimentary licenses accept expiration and seat changes. |
| Free a customer's seat | `entitle_op_license_detail` with `{"id":"LICENSE_ID"}`, then `entitle_op_license_installation_deactivate` with `{"id":"LICENSE_ID","installationId":"INSTALLATION_ID"}` |
| Read recurring revenue and retention | `entitle_op_analytics` with no arguments and a `read` key. Returns currency-specific MRR and ARR, retention counts, and per-product license and seat metrics. |
| Subscribe to cancellation and expiry | `entitle_op_webhook_create` with `url` and `events` containing `license.canceled` and `license.expired`. Use an `operations:write` key and store the returned signing secret privately. |

See [license filters and scopes](api.md#license-management-and-analytics) and
[shareable sale links](seller-guide.md#share-a-promotion).

Native feed and protected-download tools use the configured installation bearer
token. The server checks entitlement for each request. File downloads require a
new private output path.

For example, call `entitle_seller_request` with:

```json
{"method":"GET","path":"/operations/reports?days=30"}
```

For JSON mutations supply a `body` object. API keys remain subject to their
scopes, tenant ownership, paid capabilities and interactive-only restrictions.
`entitle_api`, `entitle_operator_api`, and `entitle_request` expose the CLI's
generic commands, including file uploads and downloads, through an `args` array.
Paths passed as file arguments refer to the server process's filesystem.

Creating exports requires an owner-only JSON input file, so the passphrase does
not enter a tool argument. Download ciphertext with `--output` to a private
location. Webhook creation and rotation return signing secrets once; tool results
and agent transcripts can contain sensitive customer data or secrets, so use a
trusted client and protect its logs. No command retries mutations automatically.

`entitle_export_create` and `entitle_export_download` provide the private-file
export workflow. `entitle_activation_create` reads a private request file and
writes the activation token to a new private file. The owner login and
verification tools similarly take file paths, never email tokens or proofs as
tool arguments. Configure `ENTITLE_SESSION_FILE` and, for a sensitive action,
`ENTITLE_VERIFICATION_FILE` in the MCP process environment. See the
[guided owner session](cli.md#guided-owner-session) for the sequence and the
same-session OAuth limitation.

`entitle_buyer_login_start`, `entitle_buyer_login_finish`, and
`entitle_buyer_session_refresh` support the buyer's email login; tokens remain
in private files. Set `ENTITLE_BUYER_SESSION_FILE` and `TENANT_SLUG` in the MCP
process environment before using the typed `entitle_op_buyer_...` tools. Buyer
sessions are bound to their origin and tenant and cannot be combined with seller
or bearer credentials. Buyer exports, package downloads and replacement keys
are saved to new private files; customer information returned by other tools can
still appear in an agent transcript.

The server is a local stdio process, not a remote hosted MCP endpoint. Owner
verification and Stripe authorization remain interactive.
Use the [CLI reference](cli.md#other-api-operations) and [API reference](api.md)
for credentials, endpoint details and restrictions.

See [capability-specific authentication and recovery](authentication-policy.md) for the `PRIVILEGED_AUTH_POLICY` options, hardware approvals, restricted recovery operations, and local operator recovery.
