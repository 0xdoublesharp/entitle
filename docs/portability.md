# Move a publisher to self hosting

Export your workspace and import it into a fresh standalone installation.
You need a verified Stripe merchant account, including for a complimentary-only
workspace. Any hosted tier can export, regardless of platform billing status.

The transfer preserves the public workspace slug and product slugs, products and plans, customers, license key hashes, paid grants, installation token hashes and encrypted retry tokens, immutable release artifacts including withdrawn releases and every target, download and invoice metrics, and billing receipt IDs and processing timestamps. Internal ownership changes to the standalone `primary` tenant. It never generates replacement licenses or activation tokens.

The transfer excludes seller identities, memberships, sessions, authentication challenges, API keys, buyer login sessions and links, platform subscriptions, platform work, sandbox administration, outgoing webhook credentials, and the source `APP_SECRET`. Only license-key email records are included. An unsent initial license key stays encrypted and available for delivery after reconciliation. Processed billing payloads are cleared to avoid moving unnecessary personal information; receipt IDs, type and timestamps remain. Unprocessed billing events and outstanding reconciliation work remain encrypted and held for operator review.

## Export

The service creates an encrypted manifest and separate encrypted blob files in an operator-configured private working directory. Files use AES-256-GCM with a fresh 16-byte salt for each export and a fresh 12-byte nonce for each file. The passphrase derives a 32-byte key through scrypt with N=32768, r=8, p=1 and a 64 MiB memory ceiling. Authentication binds each encrypted blob to its identifier and format. The authenticated manifest records plaintext and ciphertext sizes and checksums.

