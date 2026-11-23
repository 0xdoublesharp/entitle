import { z } from "zod";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { crc32, createGunzip } from "node:zlib";
import yauzl from "yauzl";
import { Readable } from "node:stream";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { AppError, check } from "./errors.ts";
import {
  frameworkTargets,
  type Framework,
  type FrameworkConfig,
} from "./frameworks.ts";

const metadataSchema = z
  .object({
    target: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/),
    changelog: z.string().max(6000),
    signature: z.string().min(1).max(2048).optional(),
    minSystemVersion: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/)
      .optional(),
  })
  .strict();
export type AssetMetadata = z.infer<typeof metadataSchema>;
function base64(value: string, size: number) {
  const decoded = Buffer.from(value, "base64");
  return decoded.length === size && decoded.toString("base64") === value;
}
function minisign(value: string) {
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return false;
  const lines = decoded
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\n$/, "")
    .split("\n");
  if (lines.length !== 4) return false;
  return (
    /^untrusted comment: [^\n]+$/.test(lines[0]!) &&
    base64(lines[1]!, 74) &&
    /^(?:Ed|ED)$/.test(
      Buffer.from(lines[1]!, "base64").subarray(0, 2).toString("ascii"),
    ) &&
    /^trusted comment: [^\n]+$/.test(lines[2]!) &&
    base64(lines[3]!, 64)
  );
}
export function validateAssetMetadata(
  framework: Framework,
  value: unknown,
): AssetMetadata {
  check(
    framework !== "wordpress",
    400,
    "framework_mismatch",
    "WordPress uses the ZIP release endpoint.",
  );
  const metadata = metadataSchema.parse(value);
  check(
    framework === "generic" ||
      (frameworkTargets[framework] as readonly string[]).includes(
        metadata.target,
      ),
    400,
    "invalid_target",
    "Unsupported framework target.",
  );
  const file = metadata.filename;
  const extensions =
    framework === "joomla"
      ? [".zip"]
      : framework === "jetbrains"
        ? [".zip", ".jar"]
        : framework === "generic"
          ? []
          : metadata.target.startsWith("windows-")
            ? framework === "tauri"
              ? [".exe", ".msi", ".nsis.zip", ".msi.zip"]
              : [".exe", ".zip"]
            : metadata.target.startsWith("linux-")
              ? framework === "tauri"
                ? [".AppImage", ".AppImage.tar.gz"]
                : [".AppImage", ".AppImage.tar.gz", ".tar.gz", ".deb", ".rpm"]
              : framework === "tauri"
                ? [".app.tar.gz"]
                : [".zip", ".dmg", ".pkg", ".tar.gz"];
  check(
    framework === "generic" ||
      extensions.some((extension) => file.endsWith(extension)),
    400,
    "invalid_filename",
    "Unsupported package filename for this target.",
  );
  check(
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(file),
    400,
    "invalid_filename",
    "Unsafe package filename.",
  );
  if (framework === "sparkle" || framework === "tauri")
    check(
      metadata.signature !== undefined &&
        (framework === "sparkle"
          ? base64(metadata.signature, 64)
          : minisign(metadata.signature)),
      400,
      "invalid_signature",
      "A well-formed detached updater signature is required.",
    );
  return metadata;
}
const MAX_EXPANDED = 250 * 1024 * 1024;
function safePath(name: string) {
  const clean = name.replace(/\/$/, "");
  return (
    name.length <= 1000 &&
    !/[\p{Cc}:\\]/u.test(name) &&
    !name.startsWith("/") &&
    clean
      .split("/")
      .every(
        (segment) =>
          segment !== "" &&
          segment !== "." &&
          segment !== ".." &&
          !/[. ]$/.test(segment) &&
          !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)[ .]*(?:\.|$)/i.test(
            segment,
          ),
      )
  );
}
type Entry = { name: string; bytes: Buffer; link?: string };
function canonicalPath(path: string) {
  return path.normalize("NFC").toLowerCase().replace(/\/$/, "");
}
function linkTarget(name: string, target: string) {
  check(
    Buffer.byteLength(target) <= 1000 &&
      target.length > 0 &&
      !/[\p{Cc}:\\]/u.test(target) &&
      !target.startsWith("/"),
    400,
    "invalid_package",
    "Unsafe symbolic link target.",
  );
  const parts = name.split("/").slice(0, -1);
  let descending = false;
  for (const part of target.split("/")) {
    if (part === "." && !descending) continue;
    if (part === ".." && !descending) {
      check(
        parts.length > 1,
        400,
        "invalid_package",
        "Symbolic link escapes its bundle.",
      );
      parts.pop();
    } else {
      check(
        safePath(part),
        400,
        "invalid_package",
        "Unsafe symbolic link path.",
      );
      parts.push(part);
      descending = true;
    }
  }
  check(
    parts[0] === name.split("/")[0],
    400,
    "invalid_package",
    "Symbolic link escapes its bundle.",
  );
  return parts.join("/");
}
function verifyLinks(entries: { name: string; link?: string }[]) {
  const names = new Map(
    entries.map((entry) => [canonicalPath(entry.name), entry]),
  );
  const existing = new Set<string>();
  for (const name of names.keys()) {
    const parts = name.split("/");
    for (let i = 1; i <= parts.length; i++)
      existing.add(parts.slice(0, i).join("/"));
  }
  for (const entry of entries) {
    const parts = canonicalPath(entry.name).split("/");
    for (let i = 1; i < parts.length; i++)
      check(
        !names.get(parts.slice(0, i).join("/"))?.link,
        400,
        "invalid_package",
        "Archive entry descends through a symbolic link.",
      );
    if (entry.link === undefined) continue;
    let target = canonicalPath(entry.link);
    const visited = new Set<string>();
    while (true) {
      check(
        !visited.has(target) && visited.size < 32,
        400,
        "invalid_package",
        "Symbolic link cycle or depth limit.",
      );
      visited.add(target);
      const components = target.split("/");
      let next: string | undefined;
      for (let i = 1; i <= components.length; i++) {
        const node = names.get(components.slice(0, i).join("/"));
        if (node?.link !== undefined) {
          next = canonicalPath([node.link, ...components.slice(i)].join("/"));
          break;
        }
      }
      if (next === undefined) {
        check(
          existing.has(target) &&
            !canonicalPath(entry.name).startsWith(`${target}/`),
          400,
          "invalid_package",
          "Dangling symbolic link.",
        );
        break;
      }
      target = next;
    }
  }
}
type Budget = {
  count: number;
  total: number;
  retained: number;
  limit: number;
  expanded: number;
  deadline: number;
};
function archive(
  bytes: Buffer | string,
  budget: Budget,
  retain?: "joomla" | "jetbrains",
  allowLinks = false,
): Promise<Entry[]> {
  return new Promise((resolve, reject) => {
    const load =
      typeof bytes === "string"
        ? (callback: (error: Error | null, zip: yauzl.ZipFile) => void) =>
            yauzl.open(
              bytes,
              {
                lazyEntries: true,
                validateEntrySizes: true,
                strictFileNames: true,
              },
              callback,
            )
        : (callback: (error: Error | null, zip: yauzl.ZipFile) => void) =>
            yauzl.fromBuffer(
              bytes,
              {
                lazyEntries: true,
                validateEntrySizes: true,
                strictFileNames: true,
              },
              callback,
            );
    load((error, zip) => {
      if (error || !zip) {
        reject(error ?? Error("Invalid ZIP"));
        return;
      }
      const entries: Entry[] = [],
        names = new Set<string>();
      let active: Readable | undefined;
      const timer = setTimeout(
        () => fail(Error("Archive validation timed out.")),
        Math.max(1, budget.deadline - Date.now()),
      );
      const fail = (error: Error) => {
        clearTimeout(timer);
        active?.destroy();
        zip.close();
        reject(error);
      };
      zip.on("error", fail);
      zip.on("end", () => {
        clearTimeout(timer);
        try {
          check(
            entries.some((entry) => !entry.name.endsWith("/")),
            400,
            "invalid_package",
            "Empty archive",
          );
          if (allowLinks) verifyLinks(entries);
          resolve(entries);
        } catch (error) {
          reject(error);
        }
      });
      zip.on("entry", (entry: yauzl.Entry) => {
        budget.count++;
        budget.total += entry.uncompressedSize;
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        const symbolic = allowLinks && mode === 0xa000;
        const normalized = canonicalPath(entry.fileName);
        if (
          budget.count > 2000 ||
          budget.total > budget.expanded ||
          entry.isEncrypted() ||
          entry.uncompressedSize > Math.max(1024, entry.compressedSize * 100) ||
          !safePath(entry.fileName) ||
          names.has(normalized) ||
          ![
            0,
            entry.fileName.endsWith("/") ? 0x4000 : 0x8000,
            ...(symbolic ? [0xa000] : []),
          ].includes(mode)
        ) {
          fail(Error("Unsafe archive"));
          return;
        }
        names.add(normalized);
        if (entry.fileName.endsWith("/")) {
          if (entry.uncompressedSize !== 0 || entry.crc32 !== 0) {
            fail(Error("Invalid directory"));
            return;
          }
          entries.push({ name: entry.fileName, bytes: Buffer.alloc(0) });
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail(error ?? Error("Invalid stream"));
            return;
          }
          active = stream;
          const capture =
            symbolic ||
            (retain !== undefined &&
              (entry.fileName.endsWith(".xml") ||
                (retain === "jetbrains" && entry.fileName.endsWith(".jar"))));
          if (
            capture &&
            (budget.retained + entry.uncompressedSize > budget.limit ||
              (entry.fileName.endsWith(".xml") &&
                entry.uncompressedSize > 256 * 1024) ||
              (symbolic && entry.uncompressedSize > 1000))
          ) {
            stream.destroy();
            fail(Error("Manifest memory limit"));
            return;
          }
          if (capture) budget.retained += entry.uncompressedSize;
          const chunks: Buffer[] = [];
          let checksum = 0,
            length = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            length += chunk.length;
            checksum = crc32(chunk, checksum);
            if (capture) chunks.push(chunk);
          });
          stream.on("end", () => {
            if (checksum !== entry.crc32 || length !== entry.uncompressedSize) {
              fail(Error("Archive CRC mismatch"));
              return;
            }
            try {
              const data = capture
                ? Buffer.concat(chunks, length)
                : Buffer.alloc(0);
              entries.push({
                name: entry.fileName,
                bytes: data,
                ...(symbolic
                  ? {
                      link: linkTarget(entry.fileName, data.toString("utf8")),
                    }
                  : {}),
              });
              zip.readEntry();
            } catch (error) {
              fail(error as Error);
            }
          });
        });
      });
      zip.readEntry();
    });
  });
}

