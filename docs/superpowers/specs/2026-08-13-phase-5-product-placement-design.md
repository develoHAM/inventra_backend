# Phase 5 — Product Placement Design (CompanyStoreProduct)

- **Project:** Inventra (multi-tenant inventory management SaaS)
- **Date:** 2026-08-13
- **Status:** Design approved; pending implementation plan
- **Depends on:** Phase 3 (catalog — Products), Phase 4 (Stores & Corners — `CornersService`, `OwnershipService`), Phase 2 (`AuthUser.roleCode`)

## 1. Goal & Scope

Place catalog products onto a corner's shelf: manage the **`CompanyStoreProduct`** join between a `Product` and a `CompanyStore` (corner), with a planning target. This is the seam where Phase 3 (catalog) meets Phase 4 (corners).

**In scope:** one feature module (`PlacementsModule`), nested CRUD under a corner, `targetStockQuantity` + `isActive` + `description`, soft-delete (one migration), 4 new permissions, plus two small reused lookups on existing services.

**Out of scope (later phases):** `currentQuantity` (driven by `InventoryTransaction`), `reservedQuantity` (driven by `PurchaseReservation`), `sampleQuantity` (driven by the `SAMPLE_*` transaction types), and orders/audits/reservations themselves. Those quantity fields stay at their `0` defaults in Phase 5 — placement is a *planning* link, not a stock mutation. The atomic `updateMany`/`$transaction` write pattern belongs to those later phases, not here.

## 2. Key Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Quantity scope | Phase 5 sets **`targetStockQuantity`** (+ `isActive`, `description`) only | `current`/`reserved`/`sample` are actual stock, moved by later inventory/reservation/`SAMPLE_*` transactions. Placement is planning. |
| 2 | Ownership | **Through the corner** — no `companyId` on the placement | `company_store_products` has no owner column; it's owned via `companyStore.companyId`. Resolve the corner (scoped) first, then filter placements by `companyStoreId`. |
| 3 | Removal | **Soft-delete columns** (`deletedAt` + `deletedByUserId`); `isActive` stays a separate operational toggle | Matches the app-wide convention + FK-safe (placements accrue order/inventory history). `isActive` = "selling now"; `deletedAt` = "retired". |
| 4 | Who manages | OWNER/ADMIN **+ the corner's MANAGER** (row-scoped) | A manager curates the shelf of corners they manage (`corner.managerUserId === caller.id`), else 403 — same row-level pattern as Phase 4 staff assignment. |
| 5 | URL shape | **Nested** under the corner: `/corners/:cornerId/products` | A placement is the corner's shelf; nesting makes corner-scoping fall out of the path. Consistent with Phase 4 corner sub-resources. |
| 6 | Unique vs soft-delete | On re-place, **revive** a soft-deleted row | `UNIQUE(productId, companyStoreId)` ignores `deletedAt`, so a re-insert of a previously-removed product would conflict; reviving the existing row resolves it. |
| 7 | Row-check reuse | Extract `CornersService.assertManages(caller, cornerId)` and refactor Phase 4 staff methods onto it | DRYs the "resolve corner + manager row-rule" check now shared by staff assignment and placements. |

## 3. Data Model Changes (one migration)

Add soft-delete to `company_store_products` (the only table in this phase lacking it):

```prisma
model CompanyStoreProduct {
  // ... existing fields (targetStockQuantity, sampleQuantity, reservedQuantity, currentQuantity, isActive, description) ...
  deletedAt       DateTime? @map("deleted_at") @db.Timestamptz(6)
  deletedByUserId String?   @map("deleted_by_user_id") @db.Uuid
  deletedByUser   User?     @relation("CompanyStoreProductDeletedBy", fields: [deletedByUserId], references: [id])
}
model User {
  // ... existing back-relations ...
  deletedPlacements CompanyStoreProduct[] @relation("CompanyStoreProductDeletedBy")
}
```

Migration adds a nullable `deleted_at` + `deleted_by_user_id` (uuid, FK → `users(id)`). Nullable → no backfill. No other schema change — `target_stock_quantity`, `is_active`, `description` already exist.

**Note on the existing unique constraint:** `UNIQUE(product_id, company_store_id)` (`UQ_csp_product_company_store`) stays. It does *not* include `deleted_at`, which is exactly why create must reconcile via revive (§6).

## 4. Permissions (seed additions)

**Four new permission rows:** `placements.{create,read,update,delete}`. Total grows 29 → **33**.

| Permission | OWNER | MANAGER | STAFF | ADMIN |
|---|:---:|:---:|:---:|:---:|
| `placements.read` | ✓ | ✓ | ✓ | (wildcard) |
| `placements.create` / `placements.update` / `placements.delete` | ✓ | ✓ * | — | (wildcard) |

\* MANAGER holds the write permissions, but `PlacementsService` restricts them (via `CornersService.assertManages`) to corners they manage. STAFF can read the shelf, not change it.

## 5. Module Structure

```
src/placements/  { placements.module, placements.service, placements.controller, dto/ }
```