A passphrase must contain 12 to 1024 characters. Keep it separately from the exported folder. The service cannot recover it. Provide it in the export POST body, never a URL, CLI argument, environment variable, or log. The offline CLI reads it from a private input descriptor or pipe and refuses terminal input. Configure request logging to exclude the body and authentication headers. See [operator maintenance](operator-maintenance.md#import-a-private-encrypted-export).

Default bounds are four concurrent creating or retained exports, one per tenant, a 16 MiB manifest, and a 10 GiB aggregate working-storage reservation. `EXPORT_MAX_EXPORTS` accepts 2 through 10 and `EXPORT_MAX_GIB` accepts 1 through 10. Reservations include plaintext, ciphertext and encrypted manifest overhead. Creation has a 120-second no-progress deadline and a size-scaled total deadline. Disconnects cancel and clean up an unfinished export. Metadata is read a row at a time with a manifest size limit before downloading artifacts. Artifacts stream through private files; the complete workspace is never encoded as a base64 archive in memory. A store without the optional file methods supports only artifacts up to the existing 100 MiB buffer limit.

Export API, mounted at `/api/v1/tenants/:tenant/seller`:

- `POST /exports`, body `{ "passphrase": "..." }`, returns `{ id, expiresAt, blobs }`. Limit two requests per minute per rate-limit key.
- `GET /exports/:id/manifest`, returns encrypted `manifest.entitle` bytes.
- `GET /exports/:id/blobs/:blobId`, returns an encrypted `<blobId>.blob`. Download routes allow 30 requests per minute and do not expose HEAD.
- `DELETE /exports/:id`, body `{}`, removes an owned export. Limit ten requests per minute.

Every operation checks authenticated tenant ownership and the dedicated `data:export` API-key scope. Cookie POST and DELETE requests require same-origin and CSRF headers. Cookie downloads validate the CSRF header against the authenticated seller session in constant time and do not require an Origin header, which normal browser GET requests omit. Creating an export through a seller session consumes fresh `tenant_transfer` verification from `x-account-verification`. Scoped API keys use their explicit authorization instead. Creation sets no Pro requirement and accepts no filesystem path. Download responses have `Cache-Control: no-store`. A browser never receives the operator token.

Download all files into a generated folder with mode 0700 and files mode 0600. Keep filenames exactly `manifest.entitle` and the returned UUID blob names. Do not implement a generic URL fetch or extract a caller-supplied archive.

Each export expires one hour after creation completes. Call `cleanupExpired()` periodically. It deletes only directories owned by that `Portability` instance and skips active downloads. A new export also triggers expiry cleanup. Call `close()` after HTTP requests and download streams have drained. Export handles are process-local; a restart invalidates handles. After a crash, an operator may remove abandoned generated folders only after verifying that the owning process has stopped. Automatic cleanup does not sweep unknown directories.

## Prepare the destination

1. Provision a private standalone installation on a private working volume, with a fresh migrated database and an empty `primary` tenant. Import before creating seller accounts, sessions, products or other application state. Stop HTTP traffic and workers throughout import and reconciliation.
2. Provision a new private S3 bucket. The destination `ArtifactStore` must use conditional immutable writes. Use `verifyEmptyPrivatePortabilityBucket(client, bucket)` as the `verifyDestinationEmpty` callback. It accepts only an owner-only ACL, no bucket policy and an empty bucket. It also supports MinIO's empty canonical-owner identifier. Custom stores must provide an equally strict operator-controlled preflight.
3. Generate a new destination `APP_SECRET`. Do not copy the hosted root secret. Configure the destination artifact limits to support the largest exported artifact.
4. Verify the destination Stripe credential's account identity through the Stripe Dashboard or an operator-controlled account retrieval. The account must be the exact connected merchant from the source export. Supply that verified `acct_...` value explicitly as `expectedStripeAccountId`. Do not substitute the platform's account or an unrelated account.

For a standalone export, construct `Portability` with the explicitly verified `sourceStripeAccountId`; hosted exports read the tenant's connected account. Standalone commerce keeps `stripe_account_id` null, as required by its direct-account Stripe adapter. Import records a hash of the expected merchant in an internal lock marker, and returns the source account ID for the operator's reconciliation record.

Transfers preserve complimentary provenance, expiration, allowance, and
encrypted seller notes. Reconciliation leaves these licenses complimentary.
Older paid bundles remain importable. Before configuring Stripe, use
[database and artifact backup and restore](backup.md) for server recovery.
Customer account data exports remain available without Stripe and exclude
internal seller notes. Approved customer closure scrubs those notes.

## Import and reconcile

Use the [offline operator CLI](operator-maintenance.md#import-a-private-encrypted-export)
for import and financial finalization. There is no browser import route or
browser-controlled write path. The CLI invokes the local library workflow below;
custom operator tooling must enforce the same quiescence and merchant checks:

```ts
const imported = await importPortability({
  db,
  store,
  secret: config.secret,
  directory: privateWorkingDirectory,
  bundleDirectory: operatorSelectedBundleDirectory,
  passphrase,
  expectedStripeAccountId: verifiedMerchantAccountId,
  deploymentMode: "standalone",
  verifyDestinationEmpty: () =>
    verifyEmptyPrivatePortabilityBucket(destinationS3Client, bucket),
});
```

Import authenticates the encrypted manifest, checks the format version, exact allowlisted tables and columns, safe identifiers, tenant ownership and relationships, and verifies every encrypted and plaintext artifact before inserting state. It checks the fresh database before storage work and again under the primary schema lock. Storage writes and readback verification finish before the database transaction commits. Existing destination objects are never overwritten.

On failure, the database transaction rolls back and the importer deletes only objects whose immutable writes returned success. It does not delete a colliding preexisting object or an object with an uncertain write outcome. A cleanup failure reports `import_cleanup_failed` with the known object IDs for operator cleanup. Keep failed destinations offline and inspect their bucket before retrying. Private plaintext working files are removed after success or failure.

Installation tokens and pending email/provider payloads are re-encrypted under the destination secret. Original hashes, paid grants and immutable artifact identities remain intact. Original provider jobs are held instead of being blindly replayed. The imported tenant starts suspended, and key emails remain held. This is a migration maintenance state, independent of a seller's platform or Pro payments.

Stripe cutover requires real operator work; import does not change any live provider configuration:

1. Put the source publisher in migration maintenance and drain its billing workers and mail leases before taking the final export. Stop source billing and license mutations. Preserve the source until the destination is verified. Do not run both installations as billing writers.
2. Verify that the merchant account still owns the exported customers, prices, invoices and subscriptions. If it is not the same account, stop. This import does not implement a Stripe account-to-account customer or subscription migration.
3. Configure the destination direct-account webhook endpoint and its own webhook signing secret. Check live/test mode and event types. Review the interval around source shutdown against Stripe events and invoices. Source Connect delivery and destination account-level delivery have different endpoint configuration even when the merchant is the same.
4. Use the existing destination billing services to retrieve authoritative subscription/invoice snapshots for every returned subscription ID. Handle every pending receipt through verified provider reconciliation, including paid events whose license does not exist yet. Mark a receipt processed only after its effects have been durably reconciled. Reconcile any events received during cutover before enabling traffic.
5. Finalize through the operator-only function below. The callback must do the provider reconciliation, not merely acknowledge the list. A failed callback or any unprocessed receipt leaves maintenance in place. Finalization cancels the held source job records, clears processed payloads and releases the original initial-key emails without issuing new licenses.

```ts
await completePortabilityImport({
  db,
  secret: config.secret,
  expectedStripeAccountId: verifiedMerchantAccountId,
  reconcile: async ({ subscriptionIds, pendingEventIds }) => {
    // Reconcile through the destination Billing and verified Stripe adapters.
    // Verify pending receipts and mark each processed only after applying it.
    await operatorReconciliation(subscriptionIds, pendingEventIds);
  },
});
```

The finalizer independently reads queued reconciliation subscriptions, including those with no license yet, and checks for unprocessed receipts before releasing maintenance. Keep the source stopped after cutover. Check a preserved license activation retry, a paid buyer download, the initial key email, artifact hashes and receipt counts before directing traffic to the destination.

## Public endpoint changes

The original workspace slug becomes the `primary` tenant's public slug. Standalone guards must check `tenant.id === "primary"`, and the initial UI must use the database's actual slug rather than assuming the slug is `primary`.

A changed public origin still requires an explicit adapter endpoint update. Update installed clients' configured API/update endpoint to the new origin and preserved workspace/product paths. Preserve existing activation tokens; do not rotate licenses merely to move the endpoint. Never forward Authorization, cookies or other credentials automatically across origins or rely on a cross-origin redirect to move them. Coordinate the endpoint change with customers before retiring the old host. Installed software continues to function during migration or service outages.

## Customer closure requests

Transfers preserve receipt-free awaiting-operator and blocked closure requests, including their IDs, status, blockers and request times. They remain visible to the buyer after import and continue through canonical billing reconciliation. If an unfinished closure already has reconciliation receipts, export refuses with `409 closure_reconciliation_pending` before reading artifacts. An operator must finish that privacy review before transfer.

Transfers preserve completed closure rows and their minimal financial receipts.
Necessary Stripe customer attribution is encrypted at rest and authenticated to
its tenant, customer, closure request and test/live mode. The Stripe customer
identifier enters the passphrase-encrypted manifest along with retained provider
event IDs/types, invoice IDs and license subscription IDs. The source
`APP_SECRET`, unrelated provider payloads and source keyed reference digests are
excluded. Import re-encrypts the customer identifier and rebuilds reference
digests using the destination secret and tenant identity.

Retained `events[].payloadHash` values, including source keyed payload digests,
transfer unchanged as opaque audit values. The destination cannot verify those
source keyed payload digests because no source secret or verifier key is exported.

Finalization skips subscriptions belonging to completed closed customers before
provider snapshot retrieval, including when Stripe has deleted that customer.
Subsequent matching provider events become minimal processed receipts at the
destination and cannot restore the closed identity, billing work or paid grants.

Older receipts without encrypted attribution need the shipped
`closure-attribution-upgrade` command before export. Its private reviewed receipt
must specify the exact customer/request, Stripe customer ID and explicit mode.
The command proves a supplied provider ID against retained keyed attribution,
checks every existing mode/binding and updates atomically without provider calls.
It never guesses the identifier or transfers a global verifier key. See
[operator maintenance](operator-maintenance.md#upgrade-legacy-closure-attribution).

## Recover handles and plan disk capacity

Authenticated `GET /exports` lists only the current tenant's creating, ready or
cleanup-pending handles. The dashboard's Refresh exports, Resume export and
Delete saved export controls recover access after a reload; the passphrase is
never recoverable from the service. Creating or leased bundles cannot be deleted.
An existing tenant bundle returns `export_tenant_held`; global slot exhaustion
returns `export_capacity`. Uncertain cleanup retains its disk reservation and is
retried without stopping unrelated export creation or billing/email work.

Export and import peak accounting includes the encrypted artifacts, one largest
plaintext artifact and encrypted manifest overhead. The default combined limit
is 10 GiB. It is a working-disk bound, not a promise to export every configured
storage allowance in one bundle. A tenant whose peak exceeds this cap receives
an explicit limit error; increasing paid storage alone does not raise transfer
capacity. Import authenticates artifacts before mutation and again on use,
staging only one working plaintext artifact at a time.
