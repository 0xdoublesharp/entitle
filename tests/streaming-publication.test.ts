import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile, rm, symlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Artifacts } from "../src/artifacts.ts";
import { Releases } from "../src/releases.ts";
import { VerifiedArtifactCache } from "../src/artifact-streams.ts";
import { InMemoryArtifactStore, type ArtifactStore } from "../src/storage.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { migrate } from "../src/db.ts";
import { primaryTenant } from "./helpers/tenant.ts";
import { verifyArtifact } from "../src/package-validation.ts";
import { zipBytes } from "./helpers/zip.ts";
async function fixture(t: import("node:test").TestContext) {
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/streaming-publication-",
  );
  const fixture = await isolatedDatabase("sqlite:" + directory + "/db");
  const { db } = fixture;
  await migrate(db);
  await db("products").insert({
    tenant_id: "primary",
    id: "p",
    slug: "app",
    name: "App",
    framework: "generic",
    framework_config: "{}",
  });
  const file = directory + "/upload";
  await writeFile(file, "native artifact");
  const stored = directory + "/stored";
  const store = {
    putFile: async (_t: string, _id: string, source: string) => {
      await copyFile(source, stored);
    },
    getToFile: async (
      _t: string,
      _id: string,
      _c: string,
      _s: number,
      destination: string,
    ) => {
      await copyFile(stored, destination);
    },
    delete: async () => rm(stored, { force: true }),
  } as unknown as ArtifactStore;
  const cache = new VerifiedArtifactCache({ directory: directory + "/cache" });
  const service = new Artifacts(
    db,
    store,
    primaryTenant,
    undefined,
    undefined,
    cache,
  );
  t.after(async () => {
    await cache.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    service,
    db,
    store,
    file,
    directory,
    input: {
      product: "app",
      version: "1.0.0",
      file,
      target: "linux-x64",
      filename: "app.bin",
      changelog: "",
    },
  };
}
test("publication uses file store and independently verifies readback before database visibility", async (t) => {
  const f = await fixture(t);
  const { asset } = await f.service.publish(f.input);
  assert.equal(
    asset.checksum,
    createHash("sha256").update("native artifact").digest("hex"),
  );
  const response = await f.service.open(asset, 0, 5);
  const chunks = [];
  for await (const value of response.stream) chunks.push(value);
  assert.equal(Buffer.concat(chunks).toString(), "native");
  await assert.rejects(f.service.open({ ...asset, tenant_id: "other" }), {
    code: "not_found",
  });
  await assert.rejects(
    new Artifacts(f.db, f.store, primaryTenant).open(asset),
    { code: "artifact_cache_configuration" },
  );
});
test("corrupt file readback never commits and releases the reservation", async (t) => {
  const f = await fixture(t);
  f.store.getToFile = async (_t, _i, _c, _s, destination) => {
    await writeFile(destination, "broken content!");
  };
  await assert.rejects(f.service.publish(f.input), {
    code: "artifact_integrity",
  });
  assert.equal((await f.db("release_assets")).length, 0);
  assert.equal((await f.db("upload_reservations")).length, 0);
});
test("file validators inspect distant PE headers, DMG footer, ZIP and TAR without buffering the archive", async (t) => {
  const f = await fixture(t);
  const file = f.directory + "/formats";
  const pe = Buffer.alloc(2048);
  pe.write("MZ");
  pe.writeUInt32LE(1500, 60);
  pe.write("PE\0\0", 1500);
  for (const [filename, bytes] of [
    ["app.exe", pe],
    [
      "app.dmg",
      Buffer.concat([
        Buffer.alloc(1024),
        Buffer.from("koly"),
        Buffer.alloc(508),
      ]),
    ],
    ["app.zip", zipBytes([{ name: "app/file", data: "x" }])],
  ] as const) {
    await writeFile(file, bytes);
    await verifyArtifact(
      "electron",
      {},
      "1.0.0",
      { target: "darwin-arm64", filename, changelog: "" },
      file,
    );
  }
  await symlink(file, f.directory + "/link");
  const { hashArtifactFile } = await import("../src/artifact-streams.ts");
  await assert.rejects(hashArtifactFile(f.directory + "/link", 1));
});
test("file TAR validation handles source failure and expansion deadlines", async (t) => {
  const f = await fixture(t);
  const { Readable } = await import("node:stream");
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const source = t.mock.method(
    fs.default,
    "createReadStream",
    () =>
      new Readable({
        read() {
          this.destroy(Error("source failed"));
        },
      }),
  );
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      verifyArtifact(
        "electron",
        {},
        "1.0.0",
        { target: "linux-x64", filename: "app.tar.gz", changelog: "" },
        f.file,
      ),
      { code: "invalid_package" },
    );
  } finally {
    source.mock.restore();
    syncBuiltinESMExports();
  }
  const stalled = t.mock.method(
    fs.default,
    "createReadStream",
    () => new Readable({ read() {} }),
  );
  syncBuiltinESMExports();
  const original = setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) =>
    original(callback, 0)) as typeof setTimeout);
  try {
    await assert.rejects(
      verifyArtifact(
        "electron",
        {},
        "1.0.0",
        { target: "linux-x64", filename: "app.tar.gz", changelog: "" },
        f.file,
      ),
      { code: "invalid_package" },
    );
  } finally {
    stalled.mock.restore();
    syncBuiltinESMExports();
  }
});
test("ZIP validation enforces its deadline when archive iteration stalls", async (t) => {
  const f = await fixture(t);
  const yauzl = (await import("yauzl")).default;
  const source = zipBytes([{ name: "file", data: "x" }]);
  t.mock.method(yauzl.ZipFile.prototype, "readEntry", () => {});
  const original = setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) =>
    original(callback, 0)) as typeof setTimeout);
  await assert.rejects(
    verifyArtifact(
      "electron",
      {},
      "1.0.0",
      { target: "darwin-arm64", filename: "app.zip", changelog: "" },
      source,
    ),
    { code: "invalid_package" },
  );
  void f;
});
test("publication cannot validate substituted bytes and then commit the original unvalidated archive", async (t) => {
  const f = await fixture(t),
    yauzl = (await import("yauzl")).default,
    fs = await import("node:fs");
  const bad = zipBytes([{ name: "../escape", data: "unsafe" }]),
    good = zipBytes([{ name: "safe.txt", data: "safe" }]);
  await writeFile(f.file, bad);
  const original = yauzl.open;
  const mock = t.mock.method(yauzl, "open", ((
    path: string,
    options: import("yauzl").Options,
    callback: (error: Error | null, zip: import("yauzl").ZipFile) => void,
  ) => {
    fs.writeFileSync(path, good);
    original(path, options, (error, zip) => {
      if (zip)
        zip.prependOnceListener("end", () => fs.writeFileSync(path, bad));
      callback(error, zip);
    });
  }) as unknown as typeof yauzl.open);
  try {
    await assert.rejects(
      f.service.publish({ ...f.input, filename: "app.zip" }),
      { code: "artifact_integrity" },
    );
    assert.equal((await f.db("release_assets")).length, 0);
  } finally {
    mock.mock.restore();
  }
});
test("publication reservation budgets scale beyond fifteen minutes for larger verified files", async (t) => {
  const f = await fixture(t),
    { open } = await import("node:fs/promises");
  const file = await open(f.file, "w");
  await file.truncate(32 * 1024 ** 2);
  await file.close();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const original = f.store.getToFile!;
  f.store.getToFile = async (...args) => {
    await original(...args);
    now += 900001;
  };
  const result = await f.service.publish(f.input);
  assert.equal(Number(result.asset.size), 32 * 1024 ** 2);
});

