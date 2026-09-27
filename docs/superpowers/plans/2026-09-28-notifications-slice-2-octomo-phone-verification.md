# Notifications Slice 2 — Phone Verification via OCTOMO (Reverse SMS) Implementation Plan

> **Workflow:** teaching-first, per-task. Claude teaches + gives full reference code; **the user writes production code**; **Claude writes + runs tests**. Auto-commit + push at green checkpoints. Verbose object literals (`{ id: id }`). A human runs `prisma migrate` and `npm run test:e2e`.

**Goal:** a phone-ownership verification flow (start → user texts a code → confirm → single-use token) backed by OCTOMO's reverse-SMS API, and both signup endpoints requiring a verified, unique phone.

**Architecture:** a new `PhoneVerificationModule` owns the lifecycle. The only external call — "did a text with this code arrive from this phone?" — sits behind a `PhoneOwnershipVerifier` interface bound to the `PHONE_VERIFIER` token: `OctomoPhoneVerifier` (real, `fetch`) or `FakePhoneVerifier` (e2e). The verification token is consumed inside the signup transaction. **No outbound SMS and no notifications-module changes in this slice.**

**Tech Stack:** NestJS 11 · Prisma 7 · class-validator/class-transformer · `node:crypto` (`randomInt`, `randomBytes`, `createHash`) · global `fetch` + `AbortSignal.timeout` · Zod env · Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-23-notifications-and-account-security-design.md` → "Phone verification (OCTOMO reverse SMS) — Slice 2". **Replaces** the 2026-09-27 outbound-SMS plan (decision 2026-09-28: use OCTOMO).

## Global Constraints
- Phones: `010` + 8 digits, stored digits only (`01012345678`); input may contain `-`/spaces. (OCTOMO rejects any other format.)
- Code: 6 digits, **shown to the user** (not a secret, stored as-is), live **5 min**.
- Max **10** confirm checks per verification (each is an OCTOMO call; free plan = 10,000 calls/month, 100 per 10 s).
- Max **10** starts per phone per rolling 24 h.
- `verificationToken`: single-use, **10 min**; only its SHA-256 hash is stored; purpose **and** phone must match at consumption.
- `User.phone`: unique index; duplicate → **409**.
- OCTOMO: `POST https://api.octoverse.kr/octomo/v1/public/message/exists`, `Authorization: Octomo <key>`, body `{ mobileNum, text, withinMinutes }` (1–60) → `{ exists: boolean }`. Receiver number shown to users: `1666-3538`.
- `PHONE_VERIFIER=octomo|fake`; `octomo` requires `OCTOMO_API_KEY`; `NODE_ENV=production` refuses `fake`.

## Decisions
1. **`withinMinutes` = minutes since the verification started, rounded up** (clamped 1–60), so a text sent *before* this verification can't count for it.
2. **Confirm claims a check before calling OCTOMO** with a conditional `updateMany({ checkAttempts: { lt: 10 } })`, so parallel confirms can't exceed the cap (quota protection).
3. **Issuing the token is also conditional** (`updateMany({ verifiedAt: null })`), so two parallel successful confirms can't mint two tokens for one verification.
4. **OCTOMO failures → 503** ("try again"); an OCTOMO `exists: false` → **400** "Message not received yet" (client shows "still waiting — tap again").
5. No resend cooldown (we send nothing) and no enumeration hiding (nothing is revealed before ownership is proven).
6. `fetch` gets a **5 s timeout** (`AbortSignal.timeout(5000)`) so a hanging provider can't hang our request.

