import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { createTenant, reset, type Job } from "../src/db.ts";
import {
  DeferredJob,
  queueWorkerSignal,
  runQueue,
  WorkerResourceLimit,
} from "../src/queue.ts";
import {
  epoch,
  invariantDatabase,
  parameters,
  sequence,
} from "./helpers/invariants.ts";

const database = await invariantDatabase();
const db = database.db;
after(() => database.close());
const tables = ["work", "emails", "platform_work", "platform_emails"] as const;
type QueueTable = (typeof tables)[number];
type QueueOperation = { by: number; outcome: "success" | "failure" | "defer" };
const table = fc.constantFrom(...tables);
const payload = "encrypted-recoverable-credential";
const tenant = (name: (typeof tables)[number]) =>
  name.startsWith("platform_") ? undefined : "primary";

async function seed(name: (typeof tables)[number], createdAt = epoch) {
  const tenantId = tenant(name);
  if (name === "emails") {
    await db("customers").insert({
      tenant_id: "primary",
      id: "owner",
      email: "owner@example.test",
    });
  }
  await db(name).insert({
    ...(tenantId ? { tenant_id: tenantId } : {}),
    ...(name === "emails" ? { customer_id: "owner" } : {}),
    id: "same-job",
    kind: "fixture",
    payload,
    created_at: createdAt,
  });
  if (tenantId) {
    await createTenant(db, {
      id: "other",
      slug: "other",
      name: "Other",
      exempt: 1,
    });
    if (name === "emails")
      await db("customers").insert({
        tenant_id: "other",
        id: "other-owner",
        email: "owner@example.test",
      });
    await db(name).insert({
      tenant_id: "other",
      ...(name === "emails" ? { customer_id: "other-owner" } : {}),
      id: "same-job",
      kind: "fixture",
      payload: "foreign-payload",
      created_at: createdAt,
    });
  }
}

async function ownJob(name: (typeof tables)[number]) {
  const query = db<Job>(name).where({ id: "same-job" });
  return (
    tenant(name) ? query.andWhere({ tenant_id: "primary" }) : query
  ).first();
}

test("expired poison jobs are dead-lettered while other leases are respected", async (t) => {
  await reset(db);
  await seed("work");
  t.mock.method(Date, "now", () => epoch);
  const running = {
    tenant_id: "primary", kind: "stripe_event", state: "running",
    payload, available_at: epoch, lease_owner: "previous", lease_until: epoch - 1,
    created_at: epoch - 1, attempts: 3,
  };
  await db("work").insert([
    { ...running, id: "old", created_at: epoch - 72 * 3600000 - 1, available_at: epoch + 1000 },
    { ...running, id: "too-many", attempts: 12 },
    { ...running, id: "active", attempts: 12, lease_until: epoch + 1 },
    { ...running, id: "retry" },
  ]);
  const calls: string[] = [];
  await runQueue(db, "work", async (job) => { calls.push(job.id); }, 2, "primary");
  assert.deepEqual(calls, ["retry", "same-job"]);
  for (const id of ["old", "too-many"]) {
    const row = await db("work").where({ tenant_id: "primary", id }).first();
    assert.equal(row.state, "failed");
    assert.equal(row.payload, payload);
    assert.equal(row.lease_owner, null);
    assert.equal(Number(row.lease_until), 0);
  }
  assert.equal((await db("work").where({ id: "active" }).first()).state, "running");
  assert.equal((await db("work").where({ tenant_id: "other", id: "same-job" }).first()).state, "pending");
});

