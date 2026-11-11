import { randomUUID } from "node:crypto";
import {
  createRemoteJWKSet,
  customFetch,
  jwtVerify,
  type JWTPayload,
} from "jose";
import type { Config } from "./config.ts";
import { lock, type DB, type Tx, type Tenant } from "./db.ts";
import { hash, random } from "./crypto.ts";
import { AppError, check } from "./errors.ts";
import { tenantAvailable } from "./tenants.ts";
import {
  defaultOidcProviders,
  oidcAudience,
  oidcProvidersSchema,
  publisherInputSchema,
} from "./oidc-schema.ts";

interface Publisher {
  id: string;
  tenant_id: string;
  product_id: string;
  name: string;
  provider: string;
  issuer: string;
  subject: string;
  claims: string;
  created_at: number;
  revoked_at: number | null;
}

export class OidcPublishing {
  readonly db: DB;
  readonly config: Config;
  readonly providers;
  private readonly keySets;
  constructor(db: DB, config: Config, fetcher: typeof fetch = fetch) {
    this.db = db;
    this.config = config;
    this.providers = oidcProvidersSchema.parse(
      config.oidcProviders ?? defaultOidcProviders,
    );
    this.keySets = new Map(
      this.providers.map((provider) => [
        provider.id,
        createRemoteJWKSet(new URL(provider.jwksUrl), {
          timeoutDuration: 5000,
          cooldownDuration: 30000,
          cacheMaxAge: 300000,
          [customFetch]: async (url, options) => {
            const response = await fetcher(url, {
              ...options,
              redirect: "error",
              signal: AbortSignal.any([
                options.signal!,
                AbortSignal.timeout(5000),
              ]),
            });
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              check(
                response.status === 200,
                503,
                "oidc_keys_unavailable",
                "CI identity keys are unavailable.",
              );
              if (response.body)
                for await (const chunk of response.body) {
                  size += chunk.length;
                  check(
                    size <= 256 * 1024,
                    503,
                    "oidc_keys_unavailable",
                    "CI identity keys exceed the size limit.",
                  );
                  chunks.push(chunk);
                }
              return new Response(Buffer.concat(chunks), { status: 200 });
            } finally {
              await response.body?.cancel().catch(() => {});
            }
          },
        }),
      ]),
    );
  }
  async list(tenant: Tenant) {
    const rows = await this.db<Publisher>("oidc_publishers")
      .where({ tenant_id: tenant.id })
      .orderBy("created_at", "desc")
      .limit(100);
    return {
      audience: oidcAudience(this.config.origin, tenant.slug),
      providers: this.providers.map(({ id, issuer }) => ({ id, issuer })),
      publishers: rows.map((row) => ({
        ...row,
        claims: JSON.parse(row.claims) as Record<string, unknown>,
      })),
    };
  }
  private async audit(
    tx: Tx,
    tenantId: string,
    actorType: string,
    actorId: string,
    action: string,
    details: object,
  ) {
    await tx("audit_events").insert({
      id: randomUUID(),
      tenant_id: tenantId,
      actor_type: actorType,
      actor_id: actorId,
      action,
      details: JSON.stringify(details),
      created_at: Date.now(),
    });
  }
  async create(
    tenant: Tenant,
    actorId: string,
    input: unknown,
    authorize: (tx: Tx) => Promise<void>,
  ) {
    const value = publisherInputSchema.parse(input);
    const provider = this.providers.find(
      (provider) => provider.id === value.provider,
    );
    check(
      provider,
      400,
      "oidc_provider",
      "Select an OIDC provider enabled by the operator.",
    );
    if (provider.issuer === "https://token.actions.githubusercontent.com")
      check(
        typeof value.claims.repository_id === "string" &&
          /^\d+$/.test(value.claims.repository_id) &&
          typeof value.claims.repository_owner_id === "string" &&
          /^\d+$/.test(value.claims.repository_owner_id) &&
          typeof value.claims.ref === "string" &&
          value.claims.ref.startsWith("refs/") &&
          (typeof value.claims.workflow_ref === "string" ||
            typeof value.claims.job_workflow_ref === "string"),
        400,
        "oidc_github_claims",
        "GitHub publishers require repository_id, repository_owner_id, ref, and workflow_ref or job_workflow_ref.",
      );
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await authorize(tx);
      const count = await tx("oidc_publishers")
        .where({ tenant_id: tenant.id })
        .count("* as count")
        .first();
      check(
        Number(count!.count) < 100,
        409,
        "oidc_publisher_limit",
        "At most 100 publisher records are allowed per workspace.",
      );
      const product = await tx("products")
        .where({ tenant_id: tenant.id, slug: value.product })
        .first();
      check(product, 404, "not_found", "Product not found.");
      const publisher: Publisher = {
        id: randomUUID(),
        tenant_id: tenant.id,
        product_id: product.id,
        name: value.name,
        provider: provider.id,
        issuer: provider.issuer,
        subject: value.subject,
        claims: JSON.stringify(value.claims),
        created_at: Date.now(),
        revoked_at: null,
      };
      await tx("oidc_publishers").insert(publisher);
      await this.audit(
        tx,
        tenant.id,
        "seller",
        actorId,
        "oidc.publisher.created",
        { publisherId: publisher.id, productId: product.id },
      );
      return {
        ...publisher,
        claims: value.claims,
        audience: oidcAudience(this.config.origin, tenant.slug),
      };
    });
  }
  async revoke(
    tenantId: string,
    actorId: string,
    id: string,
    authorize: (tx: Tx) => Promise<void>,
  ) {
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await authorize(tx);
      const publisher = await tx<Publisher>("oidc_publishers")
        .where({ tenant_id: tenantId, id })
        .first();
      check(publisher, 404, "not_found", "Publisher not found.");
      if (publisher.revoked_at !== null) return;
      await tx("oidc_publishers")
        .where({ tenant_id: tenantId, id })
        .update({ revoked_at: Date.now() });
      await this.audit(
        tx,
        tenantId,
        "seller",
        actorId,
        "oidc.publisher.revoked",
        { publisherId: id },
      );
    });
  }
  async exchange(tenant: Tenant, publisherId: string, identity: string) {
    check(
      tenantAvailable(tenant, "buyer"),
      403,
      "tenant_suspended",
      "This publisher's service is suspended.",
    );
    const publisher = await this.db<Publisher>("oidc_publishers")
      .where({ tenant_id: tenant.id, id: publisherId })
      .whereNull("revoked_at")
      .first();
    check(
      publisher,
      403,
      "oidc_denied",
      "CI identity is not trusted for this workspace.",
    );
    const provider = this.providers.find(
      (provider) =>
        provider.id === publisher.provider &&
        provider.issuer === publisher.issuer,
    );
    check(provider, 403, "oidc_denied", "CI identity provider is disabled.");
    let payload: JWTPayload;
    try {
      check(
        identity.length <= 16384,
        401,
        "oidc_invalid",
        "Invalid CI identity.",
      );
      ({ payload } = await jwtVerify(identity, this.keySets.get(provider.id)!, {
        issuer: provider.issuer,
        audience: oidcAudience(this.config.origin, tenant.slug),
        subject: publisher.subject,
        algorithms: provider.algorithms,
        requiredClaims: ["exp", "iat", "jti", "sub"],
        maxTokenAge: "10 minutes",
        clockTolerance: 5,
      }));
      check(
        typeof payload.jti === "string" &&
          payload.jti.length > 0 &&
          payload.jti.length <= 1000 &&
          payload.exp! > payload.iat! &&
          payload.exp! * 1000 > Date.now(),
        401,
        "oidc_invalid",
        "Invalid CI identity.",
      );
      const claims = JSON.parse(publisher.claims) as Record<string, unknown>;
      check(
        Object.entries(claims).every(
          ([key, value]) =>
            Object.hasOwn(payload, key) && payload[key] === value,
        ),
        403,
        "oidc_denied",
        "CI identity claims do not match this publisher.",
      );
      if (provider.issuer === "https://token.actions.githubusercontent.com")
        check(
          typeof payload.event_name === "string" &&
            !["pull_request", "pull_request_target"].includes(
              payload.event_name,
            ),
          403,
          "oidc_denied",
          "Pull request jobs cannot publish releases.",
        );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        401,
        "oidc_invalid",
        "CI identity signature, audience or lifetime is invalid.",
      );
    }
    const accessToken = `DE-CI-${random()}`;
    const now = Date.now(),
      expiresAt = Math.min(now + 600000, payload.exp! * 1000);
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const current = await tx<Publisher>("oidc_publishers")
        .where({ tenant_id: tenant.id, id: publisherId })
        .whereNull("revoked_at")
        .first();
      check(current, 403, "oidc_denied", "Publisher has been revoked.");
      // Retain replay markers until both the original ID token and access token expire.
      await tx("oidc_sessions").where("replay_until", "<", now).delete();
      const identityHash = hash(JSON.stringify([provider.issuer, payload.jti]));
      check(
        !(await tx("oidc_sessions")
          .where({ identity_hash: identityHash })
          .first()),
        409,
        "oidc_replayed",
        "This CI identity was already exchanged. Request a fresh ID token.",
      );
      await tx("oidc_sessions").insert({
        id: hash(accessToken),
        tenant_id: tenant.id,
        publisher_id: publisherId,
        identity_hash: identityHash,
        expires_at: expiresAt,
        replay_until: Math.max(expiresAt, payload.exp! * 1000 + 5000),
        created_at: now,
      });
      await this.audit(
        tx,
        tenant.id,
        "oidc",
        publisherId,
        "oidc.token.exchanged",
        { productId: publisher.product_id },
      );
    });
    return {
      accessToken,
      tokenType: "Bearer",
      expiresAt,
      scopes: ["releases:write"],
      productId: publisher.product_id,
    };
  }
  async authorize(tx: Tx, token: string, tenantId: string, product: string) {
    check(
      /^DE-CI-[A-Za-z0-9_-]{43}$/.test(token),
      403,
      "oidc_denied",
      "Invalid CI publishing credentials.",
    );
    const session = await tx("oidc_sessions")
      .where({ id: hash(token), tenant_id: tenantId })
      .andWhere("expires_at", ">", Date.now())
      .first();
    const publisher =
      session &&
      (await tx<Publisher>("oidc_publishers")
        .where({ id: session.publisher_id, tenant_id: tenantId })
        .whereNull("revoked_at")
        .first());
    const target =
      publisher &&
      (await tx("products")
        .where({ tenant_id: tenantId, id: publisher.product_id, slug: product })
        .first());
    check(
      publisher &&
        target &&
        this.providers.some(
          (provider) =>
            provider.id === publisher.provider &&
            provider.issuer === publisher.issuer,
        ),
      403,
      "oidc_denied",
      "CI publishing credentials are expired, revoked or do not permit this product.",
    );
    return publisher.id;
  }
}
