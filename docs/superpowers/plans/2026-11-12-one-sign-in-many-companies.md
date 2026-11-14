# One Sign-In, Many Companies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project workflow (overrides the above for this repo):** the repo is teaching-first. Per task:
> - Claude teaches the new concepts, confirms they're understood, then gives the requirements and (when asked) the full reference code.
> - **The user writes the production code** (or asks Claude to apply it). **Claude writes and runs the tests.**
> - A human runs every `prisma migrate` command and `npm run test:e2e`.
> - Auto-commit and push at green checkpoints. Verbose object literals (`{ id: id }`).

**Goal:** One sign-in per person with a separate profile per company: switch companies without a password, get every company's notifications, and join or create companies from an existing sign-in.

**Architecture:**
- A new `accounts` table holds the phone, login methods, sessions (refresh tokens) and devices. `users` stays as the per-company profile, so every company-side relation and service keeps working. **Task 1b renamed it:** the profile is `Profile` (`profiles`), the sign-in stays `Account`.
- Access tokens name the account and, when one is open, the profile. `AuthProfile.id` stays the profile id. A new `@AccountRoute()` marks the routes that work without a profile.
- A new `src/accounts/` module owns account lookups, the company list, joining and creating. `AuthModule` imports it, never the reverse.

**Tech Stack:** NestJS 11 · Prisma 7 (pg adapter, `partialIndexes` preview) · PostgreSQL · `@nestjs/jwt` · `@nestjs/event-emitter` + the BullMQ notification queue · class-validator · Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-12-one-sign-in-many-companies-design.md`

## Global Constraints

**Accounts and profiles**
- An account's `phone` is unique among non-deleted accounts and nullable (the seeded admin has none). Every real signup requires a verified phone.
- **Openable** profile = not deleted, status `ACTIVE` or `PENDING_APPROVAL` (the existing `CAN_AUTHENTICATE`). Only openable profiles are listed, opened or switched to.
- At most one profile per account per company that isn't `DEACTIVATED`: partial unique index `UQ_profiles_account_company` on `(account_id, company_id) WHERE deleted_at IS NULL AND status <> 'DEACTIVATED'`.
- Name, photo and contact email live on the profile; phone, login methods, sessions and devices on the account.
- The platform admin (an account with an `ADMIN` profile) can't join or create companies.

**Tokens and sessions**
- Access token payload: `{ sub: accountId, pid?: profileId, type: 'access' }`. Refresh token payload: `{ sub: accountId, jti, type: 'refresh' }`.
- A session (`refresh_tokens` row) remembers the profile it has open (`profile_id`). Sign-in opens `accounts.last_profile_id` if openable, else the newest openable profile, else none. A refresh keeps the session's profile if still openable, else falls back the same way. **Only switching writes `last_profile_id`.**
- Switching never asks for a password. Signing out revokes that session and unregisters that device.

**Joining and creating**
- Join: `{ joinCode, name }` → a `PENDING_APPROVAL` profile with no role and no branch. Approval is unchanged (admin, owner, or a manager as staff into their own branch).
- Create: `{ companyName, taxId, ownerName }` → a company plus a `PENDING_APPROVAL` OWNER profile, approved by `PATCH /companies/:id/approve` (unchanged).
- **At most one company waiting for approval per account** (the user's decision).

**Exact responses** (new ones; existing messages are unchanged)
- 403 `Choose a company first`: a profile-less token on a company route.
- 404 `Company profile not found`: switching to a profile that isn't openable or isn't the caller's.
- 409 `You already belong to or are waiting for this company`.
- 409 `You already have a company waiting for approval`.
- 429 `Too many invite code attempts; try again later`.
- 403 `The platform admin cannot join or create companies`.
- Kept: 409 `Phone already registered`, 409 `Email already registered`, 409 `Tax ID already registered`, 404 `Invalid join code`.

**Project rules**
- Duplicates and races by conditional writes + count (`createManyAndReturn { skipDuplicates }`, guarded `updateMany`, lock by writing), never caught database errors.
- Emails through `normalizeEmail`.
- Never edit a migration once it may have been applied. Don't run `prisma format`.

## Decisions beyond the spec

- **Migrated accounts reuse their user's id** (`accounts.id = users.id` for every existing row), so the data step is plain copies. New accounts get fresh uuids.
- **Join-attempt limit:** at most **5 unknown invite codes per account per rolling hour** → 429. Failed attempts are rows in a new `company_join_attempts` table (counted like `phone_verifications`). A correct code doesn't count. A burst of concurrent wrong codes may overshoot the limit by a few, which is acceptable for a guessing brake.
- **Switching is `POST /auth/switch { refreshToken, profileId }`** and rotates the session, so the new refresh token remembers the new profile.
- **Auth responses rename `user` to `profile`** (the user's decision): the open profile (`{ id, status, companyId, roleId } | null`), plus `companies: CompanyProfileView[]`. The `user` → `profile` key rename (and every e2e `body.user` → `body.profile`) already happened in Task 1b; Task 2 adds `companies`.
- **Pushes carry `profileId`** (the app switches by it) and, for a profile in a company, `companyId`. The push title becomes `${companyName} · ${subject}`. Email subjects are unchanged.
- **Signup takes no contact email.** Social signup credentials carry only `signupToken`; contact emails are set per profile (Task 5). Migrated users keep theirs.

## Review Focus

1. **A token naming a profile of another account** (a forged or stale `pid`) must be refused (401) and never act as that profile (Task 2).
2. **A profile-less token on any existing company route** (members, corners, orders…) must answer 403 `Choose a company first`, never a 500 from a missing `caller` (Task 2).
3. **A session whose open profile stopped being openable** (left, suspended, deleted) must never get a token for it at refresh or sign-in; it falls back to another openable profile or none (Task 2).
4. **Existing users after the migration** must sign in with the same password, Kakao or Apple link, see the same company, and keep their devices (Task 1 migration check).
5. **Two joins of the same company, or two creates by one account, at once** must give one success and one 409 (Task 4).

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` + migrations `accounts` (Task 1), `company_join_attempts` (Task 4) | `Account`; account ids on login methods, refresh tokens, devices; `users.account_id`; partial uniques |
| `prisma/seed.ts` | the admin as an account plus its ADMIN profile |
| `src/accounts/accounts.{module,service}.ts` | `createAccount`, `findProfileToOpen`, `listCompanies`, `isPlatformAdmin` |
| `src/accounts/account-companies.service.ts`, `accounts.controller.ts`, `dto/{join-company,create-company}.dto.ts` | `GET /me/companies`, `POST /me/companies/join`, `POST /me/companies` |
| `src/accounts/company-profile-view.ts` | `CompanyProfileView`, `OpenProfileSummary` |
| `src/auth/{auth.service,auth.controller,token.service}.ts`, `guards/jwt-auth.guard.ts`, `decorators/{account-route,current-account}.decorator.ts`, `types/{auth-profile,auth-account}.ts`, `dto/{signup,switch-profile}.dto.ts` | sessions, signup, switch, `GET /auth/me` |
| `src/auth/account-recovery.service.ts`, `src/phone-verification/phone-verification.service.ts` | phone lookups on the account |
| `src/social-auth/social-auth.service.ts`, `login-methods/login-methods.{service,controller}.ts` | identities and login methods on the account |
| `src/devices/devices.{service,controller}.ts` | devices on the account |
| `src/notifications/{notifications.service,notifications.listener,notification-events}.ts` | push via account devices, `notifyAccount`, per-recipient push data and title |
| `src/profiles/profile-view.ts`, `profiles.service.ts` | the member list's phone comes from the account |
| `src/profiles/{my-profile.controller,my-profile.service,profiles.module}.ts`, `dto/{update-profile,set-contact-email}.dto.ts` | `PATCH /profiles/me`, `PUT /profiles/me/contact-email` |
| `test/helpers/accounts.ts` (new), all 16 e2e suites, `test/accounts.e2e-spec.ts` (new, `testPhones(17)`) | shared signup helpers; the part-timer story |

