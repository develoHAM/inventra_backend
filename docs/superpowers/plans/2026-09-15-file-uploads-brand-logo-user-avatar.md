# File Uploads Slice 2 — Brand Logo + User Avatar Implementation Plan

> **Workflow (this repo):** teaching-first, per-task. For each task Claude (1) teaches the delta, (2) gives requirements, (3) provides full reference code below; **the user writes the production code**, **Claude writes + runs the tests**. Auto-commit + push at each green checkpoint.

**Goal:** Attach a logo to a brand and an avatar to the caller's own user profile, reusing `StorageService` + the presign-on-read pattern from product images.

**Architecture:** Extend `BrandsService`/`BrandsController` (company-scoped, integer id, `brands.update`) and `UsersService`/`UsersController` (self-service, target `caller.id`, no permission). Shared presign/confirm DTOs live in `src/storage/dto/`. DB stores the object key; reads re-presign a GET URL; proxied + presigned upload paths both offered.

**Tech Stack:** NestJS 11 (`FileInterceptor`, `ParseFilePipe`), AWS SDK v3 via `StorageService`, Prisma 7, Jest + supertest.

## Global Constraints
- Store the **key** in the DB (`logoUrl` / `profileImageUrl`); never store a presigned URL. Present a fresh GET URL on every read.
- Key prefixes: `brands/<brandId>/<uuid>.<ext>`, `users/<userId>/<uuid>.<ext>`. Ext from the `IMAGE_EXT` map (`jpg`/`png`/`webp`), fallback `bin`.
- Proxied upload validators: `MaxFileSizeValidator` 5 MB + `FileTypeValidator /^image\/(jpeg|png|webp)$/`.
- Delete the previous object on replace (both proxied and confirm paths).
- No migration, no seed change, no new permissions.
- Import `PrismaClient`-generated types from `../generated/prisma/...`; `randomUUID` from `node:crypto`.

---

### Task 1: Shared upload DTOs

**Files:**
- Create: `src/storage/dto/presign-upload.dto.ts`
- Create: `src/storage/dto/confirm-upload.dto.ts`

**Interfaces produced:** `PresignUploadDto { contentType: string }`, `ConfirmUploadDto { key: string }` — consumed by brands + users controllers/services.

**Reference code:**

```ts
// src/storage/dto/presign-upload.dto.ts
import { IsIn, IsString } from 'class-validator';

export class PresignUploadDto {
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType!: string;
}
```

```ts
// src/storage/dto/confirm-upload.dto.ts
import { IsNotEmpty, IsString } from 'class-validator';

export class ConfirmUploadDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
```

- [ ] Create both DTOs. (No test — exercised via the service/e2e tasks.)

---

### Task 2: Brand logo — service + controller

**Files:**
- Modify: `src/brands/brands.service.ts` (inject `StorageService`; add helpers + 3 methods; present in `findOne`/`findAll`)
- Modify: `src/brands/brands.controller.ts` (add 3 routes)
- Test: `src/brands/brands.service.spec.ts` (Task 3)

**Interfaces produced:**
- `uploadLogo(caller: AuthUser, id: number, file: Express.Multer.File): Promise<Brand-with-presigned-logoUrl>`
- `presignLogoUpload(caller, id: number, dto: PresignUploadDto): Promise<{ uploadUrl: string; key: string }>`
- `confirmLogo(caller, id: number, dto: ConfirmUploadDto): Promise<Brand-with-presigned-logoUrl>`

**Teaching delta:** identical to products' image methods, with three differences — (a) `id` is a `number` (`ParseIntPipe`), (b) the DB column is `logoUrl`, (c) the scoped lookup is brand's existing `findOne` (which already 404s cross-tenant). We add a `findOneRaw` that returns the **raw** key for the write methods, and make the public `findOne`/`findAll` present.

**Reference code — `brands.service.ts` (full file):**

