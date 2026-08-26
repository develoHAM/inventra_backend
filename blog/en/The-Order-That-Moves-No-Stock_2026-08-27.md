# The Order That Moves No Stock: A Restock Request as a Pure Document

> Inventra Phase 7 — where an "order" turns out to be a request, not a command, and an end-to-end test catches what a hundred green unit tests couldn't.
> 2026-08-27

## Intro

Inventra is a multi-tenant inventory SaaS on the Korean concession model — companies run "corners" inside physical stores. Phase 6 built the thing that moves real stock: a ledger plus a running balance, guarded against overselling. So when Phase 7 came up as "orders," I assumed it was the first customer of that engine — file an order, stock moves. It wasn't. The most useful question of the whole phase was the first one I asked, and the answer reshaped everything: an order here **records intent and never touches stock**. This is the story of building a document that deliberately does less than it looks like it should — and of the composite-key bug that slipped past every unit test and got caught the moment a real database was involved.

## Architectural Decisions

### 1. A document, not a command

**Goal.** Model what a corner worker actually does when the shelf runs low: file a restock request.

**The reframe.** My first instinct was that fulfilling an order would generate `RESTOCK` transactions — order in, stock up. But that bakes in a lie: in the real world the restock **isn't guaranteed**. It arrives late, or partial, or never. The company might send eight of the ten you asked for.

**Options.** (a) Order fulfillment auto-generates `RESTOCK` movements. (b) Order is a **pure document** — it records the request; the real `RESTOCK` is entered by hand when goods actually arrive. (c) A status machine (DRAFT → SUBMITTED → FULFILLED) that tries to track delivery.

**Choice.** **(b).** An order is a header (title, note, a document URL, a business date) plus line items (which placement, how many requested). Creating, editing, or deleting one never reads or writes `CompanyStoreProductStock`. When the delivery shows up, a human records the actual movement through Phase 6's engine — optionally stamping that ledger row with `source = ORDER` to point back at the request.

**Reason.** Coupling the request to the ledger would force a certainty that doesn't exist. Keeping them separate lets the **ledger stay the independent truth** of what physically moved, while the order stays the truth of what was *asked for* — and the two are free to disagree, which is exactly what reality does.

**Result.** No `$transaction`-with-`updateMany` engine this phase, no oversell guard, no status enum. Just an honest document. The `source = ORDER` reconciliation link is real in the schema but deferred — a hook for a later fulfillment phase, not something this one pretends to automate.

### 2. Replace-all items, and who owns the half-finished order

**Goal.** Let a filed request be revised (fix a quantity, drop a line) and withdrawn.

