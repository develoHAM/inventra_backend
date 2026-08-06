# Phase 3 — Product Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **This project's execution style:** per task I (1) teach the concepts, (2) give requirements, (3) provide full reference code, (4) write + run the tests. Code blocks below are the reference; the developer compares their own against them.

**Goal:** Build the product catalog — Categories (global), Brands and Products (company-owned) — the first feature domain consuming both `@RequirePermissions` and `OwnershipService`.

**Architecture:** Three feature modules (service/controller/DTOs each). Brands/Products import `AuthorizationModule` to inject `OwnershipService`; scoping is applied by spreading `scopeToCompany(caller[, field])` into Prisma `where`. Categories are global (ADMIN-only writes). All deletes are soft (`deletedAt` + `deletedByUserId`).

**Tech Stack:** NestJS 11, Prisma 7, class-validator, Jest + supertest.

## Global Constraints

- **Soft-delete everywhere:** set `deletedAt = new Date()` **and** `deletedByUserId = caller.id`; every read filters `deletedAt: null`.
- **Scoping:** company-owned reads/writes spread `scopeToCompany(caller[, field])`; cross-tenant id → **404**.
- **ADMIN** has no company → **cannot create** products/brands (403); manages categories; reads across all companies.
- **MANAGER `products.delete`** is restricted to own creations (`createdByUserId === caller.id`), else **403**.
- Duplicate `barcode` → **409**; invalid/foreign brand → **400**; missing category → **400**.
- Permissions per spec §4 (`categories.read` → all company roles; `categories.{create,update,delete}` → ADMIN-only).
- No schema work beyond §3 (the `Brand.deletedAt` + `deletedByUserId` additions).

---

## Task 1: Data model + permission seed

**Files:**
- Modify: `prisma/schema.prisma` (Brand `deletedAt` + `deletedByUserId` on Product/Brand/Category + User back-relations)
- Create: migration `prisma/migrations/<ts>_catalog_soft_delete_audit/`
- Modify: `prisma/seed.ts` (12 permissions + role grants)

**Interfaces (Produces):** `Product.deletedByUserId`, `Brand.deletedAt`/`deletedByUserId`, `Category.deletedByUserId`; permission codes `products.*`, `brands.*`, `categories.*`.

- [ ] **Step 1: Edit `schema.prisma`** — add per spec §3: `Brand.deletedAt`, `deletedByUserId` (+ named relation `*DeletedBy`) on Product/Brand/Category, and User back-relations `deletedProducts`/`deletedBrands`/`deletedCategories`.
- [ ] **Step 2: Migrate** — `npx prisma migrate dev --name catalog_soft_delete_audit` (all new columns nullable → applies cleanly on the empty tables). Then `npx prisma generate` if not automatic.
- [ ] **Step 3: Add permissions to `seed.ts`** — extend the permissions array with the 12 codes and the `roleGrants` map:

```ts
// permissions: append
{ code: 'categories.create', name: 'Create categories' },
{ code: 'categories.read',   name: 'Read categories' },
{ code: 'categories.update', name: 'Update categories' },
{ code: 'categories.delete', name: 'Delete categories' },
{ code: 'brands.create', name: 'Create brands' }, /* read/update/delete */
{ code: 'products.create', name: 'Create products' }, /* read/update/delete */

// role grants: append
OWNER:   [ ...existing, 'products.create','products.read','products.update','products.delete',
                        'brands.create','brands.read','brands.update','brands.delete','categories.read' ],
MANAGER: [ ...existing, 'products.create','products.read','products.update','products.delete',
                        'brands.create','brands.read','brands.update','categories.read' ],
STAFF:   [ ...existing, 'products.read','brands.read','categories.read' ],
// categories.{create,update,delete} granted to NO role → ADMIN wildcard only
```

- [ ] **Step 4: Re-seed** — `npm run seed` (idempotent upserts).
- [ ] **Step 5: Verify** — `docker compose exec postgres psql -U <user> -d inventra -c "\d products"` shows `deleted_by_user_id`; permission count is now 19 (7 + 12).
- [ ] **Step 6: Commit** — `git add prisma/ && git commit -m "feat(db): catalog soft-delete audit columns + product/brand/category permissions"`

---

## Task 2: Extend `OwnershipService.scopeToCompany`

**Files:**
- Modify: `src/authorization/ownership.service.ts`
- Test: `src/authorization/ownership.service.spec.ts`

**Interfaces (Produces):** `scopeToCompany(caller: AuthUser, field?: string): Record<string, string>` (default field `'companyId'`).

