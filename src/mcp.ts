import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { runCli } from "./cli.ts";
import { genericApi } from "./cli-api.ts";
import { z } from "zod";
import { agentOperations, runAgentOperation } from "./agent-operations.ts";
import { createExport, downloadExport } from "./agent-export.ts";
import {
  loginStart,
  loginFinish,
  refreshSession,
  consumeVerification,
  activateInstallation,
  buyerLoginStart,
  buyerLoginFinish,
  refreshBuyerSession,
} from "./agent-session.ts";

const commands: Record<string, string> = {
  product: "Save a product and its plans: [JSON_FILE].",
  publish:
    "Publish a WordPress release: [PRODUCT, VERSION, ZIP_FILE, METADATA_JSON_FILE].",
  "publish-asset":
    "Publish a native asset: [PRODUCT, VERSION, FILE, METADATA_JSON_FILE].",
  licenses:
    "Read seller overview, including products, licenses and releases: [].",
  revoke: "Revoke a license: [LICENSE_ID].",
  restore: "Restore a manually revoked license: [LICENSE_ID].",
  withdraw: "Withdraw a release: [RELEASE_ID].",
  reconcile: "Queue billing reconciliation: [optional SUBSCRIPTION_ID].",
  jobs: "List tenant jobs: [].",
  work: "Run a bounded batch of tenant jobs: [].",
  "demo-purchase": "Create a local billing fixture: [PLAN_ID, EMAIL].",
  features: "Read available workspace features: [].",
  prices: "List available prices: [].",
  operations: "Read operational status: [].",
  webhooks: "List webhooks and deliveries: [].",
  tenants: "List platform tenants with the operator token: [].",
  "tenant-status": "Update tenant status: [TENANT_ID, JSON_FILE].",
  "tenant-owner": "Assign tenant owner: [TENANT_ID, EMAIL].",
  "platform-reconcile": "Queue platform reconciliation: [TENANT_ID].",
  "platform-jobs": "List platform jobs: [].",
  "platform-work": "Run a bounded platform job batch: [].",
  "local-tenant": "Set a local fixture tenant: [TENANT_ID, JSON_FILE].",
  api: "Call a seller API route with the configured tenant key: [METHOD, /PATH, optional --body JSON_FILE, --upload FILE, --metadata JSON_FILE, --output FILE]. See docs/api.md for routes and scopes.",
  "operator-api":
    "Call an operator API route with the configured operator token. Arguments are the same as api.",
  request:
    "Call any /api/v1/ route with explicitly configured ENTITLE_AUTHORIZATION or ENTITLE_COOKIE and CSRF/verification environment. Arguments are the same as api. Interactive routes retain session and verification requirements.",
};

