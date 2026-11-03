import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, open } from "node:fs/promises";
import { join } from "node:path";
import {
  loginStart,
  loginFinish,
  buyerLoginStart,
  buyerLoginFinish,
  readSession,
  readBuyerSession,
  sessionOrigin,
  privateRead,
  loadOwnerSession,
  loadBuyerSession,
  activateInstallation,
} from "../src/agent-session.ts";
import { readRegularFile } from "../src/cli-files.ts";

const origin = "https://accounts.example.test";
const env = { PUBLIC_ORIGIN: origin, TENANT_SLUG: "primary" };
const token = "x".repeat(43);
const io = { log: (_value: string) => {}, error: (_value: string) => {} };

test("private session files reject mismatched origins, identities, permissions and input growth", async (t) => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/session-input-contract-",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "session");
  const write = (value: unknown) =>
    writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await write({ origin, cookie: `de-seller-session=${token}` });
  await assert.rejects(
    readSession(file, "https://other.example.test"),
    /does not match this origin/,
  );
  await write({ origin, cookie: "de-seller-session=invalid" });
  await assert.rejects(readSession(file, origin), /invalid cookie/);
  await write({ origin, cookie: `de-seller-session=${token}` });
  const tokenFile = join(dir, "token");
  await writeFile(tokenFile, "bad token with spaces", { mode: 0o600 });
  await assert.rejects(
    loginFinish(file, tokenFile, join(dir, "result"), env, io),
    /pre-authentication session/,
  );
  await write({ origin, cookie: `de-seller-preauth=${token}` });
  await assert.rejects(loadOwnerSession(file, origin), /authenticated session/);
  await assert.rejects(
    loginFinish(file, tokenFile, join(dir, "result"), env, io),
    /login token only/,
  );
  await assert.rejects(
    buyerLoginFinish(tokenFile, join(dir, "buyer-result"), env, io),
    /login token only/,
  );
  await assert.rejects(
    activateInstallation(
      tokenFile,
      join(dir, "activation"),
      { PUBLIC_ORIGIN: origin },
      io,
    ),
    /valid TENANT_SLUG/,
  );
  await write({
    origin,
    tenant: "primary",
    cookie: `de-session-primary=${token}`,
  });
  await assert.rejects(
    readBuyerSession(file, "https://other.example.test", "primary"),
    /does not match/,
  );
  await assert.rejects(
    readBuyerSession(file, origin, "other"),
    /does not match/,
  );
  await write({
    origin,
    tenant: "primary",
    cookie: "de-session-primary=invalid",
  });
  await assert.rejects(
    readBuyerSession(file, origin, "primary"),
    /does not match/,
  );
  assert.equal(sessionOrigin({}), "http://localhost:3211");
  for (const PUBLIC_ORIGIN of [
    "ftp://example.test",
    "https://user@example.test",
    "https://:pass@example.test",
    `${origin}/path`,
    `${origin}?query=1`,
    `${origin}#fragment`,
  ])
    assert.throws(() => sessionOrigin({ PUBLIC_ORIGIN }), /HTTP\(S\) origin/);
  for (const TENANT_SLUG of [undefined, "A", "a".repeat(101)])
    await assert.rejects(
      buyerLoginStart("owner@example.test", { ...env, TENANT_SLUG }, io),
      /valid TENANT_SLUG/,
    );
  await writeFile(file, "x".repeat(16385));
  await assert.rejects(privateRead(file), /at most 16 KiB/);
  await assert.rejects(privateRead(dir), /owner-only regular input/);
  if (process.getuid) {
    const uid = process.getuid();
    t.mock.method(process as { getuid: () => number }, "getuid", () => uid + 1);
    await assert.rejects(privateRead(file), /owner-only regular input/);
    t.mock.restoreAll();
  }
  await writeFile(file, "small");
  const handle = await open(file, "r"),
    prototype = Object.getPrototypeOf(handle);
  await handle.close();
  const stat = prototype.stat;
  t.mock.method(prototype, "stat", async function (this: typeof handle) {
    const value = await stat.call(this);
    await writeFile(file, "grew after stat");
    return value;
  });
  await assert.rejects(
    readRegularFile(file, 5),
    /Input exceeds the size limit/,
  );
});

