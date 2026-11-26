# Competitor-Parity Licensing & Commerce Plan for Doublesharp Entitle

## Goal

Close the key commercial software licensing gaps between Doublesharp Entitle and incumbent licensing platforms (Easy Digital Downloads Software Licensing, Freemius, Lemon Squeezy, Paddle, Keygen) — surfaced by real-world commercial publisher workflows such as Black Friday win-back campaigns — while preserving Entitle's core differentiators: seller-owned Stripe accounts, offline-resilient installed software, strict tenant isolation, multi-database support (SQLite, PostgreSQL, MySQL), encrypted workspace portability, and full HTTP/CLI/MCP parity.

## Scope & Five Pillars

### 1. Stripe Promotion Codes, Coupons & Shareable Sale Links
- Add `tenants.allow_promotion_codes` (integer `0`/`1`, default `0`) via forward-only migration `023_licensing_commerce_growth.ts`.
- Expose `allowPromotionCodes: boolean` on `GET /commerce/settings` and `PUT /commerce/settings` (optional on `PUT` to keep existing callers backwards-compatible) and on public `GET /catalog`.
- Extend `POST /checkout` to accept optional `promotionCode` (`/^[A-Za-z0-9_-]{1,64}$/`):
  - When omitted: pass `allow_promotion_codes: tenant.allow_promotion_codes === 1` to Stripe Checkout Session creation.
  - When supplied: require `tenant.allow_promotion_codes === 1` (`409 promotions_disabled`), look up active Stripe promotion code, reject invalid/inactive codes (`400 invalid_promotion_code`), reject 100%-off / zero-net coupons (`409 zero_amount_promotion` — preserving Entitle's cash-settlement invariant; complimentary licenses remain the explicit path for free access), and pass `discounts: [{ promotion_code: promo.id }]` (never combining `discounts` and `allow_promotion_codes`).
- Add `GET /seller/promotions` (read scope) listing active Stripe promotion codes (and a local fixture entry in `localBilling` mode) so sellers and agents can copy shareable sale links (`/t/<slug>?promo=<CODE>`).

### 2. One-Time / Lifetime Paid Plans
- Extend plan price validation (`isSupportedPlanPrice`) to accept active Stripe `one_time` prices (`unit_amount > 0`) alongside recurring `month` and `year` prices, storing `billing_interval = "lifetime"` in existing `plans.billing_interval`.
- Update `GET /seller/prices` and `POST /seller/products` to list and map `one_time` prices (`interval: "lifetime"`, plus local fixture prices `price_local_lifetime_{1,5,25}`).
- Add `licenses.one_time_payment_id` (nullable string(150), unique per tenant when non-null) in migration `023_licensing_commerce_growth.ts` and `src/portability.ts`.
- Export `LIFETIME_PAID_THROUGH = 253402300799000` (`9999-12-31T23:59:59.000Z`).
- Checkout for a lifetime plan uses `mode: "payment"` with `payment_intent_data.metadata` (`product_id`, `plan_id`, optional `renew_license_id`) and hosted `application_fee_amount` when configured.
- Canonical reconciliation handles `checkout.session.*` (mode `"payment"`), `charge.refunded`, `refund.*`, and `charge.dispute.*` for one-time payments, issuing/updating a `billing_status = "lifetime"` license with full refund revocation and dispute suspension parity.

### 3. In-Place License Renewal & Complimentary-to-Paid Conversion
- Extend `POST /checkout` to accept optional `renewLicenseId` (UUID), requiring an authenticated buyer session.
- Validate ownership (`license.customer_id === authenticatedCustomerId`), same `product_id`, not `revoked`/`refund_revoked`/`suspended`, not already `lifetime`, and eligible (`provenance === "complimentary"` OR `billing_status` in `["canceled", "incomplete_expired", "unpaid"]` OR `entitlementEnd(license) <= now`).
- Pass `renew_license_id` in Stripe subscription/payment metadata and preserve it across both direct and worker-continuation snapshots.
- During canonical reconciliation, attach the new subscription or one-time payment to the existing verified license row — converting complimentary to `paid` (clearing `expires_at`), preserving `key_hash` and active installations so customers never have to swap keys on installed sites, and recording `license.renewed`.

### 4. Lifecycle Outbound Webhooks, Seller License Management & Win-Back CSV/JSON Export
- Expand `outboundEventTypes` with `"license.canceled"` (emitted in `Billing.reconcile` on transition to `canceled`) and `"license.expired"` (emitted in `Operations.scanNotifications` when a non-revoked, non-suspended, non-lifetime license passes `entitlementEnd <= now`).
- Skip `billing_status === "lifetime"` in `Operations.scanNotifications` and `Operations.notifications`.
- Add `GET /seller/licenses` (filtered & cursor-paginated by `productId`, `provenance`, `status` (`active|expiring|expired|canceled|revoked|suspended|lifetime`), `expiringWithinDays`, `q`, `limit`, `after`) including active installation counts.
- Add `GET /seller/licenses/export` (`data:export` scope or interactive seller session) outputting filtered `csv` (with spreadsheet formula-injection neutralization) or `json`, excluding keys and activation tokens.
- Add `PATCH /seller/licenses/:id` (`licenses:write` scope): update `internalNote` on any license, and update `expiresAt` / `siteAllowance` on `complimentary` licenses only (`409 paid_license_immutable` for paid licenses), with audit logging and `license.renewed` emission on extension.

### 5. Revenue & Retention Analytics
- Add `GET /seller/analytics` (read scope) and extend `tenantMetrics` with canonical local metrics:
  - `recurringByCurrency`: `{ currency, mrrMinor, arrMinor, activeSubscriptions }[]` (active/trialing auto-renewing subscriptions only; excludes canceled, expired, revoked, suspended, lifetime, complimentary).
  - `retention`: `{ activeSubscriptions, canceledPendingExpiry, expiredLicenses, expiringIn30Days, lifetimeLicenses, complimentaryActive }`.
  - `byProduct`: `{ productId, productName, activeLicenses, expiredLicenses, lifetimeLicenses, activeInstallations, seatsUsed, seatAllowance }[]`.

## Parallel Implementation Workstreams

1. **Workstream A (Codex — Backend Billing, Promotions, Lifetime, Renewal & Migration)**:
   - Schema migration `023`, `db.ts`, `tenant.ts`, `portability.ts`, `commerce-admin.ts`, `stripe.ts`, `stripe-worker.ts`, `billing.ts`, `licensing.ts`, `tenant-api.ts`, `seller-api.ts` (`/prices`, `/products`, `/promotions`) + tests.
2. **Workstream B (Codex — Lifecycle Webhooks, License Management/Export & Analytics)**:
   - `outbound-webhooks.ts`, `operations.ts`, `operations-api.ts`, `metrics.ts`, new `license-management.ts` + `license-management-api.ts` + tests.
3. **Workstream C (Codex — CLI, MCP & Docs Parity)**:
   - `agent-operations.ts` (all new structured operations & updated schemas), `cli.ts`/`mcp.ts` alignment, docs (`api.md`, `cli.md`, `mcp.md`, `webhooks.md`, `seller-guide.md`) + tests.
4. **Workstream D (Codex — Buyer & Seller Web UI)**:
   - `web/checkout.ts`, `web/main.ts`, `web/features.ts`, `web/site.ts` + web unit tests.
5. **Integration & Full Verification (Lead)**:
   - Merge all 4 workstreams cleanly without disturbing pre-existing uncommitted metadata/social assets, wire shared seams (`src/seller-api.ts`, `src/billing.ts` canceled webhook, `src/db.ts`), run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:web`, `pnpm build`, and verify every new feature end-to-end.
