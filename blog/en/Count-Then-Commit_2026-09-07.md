# Count, Then Commit: An Audit That Reconciles Reality

> Inventra Phase 8 — where the stock engine built two phases ago finally gets its first real caller, and a refactor about *who owns the transaction* makes reconciling a whole shelf atomic.
> 2026-09-07

## Intro

Inventra is a multi-tenant inventory SaaS on the Korean concession model — companies run "corners" inside physical stores. Phase 6 built an engine that moves stock atomically; Phase 7 built restock orders that deliberately *don't* use it. Phase 8 is where the engine finally does real work: an **inventory audit** — a physical stock-count — and the act of **applying** it to correct the system's numbers. The interesting part wasn't the CRUD (that's the same document shape as orders by now). It was making the apply **atomic across many lines at once**, which forced a refactor about a question I hadn't had to answer before: *who owns the transaction?*

## Architectural Decisions

### 1. Two-step: count, then apply

**Goal.** Model what a manager does at month-end: walk the shelf, count what's physically there, and correct the system to match.

**The tension.** Unlike an order (which merely records intent), an audit's *entire purpose* is to change the books. So it's tempting to make it one action — count and correct in a single call. But correcting the books is **consequential and irreversible**: it writes `ADJUSTMENT` transactions that overwrite the running balance. You want a human to see the count — and the variance it will cause — *before* committing it.

**Options.** (a) Creating/finalizing the audit immediately reconciles. (b) The audit is a pure document; reconciliation is entirely manual. (c) **Two steps**: build the count as a document, then a separate explicit *apply* commits it.

**Choice.** **(c).** You `POST` an audit (header + counted lines), edit it freely while you work, and only when you're satisfied do you `POST …/audits/:id/apply`. Apply walks each line and records an `ADJUSTMENT` that **sets** that placement's `availableQuantity` to the counted number, stamped `source = AUDIT`.

**Reason.** The two-step keeps a review gate between "here's what I counted" and "make it so." A miscount caught before apply is a cheap edit; caught after, it's a correcting transaction on the ledger. And decoupling means the audit document and the stock movements it *causes* are separate records — the audit says what you counted, the ledger says what changed.

**Result.** Building an audit never touches stock. Apply is the single, deliberate moment the correction lands — and, as the next decision shows, it lands all-or-nothing.

### 2. Whose transaction is it? — the extract-method refactor

**Goal.** Make apply **atomic across every line**. Reconcile ten placements or none — never leave the shelf half-corrected.

**The obstacle.** "All-or-nothing across N writes" means one `$transaction` wrapping all N. But Phase 6's `record()` **owns its own transaction**:
```ts
async record(...) {
  await this.corners.assertWorksCorner(...);      // guard
  const placement = await ...findFirst(...);      // guard
  return this.prisma.$transaction((tx) => { ... }); // ← opens ITS OWN transaction
}
```
Looping `record()` per line gives N *separate* transactions — line 3 failing leaves lines 1–2 committed. Not atomic. And you can't hand `record()` an outer transaction to join.

**Options.** (a) Loop `record()` (not atomic). (b) Duplicate the stock-write logic inside `AuditsService`. (c) **Extract** the write into a helper that runs on a caller-provided transaction.

**Choice.** **(c).** I split `record()` into two:
```ts
// the ATOMIC WRITE, runs on a tx the caller provides — no auth, no new transaction
async recordWithinTransaction(tx: Prisma.TransactionClient, placementId, dto, callerId, source?) { … }

// the single-write entry point — guards, then opens ONE tx around the helper
async record(...) {
  await this.corners.assertWorksCorner(...);
  const placement = await ...findFirst(...);
  return this.prisma.$transaction((tx) => this.recordWithinTransaction(tx, placementId, dto, caller.id, source));
}
```
Now `AuditsService.apply` opens **one** transaction and calls the helper per line on that same `tx`, then stamps `appliedAt` — all in one unit.

**Reason.** The transaction became a **parameter**, so the caller decides the boundary: a single write draws its own, a batch draws one around the whole batch. It's DRY (the ledger-and-balance logic lives in exactly one place — no second copy to drift), and it's a clean separation of concerns: authorization is the caller's job, the write is the helper's. That's why `recordWithinTransaction` has *no* `assertWorksCorner` — the audit authorized the corner once; re-checking per line would be wrong and wasteful. And `record()`'s external contract is untouched, so its eight Phase 6 tests pass unchanged.

**Result.** Apply is genuinely atomic, and reuses the exact stock-movement semantics `record` already trusted — no duplication.

### 3. Freeze on apply — a two-state machine

**Goal.** Stop an applied audit from being applied twice, or edited after the fact.

**The problem.** Apply isn't idempotent by nature — run it again and it writes a *second* set of `ADJUSTMENT`s. And an applied audit is a historical record of a count at a point in time; letting someone edit it afterward would make the ledger lie about what was counted.

**Options.** (a) Track no state — apply is repeatable. (b) Track `appliedAt` and freeze the audit once set.

**Choice.** **(b).** Applying stamps `appliedAt` (+ `appliedByUserId`). Every mutating path — edit, delete, and apply itself — first checks it:
```ts
if (audit.appliedAt) throw new ConflictException('Audit already applied'); // 409
```

