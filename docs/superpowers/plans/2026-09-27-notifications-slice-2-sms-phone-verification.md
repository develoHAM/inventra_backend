# Notifications Slice 2 — SMS Channel + Phone Verification at Signup Implementation Plan

> **Workflow:** teaching-first, per-task. Claude teaches + gives full reference code; **the user writes production code**; **Claude writes + runs tests**. Auto-commit + push at green checkpoints. Verbose object literals (`{ id: id }`). A human runs `prisma migrate` and `npm run test:e2e`.

**Goal:** an SMS channel (fake adapter for dev/e2e, real Korean provider behind the same interface) and a one-time-code phone-verification flow; both signup endpoints require a verified, unique phone.

**Architecture:** a new `PhoneVerificationModule` owns the OTP lifecycle (`send-code` → `verify` → single-use `verificationToken` → consumed inside the signup transaction). SMS goes through a `NotificationSender` bound to an `SMS_SENDER` injection token; a `ChannelRegistry` maps `NotificationChannel` → sender for the queue worker. **Every channel goes through the same queue** (uniform dev experience): OTP codes use `dispatch` too, with a **redacted** row body while the real text travels only inside the job.

**Tech Stack:** NestJS 11 · Prisma 7 · class-validator/class-transformer · `node:crypto` (`randomInt`, `createHmac`, `timingSafeEqual`, `randomBytes`) · BullMQ (existing) · Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-notifications-and-account-security-design.md` (section "Phone verification (OTP) — Slice 2"). **Builds on:** Slices 1a/1b.

## Global Constraints
- Code: **6 digits**, expires **+3 min**, **max 5** verify attempts; only its hash is stored.
- Resend cooldown **60 s** per phone+purpose; daily cap per phone (**10** sends / 24 h, all purposes).
- `verificationToken`: single-use, **10 min**; purpose **and** phone must match at consumption.
- `FIND_ID` / `RESET_PASSWORD`: `send-code` response is **identical** whether or not the phone is registered (no account enumeration).
- `User.phone`: **unique** index (Postgres allows many NULLs; "required" is enforced by the DTOs). Duplicate phone → **409**.
- OTP SMS is a direct `dispatch` (not a domain event) **through the same BullMQ queue** as every other notification; the `Notification` row body is **redacted** — the code is never stored in plain text in Postgres.
- Phones are Korean mobiles, stored **digits only** (`01012345678`); input may contain `-` or spaces.

## Decisions made while planning (flag in review if you disagree)
1. **OTP SMS goes through the queue like everything else (user decision, 2026-09-27: uniform dev experience for push, email and SMS).** The worker normally sends `notification.body` from the DB row, which for an OTP must be redacted, so a *redacted dispatch* works like this:
   - `dispatch(input)` with `input.redactedBody` set → the row stores `redactedBody` + `redacted: true`; the **real body rides in the job data** (`{ notificationId, body }`); the processor prefers `job.data.body` over the row's body.
   - The code sits in Redis only while the job lives: **`removeOnComplete: true` and `removeOnFail: true`** for redacted jobs, and it expires in 3 minutes anyway.
   - **Short retries:** `attempts: 3`, `backoff: fixed 2 s` — a code is useless if it arrives minutes late.
   - **Front of the line:** BullMQ runs jobs **without** a `priority` before any prioritized job (lower number = higher priority among prioritized ones). So regular notifications get `priority: 10` and OTP jobs get none.
   - **Never replayed:** the reconciler can't resend a redacted row (the real text is gone), so it re-enqueues only `redacted: false` rows and marks stale redacted `PENDING` rows `FAILED` (`lastError: 'expired before delivery'`).
   - `send-code` returns once the job is enqueued; a provider failure is async (the user resends after the 60 s cooldown). Only a failed enqueue (Redis down) surfaces as **503**.
2. **Code hash = HMAC-SHA256 with a server secret (`OTP_SECRET`)**, not plain SHA-256: a 6-digit code has only 1,000,000 values, so a leaked plain hash is reversed instantly; an HMAC needs the secret too. The verification *token* is 32 random bytes, so plain SHA-256 is enough (same as refresh tokens).
3. **Phone format:** Korean mobile only (`^01[016789]\d{7,8}$` after stripping `-`/spaces). No `libphonenumber-js` dependency (YAGNI; the product is Korea-only).
4. **Token is consumed inside the signup transaction**, so a signup that fails afterwards (e.g. duplicate email race) rolls the consumption back and the user can retry without a new SMS.
5. **Send order:** cooldown → daily cap → eligibility → send SMS → create the row. For an ineligible `FIND_ID`/`RESET_PASSWORD` phone the row is still created (so cooldown/cap behave identically) but no SMS is sent.
6. **Real provider = Solapi** (Task 7), selected by `SMS_PROVIDER=fake|solapi`; production refuses `fake` (it logs codes). Task 7 is last and can be deferred without blocking anything.

## Review Focus
1. **Two concurrent wrong guesses at attempt 4** must not grant a 6th guess → the attempt increment is a conditional `updateMany({ attempts: { lt: 5 } })` (Task 4 test "stops at 5 attempts even if increments race").
2. **Reusing a verification token** (double-submit of the signup form) → second use fails with 400, first signup unaffected (Task 4 "consume is single-use" + Task 6 e2e).
3. **Token verified for phone A used to register phone B**, or a `FIND_ID` token used for `SIGNUP` → 400 (Task 4 tests).
4. **`010-1234-5678` vs `01012345678`** must be the same phone for cooldown, verify, uniqueness (Task 1 normalization tests + Task 6 e2e sends dashed, registers undashed).
5. **A redacted OTP row stuck in `PENDING`** (worker down) must never be replayed as "인증번호 [******]" by the reconciler → it is marked `FAILED` instead (Task 2 reconciler test). Related: **Redis down at send-code** → 503 with no orphaned verification row blocking the resend for 60 s (Task 3 "enqueue failure creates no row").

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `PhoneVerification` model, `PhoneVerificationPurpose` enum, `User.phone @unique` |
| `src/config/env.schema.ts` (modify) | `OTP_SECRET` (Task 1), `SMS_PROVIDER`, `SOLAPI_*` (Task 7) |
| `src/phone-verification/phone.ts` | `KOREAN_MOBILE_PATTERN`, `normalizePhone()` |
| `src/phone-verification/phone-verification.constants.ts` | TTLs, limits |
| `src/notifications/channels/fake-sms.channel.ts` | dev/e2e SMS sender: logs + in-memory outbox |
| `src/notifications/channels/channel-registry.ts` | `NotificationChannel` → `NotificationSender` |
| `src/notifications/notifications.constants.ts` (modify) | `SMS_SENDER` token |
| `src/notifications/notifications.service.ts` (modify) | `dispatch` supports `redactedBody` |
| `src/notifications/notifications.processor.ts` (modify) | use `ChannelRegistry`; prefer `job.data.body` |
| `src/notifications/notifications.reconciler.ts` (modify) | skip + fail stale redacted rows |
| `src/notifications/notification-templates.ts` (modify) | `phoneVerificationCode(code)` |
| `src/phone-verification/phone-verification.service.ts` | `sendCode`, `verify`, `consume` |
| `src/phone-verification/phone-verification.controller.ts` | `POST /auth/phone/send-code`, `POST /auth/phone/verify` |
| `src/phone-verification/dto/*.ts` | `SendCodeDto`, `VerifyCodeDto` |
| `src/phone-verification/phone-verification.module.ts` | wiring |
| `src/auth/dto/register*.dto.ts`, `src/auth/auth.service.ts`, `auth.module.ts` (modify) | signup requires a verified unique phone |
| `src/notifications/channels/solapi-sms.channel.ts` | real provider (Task 7) |
| `test/helpers/phone.ts` + every `test/*.e2e-spec.ts` that registers users | shared "get a verified phone" helper |
| `test/phone-verification.e2e-spec.ts` | the OTP flow end to end |

---

### Task 1: Schema, migration, env, phone normalization

**Files:** Modify `prisma/schema.prisma`, `src/config/env.schema.ts`, `.env.example`, `.env`, `.env.test` · Create `src/phone-verification/phone.ts`, `src/phone-verification/phone-verification.constants.ts` · Test `src/phone-verification/phone.spec.ts`

**Interfaces — Produces:** `PhoneVerification` Prisma model + `PhoneVerificationPurpose` enum (`SIGNUP | FIND_ID | RESET_PASSWORD`); `normalizePhone(value: unknown): unknown`; `KOREAN_MOBILE_PATTERN: RegExp`; constants `CODE_TTL_SECONDS=180`, `MAX_VERIFY_ATTEMPTS=5`, `RESEND_COOLDOWN_SECONDS=60`, `DAILY_SEND_LIMIT=10`, `TOKEN_TTL_SECONDS=600`; env `OTP_SECRET`.

- [ ] **Step 1 (Claude): write `phone.spec.ts`**
```ts
import { KOREAN_MOBILE_PATTERN, normalizePhone } from './phone';

describe('normalizePhone', () => {
  it('strips dashes and spaces', () => {
    expect(normalizePhone('010-1234-5678')).toBe('01012345678');
    expect(normalizePhone(' 010 1234 5678 ')).toBe('01012345678');
  });
  it('passes non-strings through untouched (the validator rejects them)', () => {
    expect(normalizePhone(12345)).toBe(12345);
    expect(normalizePhone(undefined)).toBeUndefined();
  });
});

describe('KOREAN_MOBILE_PATTERN', () => {
  it.each(['01012345678', '0111234567', '01912345678'])('accepts %s', (phone) => {
    expect(KOREAN_MOBILE_PATTERN.test(phone)).toBe(true);
  });
  it.each(['0212345678', '010-1234-5678', '0101234567890', '+821012345678', ''])(
    'rejects %s',
    (phone) => {
      expect(KOREAN_MOBILE_PATTERN.test(phone)).toBe(false);
    },
  );
});
```
- [ ] **Step 2:** `npx jest src/phone-verification/phone.spec.ts` → FAIL (module not found).
- [ ] **Step 3 (user): `src/phone-verification/phone.ts`**
```ts
/** Korean mobile, digits only: 010/011/016/017/018/019 + 7 or 8 digits. */
export const KOREAN_MOBILE_PATTERN = /^01[016789]\d{7,8}$/;

