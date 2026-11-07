import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DB, Job, Tx } from "./db.ts";
import { lock } from "./db.ts";

export class DeferredJob extends Error {
  availableAt:number;
  readonly reason: "resource_budget" | "tenant_authority";
  constructor(availableAt:number, reason: "resource_budget" | "tenant_authority" = "resource_budget"){
    super("Job deferred by resource budget");this.availableAt=availableAt;this.reason=reason;
  }
}

export interface WorkerQueueOptions {
  signal?: AbortSignal;
  heartbeatMs?: number;
  leaseMs?: number;
  budgetMs?: number;
  maxRequests?: number;
  onBeginApply?: () => void;
}
interface QueueScope {
  signal: AbortSignal;
  assertCurrent: (tx: Tx) => Promise<void>;
}
const queueScope = new AsyncLocalStorage<QueueScope>();

export function queueWorkerSignal(): AbortSignal | undefined {
  return queueScope.getStore()?.signal;
}

// Worker applies fence their durable side effects with the queue row in the
// same transaction. Ordinary API and maintenance reconciliation has no scope.
export async function assertQueueLease(tx: Tx): Promise<void> {
  await queueScope.getStore()?.assertCurrent(tx);
}

export async function runQueue(
  db: DB,
  table: "work" | "emails" | "platform_work" | "platform_emails",
  handler: (job: Job) => Promise<void>,
  limit = 20,
  tenantId?: string,
  worker?: WorkerQueueOptions,
) {
  const leaseMs = worker?.leaseMs ?? 300000;
  const heartbeatMs = worker?.heartbeatMs ?? 60000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30 ||
      !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseMs)
    throw Error("Invalid worker lease or heartbeat duration");
  const tenantOwned = table === "work" || table === "emails";
  if (tenantOwned && !tenantId) throw Error("Tenant context is required for business jobs");
  const query = (connection: Tx) => {
    const q = connection<Job>(table);
    return tenantOwned ? q.where({ tenant_id: tenantId! }) : q;
  };
  for (let i = 0; i < limit; i++) {
    if (worker?.signal?.aborted) break;
    const job = await db.transaction(async (tx) => {
      await lock(tx, table.endsWith("work") ? "work" : "email", tenantId);
      const row = await query(tx)
        .whereIn("state", ["pending", "running"])
        .andWhere("available_at", "<=", Date.now())
        .andWhere("lease_until", "<", Date.now())
        .orderBy("created_at")
        .first();
      if (!row) return;
      const owner = randomUUID();
      await query(tx)
        .where({ id: row.id })
        .update({
          state: "running",
          lease_until: Date.now() + leaseMs,
          lease_owner: owner,
          attempts: row.attempts + 1,
        });
      return { ...row, attempts: row.attempts + 1, lease_owner: owner };
    });
    if (!job) break;
    const controller = new AbortController();
    const abort = () => controller.abort(new DeferredJob(Date.now() + 5000));
    worker?.signal?.addEventListener("abort", abort, { once: true });
    if (worker?.signal?.aborted) abort();
    let renewing = Promise.resolve();
    let busy = false;
    const renew = worker ? setInterval(() => {
      if (busy || controller.signal.aborted) return;
      busy = true;
      renewing = query(db)
        .where({ id: job.id, lease_owner: job.lease_owner, state: "running" })
        .andWhere("lease_until", ">", Date.now())
        .update({ lease_until: Date.now() + leaseMs })
        .then((changed) => { if (!changed) abort(); })
        .catch(abort)
        .finally(() => { busy = false; });
    }, heartbeatMs) : undefined;
    renew?.unref();
    const stopRenewal = async () => {
      if (renew) clearInterval(renew);
      await renewing;
      worker?.signal?.removeEventListener("abort", abort);
    };
    const scope: QueueScope = {
      signal: controller.signal,
      assertCurrent: async (tx) => {
        controller.signal.throwIfAborted();
        const current = await query(tx)
          .where({ id: job.id, lease_owner: job.lease_owner, state: "running" })
          .andWhere("lease_until", ">", Date.now())
          .forUpdate()
          .first("id");
        if (!current) {
          abort();
          controller.signal.throwIfAborted();
        }
      },
    };
    try {
      if (worker) await queueScope.run(scope, () => handler(job));
      else await handler(job);
      await stopRenewal();
      if (worker) controller.signal.throwIfAborted();
      await query(db)
        .where({ id: job.id, lease_owner: job.lease_owner, state: "running" })
        .update({
          state: "sent",
          lease_until: 0,
          lease_owner: null,
          last_error: null,
          ...(table.endsWith("emails") ? { payload: "" } : {}),
        });
    } catch(caught) {
      await stopRenewal();
      const error = worker && controller.signal.aborted ? controller.signal.reason : caught;
      await query(db)
        .where({ id: job.id, lease_owner: job.lease_owner, state: "running" })
        .update({
          state: error instanceof DeferredJob ? "pending" : Date.now()-Number(job.created_at)>=72*3600000 ? "failed" : "pending",
          attempts: error instanceof DeferredJob ? job.attempts-1 : job.attempts,
          lease_until: 0,
          lease_owner: null,
          available_at: error instanceof DeferredJob ? error.availableAt : Date.now() +
            Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12)),
          last_error: error instanceof DeferredJob ? "resource_budget" : "processing_failed",
        });
    }
  }
}
