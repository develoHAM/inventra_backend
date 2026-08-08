# Phase 4 — Stores & Corners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **This project's execution style:** per task I (1) teach the concepts, (2) give requirements, (3) provide full reference code, (4) write + run the tests. Code blocks below are the reference; the developer compares their own against them.

**Goal:** Build the organizational layer beneath the catalog — global `Store` venues (ADMIN-managed) and company-owned `Corner`s (`CompanyStore`) with manager + staff assignment.

**Architecture:** Two feature modules. `StoresModule` mirrors Categories (global, ADMIN-only writes, no ownership). `CornersModule` mirrors Brands/Products (company-owned; `scopeToCompany(caller)`), imports `StoresModule` + `UsersModule` to validate `storeId` and assignment targets via the owning services (fetch-then-decide). Manager/staff assignment is exposed as sub-resource endpoints. All deletes are soft.

**Tech Stack:** NestJS 11, Prisma 7, class-validator, @nestjs/mapped-types, Jest + supertest.

## Global Constraints

- **Soft-delete everywhere:** set `deletedAt = new Date()` **and** `deletedByUserId = caller.id`; every read filters `deletedAt: null`.
- **Stores are global:** `stores.read` → all company roles; `stores.{create,update,delete}` → **no role** (ADMIN wildcard only). Service create/find/update take no caller; only `remove(caller, id)` needs the caller (to stamp the deleter).
- **Corners are company-owned:** spread `scopeToCompany(caller)` (owner column is `companyId`) into every `where`; cross-tenant id → **404**.
- **ADMIN** has full cross-tenant CRUD; on corner create it supplies `companyId` via `resolveCompanyForCreate` (→ **400** if omitted).
- **Manager eligibility:** target must be same company + `ACTIVE` + role `MANAGER`, else **400**. Manager appointment is **OWNER/ADMIN-only** — a MANAGER caller hitting `PUT /manager` gets **403**.
- **Staff:** OWNER/ADMIN may manage any corner in scope; **MANAGER only corners they manage** (`corner.managerUserId === caller.id`, else **403**). Add target must be same company + `ACTIVE` (→ **400**); remove target must currently be staff of *this* corner (→ **404**).
- **Permissions (spec §4):** +9 → 29 total. Grants: OWNER = `stores.read` + `corners.{create,read,update,delete,assign}`; MANAGER = `stores.read` + `corners.read` + `corners.assign`; STAFF = `stores.read` + `corners.read`.
- Store & Corner ids are **UUID** → controllers use `ParseUUIDPipe`.

---

## Task 1: Data model + permission seed

**Files:**
- Modify: `prisma/schema.prisma` (soft-delete on `Store` + `CompanyStore`; User back-relations)
- Create: migration `prisma/migrations/<ts>_stores_corners_soft_delete_audit/`
- Modify: `prisma/seed.ts` (9 permissions + role grants)

**Interfaces (Produces):** `Store.deletedAt`/`deletedByUserId`, `CompanyStore.deletedAt`/`deletedByUserId`; permission codes `stores.*`, `corners.*`, `corners.assign`.

- [ ] **Step 1: Edit `schema.prisma`** — add to `Store` and `CompanyStore` (mirroring the catalog columns), plus the `User` back-relations:

```prisma
// model Store — add fields + relation
  deletedAt       DateTime? @map("deleted_at") @db.Timestamptz(6)
  deletedByUserId String?   @map("deleted_by_user_id") @db.Uuid
  deletedByUser   User?     @relation("StoreDeletedBy", fields: [deletedByUserId], references: [id])

// model CompanyStore — add fields + relation
  deletedAt       DateTime? @map("deleted_at") @db.Timestamptz(6)
  deletedByUserId String?   @map("deleted_by_user_id") @db.Uuid
  deletedByUser   User?     @relation("CompanyStoreDeletedBy", fields: [deletedByUserId], references: [id])

// model User — add back-relations
  deletedStores        Store[]        @relation("StoreDeletedBy")
  deletedCompanyStores CompanyStore[] @relation("CompanyStoreDeletedBy")
```

