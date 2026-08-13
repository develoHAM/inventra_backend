# Who Runs This Corner? Sub-Resources, Singletons, and Row-Level Rules

> Inventra Phase 4 — building the layer where a company runs a corner inside a store, with one manager and a crew of staff.
> 2026-08-13

## Intro

Inventra is a multi-tenant inventory SaaS built on the Korean concession model — companies operate "corners" inside physical stores. Phase 3 built the catalog (*what* you sell). Phase 4 builds the layer beneath it: **stores** (where) and **corners** (who operates where). A store is a shared venue; a corner is one company's presence in it, with a manager and staff. This phase was less about new framework machinery and more about *modeling* — REST shapes, ownership models, and a row-level rule the permission system alone can't express.

## Architectural Decisions

### 1. Two ownership models, again — global stores, owned corners

**Goal.** Model venues that many companies share, plus each company's private presence inside them.
**Options.** Everything global; everything company-owned; or a split.
**Choice.** **Stores are global** (ADMIN-managed reference data, like Phase 3's Categories); **Corners are company-owned** and tenant-scoped.
**Reason.** A department store is one physical building that many companies rent corners inside — shared infrastructure, the same fact for everyone. A corner is private. The concession domain maps directly onto this split.
**Result.** `StoresService` came out a near-copy of `CategoriesService` (no scoping; writes fenced to ADMIN by permission grants). `CornersService` reuses `OwnershipService.scopeToCompany` — and because a corner's owner column is `companyId` (the helper's default), it's even simpler than Brands, which needed a custom column name.

### 2. A manager is a singleton; staff are a collection

**Goal.** Expose "set the corner's manager" and "add/remove staff" as clean HTTP.
**Options.** Cram it all into `PATCH /corners/:id`; or model manager + staff as sub-resources.
**Choice.** **Sub-resources, shaped by cardinality.** The manager (one per corner) is a singleton you `PUT`; staff (many per corner) is a collection you `POST` to and `DELETE` from.

| Relationship | Cardinality | Verbs |
|---|---|---|
| manager (`managerUserId`) | one (0..1) | `PUT /corners/:id/manager` |
| staff (`User.companyStoreId`) | many (0..N) | `POST /corners/:id/staff`, `DELETE /corners/:id/staff/:userId` |

**Reason.** `PUT` means "replace this one-valued slot with exactly this," and it's idempotent — retry-safe. `PATCH` is for partial deltas on a resource, which is exactly what editing a corner's name/description is. Matching the verb to the *shape* of the relationship keeps the API predictable.
**Result.** Three tiny, single-purpose endpoints, each with its own validation and its own permission — instead of one overloaded `PATCH` that has to branch on whatever you sent it.

### 3. The MANAGER role finally manages — but only its own corner

**Goal.** Let a store manager run their corner's roster, without letting them run everyone's.
**Options.** A coarse permission (any manager staffs any corner); or a row-level rule.
**Choice.** **Row-level.** MANAGER holds `corners.assign`, but the service adds: you can only touch staff of a corner you actually manage.

```ts
private assertCanManageStaff(caller: AuthUser, corner: { managerUserId: string | null }) {
  if (caller.roleCode === 'MANAGER' && corner.managerUserId !== caller.id)
    throw new ForbiddenException('You can only manage staff of corners you manage');
  // OWNER / ADMIN pass through
}
```

**Reason.** This is the same shape as Phase 3's creator-scoped product delete — a binary permission (*can this role assign?*) plus a per-row ownership check (*is this row yours?*). And it's what the seeded MANAGER role literally says: *"Manages a company_store and its members."* Appointing *the manager*, though, stays OWNER/ADMIN-only — a manager mustn't crown themselves — so `PUT /manager` throws 403 for a MANAGER caller even though they hold the same `corners.assign` permission.
**Result.** One permission, two behaviors, separated by a couple of `roleCode`/row checks in the service. The permission table stays simple; the nuance lives where the row is.

### 4. Fetch-then-decide, reused across three services

**Goal.** Validate a corner's `storeId` and its assigned users without tangling the services together.
**Choice.** Each owning service exposes a **row-or-null lookup**, and `CornersService` decides the error. `StoresService.findActive(id)` and `UsersService.findActiveMember(userId, companyId)` never throw; Corners turns their `null` into a `400`.
**Reason / Result.** Same pattern as Phase 3 — the owning service owns the lookup and its scoping; the caller owns the policy. It also came with a small DI lesson: `UsersModule` had to `exports: [UsersService]` before `CornersModule` could inject it. A provider is private to its module until you export it.

