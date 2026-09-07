# Phase 9 — Purchase Reservations: Design

> Inventra Phase 9. A **reservation** holds stock of one placement for a named customer. Creating it holds stock (`available → reserved`); fulfilling it converts the hold to a normal sale; cancelling releases it. It extends the Phase 6 effect map to the `reserved` bucket and is the third caller of `recordWithinTransaction`.

## 1. Domain & lifecycle

A `PurchaseReservation` holds `reservedQuantity` of **one placement** (`companyStoreProductId` on a corner) for a named customer (`reservedByName`/`reservedByPhone`). It's a single row, not a multi-line document.

**Hold on create.** Creating a reservation immediately moves stock `available → reserved` (guarded), and the row starts `RESERVED`. Two terminal actions:

- **Fulfill** (customer collects) → the hold unwinds and the unit sells: `RESERVATION_RELEASE` (`reserved → available`) **+ `SALE`** (`available → out`), atomically → status `FULFILLED`.
- **Cancel** (staff releases) → `RESERVATION_RELEASE` (`reserved → available`) → status `CANCELLED` (with `cancelReason`).

State machine: `RESERVED → {FULFILLED, CANCELLED}`. `PENDING` and `EXPIRED` stay defined but **unused this phase** (`PENDING` = a deferred request-then-confirm flow; `EXPIRED` = the deferred auto-sweep). Invariant: the `reserved` bucket always equals the sum of active (`RESERVED`) reservations.

## 2. Decisions

1. **Hold on create.** The reservation *is* the hold — stock is protected the instant the row exists. No `PENDING` two-step.
2. **A fulfillment is a sale.** Fulfill records `RESERVATION_RELEASE` + `SALE` rather than a bespoke "reservation fulfill" decrement. So **every purchase is a `SALE`** — walk-in or reserved — and "units sold" is one query. The fulfill's `SALE` carries `source = RESERVATION` (a walk-in `SALE` has `source = null`), so reserved-origin sales stay attributable. This is the fix for the "purchases tracked two different ways" asymmetry.
3. **All-or-nothing.** Fulfill and cancel act on the whole `reservedQuantity`; no partial pickups. A partial need = cancel + re-reserve the remainder.
4. **Store `expiresAt`, defer the sweep.** The column is captured, but the scheduled job that auto-releases expired holds is a later jobs/cross-cutting phase. `EXPIRED` stays unused for now.
5. **No soft-delete.** Cancel *is* the removal; a reservation never leaves the table, it reaches a terminal status.
6. **Track the creator.** Add `createdByUserId` (+ named `→User` relation) for the same audit trail orders/audits carry.
7. **Reuse Phase 6/8 atomicity.** Every stock move goes through `InventoryService.recordWithinTransaction(tx, …)` inside one `$transaction` per action, stamped `source = RESERVATION, sourceId = reservation.id`.
8. **Placement-nested, tenant-scoped through the corner.** Under `/corners/:cornerId/products/:placementId/reservations` (mirrors transactions); ownership via `CornersService` (`assertWorksCorner` writes / `findOne` reads).

## 3. Effect map extension (`inventory-effects.ts`)

The `reserved` bucket isn't reachable today. Two changes:

**(a) Widen the `Bucket` type:**
```ts
export type Bucket =
  | 'availableQuantity'
  | 'reservedQuantity'   // NEW
  | 'sampleQuantity'
  | 'damagedQuantity';

const reservedQuantity: Bucket = 'reservedQuantity'; // NEW const
```

**(b) Two new effects** (guard-first, like `BREAKAGE`/`SAMPLE_ALLOCATION`):
```ts
RESERVE: {
  kind: 'delta',
  deltas: [
    { field: availableQuantity, sign: -1 }, // guard: can't reserve more than available
    { field: reservedQuantity, sign: 1 },
  ],
  primaryBucket: availableQuantity,
},
RESERVATION_RELEASE: {
  kind: 'delta',
  deltas: [
    { field: reservedQuantity, sign: -1 },  // guard: can't release more than held
    { field: availableQuantity, sign: 1 },
  ],
  primaryBucket: reservedQuantity,
},
```
`SALE` (existing `dec(availableQuantity)`) is reused for the fulfill's actual sale. No `set` change (the `set` effect stays `availableQuantity`-only). The existing invariant spec test ("every delta effect lists its primaryBucket among its deltas") covers both new entries automatically.