- [ ] **Step 2: Migrate** — `npx prisma migrate dev --name stores_corners_soft_delete_audit` (all new columns nullable → applies cleanly). `npx prisma generate` if not automatic. *(The developer runs migrations; the Prisma AI-guard blocks me from destructive commands.)*
- [ ] **Step 3: Add permissions to `seed.ts`** — append 9 codes to `PERMISSIONS` and extend the three role arrays in `ROLE_PERMISSIONS`:

```ts
// PERMISSIONS: append
{ code: 'stores.create', name: 'Create stores' },
{ code: 'stores.read',   name: 'Read stores' },
{ code: 'stores.update', name: 'Update stores' },
{ code: 'stores.delete', name: 'Delete stores' },
{ code: 'corners.create', name: 'Create corners' },
{ code: 'corners.read',   name: 'Read corners' },
{ code: 'corners.update', name: 'Update corners' },
{ code: 'corners.delete', name: 'Delete corners' },
{ code: 'corners.assign', name: 'Assign corner manager and staff' },

// ROLE_PERMISSIONS: append to each array
OWNER:   [ ...existing, 'stores.read',
           'corners.create','corners.read','corners.update','corners.delete','corners.assign' ],
MANAGER: [ ...existing, 'stores.read', 'corners.read', 'corners.assign' ],
STAFF:   [ ...existing, 'stores.read', 'corners.read' ],
// stores.{create,update,delete} granted to NO role → ADMIN wildcard only
```

- [ ] **Step 4: Re-seed** — `npm run seed` (idempotent upserts).
- [ ] **Step 5: Verify** — `docker compose exec postgres psql -U <user> -d inventra -c "\d company_stores"` shows `deleted_by_user_id`; permission count is now **29** (`SELECT count(*) FROM permissions;`).
- [ ] **Step 6: Commit** — `git add prisma/ && git commit -m "feat(db): stores/corners soft-delete audit columns + permissions"`

---

## Task 2: `UsersService.findActiveMember` + export the service

**Files:**
- Modify: `src/users/users.service.ts` (add `findActiveMember`)
- Modify: `src/users/users.module.ts` (export `UsersService`)
- Test: `src/users/users.service.spec.ts`

**Interfaces (Produces):** `findActiveMember(userId: string, companyId: string)` → `Promise<(User & { role: Role | null }) | null>` — the ACTIVE, non-deleted, same-company user with its `role` included, or `null`.

**Why:** Corners validate assignment targets. Keeping the lookup (and its scoping) in the owning service, and the 400/403 decision in `CornersService`, is the Phase 3 fetch-then-decide pattern. `CornersModule` can only inject `UsersService` if `UsersModule` exports it.

- [ ] **Step 1: Add the failing test** (`src/users/users.service.spec.ts`):

```ts
describe('findActiveMember', () => {
  it('returns an active same-company member with role included', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', role: { code: 'MANAGER' } });
    const found = await service.findActiveMember('u1', 'company-1');
    expect(found).toEqual({ id: 'u1', role: { code: 'MANAGER' } });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: 'u1', companyId: 'company-1', status: UserStatus.ACTIVE, deletedAt: null },
      include: { role: true },
    });
  });

  it('returns null when no match (wrong company / inactive / deleted)', async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    expect(await service.findActiveMember('u1', 'company-1')).toBeNull();
  });
});
```

