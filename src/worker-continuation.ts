import { AsyncLocalStorage } from "node:async_hooks";
import Stripe from "stripe";
import type { DB, Job, Tx } from "./db.ts";
import { hash, seal, unseal } from "./crypto.ts";
import { assertQueueLease, DeferredJob, queueWorkerSignal } from "./queue.ts";

interface TurnOptions {
  db: DB;
  secret: string;
  job: Job;
  table: "work" | "platform_work";
  tenantId?: string | undefined;
  budgetMs?: number | undefined;
  maxRequests?: number | undefined;
  onBeginApply?: (() => void) | undefined;
}
export interface WorkerFact { kind: string; id: string; value: unknown }
const currentTurn = new AsyncLocalStorage<WorkerTurn>();
const retryDelay = 1000;

export function workerTurn(): WorkerTurn | undefined {
  return currentTurn.getStore();
}

export function workerContinuationScope(table: "work" | "platform_work", tenantId: string | undefined, jobId: string): string {
  return hash(JSON.stringify([table, tenantId ?? null, jobId]));
}

// Unlike Node's socket inactivity timeout, this client keeps the request/body
// deadline armed and aborts the actual fetch before a queue lease is released.
export function stripeWorkerHttpClient(): Stripe.HttpClient {
  return Stripe.createFetchHttpClient((input, init) => {
    const signals = [init?.signal, workerTurn()?.signal, queueWorkerSignal()]
      .filter((signal): signal is AbortSignal => !!signal);
    return fetch(input, {
      ...init,
      ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
    });
  });
}

