# Social Login (Kakao · Google · Facebook · Apple) — Design

**Date:** 2026-10-09
**Status:** approved in brainstorm; spec under review.
**Sub-project 1 of 2.** Sub-project 2 (self-service account deletion incl. owners → company closure, and provider disconnect at deletion) gets its own spec; this one stores what it needs.

---

## Goal

Let users sign up and sign in with **Kakao, Google, Facebook and Apple** from the React Native (Expo) app with **native app-to-app login** (KakaoTalk app, the system Google sheet, the Face ID Apple sheet, the native Facebook SDK) — never a webview — and let signed-in users **link and unlink** providers in settings. Email + password login stays.

## Decisions (from the brainstorm)

| Topic | Decision |
|---|---|
| Providers | Kakao, Google, Facebook, Apple (iOS). Naver dropped. Apple is mandatory on iOS when other third-party logins are offered (App Store guideline 4.8) |
| Architecture | **Native SDK on the phone → our backend verifies each provider's credential itself → our own JWTs.** No Firebase Auth / Supabase broker: app-to-app only comes from the native SDKs anyway; a broker would add a second user store and key our users by the broker's ids, making a later broker migration painful |
| Session system | Unchanged (access/refresh JWTs, rotation + reuse detection, logout, device-token removal, pending-may-log-in rule) |
| Scope | Social **signup and login**, plus **link/unlink** in settings |
| Account matching | **Never** auto-merge by email (unverified Kakao emails, Apple relay addresses → account takeover risk). A duplicate person hits "phone already registered" in OCTOMO and is told to log in and link |
| Contact email | The provider's email if it shares a **verified** one; otherwise the user types one, **verified by an emailed 6-digit code**. Stored as `User.contactEmail`; notifications use it |
| Signup handshake | Two steps with a **stored, single-use signup ticket** (`SIGNUP_REQUIRED` → signup with the ticket) |
| Signup contract | **Tagged `credentials` sub-object** on the existing register endpoints: `{ type: 'password', … } \| { type: 'social', … }` (breaking change to the request body; existing DTOs and e2e helpers are updated in the same task) |
| Nonce | Required where the provider supports it (Apple, Kakao OIDC, Facebook iOS Limited Login); for Google, enforced when the token carries one |
| Disconnect | Built now as `disconnect()` per provider; used by **unlink** (best-effort) and later by sub-project 2's deletion. Apple + Google need a stored **user refresh token** (captured at sign-in); Kakao + Facebook use app credentials + the provider user id |
| Google client library | Left to the React Native work; it **must** return an `idToken` **and** a `serverAuthCode` (offline access) |

## Client (React Native / Expo) — for reference

Native modules require an Expo **development build** (`expo prebuild` / EAS), not Expo Go.

| Provider | Library | Sends to the backend |
|---|---|---|
| Kakao | `@react-native-seoul/kakao-login` (config plugin; OIDC enabled in the Kakao console) | `{ idToken }` |
| Google | chosen during RN work (e.g. `@react-native-google-signin/google-signin` with `offlineAccess: true`) | `{ idToken, serverAuthCode }` |
| Apple | `expo-apple-authentication` | `{ identityToken, authorizationCode, fullName? }` (name arrives only on the first sign-in) |
| Facebook | `react-native-fbsdk-next` (iOS: Limited Login, required since FB iOS SDK 17) | iOS `{ authenticationToken }` · Android `{ accessToken }` |

Nonce: the app calls `POST /auth/social/nonce`, passes `SHA-256(nonce)` to the provider SDK, and sends the raw `nonce` with the credential.

## Architecture

```
app: native SDK → provider credential
app: POST /auth/social/:provider { credential, nonce? }
api: SocialIdentityVerifier[provider].verify() → SocialIdentity
     ├─ known (UserLoginMethod(method = provider, providerUserId)) → our tokens
     └─ unknown → SocialSignupTicket → SIGNUP_REQUIRED
app: signup screens (owner/member, OCTOMO phone, contact email)
app: POST /auth/register | /auth/register/member { …, credentials: { type: 'social', signupToken, … } }
```

