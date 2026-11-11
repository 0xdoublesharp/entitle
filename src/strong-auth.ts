import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from "@simplewebauthn/server";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { lock, type DB, type Tx } from "./db.ts";
import type {
  PlatformAuth,
  SellerSession,
  SellerUser,
} from "./platform-auth.ts";
import { AccountManagement } from "./account-management.ts";
import { hash, random, seal, unseal } from "./crypto.ts";
import { AppError, check } from "./errors.ts";
import { strongIntentSchema, type StrongIntent } from "./strong-schema.ts";

import {
  revokePublishingGrants,
  currentAuthSession,
  activeRecovery,
  assertCapability,
  consumeCapabilityProof,
  canonicalAuth,
  bumpAuthGeneration,
  approvedHardware,
  authNotice,
  type AuthFactor,
} from "./auth-policy.ts";

interface Factor extends AuthFactor {
  id: string;
  user_id: string;
  kind: "passkey" | "security_key";
  payload: string;
  counter: number;
  name: string;
  credential_hash: string;
}
interface ChallengePayload {
  challenge?: string;
  kind?: "passkey" | "security_key";
  intent?: StrongIntent;
  name?: string;
  generation?: number;
  recoveryId?: string;
}
const name = z.string().trim().min(1).max(150);
const response = z.record(z.string(), z.unknown());
const limit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

