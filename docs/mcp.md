# MCP for agents

Run the stdio MCP server from the source checkout with the pinned Node and pnpm
versions: `pnpm mcp`. It loads `.env` if present, like the CLI. Configure the
client to start that command in the checkout and provide `PUBLIC_ORIGIN`,
`TENANT_SLUG` and a scoped `TENANT_API_KEY` through a protected environment.
Platform tools require the independent `OPERATOR_TOKEN`. Do not put credentials
in tool arguments or client configuration committed to source control.

The server advertises named tools for the publisher and platform CLI commands,
plus `entitle_seller_request` and `entitle_operator_request` for JSON API calls.
The typed `entitle_op_...` tools accept structured fields for license issuance
and inspection, jobs, reports, webhooks, platform recovery, client checks, and
owner-session actions. Discover their schemas using `tools/list`. For example,
`entitle_op_job_retry` takes `{"table":"work","id":"JOB_ID"}`.
`entitle_op_product_save`, `entitle_op_release_publish`, and
`entitle_op_asset_publish` accept structured metadata; artifact file paths refer
to the MCP server's local filesystem. Native feed and protected-download tools
use the configured installation bearer token and preserve server entitlement
checks. File downloads require a new private output path.
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
