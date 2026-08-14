# The Shelf With No Owner Column: Placing Products on a Corner

> Inventra Phase 5 — where the catalog meets the corners, and a row learns to be owned without owning a company id.
> 2026-08-15

## Intro

Inventra is a multi-tenant inventory SaaS on the Korean concession model — companies run "corners" inside physical stores. Phase 3 built the catalog (*what* you sell); Phase 4 built the corners (*who operates where*). Phase 5 is the join between them: `CompanyStoreProduct` — a product placed on a specific corner's shelf, with a stock target. It looked like routine CRUD. It turned out to be the phase that taught me the most about *derived* ownership, and about the friction between soft-delete and a database that doesn't know what soft-delete is.

## Architectural Decisions

### 1. Ownership through the corner — a row with no company id

**Goal.** Tenant-scope placements like every other resource.
**The problem.** `company_store_products` has `companyStoreId` and `productId` but **no `companyId`**. Unlike products (`companyId`) or brands (`createdByCompanyId`), a placement has no owner column of its own.
**Options.** (a) Add a redundant `companyId`, denormalizing the corner's; (b) scope every query through a join (`where: { companyStore: { companyId } }`); (c) resolve the corner first — it's already tenant-scoped — and operate beneath it.
**Choice.** **(c)** — reuse `CornersService`. Every placement op resolves its corner through the corner service's already-scoped lookup, then filters placements by `companyStoreId`. The corner *is* the tenant boundary; once it's proven yours, its shelf is yours.
**Reason.** No denormalized column to keep in sync, no fragile join sprinkled across queries. Ownership is derived exactly once, where it already lives.
**Result.** And a bonus fell out of the **nested URL** (`/corners/:cornerId/products`): the corner — and therefore the company — comes from the *path*, which reshaped how ADMIN targets a tenant (see TIL).

### 2. Soft-delete meets a unique constraint that ignores it

**Goal.** "Remove" a placement without hard-deleting it (it accrues order/inventory history), and let a removed product be placed again later.
**The friction.** The table has `UNIQUE(product_id, company_store_id)` — one placement per product per corner — and that constraint **does not know about `deletedAt`**. So a soft-deleted placement still occupies the slot; re-inserting the same product blows up on the unique index.
**Options.** (a) Drop the DB constraint, enforce uniqueness in code among non-deleted rows; (b) 409 on re-placement and make the user "reactivate" by hand; (c) **revive** — on create, if a soft-deleted row exists for `(product, corner)`, un-delete it instead of inserting.
**Choice.** **(c) revive-on-replace.**
```ts
const existing = await this.prisma.companyStoreProduct.findFirst({
  where: { productId, companyStoreId: cornerId }, // includes soft-deleted
});
if (existing && !existing.deletedAt) throw new ConflictException('Already placed');
if (existing) return this.prisma.companyStoreProduct.update({
  where: { id: existing.id },
  data: { ...fields, deletedAt: null, deletedByUserId: null }, // revive
});
return this.prisma.companyStoreProduct.create({
  data: { ...fields, companyStoreId: cornerId, productId },
});
```
**Reason.** Keeping the constraint preserves a real DB invariant; reviving makes "place a product I once removed" just work, and it even preserves the row's downstream history. Dropping the constraint would push a database-level guarantee up into application code.
**Result.** `create` has three outcomes — 409 (live), revive (soft-deleted), insert (new) — and the e2e proves a delete-then-replace returns the *same row id*.

### 3. Two sibling auth helpers, kept apart on purpose

**Goal.** Authorize corner operations for the right people.
Two different questions were hiding in here:
- Who can manage the corner's **staff roster**? OWNER/ADMIN + the MANAGER who manages it. Never a staffer.
- Who can touch the corner's **shelf**? Same — *plus* the STAFF member assigned to it.

**Options.** One helper with a flag; or two named helpers.
**Choice.** **Two.** `assertManages` (roster) and `assertWorksCorner` (shelf), both doing `findOne` + a role check + returning the corner.
```ts
async assertWorksCorner(caller, cornerId) {
  const corner = await this.findOne(caller, cornerId);       // company-scoped → 404
  if (caller.roleCode === 'MANAGER' && corner.managerUserId !== caller.id) throw new ForbiddenException();
  if (caller.roleCode === 'STAFF'   && caller.companyStoreId !== cornerId) throw new ForbiddenException();
  return corner;
}
```
**Reason.** A boolean flag (`allowStaff`) would collapse two security policies into one call site, where a wrong argument silently widens access. Two names make the intent unmissable — and it's defense-in-depth: even though STAFF can't reach the roster endpoints (they lack the permission), the roster helper *also* refuses them.
**Result.** Placements call `assertWorksCorner`; staff-assignment calls `assertManages`; neither can be mistaken for the other.

