import { z } from "zod";
import type { DB, Tx } from "./db.ts";
import { lock } from "./db.ts";
import { hash } from "./crypto.ts";
import { AppError, check } from "./errors.ts";
import type { OutboundWebhooks } from "./outbound-webhooks.ts";
import { enqueueEmail } from "./email.ts";
import { lifecycleEmail } from "./transactional-email.ts";

const settingsSchema = z.object({
  failureThreshold: z.number().int().min(1).max(1000000),
  pendingAgeMs: z.number().int().min(1000).max(30 * 86400000),
  storageRatio: z.number().min(0.01).max(1),
  bandwidthBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  cooldownMs: z.number().int().min(1000).max(30 * 86400000),
  notificationsEnabled: z.boolean(), warningDays: z.number().int().min(1).max(90),
}).strict();
export type OperationSettings = z.infer<typeof settingsSchema>;
const defaults: OperationSettings = {failureThreshold: 1, pendingAgeMs: 3600000, storageRatio: 0.9, bandwidthBytes: 0, cooldownMs: 3600000, notificationsEnabled: true, warningDays: 7};
export interface OperationAlert { id: string; kind: string; occurredAt: number; }
interface QueueHealth { failed: number; pending: number; completed: number; canceled: number; total: number; oldestAgeMs: number; }

