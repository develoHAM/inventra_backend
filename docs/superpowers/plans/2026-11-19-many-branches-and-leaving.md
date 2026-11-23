# Many Branches & Leaving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project workflow (overrides the above for this repo):** the repo is teaching-first. Per task:
> - Claude teaches the new concepts, confirms they're understood, then gives the requirements and (when asked) the full reference code.
> - **The user writes the production code** (or asks Claude to apply it). **Claude writes and runs the tests**, RED first.
> - A human runs every `prisma migrate` command and `npm run test:e2e` (`npm run test:e2e 2>&1 | tee e2e.log`, then says "done").
> - Auto-commit and push at green checkpoints. Verbose object literals (`{ id: id }`).

**Goal:** Managers and staff can work in several branches (or none), only owners and the admin make managers, and people can leave a company, be removed from one, or delete their account without leaving a company ownerless.

**Architecture:**
- **The role stays on the person** (`profiles.role_id`: OWNER, MANAGER or STAFF) and applies in every branch they work in.
- A new `profile_branches` table is a plain list of where each person works, with no role column. It replaces `profiles.company_store_id`.
- Leaving is one transactional procedure in `LeavingService.leaveInTransaction`, shared by `POST /profiles/me/leave`, `POST /profiles/:id/remove` and account deletion.
- Account deletion lives in a new `AccountDeletionModule`, which imports the modules it needs and is imported by nothing, so no cycle.

**Tech Stack:** NestJS 11 · Prisma 7 (pg adapter, `partialIndexes`) · PostgreSQL · `@nestjs/event-emitter` + the BullMQ notification queue · class-validator / class-transformer · Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-19-many-branches-and-leaving-design.md` (redesigned 2026-11-21). Read it with this plan: its tables ("Who may do what", history encoding, endpoints) are the requirements.

## Global Constraints

**Roles and branches**
- Who may do what = the spec's per-actor tables. Only owners and the admin make managers or owners.
- Owners never have assignments. Promotion to owner ends every assignment.
- **Nothing changes a role as a side effect** of a branch change: removing an assignment or deleting a branch never touches `profiles.role_id`.
- "Live" assignment = `deletedAt: null` **and** its branch `deletedAt: null`.

**History** (`membership_changes`, append-only, written in the same transaction as the change)
- New rows follow the spec's **History encoding** table exactly: one row per assignment affected; (role, branch) pairs on both sides.
- `changed_by` is null only for system picks (`AUTO_PROMOTED`). The actor (the leaver, or the remover) is `changed_by` on their own rows and on successors they named.

**Races** (project rule: conditional writes + count, never caught DB errors)
- Lock by writing, always in this order: **account → company → branches (by id) → profiles**.
- Inserts via `createManyAndReturn({ skipDuplicates: true })` (`[]` → 409); changes via guarded `updateMany` / `updateManyAndReturn` (count 0 → 409 `This member was just changed; reload`).
- Events are emitted after commit.

**Exact responses** (new or changed; the rest unchanged)
- 400 `cornerId is only for demoting an owner` (replaces `cornerId is only for the admin demoting an owner`)
- 403 `Managers can only step down themselves` (replaces `Managers can only promote staff of their own branch to manager` and `Managers cannot change an owner's role`)
- 400 `Owners work across the whole company` (approving an OWNER with a `cornerId`; adding an owner to a branch)
- 409 `Already in this branch` · 404 `Not in this branch`
- 403 `You can only work in your own branches` (replaces both old `assertWorksCorner` messages)
- 400 `This person cannot take over as owner` · 400 `No owner successor is needed`
- 400 `To leave, use POST /profiles/me/leave` · 400 `Only active members can be removed` · 403 `Owners cannot remove an owner` · 403 `Only owners and the admin can remove members` (added 2026-11-22: a personal GRANT of `profiles.remove` gets a manager past the guard, not past `remove()`, as with `approve()`)
- 403 `The platform admin has no company to leave` · 403 `The platform admin cannot delete its account`
- Removed: 400 `Choose a branch (or null) for the demoted owner` (a `cornerId` not sent now means no branch).
- Kept and reused: 409 `A company needs at least one owner`, 404 `Branch not found`, 403 `Managers can approve only as staff`, 403 `Managers can approve only into their own branch`, 403 `Owners cannot change an owner's role`, 403 `You cannot change member roles`, 400 `Invalid role for a member`, 400 `Invalid or expired verification token`.

**Copy** (Korean member copy says **지점**)
- `memberBranchAdded(company, corner)`: subject `[Inventra] 새 지점에 배정되었습니다`; body `${company}의 ${corner} 지점에 배정되었습니다.`
- `memberBranchRemoved(company, corner)`: subject `[Inventra] 지점 배정이 해제되었습니다`; body `${company}의 ${corner} 지점 배정이 해제되었습니다.`
- `memberBranchClosed(company, corner)`: subject unchanged; body `${company}의 ${corner} 지점이 삭제되어 해당 지점 배정이 해제되었습니다.`
- `memberLeft(company, memberName, reason)`: subject `[Inventra] 구성원이 회사를 떠났습니다`; body `${memberName}님이 ${company}을(를) 떠났습니다.`, or for `REMOVED` `${memberName}님이 ${company}의 구성원에서 제외되었습니다.`
- `memberRemoved(company)`: subject `[Inventra] 회사 구성원에서 제외되었습니다`; body `${company}의 구성원에서 제외되었습니다. 다시 함께하려면 초대 코드로 가입을 요청해 주세요.`

