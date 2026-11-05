# Four Front Doors, One Lock

> I added "Sign in with Kakao, Google, Facebook and Apple." The hard part wasn't the providers. It was deciding what my server should trust, and making the database (not my code) the final judge of every race.

*2026-11-03*

## Intro

[Inventra](https://github.com/develoHAM/inventra_backend) is a multi-tenant inventory SaaS built on **NestJS 11 + Prisma 7 + PostgreSQL**, modeled on the Korean concession-store world: companies run "corners" inside department stores, and owners, managers and staff keep stock in sync.

This track added **social login with four providers**: Kakao, Google, Facebook and Apple. The mobile app (React Native / Expo) uses each provider's **native SDK**, so a tap opens KakaoTalk or Face ID and comes straight back, with no webview. My backend checks the proof itself and issues its own tokens.

It ran across **14 tasks in about three and a half weeks**: signup, sign-in, linking and unlinking login methods, emailed verification codes, and find-my-ID that finally helps social-only users. The unit suite grew from 536 to **880** tests, plus a new end-to-end suite that walks the whole journey over real HTTP.

## Architectural Decisions

### 1. No broker: my backend verifies the providers directly

**The goal:** app-to-app login (no "crappy webview"), and accounts that stay mine whatever happens to a vendor.

**The options:**
- **Firebase Auth or Supabase Auth** as a broker: the app signs in to the broker, and my server trusts the broker's token.
- **A web OAuth redirect flow** through the system browser.
- **Native SDKs in the app, verification on my server:** the app sends the provider's proof, and my backend checks it and issues its own JWTs.

**The choice:** native SDKs plus my own verification.

**The reason:**
- **App-to-app login needs each provider's native SDK anyway.** A broker would still need them, so it would only add a hop.
- **With a broker, every user is keyed to the broker's identity.** Migrating away later would mean remapping every account.
- **The providers already speak a standard** (OpenID Connect), so "verify it myself" turned out to be a few hundred lines, not a project.

**The result:** login ends in exactly the same place as password login: `AuthService.issueSessionFor(userId)`, our access and refresh tokens. No third service sits in the middle.

### 2. One interface, four verifiers, and a fake for tests

**The goal:** four providers that prove identity four different ways, without the rest of the app knowing which one it's talking to.

**The options:** a `switch (provider)` wherever it matters; or the **adapter pattern**, with one shape and one class per provider.

**The choice:** one interface, implemented four times:
```ts
export interface SocialIdentityVerifier {
  verify(credential: Record<string, unknown>, nonce?: string): Promise<SocialIdentity>;
  disconnect(login: { providerUserId: string; refreshToken: string | null }): Promise<void>;
}
```
`SocialIdentity` is the common language: `{ provider, providerUserId, email, emailVerified, name, refreshToken }`.

**The reason:** each provider's quirks stay in its own file:
- **Kakao's ID token has no `email_verified` claim,** so I ask Kakao's admin API instead.
- **Apple has no fixed client secret.** I sign a fresh ES256 JWT with my `.p8` key for every call.
- **Facebook on Android sends an opaque access token,** which Facebook itself must check (`debug_token`, which must say the token is for *my* app).
- **Google returns a refresh token only on the first consent.**

**The result:** an injection token holds a `Record<SocialProvider, SocialIdentityVerifier>`, built once at startup from `SOCIAL_VERIFIER=real|fake`. Because it's a `Record`, the compiler refuses a map that forgets a provider. In tests, a `FakeSocialVerifier` gives each provider its own view, so a "Kakao" token even fails on the Google route, like the real thing.

### 3. Check signatures offline with `jose`, and know which failure is whose

**The goal:** prove "Kakao says this is user 4012345678, signing in **to Inventra**," quickly and without trusting the request.

**The options:** send every token to the provider to ask if it's valid; use each provider's server SDK; or verify the token's **signature** locally against the provider's published public keys (JWKS).

**The choice:** `jose`'s `jwtVerify` against a cached `createRemoteJWKSet`, with plain REST + `fetch` for the few calls that need a server. I use this for all four providers; only Google even has an official Node SDK for this.

**The reason:**
- **A signature check is math, not a network call.** The keys are cached, so most logins call no provider at all.
- **The checks are the same everywhere:** RS256 only, issuer, **audience** (a token issued to some *other* app must not log in here), and expiry.
- **One pattern for four providers** beats one SDK for one of them.

**The result:** one shared `verifyIdToken` that also decides **whose fault** a failure is:
- a bad token → **401**, so the app restarts the login
- the provider's key server unreachable → **503**, so the app retries

Extras such as Kakao's email lookup and the Google/Apple refresh-token exchange **fail soft**: sign-in still works, and the extra value is `null` or "unverified."

### 4. Nonces: a token is good for one sign-in only

**The goal:** a leaked ID token (Kakao's are valid for 12 hours on mobile) must not let someone else log in.

**The choice:**
1. The app gets a random **nonce** from `POST /auth/social/nonce` and gives its **SHA-256 hash** to the provider SDK.
2. The provider seals that hash into the signed token.
3. The app sends us the token **plus the raw nonce.**
4. We **spend** the nonce (single-use, 5 minutes), *then* check that the token's claim is SHA-256 of it.

**The reason:**
- **Spending the nonce stops replays:** the same nonce never works twice.
- **Matching the claim stops swaps:** an old token can't be paired with a fresh nonce.
- **Only the hash is inside the token,** so a leaked token doesn't reveal the value we require.

**The result:** a stolen token is useless. A replayed request is rejected before any provider is even contacted.

### 5. Two-step signup through a single-use ticket, and never match by email

**The goal:** a first-time social user still needs the rest of our signup (a verified phone, a company or a join code), which happens in a *later* request.

**The options:**
- re-send the provider credential at signup
- create a half-finished account at sign-in
- hand back a **signup ticket**

**The choice:** an unknown identity gets `SIGNUP_REQUIRED` with a 15-minute **signup ticket**: a random token whose SHA-256 is stored with "this provider proved this person." Signup goes through the **existing** register endpoints, with a tagged `credentials` object (`{ type: 'password', … }` or `{ type: 'social', signupToken, … }`) validated by a class-transformer discriminator.

**The reason:**
- **The ticket carries the proof safely across requests,** the same "spend once" pattern as our phone tokens.
- **We never link accounts by email.** If a Google account happens to use the same email as an existing user, logging it into that account would be an **account takeover**. An unknown identity always means signup.

**The result:** one register endpoint per role, two credential types, and phone + ticket + (optional) email proof all spent in **one transaction**. A failure anywhere leaves every proof unspent, so the user can simply retry.

### 6. Contact emails proven by code, sent through the queue with the code redacted

**The goal:** notifications need a real inbox, but Apple (after the first sign-in) and some Kakao users share no verified email.

**The choice:** the provider's verified email, **or** an address the user types and proves with a 6-digit code (`POST /auth/email/start` / `confirm`), **or** a 400. Codes are stored as an HMAC, with a 60 s cooldown (plus `retryAfterSeconds` so the app can show a countdown), 10 per day and 5 attempts.

**The reason:** I wanted every notification to go through the queue, but a queued row stores its text, which would put the code in the database in plain text. So the row stores `******`, and the real text rides only inside the BullMQ job (deleted on completion *and* on failure). The reconciler never replays such a row; it marks it failed.

**The result:** the e2e suite reads the real code from Mailpit, then checks that the `notifications` row holds `******` and never the code.

### 7. Let the database judge races: conditional writes, never caught errors

**The goal:** the same Kakao identity signing up twice at the same instant (two tickets, a double tap) must produce exactly one account.

**The options:**
- check first, then insert (two requests can both pass the check)
- insert and **catch** Postgres's unique-violation error (Prisma `P2002`)
- a **conditional insert** that reports duplicates as a count

**The choice:** conditional inserts: `createMany({ skipDuplicates: true })`, which becomes `INSERT … ON CONFLICT DO NOTHING`, then `count === 0` → 409. Where I need the new row back, `createManyAndReturn` gives an empty array instead.

**The reason:**
- **I first wrote the error-catching version, and it worked.** But recognising the right `P2002` meant digging into Prisma 7's error object. With the pg adapter the columns live at `meta.driverAdapterError.cause.constraint.fields`, not the `meta.target` most guides mention. That's a shape that can move in any release.
- **A count is boring and stable,** and it matched the pattern the codebase already used for single-use tokens (`updateMany` with the condition in `where`).

**The result:** it's now a project rule, recorded in `CLAUDE.md`: **unique indexes enforce, the count tells.** When a link is refused, a read *afterwards* only explains which rule fired, so the message is accurate without reopening the race.

### 8. "Never remove the last login," and the race a conditional write can't catch

**The goal:** unlinking must never leave an account with zero ways to sign in.

**The problem:** two devices unlinking a user's last **two** logins at the same moment both count "2," and both delete. No unique rule is involved, because each request deletes a *different* row (what databases call "write skew").

**The choice:** make both requests touch one shared row first. A write to the user's own row (`user.updateMany({ … updatedAt })`) takes its **row lock**, so the second unlink waits, then counts **1**, then gets a 409.

**The result:** I tested it against Postgres with two simultaneous unlinks. **Without the lock: 0 logins left. With it: one 409, one login left.** The provider disconnect (Kakao unlink, Google/Apple revoke, Facebook de-authorize) runs after the commit, best-effort, so a provider outage can't hold the lock or undo the unlink.

### 9. Lowercase emails, a *partial* unique index, and a migration I had to rescue

**The goal:** `Jane@Acme.com` and `jane@acme.com` are one inbox, and one password-login email belongs to one account.

**The choice:**
- **Lowercase every email at the door:** one `normalizeEmail` used by every DTO, by provider emails, and by the seed. A data migration fixed the rows already stored, and refuses to run if two password logins would collide.
- **Make the database enforce one account per password-login email** with a *partial* unique index, `UNIQUE (email) WHERE method = 'local'`. Provider rows can share an email, but password rows can't.

**What went wrong, twice:**
1. **I edited a migration after the user had applied it.** `migrate dev` reported "divergence" and offered to *reset the database*. I restored the file byte-for-byte, matching the checksum in `_prisma_migrations`, and moved the change into a new migration. Rule learned: an applied migration is never edited.
2. **Prisma kept "fixing" the index.** Postgres stores the condition as `((method)::text = 'local'::text)`; Prisma compared that text with its own `("method" = 'local')`, saw a difference, and generated a DROP + identical CREATE on every `migrate dev`. That junk migration's UTC timestamp sorted **before** the real one, so fresh databases failed with "index does not exist." The fix: write the predicate exactly as Postgres stores it, `where: raw("((method)::text = 'local'::text)")`, and confirm with `migrate diff` → "empty migration."

**The result:** password signup and "add a password" now rely on the index through the same conditional insert as everything else.

## TIL (Today I Learned)

**"Is app X our app, or the provider?"**
Ours. In OAuth terms, Inventra is the **client**, the user is the **resource owner**, and the provider runs the **authorization server** and **resource server**. "Issued for another app" in an `aud` check means another registered *client*.

**"How does Kakao verification work in production? I thought we use the admin key to verify the user."**
The admin key verifies nothing. It can look up *any* of my users by ID, so it can't prove who is holding the phone. The proof is the **signature** on the ID token, checked locally with Kakao's public key. The admin key comes in only *after* the identity is proven, to ask whether that user's email is verified.

**"What exactly are we caching, and why?"**
Only the provider's **public key list** (JWKS), not tokens or users. `jose` refreshes it after 10 minutes, and refetches early when a token names an unknown key, which is how key rotation works. It also enforces a 30 s cooldown, so made-up key IDs can't make me hammer Kakao.

**"Why no salt on the nonce hash? And how do you verify a salted password at all?"**
Salt protects *guessable* inputs from precomputed tables. A 32-byte random nonce isn't guessable, and its hash must be reproducible from the raw value alone, both to find its row and to match the token's claim. For passwords, argon2 stores the salt *inside* the hash string, and `verify` reuses it. (Encryption has no salt at all: AES-GCM uses an **IV**, which must never repeat with the same key.)

**"Instead of relying on errors for duplicates, is there another way?"**
Yes: `skipDuplicates` (`ON CONFLICT DO NOTHING`) reports a duplicate as `count: 0`. A check-first approach can't replace the unique index, because two requests can't see each other's uncommitted rows. Only the database sees both.

**"What do you mean by 'password-login emails'? Users have several logins."**
Exactly: one table, one row per way to sign in. On a `local` row the email *is* the login ID; on a provider row it's just information. That's why the unique rule had to be partial.

**"I don't like `nonce` and `:provider` on the same path level."**
Fair: a route like `/auth/social/:provider` also matches `/auth/social/nonce` if it's declared first. Moving the provider into the body (`POST /auth/social/login { provider, … }`) removed the whole class of problem.

**"Is there a provider SDK for this, or only REST?"**
For the server side, only Google has an official Node library (`google-auth-library`). Kakao, Apple and Facebook document their server side **as** REST APIs. I kept REST + `jose` for all four, so there's one pattern to read and test.

**"How did we close the race for social logins?"**
Two pieces: a database rule (the unique `(method, provider_user_id)` index) and an insert that asks "unless it exists." The second request **waits** at the index until the first commits, then inserts nothing. There's no check-first gap to slip through.

**"`isRedacted` isn't a `JobsOptions` field, so how can it be used there?"**
It isn't passed to BullMQ. `...(isRedacted ? A : B)` is evaluated by *my* code before the call, and only the chosen object's properties are spread in. A key named `isRedacted` would fail type-checking; the expression just picks.

## NestJS Concepts & Libraries

| Concept / library | Why we used it |
|---|---|
| `jose` (`jwtVerify`, `createRemoteJWKSet`, `SignJWT`, `importPKCS8`, typed `errors`) | verify ID tokens offline; sign Apple's client secret; tell 401 from 503 |
| OpenID Connect + OAuth 2.0 | the standards all four providers follow (ID tokens, codes, revoke) |
| Injection token + `useFactory` + `Record<SocialProvider, Verifier>` | real or fake verifiers per environment, with an exhaustive map |
| class-transformer discriminator (`@Type` with `subTypes`) | one `credentials` field, two validated shapes |
| `@Transform(normalizeEmail)` | lowercase every email before validation |
| `node:crypto` (`randomBytes`, SHA-256, HMAC, `timingSafeEqual`, AES-256-GCM) | nonces, tickets, code hashes, encrypted refresh tokens |
| Prisma `createMany` / `createManyAndReturn` `{ skipDuplicates }` | race-proof inserts reported as counts |
| Prisma interactive transactions + `Prisma.TransactionClient` | spend phone token, ticket and email proof together, or not at all |
| Prisma partial indexes (preview) with `raw()` | one account per password-login email, without perpetual drift |
| Prisma nested `select` with `orderBy` | find-my-ID reads the user and all their logins in one query |
| BullMQ job data + `removeOnFail` | send the code without storing it in the notifications table |
| `Test.createTestingModule().overrideModule()` | a wiring test that builds the real module graph, minus Redis |
| Mailpit HTTP API in e2e | read real emailed codes; assert what actually left the app |
| `ParseUUIDPipe` | a malformed login-method id is a 400, not a database error |

## Wrap-up

The track delivered:
- **sign-in and signup with Kakao, Google, Facebook and Apple**, verified by my own backend
- **nonces and single-use signup tickets**, so a leaked token is useless
- **contact emails proven by code**, sent through the queue without ever storing the code
- **login methods**: link a provider, add a password, unlink (never the last one)
- **lowercase emails** and **one account per password-login email**, enforced by the database
- **find-my-ID that answers "you use Kakao"** instead of a dead end
- an **end-to-end suite** that walks the whole journey, including two signups racing for one identity

The lesson I'll keep: whenever two requests can collide, the database should be the judge. My code should ask it a question (a conditional insert, a row lock) and read a plain answer, not parse its error messages.

Next up: **account deletion and company closure**. It reuses this track's provider `disconnect`s (Apple requires a revoke on deletion) and raises the hardest question yet: what happens to a company when its owner leaves?
