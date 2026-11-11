import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { lock, type DB, type Tx } from "./db.ts";
import type { PlatformAuth, SellerSession } from "./platform-auth.ts";
import { check } from "./errors.ts";
import { hash, random, seal, unseal } from "./crypto.ts";
import {
  revokePublishingGrants,
  activeRecovery,
  approvedHardware,
  authNotice,
  consumeCapabilityProof,
  currentAuthSession,
  type AuthFactor,
  type RecoveryFlow,
} from "./auth-policy.ts";

const day = 86400000;
export async function beginRecovery(
  tx: Tx,
  userId: string,
  secret: string,
  mode: RecoveryFlow["mode"],
) {
  // Starting another proved flow supersedes only recovery material, not original keys.
  const old = await tx<RecoveryFlow>("auth_recoveries").where({
    user_id: userId,
    state: "restricted",
  });
  check(
    mode === "infrastructure" ||
      !old.some(
        (f) => f.mode === "infrastructure" && f.expires_at > Date.now(),
      ),
    409,
    "operator_recovery_active",
    "Contact your operator to continue infrastructure recovery.",
  );
  for (const flow of old) await cancelRecovery(tx, flow, secret);
  const user = await tx("seller_users").where({ id: userId }).first();
  check(user, 404, "not_found", "Account not found.");
  const permit = random(),
    id = randomUUID(),
    now = Date.now();
  await tx("auth_recoveries").insert({
    id,
    user_id: userId,
    mode,
    state: "restricted",
    generation: Number(user.security_generation),
    permit_hash: mode === "infrastructure" ? hash(permit) : null,
    not_before: now + (mode === "infrastructure" ? day : 0),
    expires_at: now + 7 * day,
    created_at: now,
  });
  await tx("seller_users")
    .where({ id: userId })
    .update({ privileged_suspended: 1 });
  await authNotice(tx, secret, userId, "seller.recovery.started", {
    flowId: id,
    mode,
  });
  return { id, permit, notBefore: now + (mode === "infrastructure" ? day : 0) };
}
export async function cancelRecovery(
  tx: Tx,
  flow: RecoveryFlow,
  secret: string,
) {
  await tx("seller_sessions").where({ recovery_id: flow.id }).delete();
  await tx("seller_factors").where({ recovery_id: flow.id }).delete();
  // Enrollment challenges are bound to the restricted sessions; orphaned rows carry no authority.
  await tx("seller_factor_challenges")
    .where({ user_id: flow.user_id })
    .delete();
  await tx("account_challenges").where({ user_id: flow.user_id }).delete();
  await tx("auth_recoveries")
    .where({ id: flow.id })
    .update({ state: "canceled", permit_hash: null });
  await tx("seller_users")
    .where({ id: flow.user_id })
    .update({ privileged_suspended: 0 });
  await authNotice(tx, secret, flow.user_id, "seller.recovery.canceled", {
    flowId: flow.id,
  });
}
export async function completeRecovery(
  tx: Tx,
  flow: RecoveryFlow,
  secret: string,
) {
  const user = await tx("seller_users").where({ id: flow.user_id }).first();
  check(
    user &&
      flow.state === "restricted" &&
      Number(flow.generation) === Number(user.security_generation) &&
      flow.expires_at > Date.now(),
    403,
    "recovery_invalid",
    "Recovery is no longer active.",
  );
  if (flow.mode === "infrastructure") {
    check(
      flow.not_before <= Date.now(),
      409,
      "recovery_delay",
      "The recovery objection period has not ended.",
    );
    check(
      (await approvedHardware(tx, flow.user_id, secret, flow.id)).length >= 2,
      403,
      "hardware_required",
      "Provision two independent replacement hardware keys.",
    );
  } else
    check(
      flow.channel_verified_at &&
        (await tx("seller_factors")
          .where({ user_id: flow.user_id, recovery_id: flow.id })
          .first()),
      403,
      "recovery_incomplete",
      "Verify the existing email channel and enroll a replacement key.",
    );
  await tx("seller_factors")
    .where({ user_id: flow.user_id })
    .where((q) => q.whereNull("recovery_id").orWhereNot("recovery_id", flow.id))
    .delete();
  await tx("seller_factors")
    .where({ user_id: flow.user_id, recovery_id: flow.id })
    .update({
      provenance:
        flow.mode === "infrastructure"
          ? "infrastructure_recovered"
          : "ordinary_recovered",
    });
  await tx("seller_sessions").where({ user_id: flow.user_id }).delete();
  await tx("seller_login_tokens").where({ user_id: flow.user_id }).delete();
  await tx("account_challenges").where({ user_id: flow.user_id }).delete();
  await tx("seller_factor_challenges")
    .where({ user_id: flow.user_id })
    .delete();
  await tx("account_recovery_codes").where({ user_id: flow.user_id }).delete();
  // A recovered owner must review/recreate every software-publishing delegation.
  await revokePublishingGrants(tx, flow.user_id);
  await tx("seller_users")
    .where({ id: flow.user_id })
    .update({
      security_generation: Number(user.security_generation) + 1,
      recovered_ordinary: flow.mode === "ordinary" ? 1 : 0,
      privileged_suspended: 0,
    });
  await tx("auth_recoveries")
    .where({ id: flow.id })
    .update({ state: "complete", permit_hash: null });
  await authNotice(tx, secret, flow.user_id, "seller.recovery.completed", {
    flowId: flow.id,
    mode: flow.mode,
  });
}

