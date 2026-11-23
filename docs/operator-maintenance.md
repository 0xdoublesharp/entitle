# Offline operator maintenance

Run from a source checkout that matches the deployed version, with Node 26.12.0 and that version's dependencies installed:

```sh
node --env-file-if-exists=.env src/maintenance-cli.ts COMMAND FLAGS
```

`pnpm maintenance COMMAND FLAGS` invokes the same entry point from that checkout.

This local process loads `loadConfig`, opens the configured database with `createDb`, and runs `migrate`. It never starts the HTTP application, Redis workers, email delivery, Checkout, or a scheduler. It closes its database and owned S3 client in `finally`. It never resets a database or empties a bucket. Exit 0 means the command completed; inspect closure approval's JSON `status`, which can be `blocked`. Exit 1 writes only a constant error code, without provider errors, configuration values, stack traces, or passphrases.

## Before every command

Stop **all application instances and all workers**, including replicas, schedulers, queue consumers, and manual jobs. Block ingress and new webhooks, then wait for every in-flight Stripe and SMTP call and database operation to finish. A SQLite lock, tenant suspension, or an idle queue does not establish quiescence. Keep services stopped throughout import, provider reconciliation, privacy reconciliation, and approval. Do not run maintenance commands concurrently.

Back up under your existing private retention policy. Do not overwrite an existing installation to make an import succeed. Reconcile interrupted or ambiguous provider/storage operations before retrying.

Every command requires:

- Valid local configuration, including a 64-character hexadecimal `APP_SECRET` and `OPERATOR_TOKEN` of at least 32 characters. Protect `.env` as an operator credential, mode 0600, outside public/static paths. The token is accepted only through environment configuration. There is no token flag or HTTP privacy approval endpoint.
- `--operator ID`, the named operator responsible for the operation. It is recorded in the audit trail and must exactly match the reviewed privacy receipt after surrounding whitespace is removed. It is an attribution field, not a second authentication credential.
- `--quiesced`, the operator's explicit attestation that the shutdown and drain above have completed. The CLI cannot infer this from database locks.
- `DATABASE_URL` and private `WORK_DIR` for the intended installation. Never point at a parent integration database or another installation by mistake.

For the supplied Compose deployments, run these source commands on the host after the shutdown and drain above. The runtime images contain compiled JavaScript, not the source entry point or pnpm. Do not use `docker compose exec` against a running application for offline maintenance.

Both Compose files mount `${ENTITLE_DATA_DIR}/app` at `/data`. Set `ENTITLE_DATA_DIR` explicitly in the host shell to the installation's actual absolute path. For the default SQLite deployment, supply `DATA_DIR="$ENTITLE_DATA_DIR/app"`, `DATABASE_URL="sqlite:$ENTITLE_DATA_DIR/app/entitle.sqlite"` and `WORK_DIR="$ENTITLE_DATA_DIR/app/work"` as environment overrides for the commands below. The container's `/data` and `/data/work` paths do not name those host files. For PostgreSQL or MySQL, use the installation's actual database URL reachable from the host instead of the SQLite example. Preserve the deployed secrets, provider mode and other configuration, and run as UID/GID 1000, the required data-directory owner, or restore that ownership for the data and work directories before restarting Compose. Keep Compose and all other workers stopped throughout maintenance.

### Move data into the app subdirectory

Earlier Compose files mounted `ENTITLE_DATA_DIR` itself at `/data`. The current files mount only `${ENTITLE_DATA_DIR}/app`, so the proxy's certificate keys in the sibling `caddy-data` and `caddy-config` directories stay out of the application's reach. Because the mount does not create a missing directory, the new files refuse to start until you move the data. With the old stack stopped and a current backup:

```sh
cd "$ENTITLE_DATA_DIR"
sudo install -d -o 1000 -g 1000 app
# Move everything the application wrote, such as entitle.sqlite, its -wal and
# -shm files, and work/. Leave caddy-data/ and caddy-config/ where they are.
sudo mv entitle.sqlite* work app/
sudo chown -R 1000:1000 app
```

List the directory first and move any other application files the same way. Then start the current Compose file and confirm readiness before resuming traffic.

Keep temporary files, encrypted bundles, and run evidence on a private working volume. The examples below use `/secure/maintenance`; replace it with an existing private directory on that volume. Do not commit receipts, captures, secrets, or bundles.

## Import a private encrypted export

