# One Sign-In, Many Companies — Design

**Date:** 2026-11-12
**Status:** approved by the user on 2026-11-12 (after a builder review).
**Piece 2 of 3** of the membership track:
1. Roles & branches (built: `2026-11-06-roles-and-branches-design.md`).
2. **One sign-in, a separate profile per company** (this doc).
3. Leaving: leave a company, delete an account, close a company when its last owner leaves, provider disconnect.

Nothing here may assume piece 3, but nothing here may block it (see "Built for piece 3").

---

## Why

**Part-timers work for several companies at the same time** (the user's reason). A sales part-timer can work for company A on weekdays and company B on weekends, and needs both in one app.

The same change also covers a second need: **a person keeps their sign-in** when their company closes or when they stop working for it and move to another company. Today they would have to delete their account and sign up again: wipe the phone, unlink Kakao/Apple, disconnect the providers.

**Why today's model can't do it.** One `users` row is both *the person* and *their job at one company*:

| On `users` today | Why it blocks a second company |
|---|---|
| `phone` (unique among non-deleted users) | the same phone can't sign up twice |
| `user_login_methods.user_id` | a password-login email is unique (`UQ_login_methods_local_email`), and a provider identity links to one row (`UQ_login_methods_identity`) |
| `refresh_tokens.user_id` | a session belongs to one row |
| `device_tokens.user_id` | a phone is registered to one row |
| the access token's `sub` = `users.id` | a token means one company |

## Goals

- **One sign-in per person, one profile per company** they belong to.
- **Switch the active company without re-entering a password.**
- **Notifications from every company reach the phone; tapping one switches into that company.**
- **Join a company (invite code → waiting → approval) or create one, from a signed-in account,** the same way the first time and every time after.
- **Existing users migrate silently:** nobody signs up again, nothing is lost, every "recorded by" still points where it did.

## Non-goals

- Leaving a company, deleting an account, closing a company (piece 3).
- The mobile app's screens. This is the backend; it must support a company dropdown, a waiting screen and tap-to-switch notifications.
- Any view that combines several companies' data.
- Changing company-side authorization (roles, branches, permissions, ownership).

## Anti-goals (would make this a failure even if it "works")

- A company learning which other companies a person belongs to (the shared phone number is the one accepted exception, see "Privacy").
- An existing user having to sign up again, or losing history.
- A token for a person's profile in company A being usable in company B.
- Switching companies asking for the password again.
- The join flow letting someone discover which invite codes exist by guessing cheaply (today's `register/member` makes every guess cost a phone verification).

---

## Decisions (the user's)

| Topic | Decision |
|---|---|
| Model | One sign-in, a separate profile per company, switching between companies like Slack workspaces |
| Who it's for | Part-timers working for several companies at once; anyone whose company closes or who moves on |
| Switching | A company dropdown in the personal menu / settings |
| Notifications | Every company's notifications reach the phone; tapping one moves into that company's menu |
| Joining | One uniform process: enter the invite code → waiting screen → unlocked when approved by the admin, an owner, or a manager (as staff, into their own branch, as today) |
| Per-company fields | Name, photo and contact email can differ for each company |
| Signup | Signup creates only the sign-in (phone check + password or Kakao/Google/Facebook/Apple). Everyone then lands on the same "join with an invite code, or create a company" screen |
| Creating a company | Makes you its owner, pending the platform admin's approval, as company registration does today |
| Company-creation limit (decided after the builder review) | **At most one company waiting for approval per sign-in at a time.** A second can be created once the first is approved. Creating no longer costs a phone verification, and every pending company reserves its globally unique tax ID, so without a limit anyone could squat real businesses' tax IDs for free |
| On sign-in (confirmed guess) | The app opens the company used last; with none, the join-or-create screen |
| Switching (confirmed guess) | Never asks for the password again |
| Joining (confirmed guesses) | You type your name for that company (prefilled from your last profile); photo and contact email come later. Waiting for company B doesn't affect company A. At most one profile per company; rejoining a company you left starts a fresh profile |
| Signing in (confirmed guesses) | The sign-in itself always works; each company's status decides what you can do there: active → in; waiting → listed with a "waiting" label, opens the waiting screen; left or closed → gone from the dropdown |
| Signing out (confirmed guess) | Signs you out on that phone for every company at once; switching doesn't start a new session |
| Privacy (confirmed guess) | No company sees your profile in another company. The phone number is shared: it belongs to the sign-in, so colleagues in every company see the same number |
| Platform admin (confirmed guess) | A sign-in with a special profile that belongs to no company, as the admin works today |
| Existing data (confirmed) | Every current user becomes one sign-in plus one profile; nothing changes for them |

---

## How it works

Calls marked *(my call)* are mine and can be rejected.

### Data model (`prisma/schema.prisma`)

**New: `accounts`, the sign-in** *(my call on the name and columns)*
- `id` (uuid), `phone` (unique among non-deleted accounts; **nullable**, because the seeded platform admin has none), `last_profile_id` (nullable: which company to open at sign-in), `created_at`, `updated_at`, `deleted_at` (soft-delete convention; piece 3 uses it).
- Owns: login methods, sessions (refresh tokens), devices.

**Kept: `users`, now the company profile** *(my call: keep the table and its ids)*
- Gains `account_id` (FK → `accounts`, required after migration).
- Loses `phone` (moved to `accounts`).
- Keeps everything company-shaped: `name`, `profile_image_url`, `contact_email`, `biography`, `status`, `company_id`, `role_id`, `company_store_id`, per-user permission overrides, and every "recorded by" relation (orders, audits, transactions, reservations, history, soft-delete actors…). **Keeping `users` as the profile means no company-side code or foreign key changes.**
- **At most one current profile per company:** a partial unique index on `(account_id, company_id) WHERE deleted_at IS NULL AND status <> 'DEACTIVATED'` *(my call)*. Only a left or closed profile (piece 3: DEACTIVATED) frees the slot, so rejoining after leaving creates a fresh one. `SUSPENDED` and `REJECTED` keep holding it, so a suspension can't be dodged by rejoining and a rejected request can't simply be resent; whoever later builds suspension or rejection decides how those end (a follow-up migration if the predicate must change). Nothing sets those two statuses today. Write the predicate with `raw()` exactly as Postgres normalizes it (STATUS.md gotcha), or `migrate dev` will drift forever.
- The platform admin's profile has `company_id = NULL`. NULLs are distinct in a Postgres unique index, so the rule above doesn't touch it.

**Moved to the account**
- `user_login_methods.user_id` → `account_id`. The identity and local-email unique rules stay; `(user_id, method)` becomes `(account_id, method)`.
- `refresh_tokens.user_id` → `account_id`.
- `device_tokens.user_id` → `account_id`.

**Unchanged:** `phone_verifications`, `email_verifications`, `social_signup_tickets`, `social_nonces` (keyed by phone/email, not by user); `notifications.recipient_user_id` (a notification is about a company, so it stays on the profile).

### Tokens, the guard and switching

- **Terms used below.** *The open profile* is the profile a token names, whatever its status the guard accepts (`ACTIVE` or `PENDING_APPROVAL`). A profile *with status ACTIVE* is spelled out as such.
- **Every access token names the account, and the open profile when there is one** *(my call)*. A brand-new account with no company yet gets a token with no profile.
- **`AuthUser.id` stays the profile id**, so every existing service (`caller.id`, `caller.companyId`, `caller.roleCode`, `caller.companyStoreId`) keeps working untouched. `AuthUser` gains `accountId`.
- **The guard** (`JwtAuthGuard`, which already reloads the user on every request) loads the profile named by the token, checks that it belongs to the token's account, that neither is deleted, and that the profile's status is in `CAN_AUTHENTICATE`.
- **Two kinds of route** *(my call)*:
  - **Company routes** (everything that exists today except sign-in) require an open profile. A profile-less token gets 403 there. As today, `PermissionsGuard` still refuses any profile whose status isn't `ACTIVE` on routes with `@RequirePermissions`, so a waiting profile can use only the unpermissioned ones: its own name, contact email and photo (so the "you've been approved" email can reach it) and `GET /auth/me`.
  - **Account routes** (my companies, join, create, switch, login methods, devices, sign-out, `GET /auth/me`) work with or without a profile.
- **The platform admin** can't join or create companies *(builder's call, accepted)*; its company-less ADMIN profile is opened at sign-in like any other.
- **Switching:** `POST /auth/switch { profileId }` *(my call on the path)* issues an access token for another profile of the **same account** whose status is `ACTIVE` or `PENDING_APPROVAL`, and records it as `last_profile_id`. No password. A profile of another account, or a left one, is 404.
- **A token for profile A can never act as profile B:** the profile is fixed in the token, and the guard checks it belongs to the account.
- **Sessions belong to the account, and each session remembers its own open profile** *(builder's call, accepted)*. Sign-in opens `last_profile_id`; a refresh re-issues a token for the profile **that session** had open, so switching on one phone doesn't move the account's other phones. Reuse detection keeps revoking every session of the account.
- **Signing out** revokes that refresh token and unregisters that device, which signs the phone out of every company at once.
- **Password reset** keeps logging out every session, now of the account.

### Endpoints

| Method + path *(paths are my call)* | Who | What |
|---|---|---|
| `POST /auth/signup` | anyone with a verified phone | Creates the account and its first login method (password, or a social signup ticket), **no profile**. Replaces the account-creating half of `register` and `register/member`. Returns tokens without a profile |
| `POST /auth/login`, `POST /auth/social/login` | — | Sign in **the account**. The response lists the account's companies (below) and the token names the profile to open: `last_profile_id` if its status is still `ACTIVE` or `PENDING_APPROVAL`, else the most recently created such profile, else none |
| `POST /auth/refresh` | — | Rotates the session as today; the new access token names the profile that session had open (if it's still `ACTIVE` or `PENDING_APPROVAL`, else as at sign-in) |
| `GET /me/companies` | the account | Every profile with status `ACTIVE` or `PENDING_APPROVAL`: `{ profileId, status, name, photo, role, company { id, name } }`. Left, closed, suspended and rejected profiles aren't listed |
| `POST /me/companies/join` | the account | `{ joinCode, name }` → a `PENDING_APPROVAL` profile in that company (no role, no branch), `MEMBER_JOIN_REQUESTED` emitted. Already pending or active there → 409. Unknown code → 404, **rate-limited per account** *(my call, numbers left to the builder)* |
| `POST /me/companies` | the account | `{ companyName, taxId, ownerName }` → a company plus a `PENDING_APPROVAL` **OWNER** profile, `COMPANY_REGISTERED` emitted; the admin approves with `PATCH /companies/:id/approve` (unchanged). **409 while this account already has a company waiting for approval** (a `PENDING_APPROVAL` OWNER profile; the user's decision). Race-safe *(my call)*: lock the account row by writing it, then count, so two creates at once give one 201 and one 409 |
| `POST /auth/switch` | the account | See above |
| `GET /auth/me` | the account | The account (phone, login methods summary) plus the open profile, if any |
| `PATCH /users/me` | the open profile (waiting ones too) | Change this company's `name` *(my call: needed because names now differ per company)* |
| `PUT /users/me/contact-email` | the open profile (waiting ones too) | Set this company's contact email, **proven by an emailed code** (the existing `/auth/email/start|confirm` flow) *(my call)* |
| `POST /users/me/avatar…` | the open profile (waiting ones too) | Unchanged path (no permission needed, as today); the photo is now this company's |
| `/users/me/login-methods…`, `POST /auth/find-id`, `POST /auth/reset-password`, `/devices` | the account | Unchanged paths; now act on the account |
| `POST /auth/register`, `POST /auth/register/member` | — | **Removed** *(my call: there's no production; the two-step flow replaces them, and the e2e helpers move to it)* |

Everything else (members, corners, orders, history…) is unchanged and runs as the open profile.

### Notifications

- **Push goes to every device of the profile's account**, so a phone gets every company's notifications whichever company is open.
- **Every push carries `companyId` and `profileId`** in its data, so tapping can switch first. Order, audit and stock-alert pushes carry only `cornerId` today and gain them.
- **The push title names the company** *(my call)*, so two companies' notices can be told apart on the lock screen.
- **Email goes to that profile's contact email.** A profile with no contact email yet gets push only for that company *(my call)*.
- **Account-wide notices** belong to no company (today only `account.passwordReset`). They go to **the account**: an email to its password-login address (the one that was just reset) and one push per device, not one per profile *(my call)*. The notification row records no profile; how it records the account is left to the builder.

### Privacy between companies

- Every company-side read is per profile, as today, so a company only ever sees its own profiles.
- An approver sees the pending profile in their company only, never the person's other companies.
- **The phone is the one shared field.** It belongs to the account, and the member list (`MEMBER_SELECT.phone`) shows it, so every company sees the same number.

### Migration (existing data)

- **Expand → migrate → contract**, with hand-written data steps (`--create-only`, data step added **before** anything applies it; never edit a migration once applied).
- One account per existing user, soft-deleted users included (their account is soft-deleted too) *(my call)*. Move `phone` to the account; repoint login methods, refresh tokens and devices; set `users.account_id`; set `last_profile_id` to that user.
- Then drop `users.phone` and the old `user_id` columns.
- The platform admin becomes an account plus its company-less ADMIN profile, exactly as the row is today.
- The seed creates the admin through the new shape.

### Races (project rule: conditional writes + count, never caught errors)

- **Two joins of the same company at once:** the partial unique index decides; `createMany`/`createManyAndReturn` with `skipDuplicates` → `count 0` / `[]` → 409.
- **Two signups with the same phone:** the unique phone on `accounts`, the same way.
- **Login methods:** the existing identity and local-email rules, unchanged. "Never unlink the last login" takes its lock on the **account** row instead of the user row.
- **Switching** writes only `last_profile_id` and the session's open profile (last write wins, harmless).
- **Two company creations at once by one account:** both write the account row first (lock by writing), so the second waits, then counts the first's pending company → 409.

### Built for piece 3

- **Leaving a company** = that profile becomes DEACTIVATED: it drops out of the dropdown and frees the "one current profile per company" slot. The account and its other companies are untouched.
- **Deleting an account** = soft-delete the account (freeing its phone and login methods for a new signup) and deactivate every profile. Names stay on records, because history foreign keys are RESTRICT and profiles are never hard-deleted.
- **The automatic promotion's "most experienced"** reads the profile's `created_at`, i.e. time at *that* company.

## Testing

- **Unit:** the new account, join, create and switch services; the guard (profile belongs to the account, profile-less tokens on company routes, statuses); notifications (push to the account's devices, `companyId`/`profileId` in the data, email per profile); the join-attempt limit; login and social login returning the companies.
- **e2e, the part-timer story:** sign up → join A → approved → join B (pending, A keeps working) → B approved → switch → a token for A is refused in B → a notification from B carries B's ids → sign out on the phone ends both.
- **e2e, the existing suites** move from `register` / `register/member` to signup + create/join helpers.
- **Migration check:** apply to a copy of the dev database and verify every user has an account, phones and login methods moved, and counts match. A human runs every `prisma migrate` and the e2e suite.

## Left to the builder

- Token claim names and shape; whether `switch` also rotates the refresh token.
- How a session stores the profile it has open.
- Exact paths and response shapes for the account routes; module layout (e.g. an `AccountsModule`).
- The join-attempt limit's numbers and window.
- The order of migrations and tasks.
