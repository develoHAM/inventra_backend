# Letting Go on a Timer

> Inventra Phase 10a — a scheduled job finally releases the holds nobody came back for, and a cron turns out to be just another front door into the same services.
> 2026-09-10

## Intro

Inventra is a multi-tenant inventory SaaS on the Korean concession model — companies run "corners" inside physical stores. Phase 9 taught the engine to *hold* stock for a customer, but left one thread dangling on purpose: a reservation could carry an `expiresAt`, and nothing ever acted on it. A hold that a customer never came back for would sit there forever, quietly keeping stock off the shelf. Phase 10a closes that loop — a background job that sweeps expired holds and releases them — and in doing so it's the first piece of the app not triggered by an HTTP request. It also came with two infrastructure detours worth writing down.

## Architectural Decisions

### 1. Claim-then-release — safe without a lock

**Goal.** Release every `RESERVED` hold whose `expiresAt` has passed, without ever double-releasing one.

**The hazard.** A background sweep is the classic setting for a race. If you deploy two app instances, each runs its own cron, so both fire the sweep at the same minute and both see the same expired reservation. The naive "find expired, release each" would then release the same hold twice — `reserved -= q` twice, `available += q` twice — corrupting the buckets. The same race exists between the sweep and a customer fulfilling or cancelling at that exact moment.

**Options.** (a) Read-then-release (racy). (b) A distributed lock (Redis / Postgres advisory lock) so only one sweeper runs. (c) A **guarded claim** — atomically flip `RESERVED → EXPIRED` first, and only release if *you* were the one who flipped it.

**Choice.** **(c).** Each reservation is claimed and released in its own transaction:
```ts
const { count } = await tx.purchaseReservation.updateMany({
  where: { id: reservation.id, status: 'RESERVED' },   // claim
  data: { status: 'EXPIRED', expiredAt: now },
});
if (count === 0) return false;                          // someone else got it — skip
await inventory.recordWithinTransaction(tx, /* RESERVATION_RELEASE … */);
```

**Reason.** This is the exact guarded-`updateMany` philosophy from Phase 6, pointed at a status column instead of a stock bucket. The claim is a single atomic write: if two sweeps (or a sweep and a fulfill) race, one flips `RESERVED → EXPIRED` and gets `count: 1`; the other matches nothing (`status` is no longer `RESERVED`) and gets `count: 0`, so it skips the release. No distributed lock, no coordination — correctness falls out of one conditional write. And because each reservation gets its own transaction wrapped in a `try/catch`, one bad row logs and is skipped rather than stalling the sweep.

**Result.** A sweep that is correct whether you run one instance or ten, built from a primitive the app already had.

### 2. The engine's fourth caller — a release is a release

**Goal.** Move the stock when a hold expires.

**Choice.** The sweep doesn't invent its own stock logic — it calls `InventoryService.recordWithinTransaction` with `RESERVATION_RELEASE`, the same effect a manual cancel uses, stamped `source = RESERVATION`. It just passes the sweep's own transaction in.

**Reason.** Expiry *is* a release — the stock movement is identical to cancelling, only the trigger differs. Reusing the engine means the ledger, the bucket math, and the guarded decrement all come for free, and the `reserved → available` move is recorded honestly. This is the fourth distinct caller of that extracted helper (after `record`, audit apply, and reservation create/fulfill/cancel), and the clearest evidence yet that pulling the atomic write out of `record` back in Phase 8 was the right move.

**Result.** Zero new stock-movement code for an entirely new lifecycle event.

### 3. Whose action is a system action?

**Goal.** The ledger's `createdByUserId` is a required field, but a cron has no logged-in user.

**Choice.** Attribute the release to `reservation.createdByUserId` — the person who made the reservation.

**Reason.** A dedicated "system user" or a nullable `createdByUserId` on the core ledger were both cleaner in theory but cost a schema or seed change to the most central table. Attributing to the creator needs neither, and it isn't misleading in context: the transaction carries `source = RESERVATION` and the reservation's status is `EXPIRED`, which together read unambiguously as "the system auto-expired this hold," not "this user manually released it." The `source` + terminal-status pair already encodes *what happened*; the creator just answers *whose reservation it was*.

**Result.** A system action recorded with an honest-enough actor and no change to the ledger's shape. (I added a symmetric `expiredAt` column to match `fulfilledAt`/`cancelledAt` — the one small schema change this phase.)

## TIL (Today I Learned)

