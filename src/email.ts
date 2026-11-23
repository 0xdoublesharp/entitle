import type { DB, Job, Tx, TenantContext } from "./db.ts";
import { seal, unseal } from "./crypto.ts";
import { runQueue, DeferredJob } from "./queue.ts";
export interface Message {
  to: string;
  subject: string;
  text: string;
  html?: string;
  messageId: string;
}
export interface Mailer {
  send: (message: Message) => Promise<void>;
}
export async function enqueueEmail(
  tx: Tx,
  secret: string,
  id: string,
  customerId: string,
  licenseId: string | null,
  kind: string,
  message: Omit<Message, "messageId">,
  tenantId: string,
) {
  await tx("emails").insert({
    tenant_id: tenantId,
    id,
    customer_id: customerId,
    license_id: licenseId,
    kind,
    payload: seal({ ...message, messageId: `<${id}@entitle>` }, secret),
    created_at: Date.now(),
  });
}
export class Outbox {
  db: DB;
  secret: string;
  mailer: Mailer;
  tenant: TenantContext;
  dailyLimit:number;
  constructor(db: DB, secret: string, mailer: Mailer, tenant: TenantContext,dailyLimit=1000) {
    this.db = db;
    this.secret = secret;
    this.mailer = mailer;
    this.tenant = tenant;
    this.dailyLimit=dailyLimit;
  }
  message(job: Job) {
    return unseal<Message>(job.payload, this.secret);
  }
  async run(limit = 20, signal?: AbortSignal) {
    await runQueue(this.db, "emails", async (job) => {
      // Check replacement/supersession after claiming. SMTP remains at-least-once.
      const current = await this.db<Job>("emails")
        .where({ id: job.id, tenant_id: this.tenant.id })
        .first();
      if (current?.state === "canceled") return;
      // Reserve SMTP attempts durably, before network I/O. A lost SMTP reply
      // consumes budget too; deferral never discards the encrypted key.
      const day=Math.floor(Date.now()/86400000),id=`${this.tenant.id}:email-budget:${day}`;
      const allowed=await this.db.transaction(async tx=>{
        await tx("locks").insert({id,version:0}).onConflict("id").ignore();
        return tx("locks").where({id}).andWhere("version","<",this.dailyLimit).increment("version",1);
      });
      if(!allowed)throw new DeferredJob((day+1)*86400000);
      await this.mailer.send(this.message(job));
    }, limit, this.tenant.id, signal ? { signal } : undefined);
  }
}
