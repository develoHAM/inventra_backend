# Many Branches & Leaving: Design

**Date:** 2026-11-19
**Status:** approved 2026-11-19; **redesigned with the user 2026-11-21** (the role belongs to the person, branches are a list; see "How we got here"); **built** 2026-11-26 (Tasks 1–5). "As built" at the end lists every deviation.
**Piece 3 of 3** of the membership track:
1. Roles & branches (built): promote and demote people, move them between branches, change history.
2. One sign-in, many companies (built): an account with one profile per company, Slack-style switching.
3. **Many branches & leaving** (this doc), in two parts built in this order:
   - **Part A, many branches:** a manager or staff member can work in several branches, or in none.
   - **Part B, leaving:** leave a company, be removed from one, delete an account, close a company, and an owner successor when the last owner leaves.

---

## Why

- **People work in more than one branch.** A part-timer sells at Hongdae and Jamsil. A manager runs Gangnam and Hongdae. Today a profile has exactly one branch (`profiles.company_store_id`), so none of this can be recorded.
- **Nobody can leave, and nobody can be let go.** There's no way to:
  - leave a company: the profile stays forever and keeps holding its "one profile per company" slot;
  - remove someone who quit: they stay a member, with access, forever;
  - delete an account: the phone number and the social identities stay tied to it. Apple also requires in-app account deletion with token revocation;
  - close a company.
- **Leaving must not leave holes:** no company with people still working in it but no owner.

## Goals

**Part A**
- A manager or staff member can work in **any number of branches, or none**.
- **The role belongs to the person** (OWNER, MANAGER or STAFF) and applies in every branch they work in.
- Owners and the admin add people to branches and remove them. Nothing is ever blocked because it would leave someone without a branch.
- A person chooses which branch they're working in by opening it: the URL names the branch (`/corners/:cornerId/...`). There's no schedule.
- Only owners and the admin make managers. Managers approve newcomers as staff.

**Part B**
- **Leaving a company** ends only that company's profile (it becomes `DEACTIVATED`). The account and its other companies are untouched, and the person can rejoin later with an invite code, as a new profile.
- **Owners and the admin can remove a member** from the company, with the same effect as leaving.
- **The last owner leaving** may name a new owner. If they don't, the system picks one. If there's nobody to pick, the company closes.
- **Stepping down:** an owner while another owner remains; a manager at any time.
- **Deleting an account** requires a fresh phone verification. It leaves every company under the same rules, frees the phone and the login identities, ends every session, and disconnects the social providers.
- Every change lands in the membership history, and **names stay on records**.

## Non-goals

