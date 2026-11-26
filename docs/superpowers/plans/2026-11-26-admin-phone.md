# The Platform Admin's Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the platform admin's account gets a phone from the seed, so find-ID and password reset by phone work for it, and then `accounts.phone` becomes NOT NULL for every account.

**Architecture:** Task 1 adds a required `SEED_ADMIN_PHONE`, which the seed writes onto the admin's account (new or existing, refusing a number another live account holds). Task 2 then makes the column NOT NULL. On an existing database, the seed must run first, so Task 2 checks that before applying. Task 2 also removes the code paths that allowed a phone-less account.

**Tech Stack:** NestJS 11 · Prisma 7 (pg adapter) · PostgreSQL · zod (env) · Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-26-admin-phone-design.md`

**Working mode:** per task, Claude teaches the concepts, applies the tests first and then the code, and the user reviews the diff file by file. A human runs every `prisma migrate` command and the e2e. Claude commits and pushes after green.

## Global Constraints

- The phone format is `KOREAN_MOBILE_PATTERN` (`/^010\d{8}$/`) after `normalizePhone` (dashes and spaces stripped), both from `src/phone-verification/phone.ts`. Define it nowhere else.
- The seed's refusal message, exactly: `SEED_ADMIN_PHONE is already used by another account`.
- The admin's real number goes only into the user's own `.env`. Claude never asks for it and never prints it (not in commands, logs or psql output).
- `.env.test` gets the made-up `SEED_ADMIN_PHONE=01099000001` (block 99, outside every suite's `testPhones` block).
- A human runs `prisma migrate` and `npm run test:e2e`; never suggest `prisma migrate reset` on the dev database.
- House style: braces on every `if`/loop body, `{ phone: phone }` (no shorthand), Prisma `select`/`where` inline at each query.

## Review Focus

1. **The number already belongs to another live account:** the seed stops with `SEED_ADMIN_PHONE is already used by another account`, and the admin's phone is unchanged (Task 1, Step 7).
2. **The number is typed with dashes in the env file** (`010-9900-0001`): it's stored as digits, so find-ID typed either way matches (Task 1, Step 1 env test; the seed uses the same `normalizePhone`).
3. **The seed runs again with the same number:** nothing is written (Task 1, Step 6: the second run logs "unchanged" and `updated_at` doesn't move).
4. **The migration is applied before the seed on an existing database:** it would fail with `column "phone" … contains null values` and change nothing. Task 2, Step 3 checks the count first, and STATUS.md gets the order (Task 2, Step 9).
5. **A soft-deleted account holding the number** doesn't block the admin, since `UQ_accounts_phone` counts live accounts only: the seed's conflict check filters `deletedAt: null` (Task 1, Step 3).

---

### Task 1: `SEED_ADMIN_PHONE` — the admin gets its phone

**Files:**
- Modify: `src/config/env.schema.ts:75-77` (the seed block), `prisma/seed.ts:249-290` (step 4), `.env.example:28-29`, `.env.test` (Claude adds the line)
- Test: `src/config/env.schema.spec.ts`, `test/account-recovery.e2e-spec.ts`

**Interfaces:**
- Produces: `Env['SEED_ADMIN_PHONE']: string` (digits only); on every seeded database, the admin's `accounts.phone` equals it.

- [ ] **Step 1 (Claude): Write the tests.**
  - **`env.schema.spec.ts`**: `baseEnv` gains `SEED_ADMIN_PHONE: '01099000001'`.
    ```ts
    it('SEED_ADMIN_PHONE is stored as digits: dashes and spaces are stripped', () => {
      expect(validateEnv({ ...baseEnv, SEED_ADMIN_PHONE: '010-9900 0001' }).SEED_ADMIN_PHONE).toBe('01099000001');
    });
    it('a missing SEED_ADMIN_PHONE is refused', () => {
      const { SEED_ADMIN_PHONE: _omitted, ...withoutPhone } = baseEnv;
      expect(() => validateEnv(withoutPhone)).toThrow(/SEED_ADMIN_PHONE/);
    });
    it.each(['02-123-4567', '0109900000', '011-9900-0001'])('%s is not a Korean mobile → refused', (phone) => {
      expect(() => validateEnv({ ...baseEnv, SEED_ADMIN_PHONE: phone })).toThrow(/SEED_ADMIN_PHONE/);
    });
    ```
  - **`account-recovery.e2e-spec.ts`**, a new `describe('the platform admin')`:
    - `'finds its ID by its phone'`: `verifiedPhoneToken(app, process.env.SEED_ADMIN_PHONE!, 'FIND_ID')`, then `findId(…)` → 200 `{ email: maskEmail(process.env.SEED_ADMIN_EMAIL!.trim().toLowerCase()), providers: [] }` (`maskEmail` from `../src/auth/mask-email`);
    - `"its number can't start a signup"`: `POST /auth/phone/start { phone: SEED_ADMIN_PHONE, purpose: 'SIGNUP' }` → 409 `Phone already registered`.
- [ ] **Step 2:** Run `npx jest src/config`. Expected: FAIL (no `SEED_ADMIN_PHONE` in the schema).
- [ ] **Step 3: Code.**
  - `env.schema.ts`: `SEED_ADMIN_PHONE` after `SEED_ADMIN_PASSWORD`. A string with `[-\s]` stripped, then matching `KOREAN_MOBILE_PATTERN`. Required.
  - `seed.ts` step 4, reading `process.env.SEED_ADMIN_PHONE` through `normalizePhone`:
    - not a string matching `KOREAN_MOBILE_PATTERN` → `throw new Error('SEED_ADMIN_PHONE must be a Korean mobile number (010 + 8 digits)')`, next to the existing email/password check;
    - the conflict check, before any write: `prisma.account.findFirst({ where: { phone: phone, deletedAt: null, id: { not: <the admin's account id> } }, select: { id: true } })` (for a new admin, no `id` condition) → found → `throw new Error('SEED_ADMIN_PHONE is already used by another account')`;
    - a new admin: `account.create({ data: { phone: phone, … } })` instead of `phone: null`; the comment says the admin's phone comes from the env;
    - an existing admin (found by its login email, as today): read its account's `phone`; if it differs, `account.update({ where: { id }, data: { phone: phone } })` and log that the phone was set, else log that it's unchanged. **Compare in code:** a `{ phone: { not: phone } }` filter would skip a null phone (in SQL, `NULL <> '010…'` isn't true).
  - `.env.example`: `SEED_ADMIN_PHONE=01000000000`, with the comment `# the admin's own mobile: find-ID and password reset use it`.
  - `.env.test` (Claude): append `SEED_ADMIN_PHONE=01099000001`.
- [ ] **Step 4 (human):** add `SEED_ADMIN_PHONE=<your mobile>` to `.env`.
- [ ] **Step 5:** Run `npm test`, `npm run build`, and lint on the changed files. Expected: PASS.
- [ ] **Step 6 (Claude):** Run `npm run seed` twice. Then read-only psql: `SELECT count(*) FROM accounts WHERE phone IS NULL` → 0. The second run logs the phone as unchanged, and the admin account's `updated_at` is the same after both runs (Review Focus 3).
- [ ] **Step 7 (Claude, Review Focus 1):** Run the seed once with `SEED_ADMIN_PHONE` set to a live non-admin account's phone, read by psql into a shell variable and never printed. Expected: exit 1 with `SEED_ADMIN_PHONE is already used by another account`; the admin's phone is unchanged (compare with a `md5(phone)` read before and after).
- [ ] **Step 8 (human):** `npm run test:e2e 2>&1 | tee e2e.log`. Expected: all green (Claude reads `e2e.log`). The pretest re-seeds with `.env.test`'s number.
- [ ] **Step 9:** Commit and push: `feat(seed): the platform admin gets a phone (SEED_ADMIN_PHONE)`.

### Task 2: Every account has a phone (`accounts.phone` NOT NULL); docs

**Files:**
- Modify: `prisma/schema.prisma:71`; a new migration `prisma/migrations/<timestamp>_accounts_phone_required/migration.sql`; `src/accounts/accounts.service.ts:26-36`; `src/profiles/profile-view.ts:14,35`; `src/account-deletion/account-deletion.service.ts:40,63-68`
- Test: `src/accounts/accounts.service.spec.ts:62-68`, `src/account-deletion/account-deletion.service.spec.ts:48,208,237-245`, `test/leaving.e2e-spec.ts:895`
- Docs: `docs/superpowers/STATUS.md`, `CLAUDE.md`, the spec (status and "As built"), this plan (✅)

**Interfaces:**
- Consumes: Task 1's seeded admin phone (no account without one).
- Produces: `Account.phone: string` in the generated client; `AccountsService.createAccount(transaction: Prisma.TransactionClient, phone: string): Promise<string | null>`; `ProfileRow.account.phone: string`; `ProfileView.phone: string`.

- [ ] **Step 1 (Claude):** `schema.prisma`: `phone String @db.VarChar(20) // every account has one, the platform admin included`. `UQ_accounts_phone` is untouched.
- [ ] **Step 2 (human):** `npx prisma migrate dev --create-only --name accounts_phone_required`.
- [ ] **Step 3 (Claude, before it's applied):** the SQL must be exactly `ALTER TABLE "accounts" ALTER COLUMN "phone" SET NOT NULL;`, with no DROP or CREATE of `UQ_accounts_phone` (that would be partial-index drift; fix the schema's `where: raw(…)` instead). Read-only psql: `SELECT count(*) FROM accounts WHERE phone IS NULL` → 0 (Review Focus 4). Show both to the user.
- [ ] **Step 4 (human):** `npx prisma migrate dev` to apply it.
- [ ] **Step 5 (Claude):** read-only psql: `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'phone'` → `NO`.
- [ ] **Step 6 (Claude): the tests.**
  - `accounts.service.spec.ts`: remove `'an account with no phone (the seeded admin) is allowed'`.
  - `account-deletion.service.spec.ts`: `lockedRows: { phone: string }[]`; remove `'an account without a phone (only the seeded admin has none) → 403, nothing spent'`; rename `'the platform admin → 403 before anything: it runs the platform, and has no phone to prove'` to `'the platform admin → 403 before anything: it runs the platform'`.
  - `leaving.e2e-spec.ts:895`: the same rename (`'the platform admin → 403: it runs the platform'`).
- [ ] **Step 7 (Claude): the code.**
  - `createAccount(transaction, phone: string)`.
  - `ProfileRow.account.phone: string` and `ProfileView.phone: string`.
  - `account-deletion.service.ts`: remove the `locked.phone === null` branch. The comment at line 40 becomes `// The platform admin runs the platform: it never deletes itself.`
  - `seed.ts`: no `phone: null` remains (Task 1 did it). `grep -rn "phone: null" src prisma/seed.ts --include='*.ts' --exclude-dir=generated` → nothing.
- [ ] **Step 8:** Run `npx prisma generate`, `npm test`, `npm run build`, and lint on the changed files. Expected: PASS. Then the human runs the e2e (`npm run test:e2e 2>&1 | tee e2e.log`), expected all green.
- [ ] **Step 9 (Claude): the docs, with measured counts only.**
  - STATUS.md: a section for this change (the env variable, the migration, the order on an existing database: `SEED_ADMIN_PHONE` in `.env` → `npm run seed` → `SELECT count(*) FROM accounts WHERE phone IS NULL` is 0 → `npx prisma migrate deploy`). Under "Resume on a new machine": `SEED_ADMIN_PHONE` in both env files, that order, and the latest migration.
  - CLAUDE.md: the unit count.
  - The spec: status "built", plus an "As built" section.
  - This plan: ✅ on both tasks.
- [ ] **Step 10:** Commit and push: `feat(accounts)!: every account has a phone (accounts.phone NOT NULL); docs`.