/** class-transformer hook: "010-1234-5678" → "01012345678". Non-strings pass through for the validator to reject. */
export function normalizePhone(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/[-\s]/g, '') : value;
}
```
**`src/phone-verification/phone-verification.constants.ts`**
```ts
export const CODE_TTL_SECONDS = 180;
export const MAX_VERIFY_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const DAILY_SEND_LIMIT = 10;
export const TOKEN_TTL_SECONDS = 600;
```
**`prisma/schema.prisma`** — `User.phone` becomes unique, add a back-relation-free model + enum:
```prisma
  phone           String?    @unique(map: "UQ_users_phone") @db.VarChar(20)
```
```prisma
enum PhoneVerificationPurpose {
  SIGNUP
  FIND_ID
  RESET_PASSWORD

  @@map("phone_verification_purpose")
}

model PhoneVerification {
  id             String                   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  phone          String                   @db.VarChar(20)
  purpose        PhoneVerificationPurpose
  codeHash       String                   @map("code_hash") @db.VarChar(64)
  expiresAt      DateTime                 @map("expires_at") @db.Timestamptz(6)
  attempts       Int                      @default(0)
  verifiedAt     DateTime?                @map("verified_at") @db.Timestamptz(6)
  tokenHash      String?                  @unique(map: "UQ_phone_verifications_token_hash") @map("token_hash") @db.VarChar(64)
  tokenExpiresAt DateTime?                @map("token_expires_at") @db.Timestamptz(6)
  consumedAt     DateTime?                @map("consumed_at") @db.Timestamptz(6)
  createdAt      DateTime                 @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([phone, createdAt], map: "IDX_phone_verifications_phone_created")
  @@map("phone_verifications")
}
```
`Notification` gains a flag (same migration):
```prisma
  redacted         Boolean             @default(false) // body is a placeholder; the real text only ever lived in the job
