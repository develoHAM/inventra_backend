# Phase 5 — Product Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **This project's execution style:** per task I (1) teach the concepts, (2) give requirements, (3) provide full reference code, (4) write + run the tests. Code blocks below are the reference; the developer compares their own against them.

**Goal:** Place catalog products onto a corner's shelf — nested CRUD over `CompanyStoreProduct`, owned through the corner, with a `targetStockQuantity` planning field and soft-delete.

**Architecture:** One feature module (`PlacementsModule`) with routes nested under `/corners/:cornerId/products`. Ownership runs *through the corner*: reads resolve it with `CornersService.findOne`, writes with `CornersService.assertManages` (adds the MANAGER row-rule). Product validation reuses `ProductsService.findInCompany`. Create reconciles the `(productId, companyStoreId)` unique constraint by reviving a soft-deleted row.

**Tech Stack:** NestJS 11, Prisma 7, class-validator, @nestjs/mapped-types, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-08-13-phase-5-product-placement-design.md`

## Global Constraints

- **Quantity scope:** Phase 5 sets `targetStockQuantity` (+ `isActive`, `description`) only. `current`/`reserved`/`sample` stay at `0` (later phases).
- **Ownership through the corner:** no `companyId` on the placement. Reads → `corners.findOne(caller, cornerId)`; writes → `corners.assertWorksCorner(caller, cornerId)` (OWNER/ADMIN any · MANAGER-managed · STAFF whose `companyStoreId === cornerId`). Then filter placements by `companyStoreId = cornerId` + `deletedAt: null`.
- **Soft-delete:** `DELETE` sets `deletedAt = new Date()` **and** `deletedByUserId = caller.id`; reads filter `deletedAt: null`. `isActive` is an independent toggle.
- **Create reconciliation:** live `(productId, cornerId)` → 409; soft-deleted → **revive** (clear `deletedAt`/`deletedByUserId`, apply new fields); none → insert.
- **Permissions (spec §4, rev):** +4 → 33. `placements.read` → OWNER/MANAGER/STAFF; `placements.{create,update,delete}` → OWNER/MANAGER/**STAFF**, row-scoped in the service (`assertWorksCorner`): MANAGER → managed corners, STAFF → the one corner they're assigned to.
- **Ids:** `cornerId` UUID (`ParseUUIDPipe`); `placementId` int (`ParseIntPipe`).

**⚠ Revision (2026-08-13) — STAFF placement access.** STAFF may CRUD placements, scoped to their assigned corner. Layered onto the tasks below:
- **Task 1:** STAFF grant is the full set `placements.{create,read,update,delete}` (not read-only).
- **Task 3 (also):** add `companyStoreId` to `AuthUser` + the guard, and a new `CornersService.assertWorksCorner` (keep `assertManages` as-is for staff assignment):
  ```ts
  // src/auth/types/auth-user.ts — add field
  companyStoreId: string | null;
  // src/auth/guards/jwt-auth.guard.ts — add `companyStoreId: true` to the user select, and to the AuthUser object:
  const authenticatedUser: AuthUser = { ...existing, companyStoreId: user.companyStoreId };
  // src/corners/corners.service.ts — new write-guard
  async assertWorksCorner(caller: AuthUser, cornerId: string) {
    const corner = await this.findOne(caller, cornerId); // company-scoped → 404
    if (caller.roleCode === 'MANAGER' && corner.managerUserId !== caller.id)
      throw new ForbiddenException('You can only manage corners you manage');
    if (caller.roleCode === 'STAFF' && caller.companyStoreId !== cornerId)
      throw new ForbiddenException('You can only manage the corner you are assigned to');
    return corner;
  }
  ```
- **Task 4:** placement **writes** (`create`/`update`/`remove`) call `corners.assertWorksCorner` instead of `assertManages`; reads keep `corners.findOne`. Tests mock `assertWorksCorner` and add STAFF-assigned (ok) vs STAFF-unassigned (403) cases.

---

## Task 1: Data model + permission seed

**Files:**
- Modify: `prisma/schema.prisma` (CompanyStoreProduct soft-delete + User back-relation) — **already done**
- Create: migration `prisma/migrations/<ts>_placement_soft_delete_audit/`
- Modify: `prisma/seed.ts` (4 permissions + grants)

**Interfaces (Produces):** `CompanyStoreProduct.deletedAt`/`deletedByUserId`; permission codes `placements.*`.

- [x] **Step 1 (DONE): schema** — `deletedAt` + `deletedByUserId` (+ named relation `CompanyStoreProductDeletedBy`) on `CompanyStoreProduct`, and `deletedPlacements` back-relation on `User`. Already committed-in-progress by the developer; matches spec §3.
- [ ] **Step 2: Migrate** — `npx prisma migrate dev --name placement_soft_delete_audit` (nullable columns → clean). `npx prisma generate` if not automatic. *(Developer runs this — Prisma AI-guard blocks me.)*
- [ ] **Step 3: Add permissions to `seed.ts`** — append 4 codes to `PERMISSIONS` and extend the role arrays:

```ts
// PERMISSIONS: append
{ code: 'placements.create', name: 'Create placements' },
{ code: 'placements.read',   name: 'Read placements' },
{ code: 'placements.update', name: 'Update placements' },
{ code: 'placements.delete', name: 'Delete placements' },