test("WordPress publication rejects missing and expired reservations after storage verification", async (t) => {
  const f = await fixture(t);
  await f.db("products").where({ id: "p" }).update({ framework: "wordpress" });
  await writeFile(
    f.file,
    zipBytes([
      {
        name: "app/app.php",
        data: "<?php\n/*\nPlugin Name: App\nVersion: 1.0.0\n*/",
      },
    ]),
  );
  const store = new InMemoryArtifactStore();
  const releases = new Releases(f.db, store, primaryTenant, f.directory);
  const get = store.get.bind(store);
  const publication = {
    product: "app",
    version: "1.0.0",
    file: f.file,
    changelog: "Release notes",
    minWp: "6.0",
    minPhp: "8.0",
    minFree: "1.0",
    tested: "6.9",
  };
  for (const change of ["expired", "missing"] as const) {
    const readback = t.mock.method(
      store,
      "get",
      async (...args: Parameters<typeof get>) => {
        const bytes = await get(...args);
        const reservations = f.db("upload_reservations").where({ id: args[1] });
        if (change === "expired") await reservations.update({ expires_at: 0 });
        else await reservations.delete();
        return bytes;
      },
    );
    try {
      await assert.rejects(releases.publish(publication), {
        status: 409,
        code: "upload_expired",
      });
      assert.equal(await releases.latest("p"), undefined);
      assert.deepEqual(await f.db("upload_reservations"), []);
    } finally {
      readback.mock.restore();
    }
  }
  const authorization: Array<boolean | undefined> = [];
  const released = await releases.publish(publication, async (_tx, commit) => {
    authorization.push(commit);
  });
  assert.deepEqual(authorization, [false, true]);
  const queries: string[] = [];
  const track = ({ sql }: { sql: string }) => {
    queries.push(sql);
  };
  f.db.on("query", track);
  try {
    assert.equal((await releases.latest("p"))?.changelog, publication.changelog);
    assert.equal(queries.length, 2);
    assert.match(
      queries[0]!,
      /^select [`"]id[`"], [`"]version[`"] from [`"]releases[`"]/i,
    );
  } finally {
    f.db.removeListener("query", track);
  }
  await releases.withdraw(released.id);
  await releases.withdraw(released.id);
  assert.equal(await releases.latest("p"), undefined);
});