## Review Focus
1. **Two concurrent confirms that both see `exists: true`** → exactly one token (Task 4 "second concurrent confirm gets 400").
2. **Reusing a verification token** (double-submitted signup form) → 400 on the second use (Task 4 + Task 6 e2e).
3. **Token for phone A used to register phone B**, or a `FIND_ID` token for `SIGNUP` → 400 (Task 4).
4. **`010-1234-5678` vs `01012345678`** is the same phone for daily cap, uniqueness, and the OCTOMO call (Task 1 + Task 6 e2e registers with dashes).
5. **OCTOMO down / slow / 429** → 503, and the failed check still counts toward the cap (Task 3 + Task 4).

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` (modify) | `User.phone @unique`; `PhoneVerificationPurpose` enum; `PhoneVerification` model |
| `src/phone-verification/phone.ts` | `KOREAN_MOBILE_PATTERN`, `normalizePhone()` |
| `src/phone-verification/phone-verification.constants.ts` | TTLs, limits, OCTOMO URL + receiver number, `PHONE_VERIFIER` token |
| `src/phone-verification/verifiers/phone-ownership-verifier.ts` | the interface |
| `src/phone-verification/verifiers/octomo.verifier.ts` | real OCTOMO client |
| `src/phone-verification/verifiers/fake.verifier.ts` | e2e stand-in with `receive()` |
| `src/config/env.schema.ts` (modify) | `PHONE_VERIFIER`, `OCTOMO_API_KEY` + cross-field rules |
| `src/phone-verification/phone-verification.service.ts` | `start`, `confirm`, `consume` |
| `src/phone-verification/dto/*.ts` | `StartVerificationDto`, `ConfirmVerificationDto` |
| `src/phone-verification/phone-verification.controller.ts` | `POST /auth/phone/start`, `POST /auth/phone/confirm` |
| `src/phone-verification/phone-verification.module.ts` | wiring + verifier selection |
| `src/auth/dto/register*.dto.ts`, `src/auth/auth.service.ts`, `auth.module.ts` (modify) | signup requires a verified unique phone |
| `test/helpers/phone.ts` + every e2e that registers users | shared "verified phone" helper |
| `test/phone-verification.e2e-spec.ts` | the flow end to end |

---

### Task 1: Schema, migration, phone normalization, constants

**Files:** Modify `prisma/schema.prisma` · Create `src/phone-verification/phone.ts`, `src/phone-verification/phone-verification.constants.ts` · Test `src/phone-verification/phone.spec.ts`

**Interfaces — Produces:** Prisma `PhoneVerification` + `PhoneVerificationPurpose` (`SIGNUP | FIND_ID | RESET_PASSWORD`); `normalizePhone(value: unknown): unknown`; `KOREAN_MOBILE_PATTERN`; constants below.

- [ ] **Step 1 (Claude):** `phone.spec.ts` — strips dashes/spaces; non-strings pass through; accepts `01012345678`; rejects landlines, dashed input, 10/12 digits, `+82…`, legacy `011`/`016`/`019` numbers, empty.
- [ ] **Step 2:** run → FAIL (module not found).
- [ ] **Step 3 (user):**

`src/phone-verification/phone.ts`
```ts
/** Korean mobile, digits only. 010 + 8 digits — the only format OCTOMO accepts. */
export const KOREAN_MOBILE_PATTERN = /^010\d{8}$/;

/**
 * class-transformer hook: "010-1234-5678" → "01012345678".
 * Non-strings pass through untouched so the validator can reject them with a 400.
 */
export function normalizePhone(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/[-\s]/g, '') : value;
}
```
`src/phone-verification/phone-verification.constants.ts`
```ts
export const CODE_TTL_SECONDS = 300; // time to switch to the SMS app and send
export const MAX_CONFIRM_CHECKS = 10; // each check is one OCTOMO API call
export const DAILY_START_LIMIT = 10; // per phone, all purposes, rolling 24 h
export const TOKEN_TTL_SECONDS = 600; // the proof lives 10 minutes

export const OCTOMO_EXISTS_URL =
  'https://api.octoverse.kr/octomo/v1/public/message/exists';
export const OCTOMO_RECEIVER_NUMBER = '1666-3538';

/** Injection token for "whichever phone-ownership verifier this environment uses". */
export const PHONE_VERIFIER = 'PHONE_VERIFIER';
```
`prisma/schema.prisma` — in `model User`:
```prisma
  phone           String?    @unique(map: "UQ_users_phone") @db.VarChar(20)
```
new enum + model:
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
  code           String                   @db.VarChar(6)
  expiresAt      DateTime                 @map("expires_at") @db.Timestamptz(6)
  checkAttempts  Int                      @default(0) @map("check_attempts")
  verifiedAt     DateTime?                @map("verified_at") @db.Timestamptz(6)
  tokenHash      String?                  @unique(map: "UQ_phone_verifications_token_hash") @map("token_hash") @db.VarChar(64)
  tokenExpiresAt DateTime?                @map("token_expires_at") @db.Timestamptz(6)
  consumedAt     DateTime?                @map("consumed_at") @db.Timestamptz(6)
  createdAt      DateTime                 @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([phone, createdAt], map: "IDX_phone_verifications_phone_created")
  @@map("phone_verifications")
}
```
- [ ] **Step 4 (human):** `npx prisma migrate dev --name phone_verification`.
- [ ] **Step 5:** `npm test` green, `tsc` 0 → commit + push `feat(phone-verification): schema, phone normalization, constants`.

