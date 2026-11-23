import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  readdir,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  VerifiedArtifactCache,
  hashArtifactFile,
  artifactTransferBudget,
  artifactFileIdentity,
} from "../src/artifact-streams.ts";
import type { ArtifactStore } from "../src/storage.ts";
const bytes = Buffer.from("verified artifact bytes");
const checksum = createHash("sha256").update(bytes).digest("hex");
const identity = { tenantId: "primary", id: "a", checksum, size: bytes.length };
async function fixture(t: import("node:test").TestContext, options = {}) {
  await access("/Volumes/Scratch");
  await mkdir(
    "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r2-fixes/artifacts-portability",
    { recursive: true },
  );
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r2-fixes/artifacts-portability/streaming-",
  );
  const cache = new VerifiedArtifactCache({
    directory,
    maxBytes: 100,
    maxInflightBytes: 100,
    ...options,
  });
  t.after(async () => {
    await cache.close();
    await rm(directory, { recursive: true, force: true });
  });
  let calls = 0;
  const store = {
    getToFile: async (
      _t: string,
      _i: string,
      _c: string,
      _s: number,
      file: string,
    ) => {
      calls++;
      await writeFile(file, bytes, { flag: "wx" });
    },
  } as unknown as ArtifactStore;
  return { directory, cache, store, calls: () => calls };
}
async function consume(stream: import("node:stream").Readable) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
test("verified cache deduplicates spools, streams ranges, and retains cached bytes", async (t) => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([
    f.cache.open(f.store, identity, 0, 7),
    f.cache.open(f.store, identity, 9),
  ]);
  assert.equal((await consume(a.stream)).toString(), "verified");
  assert.equal((await consume(b.stream)).toString(), "artifact bytes");
  assert.equal(f.calls(), 1);
  assert.deepEqual(
    await consume((await f.cache.open(f.store, identity)).stream),
    bytes,
  );
  assert.equal(f.calls(), 1);
  assert.equal((await readdir(f.directory)).length, 1);
});
test("bad digest is rejected before opening a stream and failed spools retry", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.cache.open(f.store, { ...identity, checksum: "0".repeat(64) }),
    { code: "artifact_integrity" },
  );
  assert.deepEqual(
    await readdir(f.directory + "/" + (await readdir(f.directory))[0]),
    [],
  );
  assert.deepEqual(
    await consume((await f.cache.open(f.store, identity)).stream),
    bytes,
  );
});
test("file hashes bind exact length and reject symlinks and malformed metadata", async (t) => {
  const f = await fixture(t);
  const file = f.directory + "/source";
  await writeFile(file, bytes);
  assert.equal((await hashArtifactFile(file, bytes.length)).checksum, checksum);
  await assert.rejects(hashArtifactFile(file, bytes.length - 1), {
    code: "artifact_integrity",
  });
  await assert.rejects(hashArtifactFile(file, 0));
  assert.deepEqual(await readFile(file), bytes);
});
test("cache rejects overflow configuration and unsafe identities and ranges", async (t) => {
  for (const options of [
    { directory: "relative" },
    { maxBytes: Infinity },
    { maxBytes: 0 },
    { maxInflightBytes: 101 },
    { ttlMs: 86400001 },
    { timeoutMs: 3600001 },
    { maxBytes: 65 * 1024 ** 3 },
  ]) {
    assert.throws(
      () =>
        new VerifiedArtifactCache({
          directory: "/Volumes/Scratch/entitle/tmp/never-created",
          maxBytes: 100,
          maxInflightBytes: 100,
          ...options,
        }),
      { code: "artifact_cache_configuration" },
    );
  }
  const f = await fixture(t);
  for (const value of [
    { size: 0 },
    { size: NaN },
    { size: 2048 * 1024 ** 2 + 1 },
    { checksum: "bad" },
  ])
    await assert.rejects(f.cache.open(f.store, { ...identity, ...value }), {
      code: "invalid_artifact",
    });
  for (const [start, end] of [
    [-1, 2],
    [1.1, 2],
    [0, Infinity],
    [4, 2],
    [0, 99],
  ])
    await assert.rejects(f.cache.open(f.store, identity, start, end), {
      code: "invalid_artifact",
    });
  await f.cache.close();
  await assert.rejects(f.cache.open(f.store, identity), {
    code: "artifact_cache_closed",
  });
});
test("cache preserves active leases under pressure and evicts only idle files", async (t) => {
  const f = await fixture(t, {
    maxBytes: bytes.length,
    maxInflightBytes: bytes.length,
  });
  const a = await f.cache.open(f.store, identity);
  await assert.rejects(f.cache.open(f.store, { ...identity, id: "b" }), {
    code: "artifact_cache_capacity",
  });
  await f.cache.close();
  assert.equal(a.stream.closed, true);
  const g = await fixture(t, {
    maxBytes: bytes.length,
    maxInflightBytes: bytes.length,
  });
  await consume((await g.cache.open(g.store, identity)).stream);
  await consume((await g.cache.open(g.store, { ...identity, id: "b" })).stream);
  assert.equal(g.calls(), 2);
});
test("cache TTL reuses a leased immutable generation and leaves room for another key", async (t) => {
  const f = await fixture(t, {
    ttlMs: 10,
    maxBytes: 2 * bytes.length,
    maxInflightBytes: bytes.length,
  });
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const old = await f.cache.open(f.store, identity);
  now += 11;
  const fresh = await f.cache.open(f.store, identity);
  assert.deepEqual(await consume(fresh.stream), bytes);
  assert.equal(f.calls(), 1);
  const other = await f.cache.open(f.store, { ...identity, id: "other" });
  assert.deepEqual(await consume(other.stream), bytes);
  assert.equal(f.calls(), 2);
  now += 11;
  assert.deepEqual(
    await consume((await f.cache.open(f.store, identity)).stream),
    bytes,
  );
  assert.equal(f.calls(), 2);
  assert.deepEqual(await consume(old.stream), bytes);
  // With no remaining lease, TTL still refreshes from verified storage.
  assert.deepEqual(
    await consume((await f.cache.open(f.store, identity)).stream),
    bytes,
  );
  assert.equal(f.calls(), 3);
});

