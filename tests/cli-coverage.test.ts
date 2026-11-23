import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createDb } from "../src/db.ts";
import { runCli } from "../src/cli.ts";

const root = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/cli-coverage-",
);
const calls: {
  method: string;
  path: string;
  authorization?: string;
  type?: string;
  metadata?: string;
  body: Buffer;
}[] = [];
let responseCode = 200;
let responseBody = '{"ok":true}';
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  calls.push({
    method: req.method!,
    path: req.url!,
    ...(req.headers.authorization
      ? { authorization: req.headers.authorization }
      : {}),
    ...(req.headers["content-type"]
      ? { type: req.headers["content-type"] }
      : {}),
    ...(req.headers["x-release-metadata"]
      ? { metadata: String(req.headers["x-release-metadata"]) }
      : {}),
    body: Buffer.concat(chunks),
  });
  res.writeHead(responseCode, { "content-type": "application/json" });
  res.end(responseBody);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const env = {
  APP_SECRET: "44".repeat(32),
  OPERATOR_TOKEN: "test-operator-token".repeat(3),
  DATABASE_URL: `sqlite:${join(root, "migrate.sqlite")}`,
  PUBLIC_ORIGIN: origin,
  TENANT_SLUG: "primary",
  TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
};
const output: string[] = [],
  errors: string[] = [];
const io = {
  log: (message: string) => output.push(message),
  error: (message: string) => errors.push(message),
};
before(async () => {
  await writeFile(
    join(root, "product.json"),
    JSON.stringify({ slug: "test-product" }),
  );
  await writeFile(
    join(root, "release.json"),
    JSON.stringify({ changelog: "Literal $() and `ticks`\nUnicode é" }),
  );
  await writeFile(join(root, "release.zip"), Buffer.from([0, 1, 2, 255]));
});
beforeEach(() => {
  calls.length = 0;
  output.length = 0;
  errors.length = 0;
  responseCode = 200;
  responseBody = '{"ok":true}';
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

test("CLI reports invalid environment as an error result without exiting its caller", async () => {
  const errors: string[] = [];
  const result = await runCli(
    ["product", join(root, "product.json")],
    {},
    { log: () => {}, error: (message: string) => errors.push(message) },
  );
  assert.equal(result, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /invalid|expected|TENANT_SLUG/i);
});

test("CLI sends every tenant seller command with exact methods, authentication and encoded paths", async () => {
  const cases: { args: string[]; path: string; body?: unknown }[] = [
    { args: ["licenses"], path: "/seller/overview" },
    { args: ["jobs"], path: "/seller/jobs" },
    { args: ["work"], path: "/seller/jobs/run", body: {} },
    {
      args: ["revoke", "license/one"],
      path: "/seller/licenses/license%2Fone/revoke",
      body: { revoked: true },
    },
    {
      args: ["restore", "license/one"],
      path: "/seller/licenses/license%2Fone/revoke",
      body: { revoked: false },
    },
    {
      args: ["withdraw", "release/one"],
      path: "/seller/releases/release%2Fone/withdraw",
      body: {},
    },
    { args: ["reconcile"], path: "/seller/reconcile", body: {} },
    {
      args: ["reconcile", "sub_one"],
      path: "/seller/reconcile",
      body: { subscriptionId: "sub_one" },
    },
    {
      args: ["demo-purchase", "plan", "person@example.test"],
      path: "/seller/local/purchase",
      body: { planId: "plan", email: "person@example.test" },
    },
    {
      args: ["product", join(root, "product.json")],
      path: "/seller/products",
      body: { slug: "test-product" },
    },
  ];
  for (const c of cases) {
    assert.equal(await runCli(c.args, env, io), 0);
    const request = calls.at(-1)!;
    assert.equal(request.path, `/api/v1/tenants/primary${c.path}`);
    assert.equal(request.method, c.body === undefined ? "GET" : "POST");
    assert.equal(request.authorization, `Bearer ${env.TENANT_API_KEY}`);
    assert.equal(
      request.body.toString(),
      c.body === undefined ? "" : JSON.stringify(c.body),
    );
  }
  assert.equal(errors.length, 0);
  assert.equal(output.length, cases.length);
  assert.deepEqual(JSON.parse(output[0]!), { ok: true });
});

test("CLI reports upstream HTML errors and accepts a 204 with no content", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout");
  responseCode = 502;
  responseBody = "<html>Bad Gateway</html>";
  assert.equal(await runCli(["prices"], env, io), 1);
  assert.match(errors[0]!, /API returned 502: <html>Bad Gateway<\/html>/);
  assert.ok(timeout.mock.calls.some(({ arguments: args }) => args[0] === 60000));
  assert.equal(output.length, 0);
  responseCode = 204;
  responseBody = "";
  assert.equal(await runCli(["prices"], env, io), 0);
  assert.deepEqual(output, []);
});

test("publication sends original ZIP bytes and lossless metadata to the tenant origin with the upload timeout", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout");
  assert.equal(
    await runCli(
      [
        "publish",
        "product/name",
        "1.0.0+build",
        join(root, "release.zip"),
        join(root, "release.json"),
      ],
      {
        ...env,
        PUBLIC_ORIGIN: origin,
        OPERATOR_ORIGIN: "https://unused.invalid",
      },
      io,
    ),
    0,
  );
  const c = calls[0]!;
  assert.equal(timeout.mock.calls[0]?.arguments[0], 3600000);
  assert.equal(
    c.path,
    "/api/v1/tenants/primary/seller/releases/product%2Fname/1.0.0%2Bbuild",
  );
  assert.equal(c.method, "POST");
  assert.equal(c.type, "application/zip");
  assert.deepEqual(c.body, Buffer.from([0, 1, 2, 255]));
  assert.deepEqual(
    JSON.parse(Buffer.from(c.metadata!, "base64url").toString()),
    { changelog: "Literal $() and `ticks`\nUnicode é" },
  );
});

