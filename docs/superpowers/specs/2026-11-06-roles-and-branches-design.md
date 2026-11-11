# Roles & Branches — Design

**Date:** 2026-11-06
**Status:** built (Tasks 1–8, finished 2026-11-11). Where the build differs from this design, see **As built** at the end.
**Piece 1 of 3** of the membership track:
1. **Roles & branches** (this doc): promote/demote, move between branches, one branch per manager, change history, notifications.
2. **Sign-in / company-profile split**: one sign-in, a separate profile per company, switching between companies like Slack workspaces; joining or creating a company from an existing sign-in.
3. **Leaving**: leave a company, delete an account, the company closes when its last owner leaves, automatic promotion when a branch loses its last manager, social-provider disconnect.

Pieces 2 and 3 get their own designs. Nothing here may assume them, but nothing here should block them either (see "Built for later").

---

## Why

The owner wants an **interactive member-management screen**: see the company's people, change someone's role and branch, and have it take effect immediately. Today the backend can't support it:

- A corner points at **one** manager (`company_stores.manager_user_id`), and one manager can run several corners. Staff point at their corner (`users.company_store_id`). The two roles are modeled in opposite directions.
- Nobody's role can change after approval (`approveMember` sets it once).
- Approval sets a role but no branch, so every new member waits unassigned.
- Deleting a corner leaves its staff pointing at a deleted corner.
- Nothing records who moved whom, or when.
- There is no endpoint that lists a company's members.

## Goals

- Every manager and staff member belongs to **exactly one branch, or none**. A branch holds any number of managers and staff, **including none at all**.
- Owners and the admin promote and demote people and move them between branches; managers promote within their own branch. Every change **takes effect immediately**, with **no acceptance step**.
- Approving a new member picks their **role and branch** in one step.
- Deleting a branch moves its people to "no branch".
- An **append-only history** records every join, move and role change.
- The person affected is **notified** of role changes and moves.
- A **member list** endpoint feeds the screen.

## Non-goals

- Account deletion, leaving a company, company closure, automatic promotion (piece 3).
- Multiple companies per person, the sign-in/profile split (piece 2).
- An offer/acceptance step for promotions (explicitly dropped by the user).
- The client screen itself (the React Native app is a separate project).

## Anti-goals (would make this a failure even if it "works")

- An action **refused because a branch would be left without a manager or staff.** The user was explicit: an empty branch is acceptable. There are no handover rules.
- A manager able to move anyone, or to change an owner's role in any way.
- A company left with **zero owners** by an admin demotion, including when two admins act at the same moment.
- History rows that can be edited or deleted.

---

## Decisions (the user's)

| Topic | Decision |
|---|---|
| Branch membership | A manager or staff member belongs to **one branch at most**. A branch can have **several managers**, several staff, or nobody |
| Acceptance | **None.** Changes apply immediately |
| Moves | **Admin and owners** move managers and staff to another branch, or off their branch. **Managers can't move anyone** (staff or managers) |
| Promote to owner | **Admin and owners** can promote a manager or staff member to **owner** |
| Promote staff → manager | **Admin and owners**: any staff member. **A manager**: only staff of **their own branch**, who become a manager **of that same branch** |
| Demote manager → staff | **Admin and owners.** The person **stays in their branch** |
| Demote an owner | **Only the admin**, and only while the company has **more than one owner**. The admin picks the new role (manager or staff) **and** the branch in the same step, because owners have no branch |
| Owners and owners | Owners can't demote other owners. Managers can't touch owners at all |
| Owner's branch | Someone promoted to owner **leaves their branch**: owners run the whole company |
| Notifications | The person is told about their role change ("You're now a manager") |
| History | Every move is saved: who moved, from which branch to which, by whom, and when |
| Approval | Approving a member picks their **role and branch** in the same step, so nobody waits unassigned |
| Branch deletion | Deleting a branch that still has people **moves them all to "no branch"**, with a history entry and a notification each, instead of refusing the delete |

## Decisions (my calls, stated so they can be rejected)

