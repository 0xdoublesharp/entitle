import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import * as server from "../src/server.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Releases } from "../src/releases.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { createDb, migrate, type DB } from "../src/db.ts";
import { seal } from "../src/crypto.ts";

const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/server-roles-");
after(() => rm(root, { recursive: true, force: true }));
let serial = 0;
const credentials = {
  APP_SECRET: "55".repeat(32),
  OPERATOR_TOKEN: "operator-test-token".repeat(3),
};
function config(role?: string, slot?: string) {
  return loadConfig({
    ...credentials,
    DEPLOYMENT_MODE: "hosted",
    DATA_DIR: `${root}/${++serial}`,
    PORT: "0",
    LOCAL_BILLING: "true",
    S3_ENDPOINT: "http://127.0.0.1:1",
    S3_ALLOW_HTTP: "true",
    S3_ACCESS_KEY_ID: "fixture",
    S3_SECRET_ACCESS_KEY: "fixture-secret",
    ...(role === undefined ? {} : { SERVER_ROLE: role }),
    ...(slot === undefined ? {} : { DEPLOYMENT_SLOT: slot }),
  });
}
function control() {
  const signals = new EventEmitter();
  const exits: number[] = [];
  let fire: () => void = () => assert.fail("no timer registered");
  let timers = 0;
  let migrations = 0;
  const runtime: server.ServerRuntime = {
    ...server.serverRuntime,
    signals: signals as unknown as server.ServerRuntime["signals"],
    exit: (code) => {
      exits.push(code);
    },
    migrate: async (db) => {
      migrations++;
      await migrate(db);
    },
    setInterval: ((callback: () => void) => {
      timers++;
      fire = callback;
      return setInterval(callback, 60000);
    }) as typeof setInterval,
  };
  return {
    runtime,
    signals,
    exits,
    fire: () => fire(),
    get timers() {
      return timers;
    },
    get migrations() {
      return migrations;
    },
  };
}
async function prepare(c: Config, mutate?: (db: DB) => Promise<void>) {
  const db = createDb(c.databaseUrl);
  try {
    await migrate(db);
    await mutate?.(db);
  } finally {
    await db.destroy();
  }
}

test("roles default to all and malformed roles/slots fail configuration", () => {
  assert.equal(config().serverRole, "all");
  for (const role of ["all", "api", "worker", "migrate"])
    assert.equal(config(role).serverRole, role);
  for (const role of ["", "API", "api ", "unknown"])
    assert.throws(() => config(role), /SERVER_ROLE/);
  for (const slot of ["", "red", "Blue", "green\r\nInjected: true"])
    assert.throws(() => config("api", slot), /DEPLOYMENT_SLOT/);
  for (const slot of ["blue", "green"])
    assert.equal(config("api", slot).deploymentSlot, slot);
});

test("invalid programmatic role/slot and migrate via startServer fail before DB creation", async () => {
  const c = config(),
    ctl = control();
  ctl.runtime.createDb = () => assert.fail("must validate before opening DB");
  for (const invalid of [
    { serverRole: "invalid" },
    { deploymentSlot: "invalid" },
    { serverRole: "migrate" },
  ])
    await assert.rejects(
      server.startServer({ ...c, ...invalid } as Config, ctl.runtime),
      /SERVER_ROLE|DEPLOYMENT_SLOT|startRuntime/,
    );
});

test("API verifies schema without migrations or timers and exposes slot/role on readiness", async (t) => {
  const c = config("api", "green"),
    ctl = control();
  await prepare(c);
  const running = await server.startServer(c, ctl.runtime);
  t.after(() => running.stop());
  assert.equal(ctl.migrations, 0);
  assert.equal(ctl.timers, 0);
  const response = await running.app.inject("/api/v1/ready?probe=1");
  assert.equal(response.headers["x-entitle-server-role"], "api");
  assert.equal(response.headers["x-entitle-deployment-slot"], "green");
  // Storage is deliberately offline; identity must also survive failed readiness.
  assert.equal(response.statusCode, 503);
  const stopping = running.stop();
  assert.equal(running.stop(), stopping);
  await stopping;
  assert.equal(ctl.signals.listenerCount("SIGTERM"), 0);
});