```
**`env.schema.ts`** (after the SMTP block):
```ts
  // -- Phone verification (OTP) --
  OTP_SECRET: z.string().min(32),
```
Add `OTP_SECRET=<openssl rand -hex 32>` to `.env`, `.env.test` (different values) and a placeholder to `.env.example`.
- [ ] **Step 4 (human):** `npx prisma migrate dev --name phone_verification` (regenerates the client). Fails only if two existing users share a non-null phone.
- [ ] **Step 5:** `npm test` → all green (phone spec + existing 292); `node_modules/.bin/tsc --noEmit -p tsconfig.json` → 0.
- [ ] **Step 6:** commit + push `feat(phone-verification): schema, OTP_SECRET env, phone normalization`.

---

### Task 2: SMS channel, `ChannelRegistry`, redacted dispatch through the queue, OTP template

**Files:** Create `src/notifications/channels/fake-sms.channel.ts`, `src/notifications/channels/channel-registry.ts` · Modify `notifications.constants.ts`, `notifications.module.ts`, `notifications.processor.ts`, `notifications.service.ts`, `notifications.reconciler.ts`, `notification-templates.ts` · Tests `fake-sms.channel.spec.ts`, `channel-registry.spec.ts`, update `notifications.processor.spec.ts`, `notifications.service.spec.ts`, `notifications.reconciler.spec.ts`

**Interfaces — Consumes:** `NotificationSender`, `OutgoingMessage`, `EmailChannel`, `DispatchInput`, `Notification.redacted` (Task 1). **Produces:**
- `SMS_SENDER` (string token), `SEND_JOB_OPTIONS` now includes `priority: 10`, new `REDACTED_SEND_JOB_OPTIONS`.
- `SendNotificationJobData = { notificationId: string; body?: string }`.
- `FakeSmsChannel { send(m); sent: OutgoingMessage[]; lastMessageTo(to: string): OutgoingMessage | undefined }`.
- `ChannelRegistry.senderFor(channel: NotificationChannel): NotificationSender`.
- `DispatchInput.redactedBody?: string` — when set, `dispatch` stores it (+ `redacted: true`) and puts the real `body` in the job.
- `notificationTemplates.phoneVerificationCode(code: string): RenderedMessage` (no subject); `RenderedMessage.subject` becomes optional.
- `NotificationsModule` exports `NotificationsService` + `FakeSmsChannel`.

- [ ] **Step 1 (Claude): tests**
  - `fake-sms.channel.spec.ts`: `send` appends to `sent`; `lastMessageTo` returns the newest message for that number, `undefined` for an unknown one; it logs via `Logger.prototype.log` (spied).
  - `channel-registry.spec.ts`: EMAIL → the email sender, SMS → the `SMS_SENDER`, PUSH → throws `No sender for channel PUSH`.
  - processor spec: construct with `{ senderFor: jest.fn(() => sender) }` instead of `EmailChannel`; "sends an SMS row through the SMS sender" (`senderFor` called with `NotificationChannel.SMS`); "**sends `job.data.body` when present** instead of the row's redacted body"; row body is used when `job.data.body` is absent (existing behavior).
  - service spec `dispatch`: normal input → row `body: input.body`, `redacted: false`, job data `{ notificationId }` (no `body` key), options `{ ...SEND_JOB_OPTIONS, jobId }` with `priority: 10`. With `redactedBody` → row `body: redactedBody`, `redacted: true`; job data `{ notificationId, body: input.body }`; options `{ ...REDACTED_SEND_JOB_OPTIONS, jobId }` with **no `priority`**, `removeOnFail: true`.
  - reconciler spec: `findMany` now filters `redacted: false`; a second `updateMany({ where: { status: PENDING, redacted: true, createdAt: { lt: cutoff } }, data: { status: FAILED, lastError: 'expired before delivery' } })` runs every tick; neither path ever `queue.add`s a redacted row.
  - templates: `phoneVerificationCode('123456').body` contains `123456` and `3분`; `subject` undefined.
- [ ] **Step 2:** run them → FAIL.
- [ ] **Step 3 (user): implementation**

`notifications.constants.ts`:
```ts
export const NOTIFICATIONS_QUEUE = 'notifications';
export const SEND_NOTIFICATION_JOB = 'send';

