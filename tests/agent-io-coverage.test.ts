import test from "node:test";
import assert from "node:assert/strict";
import filesystem, {
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { genericApi } from "../src/cli-api.ts";
import { loginStart } from "../src/agent-session.ts";

test("private output cleanup preserves uncertainty when close and unlink operations fail", async (t) => {
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/agent-io-contract-");
  const originalFetch = globalThis.fetch;
  const rawOpen = filesystem.open,
    unlink = filesystem.unlink;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(
    filesystem,
    "open",
    async (...args: Parameters<typeof open>) => {
      const handle = await rawOpen(...args);
      const close = handle.close.bind(handle);
      t.mock.method(handle, "close", async () => {
        await close();
        throw Error("close failed after closing");
      });
      return handle;
    },
  );
  t.mock.method(filesystem, "unlink", async (path: string) => {
    await unlink(path);
    throw Error("unlink failed after removing");
  });
  syncBuiltinESMExports();
  const env = {
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
  };
  const io = { log: (_line: string) => {} };
  globalThis.fetch = async () => {
    throw "network failed";
  };
  await assert.rejects(
    genericApi(
      "api",
      [
        "POST",
        "/products",
        "--output",
        join(dir, "body"),
        "--headers-output",
        join(dir, "headers"),
      ],
      env,
      io,
    ),
    /may have been applied.*Request failed/,
  );
  globalThis.fetch = async () =>
    new Response(null, {
      headers: { "set-cookie": `de-seller-preauth=${"t".repeat(43)}` },
    });
  await assert.rejects(
    loginStart("owner@example.test", join(dir, "preauth"), env, io),
    /remote operation completed/,
  );
  globalThis.fetch = async () => Response.json({ ok: true });
  await assert.rejects(
    genericApi(
      "api",
      ["GET", "/products", "--headers-output", join(dir, "failed-headers")],
      env,
      io,
    ),
    /Response headers could not be saved/,
  );
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(Error("broken stream"));
        },
      }),
    );
  await assert.rejects(
    genericApi(
      "api",
      ["GET", "/products", "--output", join(dir, "failed-body")],
      env,
      io,
    ),
    /broken stream/,
  );
});

test("API file options reject ambiguous metadata and body sources before contacting the server", async (t) => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/agent-options-contract-",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = {
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
  };
  const io = { log: (_line: string) => {} };
  const path = join(dir, "input");
  await writeFile(path, "{}");
  await assert.rejects(
    genericApi(
      "api",
      ["POST", "/products", "--body", path, "--upload", path],
      env,
      io,
    ),
    /Choose one request body/,
  );
  await assert.rejects(
    genericApi("api", ["GET", "/products", "--body", path], env, io),
    /GET and HEAD/,
  );
  await assert.rejects(
    genericApi("api", ["POST", "/exports"], env, io, { passphrase: "secret" }),
    /owner-only body file/,
  );
  await assert.rejects(
    genericApi("api", ["POST", "/products", "--metadata", path], env, io),
    /Metadata requires/,
  );
  await assert.rejects(
    genericApi(
      "api",
      ["POST", "/assets/plugin/1.0.0", "--upload", path, "--metadata", path],
      env,
      io,
      undefined,
      { inlineMetadata: {} },
    ),
    /Choose one metadata source/,
  );
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    new Response("text/plain data", {
      headers: { "content-type": "text/plain" },
    });
  await assert.rejects(
    genericApi("api", ["GET", "/products"], env, io),
    /Non-JSON response requires/,
  );
  globalThis.fetch = async () =>
    new Response(null, { headers: { "content-type": "application/json" } });
  await assert.rejects(
    genericApi("api", ["GET", "/products"], env, io),
    SyntaxError,
  );
  const output = join(dir, "empty-output");
  await genericApi("api", ["GET", "/products", "--output", output], env, io);
  assert.equal((await readFile(output)).length, 0);
});

test("API validates argument counts and forwards byte-range requests", async (t) => {
  const env = {
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
  };
  const io = { log: (_line: string) => {} };
  for (const args of [
    [],
    ["GET"],
    ["TRACE", "/products"],
    ["GET", ""],
    ["GET", "/products", "extra"],
  ])
    await assert.rejects(genericApi("api", args, env, io), /Usage:/);
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get("range"), "bytes=0-4");
    return new Response(null, { status: 204 });
  };
  await genericApi(
    "api",
    ["GET", "/products", "--range", "bytes=0-4"],
    env,
    io,
  );
});