test("shutdown during a queue claim releases the lease before invoking the handler", async (t) => {
  await reset(db);
  await seed("work");
  t.mock.method(Date, "now", () => epoch);
  const controller = new AbortController();
  const abortDuringClaim = ({ sql }: { sql: string }) => {
    if (
      /^update [`"]work[`"] set /i.test(sql) &&
      /[`"]attempts[`"] = /.test(sql)
    ) controller.abort();
  };
  db.on("query", abortDuringClaim);
  let calls = 0;
  try {
    await runQueue(db, "work", async () => { calls++; }, 1, "primary", {
      signal: controller.signal,
    });
  } finally {
    db.removeListener("query", abortDuringClaim);
  }
  assert.ok(controller.signal.aborted);
  assert.equal(calls, 0);
  const job = await ownJob("work");
  assert.equal(job?.state, "pending");
  assert.equal(job?.attempts, 0);
  assert.equal(job?.lease_owner, null);
  assert.equal(job?.payload, payload);
  await assert.rejects(
    runQueue(db, "work", async () => {}, 1, "primary", { leaseMs: 29 }),
    /lease or heartbeat/,
  );
});

test("queue heartbeats do not overlap and abort when a replacement owns the lease", async (t) => {
  await reset(db);
  await seed("work");
  t.mock.method(Date, "now", () => epoch);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const entered = Promise.withResolvers<AbortSignal>();
  const running = runQueue(db, "work", async () => {
    const signal = queueWorkerSignal()!;
    const stopped = new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    entered.resolve(signal);
    await stopped;
  }, 1, "primary", { leaseMs: 100, heartbeatMs: 10 });
  const signal = await entered.promise;
  await db("work").where({ tenant_id: "primary", id: "same-job" })
    .update({ lease_owner: "replacement" });
  let renewals = 0;
  const countRenewal = ({ sql }: { sql: string }) => {
    if (/^update [`"]work[`"] set [`"]lease_until[`"] = [^,]+ where/i.test(sql))
      renewals++;
  };
  db.on("query", countRenewal);
  try {
    t.mock.timers.tick(10);
    t.mock.timers.tick(10);
    await running;
  } finally {
    db.removeListener("query", countRenewal);
  }
  assert.ok(signal.aborted);
  assert.equal(renewals, 1);
  assert.equal((await ownJob("work"))?.lease_owner, "replacement");
});

test("failure to report a resource limit leaves the job recoverable", async (t) => {
  await reset(db);
  await seed("work");
  t.mock.method(Date, "now", () => epoch);
  await runQueue(db, "work", async () => {
    throw new WorkerResourceLimit("maxBytes", 11, 10);
  }, 1, "primary", {
    onResourceLimit: () => { throw Error("logger unavailable"); },
  });
  const job = await ownJob("work");
  assert.equal(job?.state, "failed");
  assert.equal(job?.attempts, 0);
  assert.equal(job?.last_error, "resource_limit");
  assert.equal(job?.payload, payload);
  assert.equal(job?.lease_owner, null);
});

test("invariant: queue retries and budget deferrals preserve payloads, tenant ownership and retry windows", async () => {
  const operation: fc.Arbitrary<QueueOperation> = fc.record({
    by: fc.constantFrom(0, 1, 2000, 300001, 3600001, 72 * 3600000),
    outcome: fc.constantFrom("success", "failure", "defer"),
  });
  await fc.assert(
    fc.asyncProperty(
      table,
      fc.constantFrom(0, 72 * 3600000 - 1, 72 * 3600000 + 1),
      sequence(operation),
      async (name, age, operations) => {
        await reset(db);
        let now = epoch;
        const original = Date.now;
        const createdAt = now - age;
        await seed(name, createdAt);
        const foreign = tenant(name)
          ? await db(name).where({ tenant_id: "other" })
          : [];
        let state = "pending",
          attempts = 0,
          availableAt = 0,
          calls = 0;
        try {
          Date.now = () => now;
          for (const op of operations) {
            now += op.by;
            const eligible = state === "pending" && availableAt <= now;
            const beforeCalls = calls;
            await runQueue(
              db,
              name,
              async (job) => {
                calls++;
                assert.equal(job.payload, payload);
                if (tenant(name)) assert.equal(job.tenant_id, "primary");
                if (op.outcome === "failure")
                  throw Error("provider secret must not be persisted");
                if (op.outcome === "defer") throw new DeferredJob(now + 1000);
              },
              1,
              tenant(name),
            );
            assert.equal(calls - beforeCalls, Number(eligible));
            if (eligible) {
              if (op.outcome === "success") {
                attempts++;
                state = "sent";
              } else if (op.outcome === "defer") availableAt = now + 1000;
              else {
                attempts++;
                state = now - createdAt >= 72 * 3600000 ? "failed" : "pending";
                availableAt =
                  now + Math.min(3600000, 1000 * 2 ** Math.min(attempts, 12));
              }
            }
            const row = await ownJob(name);
            assert.ok(row);
            assert.equal(row.state, state);
            assert.equal(row.attempts, attempts);
            assert.equal(
              row.payload,
              state === "sent" && name.endsWith("emails") ? "" : payload,
            );
            assert.equal(row.lease_owner, null);
            assert.equal(Number(row.lease_until), 0);
            if (state === "pending")
              assert.equal(Number(row.available_at), availableAt);
            if (row.last_error)
              assert.ok(
                ["processing_failed", "resource_budget"].includes(
                  row.last_error,
                ),
              );
            if (tenant(name))
              assert.deepEqual(
                await db(name).where({ tenant_id: "other" }),
                foreign,
              );
          }
        } finally {
          Date.now = original;
        }
      },
    ),
    parameters<[QueueTable, number, QueueOperation[]]>(
      tables.flatMap((name) => [
        [
          name,
          0,
          [
            { by: 0, outcome: "failure" },
            { by: 2000, outcome: "defer" },
            { by: 1000, outcome: "success" },
            { by: 3600001, outcome: "failure" },
          ],
        ],
        [
          name,
          72 * 3600000 - 1,
          [
            { by: 1, outcome: "failure" },
            { by: 3600001, outcome: "success" },
          ],
        ],
      ]),
    ),
  );
});

test("invariant: stale worker completions and failures cannot overwrite a replacement lease", async () => {
  await fc.assert(
    fc.asyncProperty(
      table,
      fc.boolean(),
      fc.boolean(),
      async (name, oldFails, newFails) => {
        await reset(db);
        await seed(name);
        const original = Date.now;
        let now = epoch;
        const oldEntered = Promise.withResolvers<void>();
        const oldRelease = Promise.withResolvers<void>();
        const newEntered = Promise.withResolvers<void>();
        const newRelease = Promise.withResolvers<void>();
        let oldWorker: Promise<void> | undefined,
          newWorker: Promise<void> | undefined;
        try {
          Date.now = () => now;
          oldWorker = runQueue(
            db,
            name,
            async () => {
              oldEntered.resolve();
              await oldRelease.promise;
              if (oldFails) throw Error("stale failure");
            },
            1,
            tenant(name),
          );
          await Promise.race([
            oldEntered.promise,
            oldWorker.then(() => {
              throw Error("old worker did not claim");
            }),
          ]);
          const oldLease = await ownJob(name);
          assert.ok(oldLease?.lease_owner);
          // The exact lease boundary remains owned; reclaim requires a later time.
          now = Number(oldLease.lease_until);
          let premature = false;
          await runQueue(
            db,
            name,
            async () => {
              premature = true;
            },
            1,
            tenant(name),
          );
          assert.equal(premature, false);
          now++;
          newWorker = runQueue(
            db,
            name,
            async () => {
              newEntered.resolve();
              await newRelease.promise;
              if (newFails) throw Error("new provider failure");
            },
            1,
            tenant(name),
          );
          await Promise.race([
            newEntered.promise,
            newWorker.then(() => {
              throw Error("new worker did not claim");
            }),
          ]);
          const replacement = await ownJob(name);
          assert.ok(replacement?.lease_owner);
          assert.notEqual(replacement.lease_owner, oldLease.lease_owner);
          assert.equal(replacement.attempts, 2);
          oldRelease.resolve();
          await oldWorker;
          assert.deepEqual(
            await ownJob(name),
            replacement,
            "stale worker must leave every field of the new lease unchanged",
          );
          newRelease.resolve();
          await newWorker;
          const completed = await ownJob(name);
          assert.ok(completed);
          assert.equal(completed.state, newFails ? "pending" : "sent");
          assert.equal(
            completed.payload,
            !newFails && name.endsWith("emails") ? "" : payload,
          );
          assert.equal(completed.lease_owner, null);
          assert.equal(completed.attempts, 2);
          if (tenant(name))
            assert.equal(
              (await db(name).where({ tenant_id: "other" }).first()).state,
              "pending",
            );
        } finally {
          oldRelease.resolve();
          newRelease.resolve();
          await Promise.allSettled(
            [oldWorker, newWorker].filter((p) => p !== undefined),
          );
          Date.now = original;
        }
      },
    ),
    parameters<[QueueTable, boolean, boolean]>(
      tables.flatMap((name) =>
        [false, true].flatMap((oldFails) =>
          [false, true].map((newFails): [QueueTable, boolean, boolean] => [
            name,
            oldFails,
            newFails,
          ]),
        ),
      ),
    ),
  );
});