test("product defaults to product.json in the working directory", async () => {
  const previous = process.cwd();
  try {
    process.chdir(root);
    assert.equal(await runCli(["product"], env, io), 0);
  } finally {
    process.chdir(previous);
  }
  assert.deepEqual(JSON.parse(calls[0]!.body.toString()), {
    slug: "test-product",
  });
});

test("migrate creates real SQLite schema and closes its connection", async () => {
  assert.equal(await runCli(["migrate"], env, io), 0);
  assert.deepEqual(output, ["Migrations applied."]);
  const db = createDb(env.DATABASE_URL);
  try {
    assert.equal(await db.schema.hasTable("licenses"), true);
  } finally {
    await db.destroy();
  }
  assert.equal(await runCli(["migrate"], env, io), 0);
});

test("usage and file errors return nonzero without making requests", async () => {
  assert.equal(await runCli([], env, io), 1);
  for (const command of ["owner-passkey-login-start", "owner-passkey-login-finish", "owner-reauth-verify"])
    assert.ok(errors[0]!.includes(command));

  for (const args of [
    ["unknown"],
    ["publish"],
    ["publish", "p"],
    ["publish", "p", "1.0.0"],
    ["publish", "p", "1.0.0", "file"],
    ["revoke"],
    ["restore"],
    ["withdraw"],
    ["demo-purchase"],
    ["demo-purchase", "plan"],
    ["product", join(root, "missing.json")],
  ]) {
    assert.equal(await runCli(args, env, io), 1, JSON.stringify(args));
  }
  assert.equal(calls.length, 0);
  assert.equal(errors.length, 12);
  assert.match(errors[0]!, /Commands:/);
  assert.match(errors.at(-1)!, /ENOENT/);
});

test("HTTP errors, malformed provider JSON, network failures and unknown thrown values fail cleanly", async (t) => {
  responseCode = 403;
  responseBody = '{"error":{"code":"tenant_denied"}}';
  assert.equal(await runCli(["licenses"], env, io), 1);
  assert.match(errors.at(-1)!, /403.*tenant_denied/);
  responseCode = 200;
  responseBody = "not-json";
  assert.equal(await runCli(["licenses"], env, io), 1);
  assert.equal(
    await runCli(
      ["licenses"],
      { ...env, PUBLIC_ORIGIN: "http://127.0.0.1:1" },
      io,
    ),
    1,
  );
  const fake = t.mock.method(globalThis, "fetch", async () => {
    throw "non-error failure";
  });
  assert.equal(await runCli(["licenses"], env, io), 1);
  assert.equal(errors.at(-1), "Command failed.");
  fake.mock.restore();
});

test("default arguments use process environment and console output", async (t) => {
  const previousEnv = process.env,
    previousArgv = process.argv;
  const logger = t.mock.method(console, "log");
  try {
    process.env = { ...process.env, ...env };
    process.argv = [process.execPath, "cli.ts", "licenses"];
    assert.equal(await runCli(), 0);
    assert.equal(logger.mock.callCount(), 1);
    assert.deepEqual(JSON.parse(String(logger.mock.calls[0]!.arguments[0])), {
      ok: true,
    });
  } finally {
    process.env = previousEnv;
    process.argv = previousArgv;
    logger.mock.restore();
  }
});

test("real CLI process exits zero for success and one for usage failure", async () => {
  const invoke = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ["src/cli.ts", ...args], {
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "",
          err = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.stderr.on("data", (chunk) => (err += chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, out, err }));
      },
    );
  const success = await invoke(["licenses"]);
  assert.equal(success.code, 0);
  assert.deepEqual(JSON.parse(success.out), { ok: true });
  const failure = await invoke(["bad-command"]);
  assert.equal(failure.code, 1);
  assert.match(failure.err, /Commands:/);
});
