# Many Branches & Leaving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Project workflow (overrides the above for this repo):** the repo is teaching-first. Per task:
> - Claude teaches the new concepts, confirms they're understood, then gives the requirements and (when asked) the full reference code.
> - **The user writes the production code** (or asks Claude to apply it). **Claude writes and runs the tests**, RED first.
> - A human runs every `prisma migrate` command and `npm run test:e2e` (`npm run test:e2e 2>&1 | tee e2e.log`, then says "done").
> - Auto-commit and push at green checkpoints. Verbose object literals (`{ id: id }`).

**Goal:** Managers and staff can belong to several branches with a role in each, and people can leave a company or delete their account without leaving a company ownerless or a branch silently manager-less.

**Architecture:**
- A new `profile_branches` table holds one live row per person per branch, with their role there.
- `profiles.role_id` keeps only OWNER and ADMIN. Everyone else's company-wide role is **worked out on every read** by one pure function, `companyRoleOf`, from their live assignments: in the guard, the views, the dropdown, the session responses and the leave preview.
- Leaving is one transactional procedure in `LeavingService`, shared by `POST /profiles/me/leave` and account deletion.
- Account deletion lives in a new `AccountDeletionModule`, which imports the modules it needs and is imported by nothing, so no cycle.

**Tech Stack:** NestJS 11 · Prisma 7 (pg adapter, `partialIndexes`) · PostgreSQL · `@nestjs/event-emitter` + the BullMQ notification queue · class-validator / class-transformer · Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-11-19-many-branches-and-leaving-design.md` (approved 2026-11-19). Read it with this plan: its tables (decisions, history encoding, endpoints) are the requirements.

## Global Constraints

**Roles**
- `profiles.role_id` ∈ {ADMIN, OWNER, null} after Task 2. Assignment roles ∈ {MANAGER, STAFF}.
- The company-wide role comes **only** from `companyRoleOf`. The member-list `role=` filter is the one other place a role is worked out, and an e2e table checks it against the function.
- "Live" assignment = `deletedAt: null` **and** its branch `deletedAt: null`.
- Owners never have assignments. Promotion to owner ends every assignment.

**History** (`membership_changes`, append-only, written in the same transaction as the change)
- New rows follow the spec's **History encoding** table exactly: one row per assignment changed or ended; (role, branch) pairs on both sides.
- `changed_by` null only for system picks (`AUTO_PROMOTED`). A leaver's own rows, and successors they named, carry the leaver's id.

**Races** (project rule: conditional writes + count, never caught DB errors)
- Lock by writing, always in this order: **account → company → branches (by id) → profiles**.
- Inserts via `createManyAndReturn({ skipDuplicates: true })` (`[]` → 409); changes via guarded `updateMany` (count 0 → 409 `This member was just changed; reload`).
- Events are emitted after commit.

**Exact responses** (new; existing ones unchanged)
- 400 `A manager needs a branch`
- 400 `Owners work across the whole company`
- 409 `Already in this branch` · 404 `Not in this branch`
- 403 `You can only work in your own branches`
- 400 `Change a role in a branch with PUT /profiles/:id/branches/:cornerId/role`
- 403 `Managers can only promote staff of their own branch, or step down themselves`
- 409 `A branch needs another manager before you step down`
- 400 `This person cannot take over as owner` · 400 `This person cannot take over this branch`
- 400 `No owner successor is needed` · 400 `No successor is needed for this branch`
- 403 `The platform admin has no company to leave` · 403 `The platform admin cannot delete its account`
- Kept and reused: 409 `A company needs at least one owner`, 404 `Branch not found`, 400 `Invalid or expired verification token`.

**Copy** (Korean member copy says **지점**)
- `memberBranchAdded(company, corner)`: subject `[Inventra] 새 지점에 배정되었습니다`; body `${company}의 ${corner} 지점에 배정되었습니다.`
- `memberBranchRemoved(company, corner)`: subject `[Inventra] 지점 배정이 해제되었습니다`; body `${company}의 ${corner} 지점 배정이 해제되었습니다.`
- `memberBranchClosed(company, corner)`: subject unchanged; body `${company}의 ${corner} 지점이 삭제되어 해당 지점 배정이 해제되었습니다.`
- `memberRoleChanged(company, role, corner | null)`: with a branch, body `${company}의 ${corner} 지점에서 회원님의 역할이 ${ROLE_LABELS_KO[role]}(으)로 변경되었습니다.`; without one, unchanged.
- `memberLeft(company, memberName)`: subject `[Inventra] 구성원이 회사를 떠났습니다`; body `${memberName}님이 ${company}을(를) 떠났습니다.`

**Project rules**
- Never edit a migration once it may have been applied.
- A `--create-only` migration gets its hand-written data step before anything applies it.
- Don't run `prisma format`. Partial-index predicates via `raw()` exactly as Postgres normalizes them.
- Leave `.vscode/settings.json` uncommitted. Commit trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Decisions beyond the spec

- **`companyRoleOf` counts the profile's role only when it is OWNER or ADMIN.** A leftover MANAGER or STAFF value on a profile is ignored, so Task 1 can ship before the contract migration nulls those values.
- **Two Part-A migrations:**
  - Task 1 `profile_branches` (expand): the table, the enum values, `companies.deleted_by_profile_id`. No data.
  - Task 2 `profile_branches_contract`: copy the assignments, null the MANAGER/STAFF role ids, drop `profiles.company_store_id`.
  - The copy runs at the switch, so nothing the old code writes between the two tasks is lost.
- The spec's `test/members.e2e-spec.ts` is **`test/profiles.e2e-spec.ts`** (renamed in piece 2).
- **Event shapes:**
  - `MemberMovedEvent` becomes `{ memberProfileId; changedByProfileId: string | null; cornerId: string; change: 'ADDED' | 'REMOVED' | 'BRANCH_DELETED' }`.
  - `MemberRoleChangedEvent` gains `cornerId: string | null` (null = a company-level change).
  - `memberMoved` is removed from the templates.
- **Views keep `role: { code, name }`.** The name comes from the `roles` table through `loadRoleNames(prisma)`: one query per response, four rows.
- **The disconnect moves out of `LoginMethodsService`** into `ProviderDisconnectService`, which `SocialAuthModule` exports. `ProfilesModule` exports `LeavingService`.
- **e2e helpers:**
  - `registerJoinedMember` takes `options.cornerId`. MANAGER without a branch now fails, by design.
  - New `addToBranch(ownerAccess, profileId, cornerId, role)`.
  - Suites that approved a MANAGER with no branch and then called `PUT /profiles/:id/branch` now approve as STAFF and call `addToBranch(…, 'MANAGER')`. A "manager of no branch" fixture becomes staff with no branch.
- **One unit-test fixture**, `src/testing/auth-profile.ts` → `anAuthProfile(overrides: Partial<AuthProfile> = {}): AuthProfile`, replaces the ~39 inline `AuthProfile` literals in the specs.
- **`POST /profiles/me/leave` answers 200** with a `LeaveSummary`.

## Review Focus

1. **One person, two roles:** someone who is MANAGER in A and STAFF in B must get manager permissions on company-wide routes but **be refused** manager-only actions in B (approving into B, promoting B's staff, reading B's history). They must be refused every route of branch C, where they have no assignment (Tasks 2–3).
2. **Two owners leaving at the same moment** (`Promise.all`): the company must never end with ACTIVE members and no ACTIVE owner. The second leave waits for the company lock and then needs a successor or closes the company (Task 4).
3. **A session still open on a profile that just left:** the old access token gets 401 and never acts as the deactivated profile. `POST /auth/refresh` falls back to another openable company, or to none (Task 4).
4. **Every credential of a deleted account:**
   - the old access and refresh tokens get 401;
   - password login gets 401;
   - its device tokens are gone, so no pushes;
   - its phone and its email login can sign up again (Task 5).
5. **An ineligible successor** must get 400 and change nothing:
   - a pending member;
   - someone from another company;
   - an owner;
   - the leaver themselves;
   - for branch X, someone who isn't X's staff (Task 4).

---

## File Structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma`; migrations `profile_branches` (T1), `profile_branches_contract` (T2) | `ProfileBranch`; enum values; `companies.deleted_by_profile_id`; drop `profiles.company_store_id` |
| `src/profiles/member-rules.ts` | `BranchRoleCode`, `companyRoleOf`, `branchRoleIn` (T1); `decideCompanyRoleChange` replaces `decideRoleChange` (T2); `decideBranchRoleChange` (T3); `pickSuccessor` (T4) |
| `src/profiles/live-branches.ts` (new) | `LIVE_BRANCHES` relation args shared by the guard, views and lookups; `branchRolesOf(rows)` |
| `src/profiles/role-names.ts` (new) | `loadRoleNames(prisma)` |
| `src/profiles/profile-list-filter.ts` (new) | `profileListWhere(query)`: the `cornerId` / `role` / `status` translation |
| `src/auth/types/auth-profile.ts`, `src/auth/guards/jwt-auth.guard.ts` | `AuthProfile { …, roleCode, branches }` |
| `src/authorization/permissions.service.ts` | permissions by role **code** |
| `src/profiles/profiles.service.ts`, `profile-view.ts`, `profiles.controller.ts`, `dto/*` | list, approve, company-level role, history; `ProfileView.branches` |
| `src/profiles/profile-branches.{service,controller}.ts` (new), `dto/{add-branch,change-branch-role}.dto.ts` | add, remove, change role in a branch |
| `src/profiles/leaving.service.ts` (new), `dto/leave-company.dto.ts`, `my-profile.controller.ts`, `profiles.module.ts` | preview, leave, `leaveInTransaction` |
| `src/corners/corners.service.ts` | `assertWorksCorner`, `listHistory`, `remove` on assignments |
| `src/accounts/{accounts.service,company-profile-view}.ts`, `src/auth/auth.service.ts` | the open profile's `roleCode`; the dropdown's computed role |
| `src/notifications/{notification-events,event-channels,notification-templates,notifications.listener,notifications.service}.ts` | reshaped moved/roleChanged events, `member.left`, branch managers from assignments |
| `src/social-auth/provider-disconnect.service.ts` (new), `login-methods/login-methods.service.ts`, `social-auth.module.ts` | disconnect reused by deletion |
| `src/account-deletion/*` (new), `src/app.module.ts` | `DELETE /me` |
| `src/testing/auth-profile.ts` (new) | `anAuthProfile()` for specs |
| `test/helpers/accounts.ts`, `test/profiles.e2e-spec.ts` + every suite using `PUT /profiles/:id/branch`, `test/leaving.e2e-spec.ts` (new, `testPhones(18)`) | e2e |