function xml(bytes: Buffer): Record<string, unknown> {
  check(
    bytes.length <= 256 * 1024 && !bytes.includes(0),
    400,
    "invalid_package",
    "Invalid XML manifest.",
  );
  const source = bytes.toString("utf8");
  check(
    !/<!DOCTYPE|<!ENTITY/i.test(source) &&
      XMLValidator.validate(source) === true,
    400,
    "invalid_package",
    "Invalid XML manifest.",
  );
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    processEntities: false,
  }).parse(source) as Record<string, unknown>;
}
function element(value: unknown): Record<string, unknown> {
  check(
    typeof value === "object" && value !== null && !Array.isArray(value),
    400,
    "invalid_package",
    "Invalid package manifest identity.",
  );
  return value as Record<string, unknown>;
}
function attributeMatches(
  value: unknown,
  key: string,
  expected: string,
): boolean {
  if (Array.isArray(value))
    return value.some((child) => attributeMatches(child, key, expected));
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record[key] === expected ||
    Object.values(record).some((child) =>
      attributeMatches(child, key, expected),
    )
  );
}
async function tar(bytes: Buffer | string, size: number, expanded: number) {
  const source =
    typeof bytes === "string"
      ? createReadStream(bytes)
      : Readable.from([bytes]);
  const stream = source.pipe(createGunzip());
  source.on("error", (error) => stream.destroy(error));
  const timer = setTimeout(
    () => stream.destroy(Error("Archive validation timed out.")),
    120000,
  );
  try {
    let total = 0,
      count = 0,
      skip = 0,
      header = Buffer.alloc(0),
      trailer = false,
      trailerBytes = 0;
    const names = new Set<string>();
    const entries: { name: string; link?: string }[] = [];
    for await (const value of stream) {
      const chunk = value as Buffer;
      total += chunk.length;
      check(
        total <= expanded && total <= Math.max(1024, size * 100),
        400,
        "invalid_package",
        "TAR expansion limit exceeded.",
      );
      let offset = 0;
      while (offset < chunk.length) {
        if (trailer) {
          check(
            chunk.subarray(offset).every((value) => value === 0),
            400,
            "invalid_package",
            "Invalid TAR trailer.",
          );
          trailerBytes += chunk.length - offset;
          break;
        }
        if (skip) {
          const length = Math.min(skip, chunk.length - offset);
          skip -= length;
          offset += length;
          continue;
        }
        const length = Math.min(512 - header.length, chunk.length - offset);
        header = Buffer.concat([
          header,
          chunk.subarray(offset, offset + length),
        ]);
        offset += length;
        if (header.length < 512) continue;
        if (header.every((value) => value === 0)) {
          trailer = true;
          trailerBytes = 512;
          header = Buffer.alloc(0);
          continue;
        }
        const text = (start: number, end: number) =>
          header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
        const name = text(0, 100),
          prefix = text(345, 500),
          path = prefix ? `${prefix}/${name}` : name;
        const sizeText = text(124, 136).trim(),
          size = /^[0-7]+$/.test(sizeText) ? Number.parseInt(sizeText, 8) : NaN;
        const checksumText = text(148, 156).trim();
        let checksum = 0;
        for (let i = 0; i < 512; i++)
          checksum += i >= 148 && i < 156 ? 32 : header[i]!;
        const key = path.normalize("NFC").toLowerCase().replace(/\/$/, "");
        check(
          ++count <= 2000 &&
            safePath(path) &&
            !names.has(key) &&
            Number.isSafeInteger(size) &&
            size >= 0 &&
            checksum === Number.parseInt(checksumText, 8) &&
            [0, 48, 50, 53].includes(header[156]!) &&
            (![50, 53].includes(header[156]!) || size === 0),
          400,
          "invalid_package",
          "Unsafe TAR contents.",
        );
        names.add(key);
        entries.push({
          name: path,
          ...(header[156] === 50
            ? { link: linkTarget(path, text(157, 257)) }
            : {}),
        });
        skip = Math.ceil(size / 512) * 512;
        header = Buffer.alloc(0);
      }
    }
    check(
      count > 0 &&
        trailer &&
        trailerBytes >= 1024 &&
        skip === 0 &&
        header.length === 0,
      400,
      "invalid_package",
      "Incomplete TAR archive.",
    );
    verifyLinks(entries);
  } finally {
    clearTimeout(timer);
    source.destroy();
    stream.destroy();
  }
}

