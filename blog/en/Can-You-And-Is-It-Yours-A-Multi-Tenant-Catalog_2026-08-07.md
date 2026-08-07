# Can You, and Is It Yours? Shipping a Multi-Tenant Product Catalog

> Inventra Phase 3 — where two-layer authorization finally meets a real feature.
> 2026-08-07

## Intro

Inventra is a multi-tenant inventory-management SaaS built on the Korean concession-store model — companies operate "corners" inside physical stores. The first two phases built plumbing you couldn't demo: Phase 1 was authentication (two tokens and a join code), Phase 2 was authorization (a `PermissionsGuard` plus a tenant-scoping `OwnershipService`).

Phase 3 is the first time that plumbing carries real water — a **product catalog** of categories, brands, and products. From here on, every request has to answer two separate questions:

- **Can you?** — do you hold the permission? (`@RequirePermissions`)
- **Is it yours?** — does this row belong to your company? (`OwnershipService`)

The catalog is where those two questions finally collide, and it turned out that the interesting design work lives in the gap between them.

## Architectural Decisions

### 1. Three resources, two ownership models

**Goal.** Model a catalog where a product references a brand and a category — but not every resource belongs to a tenant.

**Options.** (a) Make everything company-owned; (b) make everything global; (c) mix global reference data with company-owned data.

**Choice.** Mixed. **Categories are global** — a shared hierarchy, ADMIN-managed, readable by every role. **Brands and products are company-owned** and tenant-scoped.

**Reason.** A category like "Beverages" is the same fact for every tenant; duplicating it per company would be pure noise. A brand or a product, though, is a company's private inventory. The *nature of the data* dictates the ownership model — not a craving for consistency.

**Result.** Categories skip tenant scoping entirely (writes gated to ADMIN by permission, reads open to all), while brands and products flow through `OwnershipService`. One domain, two clearly-labeled halves — and a product neatly bridges them by referencing one of each.

### 2. One scoping helper, two owner columns

**Goal.** Tenant-scope both products (owner column `company_id`) and brands (owner column `created_by_company_id`) with a single helper.

**Options.** (a) Two separate methods; (b) parameterize the column name.

**Choice.** Extend the Phase 2 helper with an optional field name:

```ts
scopeToCompany(user: AuthUser, field = 'companyId'): Record<string, string> {
  if (user.roleCode === 'ADMIN') return {};              // ADMIN: no filter, see all
  if (!user.companyId) throw new ForbiddenException();    // company user must have one
  return { [field]: user.companyId };                     // pin to their company
}
```

Products call `scopeToCompany(caller)`; brands call `scopeToCompany(caller, 'createdByCompanyId')`.

**Reason.** The logic is identical — ADMIN sees everything, a company user is pinned to their `companyId`, a user with no company is rejected. Only the *column* differs. A default parameter keeps every existing Phase 2 call site compiling unchanged.

**Result.** Spread it straight into a Prisma `where` and the tenant boundary is enforced on every read:

```ts
where: { ...this.ownership.scopeToCompany(caller, 'createdByCompanyId'), deletedAt: null }
```

Because single-record lookups use a *scoped* `findFirst`, a cross-tenant id simply returns `null` → 404. No existence leak — you can't even confirm another company's brand exists.

### 3. Fetch-then-decide: who owns the error?

This is the decision I'm proudest of, and it came straight out of a question I asked mid-build.

**Goal.** Product creation must validate that the referenced brand belongs to the caller's company and the category exists. Where does that validation live?

**Options.** (a) `ProductsService` reaches directly into the brands/categories tables; (b) `BrandsService`/`CategoriesService` expose `assert…()` methods that *throw* when missing; (c) they expose a plain lookup that returns **row-or-null**, and `ProductsService` decides what a `null` means.

**Choice.** (c). Each owning service exposes a lookup that never throws:

```ts
// BrandsService — scoped to a company, returns the row or null
findInCompany(brandId: number, companyId: string) {
  return this.prisma.brand.findFirst({
    where: { id: brandId, createdByCompanyId: companyId, deletedAt: null },
  });
}
```

