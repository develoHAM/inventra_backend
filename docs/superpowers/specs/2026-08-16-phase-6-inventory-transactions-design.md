# Phase 6 — Inventory Transactions Design

- **Project:** Inventra (multi-tenant inventory management SaaS)
- **Date:** 2026-08-16
- **Status:** Design approved; pending implementation plan
- **Depends on:** Phase 5 (placements / `CompanyStoreProduct`, `assertWorksCorner`), Phase 4 (Corners), Phase 2 (`OwnershipService`, `AuthUser`)

## 1. Goal & Scope

Move **real stock** on a placement through a **single, centralized, atomic write** that (a) appends an immutable `InventoryTransaction` ledger row and (b) adjusts the affected quantity bucket(s) — both in one DB transaction, so the audit trail and the balances can never diverge. This is the phase where the atomic `updateMany`/`$transaction` pattern (deferred since Phase 4) becomes mandatory: concurrent decrements on one shelf must not oversell.

**A modeling change lands here too:** the live balances split out of `CompanyStoreProduct` into a **1:1 `CompanyStoreProductStock` table** — separating the *hot, high-write fact* (the running balance) from the *cold, slowly-changing dimension* (the placement's product/target/config). See §2 #1 and §3.

**In scope:** the stock-table split + a light Phase 5 retrofit; the inventory-transaction engine (`InventoryService.record`); the 17 transaction types and their bucket effects; the nested record/read endpoints; 2 permissions; one migration.

**Out of scope (later phases):** `reservedQuantity` movement (reservations phase), and order/audit/reservation *sources* that will *call* this engine. The engine takes an optional `source` so those phases reuse it; Phase 6's manual endpoint passes none.

## 2. Key Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | **Balance storage** | **Split** the four balances into a **1:1 `CompanyStoreProductStock`** table (PK = FK = `companyStoreProductId`); `CompanyStoreProduct` keeps only config | Separates the hot mutable *fact* (written on every movement) from the cold *dimension*. Narrower hot rows → less WAL/MVCC-bloat per write, cache-stable metadata reads, independently tunable. It's also the natural pairing: ledger = the log, stock table = its materialized running total. |
| 2 | Buckets | `availableQuantity` (sellable) + `reservedQuantity` + `sampleQuantity` + `damagedQuantity` = total physical on-hand | Each bucket is a *state* a unit can be in; the sum is the physical count. Add `damagedQuantity` so damaged stock has a home and `current` stays "sellable". |
| 3 | Ledger + balance | `InventoryTransaction` is an **append-only ledger**; the stock row is the **running balance**. Every movement writes one ledger row **and** the balance delta, **atomically** | Immutable audit history; the balance is the ledger's running total. Both-or-neither = no drift. |
| 4 | Atomicity | `prisma.$transaction` wrapping a **guarded conditional `updateMany`** per decrement + the ledger insert | The `where: { <field>: { gte: q } }` guard makes check-and-decrement one statement → no oversell under concurrency. |
| 5 | Negative stock | **Hard block → 409** | A decrement whose guarded `updateMany` touches 0 rows means insufficient stock. Race-safe, no negatives. |
| 6 | ADJUSTMENT | **Set available to the counted total** (absolute); engine computes the delta | Matches a physical stock-take; reused by the later AUDIT source. |
| 7 | Type effects | 17 types → external (±total) / internal-transfer (`SAMPLE_ALLOCATION`, `BREAKAGE`) / `ADJUSTMENT`; driven by a data map | The engine is type-agnostic; a lookup table holds the domain. |
| 8 | API shape | **Nested** under the placement: `/corners/:cornerId/products/:placementId/transactions` | Corner-scoping + placement resolution fall out of the path; consistent with Phase 5. |
| 9 | Auth | Through the corner via `assertWorksCorner` (writes) / `findOne` (reads) | Same model as placements — OWNER/ADMIN any · MANAGER managed · STAFF assigned. A floor staffer records sales/restocks. |
| 10 | Immutability | Ledger is **create + read only** (no update/delete) | You correct a mistake with a compensating transaction, never by editing history. |
| 11 | Reusable engine | `InventoryService.record(caller, cornerId, placementId, dto, source?)` takes an optional `source` (`{ type, id }`) | Orders/audits/reservations will call it later with a `sourceType`/`sourceId`; the manual endpoint passes none. |

## 3. Data Model Changes (one migration)

**(a) Split all the numbers out of `CompanyStoreProduct` into a 1:1 stock table.** The placement becomes a pure junction/config record (`isActive`, `description`); the `targetStockQuantity` target **and** the four live balances (incl. new `damagedQuantity`) move to the new table:

```prisma
model CompanyStoreProduct {          // the DIMENSION (cold): identity + config
  // id, companyStoreId, productId, isActive, description,
  // timestamps, deletedAt/deletedByUserId ... (unchanged)
  // REMOVE: targetStockQuantity, currentQuantity, reservedQuantity, sampleQuantity  (renamed to availableQuantity on the new table)
  stock CompanyStoreProductStock?    // 1:1
}

model CompanyStoreProductStock {     // the FACT (hot): target + running balance
  companyStoreProductId Int      @id @map("company_store_product_id")   // PK = FK → enforces 1:1
  targetStockQuantity   Int      @default(0) @map("target_stock_quantity")
  availableQuantity     Int      @default(0) @map("available_quantity")
  reservedQuantity      Int      @default(0) @map("reserved_quantity")
  sampleQuantity        Int      @default(0) @map("sample_quantity")
  damagedQuantity       Int      @default(0) @map("damaged_quantity")
  updatedAt             DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId], references: [id])
  @@map("company_store_product_stocks")
}
```
`InventoryTransaction` is unchanged — it still references the **placement** (`companyStoreProductId`); the balance write targets the stock row (1:1 by that same id). The moved columns carried no meaningful data (Phase 5 never populated live quantities; `targetStockQuantity` was set on placements but the dev DB `migrate reset`s), so the migration is clean.

**(b) Extend `InventoryTransactionType`** (14 → 17: add `CUSTOMER_RETURN`, `CUSTOMER_DAMAGED_RETURN`, `BREAKAGE`), documented per value:
```prisma
enum InventoryTransactionType {
  /// First stock-in when a placement is stocked. available +q.
  INITIAL_STOCK
  /// Replenishment delivery from the supplier. available +q.
  RESTOCK
  /// Sellable stock received from another corner. available +q.
  TRANSFER_IN
  /// A customer returns a sellable item — back on the shelf. available +q.
  CUSTOMER_RETURN
  /// Sold to a customer. available -q.
  SALE
  /// Sellable stock sent to another corner. available -q.
  TRANSFER_OUT
  /// The corner returns good stock to the supplier. available -q.
  RETURN
  /// Stock-take correction — sets available to the counted total (absolute).
  ADJUSTMENT
  /// A customer returns a damaged (non-sellable) item. damaged +q.
  CUSTOMER_DAMAGED_RETURN
  /// Sellable stock found damaged on-site (breakage/spoilage). available -q, damaged +q.
  BREAKAGE
  /// Damaged stock thrown away. damaged -q.
  DAMAGED_DISPOSAL
  /// The corner returns damaged stock to the supplier. damaged -q.
  DAMAGED_RETURN
  /// Sellable stock set aside as display/tester samples. available -q, sample +q.
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

## 3a. Phase 5 Retrofit (part of this phase)

Splitting the numbers ripples into the placements module. `targetStockQuantity` now lives on the stock row, so it routes through the nested `stock` relation:
- **`PlacementsService.create`** (new placement): nested-create the stock row with the target — `stock: { create: { targetStockQuantity: dto.targetStockQuantity ?? 0 } }`; placement `data` keeps only `isActive`/`description` + `companyStoreId`/`productId`.
- **Revive-on-replace:** the soft-deleted placement already has its stock row — nested-`update` its target: `stock: { update: { targetStockQuantity: dto.targetStockQuantity ?? 0 } }`.
- **`PlacementsService.update`:** route `targetStockQuantity` to `stock: { update: { targetStockQuantity } }` (only when present); other fields stay on the placement.
- **`PlacementsService.findAll`/`findOne`:** `include: { stock: true }` so the API returns the target + balances (now on the nested `stock` object).
- Phase 5's placement unit assertions get updated for the moved fields.

## 4. Transaction Effect Map

The engine reads a static map `type → effect`. An **effect** is either a set of signed bucket deltas, or an absolute set. All fields live on the **stock** row.

| Type | Effect | family |
|---|---|---|
| `INITIAL_STOCK` `RESTOCK` `TRANSFER_IN` `CUSTOMER_RETURN` | available **+q** | external in |
| `SALE` `TRANSFER_OUT` `RETURN` | available **−q** | external out |
| `CUSTOMER_DAMAGED_RETURN` | damaged **+q** | external in |
| `DAMAGED_DISPOSAL` `DAMAGED_RETURN` | damaged **−q** | external out |
| `SAMPLE_TRANSFER_IN` | sample **+q** | external in |
| `SAMPLE_TRANSFER_OUT` `SAMPLE_RETURN` `SAMPLE_DISPOSAL` | sample **−q** | external out |
| `SAMPLE_ALLOCATION` | available **−q**, sample **+q** | internal transfer |
| `BREAKAGE` | available **−q**, damaged **+q** | internal transfer |
| `ADJUSTMENT` | available **:= q** (absolute) | set |

Shape (illustrative):
```ts
type Bucket = 'availableQuantity' | 'sampleQuantity' | 'damagedQuantity';
type Effect =
  | { kind: 'delta'; deltas: { field: Bucket; sign: 1 | -1 }[]; primary: Bucket }
  | { kind: 'set';   field: 'availableQuantity' };
```
`primary` is the bucket whose value the ledger records as `quantityBefore`/`quantityAfter` (for cross-field transfers it's `availableQuantity`, the source side).

## 5. The Atomic Write (`InventoryService.record`)

```
record(caller, cornerId, placementId, dto, source?):
  corner    = corners.assertWorksCorner(caller, cornerId)     // 404 / 403
  placement = companyStoreProduct.findFirst({ id: placementId, companyStoreId: cornerId, deletedAt: null })
              // → 404 if absent
  effect = EFFECTS[dto.transactionType]
  validate dto.quantity (≥ 1 for movements; ≥ 0 for ADJUSTMENT)

  return prisma.$transaction(async tx => {
    const stock = await tx.companyStoreProductStock.findUnique({ where: { companyStoreProductId: placementId } })
    // before/after come from `stock[effect.primary]`
    for each decrement delta:
      const { count } = await tx.companyStoreProductStock.updateMany({
        where: { companyStoreProductId: placementId, [field]: { gte: q } },
        data:  { [field]: { decrement: q } },
      })
      if (count === 0) throw new ConflictException('Insufficient stock')   // 409
    for each increment delta:
      await tx.companyStoreProductStock.update({
        where: { companyStoreProductId: placementId }, data: { [field]: { increment: q } } })
    if ADJUSTMENT:
      before = stock.availableQuantity; after = q
      await tx.companyStoreProductStock.update({
        where: { companyStoreProductId: placementId }, data: { availableQuantity: q } })
    return tx.inventoryTransaction.create({ data: {
      companyStoreProductId: placementId, transactionType, quantity,
      quantityBefore, quantityAfter, remarks, createdByUserId: caller.id,
      sourceType: source?.type ?? null, sourceId: source?.id ?? null } })
  })
```

- The **guarded `updateMany`** is what prevents oversell: the `gte: q` predicate and the decrement happen in one atomic statement, so two concurrent `SALE`s of the last unit can't both succeed — the second sees `count === 0` → 409.
- Everything runs inside `$transaction`, so the ledger row and the balance change commit together or not at all.
- `quantityBefore`/`quantityAfter` record the **primary** bucket's value around the change.

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

Current balances are visible via the Phase 5 `GET /corners/:cornerId/products/:placementId` (now with `include: { stock }`), so no separate balance endpoint.

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

- **Phase 5 retrofit:** placement `create` also creates a zeroed stock row; `findOne`/`findAll` include `stock`. Update the existing placement specs for the moved fields.
- **Unit (`InventoryService`, mocked `$transaction`/Prisma + `CornersService`):** each effect family (current in/out, sample, damaged, the two cross-field transfers, ADJUSTMENT absolute); the guarded decrement → 409 when the conditional `updateMany` on the stock table returns `count 0`; ledger row fields (type, quantity, before/after, source null); `quantity < 1` rejection; placement 404. Verify decrements use the `gte` guard, not a read-then-write.
- **`inventory-effects.ts`:** a table test asserting every `InventoryTransactionType` has an effect (no unmapped type).
- **e2e (`inventory.e2e-spec.ts`):** RESTOCK raises `current`; SALE lowers it; **overselling → 409** with the balance unchanged; ADJUSTMENT sets `current` to a count; BREAKAGE moves current→damaged (total unchanged); a STAFF member assigned to the corner records a SALE; a foreign MANAGER is 403; the ledger `GET` lists history; cross-tenant placement → 404.

## 12. Open Items

- **Reservations phase:** moves `current ↔ reserved` (a `current → reserved` internal transfer) and calls `record` with `sourceType: RESERVATION`.
- **Orders / audits phases:** create transactions with `sourceType: ORDER`/`AUDIT` (audits drive `ADJUSTMENT`s from a count).
- Per-bucket `ADJUSTMENT` (correcting a sample/damaged count) is deferred — Phase 6 `ADJUSTMENT` targets `current` only.
- Zeroing stock when a placement is soft-deleted (so a revive starts clean) is a future refinement.
