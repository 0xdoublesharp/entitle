import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { migrate, reset, createTenant } from "../src/db.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Releases } from "../src/releases.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { primaryTenant } from "./helpers/tenant.ts";
import { zipBytes, type ZipEntry } from "./helpers/zip.ts";

const root = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/framework-publication-",
);
const fixture = await isolatedDatabase(`sqlite:${root}/db`);
const { db } = fixture;
const store = new InMemoryArtifactStore();
before(async () => {
  await migrate(db);
});
after(async () => {
  await fixture.close();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  await db("products").insert({
    tenant_id: "primary",
    id: "p",
    slug: "app",
    name: "App",
    framework: "generic",
    framework_config: "{}",
  });
});
async function publication(overrides = {}) {
  const file = `${root}/${randomUUID()}.bin`;
  await writeFile(file, "first bytes");
  return {
    product: "app",
    version: "1.0.0",
    file,
    target: "linux-x64",
    filename: "app.bin",
    changelog: "Notes",
    ...overrides,
  };
}
async function artifacts(max?: number, grace?: number) {
  const { Artifacts } = await import("../src/artifacts.ts");
  return new Artifacts(db, store, primaryTenant, max, grace);
}

test("publishing targets reuses immutable notes, independently verifies bytes, and accounts the total once", async () => {
  const service = await artifacts();
  const input = await publication();
  const first = await service.publish(input);
  assert.notEqual(first.release.id, first.asset.id);
  assert.equal(
    first.asset.sha512,
    createHash("sha512").update("first bytes").digest("base64"),
  );
  assert.equal((await service.read(first.asset)).toString(), "first bytes");
  const nextInput = await publication({
    target: "darwin-arm64",
    filename: "app-arm.bin",
  });
  const next = await service.publish(nextInput);
  assert.equal(next.release.id, first.release.id);
  assert.equal(Number(next.release.size), 22);
  assert.equal(next.release.checksum, first.asset.checksum);
  assert.equal((await db("releases")).length, 1);
  assert.equal((await service.latest("p"))!.assets.length, 2);
  assert.deepEqual(
    (await service.latest("p", "darwin-arm64"))!.assets.map((a) => a.id),
    [next.asset.id],
  );
  assert.equal(await service.latest("p", "missing"), undefined);
  await assert.rejects(service.publish(input), { code: "target_exists" });
  await assert.rejects(
    service.publish({ ...input, target: "windows-x64", changelog: "Changed" }),
    { code: "release_notes_changed" },
  );
  await assert.rejects(
    new Releases(db, store, primaryTenant, root).read(next.release),
    { code: "framework_mismatch" },
  );
  await new Releases(db, store, primaryTenant, root).withdraw(first.release.id);
  assert.equal(await service.latest("p"), undefined);
  assert.equal((await service.read(first.asset)).toString(), "first bytes");
  await assert.rejects(service.publish({ ...input, target: "windows-x64" }), {
    code: "release_withdrawn",
  });
  assert.equal(Number((await db("releases").first()).size), 22);
});

test("concurrent target reservations enforce shared storage quota and release duplicate losers", async () => {
  const service = await artifacts();
  const input = await publication();
  const outcomes = await Promise.allSettled([
    service.publish(input),
    service.publish(input),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await db("release_assets")).length, 1);
  assert.equal((await db("upload_reservations")).length, 0);
  await db("tenants")
    .where({ id: "primary" })
    .update({ max_storage_bytes: 21 });
  await assert.rejects(service.publish({ ...input, target: "windows-x64" }), {
    code: "storage_limit",
  });
  await db("tenants")
    .where({ id: "primary" })
    .update({ max_storage_bytes: 22 });
  await service.publish({ ...input, target: "windows-x64" });
  assert.equal(Number((await db("releases").first()).size), 22);
});

test("artifact reads and latest selection fail closed across tenants and retain cleanup protection", async () => {
  const service = await artifacts();
  const { asset, release } = await service.publish(await publication());
  await assert.rejects(service.read({ ...asset, tenant_id: "other" }), {
    code: "not_found",
  });
  await assert.rejects(service.read({ ...asset, checksum: "0".repeat(64) }), {
    code: "artifact_integrity",
  });
  await assert.rejects(service.read({ ...asset, size: 101 * 1024 * 1024 }), {
    code: "invalid_artifact",
  });
  await db("upload_reservations").insert({
    tenant_id: "primary",
    id: asset.id,
    bytes: asset.size,
    expires_at: 0,
  });
  await new Releases(db, store, primaryTenant, root).cleanup();
  assert.equal((await service.read(asset)).toString(), "first bytes");
  await createTenant(db, { id: randomUUID(), slug: "other", name: "Other" });
  const other = await db("tenants").where({ slug: "other" }).first();
  const { Artifacts } = await import("../src/artifacts.ts");
  assert.equal(await new Artifacts(db, store, other).latest("p"), undefined);
  await db("releases")
    .where({ id: release.id })
    .update({ published_at: Date.now() + 100000 });
  assert.equal(await service.latest("p"), undefined);
});

