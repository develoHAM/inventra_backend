# Many Branches & Leaving: Design

**Date:** 2026-11-19
**Status:** approved 2026-11-19, plan next
**Piece 3 of 3** of the membership track:
1. Roles & branches (built): promote and demote people, move them between branches, change history.
2. One sign-in, many companies (built): an account with one profile per company, Slack-style switching.
3. **Many branches & leaving** (this doc), in two parts built in this order:
   - **Part A, many branches:** a manager or staff member can belong to several branches, with a role in each.
   - **Part B, leaving:** leave a company, delete an account, close a company, and successors for owners and managers who leave.

Part A comes first because Part B's rules ("the last manager of a branch") are about branch assignments.

---

## Why

- **People work in more than one branch.** A part-timer works in branch A on Mondays and in branch B at weekends. A manager runs A and helps out as staff in B. Today a profile has exactly one branch and one role (`profiles.company_store_id`, `profiles.role_id`), so none of this can be recorded.
- **Nobody can leave.** There's no way to:
  - leave a company: the profile stays forever and keeps holding its "one profile per company" slot;
  - delete an account: the phone number and the social identities stay tied to it. Apple also requires in-app account deletion with token revocation;
  - close a company.
- **Leaving must not leave holes:** no company with people still working in it but no owner, and no branch that quietly loses its last manager.

## Goals

**Part A**
- A manager or staff member can belong to **any number of branches**, with a **role in each** (manager in A, staff in B).
- Owners and the admin add people to branches, remove them, and change their role in each branch.
- A person chooses which branch they're working in by opening it: the URL names the branch (`/corners/:cornerId/...`). There's no schedule.
- **Company-wide actions use the strongest role the person holds anywhere.** Branch rules use their role **in that branch**.
- That company-wide role is **worked out from the assignments every time it's needed**. Nothing derived from the assignments is stored.

**Part B**
- **Leaving a company** ends only that company's profile (it becomes `DEACTIVATED`). The account and its other companies are untouched, and the person can rejoin later with an invite code, as a new profile.
- **The last owner leaving** may name a new owner. If they don't, the system picks one. If there's nobody to pick, the company closes.
- **The last manager of a branch leaving** may name a successor from that branch's staff. If they don't, the system picks one. If there's nobody to pick, the branch is left without a manager.
- **Self-demotion** is allowed when someone else holds the same role in that scope.
- **Deleting an account** requires a fresh phone verification. It leaves every company under the same rules, frees the phone and the login identities, ends every session, and disconnects the social providers.
- Every change lands in the membership history, and **names stay on records**.

## Non-goals

- Work schedules or rosters, i.e. which days someone works in which branch.
- Scrubbing personal data at account deletion (see "Built for later").
- Per-branch permissions in the permission guard (see Approaches).
- Suspension and rejection flows; reviving a closed company (later, see "Built for later"); restoring a deleted account; deletion started by the admin; exporting data before deletion.
- The client screens.

## Anti-goals (a failure even if it "works")

- A company with **ACTIVE members but no ACTIVE owner**, including when two owners leave at the same moment.
- A branch losing its last manager while it still has active staff, without the leaver choosing a successor or the system picking one.
- **Someone's role worked out differently in two places**, for example the guard saying MANAGER while the member list says STAFF.
- A deleted account that can still sign in, refresh, or receive pushes through any session, login method or device.
- A provider disconnect failure that blocks a deletion or rolls it back.
- Leaving that erases names from records, or edits or deletes history rows.

---

## Decisions (the user's)

