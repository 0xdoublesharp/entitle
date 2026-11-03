import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runCli } from "../src/cli.ts";
import { runAgentOperation } from "../src/agent-operations.ts";

test("structured product and seller-session operations use existing API routes", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init!.method!,
      body: init!.body ? JSON.parse(String(init!.body)) : undefined,
    });
    return new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const env = {
      PUBLIC_ORIGIN: "https://example.test",
      TENANT_SLUG: "primary",
      TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
      ENTITLE_COOKIE: "de-seller-session=fixture",
      ENTITLE_CSRF_TOKEN: "fixture",
    };
    const io = { log: () => {}, error: () => {} };
    await runAgentOperation(
      "product-save",
      { slug: "plugin", name: "Plugin", plans: [] },
      env,
      io,
    );
    assert.equal(
      calls[0]?.url,
      "https://example.test/api/v1/tenants/primary/seller/products",
    );
    assert.deepEqual(calls[0]?.body, {
      slug: "plugin",
      name: "Plugin",
      plans: [],
    });
    await runAgentOperation("owner-sessions", {}, env, io);
    assert.equal(
      calls[1]?.url,
      "https://example.test/api/v1/platform/account/sessions",
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("native update tools route all supported formats and preserve XML, YAML and no-update results", async () => {
  const original = globalThis.fetch,
    calls: string[] = [],
    lines: string[] = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("currentVersion=9.0.0"))
      return new Response(null, { status: 204 });
    if (u.includes("/generic/"))
      return new Response('{"version":"2.0.0"}', {
        headers: { "content-type": "application/json" },
      });
    if (u.includes("/electron/"))
      return new Response("version: 2.0.0\n", {
        headers: { "content-type": "text/yaml" },
      });
    return new Response("<feed>fixture</feed>", {
      headers: { "content-type": "application/xml" },
    });
  };
  const env = {
    PUBLIC_ORIGIN: "https://example.test",
    TENANT_SLUG: "primary",
    ENTITLE_AUTHORIZATION: "Bearer installation-token",
  };
  const io = {
    log: (line: string) => lines.push(line),
    error: (line: string) => lines.push(line),
  };
  try {
    const cases: [string, object, string][] = [
      ["update-joomla", { product: "plugin" }, "/updates/joomla/plugin.xml"],
      [
        "update-electron",
        {
          product: "plugin",
          target: "linux-x64",
          filename: "latest-linux.yml",
        },
        "/updates/electron/plugin/linux-x64/latest-linux.yml",
      ],
      [
        "update-tauri",
        { product: "plugin", target: "linux-x86_64", currentVersion: "1.0.0" },
        "/updates/tauri/plugin/linux-x86_64/1.0.0",
      ],
      [
        "update-sparkle",
        { product: "plugin", target: "darwin-x64" },
        "/updates/sparkle/plugin/darwin-x64/appcast.xml",
      ],
      [
        "update-jetbrains",
        { product: "plugin", build: "242.1", os: "linux" },
        "/updates/jetbrains/plugin/updatePlugins.xml?build=242.1&os=linux",
      ],
      [
        "update-generic",
        { product: "plugin", target: "linux-x64" },
        "/updates/generic/plugin/linux-x64",
      ],
    ];
    for (const [name, input, path] of cases) {
      await runAgentOperation(name, input, env, io);
      assert.equal(
        new URL(calls.at(-1)!).pathname + new URL(calls.at(-1)!).search,
        `/api/v1/tenants/primary${path}`,
      );
    }
    assert.equal(JSON.parse(lines[0]!).text, "<feed>fixture</feed>");
    assert.equal(JSON.parse(lines[1]!).text, "version: 2.0.0\n");
    assert.equal(JSON.parse(lines.at(-1)!).version, "2.0.0");
    await runAgentOperation(
      "update-generic",
      { product: "plugin", target: "linux-x64", currentVersion: "9.0.0" },
      env,
      io,
    );
    assert.equal(JSON.parse(lines.at(-1)!).status, 204);
  } finally {
    globalThis.fetch = original;
  }
});