test("package validation rejects mismatched identity/version and unsafe Joomla or JetBrains archives", async () => {
  const service = await artifacts();
  const input = await publication({ target: "any", filename: "app.zip" });
  const config = {
    extensionType: "plugin",
    element: "hello",
    folder: "system",
    joomlaMajor: 5,
  };
  await db("products")
    .where({ id: "p" })
    .update({ framework: "joomla", framework_config: JSON.stringify(config) });
  const xml =
    '<extension type="plugin" group="system"><version>1.0.0</version><files><filename plugin="hello">hello.php</filename></files></extension>';
  const valid: ZipEntry[] = [
    { name: "hello.xml", data: xml },
    { name: "hello.php", data: "<?php" },
  ];
  for (const entries of [
    [{ name: "hello.xml", data: xml.replace("1.0.0", "2.0.0") }],
    [
      {
        name: "hello.xml",
        data: xml.replace('plugin="hello"', 'plugin="wrong"'),
      },
    ],
    [
      {
        name: "hello.xml",
        data: xml.replace('group="system"', 'group="content"'),
      },
    ],
    [
      {
        name: "hello.xml",
        data:
          '<!DOCTYPE extension [<!ENTITY x SYSTEM "file:///etc/passwd">]>' +
          xml,
      },
    ],
    [...valid, { name: "../escape", data: "bad" }],
    [
      ...valid,
      { name: "link", data: "hello.php", attributes: (0xa1ff << 16) >>> 0 },
    ],
    [...valid, { name: "bad", data: "bad", crc: 0 }],
    [...valid, { name: "hello.XML", data: xml }],
    [{ name: "hello.xml", data: "<invalid>" }],
  ]) {
    await writeFile(input.file, zipBytes(entries));
    await assert.rejects(service.publish(input), { code: "invalid_package" });
  }
  await writeFile(input.file, zipBytes(valid));
  await service.publish(input);
  await db("products")
    .where({ id: "p" })
    .update({
      framework: "jetbrains",
      framework_config: JSON.stringify({
        pluginId: "com.example.plugin",
        sinceBuild: "242",
      }),
    });
  const jet =
    "<idea-plugin><id>com.example.plugin</id><version>1.1.0</version></idea-plugin>";
  const next = { ...input, version: "1.1.0", filename: "plugin.jar" };
  for (const xml of [
    jet.replace("com.example.plugin", "wrong"),
    jet.replace("1.1.0", "1.0.0"),
    "<!ENTITY foo 'bar'>" + jet,
  ]) {
    await writeFile(
      input.file,
      zipBytes([{ name: "META-INF/plugin.xml", data: xml }]),
    );
    await assert.rejects(service.publish(next), { code: "invalid_package" });
  }
  await writeFile(
    input.file,
    zipBytes([{ name: "META-INF/plugin.xml", data: jet }]),
  );
  const published = await service.publish(next);
  assert.equal(published.release.version, "1.1.0");
  assert.equal((await service.latest("p", "any"))!.release.version, "1.1.0");
});

test("desktop publication validates targets, filenames, executable/archive bytes and detached signatures", async () => {
  const { validateAssetMetadata, verifyArtifact } =
    await import("../src/package-validation.ts");
  const base = {
    target: "darwin-arm64",
    filename: "app.zip",
    changelog: "Notes",
  };
  const signature = Buffer.alloc(64, 7).toString("base64");
  assert.deepEqual(validateAssetMetadata("sparkle", { ...base, signature }), {
    ...base,
    signature,
  });
  for (const framework of [
    "wordpress",
    "joomla",
    "jetbrains",
    "electron",
    "tauri",
    "sparkle",
    "generic",
  ] as const) {
    for (const fields of [
      { ...base, target: "../bad" },
      { ...base, filename: "../app.zip" },
      { ...base, unknown: true },
      { ...base, changelog: "x".repeat(6001) },
      { ...base, minSystemVersion: "bad\nheader" },
    ])
      assert.throws(() => validateAssetMetadata(framework, fields));
  }
  for (const signature of [
    undefined,
    "bad",
    Buffer.alloc(63).toString("base64"),
    Buffer.alloc(65).toString("base64"),
  ])
    assert.throws(() =>
      validateAssetMetadata("sparkle", { ...base, signature }),
    );
  const valid = zipBytes([
    { name: "App.app/Contents/Info.plist", data: "plist" },
  ]);
  await verifyArtifact("sparkle", {}, "1.0.0", { ...base, signature }, valid);
  await assert.rejects(
    verifyArtifact(
      "sparkle",
      {},
      "1.0.0",
      { ...base, signature },
      Buffer.from("bad"),
    ),
    { code: "invalid_package" },
  );
  const service = await artifacts();
  await db("products").where({ id: "p" }).update({ framework: "electron" });
  const input = await publication({
    ...base,
    target: "windows-x64",
    filename: "app.exe",
  });
  await assert.rejects(service.publish(input), { code: "invalid_package" });
  const pe = Buffer.alloc(132);
  pe.write("MZ");
  pe.writeUInt32LE(128, 60);
  pe.write("PE\0\0", 128);
  await writeFile(input.file, pe);
  await service.publish(input);
});