## 4. Data model — schema changes (migration you run)

Two additions to `prisma/schema.prisma`:

**(a) Two enum values** on `InventoryTransactionType` (with `///` doc comments, per convention):
```prisma
  /// Stock held for a customer reservation. available -q, reserved +q.
  RESERVE
  /// A reservation hold is released back to sellable. reserved -q, available +q.
  RESERVATION_RELEASE
```

**(b) `createdByUserId` on `PurchaseReservation`** + a named relation, and the `User` back-relation:
```prisma
model PurchaseReservation {
  // …existing fields…
  createdByUserId String @map("created_by_user_id") @db.Uuid   // NEW

  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId, companyStoreId], references: [id, companyStoreId])
  createdByUser       User @relation("ReservationsCreatedBy", fields: [createdByUserId], references: [id]) // NEW
  // …
}
// on User: createdReservations PurchaseReservation[] @relation("ReservationsCreatedBy")
```

Notes:
- `PurchaseReservation` PK is a single `id` (uuid); the composite FK `[companyStoreProductId, companyStoreId]` enforces same-corner integrity.
- `status` keeps its `@default(PENDING)`, but `create` sets `RESERVED` explicitly (hold-on-create), so the default is never relied on this phase.
- A **migration** adds `created_by_user_id` (+ FK) and the two enum values. Human runs `prisma migrate dev`.

## 5. Permissions

Four new codes in `prisma/seed.ts` (**44 → 48**), all granted to OWNER/MANAGER/STAFF:

| Code | Name |
|------|------|
| `reservations.create` | Create reservations |
| `reservations.read` | Read reservations |
| `reservations.fulfill` | Fulfill reservations |
| `reservations.cancel` | Cancel reservations |

`fulfill` and `cancel` are separate (distinct consequential actions, like `audits.apply`). ADMIN via its seed-derived rows.

## 6. API surface

Placement-nested (mirrors the transactions controller); `:cornerId` UUID, `:placementId` **int** (`ParseIntPipe` — placement ids are autoincrement), `:reservationId` UUID.

| Method | Path | Permission | Body |
|--------|------|------------|------|
| POST | `/corners/:cornerId/products/:placementId/reservations` | `reservations.create` | customer + quantity |
| GET | `…/reservations` | `reservations.read` | — |
| GET | `…/reservations/:reservationId` | `reservations.read` | — |
| POST | `…/reservations/:reservationId/fulfill` | `reservations.fulfill` | — |
| POST | `…/reservations/:reservationId/cancel` | `reservations.cancel` | `{ cancelReason? }` |

### DTOs
```ts
// create-reservation.dto.ts
export class CreateReservationDto {
  @IsString() @IsNotEmpty() @MaxLength(100) reservedByName!: string;
  @IsOptional() @IsString() @MaxLength(20) reservedByPhone?: string;
  @IsInt() @Min(1) reservedQuantity!: number;
  @IsOptional() @IsString() remark?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
}

// cancel-reservation.dto.ts
export class CancelReservationDto {
  @IsOptional() @IsString() cancelReason?: string;
}
```

## 7. Service logic (`ReservationsService`)

Injects `PrismaService`, `CornersService`, `InventoryService`. All writes in one `$transaction`.

