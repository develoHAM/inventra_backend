# Roles & Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project workflow (overrides the above for this repo):** the repo is teaching-first. Per task:
> - Claude teaches the new concepts, then gives the requirements and the full reference code.
> - **The user writes the production code.** **Claude writes and runs the tests.**
> - Auto-commit and push at green checkpoints.
> - Verbose object literals (`{ id: id }`).
> - A human runs `prisma migrate` and `npm run test:e2e`.

**Goal:** Managers and staff each belong to one branch. Owners and the admin move people and change roles at once, with no acceptance step, and managers promote within their own branch. Every join, move and role change is kept in an append-only history and notified to the person. A member list feeds the owner's management screen.

**Architecture:**
- Two new modules:
  - `MembershipHistoryModule` writes and reads `membership_changes`. It depends only on Prisma, so anyone can import it.
  - `MembersModule` owns the member list, approval, moves and role changes. It imports `CornersModule`, for the corner lock, and `MembershipHistoryModule`.
- `CornersModule` stops importing `UsersModule`, which removes the edge that would have formed a cycle.
- Each managers' branch moves onto `users.company_store_id` (the column staff already use), and `company_stores.manager_user_id` is dropped.

**Tech Stack:**
- NestJS 11
- Prisma 7 (pg adapter)
- PostgreSQL
- `@nestjs/event-emitter`, plus the existing notification queue
- class-validator
- Jest and supertest

**Spec:** `docs/superpowers/specs/2026-11-06-roles-and-branches-design.md`

## Global Constraints

**Roles**
- Company roles are `OWNER | MANAGER | STAFF`. `ADMIN` is the platform admin and has `companyId = null`.
- Owners and the admin always have `company_store_id = NULL`.

**Who may act on whom**
- A valid **target of a move or role change** is a non-deleted user whose `companyId` isn't null, whose role is OWNER/MANAGER/STAFF, and who is in the caller's company scope (`OwnershipService.scopeToCompany`). Anything else → **404 `Member not found`**. Approval and history use the plain scoped lookup instead (`findFirst({ id, ...scope, deletedAt: null })`), because a pending member has no role yet.
- Role changes and moves require target `status === ACTIVE`, else **400 `Only active members can be changed`**.
- A branch that isn't a live corner of the target's company → **404 `Branch not found`**.

**Races**
- Detected only by conditional writes and their count (project rule).
- A guarded member write whose count is 0 → **409 `This member was just changed; reload`**.
- An admin demotion that would leave fewer than one ACTIVE owner → **409 `A company needs at least one owner`**.

**Request rules**
- A request that changes nothing returns **200** with the member unchanged. It writes no history row and emits no event.
- `cornerId` in `PUT /users/:id/role` must be **sent** (a uuid or `null`) when the admin demotes an owner, and is refused with **400** otherwise.
- `cornerId` in `PATCH /users/:id/approve` is required and may be `null`.

**History and events**
- History rows are append-only, **full snapshots**: `from`/`to` role **and** branch, always both recorded. A change that touches both is still one row.
- Events are emitted **after** the transaction commits. Notifications go to the person changed, **excluding the actor**, by email and push.

## Decisions beyond the spec

- **Module layout.** `src/membership-history/` (`MembershipHistoryService`, `MembershipChangeInput`) and `src/members/` (`MembersService`, `MembersController` at `@Controller('users')`, DTOs, `member-rules.ts`). `approveMember` moves from `UsersService` to `MembersService`; the route `PATCH /users/:id/approve` stays the same.
- **Rules are keyed by the caller's role, not only by permission.** Moves allow only ADMIN and OWNER callers, and role changes follow the matrix in `member-rules.ts`, so a user-level GRANT override can't let a manager move people or touch owners. The permissions (`users.move`, `users.changeRole`) remain the first gate.
- **One event for a combined change.** A role change that also changes the branch (promotion to owner, or the admin demoting an owner) emits only `member.roleChanged`.
- **Pagination of history:** `?limit` (1–100, default 50) and `?cursor` (a row id). Order is `[{ createdAt: 'desc' }, { id: 'desc' }]`, and the response is `{ items, nextCursor }`. Cursor by id, not by timestamp: all rows written in one transaction share `now()`, for example on a branch deletion, so a timestamp cursor would skip rows. The member list has no pagination.
- **Interim state (Tasks 2→3).** For one task, `PUT /users/:id/branch` and the old corner assignment endpoints coexist. Task 3 removes the old ones.
- **Korean role labels** for templates: `OWNER → 대표`, `MANAGER → 매니저`, `STAFF → 직원` (`ROLE_LABELS_KO` in `notification-templates.ts`).

