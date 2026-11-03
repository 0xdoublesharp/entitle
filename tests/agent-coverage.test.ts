import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { runAgentOperation, runAgentCli } from "../src/agent-operations.ts";
import { runCli } from "../src/cli.ts";
import { genericApi } from "../src/cli-api.ts";
import { createExport, downloadExport } from "../src/agent-export.ts";
import { readRegularFile } from "../src/cli-files.ts";

const uuid = "a3a25a94-32f8-4cfb-92d8-339a8f5a39db";
const seller = "/api/v1/tenants/primary/seller";
const buyer = "/api/v1/tenants/primary";
const owner = "/api/v1/platform";
const operator = "/api/v1/operator";
const io = { log: (_value: string) => {}, error: (_value: string) => {} };

test("structured operations preserve documented methods, routes, bodies and private downloads", async (t) => {
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/agent-contract-",
  );
  const calls: {
    method: string;
    path: string;
    body: string;
    authorization?: string;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      method: req.method!,
      path: req.url!,
      body: Buffer.concat(chunks).toString(),
      ...(req.headers.authorization
        ? { authorization: req.headers.authorization }
        : {}),
    });
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const env = {
    PUBLIC_ORIGIN: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
    OPERATOR_TOKEN: "operator-secret-".repeat(3),
    ENTITLE_COOKIE: "de-seller-session=fixture",
    ENTITLE_CSRF_TOKEN: "csrf-fixture",
  };
  const cases: [string, Record<string, unknown>, string, string, unknown?][] = [
    [
      "owner-session-revoke",
      { id: "session" },
      "POST",
      `${owner}/account/sessions/revoke`,
      { id: "session" },
    ],
    [
      "owner-sessions-revoke-others",
      {},
      "POST",
      `${owner}/account/sessions/revoke-others`,
      {},
    ],
    [
      "owner-sessions-revoke-all",
      {},
      "POST",
      `${owner}/account/sessions/revoke-all`,
      {},
    ],
    ["buyer-notifications", {}, "GET", `${buyer}/notifications`],
    [
      "buyer-notification-dismiss",
      { id: "notice" },
      "POST",
      `${buyer}/notifications/notice/dismiss`,
      {},
    ],
    [
      "buyer-installation-deactivate",
      { id: "installation" },
      "POST",
      `${buyer}/installations/installation/deactivate`,
      {},
    ],
    ["buyer-closure-status", {}, "GET", `${buyer}/account/closure`],
    ["buyer-closure-request", {}, "POST", `${buyer}/account/closure`, {}],
    ["buyer-logout", {}, "POST", `${buyer}/auth/logout`, {}],
    ["catalog", {}, "GET", `${buyer}/catalog`],
    ["activation-status", {}, "GET", `${buyer}/activation`],
    ["activation-deactivate", {}, "POST", `${buyer}/deactivate`, {}],
    ["update-check", { product: "plugin" }, "GET", `${buyer}/updates/plugin`],
    ["owner-me", {}, "GET", `${owner}/me`],
    [
      "owner-verification-request",
      { purpose: "billing" },
      "POST",
      `${owner}/account/verification/request`,
      { purpose: "billing" },
    ],
    [
      "workspace-create",
      { slug: "new-workspace", name: "New workspace" },
      "POST",
      `${owner}/tenants`,
      { slug: "new-workspace", name: "New workspace" },
    ],
    ["owner-keys", {}, "GET", `${seller}/keys`],
    [
      "owner-key-revoke",
      { id: "key" },
      "POST",
      `${seller}/keys/key/revoke`,
      {},
    ],
    ["stripe-connect", {}, "POST", `${seller}/stripe/connect`, {}],
    ["platform-checkout", {}, "POST", `${seller}/platform/checkout`, {}],
    [
      "platform-checkout",
      { tier: "pro" },
      "POST",
      `${seller}/platform/checkout`,
      { tier: "pro" },
    ],
    ["platform-portal", {}, "POST", `${seller}/platform/portal`, {}],
    ["sandbox-status", {}, "GET", `${seller}/sandbox`],
    [
      "sandbox-create",
      { mode: "fixture" },
      "POST",
      `${seller}/sandbox`,
      { mode: "fixture" },
    ],
    [
      "sandbox-purchase",
      { planId: "plan" },
      "POST",
      `${seller}/sandbox/purchase`,
      { planId: "plan" },
    ],
    ["commerce-settings", {}, "GET", `${seller}/commerce/settings`],
    [
      "commerce-settings-update",
      {
        settings: {
          automaticTax: true,
          collectTaxId: true,
          collectBillingAddress: false,
        },
      },
      "PUT",
      `${seller}/commerce/settings`,
      { automaticTax: true, collectTaxId: true, collectBillingAddress: false },
    ],
    [
      "commerce-tax-code",
      { id: "product", taxCode: null },
      "PUT",
      `${seller}/commerce/products/product/tax-code`,
      { taxCode: null },
    ],
    ["license-detail", { id: "license" }, "GET", `${seller}/licenses/license?`],
    [
      "license-detail",
      { id: "license", after: "installation", limit: 20 },
      "GET",
      `${seller}/licenses/license?after=installation&limit=20`,
    ],
    [
      "jobs-retry-failed",
      { table: "emails" },
      "POST",
      `${seller}/jobs/emails/retry-failed`,
      {},
    ],
    [
      "jobs-retry-failed",
      { table: "work", limit: 10 },
      "POST",
      `${seller}/jobs/work/retry-failed`,
      { limit: 10 },
    ],
    [
      "platform-jobs-retry-failed",
      { table: "platform_emails" },
      "POST",
      `${operator}/jobs/platform_emails/retry-failed`,
      {},
    ],
    [
      "platform-jobs-retry-failed",
      { table: "platform_work", limit: 10 },
      "POST",
      `${operator}/jobs/platform_work/retry-failed`,
      { limit: 10 },
    ],
    ["reports", {}, "GET", `${seller}/operations/reports`],
    [
      "operations-settings",
      { settings: { warningDays: 3 } },
      "PUT",
      `${seller}/operations/settings`,
      { warningDays: 3 },
    ],
    [
      "webhook-rotate",
      { id: uuid },
      "POST",
      `${seller}/webhooks/${uuid}/rotate`,
      {},
    ],
    [
      "webhook-delete",
      { id: uuid },
      "DELETE",
      `${seller}/webhooks/${uuid}`,
      {},
    ],
    [
      "webhook-retry",
      { id: "a".repeat(64) },
      "POST",
      `${seller}/webhook-deliveries/${"a".repeat(64)}/retry`,
      {},
    ],
    ["export-list", {}, "GET", `${seller}/exports`],
    ["export-delete", { id: uuid }, "DELETE", `${seller}/exports/${uuid}`, {}],
  ];
  for (const [name, input, method, route, body] of cases) {
    await runAgentOperation(name, input, env, io);
    const call = calls.at(-1)!;
    assert.equal(call.method, method, name);
    assert.equal(call.path, route, name);
    assert.deepEqual(call.body ? JSON.parse(call.body) : undefined, body, name);
    if (route.startsWith(operator))
      assert.equal(call.authorization, `Bearer ${env.OPERATOR_TOKEN}`);
    else if (
      !["request"].includes(name) &&
      [
        "jobs-retry-failed",
        "reports",
        "operations-settings",
        "license-detail",
        "webhook-rotate",
        "webhook-delete",
        "webhook-retry",
        "export-list",
        "export-delete",
      ].includes(name)
    )
      assert.equal(call.authorization, `Bearer ${env.TENANT_API_KEY}`);
  }
  for (const [name, input, route] of [
    ["buyer-data-export", {}, `${buyer}/account/export`],
    [
      "buyer-release-download",
      { licenseId: "license", releaseId: uuid },
      `${buyer}/licenses/license/releases/${uuid}/download`,
    ],
    [
      "buyer-asset-download",
      { licenseId: "license", assetId: uuid },
      `${buyer}/licenses/license/assets/${uuid}/download`,
    ],
    [
      "installation-release-download",
      { releaseId: uuid },
      `${buyer}/packages/${uuid}`,
    ],
    [
      "installation-asset-download",
      { product: "plugin", assetId: uuid, filename: "app.zip" },
      `${buyer}/packages/plugin/assets/${uuid}/app.zip`,
    ],
  ] as const) {
    const output = join(directory, name);
    await runAgentOperation(name, { ...input, output }, env, io);
    assert.equal(calls.at(-1)!.path, route);
    assert.equal(await readFile(output, "utf8"), '{"ok":true}');
  }
  await assert.rejects(
    runAgentOperation("unknown", {}, env, io),
    /Unknown operation/,
  );
  const upload = join(directory, "upload");
  await writeFile(upload, "original package bytes");
  for (const [name, metadata, route] of [
    [
      "release-publish",
      { changelog: "Release notes" },
      `${seller}/releases/plugin/1.2.3`,
    ],
    [
      "asset-publish",
      { target: "linux-x64", filename: "app.zip", changelog: "Native notes" },
      `${seller}/assets/plugin/1.2.3`,
    ],
  ] as const) {
    await runAgentOperation(
      name,
      { product: "plugin", version: "1.2.3", file: upload, metadata },
      env,
      io,
    );
    assert.equal(calls.at(-1)!.path, route);
    assert.equal(calls.at(-1)!.body, "original package bytes");
  }
  for (const TENANT_SLUG of [undefined, "A", "a".repeat(101)])
    await assert.rejects(
      runAgentOperation("catalog", {}, { ...env, TENANT_SLUG }, io),
      /valid TENANT_SLUG/,
    );
  await assert.rejects(
    runAgentCli("reports", ["one", "two"], env, io),
    /one JSON input file/,
  );
  for (const command of [
    "owner-login-start",
    "owner-login-finish",
    "owner-session-refresh",
    "owner-verification-consume",
    "buyer-login-start",
    "buyer-login-finish",
    "buyer-session-refresh",
    "activation-create",
    "export-create",
    "export-download",
  ])
    assert.equal(await runCli([command], env, io), 1, command);
});