*(Ensure the spec's `prisma` mock includes `user: { findFirst: jest.fn(), ... }` and imports `UserStatus` from `../generated/prisma/enums`.)*

- [ ] **Step 2: Run → fails** (`npm test -- users.service`; `findActiveMember` undefined).
- [ ] **Step 3: Implement** — add to `UsersService`:

```ts
findActiveMember(userId: string, companyId: string) {
  return this.prisma.user.findFirst({
    where: { id: userId, companyId, status: UserStatus.ACTIVE, deletedAt: null },
    include: { role: true },
  });
}
```

- [ ] **Step 4: Export the service** — `src/users/users.module.ts`:

```ts
@Module({
  imports: [AuthorizationModule],
  controllers: [UsersController, CompaniesController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 5: Run → passes** (`npm test -- users.service`).
- [ ] **Step 6: Commit** — `git add src/users/ && git commit -m "feat(users): findActiveMember lookup + export UsersService"`

---

## Task 3: Stores module (global, ADMIN-managed)

**Files:**
- Create: `src/stores/stores.module.ts`, `stores.service.ts`, `stores.controller.ts`, `dto/create-store.dto.ts`, `dto/update-store.dto.ts`
- Modify: `src/app.module.ts` (register `StoresModule`)
- Test: `src/stores/stores.service.spec.ts`

**Interfaces (Produces):** `StoresService.findActive(id: string)` → `Promise<Store | null>` (used by Corners); plus `create/findAll/findOne/update/remove`.

- [ ] **Step 1: DTOs**

```ts
// dto/create-store.dto.ts
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
export class CreateStoreDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name!: string;
  @IsOptional() @IsString() @MaxLength(255) storeAddress?: string;
  @IsOptional() @IsString() @MaxLength(20) storePhone?: string;
  @IsOptional() @IsString() description?: string;
}
// dto/update-store.dto.ts
import { PartialType } from '@nestjs/mapped-types';
import { CreateStoreDto } from './create-store.dto';
export class UpdateStoreDto extends PartialType(CreateStoreDto) {}
```

- [ ] **Step 2: Write the service tests** (`stores.service.spec.ts`):

```ts
import { NotFoundException } from '@nestjs/common';
import { StoresService } from './stores.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('StoresService', () => {
  let service: StoresService;
  let prisma: { store: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock } };
  const admin: AuthUser = { id: 'admin-1', companyId: null, roleId: 1, roleCode: 'ADMIN', status: UserStatus.ACTIVE };

  beforeEach(() => {
    prisma = { store: {
      create: jest.fn().mockResolvedValue({ id: 's1' }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    } };
    service = new StoresService(prisma as any);
  });

  it('create passes the dto straight through', async () => {
    await service.create({ name: 'Lotte' } as any);
    expect(prisma.store.create).toHaveBeenCalledWith({ data: { name: 'Lotte' } });
  });

  it('findAll filters out soft-deleted rows', async () => {
    await service.findAll();
    expect(prisma.store.findMany).toHaveBeenCalledWith({ where: { deletedAt: null } });
  });

  it('findOne 404s an absent/deleted store', async () => {
    prisma.store.findFirst.mockResolvedValue(null);
    await expect(service.findOne('s9')).rejects.toThrow(NotFoundException);
  });

  it('findActive returns the row or null without throwing', async () => {
    prisma.store.findFirst.mockResolvedValue(null);
    expect(await service.findActive('s9')).toBeNull();
  });

  it('remove soft-deletes and stamps the deleter', async () => {
    prisma.store.findFirst.mockResolvedValue({ id: 's1' });
    await service.remove(admin, 's1');
    expect(prisma.store.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { deletedAt: expect.any(Date), deletedByUserId: 'admin-1' },
    });
  });
});
```

- [ ] **Step 3: Run → fails** (`npm test -- stores.service`).
- [ ] **Step 4: Implement the service** (`stores.service.ts`):

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateStoreDto) {
    return this.prisma.store.create({ data: dto });
  }

  findAll() {
    return this.prisma.store.findMany({ where: { deletedAt: null } });
  }

  findActive(id: string) {
    return this.prisma.store.findFirst({ where: { id, deletedAt: null } });
  }

  async findOne(id: string) {
    const store = await this.findActive(id);
    if (!store) throw new NotFoundException('Store not found');
    return store;
  }

  async update(id: string, dto: UpdateStoreDto) {
    await this.findOne(id);
    return this.prisma.store.update({ where: { id }, data: dto });
  }

  async remove(caller: AuthUser, id: string) {
    await this.findOne(id);
    return this.prisma.store.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
```

- [ ] **Step 5: Controller** (`stores.controller.ts`):

```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { StoresService } from './stores.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateStoreDto } from './dto/create-store.dto';
import { UpdateStoreDto } from './dto/update-store.dto';

@Controller('stores')
export class StoresController {
  constructor(private readonly stores: StoresService) {}

  @RequirePermissions('stores.read') @Get()
  findAll() { return this.stores.findAll(); }

  @RequirePermissions('stores.read') @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) { return this.stores.findOne(id); }

  @RequirePermissions('stores.create') @Post()
  create(@Body() dto: CreateStoreDto) { return this.stores.create(dto); }

  @RequirePermissions('stores.update') @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateStoreDto) {
    return this.stores.update(id, dto);
  }

  @RequirePermissions('stores.delete') @Delete(':id')
  remove(@CurrentUser() caller: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.stores.remove(caller, id);
  }
}
```

