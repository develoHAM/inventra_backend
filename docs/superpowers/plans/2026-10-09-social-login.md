# Social Login (Kakao · Google · Facebook · Apple) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project workflow (overrides the above for this repo):** teaching-first, per task — Claude teaches (snippets with full context) and gives the full reference code; **the user writes the production code**; **Claude writes and runs the tests**. Auto-commit + push at green checkpoints. Verbose object literals (`{ id: id }`). A human runs `prisma migrate` and `npm run test:e2e`.

**Goal:** sign up, sign in, link and unlink with Kakao, Google, Facebook and Apple through native app-to-app SDKs, verified by our backend and issued our own JWTs.

**Architecture:** a new `SocialAuthModule` holds one `SocialIdentityVerifier` per provider (behind a token, real or fake), nonces, signup tickets, email-code verification and login-method linking. `AuthService` stays the only place that creates users and issues tokens; the register endpoints take a tagged `credentials` sub-object (`password` | `social`).

**Tech Stack:** NestJS 11 · Prisma 7 · `jose` 6 (JWT/JWKS, ESM-only) · class-transformer discriminators · `node:crypto` AES-256-GCM / HMAC · global `fetch` · BullMQ (existing) · Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-10-09-social-login-design.md`

## Global Constraints
- Providers: `kakao | google | facebook | apple`. `method` column values: `local | kakao | google | facebook | apple`.
- Never auto-link by email; an unknown identity is always `SIGNUP_REQUIRED`.
- `POST /auth/social/:provider` always answers **200** with `status: 'LOGGED_IN' | 'SIGNUP_REQUIRED'`.
- Signup ticket: single-use, hashed, **15 min**. Nonce: single-use, hashed, **5 min**. Email code: 6 digits, HMAC-hashed, **10 min**, max **5** attempts, **60 s** resend cooldown, **10** sends per address per 24 h; email token **10 min**, single-use.
- Nonce: required for Apple, Kakao and Facebook iOS; Google only if the token carries one. Token claim must equal `SHA-256(nonce)` (hex).
- Contact email = a provider email with `emailVerified: true`, else `contactEmail` + a valid `emailVerificationToken`, else 400.
- Apple + Google refresh tokens stored **encrypted** (AES-256-GCM, `LOGIN_TOKEN_ENCRYPTION_KEY`).
- Unlinking the last login method → 409. Provider disconnect on unlink is best-effort (logged).
- Secret emails (the verification code) go through the queue as a **redacted dispatch**: the row stores a placeholder, the real text rides only in the job.
- `SOCIAL_VERIFIER=real|fake`; production refuses `fake`; provider credentials required only for `real`.

## Decisions beyond the spec
- **Redacted dispatch (Task 4).** The spec routes the emailed verification code through the notification queue (project rule: every sent notification goes through the queue). A queued row stores its text, so the code would sit in plain text in `notifications`. The row stores `******`; the real text rides only in the BullMQ job (removed on completion or failure); the reconciler never replays a redacted row. This is the design drafted on 2026-09-27 and dropped when OCTOMO removed outbound SMS.
- **`jose` is ESM-only** → added to the unit-Jest `transformIgnorePatterns` (like `nodemailer`); runtime and e2e load it natively.

## Review Focus
1. **The same social identity signing up twice at once** (double-tapped "sign up") → exactly one account; the loser gets 400 (ticket spent) or 409 (unique index) — Task 12.
2. **Linking an identity already linked to another account** → 409, nothing changed on either account — Task 13.
3. **Apple's second-and-later sign-ins carry no name/email** → login still works; signup falls back to the typed, code-verified email — Tasks 9 and 12.
4. **A provider's keys or API unreachable** → 503, no ticket or account created — Tasks 7–11.
5. **The emailed code never appears in the `notifications` table** (redacted) and the reconciler never replays a redacted row — Tasks 4 and 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` + migration (with backfill SQL) | unique indexes on `UserLoginMethod`; `User.contactEmail`; `Notification.redacted`; `SocialSignupTicket`, `SocialNonce`, `EmailVerification` |
| `src/auth/dto/credentials.dto.ts` | `PasswordCredentialsDto`, `SocialCredentialsDto`, the discriminator |
| `src/auth/dto/register.dto.ts`, `register-member.dto.ts` (modify) | `credentials` replaces `ownerEmail/ownerPassword` / `email/password` |
| `src/common/token-cipher.ts` | `encryptToken` / `decryptToken` (AES-256-GCM) |
| `src/notifications/*` (modify) | redacted dispatch |
| `src/email-verification/*` | start / confirm / consume (mirrors phone verification) |
| `src/social-auth/verifiers/*.ts` | the interface, Kakao, Google, Apple, Facebook, Fake |
| `src/social-auth/social-nonce.service.ts` | issue / consume nonces |
| `src/social-auth/social-auth.service.ts` | sign-in (LOGGED_IN / SIGNUP_REQUIRED), tickets |
| `src/social-auth/login-methods.service.ts` + controller | list / link / link-local / unlink |
| `src/social-auth/social-auth.controller.ts` | `/auth/social/nonce`, `/auth/social/:provider` |
| `src/social-auth/social-auth.module.ts` | wiring + verifier selection |
| `test/helpers/*`, every e2e signup call | the `credentials` shape |
| `test/social-auth.e2e-spec.ts` | the flows end to end |