// ROLE_PERMISSIONS: append
OWNER:   [ ...existing, 'placements.create','placements.read','placements.update','placements.delete' ],
MANAGER: [ ...existing, 'placements.create','placements.read','placements.update','placements.delete' ],
STAFF:   [ ...existing, 'placements.create','placements.read','placements.update','placements.delete' ],
```

- [ ] **Step 4: Re-seed** — `npm run seed`.
- [ ] **Step 5: Verify** — `docker compose exec postgres psql ... -c "\d company_store_products"` shows `deleted_by_user_id`; permission count is **33**.
- [ ] **Step 6: Commit** — `git add prisma/ && git commit -m "feat(db): placement soft-delete audit columns + permissions"`

---

## Task 2: `ProductsService.findInCompany` + export `ProductsService`

**Files:**
- Modify: `src/products/products.service.ts` (add `findInCompany`)
- Modify: `src/products/products.module.ts` (export `ProductsService`)
- Test: `src/products/products.service.spec.ts`

**Interfaces (Produces):** `findInCompany(productId: string, companyId: string)` → `Promise<Product | null>` — the live (non-deleted) product in that company, or `null`.

**Why:** Placement validates the product against the *corner's* company (not the caller's) — that's what makes ADMIN cross-tenant placement correct. Row-or-null, so `PlacementsService` decides the 400. `PlacementsModule` can only inject `ProductsService` if `ProductsModule` exports it.

- [ ] **Step 1: Add the failing test** (`products.service.spec.ts`):

```ts
describe('findInCompany', () => {
  it('returns the live product scoped to the given company', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
    const found = await service.findInCompany('p1', 'company-1');
    expect(found).toEqual({ id: 'p1' });
    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'p1', companyId: 'company-1', deletedAt: null },
    });
  });

  it('returns null when absent / other company / deleted', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    expect(await service.findInCompany('p1', 'company-1')).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fails** (`npm test -- products.service`).
- [ ] **Step 3: Implement** — add to `ProductsService`:

```ts
findInCompany(productId: string, companyId: string) {
  return this.prisma.product.findFirst({
    where: { id: productId, companyId, deletedAt: null },
  });
}
```

- [ ] **Step 4: Export the service** — `src/products/products.module.ts`, add `exports: [ProductsService]`.
- [ ] **Step 5: Run → passes** (`npm test -- products.service`).
- [ ] **Step 6: Commit** — `git add src/products/ && git commit -m "feat(products): findInCompany lookup + export ProductsService"`

---

## Task 3: `CornersService.assertManages` — export + refactor staff methods onto it

**Files:**
- Modify: `src/corners/corners.service.ts` (`assertManages` **already added**; refactor `addStaff`/`removeStaff`, drop `assertCanManageStaff`)
- Modify: `src/corners/corners.module.ts` (export `CornersService`)
- Test: `src/corners/corners.service.spec.ts`

**Interfaces (Produces):** `assertManages(caller: AuthUser, cornerId: string)` → `Promise<CompanyStore>` (404 if not the caller's, 403 if a MANAGER who doesn't manage it).

- [x] **Step 1 (DONE): `assertManages`** — already added by the developer; matches spec §7.
- [ ] **Step 2: Export the service** — `src/corners/corners.module.ts`, add `exports: [CornersService]`.
- [ ] **Step 3: Refactor `addStaff`/`removeStaff`** — replace the `findOne` + `assertCanManageStaff` pair with a single `assertManages`, and delete the now-unused `assertCanManageStaff`:

```ts
async addStaff(caller: AuthUser, cornerId: string, dto: AssignUserDto) {
  const corner = await this.assertManages(caller, cornerId); // was: findOne + assertCanManageStaff
  const member = await this.users.findActiveMember(dto.userId, corner.companyId);
  if (!member) throw new BadRequestException('Staff must be an active member of the company');
  return this.prisma.user.update({ where: { id: dto.userId }, data: { companyStoreId: cornerId } });
}

async removeStaff(caller: AuthUser, cornerId: string, userId: string) {
  await this.assertManages(caller, cornerId);
  const staff = await this.prisma.user.findFirst({ where: { id: userId, companyStoreId: cornerId } });
  if (!staff) throw new NotFoundException('User is not staff of this corner');
  return this.prisma.user.update({ where: { id: userId }, data: { companyStoreId: null } });
}
// delete the private assertCanManageStaff — assertManages replaces it
```

- [ ] **Step 4: Add an `assertManages` test** (`corners.service.spec.ts`):

```ts
describe('assertManages', () => {
  it('returns the corner for an OWNER', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'x' });
    await expect(service.assertManages(owner, 'c1')).resolves.toEqual(
      expect.objectContaining({ id: 'c1' }),
    );
  });
  it('403s a MANAGER who does not manage the corner', async () => {
    prisma.companyStore.findFirst.mockResolvedValue({ id: 'c1', companyId: 'company-1', managerUserId: 'someone-else' });
    await expect(service.assertManages(manager, 'c1')).rejects.toThrow(ForbiddenException);
  });
  it('404s a cross-tenant/absent corner', async () => {
    prisma.companyStore.findFirst.mockResolvedValue(null);
    await expect(service.assertManages(owner, 'c9')).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 5: Run → passes** (`npm test -- corners.service`; the existing addStaff/removeStaff tests keep passing — behavior is unchanged).
- [ ] **Step 6: Commit** — `git add src/corners/ && git commit -m "refactor(corners): assertManages helper + export CornersService"`

---

## Task 4: Placements module (nested CRUD)

**Files:**
- Create: `src/placements/placements.module.ts`, `placements.service.ts`, `placements.controller.ts`, `dto/create-placement.dto.ts`, `dto/update-placement.dto.ts`
- Modify: `src/app.module.ts` (register `PlacementsModule`)
- Test: `src/placements/placements.service.spec.ts`

**Interfaces (Consumes):** `CornersService.findOne`/`assertManages`, `ProductsService.findInCompany`.

- [ ] **Step 1: DTOs**

```ts
// dto/create-placement.dto.ts
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
export class CreatePlacementDto {
  @IsUUID() productId!: string;
  @IsOptional() @IsInt() @Min(0) targetStockQuantity?: number;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsString() description?: string;
}
// dto/update-placement.dto.ts — you don't re-point a placement at another product
import { OmitType, PartialType } from '@nestjs/mapped-types';
import { CreatePlacementDto } from './create-placement.dto';
export class UpdatePlacementDto extends PartialType(
  OmitType(CreatePlacementDto, ['productId'] as const),
) {}
```

- [ ] **Step 2: Write the service tests** (`placements.service.spec.ts`):

```ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { PlacementsService } from './placements.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('PlacementsService', () => {
  let service: PlacementsService;
  let prisma: { companyStoreProduct: { findFirst: jest.Mock; findMany: jest.Mock; create: jest.Mock; update: jest.Mock } };
  let corners: { findOne: jest.Mock; assertManages: jest.Mock };
  let products: { findInCompany: jest.Mock };

  const owner: AuthUser = { id: 'owner-1', companyId: 'company-1', roleId: 2, roleCode: 'OWNER', status: UserStatus.ACTIVE };
  const CORNER = { id: 'corner-1', companyId: 'company-1', managerUserId: 'mgr-1' };

  beforeEach(() => {
    prisma = { companyStoreProduct: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1 }),
      update: jest.fn().mockResolvedValue({ id: 1 }),
    } };
    corners = { findOne: jest.fn().mockResolvedValue(CORNER), assertManages: jest.fn().mockResolvedValue(CORNER) };
    products = { findInCompany: jest.fn().mockResolvedValue({ id: 'prod-1' }) };
    service = new PlacementsService(prisma as any, corners as any, products as any);
  });

  describe('create', () => {
    it('places a product after authorizing the corner and validating the product', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue(null); // none existing
      await service.create(owner, 'corner-1', { productId: 'prod-1', targetStockQuantity: 5 } as any);

      expect(corners.assertManages).toHaveBeenCalledWith(owner, 'corner-1');
      expect(products.findInCompany).toHaveBeenCalledWith('prod-1', 'company-1');
      expect(prisma.companyStoreProduct.create).toHaveBeenCalledWith({
        data: { targetStockQuantity: 5, companyStoreId: 'corner-1', productId: 'prod-1' },
      });
    });

    it('rejects an invalid product with 400', async () => {
      products.findInCompany.mockResolvedValue(null);
      await expect(service.create(owner, 'corner-1', { productId: 'bad' } as any)).rejects.toThrow(BadRequestException);
      expect(prisma.companyStoreProduct.create).not.toHaveBeenCalled();
    });

    it('409s when a live placement already exists', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue({ id: 9, deletedAt: null });
      await expect(service.create(owner, 'corner-1', { productId: 'prod-1' } as any)).rejects.toThrow(ConflictException);
      expect(prisma.companyStoreProduct.create).not.toHaveBeenCalled();
    });

    it('revives a soft-deleted placement instead of inserting', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue({ id: 9, deletedAt: new Date() });
      await service.create(owner, 'corner-1', { productId: 'prod-1', targetStockQuantity: 3 } as any);

      expect(prisma.companyStoreProduct.create).not.toHaveBeenCalled();
      expect(prisma.companyStoreProduct.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { targetStockQuantity: 3, deletedAt: null, deletedByUserId: null },
      });
    });
  });

  describe('findOne', () => {
    it('404s a placement absent from this corner (scoped)', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue(null);
      await expect(service.findOne(owner, 'corner-1', 9)).rejects.toThrow(NotFoundException);
      expect(prisma.companyStoreProduct.findFirst).toHaveBeenCalledWith({
        where: { id: 9, companyStoreId: 'corner-1', deletedAt: null },
      });
    });
  });

  describe('remove', () => {
    it('soft-deletes and stamps the deleter', async () => {
      prisma.companyStoreProduct.findFirst.mockResolvedValue({ id: 9, companyStoreId: 'corner-1' });
      await service.remove(owner, 'corner-1', 9);
      expect(prisma.companyStoreProduct.update).toHaveBeenCalledWith({
        where: { id: 9 },
        data: { deletedAt: expect.any(Date), deletedByUserId: 'owner-1' },
      });
    });
  });
});
```

- [ ] **Step 3: Run → fails** (`npm test -- placements.service`).
- [ ] **Step 4: Implement the service** (`placements.service.ts`):

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { ProductsService } from '../products/products.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreatePlacementDto } from './dto/create-placement.dto';
import { UpdatePlacementDto } from './dto/update-placement.dto';

@Injectable()
export class PlacementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
    private readonly products: ProductsService,
  ) {}

  private async getPlacement(cornerId: string, placementId: number) {
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');
    return placement;
  }

  async create(caller: AuthUser, cornerId: string, dto: CreatePlacementDto) {
    const corner = await this.corners.assertManages(caller, cornerId); // 404/403
    const { productId, ...fields } = dto;

    const product = await this.products.findInCompany(productId, corner.companyId);
    if (!product) throw new BadRequestException('Invalid product');

    const existing = await this.prisma.companyStoreProduct.findFirst({
      where: { productId, companyStoreId: cornerId }, // includes soft-deleted
    });
    if (existing && !existing.deletedAt)
      throw new ConflictException('Product already placed on this corner');
    if (existing)
      return this.prisma.companyStoreProduct.update({
        where: { id: existing.id },
        data: { ...fields, deletedAt: null, deletedByUserId: null },
      });

    return this.prisma.companyStoreProduct.create({
      data: { ...fields, companyStoreId: cornerId, productId },
    });
  }

  async findAll(caller: AuthUser, cornerId: string) {
    await this.corners.findOne(caller, cornerId); // read scope → 404
    return this.prisma.companyStoreProduct.findMany({
      where: { companyStoreId: cornerId, deletedAt: null },
    });
  }

  async findOne(caller: AuthUser, cornerId: string, placementId: number) {
    await this.corners.findOne(caller, cornerId); // read scope → 404
    return this.getPlacement(cornerId, placementId);
  }

  async update(caller: AuthUser, cornerId: string, placementId: number, dto: UpdatePlacementDto) {
    await this.corners.assertManages(caller, cornerId); // write scope → 404/403
    await this.getPlacement(cornerId, placementId); // → 404
    return this.prisma.companyStoreProduct.update({ where: { id: placementId }, data: dto });
  }

  async remove(caller: AuthUser, cornerId: string, placementId: number) {
    await this.corners.assertManages(caller, cornerId);
    await this.getPlacement(cornerId, placementId);
    return this.prisma.companyStoreProduct.update({
      where: { id: placementId },
      data: { deletedAt: new Date(), deletedByUserId: caller.id },
    });
  }
}
```