---

### Task 2: Verifiers (OCTOMO + fake), env, selection

**Files:** Create `verifiers/phone-ownership-verifier.ts`, `verifiers/octomo.verifier.ts`, `verifiers/fake.verifier.ts` · Modify `src/config/env.schema.ts`, `.env`, `.env.test`, `.env.example` · Tests `octomo.verifier.spec.ts`, `fake.verifier.spec.ts`, `src/config/env.schema.spec.ts`

**Interfaces — Produces:**
```ts
export interface PhoneOwnershipVerifier {
  /** Did `mobileNum` text exactly `text` to the receiver number within the last `withinMinutes`? */
  messageExists(mobileNum: string, text: string, withinMinutes: number): Promise<boolean>;
}
```
`FakePhoneVerifier.receive(mobileNum: string, text: string): void`; env `PHONE_VERIFIER`, `OCTOMO_API_KEY`.

- [ ] **Step 1 (Claude): tests**
  - OCTOMO (global `fetch` mocked): POSTs `OCTOMO_EXISTS_URL` with headers `Accept`/`Content-Type: application/json`, `Authorization: 'Octomo test-key'`, body `{ mobileNum, text, withinMinutes }`, and an `AbortSignal`; `{ exists: true }` → `true`; `{ exists: false }` → `false`; a missing/non-boolean `exists` → `false`; HTTP 401/429/500 → throws `OCTOMO responded 429`; a network error/timeout → rejects.
  - fake: `messageExists` is `false` until `receive(phone, code)`; exact text match only; phone-scoped.
  - env: `octomo` without `OCTOMO_API_KEY` → error mentioning `OCTOMO_API_KEY`; `production` + `fake` → error; `test` + `fake` → ok.
- [ ] **Step 3 (user):**

`verifiers/octomo.verifier.ts`
```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';
import { OCTOMO_EXISTS_URL } from '../phone-verification.constants';
import { PhoneOwnershipVerifier } from './phone-ownership-verifier';

@Injectable()
export class OctomoPhoneVerifier implements PhoneOwnershipVerifier {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async messageExists(
    mobileNum: string,
    text: string,
    withinMinutes: number,
  ): Promise<boolean> {
    const response = await fetch(OCTOMO_EXISTS_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Octomo ${this.config.get('OCTOMO_API_KEY', { infer: true })}`,
      },
      body: JSON.stringify({
        mobileNum: mobileNum,
        text: text,
        withinMinutes: withinMinutes,
      }),
      signal: AbortSignal.timeout(5000), // a hanging provider must not hang our request
    });
    if (!response.ok) {
      throw new Error(`OCTOMO responded ${response.status}`);
    }
    const body = (await response.json()) as { exists?: unknown };
    return body.exists === true;
  }
}
```
`verifiers/fake.verifier.ts`
```ts
import { Injectable } from '@nestjs/common';
import { PhoneOwnershipVerifier } from './phone-ownership-verifier';

/** e2e stand-in: tests call receive() to play "the user texted the code". */
@Injectable()
export class FakePhoneVerifier implements PhoneOwnershipVerifier {
  private readonly received: { mobileNum: string; text: string }[] = [];

  receive(mobileNum: string, text: string): void {
    this.received.push({ mobileNum: mobileNum, text: text });
  }

  async messageExists(mobileNum: string, text: string): Promise<boolean> {
    return this.received.some(
      (message) => message.mobileNum === mobileNum && message.text === text,
    );
  }
}
```
`env.schema.ts` — fields:
```ts
  // -- Phone verification (OCTOMO reverse SMS) --
  PHONE_VERIFIER: z.enum(['octomo', 'fake']),
  OCTOMO_API_KEY: z.string().min(1).optional(),
```
and cross-field rules on the object:
```ts
export const envSchema = z
  .object({ /* ...all fields... */ })
  .superRefine((env, context) => {
    if (env.PHONE_VERIFIER === 'octomo' && !env.OCTOMO_API_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['OCTOMO_API_KEY'],
        message: 'required when PHONE_VERIFIER=octomo',
      });
    }
    if (env.NODE_ENV === 'production' && env.PHONE_VERIFIER === 'fake') {
      context.addIssue({
        code: 'custom',
        path: ['PHONE_VERIFIER'],
        message: 'fake is not allowed in production',
      });
    }
  });