- [ ] **Step 6: Module + register** (`stores.module.ts`, then add to `app.module.ts` imports):

```ts
import { Module } from '@nestjs/common';
import { StoresService } from './stores.service';
import { StoresController } from './stores.controller';
@Module({ providers: [StoresService], controllers: [StoresController], exports: [StoresService] })
export class StoresModule {}
```

- [ ] **Step 7: Run → passes** (`npm test -- stores.service`).
- [ ] **Step 8: Commit** — `git add src/stores/ src/app.module.ts && git commit -m "feat(stores): global ADMIN-managed store CRUD"`

---

## Task 4: Corners module — CRUD

**Files:**
- Create: `src/corners/corners.module.ts`, `corners.service.ts`, `corners.controller.ts`, `dto/create-corner.dto.ts`, `dto/update-corner.dto.ts`, `dto/assign-user.dto.ts`
- Modify: `src/app.module.ts` (register `CornersModule`)
- Test: `src/corners/corners.service.spec.ts`

**Interfaces (Consumes):** `OwnershipService.scopeToCompany`/`resolveCompanyForCreate`, `StoresService.findActive`, `UsersService.findActiveMember`.
**Interfaces (Produces):** `CornersService.create/findAll/findOne/update/remove` + (Task 5) `assignManager/addStaff/removeStaff`; the shared private `resolveManager`.

- [ ] **Step 1: DTOs**

```ts
// dto/create-corner.dto.ts
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
export class CreateCornerDto {
  @IsUUID() storeId!: string;
  @IsOptional() @IsString() @MaxLength(255) name?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsUUID() managerUserId?: string;
  @IsOptional() @IsUUID() companyId?: string; // ADMIN target company
}
// dto/update-corner.dto.ts — omit companyId, storeId AND managerUserId
// (manager is set only via PUT /corners/:id/manager; venue/company are immutable)
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreateCornerDto } from './create-corner.dto';
export class UpdateCornerDto extends PartialType(
  OmitType(CreateCornerDto, ['companyId', 'storeId', 'managerUserId'] as const),
) {}
// dto/assign-user.dto.ts — shared by manager + staff endpoints
import { IsUUID } from 'class-validator';
export class AssignUserDto { @IsUUID() userId!: string; }
```

