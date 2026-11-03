# Seller guide

Open `/seller` on your deployment. A **publisher workspace** represents your
business or brand and can contain multiple **products**, one for each plugin or
app. Each product has its own plans, licenses, releases and client configuration.
Products share the workspace's Stripe connection, billing, access, API keys and
storage allowance. Use another workspace when you need those settings and data
kept separate; a separate workspace for every product is optional.

Buyers use `/t/YOUR_SLUG`. Build pipelines and installed
clients use `/api/v1/tenants/YOUR_SLUG` with different credentials.

## Archive, restore or remove a workspace

In hosted deployments, open **Administration → Workspaces**. Archive a retired
workspace to hide it from the active selector. Choose **Archived workspaces**
to open or restore it. Archiving a publisher also hides its sandbox from the
active list; restoring the publisher does not restore a sandbox you archived
separately. Existing licenses, updates, downloads, billing and subscriptions
continue. Archived workspaces retain their data and count toward your account
limit. Cancel subscriptions separately in Billing when appropriate.

Use **Check removal** for an empty workspace. Removal is permanent and requires
its exact address plus fresh email verification in the requesting browser. It
deletes the empty workspace, settings, membership and unused API keys, frees an
account slot and makes the address available again. Security audit records are
retained. Customers, products, licenses, releases, payments, used keys, exports,
linked services and other business history block removal; archive instead. An
empty sandbox can be removed first, but removing a publisher never deletes a
linked sandbox. The primary workspace cannot be archived or removed.

These actions manage publisher workspaces. They do not erase personal data.
Customer account closure and retained financial/security records follow the
separate privacy and retention process.

## Products and plans

Choose the framework before creating a license or publishing a release. The
framework selects site/device activation, package validation and the native feed.
Its identity and configuration lock after first use.

| Framework                | Required identity                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| WordPress                | Exact `pluginBasename`, such as `example-pro/example-pro.php`.                                                            |
| Joomla                   | Extension type, element and Joomla major; plugins also need folder, and modules/templates/libraries/packages need client. |
| JetBrains                | Plugin ID and `sinceBuild`, optionally `untilBuild`.                                                                      |
| Generic                  | Optional `activationKind`, `device` by default or explicitly `site`.                                                      |
| Electron, Tauri, Sparkle | Empty framework configuration; targets and signing metadata belong to release assets.                                     |

Products can be created without a paid plan for complimentary licensing, even
when the server has Stripe configured. Leave **Include annual paid plan**
unchecked; no connected Stripe account or price is required. When no prices are
available, this option is unchecked automatically and product creation remains
available.

To offer a paid plan, create an annual recurring Stripe price on your merchant
account and enable **Include annual paid plan**, then select the price. The
option is enabled by default when prices are available. A plan pairs the price
with an installation allowance. Hosted
publishers use their connected account; standalone uses its configured direct
account. Test/live mode must match. A local fixture price is not a real Stripe
price.

The service preserves price-to-product and allowance mappings for past invoices.
Use a new price to change seats. Changing a display name does not rewrite paid
history. A future paid period applies at its start; overlapping grants preserve
the larger paid allowance. An unpaid upgrade grants no extra seats.

## Publish a release

1. Build the package and verify its identity/version before upload.
2. Select the product and strict semantic version, such as `1.2.0`, in Releases.
3. Add release notes and required compatibility/signature metadata.
4. Obtain the browser's fresh `release_publish` confirmation when prompted.
5. Upload, then confirm the release and target inventory in the dashboard.
6. Exercise a paid installation's update check and authenticated download.

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

Open **Licenses → Issue complimentary license**. Enter the customer's email,
select the product, choose its installation allowance and a future expiration
date and time, and optionally add an internal note. The time shown in the form
uses your browser's local time zone. Review the confirmation before issuing.

Entitle creates or reuses the customer in this workspace, issues a normal license
key, and queues the existing encrypted license email. The success notice confirms
queuing; SMTP delivery is handled by the normal email worker. A failed request
can be retried with the same form values; its request ID is retained to prevent
duplicate issuance and email jobs. Changing the form values starts a new request.

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

Pilot customers are never automatically charged or enrolled in a subscription.
Any later paid purchase follows the normal checkout flow and creates a separate
paid entitlement.

### Diagnose an existing license

Search Licenses by customer email, product, plan or license ID. Combine the
product, license type and access filters, and select a column heading to sort;
select it again to reverse the order. Clear filters restores the full list.

Use the license view to distinguish paid-through time, manual revocation,
refund/dispute restrictions and installation usage. Ask the buyer for a request
ID and the product/version/target involved, without collecting their license key
or activation token.

| Buyer problem                | Supported action                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Lost license email           | Sign in at the workspace buyer page and replace the key. Replacement invalidates all prior installation tokens.        |
| No free seat                 | Deactivate an old installation from the buyer account; keep its ID stable across app updates.                          |
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

Sensitive browser actions require an emailed proof tied to the action and
session. A consumed proof lasts five minutes and works once. API-key changes,
browser publication and workspace transfer have distinct purposes. Retry a
failed action with a fresh proof.

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
[signed outgoing events](webhooks.md). Report rows are recorded UTC days; days
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
