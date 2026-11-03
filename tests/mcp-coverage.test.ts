import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

test("MCP tools preserve protocol results, validation and private-file credentials", async (t) => {
  const module =
    (await import("../src/mcp.ts")) as typeof import("../src/mcp.ts") & {
      createMcpServer: () => Server;
    };
  assert.equal(
    typeof module.createMcpServer,
    "function",
    "MCP server construction is available independently of stdio startup",
  );
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/mcp-contract-");
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const server = module.createMcpServer();
  const client = new Client({ name: "contract-test", version: "1" });
  t.after(async () => {
    await client.close();
    await server.close();
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.PUBLIC_ORIGIN = "https://accounts.example.test";
  process.env.TENANT_SLUG = "primary";
  process.env.TENANT_API_KEY = `DE-TK-${"a".repeat(43)}`;
  process.env.OPERATOR_TOKEN = "operator-secret-".repeat(3);
  process.env.ENTITLE_COOKIE = "de-seller-session=fixture";
  process.env.ENTITLE_CSRF_TOKEN = "csrf-secret";
  process.env.ENTITLE_VERIFICATION = "verification-secret";
  process.env.APP_SECRET = "application-secret";
  delete process.env.ENTITLE_SESSION_FILE;
  delete process.env.ENTITLE_BUYER_SESSION_FILE;
  delete process.env.ENTITLE_VERIFICATION_FILE;
  const token = "t".repeat(43),
    tokenFile = join(dir, "token");
  await writeFile(tokenFile, token, { mode: 0o600 });
  let failure: unknown,
    blank = false;
  globalThis.fetch = async (url) => {
    if (failure) throw failure;
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/auth/request"))
      return new Response(null, {
        headers: { "set-cookie": `de-seller-preauth=${token}; Path=/` },
      });
    if (path.endsWith("/auth/consume"))
      return new Response(null, {
        headers: {
          "set-cookie": path.includes("/tenants/")
            ? `de-session-primary=${token}; Path=/`
            : `de-seller-session=${token}; Path=/`,
        },
      });
    if (path.endsWith("/me"))
      return Response.json({ csrfToken: "fixture-csrf" });
    if (path.endsWith("/verification/consume"))
      return Response.json({ verification: "proof", expiresIn: 300 });
    if (path.endsWith("/activate"))
      return Response.json({ token: "activation" });
    if (path.endsWith("/exports"))
      return Response.json({ id: "a3a25a94-32f8-4cfb-92d8-339a8f5a39db" });
    return blank
      ? new Response(null, { status: 204 })
      : Response.json({ ok: true });
  };
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listing = await client.listTools();
  assert.ok(
    listing.tools.some((tool) => tool.name === "entitle_owner_login_start"),
  );
  const call = (name: string, args?: Record<string, unknown>) =>
    client.callTool({ name, ...(args ? { arguments: args } : {}) });
  const success = async (name: string, args?: Record<string, unknown>) => {
    const result = await call(name, args);
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return result;
  };
  const ownerPreauth = join(dir, "preauth"),
    ownerSession = join(dir, "owner"),
    buyerSession = join(dir, "buyer");
  await success("entitle_buyer_login_start", { email: "buyer@example.test" });
  await success("entitle_buyer_login_finish", {
    tokenFile,
    sessionFile: buyerSession,
  });
  await success("entitle_buyer_session_refresh", { sessionFile: buyerSession });
  await success("entitle_owner_login_start", {
    email: "owner@example.test",
    preauthFile: ownerPreauth,
  });
  await success("entitle_owner_login_finish", {
    preauthFile: ownerPreauth,
    tokenFile,
    sessionFile: ownerSession,
  });
  await success("entitle_owner_session_refresh", { sessionFile: ownerSession });
  const proof = join(dir, "proof-input");
  await writeFile(
    proof,
    JSON.stringify({ purpose: "api_keys", token: "verification" }),
    { mode: 0o600 },
  );
  await success("entitle_owner_verification_consume", {
    bodyFile: proof,
    proofFile: join(dir, "proof"),
  });
  const activation = join(dir, "activation-input");
  await writeFile(
    activation,
    JSON.stringify({
      key: "DE-key",
      product: "plugin",
      installationId: "device",
    }),
    { mode: 0o600 },
  );
  await success("entitle_activation_create", {
    bodyFile: activation,
    activationFile: join(dir, "activation"),
  });
  assert.match(await readFile(join(dir, "activation"), "utf8"), /activation/);
  const body = join(dir, "export-input");
  await writeFile(body, JSON.stringify({ passphrase: "private passphrase" }), {
    mode: 0o600,
  });
  await success("entitle_export_create", { bodyFile: body });
  await success("entitle_operator_request", {
    method: "GET",
    path: "/tenants",
  });
  await success("entitle_seller_request", {
    method: "POST",
    path: "/products",
    body: { name: "Plugin" },
  });
  await success("entitle_op_reports");
  await success("entitle_features", { args: [] });
  blank = true;
  await success("entitle_op_catalog", {});
  blank = false;
  for (const [name, args] of [
    ["entitle_owner_login_start", {}],
    ["entitle_buyer_login_start", {}],
    ["entitle_export_download", {}],
    ["entitle_op_workspace_create", {}],
    ["entitle_seller_request", {}],
    ["entitle_seller_request", { method: "GET" }],
    ["entitle_seller_request", { method: 1, path: "/products" }],
    ["entitle_seller_request", { method: "GET", path: "/products", extra: 1 }],
    [
      "entitle_seller_request",
      { method: "GET", path: "/products", body: null },
    ],
    ["entitle_seller_request", { method: "GET", path: "/products", body: [] }],
    ["unknown", {}],
    ["entitle_features", { args: [], extra: 1 }],
    ["entitle_features", { args: "invalid" }],
    ["entitle_features", { args: Array(21).fill("x") }],
    ["entitle_features", { args: [1] }],
    ["entitle_features", { args: ["x".repeat(4097)] }],
  ] as [string, Record<string, unknown>][])
    assert.equal((await call(name, args)).isError, true, name);
  assert.equal((await call("entitle_seller_request")).isError, true);
  assert.equal((await call("entitle_features")).isError, true);
  assert.equal((await call("entitle_revoke", { args: [] })).isError, true);
  for (const value of [
    Error(
      `provider echoed ${process.env.TENANT_API_KEY} ${process.env.OPERATOR_TOKEN} ${process.env.ENTITLE_COOKIE} ${process.env.ENTITLE_CSRF_TOKEN} ${process.env.ENTITLE_VERIFICATION} ${process.env.APP_SECRET}`,
    ),
    "unknown failure",
  ]) {
    failure = value;
    for (const [name, args] of [
      ["entitle_seller_request", { method: "GET", path: "/products" }],
      ["entitle_op_reports", {}],
      ["entitle_owner_session_refresh", { sessionFile: ownerSession }],
      ["entitle_buyer_session_refresh", { sessionFile: buyerSession }],
      [
        "entitle_export_download",
        {
          id: "a3a25a94-32f8-4cfb-92d8-339a8f5a39db",
          directory: join(dir, "download"),
        },
      ],
    ] as [string, Record<string, unknown>][]) {
      const result = await call(name, args);
      assert.equal(result.isError, true);
      const credentials: string[] = [
        process.env.TENANT_API_KEY!,
        process.env.OPERATOR_TOKEN!,
        process.env.ENTITLE_COOKIE!,
        process.env.ENTITLE_CSRF_TOKEN!,
        process.env.ENTITLE_VERIFICATION!,
        process.env.APP_SECRET!,
      ];
      for (const credential of credentials)
        assert.ok(
          !JSON.stringify(result).includes(credential),
          `${name} must redact configured credentials`,
        );
    }
  }
});