- [ ] **Step 2: Write the CRUD tests** (`corners.service.spec.ts`):

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CornersService } from './corners.service';
import { OwnershipService } from '../authorization/ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('CornersService', () => {
  let service: CornersService;
  let prisma: { companyStore: { create: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock; update: jest.Mock };
                user: { findFirst: jest.Mock; update: jest.Mock } };
  let stores: { findActive: jest.Mock };
  let users: { findActiveMember: jest.Mock };

  const owner: AuthUser = { id: 'owner-1', companyId: 'company-1', roleId: 2, roleCode: 'OWNER', status: UserStatus.ACTIVE };
  const admin: AuthUser = { id: 'admin-1', companyId: null, roleId: 1, roleCode: 'ADMIN', status: UserStatus.ACTIVE };

  beforeEach(() => {
    prisma = {
      companyStore: {
        create: jest.fn().mockResolvedValue({ id: 'corner-1' }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      user: { findFirst: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    };
    stores = { findActive: jest.fn().mockResolvedValue({ id: 'store-1' }) };
    users = { findActiveMember: jest.fn().mockResolvedValue({ id: 'u1', role: { code: 'MANAGER' } }) };
    // constructor order: (prisma, ownership, stores, users)
    service = new CornersService(prisma as any, new OwnershipService(), stores as any, users as any);
  });

  describe('create', () => {
    it('creates a corner owned by the caller company after validating the store', async () => {
      await service.create(owner, { storeId: 'store-1', name: 'A1' } as any);
      expect(stores.findActive).toHaveBeenCalledWith('store-1');
      expect(prisma.companyStore.create).toHaveBeenCalledWith({
        data: { storeId: 'store-1', name: 'A1', companyId: 'company-1', managerUserId: null },
      });
    });

    it('rejects an invalid store with 400', async () => {
      stores.findActive.mockResolvedValue(null);
      await expect(service.create(owner, { storeId: 'bad' } as any)).rejects.toThrow(BadRequestException);
      expect(prisma.companyStore.create).not.toHaveBeenCalled();
    });

    it('lets ADMIN create for a supplied companyId', async () => {
      await service.create(admin, { storeId: 'store-1', companyId: 'company-9' } as any);
      expect(prisma.companyStore.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ companyId: 'company-9' }) }),
      );
    });

    it('rejects ADMIN create without a companyId (400)', async () => {
      await expect(service.create(admin, { storeId: 'store-1' } as any)).rejects.toThrow(BadRequestException);
    });
  });

  describe('findOne', () => {
    it('404s a cross-tenant/absent corner and scopes the lookup', async () => {
      prisma.companyStore.findFirst.mockResolvedValue(null);
      await expect(service.findOne(owner, 'x')).rejects.toThrow(NotFoundException);
      expect(prisma.companyStore.findFirst).toHaveBeenCalledWith({
        where: { id: 'x', companyId: 'company-1', deletedAt: null },
      });
    });
  });

  describe('remove', () => {
    it('soft-deletes and stamps the deleter', async () => {
      prisma.companyStore.findFirst.mockResolvedValue({ id: 'corner-1', companyId: 'company-1' });
      await service.remove(owner, 'corner-1');
      expect(prisma.companyStore.update).toHaveBeenCalledWith({
        where: { id: 'corner-1' },
        data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
      });
    });
  });
});
```

- [ ] **Step 3: Run → fails** (`npm test -- corners.service`).
- [ ] **Step 4: Implement the service (CRUD + shared `resolveManager`)** (`corners.service.ts`):

```ts
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OwnershipService } from '../authorization/ownership.service';
import { StoresService } from '../stores/stores.service';
import { UsersService } from '../users/users.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateCornerDto } from './dto/create-corner.dto';
import { UpdateCornerDto } from './dto/update-corner.dto';
import { AssignUserDto } from './dto/assign-user.dto';

