# Backup and restore

Back up the database, private S3 objects and APP_SECRET as one application state. Keep Stripe/SMTP/storage credentials, operator settings and the recorded image digest in an encrypted configuration backup. Never commit dumps, raw webhooks or credentials. Local temporary verification copies belong on Scratch.

## Who operates backups

For the hosted service, the platform operator owns database, object-storage,
configuration and restore procedures. A seller downloading their release ZIPs
is not a complete account backup. Encrypted tenant exports are available for operator-controlled transfer to a
fresh standalone deployment. They exclude platform and login state and do not
replace these whole-service backups. This repository does not promise a hosted
backup retention period. See [portability](portability.md).

For self-hosted standalone, you are the operator and must arrange the backups
and restore drills below. Preserve `DEPLOYMENT_MODE=standalone`, the configured
owner identity and the same merchant Stripe account when restoring. A hosted
platform restore must preserve `DEPLOYMENT_MODE=hosted` and its connected-account
and platform billing mappings. Switching modes is not a restore or migration.

## Consistent backup

Stop the application so publication, activation and queue delivery cannot change during the backup. Keep the proxy running if desired; it returns unavailable. Record schema migration state, database/provider versions, image digest, bucket/key inventory and checksums.

For SQLite, archive the full persistent directory after shutdown, including `entitle.sqlite` and any WAL/SHM files. Do not copy only the live main file. For PostgreSQL use `pg_dump --format=custom` into your encrypted backup destination. For MySQL use `mysqldump --single-transaction --routines --triggers` with credentials from a protected option file. Avoid passwords in command arguments/history.

In the same maintenance window, back up the complete private bucket namespace `tenants/`, including withdrawn artifacts and any pending objects/reservations. Use provider versioning plus an independent encrypted backup/export; versioning alone is not a backup. Record object content SHA-256 against release metadata and every `release_assets` row; provider ETags may describe multipart/encrypted representations and are not interchangeable with SHA-256. Do not expire withdrawn or paid-customer artifacts through an unreviewed lifecycle rule. Keep public access blocked on the backup too.

Restart only after database/config/object snapshots complete. Persistent working-directory temporary files are disposable; the database's upload reservations allow orphan cleanup after interrupted publication. Preserve originals when their ownership is uncertain.

## Restore

1. Keep every app, worker, scheduler and mail sender stopped, including separate services managed by an orchestrator. Keep incoming traffic closed. Use a fresh database/private bucket and verify backup checksums.
2. Restore the matching database snapshot and all objects under their exact generated keys. WordPress objects use the release ID; framework assets use the asset ID, each under `tenants/TENANT_ID/releases/ID.zip`. The private key suffix does not describe the native file format. Restore the complete `release_assets` table and every target, not only each parent release's first checksum. Preserve withdrawn artifacts. Do not republish the same release as a new version or overwrite unrelated objects.
3. Restore the original APP_SECRET and environment, adjusting only the new private bucket/endpoint/credentials and host paths. Operator/API keys can be deliberately rotated; changing APP_SECRET without a migration loses encrypted retry material.
4. While all processes remain stopped, reapply post-snapshot operator revocations, tenant suspensions, account closures and key rotations from the operational record. Invalidate restored buyer/seller login tokens and sessions that must no longer authorize access. Review pending and leased work, email and webhook queues against those changes, and durably cancel or retain each affected job before any dispatcher starts. A restored login email must not resend a credential invalidated after the snapshot. An older snapshot can resurrect both credentials and queued deliveries; closing public traffic alone does not prevent outbound work.
5. Start the recorded image with `SERVER_ROLE=api` explicitly set, with traffic still restricted to the restore operator. This role has no background timer; keep every separate worker and sender stopped, and do not invoke job-running or seller reconciliation routes until the queue review is complete. Verify readiness and a known authenticated download's SHA-256/size against database release or asset metadata. Check one target for each restored framework; parent framework release size is the sum of all asset sizes. Test tenant isolation using valid restored or deliberately provisioned credentials. Do not use an anonymous public ZIP link as a restore check.
6. After the revocations and queue dispositions are committed, reconcile merchant purchases in standalone, or connected seller purchases and platform subscriptions in hosted mode, with Stripe; retain processed event IDs for safe redelivery. Resolve reconciliation failures before reopening traffic. Start the normal worker role only after this review, retry failed jobs explicitly as appropriate, then request fresh buyer/seller login links and check delivery before reopening traffic. Preserve the worker hold in the process manager so a restart cannot enable the default `SERVER_ROLE=all` during recovery.

Email remains at-least-once if SMTP's success reply was lost; stable Message-ID and encrypted key payload are preserved until confirmed delivery. A restored service never fetches customer site URLs or disables installed plugin functionality. Periodically perform an isolated restore drill; document the exact engines/provider/image and checks actually exercised.

## A customer closure is not a restore

Customer closure uses a separate offline, operator-reviewed maintenance workflow.
Stop every application and worker using the database, wait for external calls to
drain, reconcile financial/provider records, and review retention before approving
anonymization. Do not delete another customer's history to clear a blocker.
Keyed reference digests retain attribution during the procedure without retaining
the former raw provider binding. Device labels and site metadata are included in
the customer's export and removed on completion. Financial/revocation receipts
and previously delivered/provider/backed-up copies follow their own retention.
See [operator maintenance](operator-maintenance.md) for commands and receipts.
