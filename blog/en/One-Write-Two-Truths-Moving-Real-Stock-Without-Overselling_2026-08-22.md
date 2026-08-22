# One Write, Two Truths: Moving Real Stock Without Overselling

> Inventra Phase 6 — where a number on a shelf becomes an event in a ledger, and a race condition becomes a clean 409.
> 2026-08-22

## Intro

Inventra is a multi-tenant inventory SaaS on the Korean concession model — companies run "corners" inside physical stores. Every phase so far has been about *structure*: who you are (auth), what you're allowed to touch (authz), what you sell (catalog), where you operate (corners), and what sits on which shelf (placement). Phase 6 is the first phase about *motion* — moving real stock. A sale drops the count; a restock raises it; a breakage quietly turns a sellable unit into a damaged one. It sounds like `count = count - 1`. It is not. This is the phase where "just decrement a number" turned into a ledger, a running balance, a 17-entry effect table, and the one concurrency guard I'd been deferring since Phase 4.

## Architectural Decisions

### 1. Two truths, one write — a ledger *and* a running balance

**Goal.** Answer two questions that pull in opposite directions: *"how much is on the shelf right now?"* (fast, asked constantly) and *"how did it get to that number?"* (a full, auditable history).

**Options.**
- **(a) Balance only** — one mutable `availableQuantity` column. Reads are instant, but every movement overwrites the past. You can never answer *why*.
- **(b) Ledger only** — an append-only list of movements; derive the current count with `SUM(...)` on every read. Perfect history, but "what's on the shelf" becomes an O(n) aggregate on the hottest read in the app.
- **(c) Both** — append an immutable ledger row **and** update a running balance, together, in one transaction.

**Choice.** **(c).** Every movement writes two things atomically: an append-only `InventoryTransaction` (the *event* — type, quantity, `quantityBefore`, `quantityAfter`, who, and an optional source) and the balance on `CompanyStoreProductStock` (the *current truth*).

**Reason.** The two questions have genuinely different access patterns, so they get genuinely different storage. The ledger is never updated or deleted — it's the audit trail, and its immutability is the whole point. The balance is O(1) to read because it's already computed. Wrapping both in one `$transaction` means they can never disagree: either the event and the new balance both land, or neither does.

**Result.** A read of "current stock" touches one narrow row. A question of "who sold what, when, and what was the count before and after" is answered by the ledger without reconstructing anything. This is event-sourcing's good idea — keep the events — without paying event-sourcing's tax on every read.

### 2. Split the hot stock row from the cold placement config

**Goal.** Make the balance cheap to mutate thousands of times a day without dragging the placement's configuration along for the ride.

**The friction.** My original Phase 5 design put the quantity columns *on* `CompanyStoreProduct`, right next to the placement's identity and settings. But those two kinds of data live at completely different temperatures. `availableQuantity` changes on every single sale. `targetStockQuantity`, `isActive`, `description` change almost never. Postgres's MVCC rewrites the **entire row** on any `UPDATE` — so every sale was rewriting the placement's cold config too, generating dead tuples and WAL for bytes that never changed.

**Options.** (a) Leave the quantities on `CompanyStoreProduct`; (b) split the hot balances into their own 1:1 table.

**Choice.** **(b).** A new `CompanyStoreProductStock`, joined 1:1 by a shared primary key that *is* the foreign key:

```prisma
model CompanyStoreProductStock {
  companyStoreProductId Int @id @map("company_store_product_id")
  targetStockQuantity   Int @default(0) @map("target_stock_quantity")
  availableQuantity     Int @default(0) @map("available_quantity")
  reservedQuantity      Int @default(0) @map("reserved_quantity")
  sampleQuantity        Int @default(0) @map("sample_quantity")
  damagedQuantity       Int @default(0) @map("damaged_quantity")
  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId], references: [id])
  @@map("company_store_product_stocks")
}
```

**Reason.** Splitting the hot fact from the cold dimension keeps the frequently-rewritten row narrow — less MVCC churn, less WAL, fewer dead tuples to vacuum — while the placement metadata stays cache-stable for the reads that never need the live count. The shared PK/FK (`companyStoreProductId Int @id`) makes it a true 1:1: the stock row's identity *is* the placement it belongs to, no surrogate key, no chance of two stock rows for one placement.

**Result.** The stock row is created together with the placement (nested `stock: { create }`) and inherits its soft-delete lifecycle, so nothing else in Phase 5 had to change its mental model — but the write path is now aimed at a table built to be written.

### 3. The effect map — 17 transaction types as data, not branches

