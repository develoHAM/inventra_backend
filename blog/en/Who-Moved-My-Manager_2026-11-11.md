# Who Moved My Manager?

> Promoting, demoting and moving people between branches sounds like three `UPDATE` statements. It turned into a rulebook, a lock order, a history that can't be erased, and one hard lesson about guest lists.

*2026-11-11*

## Intro

[Inventra](https://github.com/develoHAM/inventra_backend) is a multi-tenant inventory SaaS built on **NestJS 11 + Prisma 7 + PostgreSQL**, modeled on the Korean concession-store world: companies run "corners" (branches) inside department stores, and owners, managers and staff keep stock in sync.

This track is **piece 1 of 3 of a membership overhaul**: roles and branches. Owners and the platform admin can now move people between branches, promote and demote them, approve newcomers straight into a role and a branch, and close a branch without stranding anyone. Every one of those changes leaves a permanent, readable history, and the person affected gets a notification.

It ran across **8 tasks in six days**, plus a final review and a fix pass. The unit suite grew from 880 to **1069** tests, and a new end-to-end suite walks the whole story over real HTTP (**227** e2e tests across 16 suites).

## Architectural Decisions

### 1. One branch per manager: the foreign key's direction decides the rule

**The goal:** a manager or staff member belongs to **one branch or none**, while a branch may have several managers and staff, or none at all.

**The options:**
- Keep `company_stores.manager_user_id` (the corner points at its manager) and add rules in code.
- A join table between users and branches, with a unique constraint.
- **Point the other way:** `users.company_store_id`, the person points at their branch.

**The choice:** the person points at the branch, the same column staff already used.

**The reason:** the direction of a foreign key *is* the cardinality.
- A column on the corner can hold one manager, but the same manager can be named by many corners. That's "one manager per corner, many corners per manager", the opposite of what we wanted.
- A column on the user holds one branch, and any number of users can hold the same one. The database enforces "one branch per person" for free, with no unique index and no code.

**The result:** one source of truth for "who is where", and the corner's manager link, the three assignment endpoints and the `corners.assign` permission all went away in favor of a single `PUT /users/:id/branch`.

The migration taught me something too. The plan was the classic **expand → migrate → contract**: create the migration with `--create-only`, hand-write a data step that copies each corner's manager into `users.company_store_id`, then apply. It got applied **before** the data step was added. Prisma records a checksum for every applied migration, so editing it afterwards would make every future `migrate` flag it as tampered with. The fix was a **data-only follow-up migration**, after first checking read-only that no database actually had manager links to lose. Rule kept: once a migration might have run anywhere, you add a new one, you never edit the old one.

### 2. An append-only history of full before-and-after snapshots

**The goal:** "who moved Lee to Branch B, and when?" must be answerable forever, per person, per branch, and per company.

**The options:**
- An `updatedAt` column (tells you *that* something changed, not what).
- A changes-only log (store just the field that changed).
- Database triggers.
- **One row per change with the complete before and after**, written by the code that makes the change.

**The choice:** `membership_changes`: `from/to role`, `from/to branch`, `reason` (`APPROVED | MOVED | ROLE_CHANGED | BRANCH_DELETED`), `changed_by_user_id` (null = the system), written in the **same transaction** as the change itself.

**The reason:**
- **Full snapshots make every query simple.** A manager promoting staff inside Branch A writes a row with `from = to = A`, so "Branch A's history" is just "rows where A is the from or the to". With a changes-only log, that promotion wouldn't mention A at all.
- **Same transaction** means a change and its history commit or roll back together. There's never a move without a row, or a row without a move.
- Rows are never updated or deleted, so the encoding had to be right from the first migration.

**The result:** three read endpoints (a person's timeline, a branch's, a company's feed) are just three different `where` clauses over one table.

### 3. The role matrix as a pure function

**The goal:** the promote/demote rules have a dozen cases (who may change whom, to what, and what happens to their branch), and I wanted to test them all without a database.

**The options:** `if` chains inside the service, next to the transaction; or a **pure function** that returns a decision.

**The choice:** `decideRoleChange`, a function with no database and no side effects:

```ts
type RoleChangeDecision =
  | 'noop'
  | { branch: 'keep' | 'clear' | 'set'; checkOwnerCount: boolean };
```

- `keep`: staff ↔ manager stay in their branch.
- `clear`: promoted to owner, so they leave it (owners have no branch).
- `set`: the admin demoting an owner picks the new branch (or `null`).
- `checkOwnerCount`: only owner demotions must prove a second owner remains.

**The reason:** the service only *executes* a decision. The rulebook is tested row by row against the spec's matrix, including self-demotion and "a manager with no branch can't promote staff with no branch" (`null === null` must not count as the same branch).

**The result:** the trickiest logic in the track has the simplest tests, and the service reads like a recipe.

### 4. Races without `SELECT … FOR UPDATE`

**The goal:** two admins demoting the last two owners at the same moment must leave exactly one owner. A move into a branch racing the branch's deletion must not leave someone in a deleted branch.

**The options:** read, check, then write (and hope); catch the database's errors; or **make the database serialize the conflicting requests**.

**The choice:** four habits used together:
- **Lock by writing.** Prisma has no `FOR UPDATE`, but any `UPDATE` holds that row's lock until commit. So "lock this branch" is an `updateMany` that bumps `updatedAt`, and its count says whether the branch is still live:
  ```ts
  const locked = await transaction.companyStore.updateMany({
    where: { id: cornerId, companyId: companyId, deletedAt: null },
    data: { updatedAt: new Date() },
  });
  return locked.count === 1;
  ```
- **Guarded writes.** The member's row is updated with its *old* values in the `where`. If someone changed it a moment ago, nothing matches, `count` is 0, and the answer is 409 "reload".
- **The company row for owner counts.** Two demotions each counting "2 owners" and each demoting one is a *write skew*: neither write conflicts with the other, but together they break the rule. Both now write the company row first, so the second waits and then counts what the first left.
- **One lock order everywhere:** company → branch → member. Two requests that lock in opposite orders can deadlock. One order makes that impossible.

And events (notifications) are emitted **after** the transaction commits, so nobody is told about a change that rolled back.

**The result:** the races are settled by Postgres, and the code reads a plain answer (a count) instead of parsing errors.

### 5. Closing a branch: a receipt, not a photo

**The goal:** deleting a branch releases everyone in it, with one `BRANCH_DELETED` history row and one notice each.

**The options:** `findMany` the branch's people, then `updateMany` them (a *photo* taken before the write), or **`updateManyAndReturn`** (a *receipt* of exactly what the write changed).

**The choice:** the receipt:

```ts
const releasedMembers = await transaction.user.updateManyAndReturn({
  where: { companyStoreId: id, deletedAt: null },
  data: { companyStoreId: null },
  select: { id: true, roleId: true },
});
```

**The reason:** with the photo, someone moved out between the read and the update would still get a "your branch was closed" row and notice. The receipt has no gap: it lists exactly the rows the update touched, in the same statement.

**The result:** the history and the notifications always match what happened.

### 6. `undefined`, `null` and a value are three different answers

**The goal:** approval must always say where the newcomer goes, including "no branch yet". A role change must refuse a branch unless the admin is demoting an owner.

**The options:** treat "missing" and `null` the same, or keep all three states.

**The choice:** three states.
- Approval: `cornerId` is **required but nullable** (`@ValidateIf((dto) => dto.cornerId !== null) @IsUUID()`): sending nothing is a 400, `null` means "no branch yet".
- Role change: `cornerId` is **optional**, and the service checks `dto.cornerId !== undefined` to know whether it was *sent* at all.

**The reason:** "the caller didn't say" and "the caller said none" are different intentions. Collapsing them would either force a branch on every role change or silently drop one on approvals.

**The result:** each endpoint asks exactly the question it needs answered, and the validation messages say so.

### 7. Who sees whom: reads are company-wide, pending people only for real approvers

**The goal:** colleagues must be able to reach each other, but people still waiting for approval aren't colleagues yet.

**The options:** branch-scoped member lists; everyone sees everyone; or **company-wide lists with one exception**.

**The choice:**
- `GET /users` lists the whole company, **with phone and contact email**, filtered by `?cornerId=` (`none` for "no branch", because a URL can't carry `null`), `?role=` and `?status=`.
- People waiting for approval are listed only for callers who can **really** approve them: they hold `users.approve` **and** have a role `approve` accepts (admin, owner, or a manager *with* a branch).

**The reason:** the "can really approve" wording came out of the final review (decision 9). For anyone else, the pending people are filtered out, and asking `?status=PENDING_APPROVAL` returns an empty list rather than a 403 that would confirm they exist.

**The result:** one list for the whole company, and the approval queue stays private to the people who can act on it.

### 8. A history you can page through: a bookmark, not a page number

**The goal:** read long histories newest first, in pages, without repeating or skipping entries while new ones keep arriving at the top.

**The options:** offset paging (`skip: 50`), or **cursor paging**.

**The choice:** a cursor, using Prisma's `cursor`, `take` and `skip`, plus two tricks of my own:

```ts
const rows = await this.prisma.membershipChange.findMany({
  where: where,
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  take: limit + 1,
  ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  select: MEMBERSHIP_CHANGE_SELECT,
});
const hasMore = rows.length > limit;
const items = rows.slice(0, limit).map((row) => toMembershipChangeView(row));
return { items: items, nextCursor: hasMore ? items[items.length - 1].id : null };
```

**The reason:**
- **Offset counts positions from the top.** When a new entry lands on top, every position shifts and an entry repeats. A cursor names a specific entry, so new arrivals don't move it.
- **Prisma's cursor is inclusive:** `cursor: { id }` starts *at* the bookmarked row, the last one the app already showed, so `skip: 1` steps over it.
- **`limit + 1` is a peek:** fetch one more than you show. If it exists, there's another page, so no `COUNT` query.
- **`id` is the tie-breaker.** Rows written by one statement share a timestamp to the microsecond (I checked: closing a branch with two people wrote two rows with an identical `created_at`). Sorting by time alone leaves their order up to the database, and a page boundary between them could repeat one and lose the other.

Visibility sits in front of it: another company's person, branch or feed is **404** (we don't confirm it exists), and only then does a role check give **403**. Items carry only ids and names, never a phone or email.

**The result:** an e2e test pages through the whole company feed one entry at a time, ties included, and checks nothing repeats and nothing is lost.

### 9. The final review, and the guest list

**The goal:** a second pair of eyes on the whole branch, not just on each task.

**The options:** trust the per-task tests; review it myself; or **dispatch a fresh reviewer** with the plan's "Review Focus" list and every judgment call I'd recorded.

**The choice:** a fresh reviewer, then **one fix pass**, each fix proven by a test that failed first.

**What it found:**
- **One real hole.** Company signup stores the owner as `PENDING_APPROVAL` *with* the OWNER role; members who join by code are pending with no role. `approve` only checked "is pending", so the admin could approve a company's pending owner as staff and leave the company with no owner. Fixed: a pending person who already has a role is refused (400), and the guarded write also requires `roleId: null`.
- **A blacklist where every other rule used a guest list.** The old check named only the role to *restrict*:
  ```ts
  if (caller.roleCode === 'MANAGER') { /* staff only, own branch only */ }
  // everyone else: no limits
  ```
  Every role it didn't name, including STAFF, got owner-level power. That only looked safe because the permission guard never let staff in. Inventra also supports **per-user permission overrides** (a `GRANT` or `DENY` row on top of the role's permissions), and the guard can't tell where a permission came from. A staff member with a personal `GRANT` of `users.approve` would pass the guard and approve someone as a manager into any branch. Now the check names the roles that are **allowed**, and everything else is 403:
  ```ts
  const isAdminOrOwner = caller.roleCode === 'ADMIN' || caller.roleCode === 'OWNER';
  if (!isAdminOrOwner) {
    if (caller.roleCode !== 'MANAGER') throw new ForbiddenException('Only owners and managers can approve members');
    /* staff only, own branch only */
  }
  ```
- **History foreign keys that could blank a name.** Prisma defaults an *optional* relation to `ON DELETE SET NULL`. A hard-deleted actor would have turned into `changedBy: null`, which our API reads as "the system did it". Now all seven are `ON DELETE RESTRICT`: the database refuses to delete anything the history points at, which enforces "a deleted person's name stays on records" at the lowest level.
- **A bookmark from another feed** silently gave a wrong page. Now it's a 400.
- **A concurrency test that couldn't fail.** "Two demotions at once" passes with or without the lock if the requests happen not to overlap. The new test holds the company row lock *itself*, sends a demotion, checks it is still waiting after half a second, then releases it and expects a 409. Without the lock in the code, it fails.

**The result:** all of it fixed, and the review's "declined to judge" list became a set of written rulings rather than silent assumptions.

## TIL (Today I Learned)

**"How does `updateMany` lock the corner? Is it the standard pessimistic `FOR UPDATE` in Prisma?"**
Prisma has no `FOR UPDATE` at all. Postgres takes a row lock for *every* `UPDATE` and holds it until the transaction ends, so writing a row (even just `updatedAt`) is a lock. A second transaction writing the same row waits, then re-checks its own `where` against the committed row.

**"What decides commit or rollback in `$transaction`, and what happens when something throws inside?"**
If the callback resolves, it commits, even if it returns `null`. If it throws, everything rolls back and the *same* error is rethrown to the caller. Two traps: a query on `this.prisma` inside the callback isn't part of the transaction, and side effects like emails can't be rolled back, which is why events are emitted after commit.

**"Moving out of A doesn't lock A, only B. Does that mean a user's branch can't become B while B is locked?"**
Not quite: the lock is on B's *row*, not on anyone's `company_store_id`. A move into B writes B's row, and so does B's deletion, so they take turns. If the delete wins, the move then finds `deletedAt` set and answers 404. If the move wins, the delete releases that person too. Either way, nobody ends up in a deleted branch.

**"Where are the extra rules checked, if not in the query?"**
After it, on the row. The tenant filter is spread into `where`. If more conditions were spread after it, a same-named key could silently replace `companyId`. So `findTarget` fetches with the tenant filter only, then rejects the row in code (no company, or not a member role → 404).

**"What's `satisfies Prisma.UserSelect`?"**
It checks that my `select` object is a valid select (typos fail to compile) **without** widening its type, so `Prisma.UserGetPayload<{ select: typeof MEMBER_SELECT }>` can still derive the exact row type from it.

**"Why allow `cornerId` to be `undefined` in the first place?"**
Because "not sent" and "sent as `null`" mean different things. On a role change, only the admin demoting an owner may send a branch, so the service needs to know whether one was sent at all, not just whether it's null.

**"Is the cursor a Prisma feature? And isn't it the first row of the next page?"**
`cursor`, `take` and `skip` are Prisma's `findMany` options; `limit + 1` and `nextCursor` are mine. The cursor I hand out is the **last row the app already showed**, and Prisma's cursor *includes* that row, so `skip: 1` drops it. Handing out the first row of the next page with no skip also works. I kept the documented pattern, where the bookmark is a row the app already has.

**"Why sort by `id` too?"**
Rows written by one statement get the same `created_at`. With only the time to sort by, the database may return tied rows in either order, and a page boundary between them can repeat one row and never show the other.

**"What do you mean by 'guest list, not a blacklist'?"**
An allow-list names who may enter, so anything unplanned is refused (fails closed). A deny-list names who is restricted, so anything unplanned walks in (fails open). Both answer the same for every case you thought of. They only differ for the cases you didn't think of, which is exactly where bugs live.

**"What's a grant? There are per-user exceptions on top of the role?"**
Yes. `user_permissions` holds per-user `GRANT` or `DENY` rows, merged on top of the role's permissions. The guard only sees the merged set, so a grant changes what someone may do without changing their role. That's why role rules in the service must refuse roles they don't expect.

**"How can there be a manager with no branch?"**
Five ways: approved as a manager with "no branch yet", moved off their branch, their branch was deleted, promoted from staff who had no branch, or an owner demoted by the admin with no branch. They can approve no one, so they don't see the approval queue either.

## NestJS Concepts & Libraries

| Concept / library | Why we used it |
|---|---|
| Prisma interactive `$transaction` + `Prisma.TransactionClient` | a change and its history commit or roll back together |
| Prisma `updateMany` + `count` | guarded writes (409 on a lost race) and lock-by-write |
| Prisma `updateManyAndReturn` | release a branch's people and learn exactly who, in one statement |
| Prisma `findMany` with `cursor` / `take` / `skip` and a compound `orderBy` | cursor-paged history with a tie-breaker |
| Prisma named relations (`@relation("MembershipChangeActor")`) | several relations from one table to `users`, `roles` and `company_stores` |
| Prisma `onDelete: Restrict` | history rows can't lose a referenced name |
| `prisma migrate dev --create-only` + data-only migrations | hand-written data steps, and recovery without editing an applied migration |
| `satisfies Prisma.UserSelect` + `Prisma.UserGetPayload` | a checked `select` and the exact row type it returns |
| class-validator `@ValidateIf`, `@IsOptional`, `@IsIn`, `@IsEnum`, `@IsUUID` | required-but-nullable vs optional fields; query filters |
| class-transformer `@Type(() => Number)` + `ValidationPipe({ transform: true })` | `?limit=20` arrives as text and leaves as a number |
| `@Query()` DTOs and `ParseUUIDPipe` | validated query strings; a malformed id is 400, not a database error |
| `@nestjs/event-emitter` listeners | notifications emitted only after commit |
| `Record<MemberRoleCode, string>` | Korean role labels that fail to compile if a role is missing |
| Postgres `pg_constraint` (in e2e) | assert every history foreign key is RESTRICT |

## Wrap-up

The track delivered:
- **one branch per manager or staff member**, moves between branches, and branch deletion that releases its people
- **promotions and demotions** from a tested pure rulebook, with "a company always keeps an owner" enforced under concurrency
- **approval that places the newcomer** in a role and a branch in one step
- an **append-only membership history**, readable per person, branch and company, cursor-paged
- **notifications** for every move and role change, in Korean
- a member list where colleagues can reach each other, and the approval queue stays private to approvers
- a final review whose findings were all fixed, including a hole that predated this track

The lesson I'll keep: write access checks as **guest lists**. A rule that only names who to restrict is only as safe as every layer in front of it, and the next feature (here, per-user grants) will eventually open one of those layers.

Next up: **piece 2, one sign-in with a profile per company.** Today a phone number belongs to exactly one company. Next, a person signs in once and switches between companies like Slack workspaces, and the account and the company profile become two different things.