/** Injection token for "whatever SMS provider this environment uses". */
export const SMS_SENDER = 'SMS_SENDER';

export interface SendNotificationJobData {
  notificationId: string;
  /** Present only for redacted notifications: the real text, which the DB row doesn't keep. */
  body?: string;
}

// BullMQ runs jobs WITHOUT a priority before any prioritized job, so regular
// notifications take priority 10 and leave the front of the line to OTP codes.
export const SEND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: true,
  priority: 10,
};

// A code is useless if it arrives minutes late, and its text must not linger
// in Redis after the job ends, whichever way it ends.
export const REDACTED_SEND_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'fixed', delay: 2000 },
  removeOnComplete: true,
  removeOnFail: true,
};
```
`channels/fake-sms.channel.ts`:
```ts
import { Injectable, Logger } from '@nestjs/common';
import { NotificationSender, OutgoingMessage } from './notification-channel';

/** Dev/e2e SMS: nothing leaves the machine. Keeps an outbox so e2e can read the code. */
@Injectable()
export class FakeSmsChannel implements NotificationSender {
  private readonly logger = new Logger(FakeSmsChannel.name);
  readonly sent: OutgoingMessage[] = [];

  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
    this.logger.log(`SMS to ${message.to}: ${message.body}`);
  }

  lastMessageTo(to: string): OutgoingMessage | undefined {
    return [...this.sent].reverse().find((message) => message.to === to);
  }
}
```
`channels/channel-registry.ts`:
```ts
import { Inject, Injectable } from '@nestjs/common';
import { NotificationChannel } from '../../generated/prisma/enums';
import { SMS_SENDER } from '../notifications.constants';
import { EmailChannel } from './email.channel';
import { NotificationSender } from './notification-channel';

@Injectable()
export class ChannelRegistry {
  constructor(
    private readonly email: EmailChannel,
    @Inject(SMS_SENDER) private readonly sms: NotificationSender,
  ) {}

  senderFor(channel: NotificationChannel): NotificationSender {
    switch (channel) {
      case NotificationChannel.EMAIL:
        return this.email;
      case NotificationChannel.SMS:
        return this.sms;
      default:
        throw new Error(`No sender for channel ${channel}`);
    }
  }
}
```
`notifications.module.ts` providers add `FakeSmsChannel`, `{ provide: SMS_SENDER, useExisting: FakeSmsChannel }`, `ChannelRegistry`; `exports: [NotificationsService, FakeSmsChannel]`.

`notifications.service.ts` — `DispatchInput` gains `redactedBody?: string;`, and `dispatch` becomes:
```ts
  async dispatch(input: DispatchInput): Promise<void> {
    const isRedacted = input.redactedBody !== undefined;
    const notification = await this.prisma.notification.create({
      data: {
        eventType: input.eventType,
        channel: input.channel,
        recipientUserId: input.recipientUserId ?? null,
        recipientAddress: input.recipientAddress,
        subject: input.subject ?? null,
        body: isRedacted ? input.redactedBody! : input.body,
        redacted: isRedacted,
      },
    });
    const jobData: SendNotificationJobData = isRedacted
      ? { notificationId: notification.id, body: input.body }
      : { notificationId: notification.id };
    await this.queue.add(SEND_NOTIFICATION_JOB, jobData, {
      ...(isRedacted ? REDACTED_SEND_JOB_OPTIONS : SEND_JOB_OPTIONS),
      jobId: notification.id,
    });
  }
```
`notifications.processor.ts`: constructor `(prisma, private readonly channels: ChannelRegistry)`; `process(job: Job<SendNotificationJobData>)`; send with
```ts
      await this.channels.senderFor(notification.channel).send({
        to: notification.recipientAddress,
        subject: notification.subject ?? undefined,
        body: job.data.body ?? notification.body, // redacted rows: the real text is only in the job
      });