```ts
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import { StorageService } from '../storage/storage.service';
import { randomUUID } from 'node:crypto';
import { PresignUploadDto } from '../storage/dto/presign-upload.dto';
import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly storage: StorageService,
  ) {}

  private logoKey(brandId: number, contentType: string): string {
    const ext = IMAGE_EXT[contentType] ?? 'bin';
    return `brands/${brandId}/${randomUUID()}.${ext}`;
  }

  private async present<T extends { logoUrl: string | null }>(brand: T): Promise<T> {
    if (!brand.logoUrl) return brand;
    return { ...brand, logoUrl: await this.storage.presignGetUrl(brand.logoUrl) };
  }

  private async findOneRaw(caller: AuthUser, id: number) {
    const brand = await this.prisma.brand.findFirst({
      where: {
        id,
        ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'),
        deletedAt: null,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand;
  }

  async create(caller: AuthUser, dto: CreateBrandDto) {
    const { companyId: requested, ...data } = dto;
    const createdByCompanyId = this.ownership.resolveCompanyForCreate(caller, requested);
    return this.prisma.brand.create({ data: { ...data, createdByCompanyId } });
  }

  async findAll(caller: AuthUser) {
    const brands = await this.prisma.brand.findMany({
      where: {
        ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'),
        deletedAt: null,
      },
    });
    return Promise.all(brands.map((b) => this.present(b)));
  }

  async findOne(caller: AuthUser, id: number) {
    return this.present(await this.findOneRaw(caller, id));
  }

  findInCompany(brandId: number, companyId: string) {
    return this.prisma.brand.findFirst({
      where: { id: brandId, createdByCompanyId: companyId, deletedAt: null },
    });
  }

  async update(caller: AuthUser, id: number, dto: UpdateBrandDto) {
    await this.findOneRaw(caller, id); // scoped 404
    return this.prisma.brand.update({ where: { id }, data: dto });
  }

  async remove(caller: AuthUser, id: number) {
    await this.findOneRaw(caller, id);
    return this.prisma.brand.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }

  async uploadLogo(caller: AuthUser, id: number, file: Express.Multer.File) {
    const brand = await this.findOneRaw(caller, id);
    const key = this.logoKey(id, file.mimetype);
    await this.storage.putObject(key, file.buffer, file.mimetype);
    if (brand.logoUrl) await this.storage.deleteObject(brand.logoUrl);
    const updated = await this.prisma.brand.update({ where: { id }, data: { logoUrl: key } });
    return this.present(updated);
  }

  async presignLogoUpload(caller: AuthUser, id: number, dto: PresignUploadDto) {
    await this.findOneRaw(caller, id);
    const key = this.logoKey(id, dto.contentType);
    const uploadUrl = await this.storage.presignPutUrl(key, dto.contentType);
    return { uploadUrl, key };
  }

  async confirmLogo(caller: AuthUser, id: number, dto: ConfirmUploadDto) {
    const brand = await this.findOneRaw(caller, id);
    if (!dto.key.startsWith(`brands/${id}/`))
      throw new BadRequestException('Key does not belong to this brand');
    if (!(await this.storage.objectExists(dto.key)))
      throw new BadRequestException('Uploaded object not found');
    if (brand.logoUrl) await this.storage.deleteObject(brand.logoUrl);
    const updated = await this.prisma.brand.update({ where: { id }, data: { logoUrl: dto.key } });
    return this.present(updated);
  }
}
```

**Reference code — `brands.controller.ts` (add imports + 3 routes):**

```ts
// add to imports:
//   FileTypeValidator, MaxFileSizeValidator, ParseFilePipe, UploadedFile, UseInterceptors
//   from '@nestjs/common'
// import { FileInterceptor } from '@nestjs/platform-express';
// import { PresignUploadDto } from '../storage/dto/presign-upload.dto';
// import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';

  @RequirePermissions('brands.update')
  @Post(':id/logo')
  @UseInterceptors(FileInterceptor('file'))
  uploadLogo(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.brands.uploadLogo(caller, id, file);
  }

  @RequirePermissions('brands.update')
  @Post(':id/logo/presign')
  presignLogo(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: PresignUploadDto,
  ) {
    return this.brands.presignLogoUpload(caller, id, dto);
  }

  @RequirePermissions('brands.update')
  @Post(':id/logo/confirm')
  confirmLogo(
    @CurrentUser() caller: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ConfirmUploadDto,
  ) {
    return this.brands.confirmLogo(caller, id, dto);
  }
```