### 4. The lone staffer and the delivery truck

**Goal.** Decide whether STAFF can change a shelf at all.
**The scenario that settled it.** A delivery arrives and the only person in the corner is a staffer. If they can't create a placement, the shelf can't reflect reality until a manager logs in.
**Options.** STAFF read-only; STAFF write any corner in the company; STAFF write only their assigned corner.
**Choice.** **Write only their assigned corner** (`caller.companyStoreId === cornerId`).
**Reason.** It matches the real world (you run the corner you're stationed at) and keeps the hierarchy sane — a staffer isn't suddenly more powerful than a manager (who's row-scoped to corners they manage). "Write any corner" would make STAFF *out-reach* MANAGER, which is backwards.
**Result.** It forced `companyStoreId` onto `AuthUser` — the guard now selects it so the STAFF-assigned check has something to compare against. A small addition to the auth layer that unlocked a real operational workflow.

## TIL (Today I Learned)

**For ADMIN cross-tenant placement, don't we need `companyStoreId` (or `companyId`) in the create DTO?**
No — and realizing *why* was the nicest moment of the phase. In Phases 3–4 the create endpoints were top-level (`POST /products`), so ADMIN had to name the target company in the body. But placement is *nested* (`POST /corners/:cornerId/products`): the target corner is in the URL, and ADMIN's scoped lookup returns `{}` (no company filter), so ADMIN can resolve any corner by id. The company falls out of the resolved corner. **Nested resources move ADMIN's targeting from a body field to the path.**

**Why was `assertManages` dead code while `assertCanManageStaff` was doing the work?**
Because I'd added `assertManages` (a combined `findOne` + check + return-corner) but hadn't wired it in — `addStaff`/`removeStaff` still called the old *pure* `assertCanManageStaff`. The fix was the refactor: point them at `assertManages` and delete the old one. Lesson: adding the new helper and migrating the callers are two steps, and leaving them half-done is exactly the "why is this unused?" smell.

**How do you soft-delete a row that a unique constraint won't let you re-create?**
You don't fight the constraint — you *reuse the row*. A `UNIQUE(product, corner)` that ignores `deletedAt` means the soft-deleted row still owns the slot, so "placing again" has to become "un-deleting." Revive-on-replace. (The other classic answer is a partial unique index over `WHERE deleted_at IS NULL` — but reviving keeps the row's history intact, which we wanted anyway.)

## NestJS Concepts & Libraries

| Concept / Library | Why we used it |
|---|---|
| Nested routes (`@Controller('corners/:cornerId/products')`) | A placement is a corner's shelf; the corner (and tenant) comes from the path. |
| Cross-module DI + `exports` | `PlacementsModule` injects `CornersService` + `ProductsService`; both modules had to export them. |
| Fetch-then-decide (`findInCompany`, `assertWorksCorner`) | Owning services resolve/validate; the caller decides the 400/403/404. |
| `@RequirePermissions('placements.*')` + a row check | Coarse RBAC at the guard, row-level (managed/assigned) rule in the service. |
| Prisma soft-delete + revive | `deletedAt`/`deletedByUserId`; reconcile the unique constraint by un-deleting. |
| `@nestjs/mapped-types` `OmitType`/`PartialType` | `UpdatePlacementDto` drops `productId` — you don't re-point a placement. |
| `class-validator` (`@IsUUID`, `@IsInt`, `@Min`, `@IsBoolean`) | Edge validation of the placement fields. |
| `ParseUUIDPipe` + `ParseIntPipe` | `cornerId` is a UUID, `placementId` an int. |
| Jest + supertest | Unit mocks the two owning services; e2e drives the full nested flow. |

## Wrap-up

Phase 5 was about *derived* things: ownership derived from a corner instead of a column, an ADMIN target derived from a URL instead of a body, a "new" placement derived from reviving an old one. The catalog and the corners are finally connected — a product can sit on a specific shelf with a target stock level, curated by whoever actually works that corner.

**Next — Phase 6: inventory transactions.** So far every quantity has been a *plan* (`targetStockQuantity`). Phase 6 moves real stock — `currentQuantity`, `sampleQuantity`, `reservedQuantity` — through a single centralized write. That's where the atomic `updateMany`/`$transaction` pattern I've been deferring since Phase 4 finally becomes non-negotiable: when two requests decrement the same shelf at once, a check-then-act race is an oversell — and an oversell is a refund.