---

### Task 1: The assignment table and the role rules (expand)

**Files:**
- Modify: `prisma/schema.prisma`; migration `profile_branches`
- Modify: `src/profiles/member-rules.ts`
- Test: `src/profiles/member-rules.spec.ts`

**Interfaces:**
- **Produces:**
  - **Prisma `ProfileBranch`** (`profile_branches`):
    - columns: `id` uuid; `profileId`; `companyStoreId`; `roleId` Int; `createdAt`; `updatedAt`; `deletedAt?`; `deletedByProfileId?`;
    - relations: `profile` (`"ProfileBranches"`), `companyStore` (`"CompanyStoreAssignments"`), `role`, `deletedByProfile` (`"ProfileBranchDeletedBy"`);
    - back-relations: `Profile.branches`, `Profile.deletedProfileBranches`, `CompanyStore.assignments`, `Role.profileBranches`;
    - `@@unique([profileId, companyStoreId], map: "UQ_profile_branches_profile_branch", where: raw("(deleted_at IS NULL)"))`;
    - `@@index([companyStoreId], map: "IDX_profile_branches_branch")`.
  - **`Company`:** gains `deletedByProfileId String? @map("deleted_by_profile_id")` and `deletedByProfile Profile? @relation("CompanyDeletedBy")`; `Profile` gains `deletedCompanies Company[] @relation("CompanyDeletedBy")`.
  - **Enum values:** `MembershipChangeReason` += `BRANCH_ADDED, BRANCH_REMOVED, LEFT_COMPANY, ACCOUNT_DELETED, COMPANY_CLOSED, AUTO_PROMOTED`; `PhoneVerificationPurpose` += `DELETE_ACCOUNT`.
  - **In `member-rules.ts`:**
    - `export type BranchRoleCode = 'MANAGER' | 'STAFF'`;
    - `export type BranchRole = { cornerId: string; roleCode: BranchRoleCode }`;
    - `export function companyRoleOf(input: { profileRoleCode: string | null; status: ProfileStatus; branchRoleCodes: BranchRoleCode[] }): string | null`;
    - `export function branchRoleIn(branches: BranchRole[], cornerId: string): BranchRoleCode | null`.

