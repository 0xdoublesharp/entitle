import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import { loadConfig } from "./config.ts";
import { createDb, migrate } from "./db.ts";
import { genericApi } from "./cli-api.ts";
import { readRegularFile } from "./cli-files.ts";
import { agentOperations, runAgentCli } from "./agent-operations.ts";
import { createExport, downloadExport } from "./agent-export.ts";
import { loginStart, loginFinish, refreshSession, consumeVerification, activateInstallation, buyerLoginStart, buyerLoginFinish, refreshBuyerSession } from "./agent-session.ts";

const tenantCommands = new Set([
  "product",
  "publish",
  "publish-asset",
  "licenses",
  "revoke",
  "restore",
  "withdraw",
  "reconcile",
  "jobs",
  "work",
  "demo-purchase",
  "features",
  "prices",
  "operations",
  "webhooks",
]);
const operatorCommands = new Set([
  "tenants",
  "tenant-status",
  "tenant-owner",
  "platform-reconcile",
  "platform-jobs",
  "platform-work",
  "local-tenant",
]);
const usage =
  `Commands: migrate | product | publish | publish-asset | licenses | revoke | restore | withdraw | reconcile | jobs | work | demo-purchase | features | prices | operations | webhooks | tenants | tenant-status | tenant-owner | platform-reconcile | platform-jobs | platform-work | local-tenant | ${Object.keys(agentOperations).join(" | ")} | export-create | export-download | owner-login-start | owner-login-finish | owner-session-refresh | owner-verification-consume | buyer-login-start | buyer-login-finish | buyer-session-refresh | activation-create | api | operator-api | request. See docs/cli.md for arguments.`;