- [ ] User writes the two production files above.
- [ ] `npm run build` clean; StorageService injects (it's `@Global()`, no module import needed).

---

### Task 3: Brand logo — unit tests (Claude)

**Files:** Modify `src/brands/brands.service.spec.ts` — add a `storage` mock as the 3rd constructor arg (`new BrandsService(prisma, new OwnershipService(), storage)`), and a `describe('logo upload')`:
- `uploadLogo` stores under `brands/<id>/<uuid>.<ext>`, deletes old, sets `logoUrl` (assert `putObject` key regex `^brands/<id>/[0-9a-f-]+\.png$`, `deleteObject` old, `update { logoUrl: key }`).
- `presignLogoUpload` returns `{ uploadUrl, key }`, no `update`.
- `confirmLogo` rejects a key not under `brands/<id>/` (400, `objectExists` not called).
- `confirmLogo` rejects a missing object (400, `update` not called).
- `confirmLogo` / `findOne` present the stored key (`presignGetUrl` called, result `logoUrl` = presigned).

- [ ] Write tests, run `npm test`, expect green.

---

### Task 4: User avatar — service + controller (self-service)

**Files:**
- Modify: `src/users/users.service.ts` (inject `StorageService`; add helpers + 3 self-service methods)
- Modify: `src/users/users.controller.ts` (add 3 `/me/avatar` routes, no permission)
- Test: `src/users/users.service.spec.ts` (Task 5)

**Interfaces produced:**
- `uploadAvatar(caller: AuthUser, file: Express.Multer.File): Promise<User-with-presigned-profileImageUrl>`
- `presignAvatarUpload(caller, dto: PresignUploadDto): Promise<{ uploadUrl: string; key: string }>`
- `confirmAvatar(caller, dto: ConfirmUploadDto): Promise<User-with-presigned-profileImageUrl>`

**Teaching delta:** the target is **always `caller.id`** — no `:id` param, so no cross-user reach and no permission needed (the `PermissionsGuard` passes no-metadata routes; JWT auth still gates). Fetch the caller's own row (`{ id: caller.id, deletedAt: null }`). Everything else mirrors brand logo, column `profileImageUrl`, prefix `users/<caller.id>/`.

**Reference code — `users.service.ts` (add imports + members):**

```ts
// add imports:
// import { StorageService } from '../storage/storage.service';
// import { randomUUID } from 'node:crypto';
// import { PresignUploadDto } from '../storage/dto/presign-upload.dto';
// import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';

const IMAGE_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// constructor gains a 3rd arg:
//   constructor(
//     private readonly prisma: PrismaService,
//     private readonly ownership: OwnershipService,
//     private readonly storage: StorageService,
//   ) {}

  private avatarKey(userId: string, contentType: string): string {
    const ext = IMAGE_EXT[contentType] ?? 'bin';
    return `users/${userId}/${randomUUID()}.${ext}`;
  }

  private async present<T extends { profileImageUrl: string | null }>(user: T): Promise<T> {
    if (!user.profileImageUrl) return user;
    return { ...user, profileImageUrl: await this.storage.presignGetUrl(user.profileImageUrl) };
  }

  private async findSelf(caller: AuthUser) {
    const user = await this.prisma.user.findFirst({
      where: { id: caller.id, deletedAt: null },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async uploadAvatar(caller: AuthUser, file: Express.Multer.File) {
    const user = await this.findSelf(caller);
    const key = this.avatarKey(caller.id, file.mimetype);
    await this.storage.putObject(key, file.buffer, file.mimetype);
    if (user.profileImageUrl) await this.storage.deleteObject(user.profileImageUrl);
    const updated = await this.prisma.user.update({
      where: { id: caller.id },
      data: { profileImageUrl: key },
    });
    return this.present(updated);
  }

  async presignAvatarUpload(caller: AuthUser, dto: PresignUploadDto) {
    await this.findSelf(caller);
    const key = this.avatarKey(caller.id, dto.contentType);
    const uploadUrl = await this.storage.presignPutUrl(key, dto.contentType);
    return { uploadUrl, key };
  }

  async confirmAvatar(caller: AuthUser, dto: ConfirmUploadDto) {
    const user = await this.findSelf(caller);
    if (!dto.key.startsWith(`users/${caller.id}/`))
      throw new BadRequestException('Key does not belong to you');
    if (!(await this.storage.objectExists(dto.key)))
      throw new BadRequestException('Uploaded object not found');
    if (user.profileImageUrl) await this.storage.deleteObject(user.profileImageUrl);
    const updated = await this.prisma.user.update({
      where: { id: caller.id },
      data: { profileImageUrl: dto.key },
    });
    return this.present(updated);
  }
```

**Reference code — `users.controller.ts` (add imports + 3 routes, no `@RequirePermissions`):**

```ts
// add to '@nestjs/common' imports: Post, FileTypeValidator, MaxFileSizeValidator,
//   ParseFilePipe, UploadedFile, UseInterceptors
// import { FileInterceptor } from '@nestjs/platform-express';
// import { PresignUploadDto } from '../storage/dto/presign-upload.dto';
// import { ConfirmUploadDto } from '../storage/dto/confirm-upload.dto';

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file'))
  uploadAvatar(
    @CurrentUser() caller: AuthUser,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.usersService.uploadAvatar(caller, file);
  }

  @Post('me/avatar/presign')
  presignAvatar(@CurrentUser() caller: AuthUser, @Body() dto: PresignUploadDto) {
    return this.usersService.presignAvatarUpload(caller, dto);
  }

  @Post('me/avatar/confirm')
  confirmAvatar(@CurrentUser() caller: AuthUser, @Body() dto: ConfirmUploadDto) {
    return this.usersService.confirmAvatar(caller, dto);
  }
```

> ⚠️ **Route order:** `me/avatar` must not collide with `:id/approve` — different verbs/paths, so fine. `me` is a literal segment; no `:id` route on `POST` exists, so no ambiguity.

- [ ] User writes the two production files. `npm run build` clean.

---

### Task 5: User avatar — unit tests (Claude)

**Files:** Modify `src/users/users.service.spec.ts` — the existing constructor call becomes `new UsersService(prisma, new OwnershipService(), storage)` (add the storage mock + `user.update` already mocked). Add a `describe('avatar (self-service)')`:
- `uploadAvatar` targets `caller.id`: `putObject` key regex `^users/<caller.id>/[0-9a-f-]+\.png$`, `update { where: { id: caller.id }, data: { profileImageUrl: key } }`, deletes old.
- `presignAvatarUpload` returns `{ uploadUrl, key }`, no `update`.
- `confirmAvatar` rejects a key not under `users/<caller.id>/` (400, `objectExists` not called) — the self-scoping guard.
- `confirmAvatar` rejects a missing object (400).
- present: result `profileImageUrl` is the presigned URL.

- [ ] Write tests, run `npm test`, expect green (full unit suite).

---

### Task 6: E2e + green checkpoint + commit (Claude)

**Files:** Modify `test/uploads.e2e-spec.ts` — add describes reusing the seeded owner + `brandId`:
- **Brand logo:** proxied `POST /brands/:id/logo` sets `logoUrl` containing `X-Amz-Signature`; a later `GET /brands/:id` re-presigns; presign → `fetch(uploadUrl, { method: 'PUT', ... })` → confirm sets `logoUrl`; confirm foreign key → 400.
- **Avatar:** proxied `POST /users/me/avatar` (as owner) sets `profileImageUrl` containing `X-Amz-Signature`; presign → PUT → confirm; confirm a key not under `users/<ownerId>/` → 400.

- [ ] Write e2e cases. **Human runs `npm run test:e2e`** (MinIO up; guarded pretest resets). Claude verifies unit green via `npm test` and can run the uploads spec directly against the seeded DB.
- [ ] On full green: commit (`feat(brands,users): logo + avatar upload (proxied + presigned)`) + push. Update `STATUS.md` to mark Slice 2 complete, point at Slice 3.

---

## Self-Review
- **Spec coverage:** DTOs (T1), brand logo service+controller (T2)+tests (T3), avatar service+controller (T4)+tests (T5), e2e+done (T6). ✅
- **Type consistency:** `id: number` for brands throughout; `caller.id: string` for avatars; DTOs named `PresignUploadDto`/`ConfirmUploadDto` consistently; columns `logoUrl`/`profileImageUrl` match schema. ✅
- **No placeholders:** all code shown in full. ✅
- **Constructor churn:** both `brands.service.spec.ts` and `users.service.spec.ts` need the new storage arg — flagged in T3/T5.
