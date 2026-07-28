# Two Guards, Two Tokens, and a Join Code: Building Inventra's Auth Layer

*How Phase 1 of a multi-tenant inventory SaaS got its authentication and authorization — with every design decision made on purpose.*

**2026-07-29**

## Intro

[Inventra](https://github.com/) is a multi-tenant inventory-management SaaS modeled on the Korean concession-store world, where brands run "corners" inside larger stores. Phase 1 built the foundation everything else stands on: **authentication** (who are you?) and **authorization** (what may you do?).

By the end I had local email/password login, access + refresh JWTs with rotation and theft detection, a role-based permission system with per-user overrides, two onboarding flows (company owners and their staff), and a platform super-admin — all covered by **52 unit tests and a 12-step end-to-end test**. This is the story of the *decisions*, not just the code.

## Architectural Decisions

### 1. Access + refresh tokens, not one long-lived token

- **Goal:** Sessions that stay usable for days but can be revoked and don't leave a stolen token dangerous for long.
- **Options:** (a) one long-lived JWT; (b) short access token only, re-login on expiry; (c) short **access** + long **refresh**.
- **Choice:** Access token (15m) + refresh token (7d), signed with **two separate secrets**.
- **Reason:** A stolen access token is useless in 15 minutes, and the refresh token — the long-lived credential — is sent only to `/auth/refresh`, so it's exposed far less. Two secrets mean a leaked access secret can't forge refresh tokens.
- **Result:** Short exposure windows for the token that travels on every request, plus a revocable, rotatable long session.

### 2. Refresh tokens: hashed, rotated, and reuse-detected

- **Goal:** Contain the damage if a refresh token leaks.
- **Options:** stateless refresh (no DB); store the raw token; store a **hash**, rotate on use, and watch for replays.
- **Choice:** Store the **SHA-256 hash**, make each refresh token **single-use** (revoke the old, issue a new one on every refresh), and if an *already-revoked* token is presented, **revoke the entire family** and reject.
- **Reason:** Hashing means a database leak exposes no usable tokens. Rotation shrinks a stolen token's lifetime from "7 days" to "until the user next refreshes." And the revoked-token tripwire is the key insight — I *soft-revoke* (set `revokedAt`) instead of deleting, so a replayed token is distinguishable from a random invalid one and signals theft.
- **Result:** A leaked refresh token is useful for one rotation at most, and a replay attack triggers a full logout of that user.

```ts
if (stored.revokedAt) {
  // a revoked token was replayed → treat as theft
  await this.prisma.refreshToken.updateMany({
    where: { userId: stored.userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  throw new UnauthorizedException('Refresh token reuse detected');
}
```

### 3. SHA-256 for refresh tokens, argon2id for passwords

- **Goal:** Use the *right* hash for each job.
- **Options:** one algorithm for both; or a different one per use case.
- **Choice:** **argon2id** for passwords, **SHA-256** for refresh tokens.
- **Reason:** Passwords are low-entropy and human-chosen, so I want a *deliberately slow, salted* hash to make brute-forcing painful. Refresh tokens are already long random high-entropy strings, so guessing is a non-issue — what I need there is a **fast, deterministic** fingerprint I can look up in the DB. argon2's random salt would actually *break* lookup, because the same token would hash differently every time.
- **Result:** Brute-force-resistant password storage and fast, deterministic refresh-token lookup — each hash doing what it's good at.

### 4. Member onboarding via a company join code (the redesign)

This one I changed mid-build after questioning my first design.

- **Goal:** Let managers and staff join an existing company.
- **Options:** (a) an insider creates the account (`POST /users`); (b) the applicant picks the company from a public list; (c) a **company join code** the owner shares.
- **Choice:** Self-signup with a **join code**, then owner-approval that assigns the role. `POST /users` dropped entirely.
- **Reason:** A stranger self-registering has no company yet, so they must *name* one — and a public directory would leak every tenant, while a raw company-ID picker invites spam. A join code resolves to exactly one company via a shared secret, with no directory exposure. And since the join-code flow plus approval fully covers onboarding, a second insider-create path was a YAGNI violation.
- **Result:** One clean, tenant-safe onboarding path; membership is always *granted from inside*, never *requested from outside*.

### 5. A nullable role — "no role" means "not a member yet"

- **Goal:** Represent someone who signed up but isn't yet an approved member.
- **Options:** default new members to `STAFF`; or make `role_id` nullable.
- **Choice:** **Nullable `role_id`.** A self-registered member is role-less until the owner assigns a role at approval.
- **Reason:** "No role" cleanly encodes "not yet a real member," and it makes approval the single moment where identity *and* privilege are both granted. As a bonus, my permission resolver returns an empty set for a null role — defense in depth.
- **Result:** Honest state modeling instead of a placeholder role that lies about a user's status.

### 6. Bootstrapping the circular FK — user-first

- **Goal:** Create a company and its owner, which reference each other (`companies.created_by_user_id` ↔ `users.company_id`).
- **Options:** deferrable FK constraints; insert against a pre-seeded admin as a temporary anchor; **user-first**, using the nullable `company_id`.
- **Choice:** Create the owner with `company_id = NULL` → create the company pointing at that user → update the user's `company_id`, all in one transaction.
- **Reason:** Because I'd already made `company_id` nullable (the platform admin belongs to no company), the user can exist momentarily company-less — no deferrable constraints, no admin anchor, and it's atomic.
- **Result:** A clean, all-or-nothing registration that satisfies both foreign keys without any exotic database features.

### 7. PENDING users authenticate but can't act

- **Goal:** Let a just-registered owner into the client to see a "pending approval" screen, without giving them any real power.
- **Options:** PENDING can't log in at all; PENDING gets full access; or PENDING **authenticates but is gated**.
- **Choice:** Split the two concerns. `JwtAuthGuard` lets `PENDING` and `ACTIVE` authenticate (rejecting only terminal/soft-deleted). `PermissionsGuard` requires `ACTIVE` on any route that demands a permission. `GET /auth/me` requires no permission, so a PENDING user can reach it.
- **Reason:** Authentication ("who you are") and activation ("may you act yet") are genuinely different questions, so they deserve different gates.
- **Result:** A pending owner logs in, `/auth/me` reports `PENDING_APPROVAL`, the client shows the waiting screen, and every real action returns `403` until an admin flips them to `ACTIVE`.

### 8. Two global guards, order enforced

- **Goal:** Make protection the default, not something you remember to add.
- **Options:** per-route `@UseGuards`; or global guards via `APP_GUARD`.
- **Choice:** Two global `APP_GUARD`s — `JwtAuthGuard` then `PermissionsGuard` — with `@Public()` to opt out.
- **Reason:** Default-on security means a new route is protected unless it *explicitly* declares otherwise. `PermissionsGuard` depends on the user that `JwtAuthGuard` attaches, so order matters — and NestJS resolves `APP_GUARD` order from module import order, so `AuthModule` is imported before `AuthorizationModule`.
- **Result:** Every route is authenticated-and-authorized by default; forgetting a guard fails *safe*, not open.

### 9. Token transport: request body, not httpOnly cookies

- **Goal:** Get tokens to and from clients.
- **Options:** refresh token in an `httpOnly; Secure; SameSite` cookie (best for a web SPA); or tokens in the request body/`Authorization` header.
- **Choice:** **Request body / header.**
- **Reason:** It's the classic XSS-vs-CSRF tradeoff. Cookies protect the refresh token from XSS but need CSRF and CORS handling and only suit browsers. Body/header transport is **client-agnostic** (web, mobile, server-to-server) and **CSRF-immune**, at the cost of the web client having to store the refresh token carefully. Since Inventra's client type isn't locked in, I chose the uniform, simpler option and documented the trade-off to revisit.
- **Result:** One API shape for all clients, no cookie/CSRF machinery — with a conscious note to move to httpOnly cookies if a browser SPA becomes primary.

## TIL (Today I Learned)

Honest questions I hit while building this:

**How does Node's `createHash` actually work?** It doesn't hash in one call — it returns a *Hash object* you feed and finalize: `createHash('sha256').update(token).digest('hex')`. The second arg to `createHash` is an options object, not a key — my first attempt returned the unfinalized object instead of the digest string.

**`sub` vs `subject` in JWT options?** `sub` is the *claim* (goes in the payload); `subject` is a sign *option* that sets that claim for you. They end up in the same place, and `jsonwebtoken` throws if you set both. I kept `sub` in the payload alongside my custom claims.

**How does the `ValidationPipe` know which DTO to build?** From the controller handler's parameter — `@Body()` marks the source, and the *type annotation* (`dto: LoginDto`) is read at runtime via `emitDecoratorMetadata` as `metadata.metatype`. The pipe is registered once, globally, but rediscovers the right DTO per parameter.

**Where does `class-validator` get wired in? I never referenced it in config.** It's implicit: `ValidationPipe` imports `class-validator` and `class-transformer` directly (they're peer deps), and each `@IsEmail()`-style decorator registers a rule into a shared metadata registry that `validate()` reads at request time. No config line connects them — the coupling lives inside the pipe.

