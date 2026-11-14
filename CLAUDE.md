# Inventra — Claude Code Working Guide

Multi-tenant inventory-management SaaS (Korean concession-store model — companies operate "corners" inside physical stores). **NestJS 11 · Prisma 7** (driver adapters; client generated to `src/generated/prisma`) **· PostgreSQL · Jest + supertest · npm.**

## Start here
**Read [`docs/superpowers/STATUS.md`](docs/superpowers/STATUS.md) first** — the living handoff: what's done, the current phase, the next slice, and new-machine setup. Specs are in `docs/superpowers/specs/`, plans in `docs/superpowers/plans/`, phase retrospectives in `blog/en` + `blog/ko`.

**Current state:** Phases 0–10a complete, plus the file-upload + order/audit CSV·xlsx import/export track, the notifications track (email · OCTOMO phone verification · account recovery · FCM push) and the **social login track** (Kakao · Google · Facebook · Apple, verified by our backend; login methods link/unlink) and **roles & branches** (membership piece 1: promote/demote, move between branches, one branch per manager, append-only change history). **Now:** membership piece 2 (one sign-in, a profile per company, Slack-style switching) — Tasks 1, 1b, 2 done; then piece 3 (leaving: account deletion, company closure) — see STATUS.md.

## How we work (please follow)
- **Teaching-first.** I'm learning NestJS — explain the concepts and framework fundamentals as we build, the *why* not just the *what*.
- **Per-task flow:** (1) teach the concepts → (2) give requirements → (3) provide full reference code → (4) **you (Claude) write the test files and run them**. **I write the production code**; you own the tests. I compare mine against your reference.
- **Phase workflow:** each phase goes brainstorm → spec → plan → per-task build (superpowers `brainstorming` → `writing-plans`, then execute task-by-task). Save the spec to `docs/superpowers/specs/`, the plan to `docs/superpowers/plans/`.
- **Auto-commit at green checkpoints.** When tests are green / a task is complete, commit with a descriptive message **and push to `origin/main`** without being asked. Verify green first; never commit known-broken code; surface anomalies instead of blindly committing. End commit messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Phase-end:** offer the bilingual EN+KR Medium-style `/phase-blog` retrospective.

## Commands
- `npm test` — unit suite (currently **1142 green**).
- `npm run test:e2e` — e2e. ⚠️ Its `pretest` runs `prisma migrate reset --force`, which Claude's Prisma AI-safety guard blocks — **a human must run e2e and any `prisma migrate` command**. Claude runs `npm test`, `npm run seed`, and read-only `psql` fine.
- `npm run build` · `npm run seed` · `npm run lint`.

## Repo conventions
- **Vocabulary:** an **Account** (`accounts`) is the sign-in, one per person: phone, login methods (`AccountLoginMethod`), sessions, devices. A **Profile** (`profiles`) is that person in ONE company: name, photo, contact email, role, branch, status. Everything "recorded by" points at a profile (`*_by_profile_id`). No model is called "User". "Member" stays the business word for a company role/event (`member-rules`, `member.*` events).
- **Soft-delete everywhere:** `deletedAt` + nullable `deletedByProfileId` (FK, named relation); reads filter `deletedAt: null`.
- **Two-layer authz:** `@RequirePermissions` (RBAC, seeded in `prisma/seed.ts`) + `OwnershipService` tenant scoping (`companyId`). Row-level rules (creator-scoped, manager-managed, staff-assigned) live in the services.
- **Duplicates & races → conditional writes + count, never caught DB errors:** inserts via `createMany`/`createManyAndReturn` `{ skipDuplicates: true }` (`count 0` / `[]` → 409), spends via `updateMany` with the condition in `where`. Unique indexes enforce; the count tells.
- **Emails are stored lowercase:** run every incoming email through `src/common/email.ts` `normalizeEmail` (DTO `@Transform`).
- **Fetch-then-decide:** owning services expose row-or-null lookups (`findInCompany`, `StoresService.findActive`, …); the calling service decides the 400/403/404.
- **Nested resources** scope through their parent (e.g. placements resolve their corner via `CornersService` rather than a `companyId` column).
- **Schema:** `prisma/schema.prisma` is the single source of truth (`prisma/models/*.prisma` are dead leftovers). Import `PrismaClient` from `../generated/prisma/client`.
- Local `DATABASE_URL` must **not** include `sslmode=require`.