First stop and drain the source too. Download the encrypted manifest and every blob through the existing authenticated seller export API/UI. Save the manifest as `manifest.entitle` and retain each returned UUID blob filename as `UUID.blob` in one mode-0700 directory. Files should be mode 0600. Do not copy plaintext or source application secrets. See [portability.md](portability.md) for transfer and adapter cutover requirements.

Destination requirements:

- `DEPLOYMENT_MODE=standalone`; `LOCAL_BILLING` must be false or unset. Hosted import and provider finalization in local fixture mode are refused.
- Fresh migrated database with only the empty primary tenant. Existing auth, commerce, sandbox, platform, or earlier import state causes rejection. Migration is automatic; no reset is offered.
- Explicit `S3_BUCKET` and `S3_REGION`, and normal configured SDK credentials or credential chain. Use a newly provisioned private empty bucket. `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and `S3_FORCE_PATH_STYLE` follow existing configuration. HTTP is allowed only with the existing nonproduction `S3_ALLOW_HTTP=true` fixture setting.
- Actual SDK preflight requires owner-only canonical ACL, no bucket policy, and no objects. Even a private custom policy is refused. Never weaken ACLs or delete objects to bypass this check. The importer uses conditional `If-None-Match: *` writes and authenticated checksum readback.
- Explicit direct merchant `STRIPE_SECRET_KEY`, matching `STRIPE_LIVE_MODE`, with account/event/subscription/customer/invoice/payment/charge/dispute read permissions. The CLI calls `Stripe.accounts.retrieve(null)` with these configured direct credentials, without a Connect account override, before import and finalization. `--expected-stripe-account acct_...` is required and validated. It must match the actual merchant, the encrypted source merchant, and `STANDALONE_STRIPE_ACCOUNT_ID` when configured. Do not pass a different account ID merely to force a transfer.

Use a secret manager or an existing owner-only passphrase file. Never put the passphrase in command arguments, environment variables, URLs, logs, or shell history. For example, assuming `/secure/maintenance/transfer-passphrase` already contains the private phrase:

```sh
umask 077
node --env-file-if-exists=.env src/maintenance-cli.ts import \
  --operator operator@example.com --quiesced \
  --bundle /secure/maintenance/downloaded-export \
  --directory /secure/maintenance/plaintext-work \
  --expected-stripe-account acct_REPLACE \
  --passphrase-fd 3 \
  3</secure/maintenance/transfer-passphrase
```

`--directory` defaults to `WORK_DIR/portability`; it must be absolute and private. `--bundle` must be absolute. The library creates private working directories and removes its plaintext children in `finally`. Do not delete unrelated working directories after a failure.

Omit `--passphrase-fd` to read descriptor 0 from a private pipe or redirected mode-0600 file. The CLI refuses terminal input, so it cannot echo a typed secret. It accepts only an owner-only regular file or pipe owned by the current OS user. Input must end at EOF, contain one UTF-8 line of 12-1024 characters, and may have one final LF or CRLF. The reader consumes at most 4,099 bytes and zeroes its byte buffer afterward. Close a pipe's producer so the reader can observe EOF. The inherited descriptor belongs to the caller; the CLI does not close it.

Import is separate from finalization. Successful import leaves primary suspended, provider jobs held, and original key emails held. The JSON response includes `requiresReconciliation:true`, subscription IDs, and pending event IDs. It contains no decrypted secrets. A failed S3 write can leave an ambiguous object for operator inspection; never delete a preexisting collision. Import cannot be retried over a populated destination.

Default transfer limits are 10 GiB total and 16 MiB for the manifest; individual artifacts are capped at 2 GiB. There are no CLI switches to relax these limits. Transfers use a 120-second idle timeout that restarts on each chunk of upload/download progress, plus a finite total deadline of `120 seconds + ceil(size / 1 MiB per second)`. A 2 GiB transfer therefore has a 2,168-second total deadline and can exceed 120 seconds while progressing. The same size-scaled deadline overrides the SDK's absolute request timeout for PUT and GET; socket inactivity is still bounded. Bucket checks and deletes keep their 120-second control timeout. Writes have one conditional attempt and are never retried after a timeout or ambiguous failure. Privacy receipt files are capped separately below.

## Reconcile and finalize the imported merchant

Keep source and destination stopped and drained. Arrange the merchant's webhook delivery cutover and recover events missed during the stopped interval before reopening service. Verify the imported paid rights and destination adapters. Stripe account migration is never implicit.

```sh
node --env-file-if-exists=.env src/maintenance-cli.ts finalize \
  --operator operator@example.com --quiesced \
  --expected-stripe-account acct_REPLACE