**Goal.** Support 17 kinds of movement (RESTOCK, SALE, TRANSFER_OUT, BREAKAGE, SAMPLE_ALLOCATION, ADJUSTMENT, …) without `record()` becoming a 17-arm `switch`.

**The shape of the problem.** The types aren't uniform. Most just move one bucket (`SALE` decrements available). Some move stock *between* buckets (`BREAKAGE` takes one out of available and puts it into damaged — the physical unit still exists, it's just not sellable). And one, `ADJUSTMENT`, ignores the current value entirely and *sets* the count to a physical recount.

**Options.** (a) A big `switch (dto.transactionType)` inside `record()`; (b) a declarative table that maps each type to its *effect*, and a `record()` that just interprets the effect.

**Choice.** **(b).** An `EFFECTS` table, exhaustively typed so the compiler refuses to let me forget a type:

```ts
export type Effect =
  | { kind: 'delta'; deltas: { field: Bucket; sign: 1 | -1 }[]; primaryBucket: Bucket }
  | { kind: 'set'; field: 'availableQuantity' };

export const EFFECTS: Record<InventoryTransactionType, Effect> = {
  SALE:    dec(availableQuantity),
  RESTOCK: inc(availableQuantity),
  BREAKAGE: {
    kind: 'delta',
    deltas: [
      { field: availableQuantity, sign: -1 },  // guard-first: the decrement
      { field: damagedQuantity,   sign: +1 },
    ],
    primaryBucket: availableQuantity,
  },
  ADJUSTMENT: { kind: 'set', field: availableQuantity },
  // …17 total
};
```

**Reason.** `Record<InventoryTransactionType, Effect>` is the trick: if I add an enum value and forget to map it, the build breaks — the table is provably *total*. Each effect is a plain value I can unit-test in isolation, and `record()` stays completely type-agnostic — it interprets `delta` vs `set`, never `if (type === 'SALE')`. The `primaryBucket` names which bucket the ledger's `before`/`after` should track when a movement touches two of them (for a breakage, that's *available* — the sellable count is the number people care about).

**Result.** Adding a movement type is a one-line row, and the compiler nags me until the table is whole again. The domain logic (what each type *means*) sits in a file with no framework in it, next to a spec test that asserts every delta lists its own `primaryBucket`.

### 4. The guarded `updateMany` — how a race becomes a 409

**Goal.** Never oversell. Two cashiers scanning the last unit at the same instant must not both succeed.

**The trap.** The obvious code is a read-then-write:

```ts
const stock = await tx.stock.findUnique(...);
if (stock.availableQuantity < q) throw new ConflictException();   // check
await tx.stock.update({ data: { availableQuantity: { decrement: q } } }); // then act
```

That's a **TOCTOU** race — a gap between the check and the act. Two transactions both read "1 available", both pass the check, both decrement, and you've sold two of the one unit you had.

**Options.** (a) Read-then-write (broken, above); (b) `SELECT ... FOR UPDATE` to lock the row; (c) an application-level mutex; (d) fold the check *into* the write with a conditional `updateMany`.

**Choice.** **(d).** Make the guard part of the same atomic `UPDATE` the database already serializes:

```ts
const { count } = await tx.companyStoreProductStock.updateMany({
  where: { companyStoreProductId: placementId, [field]: { gte: q } }, // guard in the WHERE
  data:  { [field]: { decrement: q } },
});
if (count === 0) throw new ConflictException('Insufficient stock');
```

**Reason.** The `gte: q` predicate lives *inside* the write. There's no separate read to race against — the database evaluates "is there enough?" and "subtract it" as one indivisible operation. If two of them fire on the last unit, exactly one matches the `WHERE` and updates (`count: 1`); the other matches nothing (`count: 0`) and we turn that into a `409 Conflict`. (`updateMany` is what makes this work, and not only for concurrency — a single `update` on a missing match *throws* `P2025`, while `updateMany` returns a `count` I can branch on. See the TIL.)

**Result.** This is the pattern I'd deliberately deferred since Phase 4, waiting for the phase that actually needed it. Overselling is now structurally impossible, and it costs one `if`. Cross-bucket moves list the decrement **first** (guard before you add), so a breakage can never manufacture a damaged unit it failed to remove from available.

## TIL (Today I Learned)

**Why does an effect need both a `deltas` list and a separate `primaryBucket`? Isn't the primary just… the field?**
For single-bucket moves, yes — `SALE` decrements `availableQuantity` and that's also the bucket the ledger tracks. But cross-bucket moves touch *two*: `BREAKAGE` subtracts from `available` and adds to `damaged`. The ledger's `quantityBefore`/`quantityAfter` can only tell one story, so `primaryBucket` says *which* — for a breakage, the meaningful before/after is the **available** count, because that's the sellable number the store cares about. `deltas` is *what physically moves*; `primaryBucket` is *what the ledger narrates*.