export class Operations {
  readonly db: DB;
  readonly tenantId: string;
  constructor(db: DB, tenantId: string) { this.db=db; this.tenantId=tenantId; }
  private async readSettings(db: Tx) {
    const row = await db("operation_settings").where({tenant_id: this.tenantId}).first();
    return row ? settingsSchema.parse(JSON.parse(row.settings)) : {...defaults};
  }
  async settings(): Promise<OperationSettings> { return this.readSettings(this.db); }
  async configure(input: unknown) {
    const patch = settingsSchema.partial().parse(input);
    return this.db.transaction(async tx => {
      await lock(tx, "work", this.tenantId);
      const settings = {...await this.readSettings(tx), ...patch};
      await tx("operation_settings").insert({tenant_id:this.tenantId, settings:JSON.stringify(settings)})
        .onConflict("tenant_id").merge({settings:JSON.stringify(settings)});
      return settings;
    });
  }
  async summary(now = Date.now()) {
    const queues: Record<string, QueueHealth> = {};
    for (const table of ["work", "emails", "outbound_deliveries"]) {
      const row = await this.db(table).where({tenant_id:this.tenantId}).select(
        this.db.raw("count(*) as ??", ["total"]),
        this.db.raw("sum(case when ?? = ? then 1 else 0 end) as ??", ["state","sent","completed"]),
        this.db.raw("sum(case when ?? = ? then 1 else 0 end) as ??", ["state","canceled","canceled"]),
        this.db.raw("sum(case when ?? = ? then 1 else 0 end) as ??", ["state","failed","failed"]),
        this.db.raw("sum(case when ?? in (?, ?) then 1 else 0 end) as ??", ["state","pending","running","pending"]),
        this.db.raw("min(case when ?? in (?, ?) then ?? else null end) as ??", ["state","pending","running","created_at","oldest"]),
      ).first();
      queues[table] = {failed:Number(row.failed ?? 0),pending:Number(row.pending ?? 0),completed:Number(row.completed ?? 0),canceled:Number(row.canceled ?? 0),total:Number(row.total),oldestAgeMs:row.oldest === null ? 0 : Math.max(0, now-Number(row.oldest))};
    }
    const tenant = await this.db("tenants").where({id:this.tenantId}).first();
    check(tenant,404,"tenant_missing","Tenant not found.");
    const releases = await this.db("releases").where({tenant_id:this.tenantId}).sum("size as bytes").first();
    const reservations = await this.db("upload_reservations").where({tenant_id:this.tenantId}).andWhere("expires_at",">",now).sum("bytes as bytes").first();
    const bandwidth = await this.db("download_metrics").where({tenant_id:this.tenantId})
      .andWhere("day",">=",new Date(now-30*86400000).toISOString().slice(0,10))
      .sum({served:"served_bytes",read:"storage_read_bytes",reads:"storage_reads"}).first();
    return {queues,storage:{usedBytes:Number(releases!.bytes ?? 0),reservedBytes:Number(reservations!.bytes ?? 0),limitBytes:Number(tenant.max_storage_bytes)},
      bandwidth:{servedBytes:Number(bandwidth!.served ?? 0),storageReadBytes:Number(bandwidth!.read ?? 0),storageReads:Number(bandwidth!.reads ?? 0)},
      billingCapacityWarning:!tenant.exempt && (tenant.suspended || ["past_due","unpaid","canceled","incomplete_expired"].includes(tenant.billing_status) || (tenant.billing_status === "trial" && Number(tenant.trial_ends_at) <= now)) ? true : false};
  }
  async activity(days = 30, now = Date.now()) {
    z.number().int().min(1).max(365).parse(days);
    const dayMs = 86400000;
    const today = Math.floor(now / dayMs);
    const start = (today - days + 1) * dayMs;
    const empty = () => ({ total: 0, completed: 0, failed: 0, pending: 0 });
    const daily = Array.from({length:days}, (_, index) => ({
      day: new Date(start + index * dayMs).toISOString().slice(0,10),
      work: empty(), emails: empty(), outbound_deliveries: empty(),
    }));
    for (const table of ["work", "emails", "outbound_deliveries"] as const) {
      const rows = await this.db(table).where({tenant_id:this.tenantId})
        .whereBetween("created_at", [start, now])
        .select(this.db.raw("floor(?? / ?) as ??", ["created_at", dayMs, "day_index"]))
        .select(this.db.raw("count(*) as ??", ["total"]))
        .select(this.db.raw("sum(case when ?? = ? then 1 else 0 end) as ??", ["state", "sent", "completed"]))
        .select(this.db.raw("sum(case when ?? = ? then 1 else 0 end) as ??", ["state", "failed", "failed"]))
        .select(this.db.raw("sum(case when ?? in (?, ?) then 1 else 0 end) as ??", ["state", "pending", "running", "pending"]))
        .groupBy("day_index");
      for (const row of rows) daily[Number(row.day_index) - (today - days + 1)]![table] = {
        total:Number(row.total), completed:Number(row.completed), failed:Number(row.failed), pending:Number(row.pending),
      };
    }
    const emails = await this.db("emails").where({tenant_id:this.tenantId})
      .whereBetween("created_at", [start, now])
      .orderBy("created_at", "desc").orderBy("id").limit(50)
      .select("id", "kind", "state", "attempts", "created_at");
    return {days, generatedAt:now, daily, emails:emails.map(row => ({
      id:String(row.id), kind:String(row.kind), state:String(row.state), attempts:Number(row.attempts), createdAt:Number(row.created_at),
    }))};
  }
  async alerts(now = Date.now()): Promise<OperationAlert[]> {
    const [summary, settings] = await Promise.all([this.summary(now),this.settings()]);
    const queues = Object.values(summary.queues);
    const conditions: Record<string, boolean> = {
      queue_failed: queues.reduce((sum,q)=>sum+q.failed,0) >= settings.failureThreshold,
      queue_stalled: queues.some(q=>q.pending>0 && q.oldestAgeMs>=settings.pendingAgeMs),
      storage_capacity: summary.storage.limitBytes>0 && (summary.storage.usedBytes+summary.storage.reservedBytes)/summary.storage.limitBytes >= settings.storageRatio,
      bandwidth: settings.bandwidthBytes>0 && summary.bandwidth.servedBytes>=settings.bandwidthBytes,
      billing_capacity: summary.billingCapacityWarning,
    };
    return this.db.transaction(async tx => {
      await lock(tx,"work",this.tenantId);
      const alerts: OperationAlert[] = [];
      for (const [kind,active] of Object.entries(conditions)) {
        const previous = await tx("operation_alerts").where({tenant_id:this.tenantId,id:kind}).first();
        // Coalesce repeated failures behind one pending event per condition.
        // Never overwrite its timestamp when forwarding is quota-blocked.
        const pending=await tx("operation_alerts").where({tenant_id:this.tenantId,id:`forward_${kind}`,active:1}).first();
        const send = active && (!previous || now-Number(previous.last_sent_at)>=settings.cooldownMs);
        await tx("operation_alerts").insert({tenant_id:this.tenantId,id:kind,active:active?1:0,last_sent_at:send?now:previous?.last_sent_at ?? 0})
          .onConflict(["tenant_id","id"]).merge({active:active?1:0,last_sent_at:send?now:previous?.last_sent_at ?? 0});
        if(send) {
          if(!pending) await tx("operation_alerts").insert({tenant_id:this.tenantId,id:`forward_${kind}`,active:1,last_sent_at:now})
            .onConflict(["tenant_id","id"]).merge({active:1,last_sent_at:now});
          alerts.push({id:hash(JSON.stringify([this.tenantId,kind,now])),kind,occurredAt:now});
        }
      }
      return alerts;
    });
  }
  async forwardAlerts(outbound:Pick<OutboundWebhooks,"tenantId"|"enqueue">,limit=5) {
    check(outbound.tenantId===this.tenantId,500,"alert_tenant","Alert destination tenant mismatch.");
    check(Number.isInteger(limit) && limit>=1 && limit<=5,400,"invalid_limit","Limit must be between 1 and 5.");
    const rows=await this.db("operation_alerts").where({tenant_id:this.tenantId,active:1})
      .andWhere("id","like","forward_%").orderBy("last_sent_at").orderBy("id").limit(limit);
    const result={forwarded:0,deferred:0};
    for(const row of rows) {
      const kind=(row.id as string).slice("forward_".length),occurredAt=Number(row.last_sent_at);
      try {
        await outbound.enqueue({id:hash(JSON.stringify([this.tenantId,kind,occurredAt])),type:"alert.raised",resourceId:kind,occurredAt});
      } catch(error) {
        if(error instanceof AppError && error.status===429 && error.code==="webhook_budget") {result.deferred++;continue;}
        throw error;
      }
      result.forwarded+=await this.db("operation_alerts").where({tenant_id:this.tenantId,id:row.id,active:1,last_sent_at:row.last_sent_at}).update({active:0});
    }
    return result;
  }
  async scanNotifications(now = Date.now(), cursor: string | null = null, limit = 100) {
    check(Number.isInteger(limit) && limit>=1 && limit<=1000,400,"invalid_limit","Limit must be between 1 and 1000.");
    const settings = await this.settings();
    if (!settings.notificationsEnabled) return {cursor:null,processed:0};
    return this.db.transaction(async tx => {
      await lock(tx,"work",this.tenantId);
      const query = tx("licenses").where({tenant_id:this.tenantId}).orderBy("id").limit(limit);
      if(cursor !== null) query.andWhere("id",">",cursor);
      const licenses = await query;
      for(const license of licenses) {
        const paidThrough = Number(license.paid_through);
        if(license.revoked || license.refund_revoked || license.suspended || paidThrough<=0) continue;
        let kind: string;
        if(paidThrough<=now) kind="expired";
        else if(license.billing_status==="canceled") kind="canceled_no_autorenew";
        else if(paidThrough<=now+settings.warningDays*86400000) kind="expiry_approaching";
        else continue;
        const id=hash(JSON.stringify([this.tenantId,license.id,kind,paidThrough]));
        await tx("operation_notifications").insert({tenant_id:this.tenantId,id,customer_id:license.customer_id,license_id:license.id,kind,paid_through:paidThrough,created_at:now})
          .onConflict(["tenant_id","id"]).ignore();
      }
      return {cursor:licenses.length===limit ? licenses.at(-1)!.id as string : null,processed:licenses.length};
    });
  }
  async notifications(customerId: string, now = Date.now()) {
    const settings = await this.settings();
    if(!settings.notificationsEnabled) return [];
    const rows = await this.db("operation_notifications as n")
      .join("customers as c",function(){this.on("c.tenant_id","=","n.tenant_id").andOn("c.id","=","n.customer_id");})
      .join("licenses as l",function(){this.on("l.tenant_id","=","n.tenant_id").andOn("l.id","=","n.license_id");})
      .where({"n.tenant_id":this.tenantId,"n.customer_id":customerId,"n.dismissed":0,"l.revoked":0,"l.refund_revoked":0,"l.suspended":0})
      .whereRaw("?? = ??",["n.paid_through","l.paid_through"]).select("n.id","n.kind","n.license_id","n.paid_through","n.created_at","l.billing_status")
      .orderBy("n.created_at","desc").orderBy("n.id").limit(100);
    return rows.filter(row => row.kind==="expired" ? Number(row.paid_through)<=now : row.kind==="canceled_no_autorenew" ? row.billing_status==="canceled" && Number(row.paid_through)>now : Number(row.paid_through)>now && Number(row.paid_through)<=now+settings.warningDays*86400000)
      .map(row=>({id:row.id as string,kind:row.kind as string,licenseId:row.license_id as string,paidThrough:Number(row.paid_through),createdAt:Number(row.created_at)}));
  }
  async enqueueLifecycleEmails(secret: string, now = Date.now(), limit = 100) {
    check(Number.isInteger(limit) && limit>=1 && limit<=1000,400,"invalid_limit","Limit must be between 1 and 1000.");
    const thisTenant=this.tenantId;
    return this.db.transaction(async tx => {
      // Same lock order as account closure: email cannot be queued to an identity
      // while its proof, customer row or encrypted outbox is being anonymized.
      for(const name of ["auth","billing","work","email"]) await lock(tx,name,this.tenantId);
      await tx("emails").where({tenant_id:this.tenantId,kind:"lifecycle"}).whereIn("state",["failed","canceled"]).update({payload:""});
      await tx("emails").where({tenant_id:this.tenantId,kind:"lifecycle"}).whereIn("state",["pending","running"])
        .andWhere(function(){this.where("created_at","<=",now-72*3600000).orWhereIn("customer_id",tx("customers").where({tenant_id:thisTenant}).andWhere("email","like","%.invalid").select("id"));})
        .update({state:"canceled",payload:"",lease_until:0,lease_owner:null});
      const settings=await this.readSettings(tx);
      if(!settings.notificationsEnabled) return 0;
      const rows=await tx("operation_notifications as n")
        .join("customers as c",function(){this.on("c.tenant_id","=","n.tenant_id").andOn("c.id","=","n.customer_id");})
        .join("licenses as l",function(){this.on("l.tenant_id","=","n.tenant_id").andOn("l.id","=","n.license_id");})
        .join("products as p",function(){this.on("p.tenant_id","=","l.tenant_id").andOn("p.id","=","l.product_id");})
        .join("tenants as t","t.id","l.tenant_id")
        .where({"n.tenant_id":this.tenantId,"n.dismissed":0,"l.revoked":0,"l.refund_revoked":0,"l.suspended":0})
        .whereRaw("?? = ??",["n.paid_through","l.paid_through"]).whereNot("c.email","like","%.invalid")
        .where(function(){
          this.whereExists(tx("login_tokens as proof").select("proof.id").whereRaw("?? = ??",["proof.tenant_id","n.tenant_id"]).whereRaw("?? = ??",["proof.customer_id","n.customer_id"]).andWhere("proof.used",1))
            .orWhereExists(tx("sessions as proof").select("proof.id").whereRaw("?? = ??",["proof.tenant_id","n.tenant_id"]).whereRaw("?? = ??",["proof.customer_id","n.customer_id"]).andWhere("proof.expires_at",">",now));
        }).whereNotExists(tx("emails as sent").select("sent.id").whereRaw("?? = ??",["sent.tenant_id","n.tenant_id"]).whereRaw("?? = ??",["sent.id","n.id"]))
        .andWhere(function(){
          this.where(function(){this.where("n.kind","expired").andWhere("n.paid_through","<=",now);})
            .orWhere(function(){this.where("n.kind","canceled_no_autorenew").andWhere("l.billing_status","canceled").andWhere("n.paid_through",">",now);})
            .orWhere(function(){this.where("n.kind","expiry_approaching").andWhere("n.paid_through",">",now).andWhere("n.paid_through","<=",now+settings.warningDays*86400000);});
        }).select("n.id","n.customer_id","n.license_id","n.kind","n.paid_through","c.email","p.name as product_name","t.name as publisher_name").orderBy("n.created_at").orderBy("n.id").limit(limit);
      for(const row of rows) {
        await enqueueEmail(tx,secret,row.id,row.customer_id,row.license_id,"lifecycle",lifecycleEmail(row.email,row.kind,new Date(Number(row.paid_through)).toISOString(),{publisher:row.publisher_name,product:row.product_name}),this.tenantId);
      }
      return rows.length;
    });
  }
  async dismissNotification(customerId: string, id: string) {
    return (await this.db("operation_notifications").where({tenant_id:this.tenantId,customer_id:customerId,id}).update({dismissed:1})) === 1;
  }
  async sellerNotifications(now = Date.now()) {
    const summary = await this.summary(now);
    return summary.billingCapacityWarning ? [{kind:"billing_capacity",message:"Platform billing needs attention before adding capacity. Existing buyer licenses and downloads remain available."}] : [];
  }
}