**Project rules**
- Never edit a migration once it may have been applied.
- A `--create-only` migration gets its hand-written data step before anything applies it.
- Don't run `prisma format`. Partial-index predicates via `raw()` exactly as Postgres normalizes them.
- Leave `.vscode/settings.json` uncommitted. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Decisions beyond the spec

- **Task 1 needs no schema change.** The new role rules run on today's single branch, so they ship first and on their own.
- **One migration for the whole piece**, `profile_branches` in Task 2: the table, every new enum value, `companies.deleted_by_profile_id`, the data copy, and dropping `profiles.company_store_id`.
- The spec's members suite is **`test/profiles.e2e-spec.ts`**.
- **Event shapes:**
  - `MemberMovedEvent` becomes `{ memberProfileId; changedByProfileId: string | null; cornerId: string; change: 'ADDED' | 'REMOVED' | 'BRANCH_DELETED' }`; the `memberMoved` template is removed.
  - `MemberLeftEvent { companyId; memberProfileId; memberName; cornerIds: string[]; reason: 'LEFT_COMPANY' | 'REMOVED' | 'ACCOUNT_DELETED'; changedByProfileId: string }`.
  - `MemberRemovedEvent { companyId; memberProfileId; removedByProfileId: string }`.
  - `MemberRoleChangedEvent` is unchanged.