---

### Task 1: Schema, migration, contact email

**Files:** Modify `prisma/schema.prisma` · migration created with `--create-only`, then the backfill appended · Modify `src/notifications/notifications.service.ts` (`findUserEmail`), `src/auth/auth.service.ts` (password signup sets `contactEmail`) · Tests: notifications service spec, auth service spec

**Produces:** `User.contactEmail`, `Notification.redacted`, models `SocialSignupTicket`, `SocialNonce`, `EmailVerification`; indexes `UQ_login_methods_identity`, `UQ_login_methods_user_method`.

- [ ] **Step 1 (Claude):** tests — `findUserEmail` reads `user.contactEmail` (`findUnique({ where: { id }, select: { contactEmail: true } })`) and returns null when absent; `register`/`registerMember` create the user with `contactEmail` = the login email.
- [ ] **Step 2 (user):** schema:
```prisma
model User {
  contactEmail String? @map("contact_email") @db.VarChar(255) // where notifications go
}
model UserLoginMethod {
  @@unique([method, providerUserId], map: "UQ_login_methods_identity")
  @@unique([userId, method], map: "UQ_login_methods_user_method")
}
model Notification {
  redacted Boolean @default(false) // body is a placeholder; the real text only lived in the queue job
}
model SocialSignupTicket {
  id                   String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tokenHash            String    @unique(map: "UQ_social_signup_tickets_token_hash") @map("token_hash") @db.VarChar(64)
  provider             String    @db.VarChar(20)
  providerUserId       String    @map("provider_user_id") @db.VarChar(255)
  email                String?   @db.VarChar(255)
  emailVerified        Boolean   @default(false) @map("email_verified")
  name                 String?   @db.VarChar(100)
  providerRefreshToken String?   @map("provider_refresh_token") @db.Text // encrypted
  expiresAt            DateTime  @map("expires_at") @db.Timestamptz(6)
  consumedAt           DateTime? @map("consumed_at") @db.Timestamptz(6)
  createdAt            DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  @@map("social_signup_tickets")
}
model SocialNonce {
  id         String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  nonceHash  String    @unique(map: "UQ_social_nonces_nonce_hash") @map("nonce_hash") @db.VarChar(64)
  expiresAt  DateTime  @map("expires_at") @db.Timestamptz(6)
  consumedAt DateTime? @map("consumed_at") @db.Timestamptz(6)
  createdAt  DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  @@map("social_nonces")
}
model EmailVerification {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email          String    @db.VarChar(255)
  codeHash       String    @map("code_hash") @db.VarChar(64)
  expiresAt      DateTime  @map("expires_at") @db.Timestamptz(6)
  attempts       Int       @default(0)
  verifiedAt     DateTime? @map("verified_at") @db.Timestamptz(6)
  tokenHash      String?   @unique(map: "UQ_email_verifications_token_hash") @map("token_hash") @db.VarChar(64)
  tokenExpiresAt DateTime? @map("token_expires_at") @db.Timestamptz(6)
  consumedAt     DateTime? @map("consumed_at") @db.Timestamptz(6)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  @@index([email, createdAt], map: "IDX_email_verifications_email_created")
  @@map("email_verifications")
}
```
- [ ] **Step 3 (human):** `npx prisma migrate dev --name social_login --create-only`, append to the generated SQL, then `npx prisma migrate dev`:
```sql
-- existing accounts: notifications keep going to their login email
UPDATE "users" u SET "contact_email" = lm."email"
FROM "user_login_methods" lm
WHERE lm."user_id" = u."id" AND lm."method" = 'local' AND lm."email" IS NOT NULL;
```
- [ ] **Step 4 (user):** `findUserEmail` → `user.contactEmail`; both password signups set `contactEmail: <login email>`.
- [ ] **Step 5:** `npm test` green, `tsc` 0 → commit + push.