**Choice + friction.** Full CRUD with **soft-delete** (an order may later be referenced as a transaction's source, so it must never truly vanish). For the line items, the natural design is **replace-all**: the edit carries the whole item set and the server swaps it wholesale. But that raised a good question — what if the staffer is *building* an order when a customer walks in and the app process dies? With replace-all, nothing is saved until the final submit, so every line they'd added is gone.

**Options.** (a) Replace-all, and let the **client** hold a local draft. (b) Granular server endpoints (`POST/DELETE …/items/:id`) so each line is durable the instant it's added.

**Choice.** **(a).** The server keeps one replace-all handler; in-progress durability is the client's job via `localStorage`, which survives the app process being killed — the exact scenario in question.

**Reason.** The granular design is more surface area (three more endpoints, more tests) to solve a problem the platform already solves: a browser draft outlives a process death. Push durability to where it's cheap.

**Result.** One `update` that, inside a single `$transaction`, rewrites the header and swaps the items:
```ts
await tx.orderItem.deleteMany({ where: { orderId, companyStoreId } });
await tx.orderItem.createMany({ data: items.map(/* … */) });
```
An order always carries **at least one line** — enforced at the edge (`@ArrayMinSize(1)`), so an edit can never leave an empty ghost request behind.

### 3. Moving ADMIN's authority into the database

**Goal.** This one came from a mid-task question: *can we manage ADMIN's permissions in the DB too?*

**The status quo.** ADMIN was a **code-level wildcard**. `PermissionsService` special-cased it: if your role is ADMIN, return *every* permission in the table, skip the override lookup entirely. Great for zero-maintenance (ADMIN auto-inherits any new permission the instant it's added), but ADMIN's real grants were invisible in the database, it was the one role handled differently from all others, and you could never `DENY` a single permission to a single admin.

**Options.** (a) Keep the wildcard. (b) Hand-list every permission under an ADMIN grant array. (c) **Derive** ADMIN's grants from the permission list in seed, and drop the special case so ADMIN reads its rows like any role.

**Choice.** **(c).** Seed grants ADMIN the whole set, computed:
```ts
const ROLE_PERMISSIONS = {
  ADMIN: PERMISSIONS.map((permission) => permission.code), // no drift
  OWNER: [ /* … */ ],
  // …
};
```
and the wildcard branch in `PermissionsService` is deleted — ADMIN now flows through the same rows-plus-overrides path as everyone else.

**Reason.** Hand-listing is a drift footgun: add a permission, forget to grant it to ADMIN, and ADMIN silently loses access. Deriving from the list keeps the DB the source of truth **and** can't drift, because seed recomputes ADMIN's full set every run.

**Result.** ADMIN's authority is now auditable in `role_permissions`, uniform with every other role, and — the deliberate behavioral change — user-level `GRANT`/`DENY` overrides finally apply to admins too. One special-case branch gone.

### 4. The composite-key bug that unit tests can't see

**Goal.** Nothing — this one's a lesson, not a decision.

**What happened.** `OrderItem` has two composite foreign keys that **share the `companyStoreId` column**: one to the order (`[orderId, companyStoreId]`) and one to the placement (`[companyStoreProductId, companyStoreId]`). My reference code built each nested line item as raw scalars:
```ts
orderItems: { create: items.map((i) => ({
  companyStoreId: cornerId,                 // ⛔
  companyStoreProductId: i.companyStoreProductId,
  productOrderQuantity: i.productOrderQuantity,
})) }
```
Every unit test passed. Then the e2e ran and Prisma threw: `Unknown argument 'companyStoreId'`. In a nested `order.create → orderItems.create`, the parent order already fixes `companyStoreId`, so Prisma's checked input **won't let you set it again** — it wants the placement attached by *relation*:
```ts
orderItems: { create: items.map((i) => ({
  productOrderQuantity: i.productOrderQuantity,
  companyStoreProduct: {
    connect: { id_companyStoreId: { id: i.companyStoreProductId, companyStoreId: cornerId } },
  },
})) }
```

**The lesson.** The unit tests mocked `prisma.order.create` — a `jest.fn()` that happily accepts *any* object. Mocks validate that my code calls the shape **I told them to expect**; they cannot validate that shape against Prisma's real input types. Only a real database, driven end-to-end, does that. This is precisely the seam between unit and integration testing, and Phase 7 drew it in red ink: 148 green unit tests, one bug, caught by the 47th e2e.

## TIL (Today I Learned)

**What does an "order" even mean here — does filing one move stock?**
No, and that was the whole design. It's a *request* document. The physical stock moves in a separate, manual step when goods actually arrive, through Phase 6's ledger. The order and the movement are deliberately decoupled because a restock is never guaranteed — decoupling lets the ledger stay honest about what really happened versus what was merely asked for.

**Why does the nested `items` array need both `@ValidateNested` and `@Type`?**
Because JSON over HTTP is just plain objects — class-validator doesn't know each element is an `OrderItemDto`, so without `@Type(() => OrderItemDto)` the inner `@IsInt()`/`@Min(1)` never run and bad lines slip through. `@Type` tells class-transformer which class to instantiate; `@ValidateNested({ each: true })` then validates each real instance. Paired with `@ArrayMinSize(1)`, that's the entire "≥1 valid item" guarantee, enforced before the service ever runs.

**Why did the unit tests pass but the e2e fail?**
Because a mocked `prisma.order.create` accepts anything you hand it — the unit test only checks that my service *builds* the object I claimed it would. It can't know that object is invalid against Prisma's generated input types. The shared-`companyStoreId` composite FK is a real-schema constraint, so it only bites against a real database. Mocks test your intentions; integration tests test reality.

**Can we manage ADMIN's permissions at the DB level too?**
Yes — by having seed *derive* ADMIN's grants from the permission list (`PERMISSIONS.map(...)`) rather than hand-listing them, so ADMIN lives in `role_permissions` like every other role without the drift risk of forgetting to grant a new permission. The trade-off, accepted deliberately: a `DENY` override now applies to an admin, where before admins were absolute.

**`createMany` vs a nested `create` — why do they accept different fields?**
They use different generated input types. A nested `order.create → orderItems.create` uses `OrderItemCreateWithoutOrderInput`, which omits the parent-managed keys and wants the other relation via `connect`. But `orderItem.createMany` (which the edit-swap uses) takes `OrderItemCreateManyInput` — a flat, bulk scalar insert that *does* accept `orderId`, `companyStoreId`, and `companyStoreProductId` directly. Same table, two shapes, because one is nested under a parent and the other isn't.

## NestJS Concepts & Libraries

| Concept / tool | Why it showed up in Phase 7 |
|----------------|------------------------------|
| **Nested DTO validation** (`@ValidateNested` + `@Type` + `@ArrayMinSize`) | Validate an array of line items and enforce ≥1 at the request edge — the repo's first nested-DTO body. |
| **`PartialType(CreateOrderDto)`** | The update DTO: all fields optional, but `items` (if present) still fully validated. |
| **`$transaction` replace-all** | Swap the header + whole item set (`deleteMany` + `createMany`) atomically. |
| **Prisma nested `create` + relation `connect`** | Attach each line's placement by its composite unique `id_companyStoreId` instead of the shared scalar. |
| **`createMany` vs nested-create input types** | Two different generated shapes for the same table depending on nesting. |
| **Nested route controller + `ParseUUIDPipe`** | `/corners/:cornerId/orders/:orderId` — both ids from the path. |
| **`@RequirePermissions`** | Four new codes, `orders.{create,read,update,delete}` (39 total). |
| **`CornersService.assertWorksCorner` / `findOne`** | Reuse Phase 5's derived ownership — writes need a corner worker, reads its tenant. |
| **Seed-derived role grants** (`PERMISSIONS.map(...)`) | ADMIN's authority materialized as DB rows with no drift; wildcard branch removed. |

## Wrap-up

Phase 7 delivered a restock-request subsystem: a nested `Order` + `OrderItem` aggregate with full CRUD and soft-delete, replace-all line editing in a single transaction, a ≥1-item invariant at the edge, and a quietly significant refactor that moved ADMIN's authority out of a code branch and into auditable database rows. **148 unit tests + 47 e2e, all green.**

The phase's real souvenir is the composite-key bug. It's a clean demonstration of why the test pyramid has more than one layer: unit tests gave me fast, confident feedback on my *logic*, and every one of them was right — but they mock the database away, so they were structurally blind to a constraint that only exists in the database. The e2e was slower and less pleasant to write, and it was the only thing in the building that could have caught it.

**Next up — Phase 8: inventory audits.** The `InventoryAudit` and `InventoryAuditItem` tables are already scaffolded, in the same corner-nested, composite-FK shape as orders. But an audit isn't a document that sits still — reconciling a physical stock count is where Phase 6's `record(..., { type: 'AUDIT' })` finally gets its first real caller, setting each counted line to its true quantity. The engine that moves no stock this phase is about to be put to work.
