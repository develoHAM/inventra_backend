# Inventra — Project Status & Handoff

> Living status doc. Read this first when resuming (especially on a different machine).
> Last updated: 2026-08-15.

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
| 6+ | Inventory transactions, orders, audits, reservations | ⏳ not started |

## Where we are right now — Phase 5 complete (product placement)

Phases 0–5 are done, tested, and blogged. Phase 5 connected the catalog to the corners via `CompanyStoreProduct`:
- **Placement CRUD** nested under the corner — `GET/POST/PATCH/DELETE /corners/:cornerId/products`.
- **Ownership through the corner** — placements have no `companyId`; reads resolve via `CornersService.findOne`, writes via `assertWorksCorner`. ADMIN targets a tenant via the URL path (no body `companyId`).
- **Auth** — OWNER/ADMIN any · MANAGER on corners they manage · **STAFF on the corner they're assigned to** (`AuthUser.companyStoreId`, the lone-staffer delivery case). Two sibling helpers: `assertManages` (roster) vs `assertWorksCorner` (shelf).
- **Revive-on-replace** — create reconciles the `(product, corner)` unique constraint (which ignores `deletedAt`) by un-deleting a soft-deleted row (409 if live, 400 for a foreign product).
- Data: soft-delete on `company_store_products`; **33 permissions** (`placements.*`). Only `targetStockQuantity` is set here — `current`/`reserved`/`sample` are the inventory phase's job.
- **124 unit tests green** + `test/placements.e2e-spec.ts`.

**Next — Phase 6: inventory transactions.** Move real stock (`currentQuantity`/`sampleQuantity`/`reservedQuantity`) through a single centralized write. **This is where the atomic `updateMany`/`$transaction` pattern (deferred since Phase 4) becomes mandatory** — two concurrent decrements on the same shelf is an oversell. Start with `/brainstorming` → spec → plan → per-task build.
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
6. `npm test` (unit — should be 124 green) and `npm run test:e2e`

Latest migration: `prisma/migrations/20260813134452_placement_soft_delete_audit`.

## Key references in-repo
- `docs/superpowers/specs/2026-08-13-phase-5-product-placement-design.md` — Phase 5 design (latest)
- `docs/superpowers/plans/2026-08-13-phase-5-product-placement.md` — Phase 5 implementation plan
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — Phase 1–4 specs & plans
- `blog/en` + `blog/ko` — Phase 1–5 retrospectives
- `prisma/schema.prisma` — single source of truth for the data model