```

The command verifies the actual direct credential account again. `completePortabilityImport` supplies every imported subscription and pending receipt, including queued subscription reconciliation that has not created a license. The CLI uses `StripeBilling`, `Billing`, and `Licenses` to apply authoritative snapshots. It creates no manual grants and performs no provider writes or charges.

For every pending receipt it decrypts the destination-encrypted payload, checks stored identity/type, retrieves the canonical Stripe event under the verified merchant, checks event/object identity, resolves its subscription with `StripeBilling.resolveSubscription`, and reconciles that subscription. It marks the receipt processed only after those steps succeed and a guarded SQL update confirms the receipt is unchanged. Supported event families are `customer.subscription.*`, `invoice.*`, `checkout.session.*`, `charge.*`, and `refund.*`. A successful provider resolution can establish that an event has no subscription; unknown families require operator investigation and remain pending.

Only the library's final transaction clears processed receipt payloads, cancels held original provider jobs, releases held initial-key emails, advances the import marker, and unsuspends primary. Provider failures, invalid ciphertext, mismatched merchant/event identity, unsupported events, or remaining unprocessed receipts leave the imported tenant suspended. Successfully reconciled local work can remain applied after another receipt fails; retry finalization after resolving the cause. A repeated successful finalization is refused. Do not manually clear receipts, modify marker locks, or unsuspend primary to bypass reconciliation.

A successful command returns `{"tenantId":"primary","finalized":true}`. Confirm webhook/adaptor configuration and current provider state before restarting services and reopening ingress.

## Inspect customer closure requests

These commands expose scoped request metadata, not customer email, raw provider data, tokens, or credentials:

```sh
node --env-file-if-exists=.env src/maintenance-cli.ts closures \
  --operator operator@example.com --quiesced --tenant primary --limit 100

node --env-file-if-exists=.env src/maintenance-cli.ts closure-inspect \
  --operator operator@example.com --quiesced --tenant primary \
  --customer CUSTOMER_ID --request REQUEST_ID
```

`closures` sorts by request ID, defaults to 100 rows, and accepts `--limit 1..500`. Continue a page with `--after LAST_REQUEST_ID`. `closure-inspect` requires matching tenant, customer, and request. Both record operator access. For hosted installations use the internal tenant ID, not its public slug.

## Review and reconcile closure

Use the existing customer closure request. Reconcile subscriptions and financial transactions through the normal provider review process. Resolve paid or installed rights only under separate explicit authorization. This CLI never revokes licenses, cancels subscriptions, deletes remote customers, or sends mail to force a closure through.

Review the customer's current Stripe binding and every selected provider event, work item, audit row, and outgoing event. The account service validates ownership, processed receipts, terminal/unleased jobs and deliveries, and financial retention. Delivered mail, remote providers, and backups require their own retention handling.

Prepare a private, operator-reviewed regular JSON file, owned by the running OS user and mode 0600, at most 256 KiB. Symlinks and nonregular files are refused. The strict schema is:

```json
{
  "version": 1,
  "operatorId": "operator@example.com",
  "tenantId": "primary",
  "customerId": "CUSTOMER_ID",
  "requestId": "REQUEST_ID",
  "approval": {
    "quiesced": true,
    "stripeReconciled": true,
    "retentionReviewed": true,
    "reference": "privacy-review-ticket-123",
    "stripeCustomerId": "cus_REPLACE",
    "eventIds": [],
    "workIds": [],
    "auditIds": [],
    "outgoingEventIds": []
  }
}
```

Use `stripeCustomerId:null` only when the current local binding is null. The four ID arrays are explicit reviewed selections, each at most 1,000 IDs, not wildcard deletion requests. Identity/reference/record IDs are at most 200 characters; Stripe customer binding is at most 150. Unknown keys or missing/false attestations fail validation. Receipt identity must match all command flags. No token, passphrase, provider payload, or customer email belongs in this file. Protect and retain the receipt according to the review policy; the account service stores minimal hashed references and allowlisted financial receipts.

```sh
node --env-file-if-exists=.env src/maintenance-cli.ts closure-reconcile \
  --operator operator@example.com --quiesced --tenant primary \
  --customer CUSTOMER_ID --request REQUEST_ID \
  --receipt /secure/maintenance/closure-reviewed.json

