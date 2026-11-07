import { AsyncLocalStorage } from "node:async_hooks";
import Stripe from "stripe";
import type { Knex } from "knex";
import type { DB, Job, Tx } from "./db.ts";
import { hash, seal, unseal } from "./crypto.ts";
import { assertQueueLease, DeferredJob, queueWorkerSignal, WorkerResourceLimit, type WorkerResourceLimits } from "./queue.ts";

interface TurnOptions extends WorkerResourceLimits {
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
type ResolvedWorkerResourceLimits = { [K in keyof WorkerResourceLimits]-?: number };
export const workerResourceDefaults: ResolvedWorkerResourceLimits = {
  maxFacts: 10000, maxBytes: 16 * 1024 ** 2, maxApplyRecords: 3000, maxApplyWork: 1000000, applyMs: 5000,
};
const hardLimits: ResolvedWorkerResourceLimits = {
  maxFacts: 50000, maxBytes: 64 * 1024 ** 2, maxApplyRecords: 20000, maxApplyWork: 10000000, applyMs: 30000,
};
export function billingWorkerResourceLimits(options: WorkerResourceLimits = {}): ResolvedWorkerResourceLimits {
  const limits = { ...workerResourceDefaults };
  for (const key of Object.keys(workerResourceDefaults) as (keyof WorkerResourceLimits)[]) {
    const value = options[key] ?? workerResourceDefaults[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > hardLimits[key])
      throw Error(`Invalid billing worker ${key} limit`);
    limits[key] = value;
  }
  return limits;
}
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
  private timer: ReturnType<typeof setTimeout>;
  readonly limits: ResolvedWorkerResourceLimits;
  private applyStarted = 0;
  private applyRecords = 0;
  private applyWork = 0;
  private storedChecked = false;
  private storedBytes = 0;
  private textBytes = 0;
  private readonly countedArrays = new WeakSet<readonly unknown[]>();
  constructor(options: TurnOptions) {
    const budget = options.budgetMs ?? 5000;
    const requests = options.maxRequests ?? 8;
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 60000 ||
        !Number.isSafeInteger(requests) || requests < 1 || requests > 100)
      throw Error("Invalid provider worker budget");
    this.options = options;
    this.limits = billingWorkerResourceLimits(options);
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
    if (queueWorkerSignal()?.aborted) this.defer();
    if (this.finalizing) {
      const elapsed = Math.max(0, performance.now() - this.applyStarted);
      if (this.signal.aborted || elapsed >= this.limits.applyMs)
        throw new WorkerResourceLimit("applyMs", Math.ceil(elapsed), this.limits.applyMs);
    } else if (this.signal.aborted || performance.now() >= this.deadline) this.defer();
  }
  // Complete evidence gets one separate, finite local apply phase. Exhaustion
  // retains the job for operator recovery; it never applies a truncated prefix.
  beginApply(): void {
    this.available();
    if (this.finalizing) return;
    this.options.onBeginApply?.();
    this.available();
    this.finalizing = true;
    clearTimeout(this.timer);
    this.applyStarted = performance.now();
    this.timer = setTimeout(() => this.controller.abort(), this.limits.applyMs);
    this.timer.unref();
  }
  work(amount = 1): void {
    this.available();
    if (!Number.isSafeInteger(amount) || amount < 0) throw Error("Invalid worker apply cost");
    this.applyWork += amount;
    if (this.applyWork > this.limits.maxApplyWork)
      throw new WorkerResourceLimit("maxApplyWork", this.applyWork, this.limits.maxApplyWork);
  }
  records(amount: number): void {
    this.work(amount);
    this.applyRecords += amount;
    if (this.applyRecords > this.limits.maxApplyRecords)
      throw new WorkerResourceLimit("maxApplyRecords", this.applyRecords, this.limits.maxApplyRecords);
  }
  array(values: readonly unknown[]): void {
    if (this.countedArrays.has(values)) { this.work(); return; }
    this.records(values.length);
    this.countedArrays.add(values);
  }
  async prepareTransaction(tx: Tx): Promise<void> {
    this.work();
    if (tx.client.config.client === "pg") {
      const remaining = Math.max(1, Math.floor(this.limits.applyMs - (performance.now() - this.applyStarted)));
      await tx.raw("select set_config('statement_timeout', ?, true)", [String(remaining)]);
      this.work();
    }
  }
  private boundedQuery<T>(query: Knex.QueryBuilder): Promise<T> {
    this.work();
    const remaining = this.finalizing
      ? this.limits.applyMs - (performance.now() - this.applyStarted)
      : this.deadline - performance.now();
    return query.timeout(Math.max(1, Math.floor(remaining)), {
      cancel: ["pg", "mysql2"].includes(this.options.db.client.config.client),
    }).then((result) => { this.work(); return result as T; }).catch((error: unknown) => {
      this.available();
      if (this.finalizing && error instanceof Error && error.name === "KnexTimeoutError")
        throw new WorkerResourceLimit("applyMs", this.limits.applyMs, this.limits.applyMs);
      throw error;
    });
  }
  async rows<T>(query: Knex.QueryBuilder): Promise<T[]> {
    const remaining = Math.max(0, this.limits.maxApplyRecords - this.applyRecords);
    const metadata = await this.boundedQuery<unknown[]>(query.clone().clearOrder().clearSelect()
      .select(this.options.db.raw("1 as worker_record")).limit(remaining + 1));
    this.records(metadata.length);
    const rows = await this.boundedQuery<T[]>(query.limit(metadata.length + 1));
    if (rows.length > metadata.length)
      throw new WorkerResourceLimit("maxApplyRecords", this.applyRecords + 1, this.limits.maxApplyRecords);
    this.countedArrays.add(rows);
    return rows;
  }
  private combinedBytes() {
    const bytes = this.storedBytes + this.textBytes;
    if (bytes > this.limits.maxBytes)
      throw new WorkerResourceLimit("maxBytes", bytes, this.limits.maxBytes);
  }
  // Use an indexed base-table query with a stable primary key. Lock the
  // metadata-selected rows until their bounded text fetch finishes, so a
  // concurrent receipt edit cannot grow past the preflight byte allowance.
  async textRows<T>(query: Knex.QueryBuilder, columns: readonly string[], connection: Tx = this.options.db, key = "id"): Promise<T[]> {
    await this.storedBounds(connection);
    const read = async (tx: Tx) => {
      const scoped = query.clone().transacting(tx as Knex.Transaction);
      const remaining = Math.max(0, this.limits.maxApplyRecords - this.applyRecords);
      const metadataQuery = scoped.clone().clearOrder().clearSelect()
        .select({ worker_text_id: key }).forUpdate().limit(remaining + 1);
      for (let index = 0; index < columns.length; index++)
        metadataQuery.select(connection.raw("octet_length(??) as ??", [columns[index]!, `worker_bytes_${index}`]));
      const metadata = await this.boundedQuery<({ worker_text_id: string } & Record<string, string | number | null>)[]>(metadataQuery);
      this.records(metadata.length);
      for (const row of metadata) {
        this.work(columns.length);
        for (let index = 0; index < columns.length; index++) this.textBytes += Number(row[`worker_bytes_${index}`] ?? 0);
        this.combinedBytes();
      }
      const rows = metadata.length
        ? await this.boundedQuery<T[]>(scoped.whereIn(key, metadata.map((row) => row.worker_text_id)).limit(metadata.length))
        : [];
      this.countedArrays.add(rows);
      return rows;
    };
    return connection.isTransaction ? read(connection) : connection.transaction(read);
  }
  json<T>(value: string): T {
    this.work(Math.max(1, Math.ceil(Buffer.byteLength(value) / 64)));
    const parsed = JSON.parse(value) as T;
    this.work();
    return parsed;
  }
  private async storedBounds(connection: Tx, force = false): Promise<void> {
    if (this.storedChecked && !force) { this.combinedBytes(); return; }
    let records = 0, bytes = 0;
    for (const table of ["worker_continuations", "worker_continuation_facts"]) {
      // The LIMIT bounds legacy scopes before aggregation/decryption too.
      const rows = await this.boundedQuery<{ bytes: number | string }[]>(connection(table)
        .where({ scope: this.scope }).select(connection.raw("octet_length(??) as ??", ["payload", "bytes"]))
        .limit(Math.max(1, this.limits.maxFacts - records + 1)));
      records += rows.length;
      if (records > this.limits.maxFacts)
        throw new WorkerResourceLimit("maxFacts", records, this.limits.maxFacts);
      for (const row of rows) {
        this.work(); bytes += Number(row.bytes);
        if (bytes + this.textBytes > this.limits.maxBytes)
          throw new WorkerResourceLimit("maxBytes", bytes + this.textBytes, this.limits.maxBytes);
      }
    }
    this.storedChecked = true;
    this.storedBytes = bytes;
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
    await this.storedBounds(this.options.db);
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
    if (Buffer.byteLength(encoded) > 512 * 1024) throw new WorkerResourceLimit("maxBytes", Buffer.byteLength(encoded), Math.min(512 * 1024, this.limits.maxBytes));
    await this.options.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await this.storedBounds(tx);
      await tx("worker_continuations").insert({
        ...this.key(slot), payload: seal(state, this.options.secret), updated_at: Date.now(),
        completed: Number(completed), lease_owner: this.options.job.lease_owner,
      }).onConflict(["scope", "slot"]).merge(["payload", "updated_at", "completed", "lease_owner"]);
      await this.storeFacts(tx, slot, facts);
      await this.storedBounds(tx, true);
    });
  }
  private async storeFacts(tx: Tx, slot: string, facts: WorkerFact[]) {
    facts = [...new Map(facts.map((fact) => [JSON.stringify([fact.kind, fact.id]), fact])).values()];
    if (facts.length > this.limits.maxFacts) throw new WorkerResourceLimit("maxFacts", facts.length, this.limits.maxFacts);
    let incomingBytes = 0;
    for (const kind of new Set(facts.map((fact) => fact.kind))) {
      if (!/^[a-zA-Z0-9_.:-]{1,32}$/.test(kind)) throw Error("Invalid worker fact kind");
      const last = await tx("worker_continuation_facts").where({ ...this.key(slot), kind })
        .max({ position: "position" }).first();
      let position = Number(last?.position ?? -1) + 1;
      const rows = facts.filter((fact) => fact.kind === kind).map((fact) => {
        if (!fact.id || fact.id.length > 150)
          throw Error("Invalid worker fact");
        const bytes = Buffer.byteLength(JSON.stringify(fact.value));
        if (bytes > 65536) throw new WorkerResourceLimit("maxBytes", bytes, 65536);
        const payload = seal(fact.value, this.options.secret);
        incomingBytes += payload.length;
        if (incomingBytes > this.limits.maxBytes) throw new WorkerResourceLimit("maxBytes", incomingBytes, this.limits.maxBytes);
        return { ...this.key(slot), kind, id: fact.id, position: position++, payload };
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
      await this.storedBounds(tx);
      await this.storeFacts(tx, slot, [{ kind, id, value }]);
      await this.storedBounds(tx, true);
    });
  }
  async fact<T>(slot: string, kind: string, id: string): Promise<T | undefined> {
    this.available();
    await this.storedBounds(this.options.db);
    const row = await this.options.db("worker_continuation_facts")
      .where({ ...this.key(slot), kind, id }).first("payload");
    this.work();
    return row ? unseal<T>(row.payload, this.options.secret) : undefined;
  }
  async facts<T>(slot: string, kind: string): Promise<T[]> {
    this.available();
    await this.storedBounds(this.options.db);
    const remaining = Math.max(0, this.limits.maxApplyRecords - this.applyRecords);
    const metadata = await this.boundedQuery<{ bytes: number | string }[]>(this.options.db("worker_continuation_facts")
      .where({ ...this.key(slot), kind }).select(this.options.db.raw("octet_length(??) as ??", ["payload", "bytes"]))
      .limit(remaining + 1));
    this.records(metadata.length);
    const rows = await this.boundedQuery<{ payload: string }[]>(this.options.db("worker_continuation_facts")
      .where({ ...this.key(slot), kind }).orderBy("position").orderBy("id").select("payload")
      .limit(metadata.length + 1));
    if (rows.length !== metadata.length) throw new WorkerResourceLimit("maxApplyRecords", this.applyRecords + 1, this.limits.maxApplyRecords);
    const values = rows.map((row) => { this.work(); return unseal<T>(row.payload, this.options.secret); });
    this.countedArrays.add(values);
    return values;
  }
  async reset(slot: string): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await tx("worker_continuation_facts").where(this.key(slot)).delete();
      await tx("worker_continuations").where(this.key(slot)).delete();
    });
    this.storedChecked = false;
  }
  async complete(): Promise<void> {
    await this.options.db.transaction(async (tx) => {
      await assertQueueLease(tx);
      await tx("worker_continuation_facts").where({ scope: this.scope }).delete();
      await tx("worker_continuations").where({ scope: this.scope }).delete();
    });
    this.storedChecked = false;
  }
  async discardCompletedEvidence(): Promise<void> {
    // Partial scans survive budget pauses. Once canonical evidence reaches an
    // apply attempt, any failure requires fresh provider data on the next try.
    if (this.finalizing) await this.complete();
  }
  close() { clearTimeout(this.timer); }
  failure(error: unknown): unknown {
    if (error instanceof WorkerResourceLimit || !this.finalizing || queueWorkerSignal()?.aborted) return error;
    try { this.available(); }
    catch (deadline) { return deadline; }
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "57014" || (error instanceof Error && error.name === "KnexTimeoutError"))
      return new WorkerResourceLimit("applyMs", this.limits.applyMs, this.limits.applyMs);
    return error;
  }
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
    const failure = turn.failure(error);
    if (!(failure instanceof WorkerResourceLimit)) await turn.discardCompletedEvidence();
    throw failure;
  } finally { turn.close(); }
}
