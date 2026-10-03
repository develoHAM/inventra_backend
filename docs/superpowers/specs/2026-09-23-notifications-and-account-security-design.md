# Notifications (Email · SMS · Push) + Account Security (Phone Verification · Find ID · Password Reset) — Design

**Date:** 2026-09-23
**Status:** approved in brainstorm; built in slices (1a → 1b → 2 → 3 → 4).

---

## Goal

A notifications subsystem that lets any business flow notify people by **email, SMS or push**, without the business code knowing how. On top of it, three account-security flows that use a single **reverse-SMS (MO) phone verification** mechanism (OCTOMO — the user texts a code to the provider; we never send one): **phone verification at signup**, **find my ID**, and **password reset**.

## Decisions (from the brainstorm)

| Topic | Decision |
|---|---|
| Triggers | Account lifecycle, reservations, stock alerts, order/audit workflow |
| Channel routing | **Fixed per event, in code** (each event's handler declares its channels). User preferences may be added later on top |
| Dispatch | **Domain events + queue**: services emit events (`@nestjs/event-emitter`); a listener turns them into `Notification` rows + **BullMQ** jobs on the existing Redis; a worker sends with retries |
| Email transport | **SMTP via nodemailer**; **Mailpit** in docker-compose for dev/e2e; production = env change (SES, Resend, …) |
| Phone verification | **OCTOMO reverse (MO) SMS** (decision 2026-09-28): we show a code, the user texts it from their phone to 1666-3538, we ask OCTOMO's API whether it arrived. Behind a `PhoneOwnershipVerifier` interface + a **fake** for e2e |
| Outbound SMS | Only reservation messages to customers need an outbound provider (Solapi / NHN Cloud / SENS) — **deferred** (decision 2026-10-03); when added, it goes through the queue like every sent notification |
| Push | **FCM via `firebase-admin`** (covers Android + iOS through APNs); `DeviceToken` table |
| Template language | Korean now (EN later via the `label.{ko,en}` pattern used in export) |
| Phone at signup | **Required, verified via OCTOMO, unique per user** |
| Password reset | **OCTOMO verification of the account's phone** |
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
`id, eventType, channel (EMAIL|SMS|PUSH), recipientUserId?, recipientAddress (email/phone/device token), subject?, body, status (PENDING|SENT|FAILED), attempts, lastError?, sentAt?, createdAt, updatedAt`.

### Recipients
- Users: email from `UserLoginMethod` (`method: 'local'`), phone from `User.phone`, push from `DeviceToken`.
- Reservation customers are **not users** (`reservedByName` / `reservedByPhone`) → **SMS only**.
- Platform admins: users with role `ADMIN`.

## Event catalogue

| Event | Channels | Recipients | Slice |
|---|---|---|---|
| `company.approved` | email (+push, 4) | company owner | 1a |
| `company.registered` | email (+push, 4) | platform admins | 1b |
| `member.joinRequested` | email (+push, 4) | company owner | 1b |
| `member.approved` | email (+push, 4) | the member | 1b |
| `order.created` | email (+push, 4) | corner manager + company owner (minus actor) | 1b |
| `audit.applied` | email (+push, 4) | corner manager + company owner (minus actor) | 1b |
| `stock.belowTarget` | email (+push, 4) | corner manager + company owner (nobody excluded) | 1b |
| `account.passwordReset` | email (+push, 4) | the account owner | 3 |
| `reservation.created` | SMS | the customer's phone | deferred |
| `reservation.expired` | SMS | the customer's phone | deferred |

**Channel decision (2026-09-27):** every event is **push + email** — email always (the durable record; reaches users without the app, pending users, and admins on the web console), plus push to each recipient's registered devices in Slice 4 (users with no device just get the email). Slice 4 therefore generalizes the listener's `emailUsers(...)` into a channel-aware `notifyUsers({ userIds, excludeUserId?, eventType, message })` driven by **one per-event channel table**, rather than editing each handler.

## Phone verification (OCTOMO reverse SMS) — Slice 2

**How it proves ownership:** the carrier authenticates the *sender* of an SMS. If a text containing our code arrives at OCTOMO **from** 01012345678, the person holding the code controls that phone. The code is therefore **not a secret** (it is shown on screen); it only binds "this text" to "this verification".

OCTOMO API: `POST https://api.octoverse.kr/octomo/v1/public/message/exists`, header `Authorization: Octomo <API_KEY>`, body `{ mobileNum: "010xxxxxxxx", text, withinMinutes (1–60, default 5) }` → `{ exists: boolean }`. Errors: 400 (bad body), 401 (key), 403 (app suspended), 404, 429 (100 calls / 10 s or monthly quota — free plan 10,000/month), 500. `mobileNum` must be `010` + 8 digits.

`PhoneVerification`: `id, phone, purpose (SIGNUP|FIND_ID|RESET_PASSWORD), code (plain, 6 digits), expiresAt (+5 min), checkAttempts (max 10), verifiedAt?, tokenHash?, tokenExpiresAt?, consumedAt?, createdAt`.

| Step | Endpoint | Behavior |
|---|---|---|
| Start | `POST /auth/phone/start { phone, purpose }` | Daily cap per phone (10). `SIGNUP` + phone already registered → 409. Creates the row → `{ verificationId, code, receiverNumber: '1666-3538', expiresInSeconds }` |
| Confirm | `POST /auth/phone/confirm { verificationId }` | Row must be live (not expired, not verified); claims one of 10 checks (each is a paid OCTOMO call); asks OCTOMO `exists(phone, code, minutes since start)`; `false` → 400 "not received yet" (client may retry); `true` → **single-use `verificationToken`** (10 min). Provider error → 503 |
| Consume | signup / find-id / reset | Each flow consumes the token inside its transaction; purpose and phone must match |

- **Signup:** `RegisterDto` and `RegisterMemberDto` gain the phone + its verification token. `User.phone` gets a **unique** index (Postgres allows many NULLs, so existing phone-less users are fine; "required" is enforced by the DTOs). Duplicate phone → 409.
- No outbound SMS, so no resend cooldown and no need to hide whether a phone is registered: nothing about a phone is revealed before its ownership is proven.
- `PHONE_VERIFIER=octomo|fake` (`OCTOMO_API_KEY` required for `octomo`); production refuses `fake`.
- Known limitation of MO verification: a victim can be tricked into texting a code ("text 482913 to claim a prize"). Accepted, as Korean banks do.

## Account recovery — Slice 3 (decisions 2026-10-03)
Both flows reuse the Slice 2 OCTOMO verification with purposes `FIND_ID` / `RESET_PASSWORD` — the user proves they still control the phone they gave at signup. **No outbound SMS provider** (reservation SMS deferred).
- `POST /auth/find-id { phone, phoneVerificationToken }` → `{ email: 'ow***@example.com' }` — first 2 characters of the local part + `***` + the full domain. No account on that phone → 404 (ownership is already proven, so this reveals nothing to a stranger).
- `POST /auth/reset-password { email, phone, phoneVerificationToken, newPassword }` → 204. **Email + verified phone** (two factors: a thief holding the phone only ever sees the masked email). The email's local login must belong to the user who owns that phone; otherwise 400 with one generic message. Hash the new password, **revoke all refresh tokens** (every device logged out; access tokens expire on their own within 15 min), and email the account **"your password was changed"** (`account.passwordReset`, through the queue).
- Each flow consumes its token first; a "no match" outcome **returns from the transaction** (commit — the token stays spent) and the 404/400 is thrown after, the same pattern as join-code probing.

## Push — Slice 4
`DeviceToken`: `id, userId, token (unique), platform (ANDROID|IOS), lastSeenAt, createdAt`. `POST /devices` / `DELETE /devices/:token` (self-service). `PushChannel` on `firebase-admin`; tokens FCM reports as unregistered are deleted.

## Slices

| Slice | Delivers |
|---|---|
| **1a** | Packages + Jest ESM regex, env (`REDIS_HOST`, `BULLMQ_PREFIX`, `SMTP_*`), Mailpit, `Notification` table, `EmailChannel`, `NotificationsService`/Listener/Processor, and `company.approved` end-to-end |
| **1b** | Remaining email events (table above) + after-commit event collection for stock alerts |
| **2** | `PhoneVerification` + OCTOMO verifier (+ fake), start/confirm, signup requires a verified unique phone |
| **3** | Find my ID, password reset (+ "password changed" email) — both via OCTOMO. Reservation SMS (outbound provider) **deferred** |
| **4** | `DeviceToken`, device endpoints, FCM `PushChannel`, channel-aware `notifyUsers` + per-event channel table → push on **every** user event (email kept) |

## Package / tooling notes
- `@nestjs/event-emitter` 12, `@nestjs/bullmq` 12 and `nodemailer` 10 are **ESM-only**. Runtime is fine (Node 26 supports `require()` of ESM, as `@nestjs/schedule` already proves). **Unit Jest** (CommonJS) must transform them: widen `transformIgnorePatterns` to `node_modules/(?!(@nestjs/schedule|@nestjs/event-emitter|@nestjs/bullmq|nodemailer)/)`. **e2e Jest** (native ESM under `--experimental-vm-modules`) needs no change.
- e2e now needs **Redis and Mailpit** running, in addition to Postgres and MinIO.

## Testing
- Unit: `EmailChannel` (nodemailer transport mocked), `NotificationsService.dispatch` (row + `queue.add` with retry options), processor (sends → SENT; throws → attempts++, FAILED only on the last attempt), listener (resolves recipient + template → dispatch), emit points (`EventEmitter2.emit` called after the write).
- e2e: trigger the real flow → poll until the `Notification` row is `SENT` → confirm the message in **Mailpit's API**.

## Non-goals (for now)
User notification preferences / opt-out UI; marketing campaigns; Kakao 알림톡 (the SMS adapter can add it later); in-app notification inbox.
