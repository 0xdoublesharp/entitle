import { randomUUID, createHmac } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { z } from "zod";
import type { DB } from "./db.ts";
import { lock } from "./db.ts";
import { random, seal, unseal, equal, hash } from "./crypto.ts";
import { check } from "./errors.ts";

export const outboundEventTypes = ["license.created","license.renewed","license.revoked","activation.changed","release.published","release.withdrawn","alert.raised"] as const;
const opaqueId=z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const eventSchema=z.object({id:opaqueId,type:z.enum(outboundEventTypes),resourceId:opaqueId,occurredAt:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export type OutboundEvent = z.infer<typeof eventSchema>;
const endpointSchema=z.object({url:z.string().min(1).max(1000),events:z.array(z.enum(outboundEventTypes)).min(1).max(outboundEventTypes.length)}).strict();
export interface WebhookAddress {address:string;family:number;}
export interface WebhookRequest {url:URL;addresses:readonly WebhookAddress[];rawBody:string;headers:Record<string,string>;signal?:AbortSignal;}
export interface WebhookNetwork {resolve:(hostname:string,signal?:AbortSignal)=>Promise<WebhookAddress[]>;send:(request:WebhookRequest)=>Promise<number>;}
export interface WebhookOptions {network?:WebhookNetwork;allowHosts?:readonly string[];now?:()=>number;runBudgetMs?:number;}
const reserved4=new BlockList();
for(const [address,prefix] of [["0.0.0.0",8],["10.0.0.0",8],["100.64.0.0",10],["127.0.0.0",8],["169.254.0.0",16],["172.16.0.0",12],["192.0.0.0",24],["192.0.2.0",24],["192.88.99.0",24],["192.168.0.0",16],["198.18.0.0",15],["198.51.100.0",24],["203.0.113.0",24],["224.0.0.0",4],["240.0.0.0",4]] as const) reserved4.addSubnet(address,prefix,"ipv4");
const global6=new BlockList(); global6.addSubnet("2000::",3,"ipv6");
const reserved6=new BlockList();
for(const [address,prefix] of [["2001::",23],["2001:db8::",32],["2002::",16],["3fff::",20]] as const) reserved6.addSubnet(address,prefix,"ipv6");
export function isPublicWebhookAddress(address:string) {
  const family=isIP(address);
  if(family===4) return !reserved4.check(address,"ipv4");
  return family===6 && global6.check(address,"ipv6") && !reserved6.check(address,"ipv6");
}

// Injection is a trusted transport capability, never derived from user input.
// Tests can forward this request to their own TLS fixture without a URL bypass.
export type WebhookRequestFactory = (url:URL, options:RequestOptions, callback:(response:IncomingMessage)=>void)=>ClientRequest;
export interface WebhookResolver {
  resolve4:(hostname:string)=>Promise<string[]>;
  resolve6:(hostname:string)=>Promise<string[]>;
  cancel:()=>void;
}
export interface WebhookNetworkOptions {dnsTimeoutMs?:number;resolverFactory?:()=>WebhookResolver;}
function missingFamily(error:unknown):string[] {
  if(error !== null && typeof error === "object" && "code" in error && (error.code === "ENODATA" || error.code === "ENOTFOUND")) return [];
  throw error;
}
export function createWebhookNetwork(request: WebhookRequestFactory = httpsRequest, options:WebhookNetworkOptions={}): WebhookNetwork {
  const dnsTimeoutMs=options.dnsTimeoutMs ?? 1500;
  check(Number.isInteger(dnsTimeoutMs) && dnsTimeoutMs>=1 && dnsTimeoutMs<=5000,500,"webhook_dns_config","DNS timeout must be between 1 and 5000 milliseconds.");
  const resolverFactory=options.resolverFactory ?? (()=>new Resolver({timeout:dnsTimeoutMs,tries:1}));
  return {
    resolve: (hostname,signal)=>new Promise<WebhookAddress[]>((resolve,reject)=>{
      const resolver=resolverFactory();
      const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener("abort",stop);};
      const stop=()=>{cleanup();resolver.cancel();reject(Error("Webhook DNS deadline exceeded"));};
      const timer=setTimeout(stop,dnsTimeoutMs);
      if(signal?.aborted) {stop();return;}
      signal?.addEventListener("abort",stop,{once:true});
      Promise.all([resolver.resolve4(hostname).catch(missingFamily),resolver.resolve6(hostname).catch(missingFamily)]).then(([v4,v6])=>{
        cleanup();resolve([...v4.map(address=>({address,family:4})),...v6.map(address=>({address,family:6}))]);
      },()=>{cleanup();resolver.cancel();reject(Error("Webhook DNS resolution failed"));});
    }),
    send: input=>new Promise<number>((resolve,reject)=>{
      const address=input.addresses[0]!;
      const req=request(input.url,{
        method:"POST",hostname:address.address, family:address.family,
        servername:isIP(input.url.hostname.replace(/^\[|\]$/g,"")) ? "" : input.url.hostname,agent:false,
        ...(input.signal ? {signal:input.signal} : {}),
        headers:{...input.headers,host:input.url.host,"content-type":"application/json","content-length":String(Buffer.byteLength(input.rawBody))},
      }, response=>{
        // Do not read/store remote bodies or follow redirects.
        response.destroy(); resolve(response.statusCode ?? 0);
      });
      const timer=setTimeout(()=>{req.destroy(Error("Webhook deadline exceeded"));},10000);
      req.once("close",()=>clearTimeout(timer)); req.once("error",reject);
      req.end(input.rawBody);
    }),
  };
}
// Bounds injected transports too; production transports also cancel their
// underlying c-ares queries / HTTPS sockets through the same AbortSignal.
function bounded<T>(signal:AbortSignal, task:()=>Promise<T>):Promise<T> {
  if(signal.aborted) return Promise.reject(Error("Webhook batch deadline exceeded"));
  return new Promise((resolve,reject)=>{
    const stop=()=>reject(Error("Webhook batch deadline exceeded"));
    signal.addEventListener("abort",stop,{once:true});
    Promise.resolve().then(task).then(value=>{signal.removeEventListener("abort",stop);resolve(value);},error=>{signal.removeEventListener("abort",stop);reject(error);});
  });
}

function signature(secret:string,timestamp:string,eventId:string,rawBody:string) {
  return `v1=${createHmac("sha256",secret).update(`${timestamp}.${eventId}.${rawBody}`).digest("hex")}`;
}
export function verifyWebhookSignature(secret:string,timestamp:string,eventId:string,rawBody:string,supplied:string,now=Date.now()) {
  return /^\d{1,12}$/.test(timestamp) && Math.abs(now-Number(timestamp)*1000)<=300000 && equal(signature(secret,timestamp,eventId,rawBody),supplied);
}
interface Endpoint {tenant_id:string;id:string;url:string;events:string;secret_cipher:string;generation:number;active:number;created_at:number;}
interface Delivery {tenant_id:string;id:string;endpoint_id:string;event_id:string;generation:number;state:string;attempts:number;available_at:number;deadline_at:number;created_at:number;lease_until:number;lease_owner:string|null;last_error:string|null;}
const retryWindow=72*3600000;

export class OutboundWebhooks {
  readonly db:DB; readonly tenantId:string; readonly secret:string; readonly network:WebhookNetwork; readonly allowHosts:readonly string[]|undefined; readonly now:()=>number; readonly runBudgetMs:number;
  constructor(db:DB,tenantId:string,secret:string,options:WebhookOptions={}) {
    this.db=db;this.tenantId=tenantId;this.secret=secret;this.network=options.network ?? createWebhookNetwork();this.allowHosts=options.allowHosts;this.now=options.now ?? Date.now;this.runBudgetMs=options.runBudgetMs ?? 10000;
    check(Number.isInteger(this.runBudgetMs) && this.runBudgetMs>=1 && this.runBudgetMs<=20000,500,"webhook_budget_config","Run budget must be between 1 and 20000 milliseconds.");
  }
  private async destination(raw:string, signal?:AbortSignal) {
    check(!/[\s?#]/.test(raw),400,"webhook_url","Webhook URLs cannot contain whitespace, queries or fragments.");
    let url:URL;
    try {url=new URL(raw);} catch {check(false,400,"webhook_url","Invalid webhook URL.");}
    check(!raw.slice(0,raw.indexOf("/",8)===-1?raw.length:raw.indexOf("/",8)).includes("@") && url.protocol==="https:" && !url.username && !url.password && !url.host.includes("@"),400,"webhook_url","Use an HTTPS destination without credentials.");
    const hostname=url.hostname.replace(/^\[|\]$/g,"");
    check(this.allowHosts===undefined || this.allowHosts.includes(hostname),400,"webhook_host","Webhook destination is not allowed by the operator.");
    const addresses=isIP(hostname) ? [{address:hostname,family:isIP(hostname)}] : await this.network.resolve(hostname,signal);
    check(addresses.length>0 && addresses.length<=32 && addresses.every(a=>isPublicWebhookAddress(a.address) && a.family===isIP(a.address)),400,"webhook_address","Webhook destinations must resolve only to public addresses.");
    return {url,addresses};
  }
  async createEndpoint(input:unknown) {
    const value=endpointSchema.parse(input),destination=await this.destination(value.url);
    return this.db.transaction(async tx=>{
      await lock(tx,"work",this.tenantId);
      const count=await tx("outbound_endpoints").where({tenant_id:this.tenantId,active:1}).count("* as count").first();
      check(Number(count!.count)<10,409,"webhook_limit","At most ten active webhook endpoints are allowed.");
      const id=randomUUID(),secret=random();
      await tx("outbound_endpoints").insert({tenant_id:this.tenantId,id,url:destination.url.href,events:JSON.stringify([...new Set(value.events)]),secret_cipher:seal(secret,this.secret),created_at:this.now()});
      return {id,secret};
    });
  }
  async listEndpoints() {
    const rows=await this.db<Endpoint>("outbound_endpoints").where({tenant_id:this.tenantId}).orderBy("created_at","desc").orderBy("id").limit(100);
    return rows.map(row=>({id:row.id,url:row.url,events:JSON.parse(row.events) as string[],active:!!row.active,generation:Number(row.generation),createdAt:Number(row.created_at)}));
  }
  async rotateSecret(id:string) {
    return this.db.transaction(async tx=>{
      await lock(tx,"work",this.tenantId);
      const endpoint=await tx<Endpoint>("outbound_endpoints").where({tenant_id:this.tenantId,id,active:1}).first();
      check(endpoint,404,"webhook_missing","Webhook endpoint not found.");
      const secret=random();
      await tx("outbound_endpoints").where({tenant_id:this.tenantId,id}).update({secret_cipher:seal(secret,this.secret),generation:Number(endpoint.generation)+1});
      // Rotation invalidates old in-flight claims, never their durable events.
      // Failed rows remain failed so manual retry still observes queue quotas.
      await tx("outbound_deliveries").where({tenant_id:this.tenantId,endpoint_id:id,generation:endpoint.generation,state:"failed"})
        .update({generation:Number(endpoint.generation)+1,lease_until:0,lease_owner:null});
      await tx("outbound_deliveries").where({tenant_id:this.tenantId,endpoint_id:id,generation:endpoint.generation}).whereIn("state",["pending","running"])
        .update({state:"pending",generation:Number(endpoint.generation)+1,available_at:this.now(),lease_until:0,lease_owner:null,last_error:null});
      return {id,secret};
    });
  }
  async deleteEndpoint(id:string) {
    await this.db.transaction(async tx=>{
      await lock(tx,"work",this.tenantId);
      const changed=await tx("outbound_endpoints").where({tenant_id:this.tenantId,id,active:1}).update({active:0,secret_cipher:""});
      check(changed===1,404,"webhook_missing","Webhook endpoint not found.");
      await tx("outbound_deliveries").where({tenant_id:this.tenantId,endpoint_id:id}).whereIn("state",["pending","running"]).update({state:"canceled",lease_until:0,lease_owner:null,last_error:"endpoint_disabled"});
    });
  }
  async enqueue(input:unknown) {
    const event=eventSchema.parse(input),payload=JSON.stringify({...event,tenantId:this.tenantId});
    return this.db.transaction(async tx=>{
      await lock(tx,"work",this.tenantId);
      const previous=await tx("outbound_events").where({tenant_id:this.tenantId,id:event.id}).first();
      if(previous) {check(previous.payload===payload,409,"webhook_replay","Event ID already has different contents.");return false;}
      const endpoints=await tx<Endpoint>("outbound_endpoints").where({tenant_id:this.tenantId,active:1}).orderBy("id").limit(10);
      const subscribed=endpoints.filter(e=>(JSON.parse(e.events) as string[]).includes(event.type));
      const count=await tx("outbound_deliveries").where({tenant_id:this.tenantId}).whereIn("state",["pending","running"]).count("* as count").first();
      check(Number(count!.count)+subscribed.length<=1000,429,"webhook_budget","Webhook outbox is full. Retry this event later.");
      const now=this.now();
      await tx("outbound_events").insert({tenant_id:this.tenantId,id:event.id,payload,created_at:now});
      for(const endpoint of subscribed) await tx("outbound_deliveries").insert({tenant_id:this.tenantId,id:hash(JSON.stringify([event.id,endpoint.id])),event_id:event.id,endpoint_id:endpoint.id,generation:endpoint.generation,available_at:now,deadline_at:now+retryWindow,created_at:now});
      return true;
    });
  }
  async deliveries(limit=100) {
    check(Number.isInteger(limit) && limit>=1 && limit<=100,400,"invalid_limit","Limit must be between 1 and 100.");
    const rows=await this.db<Delivery>("outbound_deliveries").where({tenant_id:this.tenantId}).orderBy("created_at","desc").orderBy("id").limit(limit);
    return rows.map(row=>({id:row.id,eventId:row.event_id,endpointId:row.endpoint_id,state:row.state,attempts:Number(row.attempts),availableAt:Number(row.available_at),deadlineAt:Number(row.deadline_at),lastError:row.last_error}));
  }
  async retry(id:string) {
    await this.db.transaction(async tx=>{
      await lock(tx,"work",this.tenantId);
      const delivery=await tx<Delivery>("outbound_deliveries").where({tenant_id:this.tenantId,id,state:"failed"}).first();
      check(delivery,404,"webhook_delivery_missing","Failed webhook delivery not found.");
      const endpoint=await tx<Endpoint>("outbound_endpoints").where({tenant_id:this.tenantId,id:delivery.endpoint_id,active:1,generation:delivery.generation}).first();
      check(endpoint,409,"webhook_generation","Endpoint was disabled or its secret was rotated.");
      const count=await tx("outbound_deliveries").where({tenant_id:this.tenantId}).whereIn("state",["pending","running"]).count("* as count").first();
      check(Number(count!.count)<1000,429,"webhook_budget","Webhook outbox is full.");
      const now=this.now();
      await tx("outbound_deliveries").where({tenant_id:this.tenantId,id}).update({state:"pending",attempts:0,available_at:now,deadline_at:now+retryWindow,lease_until:0,lease_owner:null,last_error:null});
    });
  }
  async run(limit=20,budgetMs=this.runBudgetMs) {
    check(Number.isInteger(limit) && limit>=1 && limit<=20,400,"invalid_limit","Limit must be between 1 and 20.");
    check(Number.isInteger(budgetMs) && budgetMs>=1 && budgetMs<=20000,400,"invalid_budget","Budget must be between 1 and 20000 milliseconds.");
    const controller=new AbortController(),signal=controller.signal;
    const deadline = performance.now() + budgetMs;
    const timer=setTimeout(()=>controller.abort(),budgetMs);
    try { for(let i=0;i<limit && !signal.aborted;i++) {
      if (i > 0 && deadline - performance.now() < 1500) break;
      const claimed=await this.db.transaction(async tx=>{
        await lock(tx,"work",this.tenantId);const now=this.now();
        await tx("outbound_deliveries").where({tenant_id:this.tenantId}).whereIn("state",["pending","running"]).andWhere("lease_until","<=",now)
          .andWhere(function(){this.where("deadline_at","<=",now).orWhere("attempts",">=",12);}).update({state:"failed",lease_until:0,lease_owner:null,last_error:"retry_expired"});
        const delivery=await tx<Delivery>("outbound_deliveries").where({tenant_id:this.tenantId}).whereIn("state",["pending","running"])
          .andWhere("available_at","<=",now).andWhere("lease_until","<=",now).orderBy("available_at").orderBy("created_at").orderBy("id").first();
        if(!delivery) return;
        const endpoint=await tx<Endpoint>("outbound_endpoints").where({tenant_id:this.tenantId,id:delivery.endpoint_id,active:1,generation:delivery.generation}).first();
        if(!endpoint) {await tx("outbound_deliveries").where({tenant_id:this.tenantId,id:delivery.id}).update({state:"canceled",lease_until:0,lease_owner:null,last_error:"endpoint_changed"});return {skip:true} as const;}
        const owner=randomUUID();
        await tx("outbound_deliveries").where({tenant_id:this.tenantId,id:delivery.id}).update({state:"running",lease_until:now+30000,lease_owner:owner,attempts:Number(delivery.attempts)+1});
        const event=await tx("outbound_events").where({tenant_id:this.tenantId,id:delivery.event_id}).first();
        return {skip:false,delivery,endpoint,owner,payload:event.payload as string} as const;
      });
      if(!claimed) break;
      if(claimed.skip) continue;
      const {delivery,endpoint,owner,payload}=claimed;
      try {
        const destination=await bounded(signal,()=>this.destination(endpoint.url,signal));
        const current=await this.db("outbound_endpoints").where({tenant_id:this.tenantId,id:endpoint.id,active:1,generation:delivery.generation}).first();
        if(!current) continue;
        const lease=await this.db("outbound_deliveries").where({tenant_id:this.tenantId,id:delivery.id,state:"running",lease_owner:owner}).andWhere("lease_until",">",this.now()).andWhere("deadline_at",">",this.now()).first();
        if(!lease) continue;
        const timestamp=String(Math.floor(this.now()/1000));
        const status=await bounded(signal,()=>this.network.send({...destination,signal,rawBody:payload,headers:{"x-entitle-timestamp":timestamp,"x-entitle-event-id":delivery.event_id,"x-entitle-signature":signature(unseal<string>(current.secret_cipher,this.secret),timestamp,delivery.event_id,payload)}}));
        check(status>=200 && status<300,502,"webhook_response","Webhook response was not successful.");
        await this.db("outbound_deliveries").where({tenant_id:this.tenantId,id:delivery.id,state:"running",lease_owner:owner}).update({state:"sent",lease_until:0,lease_owner:null,last_error:null});
      } catch {
        const current = this.db("outbound_deliveries")
          .where({
            tenant_id: this.tenantId,
            id: delivery.id,
            state: "running",
            lease_owner: owner,
          });
        if (signal.aborted) {
          await current.update({
            state: "pending",
            attempts: Number(delivery.attempts),
            available_at: Math.min(Number(delivery.deadline_at), this.now() + 5000),
            lease_until: 0,
            lease_owner: null,
          });
          break;
        }
        const now=this.now(),attempts=Number(delivery.attempts)+1;
        await current.update({state:now>=Number(delivery.deadline_at)||attempts>=12?"failed":"pending",lease_until:0,lease_owner:null,last_error:"delivery_failed",available_at:Math.min(Number(delivery.deadline_at),now+Math.min(3600000,5000*2**Math.min(attempts-1,10)))});
      }
    }} finally { clearTimeout(timer); }
  }
}