```
and delete the private `senderFor`.

`notifications.reconciler.ts` — requeue only replayable rows, and close out stale redacted ones:
```ts
  @Cron(CronExpression.EVERY_5_MINUTES)
  async requeueStalePending(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_AFTER_MS);

    // A redacted row's real text lived only in its job; replaying it would send
    // "******". Its code has expired anyway, so record the failure instead.
    await this.prisma.notification.updateMany({
      where: { status: NotificationStatus.PENDING, redacted: true, createdAt: { lt: cutoff } },
      data: { status: NotificationStatus.FAILED, lastError: 'expired before delivery' },
    });

    const stale = await this.prisma.notification.findMany({
      where: { status: NotificationStatus.PENDING, redacted: false, createdAt: { lt: cutoff } },
      select: { id: true },
      take: 100,
    });
    // ...unchanged loop + log
  }
```
`notification-templates.ts`: `RenderedMessage.subject` becomes optional (`subject?: string;`) — SMS has no subject line (the email templates all still set one; `EmailChannel` already falls back to `''`). Add:
```ts
  phoneVerificationCode: (code: string): RenderedMessage => ({
    body: `[Inventra] 인증번호 [${code}]를 입력해 주세요. 3분 안에 입력해야 합니다.`,
  }),
```
- [ ] **Step 4:** `npm test` → green; `tsc` → 0.
- [ ] **Step 5:** commit + push `feat(notifications): SMS channel (fake), ChannelRegistry, redacted dispatch for OTP`.

---

### Task 3: `PhoneVerificationService.sendCode`

**Files:** Create `src/phone-verification/phone-verification.service.ts` · Test `phone-verification.service.spec.ts`

**Interfaces — Consumes:** `NotificationsService.dispatch` (with `redactedBody`), `notificationTemplates.phoneVerificationCode`, constants, `OTP_SECRET`. **Produces:** `PhoneVerificationService.sendCode(phone: string, purpose: PhoneVerificationPurpose): Promise<{ expiresInSeconds: number }>`; private `hashCode(code)`.

Rules, in order:
1. Latest row for `(phone, purpose)` created < 60 s ago → **429** `Please wait before requesting another code`.
2. Rows for `phone` (any purpose) in the last 24 h ≥ 10 → **429** `Too many codes requested today`.
3. Eligibility: `SIGNUP` + phone already on a (non-deleted) user → **409** `Phone already registered`. `FIND_ID`/`RESET_PASSWORD` + no such user → *ineligible, silently*: skip step 4.
4. Eligible → `dispatch` (`channel: SMS`, `eventType: 'phone.verificationCode'`, `body` with the code, `redactedBody` with `******`) — queued like every notification, ahead of the regular ones. An **enqueue** error (Redis/DB down) → **503** `Could not send the verification code`, and **no verification row** is created. (Provider failures happen later in the worker; the user resends after the cooldown.)
5. Create the row: `codeHash = HMAC-SHA256(OTP_SECRET, code)` hex, `expiresAt = now + 180 s`.
6. Return `{ expiresInSeconds: 180 }` (same for eligible and ineligible).

- [ ] **Step 1 (Claude): tests** (fake timers at a fixed `now`; `jest.spyOn(crypto, 'randomInt')` is not possible on ESM builtins, so the spec reads the code back out of the `dispatch` call's `body`):
  - creates a row with `phone`, `purpose`, `expiresAt = now+180s`, and a `codeHash` that equals `createHmac('sha256', secret).update(<code from the SMS body>).digest('hex')` — and ≠ the code itself.
  - the dispatched `body` contains a 6-digit code; `redactedBody` contains `******` and **not** the code.
  - 429 when the last row is 59 s old; allowed at 61 s.
  - 429 when 10 rows exist in the last 24 h (`count` called with `{ phone, createdAt: { gte: now-24h } }`).
  - SIGNUP + registered phone → 409, nothing sent, no row.
  - FIND_ID + unknown phone → resolves `{ expiresInSeconds: 180 }`, **creates the row**, **no** `dispatch`.
  - `dispatch` rejects → `ServiceUnavailableException`, `phoneVerification.create` not called.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3 (user):**
```ts
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { Env } from '../config/env.schema';
import {
  NotificationChannel,
  PhoneVerificationPurpose,
} from '../generated/prisma/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { notificationTemplates } from '../notifications/notification-templates';
import {
  CODE_TTL_SECONDS,
  DAILY_SEND_LIMIT,
  RESEND_COOLDOWN_SECONDS,
} from './phone-verification.constants';

export const PHONE_VERIFICATION_CODE_EVENT = 'phone.verificationCode';