test("worker ticks without migration and is identifiable as worker, including on signals", async (t) => {
  const c = config("worker", "blue"),
    ctl = control();
  await prepare(c);
  const running = await server.startServer(c, ctl.runtime);
  t.after(() => running.stop());
  assert.equal(ctl.migrations, 0);
  assert.equal(ctl.timers, 1);
  await running
    .db("customers")
    .insert({
      tenant_id: "primary",
      id: "customer",
      email: "person@example.test",
    });
  await running
    .db("sessions")
    .insert({
      tenant_id: "primary",
      id: "expired",
      customer_id: "customer",
      expires_at: 1,
    });
  ctl.fire();
  for (let i = 0; i < 100 && (await running.db("sessions")).length; i++)
    await delay(5);
  assert.equal((await running.db("sessions")).length, 0);
  const response = await running.app.inject("/api/v1/ready");
  assert.equal(response.headers["x-entitle-server-role"], "worker");
  assert.notEqual(response.headers["x-entitle-server-role"], "api");
  ctl.signals.emit("SIGTERM");
  ctl.signals.emit("SIGINT");
  await running.stop();
  await delay(0);
  assert.deepEqual(ctl.exits, [0]);
  await assert.rejects(running.db.raw("select 1"), /connection/i);
});

async function seedTickWork(db: DB, c: Config) {
  await db("platform_emails").insert({
    id: "role-email",
    kind: "login",
    payload: seal(
      { to: "person@example.test", subject: "Role test", text: "Queued work" },
      c.secret,
    ),
    created_at: Date.now(),
  });
  await db("customers").insert({
    tenant_id: "primary",
    id: "role-customer",
    email: "person@example.test",
  });
  await db("sessions").insert({
    tenant_id: "primary",
    id: "role-session",
    customer_id: "role-customer",
    expires_at: 1,
  });
}

for (const trigger of ["operator", "direct"] as const) {
  test(`API disables ${trigger} ticks without executing seeded work`, async (t) => {
    const c = config("api"),
      ctl = control();
    await prepare(c);
    let deliveries = 0;
    ctl.runtime.buildApp = (config, db) =>
      server.serverRuntime.buildApp(
        config,
        db,
        {
          send: async () => {
            deliveries++;
          },
        },
        { store: new InMemoryArtifactStore() },
      );
    const running = await server.startServer(c, ctl.runtime);
    t.after(() => running.stop());
    await seedTickWork(running.db, c);
    const before = await running.db("platform_emails").first();
    let status: number | undefined, code: string | undefined;
    if (trigger === "operator") {
      const unauthorized = await running.app.inject({
        method: "POST",
        url: "/api/v1/operator/jobs/run",
        payload: {},
      });
      assert.equal(unauthorized.statusCode, 401);
      const response = await running.app.inject({
        method: "POST",
        url: "/api/v1/operator/jobs/run",
        headers: { authorization: `Bearer ${c.operatorToken}` },
        payload: {},
      });
      status = response.statusCode;
      code = response.json().error?.code;
    } else {
      await (
        running.app as typeof running.app & { tick: () => Promise<void> }
      ).tick();
    }
    assert.deepEqual(
      {
        status,
        code,
        deliveries,
        job: await running.db("platform_emails").first(),
        sessions: (await running.db("sessions")).length,
      },
      {
        status: trigger === "operator" ? 409 : undefined,
        code: trigger === "operator" ? "jobs_disabled" : undefined,
        deliveries: 0,
        job: before,
        sessions: 1,
      },
    );
    assert.equal(ctl.timers, 0);
  });
}

for (const role of ["worker", "all", undefined] as const) {
  for (const trigger of ["operator", "direct", "timer"] as const) {
    test(`${role ?? "omitted-role legacy"} executes seeded work through ${trigger} ticks`, async (t) => {
      const c = config(role),
        ctl = control();
      // Exercise programmatic Config callers that predate serverRole.
      if (role === undefined) delete c.serverRole;
      await prepare(c);
      let deliveries = 0;
      ctl.runtime.buildApp = (config, db) =>
        server.serverRuntime.buildApp(
          config,
          db,
          {
            send: async () => {
              deliveries++;
            },
          },
          { store: new InMemoryArtifactStore() },
        );
      const running = await server.startServer(c, ctl.runtime);
      t.after(() => running.stop());
      await seedTickWork(running.db, c);
      if (trigger === "operator") {
        const response = await running.app.inject({
          method: "POST",
          url: "/api/v1/operator/jobs/run",
          headers: { authorization: `Bearer ${c.operatorToken}` },
          payload: {},
        });
        assert.equal(response.statusCode, 200, response.body);
        assert.deepEqual(response.json(), { ok: true });
      } else if (trigger === "direct") {
        await (
          running.app as typeof running.app & { tick: () => Promise<void> }
        ).tick();
      } else {
        ctl.fire();
        for (let i = 0; i < 100 && (await running.db("sessions")).length; i++)
          await delay(5);
      }
      assert.equal(deliveries, 1);
      assert.equal((await running.db("platform_emails").first()).state, "sent");
      assert.equal((await running.db("sessions")).length, 0);
      assert.equal(ctl.timers, 1);
    });
  }
}