### Task 2: Tagged `credentials` (password variant) — the breaking contract change

**Files:** Create `src/auth/dto/credentials.dto.ts` · Modify `register.dto.ts`, `register-member.dto.ts`, `auth.service.ts` · every e2e signup call + `test/helpers` · Tests: DTO spec, auth service spec

**Produces:**
```ts
export class PasswordCredentialsDto { type!: 'password'; email!: string; password!: string; }
export class SocialCredentialsDto  { type!: 'social'; signupToken!: string; contactEmail?: string; emailVerificationToken?: string; }
// on RegisterDto / RegisterMemberDto:
@ValidateNested()
@Type(() => PasswordCredentialsDto, {
  discriminator: { property: 'type', subTypes: [
    { value: PasswordCredentialsDto, name: 'password' },
    { value: SocialCredentialsDto, name: 'social' },
  ] },
  keepDiscriminatorProperty: true,
})
credentials!: PasswordCredentialsDto | SocialCredentialsDto;
```
- [ ] **Step 1 (Claude):** DTO tests — password variant valid; missing `type` / unknown `type` → 400 on `credentials`; a password field inside a social body (and vice versa) → 400 (`forbidNonWhitelisted` on the nested class); auth service tests read `dto.credentials.email/password`. In this task the `social` variant is accepted by the DTO but `AuthService` rejects it with 400 `Social signup not available yet` (wired in Task 12).
- [ ] **Step 2 (user):** implement; `ownerEmail`/`ownerPassword` and `email`/`password` move into `credentials`.
- [ ] **Step 3 (Claude):** update every e2e signup body and helper to `credentials: { type: 'password', email, password }`.
- [ ] **Step 4:** `npm test`, `tsc`; human `npm run test:e2e` (all existing suites) → commit + push.

### Task 3: Secrets, token cipher, `jose`

**Files:** `npm install jose` · Modify `package.json` (Jest `transformIgnorePatterns` += `jose`) · Create `src/common/token-cipher.ts` · Modify `src/config/env.schema.ts` + env files · Tests: `token-cipher.spec.ts`, env spec

**Produces:** `encryptToken(plain, key): string` (`base64(iv|tag|ciphertext)`), `decryptToken(stored, key): string`; env `LOGIN_TOKEN_ENCRYPTION_KEY` (32 bytes, base64), `VERIFICATION_CODE_SECRET` (≥ 32 chars).
```ts
export function encryptToken(plain: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');           // 32 bytes
  const iv = randomBytes(12);                               // GCM nonce: unique per encryption
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function decryptToken(stored: string, keyBase64: string): string {
  const data = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
}
```
- [ ] **Step 1 (Claude):** round-trip; two encryptions of the same text differ (random IV); a tampered byte → throws; a wrong key → throws; env: key must decode to exactly 32 bytes.
- [ ] **Steps 2–4:** implement → green → commit + push.

