# Phase 2 — Ownership / Tenant Scoping Design

- **Project:** Inventra (multi-tenant inventory management SaaS)
- **Date:** 2026-07-29
- **Status:** Design approved; pending implementation plan
- **Depends on:** Phase 1 (auth, `PermissionsService`/`PermissionsGuard`, `AuthUser`, `JwtAuthGuard`)

## 1. Goal & Scope

Deliver the **scope half of authorization**. Phase 1's `PermissionsService` answers *"can this user perform action X?"* — but globally. Phase 2's `OwnershipService` answers the missing half: *"…to a record in **their** company?"* — the tenant/record-ownership boundary that keeps Company A from touching Company B's data even when both have the same permission.

**In scope:**
- `OwnershipService` — a plain **singleton** whose methods take the `AuthUser` explicitly; no dependencies (pure logic).
- Add **`roleCode`** to `AuthUser` (a `JwtAuthGuard` load-query change) so the ADMIN can be recognized without an extra query.
- **Retrofit** the existing hand-written tenant scoping in `UsersService.approveMember` onto `OwnershipService`.

**Out of scope (later):** feature modules (products, orders, inventory) that will consume `OwnershipService`; request-scoped DI; Prisma-middleware auto-scoping; refactoring `PermissionsService` to use `roleCode` (deferred to keep this phase tight).

## 2. Key Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Phase deliverable | Infra + retrofit existing | Reusable scoping pattern established before feature modules multiply; a real consumer (approval flows) proves it; testable now. |
| 2 | Context mechanism | **Explicit `AuthUser` param** (singleton), not request-scoped | Call chains are shallow (controller → one service method), so threading the caller costs almost nothing; no `Scope.REQUEST` per-request cost or scope-bubbling; the user is already on `request.user`. |
| 3 | ADMIN recognition | **`roleCode` on `AuthUser`** | Explicit and future-proof vs. implicitly equating "no company" with "god mode"; the guard already loads the user, so it's one extra join. |
| 4 | Null-company non-admin | **Throw `ForbiddenException`** (fail closed) | An invariant violation ("a real member always belongs to a company"); throwing avoids a magic sentinel and prevents an accidental unscoped query that would leak everything. |
| 5 | Cross-tenant failure | **`NotFoundException` (404)** | Consistent with the approval flows; never reveal that a record exists in another company (403 would leak existence). |
| 6 | Module placement | `AuthorizationModule` | Cohesive with `PermissionsService` — it's the scope half of authz; exported for `UsersModule` (and future modules) to import. |

## 3. Data Model / Type Changes

**No DB migration.** Type + query changes only:

- **`AuthUser`** gains `roleCode: string | null`.
- **`JwtAuthGuard`** fresh-load query adds the role code via a join and maps it:
  ```ts
  select: { id: true, companyId: true, roleId: true, status: true, deletedAt: true,
            role: { select: { code: true } } },
  // ...
  request.user = { id, companyId, roleId, status, roleCode: user.role?.code ?? null };
  ```

## 4. `OwnershipService` API

Two complementary enforcement styles, so callers pick the one that fits:

```ts
@Injectable()
export class OwnershipService {
  // (a) query-scoping — spread into a Prisma `where` so you only ever fetch your own rows
  scopeToCompany(caller: AuthUser): { companyId?: string } {
    if (caller.roleCode === 'ADMIN') return {};              // admin → all companies
    if (!caller.companyId) throw new ForbiddenException();   // non-admin must have a company
    return { companyId: caller.companyId };
  }

  // (b) assertion — for fetching a record by a global id, then verifying ownership
  assertOwns(caller: AuthUser, resourceCompanyId: string | null): void {
    if (caller.roleCode === 'ADMIN') return;                 // admin bypass
    if (resourceCompanyId !== caller.companyId) {
      throw new NotFoundException();                          // cross-tenant → 404, no leak
    }
  }
}
```

- **`scopeToCompany`** — *proactive*: you can't even see other tenants' records (this is what the retrofit uses).
- **`assertOwns`** — *reactive*: for future modules that look a record up by a global id and must check after fetching.

## 5. Retrofit

- **`UsersService.approveMember`** — replace the hand-written `companyId: caller.companyId` in the `findFirst` with `...this.ownership.scopeToCompany(caller)`. Behaviour is identical for OWNER/MANAGER; ADMIN would now also be handled correctly (though ADMIN doesn't use this route).
- **`approveCompany`** — unchanged. It's ADMIN-only and keyed by the *target* company, not the caller's tenant, so there's nothing to scope.
- **Controllers** — unchanged; they already pass `@CurrentUser()`.

## 6. Error Handling

| Situation | Response |
|---|---|
| Cross-tenant record access | 404 (`NotFoundException`) — no existence leak |
| Non-admin caller with no `companyId` (invariant violation) | 403 (`ForbiddenException`) — fail closed |
| ADMIN acting across companies | Allowed (bypass) |

## 7. Module Structure

```
src/authorization/
├── authorization.module.ts     # + provides & EXPORTS OwnershipService
├── permissions.service.ts      # (unchanged)
├── ownership.service.ts        # NEW — singleton, no deps
└── guards/permissions.guard.ts # (unchanged)

src/users/users.module.ts       # + imports AuthorizationModule
src/users/users.service.ts      # approveMember uses OwnershipService
src/auth/guards/jwt-auth.guard.ts   # loads role.code → AuthUser.roleCode
src/auth/types/auth-user.ts     # + roleCode
```

No circular dependency: `AuthorizationModule` exports `OwnershipService`; `UsersModule` imports `AuthorizationModule`; `AuthorizationModule` does not import `UsersModule`.

## 8. Testing

- **`OwnershipService` unit spec** — `scopeToCompany` (regular → `{ companyId }`, admin → `{}`, non-admin-no-company → 403); `assertOwns` (same company → ok, cross-tenant → 404, admin → bypass).
- **`JwtAuthGuard` spec** — updated so the attached `AuthUser` includes `roleCode`, and the query selects `role.code`.
- **`UsersService` spec** — stays green (the scoping helper produces the same `where` for a regular caller); add an ADMIN-caller case if useful.
- **e2e** — existing `auth.e2e-spec.ts` continues to pass unchanged (behaviour preserved).

## 9. Open Items

- Feature modules will adopt `OwnershipService` (both `scopeToCompany` and `assertOwns`) as they're built — Phase 2 only establishes and proves the pattern.
- The `PermissionsService` ADMIN-lookup refactor (using `roleCode`) is a deliberate follow-up, not part of this phase.
