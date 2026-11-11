import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { authMaintenance } from "../src/auth-maintenance.ts";
import { oidcFixture, passkeyFixture } from "./helpers/oidc.ts";
import { hash } from "../src/crypto.ts";

test("AUTH-07: protected maintenance binds physical inventory and writes one-use recovery authorization privately", async () => {
  const f = await oidcFixture({}, "");
  const env = {
    APP_SECRET: f.config.secret,
    OPERATOR_TOKEN: "x".repeat(32),
    DEPLOYMENT_MODE: "hosted",
    DATABASE_URL: `sqlite:${f.root}/db`,
  };
  const common = [
    "--operator",
    "host-operator",
    "--reference",
    "incident-42",
    "--quiesced",
  ];
  const run = (command: string, args: string[] = []) =>
    authMaintenance([command, ...common, ...args], env);
  try {
    await assert.rejects(authMaintenance([], env), /Supply one command/);
    await assert.rejects(run("unknown"), /Choose inventory/);
    await assert.rejects(run("inventory"), /Supply --user/);
    await assert.rejects(run("approve"), /bounded provisioning/);
    await assert.rejects(run("recovery-start"), /private --output/);
    await assert.rejects(run("recovery-complete"), /Supply --flow/);
    const key = passkeyFixture(f.config.origin);
    await key.seed(f.db, f.userId, f.config.secret);
    const inventory = (await run("inventory", ["--user", f.userId])) as {
      credentials: { id: string; publicKeyHash: string }[];
    };
    assert.equal(inventory.credentials.length, 1);
    assert.equal(
      inventory.credentials[0]!.publicKeyHash,
      hash(key.cose.toString("base64url")),
    );
    const base = [
      "--user",
      f.userId,
      "--factor",
      inventory.credentials[0]!.id,
      "--fingerprint",
      inventory.credentials[0]!.publicKeyHash,
      "--inventory",
      "physical-001",
    ];
    assert.deepEqual(await run("approve", base), { ok: true });
    const file = `${f.root}/operator-authorization`;
    const recovery = (await run("recovery-start", [
      "--user",
      f.userId,
      "--output",
      file,
    ])) as { flowId: string; notBefore: number };
    const { token } = JSON.parse(await readFile(file, "utf8"));
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.ok(token && !JSON.stringify(recovery).includes(token));
    await assert.rejects(
      run("recovery-start", ["--user", f.userId, "--output", file]),
      /EEXIST/,
    );
    await assert.rejects(
      run("recovery-complete", ["--flow", recovery.flowId]),
      /objection period/,
    );
    const replacement = passkeyFixture(f.config.origin),
      backup = passkeyFixture(f.config.origin);
    for (const [i, k] of [replacement, backup].entries()) {
      await k.seed(f.db, f.userId, f.config.secret);
      const row = await f
        .db("seller_factors")
        .where({ credential_hash: hash(k.id) })
        .first();
      await f
        .db("seller_factors")
        .where({ id: row.id })
        .update({ recovery_id: recovery.flowId, provenance: "recovery" });
      await run("approve", [
        "--user",
        f.userId,
        "--factor",
        row.id,
        "--fingerprint",
        hash(k.cose.toString("base64url")),
        "--inventory",
        `replacement-${i}`,
      ]);
    }
    await f
      .db("auth_recoveries")
      .where({ id: recovery.flowId })
      .update({ not_before: 0 });
    assert.deepEqual(
      await run("recovery-complete", ["--flow", recovery.flowId]),
      { ok: true },
    );
    assert.equal((await f.db("seller_factors")).length, 2);
    // Real entrypoint exposes machine-readable errors and inventory, never permits in stdout.
    for (const [args, status] of [
      [[], 1],
      [["inventory", ...common, "--user", f.userId], 0],
      [["inventory", ...common, "--bad"], 1],
    ] as const) {
      const child = spawnSync(
        process.execPath,
        ["src/auth-maintenance.ts", ...args],
        { env: { ...process.env, ...env }, encoding: "utf8" },
      );
      assert.equal(child.status, status, child.stderr);
      const body = JSON.parse(child.stdout || child.stderr);
      assert.ok(body.credentials || body.error);
      assert.ok(!child.stdout.includes(token));
    }
  } finally {
    await f.close();
  }
});