- Work schedules or rosters, i.e. which days someone works in which branch.
- **A different role per branch** ("manager in A, staff in B"). See "How we got here" and "Built for later".
- Scrubbing personal data at account deletion (see "Built for later").
- Declining a pending join request (there's no member "reject" today), suspension flows, reviving a closed company, restoring a deleted account, deletion started by the admin, exporting data before deletion.
- The client screens.

## Anti-goals (a failure even if it "works")

- A company with **ACTIVE members but no ACTIVE owner**, including when two owners leave at the same moment.
- **The system changing someone's role as a side effect** of a branch change (a branch closing, an assignment removed).
- A manager granting a power wider than their own scope: nobody below owner makes managers or owners.
- A deleted account that can still sign in, refresh, or receive pushes through any session, login method or device.
- A provider disconnect failure that blocks a deletion or rolls it back.
- Leaving or removal that erases names from records, or edits or deletes history rows.

---

## How we got here (approaches)

| | Approach | Outcome |
|---|---|---|
| 1 | A role on each branch assignment, with the company-wide role stored on the profile and kept in sync | Dropped first: the same fact stored twice, so a write path that forgets the sync leaves a stale role |
| 2 | A role on each branch assignment, with the company-wide role **worked out** from the assignments every time | Approved on 2026-11-19, then **dropped on 2026-11-21**: "manager" vanished when a manager's branch closed, and a company-wide power (editing the shared catalog) depended on branch rows |
| 3 | Only OWNER and MANAGER: everyone who works in a branch manages it | Dropped: weekend part-timers would edit and delete the company-wide catalog |
| 4 | **The role on the person; branches are a plain list. (Picked.)** | |

**Why 4:** a permission belongs at the level of the thing it protects.
- The catalog is company-wide (one product list shared by every branch), so "may edit the catalog" belongs to the **person**: the role.
- Branch work is branch-scoped, so "where they may work" belongs to the **assignments**: the list.

Approaches 1 and 2 mixed the two levels, which is why the role disappeared with the branch.

**The cost we accept:** one role everywhere a person works. Minji, a manager, has manager powers at Hongdae even if she only helps out there. A role per branch can be added later as a column on the assignments.

Also ruled out: a profile per branch (the "one profile per company" rule is piece 2's foundation), and per-branch permissions in the guard (managers and staff differ only in company-wide powers and approving, which the services already scope).

---

## Decisions (the user's)

| Topic | Decision |
|---|---|
| Where the role lives | **On the person**: OWNER, MANAGER or STAFF on the profile, applying in every branch they work in |
| Many branches | Owners can assign a manager or staff member to **any number of branches** |
| Branches are optional | A manager or staff member may have **no branch**: approving or demoting someone without one, removing someone's last branch, and deleting a branch are all allowed. A person with no branch **keeps their role** and waits for a new branch |
| Who makes managers | **Only owners and the admin** (promoting, or approving as manager). Managers approve newcomers as **staff only**, into a branch they work in |
| Removing a member | **Owners and the admin can remove someone** from the company |
| What leaving ends | Only that company's profile. Leaving a company doesn't end the account |
| Last owner leaving | They may name a new owner from the company's existing members. If they don't, the system names one (the picking rule can change later). Nobody to pick → the company closes |
| Self-demotion | An owner, while another owner remains. A manager, at any time |
| Choosing a branch | People choose which branch they work in at any given time by opening it |
| Proof for deleting an account | A fresh **phone verification** |
| Names on records after deletion | **Kept for now** |
| A closed company | **Closing is final.** Its tax ID and its product barcodes stay taken. A revival flow comes later |

## Who may do what (the user's, 2026-11-21)

**Admin**

| Actor | Action | Target | Allowed when |
|---|---|---|---|
| Admin | approves | a pending newcomer | as any role: owner (no branch), or manager or staff (into one branch, or none) |
| Admin | promotes / demotes | staff ↔ manager | always |
| Admin | promotes | a manager or staff member → owner | always; their branch assignments end |
| Admin | demotes | an owner → manager or staff (into one branch, or none) | only while another ACTIVE owner remains |
| Admin | adds / removes | a manager or staff member to or from a branch | always, including their last branch |
| Admin | removes from the company | anyone | an owner only while another ACTIVE owner remains |

**Owner**

| Actor | Action | Target | Allowed when |
|---|---|---|---|
| Owner | approves | a pending newcomer | the same as the admin |
| Owner | promotes / demotes | staff ↔ manager | always |
| Owner | promotes | a manager or staff member → owner | always; their branch assignments end |
| Owner | demotes | another owner | ✗ never (only the admin can) |
| Owner | demotes | themselves → manager or staff | only while another ACTIVE owner remains |
| Owner | adds / removes | a manager or staff member to or from a branch | always, including their last branch |
| Owner | removes from the company | a manager or staff member | always; never an owner. Leaving themselves is `POST /profiles/me/leave` |

**Manager**

| Actor | Action | Target | Allowed when |
|---|---|---|---|
| Manager | approves | a pending newcomer | **as staff only**, into a branch the manager works in |
| Manager | demotes | themselves → staff | always: owners cover everything a manager does |
| Manager | promotes / demotes | anyone else | ✗ never |
| Manager | adds / removes branches, removes from the company | anyone | ✗ never |

**Staff:** no approvals, no role changes, no branch changes, no removals.

**The principle:** company-wide powers are granted only by company-wide roles (owners, the admin). You lower only people below you, and yourself only while someone else still covers your role.

**What each role can do** (the seeded permissions, unchanged except `profiles.remove`):

| | Owner | Manager | Staff |
|---|---|---|---|
| Branch work (placements, stock, orders, audits, reservations) | every branch | the branches they work in | the branches they work in |
| Edit the catalog (products, brands) | ✓ | ✓ | read only |
| The invite code | ✓ | ✓ | ✗ |

## Decisions (my calls, stated so they can be rejected)

| Topic | Call |
|---|---|
| Who can be the owner successor | Only **ACTIVE** non-owner members of the company, other than the leaver |
| The system's pick | One pure function, `pickSuccessor`, so the rule can be swapped later. **Managers before staff**, then **longest-serving** (the profile's `created_at`, earliest first), then `id` to break ties |
| Acceptance | None. A successor takes the role immediately (piece 1's rule) |
| History of a successor | Named by the leaver: `ROLE_CHANGED`, `changed_by` = the leaver. Picked by the system: `AUTO_PROMOTED`, `changed_by` = null |
| No branch successors | A branch that loses its managers isn't a hole: owners cover approvals for it, and the catalog is company-wide. So nobody is promoted when a manager leaves |
| When a company closes | Only when **no other ACTIVE member** remains. Its other profiles (pending, suspended, rejected) are deactivated. Its branches are soft-deleted. The invite code stops working |
| Leaving while pending | This withdraws the join request, with no history row. A pending owner of a company still waiting for approval closes that company |
| Proof for leaving | None. Anyone who left can rejoin with an invite code |
| Removal: the endpoint | `POST /profiles/:id/remove`, behind a new permission `profiles.remove` seeded for owners (the admin holds every permission). 204 |
| Removal: who can be removed | ACTIVE or SUSPENDED members (a pending request isn't "removed"). Not yourself: that's leaving (400) |
| Removal: what it does | The leave procedure, with reason `REMOVED` and the remover as `changed_by` and `deleted_by`. It never needs an owner successor, because an owner can only be removed while another ACTIVE owner remains |
| Removal: notifications | The removed person gets the new `member.removed` (email and push), even though their profile is now deactivated. The owners and the managers of their branches get `member.left` with reason `REMOVED`. The remover is never notified |
| Successors when deleting an account | The **system picks everywhere**. Someone who wants to choose leaves those companies first, using the preview |
| Deletion proof details | New purpose `DELETE_ACCOUNT`. It must be the account's **own** phone, used once, and spent in the deletion's transaction. The platform admin has no phone, so it can't delete itself (403) |
| What deletion removes | Login-method rows are hard-deleted, as unlink already does, so the email and provider identities can sign up again. Every session is revoked, device tokens are deleted, and the account is soft-deleted, which frees the phone through the existing partial unique index |
| Provider disconnect | After the commit, best-effort and logged, reusing unlink's disconnect (Apple and Google use the stored encrypted refresh token) |
| Current branch | Not in the token. The URL names the branch. Remembering the last branch opened is the client's job |
| Assignment rows | Follow the soft-delete convention (`deleted_at`, `deleted_by_profile_id`) |
| Owners and branches | Owners never have assignments: they work in every branch. Promotion to owner ends all of the person's assignments |
| A person with no branch | **Keeps their role.** Every branch route answers 403 until an owner adds them to a branch. A manager with no branch keeps company-wide powers (the catalog, the invite code) but approves nobody, since approval needs a branch they work in. Owners find these people with `GET /profiles?cornerId=none` (owners are listed there too, as today) |
| `cornerId` on `PUT /profiles/:id/role` | Only when demoting an owner (400 otherwise). Not sent, or null, means no branch |
| Notifications | `member.left` and `member.removed` are new. Being added to or removed from a branch, or a branch being deleted, reuses `member.moved`. A role change reuses `member.roleChanged`. A closure notifies nobody, since nobody is left. Korean member copy says **지점** |
| Sessions after leaving or removal | Nothing to write. The guard already refuses a `DEACTIVATED` profile (401), and `POST /auth/refresh` already falls back to another company or to none (built in piece 2) |
| `companies.deleted_by_profile_id` | Added, as the soft-delete convention requires |
| Member list | `cornerId=X` means "works in X"; `cornerId=none`, "works in no branch"; `role=` is the person's role, so `?cornerId=X&role=MANAGER` is "the managers who work in X". **People who left are hidden** unless `?status=DEACTIVATED` asks for them, so someone who left and rejoined shows once |

---

## How it works: Part A (many branches)

### Data model (`prisma/schema.prisma`)

**New: `profile_branches`** (model `ProfileBranch`), one live row per person per branch. There's **no role column**.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | database default `gen_random_uuid()` |
| `profile_id` | uuid FK → profiles | |
| `company_store_id` | uuid FK → company_stores | the branch |
| `created_at`, `updated_at` | timestamptz | `created_at` = when they joined this branch |
| `deleted_at` | timestamptz, nullable | the assignment ended |
| `deleted_by_profile_id` | uuid FK → profiles, nullable, named relation | who ended it (null = the system) |

- **One live assignment per person per branch:** partial unique `UQ_profile_branches_profile_branch` on `(profile_id, company_store_id) WHERE deleted_at IS NULL`. Write the predicate with `raw()` exactly as Postgres normalizes it (STATUS.md gotcha).
- Index on `company_store_id` ("who works in this branch").

**Changed**
- `profiles.role_id`: **unchanged** (ADMIN, OWNER, MANAGER or STAFF).
- `profiles.company_store_id`: **dropped**, along with the `CompanyStoreMembers` relation.
- `companies`: gains `deleted_by_profile_id`. `UQ_companies_tax_id` stays a full unique index: closing is final.
- `MembershipChangeReason` gains `BRANCH_ADDED`, `BRANCH_REMOVED`, `LEFT_COMPANY`, `REMOVED`, `ACCOUNT_DELETED`, `COMPANY_CLOSED`, `AUTO_PROMOTED`. `MOVED` stays for old rows but is no longer written.
- `PhoneVerificationPurpose` gains `DELETE_ACCOUNT`.
- Seed: the new permission `profiles.remove`, granted to OWNER.

**Existing data.** One migration, with a hand-written data step put in place before anything applies it:
1. Create the table.
2. Copy every non-deleted profile's `company_store_id` that points at a live branch into one assignment.
3. Drop the column.

Roles aren't touched.

### `AuthProfile` (what `request.profile` holds)

```ts
type AuthProfile = {
  id: string;
  accountId: string;
  companyId: string | null;
  roleId: number | null;
  roleCode: string | null;
  branchIds: string[]; // live assignments in live branches
  status: ProfileStatus;
};
```

- `companyStoreId` is replaced by `branchIds`.
- The guard's single `findUnique` gains a relation select of the live assignments.
- `PermissionsService` is unchanged (it reads the role, which is unchanged).

### Endpoints

| Endpoint | Permission | Who | Notes |
|---|---|---|---|
| `PATCH /profiles/:id/approve { roleId, cornerId \| null }` | `profiles.approve` | admin, owner: any role. A manager: STAFF, into a branch they work in | `OWNER` with a `cornerId` → 400. A `cornerId` writes the first assignment; null writes none |
| `POST /profiles/:id/branches { cornerId }` | `profiles.move` | admin, owner | Target: an ACTIVE manager or staff member of the company (an owner → 400). Branch: live, in the company. Already in it → 409. 201 |
| `DELETE /profiles/:id/branches/:cornerId` | `profiles.move` | admin, owner | Not in that branch → 404. Their last branch may be removed. 200 |
| `PUT /profiles/:id/role { role, cornerId? }` | `profiles.changeRole` | as in "Who may do what" | `cornerId` only when demoting an owner; it writes one assignment |
| `POST /profiles/:id/remove` | `profiles.remove` | admin, owner | Part B |
| `PUT /profiles/:id/branch` | | | **removed**: adding and removing assignments replace it (no production deployment, no client yet) |

**Views**
- `ProfileView.branch` becomes `branches: [{ id, name }]` (live assignments in live branches, oldest first). `role` is unchanged.

**Branch rules that change**
- `CornersService.assertWorksCorner`: owners and the admin anywhere in scope; everyone else needs a live assignment to that corner, else 403.
- Approval by a manager: the branch must be one they work in. The pending list is shown to a manager who works in at least one branch.
- History reads:
  - `GET /profiles/:id/history`: the person themselves, the admin, an owner, or a manager who works in a branch the person works in.
  - `GET /corners/:id/history`: the admin, owners, and the managers who work in that branch.
- `NotificationsService.findCornerRecipientIds`: ACTIVE managers with a live assignment there, plus the owners.

**Branch deletion** (`DELETE /corners/:id`), never blocked by the people in it:
1. Soft-delete the branch with the guarded write (as today).
2. `updateManyAndReturn` its live assignments (`deleted_at` = now, `deleted_by` = the caller), returning each profile.
3. Write one `BRANCH_DELETED` row each and send one `member.moved` each. Nobody's role changes.

### History encoding (new rows)

Rows stay full snapshots: the role and the branch, before and after. A change writes **one row per assignment it affects**:

| Change | From | To |
|---|---|---|
| Approved | (null, null) | (R, X or null) |
| `BRANCH_ADDED` | (R, null) | (R, X) |
| `BRANCH_REMOVED`, `BRANCH_DELETED` | (R, X) | (R, null) |
| `ROLE_CHANGED` between staff and manager | one row per live assignment: (R1, X); a person with no branch: (R1, null) | (R2, X), or (R2, null) |
| Promoted to owner, or the owner successor (`ROLE_CHANGED` / `AUTO_PROMOTED`) | one row per ended assignment: (R, X); a person with no branch: (R, null) | (OWNER, null) |
| Owner demoted | (OWNER, null) | (R, X or null) |
| `LEFT_COMPANY`, `REMOVED`, `ACCOUNT_DELETED`, `COMPANY_CLOSED` | one row per ended assignment: (R, X); an owner or a person with no branch: (R, null) | (null, null) |

The branch history query is unchanged: rows where the branch is the from or the to. So a promotion of someone who works in A shows in A's history, "from A to A", as it does today.

---

## How it works: Part B (leaving)

### Endpoints

| Endpoint | Who | Result |
|---|---|---|
| `GET /profiles/me/leave-preview` | the open profile (company route) | what leaving would need, below |
| `POST /profiles/me/leave { ownerSuccessorProfileId? }` | an ACTIVE or PENDING_APPROVAL profile | 200: a summary (closed company? who became owner?) |
| `POST /profiles/:id/remove` | admin, owner (`profiles.remove`) | 204 |
| `DELETE /me { phoneVerificationToken }` | account route | 204 |
| `POST /phone-verifications { phone, purpose: 'DELETE_ACCOUNT' }` | existing public flow | |

Leaving and deletion are self-service, so they need no permission. The platform admin has no company, so leaving doesn't apply to it, and deletion returns 403.

**Preview:**
```json
{
  "companyWillClose": false,
  "owner": { "successorNeeded": true, "candidates": [{ "profileId": "…", "name": "…", "role": "MANAGER" }], "defaultPick": "…" }
}
```
- `owner` is null when the leaver isn't an owner.
- `successorNeeded` is false when another ACTIVE owner remains.
- `companyWillClose` is true when the leaver is the last ACTIVE owner and there are no candidates.

### The leave procedure (one transaction; leaving, removal and account deletion share it)

1. **Lock the company row** by writing to it.
2. Re-read the leaver. Leaving: ACTIVE or PENDING_APPROVAL. Removal: ACTIVE or SUSPENDED. Deletion: anything but DEACTIVATED. Never deleted. Otherwise 409.
3. **Owner part** (the leaver is an OWNER):
   - Another ACTIVE owner remains → nothing to do.
   - Otherwise the candidates are the ACTIVE non-owner members other than the leaver. A successor that was sent must be one of them (400 otherwise). If none was sent, `pickSuccessor` chooses. No candidates → **closure** (below).
   - The successor is written with a guarded update (their role and ACTIVE in the `where`; count 0 → 409): `role_id = OWNER`, and their live assignments end. History as in the table above.
4. **The leaver:**
   - Their live assignments end (`deleted_by` = the actor: the leaver, or the remover).
   - Status becomes `DEACTIVATED` through a guarded `updateMany`. A count of 0 → 409.
   - `role_id` stays as it was, for the record. Owner counts already filter on ACTIVE.
5. History rows: `LEFT_COMPANY`, `REMOVED`, `ACCOUNT_DELETED` or `COMPANY_CLOSED`, with `changed_by` = the actor.
6. **After the commit:** the events.

A **pending** leaver goes through steps 1, 2 and 4 only (no assignments, no history). A **pending owner** of a company still waiting for approval closes it.

**Closure** (the last owner leaves and no other ACTIVE member remains):
- The company is soft-deleted (`deleted_by` = the leaver), and so are its live branches and their assignments.
- Every other live profile of the company (pending, suspended, rejected) becomes `DEACTIVATED`.
- `COMPANY_CLOSED` rows are written for the leaver and for anyone else who had a role.
- **Closing is final.** The tax ID stays taken (registering it again → 409, as today), and so do the products' barcodes. The catalog, stock and orders stay as records of the closed company. Bringing a company back is the later revival flow.

### Removing a member (`POST /profiles/:id/remove`)

1. The target must be in the caller's company (the admin: any company), else 404. Yourself → 400 (use leave).
2. An owner removing an owner → 403. The admin removing an owner: inside the transaction, after the company lock, fewer than two ACTIVE owners → 409.
3. The target must be ACTIVE or SUSPENDED, else 400.
4. Run the leave procedure with reason `REMOVED` and the caller as the actor. It never reaches the owner part's successor branch (step 2 guarantees another owner).
5. After the commit: `member.removed` to the removed person, `member.left` (reason `REMOVED`) to the owners and the managers of their branches.

### Deleting an account (`DELETE /me`)

1. The platform admin → 403.
2. One transaction:
   1. Lock the account row.
   2. Spend the proof `{ token, phone: <the account's phone>, purpose: DELETE_ACCOUNT }`. A wrong, used or expired proof, or one for another phone or purpose → 400.
   3. For each live, non-`DEACTIVATED` profile, in `companyId` order, run **the leave procedure with system picks** (reason `ACCOUNT_DELETED`).
   4. Read the login methods (kept for the disconnect), then delete them.
   5. Revoke every live refresh token.
   6. Delete the device tokens.
   7. Set the account's `deleted_at` and set `last_profile_id` to null.
3. After the commit: the events, then a best-effort, logged `disconnect()` for each social login.

**Where the code lives:** deletion needs the accounts, the leave procedure, phone verification and the social verifiers. `SocialAuthModule` already imports `AccountsModule`, so deletion can't sit inside `AccountsModule` without an import cycle (see "Left to the builder").

### Races (project rule: conditional writes plus a count, never caught errors)

- **Two last owners leaving at once:** both lock the company row before counting owners. The second waits, then sees the first `DEACTIVATED`, so it needs a successor or closes the company.
- **The admin removing an owner while another owner leaves:** both take the company lock, so the owner count is always read after the other one finished.
- **A successor changed at the same moment** (promoted, removed, or leaving): the successor's guarded update counts 0 → 409, and nothing is written.
- **Removal racing the person's own leave:** both end in a guarded status update; the second counts 0 → 409.
- **Lock order everywhere:** account → company → branches (by `id`) → profiles.
- Adding someone to the same branch twice: the partial unique index plus `createManyAndReturn({ skipDuplicates: true })` gives `[]` → 409.
- Adding someone to a branch that's being deleted: lock the live branch first (the existing `lockLiveCorner`).
- Deleting an account twice at once: the account lock, plus the single-use proof.

### Existing code that changes

- **Schema and migration**: as above. **Seed**: `profiles.remove` for OWNER.
- **auth**: `AuthProfile`, `JwtAuthGuard` (`branchIds`).
- **profiles**:
  - `member-rules.ts`: `decideRoleChange` follows "Who may do what"; `pickSuccessor`;
  - `profiles.service.ts`: approve, list, role, history;
  - new: the branch assignments service and controller, the leaving service;
  - `profile-view.ts`, the controllers, the DTOs; the leave preview and leave on `profiles/me`.
- **corners**: `assertWorksCorner`, `listHistory`, `remove`.
- **notifications**: `findCornerRecipientIds`; `member.moved` reshaped; the new `member.left` and `member.removed` events, listener and templates.
- **membership-history**: the new reasons.
- **phone-verification**: the new purpose.
- **social-auth**: expose the provider disconnect for reuse.
- **e2e**: the members suite, `test/helpers/accounts.ts`, and every suite that reads `branch` from a view or calls `PUT /profiles/:id/branch`.

---

## Testing

**Unit**
- `decideRoleChange` over a table of every row in "Who may do what", including both kinds of stepping down and the manager's 403s.
- Approval: as owner (no branch), manager or staff (a branch or none), a manager approving as staff into their own branch only.
- The guard builds `branchIds`; `assertWorksCorner` with several branches.
- Adding and removing assignments, including the last one (the role stays).
- Branch deletion ends only that branch's assignments and changes nobody's role.
- The member list: `cornerId=X`, `cornerId=none`, `role=` with and without a branch, and people who left hidden by default.
- `pickSuccessor`.
- Leaving: staff; a manager (nobody promoted); an owner with and without another owner; a named successor vs the default pick; an invalid successor (400); closure; withdrawing a pending request; a pending owner closing their waiting company.
- Removal: who may remove whom; yourself (400); the admin removing the last owner (409); the removed person still notified.
- Deletion: a wrong purpose, or another phone (400); the admin (403); every company left, login methods gone, sessions revoked, devices gone; disconnect called after the commit, with a failure logged and not thrown.

**e2e** (a human runs it)
- The members suite:
  - only owners promote (a manager gets 403); a manager steps down; an owner steps down while another owner remains;
  - approving as owner;
  - someone in A and B works in both and is refused in C; a manager in A and B approves into either but not C;
  - adding twice (409), removing the last branch (200, role kept), deleting a branch (only its assignments end).
- New suite `test/leaving.e2e-spec.ts` (phone suite 18):
  - staff leaves: old access token 401, refresh falls back, rejoining makes a new pending profile;
  - an owner leaves and names a successor; the last owner leaves alone and the company closes (invite code 404, tax ID 409);
  - two owners leave at once (`Promise.all`) and the company still ends with exactly one ACTIVE owner;
  - an owner removes staff (204, their token 401, they're notified); an owner removing an owner (403); the admin removing the last owner (409);
  - an account is deleted: its phone can sign up again, its email login can sign up again, and its old refresh token gets 401.

**Migration check**
- The number of copied rows equals the number of live profiles that had a live branch.

## Built for later

- **A role per branch**, if "manager in A, staff in B" is ever needed: a role column on `profile_branches` (an expand migration).
- **Head-office roles**, such as catalog editors who work in no store, if the business needs them as a separate job.
- **Declining a pending join request** (a member "reject").
- **A revival flow for closed companies** (the user's decision). Closing keeps everything a revival needs: the company row with its tax ID, its products and barcodes, its branches, its history, and who closed it (`deleted_by_profile_id`). A revival un-deletes rows rather than re-creating them, so the global barcode rule never gets in the way.
- **Scrubbing personal data at deletion** (PIPA): replace the name with "탈퇴한 사용자" and clear the photo and contact email. The rows stay, so the records still link.
- **Schedules**, if "who works where on which day" ever needs recording.

## Left to the builder

- DTO names, and the exact JSON field names beyond the shapes above.
- The English and Korean copy (지점), and the event payload shapes.
- Which module holds account deletion and its `DELETE /me` controller, as long as it adds no import cycle (for example, a small module that imports the others and that nothing imports).
- Index names that follow the existing conventions.
- How the guard's assignment select is shared with the views.

## As built (2026-11-26)

Plan `docs/superpowers/plans/2026-11-19-many-branches-and-leaving.md` ("Decisions beyond the spec" has the reasons). The deviations from this design:

- **One migration for the piece:** `20261122020212_profile_branches` (the table, every new enum value, `companies.deleted_by_profile_id`, the copy, then dropping `profiles.company_store_id`). Task 1 needed no schema change and shipped first.
- **Permissions:** "unchanged except `profiles.remove`" became "plus four retired": `profiles.create`, `profiles.update`, `profiles.delete` and `companies.update` were seeded but never checked by any route. The seed drops them, and a retire step deletes them and their role and personal grants from databases seeded before. `profiles.delete` wasn't reused for removal: the profile permissions are named after their route, and a removal deletes nothing.
- **Removal checks** start with the role: a caller who isn't an OWNER or the ADMIN → 403 `Only owners and the admin can remove members`, so a personal GRANT of `profiles.remove` gets a manager past the guard but not past the service (as with approval). Then: yourself (400), the lookup (404), an owner removing an owner (403), the status (400). The last-owner 409 is counted inside the shared procedure, under the company lock.
- **The shared procedure** is `LeavingService.leaveInTransaction(transaction, { profileId, companyId, actorProfileId, reason, ownerSuccessorProfileId? })`: `actorProfileId` is the leaver for leaving and deletion, the remover for removal, and it returns its events for sending after the commit.
- **Deletion** lives in `AccountDeletionModule` (`DELETE /me`, an `@AccountRoute()`), which imports phone verification, social auth, profiles and accounts, and which nothing imports. Its account lock is one `updateManyAndReturn` that also reads the phone the proof must match; a second deletion that waited for it gets 401.
- **Linking takes the account lock** (not in this design; found while building deletion): `linkProvider` and `linkPassword` lock the live account before inserting (count 0 → 401). Without it, a link at the same moment as a deletion could leave a login on the deleted account, and since the login-method unique indexes count every row, that identity or email could never sign up again. `linkProvider` now runs in a transaction, with the provider check before it.
- **The disconnect** is `ProviderDisconnectService.disconnectQuietly` (moved out of `LoginMethodsService`, exported by `SocialAuthModule`); its warning now reads `Could not disconnect <provider> login <id>: <reason>`.
- **For the app:** a push names the recipient's `profileId`; once that profile is DEACTIVATED (left or removed), a tap-to-switch gets 404 `Company profile not found` and the session stays as it was.
- **Tests:** 1403 unit (98 suites) and 324 e2e (18 suites), measured 2026-11-26. Review Focus 1–5 each have an e2e: several branches (`profiles.e2e`), two owners leaving at once, a session on a profile that left or was removed, every credential of a deleted account plus a link racing the deletion, and ineligible successors (`leaving.e2e`).
