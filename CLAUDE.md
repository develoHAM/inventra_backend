# Inventra — Claude Code Working Guide

Multi-tenant inventory-management SaaS (Korean concession-store model — companies operate "corners" inside physical stores). **NestJS 11 · Prisma 7** (driver adapters; client generated to `src/generated/prisma`) **· PostgreSQL · Jest + supertest · npm.**

## Start here
**Read [`docs/superpowers/STATUS.md`](docs/superpowers/STATUS.md) first** — the living handoff: what's done, the current phase, the next slice, and new-machine setup. Specs are in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`, phase retrospectives in `blog/en` + `blog/ko`.

**Current state:** Phases 0–5 complete. **Next: Phase 6 — inventory transactions** (move real stock through one centralized write; this is where the atomic `updateMany`/`$transaction` pattern, deferred since Phase 4, becomes mandatory).

## How we work (please follow)
- **Teaching-first.** I'm learning NestJS — explain the concepts and framework fundamentals as we build, the *why* not just the *what*.
- **Per-task flow:** (1) teach the concepts → (2) give requirements → (3) provide full reference code → (4) **you (Claude) write the test files and run them**. **I write the production code**; you own the tests. I compare mine against your reference.
- **Phase workflow:** each phase goes brainstorm → spec → plan → per-task build (superpowers `brainstorming` → `writing-plans`, then execute task-by-task). Save the spec to `docs/superpowers/specs/`, the plan to `docs/superpowers/plans/`.
- **Auto-commit at green checkpoints.** When tests are green / a task is complete, commit with a descriptive message **and push to `origin/main`** without being asked. Verify green first; never commit known-broken code; surface anomalies instead of blindly committing. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Phase-end:** offer the bilingual EN+KR Medium-style `/phase-blog` retrospective.

## Commands
- `npm test` — unit suite (currently **124 green**).
- `npm run test:e2e` — e2e. ⚠️ Its `pretest` runs `prisma migrate reset --force`, which Claude's Prisma AI-safety guard blocks — **a human must run e2e and any `prisma migrate` command**. Claude runs `npm test`, `npm run seed`, and read-only `psql` fine.
- `npm run build` · `npm run seed` · `npm run lint`.

## Repo conventions
- **Soft-delete everywhere:** `deletedAt` + nullable `deletedByUserId` (FK, named relation); reads filter `deletedAt: null`.
- **Two-layer authz:** `@RequirePermissions` (RBAC, seeded in `prisma/seed.ts`) + `OwnershipService` tenant scoping (`companyId`). Row-level rules (creator-scoped, manager-managed, staff-assigned) live in the services.
- **Fetch-then-decide:** owning services expose row-or-null lookups (`findInCompany`, `findActiveMember`, …); the calling service decides the 400/403/404.
- **Nested resources** scope through their parent (e.g. placements resolve their corner via `CornersService` rather than a `companyId` column).
- **Schema:** `prisma/schema.prisma` is the single source of truth (`prisma/models/*.prisma` are dead leftovers). Import `PrismaClient` from `../generated/prisma/client`.
- Local `DATABASE_URL` must **not** include `sslmode=require`.