- [ ] **Step 5: Controller** (`placements.controller.ts`):

```ts
import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { PlacementsService } from './placements.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreatePlacementDto } from './dto/create-placement.dto';
import { UpdatePlacementDto } from './dto/update-placement.dto';

@Controller('corners/:cornerId/products')
export class PlacementsController {
  constructor(private readonly placements: PlacementsService) {}

  @RequirePermissions('placements.read') @Get()
  findAll(@CurrentUser() caller: AuthUser, @Param('cornerId', ParseUUIDPipe) cornerId: string) {
    return this.placements.findAll(caller, cornerId);
  }

  @RequirePermissions('placements.read') @Get(':placementId')
  findOne(@CurrentUser() caller: AuthUser, @Param('cornerId', ParseUUIDPipe) cornerId: string, @Param('placementId', ParseIntPipe) placementId: number) {
    return this.placements.findOne(caller, cornerId, placementId);
  }

  @RequirePermissions('placements.create') @Post()
  create(@CurrentUser() caller: AuthUser, @Param('cornerId', ParseUUIDPipe) cornerId: string, @Body() dto: CreatePlacementDto) {
    return this.placements.create(caller, cornerId, dto);
  }

  @RequirePermissions('placements.update') @Patch(':placementId')
  update(@CurrentUser() caller: AuthUser, @Param('cornerId', ParseUUIDPipe) cornerId: string, @Param('placementId', ParseIntPipe) placementId: number, @Body() dto: UpdatePlacementDto) {
    return this.placements.update(caller, cornerId, placementId, dto);
  }

  @RequirePermissions('placements.delete') @Delete(':placementId')
  remove(@CurrentUser() caller: AuthUser, @Param('cornerId', ParseUUIDPipe) cornerId: string, @Param('placementId', ParseIntPipe) placementId: number) {
    return this.placements.remove(caller, cornerId, placementId);
  }
}
```

