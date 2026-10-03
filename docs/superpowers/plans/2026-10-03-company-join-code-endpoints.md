# Company Join Code Endpoints Implementation Plan

> **Workflow:** teaching-first, per-task. Claude teaches + gives full reference code; **the user writes production code**; **Claude writes + runs tests**. Auto-commit + push at green checkpoints. Verbose object literals. A human runs `npm run test:e2e`.

**Goal:** let a company's owner and managers see the join code staff use for `POST /auth/register/member`, and let the owner rotate it.

**Why:** the code is generated at company registration (`INV-` + 12 hex) and never changes, and **no endpoint returns it** — owners had no way to share it (the e2e suites read it from the DB). A leaked code can't grant access (the owner approves each member) but floods the owner with join requests; rotating stops that.

**Architecture:** a new `CompaniesService` in `src/users/` (next to the existing `CompaniesController`) with `getJoinCode(caller)` and `rotateJoinCode(caller)`. Routes are `/companies/me/…`: the target company is always the caller's own (`caller.companyId`), so reaching another tenant is unrepresentable — the same self-service pattern as `/users/me/avatar`. Code generation moves out of `AuthService` into shared `generateJoinCode()` / `generateUniqueJoinCode(prisma)`.

**Format change (2026-10-03):** codes become **8 digits** (e.g. `48291307`, shown grouped `4829 1307` by the app) — easier to copy and handwrite than `INV-` + 12 hex. Member signup strips spaces/dashes from the typed code and **requires exactly 8 digits** (400 otherwise). **No legacy codes:** the dev database is reset (`prisma migrate reset`) and re-seeded; the seed creates no companies, so every company from now on gets an 8-digit code (decision 2026-10-03). Production has no data yet, so no data migration is needed.

**Spec:** decided in chat 2026-10-03 (review of the signup flow). No migration.

## Decisions
| Topic | Decision |
|---|---|
| Who can view | `companies.invite` — OWNER + MANAGER (ADMIN gets every permission) |
| Who can rotate | `companies.rotateJoinCode` — OWNER only |
| Pending users | 403 for free: `PermissionsGuard` rejects non-ACTIVE users on any permissioned route |
| Caller with no company (platform admin) | 403 `You do not belong to a company` |
| Rotation effect | old code stops working immediately; existing members unaffected (the code is only checked at signup) |
| Response shape | both return `{ joinCode }`; rotate is `POST …/rotate` with `@HttpCode(200)` (an action, nothing created) |
| Collisions | 10⁸ codes → a draw can hit an existing code (~1 in 10,000 at 10k companies): `generateUniqueJoinCode` redraws until unused (max 5 draws, then a 500); the unique index backstops the check-then-write race |
| Guessability | the join code is checked before the phone token, so codes can be probed (404 vs not). Accepted: a hit only allows a join *request* (needs a verified phone + owner approval); rotation stops abuse. Possible later hardening: check the token first |
| Expiry / per-invitee codes / share links | out of scope |

---

### Task 1: Permissions, generator, service, routes

**Files:** Modify `prisma/seed.ts`, `src/auth/auth.service.ts`, `src/auth/dto/register-member.dto.ts`, `src/users/companies.controller.ts`, `src/users/users.module.ts` · Create `src/users/join-code.ts`, `src/users/companies.service.ts` · Tests `src/users/join-code.spec.ts`, `src/users/companies.service.spec.ts`, `src/users/companies.controller.spec.ts`

**Interfaces — Produces:** `generateJoinCode(): string` (`/^\d{8}$/`); `generateUniqueJoinCode(prisma: Prisma.TransactionClient): Promise<string>`; `normalizeJoinCode(value: unknown): unknown` (DTO transform); `JOIN_CODE_PATTERN = /^\d{8}$/`; `CompaniesService.getJoinCode(caller: AuthUser): Promise<{ joinCode: string }>`; `CompaniesService.rotateJoinCode(caller: AuthUser): Promise<{ joinCode: string }>`; `GET /companies/me/join-code`; `POST /companies/me/join-code/rotate`.

- [ ] **Step 1 (Claude):** tests — generator: 8 digits, left-padded, unique-redraw + give-up; DTO strips spaces/dashes from `joinCode` and rejects anything but 8 digits; service: no `companyId` → 403 (no query); get reads `{ id, deletedAt: null }` selecting only `joinCode`; missing company → 404; rotate writes a fresh unused 8-digit code with a conditional `updateMany` and returns exactly the code it wrote; `count: 0` → 404; controller: each route carries the right `@RequirePermissions` metadata and passes the caller through.
- [ ] **Step 2 (user):** implement (reference code in the teaching message).
- [ ] **Step 3:** human: `npx prisma migrate reset --force` (dev DB) → Claude: `npm run seed` → `npm test` green, `tsc` 0 → commit + push.

### Task 2: e2e

**Files:** Create `test/join-code.e2e-spec.ts` (phone suite 12).

- [ ] owner and manager read the code (it equals the DB value); staff → 403; manager rotate → 403; owner rotate → a new code, the old one now 404s at member signup and the new one works; a pending owner → 403; the platform admin (no company) → 403.
- [ ] human runs `npm run test:e2e` → green → commit + push; STATUS updated.