```
`.env`: `PHONE_VERIFIER=octomo` + `OCTOMO_API_KEY=<from OCTOMO 마이페이지>`; `.env.test`: `PHONE_VERIFIER=fake`; `.env.example`: both, with a placeholder key.
- [ ] **Step 4:** `npm test` green, `tsc` 0 → commit + push `feat(phone-verification): OCTOMO + fake verifiers, env selection`.

---

### Task 3: `PhoneVerificationService.start`

**Files:** Create `phone-verification.service.ts` · Test `phone-verification.service.spec.ts`

**Interfaces — Produces:** `start(phone: string, purpose: PhoneVerificationPurpose): Promise<{ verificationId: string; code: string; receiverNumber: string; expiresInSeconds: number }>`.

Rules: starts for this phone in the last 24 h ≥ 10 → **429**; `SIGNUP` and a non-deleted user already has the phone → **409** `Phone already registered`; create the row (`code` = 6 random digits, `expiresAt = now + 300 s`); return it with `receiverNumber: '1666-3538'`.

- [ ] **Step 1 (Claude): tests** — fake timers; row created with `phone`, `purpose`, a `/^\d{6}$/` code, `expiresAt = now+300s`; response echoes that code + id + receiver; `count` called with `{ phone, createdAt: { gte: now-24h } }`; 10 → 429 (no row); SIGNUP + taken → 409 (no row); FIND_ID + taken → allowed.
- [ ] **Step 3 (user):**
```ts
import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';
import {
  CODE_TTL_SECONDS,
  DAILY_START_LIMIT,
  OCTOMO_RECEIVER_NUMBER,
  PHONE_VERIFIER,
} from './phone-verification.constants';
import type { PhoneOwnershipVerifier } from './verifiers/phone-ownership-verifier';