```ts
// ProductsService.create — it decides that "not found" here means 400
const brand = await this.brands.findInCompany(data.brandId, companyId);
if (!brand) throw new BadRequestException('Invalid brand');

const category = await this.categories.findActive(data.categoryId);
if (!category) throw new BadRequestException('Invalid category');
```

**Reason.** A "not found" means different things to different callers. To someone fetching a brand by URL, a missing brand is a **404**. To product-creation, a missing (or cross-tenant) brand is a **400** — *you handed me a bad reference*. If `BrandsService` threw `NotFoundException`, `ProductsService` would have to catch-and-rethrow to fix the status code. Letting the owning service **find** (with its own tenant scoping baked in) and the calling service **decide** keeps each error semantic exactly where it belongs.

**Result.** Clean separation of concerns: brands and categories own the *lookup* (and its scoping); products own the *creation policy*. And `BrandsService.findInCompany` is reusable — `update()` re-validates a changed brand against the product's company with the same call.

### 4. Creator-scoped delete: row-level rules beyond RBAC

**Goal.** Let managers delete products — but only the ones they created.

**Options.** (a) Invent a `products.delete.own` permission; (b) check the row in the service after fetching it.

**Choice.** MANAGER simply holds `products.delete`; the service adds a row-level guard:

```ts
async remove(caller: AuthUser, id: string) {
  const product = await this.findOne(caller, id); // company-scoped → 404 if not theirs
  if (caller.roleCode === 'MANAGER' && product.createdByUserId !== caller.id) {
    throw new ForbiddenException('You can only delete products you created');
  }
  return this.prisma.product.update({
    where: { id },
    data: { deletedAt: new Date(), deletedByUserId: caller.id },
  });
}
```

**Reason.** Permissions answer a *binary* question: "may this role delete products?" They can't express "…but only their own," because that depends on the specific row. Row-level facts belong in the service, after the row is fetched.

**Result.** OWNER deletes any of the company's products; MANAGER only their own. The response is **403, not 404** — deliberately. The product *is* visible to the manager (it's in their company); they simply may not delete someone else's. 404 would be a lie.

### 5. Soft delete, and who pulled the trigger

**Goal.** Never hard-delete catalog rows; also record *who* deleted each one.

**Choice.** Every soft-deletable table gets `deletedAt` **and** a nullable `deletedByUserId` FK to `users`. Deletes stamp both; every read filters `deletedAt: null`. This became a convention for all future resources.

**Reason & Result.** Soft delete alone answers "is this gone?" but not "who removed it?" — and in a multi-tenant, multi-role system, an audit trail of deletions is worth its weight. The wrinkle: `User` already relates to `Product`/`Brand` via `createdByUser`, so a *second* relation on the same pair of models needs a name, or Prisma can't tell them apart:

```prisma
model Product {
  deletedByUserId String? @map("deleted_by_user_id") @db.Uuid
  deletedByUser   User?   @relation("ProductDeletedBy", fields: [deletedByUserId], references: [id])
}
```

### 6. ADMIN as a first-class cross-tenant operator

**Goal.** The platform admin needs to work across all companies.

The spec originally said ADMIN *couldn't* create brands/products — it has no company to own the row. Mid-implementation I flipped it: ADMIN gets **full cross-tenant CRUD** and simply names the target company on create.

**Choice.** A tiny resolver decides the owning company:

```ts
resolveCompanyForCreate(caller: AuthUser, requestedCompanyId?: string): string {
  const companyId = caller.roleCode === 'ADMIN' ? requestedCompanyId : caller.companyId;
  if (!companyId) throw new BadRequestException('companyId is required');
  return companyId;
}
```

**Reason.** A company user should never be able to spoof another tenant, so their company always comes from the token — the DTO's `companyId` is ignored for them. ADMIN, by contrast, *is* the cross-tenant operator: it must be explicit and name a target (400 if it forgets). One function encodes both rules.

**Result.** The DTO carries an optional `companyId` that only ADMIN can meaningfully use; `UpdateProductDto` omits it entirely (`PartialType(OmitType(CreateProductDto, ['companyId'] as const))`) — you don't hand a product to a different company via an edit.

## TIL (Today I Learned)

