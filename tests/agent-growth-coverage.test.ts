import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCli } from "../src/cli.ts";
import { createMcpServer } from "../src/mcp.ts";

const tenant = "/api/v1/tenants/primary";
const seller = `${tenant}/seller`;
const licenseId = "a3a25a94-32f8-4cfb-92d8-339a8f5a39db";
const csv = "id,status\r\nlicense,expired\r\n";
const json = '{"ok":true}';
const filters = {
  productId: "product-1",
  provenance: "complimentary",
  status: "expired",
  expiringWithinDays: 30,
  q: "  A+B & C / #?  ",
};
const filterQuery =
  "productId=product-1&provenance=complimentary&status=expired&expiringWithinDays=30&q=A%2BB+%26+C+%2F+%23%3F";
const events = [
  "license.created",
  "license.renewed",
  "license.revoked",
  "license.canceled",
  "license.expired",
  "activation.changed",
  "release.published",
  "release.withdrawn",
  "alert.raised",
];
const buyer = { planId: "plan-lifetime", email: "buyer@example.test" };

test("licensing and growth operations work through CLI and MCP over HTTP", async (t) => {
  const dir = await mkdtemp("/Volumes/Scratch/entitle/tmp/agent-growth-");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: Array<{
    method: string;
    path: string;
    body: unknown;
    authorization: string | undefined;
    cookie: string | undefined;
    csrf: string | string[] | undefined;
  }> = [];
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    calls.push({
      method: req.method!,
      path: req.url!,
      body: body ? JSON.parse(body) : undefined,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
      csrf: req.headers["x-csrf-token"],
    });
    const isCsv = req.url?.startsWith(`${seller}/licenses/export?format=csv`);
    res.setHeader("content-type", isCsv ? "text/csv" : "application/json");
    res.end(isCsv ? csv : json);
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const env = {
    PUBLIC_ORIGIN: `http://127.0.0.1:${(http.address() as { port: number }).port}`,
    TENANT_SLUG: "primary",
    TENANT_API_KEY: `DE-TK-${"a".repeat(43)}`,
  };
  const requestCredentials = {
    "checkout-create": {
      ENTITLE_COOKIE: `de-session-primary=${"b".repeat(43)}`,
      ENTITLE_CSRF_TOKEN: "buyer-csrf",
    },
    "commerce-settings-update": {
      ENTITLE_COOKIE: `de-seller-session=${"c".repeat(43)}`,
      ENTITLE_CSRF_TOKEN: "seller-csrf",
    },
  } as Record<string, { ENTITLE_COOKIE: string; ENTITLE_CSRF_TOKEN: string }>;
  const mcp = createMcpServer();
  const client = new Client({ name: "licensing-growth-test", version: "1" });
  t.after(async () => {
    await client.close();
    await mcp.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const updateTool = tools.find(
    (tool) => tool.name === "entitle_op_license_update",
  );
  await t.test(
    "MCP advertises the refined update object and mutation hint",
    () => {
      assert.ok(updateTool);
      assert.equal(updateTool.inputSchema.type, "object");
      assert.equal(updateTool.inputSchema.additionalProperties, false);
      assert.deepEqual(updateTool.inputSchema.required, ["id"]);
      assert.deepEqual(
        Object.keys(updateTool.inputSchema.properties ?? {}).sort(),
        ["expiresAt", "id", "internalNote", "siteAllowance"],
      );
      assert.deepEqual(updateTool.inputSchema.properties?.internalNote, {
        anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }],
      });
      assert.equal(updateTool.annotations?.destructiveHint, true);
    },
  );

  type Input = Record<string, unknown>;
  const adapters = {
    CLI: async (command: string, input?: Input) => {
      const args = [command];
      if (input) {
        const inputFile = join(dir, "input.json");
        await writeFile(inputFile, JSON.stringify(input), { mode: 0o600 });
        args.push(inputFile);
      }
      const lines: string[] = [];
      const code = await runCli(
        args,
        { ...env, ...requestCredentials[command] },
        {
          log: (line: string) => lines.push(line),
          error: (line: string) => lines.push(line),
        },
      );
      return { ok: code === 0, text: lines.join("\n") };
    },
    MCP: async (command: string, input?: Input) => {
      const originalEnv = process.env;
      process.env = { ...env, ...requestCredentials[command] };
      try {
        const result = await client.callTool({
          name: `entitle_op_${command.replaceAll("-", "_")}`,
          ...(input ? { arguments: input } : {}),
        });
        assert.ok(Array.isArray(result.content));
        const content = result.content[0];
        assert.equal(content?.type, "text");
        return { ok: !result.isError, text: content.text as string };
      } finally {
        process.env = originalEnv;
      }
    },
  };

  for (const [adapter, call] of Object.entries(adapters)) {
    await t.test(
      `${adapter} sends the documented methods, routes and payloads`,
      async () => {
        const csvFile = join(dir, `${adapter}.csv`);
        const jsonFile = join(dir, `${adapter}.json`);
        const settings = {
          automaticTax: true,
          collectTaxId: false,
          collectBillingAddress: true,
          allowPromotionCodes: true,
        };
        const timing = { expiresAt: 1893456000000, siteAllowance: 5 };
        const checkout = {
          ...buyer,
          uiMode: "elements",
          renewLicenseId: licenseId,
        };
        const webhook = { url: "https://hooks.example.test/entitle", events };
        const cases: [string, Input | undefined, string, string, Input?][] = [
          ["promotions-list", undefined, "GET", `${seller}/promotions`],
          ["licenses-list", undefined, "GET", `${seller}/licenses`],
          [
            "licenses-list",
            { ...filters, limit: 500, after: "license-2" },
            "GET",
            `${seller}/licenses?${filterQuery}&limit=500&after=license-2`,
          ],
          [
            "licenses-export",
            { ...filters, format: "csv", output: csvFile },
            "GET",
            `${seller}/licenses/export?format=csv&${filterQuery}`,
          ],
          [
            "licenses-export",
            { format: "json", output: jsonFile },
            "GET",
            `${seller}/licenses/export?format=json`,
          ],
          [
            "license-update",
            { id: licenseId, internalNote: null },
            "PATCH",
            `${seller}/licenses/${licenseId}`,
            { internalNote: null },
          ],
          [
            "license-update",
            { id: licenseId, ...timing },
            "PATCH",
            `${seller}/licenses/${licenseId}`,
            timing,
          ],
          [
            "license-update",
            { id: licenseId, internalNote: "  Renewing pilot  " },
            "PATCH",
            `${seller}/licenses/${licenseId}`,
            { internalNote: "Renewing pilot" },
          ],
          ["analytics", undefined, "GET", `${seller}/analytics`],
          [
            "checkout-create",
            { ...checkout, promotionCode: "  SAVE-20_24  " },
            "POST",
            `${tenant}/checkout`,
            { ...checkout, promotionCode: "SAVE-20_24" },
          ],
          ["checkout-create", buyer, "POST", `${tenant}/checkout`, buyer],
          [
            "commerce-settings-update",
            { settings },
            "PUT",
            `${seller}/commerce/settings`,
            settings,
          ],
          ["webhook-create", webhook, "POST", `${seller}/webhooks`, webhook],
        ];
        for (const [command, input, method, path, body] of cases) {
          const before = calls.length;
          const result = await call(command, input);
          assert.equal(result.ok, true, `${command}: ${result.text}`);
          const credentials = requestCredentials[command];
          assert.deepEqual(calls.slice(before), [
            {
              method,
              path,
              body,
              authorization: credentials
                ? undefined
                : `Bearer ${env.TENANT_API_KEY}`,
              cookie: credentials?.ENTITLE_COOKIE,
              csrf: credentials?.ENTITLE_CSRF_TOKEN,
            },
          ]);
          assert.deepEqual(
            JSON.parse(result.text),
            input?.output ? { saved: input.output, status: 200 } : { ok: true },
          );
        }
        assert.equal(await readFile(csvFile, "utf8"), csv);
        assert.equal(await readFile(jsonFile, "utf8"), json);
        assert.equal((await stat(csvFile)).mode & 0o777, 0o600);
        assert.equal((await stat(jsonFile)).mode & 0o777, 0o600);
        const before = calls.length;
        const result = await call("licenses-export", {
          format: "json",
          output: csvFile,
        });
        assert.equal(result.ok, false);
        assert.equal(await readFile(csvFile, "utf8"), csv);
        assert.equal(calls.length, before);
      },
    );

    await t.test(
      `${adapter} rejects invalid growth inputs before HTTP dispatch`,
      async () => {
        const invalid: [string, Input][] = [
          ["promotions-list", { unknown: true }],
          ["licenses-list", { status: "unknown" }],
          ["licenses-list", { expiringWithinDays: 91 }],
          ["licenses-list", { limit: 501 }],
          ["licenses-export", { format: "csv" }],
          [
            "licenses-export",
            { output: join(dir, "invalid"), after: "license-2" },
          ],
          ["license-update", { id: licenseId }],
          ["license-update", { id: licenseId, expiresAt: 8640000000000001 }],
          ["license-update", { id: licenseId, siteAllowance: 0 }],
          ["analytics", { unknown: true }],
          ["checkout-create", { ...buyer, promotionCode: "SAVE 20" }],
          ["checkout-create", { ...buyer, renewLicenseId: "not-a-uuid" }],
          [
            "commerce-settings-update",
            { settings: { allowPromotionCodes: true } },
          ],
          [
            "webhook-create",
            {
              url: "https://hooks.example.test",
              events: [...events, events[0]],
            },
          ],
        ];
        const before = calls.length;
        for (const [command, input] of invalid) {
          const result = await call(command, input);
          assert.equal(result.ok, false, command);
          if (command === "license-update" && Object.keys(input).length === 1)
            assert.match(result.text, /Provide at least one field to update/);
        }
        assert.equal(calls.length, before);
      },
    );
  }
});
