# Phase 7 — Restock Orders: Design

> Inventra Phase 7. An **Order** is an official restock-request document filed against a corner, listing placements and requested quantities. It records intent; it never moves stock.

## 1. Domain

A corner worker (OWNER / ADMIN / MANAGER / STAFF) files an **order**: a formal document requesting a restock of specific placements (`CompanyStoreProduct`s) on their corner. The request is *not* a guarantee — when the company actually delivers, corner staff record the real `RESTOCK` inventory transactions **by hand** (Phase 6). An order may later be pointed at by such a transaction (`sourceType = ORDER`, `sourceId = order.id`), but **that reconciliation link is manual and out of scope for this phase** — orders here are pure documents that never call `InventoryService.record`.

This decouples the *request* from the *stock movement*: an order can be over- or under-delivered, delivered late, or never delivered, and the ledger stays the independent source of truth for what physically moved.

## 2. Decisions

1. **Document only, no stock move.** Creating/editing/deleting an order never touches `CompanyStoreProductStock` or the transaction ledger. No atomic `$transaction`-with-`updateMany` engine here (that is Phase 6's job).
2. **Full CRUD + soft-delete.** A filed request can be revised (header + line items) and withdrawn (soft-delete). Soft-delete — not hard-delete — because an order may be referenced as a transaction's `sourceId`; erasing it would dangle that reference and lose the audit trail. Follows the repo "soft-delete everywhere" convention.
3. **Replace-all line items + client-side draft.** Editing swaps the order's entire line set in one write; the server has no granular per-line endpoints. In-progress durability (a half-built order surviving an app-process kill) is the **client's** responsibility via local draft state (`localStorage` survives process death). Rejected alternative: granular server-durable item endpoints (`POST/PATCH/DELETE …/items/:placementId`) — more surface area, not needed once the client owns drafts.
4. **Every order has ≥1 line item.** Create requires a non-empty `items[]`; an edit that would leave the order empty is a `400`. There is no zero-item "draft" state on the server — an abandoned in-progress order is simply never created (it lives only in the client draft), and a filed order always has at least one line.
5. **No status field.** An "in progress" request is just an order still being edited; there is no DRAFT/SUBMITTED/FULFILLED state machine. Delivery reconciliation lives in the ledger, not on the order.
6. **Tenant-scoped through the corner.** Like placements, orders carry no `companyId`; ownership is derived through `CornersService`. Nested under `/corners/:cornerId/orders`. ADMIN targets a tenant via the URL path.
7. **fileUrl is a client-provided string.** The schema's `fileUrl` (VarChar 2048) holds a URL to an already-uploaded document. No file-upload handling (multipart, storage, signing) is in scope this phase.

## 3. Data model

**Schema status:** `prisma/schema.prisma` *already declares* everything below — `Order.deletedAt`, `Order.deletedByUserId`, the two named `Order↔User` relations (`OrdersCreatedBy`, `OrdersDeletedBy`), and their `User`-side back-relations (`createdOrders`, `deletedOrders`). **No schema editing is required.** However, the database is behind: the `20260711132505_init` migration created `orders` *without* `deleted_at`/`deleted_by_user_id`. The one outstanding data-model step is therefore a **migration that adds those two columns (+ the deleted-by FK) to the `orders` table** — a human runs `prisma migrate dev` (Claude's Prisma AI-guard blocks it). Nothing else in the model changes.

The relevant models, as they already stand:

```prisma
model Order {
  id              String    @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyStoreId  String    @map("company_store_id") @db.Uuid
  title           String    @db.VarChar(255)
  description     String?   @db.Text
  fileUrl         String?   @map("file_url") @db.VarChar(2048)
  orderDate       DateTime  @map("order_date") @db.Timestamptz(6)
  createdByUserId String    @map("created_by_user_id") @db.Uuid
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  deletedAt       DateTime? @map("deleted_at") @db.Timestamptz(6)
  deletedByUserId String?   @map("deleted_by_user_id") @db.Uuid

  companyStore  CompanyStore @relation(fields: [companyStoreId], references: [id])
  createdByUser User         @relation("OrdersCreatedBy", fields: [createdByUserId], references: [id])
  deletedByUser User?        @relation("OrdersDeletedBy", fields: [deletedByUserId], references: [id])
  orderItems    OrderItem[]

  @@id([id, companyStoreId])
  @@index([companyStoreId], map: "IDX_orders_company_store")
  @@map("orders")
}

model OrderItem {                       // unchanged
  orderId               String   @map("order_id") @db.Uuid
  companyStoreId        String   @map("company_store_id") @db.Uuid
  companyStoreProductId Int      @map("company_store_product_id")
  productOrderQuantity  Int      @map("product_order_quantity")
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt             DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  order               Order               @relation(fields: [orderId, companyStoreId], references: [id, companyStoreId])
  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId, companyStoreId], references: [id, companyStoreId])

  @@id([orderId, companyStoreId, companyStoreProductId])
  @@map("order_items")
}
```

Notes:
- `Order` PK is composite `[id, companyStoreId]`; `OrderItem`'s composite FK `[companyStoreProductId, companyStoreId]` to the placement enforces **same-corner integrity** at the database level (a line's placement must live on the order's corner).
- `User` already carries both back-relations — `createdOrders Order[] @relation("OrdersCreatedBy")` and `deletedOrders Order[] @relation("OrdersDeletedBy")` — so the two `Order→User` relations are disambiguated. Nothing to add there.
- **Line items are children of the order aggregate.** On soft-delete the order is marked; its items are left in place and are only ever read through an order whose `deletedAt` is null. On edit, the item set is swapped wholesale (hard delete + recreate) — items have no independent references, so this is safe.

## 4. Permissions

Four new codes appended to `PERMISSIONS` in `prisma/seed.ts` (**35 → 39 total**):

| Code | Name |
|------|------|
| `orders.create` | Create orders |
| `orders.read` | Read orders |
| `orders.update` | Update orders |
| `orders.delete` | Delete orders |

Granted (all four) to **OWNER**, **MANAGER**, and **STAFF** — mirroring `placements.*`, since all corner workers may file restock requests. ADMIN is served by its in-code wildcard, not by rows.

## 5. API surface

Nested under the corner, mirroring `PlacementsController`:

| Method | Path | Permission | Ownership | Body |
|--------|------|------------|-----------|------|
| POST | `/corners/:cornerId/orders` | `orders.create` | `assertWorksCorner` | header + `items[]` (≥1) |
| GET | `/corners/:cornerId/orders` | `orders.read` | `findOne` (read scope) | — |
| GET | `/corners/:cornerId/orders/:orderId` | `orders.read` | `findOne` | — |
| PATCH | `/corners/:cornerId/orders/:orderId` | `orders.update` | `assertWorksCorner` | partial header + optional full `items[]` |
| DELETE | `/corners/:cornerId/orders/:orderId` | `orders.delete` | `assertWorksCorner` | — |

`:cornerId` is `ParseUUIDPipe`, `:orderId` is `ParseUUIDPipe`. `assertWorksCorner` = OWNER/ADMIN · MANAGER on corners they manage · STAFF on their assigned corner.

### DTOs

```ts
// order-item.dto.ts
export class OrderItemDto {
  @IsInt() companyStoreProductId!: number;
  @IsInt() @Min(1) productOrderQuantity!: number;
}

// create-order.dto.ts
export class CreateOrderDto {
  @IsString() @IsNotEmpty() @MaxLength(255) title!: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @MaxLength(2048) fileUrl?: string;
  @IsDateString() orderDate!: string;                      // business date (ISO)
  @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true })
  @Type(() => OrderItemDto) items!: OrderItemDto[];
}

// update-order.dto.ts — header fields optional; items, if present, is the full replacement set (≥1)
export class UpdateOrderDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(255) title?: string;
  @IsOptional() @IsString() description?: string;
  @IsOptional() @IsString() @MaxLength(2048) fileUrl?: string;
  @IsOptional() @IsDateString() orderDate?: string;
  @IsOptional() @IsArray() @ArrayMinSize(1) @ValidateNested({ each: true })
  @Type(() => OrderItemDto) items?: OrderItemDto[];
}
```

## 6. Service logic (`OrdersService`)

Constructor injects `PrismaService` + `CornersService`. All writes run inside a `prisma.$transaction`.

- **`create(caller, cornerId, dto)`**
  1. `await corners.assertWorksCorner(caller, cornerId)`.
  2. Validate `items` (see §7): every `companyStoreProductId` is a live placement (`deletedAt: null`) on this corner; no duplicate placement ids in the payload.
  3. In one tx: create the `Order` (`createdByUserId = caller.id`), then create all `OrderItem`s. Return the order with `include: { orderItems: true }`.

- **`findAll(caller, cornerId)`** — `corners.findOne` (read scope → 404 on foreign tenant), then `order.findMany({ where: { companyStoreId: cornerId, deletedAt: null }, include: { orderItems: true }, orderBy: { orderDate: 'desc' } })`.

- **`findOne(caller, cornerId, orderId)`** — `corners.findOne`, then fetch the order (`id, companyStoreId, deletedAt: null`) `include` items; null → `404`.

- **`update(caller, cornerId, orderId, dto)`** — `assertWorksCorner`; fetch the live order or `404`. If `dto.items` present, validate it (same rules). In one tx: update header fields; if `items` present, `deleteMany` the order's existing items and recreate the new set. Return the order with items.

- **`remove(caller, cornerId, orderId)`** — `assertWorksCorner`; fetch live order or `404`; set `deletedAt: new Date()`, `deletedByUserId: caller.id`. Items untouched.

Fetch-then-decide: the service performs row-or-null lookups and decides the status code.

## 7. Validation & errors

| Situation | Status |
|-----------|--------|
| Missing/blank `title`, bad `orderDate`, `productOrderQuantity < 1`, empty `items` | 400 (ValidationPipe / `ArrayMinSize`) |
| A line's `companyStoreProductId` is not a live placement on this corner | 400 |
| Duplicate `companyStoreProductId` within one payload | 400 |
| Caller lacks the permission | 403 (PermissionsGuard) |
| Caller has the permission but does not work this corner | 403 (`assertWorksCorner`) |
| Corner not found / not the caller's tenant | 404 (`CornersService`) |
| Order id absent, soft-deleted, or on another corner | 404 |

Duplicate detection is explicit (a `Set` over the payload's placement ids) so the client gets a clean `400` rather than a Prisma unique-constraint `500` from the composite PK.

## 8. Module wiring

`OrdersModule`: `imports: [CornersModule]`, `providers: [OrdersService]`, `controllers: [OrdersController]`, `exports: [OrdersService]` (exported for a later fulfillment/reconciliation phase). Registered in `AppModule`.

## 9. Testing

- **Unit** — `src/orders/orders.service.spec.ts` (I write). Mocks Prisma + `CornersService`. Covers: create validates lines and rejects duplicate/foreign/empty; create writes order + items in a tx; `findAll`/`findOne` filter `deletedAt: null` and include items; update swaps the item set (deleteMany + recreate) and can edit header-only; remove sets `deletedAt`/`deletedByUserId`; auth delegates to `assertWorksCorner` (writes) / `findOne` (reads).
- **e2e** — `test/orders.e2e-spec.ts` (developer runs — Prisma AI-guard blocks the reset). Namespaced ids (`@ord.test`, `4x0-…`). Flow: file an order → read it (items included) → edit (swap items, header) → cancel (soft-delete, then 404 on re-read). Rejections: empty items 400, foreign-placement line 400, foreign-MANAGER 403, cross-tenant 404. An assigned STAFF can file.

## 10. Out of scope (future phases)

- Linking a `RESTOCK` transaction back to an order (`source = ORDER`) — manual reconciliation, a later phase.
- Any order status / fulfillment tracking.
- File upload for `fileUrl` (multipart, object storage).
- `PurchaseReservation` (its own phase).