- **`getPlacement(cornerId, placementId)`** — `companyStoreProduct.findFirst({ id, companyStoreId, deletedAt: null })`; null → 404 (the reservation's placement must be a live placement on the corner).
- **`getReservation(cornerId, placementId, reservationId)`** — `purchaseReservation.findFirst({ id, companyStoreId: cornerId, companyStoreProductId: placementId })`; null → 404.
- **`create(caller, cornerId, placementId, dto)`** — `assertWorksCorner`; `getPlacement`; then one tx:
  1. `reservation = tx.purchaseReservation.create({ …, companyStoreProductId: placementId, companyStoreId: cornerId, reservedQuantity: dto.reservedQuantity, status: 'RESERVED', createdByUserId: caller.id, expiresAt: dto.expiresAt ? new Date(...) : null })`
  2. `recordWithinTransaction(tx, placementId, { transactionType: 'RESERVE', quantity: dto.reservedQuantity }, caller.id, { type: 'RESERVATION', id: reservation.id })` — guarded `available→reserved`; **insufficient available → 409**, whole tx rolls back (no orphan reservation).
  3. return the reservation.
- **`findAll(caller, cornerId, placementId)`** — `findOne` (read scope); `getPlacement`; `purchaseReservation.findMany({ where: { companyStoreId: cornerId, companyStoreProductId: placementId }, orderBy: { reservedAt: 'desc' } })`.
- **`findOne(caller, cornerId, placementId, reservationId)`** — `findOne`; `getReservation`.
- **`fulfill(caller, cornerId, placementId, reservationId)`** — `assertWorksCorner`; `getReservation`; if `status !== 'RESERVED'` → **409**; one tx: `recordWithinTransaction(RESERVATION_RELEASE)` then `recordWithinTransaction(SALE)` (both `source = RESERVATION`, quantity = `reservation.reservedQuantity`), then `update({ status: 'FULFILLED', fulfilledAt: new Date() })`.
- **`cancel(caller, cornerId, placementId, reservationId, dto)`** — `assertWorksCorner`; `getReservation`; if `status !== 'RESERVED'` → **409**; one tx: `recordWithinTransaction(RESERVATION_RELEASE)`, then `update({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.cancelReason ?? null })`.

## 8. Validation & errors

| Situation | Status |
|-----------|--------|
| `reservedQuantity < 1`, blank `reservedByName`, name/phone too long, bad `expiresAt` | 400 |
| Placement not a live placement on this corner | 404 |
| Corner or reservation absent / another tenant | 404 |
| Caller lacks the permission | 403 |
| Caller has the permission but doesn't work this corner | 403 |
| **Insufficient available stock to reserve** | 409 (the `RESERVE` guard) |
| **Fulfill or cancel a non-`RESERVED` reservation** | 409 |

## 9. Module wiring

`ReservationsModule`: `imports: [CornersModule, InventoryModule]`, `providers: [ReservationsService]`, `controllers: [ReservationsController]`, `exports: [ReservationsService]`. Registered in `AppModule`.

## 10. Testing

- **Unit** — `inventory-effects.spec.ts`: `RESERVE` and `RESERVATION_RELEASE` map correctly (cross-bucket, decrement-first, right `primaryBucket`); the totality + invariant tests still pass. `reservations.service.spec.ts` (mocks Prisma + Corners + Inventory): create calls `recordWithinTransaction(RESERVE)` + writes the row `RESERVED`; fulfill calls `RESERVATION_RELEASE` then `SALE` and sets `FULFILLED`; cancel calls `RESERVATION_RELEASE` and sets `CANCELLED`; fulfill/cancel on a non-`RESERVED` reservation → 409.
- **e2e** — `test/reservations.e2e-spec.ts` (developer runs). Place a product, restock to a known available. Reserve q → available drops by q, reserved rises by q, ledger shows `RESERVE`/`source=RESERVATION`. Over-reserve → 409. Fulfill → reserved back to 0, available net-down by q, status `FULFILLED`, ledger shows `RESERVATION_RELEASE` + `SALE` (the `SALE` tagged `source=RESERVATION`). Cancel (a fresh reservation) → reserved→available restored, `CANCELLED`. Double-fulfill → 409. Foreign-corner 403, cross-tenant 404. Namespaced ids (`@rsv.test`, `2x0-…`).

## 11. Out of scope (future phases)

- Auto-expiry sweep (scheduled job releasing `RESERVED` holds past `expiresAt` → `EXPIRED`).
- Partial fulfillment.
- The `PENDING` request-then-confirm two-step.
- Editing a reservation's quantity/customer after creation.
