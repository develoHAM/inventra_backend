# Teaching the Engine to Hold

> Inventra Phase 9 — where the stock engine learns a fourth bucket, a reservation turns out to be a hold that becomes a sale, and a mid-build question moves a whole resource up a level.
> 2026-09-09

## Intro

Inventra is a multi-tenant inventory SaaS on the Korean concession model — companies run "corners" inside physical stores. Phase 6 built an engine that *moves* stock; Phase 8 taught it to *reconcile* stock. Phase 9 teaches it to **hold** stock — a purchase reservation keeps `reservedQuantity` of a product aside for a named customer until they collect it. It's the first phase to reach back into the Phase 6 effect map and add something new to it, and it turned out to be full of small modeling decisions that each changed the shape of the answer.

## Architectural Decisions

### 1. Hold on create — the reservation *is* the hold

**Goal.** Decide when a reservation starts protecting stock.

**Options.** (a) **Hold on create** — creating the reservation immediately moves `available → reserved`, so the row exists only if stock is actually held. (b) **Two-step** — create a `PENDING` request that holds nothing, then a separate `confirm` moves it to `RESERVED` and holds the stock (models "requests arrive, staff triage before committing").

**Choice.** **(a) hold on create.** `POST /reservations` runs a guarded `available → reserved` and starts the row `RESERVED`. If there isn't enough available, it's a `409` and nothing persists.

**Reason.** For a walk-up or phone reservation, "hold it now" *is* the operation — separating "I want to reserve" from "the hold is active" only earns its keep when unconfirmed requests genuinely compete for stock before a human vets them, which isn't this store's flow. Hold-on-create also buys a clean, checkable **invariant**: the `reserved` bucket always equals the sum of active reservations. Every held unit is backed by a real row, and vice versa.

**Result.** A two-state machine (`RESERVED → {FULFILLED, CANCELLED}`) instead of four, and `PENDING`/`EXPIRED` left defined-but-unused for the day a request channel or an expiry sweep actually needs them.

### 2. A fulfillment is a sale

**Goal.** Record what happens when the customer collects a held item.

**The flaw I almost shipped.** My first design gave fulfillment its own transaction type — `RESERVATION_FULFILL`, a straight `reserved −q`. But that means a **purchased item is tracked two different ways**: a walk-in sale is a `SALE` (`available −q`), while a reserved purchase is a `RESERVATION_FULFILL` (`reserved −q`). "Total units sold" would forever be `SALE ∪ RESERVATION_FULFILL` — a reserved purchase never shows up as a sale.

**Options.** (a) Bespoke `RESERVATION_FULFILL` decrementing `reserved`. (b) Model a reservation as what it is in retail — a **hold that converts to a sale**: fulfill releases the hold and then sells.

**Choice.** **(b).** Fulfill records, atomically, `RESERVATION_RELEASE` (`reserved → available`) **+ `SALE`** (`available → out`).

**Reason.** Now **every purchase is a `SALE`** — walk-in or reserved — so "units sold" is one query. And nothing is lost: the fulfill's `SALE` carries `source = RESERVATION` (a walk-in `SALE` has `source = null`), so reserved-origin sales stay filterable. Uniformity *and* attribution. It also happens to need one *fewer* new transaction type, because it reuses `SALE`.

**Result.** The ledger tells the honest story — the unit was held, released, and sold — and every reporting query that counts sales just works, no special-casing.

### 3. Extending the effect map — a fourth bucket

**Goal.** Let the engine touch `reserved`, which it never could before (the `Bucket` type was `available | sample | damaged`).

**Options.** (a) Write bespoke reserved-bucket logic inside `ReservationsService`. (b) **Extend the Phase 6 effect map** — widen `Bucket` to include `reservedQuantity` and add the new movements as data.

**Choice.** **(b).** A hold is structurally identical to `BREAKAGE` or `SAMPLE_ALLOCATION` — a cross-bucket, guard-first move — just into a different bucket:
```ts
RESERVATION_HOLD: {                          // available → reserved
  deltas: [{ field: 'availableQuantity', sign: -1 },   // guard: enough available?
           { field: 'reservedQuantity',  sign: +1 }],
  primaryBucket: 'availableQuantity',
},
RESERVATION_RELEASE: {                        // reserved → available
  deltas: [{ field: 'reservedQuantity',  sign: -1 },   // guard: enough held?
           { field: 'availableQuantity', sign: +1 }],
  primaryBucket: 'reservedQuantity',
},
```

**Reason.** Because these are just two more rows in the effect map, they inherit the entire Phase 6 machinery for free — the `$transaction`, the guarded `updateMany` (so over-reserving is the same clean `409` as overselling), the ledger append. No new atomic-write code. And `EFFECTS` is a **compiler-enforced total `Record<InventoryTransactionType, Effect>`**, so the moment I added the enum values the build refused to compile until both effects existed — the type system wouldn't let me forget one.

**Result.** "Teach the engine to hold" reduced to two data entries and a wider union. The naming even got its own small correction — the type is a noun (`RESERVATION_HOLD`, pairing with `RESERVATION_RELEASE`) to match the rest of the enum, not the verb `RESERVE`.

### 4. Corner-level, not placement-nested