export class StrongAuth {
  readonly db: DB;
  readonly auth: PlatformAuth;
  constructor(db: DB, auth: PlatformAuth) {
    this.db = db;
    this.auth = auth;
  }
  private async session<T>(
    req: FastifyRequest,
    action: (tx: Tx, session: SellerSession) => Promise<T>,
  ) {
    const session = await this.auth.seller(req, true, true);
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await this.current(tx, session);
      return action(tx, session);
    });
  }
  private async current(tx: Tx, session: SellerSession) {
    await currentAuthSession(tx, session);
  }

  private async attempts(req: FastifyRequest) {
    const session = await this.auth.seller(req, true, true);
    // Commit the attempt budget even when subsequent verification fails.
    await new AccountManagement(this.db, this.auth).throttle(
      `strong-auth:${session.user.id}`,
      10,
      300000,
    );
  }
  private async audit(tx: Tx, userId: string, action: string, details: object) {
    await tx("audit_events").insert({
      id: randomUUID(),
      tenant_id: null,
      actor_type: "seller",
      actor_id: userId,
      action,
      details: JSON.stringify(details),
      created_at: Date.now(),
    });
  }
  async status(req: FastifyRequest) {
    const session = await this.auth.seller(req, false, true);
    return this.db.transaction(async (tx) => {
      const { row, user } = await currentAuthSession(tx, session);
      const factors = tx("seller_factors").where({ user_id: user.id });
      if (row.recovery_id) {
        await activeRecovery(tx, session);
        factors.andWhere({ recovery_id: row.recovery_id });
      }
      const approved = await approvedHardware(
        tx,
        user.id,
        this.auth.config.secret,
      );
      const pendingRecoveries = await tx("auth_recoveries")
        .where({ user_id: user.id, state: "restricted" })
        .select("id", "mode", "not_before");
      return {
        pendingRecoveries,
        emailLoginEnabled: !user.email_login_disabled,
        recoveryRestricted: !!row.recovery_id,
        privilegedReady:
          !Number(user.recovered_ordinary) &&
          !Number(user.privileged_suspended) &&
          approved.length >= 2,
        factors: (
          await factors.select(
            "id",
            "kind",
            "name",
            "created_at",
            "provenance",
            "recovery_id",
          )
        ).map((f) => ({
          ...f,
          hardwareApproved: approved.some((k) => k.id === f.id),
        })),
      };
    });
  }
  private async challenge(
    tx: Tx,
    session: SellerSession,
    kind: string,
    payload: ChallengePayload,
  ) {
    await tx("seller_factor_challenges")
      .where({ user_id: session.user.id })
      .andWhere("expires_at", "<=", Date.now())
      .delete();
    // One outstanding challenge per ceremony/session keeps storage and supersession bounded.
    await tx("seller_factor_challenges")
      .where({
        user_id: session.user.id,
        session_hash: session.sessionHash,
        kind,
      })
      .delete();
    const id = randomUUID();
    await tx("seller_factor_challenges").insert({
      id,
      user_id: session.user.id,
      session_hash: session.sessionHash,
      kind,
      payload: seal(
        {
          ...payload,
          generation: Number(
            (await currentAuthSession(tx, session)).user.security_generation,
          ),
        },
        this.auth.config.secret,
      ),
      created_at: Date.now(),
      expires_at: Date.now() + 300000,
    });
    return id;
  }
  private async consume(
    tx: Tx,
    session: SellerSession,
    id: string,
    kind: string,
  ) {
    const row = await tx("seller_factor_challenges")
      .where({
        id,
        user_id: session.user.id,
        session_hash: session.sessionHash,
        kind,
      })
      .andWhere("expires_at", ">", Date.now())
      .first();
    check(
      row,
      403,
      "reauth_required",
      "Start fresh passkey or security key verification.",
    );
    await tx("seller_factor_challenges").where({ id }).delete();
    return unseal<ChallengePayload>(row.payload, this.auth.config.secret);
  }
  async require(
    req: FastifyRequest,
    tx: Tx,
    session: SellerSession,
    intent: StrongIntent,
  ) {
    await this.current(tx, session);
    if ("tenant" in intent) {
      const tenant = await tx("tenants").where({ slug: intent.tenant }).first();
      check(
        tenant &&
          (await tx("seller_memberships")
            .where({
              tenant_id: tenant.id,
              user_id: session.user.id,
              role: "owner",
            })
            .first()),
        403,
        "tenant_denied",
        "You do not own this workspace.",
      );
    }
    const proof = req.headers["x-account-verification"];
    check(
      typeof proof === "string" && proof.length <= 200,
      403,
      "reauth_required",
      "Verify with a passkey or security key to change trusted publishers.",
    );
    await consumeCapabilityProof(
      tx,
      session,
      proof,
      intent,
      this.auth.config.secret,
    );
    await this.audit(tx, session.user.id, "seller.reauthentication.used", {
      action: intent.action,
    });
  }
  private async enrollment(
    req: FastifyRequest,
    tx: Tx,
    session: SellerSession,
  ) {
    const { row: liveSession } = await currentAuthSession(tx, session);
    if (liveSession.recovery_id) {
      const flow = await activeRecovery(tx, session);
      check(
        flow.mode === "infrastructure" || flow.channel_verified_at,
        403,
        "verification_required",
        "Verify the existing email channel before enrolling a recovery key.",
      );
      return;
    }
    const factors = await tx("seller_factors").where({
      user_id: session.user.id,
    });
    check(
      factors.length < 10,
      409,
      "factor_limit",
      "At most ten security factors are allowed.",
    );
    if (factors.length)
      return this.require(req, tx, session, { action: "security.manage" });
    // Bootstrap the first factor through the existing fresh email verification.
    const supplied = req.headers["x-account-verification"];
    check(
      typeof supplied === "string" && supplied.length <= 200,
      403,
      "verification_required",
      "Verify your email before enrolling your first security factor.",
    );
    const row = await tx("account_challenges")
      .where({
        user_id: session.user.id,
        session_hash: session.sessionHash,
        purpose: "grant:security_enroll",
        token_hash: hash(supplied),
      })
      .andWhere("expires_at", ">", Date.now())
      .first();
    check(
      row,
      403,
      "verification_required",
      "Fresh email verification is required to enroll your first security factor.",
    );
    await tx("account_challenges").where({ id: row.id }).delete();
  }
  async emailLogin(req: FastifyRequest, enabled: boolean) {
    return this.session(req, async (tx, session) => {
      await this.require(req, tx, session, {
        action: "security.email_login",
        enabled,
      });
      check(
        enabled ||
          (await tx("seller_factors")
            .where({ user_id: session.user.id })
            .first()),
        409,
        "login_lockout",
        "Enroll a passkey or security key before disabling email sign-in.",
      );
      await tx("seller_users")
        .where({ id: session.user.id })
        .update({ email_login_disabled: enabled ? 0 : 1 });
      await tx("seller_login_tokens")
        .where({ user_id: session.user.id })
        .delete();
      await this.audit(tx, session.user.id, "seller.email_login.changed", {
        enabled,
      });
      return { emailLoginEnabled: enabled };
    });
  }
  async removeFactor(req: FastifyRequest, factorId: string) {
    return this.session(req, async (tx, session) => {
      await this.require(req, tx, session, {
        action: "security.remove",
        factorId,
      });
      const factor = await tx("seller_factors")
        .where({ id: factorId, user_id: session.user.id })
        .first();
      check(factor, 404, "not_found", "Security factor not found.");
      const user = await tx<SellerUser>("seller_users")
        .where({ id: session.user.id })
        .first();
      const remaining = await tx("seller_factors")
        .where({ user_id: session.user.id })
        .whereNot({ id: factorId })
        .first();
      check(
        !user!.email_login_disabled || remaining,
        409,
        "login_lockout",
        "Enable email sign-in or enroll another key before removing your last key.",
      );
      if (
        await tx("auth_hardware_approvals")
          .where({ factor_id: factorId, user_id: session.user.id })
          .first()
      )
        await revokePublishingGrants(tx, session.user.id);
      await tx("seller_factors").where({ id: factorId }).delete();
      await bumpAuthGeneration(tx, session);
      await tx("seller_sessions")
        .where({ user_id: session.user.id, auth_factor_id: factorId })
        .delete();
      await tx("seller_factor_challenges")
        .where({ user_id: session.user.id })
        .delete();
      await tx("account_challenges")
        .where({ user_id: session.user.id, purpose: "strong" })
        .delete();
      await authNotice(
        tx,
        this.auth.config.secret,
        session.user.id,
        "seller.factor.removed",
        {
          factorId,
        },
      );
      return { ok: true };
    });
  }
  get loginCookieName() {
    return this.auth.config.production
      ? "__Host-de-passkey-login"
      : "de-passkey-login";
  }
  async loginOptions(req: FastifyRequest, reply: FastifyReply) {
    this.auth.origin(req);
    const options = await generateAuthenticationOptions({
      rpID: new URL(this.auth.config.origin).hostname,
      userVerification: "required",
    });
    const browser = random();
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await tx("passkey_login_challenges")
        .where("expires_at", "<=", Date.now())
        .delete();
      const previous = req.cookies[this.loginCookieName];
      if (previous)
        await tx("passkey_login_challenges")
          .where({ id: hash(previous) })
          .delete();
      await tx("passkey_login_challenges").insert({
        id: hash(browser),
        challenge: options.challenge,
        expires_at: Date.now() + 300000,
      });
    });
    reply.setCookie(this.loginCookieName, browser, {
      path: "/",
      httpOnly: true,
      secure: this.auth.config.production,
      sameSite: "lax",
      maxAge: 300,
    });
    return { options };
  }
  async login(
    req: FastifyRequest,
    reply: FastifyReply,
    response: AuthenticationResponseJSON,
  ) {
    this.auth.origin(req);
    const cookie = req.cookies[this.loginCookieName];
    check(
      typeof cookie === "string" && /^[A-Za-z0-9_-]{43}$/.test(cookie),
      401,
      "passkey_login_invalid",
      "Start a fresh passkey or security key sign-in.",
    );
    const token = random();
    const challenge = await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const row = await tx("passkey_login_challenges")
        .where({ id: hash(cookie) })
        .andWhere("expires_at", ">", Date.now())
        .first();
      await tx("passkey_login_challenges")
        .where({ id: hash(cookie) })
        .delete();
      return row;
    });
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const factor = await tx<Factor>("seller_factors")
        .where({ credential_hash: hash(response.id) })
        .first();
      const user =
        factor &&
        (await tx<SellerUser>("seller_users")
          .where({ id: factor.user_id })
          .whereNotNull("verified_at")
          .first());
      check(
        challenge &&
          factor &&
          user &&
          (this.auth.config.deploymentMode !== "standalone" ||
            user.email === this.auth.config.standaloneOwnerEmail),
        401,
        "passkey_login_invalid",
        "Passkey or security key sign-in could not be verified.",
      );
      const stored = unseal<{ id: string; publicKey: string }>(
        factor.payload,
        this.auth.config.secret,
      );
      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: this.auth.config.origin,
          expectedRPID: new URL(this.auth.config.origin).hostname,
          requireUserVerification: true,
          credential: {
            id: stored.id,
            publicKey: Buffer.from(stored.publicKey, "base64url"),
            counter: Number(factor.counter),
          },
        });
      } catch {
        throw new AppError(
          401,
          "passkey_login_invalid",
          "Passkey or security key sign-in could not be verified.",
        );
      }
      check(
        verified.verified && verified.authenticationInfo.userVerified &&
          (!response.response.userHandle ||
            response.response.userHandle ===
              Buffer.from(user.id).toString("base64url")),
        401,
        "passkey_login_invalid",
        "Passkey or security key sign-in could not be verified.",
      );
      check(
        factor.backup_eligible === null ||
          Number(factor.backup_eligible) ===
            (verified.authenticationInfo.credentialDeviceType === "multiDevice"
              ? 1
              : 0),
        403,
        "credential_properties_changed",
        "Credential backup eligibility does not match its enrollment.",
      );
      await tx("seller_factors")
        .where({ id: factor.id })
        .update({
          counter: verified.authenticationInfo.newCounter,
          backup_eligible:
            verified.authenticationInfo.credentialDeviceType === "multiDevice"
              ? 1
              : 0,
          backed_up: verified.authenticationInfo.credentialBackedUp ? 1 : 0,
          user_verified: Number(verified.authenticationInfo.userVerified),
        });
      await tx("passkey_login_challenges")
        .where({ id: hash(cookie) })
        .delete();
      if (this.auth.config.deploymentMode === "standalone")
        await tx("seller_memberships")
          .insert({
            tenant_id: "primary",
            user_id: user.id,
            role: "owner",
            created_at: Date.now(),
          })
          .onConflict(["tenant_id", "user_id"])
          .ignore();
      await tx("seller_sessions").insert({
        id: hash(token),
        user_id: user.id,
        auth_method: "webauthn",
        auth_factor_id: factor.id,
        auth_generation: Number(user.security_generation),
        auth_verified_at: Date.now(),
        created_at: Date.now(),
        recovery_id:
          factor.recovery_id && factor.provenance === "recovery"
            ? factor.recovery_id
            : null,
        expires_at: Date.now() + 7 * 86400000,
      });
      await this.audit(tx, user.id, "seller.login", { method: factor.kind });
    });
    reply.clearCookie(this.loginCookieName, {
      path: "/",
      httpOnly: true,
      secure: this.auth.config.production,
      sameSite: "lax",
    });
    reply.setCookie(this.auth.cookieName, token, {
      path: "/",
      httpOnly: true,
      secure: this.auth.config.production,
      sameSite: "lax",
      maxAge: 7 * 86400,
    });
    return { ok: true };
  }
  async startEnrollment(
    req: FastifyRequest,
    label: string,
    kind: "passkey" | "security_key",
  ) {
    await this.attempts(req);
    return this.session(req, async (tx, session) => {
      await this.enrollment(req, tx, session);
      const existing = await tx<Factor>("seller_factors").where({
        user_id: session.user.id,
      });
      const options = await generateRegistrationOptions({
        rpName: "Entitle",
        rpID: new URL(this.auth.config.origin).hostname,
        userID: new TextEncoder().encode(session.user.id),
        userName: session.user.email,
        supportedAlgorithmIDs: [-7, -257],
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "required",
          userVerification: "required",
          ...(kind === "security_key"
            ? { authenticatorAttachment: "cross-platform" as const }
            : {}),
        },
        preferredAuthenticatorType:
          kind === "security_key" ? "securityKey" : "localDevice",
        excludeCredentials: existing.map((f) => ({
          id: unseal<WebAuthnCredential>(f.payload, this.auth.config.secret).id,
        })),
      });
      return {
        challengeId: await this.challenge(tx, session, "enroll:passkey", {
          challenge: options.challenge,
          name: label,
          kind,
        }),
        options,
      };
    });
  }
  async finishEnrollment(
    req: FastifyRequest,
    challengeId: string,
    response: RegistrationResponseJSON,
  ) {
    await this.attempts(req);
    const challenge = await this.session(req, (tx, session) =>
      this.consume(tx, session, challengeId, "enroll:passkey"),
    );
    return this.session(req, async (tx, session) => {
      check(
        challenge.generation ===
          Number(
            (await currentAuthSession(tx, session)).user.security_generation,
          ),
        403,
        "reauth_required",
        "Start enrollment again.",
      );
      const recovery = (await currentAuthSession(tx, session)).row.recovery_id
        ? await activeRecovery(tx, session)
        : null;
      const count = await tx("seller_factors")
        .where({
          user_id: session.user.id,
          ...(recovery ? { recovery_id: recovery.id } : {}),
        })
        .count("* as count")
        .first();
      check(
        Number(count!.count) < 10,
        409,
        "factor_limit",
        "At most ten security factors are allowed.",
      );
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge.challenge!,
          expectedOrigin: this.auth.config.origin,
          expectedRPID: new URL(this.auth.config.origin).hostname,
          requireUserVerification: true,
          supportedAlgorithmIDs: [-7, -257],
        });
      } catch {
        throw new AppError(
          403,
          "reauth_invalid",
          "Passkey or security key registration could not be verified.",
        );
      }
      check(
        verified.verified && verified.registrationInfo?.userVerified,
        403,
        "reauth_invalid",
        "Passkey or security key registration could not be verified.",
      );
      const credential = verified.registrationInfo.credential;
      const credentialHash = hash(credential.id);
      check(
        !(await tx("seller_factors")
          .where({ credential_hash: credentialHash })
          .first()),
        409,
        "factor_exists",
        "This credential is already registered.",
      );
      const id = randomUUID();
      await tx("seller_factors").insert({
        id,
        user_id: session.user.id,
        kind: challenge.kind!,
        name: challenge.name!,
        payload: seal(
          {
            ...credential,
            publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          },
          this.auth.config.secret,
        ),
        counter: credential.counter,
        credential_hash: credentialHash,
        provenance: recovery ? "recovery" : "ordinary",
        recovery_id: recovery?.id ?? null,
        backup_eligible:
          verified.registrationInfo.credentialDeviceType === "multiDevice"
            ? 1
            : 0,
        backed_up: verified.registrationInfo.credentialBackedUp ? 1 : 0,
        user_verified: Number(verified.registrationInfo.userVerified),
        created_at: Date.now(),
      });
      await tx("seller_factor_challenges")
        .where({ user_id: session.user.id, kind: "enroll:passkey" })
        .delete();
      if (!recovery) await bumpAuthGeneration(tx, session);
      await authNotice(
        tx,
        this.auth.config.secret,
        session.user.id,
        "seller.factor.enrolled",
        {
          kind: challenge.kind!,
          id,
        },
      );
      return { id, kind: challenge.kind! };
    });
  }
  async options(req: FastifyRequest, intent: StrongIntent) {
    await this.attempts(req);
    return this.session(req, async (tx, session) => {
      const live = await currentAuthSession(tx, session);
      const factors = await tx<Factor>("seller_factors").where({
        user_id: session.user.id,
        ...(live.row.recovery_id ? { recovery_id: live.row.recovery_id } : {}),
      });
      check(
        factors.length,
        403,
        "factor_required",
        "Enroll a passkey or security key before changing trusted publishers.",
      );
      const options = await generateAuthenticationOptions({
        rpID: new URL(this.auth.config.origin).hostname,
        userVerification: "required",
        allowCredentials: factors.map((f) => ({
          id: unseal<WebAuthnCredential>(f.payload, this.auth.config.secret).id,
        })),
      });
      return {
        challengeId: await this.challenge(tx, session, "reauth", {
          challenge: options.challenge,
          intent: strongIntentSchema.parse(intent),
        }),
        options,
      };
    });
  }
  async verify(
    req: FastifyRequest,
    challengeId: string,
    response: AuthenticationResponseJSON,
  ) {
    await this.attempts(req);
    const challenge = await this.session(req, (tx, session) =>
      this.consume(tx, session, challengeId, "reauth"),
    );
    return this.session(req, async (tx, session) => {
      check(
        challenge.generation ===
          Number(
            (await currentAuthSession(tx, session)).user.security_generation,
          ),
        403,
        "reauth_required",
        "Start verification again.",
      );
      const factor = await tx<Factor>("seller_factors")
        .where({ user_id: session.user.id, credential_hash: hash(response.id) })
        .first();
      check(
        factor,
        403,
        "reauth_invalid",
        "Passkey or security key is not registered to this account.",
      );
      const stored = unseal<{ id: string; publicKey: string }>(
        factor.payload,
        this.auth.config.secret,
      );
      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response,
          expectedChallenge: challenge.challenge!,
          expectedOrigin: this.auth.config.origin,
          expectedRPID: new URL(this.auth.config.origin).hostname,
          requireUserVerification: true,
          credential: {
            id: stored.id,
            publicKey: Buffer.from(stored.publicKey, "base64url"),
            counter: Number(factor.counter),
          },
        });
      } catch {
        throw new AppError(
          403,
          "reauth_invalid",
          "Passkey or security key authentication could not be verified.",
        );
      }
      check(
        verified.verified && verified.authenticationInfo.userVerified,
        403,
        "reauth_invalid",
        "Passkey or security key authentication could not be verified.",
      );
      check(
        factor.backup_eligible === null ||
          Number(factor.backup_eligible) ===
            (verified.authenticationInfo.credentialDeviceType === "multiDevice"
              ? 1
              : 0),
        403,
        "credential_properties_changed",
        "Credential backup eligibility does not match its enrollment.",
      );
      await tx("seller_factors")
        .where({ id: factor.id })
        .update({
          counter: verified.authenticationInfo.newCounter,
          backup_eligible:
            verified.authenticationInfo.credentialDeviceType === "multiDevice"
              ? 1
              : 0,
          backed_up: verified.authenticationInfo.credentialBackedUp ? 1 : 0,
          user_verified: Number(verified.authenticationInfo.userVerified),
        });
      await assertCapability(
        tx,
        session,
        factor.id,
        challenge.intent!,
        this.auth.config.secret,
      );
      const verification = random();
      await tx("account_challenges").insert({
        id: randomUUID(),
        user_id: session.user.id,
        session_hash: session.sessionHash,
        purpose: "strong",
        auth_generation: Number(
          (await currentAuthSession(tx, session)).user.security_generation,
        ),
        factor_id: factor.id,
        token_hash: hash(verification),
        second_hash: hash(canonicalAuth(challenge.intent)),
        created_at: Date.now(),
        expires_at: Date.now() + 300000,
      });
      await this.audit(tx, session.user.id, "seller.reauthenticated", {
        method: factor.kind,
        action: challenge.intent!.action,
      });
      return { verification, expiresIn: 300 };
    });
  }
}