export class WorkerTurn {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly options: TurnOptions;
  private readonly scope: string;
  private readonly deadline: number;
  private readonly maxRequests: number;
  private requests = 0;
  private finalizing = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(options: TurnOptions) {
    const budget = options.budgetMs ?? 5000;
    const requests = options.maxRequests ?? 8;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60000 ||
        !Number.isSafeInteger(requests) || requests < 1 || requests > 100)
      throw Error("Invalid provider worker budget");
    this.options = options;
    this.scope = workerContinuationScope(options.table, options.tenantId, options.job.id);
    this.deadline = performance.now() + budget;
    this.maxRequests = requests;
    const queueSignal = queueWorkerSignal();
    this.signal = queueSignal
      ? AbortSignal.any([this.controller.signal, queueSignal])
      : this.controller.signal;
    this.timer = setTimeout(() => this.controller.abort(), budget);
    this.timer.unref();
  }
  private defer(): never {
    throw new DeferredJob(Date.now() + retryDelay);
  }
  private available() {
    if (this.signal.aborted || (!this.finalizing && performance.now() >= this.deadline)) this.defer();
  }
  // Canonical provider evidence is complete. Local reconstruction/apply remains
  // lease-fenced, but it must not repeatedly expire while reading a large set of
  // already staged financial facts. No further provider request may start.
  beginApply(): void {
    this.available();
    this.options.onBeginApply?.();
    this.available();
    this.finalizing = true;
    clearTimeout(this.timer);
  }
  private key(slot: string) {
    if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(slot)) throw Error("Invalid worker state slot");
    return { scope: this.scope, slot };
  }
  async read<T>(call: (options: Stripe.RequestOptions) => Promise<T>): Promise<T> {
    this.available();
    if (this.finalizing) this.defer();
    if (this.requests >= this.maxRequests) this.defer();
    this.requests++;
    try {
      const result = await call({
        timeout: Math.max(1, Math.floor(this.deadline - performance.now())),
        maxNetworkRetries: 0,
      });
      this.available();
      return result;
    } catch (error) {
      // The SDK's integer millisecond timeout may settle just before our
      // monotonic deadline. It is still an exhausted worker turn, not a failed
      // provider attempt that should consume the queue's retry-age budget.
      if (error instanceof Stripe.errors.StripeConnectionError &&
          (error.raw as { detail?: { code?: string } }).detail?.code === Stripe.HttpClient.TIMEOUT_ERROR_CODE)
        this.defer();
      if (this.signal.aborted || performance.now() >= this.deadline) this.defer();
      throw error;
    }
  }
  async state<T>(slot: string, initial: T): Promise<T> {
    this.available();
    const row = await this.options.db("worker_continuations")
      .where(this.key(slot)).first("payload", "completed", "lease_owner");
    if (row?.completed && row.lease_owner !== this.options.job.lease_owner) {
      // A crash or lost lease can prevent failure cleanup. Ready evidence from
      // a previous apply attempt must not outlive that claim; partial scans can.
      await this.reset(slot);
      return initial;
    }
    return row ? unseal<T>(row.payload, this.options.secret) : initial;
  }
  async save<T>(slot: string, state: T, facts: WorkerFact[] = [], completed = false): Promise<void> {
    this.available();
    const encoded = JSON.stringify(state);
    if (Buffer.byteLength(encoded) > 512 * 1024) throw Error("Worker checkpoint is too large");
    await this.options.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await tx("worker_continuations").insert({
        ...this.key(slot), payload: seal(state, this.options.secret), updated_at: Date.now(),
        completed: Number(completed), lease_owner: this.options.job.lease_owner,
      }).onConflict(["scope", "slot"]).merge(["payload", "updated_at", "completed", "lease_owner"]);
      await this.storeFacts(tx, slot, facts);
    });
  }
  private async storeFacts(tx: Tx, slot: string, facts: WorkerFact[]) {
    facts = [...new Map(facts.map((fact) => [JSON.stringify([fact.kind, fact.id]), fact])).values()];
    for (const kind of new Set(facts.map((fact) => fact.kind))) {
      if (!/^[a-zA-Z0-9_.:-]{1,32}$/.test(kind)) throw Error("Invalid worker fact kind");
      const last = await tx("worker_continuation_facts").where({ ...this.key(slot), kind })
        .max({ position: "position" }).first();
      let position = Number(last?.position ?? -1) + 1;
      const rows = facts.filter((fact) => fact.kind === kind).map((fact) => {
        if (!fact.id || fact.id.length > 150 || Buffer.byteLength(JSON.stringify(fact.value)) > 65536)
          throw Error("Invalid worker fact");
        return { ...this.key(slot), kind, id: fact.id, position: position++, payload: seal(fact.value, this.options.secret) };
      });
      for (let offset = 0; offset < rows.length; offset += 100)
        await tx("worker_continuation_facts").insert(rows.slice(offset, offset + 100))
          .onConflict(["scope", "slot", "kind", "id"]).merge(["payload"]);
    }
  }
  async stage(slot: string, kind: string, id: string, value: unknown): Promise<void> {
    this.available();
    await this.options.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await this.storeFacts(tx, slot, [{ kind, id, value }]);
    });
  }
  async fact<T>(slot: string, kind: string, id: string): Promise<T | undefined> {
    this.available();
    const row = await this.options.db("worker_continuation_facts")
      .where({ ...this.key(slot), kind, id }).first("payload");
    return row ? unseal<T>(row.payload, this.options.secret) : undefined;
  }
  async facts<T>(slot: string, kind: string): Promise<T[]> {
    this.available();
    const rows = await this.options.db("worker_continuation_facts")
      .where({ ...this.key(slot), kind }).orderBy("position").orderBy("id").select("payload");
    return rows.map((row) => unseal<T>(row.payload, this.options.secret));
  }
  async reset(slot: string): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await tx("worker_continuation_facts").where(this.key(slot)).delete();
      await tx("worker_continuations").where(this.key(slot)).delete();
    });
  }
  async complete(): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await tx("worker_continuation_facts").where({ scope: this.scope }).delete();
      await tx("worker_continuations").where({ scope: this.scope }).delete();
    });
  }
  async discardCompletedEvidence(): Promise<void> {
    // Partial scans survive budget pauses. Once canonical evidence reaches an
    // apply attempt, any failure requires fresh provider data on the next try.
    if (this.finalizing) await this.complete();
  }
  close() { clearTimeout(this.timer); }
}

export async function withWorkerTurn<T>(options: TurnOptions, work: () => Promise<T>): Promise<T> {
  const turn = new WorkerTurn(options);
  try {
    return await currentTurn.run(turn, async () => {
      const result = await work();
      await turn.complete();
      return result;
    });
  } catch (error) {
    await turn.discardCompletedEvidence();
    throw error;
  } finally { turn.close(); }
}