test("API/worker refuse missing, pending, unknown or duplicate migration history without schema writes", async (t) => {
  for (const role of ["api", "worker"]) {
    for (const state of ["missing", "pending", "unknown", "duplicate"]) {
      const c = config(role),
        ctl = control();
      const db = createDb(c.databaseUrl);
      t.after(() => db.destroy());
      if (state !== "missing") {
        await migrate(db);
        if (state === "pending")
          await db("knex_migrations")
            .where({ name: "014_complimentary_licenses" })
            .delete();
        else
          await db("knex_migrations").insert({
            name: state === "unknown" ? "999_unknown" : "001_initial",
            batch: 1,
            migration_time: new Date(),
          });
      }
      const before = await db("sqlite_master")
        .select("name", "sql")
        .orderBy("name");
      const history =
        state === "missing" ? [] : await db("knex_migrations").select();
      const queries: string[] = [];
      db.on("query", (query) => queries.push(query.sql));
      ctl.runtime.createDb = () => db;
      const destroy = t.mock.method(db, "destroy");
      ctl.runtime.buildApp = async () =>
        assert.fail("schema refusal must precede app construction");
      await assert.rejects(
        server.startServer(c, ctl.runtime),
        /migration|schema/i,
      );
      assert.equal(destroy.mock.callCount(), 1);
      assert.equal(ctl.migrations, 0);
      assert.equal(ctl.timers, 0);
      assert.equal(ctl.signals.listenerCount("SIGTERM"), 0);
      assert.equal(
        queries.some((sql) =>
          /^\s*(create|insert|update|delete|alter|drop)\b/i.test(sql),
        ),
        false,
        queries.join("\n"),
      );
      const inspect = createDb(c.databaseUrl);
      try {
        assert.deepEqual(
          await inspect("sqlite_master").select("name", "sql").orderBy("name"),
          before,
        );
        if (state !== "missing")
          assert.deepEqual(await inspect("knex_migrations").select(), history);
      } finally {
        await inspect.destroy();
      }
    }
  }
});

test("explicit migrate dispatch applies once, closes DB, and never builds/listens/ticks", async (t) => {
  const c = config("migrate"),
    ctl = control(),
    db = createDb(c.databaseUrl);
  ctl.runtime.createDb = () => db;
  const destroy = t.mock.method(db, "destroy");
  ctl.runtime.buildApp = async () =>
    assert.fail("migrate must not construct app/listen");
  assert.deepEqual(await server.startRuntime(c, ctl.runtime), {
    role: "migrate",
  });
  assert.equal(ctl.migrations, 1);
  assert.equal(ctl.timers, 0);
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal(ctl.signals.listenerCount("SIGTERM"), 0);
  const inspect = createDb(c.databaseUrl);
  try {
    assert.equal((await inspect("knex_migrations")).length, 18);
  } finally {
    await inspect.destroy();
  }
});

test("migrate failure still destroys DB and runtime dispatch retains legacy listening result", async (t) => {
  const c = config("migrate"),
    ctl = control(),
    db = createDb(c.databaseUrl);
  ctl.runtime.createDb = () => db;
  const destroy = t.mock.method(db, "destroy");
  ctl.runtime.migrate = async () => {
    throw Error("migration failed");
  };
  await assert.rejects(server.startRuntime(c, ctl.runtime), /migration failed/);
  assert.equal(destroy.mock.callCount(), 1);
  const legacy = control();
  const running = await server.startRuntime(config(), legacy.runtime);
  assert.equal(running.role, "all");
  assert.ok("app" in running);
  if ("app" in running) {
    t.after(() => running.stop());
    assert.deepEqual((await running.app.inject("/api/v1/health")).json(), {
      ok: true,
    });
    assert.equal(legacy.timers, 1);
    assert.equal(legacy.migrations, 1);
  }
});