**How does the NestJS scheduler actually work with my other services?** It's just another entry point. `ScheduleModule.forRoot()` scans every provider at boot, finds methods tagged `@Cron`, and registers a timer that calls each one **on its real singleton instance** — so inside `sweepExpired()`, `this.prisma` and `this.inventory` are the same injected instances every controller and service holds. The cron is a peer of the HTTP server: an HTTP request goes `guard → controller → service`, while the cron goes `timer → the service method` directly. Both reach the same singletons the same way. The `@Cron` decorator is only metadata for "when to auto-call this"; the method is a plain `async` method — which is exactly why the tests can just call `app.get(ReservationExpiryService).sweepExpired()` with no timer involved.

**Why count `released` inside the loop instead of using `due.length`?** Because *being* a candidate isn't the same as *getting* released. `due` is everything that looked expired at fetch time; the guarded claim then either wins (`count: 1`, released) or loses to a concurrent action (`count: 0`, skipped). So `due.length` overcounts — it includes the ones another sweep or a fulfill already handled. `releasedCount` tallies only the real releases, which is the honest number to log and to assert on. It's reporting, not correctness: the stock moves the same whether or not you count.

**`prisma generate` vs a version mismatch.** Mid-phase I bumped the `prisma` CLI to an `8.0.0-rc` while `@prisma/client` stayed on 7. `npx prisma generate` is still the command — but the CLI and the client must be the **same major**, because the CLI generates a client the runtime has to understand. CLI 8 + client 7 either errors or emits a client the v7 runtime can't load. The fix was reverting the CLI to v7 to match the client and adapter. Lesson: a major-version bump of one Prisma package is a bump of all of them, done deliberately — not a mid-feature side quest, and never on a release candidate.

**Why did adding a cron break the e2e (and why do unit and e2e need opposite config)?** `@nestjs/schedule` v12 is **ESM-only** (`"type": "module"`). The **unit** runner is plain CommonJS Jest, which chokes on the package's `export` syntax — so it needs `transformIgnorePatterns` to *transform* the package down to CJS. The **e2e** runner already runs under `--experimental-vm-modules` (Prisma 7's WASM query compiler needs it) — an ESM context, where transforming the package *to* CJS makes its `exports` undefined. So the e2e must do the opposite: **not** transform it, and let Jest's ESM loader import the native ESM. Same dependency, two runners, two opposite fixes — because one runner is CJS and the other is ESM.

## NestJS Concepts & Libraries

| Concept / tool | Why it showed up in Phase 10a |
|----------------|------------------------------|
| **`@nestjs/schedule`** (`ScheduleModule.forRoot`, `@Cron`, `CronExpression`) | Run `sweepExpired()` every minute as a background job. |
| **Scheduler as a peer entry point** | The cron reaches services by normal DI — no request, no guards, no user (hence the actor + guarded-claim decisions). |
| **Guarded `updateMany` claim** | Phase 6's atomic-write trick applied to a status column — multi-instance-safe with no lock. |
| **`recordWithinTransaction`** | The engine's fourth caller; a release is a release. |
| **ESM-only dependency + Jest** | Unit (CJS) transforms `@nestjs/schedule` to CJS; e2e (ESM via `--experimental-vm-modules`) loads it natively. |
| **Prisma package version alignment** | CLI, `@prisma/client`, and `@prisma/adapter-pg` must share a major. |

## Wrap-up

Phase 10a delivered a scheduled auto-expiry sweep: a `@Cron` job that claims each expired hold with a guarded write and releases its stock through the same engine every other movement uses, safely even under concurrent instances, and honestly attributed in the ledger. **170 unit tests + 63 e2e, all green** — once the ESM and Prisma-versioning dust settled.

The conceptual payoff was smaller than the infrastructure lesson. The sweep itself was almost boring to write, because the hard parts — atomic writes, guarded decrements, the release effect — already existed; a cron is just a new clock wired to old machinery. The real learning was operational: that a scheduler is nothing more than another trigger into the same DI graph, and that pulling an ESM-only dependency into a CommonJS-and-WASM toolchain is where the actual afternoon goes.

**And that's the domain, complete.** Auth, authz, catalog, stores, corners, placement, transactions, orders, audits, reservations, and now the job that cleans up after them — Inventra can carry a product through its whole life on a corner's shelf. What's left is deliberately *not* built yet: caching, rate limiting, metrics, API docs — the cross-cutting concerns you add when a real deployment gives you a real reason to, not before. The engine holds, moves, reconciles, and now lets go. That's a finished machine.
