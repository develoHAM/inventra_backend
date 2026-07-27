# Phase 1 — Authentication & Authorization Design

- **Project:** Inventra (multi-tenant inventory management SaaS)
- **Date:** 2026-07-13
- **Status:** Design approved; implementation in progress
- **Depends on:** Phase 0 (Docker, `@nestjs/config` + Zod, Prisma schema/client)
- **Revision (2026-07-18):** Member onboarding changed from *insider-creates* (`POST /users`) to *member self-signup via a company join code* + owner-approval-with-role. `POST /users` removed; `users.role_id` becomes nullable.

## 1. Goal & Scope

Deliver the authentication (identity + tokens) and authorization (permissions) layer that every future feature module depends on.

**In scope:**
- Local **email + password** authentication (no OAuth yet).
- **Access + refresh** JWT tokens; refresh tokens **stored hashed** and **rotated**.
- **Company self-signup** (owner) + **member self-signup via a company join code**, both gated by approval.
- A platform **super-admin** (`ADMIN`) with cross-company access.
- **RBAC** with per-user grant/deny overrides, permissions **resolved fresh per request**.
- Custom `@nestjs/jwt` guards (Passport intentionally deferred; taught alongside as a learning aside).

**Out of scope (later phases):** OAuth providers, admin frontend/UI, Redis caching of permission lookups, Phase 2 `OwnershipService`.

## 2. Key Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Login methods | Local email+password only | Smallest complete auth; OAuth columns in `user_login_methods` wait for a later phase. |
| 2 | Token strategy | Access + refresh | Limits blast radius of a stolen access token; enables revocation. |
| 3 | Refresh storage | Hashed, stored + rotated in a new `refresh_tokens` table | Revocation + multi-device sessions + reuse detection. |
| 4 | Registration | Company self-signup (owner); member self-signup via join code; both approval-gated | Solves the company↔user bootstrap and gives a full lifecycle without an insider-create path. |
| 5 | Permission resolution | Fresh per request from DB | Revocations take effect instantly; Redis optimizes later. |
| 6 | JWT implementation | Custom guard with `@nestjs/jwt` | Transparent/learnable; no Passport indirection while OAuth is deferred. |
| 7 | Password hashing | `argon2id` | OWASP-recommended, memory-hard. |
| 8 | Super-admin | Platform `ADMIN` role, cross-company wildcard | Operator oversight; also the bootstrap anchor that breaks the circular FK. |
| 9 | Bootstrap fix | Make `users.company_id` nullable | Platform admin genuinely has no company; avoids deferrable FKs. |
| 10 | Member targeting | Company **join code** (secret, unique per company) | Applicant resolves to exactly one company without a public tenant directory or spam-any-company risk. |
| 11 | Member role | Assigned by owner **at approval**; `users.role_id` nullable until then | No self-escalation — applicant never controls their privilege level; a member is role-less (unusable) until approved. |
| 12 | No insider-create | `POST /users` dropped | Join-code self-signup + approval fully covers onboarding; a second path is redundant (YAGNI). `users.create` permission retired. |

## 3. Data Model Changes

**New model — `RefreshToken`:**
```prisma
model RefreshToken {
  id        String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  tokenHash String    @unique(map: "UQ_refresh_tokens_token_hash") @map("token_hash") @db.Text
  expiresAt DateTime  @map("expires_at") @db.Timestamptz(6)
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  user User @relation(fields: [userId], references: [id])

  @@index([userId], map: "IDX_refresh_tokens_user_id")
  @@map("refresh_tokens")
}
```
Plus `refreshTokens RefreshToken[]` on `User`.

**Modify `User`:**
- `companyId` and the `company` relation become **optional** (`String?` / `Company?`) so the platform admin can have no company. Regular users always receive one (enforced in application logic).
- `roleId` and the `role` relation become **optional** — a member who self-registers via join code is role-less (`PENDING_APPROVAL`) until the owner assigns a role at approval. A role-less user can never pass `JwtAuthGuard` (it requires `ACTIVE`), so null roles never reach permission resolution. Company owners and the platform admin always receive a role at creation.
- Add `name` (`VarChar(100)`, **NOT NULL**) — a person's display name. No such column existed; every register DTO supplies it. The seeded platform admin row must be backfilled during the migration.

**Modify `Company`:**
- Add `joinCode` — a unique, non-null, unguessable secret generated when the company is created. Members present it at self-signup to resolve their target company. (Shared out-of-band by the owner; retrievable by the authenticated owner.)
- `taxId` (사업자등록번호) becomes **NOT NULL** and is **required in `RegisterDto`**. Rationale: the ADMIN's company-approval decision is only meaningful against a verifiable business identity. (DB-nullable ≠ endpoint-optional — here we make both required.) It remains `@unique`, so duplicate registration → 409.

