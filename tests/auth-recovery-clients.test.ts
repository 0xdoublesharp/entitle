import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { oidcFixture } from "./helpers/oidc.ts";
import { AuthProvisioner } from "../src/auth-recovery.ts";
import { runCli } from "../src/cli.ts";

test("AUTH-07: CLI and MCP resume a restricted recovery session, deny privileged data and cancel through shared API", async () => {
  const f = await oidcFixture();
  let client: Client | undefined;
  try {
    const origin = await f.app.listen({ port: 0, host: "127.0.0.1" });
    f.config.origin = origin;
    const flow = await new AuthProvisioner(f.db, f.config.secret).start(
      f.userId,
      "host-operator",
      "client-incident",
    );
    const redeemed = await f.app.inject({
      method: "POST",
      url: "/api/v1/platform/account/recovery/operator",
      headers: { origin },
      payload: { token: flow.permit },
    });
    assert.equal(redeemed.statusCode, 200, redeemed.body);
    const cookie = redeemed.cookies.find(
      (c) => c.name === "de-seller-session",
    )!;
    const file = `${f.root}/restricted-session.json`;
    await writeFile(
      file,
      JSON.stringify({ origin, cookie: `${cookie.name}=${cookie.value}` }),
      { mode: 0o600 },
    );
    const env = {
        PUBLIC_ORIGIN: origin,
        TENANT_SLUG: "primary",
        ENTITLE_SESSION_FILE: file,
      },
      output: string[] = [];
    const io = {
      log: (s: string) => output.push(s),
      error: (s: string) => output.push(s),
    };
    const cli: typeof runCli = process.env.ENTITLE_TEST_SERVER_DIR
      ? (
          await import(
            pathToFileURL(`${process.env.ENTITLE_TEST_SERVER_DIR}/src/cli.js`)
              .href
          )
        ).runCli
      : runCli;
    assert.equal(
      await cli(["owner-recovery-status"], env, io),
      0,
      output.join("\n"),
    );
    assert.equal(JSON.parse(output.at(-1)!).id, flow.id);
    assert.equal(await cli(["owner-publishers"], env, io), 1);
    assert.equal(
      await cli(["owner-recovery-channel-request"], env, io),
      1,
      "Operator recovery cannot be replaced by email",
    );
    client = new Client({ name: "auth07-fixture", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        process.env.ENTITLE_TEST_SERVER_DIR
          ? `${process.env.ENTITLE_TEST_SERVER_DIR}/src/mcp.js`
          : "src/mcp.ts",
      ],
      env: { PATH: process.env.PATH ?? "", ...env },
      stderr: "pipe",
    });
    await client.connect(transport);
    const status = await client.callTool({
      name: "entitle_op_owner_recovery_status",
      arguments: {},
    });
    assert.equal(status.isError, undefined, JSON.stringify(status));
    assert.equal(
      (
        await client.callTool({
          name: "entitle_op_owner_publishers",
          arguments: {},
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await client.callTool({
          name: "entitle_op_owner_recovery_cancel",
          arguments: { flowId: flow.id },
        })
      ).isError,
      undefined,
    );
    assert.equal(await cli(["owner-recovery-status"], env, io), 1);
    assert.equal((await f.db("auth_recoveries").first()).state, "canceled");
    assert.ok(
      output.every(
        (s) => !s.includes(flow.permit) && !s.includes(cookie.value),
      ),
    );
  } finally {
    await client?.close();
    await f.close();
  }
});

test("AUTH-07: ordinary recovery CLI confirms its channel and consumes a replacement-key proof without regaining privilege", async () => {
  const { passkeyFixture } = await import("./helpers/oidc.ts");
  const { csrf, hash, random, unseal } = await import("../src/crypto.ts");
  const f = await oidcFixture();
  try {
    const origin = await f.app.listen({ port: 0, host: "127.0.0.1" }); f.config.origin = origin;
    const code = random(); await f.db("account_recovery_codes").insert({ id: hash(`recovery:${f.userId}:${code}`), user_id: f.userId, created_at: Date.now() });
    const started = await f.app.inject({ method: "POST", url: "/api/v1/platform/account/recovery/start", headers: { origin }, payload: {} }); const c = started.cookies[0]!;
    const redeemed = await f.app.inject({ method: "POST", url: "/api/v1/platform/account/recovery/consume", headers: { origin, cookie: `${c.name}=${c.value}` }, payload: { email: "owner@example.test", code } });
    assert.equal(redeemed.statusCode, 200, redeemed.body); const cookie = redeemed.cookies.find(c => c.name === "de-seller-session")!;
    const file = `${f.root}/ordinary-recovery-session`, body = `${f.root}/channel.json`, proofFile = `${f.root}/proof.json`;
    await writeFile(file, JSON.stringify({ origin, cookie: `${cookie.name}=${cookie.value}` }), { mode: 0o600 });
    const env = { PUBLIC_ORIGIN: origin, TENANT_SLUG: "primary", ENTITLE_SESSION_FILE: file }, lines: string[] = [], io = { log: (s: string) => lines.push(s), error: (s: string) => lines.push(s) };
    assert.equal(await runCli(["owner-recovery-channel-request"], env, io), 0, lines.join("\n"));
    const email = await f.db("platform_emails").where({ kind: "account_verification" }).first();
    const token = unseal<{ text: string }>(email.payload, f.config.secret).text.split(": ").at(-1)!;
    await writeFile(body, JSON.stringify({ token }), { mode: 0o600 });
    assert.equal(await runCli(["owner-recovery-channel-consume", body], env, io), 0, lines.join("\n"));
    const headers = { origin, cookie: `${cookie.name}=${cookie.value}`, "x-csrf-token": csrf(cookie.value, f.config.secret) };
    const post = (path: string, payload: object) => f.app.inject({ method: "POST", url: `/api/v1/platform/account${path}`, headers, payload });
    const key = passkeyFixture(origin); const enroll = await post("/security/passkey/enroll", { name: "Recovery replacement" });
    assert.equal((await post("/security/passkey/confirm", { challengeId: enroll.json().challengeId, response: key.registration(enroll.json().options.challenge) })).statusCode, 200);
    const flow = await f.db("auth_recoveries").first();
    const options = await post("/reauth/options", { action: "security.recovery_complete", flowId: flow.id });
    const proof = await post("/reauth/verify", { challengeId: options.json().challengeId, response: key.authentication(options.json().options.challenge) });
    await writeFile(proofFile, JSON.stringify({ verification: proof.json().verification }), { mode: 0o600 });
    assert.equal(await runCli(["owner-recovery-complete"], { ...env, ENTITLE_VERIFICATION_FILE: proofFile }, io), 0, lines.join("\n"));
    assert.equal((await f.db("seller_users").first()).recovered_ordinary, 1); assert.equal((await f.db("seller_sessions")).length, 0);
    assert.ok(lines.every(line => !line.includes(token) && !line.includes(cookie.value) && !line.includes(proof.json().verification)));
  } finally { await f.close(); }
});
