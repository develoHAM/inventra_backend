# Notifications Slice 4 — Push (FCM) Implementation Plan

> **Workflow:** teaching-first, per-task. Claude teaches (snippets with full context) + gives full reference code; **the user writes production code**; **Claude writes + runs tests**. Auto-commit + push at green checkpoints. Verbose object literals. A human runs `prisma migrate` and `npm run test:e2e`.

**Goal:** every user-facing notification event reaches the user's registered devices (Android, iOS, web) as a push, alongside the email.

**Architecture:** devices register their FCM token (`DeviceToken`, self-service endpoints in a new `DevicesModule`); logout can remove one. A `PushSender` interface (FCM or fake, chosen by `PUSH_SENDER`) is the worker's sender for `channel: PUSH`. Push goes through the same queue as email: one `Notification` row per device. The listener's `emailUsers` becomes `notifyUsers`, which fans out over the channels in one `EVENT_CHANNELS` table.

**Spec:** `docs/superpowers/specs/2026-09-23-notifications-and-account-security-design.md` → "Push — Slice 4".

## Global Constraints
- Platforms: `ANDROID | IOS | WEB`.
- `POST /devices` upserts by token (reassigns `userId` if another user registers the same token) and refreshes `lastSeenAt`; `DELETE /devices/:token` deletes only the caller's own token; both 204; no `@RequirePermissions`.
- Logout: optional `deviceToken` → delete that token **only if it belongs to the caller**.
- `PUSH_SENDER=fcm|fake` (no default); `fcm` requires `FIREBASE_SERVICE_ACCOUNT_PATH`; production refuses `fake`.
- A dead token (FCM `messaging/registration-token-not-registered` or `messaging/invalid-registration-token`) → `DeadDeviceTokenError` → the worker deletes the `DeviceToken`, marks the row `FAILED` (`lastError: 'device token unregistered'`), and does not retry.
- Push message: `title` = the template subject, `body` = the template body.
- Every current event in `EVENT_CHANNELS` is `[EMAIL, PUSH]`; a user with no device simply gets no push rows.

## Review Focus
1. **A token re-registered by a different user** (shared device, new login) → moves to the new user; the old user no longer receives on it — Task 1.
2. **Deleting someone else's token** via `DELETE /devices/:token` or logout → no effect (scoped by `userId`) — Tasks 1 and 4.
3. **A dead token retried 3×** would waste FCM calls and spam logs → no retry, token deleted — Task 2.
4. **A user with 3 devices** → 3 push rows + 1 email row for one event; dedupe still applies across user ids — Task 3.
5. **`npm test` without Firebase credentials** → the FCM sender is only built when `PUSH_SENDER=fcm`, and its spec mocks `firebase-admin` — Task 2.

---

### Task 1: `DeviceToken` + device endpoints
**Files:** Modify `prisma/schema.prisma` · Create `src/devices/devices.service.ts`, `devices.controller.ts`, `devices.module.ts`, `dto/register-device.dto.ts` · Modify `src/app.module.ts` · Tests `devices.service.spec.ts`, `devices.controller.spec.ts`, `dto/register-device.dto.spec.ts`
**Produces:** `DevicePlatform` enum, `DeviceToken` model; `DevicesService.register(caller, { token, platform })`, `unregister(userId, token)`, `findTokens(userIds): Promise<{ userId, token }[]>`; routes `POST /devices`, `DELETE /devices/:token`.

### Task 2: `PushSender` (FCM + fake) and dead-token cleanup
**Files:** `npm install firebase-admin` · Create `src/notifications/channels/push-sender.ts` (interface + `DeadDeviceTokenError`), `fcm-push.sender.ts`, `fake-push.sender.ts` · Modify `notifications.constants.ts` (`PUSH_SENDER`), `notifications.module.ts`, `notifications.processor.ts`, `src/config/env.schema.ts`, env files · Tests for both senders, processor, env
**Produces:** `PUSH_SENDER` token; worker sends `PUSH` rows; dead token → device deleted + row FAILED, no retry.

### Task 3: `notifyUsers` + `EVENT_CHANNELS`
**Files:** Create `src/notifications/event-channels.ts` · Modify `notifications.service.ts` (`emailUsers` → `notifyUsers`), `notifications.listener.ts` (8 call sites), `notifications.module.ts` (imports `DevicesModule`) · Tests service + listener specs
**Produces:** `EVENT_CHANNELS: Record<NotificationEventName, NotificationChannel[]>`; `notifyUsers({ userIds, excludeUserId?, eventType, message })`.

### Task 4: logout removes the device
**Files:** Modify `src/auth/dto/logout.dto.ts` (new: `refreshToken` + optional `deviceToken`), `auth.controller.ts`, `auth.service.ts`, `auth.module.ts` (imports `DevicesModule`) · Tests `auth.service.spec.ts`

### Task 5: e2e
**Files:** Create `test/push.e2e-spec.ts` (phone suite 14); `.env.test` gets `PUSH_SENDER=fake` · Docs STATUS/CLAUDE
Register a device → company approval → a SENT push row whose `recipientAddress` is the token, and the fake outbox has the title/body; a second user registering the same token takes it over; `DELETE` someone else's token → 204 but no effect; logout with `deviceToken` removes it; a dead token → row FAILED + device deleted; a user with no devices still gets the email.