export async function runCli(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  io: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  function redact(message: string) {
    for (const credential of [
      env.TENANT_API_KEY,
      env.OPERATOR_TOKEN,
      env.APP_SECRET,
      env.ENTITLE_AUTHORIZATION,
      env.ENTITLE_COOKIE,
      env.ENTITLE_CSRF_TOKEN,
      env.ENTITLE_VERIFICATION,
    ])
      if (credential) message = message.split(credential).join("[redacted]");
    return message;
  }
  try {
    const [command = "", ...args] = argv;
    if (command === "buyer-login-start") {
      if (args.length !== 1) throw Error("Usage: buyer-login-start EMAIL");
      await buyerLoginStart(args[0]!,env,io);
      return 0;
    }
    if (command === "buyer-login-finish") {
      if (args.length !== 2) throw Error("Usage: buyer-login-finish PRIVATE_TOKEN_FILE NEW_SESSION_FILE");
      await buyerLoginFinish(args[0]!,args[1]!,env,io);
      return 0;
    }
    if (command === "buyer-session-refresh") {
      if (args.length !== 1) throw Error("Usage: buyer-session-refresh SESSION_FILE");
      await refreshBuyerSession(args[0]!,env);
      io.log(JSON.stringify({sessionFile:args[0]}));
      return 0;
    }
    if (command === "owner-login-start") {
      if (args.length !== 2) throw Error("Usage: owner-login-start EMAIL NEW_PREAUTH_FILE");
      await loginStart(args[0]!,args[1]!,env,io);
      return 0;
    }
    if (command === "owner-login-finish") {
      if (args.length !== 3) throw Error("Usage: owner-login-finish PREAUTH_FILE PRIVATE_TOKEN_FILE NEW_SESSION_FILE");
      await loginFinish(args[0]!,args[1]!,args[2]!,env,io);
      return 0;
    }
    if (command === "owner-session-refresh") {
      if (args.length !== 1) throw Error("Usage: owner-session-refresh SESSION_FILE");
      await refreshSession(args[0]!,env);
      io.log(JSON.stringify({sessionFile:args[0]}));
      return 0;
    }
    if (command === "owner-verification-consume") {
      if (args.length !== 2) throw Error("Usage: owner-verification-consume PRIVATE_BODY_JSON_FILE NEW_PROOF_FILE");
      await consumeVerification(args[0]!,args[1]!,env,io);
      return 0;
    }
    if (command === "activation-create") {
      if (args.length !== 2) throw Error("Usage: activation-create PRIVATE_INPUT_JSON_FILE NEW_ACTIVATION_FILE");
      await activateInstallation(args[0]!,args[1]!,env,io);
      return 0;
    }
    if (command === "export-create") {
      if (args.length !== 1) throw Error("Usage: export-create PRIVATE_BODY_JSON_FILE");
      await createExport(args[0]!, env, io);
      return 0;
    }
    if (command === "export-download") {
      if (args.length !== 2) throw Error("Usage: export-download EXPORT_ID NEW_DIRECTORY");
      await downloadExport(args[0]!, args[1]!, env, io);
      return 0;
    }
    if (["api", "operator-api", "request"].includes(command)) {
      await genericApi(command, args, env, io);
      return 0;
    }
    if (Object.hasOwn(agentOperations, command)) {
      await runAgentCli(command, args, env, io);
      return 0;
    }
    if (command === "migrate") {
      const config = loadConfig(env);
      const db = createDb(config.databaseUrl);
      try {
        await migrate(db);
        io.log("Migrations applied.");
      } finally {
        await db.destroy();
      }
      return 0;
    }
    const operator = operatorCommands.has(command);
    if (!operator && !tenantCommands.has(command)) throw Error(usage);
    let token: string;
    let prefix: string;
    if (operator) {
      if (!env.OPERATOR_TOKEN || env.OPERATOR_TOKEN.length < 32)
        throw Error(
          "OPERATOR_TOKEN must contain at least 32 characters for platform commands.",
        );
      token = env.OPERATOR_TOKEN;
      prefix = "/api/v1/operator";
    } else {
      if (
        !env.TENANT_SLUG ||
        env.TENANT_SLUG.length > 100 ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(env.TENANT_SLUG)
      )
        throw Error(
          "TENANT_SLUG must be a lowercase tenant slug of at most 100 characters.",
        );
      if (
        !env.TENANT_API_KEY ||
        !/^DE-TK-[A-Za-z0-9_-]{43}$/.test(env.TENANT_API_KEY)
      )
        throw Error("A valid TENANT_API_KEY is required for tenant commands.");
      token = env.TENANT_API_KEY;
      prefix = `/api/v1/tenants/${env.TENANT_SLUG}/seller`;
    }
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
    async function request(
      path: string,
      body?: unknown,
      zip?: Buffer | {stream: Readable; size:number},
      metadata?: unknown,
    ) {
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
      };
      if (zip) {
        headers["content-type"] = command === "publish-asset" ? "application/octet-stream" : "application/zip";
        if(!Buffer.isBuffer(zip))headers["content-length"] = String(zip.size);
        headers["x-release-metadata"] = Buffer.from(
          JSON.stringify(metadata),
        ).toString("base64url");
      } else if (body !== undefined)
        headers["content-type"] = "application/json";
      const response = await fetch(`${origin.origin}${prefix}${path}`, {
        method: zip || body !== undefined ? "POST" : "GET",
        headers,
        ...(zip
          ? Buffer.isBuffer(zip) ? { body: new Uint8Array(zip) } : {body:Readable.toWeb(zip.stream) as ReadableStream<Uint8Array>,duplex:"half" as const,signal:AbortSignal.timeout(3600000)}
          : body !== undefined
            ? { body: JSON.stringify(body) }
            : {}),
        redirect: "error",
      });
      const value: unknown = await response.json();
      if (!response.ok)
        throw Error(
          `API returned ${response.status}: ${JSON.stringify(value)}`,
        );
      io.log(redact(JSON.stringify(value, null, 2)));
    }
    function required(index: number, message: string) {
      const value = args[index];
      if (!value) throw Error(message);
      return value;
    }
    function segment(value: string) {
      if (value === "." || value === "..")
        throw Error("Object IDs cannot be dot path segments.");
      return encodeURIComponent(value);
    }
    const json = async (file: string): Promise<unknown> =>
      JSON.parse((await readRegularFile(file)).toString("utf8"));
    switch (command) {
      case "features":
      case "prices":
      case "operations":
      case "webhooks":
        await request(`/${command}`);
        break;
      case "product":
        await request("/products", await json(args[0] ?? "product.json"));
        break;
      case "publish": {
        const message = "publish PRODUCT VERSION ZIP METADATA_JSON_FILE";
        const product = required(0, message),
          version = required(1, message),
          file = required(2, message),
          metadata = required(3, message);
        await request(
          `/releases/${segment(product)}/${segment(version)}`,
          undefined,
          await readRegularFile(file, 100 * 1024 * 1024),
          await json(metadata),
        );
        break;
      }
      case "publish-asset": {
        const message = "publish-asset PRODUCT VERSION FILE METADATA_JSON_FILE";
        const product = required(0, message), version = required(1, message),
          file = required(2, message), metadata = required(3, message);
        const info=await json(metadata);
        const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
        try {
          const stat=await handle.stat();
          if(!stat.isFile() || stat.size<1 || stat.size>2048*1024**2)throw Error("Native artifact must be a regular file of 1 byte to 2048 MiB.");
          const stream=handle.createReadStream({autoClose:false,start:0,end:stat.size-1});
          try {await request(`/assets/${segment(product)}/${segment(version)}`,undefined,{stream,size:stat.size},info);}
          finally {stream.destroy();}
        } finally {await handle.close();}
        break;
      }
      case "licenses":
        await request("/overview");
        break;
      case "revoke":
      case "restore":
        await request(
          `/licenses/${segment(required(0, "License ID required"))}/revoke`,
          { revoked: command === "revoke" },
        );
        break;
      case "withdraw":
        await request(
          `/releases/${segment(required(0, "Release ID required"))}/withdraw`,
          {},
        );
        break;
      case "reconcile":
        await request("/reconcile", args[0] ? { subscriptionId: args[0] } : {});
        break;
      case "jobs":
        await request("/jobs");
        break;
      case "work":
        await request("/jobs/run", {});
        break;
      case "demo-purchase":
        await request("/local/purchase", {
          planId: required(0, "demo-purchase PLAN_ID EMAIL"),
          email: required(1, "demo-purchase PLAN_ID EMAIL"),
        });
        break;
      case "tenants":
        await request("/tenants");
        break;
      case "tenant-status":
        await request(
          `/tenants/${segment(required(0, "tenant-status ID JSON_FILE"))}/status`,
          await json(required(1, "tenant-status ID JSON_FILE")),
        );
        break;
      case "tenant-owner":
        await request(
          `/tenants/${segment(required(0, "tenant-owner ID EMAIL"))}/owner`,
          { email: required(1, "tenant-owner ID EMAIL") },
        );
        break;
      case "platform-reconcile":
        await request(
          `/tenants/${segment(required(0, "platform-reconcile ID"))}/reconcile`,
          {},
        );
        break;
      case "platform-jobs":
        await request("/jobs");
        break;
      case "platform-work":
        await request("/jobs/run", {});
        break;
      case "local-tenant":
        await request(
          `/local/tenants/${segment(required(0, "local-tenant ID JSON_FILE"))}`,
          await json(required(1, "local-tenant ID JSON_FILE")),
        );
        break;
    }
    return 0;
  } catch (error) {
    io.error(
      redact(error instanceof Error ? error.message : "Command failed."),
    );
    return 1;
  }
}
if (import.meta.main) process.exitCode = await runCli();