### Task 4: Redacted dispatch (secret text through the queue)

**Files:** Modify `notifications.constants.ts`, `notifications.service.ts`, `notifications.processor.ts`, `notifications.reconciler.ts` · Tests: their specs

**Produces:** `DispatchInput.redactedBody?: string`; `REDACTED_SEND_JOB_OPTIONS = { attempts: 3, backoff: { type: 'fixed', delay: 2000 }, removeOnComplete: true, removeOnFail: true }`; job data `{ notificationId, body? }`; `SEND_JOB_OPTIONS` gains `priority: 10` (unprioritized jobs run first, so codes jump the line).
- dispatch with `redactedBody`: row `body = redactedBody`, `redacted = true`; job `{ notificationId, body: input.body }` with the redacted options.
- worker: `body: job.data.body ?? notification.body`.
- reconciler: re-enqueue only `redacted: false`; mark stale redacted PENDING rows `FAILED` (`lastError: 'expired before delivery'`).
- [ ] **Step 1 (Claude):** tests for each bullet. **Steps 2–4:** implement → green → commit + push.

### Task 5: Email verification (start / confirm / consume)

**Files:** Create `src/email-verification/{email-verification.service,controller,module,constants}.ts`, `dto/*` · Modify `notification-templates.ts` (`emailVerificationCode(code)`), `app.module.ts` · Tests: service, DTO, controller specs

**Produces:** `POST /auth/email/start { email }` → `{ expiresInSeconds: 600 }`; `POST /auth/email/confirm { email, code }` → `{ emailVerificationToken, expiresInSeconds: 600 }`; `EmailVerificationService.consume(tx, { token, email }): Promise<void>` (400 on mismatch/used/expired).
- start: 60 s cooldown (429), 10 per address per 24 h (429), `code = randomInt(0, 1e6)` padded, `codeHash = HMAC-SHA256(VERIFICATION_CODE_SECRET, code)`, then `notifications.dispatch({ channel: EMAIL, eventType: 'email.verificationCode', recipientAddress: email, subject, body: template(code), redactedBody: template('******') })`.
- confirm: live row → conditional `attempts < 5` claim → `timingSafeEqual` on the HMACs → conditional issue of the token (`verifiedAt: null`) → raw token returned, SHA-256 stored.
- consume: conditional `updateMany` on `{ tokenHash, email, consumedAt: null, tokenExpiresAt > now }`.
- [ ] **Step 1 (Claude):** tests incl. "the dispatched row body never contains the code". **Steps 2–4:** implement → green → commit + push.

### Task 6: Verifier contract, fake verifier, nonces, module + env

**Files:** Create `src/social-auth/verifiers/social-identity-verifier.ts`, `fake.verifier.ts`, `src/social-auth/social-nonce.service.ts`, `social-auth.constants.ts`, `social-auth.module.ts` · Modify `env.schema.ts`, env files, `app.module.ts` · Tests: fake verifier, nonce service, env specs

**Produces:**
```ts
export type SocialProvider = 'kakao' | 'google' | 'facebook' | 'apple';
export interface SocialIdentity {
  provider: SocialProvider; providerUserId: string;
  email: string | null; emailVerified: boolean; name: string | null;
  refreshToken: string | null; // Apple/Google, plain here; encrypted before storage
}
export interface SocialIdentityVerifier {
  verify(credential: Record<string, unknown>, nonce?: string): Promise<SocialIdentity>; // 401 / 503
  disconnect(login: { providerUserId: string; refreshToken: string | null }): Promise<void>;
}
export const SOCIAL_VERIFIERS = 'SOCIAL_VERIFIERS'; // Record<SocialProvider, SocialIdentityVerifier>
```
- `SocialNonceService.issue(): Promise<{ nonce, expiresInSeconds: 300 }>` (stores SHA-256 of the nonce); `consume(nonce): Promise<boolean>` (conditional `updateMany` unconsumed + unexpired); helper `nonceClaimFor(nonce) = sha256hex(nonce)`.
- `FakeSocialVerifier.register(credentialToken, identity)`; `verify({ token })` returns it or throws 401.
- Env: `SOCIAL_VERIFIER`, `KAKAO_NATIVE_APP_KEY`, `KAKAO_ADMIN_KEY`, `GOOGLE_CLIENT_IDS` (comma-separated), `GOOGLE_CLIENT_SECRET`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH`, `APPLE_BUNDLE_ID`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`; `superRefine`: all required when `real`, production refuses `fake`.
- [ ] Steps: tests → implement → green → commit + push.