test("publication validates bounds and preserves reservations when provider cleanup fails", async (t) => {
  const { Artifacts } = await import("../src/artifacts.ts");
  const { AppError } = await import("../src/errors.ts");
  for (const limit of [0, -1, 1.2, 2049 * 1024 * 1024, NaN])
    assert.throws(() => new Artifacts(db, store, primaryTenant, limit), {
      code: "invalid_upload_limit",
    });
  for (const grace of [0, -1, 1.2, 86400001])
    assert.throws(
      () => new Artifacts(db, store, primaryTenant, 25 * 1024 * 1024, grace),
      { code: "invalid_upload_limit" },
    );
  const service = await artifacts();
  const input = await publication({
    signature: "optional",
    minSystemVersion: "10.15",
  });
  for (const version of ["bad", "v1.0.0", "1.0.0-beta.1"])
    await assert.rejects(service.publish({ ...input, version }), {
      code: "invalid_version",
    });
  await assert.rejects(service.publish({ ...input, product: "missing" }), {
    code: "not_found",
  });
  await assert.rejects((await artifacts(10)).publish(input), {
    code: "upload_limit",
  });
  await writeFile(input.file, "");
  await assert.rejects(service.publish(input), { code: "upload_limit" });
  await writeFile(input.file, "first bytes");
  for (const error of [
    Error("failed put"),
    new AppError(409, "artifact_exists", "existing"),
  ]) {
    const mock = t.mock.method(store, "put", async () => {
      throw error;
    });
    await assert.rejects(service.publish(input), error);
    mock.mock.restore();
    assert.equal((await db("upload_reservations")).length, 0);
  }
  const get = t.mock.method(store, "get", async () => {
    throw Error("failed readback");
  });
  const remove = t.mock.method(store, "delete", async () => {
    throw Error("cleanup unavailable");
  });
  await assert.rejects(service.publish(input), /failed readback/);
  assert.equal((await db("upload_reservations")).length, 1);
  get.mock.restore();
  remove.mock.restore();
  await db("upload_reservations").update({ expires_at: 0 });
  await new Releases(db, store, primaryTenant, root).cleanup();
  assert.equal((await db("upload_reservations")).length, 0);
  const { asset } = await service.publish(input);
  assert.equal(asset.signature, "optional");
  assert.equal(asset.min_system_version, "10.15");
  for (const size of [0, -1, 1.1, NaN])
    await assert.rejects(service.read({ ...asset, size }), {
      code: "invalid_artifact",
    });
  await assert.rejects(
    service.read({ ...asset, sha512: Buffer.alloc(64).toString("base64") }),
    { code: "artifact_integrity" },
  );
  for (const bytes of [
    Buffer.from("wrong length"),
    Buffer.from("other bytes"),
  ]) {
    const mock = t.mock.method(store, "get", async () => bytes);
    await assert.rejects(service.read(asset), { code: "artifact_integrity" });
    mock.mock.restore();
  }
});

test("final publication rechecks reservations, capacity and framework identity after object verification", async (t) => {
  const service = await artifacts();
  const input = await publication();
  const original = store.get.bind(store);
  const changes: [() => Promise<unknown>, string][] = [
    [() => db("upload_reservations").delete(), "upload_expired"],
    [
      () => db("upload_reservations").update({ expires_at: 0 }),
      "upload_expired",
    ],
    [
      () =>
        db("tenants").where({ id: "primary" }).update({ max_storage_bytes: 1 }),
      "storage_limit",
    ],
    [
      () => db("products").where({ id: "p" }).update({ framework: "electron" }),
      "framework_identity_changed",
    ],
    [
      () =>
        db("products")
          .where({ id: "p" })
          .update({ framework_config: '{"activationKind":"site"}' }),
      "framework_identity_changed",
    ],
    [() => db("products").delete(), "framework_identity_changed"],
  ];
  for (const [change, code] of changes) {
    const mock = t.mock.method(
      store,
      "get",
      async (...args: Parameters<typeof store.get>) => {
        const bytes = await original(...args);
        await change();
        return bytes;
      },
    );
    await assert.rejects(service.publish(input), { code });
    mock.mock.restore();
    assert.equal((await db("release_assets")).length, 0);
    assert.equal((await db("upload_reservations")).length, 0);
    await db("tenants")
      .where({ id: "primary" })
      .update({ max_storage_bytes: 1024 ** 3 });
    await db("products").delete();
    await db("products").insert({
      tenant_id: "primary",
      id: "p",
      slug: "app",
      name: "App",
      framework: "generic",
      framework_config: "{}",
    });
  }
  const mock = t.mock.method(
    store,
    "get",
    async (...args: Parameters<typeof store.get>) => {
      const bytes = await original(...args);
      await db("products").delete();
      await db("upload_reservations").delete();
      await db("tenants").where({ id: "primary" }).delete();
      return bytes;
    },
  );
  await assert.rejects(service.publish(input), { code: "not_found" });
  mock.mock.restore();
  await db("tenants").insert({ ...primaryTenant });
});