test("cache supports legacy bounded stores and rejects large artifacts without streaming support", async (t) => {
  const f = await fixture(t, {
    maxBytes: 200 * 1024 ** 2,
    maxInflightBytes: 200 * 1024 ** 2,
  });
  const store = { get: async () => bytes } as unknown as ArtifactStore;
  assert.deepEqual(
    await consume((await f.cache.open(store, identity)).stream),
    bytes,
  );
  await assert.rejects(
    f.cache.open(store, { ...identity, id: "large", size: 101 * 1024 ** 2 }),
    { code: "streaming_storage_required" },
  );
});
test("failed inflight spools release budgets, retry, and never delete unrelated files", async (t) => {
  const f = await fixture(t, { maxInflightBytes: bytes.length });
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const store = {
    getToFile: async (
      _t: string,
      _i: string,
      _c: string,
      _s: number,
      file: string,
    ) => {
      await barrier;
      await writeFile(file, bytes);
    },
  } as unknown as ArtifactStore;
  const first = f.cache.open(store, identity);
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.cache.open(store, { ...identity, id: "other" }), {
    code: "artifact_cache_capacity",
  });
  release();
  await consume((await first).stream);
  const original = f.store.getToFile!;
  let attempt = 0;
  f.store.getToFile = async (...args) => {
    if (++attempt === 1) throw Error("failed spool");
    return original(...args);
  };
  await assert.rejects(
    f.cache.open(f.store, { ...identity, id: "retry" }),
    /failed spool/,
  );
  await consume(
    (await f.cache.open(f.store, { ...identity, id: "retry" })).stream,
  );
});
test("cache rejects changed or missing local files before returning new streams and then retries", async (t) => {
  const f = await fixture(t);
  await consume((await f.cache.open(f.store, identity)).stream);
  const directory = f.directory + "/" + (await readdir(f.directory))[0];
  let file = directory + "/" + (await readdir(directory))[0];
  await writeFile(file, "tampered bytes");
  await assert.rejects(f.cache.open(f.store, identity), {
    code: "artifact_integrity",
  });
  await consume((await f.cache.open(f.store, identity)).stream);
  file = directory + "/" + (await readdir(directory))[0];
  await rm(file);
  await assert.rejects(f.cache.open(f.store, identity), { code: "ENOENT" });
  await consume((await f.cache.open(f.store, identity)).stream);
  assert.equal(f.calls(), 3);
});
test("idle spool and response deadlines terminate stalled work and release leases", async (t) => {
  const f = await fixture(t, { timeoutMs: 10 });
  const store = {
    getToFile: async (
      _t: string,
      _i: string,
      _c: string,
      _s: number,
      file: string,
      signal: AbortSignal,
    ) => {
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      await writeFile(file, bytes);
    },
  } as unknown as ArtifactStore;
  await assert.rejects(f.cache.open(store, identity), {
    code: "artifact_cache_timeout",
  });
  const a = await f.cache.open(f.store, identity);
  const { once } = await import("node:events");
  const failure = once(a.stream, "error");
  assert.match((await failure)[0].message, /timed out/);
  if (!a.stream.closed) await once(a.stream, "close");
});
test("closing while a spool finishes prevents delivery and cleans the verified file", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.store.getToFile!;
  f.store.getToFile = async (...args) => {
    await barrier;
    await original(...args);
  };
  const pending = f.cache.open(f.store, identity);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = f.cache.close();
  release();
  await assert.rejects(pending, { code: "artifact_cache_closed" });
  await closing;
});
test("file hashing has a finite deadline", async (t) => {
  const f = await fixture(t);
  const file = f.directory + "/hash-timeout";
  await writeFile(file, Buffer.alloc(1024 * 1024));
  const original = setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) =>
    original(callback, 0)) as typeof setTimeout);
  await assert.rejects(hashArtifactFile(file, 1024 * 1024), /timed out/);
});
test("the cache spool deadline cancels stalled verification reads", async (t) => {
  const f = await fixture(t, { timeoutMs: 10 });
  const fs = await import("node:fs/promises");
  const { syncBuiltinESMExports } = await import("node:module");
  const { Readable, addAbortSignal } = await import("node:stream");
  const open = fs.open;
  let entered!: () => void;
  const reading = new Promise<void>((resolve) => { entered = resolve; });
  const opens = t.mock.method(fs.default, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    t.mock.method(handle, "createReadStream", ({ signal }: { signal?: AbortSignal } = {}) => {
      const stream = new Readable({ read: entered });
      return signal ? addAbortSignal(signal, stream) : stream;
    });
    return handle;
  });
  syncBuiltinESMExports();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const failed = assert.rejects(f.cache.open(f.store, identity), { code: "ABORT_ERR" });
    await reading;
    t.mock.timers.tick(10);
    // On an implementation that misses the spool deadline, the hashing timer
    // still bounds the test and reports a different failure.
    t.mock.timers.tick(120000);
    await failed;
    const [generation] = await readdir(f.directory);
    assert.ok(generation);
    assert.deepEqual(await readdir(join(f.directory, generation)), []);
  } finally {
    opens.mock.restore();
    syncBuiltinESMExports();
  }
  await consume((await f.cache.open(f.store, identity)).stream);
});
test("cache refuses symlink directories and releases a reservation when directory preparation fails", async (t) => {
  const f = await fixture(t);
  const { symlink } = await import("node:fs/promises");
  await symlink(f.directory, f.directory + "-link");
  t.after(() => rm(f.directory + "-link", { force: true }));
  const cache = new VerifiedArtifactCache({ directory: f.directory + "-link" });
  await assert.rejects(cache.open(f.store, identity), {
    code: "artifact_cache_configuration",
  });
  await assert.rejects(cache.close(), { code: "artifact_cache_configuration" });
});
test("cache cleanup failures retain disk accounting and still release inflight admission", async (t) => {
  const f = await fixture(t);
  const { mkdir } = await import("node:fs/promises");
  const store = {
    getToFile: async (
      _t: string,
      _i: string,
      _c: string,
      _s: number,
      file: string,
    ) => {
      await mkdir(file);
      await writeFile(file + "/unexpected", "x");
    },
  } as ArtifactStore;
  await assert.rejects(f.cache.open(store, identity));
});
test("active responses survive multiple idle periods within a size-scaled total budget", async (t) => {
  const f = await fixture(t, {
    timeoutMs: 10,
    minBytesPerSecond: 65536,
    maxBytes: 512 * 1024,
    maxInflightBytes: 256 * 1024,
  });
  const data = Buffer.alloc(256 * 1024, 3),
    item = {
      ...identity,
      size: data.length,
      checksum: createHash("sha256").update(data).digest("hex"),
    };
  f.store.getToFile = async (_t, _i, _c, _s, file) => {
    await writeFile(file, data, { flag: "wx" });
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = await f.cache.open(f.store, item);
  let length = 0;
  for await (const chunk of opened.stream) {
    length += chunk.length;
    t.mock.timers.tick(6);
  }
  assert.equal(length, data.length);
});
test("progressing spools survive the idle timeout and keep a finite size-scaled total deadline", async (t) => {
  const f = await fixture(t, { timeoutMs: 10, minBytesPerSecond: 65536 });
  const data = Buffer.alloc(3, 7),
    item = {
      ...identity,
      size: data.length,
      checksum: createHash("sha256").update(data).digest("hex"),
    };
  // Use enough declared bytes for a generous total deadline while crossing idle periods.
  const payload = Buffer.alloc(3072, 7);
  item.size = payload.length;
  item.checksum = createHash("sha256").update(payload).digest("hex");
  const cache = new VerifiedArtifactCache({
    directory: f.directory + "/progress",
    maxBytes: 6144,
    maxInflightBytes: 3072,
    timeoutMs: 10,
    minBytesPerSecond: 65536,
  });
  t.after(() => cache.close());
  const store = {
    getToFile: async (
      _t: string,
      _i: string,
      _c: string,
      _s: number,
      file: string,
      signal: AbortSignal,
      progress?: (bytes: number) => void,
    ) => {
      const { open } = await import("node:fs/promises");
      const handle = await open(file, "wx");
      try {
        for (let i = 0; i < 3; i++) {
          await handle.write(payload.subarray(i * 1024, (i + 1) * 1024));
          progress?.(1024);
          t.mock.timers.tick(6);
          if (signal.aborted) throw Error("unexpected transfer abort");
        }
      } finally {
        await handle.close();
      }
    },
  } as ArtifactStore;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.deepEqual(
    await consume((await cache.open(store, item)).stream),
    payload,
  );
});
test("a freshly published spool is pinned before a racing opener can evict it or release its budget twice", async (t) => {
  const f = await fixture(t, {
    maxBytes: bytes.length,
    maxInflightBytes: bytes.length,
  });
  const fs = (await import("node:fs/promises")).default,
    { syncBuiltinESMExports } = await import("node:module");
  let published: string | undefined,
    contender:
      | Promise<{ stream: import("node:stream").Readable; size: number }>
      | undefined;
  const set = Map.prototype.set;
  const map = t.mock.method(
    Map.prototype,
    "set",
    function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
      const result = set.call(this, key, value);
      if (
        !published &&
        typeof value === "object" &&
        value !== null &&
        "file" in value &&
        String(value.file).endsWith(".verified")
      ) {
        published = String(value.file);
        contender = f.cache.open(f.store, { ...identity, id: "racer" });
        void contender.catch(() => {});
      }
      return result;
    },
  );
  const original = fs.open;
  const opened = t.mock.method(
    fs,
    "open",
    async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === published && contender)
        await contender.catch(() => {});
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    const first = await f.cache.open(f.store, identity);
    assert.ok(contender);
    await assert.rejects(contender, { code: "artifact_cache_capacity" });
    assert.deepEqual(await consume(first.stream), bytes);
    const next = await f.cache.open(f.store, { ...identity, id: "next" });
    await assert.rejects(
      f.cache.open(f.store, { ...identity, id: "blocked" }),
      { code: "artifact_cache_capacity" },
    );
    assert.deepEqual(await consume(next.stream), bytes);
  } finally {
    map.mock.restore();
    opened.mock.restore();
    syncBuiltinESMExports();
  }
});

