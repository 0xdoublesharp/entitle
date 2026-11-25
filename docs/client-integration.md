# Client integration

Use the deployment's tenant API base, for example
`https://licenses.example.com/api/v1/tenants/primary`. Get the actual workspace
slug and framework configuration from **Integrations → Client setup** in the
seller dashboard. A transferred standalone workspace can retain a different
public slug.

## Credential lifecycle

| Credential       | How it is obtained                           | Where it belongs                                                                     |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| License key      | License issuance or replacement email        | In an installed client, send it to `POST /activate`.                                |
| Activation token | Successful activation                        | Protected storage for one installation; Bearer header on status, feeds and packages. |
| Seller API key   | Seller dashboard                             | Private publication/support automation. Never distribute it with your client.        |
| Buyer session    | Buyer email sign-in                          | Browser account/download flow with tenant-specific cookies and CSRF.                 |

Persist a random installation ID once, separately from the app version. Generate
it on first configuration, not every update check. A device product omits
`siteUrl`; a site product requires it. Labels are optional human-readable device
names, 1-120 characters without control characters.

## Activate

Replace the placeholders with the customer's key and the client's persisted
installation ID.

```http
POST /api/v1/tenants/primary/activate
Content-Type: application/json

{
  "key": "CUSTOMER_LICENSE_KEY",
  "product": "example-app",
  "installationId": "PERSISTED_RANDOM_INSTALLATION_ID",
  "installationLabel": "Work laptop"
}
```

The response contains `token`, `licenseId`, `installationId`, `siteAllowance`,
and `paidThrough`. The `paidThrough` field gives the end of the paid period or
complimentary term as a Unix timestamp in milliseconds. Store the token in
protected platform storage. Each download request checks the current license state.

Retrying the same installation ID while it remains active returns the existing
token without consuming another seat. Keep that ID on disk across application
updates. A new install on a different device needs its own ID.

For WordPress, Joomla and Generic site products, include a full `siteUrl`, such
as `https://customer.example.com/shop`. Normalization lowercases the host,
removes scheme/default ports and query/fragment, and trims trailing path slashes.
Paths and nondefault ports remain distinct. Deactivate before moving to a
different normalized site. Site URLs are metadata and are never fetched.
Development-host seat exemptions require explicit operator configuration.

## Read current status and deactivate

```http
GET /api/v1/tenants/primary/activation
Authorization: Bearer ACTIVATION_TOKEN
```

Status returns `licenseId`, `installationId`, `siteAllowance`, `paidThrough`,
`entitled` and `billingStatus`. Display it in license settings or support
information. Installed features must not depend on a successful status response.

```http
POST /api/v1/tenants/primary/deactivate
Authorization: Bearer ACTIVATION_TOKEN
Content-Type: application/json

{}
```

Deactivation invalidates that token and frees its seat. A buyer can also deactivate
an installation from their account. Replacing the license key invalidates every
existing installation token for the license, so clients must activate again with
the replacement key. Restoration of a seller revocation does not restore old
tokens that a buyer deliberately invalidated.

## Choose the update feed

Paths below are relative to the tenant API base. Send an activation Bearer token
for every protected feed. Use the product's framework-specific example rather
than substituting a different framework's target spelling.

| Framework | Feed path                                              | Example integration                                  |
| --------- | ------------------------------------------------------ | ---------------------------------------------------- |
| WordPress | `/updates/PRODUCT`                                     | [PHP](../examples/wordpress/entitle-example/) |
| Joomla    | `/updates/joomla/PRODUCT.xml`                          | [Installer plugin](../examples/joomla/)              |
| Electron  | `/updates/electron/PRODUCT/TARGET/FILENAME`            | [JavaScript](../examples/electron/)                  |
| Tauri     | `/updates/tauri/PRODUCT/TARGET/CURRENT_VERSION`        | [Rust](../examples/tauri/)                           |
| Sparkle   | `/updates/sparkle/PRODUCT/TARGET/appcast.xml`          | [Swift](../examples/sparkle/)                        |
| JetBrains | `/updates/jetbrains/PRODUCT/updatePlugins.xml`         | [Kotlin/Java](../examples/jetbrains/)                |
| Generic   | `/updates/generic/PRODUCT/TARGET?currentVersion=1.0.0` | [HTTP JavaScript](../examples/generic/)              |

