import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ReadCache, type ReadCacheEngine } from "../src/read-cache.ts";

const direct = (): ReadCacheEngine => ({
  getOrSet: async (_key, loader) =>
    loader({ signal: new AbortController().signal }),
  close: async () => {},
  getStats: () =>
    ({ counters: {}, hitsByLayer: {} }) as ReturnType<
      ReadCacheEngine["getStats"]
    >,
});
test("bounded memory cache reuses reads and isolates tenant, scope and complete input", async (t) => {
  const cache = new ReadCache();
  t.after(() => cache.close());
  let loads = 0;
  const read = (
    tenant = "a",
    input: unknown = { version: "1" },
    scope: "prices" | "feed" = "feed",
  ) => cache.remember(scope, tenant, input, async () => ({ number: ++loads }));
  assert.deepEqual(await read(), { number: 1 });
  assert.deepEqual(await read(), { number: 1 });
  assert.deepEqual(await read("b"), { number: 2 });
  assert.deepEqual(await read("a", { version: "2" }), { number: 3 });
  assert.deepEqual(await read("a", { version: "1" }, "prices"), { number: 4 });
  assert.ok(cache.getStats().counters.hit > 0);
});
test("concurrent identical misses coalesce and returned values cannot mutate stored values", async (t) => {
  const cache = new ReadCache();
  t.after(() => cache.close());
  let calls = 0;
  const values = await Promise.all(
    Array.from({ length: 12 }, () =>
      cache.remember("feed", "t", ["release", "asset"], async () => {
        ++calls;
        await new Promise((r) => setTimeout(r, 30));
        return { body: "original" };
      }),
    ),
  );
  assert.equal(calls, 1);
  values[0]!.body = "mutated";
  assert.deepEqual(
    await cache.remember("feed", "t", ["release", "asset"], async () => ({
      body: "wrong",
    })),
    { body: "original" },
  );
});
test("cache failures before and after a load use the source once and preserve source errors", async () => {
  for (const after of [false, true]) {
    let count = 0;
    const engine = direct();
    engine.getOrSet = async (_key, loader) => {
      if (after) await loader({ signal: new AbortController().signal });
      throw new Error("cache offline");
    };
    const cache = new ReadCache({}, engine);
    assert.equal(
      await cache.remember("prices", "tenant", "account", async () => ++count),
      1,
    );
    assert.equal(count, 1);
    const sourceError = new Error("provider failed");
    await assert.rejects(
      cache.remember("prices", "tenant", "failure", async () => {
        throw sourceError;
      }),
      (e) => e === sourceError,
    );
    await cache.close();
  }
});
test("failed reads are not retained and keys contain no raw input credentials", async () => {
  const engine = direct();
  const keys: string[] = [];
  let warnings = 0;
  engine.getOrSet = async (key, loader) => {
    keys.push(key);
    return loader({ signal: new AbortController().signal });
  };
  const cache = new ReadCache({
    namespace: "fixture:", onUnavailable: () => { warnings++; },
  }, engine);
  await assert.rejects(
    cache.remember("prices", "tenant", "secret-input", async () => {
      throw new Error("failed");
    }),
    /failed/,
  );
  assert.equal(warnings, 0);
  assert.equal(
    await cache.remember(
      "prices",
      "tenant",
      "secret-input",
      async () => "retried",
    ),
    "retried",
  );
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0]!, /^fixture:adaptive-v2:prices:/);
  assert.ok(!keys[0]!.includes("secret-input"));
  engine.getOrSet = async () => { throw Error("cache offline"); };
  assert.equal(await cache.remember("prices", "tenant", "fallback", async () => "source"), "source");
  assert.equal(warnings, 1);
  await cache.close();
});
test("an unavailable optional Redis server cannot prevent source reads or retain connections", async () => {
  const cache = new ReadCache({
    redisUrl: "redis://127.0.0.1:1",
    namespace: `offline:${randomUUID()}:`,
  });
  assert.equal(
    await cache.remember("prices", "tenant", {}, async () => "available"),
    "available",
  );
  await new Promise((r) => setTimeout(r, 50));
  await cache.close();
});
test(
  "real optional Redis shares cached reads across independent service instances",
  { skip: !process.env.TEST_REDIS_URL },
  async (t) => {
    const options = {
      redisUrl: process.env.TEST_REDIS_URL!,
      namespace: `test:${randomUUID()}:`,
    };
    const first = new ReadCache(options),
      second = new ReadCache(options);
    t.after(async () => {
      await first.close();
      await second.close();
    });
    let loads = 0;
    for (let i = 0; i < 40; i++) {
      await first.remember(
        "prices",
        "tenant",
        { account: "acct_a" },
        async () => ({ loads: ++loads }),
      );
      if (first.getStats().counters.hit) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const before = loads;
    const hit = await second.remember(
      "prices",
      "tenant",
      { account: "acct_a" },
      async () => ({ loads: ++loads }),
    );
    // A new client's connection may need one source fallback before it is ready.
    await new Promise((r) => setTimeout(r, 50));
    const shared = await second.remember(
      "prices",
      "tenant",
      { account: "acct_a" },
      async () => ({ loads: ++loads }),
    );
    assert.ok(hit.loads >= 1);
    assert.ok(shared.loads <= before + 1);
    assert.ok(second.getStats().counters.hit > 0);
  },
);

test(
  "application owns and closes optional Redis while supporting omitted cache defaults",
  { skip: !process.env.TEST_REDIS_URL },
  async () => {
    const { buildApp } = await import("../src/app.ts");
    const { loadConfig } = await import("../src/config.ts");
    const { createDb, migrate } = await import("../src/db.ts");
    const { InMemoryArtifactStore } = await import("../src/storage.ts");
    const config = loadConfig({
      DEPLOYMENT_MODE: "hosted",
      APP_SECRET: "cc".repeat(32),
      OPERATOR_TOKEN: "cache-fixture-operator-token-1234567890",
      CACHE_REDIS_URL: process.env.TEST_REDIS_URL,
    });
    delete config.cacheMemoryBytes;
    delete config.cacheNamespace;
    const db = createDb("sqlite::memory:");
    await migrate(db);
    try {
      const app = await buildApp(
        config,
        db,
        { send: async () => {} },
        { store: new InMemoryArtifactStore() },
      );
      await app.ready();
      await app.close();
    } finally {
      await db.destroy();
    }
  },
);

test("remote cache entries cannot replace update feeds and cache failures emit bounded safe warnings", async () => {
  const poison = direct();
  let remoteCalls = 0;
  let warnings = 0;
  poison.getOrSet = async <T>() => {
    ++remoteCalls;
    return {
      contentType: "text/html",
      body: "<script>malicious</script>",
    } as T;
  };
  const cache = new ReadCache(
    {
      onUnavailable: () => {
        ++warnings;
        throw Error("warning logger failed");
      },
    },
    poison,
  );
  assert.deepEqual(
    await cache.remember("feed", "tenant", "release", async () => ({
      contentType: "application/json",
      body: { version: "1" },
    })),
    { contentType: "application/json", body: { version: "1" } },
  );
  assert.equal(remoteCalls, 0);
  poison.getOrSet = async () => {
    throw new Error("private-redis-credentials");
  };
  for (let pass = 0; pass < 2; pass++)
    assert.deepEqual(
      await cache.remember("prices", "tenant", "acct", async () => []),
      [],
    );
  assert.equal(warnings, 1);
  await cache.close();
});

test("Redis-plus-L1 shutdown releases internal connections when Redis is unavailable", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import { AdaptiveCache } from "@0xdoublesharp/adaptive-cache";
    import { Redis } from "ioredis";
    import { setTimeout } from "node:timers/promises";
    const redis = new Redis("redis://127.0.0.1:1", {
      connectTimeout: 100, commandTimeout: 100, maxRetriesPerRequest: 0,
      enableOfflineQueue: false, retryStrategy: () => 50,
    });
    redis.on("error", () => {});
    const cache = new AdaptiveCache({
      backend: "l1-redis", keyPrefix: "offline-shutdown-regression:",
      logLevel: "silent",
      lru: { namespace: "offline-shutdown-regression", maxSizeBytes: 1024 * 1024 },
    }, redis);
    await setTimeout(100);
    try { await cache.close(); }
    catch (error) {
      if (!String(error).includes("Stream isn't writeable")) throw error;
    }
    finally { redis.disconnect(); }
    console.log("cleanup complete");
  `,
    ],
    { encoding: "utf8", timeout: 5000, env: process.env },
  );
  assert.equal(
    child.error,
    undefined,
    "shutdown must let the child exit naturally",
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /cleanup complete/);
});
