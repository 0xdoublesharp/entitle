import { privateRead, sessionOrigin } from "./agent-session.ts";
import { oidcAudience } from "./oidc-schema.ts";

async function json(url: string | URL, options: RequestInit) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  try {
    if (!response.ok)
      throw Error(
        `OIDC authentication returned HTTP ${response.status}. Request a fresh ID token before retrying.`,
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 32768) throw Error("OIDC response exceeds 32 KiB.");
        chunks.push(chunk);
      }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}

// Credentials stay in memory for one command and are never written to stdout.
export async function oidcPublishingToken(env: NodeJS.ProcessEnv) {
  if (env.TENANT_API_KEY)
    throw Error("Choose OIDC publishing or TENANT_API_KEY.");
  const origin = sessionOrigin(env);
  const remote = new URL(origin);
  if (
    remote.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(remote.hostname)
  )
    throw Error("OIDC publishing requires an HTTPS PUBLIC_ORIGIN.");
  if (
    !env.TENANT_SLUG ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.TENANT_SLUG) ||
    env.TENANT_SLUG.length > 100
  )
    throw Error("A valid TENANT_SLUG is required.");
  if (
    !env.ENTITLE_OIDC_PUBLISHER_ID ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      env.ENTITLE_OIDC_PUBLISHER_ID,
    )
  )
    throw Error("A valid ENTITLE_OIDC_PUBLISHER_ID is required.");
  if (env.ENTITLE_OIDC_TOKEN && env.ENTITLE_OIDC_TOKEN_FILE)
    throw Error("Choose one OIDC token source.");
  let identity = env.ENTITLE_OIDC_TOKEN;
  if (env.ENTITLE_OIDC_TOKEN_FILE)
    identity = (await privateRead(env.ENTITLE_OIDC_TOKEN_FILE)).trim();
  if (!identity) {
    if (
      env.GITHUB_ACTIONS !== "true" ||
      !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
      !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    )
      throw Error(
        "Supply ENTITLE_OIDC_TOKEN or ENTITLE_OIDC_TOKEN_FILE, or enable id-token: write in GitHub Actions.",
      );
    const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(".actions.githubusercontent.com") ||
      url.username ||
      url.password ||
      url.hash ||
      url.port
    )
      throw Error("Invalid GitHub Actions identity endpoint.");
    url.searchParams.set("audience", oidcAudience(origin, env.TENANT_SLUG));
    const result = await json(url, {
      headers: {
        authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`,
      },
    });
    identity = typeof result.value === "string" ? result.value : undefined;
  }
  if (
    !identity ||
    identity.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(identity)
  )
    throw Error("CI must supply a signed OIDC ID token.");
  const result = await json(
    `${origin}/api/v1/tenants/${env.TENANT_SLUG}/oidc/token`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${identity}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ publisherId: env.ENTITLE_OIDC_PUBLISHER_ID }),
    },
  );
  if (
    typeof result.accessToken !== "string" ||
    !/^DE-CI-[A-Za-z0-9_-]{43}$/.test(result.accessToken) ||
    typeof result.expiresAt !== "number" ||
    result.expiresAt <= Date.now() ||
    result.expiresAt > Date.now() + 600000 ||
    result.tokenType !== "Bearer"
  )
    throw Error("Entitle returned invalid CI publishing credentials.");
  return result.accessToken;
}