## TIL (Today I Learned)

**`PUT` or `PATCH` for assigning the manager?**
`PUT`. The manager is a single-valued slot; assigning one *replaces* it entirely, and doing it twice with the same user is idempotent — both are `PUT`'s job. `PATCH` is for partial updates to a resource (like editing a corner's name). Match the verb to whether you're replacing a whole thing or merging a delta.

**Do we even need `deletedByUserId` on stores, if only ADMIN can delete them?**
I nearly dropped it — the "who" seems fixed when only admins delete. Two things changed my mind: the `users` table allows *multiple* admins, and deleting a *shared* store is the most consequential delete in the system (every company's corners hang off it). "Which admin removed the venue 40 companies depended on" is exactly what an audit column is for. So I kept it. The lesson: an audit column's value scales with the *blast radius* of the action, not the number of people who can trigger it.

**How do we handle the race between the check and the write in `update`/`delete`?**
There's a TOCTOU gap between `findOne` (the check) and `update({ where: { id } })` (the act). The key realization is that it's safe *here specifically* because a corner's `companyId` is immutable — if the check proved "it's yours," it's still yours at write time, so no tenant boundary can be crossed in the window. The only races left are benign (editing a just-deleted row). The airtight fix, when you need it, is to fold the guard into the write itself — `updateMany({ where: { id, ...scope, deletedAt: null }, data }).count` — making check-and-act one atomic SQL statement. We're banking that for Phase 5 inventory, where a lost update means wrong stock counts and real money.

**`tsc` passed — so the types are fine, right?**
No. I made `company_stores.name` NOT NULL but left `CreateCornerDto.name` optional, and `tsc` stayed green — Prisma's `create` input is an `XOR<…>` conditional type that masks that kind of mismatch. But at runtime, a request omitting `name` would sail past validation and `500` at the database instead of returning a clean `400`. Type-check green ≠ behavior correct; the DTO still had to be tightened by hand.

## NestJS Concepts & Libraries

| Concept / Library | Why we used it |
|---|---|
| Sub-resource routes (`@Put`/`@Post`/`@Delete` on `:id/manager`, `:id/staff`) | Model one-to-one vs one-to-many relations as singletons vs collections. |
| `@RequirePermissions('corners.assign')` + a row check | Coarse RBAC at the guard, fine per-row rule in the service. |
| `OwnershipService.scopeToCompany` (default column) | A corner's owner column is `companyId` — the default — so scoping is a one-liner. |
| Cross-module DI + `exports` | `CornersModule` injects `StoresService` + `UsersService`; a provider must be exported to be shared. |
| `@nestjs/mapped-types` `PartialType`/`OmitType` | `UpdateCornerDto` drops `companyId`/`storeId`/`managerUserId` so `PATCH` can't move a corner or bypass the manager rules. |
| `class-validator` (`@IsUUID`, `@IsNotEmpty`, …) | Edge validation — and where the NOT NULL / optional-DTO lesson bit. |
| `ParseUUIDPipe` | Store and corner ids are UUIDs. |
| Prisma `updateMany` (+ `count`) | The atomic check-and-act guard — reserved for Phase 5. |
| Prisma named relations + soft delete | `deletedByUser` on stores/corners; `deletedAt`-filtered reads. |
| Jest + supertest | Unit specs mock Prisma; the e2e drives real HTTP through routing + guards. |

## Wrap-up

Phase 4 was a modeling phase. No new framework machinery — instead, three lessons about *shape*: match the HTTP verb to a relationship's cardinality (`PUT` a singleton, `POST`/`DELETE` a collection); push rules that depend on a specific row down into the service, beneath the permission; and remember that a green type-check isn't a green runtime. The corner now has a manager and a crew, scoped so a manager runs their own patch and no one else's.

**Next — Phase 5: product placement.** The catalog exists (Phase 3), the corners exist (Phase 4), and now they meet: `CompanyStoreProduct` puts a product on a specific corner's shelf, with stock targets. That's where the atomic `updateMany` guard we deferred stops being optional — inventory quantities are where races cost money.