- `PlacementsModule` imports `CornersModule` (resolve/authorize the corner), `ProductsModule` (validate the product), `AuthorizationModule`.
- **`CornersModule` must `exports: [CornersService]`** (add it) so Placements can inject it.
- **New reused lookups (fetch-then-decide):**
  - `ProductsService.findInCompany(productId, companyId)` → the live product in that company, or `null` (mirrors `BrandsService.findInCompany`). Validating against the *corner's* company is what makes ADMIN cross-tenant placement correct.
  - `CornersService.assertManages(caller, cornerId)` → the corner if the caller may manage it, else throws (404 not-theirs / 403 manager-of-another-corner). Phase 4's `addStaff`/`removeStaff` are refactored to call it.

## 6. Endpoints

All nested under `/corners/:cornerId/products`; the placement id is the `CompanyStoreProduct.id` (int).

- `GET /corners/:cornerId/products` (`placements.read`) — the corner's non-deleted shelf
- `GET /corners/:cornerId/products/:placementId` (`placements.read`)
- `POST /corners/:cornerId/products` (`placements.create`) — body `{ productId, targetStockQuantity?, isActive?, description? }`
- `PATCH /corners/:cornerId/products/:placementId` (`placements.update`) — `targetStockQuantity`/`isActive`/`description`
- `DELETE /corners/:cornerId/products/:placementId` (`placements.delete`) — soft delete

`cornerId` is a UUID (`ParseUUIDPipe`); `placementId` is an int (`ParseIntPipe`).

`UpdatePlacementDto = PartialType(OmitType(CreatePlacementDto, ['productId'] as const))` — you don't change which product a placement is for; you remove it and place another.

## 7. Ownership & Read/Write Scoping

Reads resolve the corner with the plain scoped `findOne`; writes resolve it with `assertManages` (adds the manager row-rule):

```ts
// read path
const corner = await this.corners.findOne(caller, cornerId);   // scoped → 404
// write path
const corner = await this.corners.assertManages(caller, cornerId); // → 404/403
```

Once the corner is proven to be the caller's, placements are filtered by `companyStoreId = cornerId` (+ `deletedAt: null`). A single placement is fetched with `findFirst({ where: { id: placementId, companyStoreId: cornerId, deletedAt: null } })` → absent/cross-corner id = **404**.

## 8. Create Semantics (`POST /corners/:cornerId/products`)

1. **Corner:** `assertManages(caller, cornerId)` → 404/403.
2. **Product:** `productsService.findInCompany(productId, corner.companyId)`; `null` → **400** ("invalid product" — missing, deleted, or another company's).
3. **Uniqueness / revive:** look up any placement for `(productId, cornerId)`, *including soft-deleted*:
   - a **live** one exists → **409** (already on the shelf),
   - a **soft-deleted** one exists → **revive**: clear `deletedAt`/`deletedByUserId` and apply the new `targetStockQuantity`/`isActive`/`description`,
   - none → **insert** with `companyStoreId = cornerId`, `productId`, and the provided fields (quantities default to 0).

## 8a. Deletion & isActive

- `DELETE` soft-deletes: set `deletedAt = now()` **and** `deletedByUserId = caller.id`; reads filter `deletedAt: null`.
- `isActive` is an independent operational flag toggled via `PATCH` — "selling on the shelf" vs "paused" — orthogonal to deletion. A soft-deleted placement is gone regardless of `isActive`.

## 9. Error Handling

| Situation | Response |
|---|---|
| Corner not the caller's / absent | 404 |
| MANAGER acting on a corner they don't manage | 403 |
| Invalid/foreign/deleted product | 400 |
| Placement already live for this (product, corner) | 409 |
| Placement id absent / on another corner | 404 |
| Missing permission | 403 |
| Unauthenticated | 401 |

## 10. Testing

- **Unit (`PlacementsService`):** corner resolution + manager row-rule (own → ok, another's → 403, cross-tenant → 404); product validation (400); duplicate live placement (409); **revive-on-replace** (soft-deleted row updated, not inserted); soft-delete stamps `deletedAt` + `deletedByUserId`; scoped list/get filter `deletedAt: null` and `companyStoreId`.
- **`ProductsService.findInCompany` spec:** found / wrong company / deleted → null.
- **`CornersService.assertManages` spec:** owner any corner; manager own → ok, another's → 403; cross-tenant → 404. (Existing staff-assignment tests keep passing after the refactor.)
- **e2e (`placements.e2e-spec.ts`):** OWNER places a product (201) → STAFF reads the shelf (200) but cannot place (403) → the corner's MANAGER places/updates (2xx) → a *different* corner's MANAGER is 403 → duplicate placement 409 → placing another company's product 400 → soft-delete then re-place the same product *revives* (200/201) → company 2 can't read company 1's corner shelf (404).

## 11. Open Items

- **Phase 6 — inventory transactions:** the centralized write that moves `currentQuantity`/`sampleQuantity` (and reconciles `reservedQuantity`), where the atomic `updateMany`/`$transaction` pattern becomes mandatory.
- Orders, audits, and purchase reservations remain later phases; their models already exist and stay untouched.
- The `prisma/models/*.prisma` dead files remain deletable in a future cleanup.