@Injectable()
export class CornersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
    private readonly stores: StoresService,
    private readonly users: UsersService,
  ) {}

  private async resolveManager(userId: string, companyId: string) {
    const user = await this.users.findActiveMember(userId, companyId);
    if (!user || user.role?.code !== 'MANAGER')
      throw new BadRequestException('Manager must be an active MANAGER in the company');
    return user;
  }

  async create(caller: AuthUser, dto: CreateCornerDto) {
    const { companyId: requested, managerUserId, ...data } = dto;
    const companyId = this.ownership.resolveCompanyForCreate(caller, requested);

    const store = await this.stores.findActive(data.storeId);
    if (!store) throw new BadRequestException('Invalid store');

    if (managerUserId) await this.resolveManager(managerUserId, companyId);

    return this.prisma.companyStore.create({
      data: { ...data, companyId, managerUserId: managerUserId ?? null },
    });
  }

  findAll(caller: AuthUser) {
    return this.prisma.companyStore.findMany({
      where: { ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
  }

  async findOne(caller: AuthUser, id: string) {
    const corner = await this.prisma.companyStore.findFirst({
      where: { id, ...this.ownership.scopeToCompany(caller), deletedAt: null },
    });
    if (!corner) throw new NotFoundException('Corner not found');
    return corner;
  }

  async update(caller: AuthUser, id: string, dto: UpdateCornerDto) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({ where: { id }, data: dto });
  }

  async remove(caller: AuthUser, id: string) {
    await this.findOne(caller, id);
    return this.prisma.companyStore.update({
      where: { id },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
```

- [ ] **Step 5: Controller (CRUD routes only for now)** (`corners.controller.ts`):

```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { CornersService } from './corners.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateCornerDto } from './dto/create-corner.dto';
import { UpdateCornerDto } from './dto/update-corner.dto';

@Controller('corners')
export class CornersController {
  constructor(private readonly corners: CornersService) {}

  @RequirePermissions('corners.read') @Get()
  findAll(@CurrentUser() caller: AuthUser) { return this.corners.findAll(caller); }

  @RequirePermissions('corners.read') @Get(':id')
  findOne(@CurrentUser() caller: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.corners.findOne(caller, id);
  }

  @RequirePermissions('corners.create') @Post()
  create(@CurrentUser() caller: AuthUser, @Body() dto: CreateCornerDto) {
    return this.corners.create(caller, dto);
  }

  @RequirePermissions('corners.update') @Patch(':id')
  update(@CurrentUser() caller: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCornerDto) {
    return this.corners.update(caller, id, dto);
  }

  @RequirePermissions('corners.delete') @Delete(':id')
  remove(@CurrentUser() caller: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.corners.remove(caller, id);
  }
}
```

- [ ] **Step 6: Module + register** (`corners.module.ts`, then add to `app.module.ts` imports):

```ts
import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { StoresModule } from '../stores/stores.module';
import { UsersModule } from '../users/users.module';
import { CornersService } from './corners.service';
import { CornersController } from './corners.controller';
@Module({
  imports: [AuthorizationModule, StoresModule, UsersModule],
  providers: [CornersService],
  controllers: [CornersController],
})
export class CornersModule {}
```

- [ ] **Step 7: Run → passes** (`npm test -- corners.service`).
- [ ] **Step 8: Commit** — `git add src/corners/ src/app.module.ts && git commit -m "feat(corners): company-scoped corner CRUD with store validation"`

---

## Task 5: Corners — manager & staff assignment

**Files:**
- Modify: `src/corners/corners.service.ts` (add `assignManager`, `addStaff`, `removeStaff`, private `assertCanManageStaff`)
- Modify: `src/corners/corners.controller.ts` (add 3 sub-resource routes)
- Test: `src/corners/corners.service.spec.ts` (extend)

**Interfaces (Produces):** `assignManager(caller, cornerId, dto)`, `addStaff(caller, cornerId, dto)`, `removeStaff(caller, cornerId, userId)`.

- [ ] **Step 1: Add the assignment tests** (extend `corners.service.spec.ts`):

```ts
const manager: AuthUser = { id: 'mgr-1', companyId: 'company-1', roleId: 3, roleCode: 'MANAGER', status: UserStatus.ACTIVE };

describe('assignManager', () => {
  it('sets managerUserId for an eligible MANAGER target (owner caller)', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: null });
    users.findActiveMember.mockResolvedValue({ id: 'u1', role: { code: 'MANAGER' } });
    await service.assignManager(owner, 'c1', { userId: 'u1' } as any);
    expect(users.findActiveMember).toHaveBeenCalledWith('u1', 'company-1');
    expect(prisma.companyStore.update).toHaveBeenCalledWith({ where: { id: 'c1' }, data: { managerUserId: 'u1' } });
  });

  it('rejects a non-MANAGER target with 400', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: null });
    users.findActiveMember.mockResolvedValue({ id: 'u1', role: { code: 'STAFF' } });
    await expect(service.assignManager(owner, 'c1', { userId: 'u1' } as any)).rejects.toThrow(BadRequestException);
  });

  it('forbids a MANAGER caller from appointing a manager (403)', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'mgr-1' });
    await expect(service.assignManager(manager, 'c1', { userId: 'u1' } as any)).rejects.toThrow(ForbiddenException);
    expect(prisma.companyStore.update).not.toHaveBeenCalled();
  });
});

describe('addStaff', () => {
  it('lets the corner MANAGER add an active member (sets companyStoreId)', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'mgr-1' });
    users.findActiveMember.mockResolvedValue({ id: 'u2', role: { code: 'STAFF' } });
    await service.addStaff(manager, 'c1', { userId: 'u2' } as any);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u2' }, data: { companyStoreId: 'c1' } });
  });

  it('forbids a MANAGER from staffing a corner they do not manage (403)', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'someone-else' });
    await expect(service.addStaff(manager, 'c1', { userId: 'u2' } as any)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an ineligible staff target with 400', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'mgr-1' });
    users.findActiveMember.mockResolvedValue(null);
    await expect(service.addStaff(manager, 'c1', { userId: 'bad' } as any)).rejects.toThrow(BadRequestException);
  });
});

