import type { Tenant, Tx } from "./db.ts";
import type { Config } from "./config.ts";
import { check } from "./errors.ts";
import { tenantAvailable } from "./tenants.ts";

export interface PublicationPolicy {
  deploymentMode: Config["deploymentMode"];
  graceDays?: number | undefined;
}

// Call within the mutation's schema or billing transaction. Row locks serialize
// current authority with operator/platform billing writes that use other mutexes.
// SQLite callers already hold a write lock through their transaction mutex.
export async function requireTenantCapacity(
  tx: Tx,
  tenantId: string,
  policy: Readonly<PublicationPolicy>,
): Promise<Tenant> {
  const sandbox = await tx("publisher_sandboxes")
    .where({ sandbox_tenant_id: tenantId })
    .first("parent_tenant_id");
  const authorityId = sandbox?.parent_tenant_id ?? tenantId;
  const tenants = new Map<string, Tenant>();
  for (const id of [...new Set<string>([tenantId, authorityId])].sort()) {
    const tenant = await tx<Tenant>("tenants")
      .where({ id })
      .forUpdate()
      .first();
    check(tenant, 404, "not_found", "Tenant not found.");
    tenants.set(id, tenant);
    check(
      tenantAvailable(tenant, "buyer"),
      403,
      "tenant_suspended",
      "This publisher's service is suspended.",
    );
  }
  const authority = tenants.get(authorityId)!;
  if (policy.deploymentMode === "hosted")
    check(
      tenantAvailable(
        authority,
        "capacity",
        (policy.graceDays ?? 7) * 86400000,
      ),
      403,
      "tenant_capacity",
      "Renew the platform subscription or contact the operator before adding capacity.",
    );
  return tenants.get(tenantId)!;
}

export { requireTenantCapacity as requirePublicationTenant };
