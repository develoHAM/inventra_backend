# Phase 1 — Authentication & Authorization Design

- **Project:** Inventra (multi-tenant inventory management SaaS)
- **Date:** 2026-07-13
- **Status:** Design approved; pending implementation plan
- **Depends on:** Phase 0 (Docker, `@nestjs/config` + Zod, Prisma schema/client)

## 1. Goal & Scope

Deliver the authentication (identity + tokens) and authorization (permissions) layer that every future feature module depends on.

**In scope:**
- Local **email + password** authentication (no OAuth yet).
- **Access + refresh** JWT tokens; refresh tokens **stored hashed** and **rotated**.
- **Company self-signup** + admin-approved members.
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
| 4 | Registration | Company self-signup; admin-approved members | Solves the company↔user bootstrap and gives a full lifecycle. |
| 5 | Permission resolution | Fresh per request from DB | Revocations take effect instantly; Redis optimizes later. |
| 6 | JWT implementation | Custom guard with `@nestjs/jwt` | Transparent/learnable; no Passport indirection while OAuth is deferred. |
| 7 | Password hashing | `argon2id` | OWASP-recommended, memory-hard. |
| 8 | Super-admin | Platform `ADMIN` role, cross-company wildcard | Operator oversight; also the bootstrap anchor that breaks the circular FK. |
| 9 | Bootstrap fix | Make `users.company_id` nullable | Platform admin genuinely has no company; avoids deferrable FKs. |

## 3. Data Model Changes (one migration)

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

**Modify `User`:** `companyId` and the `company` relation become **optional** (`String?` / `Company?`) so the platform admin can have no company. Regular users always receive one (enforced in application logic).

**Seed data** (`prisma/seed.ts`):
- Roles: `ADMIN` (platform super-admin), `OWNER` (company owner), `MANAGER`, `STAFF`.
- Permissions: `resource.action` naming (e.g. `users.create`, `users.approve`, `products.create`, `products.read`, …). Full catalog enumerated during implementation, one set per resource.
- `role_permissions`: baseline mapping per role.
- One platform-admin `User` (`company_id = NULL`, `status = ACTIVE`, role `ADMIN`) + its `user_login_methods` local credential (seeded from env-provided initial credentials).

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
│   ├── auth.controller.ts        # POST /auth/register, /login, /refresh, /logout
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
    ├── users.controller.ts       # create member, approve member/company
    └── users.service.ts
```

## 6. Flows

**`POST /auth/register` (public) — company self-signup**
1. Validate DTO; reject if email already in `user_login_methods`.
2. Hash password (argon2id).
3. Transaction: create `Company` (`created_by_user_id = platform ADMIN id` as bootstrap anchor, then updated to the new owner user), create `User` (role `OWNER`, status `PENDING_APPROVAL`, `company_id = new company`), create `user_login_methods` (local).
4. Return a "pending approval" response (no tokens until approved).

**`PATCH /companies/:id/approve` (ADMIN only)** — activates the owner user (`PENDING_APPROVAL → ACTIVE`), enabling login.

**`POST /auth/login` (public)**
1. Find local `user_login_methods` by email; verify password.
2. Require `status = ACTIVE` (reject pending/suspended/etc.).
3. Issue access+refresh; store hashed refresh in `refresh_tokens`.

**`POST /auth/refresh`**
1. Verify refresh JWT (refresh secret); hash and look up in `refresh_tokens`.
2. Reject if missing / revoked / expired.
3. **Rotate:** revoke old row, issue new pair, store new hash.
4. **Reuse detection:** an already-revoked token presented → revoke all the user's tokens (probable theft).

**`POST /auth/logout` (authenticated)** — revoke the presented refresh token (optional "everywhere").

**Member lifecycle (company admin)** — `POST /users` (needs `users.create`) creates a member in the admin's company (`PENDING_APPROVAL`); `PATCH /users/:id/approve` (needs `users.approve`) activates.

## 7. Token Design

| | Access | Refresh |
|---|---|---|
| Payload | `{ sub, type: "access" }` | `{ sub, type: "refresh", jti }` |
| Secret | `JWT_ACCESS_SECRET` | `JWT_REFRESH_SECRET` |
| Lifetime | 15m | 7d |
| Sent on | every request | only `/auth/refresh` |

- `type` claim prevents cross-use of the two token kinds.
- Minimal payload (`sub` only); the guard loads the user **fresh** each request (re-checks `status`, no stale claims).

## 8. Authorization

- **`JwtAuthGuard`** (global, first): skip if `@Public()`; verify access token; load user fresh; require `ACTIVE`; attach `req.user`. Failure → **401**.
- **`@CurrentUser()`**: parameter decorator returning the attached `AuthUser` (`id`, `companyId`, `roleId`, `status`).
- **`PermissionsGuard`** (global, second): read `@RequirePermissions(...)`; allow if none required; allow if role is `ADMIN` (wildcard); else require every listed permission ∈ effective set. Failure → **403**.
- **`PermissionsService.getEffectivePermissions(user)`**:
  ```
  if role === ADMIN → all permissions
  else effective = (role_permissions ∪ GRANTs) − DENYs   // DENY wins
  ```
- Guards register via `APP_GUARD` in order (auth before authz), so protection is **default-on**; public routes opt out with `@Public()`.

## 9. Bootstrapping the circular FK

`companies.created_by_user_id` and `users.company_id` are mutually referencing. Resolution:
- A **pre-seeded platform `ADMIN`** exists, so a new company can be inserted referencing that real user first — no deferrable FK needed for registration.
- Seeding the admin itself is broken by making **`users.company_id` nullable** (the super-admin belongs to no company). No `DEFERRABLE` constraints anywhere.

## 10. Error Handling

| Situation | Response |
|---|---|
| Missing/invalid/expired access token | 401 |
| User pending/suspended/deleted | 401 |
| Authenticated but lacks permission | 403 |
| Invalid request body | 400 |
| Email already registered | 409 |
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
- Decide member-creation credential flow (admin-set initial password vs invite token) — default: admin-set initial password for Phase 1.