test("owner login preserves uncertainty and cleans failed cookie responses without leaking provider errors", async (t) => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/session-post-contract-",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let sequence = 0;
  for (const status of [400, 408, 500]) {
    globalThis.fetch = async () => new Response("provider secret", { status });
    await assert.rejects(
      loginStart("owner@example.test", join(dir, `status-${status}`), env, io),
      status === 400
        ? /^Error: API returned 400\.$/
        : /request may have been applied/,
    );
  }
  globalThis.fetch = async () => {
    throw "provider secret";
  };
  await assert.rejects(
    loginStart("owner@example.test", join(dir, "network"), env, io),
    /request may have been applied/,
  );
  for (const cookies of [
    [],
    ["unrelated=cookie"],
    [`de-seller-preauth=${token}`, `de-seller-preauth=${token}`],
  ]) {
    globalThis.fetch = async () => {
      const response = new Response("body");
      for (const cookie of cookies)
        response.headers.append("set-cookie", cookie);
      t.mock.method(response.body!, "cancel", async () => {
        throw Error("cancel failed");
      });
      return response;
    };
    await assert.rejects(
      loginStart(
        "owner@example.test",
        join(dir, `cookie-${sequence++}`),
        env,
        io,
      ),
      /expected seller cookie/,
    );
  }
  globalThis.fetch = async () => {
    const response = new Response("failure", { status: 503 });
    t.mock.method(response.body!, "cancel", async () => {
      throw Error("cancel failed");
    });
    return response;
  };
  await assert.rejects(
    loginStart("owner@example.test", join(dir, "failed-cancel"), env, io),
    /API returned 503/,
  );
  globalThis.fetch = async () => new Response(null, { status: 400 });
  await assert.rejects(
    loginStart("owner@example.test", join(dir, "empty-error"), env, io),
    /API returned 400/,
  );
});

test("successful owner and buyer login keep saved credentials when subsequent session lookup fails", async (t) => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/session-lookup-contract-",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const tokenFile = join(dir, "token"),
    preauth = join(dir, "preauth");
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(
    preauth,
    JSON.stringify({ origin, cookie: `de-seller-preauth=${token}` }),
    { mode: 0o600 },
  );
  for (const buyer of [false, true]) {
    for (const failure of [Error("lookup failed"), "unknown failure"]) {
      const session = join(dir, `${buyer}-${typeof failure}`);
      globalThis.fetch = async (url) => {
        if (String(url).endsWith("/me")) throw failure;
        return new Response(null, {
          headers: {
            "set-cookie": buyer
              ? `de-session-primary=${token}; Path=/`
              : `de-seller-session=${token}; Path=/`,
          },
        });
      };
      const work = buyer
        ? buyerLoginFinish(tokenFile, session, env, io)
        : loginFinish(preauth, tokenFile, session, env, io);
      await assert.rejects(work, /[Ll]ogin succeeded and the session is saved/);
      assert.ok((await readFile(session, "utf8")).includes(token));
    }
  }
  globalThis.fetch = async () => new Response("denied", { status: 401 });
  await assert.rejects(
    loadOwnerSession(join(dir, "false-object"), origin),
    /Seller session lookup returned 401/,
  );
  await assert.rejects(
    loadBuyerSession(join(dir, "true-object"), origin, "primary"),
    /Buyer session lookup returned 401/,
  );
  globalThis.fetch = async () => new Response(null);
  await assert.rejects(
    buyerLoginFinish(tokenFile, join(dir, "no-cookie"), env, io),
    /expected buyer cookie/,
  );
  globalThis.fetch = async () => {
    const r = new Response(null);
    r.headers.append("set-cookie", `unrelated=cookie`);
    r.headers.append("set-cookie", `de-session-primary=${token}`);
    return r;
  };
  await assert.rejects(
    buyerLoginFinish(tokenFile, join(dir, "buyer-no-body"), env, io),
    /[Ll]ogin succeeded/,
  );
  const changed = join(dir, "buyer-changed");
  await writeFile(
    changed,
    JSON.stringify({
      origin,
      tenant: "primary",
      cookie: `de-session-primary=${token}`,
    }),
    { mode: 0o600 },
  );
  globalThis.fetch = async () => {
    await writeFile(
      changed,
      JSON.stringify({
        origin,
        tenant: "primary",
        cookie: `de-session-primary=${"y".repeat(43)}`,
      }),
    );
    return Response.json({ csrfToken: "csrf" });
  };
  await assert.rejects(
    loadBuyerSession(changed, origin, "primary"),
    /Buyer session changed during refresh/,
  );
});
