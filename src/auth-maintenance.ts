import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { createDb, migrate } from "./db.ts";
import { check, AppError } from "./errors.ts";
import { hash, unseal } from "./crypto.ts";
import { AuthProvisioner } from "./auth-recovery.ts";

// Protected host/database access is required; intentionally absent from CLI/MCP remote operations.
export async function authMaintenance(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      quiesced: { type: "boolean" },
      operator: { type: "string" },
      reference: { type: "string" },
      user: { type: "string" },
      factor: { type: "string" },
      fingerprint: { type: "string" },
      inventory: { type: "string" },
      flow: { type: "string" },
      output: { type: "string" },
    },
  });
  check(
    values.quiesced &&
      values.operator &&
      values.reference &&
      positionals.length === 1,
    400,
    "maintenance_usage",
    "Supply one command, --quiesced, --operator and --reference.",
  );
  const config = loadConfig(env),
    db = createDb(config.databaseUrl);
  try {
    await migrate(db);
    const root = new AuthProvisioner(db, config.secret);
    switch (positionals[0]) {
      case "inventory": {
        check(values.user, 400, "maintenance_usage", "Supply --user.");
        const rows = await db("seller_factors").where({ user_id: values.user });
        return {
          credentials: rows.map((f) => ({
            id: f.id,
            name: f.name,
            publicKeyHash: hash(
              unseal<{ publicKey: string }>(f.payload, config.secret).publicKey,
            ),
            backupEligible: f.backup_eligible,
            userVerified: f.user_verified,
            recoveryId: f.recovery_id,
          })),
        };
      }
      case "approve":
        return await root.approve({
          userId: values.user ?? "",
          factorId: values.factor ?? "",
          publicKeyHash: values.fingerprint ?? "",
          inventoryId: values.inventory ?? "",
          operator: values.operator,
          reference: values.reference,
        });
      case "recovery-start": {
        check(
          values.user && values.output,
          400,
          "maintenance_usage",
          "Supply --user and a new private --output file.",
        );
        // Reserve the destination before changing recovery state; never overwrite a saved ticket.
        const file = await open(values.output, "wx", 0o600);
        try {
          const flow = await root.start(
            values.user,
            values.operator,
            values.reference,
          );
          await file.writeFile(JSON.stringify({ token: flow.permit }) + "\n");
          await file.sync();
          return {
            flowId: flow.id,
            notBefore: flow.notBefore,
            authorizationFile: values.output,
          };
        } finally {
          await file.close();
        }
      }
      case "recovery-complete":
        check(values.flow, 400, "maintenance_usage", "Supply --flow.");
        return await root.complete(
          values.flow,
          values.operator,
          values.reference,
        );
      default:
        check(
          false,
          400,
          "maintenance_usage",
          "Choose inventory, approve, recovery-start or recovery-complete.",
        );
    }
  } finally {
    await db.destroy();
  }
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await authMaintenance(process.argv.slice(2))));
  } catch (e) {
    console.error(
      JSON.stringify({
        error: e instanceof AppError ? e.code : "maintenance_failed",
      }),
    );
    process.exitCode = 1;
  }
}