**Seed data** (`prisma/seed.ts`):
- Roles: `ADMIN` (platform super-admin), `OWNER` (company owner), `MANAGER`, `STAFF`.
- Permissions: `resource.action` naming (e.g. `users.approve`, `products.create`, `products.read`, …). Full catalog enumerated during implementation, one set per resource. (`users.create` retired — members self-register.)
- `role_permissions`: baseline mapping per role.
- One platform-admin `User` (`company_id = NULL`, `status = ACTIVE`, role `ADMIN`, `name` set) + its `user_login_methods` local credential (seeded from env-provided initial credentials). Since `users.name` is now NOT NULL, the seed must set the admin's name and the migration must backfill the existing admin row.

## 4. Config Additions (`src/config/env.schema.ts`)

| Var | Type | Default |
|---|---|---|
| `JWT_ACCESS_SECRET` | string, required | — |
| `JWT_REFRESH_SECRET` | string, required | — |
| `JWT_ACCESS_EXPIRES_IN` | string | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | string | `7d` |

Two **separate** secrets so a leaked access secret cannot forge refresh tokens. Added to `.env` / `.env.example`, validated on boot by the existing Zod schema.

## 5. Module Structure

```
src/
├── auth/              # authentication (who you are)
│   ├── auth.module.ts
│   ├── auth.controller.ts        # POST /auth/register, /register/member, /login, /refresh, /logout; GET /auth/me
│   ├── auth.service.ts
│   ├── token.service.ts          # sign/verify access+refresh, rotation
│   ├── password.service.ts       # argon2id hash/verify
│   ├── guards/jwt-auth.guard.ts  # global (APP_GUARD)
│   └── decorators/{current-user,public}.decorator.ts
├── authorization/     # authorization (what you may do)
│   ├── authorization.module.ts
│   ├── permissions.service.ts    # role + GRANTs − DENYs; ADMIN wildcard
│   ├── guards/permissions.guard.ts  # global (APP_GUARD), runs after JwtAuthGuard
│   └── decorators/require-permissions.decorator.ts
└── users/             # user lifecycle
    ├── users.module.ts
    ├── users.controller.ts       # approve member (assigns role), approve company
    └── users.service.ts
```

## 6. Flows

**`POST /auth/register` (public) — company self-signup**
1. Validate DTO (`companyName`, `taxId`, `ownerEmail`, `ownerPassword`, `ownerName`); reject if email already in `user_login_methods` (409) or `taxId` already in `companies` (409).
2. Hash password (argon2id).
3. Transaction (user-first, enabled by nullable `users.company_id`): create `User` (`name = ownerName`, role `OWNER`, status `PENDING_APPROVAL`, `company_id = NULL`) + `user_login_methods` (local, nested) → create `Company` (`taxId`, generated unique `join_code`, `created_by_user_id = new user id`) → update the user's `company_id = new company id`.
4. Issue access + refresh tokens (store hashed refresh), and return them with the owner's `status = PENDING_APPROVAL` (**auto-login**). The owner can enter the client but is confined to the pending-approval screen (see §8 status handling) until an ADMIN approves.

**`PATCH /companies/:id/approve` (ADMIN only)** — activates the owner user (`PENDING_APPROVAL → ACTIVE`), enabling login.

**`POST /auth/login` (public)**
1. Find local `user_login_methods` by email; verify password.
2. Allow `PENDING_APPROVAL` and `ACTIVE`; reject the terminal statuses (`REJECTED`/`SUSPENDED`/`DEACTIVATED`). A PENDING owner can log in but is confined to the pending screen (see §8).
3. Issue access+refresh; store hashed refresh in `refresh_tokens`.

**`POST /auth/refresh`**
1. Verify refresh JWT (refresh secret); hash and look up in `refresh_tokens`.
2. Reject if missing / revoked / expired.
3. **Rotate:** revoke old row, issue new pair, store new hash.
4. **Reuse detection:** an already-revoked token presented → revoke all the user's tokens (probable theft).

**`POST /auth/logout` (authenticated)** — revoke the presented refresh token (optional "everywhere").

**`POST /auth/register/member` (public) — member self-signup**
1. Validate DTO (`joinCode`, `email`, `password`, `name`); reject if email already in `user_login_methods`.
2. Resolve `joinCode` → `Company`; reject (404) if no company matches.
3. Hash password (argon2id).
4. Single `user.create` with nested `user_login_methods` (local): `name`, `role_id = NULL`, status `PENDING_APPROVAL`, `company_id = resolved company`. No transaction needed — the company already exists, so it's one atomic write (contrast the owner flow's circular-FK transaction).
5. Issue access + refresh tokens (**auto-login**, same as owner register) and return them with `status = PENDING_APPROVAL`, `roleId = null`. The member enters the client on the pending screen until the owner approves and assigns a role.

**`PATCH /users/:id/approve` (needs `users.approve`) — owner approves a member**
1. Load target user; enforce it belongs to the **caller's company** (tenant scope) and is `PENDING_APPROVAL`.
2. Body carries `{ roleId }` (required — you cannot activate a member without a role); reject `ADMIN`/`OWNER` role assignment here.
3. Set `role_id = roleId`, `status = ACTIVE`.

