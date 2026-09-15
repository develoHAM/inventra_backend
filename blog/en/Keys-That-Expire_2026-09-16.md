# Keys That Expire

> Storing the key, not the URL — how Inventra learned to hold files with MinIO, presigned URLs, and a self-service twist.

*2026-09-16*

## Intro

[Inventra](https://github.com/develoHAM/inventra_backend) is a multi-tenant inventory-management SaaS built on **NestJS 11 + Prisma 7 + PostgreSQL**, modeled on the Korean concession-store world (companies operate "corners" inside physical stores). By now the domain is basically complete — products, placements, stock ledgers, orders, audits, purchase reservations. What it *couldn't* do was hold a single picture.

This phase built the **file-upload subsystem**: a reusable storage foundation, then image uploads for three different entities — a **product image**, a **brand logo**, and a **user avatar**. Along the way I learned that the hardest part of file uploads isn't the upload. It's deciding what you store, who's allowed to touch it, and how a "simple" config typo can take down an entire test suite.

## Architectural Decisions

### 1. Where do the bytes live? → MinIO (S3-compatible), not the database

**The goal:** somewhere to put user-uploaded images that survives restarts and scales beyond one box.

**The options:**
- Store the bytes as a `bytea` column in Postgres.
- Write files to the server's local disk.
- Use AWS S3 directly.
- Run **MinIO** — a self-hosted, S3-compatible object store — in Docker.

**The choice:** MinIO locally, talked to via the **AWS SDK v3** (`@aws-sdk/client-s3`).

**The reason:** blobs in Postgres bloat the hot tables and the WAL; local disk doesn't survive a container or scale horizontally. MinIO speaks the *exact* S3 API, so the same code that runs against MinIO on my laptop runs against real AWS S3 in production — zero code change, just different env vars. I get cloud parity for free and keep the database lean.

**The result:** a single `@Global() StorageModule` exposing a `StorageService` with `putObject`, `presignPutUrl`, `presignGetUrl`, `objectExists`, and `deleteObject`. Every future slice just injects it.

### 2. Store the **key**, presign on read — never store a URL

**The goal:** serve images that are private by default.

**The options:**
- Make the bucket public and store a plain URL in the DB.
- Store a long-lived signed URL.
- Store only the object **key** (`products/<id>/<uuid>.png`) and generate a fresh presigned GET URL every time someone reads the row.

**The choice:** store the key; **presign on read**.

**The reason:** a stored URL is a liability. A public URL means the file isn't private. A long-lived signed URL goes stale the moment it expires — and if you make it not expire, you've just built a public URL with extra steps. The *key* is the only thing that's genuinely stable. Presigning on read means every response carries a short-lived, private link signed with the current credentials and expiry.

**The result:** the DB column (`imageUrl` / `logoUrl` / `profileImageUrl`) holds a canonical key; reads swap it for a fresh presigned URL that carries an `X-Amz-Signature`. Private by construction.

### 3. Two ways in: proxied *and* presigned

**The goal:** let clients upload, and validate what they send.

**The options:** proxied (bytes flow through the API), presigned (client PUTs straight to MinIO), or both.

**The choice:** both.

**The reason:** the proxied path (`POST /.../image`) is dead simple and lets the API validate the file inline — `ParseFilePipe` with a `MaxFileSizeValidator` (5 MB) and a `FileTypeValidator` (jpeg/png/webp) rejects junk before it's ever stored. The presigned path (`presign → client PUTs to storage → confirm`) takes the byte stream *off* the API entirely, which matters for big files and scale. The trade-off is that the server never sees the bytes, so `confirm` re-establishes trust: it checks the key is under the right prefix and that the object actually exists.

**The result:** flexibility without losing safety. Small clients use the one-shot proxied route; heavier ones use the presigned handshake.

### 4. Self-service avatars: make the wrong thing *unrepresentable*

**The goal:** let a user set their own avatar — and *only* their own.

**The options:**
- `POST /users/:id/avatar`, gated by a `users.update` permission and company-scoping.
- `POST /users/me/avatar`, where the target is always the caller.
- Both.

**The choice:** self-service only. The route has **no `:id`** and **no `@RequirePermissions`**.

**The reason:** this is the decision I'm proudest of. With no `:id` parameter, there is no route shape that even *accepts* another user's id — editing someone else's avatar isn't *forbidden*, it's **unrepresentable**. That's a stronger guarantee than an authorization check, because there's no check to get wrong. The endpoint leans on the global `JwtAuthGuard` for authentication (so you must be logged in), and every method targets `caller.id` from the token.

**The result:** zero cross-tenant surface, zero new permissions, and a `confirm` guard that still pins the key to `users/<caller.id>/`.

### 5. One shared pair of DTOs

The presign body (`{ contentType }`) and confirm body (`{ key }`) are identical for products, brands, and users. Rather than copy them a third time, I lifted them into `src/storage/dto/` as `PresignUploadDto` / `ConfirmUploadDto`. Products keeps its local copies for now — retrofitting tested code mid-slice buys nothing. YAGNI cuts both ways.

## TIL (Today I Learned)

### Why default the file extension to `'bin'`?

The key builder does `const ext = IMAGE_EXT[contentType] ?? 'bin'`. I asked: when does `'bin'` ever happen? Answer: **never, today.** Both entry points already reject non-image types before this line runs — `FileTypeValidator` on the proxied path, `@IsIn([...])` on the presigned DTO. So `'bin'` is a *fail-safe*, not a live branch: the `IMAGE_EXT` map and the allow-list are two lists that must agree, and if they ever drift (someone adds `image/gif` to one but not the other), the fallback produces a well-formed `.bin` key instead of a broken `.undefined`. It's one token of insurance against a future maintenance footgun.

### A one-character credential typo took down *every* e2e suite

I ran the e2e suite and watched **all of it** fail — reservations, inventory, audits, orders — none of which touch files. Every stack trace bottomed out at the same line: `StorageService.onModuleInit`, throwing `SignatureDoesNotMatch`.

The cause: `docker compose` reads MinIO's root credentials from `.env` (its default env file), but the test process signs its requests with `.env.test`'s `S3_SECRET_KEY`. The two had drifted — one said `letsmakesomemoney98$`, the other said `minioadmin`. MinIO recomputes the signature with *its* secret, the two HMACs don't match, and the request is rejected.

But why did it take down suites that never upload anything? Because `StorageModule` is `@Global()`, so `StorageService` boots in *every* module's `AppModule`, and its `OnModuleInit` bucket-ensure runs during `app.init()` — before any test body. **A global module's boot-time side effect is shared failure surface.** Fixing the one secret turned everything green.

### If S3 overwrites on the same key, why upload-then-delete?

I assumed I could just PUT to the same key to replace an image. S3 *does* overwrite — but we deliberately generate a **new UUID** for every upload (`products/<id>/<uuid>.png`), so keys are effectively immutable. Why? Because presigned URLs and any CDN in front of them cache *by key*. Reuse the key and a viewer can keep seeing the old image from cache long after you replaced it. A fresh key sidesteps caching entirely and makes the swap atomic — write the new object, point the row at it, then delete the old one.

### `eslint --fix` fixes *everything*, not the one thing you meant

I wanted to enforce verbose object literals (`{ id: id }`, not `{ id }`) project-wide, so I added the `object-shorthand` rule and ran `npm run lint` — which is `eslint … --fix`. It expanded the shorthand *and* silently stripped 35 `as any` casts from my tests (via a `no-unnecessary-type-assertion` rule that had never been run). Lesson: `--fix` applies the *entire* ruleset's autofixes. For a targeted, one-off transformation, run a minimal throwaway config with only the rule you want — and review the diff before committing.

## NestJS Concepts & Libraries

| Concept / Library | Why we used it |
|---|---|
| `@Global()` module | Expose `StorageService` app-wide without re-importing `StorageModule` in every feature module. |
| `OnModuleInit` | Ensure the bucket exists once, at boot (HeadBucket → CreateBucket on miss). |
| `FileInterceptor` (`@nestjs/platform-express`) | Parse a multipart `file` field from the request (multer under the hood). |
| `ParseFilePipe` + `MaxFileSizeValidator` + `FileTypeValidator` | Declarative, per-route upload validation — size + MIME — before the handler runs. |
| `@UploadedFile()` | Inject the parsed file into the handler. |
| `APP_GUARD` + `JwtAuthGuard` | Global authentication — why a route with *no* `@RequirePermissions` is still logged-in-only. |
| `@aws-sdk/client-s3` | S3 operations (put / head / delete / create-bucket) against MinIO. |
| `@aws-sdk/s3-request-presigner` (`getSignedUrl`) | Generate presigned PUT/GET URLs — signed locally, no network round-trip. |
| `ConfigService` + Zod env schema | Typed, validated access to `S3_ENDPOINT`/`S3_BUCKET`/etc. |
| `ParseIntPipe` vs `ParseUUIDPipe` | Brands use integer ids; products/users use UUIDs — the pipe enforces the right shape. |
| ESLint `object-shorthand: 'never'` | Enforce the verbose-object-literal house style going forward. |

## Wrap-up

Two slices in, Inventra has a reusable storage foundation and can attach a private, presigned image to a product, a brand, and a user — the last one self-service by design. The recurring theme was **what you persist**: store the key, not the URL; generate a fresh key, don't reuse one; represent "only yourself" in the *route shape*, not just a guard.

**Next — Slice 3: order and audit files.** This is where it gets interesting: the files are still private and presigned, but an audit that's already been **applied** is frozen history — so the guard has to refuse attaching a document to a finalized audit, the same way it already refuses editing one. Immutability, all the way down.