Generic and Tauri use the current version to suppress older/equal offers and may
return 204. WordPress metadata can describe the latest release even when it is
already installed; the client must compare versions. An absent release or target
can also produce no offer. Check [API v1](api.md) for framework-specific behavior.

Electron's channel filename is `latest.yml` for Windows, `latest-mac.yml` for
Darwin, `latest-linux.yml` for linux-x64 and `latest-linux-arm64.yml` for
linux-arm64. Disable differential download in the example integration because
the service does not generate blockmaps or deltas.

Joomla discovery requires authentication through its installer plugin. The
native installer reloads a separate public immutable details document. That
document has no buyer credentials or package bytes; package download still
requires the installation token. JetBrains repository authentication must cover
its feed and exact package path; the IDE may append bounded build/os/arch values.

## Download and verify

Use the immutable package URL returned by the feed. It contains no credential.
Attach the installation token only after verifying the configured origin and
exact tenant package path. Reject redirects and foreign origins. A shared
global HTTP hook that adds Authorization to every request can leak the token.

Verify the returned artifact's checksum before handing it to the native updater.
WordPress and Generic metadata include SHA-256; Electron feeds include SHA-512.
Tauri and Sparkle require seller-generated detached signatures and public keys
embedded in the installed app. The service validates signature metadata format;
the client updater verifies the signature against its trusted key. A checksum
does not replace platform signing, notarization or signature verification.

Native package endpoints support GET, HEAD and one byte range. Valid ranges
return 206; invalid/multipart ranges return 416. An uncached native request
verifies the entire private stored object into a bounded local disk cache before
serving any bytes, including for ranges. Cache hits reuse verified files and
still check current token, entitlement and withdrawal. The service does not
forward ranges to S3 or include a public CDN.

## Handle failures without disabling the application

| Result                       | Client behavior                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| 200 / 206 package            | Verify expected size/checksum/signature, then use the native installation flow.               |
| 204 feed                     | No update offer. Keep the installed version and try on the normal schedule.                   |
| 401                          | Token is absent, invalid or revoked. Offer activation/recovery in settings.                   |
| 403                          | Read the error code for expired/revoked/disputed access or product/scope restrictions.        |
| 404                          | Check workspace, product, asset and withdrawal state. Do not guess a storage URL.             |
| 409                          | Inspect an identity, activation, immutable-version or framework conflict.                     |
| 429 / 503                    | Respect Retry-After when supplied, use bounded backoff and preserve the current installation. |
| Timeout / connection failure | Keep local functionality and credentials intact. Retry later.                                 |

Failures use `{ "error": { "code", "message", "requestId" } }` when the
application produces JSON. A reverse proxy can return a different body. Check
status/content type before parsing an artifact or feed. Do not log tokens, raw
keys, customer email or provider secrets. Keep the request ID for support.

Cached update metadata may remain useful during an outage, but is not a promise
that a later download will be authorized. Current paid-through time, revocation,
refund/dispute restrictions and release withdrawal apply at download time.

## Qualify your client

Test purchase, activation retry, concurrent seat limits, normal and automatic
updates, key replacement, deactivation, missing targets and outages in the real
runtime. For desktop products, include each OS/architecture, protected key
storage, signing, installation and relaunch. Keep the updater loaded even if
optional features fail compatibility checks, so an update can repair them.

[Framework support](platform-support.md) lists server requirements.
[Verification](testing.md#release-checks) records tested runtimes and remaining limits.