- [ ] **Step 1 (Claude):** Write the tests in `member-rules.spec.ts`.
  - `it.each` for `companyRoleOf` as `[profileRoleCode, status, branchRoleCodes, expected]`:
    - `['ADMIN', ACTIVE, [], 'ADMIN']`
    - `['OWNER', ACTIVE, [], 'OWNER']`
    - `['OWNER', PENDING_APPROVAL, [], 'OWNER']`
    - `['OWNER', DEACTIVATED, [], null]`
    - `[null, ACTIVE, ['STAFF', 'MANAGER'], 'MANAGER']`
    - `[null, ACTIVE, ['STAFF'], 'STAFF']`
    - `[null, ACTIVE, [], 'STAFF']`
    - `[null, PENDING_APPROVAL, [], null]`
    - `[null, REJECTED, [], null]`
    - `[null, DEACTIVATED, ['MANAGER'], null]`
    - `[null, SUSPENDED, ['MANAGER'], 'MANAGER']`
    - `[null, SUSPENDED, [], null]`
    - `['MANAGER', ACTIVE, [], 'STAFF']` (a leftover value is ignored)
    - `['STAFF', ACTIVE, ['MANAGER'], 'MANAGER']`
  - `branchRoleIn([{ cornerId: 'A', roleCode: 'MANAGER' }, { cornerId: 'B', roleCode: 'STAFF' }], 'B')` → `'STAFF'`; for `'C'` → `null`.
- [ ] **Step 2:** Run `npx jest src/profiles/member-rules.spec.ts`. Expected: FAIL (`companyRoleOf` is not exported).
- [ ] **Step 3 (user):** Write the schema changes and the two functions. In `companyRoleOf`:
  1. DEACTIVATED or REJECTED → null.
  2. Then OWNER or ADMIN on the profile wins.
  3. Then MANAGER if any assignment is MANAGER, else STAFF if any assignment exists.
  4. Otherwise ACTIVE → STAFF, anything else → null.
