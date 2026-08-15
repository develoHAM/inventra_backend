# Phase 6 — Inventory Transactions Design

- **Project:** Inventra (multi-tenant inventory management SaaS)
- **Date:** 2026-08-16
- **Status:** Design approved; pending implementation plan
- **Depends on:** Phase 5 (placements / `CompanyStoreProduct`, `assertWorksCorner`), Phase 4 (Corners), Phase 2 (`OwnershipService`, `AuthUser`)

## 1. Goal & Scope

Move **real stock** on a placement through a **single, centralized, atomic write** that (a) appends an immutable `InventoryTransaction` ledger row and (b) adjusts the affected quantity bucket(s) — both in one DB transaction so the audit trail and the balances can never diverge. This is the phase where the atomic `updateMany`/`$transaction` pattern (deferred since Phase 4) becomes mandatory: concurrent decrements on one shelf must not oversell.

**In scope:** the inventory-transaction engine (`InventoryService.record`), the 17 transaction types and their bucket effects, a `damagedQuantity` column, the nested record/read endpoints, 2 permissions, one migration.

**Out of scope (later phases):** `reservedQuantity` movement (reservations phase), and order/audit/reservation *sources* that will *call* this engine. The engine is designed to accept an optional `source` so those phases reuse it; Phase 6's manual endpoint passes none.

## 2. Key Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Balance model | **Four buckets** on a placement: `currentQuantity` (sellable) + `reservedQuantity` + `sampleQuantity` + `damagedQuantity` = total physical on-hand | Each bucket is a *state* a unit can be in; the sum is the physical count. Add `damagedQuantity` so damaged stock has a home and `current` stays "sellable". |
| 2 | Ledger + balance | `InventoryTransaction` is an **append-only ledger**; the bucket columns are the **running balance**. Every movement writes one ledger row **and** the balance delta, **atomically** | Immutable audit history; the balance is the ledger's running total. Both-or-neither = no drift. |
| 3 | Atomicity | `prisma.$transaction` wrapping a **guarded conditional `updateMany`** per decrement + the ledger insert | The `where: { <field>: { gte: q } }` guard makes check-and-decrement one statement → no oversell under concurrency. |
| 4 | Negative stock | **Hard block → 409** | A decrement whose guarded `updateMany` touches 0 rows means insufficient stock. Race-safe, no negatives. |
| 5 | ADJUSTMENT | **Set current to the counted total** (absolute); engine computes the delta | Matches a physical stock-take; reused by the later AUDIT source. |
| 6 | Type effects | 17 types → external (±total) / internal-transfer (`SAMPLE_ALLOCATION`, `BREAKAGE`) / `ADJUSTMENT`; driven by a data map | The engine is type-agnostic; a lookup table holds the domain. |
| 7 | API shape | **Nested** under the placement: `/corners/:cornerId/products/:placementId/transactions` | Corner-scoping + placement resolution fall out of the path; consistent with Phase 5. |
| 8 | Auth | Through the corner via `assertWorksCorner` (writes) / `findOne` (reads) | Same model as placements — OWNER/ADMIN any · MANAGER managed · STAFF assigned. A floor staffer records sales/restocks. |
| 9 | Immutability | Ledger is **create + read only** (no update/delete) | You correct a mistake by posting a compensating transaction, never by editing history. |
| 10 | Reusable engine | `InventoryService.record(caller, cornerId, placementId, dto, source?)` takes an optional `source` (`{ type, id }`) | Orders/audits/reservations will call it later with a `sourceType`/`sourceId`; the manual endpoint passes none. |

## 3. Data Model Changes (one migration)

**(a) Add the damaged bucket to `CompanyStoreProduct`:**
```prisma
model CompanyStoreProduct {
  // ... existing quantity buckets ...
  damagedQuantity Int @default(0) @map("damaged_quantity")
}
```

