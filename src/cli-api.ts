import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import {
  privateRead,
  loadOwnerSession,
  loadBuyerSession,
} from "./agent-session.ts";
import { readRegularFile } from "./cli-files.ts";

// This escape hatch deliberately accepts only paths on the configured origin.
export async function genericApi(
  command: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
  inlineBody?: Record<string, unknown>,
  options?: { responseMode?: "text"; inlineMetadata?: Record<string, unknown> },
) {
  const privateValues: string[] = [];
  const log = (message: string) => {
    for (const secret of [
      env.TENANT_API_KEY,
      env.OPERATOR_TOKEN,
      env.ENTITLE_AUTHORIZATION,
      env.ENTITLE_COOKIE,
      env.ENTITLE_CSRF_TOKEN,
      env.ENTITLE_VERIFICATION,
      env.APP_SECRET,
      ...privateValues,
    ])
      if (secret) message = message.split(secret).join("[redacted]");
    io.log(message);
  };
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      body: { type: "string" },
      upload: { type: "string" },
      output: { type: "string" },
      "content-type": { type: "string" },
      metadata: { type: "string" },
      "headers-output": { type: "string" },
      range: { type: "string" },
    },
  });
  const [method, path] = parsed.positionals;
  if (
    parsed.positionals.length !== 2 ||
    !method ||
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method) ||
    !path
  )
    throw Error(
      "Usage: api|operator-api|request METHOD PATH [--body JSON_FILE | --upload FILE] [--output FILE] [--content-type TYPE] [--metadata JSON_FILE]",
    );
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("#") ||
    path.includes("\\") ||
    [...path].some((character) => character.charCodeAt(0) <= 32)
  )
    throw Error("Invalid API path.");
  const pathname = path.split("?")[0]!;
  const decodedSegments: string[] = [];
  for (const segment of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw Error("Invalid API path encoding.");
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      /[\\/]/.test(decoded) ||
      [...decoded].some((character) => character.charCodeAt(0) < 32) ||
      /%[0-9a-f]{2}/i.test(decoded)
    )
      throw Error("Invalid API path segment.");
    decodedSegments.push(decoded);
  }
  const exportCreation =
    method === "POST" &&
    decodedSegments.join("/").replace(/\/+$/, "").endsWith("/exports");
  const operator = command === "operator-api";
  const origin = new URL(
    (operator ? env.OPERATOR_ORIGIN : undefined) ??
      env.PUBLIC_ORIGIN ??
      "http://localhost:3211",
  );
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw Error(
      "Remote origin must be an HTTP(S) origin without credentials, path, query or fragment.",
    );
  let prefix: string;
  const headers: Record<string, string> = {};
  if (command === "api") {
    if (
      !env.TENANT_SLUG ||
      env.TENANT_SLUG.length > 100 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.TENANT_SLUG)
    )
      throw Error("A valid TENANT_SLUG is required.");
    if (
      !env.TENANT_API_KEY ||
      !/^DE-TK-[A-Za-z0-9_-]{43}$/.test(env.TENANT_API_KEY)
    )
      throw Error("A valid TENANT_API_KEY is required.");
    headers.authorization = `Bearer ${env.TENANT_API_KEY}`;
    prefix = `/api/v1/tenants/${env.TENANT_SLUG}/seller`;
  } else if (operator) {
    if (!env.OPERATOR_TOKEN || env.OPERATOR_TOKEN.length < 32)
      throw Error("A valid OPERATOR_TOKEN is required.");
    headers.authorization = `Bearer ${env.OPERATOR_TOKEN}`;
    prefix = "/api/v1/operator";
  } else {
    if (!pathname.startsWith("/api/v1/"))
      throw Error("request requires an /api/v1/ path.");
    prefix = "";
    if (env.ENTITLE_BUYER_SESSION_FILE) {
      if (
        env.ENTITLE_SESSION_FILE ||
        env.ENTITLE_COOKIE ||
        env.ENTITLE_CSRF_TOKEN ||
        env.ENTITLE_AUTHORIZATION ||
        env.ENTITLE_VERIFICATION ||
        env.ENTITLE_VERIFICATION_FILE
      )
        throw Error(
          "Buyer session cannot be combined with other authentication credentials.",
        );
      if (
        !env.TENANT_SLUG ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.TENANT_SLUG) ||
        env.TENANT_SLUG.length > 100 ||
        !pathname.startsWith(`/api/v1/tenants/${env.TENANT_SLUG}/`)
      )
        throw Error("Buyer session is restricted to its tenant API.");
      const session = await loadBuyerSession(
        env.ENTITLE_BUYER_SESSION_FILE,
        origin.origin,
        env.TENANT_SLUG,
      );
      privateValues.push(session.cookie, session.csrfToken);
      headers.cookie = session.cookie;
      headers["x-csrf-token"] = session.csrfToken;
    }
    if (
      env.ENTITLE_SESSION_FILE &&
      (env.ENTITLE_COOKIE || env.ENTITLE_CSRF_TOKEN)
    )
      throw Error(
        "Choose ENTITLE_SESSION_FILE or explicit cookie/CSRF values.",
      );
    if (env.ENTITLE_SESSION_FILE) {
      const session = await loadOwnerSession(
        env.ENTITLE_SESSION_FILE,
        origin.origin,
      );
      privateValues.push(session.cookie, session.csrfToken);
      headers.cookie = session.cookie;
      headers["x-csrf-token"] = session.csrfToken;
    }
    if (env.ENTITLE_AUTHORIZATION)
      headers.authorization = env.ENTITLE_AUTHORIZATION;
    if (env.ENTITLE_COOKIE) headers.cookie = env.ENTITLE_COOKIE;
    if (env.ENTITLE_CSRF_TOKEN)
      headers["x-csrf-token"] = env.ENTITLE_CSRF_TOKEN;
    if (env.ENTITLE_VERIFICATION)
      headers["x-account-verification"] = env.ENTITLE_VERIFICATION;
    if (env.ENTITLE_VERIFICATION_FILE) {
      if (env.ENTITLE_VERIFICATION)
        throw Error("Choose one verification source.");
      const verification = JSON.parse(
        await privateRead(env.ENTITLE_VERIFICATION_FILE),
      ) as { verification?: unknown };
      if (
        typeof verification.verification !== "string" ||
        verification.verification.length > 200 ||
        verification.verification.length < 1
      )
        throw Error("Invalid verification file.");
      privateValues.push(verification.verification);
      headers["x-account-verification"] = verification.verification;
    }
    headers.origin = origin.origin;
  }
  const { body, upload, output, metadata } = parsed.values;
  if (
    [body, upload, inlineBody].filter((value) => value !== undefined).length > 1
  )
    throw Error("Choose one request body.");
  if ((body || upload || inlineBody) && ["GET", "HEAD"].includes(method))
    throw Error("GET and HEAD cannot have a request body.");
  if (exportCreation && (inlineBody || upload))
    throw Error(
      "Export passphrases must be supplied in an owner-only body file.",
    );
  if ((metadata || options?.inlineMetadata) && !upload)
    throw Error("Metadata requires --upload.");
  if (metadata && options?.inlineMetadata)
    throw Error("Choose one metadata source.");
  if (parsed.values.range) headers.range = parsed.values.range;
  let payload: string | ReadableStream<Uint8Array> | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let uploadStream: Readable | undefined;
  let outputHandle: Awaited<ReturnType<typeof open>> | undefined;
  let headerHandle: Awaited<ReturnType<typeof open>> | undefined;
  let outputCommitted = false;
  let headerCommitted = false;
  let dispatched = false;
  let definitiveFailure = false;
  try {
    if (inlineBody) {
      payload = JSON.stringify(inlineBody);
      if (Buffer.byteLength(payload) > 1024 * 1024)
        throw Error("JSON body exceeds 1 MiB.");
      headers["content-type"] = "application/json";
    } else if (body) {
      handle = await open(
        body,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024)
        throw Error("JSON body must be a regular file of at most 1 MiB.");
      if (
        exportCreation &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
      )
        throw Error("Export passphrase input must be an owner-only file.");
      payload = await handle.readFile("utf8");
      JSON.parse(payload);
      headers["content-type"] = "application/json";
    } else if (upload) {
      handle = await open(
        upload,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 ** 3)
        throw Error("Upload must be a regular file of 1 byte to 2 GiB.");
      headers["content-type"] =
        parsed.values["content-type"] ?? "application/octet-stream";
      headers["content-length"] = String(stat.size);
      if (metadata)
        headers["x-release-metadata"] = Buffer.from(
          JSON.stringify(
            JSON.parse((await readRegularFile(metadata)).toString("utf8")),
          ),
        ).toString("base64url");
      if (options?.inlineMetadata)
        headers["x-release-metadata"] = Buffer.from(
          JSON.stringify(options.inlineMetadata),
        ).toString("base64url");
      uploadStream = handle.createReadStream({ autoClose: false });
      payload = Readable.toWeb(uploadStream) as ReadableStream<Uint8Array>;
    } else if (!["GET", "HEAD"].includes(method)) {
      payload = "{}";
      headers["content-type"] = "application/json";
    }
    if (output)
      outputHandle = await open(
        output,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    const headersOutput = parsed.values["headers-output"];
    if (headersOutput)
      headerHandle = await open(
        headersOutput,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    dispatched = true;
    const response = await fetch(`${origin.origin}${prefix}${path}`, {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(upload ? 3600000 : 180000),
      ...(payload === undefined
        ? {}
        : { body: payload, ...(upload ? { duplex: "half" as const } : {}) }),
    });
    let headerError: unknown;
    if (headerHandle) {
      const headerFile = headerHandle;
      try {
        const values = Object.fromEntries(response.headers.entries());
        const cookies = response.headers.getSetCookie();
        await headerFile.writeFile(
          JSON.stringify(
            {
              status: response.status,
              headers: values,
              ...(cookies.length ? { setCookie: cookies } : {}),
            },
            null,
            2,
          ),
        );
        await headerFile.close();
        headerHandle = undefined;
        headerCommitted = true;
      } catch (error) {
        headerError = error;
        await headerFile.close().catch(() => {});
        await unlink(headersOutput!).catch(() => {});
        headerHandle = undefined;
      }
    }
    if (!response.ok) {
      definitiveFailure =
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 408;
      await response.body?.cancel();
      throw Error(
        `API returned ${response.status} (${response.headers.get("x-request-id") ?? "no request ID"}).`,
      );
    }
    if (output) {
      const file = outputHandle!;
      try {
        if (response.body)
          await pipeline(
            Readable.fromWeb(
              response.body as import("node:stream/web").ReadableStream,
            ),
            file.createWriteStream(),
          );
        else await file.close();
        outputHandle = undefined;
        outputCommitted = true;
      } catch (error) {
        await file.close().catch(() => {});
        await unlink(output).catch(() => {});
        outputHandle = undefined;
        throw error;
      }
      log(JSON.stringify({ saved: output, status: response.status }));
    } else if (response.status === 204 || method === "HEAD")
      log(JSON.stringify({ status: response.status }));
    else {
      const isJson = response.headers.get("content-type")?.includes("json");
      if (!isJson && options?.responseMode !== "text") {
        await response.body?.cancel();
        throw Error("Non-JSON response requires --output FILE.");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body)
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 4 * 1024 * 1024)
            throw Error("Response exceeds 4 MiB; use --output FILE.");
          chunks.push(chunk);
        }
      const text = Buffer.concat(chunks).toString("utf8");
      log(
        JSON.stringify(
          isJson
            ? JSON.parse(text)
            : {
                status: response.status,
                contentType: response.headers.get("content-type"),
                text,
              },
          null,
          2,
        ),
      );
    }
    if (headerError)
      throw Error(
        `Response headers could not be saved.${outputCommitted ? ` Response body was saved to ${output}.` : ""}`,
        { cause: headerError },
      );
  } catch (error) {
    if (dispatched && !definitiveFailure && !["GET", "HEAD"].includes(method))
      throw Error(
        `The request may have been applied; inspect its state before retrying. ${error instanceof Error ? error.message : "Request failed."}`,
        { cause: error },
      );
    throw error;
  } finally {
    uploadStream?.destroy();
    await handle?.close();
    if (outputHandle) await outputHandle.close().catch(() => {});
    if (output && !outputCommitted && outputHandle)
      await unlink(output).catch(() => {});
    if (headerHandle) await headerHandle.close().catch(() => {});
    if (parsed.values["headers-output"] && !headerCommitted && headerHandle)
      await unlink(parsed.values["headers-output"]).catch(() => {});
  }
}
