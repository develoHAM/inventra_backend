# File Uploads — Slice 2: Brand Logo + User Avatar (Design)

> Spec for the second slice of the file-upload subsystem. Slice 1 (storage foundation + product image) is complete; this slice reuses `StorageService` and the presign-on-read pattern for two more entities. Slice 3 (order file + audit file) follows.

**Date:** 2026-09-15
**Depends on:** Slice 1 — `StorageService`, `@Global() StorageModule`, MinIO/S3 config (`docs/superpowers/specs/2026-09-10-file-uploads-storage-product-image-design.md`).

---

## Goal

Let a company attach a **logo to a brand** and a user attach an **avatar to their own profile**, reusing the exact storage pattern established for product images: store the object **key** in the DB, return a fresh **presigned GET URL** on every read, and offer both a **proxied** upload (bytes through the API) and a **presigned** upload (client PUTs straight to MinIO, then confirms).

## Why this is mostly mechanical (and what isn't)

The storage mechanics are identical to products, so the bulk is reuse. Three things differ and drive the design:

1. **No schema or permission work.** `Brand.logoUrl` (`logo_url VARCHAR(2048)`) and `User.profileImageUrl` (`profile_image_url VARCHAR(2048)`) already exist. `brands.update` and `users.update` are already seeded. **No migration, no seed change, no new permissions.**
2. **Brands use integer IDs** (`@default(autoincrement())`), not UUIDs — so controllers use `ParseIntPipe`, and the object-key prefix is `brands/<int>/`.
3. **Avatars are self-service.** `UsersService` currently exposes only approve/lookup; there is no "edit my profile" surface. The avatar endpoints target **`caller.id`** exclusively — no `:id` param — so editing another user's avatar is *structurally impossible*, not merely forbidden.

## Non-goals (YAGNI)

- Managed avatars (an OWNER/MANAGER setting a member's avatar). Self-service only; can be added later if a real need appears.
- Multiple images per entity (single `logoUrl` / `profileImageUrl`, like products' single `imageUrl`).
- Public objects / CDN. Everything stays private → presign-on-read.
- Retrofitting products to the shared DTOs (optional later cleanup; products keeps its local DTOs for now to avoid churning tested code).

---

## Architecture

### Shared upload DTOs (small DRY step)
The presign/confirm request bodies are identical across entities, so they are extracted once and imported by brands + users:

- `src/storage/dto/presign-upload.dto.ts` — `contentType: string` with `@IsIn(['image/jpeg', 'image/png', 'image/webp'])`.
- `src/storage/dto/confirm-upload.dto.ts` — `key: string` with `@IsString() @IsNotEmpty()`.

### Brand logo — `BrandsService` + `BrandsController`
Mirrors products with brand's integer id and company scoping:

- Inject `StorageService` (4th-ish constructor arg after prisma + ownership).
- Helpers: an `IMAGE_EXT` content-type→extension map; `logoKey(brandId, contentType)` → `brands/${brandId}/${randomUUID()}.${ext}`; `present<T>(brand)` — if `logoUrl` is set, replace it with `presignGetUrl(logoUrl)`; `findOneRaw(caller, id)` — the scoped lookup returning the **raw** stored key (used internally by the write methods); `findOne`/`findAll` return **presented** rows.
- Methods, each fetching via the scoped lookup first (inherits tenant 404):
  - `uploadLogo(caller, id, file)` — `putObject(key, file.buffer, file.mimetype)` → delete old key if any → `update({ logoUrl: key })` → present.
  - `presignLogoUpload(caller, id, dto)` — returns `{ uploadUrl, key }`; does **not** touch the row.
  - `confirmLogo(caller, id, dto)` — validate `key.startsWith('brands/' + id + '/')` (else 400) → `objectExists(key)` (else 400) → delete old key → `update({ logoUrl: key })` → present.
- Routes (all `@RequirePermissions('brands.update')`, `ParseIntPipe` on `:id`):
  - `POST /brands/:id/logo` — `FileInterceptor('file')` + `ParseFilePipe` (`MaxFileSizeValidator` 5 MB + `FileTypeValidator /^image\/(jpeg|png|webp)$/`).
  - `POST /brands/:id/logo/presign` — body `PresignUploadDto`.
  - `POST /brands/:id/logo/confirm` — body `ConfirmUploadDto`.

### User avatar — `UsersService` + `UsersController` (self-service)
- Inject `StorageService`.
- Helpers: reuse the same `IMAGE_EXT` map; `avatarKey(userId, contentType)` → `users/${userId}/${randomUUID()}.${ext}`; `present(user)` — swap `profileImageUrl`→presigned GET.
- Methods, target always `caller.id`, fetching `user { id: caller.id, deletedAt: null }` (404 if absent):
  - `uploadAvatar(caller, file)` — put → delete old → `update({ profileImageUrl: key })` → present.
  - `presignAvatarUpload(caller, dto)` — returns `{ uploadUrl, key }`.
  - `confirmAvatar(caller, dto)` — validate `key.startsWith('users/' + caller.id + '/')` (else 400) → `objectExists` (else 400) → delete old → update → present.
- Routes on `UsersController` (**no `@RequirePermissions`**, no `:id`):
  - `POST /users/me/avatar` — `FileInterceptor` + `ParseFilePipe` (same validators).
  - `POST /users/me/avatar/presign` · `POST /users/me/avatar/confirm`.
- **Why no permission:** `PermissionsGuard` returns `true` for routes with no `@RequirePermissions` metadata; JWT auth still applies globally, so the caller is always an authenticated user editing only themselves. Returning the `User` row is safe — it has no secret columns (credentials live in `UserLoginMethod`).

### Storage layout
One bucket (`inventra-files` dev / `inventra-files-test` in tests), namespaced by key prefix: `products/…`, `brands/…`, `users/…`. All private; every read re-presigns.

## Error model
- **400** — non-image or >5 MB (proxied, via `ParseFilePipe`); a confirm `key` not under the entity's prefix; a confirm `key` whose object doesn't exist in the bucket.
- **403** — brand logo: caller lacks `brands.update` (guard). (Avatar has no permission gate.)
- **404** — brand: absent/other-tenant/deleted brand (scoped lookup). Avatar: the caller's own user row is missing/soft-deleted (shouldn't happen for an authenticated active user).

## Testing
- **Unit** (Claude owns): extend `brands.service.spec.ts` (storage mock; logo: key regex `^brands/<id>/[0-9a-f-]+\.<ext>$`, delete-old-on-replace, confirm foreign-key 400, confirm missing-object 400, findOne presents) and `users.service.spec.ts` (avatar: targets `caller.id`, key regex under `users/<caller.id>/`, confirm rejects a key not under the caller's prefix, present).
- **E2e** (Claude owns): extend `test/uploads.e2e-spec.ts` with brand-logo (proxied sets a presigned `logoUrl`; presign → direct PUT → confirm) and avatar (proxied sets a presigned `profileImageUrl`; presign → PUT → confirm) describes, reusing the existing seeded owner + `inventra-files-test` bucket.

## Definition of done
Unit suite green (adds ~9 tests), `npm run test:e2e` green with the new upload cases, both commits pushed, STATUS.md updated to mark Slice 2 complete and point at Slice 3.
