# Seller guide

Open the seller dashboard at `/app/seller` on hosted or `/seller` on standalone.
A **publisher workspace** represents a business or brand. Add a **product** for
each plugin or app. Each product has its own plans, licenses, releases, and
client settings. Products share the workspace's Stripe connection, billing,
access, API keys, and storage allowance.

Buyers use `/app/t/YOUR_SLUG` on hosted or `/t/YOUR_SLUG` on standalone. Adjust
those page URLs if your operator uses a [custom app mount](deployment.md#independent-marketing-and-application-sites).
Build pipelines and installed clients both use `/api/v1/tenants/YOUR_SLUG`. See the
[API reference](api.md#credential-selection-and-scopes) for their credentials.

## Archive, restore or remove a workspace

In hosted deployments, open **Administration → Workspaces**. Archive a retired
workspace to hide it from the active selector. Choose **Archived workspaces**
to open or restore it. Archiving a publisher also hides its sandbox from the
active list; restoring the publisher does not restore a sandbox you archived
separately. Existing licenses, updates, downloads, billing and subscriptions
continue. Archived workspaces retain their data and count toward your account
limit. Cancel subscriptions separately in Billing when appropriate.

Use **Check removal** for an empty workspace. Removal is permanent and requires
its exact address and a fresh passkey or security-key approval in the requesting
browser. Removal deletes the workspace, settings, membership, and unused API
keys. It frees an account slot and makes the address available again. Entitle
retains security audit records. Archive a workspace if it has customers,
products, licenses, releases, payments, used keys, exports, linked services, or
other business history. Remove an empty linked sandbox before removing its
publisher workspace. The primary workspace cannot be archived or removed.

For personal data requests, follow the
[customer account closure procedure](operator-maintenance.md#inspect-customer-closure-requests).

## Products and plans

Open **Products & sales → Products**. The framework determines the activation
type, package validation, and update feed. Its identity and configuration lock
after the first license or release.

| Framework                | Required identity                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| WordPress                | Exact `pluginBasename`, such as `example-pro/example-pro.php`.                                                            |
| Joomla                   | Extension type, element and Joomla major; plugins also need folder, and modules/templates/libraries/packages need client. |
| JetBrains                | Plugin ID and `sinceBuild`, optionally `untilBuild`.                                                                      |
| Generic                  | Optional `activationKind`, `device` by default or explicitly `site`.                                                      |
| Electron, Tauri, Sparkle | Empty framework configuration; targets and signing metadata belong to release assets.                                     |

For complimentary licensing, leave the paid plan option unchecked. The form
clears this option when no prices are available.

To offer a paid plan, create a monthly, annual, or one-time Stripe price on your
merchant account. Enable the paid plan option and select the price. A plan pairs
the price with an installation allowance. A one-time price creates a lifetime
plan and appears as `interval: "lifetime"` in the seller API. Use your connected
account on hosted or the account configured on your standalone server. The
price and server credentials must use the same Stripe mode.

### Edit a product and its plans

Choose **Edit product** beside a product to rename it or add plans. Enable the
paid plan option, enter the plan name and allowance, and select a price. You can
add a paid plan to a pilot product at any time. Existing complimentary licenses
and previously saved plans stay in place.

The editor lists each plan with its allowance, price ID, and formatted price,
such as `$9 / month`. **Archive** a plan to remove it from the customer catalog
and refuse new checkouts for it. Existing licenses and subscriptions on that plan
are not changed. **Restore** offers it again. Archived plans stay in the editor
and in paid history.

The customer catalog shows each available plan's price and interval, for example
`$49 / year`. Elements checkout shows a monthly or annual renewal or a one-time
lifetime payment. Plans created before intervals were recorded show as annual,
because earlier versions accepted only annual prices.

The service preserves price-to-product and allowance mappings for past invoices.
Use a new price to change seats. Changing a display name does not rewrite paid
history. A future paid period applies at its start; overlapping grants preserve
the larger paid allowance. An unpaid upgrade grants no extra seats.

### Share a promotion

Create a promotion code in the workspace's Stripe account, then enable **Allow
promotion codes at checkout** in Commerce settings. The equivalent API field
is `allowPromotionCodes`. Use **Promotion codes** in the dashboard or
`GET /seller/promotions` to find active codes.

Share `/t/WORKSPACE?promo=CODE` to prefill a code. Add `&plan=PLAN_ID` to preselect
a plan and `&renew=LICENSE_ID` to target a specific buyer license. The full
link has the form `/t/WORKSPACE?promo=CODE&plan=PLAN_ID&renew=LICENSE_ID`. The
buyer signs in to renew. Paid checkout requires a positive amount due after the
discount. Issue a complimentary license for free access.

## Publish a release

1. Build the package and verify its identity and version.
2. Open **Products & sales → Releases**, select the product, and enter a strict
   semantic version such as `1.2.0`.
3. Add release notes and required compatibility/signature metadata.
4. Approve the upload with your passkey or security key when prompted.
5. Upload, then confirm the release and target inventory in the dashboard.
6. Verify the update check and authenticated download from a licensed installation.

WordPress uses one plugin ZIP per version. Other frameworks use one asset per
target; you can add another target to an existing version when the release notes
match exactly. You cannot replace an existing target's bytes or alter the
published notes. Publish a new version for a correction.

| WordPress metadata | Purpose                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `changelog`        | Release notes, schema maximum 30,000 characters; the complete encoded metadata header must also fit 12,288 bytes. |
| `minWp`, `minPhp`  | Minimum WordPress and PHP versions; defaults `6.0` and `8.0`.                                                     |
| `minFree`          | Minimum companion Free version, default `0.0.0`.                                                                  |
| `tested`           | Tested compatibility version, default `0.0.0`.                                                                    |

Native metadata contains `target`, `filename` and `changelog`, with `signature`
and `minSystemVersion` where applicable. Filenames are safe display names, not
storage paths. See [framework support](platform-support.md) for targets and
formats, and [CLI publication](cli.md#publish-from-ci) for automation.

### Withdraw a faulty release

Withdrawal stops new offers and downloads for every target in the version.
It leaves the private objects in storage and charged against quota. An old cached
feed offer cannot download a withdrawn release. Publish corrected bytes as a new
version; withdrawal does not remove installed software.

## Support a buyer

### Issue a complimentary license

Open **Products & sales → Licenses** and select **Issue complimentary license**.
Enter the customer's email, product, installation allowance, and a future
expiration date and time. The form uses your browser's local time zone. You can
add a private note. Review the confirmation before issuing.

Entitle creates or reuses the customer in this workspace, issues a license key,
and queues the encrypted license email. Check email history for delivery
attempts. If you are unsure whether issuance succeeded, retry with the same form
values to reuse its request ID and avoid duplicate licenses or emails. Changing
the form values starts a new request.

Complimentary licenses are labelled in the seller and customer views. They have
their own expiration and allowance and create no invoice, payment, revenue or
subscription. The note is internal. No Stripe account or price is needed:
create the product without a paid plan, publish its
release, and issue the complimentary license. Paid checkout and billing remain
unavailable until their required configuration is present.

The normal activation, seat enforcement, protected downloads and updater APIs
apply, including the existing WordPress client. Expiration blocks new activations,
downloads and updates while installed plugin features continue working. Seller
revocation/restoration and customer key replacement use the same controls as
other licenses. Restoration does not extend expiration. Key replacement revokes
old keys and activation tokens and queues a replacement email.

Pilot customers start paid checkout themselves. A signed-in buyer can convert an
eligible complimentary license to paid or renew an eligible canceled, expired,
or unpaid license in place. They choose a plan for the same product. Checkout
uses `renewLicenseId` to identify the existing license, and payment confirmation
preserves its key and active installations. Revoked, suspended, and lifetime
licenses are ineligible for this renewal flow.

### Diagnose an existing license

Search Licenses by customer email, product, plan or license ID. Combine the
product, license type and access filters, and select a column heading to sort;
select it again to reverse the order. Clear filters restores the full list.

Use the [license management API](api.md#license-management-and-analytics) to
filter by expiration window or to save matching records as CSV or JSON. Exports
omit license keys and installation tokens and require `data:export` for API
keys. A key with `licenses:write` can update the internal note on any license
and adjust the expiration and seat allowance on complimentary licenses.

Use the license view to distinguish paid-through time, manual revocation,
refund/dispute restrictions and installation usage. Ask the buyer for a request
ID and the product/version/target involved, without collecting their license key
or activation token.

Choose **Installations** on a license row to see each site or device, whether it
is active, and whether it uses a seat. Long lists load in pages with **Load more
installations**. To free a seat for a customer who cannot sign in, choose
**Deactivate** on the installation and confirm. The installation stops receiving
licensed updates and its token stops working; installed software keeps running,
and the customer can activate it again with their key.

| Buyer problem                | Supported action                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Lost license email           | Sign in at the workspace buyer page and replace the key. Replacement invalidates all prior installation tokens.        |
| No free seat                 | Deactivate an old installation from the buyer account, or from **Licenses → Installations** for that license; keep its ID stable across app updates. |
| Paid invoice missing locally | Inspect billing jobs and reconcile the subscription. Reconciliation reads provider state and does not create a charge. |
| Manually revoked license     | Restore only the seller revocation. Refund/dispute restrictions still apply.                                           |
| Canceled renewal             | Purchased time remains until its paid-through date. Cancellation is not immediate license revocation.                  |
| Server outage                | Recover service and update delivery; installed functionality must remain usable.                                       |

Buyers manage subscriptions in the merchant's Stripe Customer Portal. A key
replacement, installation deactivation or account closure request does not
cancel recurring payments. Full refunds revoke future downloads; partial refunds
leave entitlement unchanged. Open/lost disputes suspend downloads pending
canonical reconciliation.

## Protect the seller account

Account security lists sessions and supports revoking one, others, or all.
Revoking the current session signs you out. Create offline recovery codes after
an emailed confirmation and store them separately from your email account.
Replacing codes invalidates the previous set; each code works once. Signed-out
recovery must start and finish in the same browser.

API-key changes, browser publication, trusted-publisher changes, and workspace
removal require a fresh passkey or security-key approval for that exact action.
Your operator's `PRIVILEGED_AUTH_POLICY` decides which keys qualify. Under
`passkey`, any user-verified passkey you enrolled works. Under `hardware`, you
need two security keys that the operator inventoried and approved.
Account security shows the wording for your server's policy.

Workspace export and recovery-code replacement use an emailed proof tied to the
action and session. A consumed proof lasts five minutes and works once. Retry a
failed action with a fresh approval or proof.

Hosted email changes require confirmation from both current and new mailboxes
in the requesting session. Standalone owner email changes require the operator
to update configuration through its maintenance procedure.

## API keys for automation

Create a named, expiring key in API keys. Save its raw value when shown; the
dashboard cannot reveal it later. The default is 90 days with `read` and
`releases:write`; expiry can be at most 365 days. Give each pipeline only its
required [scopes](api.md#credential-selection-and-scopes).

Rotate by creating a replacement, privately updating the intended pipeline,
confirming a request with the replacement, then revoking the old key. Keys are
workspace-bound. Key management, commerce settings, sandbox management, Connect
and platform billing require interactive seller sessions. `operations:write`
can create/rotate webhook secrets; `data:export` can export customer and license
state. Treat those scopes as sensitive.

## Test in a sandbox

Sandbox creates one isolated child workspace with its own buyer URL, products,
customers, licenses, activation tokens and artifact namespace. Choose `fixture`
or `stripe` at creation; its mode is immutable. Check the server-confirmed badge
and returned URLs before testing. A sandbox does not consume another live
workspace slot; its capacity and Pro access follow the live parent.

Fixture purchases do not charge money. They deliver to the verified seller's
email only, through the child workspace's Sandbox purchase action. Create the
child product/plan and publish its release before testing. Live tokens cannot
authenticate its protected packages.

Stripe sandboxes need the operator's complete separate test key set and signed
`/api/v1/stripe/sandbox-webhook`. Without those settings, use fixture mode.
Neither sandbox mode qualifies a live payment, payout or production tax setup.

## Configure tax collection

Tax settings control automatic tax, tax-ID collection and billing-address
collection. Both Checkout interfaces use the same server settings. Activate
Stripe Tax and configure registrations on the correct merchant account before
enabling automatic tax. Product tax codes are checked on that account too.

The settings API accepts all three booleans together. They do not appoint the
service as merchant of record or move the publisher's tax responsibilities.

## Read operations and reports

The overview displays license, installation, download, release and storage
metrics, with seat and storage utilization bars. Operations shows completed,
failed, pending and canceled jobs, oldest pending age, storage used/reserved,
served bytes, storage reads and billing-capacity warnings. Counts belong to the
selected workspace; select a sandbox to inspect its activity. Successfully sent
emails count as completed jobs rather than pending jobs.

Use `GET /seller/analytics` to read monthly and annual recurring revenue by
currency, retention counts, and per-product license, installation, and
seat counts. The same report is available through `pnpm cli analytics` and
`entitle_op_analytics` with a `read` key.

Load an activity report for daily job charts and the latest 50 email jobs in
the period. Charts group jobs by the UTC day they were queued and show their
current results. Sent means the configured mail transport accepted the message.
Only retained jobs are counted; email contents and credentials are omitted.

Default alert thresholds are one failed job, one hour pending age, 90% storage
and a one-hour cooldown. The bandwidth alert is disabled until its byte
threshold is nonzero.

Lifecycle notices default to seven days before expiry and are configurable.
They do not extend paid time. Queue/mail delays can defer delivery, so confirm
access from current license state.

Hosted Pro and standalone can read daily reports for 1-365 days and send
[signed outgoing events](webhooks.md), including `license.canceled` and
`license.expired`. Report rows are recorded UTC days; days
with no records need not appear. The dashboard fills missing chart days with
zero and offers 7-, 30- and 90-day views of downloads, delivered bytes, origin
reads and average response size. Served responses and bytes do not prove a
completed installation. Payment amounts are grouped by currency and include
taxes; they do not subtract Stripe fees or establish seller profit.

## Export and privacy

Buyers can export their own account JSON, dismiss notices and request closure.
Closure waits for offline operator review of financial obligations, retention
and paid rights. It does not cancel subscriptions or erase paid grants on request.

Workspace transfer exports are core, including when hosted Pro expires. Choose
a private passphrase, download the encrypted manifest and every blob before the
one-hour expiry, and keep the passphrase separately. A process restart invalidates
export handles. Use [portability](portability.md) for the transfer boundaries and
[operator maintenance](operator-maintenance.md) for a fresh standalone import.