for (const state of ["suspended", "expired"] as const) {
  for (const sandbox of [false, true]) {
    test(`native publication rechecks ${sandbox ? "sandbox parent" : "tenant"} ${state} after storage readback`, async (t) => {
      const service = await artifacts();
      const input = await publication();
      let authorityId = primaryTenant.id;
      if (sandbox) {
        const parent = await createTenant(db, {
          id: randomUUID(),
          slug: "parent",
          name: "Parent",
        });
        authorityId = parent.id;
        await db("publisher_sandboxes").insert({
          parent_tenant_id: parent.id,
          sandbox_tenant_id: primaryTenant.id,
          mode: "fixture",
          created_at: Date.now(),
        });
      }
      const get = store.get.bind(store);
      t.mock.method(
        store,
        "get",
        async (...args: Parameters<typeof store.get>) => {
          const value = await get(...args);
          await db("tenants")
            .where({ id: authorityId })
            .update(
              state === "suspended"
                ? { suspended: 1 }
                : { exempt: 0, trial_ends_at: 0, paid_through: 0 },
            );
          return value;
        },
      );
      const remove = t.mock.method(store, "delete");
      await assert.rejects(service.publish(input), {
        status: 403,
        code: state === "suspended" ? "tenant_suspended" : "tenant_capacity",
      });
      assert.equal(remove.mock.callCount(), 1);
      assert.equal((await db("releases")).length, 0);
      assert.equal((await db("release_assets")).length, 0);
      assert.equal((await db("business_events")).length, 0);
      assert.equal((await db("upload_reservations")).length, 0);
    });
  }
}

for (const policy of [
  { deploymentMode: "standalone", graceDays: 0, allowed: true },
  { deploymentMode: "hosted", graceDays: 2, allowed: true },
  { deploymentMode: "hosted", graceDays: 0, allowed: false },
] as const) {
  test(`native publication respects ${policy.deploymentMode} mode and ${policy.graceDays} grace days`, async () => {
    const { Artifacts } = await import("../src/artifacts.ts");
    await db("tenants")
      .where({ id: primaryTenant.id })
      .update({
        exempt: 0,
        trial_ends_at: 0,
        paid_through: Date.now() - 86400000,
      });
    const service = new Artifacts(
      db,
      store,
      primaryTenant,
      undefined,
      undefined,
      undefined,
      policy,
    );
    const input = await publication();
    if (policy.allowed) {
      const { asset } = await service.publish(input);
      assert.equal((await service.read(asset)).toString(), "first bytes");
    } else {
      await assert.rejects(service.publish(input), {
        status: 403,
        code: "tenant_capacity",
      });
      assert.equal((await db("upload_reservations")).length, 0);
      assert.equal((await db("release_assets")).length, 0);
    }
  });
}

test("the WordPress publication endpoint rejects a non-WordPress product", async () => {
  const input = await publication();
  await assert.rejects(
    new Releases(db, store, primaryTenant, root).publish({
      ...input,
      minWp: "6.0",
      minPhp: "8.0",
      minFree: "1.0.0",
      tested: "7.0",
    }),
    { code: "framework_mismatch" },
  );
});