node --env-file-if-exists=.env src/maintenance-cli.ts closure-approve \
  --operator operator@example.com --quiesced --tenant primary \
  --customer CUSTOMER_ID --request REQUEST_ID \
  --receipt /secure/maintenance/closure-reviewed.json
```

`closure-reconcile` calls `CustomerAccounts.reconcileClosure`. It retains financial/event receipts, redacts only explicitly selected owned records, and clears the local Stripe binding after validation. The ticket reference is idempotent; use a newly reviewed reference for a later reconciliation of additional records. Do not edit receipts merely to bypass a blocker.

`closure-approve` calls `CustomerAccounts.approveClosure` with all three validated attestations. It returns `blocked` with durable reasons or safely anonymizes once paid rights, subscriptions, bindings, work, and retained payload blockers are resolved. A blocked result is a successful command, so check JSON `status`, not exit code alone. Completed approval is idempotent. The receipt records an operator attestation; it is not an automated claim that Stripe or external retention obligations are satisfied.

## Discover closure blockers before reconciliation

`closure-inspect` recomputes current blockers and returns `blockerRecords` with
sorted IDs under `customers`, `licenses`, `emails`, `billing_events`, `work`,
`audit_events`, `outbound_events` and `outbound_deliveries`. Blocked approval
returns the same structure. These results contain IDs, not decrypted payloads.
Use the applicable IDs in the reviewed reconciliation receipt; unrelated records
are rejected. Rerun inspection after reconciliation before approving closure.

Completed closures retain keyed attribution tombstones and minimal financial
receipts. A matching late Stripe event becomes a processed receipt containing
its event ID/type, a keyed digest and allowlisted financial values. It does not
restore customer identity, create billing work, or issue paid rights. Events
without customer identity require canonical, account-scoped provider attribution;
provider failures remain retryable instead of retaining an unverified payload.

These receipts have no automatic expiry. Retain them and their HMAC key while
accepting late events, replays or manual reconciliation. Before key rotation or
record deletion, review the retention policy and preserve the attribution needed
to prevent identity from returning. Failed recovery audits also use a keyed digest.

Publisher portability preserves receipt-free pending closure requests and completed closure history with minimal financial attribution. Export returns `409 closure_reconciliation_pending` if an unfinished closure already has reconciliation receipts; finish that operator review before transferring. The encrypted transfer excludes `APP_SECRET` and source keyed
reference digests. Import re-encrypts the scoped Stripe customer identifier and
rebuilds reference digests with the destination secret. Retained
`events[].payloadHash` values, including source keyed payload digests, transfer
unchanged as opaque audit values that cannot be verified at the destination.
Provider event IDs/types, invoice IDs and license subscription IDs transfer too.
No source secret or verifier key is exported. Finalization skips completed
closed-customer subscriptions before provider reads. Matching late events remain minimal after cutover. Older receipts
need the reviewed upgrade below before they can be exported.

## Upgrade legacy closure attribution

For attribution upgrades, all four approval ID arrays must be empty. This command backfills attribution without redacting additional records.

For `privacy_attribution_upgrade_required`, prepare the same owner-only reviewed
receipt schema used by closure reconciliation and add REQUIRED top-level
`"stripeLiveMode": false` or `true`. Set `approval.stripeCustomerId` to the exact
reviewed provider customer ID. This is a local maintenance step; it does not
query Stripe or infer identity from a customer email.

```sh
node --env-file-if-exists=.env src/maintenance-cli.ts closure-attribution-upgrade \
  --operator operator@example.com --quiesced --tenant primary \
  --customer CUSTOMER_ID --request REQUEST_ID \
  --receipt /secure/maintenance/closure-reviewed.json
```

The explicit reviewed mode must match runtime and any retained boolean mode.
A missing legacy mode can be established by that reviewed value; malformed or
conflicting values refuse the upgrade. A provider ID must match the closure's
retained HMAC. Use null only when the customer never had any Stripe customer object and has no Stripe-linked licenses. Checkout creates that object before payment, so a customer who abandoned checkout has one. Supply its ID instead. Null must not mean only that there is no current subscription or local binding. All retained encrypted bindings must authenticate to the same scope.
The command updates receipts atomically and never exports a source secret or
unrelated tenant capability. A mismatched proof is an operator-review error,
not a reason to discard receipts or manually unsuspend a destination.