**Why `as const` in `OmitType(CreateBrandDto, ['companyId'] as const)`?**
Without it, TypeScript infers the array's type as `string[]`, so `OmitType` only knows you're removing "some strings" — the resulting type still *thinks* it might have `companyId`. `as const` makes the literal a `readonly ['companyId']` tuple, so the type system can subtract exactly that key and give you a precisely-typed DTO. It's the difference between "an array of strings" and "this one specific key."

**Why let the owning service return `null` instead of throwing?**
Because the *caller* knows what the absence means, and the finder doesn't. A brand that isn't found is a 404 to a URL fetch but a 400 to product-creation. Return the raw fact (row or null) and let each caller translate it into the right HTTP story. Throwing bakes in one interpretation and forces everyone else to catch-and-rethrow.

**`if (!caller.companyId) throw new ForbiddenException()` — wait, that rejects ADMIN too.**
I almost guarded product-create with a blanket "must have a company" check. But ADMIN legitimately has *no* company (`companyId: null`). The blanket check would 403 the one role that's allowed to do the most. The fix was to funnel the decision through `resolveCompanyForCreate`, which branches on `roleCode` *before* it ever looks at `companyId`. Lesson: "must have X" checks are exactly where ADMIN's null-company special case bites you.

**The bug my unit tests couldn't see: `@Controller()` vs `@Controller('brands')`.**
`BrandsController` was declared `@Controller()` with no prefix — so its routes mounted at the app root (`POST /`, `GET /:id`) instead of `/brands`. All 86 unit tests stayed green, because they call the *service* directly and never touch the router. The e2e caught it instantly: `POST /brands` returned 404. That's the whole point of an end-to-end test — it exercises the wiring (routing, guards, pipes) that unit tests deliberately stub out. Green units are necessary, not sufficient.

**Prisma named relations: why `deletedByUser` needs a name.**
When two relations connect the *same* two models (`User` ↔ `Product`, once for `createdBy` and once for `deletedBy`), Prisma can't infer which foreign key belongs to which relation. Naming them (`@relation("ProductDeletedBy", …)`) disambiguates the pair — and the `User` side gets the matching back-relation (`deletedProducts Product[] @relation("ProductDeletedBy")`).

## NestJS Concepts & Libraries

| Concept / Library | Why we used it |
|---|---|
| `@Controller('prefix')` | The route prefix that mounts a controller's handlers under a path — the one I forgot on brands. |
| `@RequirePermissions()` + `PermissionsGuard` | The "can you?" layer — declarative RBAC per route, checked by a global guard. |
| `OwnershipService` (custom provider) | The "is it yours?" layer — tenant scoping via `companyId`, injected into brands/products. |
| Cross-module DI (`imports`/`exports`) | `ProductsModule` imports `BrandsModule` + `CategoriesModule` to reuse their scoped lookups. |
| `@nestjs/mapped-types` (`PartialType`, `OmitType`) | Derive `UpdateXDto` from `CreateXDto` while dropping `companyId` — DRY DTOs. |
| `class-validator` DTOs (`@IsInt`, `@IsUUID`, `@IsOptional`, …) | Declarative request validation at the edge, before the service runs. |
| `ParseIntPipe` / `ParseUUIDPipe` | Coerce + validate route params (int ids for brands/categories, uuid for products). |
| `@CurrentUser()` (custom param decorator) | Pull the authenticated `AuthUser` (with `roleCode`, `companyId`) off the request. |
| Prisma named relations + soft delete | Two `User` relations per table (`createdBy`/`deletedBy`) and `deletedAt`-filtered reads. |
| Jest (unit) + supertest (e2e) | Unit specs mock Prisma to test service logic; e2e drives real HTTP to test the wiring. |

## Wrap-up

Phase 3 turned two guards into a working feature. The catalog now enforces both questions on every request — *can you?* and *is it yours?* — with a clean split between the RBAC layer, the tenant-scoping layer, and the row-level policies (creator-scoped delete) that neither can express alone. Along the way I learned to let the caller own the error, to treat ADMIN's null company as a first-class case, and to trust the e2e to catch the wiring bugs my unit tests structurally can't.

**Next up — Phase 4: store placement.** Products exist, but they aren't *anywhere* yet. Phase 4 places catalog products into physical store corners (`CompanyStoreProduct`), which is where the composite foreign keys I set up back in Phase 0 finally earn their keep.