---

### Task 1: The sign-in moves off `users` (behaviour unchanged) — ✅ done (`5b24f87`)

> Written in the names of its time (`User` = the profile). Task 1b renamed them.

Every existing endpoint keeps its request and response. `register` and `register/member` now create an account plus one profile.

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/seed.ts`
- Migration: `prisma/migrations/<timestamp>_accounts/migration.sql` (generated, then hand-edited)
- Create: `src/accounts/accounts.module.ts`, `src/accounts/accounts.service.ts`
- Modify:
  - `src/auth/{auth.service,auth.module}.ts`, `src/auth/types/auth-user.ts`, `src/auth/guards/jwt-auth.guard.ts`, `src/auth/account-recovery.service.ts`
  - `src/phone-verification/phone-verification.service.ts`
  - `src/social-auth/social-auth.service.ts`, `src/social-auth/login-methods/login-methods.{service,controller}.ts`
  - `src/devices/devices.{service,controller}.ts`
  - `src/notifications/{notifications.service,notifications.listener,notification-events}.ts`
  - `src/members/{member-view,members.service}.ts`
- Test: `src/accounts/accounts.service.spec.ts` (new); the specs of every file above; every e2e suite that reads login methods, refresh tokens, devices or `users.phone` directly

**Interfaces:**
- **Produces:**
  - Prisma `Account { id; phone: string | null; lastProfileId: string | null; createdAt; updatedAt; deletedAt }` with relations `profiles` ("AccountProfiles"), `lastProfile` ("AccountLastProfile"), `loginMethods`, `refreshTokens`, `deviceTokens`. `User.accountId` (required) + `account`. `UserLoginMethod.accountId`, `DeviceToken.accountId`, `RefreshToken.accountId` + `RefreshToken.profileId` (nullable, relation "RefreshTokenProfile").
  - `AccountsService.createAccount(transaction: Prisma.TransactionClient, phone: string | null): Promise<string | null>`. Returns the new id, or `null` when the phone is taken (`createManyAndReturn` with `skipDuplicates`).
  - `AccountsService.findProfileToOpen(accountId: string, preferredProfileId: string | null): Promise<string | null>`. Returns the preferred profile if it's openable and belongs to the account, else the newest openable profile, else `null`.
  - `AuthService.issueSessionFor(accountId: string, profileId: string | null): Promise<{ accessToken: string; refreshToken: string }>`. Writes `{ accountId, profileId }` on the refresh row. Until Task 2 the access token's `sub` is still the profile id.
  - `AuthUser.accountId: string`, loaded by the guard.
  - `DevicesService.register(accountId, input)`, `unregister(accountId, token)`, `findTokens(accountIds: string[]): Promise<{ accountId: string; token: string }[]>`.
  - `LoginMethodsService.list | linkProvider | linkPassword | unlink` take `accountId` instead of `userId`. The controller passes `user.accountId`.
  - `NotificationsService.notifyAccount(input: { accountId: string; eventType: NotificationEventName; message: RenderedMessage }): Promise<void>`. Emails the account's `local` login email (skipped if none) and pushes every device of the account, with `recipientUserId: null`.
  - `AccountPasswordResetEvent { accountId: string }`.

- [ ] **Step 1 (Claude):** Write and update the tests.
  - `accounts.service.spec.ts`:
    - `createAccount` calls `createManyAndReturn({ data: [{ phone }], skipDuplicates: true, select: { id: true } })` and returns the id; `[]` returns `null`.
    - `findProfileToOpen`: a preferred openable profile wins; a preferred profile that is left, suspended, deleted or another account's is skipped for the newest openable one (`orderBy: { createdAt: 'desc' }`); none → `null`.
  - `auth.service.spec`:
    - `register` and `registerMember` call `createAccount` with the phone inside the transaction, then create the profile with `accountId` and the login method with `accountId`. `createAccount` → `null` gives 409 `Phone already registered` with no profile created.
    - `login` loads `loginMethod.account` and opens `findProfileToOpen(account.id, account.lastProfileId)`. A deleted account, or no openable profile, gives 401 `Account cannot sign in` (unchanged until Task 2).
    - `refresh` reuses `stored.accountId` / `stored.profileId`. Reuse detection revokes every session **of the account**.
    - `logout` revokes by `{ tokenHash, accountId }` and unregisters the device by `accountId`.
  - `account-recovery.service.spec`:
    - `findId` looks the account up by phone (`deletedAt: null`).
    - `resetPassword` matches `{ method: 'local', email, account: { phone, deletedAt: null } }`, revokes the account's sessions and emits `{ accountId }`.
  - `phone-verification.service.spec`: the signup start's "phone nobody has" check reads `account.findFirst({ where: { phone, deletedAt: null } })`.
  - `social-auth.service.spec`: a known identity opens `findProfileToOpen(account.id, account.lastProfileId)`. A deleted account or no openable profile gives 401.
  - `login-methods.service.spec`: every query filters by `accountId`. `unlink` takes its lock with `account.updateMany({ where: { id: accountId } … })` before counting.
  - `devices.service.spec`: `register` upserts by token with `accountId`; `findTokens` filters `accountId: { in }`.
  - `notifications.service.spec`:
    - `notifyUsers` push maps recipient profiles to their `accountId`, pushes each account's devices, and keeps `recipientUserId` = the profile id.
    - `notifyAccount` emails the `local` login email, pushes each device with `recipientUserId: null`, and with no `local` login sends push only.
  - `notifications.listener.spec`: `ACCOUNT_PASSWORD_RESET { accountId }` → `notifyAccount` with `passwordReset()`.
  - `members.service.spec`: the member view's `phone` comes from `row.account.phone`. Update the `memberRow` fixture.
  - `jwt-auth.guard` / `AuthUser`: `accountId` is selected and set.
  - **E2e, mechanical:**
    - `where: { loginMethods: { some: … } }` becomes `where: { account: { loginMethods: { some: … } } }`.
    - Direct `prisma.userLoginMethod` / `refreshToken` / `deviceToken` reads by `userId` read by the user's `accountId`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL (no `Account` model, no `AccountsService`).
- [ ] **Step 3 (user):** Change the schema.
  - Add the `Account` model:
    ```prisma
    model Account {
      id            String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
      phone         String?   @db.VarChar(20)
      lastProfileId String?   @map("last_profile_id") @db.Uuid
      createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
      updatedAt     DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
      deletedAt     DateTime? @map("deleted_at") @db.Timestamptz(6)

      lastProfile   User?             @relation("AccountLastProfile", fields: [lastProfileId], references: [id])
      profiles      User[]            @relation("AccountProfiles")
      loginMethods  UserLoginMethod[]
      refreshTokens RefreshToken[]
      deviceTokens  DeviceToken[]

      @@unique([phone], map: "UQ_accounts_phone", where: raw("(deleted_at IS NULL)"))
      @@map("accounts")
    }
    ```
  - `User`:
    - Drop `phone`, `loginMethods`, `refreshTokens` and `deviceTokens`.
    - Add `accountId String @map("account_id") @db.Uuid`, `account Account @relation("AccountProfiles", …)`, `lastProfileOf Account[] @relation("AccountLastProfile")` and `openSessions RefreshToken[] @relation("RefreshTokenProfile")`.
    - Add `@@unique([accountId, companyId], map: "UQ_users_account_company", where: raw("((deleted_at IS NULL) AND (status <> 'DEACTIVATED'::user_status))"))`.
  - `UserLoginMethod`: `userId` → `accountId` (`account_id`), and `@@unique([accountId, method], map: "UQ_login_methods_account_method")`.
  - `DeviceToken`: `userId` → `accountId`, with index `IDX_device_tokens_account`.
  - `RefreshToken`:
    - `userId` → `accountId`, with index `IDX_refresh_tokens_account_id`.
    - Add `profileId String? @map("profile_id") @db.Uuid` and its relation "RefreshTokenProfile".
- [ ] **Step 4 (human):** Run `npx prisma migrate dev --create-only --name accounts`.
- [ ] **Step 5 (Claude):** Rewrite the generated SQL into this order, **before anything applies it**:
  1. `CREATE TABLE "accounts"`.
  2. Add `account_id` as **nullable** to `users`, `user_login_methods`, `refresh_tokens` and `device_tokens`, and add `refresh_tokens.profile_id`.
  3. Data step:
     ```sql
     INSERT INTO "accounts" ("id", "phone", "last_profile_id", "created_at", "updated_at", "deleted_at")
       SELECT "id", "phone", "id", "created_at", "updated_at", "deleted_at" FROM "users";
     UPDATE "users"              SET "account_id" = "id";
     UPDATE "user_login_methods" SET "account_id" = "user_id";
     UPDATE "refresh_tokens"     SET "account_id" = "user_id", "profile_id" = "user_id";
     UPDATE "device_tokens"      SET "account_id" = "user_id";
     ```
  4. `SET NOT NULL` on the four `account_id` columns.
  5. Drop the old foreign keys, indexes and columns: `UQ_users_phone`/`users.phone`, `UQ_login_methods_user_method`/`user_login_methods.user_id`, `refresh_tokens.user_id`, `device_tokens.user_id`.
  6. Add the new foreign keys, indexes and the partial uniques.
- [ ] **Step 6 (human):**
  1. Run `npx prisma migrate dev`, then `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`. Expected: empty. If not, the `raw()` predicates don't match Postgres's normalized text: fix the schema, not the applied migration.
  2. Claude, read-only `psql` on dev (Review Focus 4):
     - `SELECT count(*) FROM users WHERE account_id IS NULL` = 0, and account count = user count.
     - `SELECT count(*) FROM user_login_methods l LEFT JOIN users u ON u.account_id = l.account_id WHERE u.id IS NULL` = 0: every login still leads to a profile.
     - Device and refresh-token counts match those from before the migration.
- [ ] **Step 7 (user):** Code to the interfaces above.
  - `AccountsModule` exports `AccountsService`; `AuthModule` imports it.
  - The seed creates the admin account (`phone: null`) with an ADMIN profile and a `local` login method on the account.
- [ ] **Step 8:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 9 (human):** Run `npm run test:e2e`. Expected: all green. Record the `Tests:` line as reported.
- [ ] **Step 10:** Commit: `refactor(accounts)!: the sign-in (phone, login methods, sessions, devices) moves to accounts`.

### Task 1b: Names — the company profile is a Profile — ✅ done (`7c05860`)

Added mid-track (the user's decision): **Account** = the sign-in, **Profile** = the person in one company; no model is called "User". `User→Profile` (`profiles`), `UserPermission→ProfilePermission`, `UserStatus→ProfileStatus`, `UserLoginMethod→AccountLoginMethod` (`account_login_methods`), `*_user_id` → `*_profile_id`; `AuthUser→AuthProfile`, `@CurrentUser→@CurrentProfile`, `request.user→request.profile`, `notifyUsers→notifyProfiles`, `findUserEmail→findProfileEmail`; `src/members` + the avatar service → `src/profiles` (`ProfilesService`, `ProfilePhotosService`), companies + join code → `src/companies`; routes `/users/…` → `/profiles/…`, login methods → `/accounts/me/login-methods`; permissions `users.*` → `profiles.*`; auth responses' `user` key → `profile`. Migration `20261113120851_profiles`: hand-written RENAMEs + the permission-code UPDATE. 1083 unit + 227 e2e green.

### Task 2: Tokens name the account and the open profile; switching — ✅ done

> As built: `AuthService.startSession(accountId, profile)` is the one place a `SessionResponse` is made (`issueSessionFor` became private); `AccountsService.findOpenableProfile(accountId, profileId)` (row or null) serves refresh and switch; refresh also refuses a deleted account; signup keeps its old response until Task 3; `/auth/switch` answers 201 like `/auth/login` and `/auth/refresh`. 1142 unit + 231 e2e green.

**Files:**
- Create:
  - `src/auth/decorators/account-route.decorator.ts`, `src/auth/decorators/current-account.decorator.ts`
  - `src/auth/types/auth-account.ts`, `src/auth/dto/switch-profile.dto.ts`
- Modify: `src/auth/{token.service,auth.service,auth.controller}.ts`, `src/auth/guards/jwt-auth.guard.ts`, `src/social-auth/social-auth.service.ts`, `src/accounts/{accounts.service,company-profile-view}.ts`; tag the account-level routes (`/auth/logout`, `/auth/me`, `/auth/switch`, `/devices`, `/accounts/me/login-methods`) with `@AccountRoute()`
- Test: the specs of each; `test/auth.e2e-spec.ts`

**Interfaces:**
- **Consumes:** Task 1's `findProfileToOpen`, `issueSessionFor`.
- **Produces:**
  - `TokenService.signAccess(session: { accountId: string; profileId: string | null }): Promise<string>` and `verifyAccess(token): Promise<{ accountId: string; profileId: string | null }>`.
  - `signRefresh(accountId: string)` and `verifyRefresh(token): Promise<{ accountId: string; jti: string }>`.
  - `type AuthAccount = { accountId: string; profileId: string | null }`, set on `request.account` for every authenticated request. `request.profile` (`AuthProfile`) is set only when a profile is open.
  - `@AccountRoute()` (metadata key `ACCOUNT_ROUTE_KEY`) and `@CurrentAccount()` (returns `AuthAccount`).
  - `OpenProfileSummary = { id: string; status: ProfileStatus; companyId: string | null; roleId: number | null }` (exists since Task 1, `OPEN_PROFILE_SELECT`).
  - `CompanyProfileView = { profileId: string; status: ProfileStatus; name: string; profileImageUrl: string | null; role: { code: string; name: string } | null; company: { id: string; name: string } | null }`. The photo is presigned, like `ProfileView`.
  - `SessionResponse = { accessToken: string; refreshToken: string; profile: OpenProfileSummary | null; companies: CompanyProfileView[] }`, returned by `login`, `refresh`, social `LOGGED_IN` and `switchProfile`.
  - `AccountsService.listCompanies(accountId: string): Promise<CompanyProfileView[]>`. Openable profiles only, oldest first.
  - `AuthService.switchProfile(account: AuthAccount, dto: { refreshToken: string; profileId: string }): Promise<SessionResponse>`.

- [ ] **Step 1 (Claude):** Write the tests.
  - **Token:**
    - `signAccess({ accountId: 'a', profileId: 'p' })` signs `{ sub: 'a', pid: 'p', type: 'access' }`; a `null` profile omits `pid`.
    - `verifyAccess` returns `profileId: null` when `pid` is absent.
  - **Guard:**
    - A profile token sets `request.profile` (`id` = profile, `accountId`) and `request.account`.
    - **Review Focus 1:** a `pid` whose profile belongs to another account → 401.
    - A deleted account → 401, and a non-openable profile → 401.
    - **Review Focus 2:** a profile-less token on an unmarked route → 403 `Choose a company first`; on an `@AccountRoute()` it passes with `request.profile` undefined.
    - `@Public()` routes are unchanged.
  - **Login and social login:**
    - The response is a `SessionResponse` with `companies` from `listCompanies`.
    - **An account with no openable profile now signs in** with `profile: null` instead of 401. A deleted account is still 401.
  - **Refresh (Review Focus 3):**
    - The session's `profileId` is kept when it's still openable.
    - When it isn't (left, suspended, deleted), `findProfileToOpen(accountId, accounts.lastProfileId)` decides, and a refresh never names a non-openable profile.
    - Reuse detection is unchanged.
  - **Switch:**
    - Another account's profile, or one that isn't openable → 404 `Company profile not found`, and nothing is revoked.
    - A refresh token of another account → 401.
    - Success revokes the old refresh row, writes a new one with the new `profileId`, sets `accounts.lastProfileId`, and returns the new session.
    - A revoked refresh token triggers reuse detection.
  - **`GET /auth/me`** returns `{ accountId, phone, profile: AuthProfile | null }`.
  - **`listCompanies`:** only openable profiles, with role and company, the photo presigned.
  - **E2e:**
    - `POST /auth/login` returns `companies` with one entry.
    - `POST /auth/switch` to that same profile returns new tokens, and the old refresh token is now refused.
    - Switching to another account's profile id → 404.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces.
  - Add `POST /auth/switch` (`@AccountRoute()`, body `SwitchProfileDto { refreshToken: string; profileId: uuid }`).
  - `GET /auth/me`, `POST /auth/logout`, `/devices` and `/accounts/me/login-methods` become `@AccountRoute()` and read **`@CurrentAccount()`**, not `@CurrentProfile()`. `request.profile` is absent when no profile is open.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(auth): tokens name the account and the open profile; switch companies`.