describe('removeStaff', () => {
  it('404s when the user is not staff of this corner', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'mgr-1' });
    prisma.user.findFirst.mockResolvedValue(null);
    await expect(service.removeStaff(manager, 'c1', 'u2')).rejects.toThrow(NotFoundException);
  });

  it('unsets companyStoreId for a current staff member', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'mgr-1' });
    prisma.user.findFirst.mockResolvedValue({ id: 'u2', companyStoreId: 'c1' });
    await service.removeStaff(manager, 'c1', 'u2');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u2' }, data: { companyStoreId: null } });
  });
});
```

- [ ] **Step 2: Run → fails** (`npm test -- corners.service`).
- [ ] **Step 3: Implement the assignment methods** — add to `CornersService`:

```ts
private assertCanManageStaff(caller: AuthUser, corner: { managerUserId: string | null }) {
  if (caller.roleCode === 'MANAGER' && corner.managerUserId !== caller.id)
    throw new ForbiddenException('You can only manage staff of corners you manage');
  // OWNER / ADMIN pass through
}

async assignManager(caller: AuthUser, cornerId: string, dto: AssignUserDto) {
  const corner = await this.findOne(caller, cornerId); // scoped 404
  if (caller.roleCode === 'MANAGER')
    throw new ForbiddenException('Only an owner can appoint a manager');
  await this.resolveManager(dto.userId, corner.companyId); // 400 if ineligible
  return this.prisma.companyStore.update({
    where: { id: cornerId },
    data: { managerUserId: dto.userId },
  });
}

async addStaff(caller: AuthUser, cornerId: string, dto: AssignUserDto) {
  const corner = await this.findOne(caller, cornerId);
  this.assertCanManageStaff(caller, corner);
  const member = await this.users.findActiveMember(dto.userId, corner.companyId);
  if (!member) throw new BadRequestException('Staff must be an active member of the company');
  return this.prisma.user.update({
    where: { id: dto.userId },
    data: { companyStoreId: cornerId },
  });
}

async removeStaff(caller: AuthUser, cornerId: string, userId: string) {
  const corner = await this.findOne(caller, cornerId);
  this.assertCanManageStaff(caller, corner);
  const staff = await this.prisma.user.findFirst({ where: { id: userId, companyStoreId: cornerId } });
  if (!staff) throw new NotFoundException('User is not staff of this corner');
  return this.prisma.user.update({ where: { id: userId }, data: { companyStoreId: null } });
}
```

- [ ] **Step 4: Add the controller routes** — add `Put` to the import and these handlers to `CornersController`:

```ts
import { AssignUserDto } from './dto/assign-user.dto';
// ...
@RequirePermissions('corners.assign') @Put(':id/manager')
assignManager(@CurrentUser() caller: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignUserDto) {
  return this.corners.assignManager(caller, id, dto);
}

@RequirePermissions('corners.assign') @Post(':id/staff')
addStaff(@CurrentUser() caller: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignUserDto) {
  return this.corners.addStaff(caller, id, dto);
}

@RequirePermissions('corners.assign') @Delete(':id/staff/:userId')
removeStaff(@CurrentUser() caller: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Param('userId', ParseUUIDPipe) userId: string) {
  return this.corners.removeStaff(caller, id, userId);
}
```

- [ ] **Step 5: Run → passes** (`npm test -- corners.service`).
- [ ] **Step 6: Commit** — `git add src/corners/ && git commit -m "feat(corners): manager appointment + creator-scoped staff assignment"`

---

## Task 6: e2e — stores & corners flow

**Files:**
- Create: `test/stores-corners.e2e-spec.ts`

**What it proves:** the full wiring (routing, guards, pipes) across tenants and roles.

- [ ] **Step 1: Write the e2e spec** (reuse the `registerCompany` / `registerMember` helpers from `test/catalog.e2e-spec.ts`; admin login from `SEED_ADMIN_*`):

```ts
// Flow (one describe, sequential `it`s sharing ids):
// 1. ADMIN creates a store (201); a company OWNER cannot (403).
// 2. OWNER opens a corner in that store (201). Invalid storeId → 400.
// 3. OWNER assigns a MANAGER-role member as the corner manager (200);
//    assigning a STAFF-role member → 400.
// 4. That manager adds a STAFF member to their corner (POST /corners/:id/staff, 200).
// 5. A manager of a DIFFERENT corner is 403 adding staff to this one.
// 6. Company 2 cannot fetch company 1's corner (GET → 404).
// 7. ADMIN reads across tenants (200) and creates a corner via companyId (201).
```

Concretely (abbreviated — mirror `catalog.e2e-spec.ts` setup verbatim, then):

```ts
it('ADMIN creates a store; a company user cannot (403)', async () => {
  const res = await request(http).post('/stores')
    .set('Authorization', `Bearer ${adminAccess}`).send({ name: 'Lotte Jamsil' }).expect(201);
  storeId = res.body.id;
  await request(http).post('/stores')
    .set('Authorization', `Bearer ${ownerAccess}`).send({ name: 'Nope' }).expect(403);
});