- [ ] **Step 1: Add the failing test**

```ts
it('scopes to a custom owner column when field is given', () => {
  expect(service.scopeToCompany(member, 'createdByCompanyId')).toEqual({
    createdByCompanyId: 'company-1',
  });
});
```

- [ ] **Step 2: Run → fails** (`npm test -- ownership.service`; extra key mismatch).
- [ ] **Step 3: Implement**

```ts
scopeToCompany(caller: AuthUser, field = 'companyId'): Record<string, string> {
  if (caller.roleCode === 'ADMIN') return {};
  if (!caller.companyId) throw new ForbiddenException();
  return { [field]: caller.companyId };
}
```

- [ ] **Step 4: Run → passes** (existing default-field cases still green — backward-compatible).
- [ ] **Step 5: Commit** — `git commit -m "feat(authz): scopeToCompany supports a custom owner column"`

---

## Task 3: Categories module (global, ADMIN-managed)

**Files:**
- Create: `src/categories/{categories.module,categories.service,categories.controller}.ts`, `src/categories/dto/{create-category.dto,update-category.dto}.ts`
- Test: `src/categories/categories.service.spec.ts`
- Modify: `src/app.module.ts` (import `CategoriesModule`)

**Interfaces (Produces):** `CategoriesService.{create,findAll,findOne,update,remove}`.

Categories are **global** — no `OwnershipService`. Writes require ADMIN permissions; reads require `categories.read` (all company roles). Soft-delete stamps `deletedByUserId`.

- [ ] **Step 1: DTOs**

```ts
// create-category.dto.ts
export class CreateCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(50) name!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsInt() parentCategoryId?: number;
}
// update-category.dto.ts — extends PartialType(CreateCategoryDto) from @nestjs/mapped-types
```

- [ ] **Step 2: Service** — `create`, `findAll` (`where: { deletedAt: null }`), `findOne` (404 if missing/deleted), `update`, `remove` (soft):

```ts
async remove(caller: AuthUser, id: number) {
  await this.findOne(id); // 404 if absent
  return this.prisma.category.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByUserId: caller.id },
  });
}
```

- [ ] **Step 3: Controller** — `@Controller('categories')`, `@RequirePermissions('categories.read')` on GETs, `categories.create/update/delete` on writes; `@CurrentUser()` passed to `create`/`update`/`remove`.
- [ ] **Step 4: Module + AppModule import.**
- [ ] **Step 5: Spec** (I write) — read filters deleted; `remove` stamps `deletedAt`+`deletedByUserId`; `findOne` 404s a deleted/absent id. Run → green.
- [ ] **Step 6: Commit** — `git commit -m "feat(categories): global category CRUD (ADMIN-managed)"`

---

## Task 4: Brands module (company-owned)