- [ ] **Step 6: Module + register** (`placements.module.ts`, then add to `app.module.ts` imports):

```ts
import { Module } from '@nestjs/common';
import { CornersModule } from '../corners/corners.module';
import { ProductsModule } from '../products/products.module';
import { PlacementsService } from './placements.service';
import { PlacementsController } from './placements.controller';

@Module({
  imports: [CornersModule, ProductsModule],
  providers: [PlacementsService],
  controllers: [PlacementsController],
})
export class PlacementsModule {}
```

- [ ] **Step 7: Run → passes** (`npm test -- placements.service`); then `npm test` (full suite) + confirm `CornersModule`/`ProductsModule` export their services so DI boots.
- [ ] **Step 8: Commit** — `git add src/placements/ src/app.module.ts && git commit -m "feat(placements): nested product placement CRUD with revive-on-replace"`

---

## Task 5: e2e — placement flow

**Files:**
- Create: `test/placements.e2e-spec.ts`

- [ ] **Step 1: Write the e2e** (reuse the `registerCompany`/`registerMember` helpers from `test/stores-corners.e2e-spec.ts`; distinct `@pl.test` emails / `7x0-…` tax ids). Setup: register company 1 (owner) + a MANAGER member (who will manage a corner) + a STAFF member; ADMIN creates a store; OWNER creates a corner and appoints the manager; OWNER creates a product (Phase 3 `/products`). Then:

