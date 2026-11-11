import { randomUUID } from "node:crypto";
import type { Tx } from "./db.ts";
import { check } from "./errors.ts";
import { hash, seal, unseal } from "./crypto.ts";
import type { SellerSession, SellerUser } from "./platform-auth.ts";
import { strongIntentSchema, type StrongIntent } from "./strong-schema.ts";

export interface AuthFactor {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  payload: string;
  credential_hash: string;
  counter: number;
  provenance: string | null;
  recovery_id: string | null;
  backup_eligible: number | null;
  backed_up: number | null;
  user_verified: number;
}
export interface RecoveryFlow {
  id: string;
  user_id: string;
  mode: "ordinary" | "infrastructure";
  state: "restricted" | "complete" | "canceled";
  generation: number;
  permit_hash: string | null;
  channel_verified_at: number | null;
  not_before: number;
  expires_at: number;
  created_at: number;
}
export const privilegedPurposes = [
  "api_keys",
  "workspace_remove",
  "release_publish",
] as const;
export function canonicalAuth(value: unknown): string {
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalAuth((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function authNotice(
  tx: Tx,
  secret: string,
  userId: string,
  action: string,
  details: object = {},
) {
  const user = await tx<SellerUser>("seller_users")
    .where({ id: userId })
    .first();
  check(user, 404, "not_found", "Account not found.");
  const id = randomUUID();
  await tx("audit_events").insert({
    id,
    tenant_id: null,
    actor_type: "seller",
    actor_id: userId,
    action,
    details: JSON.stringify(details),
    created_at: Date.now(),
  });
  await tx("platform_emails").insert({
    id,
    kind: "account_security",
    created_at: Date.now(),
    payload: seal(
      {
        to: user.email,
        subject: "Entitle: account security update",
        text: `Account security changed: ${action}. ${"flowId" in details ? `Recovery reference: ${details.flowId}. ` : ""}If you did not initiate this, use an existing key or contact your Entitle operator.`,
        messageId: `<${id}@entitle>`,
      },
      secret,
    ),
  });
}
export async function currentAuthSession(tx: Tx, s: SellerSession) {
  const row = await tx("seller_sessions")
    .where({ id: s.sessionHash, user_id: s.user.id })
    .andWhere("expires_at", ">", Date.now())
    .first();
  const user = await tx<SellerUser>("seller_users")
    .where({ id: s.user.id })
    .first();
  check(
    row &&
      user?.verified_at != null &&
      Number(row.auth_generation) === Number(user.security_generation),
    401,
    "seller_login_required",
    "Sign in again.",
  );
  return { row, user };
}
export async function activeRecovery(tx: Tx, s: SellerSession) {
  const { row, user } = await currentAuthSession(tx, s);
  const flow =
    row.recovery_id &&
    (await tx<RecoveryFlow>("auth_recoveries")
      .where({
        id: row.recovery_id,
        user_id: user.id,
        state: "restricted",
        generation: Number(user.security_generation),
      })
      .andWhere("expires_at", ">", Date.now())
      .first());
  check(flow, 403, "recovery_required", "Start or resume account recovery.");
  return flow as RecoveryFlow;
}
export async function approvedHardware(
  tx: Tx,
  userId: string,
  secret: string,
  recoveryId?: string,
) {
  const rows = await tx<AuthFactor>("seller_factors").where({
    user_id: userId,
  });
  const eligible: AuthFactor[] = [];
  for (const f of rows) {
    if (
      Number(f.backup_eligible) !== 0 ||
      f.backup_eligible === null ||
      f.backed_up === null ||
      Number(f.backed_up) !== 0 ||
      Number(f.user_verified) !== 1
    )
      continue;
    if (
      recoveryId
        ? f.recovery_id !== recoveryId
        : !!f.recovery_id && f.provenance !== "infrastructure_recovered"
    )
      continue;
    const approval = await tx("auth_hardware_approvals")
      .where({ factor_id: f.id, user_id: userId })
      .first();
    const stored = unseal<{ publicKey: string }>(f.payload, secret);
    if (
      approval &&
      approval.public_key_hash === hash(stored.publicKey) &&
      (!recoveryId || approval.recovery_id === recoveryId)
    )
      eligible.push(f);
  }
  return eligible;
}
export async function assertCapability(
  tx: Tx,
  s: SellerSession,
  factorId: string,
  intent: StrongIntent,
  secret: string,
) {
  const { row, user } = await currentAuthSession(tx, s);

  const factor = await tx<AuthFactor>("seller_factors")
    .where({ id: factorId, user_id: user.id })
    .first();
  check(factor, 403, "reauth_required", "Verify with a current credential.");
  if (row.recovery_id) {
    const flow = await activeRecovery(tx, s);
    check(
      intent.action === "security.recovery_complete" &&
        intent.flowId === flow.id &&
        factor.recovery_id === flow.id,
      403,
      "recovery_restricted",
      "Complete recovery before changing account privileges.",
    );
    return factor;
  }
  if (intent.action === "security.recovery_cancel")
    check(
      !factor.recovery_id,
      403,
      "recovery_restricted",
      "Use a pre-existing credential to cancel another recovery.",
    );
  const privileged =
    intent.action.startsWith("oidc.") || intent.action === "account.privileged";
  const targetHardware =
    intent.action === "security.remove" &&
    (await tx("auth_hardware_approvals")
      .where({ factor_id: intent.factorId, user_id: user.id })
      .first());
  if (privileged || targetHardware) {
    const keys = await approvedHardware(tx, user.id, secret);
    check(
      !Number(user.recovered_ordinary) &&
        !Number(user.privileged_suspended) &&
        keys.some((k) => k.id === factorId) &&
        keys.length >= (privileged ? 2 : 1),
      403,
      "hardware_required",
      "This action requires independently provisioned hardware credentials. Contact your Entitle operator.",
    );
    if (targetHardware && intent.action === "security.remove")
      check(
        factorId !== intent.factorId,
        403,
        "remaining_key_required",
        "Use a remaining approved key to remove a hardware credential.",
      );
  }
  return factor;
}
export async function consumeCapabilityProof(
  tx: Tx,
  s: SellerSession,
  proof: string,
  intent: StrongIntent,
  secret: string,
  consume = true,
) {
  const { user } = await currentAuthSession(tx, s);
  const grant = await tx("account_challenges")
    .where({
      user_id: user.id,
      session_hash: s.sessionHash,
      purpose: "strong",
      token_hash: hash(proof),
      second_hash: hash(canonicalAuth(strongIntentSchema.parse(intent))),
      auth_generation: Number(user.security_generation),
    })
    .andWhere("expires_at", ">", Date.now())
    .first();
  check(
    grant?.factor_id,
    403,
    "reauth_required",
    "Fresh verification for this exact action is required.",
  );
  await assertCapability(tx, s, grant.factor_id, intent, secret);
  if (consume) await tx("account_challenges").where({ id: grant.id }).delete();
}
export async function bumpAuthGeneration(tx: Tx, s: SellerSession) {
  const { user } = await currentAuthSession(tx, s);
  const flows = await tx<RecoveryFlow>("auth_recoveries").where({
    user_id: user.id,
    state: "restricted",
  });
  for (const flow of flows) {
    await tx("seller_sessions").where({ recovery_id: flow.id }).delete();
    await tx("seller_factors").where({ recovery_id: flow.id }).delete();
    await tx("auth_recoveries")
      .where({ id: flow.id })
      .update({ state: "canceled", permit_hash: null });
  }
  if (flows.length)
    await tx("seller_users")
      .where({ id: user.id })
      .update({ privileged_suspended: 0 });
  const generation = Number(user.security_generation) + 1;
  await tx("seller_users")
    .where({ id: user.id })
    .update({ security_generation: generation });
  await tx("seller_sessions")
    .where({ id: s.sessionHash })
    .update({ auth_generation: generation });
  await tx("seller_factor_challenges").where({ user_id: user.id }).delete();
  await tx("account_challenges").where({ user_id: user.id }).delete();
}

export async function revokePublishingGrants(tx: Tx, userId: string) {
  const owned = tx("seller_memberships")
    .select("tenant_id")
    .where({ user_id: userId, role: "owner" });
  await tx("tenant_api_keys")
    .whereIn("tenant_id", owned)
    .whereNull("revoked_at")
    .update({ revoked_at: Date.now() });
  await tx("oidc_publishers")
    .whereIn("tenant_id", owned)
    .whereNull("revoked_at")
    .update({ revoked_at: Date.now() });
  await tx("oidc_sessions").whereIn("tenant_id", owned).delete();
}
