export interface Tenant {
  id: string;
  slug: string;
  name: string;
  stripe_account_id: string | null;
  stripe_status: string;
  platform_customer_id: string | null;
  platform_subscription_id: string | null;
  billing_status: string;
  paid_through: number;
  trial_ends_at: number;
  exempt: number;
  suspended: number;
  max_products: number;
  max_storage_bytes: number;
  created_at: number;
  archived_at?: number | null;
  parent_archived_at?: number | null;
  sandbox_parent_slug?: string | null;
  pro_paid_through?: number;
  pro_period_start?: number;
  platform_billing_revision?: number;
  automatic_tax?: number;
  collect_tax_id?: number;
  collect_billing_address?: number;
}

export const workspaceArchived = (tenant: Tenant): boolean =>
  !!(tenant.archived_at || tenant.parent_archived_at);