```ts
it('OWNER places a product on the corner; STAFF can read but not place', async () => {
  const res = await request(http).post(`/corners/${cornerId}/products`)
    .set('Authorization', `Bearer ${ownerAccess}`).send({ productId, targetStockQuantity: 10 }).expect(201);
  placementId = res.body.id;

  await request(http).get(`/corners/${cornerId}/products`)
    .set('Authorization', `Bearer ${staffAccess}`).expect(200);
  await request(http).post(`/corners/${cornerId}/products`)
    .set('Authorization', `Bearer ${staffAccess}`).send({ productId }).expect(403);
});

it('duplicate placement is 409; a foreign product is 400', async () => {
  await request(http).post(`/corners/${cornerId}/products`)
    .set('Authorization', `Bearer ${ownerAccess}`).send({ productId }).expect(409);
  await request(http).post(`/corners/${cornerId}/products`)
    .set('Authorization', `Bearer ${ownerAccess}`).send({ productId: company2ProductId }).expect(400);
});

it('the corner MANAGER updates; a foreign MANAGER is 403', async () => {
  await request(http).patch(`/corners/${cornerId}/products/${placementId}`)
    .set('Authorization', `Bearer ${managerAccess}`).send({ targetStockQuantity: 20 }).expect(200);
  await request(http).patch(`/corners/${cornerId}/products/${placementId}`)
    .set('Authorization', `Bearer ${otherManagerAccess}`).send({ targetStockQuantity: 1 }).expect(403);
});

it('soft-delete then re-place the same product revives it', async () => {
  await request(http).delete(`/corners/${cornerId}/products/${placementId}`)
    .set('Authorization', `Bearer ${ownerAccess}`).expect(200);
  const res = await request(http).post(`/corners/${cornerId}/products`)
    .set('Authorization', `Bearer ${ownerAccess}`).send({ productId, targetStockQuantity: 7 }).expect(201);
  expect(res.body.id).toBe(placementId); // same row revived, not a new one
});

it("company 2 cannot read company 1's corner shelf (404)", async () => {
  await request(http).get(`/corners/${cornerId}/products`)
    .set('Authorization', `Bearer ${owner2Access}`).expect(404);
});
```