**(b) Extend `InventoryTransactionType`** (14 → 17: add `CUSTOMER_RETURN`, `CUSTOMER_DAMAGED_RETURN`, `BREAKAGE`), documented per value:
```prisma
enum InventoryTransactionType {
  /// First stock-in when a placement is stocked. current +q.
  INITIAL_STOCK
  /// Replenishment delivery from the supplier. current +q.
  RESTOCK
  /// Sellable stock received from another corner. current +q.
  TRANSFER_IN
  /// A customer returns a sellable item — back on the shelf. current +q.
  CUSTOMER_RETURN
  /// Sold to a customer. current -q.
  SALE
  /// Sellable stock sent to another corner. current -q.
  TRANSFER_OUT
  /// The corner returns good stock to the supplier. current -q.
  RETURN
  /// Stock-take correction — sets current to the counted total (absolute).
  ADJUSTMENT
  /// A customer returns a damaged (non-sellable) item. damaged +q.
  CUSTOMER_DAMAGED_RETURN
  /// Sellable stock found damaged on-site (breakage/spoilage). current -q, damaged +q.
  BREAKAGE
  /// Damaged stock thrown away. damaged -q.
  DAMAGED_DISPOSAL
  /// The corner returns damaged stock to the supplier. damaged -q.
  DAMAGED_RETURN
  /// Sellable stock set aside as display/tester samples. current -q, sample +q.
  SAMPLE_ALLOCATION
  /// Samples received from another corner. sample +q.
  SAMPLE_TRANSFER_IN
  /// Samples sent to another corner. sample -q.
  SAMPLE_TRANSFER_OUT
  /// The corner returns a sample to the supplier. sample -q.
  SAMPLE_RETURN
  /// A sample is used up or thrown away. sample -q.
  SAMPLE_DISPOSAL

  @@map("inventory_transaction_type")
}
```

Both changes are additive (new nullable-defaulted column; new enum values) → clean migration, no backfill. `InventoryTransaction` itself already has every field we need (`quantity`, `quantityBefore`, `quantityAfter`, `createdByUserId`, `sourceType`, `sourceId`).

## 4. Transaction Effect Map

The engine reads a static map `type → effect`. An **effect** is either a set of signed bucket deltas, or an absolute set.

| Type | Effect | family |
|---|---|---|
| `INITIAL_STOCK` `RESTOCK` `TRANSFER_IN` `CUSTOMER_RETURN` | current **+q** | external in |
| `SALE` `TRANSFER_OUT` `RETURN` | current **−q** | external out |
| `CUSTOMER_DAMAGED_RETURN` | damaged **+q** | external in |
| `DAMAGED_DISPOSAL` `DAMAGED_RETURN` | damaged **−q** | external out |
| `SAMPLE_TRANSFER_IN` | sample **+q** | external in |
| `SAMPLE_TRANSFER_OUT` `SAMPLE_RETURN` `SAMPLE_DISPOSAL` | sample **−q** | external out |
| `SAMPLE_ALLOCATION` | current **−q**, sample **+q** | internal transfer |
| `BREAKAGE` | current **−q**, damaged **+q** | internal transfer |
| `ADJUSTMENT` | current **:= q** (absolute) | set |