@Injectable()
export class PhoneVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PHONE_VERIFIER) private readonly verifier: PhoneOwnershipVerifier,
  ) {}

  async start(phone: string, purpose: PhoneVerificationPurpose) {
    const now = Date.now();

    const startedToday = await this.prisma.phoneVerification.count({
      where: {
        phone: phone,
        createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) },
      },
    });
    if (startedToday >= DAILY_START_LIMIT) {
      throw new HttpException(
        'Too many verifications for this phone today',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (purpose === PhoneVerificationPurpose.SIGNUP) {
      const owner = await this.prisma.user.findFirst({
        where: { phone: phone, deletedAt: null },
        select: { id: true },
      });
      if (owner) throw new ConflictException('Phone already registered');
    }

    const verification = await this.prisma.phoneVerification.create({
      data: {
        phone: phone,
        purpose: purpose,
        code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
        expiresAt: new Date(now + CODE_TTL_SECONDS * 1000),
      },
    });
    return {
      verificationId: verification.id,
      code: verification.code,
      receiverNumber: OCTOMO_RECEIVER_NUMBER,
      expiresInSeconds: CODE_TTL_SECONDS,
    };
  }
}
```
- [ ] **Step 4:** green → commit + push `feat(phone-verification): start (daily cap, signup duplicate check)`.

---

### Task 4: `confirm` and `consume`

**Files:** Modify `phone-verification.service.ts` · Test same spec

**Interfaces — Produces:**
- `confirm(verificationId: string): Promise<{ verificationToken: string; expiresInSeconds: number }>`
- `consume(tx: Prisma.TransactionClient, input: { token: string; phone: string; purpose: PhoneVerificationPurpose }): Promise<void>`

- [ ] **Step 1 (Claude): tests** — unknown id / expired / already verified → 400 `Invalid or expired verification` (no check claimed, no OCTOMO call); claim `updateMany` count 0 → 429 `Too many checks; start a new verification` (no OCTOMO call); `messageExists` called with `(phone, code, withinMinutes)` where 90 s after start → `2`, 10 s → `1`; verifier throws → 503; `false` → 400 `Message not received yet`; `true` → token (base64url, 43 chars), `updateMany` sets `verifiedAt`, `tokenHash = sha256(token)`, `tokenExpiresAt = now+600s` with `where` including `verifiedAt: null`; that update's count 0 (concurrent winner) → 400. `consume` → `updateMany` where `{ tokenHash, phone, purpose, consumedAt: null, tokenExpiresAt: { gt: now } }`; count 1 resolves, 0 → 400 `Invalid or expired verification token`.
- [ ] **Step 3 (user):**
```ts
  async confirm(verificationId: string) {
    const now = new Date();
    const verification = await this.prisma.phoneVerification.findFirst({
      where: {
        id: verificationId,
        verifiedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!verification) {
      throw new BadRequestException('Invalid or expired verification');
    }

    // Each check costs an OCTOMO call: claim one first, conditionally, so
    // parallel requests can't exceed the cap.
    const claimed = await this.prisma.phoneVerification.updateMany({
      where: {
        id: verification.id,
        checkAttempts: { lt: MAX_CONFIRM_CHECKS },
      },
      data: { checkAttempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new HttpException(
        'Too many checks; start a new verification',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Only texts sent since this verification started may count.
    const minutesSinceStart = Math.ceil(
      (now.getTime() - verification.createdAt.getTime()) / 60_000,
    );
    const withinMinutes = Math.min(60, Math.max(1, minutesSinceStart));

    let received: boolean;
    try {
      received = await this.verifier.messageExists(
        verification.phone,
        verification.code,
        withinMinutes,
      );
    } catch {
      throw new ServiceUnavailableException(
        'Could not check the message right now; try again',
      );
    }
    if (!received) throw new BadRequestException('Message not received yet');

    const verificationToken = randomBytes(32).toString('base64url');
    const issued = await this.prisma.phoneVerification.updateMany({
      where: { id: verification.id, verifiedAt: null },
      data: {
        verifiedAt: now,
        tokenHash: this.hashToken(verificationToken),
        tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000),
      },
    });
    if (issued.count === 0) {
      // a parallel confirm already verified it and holds the token
      throw new BadRequestException('Invalid or expired verification');
    }
    return {
      verificationToken: verificationToken,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    };
  }

  /** Single-use: marks the token consumed inside the caller's transaction. */
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
(new imports: `BadRequestException`, `ServiceUnavailableException`, `createHash`, `randomBytes`, `Prisma` from `../generated/prisma/client`, `MAX_CONFIRM_CHECKS`, `TOKEN_TTL_SECONDS`.)
- [ ] **Step 4:** green → commit + push `feat(phone-verification): confirm via verifier (check-capped) + single-use consume`.

---

### Task 5: Endpoints, module, signup requires a verified phone

**Files:** Create `dto/start-verification.dto.ts`, `dto/confirm-verification.dto.ts`, `phone-verification.controller.ts`, `phone-verification.module.ts` · Modify `auth.module.ts`, `auth/dto/register.dto.ts`, `auth/dto/register-member.dto.ts`, `auth/auth.service.ts` · Tests `dto/phone-verification.dto.spec.ts`, `auth.service.spec.ts` (update)

**Interfaces — Produces:** `POST /auth/phone/start { phone, purpose }` → 200; `POST /auth/phone/confirm { verificationId }` → 200; `RegisterDto` + `ownerPhone`, `ownerPhoneVerificationToken`; `RegisterMemberDto` + `phone`, `phoneVerificationToken`.

- [ ] **Step 1 (Claude): tests** — DTOs: `'010-1234-5678'` normalized + valid; `'011-123-4567'` invalid; `purpose: 'LOGIN'` invalid; `verificationId: 'abc'` invalid (`@IsUUID`). `auth.service.spec`: `register` 409 when `user.findFirst` finds the phone; `consume(tx, { token, phone, purpose: SIGNUP })` runs inside `$transaction` before `tx.user.create`; user created with `phone`; a consume rejection propagates and no user is created. Same for `registerMember` (now wrapped in `$transaction`).
- [ ] **Step 3 (user):**

`dto/start-verification.dto.ts`
```ts
import { Transform } from 'class-transformer';
import { IsEnum, Matches } from 'class-validator';
import { PhoneVerificationPurpose } from '../../generated/prisma/enums';
import { KOREAN_MOBILE_PATTERN, normalizePhone } from '../phone';

export class StartVerificationDto {
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'phone must be a Korean mobile number starting with 010',
  })
  phone!: string;

  @IsEnum(PhoneVerificationPurpose)
  purpose!: PhoneVerificationPurpose;
}
```
`dto/confirm-verification.dto.ts`: `@IsUUID() verificationId!: string;`

`phone-verification.controller.ts`
```ts
@Controller('auth/phone')
export class PhoneVerificationController {
  constructor(private readonly phoneVerification: PhoneVerificationService) {}

  @Public()
  @Post('start')
  @HttpCode(HttpStatus.OK)
  start(@Body() dto: StartVerificationDto) {
    return this.phoneVerification.start(dto.phone, dto.purpose);
  }

  @Public()
  @Post('confirm')
  @HttpCode(HttpStatus.OK)
  confirm(@Body() dto: ConfirmVerificationDto) {
    return this.phoneVerification.confirm(dto.verificationId);
  }
}
```
`phone-verification.module.ts`
```ts
@Module({
  controllers: [PhoneVerificationController],
  providers: [
    PhoneVerificationService,
    OctomoPhoneVerifier,
    FakePhoneVerifier,
    {
      provide: PHONE_VERIFIER,
      inject: [ConfigService, OctomoPhoneVerifier, FakePhoneVerifier],
      useFactory: (
        config: ConfigService<Env, true>,
        octomo: OctomoPhoneVerifier,
        fake: FakePhoneVerifier,
      ) => (config.get('PHONE_VERIFIER', { infer: true }) === 'octomo' ? octomo : fake),
    },
  ],
  exports: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
```
`AuthModule` imports `PhoneVerificationModule`.

`RegisterDto` adds:
```ts
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'ownerPhone must be a Korean mobile number starting with 010',
  })
  ownerPhone!: string;

  @IsString()
  @IsNotEmpty()
  ownerPhoneVerificationToken!: string;
```
`RegisterMemberDto` adds the same as `phone` / `phoneVerificationToken`.

`AuthService` — constructor adds `private readonly phoneVerification: PhoneVerificationService`. `register`: add a `phoneTakenPromise = this.prisma.user.findFirst({ where: { phone: ownerPhone, deletedAt: null }, select: { id: true } })` to the `Promise.all`, `if (phoneTaken) throw new ConflictException('Phone already registered');`, first line inside `$transaction`:
```ts
        await this.phoneVerification.consume(transaction, {
          token: ownerPhoneVerificationToken,
          phone: ownerPhone,
          purpose: PhoneVerificationPurpose.SIGNUP,
        });
```
and `phone: ownerPhone` in `user.create`. `registerMember`: same pre-check; wrap the create:
```ts
    const user = await this.prisma.$transaction(async (transaction) => {
      await this.phoneVerification.consume(transaction, {
        token: phoneVerificationToken,
        phone: phone,
        purpose: PhoneVerificationPurpose.SIGNUP,
      });
      return transaction.user.create({ data: { /* as before */ phone: phone } });
    });
```
- [ ] **Step 4:** green + `tsc` 0 → commit + push `feat(auth): signup requires an OCTOMO-verified unique phone`.

---

### Task 6: e2e

**Files:** Create `test/helpers/phone.ts`, `test/phone-verification.e2e-spec.ts` · Modify every e2e that registers users (audits, auth, catalog, inventory, notifications, orders, placements, reservations, stores-corners, uploads) · Docs `STATUS.md`, `CLAUDE.md`

**Interfaces — Produces:** `testPhones(suiteNumber: number): () => string` (`010` + 2-digit suite + 6-digit counter → unique across suites sharing one DB); `verifiedPhoneToken(http, app, phone): Promise<string>` (start → `app.get(FakePhoneVerifier).receive(phone, code)` → confirm → token).

- [ ] **Step 1 (Claude):** helper + update each suite's register helpers. Suite numbers: auth 01, catalog 02, stores-corners 03, placements 04, inventory 05, orders 06, audits 07, reservations 08, uploads 09, notifications 10, phone-verification 11.
- [ ] **Step 2 (Claude): `phone-verification.e2e-spec.ts`:** start with a dashed phone → 200 + 6-digit code + `1666-3538`; confirm before "texting" → 400 not received; `receive` then confirm → token; confirm again → 400; register an owner with the **dashed** phone + token → 201, stored undashed; reuse token (member signup) → 400; start SIGNUP for that phone → 409; token for phone A with phone B → 400; FIND_ID token used for SIGNUP → 400; 10 failed confirms → 11th → 429.
- [ ] **Step 3:** `tsc` 0; **human** runs `npm run test:e2e`; green → commit + push; `STATUS.md` + `CLAUDE.md` → Slice 2 done, Slice 3 next.

---

## Self-review notes
- Spec coverage: model ✔ T1; verifier + env + prod guard ✔ T2; start (cap, 409) ✔ T3; confirm (live row, check cap, window, 503/400) + token ✔ T4; consume (purpose + phone, single-use, in-tx) ✔ T4/T5; signup DTOs + unique + 409 ✔ T1/T5; e2e ✔ T6.
- Out of scope (Slice 3): consuming `FIND_ID` / `RESET_PASSWORD` tokens; outbound reservation SMS (`SmsChannel` through the queue).