function toolError(error: unknown, fallback: string) {
  let message = error instanceof Error ? error.message : fallback;
  for (const secret of [
    process.env.TENANT_API_KEY,
    process.env.OPERATOR_TOKEN,
    process.env.ENTITLE_AUTHORIZATION,
    process.env.ENTITLE_COOKIE,
    process.env.ENTITLE_CSRF_TOKEN,
    process.env.ENTITLE_VERIFICATION,
    process.env.APP_SECRET,
  ])
    if (secret) message = message.split(secret).join("[redacted]");
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function createMcpServer() {
  const server = new Server(
    { name: "entitle", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "entitle_buyer_login_start",
        description:
          "Request a buyer email login link. A generic response does not disclose whether the account exists.",
        inputSchema: {
          type: "object" as const,
          properties: { email: { type: "string", format: "email" } },
          required: ["email"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_buyer_login_finish",
        description:
          "Complete buyer login using an owner-only token file; save the session to a new private file bound to origin and tenant.",
        inputSchema: {
          type: "object" as const,
          properties: {
            tokenFile: { type: "string" },
            sessionFile: { type: "string" },
          },
          required: ["tokenFile", "sessionFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_buyer_session_refresh",
        description:
          "Validate a private buyer session and its current CSRF value without rewriting the file.",
        inputSchema: {
          type: "object" as const,
          properties: { sessionFile: { type: "string" } },
          required: ["sessionFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_owner_login_start",
        description:
          "Start email sign-in and save the browser-bound pre-auth cookie to a new private file.",
        inputSchema: {
          type: "object" as const,
          properties: {
            email: { type: "string", format: "email" },
            preauthFile: { type: "string" },
          },
          required: ["email", "preauthFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_owner_login_finish",
        description:
          "Complete email sign-in with a private token file and save a new private session file. Never put the token in a tool argument.",
        inputSchema: {
          type: "object" as const,
          properties: {
            preauthFile: { type: "string" },
            tokenFile: { type: "string" },
            sessionFile: { type: "string" },
          },
          required: ["preauthFile", "tokenFile", "sessionFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_owner_session_refresh",
        description:
          "Validate a private owner session and its current CSRF value without rewriting the file.",
        inputSchema: {
          type: "object" as const,
          properties: { sessionFile: { type: "string" } },
          required: ["sessionFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_owner_verification_consume",
        description:
          "Consume an emailed verification token using an owner-only JSON file and save the one-use proof to a new private file.",
        inputSchema: {
          type: "object" as const,
          properties: {
            bodyFile: { type: "string" },
            proofFile: { type: "string" },
          },
          required: ["bodyFile", "proofFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_activation_create",
        description:
          "Activate an installation using an owner-only input JSON file containing the license key; write the activation token to a new private file.",
        inputSchema: {
          type: "object" as const,
          properties: {
            bodyFile: { type: "string" },
            activationFile: { type: "string" },
          },
          required: ["bodyFile", "activationFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_export_create",
        description:
          "Create an encrypted workspace export using an owner-only JSON file containing the passphrase. The file is read by the MCP server; the passphrase never enters tool arguments.",
        inputSchema: {
          type: "object" as const,
          properties: { bodyFile: { type: "string" } },
          required: ["bodyFile"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      {
        name: "entitle_export_download",
        description:
          "Download the encrypted manifest and every blob into a new private directory. A failure leaves a partial directory for inspection.",
        inputSchema: {
          type: "object" as const,
          properties: {
            id: { type: "string", format: "uuid" },
            directory: { type: "string" },
          },
          required: ["id", "directory"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      ...Object.entries(agentOperations).map(([name, operation]) => ({
        name: `entitle_op_${name.replaceAll("-", "_")}`,
        description: operation.description,
        inputSchema: z.toJSONSchema(operation.schema) as {
          type: "object";
          [key: string]: unknown;
        },
        annotations: {
          readOnlyHint: operation.readOnly === true,
          destructiveHint: operation.readOnly !== true,
          openWorldHint: true,
        },
      })),
      ...Object.entries(commands).map(([name, description]) => ({
        name: `entitle_${name.replaceAll("-", "_")}`,
        description,
        inputSchema: {
          type: "object" as const,
          properties: {
            args: {
              type: "array",
              items: { type: "string" },
              maxItems: 20,
              description:
                "CLI arguments in order. Never put credentials or passphrases in arguments.",
            },
          },
          required: ["args"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: [
            "licenses",
            "jobs",
            "features",
            "prices",
            "operations",
            "webhooks",
            "tenants",
            "platform-jobs",
          ].includes(name),
          destructiveHint: ["revoke", "withdraw"].includes(name),
          openWorldHint: true,
        },
      })),
      ...["seller", "operator"].map((kind) => ({
        name: `entitle_${kind}_request`,
        description: `Call a ${kind} API JSON endpoint with configured ${kind} credentials. Provide a relative API path and optional JSON object body. Export passphrases must be supplied through an owner-only file using entitle_api.`,
        inputSchema: {
          type: "object" as const,
          properties: {
            method: {
              type: "string",
              enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
            },
            path: { type: "string" },
            body: { type: "object" },
          },
          required: ["method", "path"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
      })),
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (
      [
        "entitle_buyer_login_start",
        "entitle_buyer_login_finish",
        "entitle_buyer_session_refresh",
      ].includes(request.params.name)
    ) {
      const lines: string[] = [];
      const io = {
        log: (line: string) => lines.push(line),
      };
      const path = z.string().min(1).max(4096);
      try {
        if (request.params.name === "entitle_buyer_login_start") {
          const v = z
            .object({ email: z.email().max(254) })
            .strict()
            .parse(request.params.arguments);
          await buyerLoginStart(v.email, process.env, io);
        } else if (request.params.name === "entitle_buyer_login_finish") {
          const v = z
            .object({ tokenFile: path, sessionFile: path })
            .strict()
            .parse(request.params.arguments);
          await buyerLoginFinish(v.tokenFile, v.sessionFile, process.env, io);
        } else {
          const v = z
            .object({ sessionFile: path })
            .strict()
            .parse(request.params.arguments);
          await refreshBuyerSession(v.sessionFile, process.env);
          io.log(JSON.stringify({ sessionFile: v.sessionFile }));
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return toolError(error, "Buyer operation failed.");
      }
    }
    if (
      [
        "entitle_owner_login_start",
        "entitle_owner_login_finish",
        "entitle_owner_session_refresh",
        "entitle_owner_verification_consume",
        "entitle_activation_create",
      ].includes(request.params.name)
    ) {
      const input = request.params.arguments;
      const lines: string[] = [];
      const io = {
        log: (line: string) => lines.push(line),
      };
      const path = z.string().min(1).max(4096);
      try {
        if (request.params.name === "entitle_owner_login_start") {
          const v = z
            .object({ email: z.email().max(254), preauthFile: path })
            .strict()
            .parse(input);
          await loginStart(v.email, v.preauthFile, process.env, io);
        } else if (request.params.name === "entitle_owner_login_finish") {
          const v = z
            .object({ preauthFile: path, tokenFile: path, sessionFile: path })
            .strict()
            .parse(input);
          await loginFinish(
            v.preauthFile,
            v.tokenFile,
            v.sessionFile,
            process.env,
            io,
          );
        } else if (request.params.name === "entitle_owner_session_refresh") {
          const v = z.object({ sessionFile: path }).strict().parse(input);
          await refreshSession(v.sessionFile, process.env);
          io.log(JSON.stringify({ sessionFile: v.sessionFile }));
        } else if (
          request.params.name === "entitle_owner_verification_consume"
        ) {
          const v = z
            .object({ bodyFile: path, proofFile: path })
            .strict()
            .parse(input);
          await consumeVerification(v.bodyFile, v.proofFile, process.env, io);
        } else {
          const v = z
            .object({ bodyFile: path, activationFile: path })
            .strict()
            .parse(input);
          await activateInstallation(
            v.bodyFile,
            v.activationFile,
            process.env,
            io,
          );
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return toolError(error, "Owner operation failed.");
      }
    }
    if (
      request.params.name === "entitle_export_create" ||
      request.params.name === "entitle_export_download"
    ) {
      const input = request.params.arguments;
      const schema =
        request.params.name === "entitle_export_create"
          ? z.object({ bodyFile: z.string().min(1).max(4096) }).strict()
          : z
              .object({
                id: z.string().uuid(),
                directory: z.string().min(1).max(4096),
              })
              .strict();
      const lines: string[] = [];
      try {
        const value = schema.parse(input);
        const io = {
          log: (line: string) => lines.push(line),
        };
        if ("bodyFile" in value)
          await createExport(value.bodyFile, process.env, io);
        else await downloadExport(value.id, value.directory, process.env, io);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return toolError(error, "Export failed.");
      }
    }
    const operation = Object.keys(agentOperations).find(
      (key) => `entitle_op_${key.replaceAll("-", "_")}` === request.params.name,
    );
    if (operation) {
      const lines: string[] = [];
      try {
        await runAgentOperation(
          operation,
          request.params.arguments ?? {},
          process.env,
          {
            log: (line: string) => lines.push(line),
          },
        );
        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (error) {
        return toolError(error, "Request failed.");
      }
    }
    if (
      request.params.name === "entitle_seller_request" ||
      request.params.name === "entitle_operator_request"
    ) {
      const input = request.params.arguments;
      if (
        !input ||
        Object.keys(input).some(
          (key) => !["method", "path", "body"].includes(key),
        ) ||
        typeof input.method !== "string" ||
        typeof input.path !== "string" ||
        (input.body !== undefined &&
          (!input.body ||
            typeof input.body !== "object" ||
            Array.isArray(input.body)))
      )
        return {
          isError: true,
          content: [{ type: "text", text: "Invalid request arguments." }],
        };
      const lines: string[] = [];
      try {
        await genericApi(
          request.params.name === "entitle_seller_request"
            ? "api"
            : "operator-api",
          [input.method, input.path],
          process.env,
          {
            log: (line: string) => lines.push(line),
          },
          input.body as Record<string, unknown> | undefined,
        );
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (error) {
        return toolError(error, "Request failed.");
      }
    }
    const command = Object.keys(commands).find(
      (key) => `entitle_${key.replaceAll("-", "_")}` === request.params.name,
    );
    const input = request.params.arguments;
    if (
      !command ||
      !input ||
      Object.keys(input).some((key) => key !== "args") ||
      !Array.isArray(input.args) ||
      input.args.length > 20 ||
      !input.args.every((arg) => typeof arg === "string" && arg.length <= 4096)
    )
      return {
        isError: true,
        content: [{ type: "text", text: "Invalid tool or arguments." }],
      };
    const lines: string[] = [];
    const status = await runCli(
      [command, ...(input.args as string[])],
      process.env,
      {
        log: (line: string) => lines.push(line),
        error: (line: string) => lines.push(line),
      },
    );
    return {
      ...(status ? { isError: true } : {}),
      content: [
        {
          type: "text",
          text: lines.join("\n"),
        },
      ],
    };
  });
  return server;
}

export async function startMcp() {
  await createMcpServer().connect(new StdioServerTransport());
}

if (import.meta.main) await startMcp();