- **`leaveInTransaction` takes `actorProfileId`**: the leaver for leaving and deletion, the remover for removal. It's `changed_by` and `deleted_by`.
- **The disconnect moves out of `LoginMethodsService`** into `ProviderDisconnectService`, which `SocialAuthModule` exports. `ProfilesModule` exports `LeavingService`.
- **e2e helpers:** `registerJoinedMember` takes `options.cornerId` (passed to approve); new `addToBranch(ownerAccess, profileId, cornerId)`.
- **No shared fixture or helper files** (the user's call, 2026-11-22: a new file only to remove repetition harms readability). Every spec keeps its own full `AuthProfile` literals, now with `branchIds`; Prisma `select` / `where` objects are written inline at each query.
- **Status codes:** `POST /profiles/me/leave` answers 200 with a `LeaveSummary`; `POST /profiles/:id/remove` answers 204.
- **Retired permissions** (the user's call, 2026-11-22): `profiles.create`, `profiles.update`, `profiles.delete` and `companies.update` were seeded but never checked by any route. `profiles.delete` isn't reused for removal: the profile permissions are named after their action and route (`profiles.approve` ↔ `:id/approve`), and a removal deletes nothing. The seed drops the four from its lists, and a retire step deletes them, with their role and personal grants first (`ON DELETE RESTRICT`), from databases seeded before. The upserts only ever add.
- **The last-owner check for removal lives in `leaveInTransaction`:** an ACTIVE owner, no other ACTIVE owner, and reason `REMOVED` → 409 `A company needs at least one owner`. It runs on the locked re-read and reuses the count the owner part already makes, so a removal never reaches the successor or closing branch.

## Review Focus

1. **One person, several branches:** a staff member in A and B works in both and is refused every route of C. A manager in A and B approves into A or B, never C, and reads only A's and B's branch history (Task 2).
2. **Two owners leaving at the same moment** (`Promise.all`): the company must never end with ACTIVE members and no ACTIVE owner. The second leave waits for the company lock, then needs a successor or closes the company (Task 3).
3. **A session still open on a profile that just left or was removed:** the old access token gets 401 and never acts as the deactivated profile. `POST /auth/refresh` falls back to another openable company, or to none (Tasks 3, 4).
4. **Every credential of a deleted account:** the old access and refresh tokens get 401; password login gets 401; its device tokens are gone, so no pushes; its phone and its email login can sign up again (Task 5).
5. **An ineligible owner successor** (a pending member, someone from another company, an owner, the leaver themselves) must get 400 and change nothing (Task 3).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/profiles/member-rules.ts` | `decideRoleChange` follows "Who may do what" (T1); `pickSuccessor` (T3) |
| `prisma/schema.prisma`; migration `profile_branches` (T2) | `ProfileBranch`; enum values; `companies.deleted_by_profile_id`; drop `profiles.company_store_id` |
| `src/auth/types/auth-profile.ts`, `src/auth/guards/jwt-auth.guard.ts` | `AuthProfile.branchIds` |
| `src/profiles/profiles.service.ts`, `profile-view.ts`, `profiles.controller.ts`, `dto/*` | approve, list, role, history; `ProfileView.branches`; the remove route (T4) |
| `src/profiles/profile-branches.{service,controller}.ts` (new), `dto/add-branch.dto.ts` | add and remove assignments |
| `src/profiles/leaving.service.ts` (new), `leaving.ts`, `dto/leave-company.dto.ts`, `my-profile.controller.ts`, `profiles.module.ts` | preview, leave, remove, `leaveInTransaction` |
| `src/corners/corners.service.ts` | `assertWorksCorner`, `listHistory`, `remove` on assignments |
| `src/notifications/{notification-events,event-channels,notification-templates,notifications.listener,notifications.service}.ts` | reshaped `member.moved`, new `member.left` and `member.removed`, branch managers from assignments |
| `prisma/seed.ts` | `profiles.remove` for OWNER (T4) |
| `src/social-auth/provider-disconnect.service.ts` (new), `login-methods/login-methods.service.ts`, `social-auth.module.ts` | disconnect reused by deletion |
| `src/account-deletion/*` (new), `src/app.module.ts` | `DELETE /me` |
| `test/helpers/accounts.ts`, `test/profiles.e2e-spec.ts` + every suite using `PUT /profiles/:id/branch`, `test/leaving.e2e-spec.ts` (new, `testPhones(18)`) | e2e |

---

### Task 1: Who may do what (on today's single branch)

**Files:**
- Modify: `src/profiles/member-rules.ts`, `src/profiles/profiles.service.ts` (`approve`, `changeRole`), `src/profiles/dto/change-role.dto.ts` (comment), `prisma/seed.ts` (comments on MANAGER's `profiles.approve` and `profiles.changeRole`)
- Test: `src/profiles/member-rules.spec.ts`, `src/profiles/profiles.service.spec.ts`, `test/profiles.e2e-spec.ts`

**Interfaces:**
- **Produces:**
  - **`decideRoleChange(input: { callerRole: string | null; isSelf: boolean; targetRole: MemberRoleCode; requestedRole: MemberRoleCode; cornerIdSent: boolean }): RoleChangeDecision`**. `callerBranchId` and `targetBranchId` are gone. `RoleChangeDecision` is unchanged. The rules, in order:
    1. `cornerIdSent` when the change isn't an owner demotion → 400 `cornerId is only for demoting an owner`;
    2. same role → `'noop'`;
    3. **admin:** an owner target → `{ branch: 'set', checkOwnerCount: true }`; to OWNER → `{ branch: 'clear', checkOwnerCount: false }`; otherwise `{ branch: 'keep', checkOwnerCount: false }`;
    4. **owner:** an owner target → `isSelf` ? `{ branch: 'set', checkOwnerCount: true }` : 403 `Owners cannot change an owner's role`; to OWNER → `clear`; otherwise `keep`;
    5. **manager:** `isSelf`, MANAGER → STAFF → `{ branch: 'keep', checkOwnerCount: false }`; anything else → 403 `Managers can only step down themselves`;
    6. anyone else → 403 `You cannot change member roles`.
  - **`approve`:** an admin or owner may approve as OWNER, MANAGER or STAFF. OWNER with a non-null `cornerId` → 400 `Owners work across the whole company`. Managers: unchanged (STAFF only, into their own branch).
  - **`changeRole`** passes `isSelf: target.id === caller.id`. With `branch: 'set'`, a `cornerId` not sent means no branch.

- [ ] **Step 1 (Claude):** Write the tests.
  - **`decideRoleChange`**, an `it.each` of `[callerRole, isSelf, targetRole, requestedRole, cornerIdSent, expected]`:
    - `['ADMIN', false, 'OWNER', 'MANAGER', true, { branch: 'set', checkOwnerCount: true }]`
    - `['ADMIN', false, 'STAFF', 'MANAGER', false, keep]` · `['ADMIN', false, 'MANAGER', 'OWNER', false, clear]`
    - `['OWNER', false, 'STAFF', 'MANAGER', false, keep]` · `['OWNER', false, 'MANAGER', 'STAFF', false, keep]` · `['OWNER', false, 'STAFF', 'OWNER', false, clear]`
    - `['OWNER', false, 'OWNER', 'STAFF', false, 403 Owners cannot change an owner's role]`
    - `['OWNER', true, 'OWNER', 'MANAGER', true, set + owner count]` · `['OWNER', true, 'OWNER', 'STAFF', false, set + owner count]`
    - `['MANAGER', true, 'MANAGER', 'STAFF', false, keep]`
    - `['MANAGER', false, 'STAFF', 'MANAGER', false, 403 Managers can only step down themselves]`, the same for `['MANAGER', false, 'MANAGER', 'STAFF', …]` and `['MANAGER', false, 'OWNER', 'STAFF', …]`
    - `['STAFF', true, 'STAFF', 'MANAGER', false, 403 You cannot change member roles]`
    - `['OWNER', false, 'STAFF', 'MANAGER', true, 400 cornerId is only for demoting an owner]`
    - `['ADMIN', false, 'STAFF', 'STAFF', false, 'noop']`
  - **`approve`:**
    - an owner approving as OWNER with `cornerId: null` → the guarded `updateMany` writes the OWNER role id and no branch; one `APPROVED` row to `(OWNER, null)`; `member.approved` after commit;
    - OWNER with a `cornerId` → 400 `Owners work across the whole company`, and no transaction runs;
    - a manager approving as OWNER → 403 `Managers can approve only as staff`;
    - the ADMIN role id → 400 `Invalid role for a member`.
  - **`changeRole`:**
    - an owner stepping down with another ACTIVE owner → the company lock, then the owner count, then the guarded update;
    - the last owner stepping down → 409 `A company needs at least one owner`;
    - a manager stepping down → MANAGER → STAFF, branch kept, one `ROLE_CHANGED` row;
    - a manager promoting staff → 403, nothing written.
  - **e2e** (`test/profiles.e2e-spec.ts`):
    - the tests where a manager promotes staff now expect 403 `Managers can only step down themselves`. The **owner** makes those promotions, so the branch-history test's `changedBy` is the owner;
    - an owner approves a newcomer as OWNER → 200, `role.code === 'OWNER'`, `branch: null`; with a `cornerId` → 400;
    - the manager steps down → 200, STAFF, still in Branch A;
    - an owner steps down to MANAGER in Branch A while another owner exists → 200; the last owner → 409.
- [ ] **Step 2:** Run `npx jest src/profiles`. Expected: FAIL (the new rules aren't in place).
- [ ] **Step 3 (user):** Code to the interfaces.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run the e2e. Expected: all green.
- [ ] **Step 6:** Commit: `feat(profiles): only owners make managers; stepping down; approving as owner`.

---

### Task 2: Many branches per person

**Files:**
- Modify: `prisma/schema.prisma`; migration `profile_branches`
- Create: `src/profiles/profile-branches.{service,controller}.ts`, `src/profiles/dto/add-branch.dto.ts`
- Modify: `src/auth/types/auth-profile.ts`, `src/auth/guards/jwt-auth.guard.ts`
- Modify: `src/profiles/{profiles.service,profile-view,profiles.controller,profiles.module}.ts`; delete `src/profiles/dto/change-branch.dto.ts`
- Modify: `src/corners/corners.service.ts`
- Modify: `src/notifications/{notification-events,notification-templates,notifications.listener,notifications.service}.ts`
- Test: the matching `*.spec.ts` (every spec's `AuthProfile` literals gain `branchIds`), `test/helpers/accounts.ts`, `test/profiles.e2e-spec.ts`, and every e2e suite using `PUT /profiles/:id/branch`: audits, inventory, notifications, orders, placements, reservations

**Interfaces:**
- **Consumes:** Task 1's `decideRoleChange`.
- **Produces:**
  - **Prisma `ProfileBranch`** (`profile_branches`):
    - columns: `id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid`; `profileId`; `companyStoreId`; `createdAt @default(now())`; `updatedAt @default(now()) @updatedAt`; `deletedAt?`; `deletedByProfileId?`. There's no role column;
    - relations: `profile` (`"ProfileBranches"`), `companyStore` (`"CompanyStoreAssignments"`), `deletedByProfile` (`"ProfileBranchDeletedBy"`);
    - back-relations: `Profile.branches`, `Profile.deletedProfileBranches`, `CompanyStore.assignments`;
    - `@@unique([profileId, companyStoreId], map: "UQ_profile_branches_profile_branch", where: raw("(deleted_at IS NULL)"))`; `@@index([companyStoreId], map: "IDX_profile_branches_branch")`.
  - **Removed:** `Profile.companyStoreId`, `Profile.companyStore` and its back-relation (`"CompanyStoreMembers"`).
  - **`Company`:** gains `deletedByProfileId String? @map("deleted_by_profile_id")` and `deletedByProfile Profile? @relation("CompanyDeletedBy")`; `Profile` gains `deletedCompanies Company[] @relation("CompanyDeletedBy")`.
  - **Enum values** (all of this piece's): `MembershipChangeReason` += `BRANCH_ADDED, BRANCH_REMOVED, LEFT_COMPANY, REMOVED, ACCOUNT_DELETED, COMPANY_CLOSED, AUTO_PROMOTED`; `PhoneVerificationPurpose` += `DELETE_ACCOUNT`.
  - **`AuthProfile`** = `{ id; accountId; companyId: string | null; roleId: number | null; roleCode: string | null; branchIds: string[]; status: ProfileStatus }`. `companyStoreId` is gone.
  - **Live assignments** are filtered with `{ deletedAt: null, companyStore: { deletedAt: null } }`, written inline at every query (the user's call, 2026-11-22: no shared select or where constants). `PROFILE_SELECT.branches` = that `where`, `select: { companyStore: { select: { id: true, name: true } } }`, `orderBy: { createdAt: 'asc' }`.
  - **`ProfileView`:** `branch` is replaced by `branches: { id: string; name: string }[]`.
  - **`ProfileBranchesService`:**
    - `add(caller: AuthProfile, profileId: string, dto: AddBranchDto): Promise<ProfileView>`;
    - `remove(caller: AuthProfile, profileId: string, cornerId: string): Promise<ProfileView>`;
    - `AddBranchDto { cornerId: string }` (`@IsUUID`).
  - **Routes:** `POST /profiles/:id/branches` (201, `profiles.move`), `DELETE /profiles/:id/branches/:cornerId` (200, `profiles.move`). `PUT /profiles/:id/branch` and `ProfilesService.changeBranch` are removed.
  - Events and templates as in "Decisions beyond the spec" and the Copy constraints.
  - **e2e helpers:** `registerJoinedMember(…, options: PersonOptions & { cornerId?: string })`; `addToBranch(ownerAccess: string, profileId: string, cornerId: string): Promise<void>` (both in `suiteAccounts`).

- [ ] **Step 1 (Claude):** Give every spec's `AuthProfile` literal a `branchIds` (`companyStoreId: X` → `branchIds: [X]`, otherwise `branchIds: []`).
- [ ] **Step 2 (Claude):** Write the unit tests.
  - **Guard:** builds `branchIds` from the live assignments (the select filters live assignments). A profile in A and B → `branchIds: [A, B]`.
  - **`assertWorksCorner`:** owner or admin, any corner of the company; MANAGER or STAFF with the corner in `branchIds` → passes; without it → 403 `You can only work in your own branches`.
  - **`approve`:**
    - with a `cornerId`: lock the corner, the guarded `updateMany` (no branch column now), `createManyAndReturn` the assignment, one `APPROVED` row from `(null, null)` to `(R, X)`;
    - with null: no assignment, row to `(R, null)`;
    - a manager approving into a branch not in their `branchIds`, or with null → 403 `Managers can approve only into their own branch`.
  - **`list`:** `cornerId=X` → `branches: { some: <live, in X> }`; `cornerId=none` → `branches: { none: <live> }`; a MANAGER with at least one branch sees pending members, one with none doesn't.
  - **`ProfileBranchesService.add`:**
    - target not ACTIVE → 400 `Only active members can be changed`; target OWNER → 400 `Owners work across the whole company`;
    - corner not live → 404 `Branch not found` (through `lockLiveCorner`);
    - `[]` from `createManyAndReturn` → 409 `Already in this branch`;
    - one `BRANCH_ADDED` row from `(R, null)` to `(R, X)`;
    - `member.moved { change: 'ADDED', cornerId }` after commit, and none when the transaction throws.
  - **`ProfileBranchesService.remove`:**
    - a guarded `updateManyAndReturn` (`profileId`, `companyStoreId`, `deletedAt: null`) setting `deletedAt` and `deletedByProfileId` = the caller; `[]` → 404 `Not in this branch`;
    - removing the last branch is allowed: the view has `branches: []` and the **same role**;
    - one `BRANCH_REMOVED` row from `(R, X)` to `(R, null)`; event `REMOVED`.
  - **`changeRole`**, on assignments:
    - `clear` (to OWNER): one `updateManyAndReturn` ends the live assignments; one row per ended assignment from `(R, X)` to `(OWNER, null)`, or one from `(R, null)` if there were none;
    - `keep` (staff ↔ manager): one row per live assignment from `(R1, X)` to `(R2, X)`, or one from `(R1, null)` to `(R2, null)`;
    - `set` (owner demoted) with a `cornerId`: `lockLiveCorner`, `createManyAndReturn` the assignment, row `(OWNER, null)` → `(R, X)`; without one: row → `(R, null)`;
    - the guarded profile update no longer names a branch column.
  - **History reads:**
    - `ProfilesService.listHistory`: a MANAGER who shares a branch with the person → allowed; one who shares none, or has no branch → 403;
    - `CornersService.listHistory`: a MANAGER with the corner in `branchIds` → allowed; STAFF there → 403; a manager of another branch → 403.
  - **`CornersService.remove`:** an `updateManyAndReturn` on `profileBranch` (`companyStoreId`, `deletedAt: null`) with `deletedAt` and `deletedByProfileId` = the caller; one `BRANCH_DELETED` row each from `(R, X)` to `(R, null)`, with the person's current role (one `findMany` for the roles); `member.moved { change: 'BRANCH_DELETED' }` each; **no profile row is written**.
  - **`findCornerRecipientIds`:** `where: { branches: { some: { companyStoreId: X, deletedAt: null } }, role: { code: 'MANAGER' }, status: ACTIVE, deletedAt: null }`, plus the owners.
  - **Listener and templates:** `ADDED` → `memberBranchAdded`, `REMOVED` → `memberBranchRemoved`, `BRANCH_DELETED` → `memberBranchClosed`, each with the corner's name read without a `deletedAt` filter.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL.
- [ ] **Step 4 (user):** Make the schema changes and the code to the interfaces.
- [ ] **Step 5 (human):** Run `npx prisma migrate dev --create-only --name profile_branches`.
- [ ] **Step 6 (Claude, before it's applied):** Edit the generated SQL, then show it to the user.
  - Prisma writes the drop of the `profiles.company_store_id` foreign key and column **before** `CREATE TABLE "profile_branches"`. Move those two statements to the **end** of the file.
  - Right after the `profile_branches` table and its indexes, insert the data step:
    ```sql
    INSERT INTO profile_branches (profile_id, company_store_id)
    SELECT p.id, p.company_store_id
    FROM profiles p
    JOIN company_stores cs ON cs.id = p.company_store_id
    WHERE p.deleted_at IS NULL AND cs.deleted_at IS NULL;
    ```
  - Check that the partial unique index reads `WHERE (deleted_at IS NULL)`.
- [ ] **Step 7 (Claude, read-only `psql`):** Record the expected count: the data step's `SELECT` wrapped in `SELECT count(*) FROM (…) AS expected`.
- [ ] **Step 8 (human):** Run `npx prisma migrate dev` to apply it.
- [ ] **Step 9 (Claude, read-only `psql`):** `SELECT count(*) FROM profile_branches` equals the count from Step 7.
- [ ] **Step 10:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 11 (Claude):** Update the e2e (Review Focus 1).
  - **Helpers:** add `addToBranch`; `registerJoinedMember` passes `options.cornerId` to approve.
  - Each suite listed in **Files** stops calling `PUT /profiles/:id/branch` and approves straight into its branch, or calls `addToBranch`.
  - **`test/profiles.e2e-spec.ts`:**
    - **Several branches:** staff added to A and B → `branches` lists both; they create an order in B (201); any route of C → 403 `You can only work in your own branches`.
    - **A manager in A and B:** approves a newcomer into B → 200, into C → 403; reads A's history → 200, C's → 403.
    - **Adding and removing:** adding again → 409; adding an owner → 400; removing A → 200 and then 404; removing their last branch → 200, the role unchanged, and they're listed by `?cornerId=none`.
    - **Promotion:** promoting someone in A and B to OWNER ends both assignments and writes two history rows.
    - **Branch deletion:** deleting A ends only A's assignments; someone whose only branch was A keeps their role, is listed by `?cornerId=none`, and gets the `memberBranchClosed` notification.
    - **The list:** `?cornerId=A&role=MANAGER` returns exactly the managers who work in A.
- [ ] **Step 12 (human):** Run `npm run test:e2e 2>&1 | tee e2e.log`. Expected: all green (Claude reads `e2e.log`).
- [ ] **Step 13:** Commit: `feat(profiles)!: many branches per person; PUT /profiles/:id/branch removed`.

---

### Task 3: Leaving a company

**Files:**
- Modify: `src/profiles/member-rules.ts` (`pickSuccessor`), `src/profiles/profiles.service.ts` (the list hides people who left)
- Create: `src/profiles/leaving.service.ts` (with its types: no separate file), `src/profiles/dto/leave-company.dto.ts`
- Modify: `src/profiles/{my-profile.controller,profiles.module}.ts`
- Modify: `src/notifications/{notification-events,event-channels,notification-templates,notifications.listener}.ts`
- Test: `member-rules.spec.ts`, `leaving.service.spec.ts`, `my-profile.controller.spec.ts`, `profiles.service.spec.ts`, `notifications.listener.spec.ts`, `event-channels.spec.ts`, `test/leaving.e2e-spec.ts` (new, `testPhones(18)`)

**Interfaces:**
- **Consumes:** the inline live-assignment filter, `MembershipHistoryService.record`, `MemberRoleChangedEvent`.
- **Produces:**
  - **`pickSuccessor(candidates: { profileId: string; createdAt: Date; roleCode: string }[]): string | null`.** Order: MANAGER first, then `createdAt` ascending, then `profileId` ascending.
  - **`LeaveCompanyDto { ownerSuccessorProfileId?: string }`** (`@IsOptional @IsUUID`).
  - **Exported from `leaving.service.ts`:**
    - `LeavePreview` (the spec's JSON: `{ companyWillClose: boolean; owner: { successorNeeded: boolean; candidates: { profileId: string; name: string; role: string }[]; defaultPick: string | null } | null }`);
    - `Successor { profileId: string; name: string; picked: 'CHOSEN' | 'AUTO' }`;
    - `LeaveSummary { companyClosed: boolean; newOwner: Successor | null }`;
    - `LeaveOutcome { summary: LeaveSummary; events: { name: NotificationEventName; payload: object }[] }`.
  - **`LeavingService`:**
    - `preview(caller: AuthProfile): Promise<LeavePreview>`;
    - `leave(caller: AuthProfile, dto: LeaveCompanyDto): Promise<LeaveSummary>`;
    - `leaveInTransaction(transaction: Prisma.TransactionClient, input: { profileId: string; companyId: string; actorProfileId: string; reason: 'LEFT_COMPANY' | 'REMOVED' | 'ACCOUNT_DELETED'; ownerSuccessorProfileId?: string }): Promise<LeaveOutcome>`. `companyId` comes from the caller (who already knows it), so the company lock is the very first statement; the re-read then checks the leaver is in that company. The statuses it accepts: `LEFT_COMPANY` ACTIVE or PENDING_APPROVAL; `REMOVED` ACTIVE or SUSPENDED; `ACCOUNT_DELETED` anything but DEACTIVATED.
  - **Routes** on `MyProfileController`: `GET /profiles/me/leave-preview`, `POST /profiles/me/leave` (`@HttpCode(200)`).
  - **Event:** `NotificationEvent.MEMBER_LEFT = 'member.left'` with `MemberLeftEvent`; channels `EMAIL_AND_PUSH`.
  - **The member list** leaves out `DEACTIVATED` profiles unless `query.status` is set.
  - `ProfilesModule` exports `LeavingService`.

- [ ] **Step 1 (Claude):** Write the tests.
  - **`pickSuccessor`:** a manager who joined later beats earlier staff; ties → the lower `profileId`; `[]` → null.
  - **`leaveInTransaction`**, following the spec's procedure step by step. The timeline asserts the company lock comes first, before any profile write.
    - **Staff or a manager:**
      - their assignments end (`deletedByProfileId` = the actor);
      - a guarded `updateMany` to DEACTIVATED (the reason's statuses), count 0 → 409 `This member was just changed; reload`;
      - one `LEFT_COMPANY` row per ended assignment from `(R, X)` to `(null, null)`, or one from `(R, null)`;
      - `member.left` with their `cornerIds`;
      - nobody is promoted, even if they were a branch's only manager.
    - **The last ACTIVE owner:**
      - a named ACTIVE non-owner becomes OWNER through a guarded update (their role and ACTIVE in the `where`, count 0 → 409). Their assignments end. `ROLE_CHANGED` rows from `(R, X)` to `(OWNER, null)` with `changed_by` = the actor, `picked: 'CHOSEN'`, and `member.roleChanged` for them;
      - none named → `pickSuccessor` (managers first): `AUTO_PROMOTED`, `changed_by` null, `picked: 'AUTO'`;
      - an ineligible person (pending, an owner, another company's, the leaver) → 400 `This person cannot take over as owner`, nothing written;
      - `ownerSuccessorProfileId` while another owner remains → 400 `No owner successor is needed`.
    - **Closure** (the last owner, no other ACTIVE member):
      - the company is soft-deleted with `deletedByProfileId` = the leaver, along with its live branches and their assignments;
      - every other live profile becomes DEACTIVATED;
      - `COMPANY_CLOSED` rows;
      - `summary.companyClosed === true`, and no `member.left`.
    - **A pending leaver:** only DEACTIVATED, with no rows and no events. A pending OWNER closes the waiting company.
  - **`leave`:**
    - the admin → 403 `The platform admin has no company to leave`;
    - runs `leaveInTransaction` with reason `LEFT_COMPANY` and `actorProfileId` = the caller, and emits the outcome's events after commit (never if the transaction throws).
  - **`preview`:** an owner with a co-owner (`successorNeeded: false`); the last owner, with candidates and `defaultPick`; a lone owner (`companyWillClose: true`); staff (`owner: null`).
  - **The list:** people who left are hidden by default; `?status=DEACTIVATED` shows them.
  - **Listener:** `member.left` goes to the owners plus the managers who work in each `cornerId`, excluding `changedByProfileId`, with the `memberLeft` copy.
  - **`test/leaving.e2e-spec.ts`** (Review Focus 2, 3, 5):
    - **Staff leaves:** their old access token → 401; refresh → the session falls back (none open); rejoining with the code → a new pending profile; the list hides the old profile; `?status=DEACTIVATED` shows it.
    - **An owner names a successor:** the successor is OWNER and has no branches.
    - **The last owner leaves without naming anyone:** the longest-serving manager becomes owner, and their history shows `AUTO_PROMOTED`.
    - **Ineligible successors** (pending, another company's, themselves) → 400, nothing changed.
    - **Two owners leave at once** (`Promise.all`): with a third ACTIVE member, that member becomes the owner; the company never has 0 ACTIVE owners.
    - **A lone owner leaves:** the company is closed, its invite code → 404, and registering its tax ID again → 409.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run the e2e. Expected: all green.
- [ ] **Step 6:** Commit: `feat(profiles): leave a company; the last owner names a successor or it closes`.

---

### Task 4: Removing a member

**Files:**
- Modify: `prisma/seed.ts` (`profiles.remove` for OWNER), `src/profiles/leaving.service.ts` (`remove`), `src/profiles/profiles.controller.ts` (the route)
- Modify: `src/notifications/{notification-events,event-channels,notification-templates,notifications.listener}.ts`
- Test: `leaving.service.spec.ts`, `profiles.controller.spec.ts`, `notifications.listener.spec.ts`, `event-channels.spec.ts`, `test/leaving.e2e-spec.ts`

**Interfaces:**
- **Consumes:** `LeavingService.leaveInTransaction`, `MemberLeftEvent`.
- **Produces:**
  - **`LeavingService.remove(caller: AuthProfile, profileId: string): Promise<void>`.**
  - **Route:** `POST /profiles/:id/remove` with `@RequirePermissions('profiles.remove')` and `@HttpCode(204)`.
  - **Event:** `NotificationEvent.MEMBER_REMOVED = 'member.removed'` with `MemberRemovedEvent`; channels `EMAIL_AND_PUSH`; template `memberRemoved(company)`.
  - **Seed:** permission `profiles.remove` ('Remove members from the company'), granted to OWNER. The admin gets it automatically (it holds every permission).
  - **Seed:** the retire step for `profiles.create`, `profiles.update`, `profiles.delete`, `companies.update` (see Decisions beyond the spec).
  - `LeavingService` gains `OwnershipService` (constructor: prisma, history, eventEmitter, ownership); the removal lookup is `scopeToCompany`-scoped, and the procedure runs in the target's company.

- [ ] **Step 1 (Claude):** Write the tests.
  - **`remove`:**
    - a caller who isn't an OWNER or the ADMIN (a personal GRANT) → 403 `Only owners and the admin can remove members`;
    - yourself → 400 `To leave, use POST /profiles/me/leave`;
    - another company's or unknown → 404 `Member not found`;
    - not ACTIVE or SUSPENDED → 400 `Only active members can be removed`;
    - an owner removing an owner → 403 `Owners cannot remove an owner`;
    - the admin removing an owner: after the company lock, fewer than two ACTIVE owners → 409 `A company needs at least one owner`;
    - otherwise `leaveInTransaction` with `{ reason: 'REMOVED', actorProfileId: caller.id }`; after commit, `member.removed` and `member.left` (reason `REMOVED`).
  - **Controller:** the route carries `profiles.remove` and 204.
  - **Listener:** `member.removed` notifies the removed profile even though it's DEACTIVATED, with the `memberRemoved` copy; `member.left` with `REMOVED` uses the removal sentence.
  - **Seed:** after `npm run seed` (Claude runs it), read-only `psql` shows OWNER holds `profiles.remove`.
  - **e2e** (Review Focus 3):
    - an owner removes staff → 204; their access token → 401; the list hides them; their notification row exists;
    - an owner removing a co-owner → 403; a manager → 403 (no permission); removing yourself → 400;
    - the admin removes one of two owners → 204; the admin removing the last owner → 409;
    - the removed person rejoins with the invite code → a new pending profile.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces, including the seed.
- [ ] **Step 4:** Run `npm run seed`, `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run the e2e. Expected: all green.
- [ ] **Step 6:** Commit: `feat(profiles): owners and the admin remove members`.

---

### Task 5: Deleting an account; docs

**Files:**
- Create: `src/social-auth/provider-disconnect.service.ts`; `src/account-deletion/{account-deletion.module,account-deletion.service,account-deletion.controller}.ts`, `dto/delete-account.dto.ts`
- Modify: `src/social-auth/{social-auth.module,login-methods/login-methods.service}.ts`, `src/app.module.ts`
- Test: `provider-disconnect.service.spec.ts`, `login-methods.service.spec.ts`, `account-deletion.service.spec.ts`, `account-deletion.controller.spec.ts`, `account-deletion.module.spec.ts`, `test/leaving.e2e-spec.ts`
- Docs: `docs/superpowers/STATUS.md`, `CLAUDE.md`, the spec's **As built**, this plan's ✅ marks

**Interfaces:**
- **Consumes:** `LeavingService.leaveInTransaction`, `PhoneVerificationService.consume`, `AccountsService.isPlatformAdmin`, `PhoneVerificationPurpose.DELETE_ACCOUNT` (Task 2).
- **Produces:**
  - **`ProviderDisconnectService.disconnectQuietly(login: { id: string; method: string; providerUserId: string | null; refreshToken: string | null }): Promise<void>`**: the body moves from `LoginMethodsService.disconnectFromProvider` (decrypt, call the verifier, log and never throw). `SocialAuthModule` exports it.
  - **`AccountDeletionService.deleteAccount(account: AuthAccount, dto: DeleteAccountDto): Promise<void>`**; `DeleteAccountDto { phoneVerificationToken: string }` (`@IsString @IsNotEmpty`).
  - **`AccountDeletionController`:** `@AccountRoute() @Controller('me')`, `@Delete() @HttpCode(204)`.
  - **`AccountDeletionModule`:** `imports: [PhoneVerificationModule, SocialAuthModule, ProfilesModule, AccountsModule]`; registered in `AppModule`.

- [ ] **Step 1 (Claude):** Write the tests.
  - **`disconnectQuietly`:**
    - a password login → no call;
    - a social login → `verifiers[provider].disconnect` with the decrypted refresh token;
    - a throwing provider → logged, resolves;
    - `unlink` still disconnects through it.
  - **`deleteAccount`:**
    - the admin → 403 `The platform admin cannot delete its account`;
    - inside one transaction, in this order:
      1. lock the account row;
      2. `consume({ token, phone: <the account's phone>, purpose: DELETE_ACCOUNT })` (a throw → nothing else runs);
      3. `leaveInTransaction` for each non-DEACTIVATED, non-deleted profile, ordered by `companyId`, with reason `ACCOUNT_DELETED`, `actorProfileId` = that profile, and no successor named;
      4. read the login methods, then `deleteMany` them;
      5. revoke the live refresh tokens;
      6. `deleteMany` the device tokens;
      7. set `deletedAt` and `lastProfileId: null` on the account;
    - **after commit:** every outcome's events, then `disconnectQuietly` once per login method. A disconnect failure doesn't reject.
  - **Controller and module:** the route carries `@AccountRoute()`; the module compiles with the stub `NotificationsModule` (as in `accounts.module.spec.ts`).
  - **e2e** (Review Focus 4):
    - a member of two companies proves their phone with `DELETE_ACCOUNT` and calls `DELETE /me` → 204;
    - afterwards their old access and refresh tokens → 401, password login → 401, `device_tokens` has none of theirs (Prisma), and both companies list them only with `?status=DEACTIVATED`;
    - the same phone signs up again → 201, and the same email login can be added again;
    - a proof for another purpose, or for another phone → 400, and nothing is deleted;
    - the admin → 403.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run the e2e. Expected: all green.
- [ ] **Step 6 (Claude):** Update the docs with the **measured** counts only:
  - STATUS.md: piece 3 complete, the migration, the endpoints, the counts, and the next step;
  - CLAUDE.md: the current state and the unit count;
  - the spec: status "built", plus an **As built** section listing the deviations;
  - this plan: ✅ marks.
- [ ] **Step 7:** Commit: `feat(accounts): delete an account behind a phone proof; disconnect providers; docs`.
- [ ] **Step 8:** Offer `/phase-blog` for the membership track's piece 3.
