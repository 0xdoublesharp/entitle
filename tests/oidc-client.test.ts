import { csrf, hash } from "../src/crypto.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  writeFile,
  chmod,
  readFile,
  stat,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { oidcPublishingToken } from "../src/oidc-client.ts";
import { oidcFixture } from "./helpers/oidc.ts";
import { passkeyFixture, provisionTestPair, publisherInput } from "./helpers/oidc.ts";
import { zipBytes } from "./helpers/zip.ts";
import { runCli } from "../src/cli.ts";

test("CLI and MCP publish using exchanged identities through the real HTTP API", async () => {
  const cliEntry = process.env.ENTITLE_TEST_SERVER_DIR
    ? `${process.env.ENTITLE_TEST_SERVER_DIR}/src/cli.js`
    : "src/cli.ts";
  const mcpEntry = process.env.ENTITLE_TEST_SERVER_DIR
    ? `${process.env.ENTITLE_TEST_SERVER_DIR}/src/mcp.js`
    : "src/mcp.ts";
  const f = await oidcFixture();
  let client: Client | undefined;
  try {
    const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
    f.config.origin = address;
    const id = await f.seedPublisher();
    const metadata = `${f.root}/metadata.json`,
      zip = `${f.root}/plugin.zip`;
    await writeFile(metadata, '{"changelog":"Published from CI"}');
    await writeFile(
      zip,
      zipBytes([
        {
          name: "plugin/plugin.php",
          data: "<?php\n/* Plugin Name: Plugin\nVersion: 1.0.0\n*/",
        },
      ]),
    );
    const env = {
      PUBLIC_ORIGIN: address,
      TENANT_SLUG: "primary",
      ENTITLE_OIDC_PUBLISHER_ID: id,
      ENTITLE_OIDC_TOKEN: await f.token(),
    };
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [cliEntry, "publish", "plugin", "1.0.0", zip, metadata],
      { env: { ...process.env, ...env }, timeout: 10000 },
    );
    assert.equal(stderr, "");
    assert.equal(JSON.parse(stdout).version, "1.0.0");
    assert.ok(
      !stdout.includes(env.ENTITLE_OIDC_TOKEN) && !stdout.includes("DE-CI-"),
    );
    await writeFile(
      zip,
      zipBytes([
        {
          name: "plugin/plugin.php",
          data: "<?php\n/* Plugin Name: Plugin\nVersion: 1.0.1\n*/",
        },
      ]),
    );
    client = new Client({ name: "oidc-test", version: "1" });
    const childEnv = {
      ...process.env,
      ...env,
      ENTITLE_OIDC_TOKEN: await f.token(),
    } as Record<string, string>;
    delete childEnv.TENANT_API_KEY;
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [mcpEntry],
        env: childEnv,
        stderr: "pipe",
      }),
    );
    const result = await client.callTool({
      name: "entitle_op_release_publish",
      arguments: {
        product: "plugin",
        version: "1.0.1",
        file: zip,
        metadata: { changelog: "Via MCP" },
      },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    assert.ok(
      !JSON.stringify(result).includes(childEnv.ENTITLE_OIDC_TOKEN!) &&
        !JSON.stringify(result).includes("DE-CI-"),
    );
    assert.equal((await f.db("releases")).length, 2);
    const denied = await client.callTool({
      name: "entitle_op_product_save",
      arguments: { slug: "oops", name: "Oops", plans: [] },
    });
    assert.equal(denied.isError, true);
    const tools = await client.listTools();
    for (const name of [
      "entitle_op_owner_publishers",
      "entitle_op_owner_publisher_create",
      "entitle_op_owner_publisher_revoke",
      "entitle_op_owner_reauth_options",
      "entitle_owner_reauth_verify",
    ])
      assert.ok(
        tools.tools.some((tool) => tool.name === name),
        name,
      );
  } finally {
    await client?.close();
    await f.close();
  }
});

const baseEnv = {
  PUBLIC_ORIGIN: "https://entitle.test",
  TENANT_SLUG: "primary",
  ENTITLE_OIDC_PUBLISHER_ID: "00000000-0000-4000-8000-000000000000",
};