**Files:**
- Create: `src/brands/{brands.module,brands.service,brands.controller}.ts`, `src/brands/dto/{create-brand.dto,update-brand.dto}.ts`
- Test: `src/brands/brands.service.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces (Consumes):** `OwnershipService.scopeToCompany(caller, 'createdByCompanyId')`.

- [ ] **Step 1: DTOs** — `CreateBrandDto { name(≤100), nameKr?, description?, logoUrl? }`; `UpdateBrandDto = PartialType`.
- [ ] **Step 2: Module** imports `AuthorizationModule`; service injects `PrismaService` + `OwnershipService`.
- [ ] **Step 3: Service** — company-scoped throughout:

```ts
create(caller, dto) {
  if (!caller.companyId) throw new ForbiddenException(); // ADMIN has no company
  return this.prisma.brand.create({
    data: { ...dto, createdByCompanyId: caller.companyId },
  });
}
findAll(caller) {
  return this.prisma.brand.findMany({
    where: { ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'), deletedAt: null },
  });
}
async findOne(caller, id) {
  const brand = await this.prisma.brand.findFirst({
    where: { id, ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'), deletedAt: null },
  });
  if (!brand) throw new NotFoundException();
  return brand;
}
async remove(caller, id) {
  await this.findOne(caller, id); // scoped 404
  return this.prisma.brand.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByUserId: caller.id },
  });
}
// update: findOne(caller,id) then prisma.brand.update
```

- [ ] **Step 4: Controller** — `@Controller('brands')`, `@RequirePermissions('brands.<action>')`, `@CurrentUser()`.
- [ ] **Step 5: Spec** (I write) — create sets `createdByCompanyId`; ADMIN create → 403; findOne/remove cross-tenant → 404; remove stamps audit. Run → green.
- [ ] **Step 6: Commit** — `git commit -m "feat(brands): company-scoped brand CRUD"`

---

## Task 5: Products module (company-owned + validations + creator-delete)

**Files:**
- Create: `src/products/{products.module,products.service,products.controller}.ts`, `src/products/dto/{create-product.dto,update-product.dto}.ts`
- Test: `src/products/products.service.spec.ts`
- Modify: `src/app.module.ts`

- [ ] **Step 1: DTOs** — `CreateProductDto { name(≤255), barcode(≤100), categoryId:int, brandId:int, priceKrw:int≥0, color?, imageUrl? }`; `UpdateProductDto = PartialType`.
- [ ] **Step 2: Module** imports `AuthorizationModule`.
- [ ] **Step 3: Service `create` with validations**

```ts
async create(caller: AuthUser, dto: CreateProductDto) {
  if (!caller.companyId) throw new ForbiddenException();          // ADMIN can't create
  const brand = await this.prisma.brand.findFirst({              // brand must be YOURS
    where: { id: dto.brandId, createdByCompanyId: caller.companyId, deletedAt: null },
  });
  if (!brand) throw new BadRequestException('Invalid brand');
  const category = await this.prisma.category.findFirst({        // category must exist
    where: { id: dto.categoryId, deletedAt: null },
  });
  if (!category) throw new BadRequestException('Invalid category');
  const dup = await this.prisma.product.findUnique({ where: { barcode: dto.barcode } });
  if (dup) throw new ConflictException('Barcode already exists'); // 409
  return this.prisma.product.create({
    data: { ...dto, companyId: caller.companyId, createdByUserId: caller.id },
  });
}
```

- [ ] **Step 4: Service reads/update** — `findAll`/`findOne`/`update` scoped with `scopeToCompany(caller)` (default `companyId`) + `deletedAt: null`; cross-tenant → 404.
- [ ] **Step 5: Service `remove` (creator-scoped)**

```ts
async remove(caller: AuthUser, id: string) {
  const product = await this.findOne(caller, id);                // scoped 404
  if (caller.roleCode === 'MANAGER' && product.createdByUserId !== caller.id) {
    throw new ForbiddenException('You can only delete products you created');
  }
  return this.prisma.product.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByUserId: caller.id },
  });
}
```

- [ ] **Step 6: Controller** — `@Controller('products')`, `@RequirePermissions('products.<action>')`, `@CurrentUser()`.
- [ ] **Step 7: Spec** (I write) — create validations (brand-not-yours → 400, missing category → 400, dup barcode → 409, ADMIN → 403); scoped reads (cross-tenant 404); creator-delete (OWNER any; MANAGER own ok / another's 403); soft-delete stamps audit. Run → green.
- [ ] **Step 8: Commit** — `git commit -m "feat(products): company-scoped product CRUD with validations and creator-scoped delete"`

---

## Task 6: End-to-end catalog flow

**Files:**
- Create: `test/catalog.e2e-spec.ts`

- [ ] **Step 1: Write the flow** (I write) — bootstrap app + global pipe like `auth.e2e-spec.ts`; then: ADMIN logs in → creates a category; register + approve a company (owner) → owner creates a brand → owner creates a product; member joins + approved as STAFF → STAFF `GET /products` ok, `POST /products` → 403; approve a second MANAGER → MANAGER `DELETE`ing the owner's product → 403; a second company registered/approved → `GET /products/:id` of the first company's product → 404.
- [ ] **Step 2: Run** — `npm run test:e2e` → green.
- [ ] **Step 3: Commit** — `git commit -m "test(catalog): end-to-end product catalog flow"`

---

## Self-Review (coverage vs spec)

- §2 decisions 1–9: T1 (perms, audit cols), T2 (field param), T3–T5 (modules, scoping, validations, creator-delete), T5 (barcode 409). ✅
- §3 data model: T1. ✅  §4 permissions: T1. ✅  §5 modules: T3–T5. ✅
- §6 endpoints: T3–T5. ✅  §7 scoping: T2 + T4/T5. ✅  §8 create validations: T5. ✅  §8a deletion rules (soft-delete audit + MANAGER creator-scope): T3–T5. ✅
- §9 errors (404/403/409/400): asserted across T4–T6. ✅  §10 testing: per-task specs + T6 e2e. ✅
- Type consistency: `scopeToCompany(caller, field?)`, `deletedByUserId`, `remove(caller, id)` signatures consistent across tasks. ✅