**Reason.** One timestamp turns the audit into a tiny state machine: *unapplied* (editable, deletable, appliable) → *applied* (frozen, immutable). Re-applying, editing, or deleting a frozen audit is a `409` — a clear "this record is closed," not a silent no-op or a duplicate correction.

**Result.** The audit becomes an immutable artifact the moment it's committed, and the ledger it produced can be trusted as the record of that count.

### 4. `audits.apply` as its own permission

**Goal.** Decide who's allowed to commit stock corrections.

**Choice.** A dedicated `audits.apply` permission, separate from `audits.create/read/update/delete` — even though, for now, all of them go to the same roles (OWNER/MANAGER/STAFF).

**Reason.** Counting and *committing the correction to the books* are conceptually different authorities, even when the same person does both. Making apply its own permission means the RBAC layer can distinguish "can build an audit" from "can commit its adjustments" — so the day a company wants only managers to sign off on corrections, it's a seed change, not a code change. Cheap now, flexible later.

**Result.** The count-vs-commit distinction is explicit in the permission model, not buried in role assumptions.

## TIL (Today I Learned)

**Why refactor `record()` and expose `recordWithinTransaction`?**
Because atomicity is about the *transaction boundary*, and `record()` insisted on drawing its own. To reconcile N lines all-or-nothing, one transaction has to span all N — which means the write has to be runnable *inside a transaction someone else opened*. Extracting it made the transaction a parameter: `record()` opens one for a single write, `apply` opens one around the whole batch, and both share the same underlying write logic. It's the "pass the unit-of-work handle" pattern.

**Why a `for…of` loop with `await`, instead of `Promise.all`?**
Because all the line-writes run on the **same `tx`**, and one interactive transaction is bound to **one database connection**, which processes **one statement at a time**. `Promise.all` would fire them concurrently at a connection that can't do concurrency — a known Prisma footgun that errors or serializes unpredictably. Sequential `await` is what respects "one at a time down the one connection." (Outside a transaction, on pooled connections, `Promise.all` *is* the right call — the rule is specifically: within one `tx`, serialize.)

**Is `POST …/audits/:id/apply` even RESTful?**
Not strictly — `/apply` is a verb, and pure REST wants nouns. But it's the pragmatic "action sub-resource" pattern that real APIs use for non-CRUD state transitions (GitHub `POST …/merge`, Stripe, k8s subresources). The "more RESTful" alternatives are worse *here*: folding it into a `PATCH { appliedAt }` hides that it's a heavy, irreversible command, and noun-ifying it as `POST …/reconciliation` only pays off if the reconciliation is a thing you'd later `GET` — which, per our design, it isn't. Keep the action endpoint until you need to query the result.

**The bug the mocks couldn't see (again).** My extracted helper accidentally opened *its own* `$transaction` inside itself — which would have ignored the `tx` the audit passed it, silently breaking the atomicity the whole refactor exists for. The unit tests stayed green, because a mocked `$transaction` is just a passthrough. And later: `@Patch('auditId')` — missing the `:` — registered a route at the literal path `…/audits/auditId`, so real requests 404'd. Both slipped past 157 unit tests and were caught by the e2e. That's three phases running where the integration layer earned its keep on exactly the class of bug mocks are blind to: transaction semantics and route wiring.

## NestJS Concepts & Libraries

| Concept / tool | Why it showed up in Phase 8 |
|----------------|------------------------------|
| **Extracted tx-accepting method** (`recordWithinTransaction`) | Reuse the atomic write inside a caller's transaction; makes batch apply all-or-nothing. |
| **`Prisma.TransactionClient`** | Type the passed-in `tx` param (a `PrismaClient` minus the calls you can't make mid-transaction). |
| **`$transaction` (interactive) + `for…of await`** | One transaction spanning N line-writes, run sequentially down the single connection. |
| **Action sub-resource route** (`POST :id/apply`) | Express a non-CRUD, side-effectful state transition. |
| **`@RequirePermissions('audits.apply')`** | A dedicated permission so committing corrections is distinct from editing the count (44 total). |
| **`PartialType` update DTO** | A partial `PATCH` must validate against optional fields — using the create DTO by mistake 400s a `{ title }` edit. |
| **Cross-module injection** | `AuditsModule` imports `InventoryModule` to inject `InventoryService` and reuse its write. |
| **Prisma relation `connect`** | Attach each counted line's placement by its composite unique (the shared-`companyStoreId` rule from Phase 7). |

## Wrap-up

Phase 8 delivered inventory audits: a nested `InventoryAudit` + `InventoryAuditItem` aggregate with full CRUD and soft-delete, a two-step *count then apply* flow, an apply that reconciles every line atomically in one transaction, and a freeze-on-apply state machine that turns a committed audit into an immutable record. **157 unit tests + 54 e2e, all green.**

The lasting lesson is the refactor. "Make this batch atomic" sounds like a database concern, but it turned into a design question — *who owns the transaction?* — whose answer was to stop letting the write own it and start passing it in. That one move made reconciliation atomic without a line of duplicated logic, and left the Phase 6 engine's contract completely intact.

**Next up — Phase 9: purchase reservations.** There's a `reservedQuantity` bucket that's sat untouched since Phase 6, and a third `TransactionSourceType` — `RESERVATION` — waiting for a caller. A reservation holds stock for a customer against that bucket; fulfilling or cancelling moves it. The engine that finally ran this phase is about to learn to *hold* stock, not just move it.
