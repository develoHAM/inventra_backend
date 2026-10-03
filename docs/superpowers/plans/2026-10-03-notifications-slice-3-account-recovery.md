# Notifications Slice 3 — Account Recovery (Find ID + Password Reset) Implementation Plan

> **Workflow:** teaching-first, per-task. Claude teaches (snippets with full context) + gives full reference code; **the user writes production code**; **Claude writes + runs tests**. Auto-commit + push at green checkpoints. Verbose object literals. A human runs `npm run test:e2e`.

**Goal:** a user who signed up with email + password can recover their login ID and reset their password by proving they still control their phone through OCTOMO.

**Architecture:** a new `AccountRecoveryService` + `AccountRecoveryController` (`@Controller('auth')`) inside `AuthModule` (it already has `PasswordService`, Prisma and `PhoneVerificationService`). Both flows consume a Slice 2 verification token (`FIND_ID` / `RESET_PASSWORD`). Reset emits `account.passwordReset` after commit; the existing notifications listener emails the account through the queue.

**Spec:** `docs/superpowers/specs/2026-09-23-notifications-and-account-security-design.md` → "Account recovery — Slice 3".

## Global Constraints
- Masked email: first **2** characters of the local part (fewer if the local part is that short) + `***` + `@` + full domain.
- Reset requires **email + phone + `RESET_PASSWORD` token + newPassword** (8–128 chars, same as signup).
- Only the account's **local** login method (`method: 'local'`) is considered; deleted users never match.
- A "no match" outcome still **spends** the token: the transaction returns a marker (commit), the 404/400 is thrown after.
- Reset revokes **every** active refresh token of that user, in the same transaction as the password change.
- `account.passwordReset` is emitted **after** the transaction commits and emails the account (no actor exclusion).

## Review Focus
1. **A `SIGNUP` or `FIND_ID` token used for reset** (or vice versa) → 400 (purpose is part of `consume`'s `where`) — Task 2 + e2e.
2. **Right phone + token, but someone else's email** → 400, password unchanged, token spent — Task 2 + e2e.
3. **Old sessions after a reset** → refresh with an old refresh token → 401; login with the old password → 401, new password → 201 — e2e.
4. **Reset failure mid-transaction** (e.g. DB error on revoke) → rolled back: password unchanged, token unspent, no email — Task 2.
5. **Short local parts** (`a@x.com`, `ab@x.com`) don't crash the mask and still hide something where possible — Task 1.

---

### Task 1: `maskEmail` + find my ID
**Files:** Create `src/auth/mask-email.ts`, `src/auth/dto/find-id.dto.ts`, `src/auth/account-recovery.service.ts`, `src/auth/account-recovery.controller.ts` · Modify `src/auth/auth.module.ts` · Tests `mask-email.spec.ts`, `account-recovery.service.spec.ts` (findId), `account-recovery.controller.spec.ts`

**Produces:** `maskEmail(email: string): string`; `AccountRecoveryService.findId(phone, token): Promise<{ email: string }>`; `POST /auth/find-id` (public, 200).

### Task 2: password reset
**Files:** Create `src/auth/dto/reset-password.dto.ts` · Modify `account-recovery.service.ts`, `account-recovery.controller.ts`, `src/notifications/notification-events.ts` (event name + payload only) · Tests extend the service/controller specs

**Produces:** `AccountRecoveryService.resetPassword(dto): Promise<void>`; `POST /auth/reset-password` (public, 204); `NotificationEvent.ACCOUNT_PASSWORD_RESET = 'account.passwordReset'`, `AccountPasswordResetEvent { userId }`.

### Task 3: "password changed" email
**Files:** Modify `notification-templates.ts`, `notifications.listener.ts` · Tests extend `notifications.listener.spec.ts`

**Produces:** `notificationTemplates.passwordReset(): RenderedMessage`; listener `handleAccountPasswordReset`.

### Task 4: e2e
**Files:** Create `test/account-recovery.e2e-spec.ts` (phone suite 13) · Docs `STATUS.md`, `CLAUDE.md`

Find-ID returns the masked email / 404 for an unregistered phone / 400 for a `SIGNUP` token; reset changes the password (old 401, new 201), revokes refresh tokens (old refresh → 401), sends the email (Mailpit), rejects a mismatched email (400, password unchanged) and a reused token (400).