/** Host/database authority is the independent trust root. Never register this on HTTP/MCP. */
export class AuthProvisioner {
  readonly db: DB;
  readonly secret: string;
  constructor(db: DB, secret: string) {
    this.db = db;
    this.secret = secret;
  }
  async approve(input: {
    userId: string;
    factorId: string;
    publicKeyHash: string;
    inventoryId: string;
    operator: string;
    reference: string;
  }) {
    for (const value of Object.values(input))
      check(
        typeof value === "string" && value.length > 0 && value.length <= 200,
        400,
        "invalid_input",
        "Supply bounded provisioning identifiers.",
      );
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const factor = await tx<AuthFactor>("seller_factors")
        .where({ id: input.factorId, user_id: input.userId })
        .first();
      const user = await tx("seller_users").where({ id: input.userId }).first();
      check(factor && user, 404, "not_found", "Credential not found.");
      check(
        factor.backup_eligible === 0 &&
          factor.backed_up === 0 &&
          factor.user_verified === 1,
        403,
        "hardware_required",
        "Verified non-backup-eligible user-verified enrollment is required.",
      );
      const publicKeyHash = hash(
        unseal<{ publicKey: string }>(factor.payload, this.secret).publicKey,
      );
      check(
        publicKeyHash === input.publicKeyHash,
        403,
        "credential_mismatch",
        "The inventoried credential fingerprint does not match.",
      );
      if (factor.recovery_id) {
        const flow = await tx<RecoveryFlow>("auth_recoveries")
          .where({
            id: factor.recovery_id,
            user_id: user.id,
            state: "restricted",
            mode: "infrastructure",
            generation: Number(user.security_generation),
          })
          .andWhere("expires_at", ">", Date.now())
          .first();
        check(
          flow,
          403,
          "recovery_restricted",
          "Ordinary recovery cannot provision privileged credentials. Start infrastructure recovery.",
        );
      } else
        check(
          !user.recovered_ordinary,
          403,
          "recovery_restricted",
          "Infrastructure recovery is required to restore privileges.",
        );
      check(
        !(await tx("auth_hardware_approvals")
          .where({ user_id: user.id, inventory_id: input.inventoryId })
          .first()),
        409,
        "inventory_exists",
        "Use a distinct inventoried physical key.",
      );
      await tx("auth_hardware_approvals").insert({
        factor_id: factor.id,
        user_id: user.id,
        public_key_hash: publicKeyHash,
        inventory_id: input.inventoryId,
        operator_id: input.operator,
        reference: input.reference,
        recovery_id: factor.recovery_id,
        approved_at: Date.now(),
      });
      await authNotice(
        tx,
        this.secret,
        user.id,
        "seller.hardware.provisioned",
        {
          factorId: factor.id,
          operator: input.operator,
          reference: input.reference,
          inventoryId: input.inventoryId,
          assurance: "operational",
        },
      );
      return { ok: true };
    });
  }
  async start(userId: string, operator: string, reference: string) {
    check(
      operator &&
        reference &&
        operator.length <= 150 &&
        reference.length <= 200,
      400,
      "invalid_input",
      "Identify the operator and recovery authorization.",
    );
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const flow = await beginRecovery(
        tx,
        userId,
        this.secret,
        "infrastructure",
      );
      await authNotice(tx, this.secret, userId, "seller.recovery.authorized", {
        operator,
        reference,
        flowId: flow.id,
      });
      return flow;
    });
  }
  async complete(flowId: string, operator: string, reference: string) {
    check(
      operator &&
        reference &&
        operator.length <= 150 &&
        reference.length <= 200,
      400,
      "invalid_input",
      "Identify the operator and recovery authorization.",
    );
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const flow = await tx<RecoveryFlow>("auth_recoveries")
        .where({ id: flowId, mode: "infrastructure" })
        .first();
      check(flow, 404, "not_found", "Recovery not found.");
      await completeRecovery(tx, flow, this.secret);
      await authNotice(
        tx,
        this.secret,
        flow.user_id,
        "seller.recovery.promoted",
        { operator, reference, flowId },
      );
      return { ok: true };
    });
  }
}