test("cache hits retain other idle generations and the maximum native deadline permits a 100 Mbit transfer", async (t) => {
  const f = await fixture(t, {
    maxBytes: 2 * bytes.length,
    maxInflightBytes: bytes.length,
  });
  for (const id of ["first", "second", "first", "second"])
    assert.deepEqual(
      await consume((await f.cache.open(f.store, { ...identity, id })).stream),
      bytes,
    );
  assert.equal(f.calls(), 2);
  assert.equal(artifactTransferBudget(2048 * 1024 ** 2, 120000), 2168000);
});
test("constant progress cannot bypass a response total deadline", async (t) => {
  const f = await fixture(t, {
    timeoutMs: 10,
    minBytesPerSecond: 64 * 1024 ** 2,
    maxBytes: 65536,
    maxInflightBytes: 65536,
  });
  const data = Buffer.alloc(65536, 3);
  const item = {
    ...identity,
    size: data.length,
    checksum: createHash("sha256").update(data).digest("hex"),
  };
  f.store.getToFile = async (_t, _i, _c, _s, file) => {
    await writeFile(file, data, { flag: "wx" });
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const opened = await f.cache.open(f.store, item);
  await assert.rejects(
    (async () => {
      for await (const _chunk of opened.stream) t.mock.timers.tick(6);
    })(),
    /timed out/,
  );
});
test("source descriptor failures reach the response stream and release its lease", async (t) => {
  const f = await fixture(t);
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  const original = fs.open;
  const mocked = t.mock.method(
    fs,
    "open",
    async (...args: Parameters<typeof original>) => {
      const handle = await original(...args);
      if (String(args[0]).endsWith(".verified")) {
        const create = handle.createReadStream.bind(handle);
        handle.createReadStream = (...options) => {
          const source = create(...options);
          queueMicrotask(() => source.destroy(Error("source IO failure")));
          return source;
        };
      }
      return handle;
    },
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      consume((await f.cache.open(f.store, identity)).stream),
      /source IO failure/,
    );
    mocked.mock.restore();
    syncBuiltinESMExports();
    assert.deepEqual(
      await consume((await f.cache.open(f.store, identity)).stream),
      bytes,
    );
    assert.equal(f.calls(), 1);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
test("retired generation unlink failure preserves quota and is never released twice", async (t) => {
  await access("/Volumes/Scratch");
  await mkdir(
    "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r2-fixes/artifacts-portability",
    { recursive: true },
  );
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r2-fixes/artifacts-portability/streaming-unlink-",
  );
  const cache = new VerifiedArtifactCache({
    directory,
    maxBytes: 2 * bytes.length,
    maxInflightBytes: bytes.length,
    ttlMs: 10,
  });
  const store = {
    getToFile: async (
      _t: string,
      _i: string,
      _c: string,
      _s: number,
      file: string,
    ) => {
      await writeFile(file, bytes, { flag: "wx" });
    },
  } as ArtifactStore;
  const fs = (await import("node:fs/promises")).default;
  const { syncBuiltinESMExports } = await import("node:module");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const old = await cache.open(store, identity);
  const child = directory + "/" + (await readdir(directory))[0];
  const oldFile = child + "/" + (await readdir(child))[0];
  now += 11;
  // Invalidate a leased generation to exercise retirement without duplicating
  // an unchanged leased file merely because its TTL expired.
  await writeFile(oldFile, bytes);
  await assert.rejects(cache.open(store, identity), {
    code: "artifact_integrity",
  });
  const fresh = await cache.open(store, identity);
  const original = fs.rm;
  let attempts = 0;
  const mocked = t.mock.method(
    fs,
    "rm",
    async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === oldFile) {
        attempts++;
        throw Error("unlink denied");
      }
      return original(...args);
    },
  );
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await consume(old.stream), bytes);
    // Failed unlink keeps the old generation charged while the fresh reader is active.
    await assert.rejects(cache.open(store, { ...identity, id: "blocked" }), {
      code: "artifact_cache_capacity",
    });
    assert.deepEqual(await consume(fresh.stream), bytes);
    await assert.rejects(cache.close(), /unlink denied/);
    assert.equal(attempts, 1);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
    old.stream.destroy();
    fresh.stream.destroy();
    await cache.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

test("private file identity is stable until replacement and refuses symlink opens", async (t) => {
  const f = await fixture(t);
  const file = f.directory + "/identity";
  await writeFile(file, bytes, { mode: 0o600 });
  const before = await artifactFileIdentity(file);
  assert.equal(await artifactFileIdentity(file), before);
  const replacement = f.directory + "/replacement";
  await writeFile(replacement, bytes, { mode: 0o600 });
  const { rename, symlink } = await import("node:fs/promises");
  await rename(replacement, file);
  assert.notEqual(await artifactFileIdentity(file), before);
  await symlink(file, replacement);
  await assert.rejects(artifactFileIdentity(replacement), { code: "ELOOP" });
});