export async function strongAuthRoutes(app: FastifyInstance, auth: StrongAuth) {
  app.get("/security", (req) => auth.status(req));
  app.post("/security/passkey/enroll", { config: limit }, (req) => {
    const input = z
      .object({
        name,
        kind: z.enum(["passkey", "security_key"]).default("passkey"),
      })
      .strict()
      .parse(req.body);
    return auth.startEnrollment(req, input.name, input.kind);
  });
  app.post("/security/passkey/confirm", { config: limit }, (req) => {
    const input = z
      .object({ challengeId: z.uuid(), response })
      .strict()
      .parse(req.body);
    return auth.finishEnrollment(
      req,
      input.challengeId,
      input.response as unknown as RegistrationResponseJSON,
    );
  });
  app.post("/security/email-login", { config: limit }, (req) => {
    const { enabled } = z
      .object({ enabled: z.boolean() })
      .strict()
      .parse(req.body);
    return auth.emailLogin(req, enabled);
  });
  app.post("/security/factors/:id/remove", { config: limit }, (req) => {
    z.object({}).strict().parse(req.body);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return auth.removeFactor(req, id);
  });
  app.post("/reauth/options", { config: limit }, (req) =>
    auth.options(req, strongIntentSchema.parse(req.body)),
  );
  app.post("/reauth/verify", { config: limit }, (req) => {
    const input = z
      .object({
        challengeId: z.uuid(),
        response: response.refine(
          (value) => typeof value.id === "string" && value.id.length <= 2000,
        ),
      })
      .strict()
      .parse(req.body);
    return auth.verify(
      req,
      input.challengeId,
      input.response as unknown as AuthenticationResponseJSON,
    );
  });
}

export async function passkeyLoginRoutes(
  app: FastifyInstance,
  auth: StrongAuth,
) {
  app.post("/auth/passkey/options", { config: limit }, (req, reply) => {
    z.object({}).strict().parse(req.body);
    return auth.loginOptions(req, reply);
  });
  app.post("/auth/passkey/verify", { config: limit }, (req, reply) => {
    const input = z
      .object({
        response: response.refine(
          (value) => typeof value.id === "string" && value.id.length <= 2000,
        ),
      })
      .strict()
      .parse(req.body);
    return auth.login(
      req,
      reply,
      input.response as unknown as AuthenticationResponseJSON,
    );
  });
}
