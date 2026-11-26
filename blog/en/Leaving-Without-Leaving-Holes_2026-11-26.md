# Leaving Without Leaving Holes

> Letting people work in several branches took one table. Letting them leave took a lock on every way out, a rule for who takes over, and asking Apple to forget us.

*2026-11-26*

## Intro

[Inventra](https://github.com/develoHAM/inventra_backend) is a multi-tenant inventory SaaS built on **NestJS 11 + Prisma 7 + PostgreSQL**, modeled on the Korean concession-store world: companies run branches ("corners") inside department stores, and owners, managers and staff keep the stock in sync.

This track is **piece 3 of 3 of the membership overhaul: many branches, and leaving.** Two things were missing. A part-timer who sells at Hongdae on weekdays and Jamsil on weekends could only be recorded in one branch. And nobody could ever leave: no "leave this company", no way for an owner to let someone go, no account deletion (which Apple requires, with token revocation), no way for a company to close. The rule that shaped everything: **leaving must never leave a hole**, meaning a company with people still working in it and no owner.

It ran **eight days**: a design I approved and then threw away on day three, 5 tasks, one migration, and one style commit I asked for halfway through. The unit suite went from 1238 to **1403** tests, and the end-to-end suites from 271 to **324** across 18 suites.

## Architectural Decisions

### 1. The role belongs to the person; branches are just a list

**The goal:** a manager or staff member can work in any number of branches, or in none.

**The options:**

| | Approach | What happened |
|---|---|---|
| 1 | A role on each branch assignment, plus a company-wide role kept in sync | Dropped: the same fact stored twice. One forgotten sync and the role is stale |
| 2 | A role on each branch assignment, with the company-wide role **computed** from them | **Approved, then dropped two days later** |
| 3 | Only owners and managers: everyone in a branch manages it | Dropped: weekend part-timers would edit the company-wide catalog |
| 4 | **The role on the person, branches as a plain list** | Picked |

**The choice:** approach 4. `profiles.role_id` stays where it was, and a new `profile_branches` table holds where each person works.

**The reason:** approach 2 died on a question I asked while reviewing it: *Minji manages Gangnam. Gangnam closes. Is she still a manager?* Under approach 2, no: her role lived on the branch row, so it disappeared with the branch, and with it her right to edit the shared catalog. That's when the principle clicked: **a permission belongs at the level of the thing it protects.** The catalog is company-wide, so "may edit the catalog" belongs to the person. Branch work is branch-scoped, so "where they may work" belongs to the list.

It also settled a second question. I'd wanted to require at least one branch, and to block deleting a branch that would leave someone with none. With the role on the person, there's nothing to protect: Minji keeps her role, every branch route answers 403 until an owner adds her somewhere, and nothing is ever blocked.

**The result:** one migration did the whole piece, including a hand-written copy placed before the old column's drop:

```sql
CREATE UNIQUE INDEX "UQ_profile_branches_profile_branch"
  ON "profile_branches"("profile_id", "company_store_id") WHERE (deleted_at IS NULL);

-- Copy (hand-written): each live profile's live branch becomes its first assignment.
INSERT INTO "profile_branches" ("profile_id", "company_store_id")
SELECT p."id", p."company_store_id"
FROM "profiles" p
JOIN "company_stores" cs ON cs."id" = p."company_store_id"
WHERE p."deleted_at" IS NULL AND cs."deleted_at" IS NULL;

-- Moved to the end by hand: the old column goes only after the copy above.
ALTER TABLE "profiles" DROP COLUMN "company_store_id";
```

The guard reads `branchIds` fresh on every request, so adding someone to a branch takes effect on their next click, with no new token.

### 2. One procedure for every way out

**The goal:** three ways to leave a company (leaving yourself, being removed, deleting your account), all with the same rules: assignments end, history is written, the last owner is replaced or the company closes.

**The options:** three services, each with its own copy of the rules; or **one procedure** that each caller runs inside its own transaction.

**The choice:** one procedure, `LeavingService.leaveInTransaction(transaction, { profileId, companyId, actorProfileId, reason, ownerSuccessorProfileId? })`.

**The reason:** the rules are where the bugs hide. Three copies would drift apart, and the first drift would be a company with no owner. Two design details made sharing work:

- **It takes a transaction instead of opening one.** Account deletion runs it once per company, all inside one transaction, so either every company is left or none is.
- **It returns its events instead of emitting them.** A notification sent from inside a transaction that later rolls back announces something that never happened. So the procedure collects them, and each caller emits them after its commit:

```ts
const outcome = await this.prisma.$transaction((transaction) =>
  this.leaveInTransaction(transaction, { …, reason: 'LEFT_COMPANY' }),
);
// Only now, after the commit: never announce a leave that rolled back.
for (const event of outcome.events) {
  this.eventEmitter.emit(event.name, event.payload);
}
```

**The result:** removal (Task 4) needed one new branch in the procedure, and account deletion (Task 5) needed none. Leaving every company at deletion is a short loop over the same call.

### 3. The last owner names a successor, the system picks one, or the company closes

**The goal:** the last ACTIVE owner can leave without leaving the company ownerless.

**The options:** forbid the last owner from leaving; force them to name someone; or **let them name someone, and otherwise let the system pick, and close the company if nobody is left**.

**The choice:** the third. A named successor must be an ACTIVE manager or staff member of the same company (anyone else → 400 `This person cannot take over as owner`). Otherwise `pickSuccessor` picks, and records `AUTO_PROMOTED` with no `changed_by`, because no person made that choice:

```ts
export function pickSuccessor(
  candidates: { profileId: string; createdAt: Date; roleCode: string }[],
): string | null {
  const ranked = [...candidates].sort((first, second) => {
    const firstRank = first.roleCode === 'MANAGER' ? 0 : 1;
    const secondRank = second.roleCode === 'MANAGER' ? 0 : 1;
    if (firstRank !== secondRank) {
      return firstRank - secondRank; // managers first
    }
    const byTenure = first.createdAt.getTime() - second.createdAt.getTime();
    if (byTenure !== 0) {
      return byTenure; // the earliest joiner first
    }
    return first.profileId < second.profileId ? -1 : 1; // a fixed tie-break
  });
  return ranked[0]?.profileId ?? null;
}
```

**The reason:** forbidding it traps people in a company, and forcing a name fails exactly when nobody is around to ask, for example at account deletion. The pick is a pure function so the rule can change later without touching the transaction.

**The result:** a `GET /profiles/me/leave-preview` shows the owner, before anything happens, who could take over, who the system would pick, and whether the company would close. Closing is final for now: the company and its branches are soft-deleted, so their names stay on every record.

### 4. Every race is closed by a lock taken inside the transaction, never by an early check

**The goal:** two owners leaving at the same moment must not both see "someone else is still owner".

**The options:** check the owner count before the transaction (simple, and wrong), or **lock the company row first and count after the lock**.

**The choice:** every way out writes the company row first, which locks it:

| Time | Request 1: owner A leaves | Request 2: owner B leaves |
|---|---|---|
| t1 | locks the company | waits for the lock |
| t2 | counts: B is still an owner → leaves | |
| t3 | commits | gets the lock, counts: **nobody left** → successor or closing |

The same rule placed the removal check. Removing the last ACTIVE owner is a 409, but that check lives **inside** the procedure, after the lock, not as an early `if` in the remove endpoint. An early check would read the count before a co-owner's leave committed.

**The reason:** an early check answers "how many owners are there *now*?", and by the time you act on it, "now" is over.

**The result:** an e2e fires two leaves with `Promise.all` and checks that the company never ends up with members and no owner. The same idea solved two more problems:

- **Deadlocks.** Account deletion leaves companies in `companyId` order. If Kim locks A then wants B while Lee locks B then wants A, both wait forever. With one shared order, the second simply waits for the first.
- **A race nobody had specified.** While teaching the deletion I noticed that *linking* a Google login didn't take the account lock. A link landing just after deletion step 4 would leave a login row on a deleted account forever, and since that unique index counts every row, that Google account could never sign up again. Now both link methods lock the live account first (count 0 → 401), and an e2e fires a deletion and a link together and checks that nothing is left behind.

### 5. Removal checks the role, not just the permission

**The goal:** owners and the admin can remove members. Nobody else can, and owners can't remove each other.

**The options:** trust the `profiles.remove` permission alone, or **check the role in the service too**.

**The choice:** both layers, with the role check first because it needs no query:

```ts
// The role, not just the permission: a personal GRANT of profiles.remove
// gets a manager past the guard, but never past this.
if (caller.roleCode !== 'OWNER' && caller.roleCode !== 'ADMIN') {
  throw new ForbiddenException('Only owners and the admin can remove members');
}
```

Then: not yourself (400, with a pointer to `/profiles/me/leave`), a lookup scoped to the caller's company (another company's member is **404**, never 403, so we don't confirm they exist), owners never remove an owner (403), and the status check last, so nobody learns the state of someone they may not remove.

**The reason:** permissions can be granted to one person (`profile_permissions`). A business rule like "only owners remove" must not be one grant away from bypass, the same rule approval already follows.

**The result:** two more decisions came with it:

- **`POST /profiles/:id/remove`, answering 204**, not `DELETE /profiles/:id`. Nothing is deleted: the profile stays, `DEACTIVATED`, and every record still points at it.
- **Four permissions retired.** `profiles.create`, `profiles.update`, `profiles.delete` and `companies.update` had been seeded for months and **no route ever checked them**. Removing them from the seed list isn't enough, because the seed's `upsert(…, update: {})` only ever adds. So the seed gained a retire step, deleting grants first because both grant tables point at the permission with `ON DELETE RESTRICT`:

```ts
await prisma.$transaction([
  prisma.rolePermission.deleteMany({ where: { permission: { code: { in: retiredCodes } } } }),
  prisma.profilePermission.deleteMany({ where: { permission: { code: { in: retiredCodes } } } }),
  prisma.permission.deleteMany({ where: { code: { in: retiredCodes } } }),
]);
```

### 6. Deleting an account: what to delete, and what to only mark

**The goal:** a deleted account can never sign in, refresh or get a push again, and its phone and login identities are free for a new signup. But **names stay on records**: history rows point at profiles with `ON DELETE RESTRICT`.

**The options:** hard-delete everything (breaks history), soft-delete everything (blocks re-signup), or **decide row by row**.

**The choice:** decide by which unique indexes ignore deleted rows:

| Thing | Its unique rule | So we… |
|---|---|---|
| The phone (on the account) | counts only `deleted_at IS NULL` rows | soft-delete the account, and the phone is free |
| Kakao/Google identity, password email | counts **every** row | hard-delete the login methods |
| Profiles | history points at them | keep them, `DEACTIVATED` |
| Sessions | — | mark them revoked |
| Device tokens | — | delete them: no more pushes |

`DELETE /me` runs all of it in one transaction behind a fresh phone proof (purpose `DELETE_ACCOUNT`, the account's own phone, single use):

```
1. lock the live account, reading its phone in the same statement
2. spend the proof (inside the transaction: a later failure gives it back)
3. leave every company, in companyId order
4. read the login methods, then delete them
5. revoke every live refresh token
6. delete the device tokens
7. set deleted_at; clear last_profile_id
```

Step 1 is one `updateManyAndReturn` that both takes the lock and reads the phone. If it returns `[]`, a second deletion waited here and found the account already gone (401).

**The reason:** "soft-delete everywhere" is the project's convention, but a convention is a default, not a law. The deciding question was always "does a unique index still see this row?"

**The result:** the e2e for a deleted account checks every credential: the old access token and refresh token get 401, password login gets 401, `device_tokens` is empty, and then the same phone and email sign up again and the same Kakao identity links again.

### 7. Talk to the outside world only after the commit

**The goal:** Apple requires that deleting an account also revokes its Sign in with Apple tokens. Google, Kakao and Facebook can be told too.

**The options:** call the providers inside the transaction, or **after the commit, best-effort**.

**The choice:** after the commit, through one method that never throws:

| If it ran inside the transaction… | Problem |
|---|---|
| A provider takes seconds | The account and company locks are held the whole time |
| The transaction then rolls back | Apple has already forgotten us, but the account still exists here |

The disconnect already existed as a private method in `LoginMethodsService` (unlink uses it). I moved it into its own `ProviderDisconnectService.disconnectQuietly`, exported by `SocialAuthModule`, so unlink and deletion share one copy, and deletion gets exactly that method rather than the whole login-methods service.

**The reason:** at that point the account really is deleted. Answering 500 because Google was down would tell the user "it didn't work" when it did. A failure is logged for us instead.

**The result:** a provider outage can't block a deletion or undo one, which the spec listed as an anti-goal.

### 8. Deletion gets its own small module, which nothing imports

**The goal:** a home for `DELETE /me`. It needs four other modules: the phone proof, the provider disconnect, the leave procedure and the admin check.

**The options:** `AccountsModule` (the obvious home), `ProfilesModule`, `SocialAuthModule`, or **a new module**.

**The choice:** `AccountDeletionModule`, which imports the four and is imported by nothing.

**The reason:** `AccountsModule` would have to import `SocialAuthModule` for the disconnect, but `SocialAuthModule` already imports `AccountsModule`. That's a cycle. `ProfilesModule` would have worked, but it's about one person in one company, not the sign-in. A module that nothing imports can't be part of a cycle.

**The result:** a wiring test builds the real module graph with only the database, storage and the queue swapped out, so a missing export fails in `npm test` instead of at app start.

### 9. Two readability rules I asked for

Halfway through, I asked for two rules that changed every file:

- **Braces on every `if`, `else` and loop body**, even a one-line `return`, enforced with ESLint `curly: ['error', 'all']`. It landed as its own commit across 49 files, so the feature commits stayed readable.
- **Every Prisma `select` and `where` inline at its query.** Shared constants like `PROFILE_SELECT` saved lines but made me jump to another file to see which fields a query reads. Repetition I can see beats indirection I have to look up.

## TIL (Today I Learned)

**"Should staff and managers need at least one branch, and should deleting a branch be blocked if it would leave them with none?"**
No, once the role lived on the person. A rule like that only exists to protect something stored on the branch. With nothing stored there, the person keeps their role, waits for a new branch, and no deletion is ever blocked.

**"Some roles edit the catalog while working in a branch; staff only use it. Where does that belong?"**
On the person. The catalog is shared by every branch, so a power over it can't depend on which branch rows you have. This question is what made approach 4 the right one.

**"What does `isMarked` do?"**
It reads metadata that a decorator attached to the route. `@Public()` and `@AccountRoute()` are just `SetMetadata(KEY, true)`. The guard asks the `Reflector` whether the handler or its class carries that key, and lets the request through, or skips the company check, accordingly.

**"Is defining the `select` once the only alternative to writing it inline?"**
No, both work (a shared object typed with `satisfies Prisma.ProfileSelect` is perfectly valid). Inline was a readability choice, not a technical limit.

**"Why `flatMap` instead of `filter`?"**
`filter` keeps the element type unchanged unless you write a type predicate, so TypeScript would still think `role` might be `null`. `flatMap` returning `[]` (drop) or `[item]` (keep, reshaped) filters and maps in one pass, and TypeScript knows exactly what comes out.

**"What statuses can a profile have, and what creates each one?"**
Five: `PENDING_APPROVAL` (joining or creating), `ACTIVE` (approval), `DEACTIVATED` (leaving, removal, deletion, closure), plus `SUSPENDED` and `REJECTED`, which the enum has but **no endpoint sets yet**. The leave procedure still accepts them, so a future suspension flow won't need it rewritten.

**"Why does deletion need its own controller and service?"**
Because in Nest, *where a class can be built is decided by what it needs*. A provider can only receive what its own module provides or imports. Deletion needs four modules, and the only home that can import all four without a cycle is a new one. The controller moves with the service, since a controller can only inject what its module sees.

**"What does `@Inject(SOCIAL_VERIFIERS)` do?"**
It took four explanations to land, so here's the one that worked. Nest normally decides what to pass into a constructor by reading each parameter's **type**. That works for classes like `PrismaService`. The verifier map's type is `Record<…>`, which only exists for TypeScript and is gone when the code runs, so Nest has nothing to go by. We give it a **name** instead, in two places:

```ts
// 1. The module stores the value under a name
{ provide: SOCIAL_VERIFIERS, useFactory: buildSocialVerifiers }

// 2. The constructor asks for it by that name
@Inject(SOCIAL_VERIFIERS) private readonly verifiers: Record<SocialProvider, SocialIdentityVerifier>
```

The rule of thumb: a class needs no `@Inject`, anything else does. (The detailed version, about `design:paramtypes` and how the injector overwrites one entry in that list, was correct, but it was the explanation that didn't help.)

**"What's `ConfigService<Env, true>`?"**
`Env` is the shape of our validated environment, so `get('LOGIN_TOKEN_ENCRYPTION_KEY')` knows the key exists. `true` says the values were validated at startup, so `get` returns `string`, not `string | undefined`.

And a few I didn't know to ask, picked up while reviewing the diffs:

| Thing | Lesson |
|---|---|
| `ParseUUIDPipe` on `:id` | A malformed id is a 400 before any query. Without it, Postgres rejects the value and the client sees a 500 |
| `@HttpCode(204)` | Nest answers 201 for POST and 200 for everything else, DELETE included, unless you say otherwise |
| `as const` + `Record<EventName, …>` | Adding an event name is a compile error until it has channels. The type system keeps the table complete |
| `$transaction([...])` vs `$transaction(async (tx) => …)` | The array form runs independent queries in one transaction; the function form is for read, check, then write |
| `import type` on a DTO | It compiles, starts, and **silently skips validation**: the pipe sees `Object` instead of the class |

## NestJS Concepts & Libraries

| Concept / library | Why we used it |
|---|---|
| **Modules: `imports` / `exports`** | Deletion's dependencies come from four modules; a leaf module avoids an import cycle |
| **Custom providers: `useFactory` + `@Inject(TOKEN)`** | The social verifier map is built per environment and isn't a class |
| **`emitDecoratorMetadata`** | Why injected classes and DTOs must be value imports |
| **`SetMetadata` + `Reflector`** | `@AccountRoute()` makes `DELETE /me` work with no company open |
| **`ParseUUIDPipe`, `ValidationPipe` + class-validator** | Bad input is a 400 before the service runs |
| **`@HttpCode`** | 204 for removal and deletion, 200 with a summary for leaving |
| **`@nestjs/event-emitter`** | `member.left`, `member.removed`, `member.roleChanged`, emitted only after the commit |
| **Prisma interactive `$transaction`** | Every way out is one transaction around the shared procedure |
| **Prisma `updateManyAndReturn` / `createManyAndReturn({ skipDuplicates })`** | Locks, receipts and duplicates detected by counts, never by catching errors |
| **Postgres partial unique indexes** | One live assignment per person per branch; a deleted account frees its phone |
| **Postgres row locks (via `UPDATE`)** | Company lock first, account lock first, one lock order everywhere |
| **ESLint `curly: all`** | Braces everywhere, enforced |
| **Jest: a timeline array, `it.each`, `Reflect.getMetadata`, `Test.createTestingModule` wiring specs** | The exact order of steps, every refusal, route metadata, and module wiring, without a database |
| **supertest + `Promise.all`** | Two leaves, or a deletion and a link, at the same moment |

## Wrap-up

Piece 3 delivered **several branches per person** (`profile_branches`), **leaving** with an owner successor or a closure, **removal** by owners and the admin, and **account deletion** behind a phone proof that disconnects the social providers. That's six new endpoints and one removed, in one migration, with 1403 unit tests and 324 end-to-end tests green.

That also completes the membership overhaul: roles and branches, one sign-in for many companies, and now a way to leave. What comes next is still open. The spec's "built for later" list includes the obvious candidate: scrubbing personal data at deletion, the step Korea's privacy law (PIPA) will eventually ask for, which this piece deliberately left as "names stay on records, for now".