export async function verifyArtifact(
  framework: Framework,
  config: FrameworkConfig,
  version: string,
  metadata: AssetMetadata,
  source: Buffer | string,
): Promise<void> {
  try {
    const size =
      typeof source === "string" ? (await stat(source)).size : source.length;
    const expanded = Math.min(4 * 1024 ** 3, Math.max(MAX_EXPANDED, size * 4));
    let bytes: Buffer;
    if (typeof source === "string") {
      const file = await open(source, "r");
      try {
        bytes = Buffer.alloc(Math.min(size, 1024));
        await file.read(bytes, 0, bytes.length, 0);
        if (metadata.filename.endsWith(".exe") && bytes.length >= 64) {
          const offset = bytes.readUInt32LE(60);
          if (offset >= 64 && offset + 4 <= size) {
            const signature = Buffer.alloc(4);
            await file.read(signature, 0, 4, offset);
            bytes.writeUInt32LE(64, 60);
            bytes = Buffer.concat([bytes.subarray(0, 64), signature]);
          }
        } else if (metadata.filename.endsWith(".dmg") && size >= 512) {
          bytes = Buffer.alloc(512);
          await file.read(bytes, 0, 512, size - 512);
        }
      } finally {
        await file.close();
      }
    } else bytes = source;
    const budget = {
      count: 0,
      total: 0,
      retained: 0,
      limit: Math.min(size * 2, 32 * 1024 * 1024),
      expanded,
      deadline: Date.now() + 120000,
    };
    if (
      framework === "joomla" ||
      framework === "jetbrains" ||
      metadata.filename.endsWith(".zip") ||
      metadata.filename.endsWith(".jar")
    ) {
      const entries = await archive(
        source,
        budget,
        framework === "joomla" || framework === "jetbrains"
          ? framework
          : undefined,
        framework === "electron" ||
          framework === "tauri" ||
          framework === "sparkle",
      );
      if (framework === "joomla") {
        const cfg = config as {
          extensionType: string;
          element: string;
          folder?: string;
          client?: string;
        };
        const manifests = entries
          .filter((entry) => entry.name.endsWith(".xml"))
          .map((entry) => ({ entry, document: xml(entry.bytes) }))
          .filter((item) => item.document.extension !== undefined);
        check(
          manifests.length === 1,
          400,
          "invalid_package",
          "Exactly one Joomla manifest is required.",
        );
        const { entry, document } = manifests[0]!,
          manifest = element(document.extension);
        const stem = entry.name.split("/").at(-1)!.slice(0, -4);
        const identity =
          cfg.extensionType === "plugin" || cfg.extensionType === "module"
            ? attributeMatches(
                manifest,
                `@${cfg.extensionType}`,
                cfg.element,
              ) && stem === cfg.element
            : cfg.extensionType === "component"
              ? [cfg.element, cfg.element.replace(/^com_/, "")].includes(stem)
              : cfg.extensionType === "package"
                ? manifest.packagename === cfg.element.replace(/^pkg_/, "")
                : cfg.extensionType === "library"
                  ? manifest.libraryname === cfg.element
                  : manifest.name === cfg.element;
        check(
          manifest["@type"] === cfg.extensionType &&
            manifest.version === version &&
            identity &&
            (cfg.folder === undefined || manifest["@group"] === cfg.folder) &&
            (cfg.client === undefined ||
              (manifest["@client"] ??
                (cfg.extensionType === "component" ? "administrator" : "site")) ===
                cfg.client),
          400,
          "invalid_package",
          "Joomla manifest identity or version does not match.",
        );
      }
      if (framework === "jetbrains") {
        const all = [...entries];
        for (const entry of entries.filter((e) => e.name.endsWith(".jar")))
          all.push(...(await archive(entry.bytes, budget, "jetbrains")));
        const manifests = all.filter((entry) =>
          /(?:^|\/)META-INF\/plugin\.xml$/.test(entry.name),
        );
        check(
          manifests.length === 1,
          400,
          "invalid_package",
          "Exactly one JetBrains plugin manifest is required.",
        );
        const manifest = element(xml(manifests[0]!.bytes)["idea-plugin"]);
        check(
          manifest.id === (config as { pluginId: string }).pluginId &&
            manifest.version === version,
          400,
          "invalid_package",
          "JetBrains plugin ID or version does not match.",
        );
      }
    } else if (framework !== "generic") {
      const name = metadata.filename;
      if (name.endsWith(".tar.gz")) await tar(source, size, expanded);
      else if (name.endsWith(".exe")) {
        const offset = bytes.length >= 64 ? bytes.readUInt32LE(60) : 0;
        check(
          bytes.length >= 64 &&
            bytes.subarray(0, 2).toString() === "MZ" &&
            offset >= 64 &&
            offset + 4 <= bytes.length &&
            bytes.subarray(offset, offset + 4).equals(Buffer.from("PE\0\0")),
          400,
          "invalid_package",
          "Invalid PE executable.",
        );
      } else if (name.endsWith(".AppImage"))
        check(
          bytes.length >= 64 &&
            bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
            bytes.subarray(8, 11).equals(Buffer.from([65, 73, 2])),
          400,
          "invalid_package",
          "Invalid AppImage executable.",
        );
      else if (name.endsWith(".dmg"))
        check(
          bytes.length >= 512 &&
            bytes.subarray(-512, -508).toString() === "koly",
          400,
          "invalid_package",
          "Invalid disk image.",
        );
      else if (name.endsWith(".msi"))
        check(
          bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex")),
          400,
          "invalid_package",
          "Invalid MSI package.",
        );
      else if (name.endsWith(".pkg"))
        check(
          bytes.subarray(0, 4).toString() === "xar!",
          400,
          "invalid_package",
          "Invalid installer package.",
        );
      else if (name.endsWith(".deb"))
        check(
          bytes.subarray(0, 8).toString() === "!<arch>\n",
          400,
          "invalid_package",
          "Invalid Debian package.",
        );
      else
        check(
          bytes.subarray(0, 4).equals(Buffer.from("edabeedb", "hex")),
          400,
          "invalid_package",
          "Invalid RPM package.",
        );
    }
  } catch {
    throw new AppError(
      400,
      "invalid_package",
      "Package integrity, identity or safety validation failed.",
    );
  }
}