**Why doesn't the `CreateTransactionDto` accept `sourceType` / `sourceId`?**
Because provenance isn't something a client should be able to claim. `source` is set by *the server* — later, when the orders module calls `record(..., { type: 'ORDER', id })`, it stamps the ledger with where the movement came from. A human hitting the API just says "SALE, quantity 3"; they don't get to forge "this was order #42". So `source` is an optional *method parameter*, not a DTO field — trusted callers pass it, untrusted input never touches it.

**Does `quantity` mean an absolute amount or the amount to apply?**
Both — and which one depends on the effect's `kind`. For a `delta` type it's the amount *to apply* (SALE quantity 3 = "remove three"). For the `set` type (`ADJUSTMENT`) it's the *absolute* result of a physical recount ("there are actually 5 here, make it so"), so the ledger records `before = whatever it was`, `after = 5`. Same field, two meanings, disambiguated by the effect — which is exactly why the effect table earns its keep.

**`companyStoreProductId` is unique — why `updateMany` instead of `update`?**
Not for the *number* of rows — it's always one. It's for the **conditional** `WHERE` and the **return value**. Prisma's `update` targets a row by unique id and *throws `P2025`* if the `where` matches nothing — and I can't add `availableQuantity: { gte: q }` to an `update`'s where at all. `updateMany` lets me put the stock guard in the `where` *and* returns `{ count }` instead of throwing, so `count === 0` becomes my clean "not enough stock → 409" signal instead of a try/catch around an exception.

**So `count` only comes back from `updateMany`?**
Right. `update` returns the updated *record* (or throws); `updateMany`/`deleteMany`/`updateMany` return `{ count }` — a batch result. When I care "did my guarded write hit anything?", the batch API's count is the answer; the single-record API would make me catch an exception to learn the same thing.

**I didn't want to `!`-assert that the primary bucket has a sign. What's the right way to fail?**
If `primaryBucket` isn't among an effect's `deltas`, that's not a user error — it's a *me* error, a misconfigured table that should never ship. So instead of a non-null assertion (`primarySign!`), I throw an `InternalServerErrorException` with a diagnostic message naming the offending type. It's a 5xx because the invariant that broke is the server's, not the caller's — and the spec test that asserts "every delta effect lists its own primaryBucket" means this branch should be unreachable in practice. The throw is the belt to the test's suspenders.

## NestJS Concepts & Libraries

| Concept / tool | Why it showed up in Phase 6 |
|----------------|------------------------------|
| **`PrismaClient.$transaction` (interactive)** | Wrap the ledger insert + balance move in one all-or-nothing unit. |
| **Guarded `updateMany` + `{ count }`** | Fold the oversell check into the atomic write; `count === 0` ⇒ 409. |
| **Prisma 1:1 via shared PK/FK** | `CompanyStoreProductStock` keyed by the placement id — a true one-to-one, hot row split from cold. |
| **Nested route controllers** | `/corners/:cornerId/products/:placementId/transactions` — the movement inherits its corner and placement from the path. |
| **`@RequirePermissions` (RBAC)** | Two new seeded permissions — `transactions.read` / `transactions.create` (35 total). |
| **`OwnershipService` / `assertWorksCorner`** | Reuse Phase 5's derived ownership — writes need someone who works the corner, reads just its tenant. |
| **`ValidationPipe` + `@IsEnum`/`@IsInt`/`@Min`** | Reject an unknown `transactionType` or a negative quantity at the edge with a 400. |
| **Exhaustive `Record<Enum, T>`** | Compiler-enforced totality for the 17-type effect map. |

## Wrap-up

Phase 6 turned inventory from a number you overwrite into an event you record. The deliverables: a split hot/cold data model, an append-only ledger beside an O(1) running balance, a declarative 17-type effect map the compiler keeps honest, and a single atomic write where overselling is a structural impossibility rather than a bug to test for. **140 unit tests + 39 e2e, all green.**

The most satisfying part is that the last piece clicked into a slot cut three phases ago. The atomic `updateMany` pattern was named back in Phase 4 and deliberately left on the shelf until a phase genuinely needed it — and inventory movement is exactly that phase.

**Next up — Phase 7: orders.** The very first thing that will call `record(..., source)` in anger: an order line that moves stock *and* stamps the ledger with where the movement came from. The provenance parameter I built and left empty this phase is about to get its first real caller.