Shape (illustrative):
```ts
type Bucket = 'currentQuantity' | 'sampleQuantity' | 'damagedQuantity';
type Effect =
  | { kind: 'delta'; deltas: { field: Bucket; sign: 1 | -1 }[]; primary: Bucket }
  | { kind: 'set';   field: 'currentQuantity' };
```
`primary` is the bucket whose value the ledger records as `quantityBefore`/`quantityAfter` (for cross-field transfers it's `currentQuantity`, the source side).

## 5. The Atomic Write (`InventoryService.record`)

```
record(caller, cornerId, placementId, dto, source?):
  corner    = corners.assertWorksCorner(caller, cornerId)     // 404 / 403
  placement = companyStoreProduct.findFirst({ id: placementId, companyStoreId: cornerId, deletedAt: null })
              // → 404 if absent
  effect = EFFECTS[dto.transactionType]
  validate dto.quantity (≥ 1 for movements; ≥ 0 for ADJUSTMENT)

  return prisma.$transaction(async tx => {
    read the placement's affected bucket value(s) for before/after
    for each decrement delta:
      const { count } = tx.companyStoreProduct.updateMany({
        where: { id: placementId, [field]: { gte: q } },
        data:  { [field]: { decrement: q } },
      })
      if (count === 0) throw new ConflictException('Insufficient stock')   // 409
    for each increment delta:
      tx.companyStoreProduct.update({ where: { id: placementId }, data: { [field]: { increment: q } } })
    if ADJUSTMENT:
      before = placement.currentQuantity; after = q
      tx.companyStoreProduct.update({ where: { id: placementId }, data: { currentQuantity: q } })
    insert InventoryTransaction { companyStoreProductId: placementId, transactionType, quantity,
        quantityBefore, quantityAfter, remarks, createdByUserId: caller.id,
        sourceType: source?.type ?? null, sourceId: source?.id ?? null }
  })
```

- The **guarded `updateMany`** is what prevents oversell: the `gte: q` predicate and the decrement happen in one atomic statement, so two concurrent `SALE`s of the last unit can't both succeed — the second sees `count === 0` → 409.
- Everything runs inside `$transaction`, so the ledger row and the balance change commit together or not at all.
- `quantityBefore`/`quantityAfter` record the **primary** bucket's value around the change (audit trail).

## 6. Module Structure

```
src/inventory/  { inventory.module, inventory.service, inventory.controller, dto/, inventory-effects.ts }
```
- `InventoryModule` imports `CornersModule` (for `assertWorksCorner`/`findOne`). Exports `InventoryService` so later phases (orders/audits/reservations) can call `record` with a `source`.
- `InventoryService.record(...)` is the centralized write; `findForPlacement(caller, cornerId, placementId)` returns the ledger history.
- `inventory-effects.ts` holds the `EFFECTS` map (the domain table from §4).

## 7. Endpoints

Nested under the placement (`cornerId` UUID → `ParseUUIDPipe`; `placementId` int → `ParseIntPipe`):

- `POST /corners/:cornerId/products/:placementId/transactions` (`transactions.create`) — body `{ transactionType, quantity, remarks? }`; records a movement, returns the created transaction. → 409 on insufficient stock.
- `GET /corners/:cornerId/products/:placementId/transactions` (`transactions.read`) — the placement's ledger, newest first.

The current balances are already visible via the Phase 5 `GET /corners/:cornerId/products/:placementId` (the placement row carries `current`/`sample`/`damaged`/`reserved`), so no separate balance endpoint.

`CreateTransactionDto`: `@IsEnum(InventoryTransactionType) transactionType`; `@IsInt() @Min(0) quantity`; `@IsOptional() @IsString() remarks`. (Service rejects `quantity < 1` for non-`ADJUSTMENT` types.)

## 8. Ownership & Auth

Transactions mutate stock, so they use the **write** guard: `corners.assertWorksCorner(caller, cornerId)` (OWNER/ADMIN any · MANAGER managed · STAFF assigned). The placement is then resolved scoped to that corner (`companyStoreId = cornerId`, `deletedAt: null`) → 404 if absent/cross-corner. Reads use `corners.findOne` (any company member) + the scoped ledger query. A soft-deleted placement accepts no transactions (404).

## 9. Permissions (seed additions)

**Two new rows:** `transactions.create`, `transactions.read`. Total 33 → **35**.

| Permission | OWNER | MANAGER | STAFF | ADMIN |
|---|:---:|:---:|:---:|:---:|
| `transactions.read` | ✓ | ✓ | ✓ | (wildcard) |
| `transactions.create` | ✓ | ✓ * | ✓ * | (wildcard) |

\* MANAGER/STAFF hold `transactions.create`, but the service fences it to corners they manage / are assigned to (via `assertWorksCorner`), exactly like placements.

## 10. Error Handling

| Situation | Response |
|---|---|
| Corner not the caller's / not managed / not assigned | 404 / 403 |
| Placement absent on this corner (or soft-deleted) | 404 |
| Decrement would go below 0 (insufficient stock) | 409 |
| `quantity < 1` for a movement type (non-ADJUSTMENT) | 400 |
| Invalid `transactionType` | 400 |
| Missing permission | 403 · Unauthenticated | 401 |

## 11. Testing

- **Unit (`InventoryService`, mocked `$transaction`/Prisma + `CornersService`):** each effect family (current in/out, sample, damaged, the two cross-field transfers, ADJUSTMENT absolute); the guarded decrement → 409 when the conditional `updateMany` returns `count 0`; ledger row fields (type, quantity, before/after, source null); `quantity < 1` rejection; placement 404. Verify decrements use the `gte` guard, not a read-then-write.
- **`inventory-effects.ts`:** a table test asserting every `InventoryTransactionType` has an effect (no unmapped type).
- **e2e (`inventory.e2e-spec.ts`):** RESTOCK raises `current`; SALE lowers it; **overselling → 409** and leaves the balance unchanged; ADJUSTMENT sets `current` to a count; BREAKAGE moves current→damaged (total unchanged); a STAFF member assigned to the corner can record a SALE; a foreign MANAGER is 403; the ledger `GET` lists the history; cross-tenant placement → 404.

## 12. Open Items

- **Reservations phase:** moves `current ↔ reserved` (a `current → reserved` internal transfer) and will call `record` with `sourceType: RESERVATION`.
- **Orders / audits phases:** create transactions with `sourceType: ORDER`/`AUDIT` (audits drive `ADJUSTMENT`s from a count).
- Per-bucket `ADJUSTMENT` (e.g. correcting a sample or damaged count) is deferred — Phase 6 `ADJUSTMENT` targets `current` only.
- A future `DAMAGE`-style stock-take for the damaged bucket, if a real need appears.