### Task 7: Kakao verifier
**Files:** `src/social-auth/verifiers/kakao.verifier.ts` + spec.
- verify `{ idToken }`: `jwtVerify(idToken, createRemoteJWKSet(new URL('https://kauth.kakao.com/.well-known/jwks.json')), { issuer: 'https://kauth.kakao.com', audience: KAKAO_NATIVE_APP_KEY })`; `payload.nonce === sha256hex(nonce)` (required); identity `{ providerUserId: payload.sub, email: payload.email ?? null, emailVerified: payload.email_verified === true }` (Kakao includes `email_verified` only if the email scope is consented); jose verification errors → 401; JWKS fetch failure → 503.
- disconnect: `POST https://kapi.kakao.com/v1/user/unlink`, header `Authorization: KakaoAK ${KAKAO_ADMIN_KEY}`, form `target_id_type=user_id&target_id=${providerUserId}`.
- [ ] Tests sign tokens with a local key pair (`generateKeyPair('RS256')` + `SignJWT`) and inject a local JWKS (`createLocalJWKSet`) — the verifier takes its key-set getter by constructor parameter so tests can swap it. Bad signature / wrong `aud` / expired / missing or wrong nonce → 401.

### Task 8: Google verifier
**Files:** `google.verifier.ts` + spec.
- verify `{ idToken, serverAuthCode }`: JWKS `https://www.googleapis.com/oauth2/v3/certs`, `issuer: ['https://accounts.google.com', 'accounts.google.com']`, `audience: GOOGLE_CLIENT_IDS`; nonce checked only if the token has one; then `POST https://oauth2.googleapis.com/token` (`grant_type=authorization_code, code, client_id=<web client id>, client_secret`) → `refresh_token`. Exchange failure → 503; a 400 `invalid_grant` → 401.
- disconnect: `POST https://oauth2.googleapis.com/revoke` (form `token=<refresh token>`).

### Task 9: Apple verifier
**Files:** `apple.verifier.ts` + spec.
- client secret: an ES256 JWT `{ iss: APPLE_TEAM_ID, iat, exp: +5 min, aud: 'https://appleid.apple.com', sub: APPLE_BUNDLE_ID }`, header `kid: APPLE_KEY_ID`, signed with the `.p8` key (`importPKCS8`).
- verify `{ identityToken, authorizationCode, fullName? }`: JWKS `https://appleid.apple.com/auth/keys`, `issuer: 'https://appleid.apple.com'`, `audience: APPLE_BUNDLE_ID`, nonce required; `email_verified` may be the string `"true"`; name from `fullName` (first sign-in only); exchange at `POST https://appleid.apple.com/auth/token` → `refresh_token`.
- tests: a credential **without `fullName`** (every sign-in after the first) still verifies, with `name: null`; `email_verified` given as the string `"true"` or boolean `true` both count.
- disconnect: `POST https://appleid.apple.com/auth/revoke` (`client_id, client_secret, token, token_type_hint=refresh_token`).