- [ ] **Step 4 (human):** Run `npx prisma migrate dev --name profile_branches`. It's expand-only, with no data step. Check the generated SQL creates the partial unique index with `WHERE (deleted_at IS NULL)` and nothing else changes.
- [ ] **Step 5:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS. The old code is untouched: it still reads `company_store_id`.
- [ ] **Step 6:** Commit: `feat(profiles): branch-assignment table and the company-role rule (expand)`.

---

### Task 2: The switch: your branches decide your role

**Files:**
- Modify: `prisma/schema.prisma` (drop `Profile.companyStoreId`, `companyStore`, `CompanyStore.profiles`); migration `profile_branches_contract`
- Create: `src/profiles/{live-branches,role-names,profile-list-filter}.ts`, `src/profiles/profile-branches.{service,controller}.ts`, `src/profiles/dto/add-branch.dto.ts`, `src/testing/auth-profile.ts`
- Modify: `src/auth/types/auth-profile.ts`, `src/auth/guards/jwt-auth.guard.ts`, `src/auth/auth.service.ts`, `src/authorization/permissions.service.ts`
- Modify: `src/profiles/{member-rules,profiles.service,profile-view,profiles.controller,profiles.module}.ts`, `dto/change-role.dto.ts`; delete `dto/change-branch.dto.ts`
- Modify: `src/corners/corners.service.ts`, `src/accounts/{accounts.service,company-profile-view}.ts`
- Modify: `src/notifications/{notification-events,notification-templates,notifications.listener,notifications.service}.ts`
- Test: the matching `*.spec.ts` (every spec that builds an `AuthProfile` moves to `anAuthProfile()`), `test/helpers/accounts.ts`, `test/profiles.e2e-spec.ts`, and every e2e suite using `PUT /profiles/:id/branch`: audits, orders, placements, inventory, reservations, notifications, stores-corners

**Interfaces:**
- **Consumes:** Task 1's `ProfileBranch`, `companyRoleOf`, `branchRoleIn`, `BranchRole`, `BranchRoleCode`.
- **Produces:**
  - **`AuthProfile`** = `{ id; accountId; companyId: string | null; roleCode: string | null; branches: BranchRole[]; status: ProfileStatus }`. The `roleId` and `companyStoreId` fields are gone.
  - **`live-branches.ts`:**
    - `LIVE_BRANCHES`: relation args `{ where: { deletedAt: null, companyStore: { deletedAt: null } }, select: { companyStoreId: true, role: { select: { code: true, name: true } }, companyStore: { select: { id: true, name: true } } }, orderBy: { createdAt: 'asc' } }`;
    - `branchRolesOf(rows): BranchRole[]`.
  - `loadRoleNames(prisma: PrismaService): Promise<Map<string, string>>`.
  - **`profileListWhere(query: ListProfilesQueryDto): Prisma.ProfileWhereInput`**. The default excludes `DEACTIVATED` unless `query.status` is set. `role=` follows the spec's member-list bullets. With `cornerId=X`, OWNER matches nobody.
  - **`ProfileView`:** `role` is computed; `branch` is replaced by `branches: { id: string; name: string; role: { code: string; name: string } }[]`.
  - **`OpenProfileSummary`** = `{ id; status; companyId; roleCode: string | null }`. `AccountsService` maps rows into it, and `CompanyProfileView.role` is computed.
  - `PermissionsService.getEffectivePermissions(profile: AuthProfile)` reads `profile.roleCode`.
  - **`decideCompanyRoleChange(input: { callerRole: string | null; targetRole: string; requestedRole: MemberRoleCode; cornerIdSent: boolean; isSelf: boolean }): 'noop' | { kind: 'promoteToOwner' } | { kind: 'demoteOwner' }`:**
    - same role → `'noop'`;
    - a non-owner target asking for MANAGER or STAFF → 400 `Change a role in a branch with PUT /profiles/:id/branches/:cornerId/role`;
    - promote: admin or owner;
    - demote an owner: the admin only (Task 3 adds self).
  - **`ProfileBranchesService`:**
    - `add(caller: AuthProfile, profileId: string, dto: AddBranchDto): Promise<ProfileView>`;
    - `remove(caller: AuthProfile, profileId: string, cornerId: string): Promise<ProfileView>`;
    - `AddBranchDto { cornerId: uuid; role: 'MANAGER' | 'STAFF' }`.
  - **Routes:** `POST /profiles/:id/branches` (201, `profiles.move`), `DELETE /profiles/:id/branches/:cornerId` (200, `profiles.move`). `PUT /profiles/:id/branch` is removed.
  - Events: `MemberMovedEvent` and `MemberRoleChangedEvent` as in "Decisions beyond the spec".
  - `anAuthProfile(overrides)` defaults: an ACTIVE STAFF with no branches in company `'company-1'`.
  - **e2e helper:** `registerJoinedMember(…, options: PersonOptions & { cornerId?: string })`; `addToBranch(ownerAccess: string, profileId: string, cornerId: string, role: 'MANAGER' | 'STAFF'): Promise<void>`.

