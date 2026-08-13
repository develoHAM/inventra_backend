# Inventra — Project Status & Handoff

> Living status doc. Read this first when resuming (especially on a different machine).
> Last updated: 2026-08-13.

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
| 4 | **Stores & Corners** (venues + company corners, manager/staff assignment) | ✅ complete (blogged) |
| 5+ | Product placement (`CompanyStoreProduct`), orders, inventory transactions | ⏳ not started |

## Where we are right now — Phase 4 complete (stores & corners)

Phases 0–4 are done, tested, and blogged. Phase 4 built the organizational layer beneath the catalog:
- **Stores** — global, ADMIN-managed venues (mirrors Categories).
- **Corners** (`CompanyStore`) — company-owned, tenant-scoped; CRUD + store/manager validation; ADMIN cross-tenant.
- **Assignment** — `PUT /corners/:id/manager` (OWNER/ADMIN-only; target must be an active MANAGER member) + `POST`/`DELETE /corners/:id/staff` (MANAGER row-scoped to corners they manage; mirrors Phase 3's creator-scoped delete).
- Data: soft-delete + `deletedByUserId` on `stores`/`company_stores`; `name` NOT NULL; new `corners.location`; **29 permissions** (`stores.*`, `corners.*`, `corners.assign`).
- **100 unit tests green** + `test/stores-corners.e2e-spec.ts`.

**Next — Phase 5: product placement** (`CompanyStoreProduct`): place catalog products onto a corner's shelf with stock targets (`targetStockQuantity`, `sampleQuantity`, `isActive`); `reserved`/`current` quantities are driven by the later orders/inventory phases. This is where the atomic `updateMany`/`$transaction` write pattern (deliberately deferred in Phase 4) becomes mandatory — inventory races cost money.
- ⚠️ e2e reminder: `npm run test:e2e`'s `pretest` runs `prisma migrate reset --force`, blocked by Claude's Prisma AI-guard — **a human must run it**. Claude runs `npm test` fine.

## Roadmap after Phase 5
Orders → inventory transactions (single centralized write function) → cross-cutting concerns → Redis caching (only when a measured need appears).

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
6. `npm test` (unit — should be 100 green) and `npm run test:e2e`

Latest migration: `prisma/migrations/20260811154859_corner_add_location`.

## Key references in-repo
- `docs/superpowers/specs/2026-08-07-phase-4-stores-corners-design.md` — Phase 4 design (latest)
- `docs/superpowers/plans/2026-08-07-phase-4-stores-corners.md` — Phase 4 implementation plan
- `docs/superpowers/specs/2026-08-01-phase-3-product-catalog-design.md` — Phase 3 design
- `blog/en` + `blog/ko` — Phase 1–4 retrospectives
- `prisma/schema.prisma` — single source of truth for the data model
