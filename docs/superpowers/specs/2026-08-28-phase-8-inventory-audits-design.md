# Phase 8 — Inventory Audits: Design

> Inventra Phase 8. An **audit** is a physical stock-count document filed against a corner. Building it records counts; a separate **apply** action reconciles the books — the first real caller of `InventoryService.record(..., { type: 'AUDIT' })`.

## 1. Domain & the two-step model

A corner worker walks the shelf and files an **audit**: a header (title, note, `fileUrl`, `auditedDate`) plus counted lines — one per placement, with the physically-counted `productQuantity`. Building, editing, or deleting the audit **never touches stock**.

A separate, explicit **apply** action reconciles the system to the count: for each line it records an `ADJUSTMENT` inventory transaction (Phase 6) that **sets** the placement's `availableQuantity` to the counted number, stamped `sourceType = AUDIT`, `sourceId = auditId`. Apply is **one-shot** — it stamps `appliedAt` and freezes the audit as an immutable historical record.

The two steps are separate so a manager can review the count (and the variance it will cause) before committing corrections to the books.

## 2. Decisions

1. **Two-step: count, then apply.** Building the audit is a pure document operation. Reconciliation is a distinct action that generates the ledger movements.
2. **Apply is atomic.** All per-line `ADJUSTMENT`s and the `appliedAt` stamp run in **one** `$transaction` — a failure on any line rolls the whole apply back; the shelf is never left half-reconciled.
3. **Apply-state tracked; applied audits are frozen.** `appliedAt` (+ `appliedByUserId`) mark a committed audit. Editing, deleting, or re-applying an applied audit is a `409`. Applying is blocked if `appliedAt` is already set.
4. **Full CRUD + soft-delete while unapplied.** Same lifecycle as orders (Phase 7): create, replace-all line edits, soft-delete — permitted only while `appliedAt` is null.
5. **Counts reconcile `availableQuantity` only.** A line's `productQuantity` is the counted *sellable* quantity; apply sets `availableQuantity` to it via `ADJUSTMENT`. Reserved/sample/damaged buckets are out of scope this phase.
6. **`productQuantity` allows 0.** An empty shelf is a valid count (`@Min(0)`), unlike an order's requested quantity (`@Min(1)`). `ADJUSTMENT` is a `set`, so `record` already skips its `quantity ≥ 1` guard.
7. **Reuse Phase 6 via an extracted helper.** `InventoryService.record`'s in-transaction body becomes a public `recordWithinTransaction(tx, …)`; `record` stays a thin wrapper. Apply calls the helper per line inside its own transaction. `record`'s external behavior is unchanged, so Phase 6 tests stay green.
8. **Dedicated `audits.apply` permission**, granted to all corner workers (OWNER/MANAGER/STAFF) — same roster that can count.
9. **Tenant-scoped through the corner**, nested under `/corners/:cornerId/audits`, ownership via `CornersService` (`assertWorksCorner` writes / `findOne` reads) — identical to orders.

## 3. Data model

