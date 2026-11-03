import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runCli } from "../src/cli.ts";
import { execFileSync, spawnSync } from "node:child_process";

test("named-pipe inputs fail promptly without dispatching a request", async () => {
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/agent-fifo-");
  try {
    const fifo = join(dir, "pipe");
    execFileSync("mkfifo", [fifo]);
    const env = {
      ...process.env,
      PUBLIC_ORIGIN: "http://127.0.0.1:1",
      TENANT_SLUG: "primary",
      TENANT_API_KEY: `DE-TK-${"k".repeat(43)}`,
    };
    const metadata = join(dir, "metadata.json");
    await writeFile(metadata, '{"changelog":"test"}');
    for (const args of [
      ["buyer-login-finish", fifo, join(dir, "session")],
      ["api", "POST", "/assets/plugin/1.0.0", "--upload", fifo],
      ["api", "POST", "/products", "--body", fifo],
      [
        "api",
        "POST",
        "/assets/plugin/1.0.0",
        "--upload",
        metadata,
        "--metadata",
        fifo,
      ],
      ["product-save", fifo],
      ["product", fifo],
      ["publish", "plugin", "1.0.0", fifo, metadata],
      ["publish-asset", "plugin", "1.0.0", fifo, metadata],
    ]) {
      const result = spawnSync(process.execPath, ["src/cli.ts", ...args], {
        env,
        encoding: "utf8",
        timeout: 1500,
        killSignal: "SIGKILL",
      });
      assert.equal(
        result.status,
        1,
        `Input did not fail promptly: ${result.error?.message ?? result.stderr}`,
      );
      assert.match(result.stderr, /regular (?:input )?file/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a private output write failure reports the already-completed activation", async (t) => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/agent-output-failure-",
  );
  const originalFetch = globalThis.fetch;
  try {
    const input = join(dir, "input.json"),
      output = join(dir, "activation.json");
    await writeFile(
      input,
      JSON.stringify({
        key: "DE-fixture",
        installationId: "installation-1",
        product: "plugin",
      }),
      { mode: 0o600 },
    );
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response('{"token":"private-token"}', {
        headers: { "content-type": "application/json" },
      });
    };
    const file = await open(input, "r"),
      prototype = Object.getPrototypeOf(file);
    await file.close();
    t.mock.method(prototype, "writeFile", async () => {
      throw Object.assign(new Error("disk write failed"), { code: "ENOSPC" });
    });
    const lines: string[] = [];
    const io = {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };
    assert.equal(
      await runCli(
        ["activation-create", input, output],
        { PUBLIC_ORIGIN: "https://example.test", TENANT_SLUG: "primary" },
        io,
      ),
      1,
    );
    assert.equal(requests, 1);
    assert.match(lines.at(-1)!, /completed.*sav/i);
    await assert.rejects(readFile(output), { code: "ENOENT" });
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("session refresh never rewrites the saved owner or buyer session", async (t) => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/agent-session-failure-",
  );
  const originalFetch = globalThis.fetch;
  try {
    const session = join(dir, "session.json"),
      cookie = `de-seller-session=${"s".repeat(43)}`;
    await writeFile(
      session,
      JSON.stringify({
        origin: "https://example.test",
        cookie,
        csrfToken: "old-csrf",
      }),
      { mode: 0o600 },
    );
    globalThis.fetch = async () =>
      new Response('{"csrfToken":"new-csrf"}', {
        headers: { "content-type": "application/json" },
      });
    const file = await open(session, "r"),
      prototype = Object.getPrototypeOf(file);
    await file.close();
    const originalWrite = prototype.write;
    let writes = 0;
    t.mock.method(
      prototype,
      "write",
      function (
        this: unknown,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) {
        writes++;
        if (writes > 1)
          return Promise.reject(
            Object.assign(new Error("disk write failed"), { code: "ENOSPC" }),
          );
        return originalWrite.call(
          this,
          buffer,
          offset,
          Math.min(length, 4),
          position,
        );
      },
    );
    const lines: string[] = [];
    assert.equal(
      await runCli(
        ["owner-session-refresh", session],
        { PUBLIC_ORIGIN: "https://example.test" },
        {
          log: (line: string) => lines.push(line),
          error: (line: string) => lines.push(line),
        },
      ),
      0,
    );
    assert.equal(writes, 0);
    assert.equal(
      JSON.parse(await readFile(session, "utf8")).csrfToken,
      "old-csrf",
    );
    writes = 0;
    const buyer = join(dir, "buyer-session.json");
    await writeFile(
      buyer,
      JSON.stringify({
        origin: "https://example.test",
        tenant: "primary",
        cookie: `de-session-primary=${"b".repeat(43)}`,
        csrfToken: "old-buyer-csrf",
      }),
      { mode: 0o600 },
    );
    assert.equal(
      await runCli(
        ["buyer-session-refresh", buyer],
        { PUBLIC_ORIGIN: "https://example.test", TENANT_SLUG: "primary" },
        {
          log: (line: string) => lines.push(line),
          error: (line: string) => lines.push(line),
        },
      ),
      0,
    );
    assert.equal(writes, 0);
    assert.equal(
      JSON.parse(await readFile(buyer, "utf8")).csrfToken,
      "old-buyer-csrf",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("buyer login keeps the session cookie when the successful response body fails", async () => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/buyer-login-response-",
  );
  const originalFetch = globalThis.fetch;
  try {
    const token = join(dir, "token"),
      session = join(dir, "session");
    await writeFile(token, "buyer-login-token", { mode: 0o600 });
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      if (requests === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.error(new Error("body stream failed"));
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            "set-cookie": `de-session-primary=${"b".repeat(43)}; HttpOnly; Path=/`,
          },
        });
      }
      return new Response('{"csrfToken":"valid-csrf"}', {
        headers: { "content-type": "application/json" },
      });
    };
    const lines: string[] = [];
    assert.equal(
      await runCli(
        ["buyer-login-finish", token, session],
        { PUBLIC_ORIGIN: "https://example.test", TENANT_SLUG: "primary" },
        {
          log: (line: string) => lines.push(line),
          error: (line: string) => lines.push(line),
        },
      ),
      0,
      lines.join("\n"),
    );
    assert.equal(requests, 2);
    assert.equal(
      JSON.parse(await readFile(session, "utf8")).cookie,
      `de-session-primary=${"b".repeat(43)}`,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("session refresh does not overwrite a concurrently replaced identity", async () => {
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/agent-session-race-");
  const originalFetch = globalThis.fetch;
  try {
    const session = join(dir, "session.json"),
      first = `de-seller-session=${"a".repeat(43)}`,
      second = `de-seller-session=${"b".repeat(43)}`;
    await writeFile(
      session,
      JSON.stringify({
        origin: "https://example.test",
        cookie: first,
        csrfToken: "first",
      }),
      { mode: 0o600 },
    );
    globalThis.fetch = async () => {
      await writeFile(
        session,
        JSON.stringify({
          origin: "https://example.test",
          cookie: second,
          csrfToken: "second",
        }),
        { mode: 0o600 },
      );
      return new Response('{"csrfToken":"first-new"}', {
        headers: { "content-type": "application/json" },
      });
    };
    const lines: string[] = [];
    assert.equal(
      await runCli(
        ["owner-session-refresh", session],
        { PUBLIC_ORIGIN: "https://example.test" },
        {
          log: (line: string) => lines.push(line),
          error: (line: string) => lines.push(line),
        },
      ),
      1,
    );
    assert.match(lines.at(-1)!, /session changed/i);
    assert.equal(JSON.parse(await readFile(session, "utf8")).cookie, second);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI and MCP reach API with scoped credentials, enforce paths and transfer private binary data", async () => {
  const calls: {
    url: string;
    method: string;
    auth: string | undefined;
    cookie: string | undefined;
    csrf: string | undefined;
    proof: string | undefined;
    body: string;
  }[] = [];
  let failBlob = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      url: req.url!,
      method: req.method!,
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
      csrf: req.headers["x-csrf-token"] as string | undefined,
      proof: req.headers["x-account-verification"] as string | undefined,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.url === "/api/v1/tenants/primary/seller/drop") {
      req.socket.destroy();
      return;
    }
    if (req.url === "/api/v1/tenants/primary/seller/timeout") {
      res.writeHead(408).end();
      return;
    }
    if (req.url === "/api/v1/platform/auth/request")
      res
        .writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `de-seller-preauth=${"p".repeat(43)}; HttpOnly; Path=/`,
        })
        .end('{"ok":true}');
    else if (req.url === "/api/v1/platform/auth/consume") {
      if (
        req.headers.cookie !== `de-seller-preauth=${"p".repeat(43)}` ||
        JSON.parse(Buffer.concat(chunks).toString()).token !== "login-token"
      )
        res.writeHead(401).end();
      else
        res
          .writeHead(200, {
            "content-type": "application/json",
            "set-cookie": `de-seller-session=${"s".repeat(43)}; HttpOnly; Path=/`,
          })
          .end('{"ok":true}');
    } else if (req.url === "/api/v1/platform/me")
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ csrfToken: "private-csrf" }));
    else if (req.url === "/api/v1/platform/account/verification/consume")
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ verification: "private-proof", expiresIn: 300 }));
    else if (
      req.url === "/api/v1/tenants/primary/seller/exports" &&
      req.method === "GET"
    )
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          exports: [
            {
              id: "a3a25a94-32f8-4cfb-92d8-339a8f5a39db",
              status: "ready",
              blobs: ["e7e7fe3d-4960-458e-9442-6dd89f0c82fa"],
            },
          ],
        }),
      );
    else if (failBlob && req.url?.includes("/blobs/")) res.writeHead(503).end();
    else if (req.url?.endsWith("/manifest") || req.url?.includes("/blobs/"))
      res
        .writeHead(200, { "content-type": "application/octet-stream" })
        .end(Buffer.from([0, 1, 255]));
    else if (req.url?.endsWith("/denied"))
      res
        .writeHead(403, { "content-type": "application/json" })
        .end('{"error":"denied"}');
    else
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/agent-interfaces-");
  const env = {
    ...process.env,
    PUBLIC_ORIGIN: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"k".repeat(43)}`,
  };
  const lines: string[] = [];
  const io = {
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
  const client = new Client({ name: "entitle-test", version: "1" });
  try {
    const output = join(dir, "manifest.entitle");
    assert.equal(
      await runCli(
        ["api", "GET", "/exports/abc/manifest", "--output", output],
        env,
        io,
      ),
      0,
    );
    assert.deepEqual(await readFile(output), Buffer.from([0, 1, 255]));
    assert.equal(
      await runCli(
        ["api", "GET", "/exports/abc/manifest", "--output", output],
        env,
        io,
      ),
      1,
    );
    const body = join(dir, "body.json");
    await writeFile(
      body,
      JSON.stringify({ passphrase: "a-private-passphrase" }),
      { mode: 0o600 },
    );
    assert.equal(
      await runCli(["api", "POST", "/exports", "--body", body], env, io),
      0,
    );
    const exportDir = join(dir, "export");
    assert.equal(
      await runCli(
        ["export-download", "a3a25a94-32f8-4cfb-92d8-339a8f5a39db", exportDir],
        env,
        io,
      ),
      0,
      lines.join("\n"),
    );
    assert.deepEqual(
      await readFile(
        join(exportDir, "e7e7fe3d-4960-458e-9442-6dd89f0c82fa.blob"),
      ),
      Buffer.from([0, 1, 255]),
    );
    failBlob = true;
    const partial = join(dir, "partial");
    assert.equal(
      await runCli(
        ["export-download", "a3a25a94-32f8-4cfb-92d8-339a8f5a39db", partial],
        env,
        io,
      ),
      1,
    );
    assert.deepEqual(
      await readFile(join(partial, "manifest.entitle")),
      Buffer.from([0, 1, 255]),
    );
    assert.match(lines.at(-1)!, /incomplete/);
    failBlob = false;
    const preauth = join(dir, "preauth"),
      token = join(dir, "token"),
      session = join(dir, "session");
    assert.equal(
      await runCli(
        ["owner-login-start", "owner@example.test", preauth],
        env,
        io,
      ),
      0,
      lines.join("\n"),
    );
    await writeFile(token, "login-token", { mode: 0o600 });
    await chmod(token, 0o644);
    const beforeBadToken = calls.length;
    assert.equal(
      await runCli(["owner-login-finish", preauth, token, session], env, io),
      1,
    );
    assert.equal(calls.length, beforeBadToken);
    await chmod(token, 0o600);
    assert.equal(
      await runCli(["owner-login-finish", preauth, token, session], env, io),
      0,
      lines.join("\n"),
    );
    const ownerEnv = { ...env, ENTITLE_SESSION_FILE: session };
    assert.equal(await runCli(["owner-me"], ownerEnv, io), 0, lines.join("\n"));
    assert.doesNotMatch(lines.at(-1)!, /private-csrf/);
    const verify = join(dir, "verify.json"),
      proof = join(dir, "proof.json");
    await writeFile(
      verify,
      JSON.stringify({ purpose: "api_keys", token: "verification-token" }),
      { mode: 0o600 },
    );
    assert.equal(
      await runCli(["owner-verification-consume", verify, proof], ownerEnv, io),
      0,
      lines.join("\n"),
    );
    const beforeExistingProof = calls.length;
    assert.equal(
      await runCli(["owner-verification-consume", verify, proof], ownerEnv, io),
      1,
    );
    assert.equal(calls.length, beforeExistingProof);
    assert.equal(
      JSON.parse(await readFile(proof, "utf8")).verification,
      "private-proof",
    );
    const keyInput = join(dir, "key.json");
    await writeFile(keyInput, JSON.stringify({ name: "agent" }));
    assert.equal(
      await runCli(
        ["owner-key-create", keyInput],
        { ...ownerEnv, ENTITLE_VERIFICATION_FILE: proof },
        io,
      ),
      0,
      lines.join("\n"),
    );
    assert.equal(calls.at(-1)?.cookie, `de-seller-session=${"s".repeat(43)}`);
    assert.equal(calls.at(-1)?.csrf, "private-csrf");
    assert.equal(calls.at(-1)?.proof, "private-proof");
    const upload = join(dir, "asset.bin");
    await writeFile(upload, "asset bytes");
    assert.equal(
      await runCli(
        ["api", "POST", "/assets/test/1.0.0", "--upload", upload],
        env,
        io,
      ),
      0,
    );
    assert.equal(calls.at(-1)?.body, "asset bytes");
    const headers = join(dir, "headers.json");
    assert.equal(
      await runCli(
        ["request", "HEAD", "/api/v1/health", "--headers-output", headers],
        env,
        io,
      ),
      0,
    );
    assert.equal(JSON.parse(await readFile(headers, "utf8")).status, 200);
    const before = calls.length;
    for (const path of [
      "//other.example/path",
      "/../operator",
      "/%2e%2e/operator",
      "/%252e%252e/operator",
      "/x%2fy",
    ])
      assert.equal(await runCli(["api", "GET", path], env, io), 1);
    assert.equal(calls.length, before);
    assert.equal(await runCli(["api", "GET", "/denied"], env, io), 1);
    assert.match(lines.at(-1)!, /403/);
    assert.equal(await runCli(["api", "POST", "/drop"], env, io), 1);
    assert.match(lines.at(-1)!, /may have been applied/);
    assert.equal(await runCli(["api", "POST", "/timeout"], env, io), 1);
    assert.match(lines.at(-1)!, /may have been applied/);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [process.env.ENTITLE_MCP_ENTRY ?? "src/mcp.ts"],
      env: {
        ...env,
        ENTITLE_SESSION_FILE: session,
        ENTITLE_VERIFICATION_FILE: proof,
      } as Record<string, string>,
      stderr: "pipe",
    });
    await client.connect(transport);
    const tools = await client.listTools();
    const mcpPreauth = join(dir, "mcp-preauth"),
      mcpSession = join(dir, "mcp-session");
    const loginStart = await client.callTool({
      name: "entitle_owner_login_start",
      arguments: { email: "owner@example.test", preauthFile: mcpPreauth },
    });
    assert.equal(loginStart.isError, undefined);
    const loginFinish = await client.callTool({
      name: "entitle_owner_login_finish",
      arguments: {
        preauthFile: mcpPreauth,
        tokenFile: token,
        sessionFile: mcpSession,
      },
    });
    assert.equal(loginFinish.isError, undefined);
    const ownerKey = await client.callTool({
      name: "entitle_op_owner_key_create",
      arguments: { name: "agent", scopes: ["read"] },
    });
    assert.equal(ownerKey.isError, undefined);
    assert.equal(calls.at(-1)?.proof, "private-proof");
    const mcpExport = join(dir, "mcp-export");
    const downloaded = await client.callTool({
      name: "entitle_export_download",
      arguments: {
        id: "a3a25a94-32f8-4cfb-92d8-339a8f5a39db",
        directory: mcpExport,
      },
    });
    assert.equal(downloaded.isError, undefined);
    assert.deepEqual(
      await readFile(join(mcpExport, "manifest.entitle")),
      Buffer.from([0, 1, 255]),
    );
    assert.ok(
      tools.tools.some((tool) => tool.name === "entitle_seller_request"),
    );
    const retryTool = tools.tools.find(
      (tool) => tool.name === "entitle_op_job_retry",
    );
    assert.ok(retryTool && retryTool.inputSchema.properties?.table);
    const retried = await client.callTool({
      name: "entitle_op_job_retry",
      arguments: { table: "emails", id: "job-1" },
    });
    assert.equal(retried.isError, undefined);
    assert.equal(
      calls.at(-1)?.url,
      "/api/v1/tenants/primary/seller/jobs/emails/job-1/retry",
    );
    const invalidRetry = await client.callTool({
      name: "entitle_op_job_retry",
      arguments: { table: "platform_work", id: "job-1" },
    });
    assert.equal(invalidRetry.isError, true);
    const result = await client.callTool({
      name: "entitle_seller_request",
      arguments: {
        method: "POST",
        path: "/licenses/complimentary",
        body: { email: "a@example.test", confirm: true },
      },
    });
    assert.equal(result.isError, undefined);
    const call = calls.at(-1)!;
    assert.equal(
      call.url,
      "/api/v1/tenants/primary/seller/licenses/complimentary",
    );
    assert.equal(call.method, "POST");
    assert.equal(call.auth, `Bearer ${env.TENANT_API_KEY}`);
    assert.deepEqual(JSON.parse(call.body), {
      email: "a@example.test",
      confirm: true,
    });
    const denied = await client.callTool({
      name: "entitle_seller_request",
      arguments: {
        method: "POST",
        path: "/%65xports",
        body: { passphrase: "a-private-passphrase" },
      },
    });
    assert.equal(denied.isError, true);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("buyer MCP login and key replacement keep credentials in private, tenant-bound files", async () => {
  const calls: {
    url: string;
    cookie: string | undefined;
    csrf: string | undefined;
  }[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      /* consume request */
    }
    calls.push({
      url: req.url!,
      cookie: req.headers.cookie,
      csrf: req.headers["x-csrf-token"] as string | undefined,
    });
    if (req.url === "/api/v1/tenants/primary/auth/consume")
      res
        .writeHead(200, {
          "content-type": "application/json",
          "set-cookie": `de-session-primary=${"b".repeat(43)}; HttpOnly; Path=/`,
        })
        .end('{"ok":true}');
    else if (req.url === "/api/v1/tenants/primary/me")
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(
          '{"csrfToken":"buyer-private-csrf","customer":{"email":"buyer@example.test"}}',
        );
    else if (req.url === "/api/v1/tenants/primary/licenses/license-1/key")
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"key":"DE-buyer-secret"}');
    else
      res
        .writeHead(200, { "content-type": "application/json" })
        .end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/buyer-mcp-");
  const token = join(dir, "token"),
    session = join(dir, "session"),
    output = join(dir, "new-key.json");
  await writeFile(token, "buyer-login-token", { mode: 0o600 });
  const client = new Client({ name: "buyer-mcp-test", version: "1" });
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [process.env.ENTITLE_MCP_ENTRY ?? "src/mcp.ts"],
        env: {
          PATH: process.env.PATH ?? "",
          PUBLIC_ORIGIN: origin,
          TENANT_SLUG: "primary",
          ENTITLE_BUYER_SESSION_FILE: session,
        },
        stderr: "pipe",
      }),
    );
    assert.equal(
      (
        await client.callTool({
          name: "entitle_buyer_login_start",
          arguments: { email: "buyer@example.test" },
        })
      ).isError,
      undefined,
    );
    assert.equal(
      (
        await client.callTool({
          name: "entitle_buyer_login_finish",
          arguments: { tokenFile: token, sessionFile: session },
        })
      ).isError,
      undefined,
    );
    const me = await client.callTool({
      name: "entitle_op_buyer_me",
      arguments: {},
    });
    assert.equal(me.isError, undefined);
    assert.doesNotMatch(JSON.stringify(me), /buyer-private-csrf/);
    const replaced = await client.callTool({
      name: "entitle_op_buyer_key_replace",
      arguments: { id: "license-1", output },
    });
    assert.equal(replaced.isError, undefined);
    assert.doesNotMatch(JSON.stringify(replaced), /DE-buyer-secret/);
    assert.equal(
      JSON.parse(await readFile(output, "utf8")).key,
      "DE-buyer-secret",
    );
    assert.equal(calls.at(-1)?.cookie, `de-session-primary=${"b".repeat(43)}`);
    assert.equal(calls.at(-1)?.csrf, "buyer-private-csrf");
    const before = calls.filter((call) =>
      call.url.endsWith("/licenses/license-1/key"),
    ).length;
    assert.equal(
      (
        await client.callTool({
          name: "entitle_op_buyer_key_replace",
          arguments: { id: "license-1", output },
        })
      ).isError,
      true,
    );
    assert.equal(
      calls.filter((call) => call.url.endsWith("/licenses/license-1/key"))
        .length,
      before,
    );
    const beforeOwner = calls.length;
    assert.equal(
      (
        await client.callTool({
          name: "entitle_op_owner_sessions",
          arguments: {},
        })
      ).isError,
      true,
    );
    assert.equal(calls.length, beforeOwner);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