test("typed operations constrain inputs and preserve seller and operator authorization", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; auth: string; body: unknown }[] =
    [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init!.method!,
      auth: (init!.headers as Record<string, string>).authorization!,
      body: init!.body ? JSON.parse(String(init!.body)) : undefined,
    });
    return new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    PUBLIC_ORIGIN: "https://example.test",
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
    OPERATOR_TOKEN: "operator-secret-".repeat(3),
  };
  const io = { log: () => {}, error: () => {} };
  try {
    await runAgentOperation(
      "license-complimentary",
      {
        email: "pilot@example.test",
        productId: "product",
        siteAllowance: 2,
        expiresAt: 1900000000000,
        requestId: "a3a25a94-32f8-4cfb-92d8-339a8f5a39db",
        confirm: true,
      },
      env,
      io,
    );
    assert.equal(
      calls.at(-1)?.url,
      "https://example.test/api/v1/tenants/primary/seller/licenses/complimentary",
    );
    assert.equal(
      (calls.at(-1)?.body as { requestId: string }).requestId,
      "a3a25a94-32f8-4cfb-92d8-339a8f5a39db",
    );
    await runAgentOperation(
      "platform-job-retry",
      { table: "platform_work", id: "job-1" },
      env,
      io,
    );
    assert.equal(calls.at(-1)?.auth, `Bearer ${env.OPERATOR_TOKEN}`);
    assert.equal(
      calls.at(-1)?.url,
      "https://example.test/api/v1/operator/jobs/platform_work/job-1/retry",
    );
    await runAgentOperation(
      "webhook-create",
      { url: "https://hooks.example.test", events: ["release.withdrawn"] },
      env,
      io,
    );
    assert.equal(calls.at(-1)?.auth, `Bearer ${env.TENANT_API_KEY}`);
    await runAgentOperation("reports", { days: 30 }, env, io);
    assert.match(calls.at(-1)!.url, /reports\?days=30$/);
    const before = calls.length;
    await assert.rejects(
      runAgentOperation(
        "license-complimentary",
        {
          email: "x@example.test",
          productId: "p",
          siteAllowance: 1,
          expiresAt: 1,
          requestId: "invalid",
          confirm: true,
        },
        env,
        io,
      ),
    );
    await assert.rejects(
      runAgentOperation(
        "jobs-retry-failed",
        { table: "work", limit: 501 },
        env,
        io,
      ),
    );
    await assert.rejects(
      runAgentOperation(
        "webhook-create",
        { url: "https://hooks.example.test", events: ["unknown"] },
        env,
        io,
      ),
    );
    assert.equal(calls.length, before);
  } finally {
    globalThis.fetch = original;
  }
});

test("named job retry routes validated arguments to the tenant API", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      method: init!.method!,
      body: JSON.parse(String(init!.body)),
    });
    return new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const env = {
      PUBLIC_ORIGIN: "https://example.test",
      TENANT_SLUG: "primary",
      TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
    };
    const out: string[] = [];
    const io = {
      log: (v: string) => out.push(v),
      error: (v: string) => out.push(v),
    };
    assert.equal(
      await runCli(["job-retry", "work", "job-1"], env, io),
      0,
      out.join("\n"),
    );
    assert.equal(
      calls[0]?.url,
      "https://example.test/api/v1/tenants/primary/seller/jobs/work/job-1/retry",
    );
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, {});
    assert.equal(
      await runCli(["job-retry", "not-a-queue", "job-1"], env, io),
      1,
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI exposes seller API operations with the configured workspace key", async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push(
      `${init?.method} ${new URL(String(input)).pathname} ${(init?.headers as Record<string, string>).authorization}`,
    );
    return new Response('{"ok":true}', {
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const env = {
      PUBLIC_ORIGIN: "https://entitle.example",
      TENANT_SLUG: "primary",
      TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
    };
    const output: string[] = [];
    const io = {
      log: (v: string) => output.push(v),
      error: (v: string) => output.push(v),
    };
    assert.equal(await runCli(["features"], env, io), 0, output.join("\n"));
    assert.equal(
      await runCli(["api", "GET", "/operations"], env, io),
      0,
      output.join("\n"),
    );
    assert.deepEqual(calls, [
      "GET /api/v1/tenants/primary/seller/features Bearer " +
        env.TENANT_API_KEY,
      "GET /api/v1/tenants/primary/seller/operations Bearer " +
        env.TENANT_API_KEY,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MCP stdio entrypoint initializes and advertises agent tools", async () => {
  const child = spawn(process.execPath, ["src/mcp.ts"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    output += chunk;
    lines.push(...output.split("\n").slice(0, -1));
    output = output.slice(output.lastIndexOf("\n") + 1);
  });
  child.stdin.end(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    }) +
      "\n" +
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n" +
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }) +
      "\n",
  );
  const code = await new Promise<number | null>((resolve) =>
    child.on("close", resolve),
  );
  assert.equal(code, 0);
  const responses = lines.map((line) => JSON.parse(line));
  assert.ok(responses.find((item) => item.id === 1)?.result?.protocolVersion);
  assert.ok(responses.find((item) => item.id === 2)?.result?.tools?.length);
});
