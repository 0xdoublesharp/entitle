import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { genericApi } from "./cli-api.ts";

const exportId = z.string().uuid();
const entry = z
  .object({
    id: exportId,
    status: z.string(),
    blobs: z.array(exportId).max(10000),
  })
  .passthrough();

export async function createExport(
  bodyFile: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  if (!bodyFile)
    throw Error(
      "An owner-only JSON body file containing the export passphrase is required.",
    );
  await genericApi("api", ["POST", "/exports", "--body", bodyFile], env, io);
}

export async function downloadExport(
  id: string,
  directory: string,
  env: NodeJS.ProcessEnv,
  io: Pick<Console, "log">,
) {
  exportId.parse(id);
  if (!directory) throw Error("A new private output directory is required.");
  const lines: string[] = [];
  await genericApi("api", ["GET", "/exports"], env, {
    log: (line: string) => lines.push(line),
  });
  const listing = z
    .object({ exports: z.array(entry).max(10) })
    .parse(JSON.parse(lines.join("\n")));
  const found = listing.exports.find((item) => item.id === id);
  if (!found || found.status !== "ready")
    throw Error("Export is not ready or not accessible in this workspace.");
  if (new Set(found.blobs).size !== found.blobs.length)
    throw Error("Export has duplicate blob identifiers.");
  await mkdir(directory, { mode: 0o700 });
  const quiet = { log: () => {} };
  try {
    await genericApi(
      "api",
      [
        "GET",
        `/exports/${id}/manifest`,
        "--output",
        join(directory, "manifest.entitle"),
      ],
      env,
      quiet,
    );
    for (const blob of found.blobs)
      await genericApi(
        "api",
        [
          "GET",
          `/exports/${id}/blobs/${blob}`,
          "--output",
          join(directory, `${blob}.blob`),
        ],
        env,
        quiet,
      );
  } catch (error) {
    throw Error(
      `Export download incomplete in ${directory}; inspect the partial directory and export ${id} before retrying. ${error instanceof Error ? error.message : "Download failed."}`,
      { cause: error },
    );
  }
  io.log(JSON.stringify({ id, directory, blobs: found.blobs.length }));
}