## Review Focus

1. **The admin targeting the platform admin or a user with no company.** The admin's scope is `{}`. This must return 404 and never change a role. (Task 2 and Task 5 tests)
2. **A manager with no branch "promoting" staff who also have no branch.** `null === null` must not count as the same branch, so this is 403. (Task 5 test)
3. **A `cornerId` belonging to another company**, in a move, an approval or an owner demotion. The answer is 404 `Branch not found` and nothing is written. (Task 2 and Task 4 tests)
4. **A stale token after a move or demotion.** The person's next request is judged by the new branch and role, because the guard reads the database every time, so their old corner returns 403. (Task 3 e2e)
5. **Moving someone into a branch that was just deleted** returns 404, and the deleted branch never gets new members. (Task 6 test)

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` + 2 migrations | `MembershipChange` + enum (Task 1); drop `manager_user_id`, relation rename, data copy, `corners.assign` removal (Task 3) |
| `prisma/seed.ts` | `users.move`, `users.changeRole`; drop `corners.assign` |
| `src/membership-history/membership-history.{module,service}.ts`, `membership-change.ts` | write (`record`) and read (`page`) history rows |
| `src/members/members.{module,controller,service}.ts` | list, approve, move, role change, a person's history |
| `src/members/member-rules.ts` | pure `decideRoleChange` (the role matrix) |
| `src/members/dto/*.ts` | `ChangeBranchDto`, `ChangeRoleDto`, `ListMembersQueryDto`, `HistoryQueryDto`; `ApproveMemberDto` moves here |
| `src/corners/corners.{service,controller}.ts` | `lockLiveCorner`, branch-based `assert*`, deletion releases members, branch history; old assignment endpoints removed |
| `src/users/{users,companies}.{service,controller}.ts` | `approveMember` and `findActiveMember` removed; `GET /companies/:id/history` |
| `src/notifications/{notification-events,event-channels,notification-templates,notifications.listener,notifications.service}.ts` | `member.moved`, `member.roleChanged`; all of a branch's managers as corner recipients |
| `test/members.e2e-spec.ts` (new, `testPhones(16)`) | the story suite, grown task by task |
| existing e2e suites | approve with `cornerId`; `PUT /users/:id/branch` replaces corner assignment |

---

### Task 1: History table and writer

**Files:**
- Modify `prisma/schema.prisma` and `prisma/seed.ts`
- Create `src/membership-history/membership-change.ts`, `membership-history.service.ts`, `membership-history.module.ts`
- Test `src/membership-history/membership-history.service.spec.ts`

**Interfaces:**
- **Produces:**
  - `interface MembershipChangeInput { companyId: string; userId: string; reason: MembershipChangeReason; fromRoleId: number | null; toRoleId: number | null; fromCornerId: string | null; toCornerId: string | null; changedByUserId: string | null }`
  - `MembershipHistoryService.record(transaction: Prisma.TransactionClient, changes: MembershipChangeInput[]): Promise<void>`
  - `MembershipHistoryModule` (exports the service)

- [ ] **Step 1 (Claude):** Write the tests:
  - `record` calls `transaction.membershipChange.createMany({ data: [...] })` once, mapping `fromCornerId → fromCompanyStoreId` and `toCornerId → toCompanyStoreId`, with every other field copied as is.
  - `record(transaction, [])` makes no call.
- [ ] **Step 2:** Run `npx jest src/membership-history`. Expected: FAIL (module not found).
- [ ] **Step 3 (user):** Add to the schema:
```prisma
enum MembershipChangeReason {
  APPROVED
  MOVED
  ROLE_CHANGED
  BRANCH_DELETED

  @@map("membership_change_reason")
}

model MembershipChange {
  id                 String                 @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  companyId          String                 @map("company_id") @db.Uuid
  userId             String                 @map("user_id") @db.Uuid
  reason             MembershipChangeReason
  fromRoleId         Int?                   @map("from_role_id")
  toRoleId           Int?                   @map("to_role_id")
  fromCompanyStoreId String?                @map("from_company_store_id") @db.Uuid
  toCompanyStoreId   String?                @map("to_company_store_id") @db.Uuid
  changedByUserId    String?                @map("changed_by_user_id") @db.Uuid
  createdAt          DateTime               @default(now()) @map("created_at") @db.Timestamptz(6)

  company          Company       @relation(fields: [companyId], references: [id])
  user             User          @relation("MembershipChangeMember", fields: [userId], references: [id])
  changedByUser    User?         @relation("MembershipChangeActor", fields: [changedByUserId], references: [id])
  fromRole         Role?         @relation("MembershipChangeFromRole", fields: [fromRoleId], references: [id])
  toRole           Role?         @relation("MembershipChangeToRole", fields: [toRoleId], references: [id])
  fromCompanyStore CompanyStore? @relation("MembershipChangeFromBranch", fields: [fromCompanyStoreId], references: [id])
  toCompanyStore   CompanyStore? @relation("MembershipChangeToBranch", fields: [toCompanyStoreId], references: [id])

  @@index([userId, createdAt], map: "IDX_membership_changes_user_created")
  @@index([companyId, createdAt], map: "IDX_membership_changes_company_created")
  @@index([fromCompanyStoreId], map: "IDX_membership_changes_from_branch")
  @@index([toCompanyStoreId], map: "IDX_membership_changes_to_branch")
  @@map("membership_changes")
}
```
  Also:
  - Add the back-relation arrays on `User` (two of them), `Company`, `Role` (two) and `CompanyStore` (two).
  - Seed: add `{ code: 'users.move', name: 'Move members between branches' }` (OWNER) and `{ code: 'users.changeRole', name: 'Change member roles' }` (OWNER and MANAGER). ADMIN gets both through `PERMISSIONS.map`.
- [ ] **Step 4 (human):** Run `npx prisma migrate dev --name membership_changes`, then `npm run seed`.
- [ ] **Step 5 (user):** Write `MembershipHistoryService.record` and the module. `createMany` needs no `skipDuplicates`, because every row has a fresh id.
- [ ] **Step 6:** Run `npx jest src/membership-history`, then `npm test`. Expected: PASS, with 880 + the new tests green.
- [ ] **Step 7:** Commit: `feat(membership): membership_changes history table and writer`.

### Task 2: Move a member between branches

**Files:**
- Create `src/members/members.module.ts`, `members.service.ts`, `members.controller.ts`, `dto/change-branch.dto.ts`
- Modify:
  - `src/corners/corners.service.ts` (`lockLiveCorner`)
  - `src/notifications/notification-events.ts`, `event-channels.ts`, `notification-templates.ts`, `notifications.listener.ts`
  - `src/app.module.ts`
- Test: `src/members/members.service.spec.ts`, `src/corners/corners.service.spec.ts`, `src/notifications/notifications.listener.spec.ts`, and a new `test/members.e2e-spec.ts`

**Interfaces:**
- **Consumes:** `MembershipHistoryService.record` (Task 1).
- **Produces:**
  - `CornersService.lockLiveCorner(transaction: Prisma.TransactionClient, cornerId: string, companyId: string): Promise<boolean>`. It does a `companyStore.updateMany({ where: { id, companyId, deletedAt: null }, data: { updatedAt: new Date() } })` and returns `count === 1`. Writing to the corner row takes its lock, so a concurrent delete or move of that corner has to wait.
  - `MembersService.changeBranch(caller: AuthUser, userId: string, dto: ChangeBranchDto): Promise<MemberView>`
  - Private `MembersService.findTarget(caller: AuthUser, userId: string)`, which returns the user with `role` or throws 404 per Global Constraints.
  - `type MemberView = { id; name; profileImageUrl; phone; contactEmail; status; role: { code; name } | null; branch: { id; name } | null; createdAt }`, produced by a private `toMemberView`; the avatar is presigned like `UsersService.present`.
  - `ChangeBranchDto { cornerId: string | null }`, written as `@ValidateIf((dto) => dto.cornerId !== null) @IsUUID()`, so the field must be present and may be null.
  - Event `NotificationEvent.MEMBER_MOVED = 'member.moved'`, with `MemberMovedEvent { memberUserId: string; changedByUserId: string | null; fromCornerId: string | null; toCornerId: string | null; reason: 'MOVED' | 'BRANCH_DELETED' }`.
  - Templates `memberMoved(companyName: string, cornerName: string | null)` and `memberBranchClosed(cornerName: string)` (the second is used in Task 6).

- [ ] **Step 1 (Claude):** Write the unit tests.
  - `changeBranch`, with an owner caller and ACTIVE staff `staff-1` (roleId 4, `companyStoreId: 'corner-a'`):
    - "moves a member to a live branch": `lockLiveCorner(tx, 'corner-b', 'company-1')`; then `user.updateMany` with `where: { id: 'staff-1', companyId: 'company-1', roleId: 4, companyStoreId: 'corner-a', status: ACTIVE, deletedAt: null }` and `data: { companyStoreId: 'corner-b' }`; then `record` gets one row `{ reason: MOVED, fromRoleId: 4, toRoleId: 4, fromCornerId: 'corner-a', toCornerId: 'corner-b', changedByUserId: 'owner-1' }`; then `member.moved` is emitted **after** `$transaction` resolves.
    - "cornerId null takes them off their branch": `lockLiveCorner` is not called, and `toCornerId` is null.
    - "the same branch is a no-op": no `$transaction`, no emit, and it returns the view.
  - Refusals and races, with no writes and no emits in any of them:
    - 404 for a member of another company.
    - 404 when an admin targets a user whose `companyId` is null.
    - 400 for an OWNER target.
    - 400 for a target that isn't ACTIVE.
    - 403 for MANAGER and STAFF callers.
    - `lockLiveCorner` returning false → 404 `Branch not found`.
    - `updateMany` count 0 → 409, with no history row.
  - `lockLiveCorner`: checks the `where` and `data` above, and returns false when the count is 0.
  - The listener's `handleMemberMoved` (with reason MOVED): notifies `[memberUserId]` excluding `changedByUserId`, uses `memberMoved(company.name, toCorner?.name ?? null)`, and sends `data: { companyId, cornerId }` (without `cornerId` when it's null).
  - The e2e suite `test/members.e2e-spec.ts` (`testPhones(16)`). Setup:
    - one company, plus a second company to test tenant isolation
    - the admin creates a store; the owner opens branches A and B
    - a manager and two staff members are approved with `{ roleId }`, since Task 4 adds `cornerId`
    - the owner moves them into A

    Then cover:
    - the owner moves staff A → B → `null` (200); the history rows are checked through `prisma`
    - a manager calling `PUT /users/:id/branch` → 403
    - the other company's owner → 404
    - a `cornerId` belonging to the other company → 404
- [ ] **Step 2:** Run `npx jest src/members src/corners src/notifications`. Expected: FAIL.
- [ ] **Step 3 (user):** Write the following:
  - `lockLiveCorner`.
  - The `MembersModule`: imports `AuthorizationModule`, `CornersModule` and `MembershipHistoryModule`; registered in `AppModule`.
  - `PUT /users/:id/branch`: `@RequirePermissions('users.move')`, `ParseUUIDPipe`, returns 200.
  - `changeBranch`. The order is fixed by the tests: target → status/role checks → no-op → transaction (lock corner → guarded write → record) → emit.
  - The event, its channel entry (`EMAIL_AND_PUSH`), the templates, and the listener handler.
- [ ] **Step 4:** Run `npm test` and `npm run build`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(members): move members between branches with history and notification`.

### Task 3: Managers point at their branch

**Files:**
- Modify:
  - `prisma/schema.prisma` and `prisma/seed.ts`
  - `src/corners/corners.service.ts`, `corners.controller.ts`, `corners.module.ts`, `dto/create-corner.dto.ts`, `dto/update-corner.dto.ts`
  - `src/users/users.service.ts` (delete `findActiveMember`)
  - `src/notifications/notifications.service.ts`
- Delete `src/corners/dto/assign-user.dto.ts`
- Test:
  - the corners, users and notifications-service specs
  - `test/stores-corners`, `audits`, `inventory`, `orders`, `placements`, `reservations` and `notifications` e2e
- Migration: `branch_managers`.

**Interfaces:**
- **Consumes:** `PUT /users/:id/branch` (Task 2).
- **Produces:** `assertManages` / `assertWorksCorner` judge a manager by `caller.companyStoreId === cornerId`. `findCornerRecipientIds(cornerId)` returns every ACTIVE, non-deleted MANAGER whose `companyStoreId` is the corner, plus the owners.

- [ ] **Step 1 (Claude):** Write the tests:
  - **Unit:**
    - `assertManages` passes for a manager whose `companyStoreId` is the corner and returns 403 for another branch. `assertWorksCorner` behaves the same for managers, and staff are unchanged.
    - `create` neither takes nor sets `managerUserId`.
    - The `assignManager` / `addStaff` / `removeStaff` / `findActiveMember` tests are removed.
    - `findCornerRecipientIds` queries `user.findMany({ where: { companyStoreId: cornerId, role: { code: 'MANAGER' }, status: ACTIVE, deletedAt: null } })` and returns managers then owners; with no managers it returns only owners.
  - **e2e:**
    - Each suite's corner assignment becomes `PUT /users/:id/branch` by the owner.
    - In `stores-corners`, the appoint/add/remove tests become:
      - the owner puts the manager and staff in the corner
      - the corner's manager manages it, while a manager of another branch → 403
      - `POST /corners` with `managerUserId` → 400
      - `PUT /corners/:id/manager` → 404
    - Review Focus 4: a manager moved to B gets 403 on A's placements with the token they already had.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Schema changes:
  - Remove `CompanyStore.managerUserId` / `manager` and `User.managedStores`.
  - Rename the relation `"CompanyStoreStaff"` → `"CompanyStoreMembers"` on both sides.
- [ ] **Step 4 (human):** Run `npx prisma migrate dev --create-only --name branch_managers`. Before anyone applies it, **Claude** puts this data step at the **top** of the file, ahead of the generated `DROP COLUMN`:
```sql
-- Members pointing at a deleted corner have no branch.
UPDATE "users" SET "company_store_id" = NULL
WHERE "company_store_id" IN (SELECT "id" FROM "company_stores" WHERE "deleted_at" IS NOT NULL);
-- Owners and the admin have no branch.
UPDATE "users" u SET "company_store_id" = NULL
FROM "roles" r WHERE u."role_id" = r."id" AND r."code" IN ('OWNER', 'ADMIN');
-- A manager's branch = the most recently created live corner they managed.
UPDATE "users" u SET "company_store_id" = picked."id"
FROM (
  SELECT DISTINCT ON ("manager_user_id") "manager_user_id", "id"
  FROM "company_stores"
  WHERE "manager_user_id" IS NOT NULL AND "deleted_at" IS NULL
  ORDER BY "manager_user_id", "created_at" DESC
) picked
WHERE u."id" = picked."manager_user_id";
-- corners.assign is replaced by users.move.
DELETE FROM "role_permissions" WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" = 'corners.assign');
DELETE FROM "user_permissions" WHERE "permission_id" IN (SELECT "id" FROM "permissions" WHERE "code" = 'corners.assign');
DELETE FROM "permissions" WHERE "code" = 'corners.assign';
```
  Then the human runs `npx prisma migrate dev` and checks that `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` prints nothing.
- [ ] **Step 5 (user):** Code changes:
  - Remove `corners.assign` from the seed.
  - Remove `resolveManager`, `assignManager`, `addStaff`, `removeStaff`, the three routes, `AssignUserDto`, `managerUserId` in `CreateCornerDto` (and in the `OmitType` list of `UpdateCornerDto`), and `findActiveMember`.
  - Drop `UsersModule` from `CornersModule.imports` and `UsersService` from the `CornersService` constructor.
  - Switch the `assert*` checks and `findCornerRecipientIds` to the branch.
- [ ] **Step 6:** Run `npm test`, `npm run build` and `npm run lint`. Expected: PASS.
- [ ] **Step 7 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 8:** Commit: `refactor(corners)!: managers belong to one branch; drop corner manager link and assignment endpoints`.

### Task 4: Approval picks the branch

**Files:**
- Move `approveMember` and `ApproveMemberDto` to `src/members/` (`members.service.ts`, `members.controller.ts`, `dto/approve-member.dto.ts`)
- Remove the route from `users.controller.ts`
- Test:
  - `members.service.spec.ts`, which gains the approve tests from `users.service.spec.ts`
  - `dto/approve-member.dto.spec.ts`
  - every e2e suite that approves

**Interfaces:**
- **Consumes:** `lockLiveCorner` and `record` (Task 2). It keeps today's scoped lookup, not `findTarget`, because the member has no role yet.
- **Produces:** `MembersService.approve(caller: AuthUser, userId: string, dto: ApproveMemberDto)`; `ApproveMemberDto { roleId: number; cornerId: string | null }`.

- [ ] **Step 1 (Claude):** Write the tests.
  - Carry over the existing approve tests:
    - assigns the role and activates
    - emits `member.approved`
    - 404 across tenants
    - 400 when not pending
    - 400 for OWNER/ADMIN roles and for an unknown role
    - the admin isn't scoped
  - One guarded `user.updateMany` with `where: { id, status: PENDING_APPROVAL, deletedAt: null }` and `data: { roleId, status: ACTIVE, companyStoreId: dto.cornerId }`. Count 0 → 409.
  - `cornerId` null → no `lockLiveCorner`. `lockLiveCorner` false → 404 `Branch not found`.
  - The history row: `{ reason: APPROVED, fromRoleId: target.roleId, toRoleId: dto.roleId, fromCornerId: target.companyStoreId, toCornerId: dto.cornerId, changedByUserId: caller.id }`.
  - A manager caller (`companyStoreId: 'corner-a'`):
    - STAFF into `corner-a` → OK
    - MANAGER role → 403 `Managers can approve only as staff`
    - another branch, `null`, or a caller with no branch → 403 `Managers can approve only into their own branch`
  - The DTO spec: a missing `cornerId` fails, `null` passes, and a non-uuid fails.
  - **e2e:**
    - every `/approve` call sends `cornerId`: `null`, or the branch when it already exists
    - in `members`: a manager approves into their own branch as staff (200), and as a manager → 403
    - Review Focus 3: the owner approves into the other company's branch → 404, and the member stays PENDING_APPROVAL
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Move and rework `approve`. Order: target → pending/role checks → manager limits → transaction (lock corner if not null → guarded write → record) → emit `member.approved`.
- [ ] **Step 4:** Run `npm test`, then `npm run build`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(members): approval assigns role and branch`.

### Task 5: Change a member's role

**Files:**
- Create `src/members/member-rules.ts` and `dto/change-role.dto.ts`
- Modify `members.service.ts`, `members.controller.ts`, and the notifications files (as in Task 2)
- Test `member-rules.spec.ts`, `members.service.spec.ts`, the listener spec, and `test/members.e2e-spec.ts`

**Interfaces:**
- **Produces:**
  - `type MemberRoleCode = 'OWNER' | 'MANAGER' | 'STAFF'`
  - `decideRoleChange(input: { callerRole: string; callerBranchId: string | null; targetRole: MemberRoleCode; targetBranchId: string | null; requestedRole: MemberRoleCode; cornerIdSent: boolean }): 'noop' | { branch: 'keep' | 'clear' | 'set'; checkOwnerCount: boolean }`. It throws `BadRequestException` / `ForbiddenException`.
  - `MembersService.changeRole(caller, userId, dto: ChangeRoleDto): Promise<MemberView>`
  - `ChangeRoleDto { role: MemberRoleCode; cornerId?: string | null }`
  - Event `MEMBER_ROLE_CHANGED = 'member.roleChanged'`, with `MemberRoleChangedEvent { memberUserId: string; changedByUserId: string | null; toRoleCode: MemberRoleCode }`
  - Template `memberRoleChanged(companyName: string, roleCode: MemberRoleCode)`, which uses `ROLE_LABELS_KO`

- [ ] **Step 1 (Claude):** Write the tests.
  - `decideRoleChange`, table-driven over every row of the spec's matrix:
    - admin/owner: M/S → OWNER = `clear`; S → M and M → S = `keep`
    - manager: S → M in their own branch = `keep`; a different branch, or `callerBranchId` null (Review Focus 2) = 403
    - admin: OWNER → M/S with `cornerIdSent` = `set` + `checkOwnerCount`; without it = 400
    - an owner targeting an owner, themselves included = 403
    - a manager targeting an owner, or demoting a manager = 403
    - a staff caller = 403
    - `cornerIdSent` on anything but the admin's owner demotion = 400
    - the same role = `noop` (checked after the `cornerIdSent` rule)
  - `changeRole`:
    - The role is looked up by code.
    - Staff → owner: a guarded write with `data: { roleId: 2, companyStoreId: null }`, and the history row is `STAFF@corner-a → OWNER@null` with reason `ROLE_CHANGED`.
    - The admin demotes an owner:
      - `company.updateMany({ where: { id: 'company-1' }, data: { updatedAt } })` is called **before** `user.count({ where: { companyId, role: { code: 'OWNER' }, status: ACTIVE, deletedAt: null } })`
      - a count of 1 → 409 `A company needs at least one owner`, with no member write
      - a count of 2 → it proceeds, `lockLiveCorner` is called when `cornerId` is set and skipped when it's null
    - The guarded write's count 0 → 409.
    - A `noop` decision → no `$transaction`, no emit, and it returns the view.
    - `cornerIdSent` is `dto.cornerId !== undefined`.
    - `member.roleChanged` is emitted after commit, with `toRoleCode`.
    - Review Focus 1: the admin targeting the admin → 404.
  - The listener: notifies the member excluding the actor, using `memberRoleChanged`.
  - **e2e:**
    - owner promotes staff → manager, and a manager → owner (who leaves their branch)
    - a manager promotes staff in their own branch (200), and in another branch → 403
    - a manager can't touch an owner or demote a manager (403)
    - an owner demoting an owner, or themselves → 403
    - a demoted manager stays in their branch as staff
    - the admin demotes one of two owners into B (200), then the last one → 409
    - two admin demotions run concurrently on a company with two owners (`Promise.all`): the sorted statuses are `[200, 409]`, and exactly one ACTIVE owner remains
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Write the following:
  - `member-rules.ts`.
  - The DTO: `@IsIn(['OWNER', 'MANAGER', 'STAFF']) role`; and for `cornerId`, `@IsOptional() @IsUUID()`. `IsOptional` lets both `null` and a missing field through; the service tells them apart with `!== undefined`.
  - `PUT /users/:id/role` (`users.changeRole`, 200).
  - `changeRole`, with the transaction in this order: company lock + owner count (if `checkOwnerCount`) → corner lock (if `set` and non-null) → guarded write → record. Then emit.
  - The event, its channel entry, the template and the listener handler.
- [ ] **Step 4:** Run `npm test`, then `npm run build`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(members): promote and demote members with history and notification`.

### Task 6: Deleting a branch releases its people

**Files:**
- Modify `src/corners/corners.service.ts` (`remove`) and `corners.module.ts` (import `MembershipHistoryModule`)
- Modify the listener, for the `BRANCH_DELETED` reason
- Test: the corners spec, the listener spec, and `test/members.e2e-spec.ts`

**Interfaces:**
- **Consumes:** `record`, `MemberMovedEvent` with `reason: 'BRANCH_DELETED'`, and `memberBranchClosed`.
- **Produces:** `CornersService` constructor `(prisma, ownership, stores, membershipHistory, eventEmitter)`.

- [ ] **Step 1 (Claude):** Write the tests.
  - `remove`:
    - After `findOne` (scoped 404), it soft-deletes with `companyStore.updateMany({ where: { id, deletedAt: null }, data: { deletedAt, deletedByUserId } })`. A count of 0 → 404.
    - It reads the branch's people with `user.findMany({ where: { companyStoreId: id, deletedAt: null }, select: { id, roleId } })`.
    - It runs `user.updateMany({ where: { companyStoreId: id }, data: { companyStoreId: null } })`.
    - `record` gets one row per person: `{ reason: BRANCH_DELETED, fromRoleId = toRoleId, fromCornerId: id, toCornerId: null, changedByUserId: caller.id }`.
    - One `member.moved` (reason `BRANCH_DELETED`) per person, after commit.
    - An empty branch → no `record` and no emits.
  - The listener: the `BRANCH_DELETED` reason reads the soft-deleted corner's name (`findUnique` by id, no `deletedAt` filter) and uses `memberBranchClosed`.
  - **e2e:**
    - Deleting a branch that has a manager and a staff member: both end up with `companyStoreId` null, there are two `BRANCH_DELETED` rows, and a notification row is sent to each.
    - Review Focus 5: `PUT /users/:id/branch` into the deleted branch → 404.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Rework `remove` as one transaction, emitting after commit, and give the listener its `BRANCH_DELETED` branch.
- [ ] **Step 4:** Run `npm test`, then `npm run build`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(corners): deleting a branch releases its members`.

### Task 7: Member list

**Files:**
- Create `src/members/dto/list-members-query.dto.ts`
- Modify `members.service.ts` and `members.controller.ts`
- Test `members.service.spec.ts`, the DTO spec, and `test/members.e2e-spec.ts`

**Interfaces:**
- **Produces:**
  - `MembersService.list(caller: AuthUser, query: ListMembersQueryDto): Promise<MemberView[]>`
  - `ListMembersQueryDto { companyId?: string; cornerId?: string /* uuid | 'none' */; role?: MemberRoleCode; status?: UserStatus }`

- [ ] **Step 1 (Claude):** Write the tests.
  - The company comes from `ownership.resolveCompanyForCreate(caller, query.companyId)`: a caller who isn't the admin always gets their own company, and the admin without `companyId` → 400.
  - The `where` is `{ companyId, deletedAt: null, role: { code: { in: ['OWNER', 'MANAGER', 'STAFF'] } } }`. It adds `companyStoreId` (`'none'` → `null`), `role: { code }` and `status` when given.
  - Results are ordered by `createdAt: 'asc'`.
  - Each item has the `MemberView` fields, including `phone` and `contactEmail`.
  - The DTO: `cornerId: 'none'` passes, and `'abc'` fails.
  - **e2e:**
    - staff list their company with phone and email
    - the `cornerId`, `cornerId=none` and `role` filters work
    - the other company's people never appear
    - the admin without `companyId` → 400
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Write the following:
  - `GET /users` (`users.read`).
  - The `list` method.
  - The DTO, where `cornerId` uses `@IsOptional() @ValidateIf((dto) => dto.cornerId !== 'none') @IsUUID()`.
- [ ] **Step 4:** Run `npm test`, then `npm run build`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green.
- [ ] **Step 6:** Commit: `feat(members): company member list for the management screen`.

### Task 8: Reading the history, plus docs

**Files:**
- Modify:
  - `membership-history.service.ts` (`page`)
  - `members.{service,controller}.ts`
  - `corners.{service,controller}.ts`
  - `src/users/companies.{service,controller}.ts`
  - `src/users/users.module.ts` (import `MembershipHistoryModule`)
- Create `src/members/dto/history-query.dto.ts`
- Docs: `docs/superpowers/STATUS.md`, `CLAUDE.md`, and the spec's status
- Test: the history, members, corners and companies specs, plus `test/members.e2e-spec.ts`

**Interfaces:**
- **Produces:**
  - `HistoryQueryDto { limit?: number /* 1–100, default 50 */; cursor?: string /* uuid */ }`
  - `MembershipHistoryService.page(where: Prisma.MembershipChangeWhereInput, query: HistoryQueryDto): Promise<{ items: MembershipChangeView[]; nextCursor: string | null }>`
  - `type MembershipChangeView = { id; reason; createdAt; member: { id; name }; changedBy: { id; name } | null; fromRole: { code; name } | null; toRole: { code; name } | null; fromBranch: { id; name } | null; toBranch: { id; name } | null }`
  - `MembersService.history(caller, userId, query)`, `CornersService.history(caller, cornerId, query)`, and `CompaniesService.history(caller, companyId, query)`

- [ ] **Step 1 (Claude):** Write the tests.
  - `page`:
    - calls `findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit + 1 })`, plus `cursor: { id }, skip: 1` when a cursor is given
    - with `limit + 1` rows, it returns `limit` items and `nextCursor` = the id of the last returned item; otherwise `nextCursor` is null
  - Visibility (spec "Who reads history"):
    - **A person's history** (`MembersService.history`):
      - a target outside the caller's scope → 404
      - allowed for themselves, the admin, an owner, or a manager whose non-null branch is the target's branch; anyone else → 403
      - `where: { userId }`
    - **A branch's history** (`CornersService.history`):
      - `findOne` gives the scoped 404
      - staff → 403, and a manager of another branch → 403
      - `where: { OR: [{ fromCompanyStoreId: id }, { toCompanyStoreId: id }] }`
    - **A company's history** (`CompaniesService.history`):
      - the admin: any existing company (otherwise 404)
      - an owner: their own company (another company → 404)
      - a manager or staff member → 403, checked after the 404
      - `where: { companyId }`
  - **e2e:**
    - a manager promotes staff in branch A, and the row appears in A's history (snapshot `A → A`)
    - the company feed for the owner; 403 for the manager
    - staff read their own history but not a colleague's (403)
    - paging with `limit=1` returns a `nextCursor` and then the next row
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Write the following:
  - `page`, the three `history` methods, and the DTO (`@Type(() => Number) @IsInt() @Min(1) @Max(100)`).
  - The routes:
    - `GET /users/:id/history` (`users.read`)
    - `GET /corners/:id/history` (`corners.read`)
    - `GET /companies/:id/history` (`companies.read`)
- [ ] **Step 4:** Run `npm test`, `npm run build` and `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run `npm run test:e2e`. Expected: all green. Record the `Tests:` line as reported.
- [ ] **Step 6 (Claude):** Update the docs:
  - STATUS.md: a section for this track, the measured unit count, the e2e count only from a real `Tests:` line, and the migrations.
  - CLAUDE.md: the current state and the test count.
  - The spec: status set to built, plus any deviations.
- [ ] **Step 7:** Commit: `feat(members): membership history endpoints; docs`.
