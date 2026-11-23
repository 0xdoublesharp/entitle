import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { check } from "./errors.ts";
import {
  MAX_ARTIFACT_BYTES,
  MAX_NATIVE_ARTIFACT_BYTES,
  type ArtifactStore,
} from "./storage.ts";

export async function hashArtifactFile(
  file: string,
  size: number,
  onProgress?: (bytes: number) => void,
  signal?: AbortSignal,
) {
  check(
    Number.isSafeInteger(size) && size > 0 && size <= MAX_NATIVE_ARTIFACT_BYTES,
    400,
    "invalid_artifact",
    "Invalid artifact size.",
  );
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    check(
      before.isFile() && before.size === size,
      503,
      "artifact_integrity",
      "Artifact length changed.",
    );
    const sha256 = createHash("sha256"),
      sha512 = createHash("sha512");
    let length = 0;
    const stream = handle.createReadStream({ autoClose: false, signal });
    const timer = deadline(size, 120000, 1024 ** 2, () =>
      stream.destroy(Error("Artifact hashing timed out.")),
    );
    try {
      for await (const chunk of stream) {
        length += chunk.length;
        timer.progress();
        onProgress?.(chunk.length);
        check(
          length <= size,
          503,
          "artifact_integrity",
          "Artifact length changed.",
        );
        sha256.update(chunk);
        sha512.update(chunk);
      }
    } finally {
      timer.clear();
    }
    const after = await handle.stat();
    check(
      length === size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs,
      503,
      "artifact_integrity",
      "Artifact changed during verification.",
    );
    return { checksum: sha256.digest("hex"), sha512: sha512.digest("base64") };
  } finally {
    await handle.close();
  }
}
export interface ArtifactIdentity {
  tenantId: string;
  id: string;
  checksum: string;
  size: number;
}
export interface VerifiedArtifactCacheOptions {
  directory: string;
  maxBytes?: number;
  maxInflightBytes?: number;
  ttlMs?: number;
  /** No-progress deadline. Total deadline also includes size/minBytesPerSecond. */
  timeoutMs?: number;
  minBytesPerSecond?: number;
}
type Cached = {
  key: string;
  file: string;
  size: number;
  expires: number;
  leases: number;
  mtime: number;
  ctime: number;
  disposing?: Promise<void>;
};
type Pending = { waiters: number; promise: Promise<Cached> };
export function artifactTransferBudget(
  size: number,
  idleMs: number,
  minBytesPerSecond = 1024 ** 2,
) {
  return idleMs + Math.ceil((1000 * size) / minBytesPerSecond);
}
export async function artifactFileIdentity(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat({ bigint: true });
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs]
      .map(String)
      .join(":");
  } finally {
    await handle.close();
  }
}
function deadline(
  size: number,
  idleMs: number,
  minBytesPerSecond: number,
  expire: () => void,
) {
  const total = setTimeout(
    expire,
    artifactTransferBudget(size, idleMs, minBytesPerSecond),
  );
  let idle = setTimeout(expire, idleMs);
  return {
    progress: () => {
      clearTimeout(idle);
      idle = setTimeout(expire, idleMs);
    },
    clear: () => {
      clearTimeout(total);
      clearTimeout(idle);
    },
  };
}
export class VerifiedArtifactCache {
  private readonly options: Required<VerifiedArtifactCacheOptions>;
  private readonly entries = new Map<string, Cached>();
  private readonly retired = new Set<Cached>();
  private readonly pending = new Map<string, Pending>();
  private readonly openings = new Set<
    Promise<{ stream: Readable; size: number }>
  >();
  private readonly streams = new Map<Readable, Promise<void>>();
  private used = 0;
  private inflight = 0;
  private closed = false;
  private queue = Promise.resolve();
  private readonly root: Promise<string>;
  constructor(options: VerifiedArtifactCacheOptions) {
    this.options = {
      maxBytes: 4 * 1024 ** 3,
      maxInflightBytes: 2 * 1024 ** 3,
      ttlMs: 300000,
      timeoutMs: 120000,
      minBytesPerSecond: 1024 ** 2,
      ...options,
    };
    check(
      isAbsolute(options.directory) &&
        Object.entries(this.options).every(
          ([key, value]) =>
            key === "directory" ||
            (Number.isSafeInteger(value) && Number(value) > 0),
        ) &&
        this.options.maxBytes <= 64 * 1024 ** 3 &&
        this.options.maxInflightBytes <= this.options.maxBytes &&
        this.options.ttlMs <= 86400000 &&
        this.options.timeoutMs <= 3600000 &&
        this.options.minBytesPerSecond >= 65536 &&
        this.options.minBytesPerSecond <= 64 * 1024 ** 2,
      500,
      "artifact_cache_configuration",
      "Invalid artifact cache configuration.",
    );
    this.root = mkdir(options.directory, { recursive: true, mode: 0o700 }).then(
      async () => {
        check(
          !(await lstat(options.directory)).isSymbolicLink(),
          500,
          "artifact_cache_configuration",
          "Cache directory must be private.",
        );
        const directory = join(options.directory, randomUUID());
        await mkdir(directory, { mode: 0o700 });
        return directory;
      },
    );
  }
  // Protect generation selection, pinning, unlink accounting and reservations.
  // Network transfer and hashing never hold this queue.
  private async metadata<T>(work: () => Promise<T> | T): Promise<T> {
    const before = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    try {
      return await work();
    } finally {
      release();
    }
  }
  private discard(entry: Cached): Promise<void> {
    if (entry.disposing) return entry.disposing;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.retired.add(entry);
    entry.disposing = rm(entry.file, { force: true }).then(() => {
      this.used -= entry.size;
      this.retired.delete(entry);
    });
    return entry.disposing;
  }
  private release(entry: Cached, invalid = false) {
    return this.metadata(async () => {
      entry.leases--;
      if (invalid) {
        if (this.entries.get(entry.key) === entry)
          this.entries.delete(entry.key);
        this.retired.add(entry);
      }
      if (entry.leases === 0 && this.retired.has(entry))
        await this.discard(entry);
    });
  }
  private async spool(
    store: ArtifactStore,
    identity: ArtifactIdentity,
    key: string,
    pending: Pending,
  ): Promise<Cached> {
    const { size, checksum } = identity;
    let file: string | undefined;
    const controller = new AbortController();
    const timer = deadline(
      size,
      this.options.timeoutMs,
      this.options.minBytesPerSecond,
      () => controller.abort(),
    );
    try {
      const directory = await this.root;
      file = join(directory, randomUUID() + ".partial");
      if (store.getToFile)
        await store.getToFile(
          identity.tenantId,
          identity.id,
          checksum,
          size,
          file,
          controller.signal,
          timer.progress,
        );
      else {
        check(
          size <= MAX_ARTIFACT_BYTES,
          503,
          "streaming_storage_required",
          "Streaming storage is required for this artifact.",
        );
        const bytes = await store.get(
          identity.tenantId,
          identity.id,
          checksum,
          size,
        );
        timer.progress();
        check(
          bytes.length === size,
          503,
          "artifact_integrity",
          "Artifact length mismatch.",
        );
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
      }
      check(
        !controller.signal.aborted,
        503,
        "artifact_cache_timeout",
        "Artifact verification timed out.",
      );
      const hash = await hashArtifactFile(
        file,
        size,
        timer.progress,
        controller.signal,
      );
      check(
        !controller.signal.aborted && hash.checksum === checksum,
        503,
        "artifact_integrity",
        "Artifact failed integrity verification.",
      );
      const destination = join(directory, randomUUID() + ".verified");
      await rename(file, destination);
      file = destination;
      const info = await lstat(file);
      const entry: Cached = {
        key,
        file,
        size,
        expires: Date.now() + this.options.ttlMs,
        leases: 0,
        mtime: info.mtimeMs,
        ctime: info.ctimeMs,
      };
      await this.metadata(() => {
        // All waiting openers own their lease before the entry becomes evictable.
        entry.leases = pending.waiters;
        this.entries.set(key, entry);
        this.pending.delete(key);
        this.inflight -= size;
      });
      timer.clear();
      return entry;
    } catch (error) {
      timer.clear();
      let removed = true;
      try {
        if (file !== undefined) await rm(file, { force: true });
      } catch {
        removed = false;
      }
      await this.metadata(() => {
        if (removed) this.used -= size;
        this.inflight -= size;
        this.pending.delete(key);
      });
      throw error;
    }
  }
  open(
    store: ArtifactStore,
    identity: ArtifactIdentity,
    start?: number,
    end?: number,
  ) {
    const work = this.acquire(store, identity, start, end);
    this.openings.add(work);
    void work.finally(() => this.openings.delete(work)).catch(() => {});
    return work;
  }
  private async acquire(
    store: ArtifactStore,
    identity: ArtifactIdentity,
    start = 0,
    end = identity.size - 1,
  ): Promise<{ stream: Readable; size: number }> {
    check(
      !this.closed,
      503,
      "artifact_cache_closed",
      "Artifact cache is closed.",
    );
    check(
      /^[a-f0-9]{64}$/.test(identity.checksum) &&
        Number.isSafeInteger(identity.size) &&
        identity.size > 0 &&
        identity.size <= MAX_NATIVE_ARTIFACT_BYTES &&
        Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        start >= 0 &&
        end >= start &&
        end < identity.size,
      400,
      "invalid_artifact",
      "Invalid artifact identity or range.",
    );
    const key = JSON.stringify([
      identity.tenantId,
      identity.id,
      identity.checksum,
      identity.size,
    ]);
    // A completed consumer may still be closing its descriptor. Let its existing
    // lease finish outside the metadata queue before deciding capacity is busy.
    await Promise.all(
      [...this.streams]
        .filter(([stream]) => stream.readableEnded || stream.destroyed)
        .map(([, closed]) => closed),
    );
    const chosen = await this.metadata(
      async (): Promise<{ entry: Cached } | { pending: Pending }> => {
        check(
          !this.closed,
          503,
          "artifact_cache_closed",
          "Artifact cache is closed.",
        );
        const cached = this.entries.get(key);
        // TTL refresh waits for the last reader. Every opener still verifies the
        // private immutable file below, so a lease never needs a duplicate spool.
        if (cached && (cached.expires > Date.now() || cached.leases > 0)) {
          cached.leases++;
          return { entry: cached };
        }
        if (cached) {
          this.entries.delete(key);
          this.retired.add(cached);
          if (cached.leases === 0) await this.discard(cached);
        }
        const existing = this.pending.get(key);
        if (existing) {
          existing.waiters++;
          return { pending: existing };
        }
        check(
          this.inflight + identity.size <= this.options.maxInflightBytes,
          503,
          "artifact_cache_capacity",
          "Artifact cache is at capacity.",
        );
        for (const entry of this.entries.values()) {
          if (this.used + identity.size <= this.options.maxBytes) break;
          if (entry.leases === 0) await this.discard(entry);
        }
        check(
          this.used + identity.size <= this.options.maxBytes,
          503,
          "artifact_cache_capacity",
          "Artifact cache is at capacity.",
        );
        this.used += identity.size;
        this.inflight += identity.size;
        const pending: Pending = { waiters: 1, promise: undefined! };
        this.pending.set(key, pending);
        pending.promise = this.spool(store, identity, key, pending);
        return { pending };
      },
    );
    const entry =
      "entry" in chosen ? chosen.entry : await chosen.pending.promise;
    let handle;
    try {
      check(
        !this.closed,
        503,
        "artifact_cache_closed",
        "Artifact cache is closed.",
      );
      handle = await open(
        entry.file,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await handle.stat();
      check(
        !this.closed,
        503,
        "artifact_cache_closed",
        "Artifact cache is closed.",
      );
      check(
        info.isFile() &&
          info.size === entry.size &&
          info.mtimeMs === entry.mtime &&
          info.ctimeMs === entry.ctime,
        503,
        "artifact_integrity",
        "Verified cache file changed.",
      );
    } catch (error) {
      await handle?.close();
      await this.release(entry, true);
      throw error;
    }
    const source = handle.createReadStream({
      start,
      end,
      highWaterMark: 16 * 1024,
    });
    const timer = deadline(
      end - start + 1,
      this.options.timeoutMs,
      this.options.minBytesPerSecond,
      () => output.destroy(Error("Artifact stream timed out.")),
    );
    const output = new Transform({
      highWaterMark: 16 * 1024,
      transform(chunk: Buffer, _encoding, done) {
        timer.progress();
        done(null, chunk);
      },
    });
    const fileClosed = new Promise<void>((resolve) =>
      source.once("close", resolve),
    );
    const outputClosed = new Promise<void>((resolve) =>
      output.once("close", resolve),
    );
    const closed = Promise.all([fileClosed, outputClosed]).then(async () => {
      timer.clear();
      this.streams.delete(output);
      await this.release(entry);
    });
    void closed.catch(() => {});
    this.streams.set(output, closed);
    source.once("error", (error) => output.destroy(error));
    output.once("close", () => source.destroy());
    source.pipe(output);
    return { stream: output, size: end - start + 1 };
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.openings);
    const closing = [...this.streams.values()];
    for (const stream of this.streams.keys()) stream.destroy();
    await Promise.all(closing);
    await this.metadata(async () => {
      for (const entry of new Set([...this.entries.values(), ...this.retired]))
        await this.discard(entry);
    });
    await rm(await this.root, { recursive: true, force: true });
  }
}