@Injectable()
export class PhoneVerificationService {
  private readonly otpSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    config: ConfigService<Env, true>,
  ) {
    this.otpSecret = config.get('OTP_SECRET', { infer: true });
  }

  async sendCode(
    phone: string,
    purpose: PhoneVerificationPurpose,
  ): Promise<{ expiresInSeconds: number }> {
    const now = Date.now();

    const latest = await this.prisma.phoneVerification.findFirst({
      where: { phone: phone, purpose: purpose },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (latest && now - latest.createdAt.getTime() < RESEND_COOLDOWN_SECONDS * 1000) {
      throw new HttpException(
        'Please wait before requesting another code',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const sentToday = await this.prisma.phoneVerification.count({
      where: { phone: phone, createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) } },
    });
    if (sentToday >= DAILY_SEND_LIMIT) {
      throw new HttpException('Too many codes requested today', HttpStatus.TOO_MANY_REQUESTS);
    }

    const owner = await this.prisma.user.findFirst({
      where: { phone: phone, deletedAt: null },
      select: { id: true },
    });
    if (purpose === PhoneVerificationPurpose.SIGNUP && owner) {
      throw new ConflictException('Phone already registered');
    }
    // Recovery flows answer the same either way, so a stranger can't probe which
    // phones have accounts. Ineligible = the row is recorded, nothing is sent.
    const eligible = purpose === PhoneVerificationPurpose.SIGNUP || owner !== null;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    if (eligible) {
      try {
        await this.notifications.dispatch({
          eventType: PHONE_VERIFICATION_CODE_EVENT,
          channel: NotificationChannel.SMS,
          recipientUserId: owner?.id,
          recipientAddress: phone,
          body: notificationTemplates.phoneVerificationCode(code).body,
          // the row keeps only this; the real code rides in the queue job
          redactedBody: notificationTemplates.phoneVerificationCode('******').body,
        });
      } catch {
        throw new ServiceUnavailableException('Could not send the verification code');
      }
    }

    await this.prisma.phoneVerification.create({
      data: {
        phone: phone,
        purpose: purpose,
        codeHash: this.hashCode(code),
        expiresAt: new Date(now + CODE_TTL_SECONDS * 1000),
      },
    });
    return { expiresInSeconds: CODE_TTL_SECONDS };
  }

  private hashCode(code: string): string {
    return createHmac('sha256', this.otpSecret).update(code).digest('hex');
  }
}
```
- [ ] **Step 4:** `npm test` → green.
- [ ] **Step 5:** commit + push `feat(phone-verification): send-code with cooldown, daily cap, no-enumeration`.

---

### Task 4: `verify` and `consume`

**Files:** Modify `phone-verification.service.ts` · Test same spec

**Interfaces — Produces:**
- `verify(phone, purpose, code): Promise<{ verificationToken: string; expiresInSeconds: number }>`
- `consume(tx: Prisma.TransactionClient, input: { token: string; phone: string; purpose: PhoneVerificationPurpose }): Promise<void>` — throws `BadRequestException('Invalid or expired verification token')`.

`verify` rules: latest row for `(phone, purpose)` with `verifiedAt: null` and `expiresAt > now` → else 400 `Invalid or expired code`. Atomically claim an attempt: `updateMany({ where: { id, attempts: { lt: 5 } }, data: { attempts: { increment: 1 } } })`; `count === 0` → 400 `Too many attempts; request a new code`. Compare HMACs with `timingSafeEqual`; mismatch → 400 `Invalid or expired code`. Match → `update` the row: `verifiedAt: now`, `tokenHash: sha256(token)`, `tokenExpiresAt: now + 600 s`; return the raw token (`randomBytes(32).toString('base64url')`).

`consume` rules: `updateMany({ where: { tokenHash: sha256(token), phone, purpose, consumedAt: null, tokenExpiresAt: { gt: now } }, data: { consumedAt: now } })`; `count !== 1` → 400. One conditional write = check + mark in one step, so two concurrent signups with the same token can't both win.

- [ ] **Step 1 (Claude): tests:** correct code → token returned, row updated with `sha256(token)` (not the token) and `tokenExpiresAt = now+600s`; wrong code → 400 and attempts claimed; no live row (expired / already verified / none) → 400 without touching attempts; `updateMany` count 0 → "Too many attempts" (the race test: the 6th guess fails even if it's the right code); `consume` passes `{ tokenHash: sha256(token), phone, purpose, consumedAt: null, tokenExpiresAt: { gt: now } }` and resolves on count 1; count 0 → 400 (covers reuse, wrong phone, wrong purpose, expired — all enforced by the same `where`).
- [ ] **Step 2:** FAIL. **Step 3 (user):**
```ts
  async verify(
    phone: string,
    purpose: PhoneVerificationPurpose,
    code: string,
  ): Promise<{ verificationToken: string; expiresInSeconds: number }> {
    const now = new Date();
    const verification = await this.prisma.phoneVerification.findFirst({
      where: { phone: phone, purpose: purpose, verifiedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!verification) throw new BadRequestException('Invalid or expired code');

    // Claim an attempt BEFORE comparing: a conditional write, so parallel
    // guesses can't sneak past the limit.
    const claimed = await this.prisma.phoneVerification.updateMany({
      where: { id: verification.id, attempts: { lt: MAX_VERIFY_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('Too many attempts; request a new code');
    }

    const expected = Buffer.from(verification.codeHash, 'hex');
    const actual = Buffer.from(this.hashCode(code), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      throw new BadRequestException('Invalid or expired code');
    }

    const verificationToken = randomBytes(32).toString('base64url');
    await this.prisma.phoneVerification.update({
      where: { id: verification.id },
      data: {
        verifiedAt: now,
        tokenHash: this.hashToken(verificationToken),
        tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000),
      },
    });
    return { verificationToken: verificationToken, expiresInSeconds: TOKEN_TTL_SECONDS };
  }

  /** Single-use: marks the token consumed in the caller's transaction. */
  async consume(
    tx: Prisma.TransactionClient,
    input: { token: string; phone: string; purpose: PhoneVerificationPurpose },
  ): Promise<void> {
    const now = new Date();
    const consumed = await tx.phoneVerification.updateMany({
      where: {
        tokenHash: this.hashToken(input.token),
        phone: input.phone,
        purpose: input.purpose,
        consumedAt: null,
        tokenExpiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new BadRequestException('Invalid or expired verification token');
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
```
(imports: `BadRequestException`, `createHash`, `randomBytes`, `timingSafeEqual`, `Prisma` from `../generated/prisma/client`, `MAX_VERIFY_ATTEMPTS`, `TOKEN_TTL_SECONDS`.)
- [ ] **Step 4:** `npm test` → green. **Step 5:** commit + push `feat(phone-verification): verify (attempt-capped) and single-use consume`.

---

### Task 5: Endpoints + signup requires a verified phone

**Files:** Create `src/phone-verification/dto/send-code.dto.ts`, `dto/verify-code.dto.ts`, `phone-verification.controller.ts`, `phone-verification.module.ts` · Modify `app.module.ts`, `auth.module.ts`, `auth/dto/register.dto.ts`, `auth/dto/register-member.dto.ts`, `auth/auth.service.ts` · Test `auth.service.spec.ts` (update), `phone-verification.dto.spec.ts`

**Interfaces — Consumes:** `sendCode`, `verify`, `consume`. **Produces:** `POST /auth/phone/send-code { phone, purpose }` → 200 `{ expiresInSeconds }`; `POST /auth/phone/verify { phone, purpose, code }` → 200 `{ verificationToken, expiresInSeconds }`; `RegisterDto` + `ownerPhone`, `ownerPhoneVerificationToken`; `RegisterMemberDto` + `phone`, `phoneVerificationToken`.

- [ ] **Step 1 (Claude): tests**
  - DTO spec (`plainToInstance` + `validate`): `'010-1234-5678'` is normalized and valid; `'02-123-4567'` invalid; `purpose: 'LOGIN'` invalid; `code: '12345'` / `'12a456'` invalid.
  - `auth.service.spec`: `register` → 409 `Phone already registered` when `user.findFirst` finds the phone; calls `phoneVerification.consume(tx, { token, phone, purpose: SIGNUP })` **inside** `$transaction` (with the tx client) **before** `tx.user.create`; creates the user with `phone`; a consume rejection propagates and no user is created. Same three for `registerMember` (now wrapped in `$transaction`).
- [ ] **Step 2:** FAIL. **Step 3 (user):**

`dto/send-code.dto.ts`:
```ts
import { Transform } from 'class-transformer';
import { IsEnum, Matches } from 'class-validator';
import { PhoneVerificationPurpose } from '../../generated/prisma/enums';
import { KOREAN_MOBILE_PATTERN, normalizePhone } from '../phone';

export class SendCodeDto {
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, { message: 'phone must be a Korean mobile number' })
  phone!: string;

  @IsEnum(PhoneVerificationPurpose)
  purpose!: PhoneVerificationPurpose;
}
```
`dto/verify-code.dto.ts`: `extends SendCodeDto` + `@Matches(/^\d{6}$/) code!: string;`

`phone-verification.controller.ts`:
```ts
@Controller('auth/phone')
export class PhoneVerificationController {
  constructor(private readonly phoneVerification: PhoneVerificationService) {}

  @Public()
  @Post('send-code')
  @HttpCode(HttpStatus.OK)
  sendCode(@Body() dto: SendCodeDto) {
    return this.phoneVerification.sendCode(dto.phone, dto.purpose);
  }

  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  verify(@Body() dto: VerifyCodeDto) {
    return this.phoneVerification.verify(dto.phone, dto.purpose, dto.code);
  }
}
```
`phone-verification.module.ts`: `imports: [NotificationsModule]`, `controllers`, `providers: [PhoneVerificationService]`, `exports: [PhoneVerificationService]`. `AuthModule` imports it; `AppModule` needs no change beyond what `AuthModule` pulls in.

`RegisterDto` adds:
```ts
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, { message: 'ownerPhone must be a Korean mobile number' })
  ownerPhone!: string;

  @IsString()
  @IsNotEmpty()
  ownerPhoneVerificationToken!: string;
```
`RegisterMemberDto` adds the same as `phone` / `phoneVerificationToken`.

`AuthService` — constructor adds `private readonly phoneVerification: PhoneVerificationService`; in `register`, add the phone to the pre-checks and consume inside the transaction:
```ts
    const phoneTakenPromise = this.prisma.user.findFirst({
      where: { phone: ownerPhone, deletedAt: null },
      select: { id: true },
    });
    // ...Promise.all([... , phoneTakenPromise]); then:
    if (phoneTaken) throw new ConflictException('Phone already registered');
    // inside $transaction, first line:
        await this.phoneVerification.consume(transaction, {
          token: ownerPhoneVerificationToken,
          phone: ownerPhone,
          purpose: PhoneVerificationPurpose.SIGNUP,
        });
    // and user.create data gets `phone: ownerPhone`
```
`registerMember`: same pre-check; wrap the `user.create` in `this.prisma.$transaction(async (transaction) => { await this.phoneVerification.consume(transaction, {...}); return transaction.user.create({...phone: phone...}); })`.
- [ ] **Step 4:** `npm test` → green; `tsc` → 0.
- [ ] **Step 5:** commit + push `feat(auth): signup requires a verified, unique phone`.

---

### Task 6: e2e

**Files:** Create `test/helpers/phone.ts`, `test/phone-verification.e2e-spec.ts` · Modify every e2e that calls `/auth/register` or `/auth/register/member` (audits, auth, catalog, inventory, notifications, orders, placements, reservations, stores-corners, uploads)

**Interfaces — Produces:** `testPhones(suiteNumber: number): () => string` (unique across suites: `010` + 2-digit suite + 6-digit counter); `verifiedPhoneToken(http, app, phone): Promise<string>` (send-code → **poll** `FakeSmsChannel.lastMessageTo(phone)` until the worker has delivered it — the SMS is queued, so it arrives asynchronously → extract `\d{6}` → verify).

- [ ] **Step 1 (Claude):** helper + update each suite's register helpers to pass a unique phone + token. Suite numbers: auth 01, catalog 02, stores-corners 03, placements 04, inventory 05, orders 06, audits 07, reservations 08, uploads 09, notifications 10, phone-verification 11.
- [ ] **Step 2 (Claude): `phone-verification.e2e-spec.ts`:**
  1. send-code with `010-…` dashed → 200; a `SENT` SMS `Notification` row exists whose body contains `******` and not the code.
  2. resend within 60 s → 429.
  3. wrong code → 400; right code → 200 + token; register an owner with the **undashed** phone + token → 201, user row has the phone.
  4. the same token again (member signup) → 400; send-code SIGNUP for that phone → 409.
  5. `FIND_ID` for an unknown phone → 200 `{ expiresInSeconds: 180 }` and **no** SMS in the fake outbox.
  6. token for phone A used with phone B → 400.
  7. 5 wrong codes → the 6th (even correct) → 400 "Too many attempts".
- [ ] **Step 3:** `tsc` → 0; **human** runs `npm run test:e2e` → all green.
- [ ] **Step 4:** commit + push; update `STATUS.md` + `CLAUDE.md` (Slice 2 done — or 2 minus Task 7).

---

### Task 7 (deferrable): Solapi adapter + provider switch

**Files:** Create `src/notifications/channels/solapi-sms.channel.ts` · Modify `env.schema.ts`, `notifications.module.ts`, `.env.example` · Test `solapi-sms.channel.spec.ts`, `env.schema.spec.ts`

**Interfaces — Produces:** env `SMS_PROVIDER: 'fake' | 'solapi'` (default `fake`), `SOLAPI_API_KEY`, `SOLAPI_API_SECRET`, `SOLAPI_SENDER` (required when `solapi`); production + `fake` → env validation error. `SMS_SENDER` becomes a `useFactory` choosing the adapter.

- [ ] **Step 0:** confirm Solapi's current v4 send API + HMAC auth header format against its docs (context7 / official docs) **before** writing code; adjust the reference below to match.
- [ ] **Step 1 (Claude): tests** — `global.fetch` mocked: POSTs `https://api.solapi.com/messages/v4/send` with `{ message: { to, from: SOLAPI_SENDER, text: body } }` and an `Authorization: HMAC-SHA256 apiKey=…, date=…, salt=…, signature=…` header where `signature = HMAC-SHA256(secret, date + salt)`; non-2xx → throws with the provider's message. Env spec: production + `fake` rejected; `solapi` without key rejected.
- [ ] **Step 2–4:** implement (`fetch` + `createHmac`, no SDK), wire:
```ts
    {
      provide: SMS_SENDER,
      inject: [ConfigService, FakeSmsChannel, SolapiSmsChannel],
      useFactory: (config: ConfigService<Env, true>, fake: FakeSmsChannel, solapi: SolapiSmsChannel) =>
        config.get('SMS_PROVIDER', { infer: true }) === 'solapi' ? solapi : fake,
    },
```
- [ ] **Step 5:** `npm test` green → commit + push `feat(notifications): Solapi SMS adapter behind SMS_PROVIDER`.

---

## Self-review notes
- Spec coverage: model ✔ (T1), send-code cooldown/cap/no-enumeration ✔ (T3), verify hash/expiry/attempts/token ✔ (T4), consume purpose+phone ✔ (T4), signup DTOs + unique + 409 ✔ (T1/T5), redacted body ✔ (T2/T3), fake adapter ✔ (T2), provider adapter ✔ (T7). Deviation from the spec's wording: OTP is queued as the spec says, but via a *redacted* dispatch with the real text only in the job, no priority (= ahead of `priority: 10` regular jobs), short fixed retries, and no reconciler replay (Decision 1) — spec updated to match in Task 6's doc commit.
- Out of scope (Slice 3): consuming `FIND_ID`/`RESET_PASSWORD` tokens; reservation SMS.