- **`SocialAuthModule`**: the verifiers, nonces, signup tickets, email verification, and linking. **`AuthService`** remains the only place that creates users and issues tokens — social and password signup share one core, so signup and session rules can't drift.
- **`SocialIdentityVerifier`** (one per provider, behind a token like `PHONE_VERIFIER`; `SOCIAL_VERIFIER=real|fake`, production refuses `fake`):
  ```ts
  interface SocialIdentityVerifier {
    verify(credential, nonce?): Promise<SocialIdentity>;     // { provider, providerUserId, email, emailVerified, name, refreshToken? }
    disconnect(login: { providerUserId: string; refreshToken?: string }): Promise<void>;
  }
  ```

| Verifier | verify() | disconnect() |
|---|---|---|
| Kakao | `idToken` signature vs Kakao JWKS (`iss` kauth.kakao.com, `aud` native app key), nonce | unlink with the **Admin Key** + Kakao user id |
| Google | `idToken` vs Google JWKS (`aud` ∈ our client ids); exchange `serverAuthCode` at `oauth2.googleapis.com/token` → **refresh token** | `oauth2.googleapis.com/revoke` with the refresh token |
| Apple | `identityToken` vs Apple JWKS (`aud` = bundle id), nonce; exchange `authorizationCode` at `appleid.apple.com/auth/token` (client secret = JWT signed with our `.p8`) → **refresh token** | `appleid.apple.com/auth/revoke` with the refresh token |
| Facebook | iOS: `authenticationToken` vs Facebook JWKS (Limited Login), nonce. Android: Graph `debug_token` (token issued to **our** app, valid) then `/me` for the id | remove the app's permissions with app credentials + the app-scoped user id |
| Fake (e2e) | returns the identity the test registered | records the call |

JWT checks use **`jose`** (`createRemoteJWKSet` caches provider keys): signature, `iss`, `aud`, `exp`, nonce.

## Endpoints

| Route | Auth | Behavior |
|---|---|---|
| `POST /auth/social/nonce` | public | `{ nonce, expiresInSeconds: 300 }`; stored hashed, single-use |
| `POST /auth/social/:provider` | public | verify → `200 { status: 'LOGGED_IN', accessToken, refreshToken, user }` or `200 { status: 'SIGNUP_REQUIRED', signupToken, expiresInSeconds: 900, profile: { email, emailVerified, name } }` |
| `POST /auth/register` · `POST /auth/register/member` | public | body carries `credentials` (tagged union, below) |
| `POST /auth/email/start` · `POST /auth/email/confirm` | public | emailed 6-digit code → `emailVerificationToken` |
| `GET /users/me/login-methods` | logged in | `[{ id, method, email? (masked for local) }]` |
| `POST /users/me/login-methods/:provider` | logged in | link (same body as social login); 409 if the identity belongs to another account or the user already has this provider |
| `POST /users/me/login-methods/local` | logged in | `{ email, password, emailVerificationToken }` — add a password to a social-only account; email code-verified and unused by any other local login |
| `DELETE /users/me/login-methods/:id` | logged in | own rows only; **409 if it is the last one**; best-effort `disconnect()` at the provider |

`:provider` ∈ `kakao | google | facebook | apple`.

### Signup body (tagged `credentials`)

```jsonc
// owner
{ "companyName": "…", "taxId": "…", "ownerName": "…", "ownerPhone": "…", "ownerPhoneVerificationToken": "…",
  "credentials": { "type": "password", "email": "owner@acme.com", "password": "…" } }
// or
  "credentials": { "type": "social", "signupToken": "…", "contactEmail": "…?", "emailVerificationToken": "…?" }
// member: same, with joinCode / name / phone / phoneVerificationToken
```
class-transformer `@Type(() => …, { discriminator: { property: 'type', … } })` + `@ValidateNested`; each variant is strict (`forbidNonWhitelisted`), unknown `type` → 400.

Social login of a **known** identity applies the same status rules as `/auth/login`, refreshes the stored provider refresh token (Apple/Google) and `lastLoginAt`, then issues our tokens.

Password signup sets `contactEmail` to the login email.

Social signup transaction: spend the phone token → spend the signup ticket (conditional `updateMany`) → spend the email token if given → create the user (`contactEmail`) + `UserLoginMethod(method = provider, providerUserId, email, emailVerified, refreshToken)`. Contact email = ticket email if `emailVerified`, else `contactEmail` + a valid `emailVerificationToken` (else 400).

