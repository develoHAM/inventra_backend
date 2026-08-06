# Inventra — Project Status & Handoff

> Living status doc. Read this first when resuming (especially on a different machine).
> Last updated: 2026-08-07.

**Inventra** = multi-tenant inventory-management SaaS (Korean concession-store model — companies operate "corners" inside physical stores).
**Stack:** NestJS 11 · Prisma 7 (driver adapters, client generated to `src/generated/prisma`) · PostgreSQL · Jest + supertest · npm.

---

## Phase progress

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Infra: Docker Compose, Zod env validation, Prisma modern setup | ✅ complete |
| 1 | Auth: register (owner + member self-signup via join code), login, JWT access/refresh rotation + reuse detection | ✅ complete (blogged) |
| 2 | Authz: `PermissionsGuard` (RBAC) + `OwnershipService` tenant scoping (`companyId`) | ✅ complete (blogged) |
| 3 | **Product catalog** (categories, brands, products) | 🟡 in progress — see below |
| 4+ | Store placement (company↔store), orders, inventory transactions | ⏳ not started |

## Where we are right now — Phase 3 (product catalog)

Two-layer authz applied to a real feature. Design/spec/plan committed under `docs/superpowers/`.

**Done & committed (Tasks 1–5):**
- Data model: soft-delete audit columns (`deletedAt`, `deletedByUserId` FK + named relation) on products/brands/categories; 20 permissions seeded.
- `CategoriesService` — global, ADMIN-managed (`findActive` returns row|null; `findOne` throws).
- `BrandsService` — company-owned via `createdByCompanyId`; `findInCompany` returns row|null.
- `ProductsService` — company-owned via `companyId`; validates brand (in-company) + category + unique barcode; **MANAGER can only delete products they created**; **ADMIN full cross-tenant read + create (supplies `companyId`)**.
- **86 unit tests green across 11 suites.**

**Pending — Task 6 (the ONLY open item):**
- `test/catalog.e2e-spec.ts` is written and committed but **not yet run**.
- ▶️ **Run it:** `npm run test:e2e`
- ⚠️ A human must run this — its `pretest:e2e` runs `prisma migrate reset --force`, which Claude's Prisma AI-safety guard blocks. (Claude can run the plain unit suite `npm test`.)
- When green → **Phase 3 is complete** → generate the bilingual EN+KR `/phase-blog` retrospective (portfolio convention).

## Roadmap after Phase 3
Store placement (company↔store junction) → orders → inventory transactions (single centralized write function) → cross-cutting concerns → Redis caching (only when a measured need appears).

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
6. `npm test` (unit — should be 86 green) and `npm run test:e2e`

Latest migration: `prisma/migrations/20260801120657_catalog_soft_delete_audit`.

## Key references in-repo
- `docs/superpowers/specs/2026-08-01-phase-3-product-catalog-design.md` — Phase 3 design
- `docs/superpowers/plans/2026-08-01-phase-3-product-catalog.md` — Phase 3 implementation plan
- `blog/en` + `blog/ko` — Phase 1 & Phase 2 retrospectives
- `prisma/schema.prisma` — single source of truth for the data model