test("CLI passkey sign-in and strong approval use private files and the real account API", async () => {
  const f = await oidcFixture();
  try {
    const address = await f.app.listen({ port: 0, host: "127.0.0.1" });
    f.config.origin = address;
    const key = passkeyFixture(address);
    await key.seed(f.db, f.userId, f.config.secret);
    await provisionTestPair(f, key);
    const env = { PUBLIC_ORIGIN: address },
      lines: string[] = [];
    const io = {
      log: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };
    const preauth = `${f.root}/preauth.json`,
      assertion = `${f.root}/assertion.json`,
      session = `${f.root}/session.json`;
    assert.equal(
      await runCli(["owner-passkey-login-start", preauth], env, io),
      0,
      lines.join("\n"),
    );
    const saved = JSON.parse(await readFile(preauth, "utf8"));
    await writeFile(
      assertion,
      JSON.stringify(key.authentication(saved.options.challenge, 1)),
      { mode: 0o600 },
    );
    assert.equal(
      await runCli(
        ["owner-passkey-login-finish", preauth, assertion, session],
        env,
        io,
      ),
      0,
      lines.join("\n"),
    );
    assert.equal((await stat(session)).mode & 0o077, 0);
    const logged = JSON.parse(await readFile(session, "utf8"));
    assert.ok(
      !lines.join("\n").includes(saved.cookie) &&
        !lines.join("\n").includes(logged.cookie),
    );
    const intent = { action: "security.email_login", enabled: false };
    const intentFile = `${f.root}/intent.json`;
    await writeFile(intentFile, JSON.stringify(intent));
    assert.equal(
      await runCli(
        ["owner-reauth-options", intentFile],
        { ...env, ENTITLE_SESSION_FILE: session },
        io,
      ),
      0,
      lines.join("\n"),
    );
    const opts = JSON.parse(lines.at(-1)!);
    const input = `${f.root}/approval-input.json`,
      output = `${f.root}/approval.json`;
    await writeFile(
      input,
      JSON.stringify({
        challengeId: opts.challengeId,
        response: key.authentication(opts.options.challenge, 2),
      }),
      { mode: 0o600 },
    );
    assert.equal(
      await runCli(
        ["owner-reauth-verify", input, output],
        { ...env, ENTITLE_SESSION_FILE: session },
        io,
      ),
      0,
      lines.join("\n"),
    );
    const proof = JSON.parse(await readFile(output, "utf8"));
    assert.ok(
      proof.verification && !lines.join("\n").includes(proof.verification),
    );
    const change = `${f.root}/email-setting.json`;
    await writeFile(change, '{"enabled":false}');
    assert.equal(
      await runCli(
        ["owner-email-login", change],
        {
          ...env,
          ENTITLE_SESSION_FILE: session,
          ENTITLE_VERIFICATION_FILE: output,
        },
        io,
      ),
      0,
      lines.join("\n"),
    );
    assert.equal(
      (await f.db("seller_users").where({ id: f.userId }).first())
        .email_login_disabled,
      1,
    );
    const ownerEnv = {
      ...env,
      TENANT_SLUG: "primary",
      ENTITLE_SESSION_FILE: session,
    };
    for (const command of ["owner-security", "owner-publishers"])
      assert.equal(await runCli([command], ownerEnv, io), 0, lines.join("\n"));
    let nextCounter = 2;
    const approve = async (intent: object, name: string) => {
      const intentPath = `${f.root}/${name}-intent.json`;
      await writeFile(intentPath, JSON.stringify(intent));
      assert.equal(
        await runCli(["owner-reauth-options", intentPath], ownerEnv, io),
        0,
      );
      const options = JSON.parse(lines.at(-1)!);
      const body = `${f.root}/${name}-body.json`,
        result = `${f.root}/${name}-proof.json`;
      await writeFile(
        body,
        JSON.stringify({
          challengeId: options.challengeId,
          response: key.authentication(
            options.options.challenge,
            ++nextCounter,
          ),
        }),
        { mode: 0o600 },
      );
      assert.equal(
        await runCli(["owner-reauth-verify", body, result], ownerEnv, io),
        0,
        lines.join("\n"),
      );
      return { ...ownerEnv, ENTITLE_VERIFICATION_FILE: result };
    };
    const publisherFile = `${f.root}/publisher.json`;
    await writeFile(publisherFile, JSON.stringify(publisherInput));
    assert.equal(
      await runCli(
        ["owner-publisher-create", publisherFile],
        await approve(
          {
            action: "oidc.create",
            tenant: "primary",
            publisher: publisherInput,
          },
          "publisher-create",
        ),
        io,
      ),
      0,
      lines.join("\n"),
    );
    const publisherId = (await f.db("oidc_publishers").first()).id;
    const revokeFile = `${f.root}/publisher-revoke.json`;
    await writeFile(revokeFile, JSON.stringify({ id: publisherId }));
    assert.equal(
      await runCli(
        ["owner-publisher-revoke", revokeFile],
        await approve(
          { action: "oidc.revoke", tenant: "primary", publisherId },
          "publisher-revoke",
        ),
        io,
      ),
      0,
      lines.join("\n"),
    );
    const factorId = (await f.db("seller_factors").where({ credential_hash: hash(key.id) }).first()).id;
    // The key being removed cannot approve its own hardware revocation.
    const ownerSession = JSON.parse(await readFile(session, "utf8"));
    const requestHeaders = { origin: address, cookie: ownerSession.cookie, "x-csrf-token": csrf(ownerSession.cookie.split("=")[1]!, f.config.secret) };
    const blocked = await f.app.inject({ method: "POST", url: "/api/v1/platform/account/reauth/options", headers: requestHeaders, payload: { action: "security.remove", factorId } });
    const denied = await f.app.inject({ method: "POST", url: "/api/v1/platform/account/reauth/verify", headers: requestHeaders, payload: { challengeId: blocked.json().challengeId, response: key.authentication(blocked.json().options.challenge, 20) } });
    assert.equal(denied.statusCode, 403);
    assert.equal(await runCli(["owner-passkey-login-start"], env, io), 1);
    assert.equal(await runCli(["owner-passkey-login-finish"], env, io), 1);
    saved.origin = "https://other.test";
    await writeFile(preauth, JSON.stringify(saved), { mode: 0o600 });
    assert.equal(
      await runCli(
        [
          "owner-passkey-login-finish",
          preauth,
          assertion,
          `${f.root}/wrong.json`,
        ],
        env,
        io,
      ),
      1,
    );
  } finally {
    await f.close();
  }
});
test("CLI passkey login handles denied or malformed browser binding and preserves a completed login after a failed refresh", async (t) => {
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/passkey-cli-errors-");
  const lines: string[] = [],
    io = {
      log: (value: string) => lines.push(value),
      error: (value: string) => lines.push(value),
    };
  try {
    let response = new Response("denied", { status: 403 });
    t.mock.method(globalThis, "fetch", async () => response);
    assert.equal(
      await runCli(
        ["owner-passkey-login-start", `${dir}/denied.json`],
        baseEnv,
        io,
      ),
      1,
    );
    response = Response.json({ options: {} });
    assert.equal(
      await runCli(
        ["owner-passkey-login-start", `${dir}/missing.json`],
        baseEnv,
        io,
      ),
      1,
    );
    const preauth = `${dir}/preauth.json`,
      assertion = `${dir}/assertion.json`,
      session = `${dir}/session.json`;
    await writeFile(
      preauth,
      JSON.stringify({
        origin: baseEnv.PUBLIC_ORIGIN,
        cookie: `de-passkey-login=${"a".repeat(43)}`,
        options: {},
      }),
      { mode: 0o600 },
    );
    await writeFile(assertion, '{"id":"assertion"}', { mode: 0o600 });
    t.mock.method(globalThis, "fetch", async (url: string) =>
      String(url).endsWith("/verify")
        ? new Response(null, {
            headers: {
              "set-cookie": `de-seller-session=${"b".repeat(43)}; Path=/`,
            },
          })
        : new Response("unavailable", { status: 503 }),
    );
    assert.equal(
      await runCli(
        ["owner-passkey-login-finish", preauth, assertion, session],
        baseEnv,
        io,
      ),
      1,
    );
    assert.match(lines.at(-1)!, /sign-in succeeded.*session is saved/);
    assert.ok((await stat(session)).isFile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("GitHub client requests the exact audience, never follows redirects, and keeps credentials private", async (t) => {
  const seen: { url: string; init: RequestInit }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL, init: RequestInit) => {
      seen.push({ url: String(url), init });
      if (String(url).includes("actions.githubusercontent.com"))
        return Response.json({ value: "eyJhbGciOiJSUzI1NiJ9.e30.c2ln" });
      return Response.json({
        accessToken: `DE-CI-${"a".repeat(43)}`,
        tokenType: "Bearer",
        expiresAt: Date.now() + 60000,
      });
    },
  );
  const token = await oidcPublishingToken({
    ...baseEnv,
    GITHUB_ACTIONS: "true",
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://pipelines.actions.githubusercontent.com/token?existing=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-secret",
  });
  assert.equal(token, `DE-CI-${"a".repeat(43)}`);
  assert.equal(
    new URL(seen[0]!.url).searchParams.get("audience"),
    "https://entitle.test/api/v1/tenants/primary/oidc",
  );
  assert.equal(
    (seen[0]!.init.headers as Record<string, string>).authorization,
    "Bearer runner-secret",
  );
  assert.equal(seen[0]!.init.redirect, "error");
  assert.equal(seen[1]!.init.redirect, "error");
  const lines: string[] = [];
  const invalid = await runCli(["owner-reauth-verify"], baseEnv, {
    log: (s) => lines.push(s),
    error: (s) => lines.push(s),
  });
  assert.equal(invalid, 1);
  assert.match(lines.join(""), /Usage/);
});

test("OIDC client rejects insecure origins, ambiguous credentials, malformed tokens and untrusted runner endpoints", async () => {
  for (const extra of [
    { TENANT_API_KEY: "key" },
    { PUBLIC_ORIGIN: "http://remote.test" },
    { PUBLIC_ORIGIN: "https://entitle.test/path" },
    { TENANT_SLUG: "../bad" },
    { ENTITLE_OIDC_PUBLISHER_ID: "bad" },
    { ENTITLE_OIDC_TOKEN: "a.b.c", ENTITLE_OIDC_TOKEN_FILE: "unused" },
    {},
    { ENTITLE_OIDC_TOKEN: "not-a-jwt" },
    {
      GITHUB_ACTIONS: "true",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://attacker.test/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "private",
    },
  ])
    await assert.rejects(oidcPublishingToken({ ...baseEnv, ...extra }));
});

test("OIDC client reads private ID token files and bounds remote responses and credentials", async (t) => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/oidc-client-");
  const file = `${root}/token`;
  try {
    await writeFile(file, "a.b.c\n", { mode: 0o600 });
    const env = { ...baseEnv, ENTITLE_OIDC_TOKEN_FILE: file };
    t.mock.method(globalThis, "fetch", async () =>
      Response.json({
        accessToken: `DE-CI-${"b".repeat(43)}`,
        tokenType: "Bearer",
        expiresAt: Date.now() + 60000,
      }),
    );
    assert.equal(await oidcPublishingToken(env), `DE-CI-${"b".repeat(43)}`);
    await chmod(file, 0o644);
    await assert.rejects(oidcPublishingToken(env), /owner-only/);
    await chmod(file, 0o600);
    for (const result of [
      new Response("bad", { status: 403 }),
      new Response("x".repeat(32769)),
      Response.json({ accessToken: "bad" }),
      Response.json({
        accessToken: `DE-CI-${"b".repeat(43)}`,
        tokenType: "Bearer",
        expiresAt: Date.now() - 1,
      }),
      Response.json({
        accessToken: `DE-CI-${"b".repeat(43)}`,
        tokenType: "Bearer",
        expiresAt: Date.now() + 700000,
      }),
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(Error("connection lost"));
          },
        }),
      ),
    ]) {
      t.mock.method(globalThis, "fetch", async () => result);
      await assert.rejects(oidcPublishingToken(env));
    }
    t.mock.method(globalThis, "fetch", async () => Response.json({}));
    await assert.rejects(
      oidcPublishingToken({
        ...baseEnv,
        GITHUB_ACTIONS: "true",
        ACTIONS_ID_TOKEN_REQUEST_URL:
          "https://pipelines.actions.githubusercontent.com/token",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
      }),
      /signed OIDC/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