it('OWNER opens a corner; invalid store is 400', async () => {
  const res = await request(http).post('/corners')
    .set('Authorization', `Bearer ${ownerAccess}`).send({ storeId, name: 'A-1' }).expect(201);
  cornerId = res.body.id;
  await request(http).post('/corners')
    .set('Authorization', `Bearer ${ownerAccess}`)
    .send({ storeId: '00000000-0000-0000-0000-000000000000', name: 'X' }).expect(400);
});

it('OWNER appoints a MANAGER; a STAFF target is 400', async () => {
  await request(http).put(`/corners/${cornerId}/manager`)
    .set('Authorization', `Bearer ${ownerAccess}`).send({ userId: managerUserId }).expect(200);
  await request(http).put(`/corners/${cornerId}/manager`)
    .set('Authorization', `Bearer ${ownerAccess}`).send({ userId: staffUserId }).expect(400);
});

it('the corner MANAGER adds staff; a foreign manager is 403', async () => {
  await request(http).post(`/corners/${cornerId}/staff`)
    .set('Authorization', `Bearer ${managerAccess}`).send({ userId: staffUserId }).expect(201);
  await request(http).post(`/corners/${cornerId}/staff`)
    .set('Authorization', `Bearer ${otherManagerAccess}`).send({ userId: staffUserId }).expect(403);
});

it("company 2 cannot fetch company 1's corner (404); ADMIN can (200) and can create via companyId (201)", async () => {
  await request(http).get(`/corners/${cornerId}`)
    .set('Authorization', `Bearer ${owner2Access}`).expect(404);
  await request(http).get(`/corners/${cornerId}`)
    .set('Authorization', `Bearer ${adminAccess}`).expect(200);
  await request(http).post('/corners')
    .set('Authorization', `Bearer ${adminAccess}`)
    .send({ storeId, name: 'admin-made', companyId: company1Id }).expect(201);
});
```

*(Setup note: to have `managerUserId`/`staffUserId` and an `otherManagerAccess`, register two members with the MANAGER role (one for the corner, one for a second corner) and one with STAFF, using `registerMember`; capture their DB user ids via `prisma.user.findFirst({ where: { loginMethods: { some: { email } } } })`, as in the catalog e2e.)*

- [ ] **Step 2: Run the e2e** — `npm run test:e2e` (the `pretest` migrate-reset + seed runs first). *(The developer runs this — the Prisma AI-guard blocks the reset for me.)*
- [ ] **Step 3: Fix any failures, then commit** — `git add test/stores-corners.e2e-spec.ts && git commit -m "test(corners): e2e stores + corners flow across tenants and roles"`

---

## Self-Review (spec coverage)

- Spec §2 decisions #1–#9 → Tasks 1 (data model/soft-delete, perms), 3 (Store global/ADMIN), 4 (corner ownership, ADMIN companyId), 5 (manager eligibility, staff row-level, assign permission). ✓
- Spec §3 migration → Task 1. §4 permissions/grants → Task 1. §5 modules + `findActiveMember` → Tasks 2–4. §6 endpoints → Tasks 3–5. §7 scoping/assignment rules → Tasks 4–5. §8 error table → covered by the 400/403/404 tests in Tasks 4–5 + e2e Task 6. §9 testing → each task's tests + Task 6. ✓
- **Deviation from spec §6 (intentional tightening):** `UpdateCornerDto` also omits `managerUserId` (not just `companyId`/`storeId`) so `PATCH /corners/:id` cannot bypass the OWNER/ADMIN-only + eligibility rules for manager appointment. Manager is set only via `PUT /corners/:id/manager`. The spec §6 line will be updated to match.
- Type consistency: `findActiveMember(userId, companyId)` returns user-with-`role`; `resolveManager` reads `user.role?.code`; constructor order `(prisma, ownership, stores, users)` matches the test. ✓