### Task 10: Facebook verifier
**Files:** `facebook.verifier.ts` + spec.
- iOS `{ authenticationToken }`: JWKS `https://limited.facebook.com/.well-known/oauth/openid/jwks/`, `issuer: 'https://www.facebook.com'`, `audience: FACEBOOK_APP_ID`, nonce required.
- Android `{ accessToken }`: `GET https://graph.facebook.com/debug_token?input_token=…&access_token=${APP_ID}|${APP_SECRET}` → require `data.is_valid && data.app_id === FACEBOOK_APP_ID`; then `GET https://graph.facebook.com/me?fields=id,name,email&access_token=…`; email (if present) counts as verified.
- disconnect: `DELETE https://graph.facebook.com/${providerUserId}/permissions?access_token=${APP_ID}|${APP_SECRET}`.

### Task 11: Social sign-in (`LOGGED_IN` / `SIGNUP_REQUIRED`)
**Files:** `social-auth.service.ts`, `social-auth.controller.ts`, `dto/social-sign-in.dto.ts` + specs.
**Produces:** `POST /auth/social/nonce`, `POST /auth/social/:provider` (public, 200); `AuthService.issueSessionFor(userId)` (extracted from `issueTokens`, exported for social); `SocialAuthService.signIn(provider, body)`.
- consume the nonce first (when given/required) → verify → find `UserLoginMethod { method: provider, providerUserId }` with its live user → login rules (`CAN_AUTHENTICATE`, not deleted) → update `refreshToken` (encrypted) + `lastLoginAt` → `{ status: 'LOGGED_IN', …tokens, user }`; else create a ticket (raw token returned, SHA-256 stored, `providerRefreshToken` encrypted) → `{ status: 'SIGNUP_REQUIRED', signupToken, expiresInSeconds: 900, profile }`.

### Task 12: Social signup (`credentials.type = 'social'`)
**Files:** Modify `auth.service.ts` + spec · `SignupTicketService.consume(tx, token): Promise<Ticket>`.
- tests: **two concurrent signups with the same ticket** → exactly one user (the conditional `updateMany` gives the loser `count: 0` → 400); a P2002 on `UQ_login_methods_identity` → 409; Apple ticket without email (second-and-later sign-in) → requires the code-verified `contactEmail`.
- in the signup transaction: phone token → ticket (conditional `updateMany` on `{ tokenHash, consumedAt: null, expiresAt > now }`, then read it) → contact email (ticket email if `emailVerified`; else `credentials.contactEmail` + `EmailVerificationService.consume`; else 400) → create user (`contactEmail`) + `UserLoginMethod { method: provider, providerUserId, email, emailVerified, refreshToken }`. A P2002 on `UQ_login_methods_identity` → 409 `This account is already registered`.

### Task 13: Login methods (list / link / link-local / unlink)
**Files:** `login-methods.service.ts`, `login-methods.controller.ts` + specs (routes under `/users/me/login-methods`, logged in, no permission).
- list → `[{ id, method, email: method === 'local' ? maskEmail(email) : null }]`.
- link `:provider` (same body + nonce) → verify → 409 if the identity belongs to another user (`UQ_login_methods_identity`) or the user already has this provider (`UQ_login_methods_user_method`) → create.
- link `local` `{ email, password, emailVerificationToken }` → consume email token → email unused by any local login (409) → hash → create.
- unlink `:id` → own row (404 otherwise) → count of the user's methods = 1 → 409 → delete → best-effort `verifiers[method].disconnect(…)` (decrypting the refresh token) with a logged warning on failure.

### Task 14: Find-my-ID providers, e2e, docs
**Files:** Modify `account-recovery.service.ts` + spec · Create `test/social-auth.e2e-spec.ts` (phone suite 15) · `STATUS.md`, `CLAUDE.md`.
- find-ID → `{ email: masked local email | null, providers: string[] }`.
- e2e (`SOCIAL_VERIFIER=fake`): SIGNUP_REQUIRED → owner social signup with a verified provider email → LOGGED_IN; member social signup with a typed email verified via the code read from Mailpit (and the `notifications` row body contains `******`, not the code); link Apple → list shows it; link an identity owned by someone else → 409; unlink until one remains → 409; find-ID lists providers; a reused signup ticket → 400; a reused nonce → 401.