### Find-my-ID and password reset

- Find-my-ID → `{ email: masked local email | null, providers: ['kakao', 'apple'] }` so a social-only user learns how they sign in.
- Password reset is unchanged (local login only).

## Data model

- **`UserLoginMethod`** (existing columns): `method` = `local | kakao | google | facebook | apple` (string, validated in code); social rows use `providerUserId`, `email`, `emailVerified`, and `refreshToken` (**encrypted**, Apple + Google). New indexes:
  - `@@unique([method, providerUserId])` — one provider identity → one account (local rows have NULL, never conflict)
  - `@@unique([userId, method])` — one login per provider per account
- **`User.contactEmail String?`** — where notifications go; migration backfills it from each user's local login email; `findUserEmail` reads it.
- **`SocialSignupTicket`**: `id, tokenHash (unique), provider, providerUserId, email?, emailVerified, name?, providerRefreshToken? (encrypted), expiresAt (+15 min), consumedAt?, createdAt`.
- **`SocialNonce`**: `id, nonceHash (unique), expiresAt (+5 min), consumedAt?, createdAt`.
- **`EmailVerification`**: `id, email, codeHash (HMAC, VERIFICATION_CODE_SECRET), expiresAt (+10 min), attempts (max 5), verifiedAt?, tokenHash? (unique), tokenExpiresAt?, consumedAt?, createdAt`; 60 s resend cooldown + daily cap per address (we *send* email, so anti-spam limits apply).

## Errors

| Situation | Response |
|---|---|
| Credential invalid / expired / wrong audience / bad signature / nonce missing, reused or mismatched | 401 `Invalid social credential` |
| Provider unreachable (keys, Graph, code exchange) | 503 |
| Signup ticket invalid / expired / used | 400 `Invalid or expired signup token` |
| Unverified provider email and no `emailVerificationToken` | 400 `A verified contact email is required` |
| Link: identity linked elsewhere, or provider already on this account | 409 |
| Unlink the last login method | 409 `An account needs at least one way to sign in` |
| Email code: cooldown / daily cap / attempts | 429 / 429 / 400 |
| Disconnect fails during unlink | logged; unlink succeeds |

## Security

- Every credential is verified server-side (signature, `iss`, `aud`, `exp`, nonce); Facebook Android tokens via `debug_token` against **our** app.
- Apple + Google refresh tokens encrypted with AES-256-GCM (`LOGIN_TOKEN_ENCRYPTION_KEY`); key rotation out of scope.
- Session rules identical to password login (pending may log in; suspended / deleted → 401).
- New env, validated at boot: `SOCIAL_VERIFIER`, `KAKAO_NATIVE_APP_KEY`, `KAKAO_ADMIN_KEY`, `GOOGLE_CLIENT_IDS`, `GOOGLE_CLIENT_SECRET`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_PATH`, `APPLE_BUNDLE_ID`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `LOGIN_TOKEN_ENCRYPTION_KEY`, `VERIFICATION_CODE_SECRET` (provider keys required only when `SOCIAL_VERIFIER=real`).

## Testing

- Verifier unit tests sign tokens with a **locally generated key pair** (`jose`) and point the verifier at it — real signature / `aud` / `exp` / nonce failures, no network; HTTP (Graph, code exchanges, disconnects) via mocked `fetch`.
- Service: LOGGED_IN vs SIGNUP_REQUIRED, single-use ticket and nonce, consumption order in the signup transaction, link/unlink rules (last method, linked elsewhere), encryption round-trip.
- DTO: the tagged `credentials` union (password / social; mixed or unknown `type` → 400).
- e2e (`FakeSocialVerifier`): SIGNUP_REQUIRED → social signup as owner and as member → LOGGED_IN; link / unlink / 409s; find-ID lists providers; the email code read from **Mailpit**; password signup still works in the new `credentials` shape across every suite.

## Out of scope

- Account deletion and company closure (sub-project 2; uses `disconnect()` and the stored refresh tokens).
- Naver.
- A database-level unique index on local login emails (needs a partial index via raw SQL — its own task).
- Web sign-in (redirect URIs, web client ids) — the RN app first.
- Encryption key rotation.
