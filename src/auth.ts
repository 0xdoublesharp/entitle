import { appUrl } from "../packages/shared/app-path.ts";
import { randomUUID } from "node:crypto";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { DB, Customer, TenantContext } from "./db.ts";
import { lock } from "./db.ts";
import type { Config } from "./config.ts";
import { hash, random, csrf, equal,seal,unseal } from "./crypto.ts";
import { check } from "./errors.ts";
import { enqueueEmail } from "./email.ts";
import { signInEmail } from "./sign-in-email.ts";
export class Auth {
  db: DB;
  config: Config;
  cookieName: string;
  checkoutCookieName:string;
  tenant: TenantContext;
  constructor(db: DB, config: Config, tenant: TenantContext) {
    this.db = db;
    this.config = config;
    this.tenant = tenant;
    this.cookieName = `${config.production ? "__Host-" : ""}de-session-${tenant.id}`;
    this.checkoutCookieName=`${config.production?"__Host-":""}de-checkout-${tenant.id}`;
  }
  checkoutCustomer(req:FastifyRequest):string|undefined{
    const value=req.cookies[this.checkoutCookieName];
    if(!value)return;
    try{
      const claim=unseal<{purpose:string;tenantId:string;customerId:string;expiresAt:number}>(value,this.config.secret);
      if(claim.purpose==="checkout"&&claim.tenantId===this.tenant.id&&typeof claim.customerId==="string"&&claim.expiresAt>Date.now())return claim.customerId;
    }catch{/* Invalid claims do not grant access to an existing customer. */}
  }
  issueCheckoutClaim(customerId:string,reply:FastifyReply){
    reply.setCookie(this.checkoutCookieName,seal({purpose:"checkout",tenantId:this.tenant.id,customerId,expiresAt:Date.now()+7*86400000},this.config.secret),{path:"/",httpOnly:true,secure:this.config.production,sameSite:"lax",maxAge:7*86400});
  }
  async request(email: string) {
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth", this.tenant.id);
      const c = await tx<Customer>("customers").where({ tenant_id: this.tenant.id, email }).first();
      if (!c) return;
      const links=await tx("login_tokens").where({tenant_id:this.tenant.id,customer_id:c.id}).andWhere("expires_at",">",Date.now()-86400000+900000);
      if(links.length>=10||links.some(link=>Number(link.expires_at)>Date.now()+840000))return;
      const token = random();
      await tx("login_tokens").insert({
        tenant_id: this.tenant.id,
        id: hash(token),
        customer_id: c.id,
        expires_at: Date.now() + 900000,
      });
      await enqueueEmail(
        tx,
        this.config.secret,
        randomUUID(),
        c.id,
        null,
        "login",
        signInEmail(
          c.email,
          appUrl(this.config, `/t/${this.tenant.slug}#login=${token}`),
          "customer",
          this.tenant.name,
        ),
        this.tenant.id,
      );
    });
  }
  async consume(token: string, req: FastifyRequest, reply: FastifyReply) {
    this.origin(req);
    const session = random();
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth", this.tenant.id);
      const link = await tx("login_tokens")
        .where({ tenant_id: this.tenant.id, id: hash(token), used: 0 })
        .andWhere("expires_at", ">", Date.now())
        .first();
      check(
        link,
        401,
        "invalid_login",
        "Login link is invalid, expired, or already used.",
      );
      await tx("login_tokens").where({ tenant_id: this.tenant.id, id: link.id }).update({ used: 1 });
      await tx("sessions").insert({
        tenant_id: this.tenant.id,
        id: hash(session),
        customer_id: link.customer_id,
        expires_at: Date.now() + 7 * 86400000,
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
  origin(req: FastifyRequest) {
    check(
      req.headers.origin === this.config.origin,
      403,
      "origin_denied",
      "A same-origin request is required.",
    );
  }
  async customer(req: FastifyRequest, mutation = false) {
    const token = req.cookies[this.cookieName];
    check(token, 401, "login_required", "Sign in to continue.");
    const session = await this.db("sessions")
      .where({ tenant_id: this.tenant.id, id: hash(token) })
      .andWhere("expires_at", ">", Date.now())
      .first();
    check(
      session,
      401,
      "login_required",
      "Your session has expired. Sign in again.",
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
    const customer = await this.db<Customer>("customers")
      .where({ tenant_id: this.tenant.id, id: session.customer_id })
      .first();
    check(customer, 401, "login_required", "Sign in again.");
    return { customer, csrfToken, sessionHash: session.id as string };
  }
}
export function bearer(req: FastifyRequest) {
  const header = req.headers.authorization;
  check(
    typeof header === "string" && header.startsWith("Bearer "),
    401,
    "token_required",
    "A bearer token is required.",
  );
  return header.slice(7);
}
