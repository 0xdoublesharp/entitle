import { appUrl } from "../packages/shared/app-path.ts";
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.ts";
import type { DB, Job, Tenant, Tx } from "./db.ts";
import { lock } from "./db.ts";
import { csrf, equal, hash, random, seal, unseal } from "./crypto.ts";
import { check } from "./errors.ts";
import type { Mailer, Message } from "./email.ts";
import { runQueue, DeferredJob } from "./queue.ts";
import { tenantApiKeyScopes } from "./tenants.ts";
import { signInEmail } from "./sign-in-email.ts";

export interface SellerUser {
  id: string;
  email: string;
  verified_at: number | null;
  created_at: number;
}
export interface SellerSession {
  user: SellerUser;
  csrfToken: string;
  sessionHash: string;
}

export class PlatformAuth {
  db: DB;
  config: Config;
  cookieName: string;
  preauthCookieName: string;
  constructor(db: DB, config: Config) {
    this.db = db;
    this.config = config;
    this.cookieName = config.production
      ? "__Host-de-seller-session"
      : "de-seller-session";
    this.preauthCookieName = config.production
      ? "__Host-de-seller-preauth"
      : "de-seller-preauth";
  }
  async request(email: string, req: FastifyRequest, reply: FastifyReply) {
    this.origin(req);
    email = email.trim().toLowerCase();
    if (this.config.deploymentMode === "standalone" && email !== this.config.standaloneOwnerEmail)
      return;
    check(
      email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
      400,
      "invalid_email",
      "Enter a valid email address.",
    );
    const supplied = req.cookies[this.preauthCookieName];
    const browser =
      typeof supplied === "string" && /^[A-Za-z0-9_-]{43}$/.test(supplied)
        ? supplied
        : random();
    const issued = await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const now = Date.now();
      let user = await tx<SellerUser>("seller_users").where({ email }).first();
      if (!user) {
        // All accounts start unverified; later verification must not free a creation slot.
        const signups = await tx("seller_users")
          .where("created_at", ">", now - 3600000)
          .count({ total: "id" })
          .first();
        if (
          Number(signups!.total) >= (this.config.maxSellerSignupsPerHour ?? 500)
        )
          return false;
        user = {
          id: randomUUID(),
          email,
          verified_at: null,
          created_at: Date.now(),
        };
        await tx("seller_users").insert(user);
      }
      const browserHash = hash(browser);
      const recent = await tx("seller_login_tokens")
        .where({ user_id: user.id, browser_hash: browserHash })
        .andWhere("created_at", ">", now - 60000)
        .first();
      const daily = await tx("seller_login_tokens")
        .where({ user_id: user.id, browser_hash: browserHash })
        .andWhere("created_at", ">", now - 86400000)
        .count({ total: "id" })
        .first();
      const addressDaily = await tx("seller_login_tokens")
        .where({ user_id: user.id })
        .andWhere("created_at", ">", now - 86400000)
        .count({ total: "id" })
        .first();
      if (
        recent ||
        Number(daily!.total) >= 10 ||
        Number(addressDaily!.total) >= 1000
      )
        return false;
      const token = random();
      const id = randomUUID();
      await tx("seller_login_tokens").insert({
        id: hash(token),
        user_id: user.id,
        expires_at: now + 900000,
        browser_hash: browserHash,
        created_at: now,
      });
      await tx("platform_emails").insert({
        id,
        kind: "seller_login",
        created_at: Date.now(),
        payload: seal(
          {
            ...signInEmail(
              email,
              appUrl(this.config, `/seller#seller-login=${token}`),
              "seller",
            ),
            messageId: `<${id}@entitle>`,
          },
          this.config.secret,
        ),
      });
      return true;
    });
    if (issued)
      reply.setCookie(this.preauthCookieName, browser, {
        path: "/",
        httpOnly: true,
        secure: this.config.production,
        sameSite: "lax",
        maxAge: 86400,
      });
  }
  origin(req: FastifyRequest) {
    check(
      req.headers.origin === this.config.origin,
      403,
      "origin_denied",
      "A same-origin request is required.",
    );
  }
  async consume(token: string, req: FastifyRequest, reply: FastifyReply) {
    this.origin(req);
    const session = random();
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const link = await tx("seller_login_tokens")
        .where({ id: hash(token), used: 0 })
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(
        link &&
          typeof req.cookies[this.preauthCookieName] === "string" &&
          !!link.browser_hash &&
          equal(link.browser_hash, hash(req.cookies[this.preauthCookieName]!)),
        401,
        "invalid_login",
        "Login link is invalid, expired, or already used.",
      );
      if (this.config.deploymentMode === "standalone") {
        const owner = await tx<SellerUser>("seller_users").where({ id: link.user_id }).first();
        check(owner?.email === this.config.standaloneOwnerEmail && !!this.config.standaloneOwnerEmail,
          401, "invalid_login", "Login link is invalid, expired, or already used.");
        await tx("seller_memberships").insert({ tenant_id: "primary", user_id: link.user_id,
          role: "owner", created_at: Date.now() }).onConflict(["tenant_id", "user_id"]).ignore();
      }
      await tx("seller_login_tokens")
        .where({ id: link.id })
        .update({ used: 1 });
      await tx("seller_users")
        .where({ id: link.user_id })
        .whereNull("verified_at")
        .update({ verified_at: Date.now() });
      await tx("seller_sessions").insert({
        id: hash(session),
        user_id: link.user_id,
        expires_at: Date.now() + 7 * 86400000,
      });
      await tx("audit_events").insert({
        id: randomUUID(),
        tenant_id: null,
        actor_type: "seller",
        actor_id: link.user_id,
        action: "seller.login",
        details: "{}",
        created_at: Date.now(),
      });
    });
    reply.setCookie(this.cookieName, session, {
      path: "/",
      httpOnly: true,
      secure: this.config.production,
      sameSite: "lax",
      maxAge: 7 * 86400,
    });
  }
  async seller(req: FastifyRequest, mutation = true): Promise<SellerSession> {
    const token = req.cookies[this.cookieName];
    check(
      token,
      401,
      "seller_login_required",
      "Sign in as a seller to continue.",
    );
    const session = await this.db("seller_sessions")
      .where({ id: hash(token) })
      .andWhere("expires_at", ">", Date.now())
      .first();
    check(
      session,
      401,
      "seller_login_required",
      "Your seller session has expired. Sign in again.",
    );
    const csrfToken = csrf(token, this.config.secret);
    if (mutation) {
      this.origin(req);
      check(
        typeof req.headers["x-csrf-token"] === "string" &&
          equal(req.headers["x-csrf-token"], csrfToken),
        403,
        "csrf_denied",
        "CSRF token is missing or invalid.",
      );
    }
    const user = await this.db<SellerUser>("seller_users")
      .where({ id: session.user_id })
      .whereNotNull("verified_at")
      .first();
    check(
      user && (this.config.deploymentMode !== "standalone" || user.email === this.config.standaloneOwnerEmail),
      401,
      "seller_login_required",
      "Verify your email and sign in again.",
    );
    return { user, csrfToken, sessionHash: session.id as string };
  }
  publicationAuthorization(req: FastifyRequest, tenantId: string) {
    if (req.headers.authorization === undefined) return undefined;
    const keyHash = hash(req.headers.authorization.slice(7));
    return async (tx: Tx) => {
      // Revocation takes the same lock. Keep it until the publication commits,
      // acquiring it before publication's schema and tenant-row locks.
      await lock(tx, "auth");
      const key = await tx("tenant_api_keys")
        .where({ tenant_id: tenantId, key_hash: keyHash })
        .whereNull("revoked_at")
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(key, 403, "tenant_denied", "Tenant credentials are invalid.");
      let scopes: unknown;
      try { scopes = JSON.parse(key.scopes as string); } catch { scopes = []; }
      check(
        Array.isArray(scopes) && scopes.includes("releases:write"),
        403,
        "scope_denied",
        "This API key does not permit that operation.",
      );
    };
  }
  async tenant(
    req: FastifyRequest,
    slug: string,
    mutation = true,
    allowApiKey = false,
    requiredScope?: string,
  ): Promise<Tenant> {
    const tenant = await this.db<Tenant>("tenants").where({ slug }).first();
    check(tenant, 404, "tenant_not_found", "Tenant was not found.");
    if (req.headers.authorization !== undefined) {
      check(
        allowApiKey,
        401,
        "seller_login_required",
        "An interactive seller session is required.",
      );
      check(
        requiredScope &&
          tenantApiKeyScopes.includes(
            requiredScope as (typeof tenantApiKeyScopes)[number],
          ),
        403,
        "scope_required",
        "An explicit tenant API key scope is required.",
      );
      const header = req.headers.authorization;
      check(
        header.startsWith("Bearer DE-TK-"),
        403,
        "tenant_denied",
        "Tenant credentials are invalid.",
      );
      const key = await this.db("tenant_api_keys")
        .where({ tenant_id: tenant.id, key_hash: hash(header.slice(7)) })
        .whereNull("revoked_at")
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(key, 403, "tenant_denied", "Tenant credentials are invalid.");
      let scopes: unknown;
      try {
        scopes = JSON.parse(key.scopes as string);
      } catch {
        scopes = [];
      }
      check(
        Array.isArray(scopes) && scopes.includes(requiredScope),
        403,
        "scope_denied",
        "This API key does not permit that operation.",
      );
      await this.db("tenant_api_keys")
        .where({ id: key.id, tenant_id: tenant.id })
        .update({ last_used_at: Date.now() });
    } else {
      const { user } = await this.seller(req, mutation);
      const membership = await this.db("seller_memberships")
        .where({ tenant_id: tenant.id, user_id: user.id, role: "owner" })
        .first();
      check(membership, 403, "tenant_denied", "You do not own this tenant.");
    }
    return tenant;
  }
}

export class PlatformOutbox {
  db: DB;
  secret: string;
  mailer: Mailer;
  dailyLimit: number;
  constructor(db: DB, secret: string, mailer: Mailer, dailyLimit = 1000) {
    this.db = db;
    this.secret = secret;
    this.mailer = mailer;
    this.dailyLimit = dailyLimit;
  }
  message(job: Job): Message {
    return unseal<Message>(job.payload, this.secret);
  }
  async run() {
    await runQueue(this.db, "platform_emails", async (job) => {
      const current = await this.db<Job>("platform_emails")
        .where({ id: job.id })
        .first();
      if (current?.state === "canceled") return;
      // Reserve attempts before SMTP. Failures consume budget; deferral preserves credentials.
      const day = Math.floor(Date.now() / 86400000),
        id = `platform:email-budget:${day}`;
      const allowed = await this.db.transaction(async (tx) => {
        await tx("locks").insert({ id, version: 0 }).onConflict("id").ignore();
        return tx("locks")
          .where({ id })
          .andWhere("version", "<", this.dailyLimit)
          .increment("version", 1);
      });
      if (!allowed) throw new DeferredJob((day + 1) * 86400000);
      await this.mailer.send(this.message(job));
    });
  }
}
