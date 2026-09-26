# Inventra — Project Status & Handoff

> Living status doc. Read this first when resuming (especially on a different machine).
> Last updated: 2026-09-14.

**Inventra** = multi-tenant inventory-management SaaS (Korean concession-store model — companies operate "corners" inside physical stores).
**Stack:** NestJS 11 · Prisma 7 (driver adapters, client generated to `src/generated/prisma`) · PostgreSQL · Jest + supertest · npm.

---

## Phase progress

| Phase | Scope | State |
|-------|-------|-------|
| 0 | Infra: Docker Compose, Zod env validation, Prisma modern setup | ✅ complete |
| 1 | Auth: register (owner + member self-signup via join code), login, JWT access/refresh rotation + reuse detection | ✅ complete (blogged) |
| 2 | Authz: `PermissionsGuard` (RBAC) + `OwnershipService` tenant scoping (`companyId`) | ✅ complete (blogged) |
| 3 | Product catalog (categories, brands, products) | ✅ complete (blogged) |
| 4 | Stores & Corners (venues + company corners, manager/staff assignment) | ✅ complete (blogged) |
| 5 | **Product placement** (`CompanyStoreProduct` — products on a corner's shelf) | ✅ complete (blogged) |
| 6 | **Inventory transactions** (ledger + running balance, one atomic write) | ✅ complete (blogged) |
| 7 | **Restock orders** (request document: header + line items, nested CRUD) | ✅ complete (blogged) |
| 8 | **Inventory audits** (physical count doc → atomic apply reconciles stock) | ✅ complete (blogged) |
| 9 | **Purchase reservations** (hold stock for a customer; fulfill = release + sale) | ✅ complete (blogged) |
| 10a | **Reservation auto-expiry sweep** (`@nestjs/schedule` cron releases expired holds) | ✅ complete (blogged) |
| 10b+ | More cross-cutting concerns / Redis caching (only when measured) | ⏳ not started |
| Files | **File uploads** (product/brand/avatar images) + **data import/export** (order/audit CSV·xlsx) | ✅ Slices 1–3 complete |
| Notify | **Notifications** (email · SMS · push) + **account security** (phone OTP · find ID · password reset) | 🔨 Slice 1a complete; 1b next |

## Where we are right now — Notifications, Slice 1a complete (foundation + email)

New track, designed in `docs/superpowers/specs/2026-09-23-notifications-and-account-security-design.md` (slices 1a → 1b → 2 → 3 → 4). Decisions: fixed channels per event (in code); **domain events + BullMQ queue**; SMTP via nodemailer with **Mailpit** for dev/e2e; SMS via a Korean provider adapter (Slice 2); push via FCM (Slice 4); a verified phone is **required + unique** at signup; password reset and find-my-ID use an **SMS one-time code**; find-my-ID returns a masked email.

**Slice 1a ✅ — the whole pipeline, proven with `company.approved` → email to the owner:**
- Flow: `UsersService.approveCompany` writes, then `eventEmitter.emit('company.approved', { companyId, ownerUserId })` → `NotificationsListener` (`@OnEvent`) resolves the owner's email + renders the Korean template → `NotificationsService.dispatch()` writes a `Notification` row (`PENDING`) **then** `queue.add('send', { notificationId })` → `NotificationsProcessor` (`@Processor`, `WorkerHost`) loads the row, sends via `EmailChannel` (nodemailer), marks `SENT`; on failure records `attempts`/`lastError`, sets `FAILED` only on the last attempt, and rethrows so BullMQ retries (3 attempts, exponential 5 s). Unknown job names → `UnrecoverableError`.
- `Notification` table (+ `notification_channel` / `notification_status` enums). Env: `REDIS_HOST`, `BULLMQ_PREFIX` (`inventra` / `inventra-test` — dev and e2e share one Redis), `SMTP_*`. Redis now runs with `--appendonly yes`.
- **233 unit tests green (25 suites) + 87 e2e green (10 suites)**, incl. `test/notifications.e2e-spec.ts` (polls until the row is `SENT`, then checks Mailpit's API).
- ⚠️ **Gotchas:** (1) `@nestjs/event-emitter` 12, `@nestjs/bullmq` 12, its transitive `@nestjs/bull-shared`, and `nodemailer` 10 are **ESM-only** → added to the unit Jest `transformIgnorePatterns` (e2e loads them natively). (2) **BullMQ 6 made `ioredis` an optional peer** — without it every queue/worker fails to connect in a tight loop, which OOM'd Jest; `ioredis` is now a direct dependency. (3) **e2e now needs Redis + Mailpit running** (the app boots BullMQ), in addition to Postgres + MinIO.

**Next — Slice 1b:** the remaining email events (`company.registered` → admins, `member.joinRequested` → owner, `member.approved` → member, `order.created` / `audit.applied` / `stock.belowTarget` → corner manager + owner), plus **emit-after-commit** plumbing for events raised inside `$transaction` (stock alerts fire only on the crossing below target), and a reconciliation cron that re-enqueues stale `PENDING` rows. Plan: write `docs/superpowers/plans/…-notifications-slice-1b-….md` first.

## Prior — File-upload + import/export track complete (Slices 1–3)

New parallel track (from the two-item todo: *Prisma 8 migration* + *file uploads*). **Prisma 8 is blocked upstream** — no GA client/adapter yet (only `8.0.0-rc` / dev); revisit when a stable `@prisma/client` + `@prisma/adapter-pg` v8 ship together. So the file-upload subsystem went first.

**MinIO** (self-hosted, S3-compatible object store) added as a Docker service; the app talks to it via the AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`). A **`@Global() StorageModule`** exposes **`StorageService`** (`src/storage/`): `putObject`, `presignPutUrl`, `presignGetUrl`, `objectExists`, `deleteObject`, plus an `onModuleInit` bucket-ensure (HeadBucket → CreateBucket on miss). Env (Zod-validated): `S3_ENDPOINT / S3_REGION / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET / S3_PRESIGN_EXPIRY_SECONDS`.

**Slice 1 — product image** ✅. Object keys are `products/<productId>/<uuid>.<ext>`; the DB stores the **key**, and reads **presign-on-read** (return a fresh presigned GET URL each time). Two upload paths: **proxied** (`POST /products/:id/image`, multer `FileInterceptor` + `ParseFilePipe` — 5 MB + jpeg/png/webp) and **presigned** (`…/image/presign` → client PUTs bytes straight to MinIO → `…/image/confirm` validates key-prefix + object-exists). All gated `products.update`; old image deleted on replace. Single `imageUrl` for now (multi-image = future `ProductImage` child table).
- ⚠️ **MinIO creds gotcha (cost an entire e2e run):** `docker compose` reads `${MINIO_ROOT_*}` from **`.env`** (its default env file), so that's what the container boots with; the e2e process signs with **`.env.test`**'s `S3_*`. If those secrets diverge → `SignatureDoesNotMatch` at `onModuleInit` in **every** e2e suite (StorageService is `@Global()`, so it boots app-wide, not just in the uploads suite). Keep the two files' MinIO secret aligned.
- **`.env.test` uses its own bucket** `inventra-files-test` (isolated from dev's `inventra-files`); `onModuleInit` auto-creates it on first boot.
**Slice 2 — brand logo + user avatar** ✅. Same pattern reused. **Brand logo** (`BrandsService`/`BrandsController`, gated `brands.update`, integer id via `ParseIntPipe`, key `brands/<id>/<uuid>.<ext>`). **User avatar is self-service**: `POST /users/me/avatar[/presign|/confirm]` with **no `@RequirePermissions`** — the target is always `caller.id` (no `:id` param), so editing another user is *unrepresentable*; the global `JwtAuthGuard` (`APP_GUARD` in `auth.module.ts`) still authenticates. The presign/confirm DTOs were extracted to shared `src/storage/dto/` (`PresignUploadDto`, `ConfirmUploadDto`); products keeps its local copies (optional later retrofit). No migration/seed/permission changes — `logoUrl` / `profileImageUrl` columns and the `*.update` perms already existed.
- Slice 2 shipped with full e2e green (`test/uploads.e2e-spec.ts` covers product + brand + avatar).

**Slice 3a — order/audit CSV·xlsx export** ✅. **Reframed:** the "order/audit file" turned out to be **data interchange, not a stored attachment** — it does *not* use `StorageService`/presign/`fileUrl`. `GET /corners/:cornerId/{orders/:orderId,audits/:auditId}/export?format=csv|xlsx&lang=en|ko` (default csv+en, gated `*.read`, corner-scoped) streams a flat denormalized sheet (one row per line item, header repeated) via `StreamableFile`. A shared **`@Global() SpreadsheetService`** (`exceljs`, `src/spreadsheet/`) emits both formats from one workbook. **Localized headers** (EN/KO): columns are `{ key, label: { en, ko } }`; the stable `key` is the import anchor. Audit export includes `appliedAt`. No migration/seed/permission changes.
- **198 unit tests green** (21 suites) + order/audit export e2e (csv default, `lang=ko`, xlsx, bad-format/lang → 400) — full e2e green.

**Slice 3b — order/audit CSV·xlsx import** ✅. `POST /corners/:cornerId/{orders,audits}/import` (create, gated `*.create`, 201) and `…/{orders/:orderId,audits/:auditId}/import` (update, gated `*.update`, 200). `SpreadsheetService.parse` reads both formats into a `string[][]` grid (xlsx `load` needs a cast at exceljs's stale `Buffer` type — types-only). Each service reads columns **by position**, looked up in the shared `*_EXPORT_COLUMNS` (so localized headers don't matter); validates **header-field consistency** (every row must repeat the first row's title/description/date — one file = one order/audit); resolves `productBarcode` → placement on the corner in two batched queries; and **collects every row error** into one `400 { message: 'Import failed', errors: [{ row, error }] }` (row = sheet line; nothing written). On success it **reuses the existing `create`/`update`** write path — so update-import onto an applied audit → 409. Format from file extension; ≤10 MB. The sheet's id column is never used (update target comes from the URL). Spec: `docs/superpowers/specs/2026-09-19-order-audit-import-design.md`; plan: `…/plans/2026-09-19-order-audit-import.md`.
- **210 unit tests green** (21 suites) + order/audit import e2e (create, error-list 400, update, applied-audit 409) — **86 e2e green across 9 suites**.

**The file-upload + import/export track is complete** — images (product/brand/avatar) and data interchange (order/audit CSV·xlsx export + import). Later candidates (on real need only): Prisma 8 migration (once a stable v8 client + `@prisma/adapter-pg` ship), Redis caching (measure first), rate limiting, observability/metrics, OpenAPI docs.

## Prior — Phase 10a complete (reservation auto-expiry sweep)

Phases 0–9 done, tested, blogged. Phase 10a (first slice of cross-cutting concerns) done, tested, and blogged. It closes the loop Phase 9 left open: `expiresAt` was stored but nothing released expired holds.
- **`@nestjs/schedule`** added; `ScheduleModule.forRoot()` in `AppModule`. A **`ReservationExpiryService`** (in the reservations module) runs `@Cron(EVERY_MINUTE) sweepExpired()`.
- **Claim-then-release, safe by construction.** For each `RESERVED` reservation past `expiresAt`, in its own `$transaction`: a **guarded `updateMany`** claim (`status: RESERVED → EXPIRED`, stamps new `expiredAt` column) — `count === 0` means a concurrent sweep/fulfill/cancel already handled it, skip; else `recordWithinTransaction(RESERVATION_RELEASE)` (reserved→available), actor = `reservation.createdByUserId` (source=RESERVATION + EXPIRED status disambiguate it from a manual release). One bad row can't stall the rest.
- Migration `20260909162034_reservation_expired_at` added `expired_at`. No new permissions (background job, no HTTP surface). `sweepExpired()` is directly callable — the e2e invokes it via `app.get(...)`.
- **⚠️ Prisma/ESM gotchas** (both resolved, worth remembering): (1) briefly upgraded the `prisma` CLI to an **8.0.0-rc** while `@prisma/client` stayed 7 — a CLI/client major mismatch; reverted to matched **v7**. (2) `@nestjs/schedule` v12 is **ESM-only**, so the **unit** jest config transforms it to CJS (`transformIgnorePatterns: ["node_modules/(?!@nestjs/schedule)"]`, no vm-modules), while the **e2e** loads it as native ESM under `--experimental-vm-modules` (which Prisma 7's WASM query compiler also needs) — opposite handling in the two jest configs.
- **170 unit tests green** + `test/reservations.e2e-spec.ts` extended (**63 e2e green across 8 suites**).

## Historical — Phase 9 (purchase reservations)

Phase 9 adds **purchase reservations** — hold a customer's stock, convert the hold to a sale on pickup. It's the first phase to *extend* the Phase 6 effect map (the `reserved` bucket) and the third `recordWithinTransaction` caller.
- **Reservation = single row** (`PurchaseReservation`: one placement + `reservedQuantity` + customer `reservedByName`/`Phone`), corner-scoped. Migration `20260908124337_reservations_reserve_types_created_by` added `created_by_user_id` + the two enum values.
- **Hold on create.** Creating a reservation moves stock `available → reserved` (guarded `RESERVATION_HOLD`; **insufficient available → 409**) and starts it `RESERVED`. **Fulfill** = `RESERVATION_RELEASE` + `SALE` → `FULFILLED` (so *every* purchase is a `SALE`; reserved-origin ones tagged `source=RESERVATION`). **Cancel** = `RESERVATION_RELEASE` → `CANCELLED`. Fulfill/cancel on a non-`RESERVED` reservation → 409. `PENDING`/`EXPIRED` defined but unused (deferred).
- **Effect map extended.** `Bucket` gained `reservedQuantity`; two new cross-bucket, guard-first effects `RESERVATION_HOLD` (available→reserved) / `RESERVATION_RELEASE` (reserved→available), reusing `SALE`. Invariant: the `reserved` bucket = sum of active reservations.
- **Corner-level resource** (revised from placement-nested mid-build): `POST/GET /corners/:cornerId/reservations` (companyStoreProductId in the create body; GET corner-wide with optional `?companyStoreProductId`/`?status` filters — the counter's pickup view), `…/:reservationId/fulfill|cancel`. RBAC `reservations.{create,read,fulfill,cancel}`, all to OWNER/MANAGER/STAFF. **48 permissions**. No soft-delete (terminal statuses instead). `createdByUserId` added; transition-actors live in the ledger (source=RESERVATION).
- **166 unit tests green** + `test/reservations.e2e-spec.ts` (**62 e2e green across 8 suites**) — passed first run.

The reservation auto-expiry sweep (Phase 10a, above) was Phase 9's deferred job.

**Next — Phase 10b onward: remaining cross-cutting concerns.** No concrete forced next slice — the domain feature set is complete. Candidates: Redis caching (roadmap says *only when a measured need appears* — don't build speculatively), rate limiting, observability/metrics, API docs (OpenAPI). Pick based on an actual need. Start any new slice with `/brainstorming` → spec → plan → per-task build.
- ⚠️ e2e reminder: `npm run test:e2e`'s `pretest` runs `prisma migrate reset --force`, blocked by Claude's Prisma AI-guard — **a human must run it**. Claude runs `npm test` fine.
- ⚠️ Two jest configs handle the ESM-only `@nestjs/schedule` differently — see Phase 10a notes above before touching test config.

## Roadmap after Phase 6 (historical)

Phases 0–6 are done and tested (Phase 6 blog pending). Phase 6 moves real stock through a single centralized, oversell-safe write:
- **Stock split.** `CompanyStoreProduct` (cold placement config) now 1:1-owns `CompanyStoreProductStock` (hot balances) via a shared PK/FK (`company_store_product_id`). Splitting the hot fact from the cold dimension keeps the frequently-mutated balance rows narrow (less MVCC/WAL churn) and the placement metadata cache-stable. The stock row is created with the placement (nested `stock: { create }`) and inherits its soft-delete lifecycle.
- **Four buckets** on the stock row sum to the physical count: `availableQuantity` (renamed from `currentQuantity`), `reservedQuantity`, `sampleQuantity`, `damagedQuantity` (new). `targetStockQuantity` also lives here now.
- **17 transaction types → an effect map** (`src/inventory/inventory-effects.ts`): each type is a `delta` (±buckets, with a `primaryBucket` the ledger's before/after tracks) or a `set` (ADJUSTMENT overwrites `availableQuantity`). Cross-bucket moves (BREAKAGE available→damaged, SAMPLE_ALLOCATION available→sample) list the decrement first.
- **The atomic engine** (`InventoryService.record`): one `$transaction` appends an immutable `InventoryTransaction` (ledger) **and** moves the balance. Decrements use a **guarded `updateMany`** (`where: { [bucket]: { gte: q } }`) → `count === 0` ⇒ `ConflictException` (409), the oversell guard. `record(caller, cornerId, placementId, dto, source?)` — the optional `source` (type+id) is for later phases (orders/audits) to stamp provenance; it's not in the DTO.
- **Nested API** — `GET/POST /corners/:cornerId/products/:placementId/transactions`, RBAC `transactions.read`/`transactions.create`, ownership via `assertWorksCorner` (writes) / `findOne` (reads). **35 permissions** now.
- **Errors:** 400 (quantity < 1 or bad enum) · 403 (foreign manager) · 404 (absent placement / other tenant) · 409 (oversell).
- **140 unit tests green** + `test/inventory.e2e-spec.ts` (**39 e2e green across 5 suites**).

**Next — Phase 7: orders.** First consumer of `InventoryService.record(...source)` — an order line stamps its `sourceType`/`sourceId` onto the ledger as it moves stock. Start with `/brainstorming` → spec → plan → per-task build.
- ⚠️ e2e reminder: `npm run test:e2e`'s `pretest` runs `prisma migrate reset --force`, blocked by Claude's Prisma AI-guard — **a human must run it**. Claude runs `npm test` fine.

## Roadmap after Phase 6
Orders → audits → purchase reservations → cross-cutting concerns → Redis caching (only when a measured need appears).

---

## Working conventions (how we collaborate)
- **Teaching-first:** the user is learning NestJS; explain concepts and framework fundamentals as we build — the "why", not just the "what".
- **Per-task flow (Phase 2/3):** (1) teach the concepts → (2) give requirements → (3) provide full reference code → (4) Claude writes the test files and runs them. **The user writes the production code; Claude owns the tests.**
- **Checkpoints auto-commit:** when a checkpoint is reached (unit/e2e tests green, a feature/task complete), Claude commits with a descriptive message and pushes to `origin/main` without being asked. Verify green first; never commit known-broken code; surface anomalies instead of blindly committing. Commit messages end with the `Co-Authored-By: Claude` trailer.
- **Phase-end:** offer the bilingual EN+KR Medium-style `/phase-blog` retrospective.

## Resume on a new machine
The DB, secrets, and generated client are **not** in the repo. After `git pull`:
1. `npm install`
2. Recreate the gitignored env files (copy from the other laptop): **`.env`** and **`.env.test`** (both now carry the `MINIO_*` + `S3_*` block). `DATABASE_URL` must **not** include `sslmode=require` for the local container. Keep each file's `MINIO_ROOT_PASSWORD` and `S3_SECRET_KEY` equal — a mismatch triggers `SignatureDoesNotMatch` on boot.
3. `docker compose up -d` (postgres + redis + **minio** + **mailpit** — MinIO console at `localhost:${MINIO_CONSOLE_PORT}`, Mailpit inbox at `localhost:${MAILPIT_UI_PORT}`). The app and **every** e2e suite need Redis up (BullMQ connects at boot).
4. `npx prisma generate` (client generates into `src/generated/prisma`, which is gitignored)
5. `npx prisma migrate deploy` then `npm run seed` (or `npx prisma migrate reset --force` which also seeds via `prisma/seed.ts`)
6. `npm test` (unit — should be 233 green across 25 suites) and `npm run test:e2e` (87 green across 10 suites, incl. uploads, order/audit CSV·xlsx export/import, and notifications via Mailpit)

Latest migration: `prisma/migrations/20260909162034_reservation_expired_at`. **Keep the `prisma` CLI + `@prisma/client` + `@prisma/adapter-pg` all on the same major (v7); don't bump to the v8 RC.**

## Key references in-repo
- `docs/superpowers/specs/2026-09-07-phase-9-purchase-reservations-design.md` — Phase 9 design (latest full spec; Phase 10a was built directly from an in-session design, no spec file)
- `docs/superpowers/plans/2026-09-07-phase-9-purchase-reservations.md` — Phase 9 implementation plan
- `docs/superpowers/specs/` + `docs/superpowers/plans/` — Phase 1–9 specs & plans
- `blog/en` + `blog/ko` — Phase 1–9 + 10a retrospectives
- `prisma/schema.prisma` — single source of truth for the data model