**Goal.** Choose where the reservations resource lives in the URL tree.

**Where I started.** Placement-nested — `/corners/:cornerId/products/:placementId/reservations`, mirroring the transactions endpoint, since a reservation is about one placement's stock.

**The question that moved it.** *"What if the counter worker wants to see every reservation for the corner?"* — the pickup-desk view, across all products. Placement-nesting can't serve that without looping over every placement.

**Choice.** **Move the whole resource to corner-level** — `/corners/:cornerId/reservations`. The corner-wide list becomes the base `GET`, per-placement becomes a `?companyStoreProductId=` filter (plus `?status=RESERVED` for the active pickup list). `companyStoreProductId` rides in the create body; `fulfill`/`cancel` take only `:reservationId` (the row already knows its placement).

**Reason.** A reservation is a corner-scoped record that *references* a placement — unlike a transaction, which *is* an event on one placement's stock. The primary real-world view is corner-wide, so that should be the natural shape, not something you assemble by fanning out. The move also resolved a smaller question cleanly: at corner level, `companyStoreProductId` genuinely belongs in the request body.

**Result.** One `GET /corners/:cornerId/reservations` answers the counter's actual question, and the per-placement and per-status views fall out as filters.

## TIL (Today I Learned)

**Hold-on-create vs two-step — what actually differs?** *When stock starts being protected.* Hold-on-create protects it the instant the reservation exists (the row and the hold are the same thing). Two-step separates "I want to reserve" (`PENDING`, protects nothing) from "the hold is live" (`RESERVED`) — worth it only when unconfirmed requests compete for stock before a human commits it. For a store that just holds items on request, that middle state is machinery you don't use.

**`prisma generate` vs `prisma migrate dev`.** I hit this the hard way: after adding the enum values I ran (or an editor ran) `prisma generate`, the build went green, and I assumed the schema change was done. It wasn't. **`generate`** regenerates the TypeScript client *from the schema* so your code compiles; **`migrate dev`** diffs the schema against the *database*, writes a SQL migration, and applies it. The client knew about the new enum and column; Postgres didn't. Unit tests (mocked) passed, the build passed, and only a real insert would have failed. Generate makes the code compile; migrate makes the database real.

**Do we need a `createdAt` and an `updatedByUserId`?** No to both, for good reasons. `reservedAt` already *is* the created timestamp, domain-named. And a generic `updatedByUserId` is off-convention (the codebase names actors per transition — `deletedByUserId`, `appliedByUserId`) *and* redundant: every reservation stock move goes through `recordWithinTransaction`, which stamps the actor plus `source = RESERVATION`, so "who fulfilled/cancelled this" already lives in the ledger. `createdByUserId` earns its place (there's no ledger row for "filed the reservation"); the transition-actors don't.

**Does `companyStoreProductId` belong in the create DTO?** It depends entirely on the route level — and that's the tell. Under a placement-nested route it comes from the path, so *no*; under a corner-level route it comes from the body, so *yes*. The question surfacing at all was a hint that the resource wanted to be corner-level.

## NestJS Concepts & Libraries

| Concept / tool | Why it showed up in Phase 9 |
|----------------|------------------------------|
| **Compiler-total `Record<Enum, T>`** | Adding an enum value breaks the build until the effect map maps it — the type system enforces completeness. |
| **Prisma enum migration** | New enum values need `migrate dev` (schema→DB), not just `generate` (schema→client). |
| **`@Query()` + a query DTO + `@Type`** | Corner-wide list filters (`?companyStoreProductId`/`?status`) validated and coerced from query strings. |
| **Action sub-resources** (`POST :id/fulfill` / `cancel`) | Non-CRUD state transitions on a reservation. |
| **`recordWithinTransaction` reuse** | Reservations are the Phase 8 helper's third caller; `ReservationsModule` injects `InventoryService`. |
| **Guarded `updateMany`** | Inherited from Phase 6 — over-reserving is a clean `409`, same as overselling. |
| **Resource altitude (nested vs corner-level)** | A reservation *references* a placement rather than *being* a placement event, so it lives at corner level. |

## Wrap-up

Phase 9 delivered purchase reservations: hold-on-create with a guarded `available→reserved`, a fulfillment that releases-then-sells so every purchase is a `SALE`, a corner-level resource with a pickup-desk list, and — the centerpiece — the first extension of the Phase 6 effect map to a fourth bucket. **166 unit tests + 62 e2e, all green, e2e passing on the first run.**

The satisfying part was how little new *machinery* it took. Teaching the engine an entirely new behavior — holding stock — came down to widening a union and adding two rows to a table, because the hard parts (atomic writes, oversell guards, the immutable ledger) were built to be reused. That's the Phase 6 investment paying its third dividend.

**Next up — Phase 10: cross-cutting concerns.** There's a loose thread I left on purpose: `expiresAt`. Reservations can carry an expiry, but nothing releases them yet. The natural first job is a scheduled **auto-expiry sweep** — a `@nestjs/schedule` task that finds `RESERVED` holds past their `expiresAt` and releases them (`RESERVATION_RELEASE` → `EXPIRED`), reusing the exact same engine one more time. The engine that learned to hold this phase is about to learn to let go on a timer.