test("native metadata accepts the supported target/filename matrix and rejects invalid signatures", async () => {
  const { validateAssetMetadata } =
    await import("../src/package-validation.ts");
  const { frameworkTargets } = await import("../src/frameworks.ts");
  const packet = Buffer.alloc(74);
  packet.write("ED");
  const signature = Buffer.from(
    `untrusted comment: signature from minisign secret key\n${packet.toString("base64")}\ntrusted comment: timestamp:123\n${Buffer.alloc(64).toString("base64")}\n`,
  ).toString("base64");
  const base = { target: "linux-x64", filename: "app.bin", changelog: "" };
  for (const [framework, filename] of [
    ["joomla", "app.zip"],
    ["jetbrains", "app.jar"],
  ] as const)
    assert.equal(
      validateAssetMetadata(framework, { ...base, target: "any", filename })
        .filename,
      filename,
    );
  for (const target of frameworkTargets.electron) {
    const filename = target.startsWith("windows")
      ? "app.exe"
      : target.startsWith("linux")
        ? "app.AppImage"
        : "app.zip";
    assert.equal(
      validateAssetMetadata("electron", { ...base, target, filename }).target,
      target,
    );
  }
  for (const target of frameworkTargets.tauri) {
    const filename = target.startsWith("windows")
      ? "app.exe"
      : target.startsWith("linux")
        ? "app.AppImage"
        : "app.app.tar.gz";
    assert.equal(
      validateAssetMetadata("tauri", { ...base, target, filename, signature })
        .signature,
      signature,
    );
  }
  for (const target of frameworkTargets.sparkle)
    assert.equal(
      validateAssetMetadata("sparkle", {
        ...base,
        target,
        filename: "app.zip",
        signature: Buffer.alloc(64).toString("base64"),
      }).target,
      target,
    );
  for (const bad of [
    "AA",
    "a!",
    Buffer.from("one line").toString("base64"),
    Buffer.from(
      `untrusted comment: test\n${Buffer.alloc(74).toString("base64")}\ntrusted comment: test\n${Buffer.alloc(64).toString("base64")}`,
    ).toString("base64"),
    Buffer.from(
      `bad comment\n${packet.toString("base64")}\ntrusted comment: test\n${Buffer.alloc(64).toString("base64")}`,
    ).toString("base64"),
    Buffer.from(
      `untrusted comment: test\n${packet.toString("base64")}\nbad comment\n${Buffer.alloc(64).toString("base64")}`,
    ).toString("base64"),
    Buffer.from(
      `untrusted comment: test\n${packet.toString("base64")}\ntrusted comment: test\n${Buffer.alloc(63).toString("base64")}`,
    ).toString("base64"),
  ])
    assert.throws(
      () =>
        validateAssetMetadata("tauri", {
          ...base,
          target: "windows-x86_64",
          filename: "app.exe",
          signature: bad,
        }),
      { code: "invalid_signature" },
    );
  assert.throws(
    () => validateAssetMetadata("generic", { ...base, filename: "CON.exe" }),
    { code: "invalid_filename" },
  );
  assert.throws(
    () =>
      validateAssetMetadata("electron", {
        ...base,
        target: "darwin-x64",
        filename: "app.exe",
      }),
    { code: "invalid_filename" },
  );
});

