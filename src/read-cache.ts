import { createHash, randomUUID } from "node:crypto";
import { AdaptiveCache } from "@0xdoublesharp/adaptive-cache";
import { Redis } from "ioredis";

export type ReadCacheEngine = Pick<
  AdaptiveCache,
  "getOrSet" | "getStats" | "close"
>;
interface ReadCacheOptions {
  onUnavailable?: () => void;
  redisUrl?: string;
  namespace?: string;
  memoryBytes?: number;
}
class ReadSourceError extends Error {}

/** Only presentation/provider reads. Never cache authority or artifact bytes. */
export class ReadCache {
  private readonly engine: ReadCacheEngine;
  private readonly namespace: string;
  private readonly redis: Redis | undefined;
  private readonly localFeeds: ReadCacheEngine | undefined;
  private readonly onUnavailable: (() => void) | undefined;
  private warned = false;
  constructor(options: ReadCacheOptions = {}, engine?: ReadCacheEngine) {
    // Keep pre-0.2 writers out of the revised cache format during rolling upgrades.
    this.namespace = `${options.namespace ?? `entitle:${randomUUID()}:`}adaptive-v2:`;
    this.onUnavailable = options.onUnavailable;
    // An external backend must never supply executable feed/manifest bytes.
    if (engine || options.redisUrl)
      this.localFeeds = new AdaptiveCache({
        backend: "clustered-lru", keyPrefix: `${this.namespace}feeds:`, initialTTL: 15,
        maxTTL: 60, staleWhileRevalidate: 0, staleIfError: 0, negativeTTL: 0, logLevel: "silent",
        lru: { namespace: `${this.namespace}feeds:${randomUUID()}`, maxSizeBytes: options.memoryBytes ?? 8 * 1024 * 1024, maxEntrySizeBytes: 256 * 1024 },
      });
    if (engine) {
      this.engine = engine;
      return;
    }
    if (options.redisUrl) {
      this.redis = new Redis(options.redisUrl, {
        connectTimeout: 500,
        commandTimeout: 500,
        maxRetriesPerRequest: 0,
        enableOfflineQueue: false,
        retryStrategy: () => 1000,
      });
      // Connectivity is optional; never emit Redis URLs or credential-bearing errors.
      this.redis.on("error", () => {});
    }
    this.engine = new AdaptiveCache(
      {
        backend: this.redis ? "redis" : "clustered-lru",
        keyPrefix: this.namespace,
        initialTTL: 15,
        maxTTL: 60,
        metaTTL: 300,
        ttlScaling: 1.5,
        staleWhileRevalidate: 0,
        staleIfError: 0,
        negativeTTL: 0,
        logLevel: "silent",
        compress: false,
        lru: {
          namespace: `${this.namespace}l1:${randomUUID()}`,
          maxSizeBytes: options.memoryBytes ?? 8 * 1024 * 1024,
          maxEntrySizeBytes: 256 * 1024,
        },
      },
      this.redis,
    );
  }
  async remember<T>(
    scope: "prices" | "feed",
    tenantId: string,
    identity: unknown,
    load: () => Promise<T>,
  ): Promise<T> {
    const key =
      this.namespace +
      scope +
      ":" +
      createHash("sha256")
        .update(JSON.stringify([tenantId, identity]))
        .digest("hex");
    let source: Promise<T> | undefined;
    const compute = () => (source ??= Promise.resolve().then(load));
    const engine = scope === "feed" && this.localFeeds ? this.localFeeds : this.engine;
    try {
      return await engine.getOrSet(key, () =>
        compute().catch((cause) => {
          // Coalesced callers receive the same source failure from the cache.
          throw new ReadSourceError("Read source failed", { cause });
        }),
      );
    } catch (error) {
      if (error instanceof ReadSourceError) throw error.cause;
      if (!this.warned) {
        this.warned = true;
        try { this.onUnavailable?.(); } catch { /* Logging cannot prevent source reads. */ }
      }
      return compute();
    }
  }
  getStats() {
    return this.engine.getStats();
  }
  async close() {
    try {
      await this.engine.close();
    } finally {
      try { await this.localFeeds?.close(); } finally { this.redis?.disconnect(); }
    }
  }
}