*(Setup detail: `company2ProductId` is a product created by company 2's owner via `POST /products`, used to prove cross-company product rejection. `otherManagerAccess` is a second MANAGER in company 1 who does not manage `cornerId`.)*

- [ ] **Step 2: Run the e2e** — `npm run test:e2e`. *(Developer runs this — Prisma AI-guard blocks the reset.)*
- [ ] **Step 3: Fix any failures, then commit** — `git add test/placements.e2e-spec.ts && git commit -m "test(placements): e2e placement flow (revive, 409, 400, row-scoped manager)"`

---

## Self-Review (spec coverage)

- Spec §2 decisions #1–#7 → Task 1 (soft-delete/perms), Task 2 (`findInCompany` for cross-company product check), Task 3 (`assertManages` + refactor), Task 4 (nested CRUD, ownership-via-corner, revive). ✓
- §3 migration → Task 1. §4 permissions/grants → Task 1. §5 module + reused lookups → Tasks 2–4. §6 endpoints → Task 4. §7 scoping → Task 4. §8 create/revive → Task 4. §8a delete/isActive → Task 4. §9 errors → 400/403/404/409 tests in Task 4 + e2e Task 5. §10 testing → each task + Task 5. ✓
- Type consistency: `assertManages(caller, cornerId) → CompanyStore`; `findInCompany(productId, companyId) → Product|null`; `PlacementsService` constructor `(prisma, corners, products)` matches the test. `getPlacement` private, used by findOne/update/remove. ✓
- Partial-done marked: Task 1 Step 1 (schema) and Task 3 Step 1 (`assertManages`) are `[x]` — done by the developer.
