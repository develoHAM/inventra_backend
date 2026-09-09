# Inventra — Project Status & Handoff

> Living status doc. Read this first when resuming (especially on a different machine).
> Last updated: 2026-09-09.

**Inventra** = multi-tenant inventory-management SaaS (Korean concession-store model — companies operate "corners" inside physical stores).
**Stack:** NestJS 11 · Prisma 7 (driver adapters, client generated to `src/generated/prisma`) · PostgreSQL · Jest + supertest · npm.

---

## Phase progress

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Infra: Docker Compose, Zod env validation, Prisma modern setup | ✅ complete |
| 1 | Auth: register (owner + member self-signup via join code), login, JWT access/refresh rotation + reuse detection | ✅ complete (blogged) |
| 2 | Authz: `PermissionsGuard` (RBAC) + `OwnershipService` tenant scoping (`companyId`) | ✅ complete (blogged) |
| 3 | Product catalog (categories, brands, products) | ✅ complete (blogged) |
| 4 | Stores & Corners (venues + company corners, manager/staff assignment) | ✅ complete (blogged) |
| 5 | **Product placement** (`CompanyStoreProduct` — products on a corner's shelf) | ✅ complete (blogged) |
| 6 | **Inventory transactions** (ledger + running balance, one atomic write) | ✅ complete (blogged) |
| 7 | **Restock orders** (request document: header + line items, nested CRUD) | ✅ complete (blogged) |
| 8 | **Inventory audits** (physical count doc → atomic apply reconciles stock) | ✅ complete (blogged) |
| 9 | **Purchase reservations** (hold stock for a customer; fulfill = release + sale) | ✅ complete |
| 10+ | Cross-cutting concerns (auto-expiry sweep, jobs), Redis caching | ⏳ not started |

## Where we are right now — Phase 9 complete (purchase reservations)

Phases 0–9 are done and tested (Phase 9 blog pending). Phase 9 adds **purchase reservations** — hold a customer's stock, convert the hold to a sale on pickup. It's the first phase to *extend* the Phase 6 effect map (the `reserved` bucket) and the third `recordWithinTransaction` caller.
- **Reservation = single row** (`PurchaseReservation`: one placement + `reservedQuantity` + customer `reservedByName`/`Phone`), corner-scoped. Migration `20260908124337_reservations_reserve_types_created_by` added `created_by_user_id` + the two enum values.
- **Hold on create.** Creating a reservation moves stock `available → reserved` (guarded `RESERVATION_HOLD`; **insufficient available → 409**) and starts it `RESERVED`. **Fulfill** = `RESERVATION_RELEASE` + `SALE` → `FULFILLED` (so *every* purchase is a `SALE`; reserved-origin ones tagged `source=RESERVATION`). **Cancel** = `RESERVATION_RELEASE` → `CANCELLED`. Fulfill/cancel on a non-`RESERVED` reservation → 409. `PENDING`/`EXPIRED` defined but unused (deferred).
- **Effect map extended.** `Bucket` gained `reservedQuantity`; two new cross-bucket, guard-first effects `RESERVATION_HOLD` (available→reserved) / `RESERVATION_RELEASE` (reserved→available), reusing `SALE`. Invariant: the `reserved` bucket = sum of active reservations.
- **Corner-level resource** (revised from placement-nested mid-build): `POST/GET /corners/:cornerId/reservations` (companyStoreProductId in the create body; GET corner-wide with optional `?companyStoreProductId`/`?status` filters — the counter's pickup view), `…/:reservationId/fulfill|cancel`. RBAC `reservations.{create,read,fulfill,cancel}`, all to OWNER/MANAGER/STAFF. **48 permissions**. No soft-delete (terminal statuses instead). `createdByUserId` added; transition-actors live in the ledger (source=RESERVATION).
- **166 unit tests green** + `test/reservations.e2e-spec.ts` (**62 e2e green across 8 suites**) — passed first run.

**Next — Phase 10: cross-cutting concerns.** The deferred **reservation auto-expiry sweep** (a scheduled job releasing `RESERVED` holds past `expiresAt` → `EXPIRED`, via `recordWithinTransaction(RESERVATION_RELEASE)`) is the natural first job — introduces `@nestjs/schedule`. Then Redis caching (only when a measured need appears). Start with `/brainstorming` → spec → plan → per-task build.
- ⚠️ e2e reminder: `npm run test:e2e`'s `pretest` runs `prisma migrate reset --force`, blocked by Claude's Prisma AI-guard — **a human must run it**. Claude runs `npm test` fine.

## Roadmap after Phase 6 (historical)

Phases 0–6 are done and tested (Phase 6 blog pending). Phase 6 moves real stock through a single centralized, oversell-safe write:
- **Stock split.** `CompanyStoreProduct` (cold placement config) now 1:1-owns `CompanyStoreProductStock` (hot balances) via a shared PK/FK (`company_store_product_id`). Splitting the hot fact from the cold dimension keeps the frequently-mutated balance rows narrow (less MVCC/WAL churn) and the placement metadata cache-stable. The stock row is created with the placement (nested `stock: { create }`) and inherits its soft-delete lifecycle.
- **Four buckets** on the stock row sum to the physical count: `availableQuantity` (renamed from `currentQuantity`), `reservedQuantity`, `sampleQuantity`, `damagedQuantity` (new). `targetStockQuantity` also lives here now.
- **17 transaction types → an effect map** (`src/inventory/inventory-effects.ts`): each type is a `delta` (±buckets, with a `primaryBucket` the ledger's before/after tracks) or a `set` (ADJUSTMENT overwrites `availableQuantity`). Cross-bucket moves (BREAKAGE available→damaged, SAMPLE_ALLOCATION available→sample) list the decrement first.
- **The atomic engine** (`InventoryService.record`): one `$transaction` appends an immutable `InventoryTransaction` (ledger) **and** moves the balance. Decrements use a **guarded `updateMany`** (`where: { [bucket]: { gte: q } }`) → `count === 0` ⇒ `ConflictException` (409), the oversell guard. `record(caller, cornerId, placementId, dto, source?)` — the optional `source` (type+id) is for later phases (orders/audits) to stamp provenance; it's not in the DTO.
- **Nested API** — `GET/POST /corners/:cornerId/products/:placementId/transactions`, RBAC `transactions.read`/`transactions.create`, ownership via `assertWorksCorner` (writes) / `findOne` (reads). **35 permissions** now.
- **Errors:** 400 (quantity < 1 or bad enum) · 403 (foreign manager) · 404 (absent placement / other tenant) · 409 (oversell).
- **140 unit tests green** + `test/inventory.e2e-spec.ts` (**39 e2e green across 5 suites**).

**Next — Phase 7: orders.** First consumer of `InventoryService.record(...source)` — an order line stamps its `sourceType`/`sourceId` onto the ledger as it moves stock. Start with `/brainstorming` → spec → plan → per-task build.
- ⚠️ e2e reminder: `npm run test:e2e`'s `pretest` runs `prisma migrate reset --force`, blocked by Claude's Prisma AI-guard — **a human must run it**. Claude runs `npm test` fine.

## Roadmap after Phase 6
Orders → audits → purchase reservations → cross-cutting concerns → Redis caching (only when a measured need appears).

---

## Working conventions (how we collaborate)
- **Teaching-first:** the user is learning NestJS; explain concepts and framework fundamentals as we build — the "why", not just the "what".
- **Per-task flow (Phase 2/3):** (1) teach the concepts → (2) give requirements → (3) provide full reference code → (4) Claude writes the test files and runs them. **The user writes the production code; Claude owns the tests.**
- **Checkpoints auto-commit:** when a checkpoint is reached (unit/e2e tests green, a feature/task complete), Claude commits with a descriptive message and pushes to `origin/main` without being asked. Verify green first; never commit known-broken code; surface anomalies instead of blindly committing. Commit messages end with the `Co-Authored-By: Claude` trailer.
- **Phase-end:** offer the bilingual EN+KR Medium-style `/phase-blog` retrospective.

## Resume on a new machine
The DB, secrets, and generated client are **not** in the repo. After `git pull`:
1. `npm install`
2. Recreate the gitignored env files (copy from the other laptop): **`.env`** and **`.env.test`**. `DATABASE_URL` must **not** include `sslmode=require` for the local container.
3. `docker compose up -d` (postgres + redis)
4. `npx prisma generate` (client generates into `src/generated/prisma`, which is gitignored)
5. `npx prisma migrate deploy` then `npm run seed` (or `npx prisma migrate reset --force` which also seeds via `prisma/seed.ts`)
6. `npm test` (unit — should be 166 green) and `npm run test:e2e` (62 green across 8 suites)

Latest migration: `prisma/migrations/20260908124337_reservations_reserve_types_created_by`.

## Key references in-repo
- `docs/superpowers/specs/2026-09-07-phase-9-purchase-reservations-design.md` — Phase 9 design (latest)
- `docs/superpowers/plans/2026-09-07-phase-9-purchase-reservations.md` — Phase 9 implementation plan
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — Phase 1–8 specs & plans
- `blog/en` + `blog/ko` — Phase 1–8 retrospectives (Phase 9 pending)
- `prisma/schema.prisma` — single source of truth for the data model