test("export creation uses private passphrase input, validates listing and reports incomplete downloads", async (t) => {
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/export-contract-",
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const env = {
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
  };
  let status = "ready",
    blobs: string[] = [],
    failure: unknown,
    created = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      created++;
      assert.equal(
        JSON.parse(String(init.body)).passphrase,
        "private passphrase",
      );
      return Response.json({ id: uuid });
    }
    if (String(_url).endsWith("/exports"))
      return Response.json({ exports: [{ id: uuid, status, blobs }] });
    if (failure) throw failure;
    return new Response("manifest");
  };
  const body = join(directory, "body.json");
  await writeFile(body, JSON.stringify({ passphrase: "private passphrase" }), {
    mode: 0o600,
  });
  await assert.rejects(createExport("", env, io), /owner-only JSON body file/);
  await createExport(body, env, io);
  assert.equal(created, 1);
  await assert.rejects(downloadExport("invalid", directory, env, io));
  await assert.rejects(
    downloadExport(uuid, "", env, io),
    /new private output directory/,
  );
  status = "pending";
  await assert.rejects(
    downloadExport(uuid, join(directory, "pending"), env, io),
    /not ready/,
  );
  status = "ready";
  blobs = [uuid, uuid];
  await assert.rejects(
    downloadExport(uuid, join(directory, "duplicates"), env, io),
    /duplicate blob/,
  );
  blobs = [];
  await downloadExport(uuid, join(directory, "empty"), env, io);
  assert.equal(
    await readFile(join(directory, "empty/manifest.entitle"), "utf8"),
    "manifest",
  );
  failure = "connection lost";
  await assert.rejects(
    downloadExport(uuid, join(directory, "partial"), env, io),
    /incomplete.*Download failed/,
  );
});

test("API rejects malformed encodings and oversized JSON responses without dispatching unsafe paths", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const env = {
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
  };
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(`"${"x".repeat(4 * 1024 * 1024)}"`, {
      headers: { "content-type": "application/json" },
    });
  };
  await assert.rejects(
    genericApi("api", ["GET", "/%ZZ"], env, io),
    /Invalid API path encoding/,
  );
  await assert.rejects(
    genericApi("api", ["GET", "/has space"], env, io),
    /Invalid API path/,
  );
  await assert.rejects(
    genericApi(
      "api",
      ["GET", "/products"],
      { ...env, PUBLIC_ORIGIN: "ftp://example.test" },
      io,
    ),
    /HTTP\(S\) origin/,
  );
  await assert.rejects(
    genericApi("api", ["GET", "/a%01b"], env, io),
    /Invalid API path segment/,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    genericApi("api", ["GET", "/products"], env, io),
    /Response exceeds 4 MiB/,
  );
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/regular-file-contract-",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "input");
  await writeFile(path, "small");
  assert.equal((await readRegularFile(path)).toString(), "small");
  await assert.rejects(
    readRegularFile(path, 2),
    /regular file within the size limit/,
  );
});