**Schema status:** `prisma/schema.prisma` **already declares** everything below — `InventoryAudit.appliedAt`, `appliedByUserId`, `deletedAt`, `deletedByUserId`, the three named `InventoryAudit↔User` relations (`AuditsCreatedBy`, `AuditsAppliedBy`, `AuditsDeletedBy`), and the `User`-side back-relations (`createdAudits`, `appliedAudits`, `deletedAudits`). **No schema editing is required.** The database is behind: the `20260711132505_init` migration created `inventory_audits` without those four columns. The one outstanding data-model step is a **migration adding them (+ the two deleted/applied-by FKs) to `inventory_audits`** — a human runs `prisma migrate dev` (Claude's Prisma AI-guard blocks it).

The models as they already stand:

```prisma
model InventoryAudit {
  id              String    @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyStoreId  String    @map("company_store_id") @db.Uuid
  title           String    @db.VarChar(255)
  description     String?   @db.Text
  fileUrl         String?   @map("file_url") @db.VarChar(2048)
  auditedDate     DateTime  @map("audited_date") @db.Timestamptz(6)
  createdByUserId String    @map("created_by_user_id") @db.Uuid
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  appliedAt       DateTime? @map("applied_at") @db.Timestamptz(6)
  appliedByUserId String?   @map("applied_by_user_id") @db.Uuid
  deletedAt       DateTime? @map("deleted_at") @db.Timestamptz(6)
  deletedByUserId String?   @map("deleted_by_user_id") @db.Uuid

  companyStore  CompanyStore @relation(fields: [companyStoreId], references: [id])
  createdByUser User         @relation("AuditsCreatedBy", fields: [createdByUserId], references: [id])
  appliedByUser User?        @relation("AuditsAppliedBy", fields: [appliedByUserId], references: [id])
  deletedByUser User?        @relation("AuditsDeletedBy", fields: [deletedByUserId], references: [id])
  inventoryAuditItems InventoryAuditItem[]

  @@id([id, companyStoreId])
  @@index([companyStoreId], map: "IDX_inventory_audits_company_store")
  @@map("inventory_audits")
}

model InventoryAuditItem {                 // unchanged
  inventoryAuditId      String   @map("inventory_audit_id") @db.Uuid
  companyStoreId        String   @map("company_store_id") @db.Uuid
  companyStoreProductId Int      @map("company_store_product_id")
  productQuantity       Int      @map("product_quantity")
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt             DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  inventoryAudit      InventoryAudit      @relation(fields: [inventoryAuditId, companyStoreId], references: [id, companyStoreId])
  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId, companyStoreId], references: [id, companyStoreId])

  @@id([inventoryAuditId, companyStoreId, companyStoreProductId])
  @@map("inventory_audit_items")
}
```

Notes:
- `InventoryAuditItem`'s composite FK `[companyStoreProductId, companyStoreId]` enforces same-corner integrity, exactly like `OrderItem`. `companyStoreId` is shared with the parent-audit relation, so nested creates attach the placement **by relation** (`connect` on `id_companyStoreId`), not raw scalars — the Phase 7 gotcha.
- Line items are children of the audit aggregate: soft-delete marks the audit, items read through it; edits swap the whole set (`deleteMany` + `createMany`).

## 4. Permissions

Five new codes in `prisma/seed.ts` (**39 → 44**):

| Code | Name |
|------|------|
| `audits.create` | Create audits |
| `audits.read` | Read audits |
| `audits.update` | Update audits |
| `audits.delete` | Delete audits |
| `audits.apply` | Apply audits |

All five granted to **OWNER**, **MANAGER**, **STAFF** (mirroring orders + the apply decision). ADMIN via its seed-derived rows (Phase 7).

## 5. `InventoryService` refactor (extract the atomic write)

`record`'s current in-`$transaction` body moves into a new **public** method so the audit apply can reuse it inside its own transaction:

```ts
// runs INSIDE a caller-provided tx; no auth, no new transaction
async recordWithinTransaction(
  tx: Prisma.TransactionClient,
  placementId: number,
  dto: { transactionType: InventoryTransactionType; quantity: number; remarks?: string },
  callerId: string,
  source?: Source,
) { /* effect lookup + quantity guard + stock lookup + guarded updateMany/update + ledger insert */ }
```

`record` becomes: `assertWorksCorner` → placement 404 check → `this.prisma.$transaction((tx) => this.recordWithinTransaction(tx, placementId, dto, caller.id, source))`. External behavior of `record` is identical, so the eight Phase 6 unit tests pass unchanged.

## 6. API surface

Nested under the corner:

| Method | Path | Permission | Ownership |
|--------|------|------------|-----------|
| POST | `/corners/:cornerId/audits` | `audits.create` | `assertWorksCorner` |
| GET | `/corners/:cornerId/audits` | `audits.read` | `findOne` |
| GET | `/corners/:cornerId/audits/:auditId` | `audits.read` | `findOne` |
| PATCH | `/corners/:cornerId/audits/:auditId` | `audits.update` | `assertWorksCorner` |
| DELETE | `/corners/:cornerId/audits/:auditId` | `audits.delete` | `assertWorksCorner` |
| POST | `/corners/:cornerId/audits/:auditId/apply` | `audits.apply` | `assertWorksCorner` |

`:cornerId` and `:auditId` are `ParseUUIDPipe`.

### DTOs

```ts
// audit-item.dto.ts
export class AuditItemDto {
  @IsInt() companyStoreProductId!: number;
  @IsInt() @Min(0) productQuantity!: number;   // 0 is a valid count
}

// create-audit.dto.ts
export class CreateAuditDto {
  @IsString() @IsNotEmpty() @MaxLength(255) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @MaxLength(2048) fileUrl?: string;
  @IsDateString() auditedDate!: string;
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true })
  @Type(() => AuditItemDto) items!: AuditItemDto[];
}

// update-audit.dto.ts
export class UpdateAuditDto extends PartialType(CreateAuditDto) {}
```

## 7. Service logic (`AuditsService`)

Injects `PrismaService`, `CornersService`, and `InventoryService` (from `InventoryModule`, already exported). Mirrors `OrdersService` for CRUD, adds `apply`.

- **`validateItems(cornerId, items)`** — same as orders: reject duplicate placement ids (400) and any id that isn't a live placement on this corner (400).
- **`getAudit(cornerId, auditId)`** — `findFirst` where `{ id, companyStoreId, deletedAt: null }`, `include: { inventoryAuditItems: true }`; null → 404.
- **`create`** — `assertWorksCorner`; `validateItems`; create the audit + items (nested `create` with `companyStoreProduct: { connect: { id_companyStoreId } }`), `include` items.
- **`findAll` / `findOne`** — read through the corner, `deletedAt: null`, include items, `orderBy: { auditedDate: 'desc' }`.
- **`update`** — `assertWorksCorner`; `getAudit`; **if `appliedAt` → 409**; if `dto.items`, `validateItems`; in one `$transaction`: update header, and if items present `deleteMany` + `createMany` the new set.
- **`remove`** — `assertWorksCorner`; `getAudit`; **if `appliedAt` → 409**; soft-delete (`deletedAt`/`deletedByUserId`).
- **`apply`** — `assertWorksCorner`; `getAudit`; **if `appliedAt` → 409**; `validateItems` (lines still live placements → 400); then one `$transaction`:
  ```ts
  for (const item of audit.inventoryAuditItems) {
    await this.inventory.recordWithinTransaction(
      tx, item.companyStoreProductId,
      { transactionType: 'ADJUSTMENT', quantity: item.productQuantity },
      caller.id, { type: 'AUDIT', id: auditId },
    );
  }
  return tx.inventoryAudit.update({
    where: { id_companyStoreId: { id: auditId, companyStoreId: cornerId } },
    data: { appliedAt: new Date(), appliedByUserId: caller.id },
    include: { inventoryAuditItems: true },
  });
  ```
  Returns the applied audit. The per-line variance (before/after) lives in the `ADJUSTMENT` ledger rows.

## 8. Validation & errors

| Situation | Status |
|-----------|--------|
| Blank `title`, bad `auditedDate`, `productQuantity < 0`, empty `items` | 400 |
| A line's placement isn't live on this corner (create / update / apply) | 400 |
| Duplicate placement in a create/update payload | 400 |
| Caller lacks the permission | 403 |
| Caller has the permission but doesn't work this corner | 403 |
| Corner or audit absent / another tenant | 404 |
| Edit, delete, or apply an **already-applied** audit | 409 |

## 9. Module wiring

`AuditsModule`: `imports: [CornersModule, InventoryModule]`, `providers: [AuditsService]`, `controllers: [AuditsController]`, `exports: [AuditsService]`. Registered in `AppModule`.

## 10. Testing

- **Unit** — `src/audits/audits.service.spec.ts` (mocks Prisma + Corners + InventoryService): create validates + writes via connect; findAll/findOne filter `deletedAt: null`; update swaps items and is blocked once applied (409); remove soft-deletes; **apply** calls `inventory.recordWithinTransaction` once per line with `ADJUSTMENT` + `{ type: 'AUDIT', id }`, stamps `appliedAt`, all inside one `$transaction`, and 409s a second apply. Plus an `inventory.service.spec` assertion that `record` still routes through `recordWithinTransaction` (Phase 6 suite otherwise unchanged).
- **e2e** — `test/audits.e2e-spec.ts` (developer runs). Flow: file a count over two placements → apply → each placement's `availableQuantity` now equals its counted number and the transaction ledger shows the `ADJUSTMENT`s → second apply is 409 → editing/deleting the applied audit is 409. Rejections: empty items 400, foreign-placement line 400, foreign-MANAGER 403, cross-tenant 404; an assigned STAFF can apply. Namespaced ids (`@aud.test`, `3x0-…`).

## 11. Out of scope (future phases)

- Auditing reserved/sample/damaged buckets.
- Variance/discrepancy reports (the ledger already carries before/after per line).
- Un-applying or reversing an applied audit.
- File upload for `fileUrl`.
