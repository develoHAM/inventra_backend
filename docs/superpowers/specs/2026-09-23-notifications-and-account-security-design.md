# Notifications (Email · SMS · Push) + Account Security (Phone Verification · Find ID · Password Reset) — Design

**Date:** 2026-09-23
**Status:** approved in brainstorm; built in slices (1a → 1b → 2 → 3 → 4).

---

## Goal

A notifications subsystem that lets any business flow notify people by **email, SMS or push**, without the business code knowing how. On top of it, three account-security flows that use a single **SMS one-time-code (OTP)** mechanism: **phone verification at signup**, **find my ID**, and **password reset**.

## Decisions (from the brainstorm)

| Topic | Decision |
|---|---|
| Triggers | Account lifecycle, reservations, stock alerts, order/audit workflow |
| Channel routing | **Fixed per event, in code** (each event's handler declares its channels). User preferences may be added later on top |
| Dispatch | **Domain events + queue**: services emit events (`@nestjs/event-emitter`); a listener turns them into `Notification` rows + **BullMQ** jobs on the existing Redis; a worker sends with retries |
| Email transport | **SMTP via nodemailer**; **Mailpit** in docker-compose for dev/e2e; production = env change (SES, Resend, …) |
| SMS | Korean provider adapter (Solapi / NHN Cloud / SENS) behind an interface + a **fake adapter** for dev/e2e |
| Push | **FCM via `firebase-admin`** (covers Android + iOS through APNs); `DeviceToken` table |
| Template language | Korean now (EN later via the `label.{ko,en}` pattern used in export) |
| Phone at signup | **Required, verified by SMS, unique per user** |
| Password reset | **SMS code to the verified phone** |
| Find my ID | Verified phone → the account's **masked email** (`ow***@example.com`) |

## Architecture

```
business service ── emit('<event>') ──► NotificationsListener (@OnEvent)
  (after commit)                          │ resolve recipients, render template
                                          │ NotificationsService.dispatch():
                                          │   create Notification (PENDING) + queue.add
                                          ▼
                              BullMQ "notifications" (Redis, per-env prefix)
                                          ▼
                              NotificationsProcessor (WorkerHost)
                                 channel sender .send() → SENT, or retry → FAILED
                                          ▼
                   EmailChannel (nodemailer) · SmsChannel · PushChannel (FCM)
```

- **Business code never imports notifications.** It emits a named event with a small payload (`NotificationEvent.COMPANY_APPROVED`, `{ companyId, ownerUserId }`).
- **Listener errors never break the request.** Emission is fire-and-forget; the listener is async and its errors are logged, not propagated.
- **Emit after commit.** An event raised inside a `$transaction` that later rolls back would announce something that never happened. Work done inside a transaction collects its events and emits them only after `$transaction` resolves (needed for stock alerts, which are detected inside `recordWithinTransaction`).
- **Stock alerts fire on the crossing only**: `availableQuantity` goes from `>= targetStockQuantity` to `< targetStockQuantity`, so the alert is sent once, not on every later sale.
- **Retries:** 3 attempts with exponential backoff. A notification is `FAILED` only after the last attempt.
- **Per-environment queue prefix** (`BULLMQ_PREFIX`: `inventra` / `inventra-test`) because dev and e2e share one Redis, like the separate MinIO test bucket.

### `Notification` table (log + audit trail)
`id, eventType, channel (EMAIL|SMS|PUSH), recipientUserId?, recipientAddress (email/phone/device token), subject?, body, status (PENDING|SENT|FAILED), attempts, lastError?, sentAt?, createdAt, updatedAt`. OTP message bodies are **redacted** in this table (the code itself is never stored in plain text anywhere).

### Recipients
- Users: email from `UserLoginMethod` (`method: 'local'`), phone from `User.phone`, push from `DeviceToken`.
- Reservation customers are **not users** (`reservedByName` / `reservedByPhone`) → **SMS only**.
- Platform admins: users with role `ADMIN`.

## Event catalogue

| Event | Channels | Recipients | Slice |
|---|---|---|---|
| `company.approved` | email | company owner | 1a |
| `company.registered` | email | platform admins | 1b |
| `member.joinRequested` | email | company owner | 1b |
| `member.approved` | email | the member | 1b |
| `order.created` | email (+push, 4) | corner manager + company owner | 1b |
| `audit.applied` | email (+push, 4) | corner manager + company owner | 1b |
| `stock.belowTarget` | email (+push, 4) | corner manager + company owner | 1b |
| `reservation.created` | SMS | the customer's phone | 3 |
| `reservation.expired` | SMS | the customer's phone | 3 |

## Phone verification (OTP) — Slice 2

`PhoneVerification`: `id, phone, purpose (SIGNUP|FIND_ID|RESET_PASSWORD), codeHash, expiresAt (+3 min), attempts (max 5), verifiedAt?, consumedAt?, tokenHash?, tokenExpiresAt?, createdAt`.

| Step | Endpoint | Behavior |
|---|---|---|
| Request | `POST /auth/phone/send-code { phone, purpose }` | 6-digit code, only its hash stored, sent by SMS (high-priority queue job). 60 s resend cooldown + daily cap per phone. For `FIND_ID`/`RESET_PASSWORD` the response is identical whether or not the phone is registered (no account enumeration) |
| Verify | `POST /auth/phone/verify { phone, purpose, code }` | Checks hash, expiry, attempts → returns a **single-use `verificationToken`** (10 min) |
| Consume | signup / find-id / reset | Each flow consumes the token; purpose and phone must match |

- **Signup:** `RegisterDto` and `RegisterMemberDto` gain `phone` + `phoneVerificationToken`. `User.phone` gets a **unique** index (Postgres allows many NULLs, so existing phone-less users are fine; "required" is enforced by the DTOs). Duplicate phone → 409.
- OTP SMS is sent by a direct high-priority `dispatch`, not a domain event.

## Account recovery — Slice 3
- `POST /auth/find-id { phoneVerificationToken }` → `{ email: 'ow***@example.com' }`.
- `POST /auth/reset-password { email, phoneVerificationToken, newPassword }` → the email's user must own that phone; hash the new password; **revoke all refresh tokens**.

## Push — Slice 4
`DeviceToken`: `id, userId, token (unique), platform (ANDROID|IOS), lastSeenAt, createdAt`. `POST /devices` / `DELETE /devices/:token` (self-service). `PushChannel` on `firebase-admin`; tokens FCM reports as unregistered are deleted.

## Slices

| Slice | Delivers |
|---|---|
| **1a** | Packages + Jest ESM regex, env (`REDIS_HOST`, `BULLMQ_PREFIX`, `SMTP_*`), Mailpit, `Notification` table, `EmailChannel`, `NotificationsService`/Listener/Processor, and `company.approved` end-to-end |
| **1b** | Remaining email events (table above) + after-commit event collection for stock alerts |
| **2** | `SmsChannel` (provider + fake), `PhoneVerification`, send-code/verify, signup requires a verified phone |
| **3** | Find my ID, password reset, reservation SMS |
| **4** | `DeviceToken`, device endpoints, FCM `PushChannel`, push on stock and order/audit events |

## Package / tooling notes
- `@nestjs/event-emitter` 12, `@nestjs/bullmq` 12 and `nodemailer` 10 are **ESM-only**. Runtime is fine (Node 26 supports `require()` of ESM, as `@nestjs/schedule` already proves). **Unit Jest** (CommonJS) must transform them: widen `transformIgnorePatterns` to `node_modules/(?!(@nestjs/schedule|@nestjs/event-emitter|@nestjs/bullmq|nodemailer)/)`. **e2e Jest** (native ESM under `--experimental-vm-modules`) needs no change.
- e2e now needs **Redis and Mailpit** running, in addition to Postgres and MinIO.

## Testing
- Unit: `EmailChannel` (nodemailer transport mocked), `NotificationsService.dispatch` (row + `queue.add` with retry options), processor (sends → SENT; throws → attempts++, FAILED only on the last attempt), listener (resolves recipient + template → dispatch), emit points (`EventEmitter2.emit` called after the write).
- e2e: trigger the real flow → poll until the `Notification` row is `SENT` → confirm the message in **Mailpit's API**.

## Non-goals (for now)
User notification preferences / opt-out UI; marketing campaigns; Kakao 알림톡 (the SMS adapter can add it later); in-app notification inbox.