test("expired reservation remains invalidated during remote deletion and after cleanup failure", async (t) => {
  const f = await fixture(t);
  const key = { tenant_id: "primary", id: randomUUID() };
  await f.db("upload_reservations").insert({ ...key, expires_at: 1, bytes: 1 });
  const store = new InMemoryArtifactStore();
  const releases = new Releases(f.db, store, primaryTenant, f.directory);
  const remove = t.mock.method(store, "delete", async () => {
    const row = await f.db("upload_reservations").where(key).first();
    assert.equal(Number(row.expires_at), 0);
    throw Error("provider unavailable");
  });
  await assert.rejects(releases.cleanup(), /provider unavailable/);
  assert.equal(remove.mock.callCount(), 1);
  remove.mock.restore();
  await releases.cleanup();
  assert.deepEqual(await f.db("upload_reservations"), []);

  await f.db("upload_reservations").insert([
    { ...key, expires_at: 0, bytes: 1 },
    { ...key, id: randomUUID(), expires_at: 0, bytes: 1 },
  ]);
  const concurrentCleanup = t.mock.method(
    store,
    "delete",
    async (_tenant: string, id: string) => {
      await f.db("upload_reservations")
        .where({ tenant_id: "primary" })
        .whereNot("id", id)
        .delete();
    },
  );
  await releases.cleanup();
  assert.equal(concurrentCleanup.mock.callCount(), 1);
  assert.deepEqual(await f.db("upload_reservations"), []);
});

test("large native TAR archives can expand past the small-package floor", async (t) => {
  const { directory } = await fixture(t);
  const { createWriteStream } = await import("node:fs");
  const { randomBytes } = await import("node:crypto");
  const { Readable } = await import("node:stream");
  const { pipeline } = await import("node:stream/promises");
  const { createGzip } = await import("node:zlib");
  const mib = 1024 ** 2;
  const block = Buffer.concat([randomBytes(mib), Buffer.alloc(3 * mib)]);
  const blocks = 65;
  const header = Buffer.alloc(512);
  header.write("App.app/Contents/app");
  header.write((block.length * blocks).toString(8).padStart(11, "0"), 124);
  header.fill(32, 148, 156);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(checksum.toString(8).padStart(6, "0"), 148);
  header[154] = 0;
  const file = directory + "/app.tar.gz";
  function* archive() {
    yield header;
    for (let i = 0; i < blocks; i++) yield block;
    yield Buffer.alloc(1024);
  }
  await pipeline(
    Readable.from(archive()),
    createGzip({ level: 1 }),
    createWriteStream(file),
  );
  await verifyArtifact(
    "sparkle",
    {},
    "1.0.0",
    { target: "darwin-arm64", filename: "app.tar.gz", changelog: "" },
    file,
  );
});
