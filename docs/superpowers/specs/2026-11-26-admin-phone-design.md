# The Platform Admin's Phone: Design (short)

**Date:** 2026-11-26
**Status:** approved by the user 2026-11-26. Plan: `docs/superpowers/plans/2026-11-26-admin-phone.md`.

## Why

The seeded platform admin is the only account without a phone (`accounts.phone` is null; checked on the dev database 2026-11-26). So the admin can't use the two phone-based recovery flows, **find-ID** and **password reset**, which every other account has. The user also wants **the same data for every role**: every account has a phone, the admin included.

## Goals

- The admin's account has a phone, so find-ID and password reset by phone work for it.
- **Every account has a phone, enforced by the database:** `accounts.phone` becomes NOT NULL.
- The admin stays one ADMIN profile that oversees every company. **This already holds** and doesn't change: joining or creating a company refuses the admin (403), and so do leaving and account deletion.

## Non-goals

- An endpoint to add or change a phone, for anyone (none exists today).
- Proving the admin's number by text message. The operator types it into the env file.
- Admin account deletion (stays 403), or more than one platform admin.

## Anti-goals

- A migration that invents a phone (a placeholder) for an existing admin.
- Two live accounts sharing one number, or the seed taking another account's number.
- A database left half-migrated: the NOT NULL migration must fail cleanly, changing nothing, if an account still has no phone.

## Approaches

| | Approach | |
|---|---|---|
| A | The seed gives the admin a phone, **and** a migration makes `accounts.phone` NOT NULL | **Picked** (the user, 2026-11-26): consistency is enforced, not just followed |
| B | The seed gives the admin a phone; the column stays optional | Not picked: a future code path could still create a phone-less account, and the code keeps its "no phone" branches |

## Design

1. **`SEED_ADMIN_PHONE`**, required, next to `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD`: in `src/config/env.schema.ts` (dashes and spaces stripped, then `KOREAN_MOBILE_PATTERN`, the rule signup uses) and in `.env.example`. The seed normalizes and checks it the same way, importing `normalizePhone` and `KOREAN_MOBILE_PATTERN` from `src/phone-verification/phone.ts`, so the format is defined once.
2. **The seed's admin step:**
   - creating the admin: the account gets `SEED_ADMIN_PHONE`;
   - the admin already exists (found by its login email, as today): if its phone differs from `SEED_ADMIN_PHONE`, the seed sets it. Changing the env and re-seeding is also how a mistyped number gets fixed;
   - either way, if another live account has that number, the seed stops with `SEED_ADMIN_PHONE is already used by another account`, and nothing is written. (A signup taking the number between the check and the write would make the write fail loudly: acceptable for a script a person runs.)
3. **Schema and migration:** `phone String @db.VarChar(20)` (no `?`); the comment becomes "every account, the platform admin included". `UQ_accounts_phone` (partial, live accounts) is unchanged. Migration `accounts_phone_required`: `ALTER TABLE "accounts" ALTER COLUMN "phone" SET NOT NULL;`.
4. **Order on an existing database** (this machine and the other laptop): add `SEED_ADMIN_PHONE` to `.env`, run `npm run seed` (it fills in the admin's phone), check that `SELECT count(*) FROM accounts WHERE phone IS NULL` is 0, then apply the migration. A fresh database (the e2e reset) needs nothing: migrations run on empty tables, then the seed creates the admin with its phone.
5. **Code that loses its "no phone" case:**
   - `AccountsService.createAccount(transaction, phone: string)`;
   - `ProfileRow.account.phone` and `ProfileView.phone`: `string`;
   - account deletion: the `locked.phone === null` branch goes (the admin is still refused first, by `isPlatformAdmin`), and its comments stop saying the admin has no phone.
6. **Tests:**
   - **Unit:** the env schema accepts a dashed number (stored as digits) and refuses a missing one or a non-010 one. Remove the two tests for a phone-less account (`createAccount` with null; deletion's no-phone 403).
   - **The seed:** run twice on the dev database (the second run changes nothing), then read-only `psql`: the admin's phone is set, and no account has none.
   - **E2e** (`.env.test` gets a made-up `SEED_ADMIN_PHONE` outside every suite's phone block, e.g. `01099000001`): the admin finds its ID by phone (a `FIND_ID` proof of that number → the admin's masked email); a signup verification for that number → 409 `Phone already registered`. Password reset for the admin stays out of the e2e: it would change the shared admin password and sign out every suite's admin session. It runs the same code every account uses, which the existing reset e2e covers.
7. **Docs:** STATUS.md's "Resume on a new machine" gets `SEED_ADMIN_PHONE` and the seed-before-migrate order.

## Constraints

- A human runs `prisma migrate` and the e2e.
- The admin's real number goes only into the user's own `.env` (git-ignored). Claude doesn't ask for it, and doesn't print it.

## Left to the builder

- The exact zod expression, the seed's log wording, and the e2e's made-up number.