export class AuthRecovery {
  readonly db: DB;
  readonly auth: PlatformAuth;
  constructor(db: DB, auth: PlatformAuth) {
    this.db = db;
    this.auth = auth;
  }
  private async action<T>(
    req: FastifyRequest,
    mutation: boolean,
    run: (tx: Tx, s: SellerSession, flow: RecoveryFlow) => Promise<T>,
  ) {
    const s = await this.auth.seller(req, mutation, true);
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      return run(tx, s, await activeRecovery(tx, s));
    });
  }
  async status(req: FastifyRequest) {
    return this.action(req, false, async (_tx, s, flow) => ({
      id: flow.id,
      mode: flow.mode,
      channelVerified: !!flow.channel_verified_at,
      notBefore: Number(flow.not_before),
      expiresAt: Number(flow.expires_at),
      csrfToken: s.csrfToken,
    }));
  }
  async requestChannel(req: FastifyRequest) {
    return this.action(req, true, async (tx, s, flow) => {
      check(
        flow.mode === "ordinary",
        409,
        "channel_unneeded",
        "Infrastructure recovery uses operator authorization.",
      );
      const recent = await tx("account_challenges")
        .where({ user_id: s.user.id, purpose: "recovery:channel" })
        .andWhere("created_at", ">", Date.now() - 60000)
        .first();
      check(
        !recent,
        429,
        "account_rate_limited",
        "Wait before requesting another recovery email.",
      );
      const token = random(),
        id = randomUUID();
      await tx("account_challenges").insert({
        id,
        user_id: s.user.id,
        session_hash: s.sessionHash,
        purpose: "recovery:channel",
        token_hash: hash(token),
        second_hash: hash(flow.id),
        auth_generation: flow.generation,
        created_at: Date.now(),
        expires_at: Date.now() + 600000,
      });
      await tx("platform_emails").insert({
        id,
        kind: "account_verification",
        created_at: Date.now(),
        payload: seal(
          {
            to: s.user.email,
            subject: "Entitle: confirm ordinary account recovery",
            text: `Enter this recovery confirmation in the browser where you started recovery: ${token}`,
            messageId: `<${id}@entitle>`,
          },
          this.auth.config.secret,
        ),
      });
      return { ok: true };
    });
  }
  async channel(req: FastifyRequest, token: string) {
    return this.action(req, true, async (tx, s, flow) => {
      const row = await tx("account_challenges")
        .where({
          user_id: s.user.id,
          session_hash: s.sessionHash,
          purpose: "recovery:channel",
          token_hash: hash(token),
          second_hash: hash(flow.id),
          auth_generation: flow.generation,
        })
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(
        row,
        403,
        "verification_required",
        "Verify the recovery email in this browser.",
      );
      await tx("account_challenges").where({ id: row.id }).delete();
      await tx("auth_recoveries")
        .where({ id: flow.id })
        .update({ channel_verified_at: Date.now() });
      return { ok: true };
    });
  }
  async complete(req: FastifyRequest) {
    return this.action(req, true, async (tx, s, flow) => {
      check(
        flow.mode === "ordinary",
        403,
        "operator_required",
        "Your operator must complete infrastructure recovery.",
      );
      const proof = req.headers["x-account-verification"];
      check(
        typeof proof === "string",
        403,
        "reauth_required",
        "Verify the replacement key to complete recovery.",
      );
      await consumeCapabilityProof(
        tx,
        s,
        proof,
        { action: "security.recovery_complete", flowId: flow.id },
        this.auth.config.secret,
      );
      await completeRecovery(tx, flow, this.auth.config.secret);
      return { ok: true, signInRequired: true };
    });
  }
  async cancel(req: FastifyRequest, flowId: string) {
    const s = await this.auth.seller(req, true, true);
    return this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const { row } = await currentAuthSession(tx, s);
      const flow = await tx<RecoveryFlow>("auth_recoveries")
        .where({ id: flowId, user_id: s.user.id, state: "restricted" })
        .first();
      check(flow, 404, "not_found", "Active recovery not found.");
      if (row.recovery_id !== flow.id) {
        const proof = req.headers["x-account-verification"];
        check(
          typeof proof === "string",
          403,
          "reauth_required",
          "Verify an existing key to cancel recovery.",
        );
        await consumeCapabilityProof(
          tx,
          s,
          proof,
          { action: "security.recovery_cancel", flowId },
          this.auth.config.secret,
        );
      }
      await cancelRecovery(tx, flow, this.auth.config.secret);
      return { ok: true };
    });
  }
  async redeem(req: FastifyRequest, reply: FastifyReply, permit: string) {
    this.auth.origin(req);
    const token = random();
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      const flow = await tx<RecoveryFlow>("auth_recoveries")
        .where({
          permit_hash: hash(permit),
          mode: "infrastructure",
          state: "restricted",
        })
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(
        flow,
        401,
        "recovery_invalid",
        "Recovery authorization is invalid or used.",
      );
      const user = await tx("seller_users").where({ id: flow.user_id }).first();
      check(
        user &&
          Number(user.security_generation) === flow.generation &&
          (this.auth.config.deploymentMode !== "standalone" ||
            user.email === this.auth.config.standaloneOwnerEmail),
        401,
        "recovery_invalid",
        "Recovery authorization is invalid or used.",
      );
      await tx("auth_recoveries")
        .where({ id: flow.id })
        .update({ permit_hash: null });
      await tx("seller_sessions").insert({
        id: hash(token),
        user_id: user.id,
        auth_method: "recovery",
        auth_generation: flow.generation,
        recovery_id: flow.id,
        created_at: Date.now(),
        expires_at: flow.expires_at,
      });
    });
    reply.setCookie(this.auth.cookieName, token, {
      path: "/",
      httpOnly: true,
      secure: this.auth.config.production,
      sameSite: "lax",
      maxAge: 7 * 86400,
    });
    return { ok: true, recoveryRestricted: true };
  }
}
export async function authRecoveryRoutes(
  app: FastifyInstance,
  service: AuthRecovery,
) {
  const limit = { rateLimit: { max: 10, timeWindow: "1 minute" } };
  const token = z.object({ token: z.string().min(1).max(200) }).strict();
  app.get("/recovery/status", (req) => service.status(req));
  app.post("/recovery/channel/request", { config: limit }, (req) => {
    z.object({}).strict().parse(req.body);
    return service.requestChannel(req);
  });
  app.post("/recovery/channel/consume", { config: limit }, (req) =>
    service.channel(req, token.parse(req.body).token),
  );
  app.post("/recovery/complete", { config: limit }, (req) => {
    z.object({}).strict().parse(req.body);
    return service.complete(req);
  });
  app.post("/recovery/cancel", { config: limit }, (req) =>
    service.cancel(
      req,
      z.object({ flowId: z.uuid() }).strict().parse(req.body).flowId,
    ),
  );
  app.post("/recovery/operator", { config: limit }, (req, reply) =>
    service.redeem(req, reply, token.parse(req.body).token),
  );
}