| Topic | Decision |
|---|---|
| What leaving ends | Only that company's profile. Leaving a company doesn't end the account |
| Last owner leaving | The app may ask them to name a new owner from the company's existing members. If they don't, the system names one (the picking rule can change later) |
| Last manager of a branch leaving | They may choose their successor **within the branch they manage**. If they don't, the system picks one |
| Scopes | Owners: the whole company. Managers: their branch |
| Self-demotion | Allowed if **someone else holds the same role in their scope**: an owner while another owner remains; a manager of branch X while another manager of X remains |
| Many branches | Owners can assign managers and staff to **several branches** |
| Choosing a branch | People choose which branch they work in at any given time (e.g. A on Mondays, B at weekends) |
| Where the role lives | **On each branch assignment.** Someone can be a manager in A and staff in B |
| Company-wide actions | Use the **strongest role anywhere**. Branch rules use that branch's role |
| How the company-wide role is known | **Worked out from the assignments every time** (option 2). The profile stores only company-level roles (OWNER, the platform ADMIN) |
| Proof for deleting an account | A fresh **phone verification** |
| Names on records after deletion | **Kept for now** |
| A closed company | **Closing is final.** Its tax ID and its product barcodes stay taken. A revival flow comes later |

## Decisions (my calls, stated so they can be rejected)