**What does `{ provide: APP_GUARD, useClass: JwtAuthGuard }` do?** It registers a global guard *built by the DI container*, so the guard can inject `Reflector`, `TokenService`, `PrismaService`. Doing `new JwtAuthGuard()` in `main.ts` would force me to hand-construct all its dependencies.

**`imports` vs `providers` vs `exports` in a module?** `imports` takes **modules**; `providers`/`exports` take **services**. You never import a service directly — you import the *module* that exported it. It's just like a TypeScript file's `import`/`export`, but for the DI container.

**Can Prisma's `create`/`update` return `null`?** No — they **throw** on failure (`update` throws `P2025` if the row is missing). Only `findUnique`/`findFirst` return `null`. So no null-checks around writes, but the `findUnique` role lookup did need one (I used `findUniqueOrThrow`).

**`return await` vs `return promise` in a controller?** Nest awaits both, so for a plain pass-through they're equivalent. But `await` matters if you have a `try/catch` (a non-awaited return escapes the block before it rejects) and gives better async stack traces.

**Prisma 7 + Jest e2e: "dynamic import callback invoked without `--experimental-vm-modules`."** Prisma 7 loads its query engine via a dynamic `import()` at connect time. Unit tests mock Prisma so never hit it; the e2e boots the real client and does. The fix was running Jest through `node --experimental-vm-modules`.