| Topic | Call |
|---|---|
| Moves are notified too | "You've moved to Branch B", same as role changes |
| Role changes are in the history too | One timeline per person: joins, moves, role changes |
| Who reads history | Admin/owners: the whole company's feed, anyone in it, and any branch. A manager: their own branch's history, and the history of people currently in their branch. Anyone: their own |
| "No branch" at approval | Approval **always asks** for the branch: `cornerId` must be sent, but it may be `null`. Only the platform admin creates stores, so a newly approved company may have no branch yet, and a required non-null branch would lock it out of approving anyone. The same applies when the admin demotes an owner |
| History rows are full snapshots | Every row stores the role **and** branch both **before and after**, even the parts that didn't change. A manager promoting staff in Branch A is then a row with `from = to = A`, so it shows up in Branch A's history. Rows are append-only, so this encoding has to be right from the first migration |
| Self-demotion | An owner demoting **themselves** counts as "an owner demoting an owner" → refused. Only the admin demotes owners |
| Who is a valid target | Only **ACTIVE**, non-deleted members of the caller's company (the admin: of any company). Pending, rejected, suspended or deactivated people can't be moved or re-roled; approval is the path for pending ones |
| No-op requests | Moving someone to the branch they're in, or "changing" a role to the one they have, returns 200 with the member unchanged: no history row, no notification |
| Manager promotes staff | Only the promoted person is notified. Owners aren't; they see it in the company history feed |
| Actor never notified | Same rule as every existing event (`notifyUsers` drops the actor) |
| Member list visibility | Every member of the company can list its members, **including phone and contact email** so colleagues can reach each other (the user's decision). The phone is the verified sign-in phone; the email is `contactEmail`, where notifications go, not the login email |
| Existing data | There's no production deployment yet. The migration copies each corner's `manager_user_id` into that manager's `users.company_store_id`. A manager who ran several corners keeps **the most recently created one**. Owners and the admin get `company_store_id = NULL` |

## Approval (decided after the review)

Managers **keep** `users.approve`, limited to approving **into their own branch** and **as staff** only.

Why: managers can no longer move anyone, so approval is their only way to staff their branch. The limits mirror the promotion rule, under which managers act only inside their own branch. To get a newcomer as a manager, a manager approves them as staff, then promotes them. That's two history rows.

| Caller | Allowed role | Allowed `cornerId` |
|---|---|---|
| Admin, owner | MANAGER or STAFF | any live corner of the company, or `null` |
| Manager | STAFF only (else 403) | **their own branch** only (else 403). A manager with no branch can't approve anyone |

---

## How it works

### Data model (`prisma/schema.prisma`)

- **`users.company_store_id`** now means "this person's branch" for **both** managers and staff. Rename the relation `"CompanyStoreStaff"` → `"CompanyStoreMembers"` (and `CompanyStore.users` stays the back-relation). Owners and the admin always have `NULL`. The service enforces this; there's no database CHECK, because the role lives in another table.
- **Drop `company_stores.manager_user_id`**, plus the `"CompanyStoreManager"` relation and `User.managedStores`. The migration's hand-added data step (an `UPDATE users … FROM company_stores …`) runs **before** the generated `DROP COLUMN`. Edit the migration file only before it's handed over for the first time.
- **New append-only table `membership_changes`** (model `MembershipChange`). One row per change:

  | Column | Type | Notes |
  |---|---|---|
  | `id` | uuid PK | |
  | `company_id` | uuid FK → companies | tenant scope |
  | `user_id` | uuid FK → users | the person changed |
  | `reason` | enum `MembershipChangeReason` | `APPROVED`, `MOVED`, `ROLE_CHANGED`, `BRANCH_DELETED` (piece 3 adds its own values) |
  | `from_role_id` / `to_role_id` | int FK → roles, nullable | the role before and after, **always both recorded** (equal when unchanged; `from` is null only before approval) |
  | `from_company_store_id` / `to_company_store_id` | uuid FK → company_stores, nullable | the branch before and after, **always both recorded**; null means "no branch" |
  | `changed_by_user_id` | uuid FK → users, **nullable** | nullable now so piece 3's system-made changes fit |
  | `created_at` | timestamptz | |

  Each row is a **full snapshot** of role and branch, before and after, so a change touching both is still **one** row. Examples:
  - a promotion to owner: `MANAGER @ A → OWNER @ none`
  - a manager promoting staff: `STAFF @ A → MANAGER @ A`
  - an admin demoting an owner: `OWNER @ none → STAFF @ B`

  Branch history (from or to = the branch) therefore includes role changes made inside it. Indexes: `(user_id, created_at)`, `(company_id, created_at)`, `(from_company_store_id)`, `(to_company_store_id)`. No `deleted_at`, and the code never updates or deletes rows.

### Endpoints

| Method + path | Who | What |
|---|---|---|
| `GET /users` | any member (`users.read`) | The caller's company's members. The admin passes `?companyId=`. Filters: `?cornerId=` (`none` = unassigned), `?role=`, `?status=`. Each item: `id, name, profileImageUrl, phone, contactEmail, status, role { code, name }, branch { id, name } \| null, createdAt` |
| `PATCH /users/:id/approve` | admin, owner, manager (`users.approve`; see "Approval") | **Body gains a required `cornerId`: a uuid, or an explicit `null`** (no branch yet). Body `{ roleId, cornerId }`; `roleId` keeps its existing contract |
| `PUT /users/:id/branch` | admin, owner (`users.move`) | Body `{ cornerId: uuid \| null }`. `null` = off their branch |
| `PUT /users/:id/role` | admin, owner, manager (`users.changeRole`; row rules in the service) | Body `{ role: 'OWNER' \| 'MANAGER' \| 'STAFF', cornerId?: uuid \| null }`. `cornerId` must be **sent** (a uuid or `null`) when the admin demotes an owner, and is **refused (400)** otherwise; the branch is changed with `PUT …/branch` |
| `GET /users/:id/history` | per "Who reads history" (`users.read`) | The person's timeline, newest first |
| `GET /corners/:id/history` | admin, owner, that branch's managers (`corners.read`) | Rows where the branch is the `from` or the `to`, newest first |
| `GET /companies/:id/history` | admin (any company), owner (own company; another company → 404) (`companies.read`) | The whole company's feed, newest first |
| `DELETE /corners/:id` | unchanged (`corners.delete`) | Now also releases the branch's people (below) |

**Removed:** `PUT /corners/:id/manager`, `POST /corners/:id/staff`, `DELETE /corners/:id/staff/:userId`, `CreateCornerDto.managerUserId`, and the `corners.assign` permission, all replaced by `PUT /users/:id/branch`. This is a breaking change; the existing e2e helpers that assign managers and staff move to the new endpoint in the same task.

**Permissions (seed):** add `users.move` (ADMIN, OWNER) and `users.changeRole` (ADMIN, OWNER, MANAGER). ADMIN keeps "every permission" through `PERMISSIONS.map(...)`.

### The rules, as the service checks them

The role-change matrix, where the target is an ACTIVE member of the caller's company:

| Caller | Target's current role → requested | Allowed when | Branch effect |
|---|---|---|---|
| Admin, owner | MANAGER/STAFF → OWNER | always | cleared (→ null) |
| Admin, owner | STAFF → MANAGER | always | unchanged |
| Admin, owner | MANAGER → STAFF | always | unchanged |
| Manager | STAFF → MANAGER | target's branch = **caller's branch** | unchanged |
| Admin | OWNER → MANAGER/STAFF | company has **≥ 2** ACTIVE owners **and** `cornerId` sent (a live corner of that company, or `null`) | set to `cornerId` |
| anything else | | **403** | |

Moves (`PUT …/branch`): the caller is admin or owner, the target is an ACTIVE MANAGER or STAFF in the company, and `cornerId` is null or a **live** corner of the **same** company (404 otherwise).

### Races (project rule: conditional writes + count, never caught errors)

Every mutation runs in one `$transaction`: a guarded write plus the history insert. Notifications are emitted **after** commit, following the existing emit-after-commit pattern.

- **Role change / move:** read the target, decide, then `user.updateMany({ where: { id, companyId, roleId: <role read>, companyStoreId: <branch read>, status: ACTIVE, deletedAt: null }, data })`. If the count is 0, someone changed them in between → **409** "This member was just changed; reload".
- **Admin demoting an owner:** first take a **lock-by-write on the company row** (`company.updateMany({ where: { id }, data: { updatedAt: now } })`), then count the ACTIVE owners, then demote. Two admins demoting the last two owners at once serialize on that row, and the second sees one owner → 409. This is the same pattern as unlink's lock on the user row.
- **Moving into a branch vs deleting it:** both start by writing the corner row. The move does `companyStore.updateMany({ where: { id: cornerId, companyId, deletedAt: null }, data: { updatedAt } })`, where count 0 → 404. The delete is the guarded soft-delete itself. So a move can't land in a branch that was deleted a moment earlier.

### Branch deletion

`DELETE /corners/:id`, in one transaction:
1. Soft-delete the corner with a guarded `updateMany` (`deletedAt: null` in `where`; count 0 → 404).
2. Find its members, set their `company_store_id` to NULL, and write one `BRANCH_DELETED` row each (`to_company_store_id` null).

After commit, each released person is notified ("Branch A was closed; you're not assigned to a branch").

### Existing code that changes

- `CornersService.assertManages` / `assertWorksCorner`: the manager check becomes `caller.companyStoreId === cornerId`. `AuthUser.companyStoreId` is already loaded by `JwtAuthGuard` on every request, so changes apply on the person's next request. `resolveManager` and `assignManager` / `addStaff` / `removeStaff` go away.
- `NotificationsService.findCornerRecipientIds`: changes from "the corner's manager + owners" to "**every ACTIVE manager whose branch is this corner** + owners". So order/audit/stock alerts reach all of a branch's managers.
- `UsersService.approveMember`: requires `cornerId`, sets it with the role, and writes an `APPROVED` history row in the same transaction.
- New notification events, `member.roleChanged` and `member.moved`, with Korean templates. `EVENT_CHANNELS` is exhaustive, so both must be listed (email + push, like every event). Push `data`: `{ companyId, cornerId? }`.

### Built for later (so pieces 2 and 3 don't redo this)

- `changed_by_user_id` is nullable (system changes in piece 3).
- `MembershipChangeReason` is a Postgres enum that piece 3 extends (`ACCOUNT_DELETED`, `LEFT_COMPANY`, `COMPANY_CLOSED`, `AUTO_PROMOTED`).
- History hangs off `users` rows. Piece 2 keeps `users` as the per-company profile, so history stays correct when one sign-in owns several profiles.

## Testing

- **Unit (Claude writes):** the role matrix (every allowed and refused row), moves, no-op behavior, the 409 paths (count 0), the owner-count guard, branch deletion releasing members, the history rows written, and events emitted after commit only. Update the specs for the corners service and the notifications recipient lookup.
- **e2e (Claude writes, a human runs):** a story-style `test/members.e2e-spec.ts`:
  - approve with a branch
  - move, promote and demote across the matrix
  - a manager promotes in their branch, but not outside it, never moves anyone, and never touches owners
  - the admin's demotion of a company's last owner is refused
  - two concurrent admin demotions leave exactly one owner (`Promise.all`, sorted statuses)
  - branch deletion releases its people
  - history visibility
  - notification rows

  Existing suites that used `PUT /corners/:id/manager` or `POST /corners/:id/staff` switch to `PUT /users/:id/branch`.
- **A human runs** `prisma migrate dev` and `npm run test:e2e`.

## Left to the builder

- Module layout: a `MembersService` in `src/users/`, or a new `src/members/` module.
- Response shapes beyond the fields listed.
- Pagination for the list and history endpoints.
- Korean template wording.
- Whether the `corners.assign` permission row is deleted by a migration or left unused.
- Task order.

## As built (2026-11-11)

Built in 8 tasks from `docs/superpowers/plans/2026-11-06-roles-and-branches.md`. Where the build differs from the design above, or settles what was left to the builder:

- **Existing data.** The design's migration copied each corner's `manager_user_id` into that manager's `users.company_store_id`. `20261107182006_branch_managers` was applied as generated, before its data step was added, and isn't edited (its applied checksum must match). The data-only follow-up `20261107182640_branch_cleanup_drop_corners_assign` clears stale branch pointers, gives owners and the admin no branch, and deletes `corners.assign`. The manager copy was dropped: no database had manager links (dev checked: 0; the e2e database is rebuilt empty) and there's no production.
- **Member list visibility** (the user's decision): people waiting for approval are listed only for callers holding `users.approve`, by effective permissions, so per-user GRANT/DENY count. For anyone else they're filtered out, and `?status=PENDING_APPROVAL` returns `[]` rather than 403. There's no default role filter, so pending people, who have no role, stay visible to approvers.
- **No-op before authority.** `decideRoleChange` checks the `cornerId` rule, then the no-op, then authority, so a manager "changing" anyone to the role they already have gets 200 unchanged rather than 403 (no write, no event).
- **Branch deletion** releases people with `updateManyAndReturn`, which returns exactly the rows it changed, so someone moved out between a read and the update can't get a false `BRANCH_DELETED` row or notice. `DELETE /corners/:id` returns the deleted corner. The closed-branch notice names the company and the branch (`memberBranchClosed(companyName, cornerName)`).
- **History pagination** (left to the builder): `?limit=` 1–100 (default 50) and `?cursor=` the id of the last item received → `{ items, nextCursor }`, newest first, ties broken by `id` (Prisma's cursor is inclusive, hence `skip: 1`). Items: `{ id, reason, createdAt, member, changedBy | null, fromRole, toRole, fromBranch, toBranch }`, with only ids and names. A deleted branch's own history is 404 (it's looked up as a live branch); its rows stay in the company feed and in each person's history, names intact. The member list isn't paginated.
- **A person's history** uses a plain company-scoped lookup, so someone waiting for approval (no role yet) has a readable, empty history rather than a 404.
- **Module layout** (left to the builder): `src/members/` (service + controller on the `/users` prefix) and `src/membership-history/` (writer and reader, the history DTO and view; imports nothing). `CornersService.assertManages` was deleted with its only callers.
- **`OwnershipService.resolveCompanyForCreate`** was renamed `resolveTargetCompany`, since the member list uses it for reads.
- **Korean wording** (left to the builder): member notices say **지점** (the user's rewording); roles read 대표 / 매니저 / 직원.
- **`corners.assign`** was deleted by the data-only migration, not left unused.