| Topic | Call |
|---|---|
| Who can be a successor | Only **ACTIVE** members. Pending, suspended, rejected and deactivated people can't be picked |
| The system's pick | One pure function, `pickSuccessor`, so the rule can be swapped later. It starts as **longest-serving** (the profile's `created_at`, as piece 2's spec promised; earliest first, `id` breaks ties). **Owner successor:** people who manage some branch come before staff. **Branch successor:** that branch's staff, earliest first |
| Acceptance | None. A successor takes the role immediately (piece 1's rule) |
| History of a successor | Named by the leaver: `ROLE_CHANGED`, `changed_by` = the leaver. Picked by the system: `AUTO_PROMOTED`, `changed_by` = null |
| No chain reaction | A new owner leaves all their branches (owners have no branches, piece 1's rule). If that leaves a branch without a manager, the system does **not** fill it; the new owner covers it |
| When a company closes | Only when **no other ACTIVE member** remains. Its other profiles (pending, suspended, rejected) are deactivated. Its branches are soft-deleted. The invite code stops working |
| Leaving while pending | This withdraws the join request, with no history row. A pending owner of a company still waiting for approval closes that company |
| Proof for leaving | None. Anyone who left can rejoin with an invite code |
| Successors when deleting an account | The **system picks everywhere**. Someone who wants to choose leaves those companies first, using the preview |
| Deletion proof details | New purpose `DELETE_ACCOUNT`. It must be the account's **own** phone, used once, and spent in the deletion's transaction. The platform admin has no phone, so it can't delete itself (403) |
| What deletion removes | Login-method rows are hard-deleted, as unlink already does, so the email and provider identities can sign up again. Every session is revoked, device tokens are deleted, and the account is soft-deleted, which frees the phone through the existing partial unique index |
| Provider disconnect | After the commit, best-effort and logged, reusing unlink's disconnect (Apple and Google use the stored encrypted refresh token) |
| Current branch | Not in the token. The URL names the branch. Remembering the last branch opened is the client's job |
| Assignment rows | Follow the soft-delete convention (`deleted_at`, `deleted_by_profile_id`) |
| Owners and branches | Owners can't be put in branches. Promotion to owner ends all of the person's assignments |
| Who adds people to branches and removes them | **Only owners and the admin.** (My earlier suggestion that managers could add staff to their branches is dropped: the user said owners assign.) Managers keep two powers: approving newcomers as staff into a branch they manage, and promoting staff to manager in a branch they manage |
| Approving as a manager | Needs a branch, because a manager manages a branch. Staff may still be approved with no branch |
| A member with no branch | Counts as **STAFF company-wide**, the same as staff with no branch today, and can't open any branch's routes |
| Existing managers with no branch (left behind by a branch deletion) | Become staff-level at the migration, because there's no branch for them to manage |
| Moving someone (`PUT /profiles/:id/branch`) | **Removed.** Adding and removing assignments replace it. There's no production deployment and no client yet |
| Notifications | `member.left` (new) goes to the owners and to the managers of the leaver's branches. A successor gets `member.roleChanged`. Being added to or removed from a branch reuses `member.moved`, and a role change in a branch reuses `member.roleChanged`. A closure notifies nobody, since nobody is left. Korean member copy says **지점** |
| Sessions after leaving | Nothing to write. The guard already refuses a `DEACTIVATED` profile (401), and `POST /auth/refresh` already falls back to another company or to none (built in piece 2). After leaving, the client refreshes |
| `companies.deleted_by_profile_id` | Added, as the soft-delete convention requires |
| Member list: branch plus role | With `cornerId=X`, `role=` means the role **in X** (who are X's managers or staff). Without a branch it means the company-wide role *(raised by the review)* |
| Member list: people who left | Hidden unless `?status=DEACTIVATED`. `companyRoleOf` gives them no role, not even a former owner; a pending owner keeps OWNER *(raised by the review)* |

---

## Approaches (decided)

All three options share the same new table: one row per person per branch, holding their role there. They differ in where the **company-wide role** (strongest anywhere) comes from.

1. **Store it on the profile and keep it in sync.** `profiles.role_id` holds OWNER, or the strongest of the person's branch roles. One helper recalculates it inside every transaction that changes an assignment. Existing code that reads the role keeps working. The cost is that the same fact is stored twice, so a write path that forgets the helper leaves a stale role.
2. **Work it out every time it's needed. (Picked by the user.)** The profile stores only company-level roles. The guard, the member views and the filters all work the role out from the live assignments. Nothing can go stale. The cost is that every reader of the role is rewritten, and the guard reads assignments on every request (Prisma's second, batched query).
3. *Dropped:* **per-branch permissions in the guard**, i.e. reading `:cornerId` from the URL and checking that branch's role. Managers and staff have identical permissions for branch work (placements, stock movements, orders, audits, reservations). They differ only in managing people and the catalog, which the services already check per branch. It would also tie the guard to URL parameter names.

Also ruled out: a profile per branch (the "one profile per company" rule is piece 2's foundation), and keeping a single role on the profile with only the branches in a list (the user chose a role per assignment).

---

## How it works: Part A (many branches)

### Data model (`prisma/schema.prisma`)

**New: `profile_branches`** (model `ProfileBranch`), one live row per person per branch.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | |
| `profile_id` | uuid FK → profiles | |
| `company_store_id` | uuid FK → company_stores | the branch |
| `role_id` | int FK → roles | MANAGER or STAFF only (checked by the services) |
| `created_at`, `updated_at` | timestamptz | `created_at` = when they joined this branch |
| `deleted_at` | timestamptz, nullable | the assignment ended |
| `deleted_by_profile_id` | uuid FK → profiles, nullable, named relation | who ended it (the leaver for a departure; null = the system) |

- **One live assignment per person per branch:** partial unique `UQ_profile_branches_profile_branch` on `(profile_id, company_store_id) WHERE deleted_at IS NULL`. Write the predicate with `raw()` exactly as Postgres normalizes it (STATUS.md gotcha).
- Index on `company_store_id` ("who is in this branch").

**Changed**
- `profiles.role_id`: now holds only **ADMIN** (the platform admin's profile) or **OWNER**, and null for everyone else.
- `profiles.company_store_id`: **dropped**, along with the `CompanyStoreMembers` relation.
- `companies`: gains `deleted_by_profile_id`. `UQ_companies_tax_id` stays a full unique index: closing is final.
- `MembershipChangeReason` gains `BRANCH_ADDED`, `BRANCH_REMOVED`, `LEFT_COMPANY`, `ACCOUNT_DELETED`, `COMPANY_CLOSED`, `AUTO_PROMOTED`. `MOVED` stays for old rows but is no longer written.
- `PhoneVerificationPurpose` gains `DELETE_ACCOUNT`.

**Existing data.** There's no production deployment, so one migration can do all of it, provided its hand-written data step is in place before anything applies it:
1. Create the table.
2. Copy every non-deleted profile with role MANAGER or STAFF and a live `company_store_id` into one row (same role).
3. Set `role_id = NULL` for MANAGER and STAFF profiles.
4. Drop the column.

Step 3 must ship together with the new code: the computed role prefers the profile's `role_id`, so a stale MANAGER left there would win.

### Working out the role: one pure function

Every place that needs someone's company-wide role calls the same function in `src/profiles/member-rules.ts`: the guard, the member views and the company dropdown, the session responses, and the leave preview.

```ts
export function companyRoleOf(input: {
  profileRoleCode: string | null;              // 'ADMIN' | 'OWNER' | null
  status: ProfileStatus;
  branchRoleCodes: ('MANAGER' | 'STAFF')[];    // live assignments only
}): string | null {
  // someone who left (or was turned down) holds no role, even a former owner
  if (input.status === ProfileStatus.DEACTIVATED || input.status === ProfileStatus.REJECTED) return null;
  if (input.profileRoleCode !== null) return input.profileRoleCode; // a pending owner stays OWNER (the dropdown shows it)
  if (input.branchRoleCodes.includes('MANAGER')) return 'MANAGER';
  if (input.branchRoleCodes.length > 0) return 'STAFF';
  return input.status === ProfileStatus.ACTIVE ? 'STAFF' : null; // a member with no branch is staff; pending/left: no role
}
```

**`AuthProfile`** (what `request.profile` holds) changes:

```ts
type AuthProfile = {
  id: string;
  accountId: string;
  companyId: string | null;
  roleCode: string | null;                                         // companyRoleOf(...)
  branches: { cornerId: string; roleCode: 'MANAGER' | 'STAFF' }[]; // live assignments in live branches
  status: ProfileStatus;
};
```

- `roleId` and `companyStoreId` are removed.
- The guard's single `findUnique` gains a relation select of the live assignments (`where: { deletedAt: null }`).
- `PermissionsService` looks the role up **by code** (`roles.code` is unique).
- A helper `branchRoleIn(profile, cornerId)` returns `'MANAGER' | 'STAFF' | null`.

### Endpoints

| Endpoint | Permission | Who | Notes |
|---|---|---|---|
| `PATCH /profiles/:id/approve { roleId, cornerId \| null }` | `profiles.approve` | as today | `MANAGER` needs a `cornerId` (400 otherwise). Writes the first assignment. `STAFF` with `null` writes none |
| `POST /profiles/:id/branches { cornerId, role }` | `profiles.move` | admin, owner | Target: an ACTIVE non-owner member of the company. Branch: live, in the company. Already in that branch → 409 |
| `PUT /profiles/:id/branches/:cornerId/role { role }` | `profiles.changeRole` | admin or owner: MANAGER ↔ STAFF. A manager of **that** branch: staff → manager. A manager demoting **themselves** to staff there, while another ACTIVE manager of that branch remains | Same role → 200, no change. Not in that branch → 404 |
| `DELETE /profiles/:id/branches/:cornerId` | `profiles.move` | admin, owner | Not in that branch → 404 |
| `PUT /profiles/:id/role { role, cornerId? }` | `profiles.changeRole` | **Company-level only.** Promote an ACTIVE member to OWNER (admin, owner), which ends all their assignments. Demote an OWNER (the admin; or **the owner themselves** while another ACTIVE owner remains) to MANAGER (`cornerId` required) or STAFF (`cornerId` or null) | MANAGER ↔ STAFF for a non-owner here → 400, pointing to the branch endpoint |
| `PUT /profiles/:id/branch` | | | **removed** |

The permission codes are unchanged, so the seed doesn't change.

**Views**
- `ProfileView.role` is computed. `branch` becomes `branches: [{ id, name, role: { code, name } }]` (live assignments in live branches).
- The dropdown's `CompanyProfileView.role` is computed.
- The open profile in auth responses shows the computed role code instead of `roleId`.

**Member list** (`GET /profiles?cornerId=&role=&status=`): same parameters, translated.
- `cornerId=X`: has a live assignment in X.
- `cornerId=none`: no live assignment (owners included, as today).
- **`role=` without a branch** (no `cornerId`, or `cornerId=none`) means the company-wide role. It must select exactly the people for whom `companyRoleOf` returns that role.
- **`role=` with `cornerId=X`** means the role **in X**, so `?cornerId=X&role=MANAGER` answers "who are X's managers", as it did in piece 1. It must match `branchRoleIn`, and OWNER matches nobody here.
- **Two unit-test tables** check these filters against `companyRoleOf` and `branchRoleIn`, because the filter is the second place each role is worked out (see Anti-goals).
- **People who left are hidden by default.** `DEACTIVATED` profiles are left out unless `?status=DEACTIVATED` asks for them. Someone who left and rejoined therefore shows once, as their current profile.

**Branch rules that change**
- `CornersService.assertWorksCorner`: owners and the admin anywhere in scope; everyone else needs a live assignment to that corner (any role), else 403.
- Approval by a manager: they must be MANAGER **in the target branch**. The pending list is shown to a manager if they're MANAGER somewhere.
- History reads: `GET /profiles/:id/history` is readable by a manager of **any** branch the person is in. `GET /corners/:id/history` by the managers of that branch.
- `NotificationsService.findCornerRecipientIds`: ACTIVE profiles with a live MANAGER assignment there, plus the owners.

**Branch deletion** (`DELETE /corners/:id`):
1. Soft-delete the branch with the guarded write (as today).
2. `updateManyAndReturn` its live assignments (`deleted_at` = now, `deleted_by` = the caller), returning each profile and role.
3. Write one `BRANCH_DELETED` row each and send one `member.moved` each.

### History encoding (new rows)

Each new row describes **one assignment** (or the company-level role). From and to are each a (role, branch) pair:

| Change | From | To |
|---|---|---|
| Approved | (null, null) | (role, branch or null) |
| `BRANCH_ADDED` | (null, null) | (R, X) |
| `BRANCH_REMOVED`, `BRANCH_DELETED` | (R, X) | (null, null) |
| `ROLE_CHANGED` in a branch, or the branch successor (`ROLE_CHANGED` / `AUTO_PROMOTED`) | (R1, X) | (R2, X) |
| Promoted to owner, or the owner successor | one row per ended assignment: (R, X); a person with no branch: (STAFF, null) | (OWNER, null) |
| Owner demoted | (OWNER, null) | (R, X or null) |
| `LEFT_COMPANY`, `ACCOUNT_DELETED`, `COMPANY_CLOSED` | one row per ended assignment: (R, X); an owner or a person with no branch: (their role, null) | (null, null) |

The branch history query is unchanged: rows where the branch is the from or the to. Old rows, such as `MOVED` and `BRANCH_DELETED` with the role kept, still read fine because the views show only ids and names.

---

## How it works: Part B (leaving)

### Endpoints

| Endpoint | Who | Result |
|---|---|---|
| `GET /profiles/me/leave-preview` | the open profile (company route) | what leaving would need, below |
| `POST /profiles/me/leave { ownerSuccessorProfileId?, branchSuccessors?: [{ cornerId, profileId }] }` | an ACTIVE or PENDING_APPROVAL profile | 200: a summary (closed company? who became what) |
| `DELETE /me { phoneVerificationToken }` | account route | 204 |
| `POST /phone-verifications { phone, purpose: 'DELETE_ACCOUNT' }` | existing public flow | |

There are no new permission codes, since these are self-service. The platform admin has no company, so leaving doesn't apply to it, and deletion returns 403.

**Preview:**
```json
{
  "companyWillClose": false,
  "owner": { "successorNeeded": true, "candidates": [{ "profileId": "…", "name": "…", "role": "MANAGER" }], "defaultPick": "…" },
  "branches": [{ "cornerId": "…", "name": "…", "successorNeeded": true, "candidates": [ … ], "defaultPick": "… or null" }]
}
```
- `owner` is null when the leaver isn't an owner.
- `branches` lists only the branches where the leaver is a manager.
- `successorNeeded` is false when another ACTIVE owner (or manager of that branch) remains.

### The leave procedure (one transaction; leaving and account deletion share it)

1. **Lock the company row** by writing to it.
2. **Lock the branches involved** by writing to them, in `id` order: those the leaver manages, plus the owner successor's branches.
3. Re-read the leaver: ACTIVE or PENDING_APPROVAL and not deleted, else 409.
4. **Owner part** (the leaver is an OWNER):
   - Another ACTIVE owner remains → nothing to do.
   - Otherwise the candidates are the ACTIVE non-owner members other than the leaver. A successor that was sent must be one of them (400 otherwise). If none was sent, `pickSuccessor` chooses. No candidates → **closure** (below).
   - The successor gets `role_id = OWNER` and their live assignments end. History as in the table above.
5. **Branch part** (each branch X where the leaver is a MANAGER):
   - Another ACTIVE manager of X remains → nothing to do.
   - Otherwise the candidates are the ACTIVE profiles with a live STAFF assignment in X, excluding the leaver and the owner successor.
   - A successor that was sent must be a candidate. A successor sent for a branch that doesn't need one → 400. If none was sent, `pickSuccessor` chooses. No candidates → X has no manager.
6. **The leaver:**
   - Their live assignments end (`deleted_by` = the leaver).
   - Status becomes `DEACTIVATED` through a guarded `updateMany` (`status IN (ACTIVE, PENDING_APPROVAL)`). A count of 0 → 409.
   - `role_id` stays as it was, for the record. Owner counts already filter on ACTIVE.
7. History rows: `LEFT_COMPANY`, `ACCOUNT_DELETED` or `COMPANY_CLOSED`.
8. **After the commit:** the events.

A **pending** leaver goes through steps 1, 3 and 6 only (no assignments, no history). A **pending owner** of a company still waiting for approval closes it.

**Closure** (the last owner leaves and no other ACTIVE member remains):
- The company is soft-deleted (`deleted_by` = the leaver), and so are its live branches and their assignments.
- Every other live profile of the company (pending, suspended, rejected) becomes `DEACTIVATED`.
- `COMPANY_CLOSED` rows are written for the leaver and for anyone else who had a role.
- **Closing is final.** The tax ID stays taken (registering it again → 409, as today), and so do the products' barcodes. The catalog, stock and orders stay as records of the closed company. Bringing a company back is the later revival flow.

### Deleting an account (`DELETE /me`)

1. The platform admin → 403.
2. One transaction:
   1. Lock the account row.
   2. Spend the proof `{ token, phone: <the account's phone>, purpose: DELETE_ACCOUNT }`. A wrong, used or expired proof, or one for another phone or purpose → 400.
   3. For each live, non-`DEACTIVATED` profile, in `companyId` order, run **the leave procedure with system picks** (reason `ACCOUNT_DELETED`). SUSPENDED and REJECTED profiles are simply deactivated.
   4. Read the login methods (kept for the disconnect), then delete them.
   5. Revoke every live refresh token.
   6. Delete the device tokens.
   7. Set the account's `deleted_at` and set `last_profile_id` to null.
3. After the commit: the events, then a best-effort, logged `disconnect()` for each social login.

**Where the code lives:** deletion needs the accounts, the leave procedure, phone verification and the social verifiers. `SocialAuthModule` already imports `AccountsModule`, so deletion can't sit inside `AccountsModule` without an import cycle (see "Left to the builder").

### Races (project rule: conditional writes plus a count, never caught errors)

- **Two last owners leaving at once:** both lock the company row before counting owners. The second waits, then sees the first `DEACTIVATED`, so it needs a successor or closes the company.
- **Two managers of one branch leaving at once:** same pattern with the branch row.
- A leave racing a promotion or demotion, or a successor leaving at the same moment: they take the same company and branch locks and re-read afterwards.
- **Lock order everywhere:** account → company → branches (by `id`) → profiles.
- Adding someone to the same branch twice: the partial unique index plus `createManyAndReturn({ skipDuplicates: true })` gives `[]` → 409.
- Adding someone to a branch that's being deleted: lock the live branch first (the existing `lockLiveCorner`).
- Deleting an account twice at once: the account lock, plus the single-use proof.

### Existing code that changes

- **Schema and migration**: as above. Seed: nothing (permission codes unchanged).
- **auth**: `AuthProfile`, `JwtAuthGuard`, the session responses' open profile.
- **authorization**: `PermissionsService` looks roles up by code.
- **profiles**:
  - `member-rules.ts`: `companyRoleOf`, `pickSuccessor`, the branch-role and company-role rulebooks replacing `decideRoleChange`;
  - `profiles.service.ts`: approve, list, role, branches, history;
  - `profile-view.ts`, the controllers, the DTOs;
  - the leave preview and leave on `profiles/me`.
- **corners**: `assertWorksCorner`, `listHistory`, `remove`.
- **notifications**: `findCornerRecipientIds`; the new `member.left` event, listener and templates.
- **accounts**: the dropdown's role is computed.
- **membership-history**: the new reasons.
- **phone-verification**: the new purpose.
- **social-auth**: expose the provider disconnect for reuse.
- **e2e**: `test/members.e2e-spec.ts`, `test/helpers/accounts.ts`, and every suite that reads `branch` from a view.

---

## Testing

**Unit**
- `companyRoleOf` over a table of cases, including people who left and pending owners.
- **The member-list `role=` filter**: against `companyRoleOf` without a branch, and against `branchRoleIn` with `cornerId`.
- The default list hides people who left; `?status=DEACTIVATED` shows them.
- `pickSuccessor`.
- The branch-role and company-role rules, including both kinds of self-demotion.
- The guard builds `branches`; `PermissionsService` looks roles up by code.
- Leaving:
  - staff;
  - a manager, with and without another manager in the branch, and with and without staff;
  - a named successor vs the default pick, and an invalid successor (400);
  - an owner, with and without another owner;
  - closure;
  - withdrawing a pending request;
  - a pending owner closing their waiting company.
- Deletion:
  - a wrong purpose, or another phone (400);
  - the admin (403);
  - every company left, login methods gone, sessions revoked, devices gone;
  - disconnect called after the commit, with a failure logged and not thrown.

**e2e** (a human runs it)
- New suite `test/leaving.e2e-spec.ts` (phone suite 18):
  - someone who manages A and is staff in B works in both, and is refused in C;
  - the last manager leaves, and the default pick becomes the manager;
  - an owner leaves and names a successor;
  - the last owner leaves alone: the company closes, the invite code returns 404, and registering its tax ID again returns 409;
  - an account is deleted: its phone can sign up again, its email login can sign up again, and its old refresh token gets 401;
  - two owners leave at once (`Promise.all`) and the company still ends up with exactly one ACTIVE owner, or closes if neither remained.
- `test/members.e2e-spec.ts` is updated for branch assignments.

**Migration check**
- The number of copied rows equals the number of MANAGER and STAFF profiles that had a live branch.
- No MANAGER or STAFF `role_id` is left on any profile.

## Built for later

- **A revival flow for closed companies** (the user's decision). Closing keeps everything a revival needs: the company row with its tax ID, its products and barcodes, its branches, its history, and who closed it (`deleted_by_profile_id`). A revival un-deletes rows rather than re-creating them, so the global barcode rule never gets in the way. Who may revive a company, and how a returning owner proves it's their business, is that flow's own design.
- **Scrubbing personal data at deletion** (PIPA): replace the name with "탈퇴한 사용자" and clear the photo and contact email. The rows stay, so the records still link. That's a later change to the deletion transaction and doesn't touch the schema.
- **Per-branch permissions in the guard**, if managers and staff ever differ in branch-work permissions.
- **Schedules**, if "who works where on which day" ever needs recording.

## Left to the builder

- Splitting the work into tasks (Part A before Part B), DTO names, and the exact JSON field names beyond the shapes above.
- The English and Korean copy (지점), and the event payload shapes.
- Which module holds account deletion and its `DELETE /me` controller, as long as it adds no import cycle (for example, a small module that imports the others and that nothing imports).
- Whether the migrations are one or several, and index names that follow the existing conventions.
- How the guard's assignment select is shared with the views.