## NestJS Concepts & Libraries

| Concept / Library | Why we used it |
|---|---|
| **Modules & DI** | Wire services, controllers, and global guards; scope what's visible where |
| **Guards** (`CanActivate`, `ExecutionContext`) | Enforce authN then authZ before handlers run |
| **`APP_GUARD`** | Register guards globally so protection is default-on |
| **Custom decorators** (`SetMetadata`, `createParamDecorator`) | `@Public()`, `@RequirePermissions()`, `@CurrentUser()` |
| **`Reflector`** | Read route metadata the decorators attached |
| **Pipes** (`ValidationPipe`) | Validate + sanitize request bodies before handlers |
| **class-validator / class-transformer** | Declarative DTO rules + turning bodies into typed instances |
| **@nestjs/jwt** | Sign/verify access & refresh tokens |
| **argon2** | Slow, salted password hashing |
| **node:crypto** | `randomUUID` (jti) + `createHash` (SHA-256 token fingerprints) |
| **Prisma 7** | `$transaction`, nested writes, driver adapters, migrations |
| **Jest + supertest** | Isolated unit tests (mocked) + real-HTTP e2e |

## Wrap-up

Phase 1 delivered a complete, tested auth layer: identity and tokens, a two-layer guard pipeline, RBAC with per-user overrides, join-code onboarding, an approval lifecycle, and the PENDING gate — proven end-to-end against a real database. More than the code, it forced me to make each decision *on purpose*, and the tests earned their keep by catching real bugs (a `jti` mismatch, a missing reuse check, an unwired module).

Next up is **Phase 2**: a request-scoped `OwnershipService` that turns "you have permission to do X" into "you have permission to do X *to this specific record in your tenant*" — the scope half of authorization. See you there.