## 7. Token Design

| | Access | Refresh |
|---|---|---|
| Payload | `{ sub, type: "access" }` | `{ sub, type: "refresh", jti }` |
| Secret | `JWT_ACCESS_SECRET` | `JWT_REFRESH_SECRET` |
| Lifetime | 15m | 7d |
| Sent on | every request | only `/auth/refresh` |

- `type` claim prevents cross-use of the two token kinds.
- Minimal payload (`sub` only); the guard loads the user **fresh** each request (re-checks `status`, no stale claims).
- **Transport (decided 2026-07-27): request body / header, not cookies.** Both tokens are returned in the JSON response; the client sends the access token as `Authorization: Bearer` and the refresh token in the request body (`POST /auth/refresh`, `POST /auth/logout`). Chosen for **client-agnosticism** (web + mobile + server) and **CSRF-immunity** over httpOnly-cookie transport. Trade-off: a browser SPA must store the refresh token carefully (`localStorage` is XSS-exposed) — revisit httpOnly `Secure` `SameSite` cookies if a web SPA becomes the primary client.

## 8. Authorization

- **`JwtAuthGuard`** (global, first): skip if `@Public()`; verify access token; load user fresh; allow only `PENDING_APPROVAL` or `ACTIVE` to authenticate (reject soft-deleted and the terminal statuses `REJECTED`/`SUSPENDED`/`DEACTIVATED`); attach `req.user` (incl. `status`). Failure → **401**. Note: PENDING users *authenticate* but are gated from acting by `PermissionsGuard` (below).
- **`@CurrentUser()`**: parameter decorator returning the attached `AuthUser` (`id`, `companyId`, `roleId`, `status`).
- **`PermissionsGuard`** (global, second): read `@RequirePermissions(...)`; allow if none required (so PENDING users can reach permission-free authenticated routes like `GET /auth/me`); otherwise require `status = ACTIVE` (a PENDING user on a permissioned route → **403**), then require every listed permission ∈ effective set (ADMIN's effective set is all permissions). Failure → **403**. **Order matters:** the no-permissions early-return runs *before* the ACTIVE check, else PENDING users couldn't reach their own pending screen.
- **`PermissionsService.getEffectivePermissions(user)`**:
  ```
  if role === ADMIN → all permissions
  else effective = (role_permissions ∪ GRANTs) − DENYs   // DENY wins
  ```
- Guards register via `APP_GUARD` in order (auth before authz), so protection is **default-on**; public routes opt out with `@Public()`.

## 9. Bootstrapping the circular FK

`companies.created_by_user_id` and `users.company_id` are mutually referencing. Resolution — **user-first**, made possible by nullable `users.company_id`:
1. Insert the owner `User` with `company_id = NULL` (temporarily company-less).
2. Insert the `Company` with `created_by_user_id =` that user's id.
3. Update the user's `company_id` to the new company.
All three in one transaction, so it's atomic. No admin anchor and no `DEFERRABLE` constraints needed. (The same nullable column also lets the platform `ADMIN` be seeded with no company at all.)

## 10. Error Handling

| Situation | Response |
|---|---|
| Missing/invalid/expired access token | 401 |
| User soft-deleted or terminal status (REJECTED/SUSPENDED/DEACTIVATED) | 401 |
| PENDING user on a permissioned route | 403 |
| Authenticated but lacks permission | 403 |
| Invalid request body | 400 |
| Email already registered | 409 |
| Company tax ID already registered | 409 |
| Unknown/invalid join code | 404 |
| Approving a member outside the caller's company | 404 (don't leak existence) |
| Refresh token reuse detected | 401 + revoke all user tokens |

## 11. Testing

- **Unit:** `PermissionsService` (grant/deny math, ADMIN wildcard), `PasswordService` (hash/verify), `TokenService` (sign/verify, type-mismatch rejection, rotation).
- **e2e:** register → approve → login → protected route → refresh → logout; pending user rejected at login; missing permission → 403; ADMIN bypass; rotation invalidates old refresh token.

## 12. Libraries

- **`@nestjs/jwt`** — sign/verify JWTs.
- **`argon2`** — password hashing.
- **`class-validator` + `class-transformer`** — DTO validation via `ValidationPipe`.
- (Existing) **`zod`** for env config, **Prisma** for data access.

## 13. Open Items for Implementation Planning

- Enumerate the full permission catalog per resource (mechanical).
- Finalize which role gets which baseline permissions.
- **Resolved:** member onboarding = self-signup with a company join code; the member sets their own password at signup; the owner assigns the role at approval.
- Decide `join_code` format/length and generation (e.g. `INV-` + base32 random) and whether the owner can rotate it (rotation deferred — static per company for Phase 1).
- Decide how the owner retrieves their `join_code` (e.g. include on an authenticated "my company" read) — minimal endpoint in Phase 1.
