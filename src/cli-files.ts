import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Reject special files before reading so FIFOs cannot block agent tools. */
export async function readRegularFile(
  path: string,
  maxBytes = 1024 * 1024,
): Promise<Buffer> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw Error("Input must be a regular file within the size limit.");
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw Error("Input exceeds the size limit.");
    return bytes;
  } finally {
    await handle.close();
  }
}