test("API listen failure closes app and DB before installing timers or signals", async (t) => {
  const c = config("api"),
    ctl = control();
  await prepare(c);
  const db = createDb(c.databaseUrl);
  ctl.runtime.createDb = () => db;
  const destroy = t.mock.method(db, "destroy");
  let closes = 0;
  ctl.runtime.buildApp = async (...args) => {
    const app = await server.serverRuntime.buildApp(...args);
    app.addHook("onClose", async () => {
      closes++;
    });
    t.mock.method(app, "listen", async () => {
      throw Error("listen failed");
    });
    return app;
  };
  await assert.rejects(server.startServer(c, ctl.runtime), /listen failed/);
  assert.equal(closes, 1);
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal(ctl.timers, 0);
  assert.equal(ctl.signals.listenerCount("SIGTERM"), 0);
});

test("real migrate entry exits successfully without listening", async () => {
  const data = `${root}/entry`;
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      ...credentials,
      NODE_ENV: "test",
      SERVER_ROLE: "migrate",
      DEPLOYMENT_SLOT: "blue",
      DATABASE_URL: `sqlite:${data}/db.sqlite`,
      DATA_DIR: data,
      PORT: "0",
      LOCAL_BILLING: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /listening/i);
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
  }
});

test("successful readiness preserves the legacy body and labels every serving role", async (t) => {
  for (const role of [undefined, "api", "worker"]) {
    const c = config(role),
      ctl = control();
    if (role !== undefined) await prepare(c);
    ctl.runtime.buildApp = (config, db) =>
      server.serverRuntime.buildApp(
        config,
        db,
        { send: async () => {} },
        { store: new InMemoryArtifactStore() },
      );
    const running = await server.startServer(c, ctl.runtime);
    t.after(() => running.stop());
    const response = await running.app.inject("/api/v1/ready");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true });
    assert.equal(response.headers["x-entitle-server-role"], role ?? "all");
    assert.equal(response.headers["x-entitle-deployment-slot"], undefined);
    await running.stop();
  }
});

test("worker shutdown drains an active core tick before destroying DB and ignores later ticks", async (t) => {
  const c = config("worker"),
    ctl = control();
  await prepare(c);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  t.mock.method(Releases.prototype, "cleanup", async () => {
    attempts++;
    entered();
    await blocked;
  });
  const running = await server.startServer(c, ctl.runtime);
  const destroy = t.mock.method(running.db, "destroy");
  ctl.fire();
  await started;
  const stopping = running.stop();
  try {
    await delay(20);
    assert.equal(destroy.mock.callCount(), 0);
    assert.equal(ctl.signals.listenerCount("SIGTERM"), 1);
    assert.equal(running.stop(), stopping);
  } finally {
    release();
    await stopping;
  }
  assert.equal(destroy.mock.callCount(), 1);
  const tick = (
    running.app as typeof running.app & { tick: () => Promise<void> }
  ).tick;
  await tick();
  assert.equal(attempts, 1);
});

test("start launcher dispatches migrate through the runtime entry", async () => {
  const out = `${root}/launcher-build`,
    data = `${root}/launcher-data`;
  await mkdir(`${out}/server/src`, { recursive: true });
  await writeFile(
    `${out}/server/package.json`,
    JSON.stringify({ type: "module" }),
  );
  // Isolate launcher dispatch while exercising the real source migration runtime.
  await writeFile(
    `${out}/server/src/server.js`,
    `export { startRuntime, startServer } from ${JSON.stringify(pathToFileURL(resolve("src/server.ts")).href)};\n`,
  );
  const child = spawn(
    process.execPath,
    ["--env-file-if-exists=.env", "scripts/start.ts"],
    {
      env: {
        ...process.env,
        ...credentials,
        NODE_ENV: "test",
        SERVER_ROLE: "migrate",
        DEPLOYMENT_SLOT: "blue",
        DATABASE_URL: `sqlite:${data}/db.sqlite`,
        DATA_DIR: data,
        BUILD_DIR: out,
        PORT: "0",
        LOCAL_BILLING: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /listening/i);
    const db = createDb(`sqlite:${data}/db.sqlite`);
    try {
      assert.equal((await db("knex_migrations")).length, 18);
    } finally {
      await db.destroy();
    }
  } finally {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
  }
});