test("desktop format checks verify executable, installer and compressed TAR headers", async () => {
  const { verifyArtifact } = await import("../src/package-validation.ts");
  const { gzipSync } = await import("node:zlib");
  const { randomBytes } = await import("node:crypto");
  const base = { target: "linux-x64", filename: "app.bin", changelog: "" };
  const image = Buffer.alloc(64);
  image.set([127, 69, 76, 70]);
  image.set([65, 73, 2], 8);
  const dmg = Buffer.alloc(512);
  dmg.write("koly");
  const formats: [string, Buffer][] = [
    ["app.AppImage", image],
    ["app.dmg", dmg],
    ["app.msi", Buffer.from("d0cf11e0a1b11ae1", "hex")],
    ["app.pkg", Buffer.from("xar!")],
    ["app.deb", Buffer.from("!<arch>\n")],
    ["app.rpm", Buffer.from("edabeedb", "hex")],
  ];
  for (const [filename, bytes] of formats) {
    await verifyArtifact("electron", {}, "1.0.0", { ...base, filename }, bytes);
    await assert.rejects(
      verifyArtifact(
        "electron",
        {},
        "1.0.0",
        { ...base, filename },
        Buffer.from("bad"),
      ),
      { code: "invalid_package" },
    );
  }
  for (const bytes of [
    Buffer.from("MZ"),
    Buffer.alloc(64),
    (() => {
      const b = Buffer.alloc(64);
      b.write("MZ");
      b.writeUInt32LE(500, 60);
      return b;
    })(),
  ])
    await assert.rejects(
      verifyArtifact(
        "electron",
        {},
        "1.0.0",
        { ...base, filename: "app.exe" },
        bytes,
      ),
      { code: "invalid_package" },
    );
  function tar(
    entries: {
      name: string;
      prefix?: string;
      bytes?: Buffer;
      type?: string;
      size?: string;
    }[],
    trailer = true,
  ) {
    const parts: Buffer[] = [];
    for (const entry of entries) {
      const header = Buffer.alloc(512);
      header.write(entry.name);
      header.write("0000755", 100);
      header.write("0000000", 108);
      header.write("0000000", 116);
      const data = entry.bytes ?? Buffer.alloc(0);
      header.write(
        entry.size ?? data.length.toString(8).padStart(11, "0"),
        124,
      );
      header.fill(32, 148, 156);
      header.write(entry.type ?? "0", 156);
      header.write("ustar\0", 257);
      if (entry.prefix) header.write(entry.prefix, 345);
      const sum = header.reduce((a, b) => a + b, 0);
      header.write(sum.toString(8).padStart(6, "0"), 148);
      header[154] = 0;
      header[155] = 32;
      parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    if (trailer) parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
  }
  const good = tar([
    { name: "App.app/", type: "5" },
    {
      name: "Contents/Info.plist",
      prefix: "App.app",
      bytes: randomBytes(40000),
    },
    { name: "small", bytes: Buffer.from("hello") },
  ]);
  await verifyArtifact(
    "sparkle",
    {},
    "1.0.0",
    { ...base, filename: "app.tar.gz" },
    good,
  );
  for (const bytes of [
    Buffer.from("not gzip"),
    tar([]),
    tar([{ name: "../bad" }]),
    tar([{ name: "symlink", type: "2" }]),
    tar([{ name: "bad", size: "garbage" }]),
    tar([{ name: "dir/", type: "5", bytes: Buffer.from("data") }]),
    tar([{ name: "same" }, { name: "same" }]),
    tar([{ name: "good" }], false),
    gzipSync(Buffer.alloc(10)),
    gzipSync(Buffer.concat([Buffer.alloc(512), Buffer.from("bad trailer")])),
    tar([{ name: "large", bytes: Buffer.alloc(1000000) }]),
  ])
    await assert.rejects(
      verifyArtifact(
        "sparkle",
        {},
        "1.0.0",
        { ...base, filename: "app.tar.gz" },
        bytes,
      ),
      { code: "invalid_package" },
    );
});

test("ZIP safety checks reject aliases, encryption, malformed directories and unsupported streams", async (t) => {
  const { verifyArtifact } = await import("../src/package-validation.ts");
  const yauzl = (await import("yauzl")).default;
  const base = { target: "darwin-x64", filename: "app.zip", changelog: "" };
  const archives = [
    zipBytes([]),
    zipBytes([{ name: "file", data: "data" }], true),
    zipBytes([{ name: "/absolute", data: "bad" }]),
    zipBytes([{ name: "folder/../bad", data: "bad" }]),
    zipBytes([{ name: "folder/./bad", data: "bad" }]),
    zipBytes([{ name: "folder//bad", data: "bad" }]),
    zipBytes([{ name: "folder/back\\slash", data: "bad" }]),
    zipBytes([{ name: "C:drive", data: "bad" }]),
    zipBytes([{ name: "file.", data: "bad" }]),
    zipBytes([{ name: "CON.txt", data: "bad" }]),
    zipBytes([
      { name: "same", data: "one" },
      { name: "SAME", data: "two" },
    ]),
    zipBytes([{ name: "secret", data: "bad", flags: 1 }]),
    zipBytes([{ name: "directory/", data: "bad" }]),
    zipBytes([{ name: "directory/", crc: 1 }]),
    zipBytes([{ name: "invalid", method: 99, data: "bad" }]),
    zipBytes([
      {
        name: "broken",
        method: 8,
        compressed: Buffer.from([255, 255]),
        data: "expected",
      },
    ]),
    zipBytes([
      { name: "oversized", declaredSize: 251 * 1024 * 1024, data: "tiny" },
    ]),
    zipBytes(Array.from({ length: 2001 }, (_, n) => ({ name: `dir${n}/` }))),
  ];
  for (const bytes of archives)
    await assert.rejects(verifyArtifact("electron", {}, "1.0.0", base, bytes), {
      code: "invalid_package",
    });
  await verifyArtifact(
    "electron",
    {},
    "1.0.0",
    base,
    zipBytes([{ name: "App/" }, { name: "App/file", data: "data", method: 8 }]),
  );
  for (const error of [new Error("reader failed"), null]) {
    const mock = t.mock.method(
      yauzl,
      "fromBuffer",
      (
        _bytes: Buffer,
        _options: unknown,
        callback: (error: Error | null) => void,
      ) => callback(error),
    );
    await assert.rejects(
      verifyArtifact(
        "electron",
        {},
        "1.0.0",
        base,
        zipBytes([{ name: "file", data: "data" }]),
      ),
      { code: "invalid_package" },
    );
    mock.mock.restore();
  }
  const mock = t.mock.method(
    yauzl.ZipFile.prototype,
    "openReadStream",
    (_entry: unknown, callback: (error: Error | null) => void) =>
      callback(null),
  );
  await assert.rejects(
    verifyArtifact(
      "electron",
      {},
      "1.0.0",
      base,
      zipBytes([{ name: "file", data: "data" }]),
    ),
    { code: "invalid_package" },
  );
  mock.mock.restore();
});

test("Joomla extension identity variants and nested JetBrains JAR manifests are validated", async () => {
  const { verifyArtifact } = await import("../src/package-validation.ts");
  const { crc32 } = await import("node:zlib");
  const base = { target: "any", filename: "app.zip", changelog: "" };
  const configs = [
    {
      extensionType: "plugin",
      element: "hello",
      folder: "system",
      client: "administrator",
      joomlaMajor: 5,
    },
    { extensionType: "module", element: "mod_hello", joomlaMajor: 5 },
    { extensionType: "component", element: "com_hello", joomlaMajor: 5 },
    { extensionType: "package", element: "pkg_hello", joomlaMajor: 5 },
    { extensionType: "library", element: "hello", joomlaMajor: 5 },
    { extensionType: "template", element: "hello", joomlaMajor: 5 },
  ] as const;
  const manifests = [
    '<extension type="plugin" group="system" client="administrator"><version>1.0.0</version><files><filename plugin="other">other.php</filename><folder plugin="hello">src</folder></files></extension>',
    '<extension type="module"><version>1.0.0</version><files><filename module="mod_hello">hello.php</filename></files></extension>',
    '<extension type="component"><version>1.0.0</version></extension>',
    '<extension type="package"><version>1.0.0</version><packagename>hello</packagename></extension>',
    '<extension type="library"><version>1.0.0</version><libraryname>hello</libraryname></extension>',
    '<extension type="template"><version>1.0.0</version><name>hello</name></extension>',
  ];
  for (const [index, config] of configs.entries()) {
    const name =
      config.extensionType === "module" ? "mod_hello.xml" : "hello.xml";
    await verifyArtifact(
      "joomla",
      config,
      "1.0.0",
      base,
      zipBytes([{ name, data: manifests[index]! }]),
    );
    await assert.rejects(
      verifyArtifact(
        "joomla",
        config,
        "2.0.0",
        base,
        zipBytes([{ name, data: manifests[index]! }]),
      ),
      { code: "invalid_package" },
    );
  }
  const config = configs[0];
  for (const entries of [
    [
      {
        name: "hello.xml",
        data: manifests[0]!.replace('client="administrator"', 'client="site"'),
      },
    ],
    [
      {
        name: "hello.xml",
        data: manifests[0]!.replace('type="plugin"', 'type="module"'),
      },
    ],
    [
      {
        name: "hello.xml",
        data: manifests[0]!.replace(
          "<version>1.0.0</version>",
          "<version>1.0.0</version><version>1.0.0</version>",
        ),
      },
    ],
    [
      { name: "hello.xml", data: manifests[0]! },
      { name: "other.xml", data: manifests[0]! },
    ],
    [{ name: "hello.xml", data: "<other/>" }],
    [{ name: "hello.xml", data: "<extension>\0</extension>" }],
    [
      {
        name: "hello.xml",
        data: "<extension>" + "x".repeat(256 * 1024) + "</extension>",
      },
    ],
    [{ name: "hello.xml", data: "<extension/>" }],
  ])
    await assert.rejects(
      verifyArtifact("joomla", config, "1.0.0", base, zipBytes(entries)),
      { code: "invalid_package" },
    );
  const plugin =
    "<idea-plugin><id>com.example.plugin</id><version>1.0.0</version></idea-plugin>";
  const inner = zipBytes([{ name: "META-INF/plugin.xml", data: plugin }]);
  const name = "plugin/lib/plugin.jar",
    outer = zipBytes([{ name, data: "x".repeat(inner.length) }]);
  inner.copy(outer, 30 + Buffer.byteLength(name));
  outer.writeUInt32LE(crc32(inner), 14);
  outer.writeUInt32LE(
    crc32(inner),
    30 + Buffer.byteLength(name) + inner.length + 16,
  );
  await verifyArtifact(
    "jetbrains",
    { pluginId: "com.example.plugin", sinceBuild: "242" },
    "1.0.0",
    base,
    outer,
  );
  await assert.rejects(
    verifyArtifact(
      "jetbrains",
      { pluginId: "com.example.plugin", sinceBuild: "242" },
      "1.0.0",
      base,
      zipBytes([{ name: "file", data: "data" }]),
    ),
    { code: "invalid_package" },
  );
  await assert.rejects(
    verifyArtifact(
      "jetbrains",
      { pluginId: "com.example.plugin", sinceBuild: "242" },
      "1.0.0",
      base,
      zipBytes([
        {
          name: "META-INF/plugin.xml",
          data: "<idea-plugin><id>com.example.plugin</id><id>duplicate</id><version>1.0.0</version></idea-plugin>",
        },
      ]),
    ),
    { code: "invalid_package" },
  );
});

test("Joomla missing client defaults to site and WordPress reads reject missing product identities", async () => {
  const { verifyArtifact } = await import("../src/package-validation.ts");
  await verifyArtifact(
    "joomla",
    {
      extensionType: "plugin",
      element: "hello",
      folder: "system",
      client: "site",
      joomlaMajor: 5,
    },
    "1.0.0",
    { target: "any", filename: "plugin.zip", changelog: "" },
    zipBytes([
      {
        name: "hello.xml",
        data: '<extension type="plugin" group="system"><version>1.0.0</version><files><filename plugin="hello">hello.php</filename></files></extension>',
      },
    ]),
  );
  const { release } = await (await artifacts()).publish(await publication());
  await assert.rejects(
    new Releases(db, store, primaryTenant, root).read({
      ...release,
      product_id: "missing",
    }),
    { code: "framework_mismatch" },
  );
});

test("Tauri Linux filenames are updater artifacts and generic filenames may be one safe character", async () => {
  const { validateAssetMetadata } =
    await import("../src/package-validation.ts");
  assert.throws(
    () =>
      validateAssetMetadata("tauri", {
        target: "linux-x86_64",
        filename: "app.deb",
        changelog: "",
      }),
    { code: "invalid_filename" },
  );
  assert.equal(
    validateAssetMetadata("generic", {
      target: "any",
      filename: "x",
      changelog: "",
    }).filename,
    "x",
  );
});

test("compressed manifests cannot exceed the upload-relative verification buffer budget", async () => {
  const { verifyArtifact } = await import("../src/package-validation.ts");
  const { randomBytes } = await import("node:crypto");
  const description = randomBytes(8000).toString("base64").repeat(4);
  const xml = `<extension type="plugin" group="system"><version>1.0.0</version><description>${description}</description><files><filename plugin="hello">hello.php</filename></files></extension>`;
  const bytes = zipBytes([{ name: "hello.xml", data: xml, method: 8 }]);
  assert.ok(Buffer.byteLength(xml) > bytes.length * 2);
  await assert.rejects(
    verifyArtifact(
      "joomla",
      {
        extensionType: "plugin",
        element: "hello",
        folder: "system",
        joomlaMajor: 5,
      },
      "1.0.0",
      { target: "any", filename: "plugin.zip", changelog: "" },
      bytes,
    ),
    { code: "invalid_package" },
  );
});

test("desktop ZIP bundles accept internal framework links and reject escaping, cyclic or aliased links", async () => {
  const { verifyArtifact } = await import("../src/package-validation.ts");
  const base = { target: "darwin-arm64", filename: "app.zip", changelog: "" };
  const link = (name: string, data: string): ZipEntry => ({
    name,
    data,
    attributes: (0xa1ff << 16) >>> 0,
  });
  const regular: ZipEntry = {
    name: "App.app/Versions/A/App",
    data: "executable",
  };
  const links = [
    link("App.app/Versions/Current", "A"),
    link("App.app/App", "Versions/Current/App"),
  ];
  await verifyArtifact(
    "electron",
    {},
    "1.0.0",
    base,
    zipBytes([regular, ...links]),
  );
  for (const entries of [
    [regular, link("App.app/App", "../escape")],
    [regular, link("App.app/App", "/absolute")],
    [regular, link("App.app/App", "Versions\\A\\App")],
    [regular, link("App.app/App", "missing")],
    [regular, link("App.app/App", ".")],
    [regular, link("App.app/a", "b"), link("App.app/b", "a")],
    [
      regular,
      ...links,
      { name: "App.app/Versions/Current/overwrite", data: "bad" },
    ],
    [regular, link("App.app/App", "Versions/A/../A/App")],
    [regular, link("App.app/App", "x".repeat(1001))],
  ])
    await assert.rejects(
      verifyArtifact("electron", {}, "1.0.0", base, zipBytes(entries)),
      { code: "invalid_package" },
    );
  const cfg = {
    extensionType: "plugin",
    element: "hello",
    folder: "system",
    joomlaMajor: 5,
  } as const;
  await assert.rejects(
    verifyArtifact(
      "joomla",
      cfg,
      "1.0.0",
      { target: "any", filename: "app.zip", changelog: "" },
      zipBytes([regular, ...links]),
    ),
    { code: "invalid_package" },
  );
});

test("desktop TAR bundles accept relative links inside the app and reject escaping targets", async () => {
  const { verifyArtifact } = await import("../src/package-validation.ts");
  const { gzipSync } = await import("node:zlib");
  const base = {
    target: "darwin-aarch64",
    filename: "app.app.tar.gz",
    changelog: "",
  };
  function tar(link: string, size = 0) {
    const parts: Buffer[] = [];
    for (const [name, type, target, data] of [
      ["App.app/file", "0", "", Buffer.from("executable")],
      ["App.app/Sub/link", "2", link, Buffer.alloc(size)],
    ] as const) {
      const header = Buffer.alloc(512);
      header.write(name);
      header.write(data.length.toString(8).padStart(11, "0"), 124);
      header.fill(32, 148, 156);
      header.write(type, 156);
      header.write(target, 157);
      header.write("ustar\0", 257);
      header.write(
        header
          .reduce((a, b) => a + b, 0)
          .toString(8)
          .padStart(6, "0"),
        148,
      );
      header[154] = 0;
      header[155] = 32;
      parts.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    parts.push(Buffer.alloc(1024));
    return gzipSync(Buffer.concat(parts));
  }
  await verifyArtifact("tauri", {}, "1.0.0", base, tar("../file"));
  await verifyArtifact("tauri", {}, "1.0.0", base, tar("./../file"));
  for (const link of [
    "../../outside",
    "/outside",
    "../missing",
    "",
    "../Sub/link",
    "../file/../file",
  ])
    await assert.rejects(
      verifyArtifact("tauri", {}, "1.0.0", base, tar(link)),
      { code: "invalid_package" },
    );
  await assert.rejects(
    verifyArtifact("tauri", {}, "1.0.0", base, tar("../file", 1)),
    { code: "invalid_package" },
  );
});
