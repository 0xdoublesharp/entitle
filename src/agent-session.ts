import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { z } from "zod";
import { genericApi } from "./cli-api.ts";

const sessionSchema = z
  .object({
    origin: z.string().url(),
    cookie: z.string().min(1).max(500),
    csrfToken: z.string().max(500).optional(),
  })
  .strict();
const buyerSessionSchema = z
  .object({
    origin: z.string().url(),
    tenant: z.string().min(1).max(100),
    cookie: z.string().min(1).max(500),
    csrfToken: z.string().max(500).optional(),
  })
  .strict();
function buyerTenant(env: NodeJS.ProcessEnv) {
  if (
    !env.TENANT_SLUG ||
    env.TENANT_SLUG.length > 100 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.TENANT_SLUG)
  )
    throw Error("A valid TENANT_SLUG is required.");
  return env.TENANT_SLUG;
}

export async function privateRead(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size > 16384
    )
      throw Error("Use an owner-only regular input file of at most 16 KiB.");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
export async function readSession(path: string, origin: string) {
  const session = sessionSchema.parse(JSON.parse(await privateRead(path)));
  if (
    session.origin !== origin ||
    !/^(?:__Host-)?de-seller-(?:preauth|session)=[A-Za-z0-9_-]{43}$/.test(
      session.cookie,
    )
  )
    throw Error(
      "Session file does not match this origin or has an invalid cookie.",
    );
  return session;
}
export async function readBuyerSession(
  path: string,
  origin: string,
  tenant: string,
) {
  const session = buyerSessionSchema.parse(JSON.parse(await privateRead(path)));
  if (
    session.origin !== origin ||
    session.tenant !== tenant ||
    !/^(?:__Host-)?de-session-[A-Za-z0-9_-]{1,64}=[A-Za-z0-9_-]{43}$/.test(
      session.cookie,
    )
  )
    throw Error("Buyer session file does not match this origin or workspace.");
  return session;
}
export function sessionOrigin(env: NodeJS.ProcessEnv) {
  const origin = new URL(env.PUBLIC_ORIGIN ?? "http://localhost:3211");
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error(
      "PUBLIC_ORIGIN must be an HTTP(S) origin without credentials or path.",
    );
  return origin.origin;
}
function cookie(response: Response, suffix: string) {
  const re = new RegExp(
    `^((?:__Host-)?de-seller-${suffix}=[A-Za-z0-9_-]{43})(?:;|$)`,
  );
  const matches = response.headers
    .getSetCookie()
    .map((value) => re.exec(value)?.[1])
    .filter((value): value is string => !!value);
  if (matches.length !== 1)
    throw Error(
      "The server did not return the expected seller cookie; the request may have been applied. Inspect its state before retrying.",
    );
  return matches[0]!;
}
async function post(
  origin: string,
  path: string,
  body: object,
  existingCookie?: string,
) {
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        ...(existingCookie ? { cookie: existingCookie } : {}),
      },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw Error(
      "The request may have been applied; inspect its state before retrying.",
      { cause: error },
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 408 || response.status >= 500)
      throw Error(
        `API returned ${response.status}; the request may have been applied. Inspect its state before retrying.`,
      );
    throw Error(`API returned ${response.status}.`);
  }
  // Cookies are already in response headers; a failed body cancellation must
  // not discard the result of a successfully consumed login token.
  await response.body?.cancel().catch(() => {});
  return response;
}
async function saveNew(path: string, work: () => Promise<unknown>) {
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let completed = false;
  try {
    const value = await work();
    completed = true;
    await file.writeFile(JSON.stringify(value));
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(path).catch(() => {});
    if (completed)
      throw Error(
        "The remote operation completed, but saving its private response failed. Inspect state and request fresh credentials if needed before retrying.",
        { cause: error },
      );
    throw error;
  }
}
export async function loginStart(
  email: string,
  path: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  z.email().max(254).parse(email);
  const origin = sessionOrigin(env);
  await saveNew(path, async () => ({
    origin,
    cookie: cookie(
      await post(origin, "/api/v1/platform/auth/request", { email }),
      "preauth",
    ),
  }));
  io.log(
    JSON.stringify({
      preauthFile: path,
      next: "Copy the login token from the email into an owner-only file, then run owner-login-finish.",
    }),
  );
}
export async function loginFinish(
  preauthFile: string,
  tokenFile: string,
  sessionFile: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  const origin = sessionOrigin(env),
    preauth = await readSession(preauthFile, origin);
  if (!preauth.cookie.includes("preauth="))
    throw Error("A pre-authentication session file is required.");
  const token = (await privateRead(tokenFile)).trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(token))
    throw Error("The private token file must contain the login token only.");
  await saveNew(sessionFile, async () => ({
    origin,
    cookie: cookie(
      await post(
        origin,
        "/api/v1/platform/auth/consume",
        { token },
        preauth.cookie,
      ),
      "session",
    ),
  }));
  try {
    await refreshSession(sessionFile, env);
  } catch (error) {
    throw Error(
      `Login succeeded and the session is saved in ${sessionFile}; run owner-session-refresh to retrieve CSRF. ${error instanceof Error ? error.message : "Lookup failed."}`,
      { cause: error },
    );
  }
  io.log(
    JSON.stringify({
      sessionFile,
      next: "Set ENTITLE_SESSION_FILE to this private file for owner commands.",
    }),
  );
}
export async function refreshSession(
  sessionFile: string,
  env: NodeJS.ProcessEnv,
) {
  await loadOwnerSession(sessionFile, sessionOrigin(env));
}
export async function loadOwnerSession(sessionFile: string, origin: string) {
  const session = await readSession(sessionFile, origin);
  if (!session.cookie.includes("session="))
    throw Error("An authenticated session file is required.");
  const response = await fetch(`${origin}/api/v1/platform/me`, {
    headers: { cookie: session.cookie },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Seller session lookup returned ${response.status}.`);
  }
  const result = z
    .object({ csrfToken: z.string().min(1).max(500) })
    .passthrough()
    .parse(await response.json());
  const current = await readSession(sessionFile, origin);
  if (current.cookie !== session.cookie)
    throw Error("Session changed during refresh.");
  return { ...session, csrfToken: result.csrfToken };
}
export async function buyerLoginStart(
  email: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  z.email().max(254).parse(email);
  const origin = sessionOrigin(env),
    tenant = buyerTenant(env);
  await post(origin, `/api/v1/tenants/${tenant}/auth/request`, { email });
  io.log(
    JSON.stringify({
      ok: true,
      next: "If the buyer account exists, copy its email login token into an owner-only file, then run buyer-login-finish.",
    }),
  );
}
export async function buyerLoginFinish(
  tokenFile: string,
  sessionFile: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  const origin = sessionOrigin(env),
    tenant = buyerTenant(env);
  const token = (await privateRead(tokenFile)).trim();
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(token))
    throw Error("The private token file must contain the login token only.");
  await saveNew(sessionFile, async () => {
    const response = await post(
      origin,
      `/api/v1/tenants/${tenant}/auth/consume`,
      { token },
    );
    const cookies = response.headers
      .getSetCookie()
      .map(
        (value) =>
          /^((?:__Host-)?de-session-[A-Za-z0-9_-]{1,64}=[A-Za-z0-9_-]{43})(?:;|$)/.exec(
            value,
          )?.[1],
      )
      .filter((value): value is string => !!value);
    if (cookies.length !== 1)
      throw Error(
        "The server did not return the expected buyer cookie; the request may have been applied. Inspect its state before retrying.",
      );
    return { origin, tenant, cookie: cookies[0] };
  });
  try {
    await refreshBuyerSession(sessionFile, env);
  } catch (error) {
    throw Error(
      `Buyer login succeeded and the session is saved in ${sessionFile}; run buyer-session-refresh to retrieve CSRF. ${error instanceof Error ? error.message : "Lookup failed."}`,
      { cause: error },
    );
  }
  io.log(
    JSON.stringify({
      sessionFile,
      next: "Set ENTITLE_BUYER_SESSION_FILE to this private file for buyer commands.",
    }),
  );
}
export async function refreshBuyerSession(
  path: string,
  env: NodeJS.ProcessEnv,
) {
  await loadBuyerSession(path, sessionOrigin(env), buyerTenant(env));
}
export async function loadBuyerSession(
  path: string,
  origin: string,
  tenant: string,
) {
  const session = await readBuyerSession(path, origin, tenant);
  const response = await fetch(`${origin}/api/v1/tenants/${tenant}/me`, {
    headers: { cookie: session.cookie },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`Buyer session lookup returned ${response.status}.`);
  }
  const result = z
    .object({ csrfToken: z.string().min(1).max(500) })
    .passthrough()
    .parse(await response.json());
  const current = await readBuyerSession(path, origin, tenant);
  if (current.cookie !== session.cookie)
    throw Error("Buyer session changed during refresh.");
  return { ...session, csrfToken: result.csrfToken };
}
export async function consumeVerification(
  bodyFile: string,
  output: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  const input = z
    .object({
      purpose: z.enum([
        "recovery_codes",
        "billing",
        "api_keys",
        "tenant_transfer",
        "release_publish",
      ]),
      token: z.string().min(1).max(200),
    })
    .strict()
    .parse(JSON.parse(await privateRead(bodyFile)));
  await saveNew(output, async () => {
    const lines: string[] = [];
    await genericApi(
      "request",
      ["POST", "/api/v1/platform/account/verification/consume"],
      env,
      {
        log: (line: string) => lines.push(line),
      },
      input,
    );
    return z
      .object({
        verification: z.string().min(1).max(200),
        expiresIn: z.number(),
      })
      .passthrough()
      .parse(JSON.parse(lines.join("\n")));
  });
  io.log(JSON.stringify({ proofFile: output }));
}
export async function activateInstallation(
  bodyFile: string,
  output: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  if (
    !env.TENANT_SLUG ||
    env.TENANT_SLUG.length > 100 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.TENANT_SLUG)
  )
    throw Error("A valid TENANT_SLUG is required.");
  const input = z
    .object({
      key: z.string().min(1).max(200),
      installationId: z.string().min(1).max(150),
      product: z.string().min(1).max(150),
      siteUrl: z.string().optional(),
      installationLabel: z.string().optional(),
    })
    .strict()
    .parse(JSON.parse(await privateRead(bodyFile)));
  await saveNew(output, async () => {
    const lines: string[] = [];
    await genericApi(
      "request",
      ["POST", `/api/v1/tenants/${env.TENANT_SLUG}/activate`],
      env,
      {
        log: (line: string) => lines.push(line),
      },
      input,
    );
    return JSON.parse(lines.join("\n")) as unknown;
  });
  io.log(JSON.stringify({ activationFile: output }));
}