### Task 3: Signup creates only the sign-in

**Files:**
- Create: `src/auth/dto/signup.dto.ts`
- Modify: `src/auth/{auth.service,auth.controller}.ts`
- Test: `auth.service.spec`, `src/auth/dto/signup.dto.spec.ts`, `test/auth.e2e-spec.ts`

**Interfaces:**
- **Consumes:** `createAccount`, `AuthService.startSession(accountId, null)` (Task 2; returns the `SessionResponse`).
- **Produces:**
  - `SignupDto { phone; phoneVerificationToken; credentials: PasswordCredentialsDto | SocialSignupCredentialsDto }`. `SocialSignupCredentialsDto` is `{ type: 'social'; signupToken }` with no contact-email fields. The phone rules are those of today's `RegisterMemberDto`.
  - `AuthService.signup(dto: SignupDto): Promise<SessionResponse>` behind `POST /auth/signup` (`@Public()`).

- [ ] **Step 1 (Claude):** Write the tests.
  - `signup` order:
    1. Inside one transaction: spend the `SIGNUP` phone token, then `createAccount(phone)` (`null` → 409 `Phone already registered`).
    2. The first login method on the account: a password login, or a spent signup ticket. A duplicate email or identity → 409, with the whole signup rolled back.
    3. `startSession(accountId, null)`.
  - The response is `{ …tokens, profile: null, companies: [] }`.
  - DTO spec: social credentials with `contactEmail` are refused as non-whitelisted.
  - **E2e:**
    - Sign up with a password → `GET /auth/me` shows `profile: null`.
    - `GET /profiles` → 403 `Choose a company first`.
    - Logging in with that password → `profile: null`, `companies: []`.
    - The same phone signing up again → 409.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces. `register` and `register/member` stay until Task 7.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(auth): signup creates only the sign-in`.

### Task 4: Join or create a company from a sign-in

**Files:**
- Modify: `prisma/schema.prisma` (`CompanyJoinAttempt`); migration `company_join_attempts`
- Create: `src/accounts/{account-companies.service,accounts.controller}.ts`, `src/accounts/dto/{join-company,create-company}.dto.ts`
- Modify: `src/accounts/{accounts.module,accounts.service}.ts`
- Test: `account-companies.service.spec.ts`, the DTO specs, `accounts.controller.spec.ts`, `test/accounts.e2e-spec.ts` (new, `testPhones(17)`)

**Interfaces:**
- **Consumes:** `AuthAccount`, `@AccountRoute()`, `CompanyProfileView`, `generateUniqueJoinCode` (`src/companies/join-code.ts`), the `MEMBER_JOIN_REQUESTED` and `COMPANY_REGISTERED` events.
- **Produces:**
  - Prisma `CompanyJoinAttempt { id; accountId; createdAt }` (`company_join_attempts`, index `[accountId, createdAt]`).
  - `JoinCompanyDto { joinCode (the existing join-code rules); name (string, not empty) }` and `CreateCompanyDto { companyName; taxId; ownerName }` (today's `RegisterDto` field rules).
  - `AccountsService.isPlatformAdmin(accountId: string): Promise<boolean>`: does a non-deleted profile with role `ADMIN` exist?
  - `AccountCompaniesService.join(account: AuthAccount, dto: JoinCompanyDto): Promise<CompanyProfileView>`.
  - `AccountCompaniesService.create(account: AuthAccount, dto: CreateCompanyDto): Promise<CompanyProfileView>`.
  - Constants `JOIN_ATTEMPT_LIMIT = 5` and `JOIN_ATTEMPT_WINDOW_MS = 60 * 60 * 1000`.
  - `AccountsController` (`@Controller('me')`, every route `@AccountRoute()`): `GET companies` → `listCompanies`, `POST companies/join` → 201, `POST companies` → 201.

- [ ] **Step 1 (Claude):** Write the tests.
  - **`join`:**
    - The admin → 403.
    - With ≥ 5 attempts in the window → 429, and no company lookup happens.
    - An unknown or deleted company's code inserts an attempt row → 404 `Invalid join code`.
    - Otherwise `profile.createManyAndReturn({ data: [{ accountId, companyId, name, status: PENDING_APPROVAL, roleId: null }], skipDuplicates: true })`. `[]` → 409 `You already belong to or are waiting for this company`.
    - `MEMBER_JOIN_REQUESTED { companyId, memberProfileId }` is emitted after the write.
    - A correct code records no attempt.
  - **`create`:**
    - The admin → 403.
    - Inside one transaction:
      1. `account.updateMany({ where: { id } … })` (the lock), **then** count the account's `PENDING_APPROVAL` OWNER profiles. ≥ 1 → 409 `You already have a company waiting for approval`.
      2. The OWNER profile (`companyId: null`), then the company via `createManyAndReturn` with `skipDuplicates` (`[]` → 409 `Tax ID already registered`, rolling back the profile).
      3. Set the profile's `companyId`.
    - `COMPANY_REGISTERED` is emitted after commit.
    - The timeline asserts the lock before the count.
  - **Controller:** each route carries `@AccountRoute()` and passes `@CurrentAccount()` through.
  - **E2e (Review Focus 5):**
    - A signed-up account joins company 1 → 201, pending; `GET /me/companies` lists it as `PENDING_APPROVAL`.
    - Joining again → 409. Two joins of another company at once → one 201, one 409.
    - Five wrong codes → five 404s; the sixth → 429; the right code still works.
    - Create a company → 201; a second create → 409. After the admin approves the first, a second create → 201.
    - Two creates at once by a fresh account → one 201, one 409.
    - The admin's token on join or create → 403.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Add `CompanyJoinAttempt` to the schema.
- [ ] **Step 4 (human):** Run `npx prisma migrate dev --name company_join_attempts` (no data step needed).
- [ ] **Step 5 (user):** Code to the interfaces.
- [ ] **Step 6:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 7 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 8:** Commit: `feat(accounts): join or create a company from a sign-in`.

### Task 5: Each company's name and contact email

**Files:**
- Create: `src/profiles/{my-profile.controller,my-profile.service}.ts`, `src/profiles/dto/{update-profile,set-contact-email}.dto.ts`
- Modify: `src/profiles/profiles.module.ts`
- Test: `my-profile.service.spec.ts`, the DTO specs, `test/accounts.e2e-spec.ts`

**Interfaces:**
- **Consumes:** `EmailVerificationService.consume(transaction, { token, email })`, `normalizeEmail`.
- **Produces:**
  - `UpdateProfileDto { name: string (not empty, ≤ 100) }`, `SetContactEmailDto { email (normalized); emailVerificationToken }`.
  - `type ProfileSummary = { id: string; name: string; contactEmail: string | null }`.
  - `MyProfileService.updateMyProfile(caller: AuthProfile, dto): Promise<ProfileSummary>` (`PATCH /profiles/me`).
  - `MyProfileService.setMyContactEmail(caller: AuthProfile, dto): Promise<ProfileSummary>` (`PUT /profiles/me/contact-email`).
  - `MyProfileController` (`@Controller('profiles/me')`); the photo routes stay on `ProfilePhotosController` (`/profiles/me/avatar…`).
  - Neither route has a permission decorator, so a waiting profile can use both.

- [ ] **Step 1 (Claude):** Write the tests.
  - `updateMyProfile` writes only the caller's own profile (`where: { id: caller.id }`).
  - `setMyContactEmail` consumes the email proof and updates `contactEmail` in one transaction. A bad or used proof → the existing email-verification error, and nothing is written.
  - **E2e:**
    - A **pending** profile sets its name and a code-proven contact email → 200.
    - After approval, the `member.approved` email arrives at that address (Mailpit).
    - The account's other profile keeps its own name and email.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces. `ProfilesModule` imports `EmailVerificationModule`.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(profiles): each company's name and contact email`.