- [ ] **Step 1 (Claude):** Add `src/testing/auth-profile.ts` and move every spec's inline `AuthProfile` to it. Run `npx tsc --noEmit -p tsconfig.json`. Expected: errors only where the old fields are read, which is the RED to come.
- [ ] **Step 2 (Claude):** Write the unit tests.
  - **Guard:** builds `roleCode` with `companyRoleOf` and `branches` from the live assignments. A MANAGER-in-A, STAFF-in-B profile → `roleCode: 'MANAGER'`, two branches.
  - **`PermissionsService`:** looks the role up with `where: { code: profile.roleCode }`. A null `roleCode` → an empty set.
  - **`assertWorksCorner`:**
    - owner or admin: any corner of the company;
    - STAFF assigned to the corner: passes;
    - no assignment to the corner → 403 `You can only work in your own branches`.
  - **`approve`:**
    - MANAGER with `cornerId: null` → 400 `A manager needs a branch`;
    - with a branch: lock the corner, guarded `updateMany` to ACTIVE (`roleId` stays null), `createManyAndReturn` the assignment, and one `APPROVED` row from `(null, null)` to `(role, corner)`;
    - STAFF with null: no assignment, row to `(STAFF, null)`;
    - a manager approving into a branch where `branchRoleIn` is not MANAGER → 403.
  - **`ProfileBranchesService.add`:**
    - caller not admin or owner → 403;
    - target not ACTIVE → 400; target OWNER → 400 `Owners work across the whole company`;
    - corner not live → 404 `Branch not found`;
    - `[]` from `createManyAndReturn` → 409 `Already in this branch`;
    - one `BRANCH_ADDED` row from `(null, null)` to `(role, X)`;
    - `member.moved { change: 'ADDED', cornerId }` after commit.
  - **`ProfileBranchesService.remove`:**
    - guarded `updateMany` (`deletedAt: null`) with count 0 → 404 `Not in this branch`;
    - `BRANCH_REMOVED` row from `(R, X)` to `(null, null)`;
    - event `REMOVED`.
  - **`changeRole`** (company-level) through `decideCompanyRoleChange`:
    - **promote to OWNER:** the profile gets `roleId = OWNER`, every live assignment is ended in one `updateManyAndReturn`, and there is one row per ended assignment from `(R, X)` to `(OWNER, null)`, or one from `(STAFF, null)` if the person had no branch;
    - **demote an owner (admin):** company lock, then count active owners (< 2 → 409);
    - demoting to MANAGER needs `cornerId` (400 `A manager needs a branch`), and the assignment is created;
    - a non-owner target with MANAGER/STAFF → the 400 above.
  - **`CornersService.remove`:** `updateManyAndReturn` on the live assignments of the branch; one `BRANCH_DELETED` row each, from `(R, X)` to `(null, null)`; `member.moved { change: 'BRANCH_DELETED' }` each.
  - **`findCornerRecipientIds`:** filters `branches: { some: { companyStoreId, deletedAt: null, role: { code: 'MANAGER' } } }`.
  - **Listener and templates:** `ADDED` → `memberBranchAdded`, `REMOVED` → `memberBranchRemoved`, `BRANCH_DELETED` → `memberBranchClosed`, each with the corner's name, read without a `deletedAt` filter.
  - **`profileListWhere`:** the where shape for `role=STAFF` without a branch, `role=MANAGER&cornerId=X`, `role=OWNER&cornerId=X` (matches nothing), `cornerId=none`, the default `status` exclusion, and `status=DEACTIVATED`.
  - **`AccountsService`:** the open profile summary carries `roleCode` from `companyRoleOf`; a dropdown entry for a branch manager shows `role.code === 'MANAGER'`.
  - **Pending list:** a caller who is MANAGER in some branch sees pending members; a STAFF-only caller doesn't.
  - **History reads:**
    - `ProfilesService.listHistory`: a manager of a branch the person is in → allowed; a manager of a different branch → 403.
    - `CornersService.listHistory`: `branchRoleIn(caller.branches, corner.id) === 'MANAGER'` → allowed; STAFF there → 403.
- [ ] **Step 3:** Run `npm test`. Expected: FAIL.
- [ ] **Step 4 (user):** Make the schema changes and code to the interfaces.
- [ ] **Step 5 (human):** Run `npx prisma migrate dev --create-only --name profile_branches_contract`. Before applying it, put this data step **above** the generated `DROP` statements:
  ```sql
  INSERT INTO profile_branches (profile_id, company_store_id, role_id)
  SELECT p.id, p.company_store_id, p.role_id
  FROM profiles p
  JOIN roles r ON r.id = p.role_id
  JOIN company_stores cs ON cs.id = p.company_store_id
  WHERE p.deleted_at IS NULL AND cs.deleted_at IS NULL AND r.code IN ('MANAGER', 'STAFF');

  UPDATE profiles SET role_id = NULL
  WHERE role_id IN (SELECT id FROM roles WHERE code IN ('MANAGER', 'STAFF'));
  ```