### Task 6: Notifications from every company

**Files:**
- Modify: `src/notifications/notifications.service.ts`
- Test: `notifications.service.spec`, `test/push.e2e-spec.ts`

**Interfaces:**
- **Consumes:** Task 1's account-based `findTokens`.
- **Produces:** `notifyProfiles` push rows for each recipient profile × each device of its account. The push data is `{ ...input.data, profileId: <recipient profile id>, ...(profile has a company ? { companyId: <its id> } : {}) }`, and the push subject is `${company.name} · ${message.subject}` when the profile has a company (otherwise unchanged). Email rows are unchanged.

- [ ] **Step 1 (Claude):** Write the tests.
  - Two recipients in one company whose accounts have one and two devices → three push rows, each with its recipient's `profileId` and the company's `companyId`, and the subject prefixed with the company name.
  - An admin recipient (no company) keeps the event's own data and subject, plus `profileId`.
  - The event's own data keys survive.
  - **E2e:** an order created in company A by its owner reaches the manager's device with `profileId`/`companyId` of A and an `A · …` title (the push rows in `notifications`).
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interface.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(notifications): pushes from every company, tagged and tappable`.

### Task 7: Retire the old signup endpoints; the part-timer story; docs

**Files:**
- Delete:
  - `src/auth/dto/{register,register-member}.dto.ts`
  - `AuthService.register` / `registerMember` and their routes
  - `SocialCredentialsDto`'s contact-email fields and `contactEmailFor`, if nothing else uses them
- Create: `test/helpers/accounts.ts`
- Modify: all 16 e2e suites, `test/accounts.e2e-spec.ts`, `docs/superpowers/STATUS.md`, `CLAUDE.md`, the spec's status
- Test: `auth.service.spec`, `auth.controller` spec, every e2e suite

**Interfaces:**
- **Produces** (`test/helpers/accounts.ts`; each helper drives the real endpoints):
  - `signUp(app, nextPhone, credentials: { email: string; password: string }): Promise<Session>`.
  - `createCompany(app, session, body): Promise<{ profileId: string; companyId: string; joinCode: string }>`.
  - `joinCompany(app, session, joinCode, name): Promise<{ profileId: string }>`.
  - `switchTo(app, session, profileId): Promise<Session>`.
  - `Session = { accessToken; refreshToken }`.
  - Composites `registerOwner(app, adminAccess, nextPhone, n)` and `registerJoinedMember(app, ownerAccess, nextPhone, joinCode, roleCode, tag)`, with the same results the suites' current helpers return.

- [ ] **Step 1 (Claude):**
  - Move every suite to the shared helpers.
  - Add the part-timer story to `test/accounts.e2e-spec.ts`:
    1. Sign up, join A, approved, then join B (pending): A's routes still work with A's token.
    2. B is approved, then switch to B.
    3. A token for A is refused on B's members (404 or 403 per existing rules), and B's token can't read A.
    4. A B notification push carries B's `profileId`.
    5. Signing out ends the session for both companies.
    6. A left company disappears from `GET /me/companies` (set `DEACTIVATED` directly; piece 3 builds leaving).
  - Unit specs: the removed methods go.
- [ ] **Step 2 (user):** Delete the old endpoints, DTOs and the now-unused credentials fields.
- [ ] **Step 3:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 4 (human):** Run `npm run test:e2e`. Expected: all green. Record the `Tests:` line as reported.
- [ ] **Step 5 (Claude):** Docs.
  - STATUS.md: a section for this track, the measured counts (e2e only from a real `Tests:` line), the migrations, and the new endpoints.
  - CLAUDE.md: state and count.
  - The spec: status built, plus "As built".
- [ ] **Step 6:** Commit: `feat(auth)!: signup → join or create; retire register endpoints; docs`.