- [ ] **Step 6 (Claude, read-only `psql`, before it's applied):** Record the expected count: the data step's `SELECT` wrapped in `SELECT count(*) FROM (…) AS expected`.
- [ ] **Step 7 (human):** Run `npx prisma migrate dev` to apply it.
- [ ] **Step 8 (Claude, read-only `psql`):** Migration check.
  - `SELECT count(*) FROM profile_branches` equals the count recorded in Step 6.
  - `SELECT count(*) FROM profiles p JOIN roles r ON r.id = p.role_id WHERE r.code IN ('MANAGER', 'STAFF')` = 0.
- [ ] **Step 9:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 10 (Claude):** Update the e2e (Review Focus 1).
  - **Helper:** add `addToBranch`, and pass `cornerId` through `registerJoinedMember`.
  - Each suite listed in **Files** stops calling `PUT /profiles/:id/branch`.
  - **`test/profiles.e2e-spec.ts`:**
    - **The multi-branch story:** someone added as MANAGER in A and STAFF in B gets `role.code === 'MANAGER'` and two `branches`. `POST /products` → 201. They can work in B's orders (201). Approving into B → 403. `GET /corners/B/history` → 403. Any route of corner C → 403.
    - **Adding and removing:** adding again → 409; adding an owner → 400; removing → 200 and then 404.
    - **Approval:** approving a MANAGER with no branch → 400.
    - **Promotion:** promoting to OWNER ends both assignments and writes two history rows.
    - **Branch deletion:** deleting A ends only A's assignment; B stays.
    - **The role-filter table:** fixtures are an owner, a manager-in-A + staff-in-B, staff in A, staff with no branch, a pending member, and a profile set to `DEACTIVATED` through Prisma. For each `role` in OWNER/MANAGER/STAFF, `GET /profiles?role=` returns exactly the fixtures whose expected role (written in the test, from the spec's rule) matches. For `cornerId=A&role=MANAGER` and `cornerId=A&role=STAFF`, the same with the role in A. `?status=DEACTIVATED` shows the deactivated profile, and the default list doesn't.
- [ ] **Step 11 (human):** Run `npm run test:e2e 2>&1 | tee e2e.log`. Expected: all green (Claude reads `e2e.log`).
- [ ] **Step 12:** Commit: `feat(profiles)!: a role per branch; company-wide role worked out from assignments`.

---

### Task 3: A role in each branch; stepping down

**Files:**
- Modify: `src/profiles/{member-rules,profile-branches.service,profile-branches.controller,profiles.service}.ts`
- Create: `src/profiles/dto/change-branch-role.dto.ts`
- Modify: `src/notifications/{notification-templates,notifications.listener}.ts`
- Test: `member-rules.spec.ts`, `profile-branches.service.spec.ts`, `profiles.service.spec.ts`, `notifications.listener.spec.ts`, `test/profiles.e2e-spec.ts`

**Interfaces:**
- **Consumes:** Task 2's `ProfileBranchesService`, `decideCompanyRoleChange`, `MemberRoleChangedEvent.cornerId`, `branchRoleIn`.
- **Produces:**
  - **`decideBranchRoleChange(input: { callerRole: string | null; callerBranchRole: BranchRoleCode | null; isSelf: boolean; targetBranchRole: BranchRoleCode; requestedRole: BranchRoleCode }): 'noop' | { checkManagerCount: boolean }`:**
    - admin or owner: promote STAFF → MANAGER **or demote MANAGER → STAFF** in any branch, `checkManagerCount: false`. Demoting a branch's last manager is allowed (piece 1: a branch may have no manager), and nobody is auto-promoted, because the owner chose this;
    - MANAGER of that branch: STAFF → MANAGER for another person, or themselves MANAGER → STAFF with `checkManagerCount: true`;
    - else 403 `Managers can only promote staff of their own branch, or step down themselves`, or 403 `You cannot change member roles` for other roles.
  - `decideCompanyRoleChange` now also allows `isSelf` owner → MANAGER/STAFF (the owner-count check applies).
  - **`ProfileBranchesService.changeRole(caller, profileId, cornerId, dto: ChangeBranchRoleDto): Promise<ProfileView>`**, `ChangeBranchRoleDto { role: 'MANAGER' | 'STAFF' }`.
  - **Route:** `PUT /profiles/:id/branches/:cornerId/role` (200, `profiles.changeRole`).

- [ ] **Step 1 (Claude):** Write the tests.
  - **`decideBranchRoleChange`**, every row of its rule list:
    - an owner demoting a manager to staff → `{ checkManagerCount: false }`, the same for the admin;
    - a manager demoting **another** manager → 403;
    - a manager acting in a branch they only staff → 403.
  - **`changeRole`:**
    - not in the branch → 404 `Not in this branch`;
    - target not ACTIVE → 400;
    - lock the corner, then for a self step-down count the **other** ACTIVE managers of the branch; 0 → 409 `A branch needs another manager before you step down`;
    - guarded `updateMany` on the assignment (`roleId` = the old one), count 0 → 409;
    - one `ROLE_CHANGED` row from `(R1, X)` to `(R2, X)`;
    - `member.roleChanged { cornerId: X }`.
  - **Owner self-demotion:**
    - allowed while another ACTIVE owner exists, behind the company lock;
    - the last owner → 409 `A company needs at least one owner`.
  - **Template:** `memberRoleChanged` with a corner name uses the branch sentence from Global Constraints.
  - **e2e:**
    - an owner promotes someone to MANAGER in A only; B is untouched;
    - an owner demotes A's manager to staff → 200, even A's only manager. A is left with no manager and nobody is promoted, and the person's `member.roleChanged` names A;
    - A's manager promotes A's staff → 200, but B's staff → 403;
    - A's second manager steps down → 200; the last one → 409;
    - an owner steps down while another owner exists → 200; the last owner → 409.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run the e2e. Expected: all green.
- [ ] **Step 6:** Commit: `feat(profiles): a role per branch can change; managers and owners can step down`.

---

### Task 4: Leaving a company

**Files:**
- Modify: `src/profiles/member-rules.ts` (`pickSuccessor`)
- Create: `src/profiles/leaving.service.ts`, `src/profiles/leaving.ts` (types), `src/profiles/dto/leave-company.dto.ts`
- Modify: `src/profiles/{my-profile.controller,profiles.module}.ts`
- Modify: `src/notifications/{notification-events,event-channels,notification-templates,notifications.listener}.ts`
- Test: `member-rules.spec.ts`, `leaving.service.spec.ts`, `dto/leave-company.dto.spec.ts`, `my-profile.controller.spec.ts`, `notifications.listener.spec.ts`, `event-channels.spec.ts`, `test/leaving.e2e-spec.ts` (new, `testPhones(18)`)

**Interfaces:**
- **Consumes:** `companyRoleOf`, `branchRoleIn`, `LIVE_BRANCHES`, `MembershipHistoryService.record`, `CornersService.lockLiveCorner`, `MemberRoleChangedEvent`.
- **Produces:**
  - **`pickSuccessor(candidates: { profileId: string; createdAt: Date; managesABranch: boolean }[], options: { preferManagers: boolean }): string | null`.** Order: `managesABranch` first when `preferManagers`, then `createdAt` ascending, then `profileId` ascending.
  - **`LeaveCompanyDto { ownerSuccessorProfileId?: uuid; branchSuccessors?: BranchSuccessorDto[] }`**, `BranchSuccessorDto { cornerId: uuid; profileId: uuid }` (`@IsArray @ValidateNested({ each: true }) @Type(() => BranchSuccessorDto)`; duplicate `cornerId`s → 400).
  - **In `leaving.ts`:**
    - `LeavePreview` (the spec's JSON);
    - `LeaveSummary { companyClosed: boolean; newOwner: Successor | null; newManagers: (Successor & { cornerId: string })[] }`;
    - `Successor { profileId: string; name: string; picked: 'CHOSEN' | 'AUTO' }`;
    - `LeaveOutcome { summary: LeaveSummary; events: { name: NotificationEventName; payload: object }[] }`.
  - **`LeavingService`:**
    - `preview(caller: AuthProfile): Promise<LeavePreview>`;
    - `leave(caller: AuthProfile, dto: LeaveCompanyDto): Promise<LeaveSummary>`;
    - `leaveInTransaction(transaction: Prisma.TransactionClient, input: { profileId: string; reason: 'LEFT_COMPANY' | 'ACCOUNT_DELETED'; ownerSuccessorProfileId?: string; branchSuccessors?: { cornerId: string; profileId: string }[] }): Promise<LeaveOutcome>`.
  - **Routes** on `MyProfileController`: `GET /profiles/me/leave-preview`, `POST /profiles/me/leave` (`@HttpCode(200)`).
  - **Event:** `NotificationEvent.MEMBER_LEFT = 'member.left'`; `MemberLeftEvent { companyId: string; memberProfileId: string; memberName: string; cornerIds: string[]; reason: 'LEFT_COMPANY' | 'ACCOUNT_DELETED' }`; channels `EMAIL_AND_PUSH`.
  - `ProfilesModule` exports `LeavingService`.

- [ ] **Step 1 (Claude):** Write the tests.
  - **`pickSuccessor`:**
    - a manager who joined later beats earlier staff with `preferManagers`, but not without it;
    - ties → the lower `profileId`;
    - `[]` → null.
  - **`leaveInTransaction`**, following the spec's procedure step by step. The timeline asserts the locks: company, then branches in id order, then the profile update.
    - **Staff:** assignments ended (`deletedByProfileId` = the leaver); guarded `updateMany` to DEACTIVATED (statuses ACTIVE, PENDING_APPROVAL; or also SUSPENDED and REJECTED for `ACCOUNT_DELETED`), count 0 → 409; one `LEFT_COMPANY` row per ended assignment, or one `(STAFF, null)` row if there was no branch; `member.left` with their `cornerIds`.
    - **A manager whose branch has another ACTIVE manager:** no successor.
    - **The last manager of X:**
      - a named staff member of X becomes MANAGER in X: `ROLE_CHANGED`, `changed_by` = the leaver, `picked: 'CHOSEN'`, and `member.roleChanged { cornerId: X, changedByProfileId: leaver }`;
      - none named → `pickSuccessor`: `AUTO_PROMOTED`, `changed_by` null;
      - no staff → nobody promoted.
    - **A manager of A and B:** each branch is decided on its own.
    - **Successor errors:**
      - a successor for a branch the leaver doesn't manage, or that has another manager → 400 `No successor is needed for this branch`;
      - someone who isn't ACTIVE staff of X (pending, another branch's staff, the leaver) → 400 `This person cannot take over this branch`.
    - **The last ACTIVE owner:**
      - a named ACTIVE non-owner becomes OWNER (assignments ended; rows as in the history table);
      - none named → `pickSuccessor` with `preferManagers: true`;
      - an ineligible person (pending, an owner, another company's, themselves) → 400 `This person cannot take over as owner`;
      - `ownerSuccessorProfileId` while another owner remains → 400 `No owner successor is needed`.
    - **Ordering:** the owner part runs before the branch part, so a promoted owner can't be picked for a branch.
    - **Closure** (the last owner, no other ACTIVE member):
      - the company is soft-deleted with `deletedByProfileId` = the leaver, along with its live branches and their assignments;
      - every other live profile becomes DEACTIVATED;
      - `COMPANY_CLOSED` rows;
      - `summary.companyClosed === true`, and no `member.left`.
    - **Pending leaver:** only DEACTIVATED, with no rows and no events. A pending OWNER closes the company.
  - **`leave`:**
    - the admin → 403 `The platform admin has no company to leave`;
    - runs `leaveInTransaction` with reason `LEFT_COMPANY` and emits the outcome's events after commit (never if the transaction throws).
  - **`preview`:** matches the spec's JSON for an owner with a co-owner (`successorNeeded: false`), the last owner (with candidates and `defaultPick`), the last manager of a branch with no staff (`defaultPick: null`), and a lone owner (`companyWillClose: true`).
  - **Listener:** `member.left` goes to the owners plus the managers of each `cornerId`, excluding the leaver, with the `memberLeft` copy.
  - **`test/leaving.e2e-spec.ts`** (Review Focus 2, 3, 5):
    - **Staff leaves:** their old access token → 401; refresh → the session falls back (none open); rejoining with the code → a new pending profile; the member list hides the old profile; `?status=DEACTIVATED` shows it.
    - **The last manager leaves without naming anyone:** the longest-serving staff member becomes manager, and the branch history shows `AUTO_PROMOTED`.
    - **An owner names a successor:** the successor is OWNER.
    - **Ineligible successors** (pending, other company, themselves) → 400, nothing changed.
    - **Two owners leave at once** (`Promise.all`): with a third ACTIVE member, that member becomes the owner; the company never has 0 ACTIVE owners.
    - **A lone owner leaves:** the company is closed, its invite code → 404, and registering its tax ID again → 409.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3 (user):** Code to the interfaces.
- [ ] **Step 4:** Run `npm test`, `npm run build`, `npm run lint`. Expected: PASS.
- [ ] **Step 5 (human):** Run the e2e. Expected: all green.
- [ ] **Step 6:** Commit: `feat(profiles): leave a company with successors; the last owner closes it`.

---

### Task 5: Deleting an account; docs

**Files:**
- Create: `src/social-auth/provider-disconnect.service.ts`; `src/account-deletion/{account-deletion.module,account-deletion.service,account-deletion.controller}.ts`, `dto/delete-account.dto.ts`
- Modify: `src/social-auth/{social-auth.module,login-methods/login-methods.service}.ts`, `src/app.module.ts`
- Test: `provider-disconnect.service.spec.ts`, `login-methods.service.spec.ts`, `account-deletion.service.spec.ts`, `account-deletion.controller.spec.ts`, `account-deletion.module.spec.ts`, `test/leaving.e2e-spec.ts`
- Docs: `docs/superpowers/STATUS.md`, `CLAUDE.md`, the spec's **As built**, this plan's ✅ marks

**Interfaces:**
- **Consumes:** `LeavingService.leaveInTransaction`, `PhoneVerificationService.consume`, `AccountsService.isPlatformAdmin`, `PhoneVerificationPurpose.DELETE_ACCOUNT` (Task 1).
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
      3. `leaveInTransaction` for each non-DEACTIVATED, non-deleted profile, ordered by `companyId`, with reason `ACCOUNT_DELETED` and no successors;
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
  - STATUS.md: piece 3 complete, the migrations, the endpoints, the counts, and the next step;
  - CLAUDE.md: the current state and the unit count;
  - the spec: status "built", plus an **As built** section listing the deviations;
  - this plan: ✅ marks.
- [ ] **Step 7:** Commit: `feat(accounts): delete an account behind a phone proof; disconnect providers; docs`.
- [ ] **Step 8:** Offer `/phase-blog` for the membership track's piece 3.
