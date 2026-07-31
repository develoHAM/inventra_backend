# Permission Isn't Enough: Building Inventra's Tenant Boundary

*Phase 2 added the "scope" half of authorization — making sure a company can only ever touch its own records, even when it holds the right permission.*

**2026-07-31**

## Intro

Inventra is a multi-tenant inventory-management SaaS. Phase 1 gave it a role/permission system that answers *"can this user perform action X?"* — but that's only half of authorization. A `MANAGER` at Company A who has `products.update` must **not** be able to update Company B's products. Phase 2 built the missing half: the **tenant/record-ownership boundary**, as a small, dependency-free `OwnershipService`, and retrofitted it onto the existing approval flow to prove the pattern.

## Architectural Decisions

### 1. Build the infra now and retrofit, not wait for a feature module

- **Goal:** Establish tenant scoping in the codebase.
- **Options:** (a) build `OwnershipService` now and apply it to what exists; (b) build it together with the first record-owning feature module (products); (c) build it standalone with unit tests and no consumer.
- **Choice:** Build it now and **retrofit** the existing approval flows, which were already scoping by `companyId` by hand.
- **Reason:** Establishing the pattern *before* feature modules multiply means every future module enforces tenancy the same way — nobody reinvents (or forgets) the `companyId` filter. And retrofitting gives the service a real consumer to validate against, instead of designing an abstraction with no user.
- **Result:** A reusable scoping primitive and a cleaner approval flow, both shipped and tested, before a single feature module exists.

### 2. Explicit parameter, not a request-scoped provider

This was the phase's most interesting call, and I went against the "fancier" option on purpose.

- **Goal:** Let `OwnershipService` know *who's asking* (their `companyId`).
- **Options:** (a) a **request-scoped** provider (`Scope.REQUEST`) — one instance per HTTP request that reads `request.user` once and exposes the tenant *ambiently*; (b) a plain **singleton** whose methods take the `AuthUser` as an explicit parameter.
- **Choice:** The **singleton with an explicit `AuthUser` parameter**.
- **Reason:** A request-scoped provider is elegant but not free — NestJS rebuilds it (and everything that injects it) on *every* request, and that "scope bubbling" spreads up the dependency chain. The ergonomic win it buys — not threading the caller through methods — only pays off with deep call chains. Mine are shallow: a controller grabs `@CurrentUser()` and calls *one* service method. So explicit param costs almost nothing, and the user is already sitting on `request.user` from the auth guard.
- **Result:** A trivially simple, dependency-free singleton — no per-request instantiation, no scope bubbling, and a service I can unit-test with a bare `new OwnershipService()`.

### 3. Recognize ADMIN by an explicit `roleCode`, not by "has no company"

- **Goal:** Let the platform ADMIN (who spans all companies) bypass the tenant check.
- **Options:** (a) treat `companyId === null` as the bypass, since only the platform admin has no company; (b) add the role's `code` to `AuthUser` and bypass when `roleCode === 'ADMIN'`.
- **Choice:** Add **`roleCode` to `AuthUser`** (the auth guard loads it via a join) and check it explicitly.
- **Reason:** Equating "has no company" with "god mode" is an implicit coupling that would quietly break if the data model ever changed. An explicit `roleCode === 'ADMIN'` says exactly what it means, and it's future-proof if cross-tenant access ever becomes role-driven for more than one role.
- **Result:** A clear bypass condition — plus a bonus: `PermissionsService` currently does an extra DB lookup just to check the ADMIN role, and now it *could* use `roleCode` to skip it (a deliberate follow-up, kept out of this phase).

### 4. Fail closed on a broken invariant, with no magic sentinel

- **Goal:** Handle the "impossible" case — a non-admin caller with no `companyId`.
- **Options:** (a) return a sentinel filter like `{ companyId: '__none__' }` so the query matches nothing; (b) `throw`.
- **Choice:** **Throw `ForbiddenException`.**
- **Reason:** "A real member always belongs to a company" is an invariant; if it's ever violated, that's a broken session, and the safe response is to **fail closed** (deny). A magic sentinel is a code smell, and — worse — if I'd returned an *empty* scope by mistake, the query would match *every* company's records. Throwing removes both the smell and the footgun.
- **Result:** An explicit, self-documenting guard instead of a fragile string constant.

### 5. Cross-tenant access returns 404, not 403

- **Goal:** Decide what a caller sees when they reach for another company's record.
- **Options:** `403 Forbidden` or `404 Not Found`.
- **Choice:** **`404 NotFoundException`.**
- **Reason:** `403` leaks information — it confirms "this record exists, you just can't have it." `404` says "there's nothing here," indistinguishable from a genuinely non-existent id. In a multi-tenant system you never want to confirm the *existence* of another tenant's data.
- **Result:** Cross-tenant probing reveals nothing.

### 6. Two enforcement styles in one service

- **Goal:** Enforce ownership across different query patterns.
- **Options:** proactive query-scoping only; reactive assertion only; both.
- **Choice:** **Both** — `scopeToCompany` (a Prisma `where`-fragment) and `assertOwns` (a post-fetch check).
- **Reason:** Query-scoping is the safest pattern — you bake `companyId` into the `where`, so other tenants' rows are *never fetched* and a miss is a natural 404. But sometimes you must look a record up by a global id first (a REST `GET /products/:id`) and can only check *after*; that's what `assertOwns` is for. Different call patterns need different tools.
- **Result:** One small service that fits both how the current code queries and how future modules will.

```ts
@Injectable()
export class OwnershipService {
  scopeToCompany(caller: AuthUser): { companyId?: string } {
    if (caller.roleCode === 'ADMIN') return {};              // all companies
    if (!caller.companyId) throw new ForbiddenException();   // fail closed
    return { companyId: caller.companyId };
  }

  assertOwns(caller: AuthUser, resourceCompanyId: string | null): void {
    if (caller.roleCode === 'ADMIN') return;
    if (resourceCompanyId !== caller.companyId) throw new NotFoundException();
  }
}
```

## TIL (Today I Learned)

**What's the real difference between a request-scoped provider and a singleton?** By default NestJS makes one instance of a provider and shares it across *every* request — so it literally can't "remember" the current caller, because it's serving thousands at once. That's why you pass the user in. A request-scoped provider is a *fresh instance per request*, so it can safely hold `request.user`. The tradeoff is cost: it (and everything injecting it) gets rebuilt each request.

**What does "thread the caller through every method" mean?** It's passing the same argument down a chain of calls: if a controller calls `A.do(caller)`, and `do` needs `B.help(caller)`, and that needs `C.check(caller)`, every function in the path has to accept and forward `caller`. A request-scoped service spares you that; with explicit params you pass it wherever scoping happens (trivial when the chain is one call deep).

**How do you pull one field off a related table in Prisma?** A nested `select` on the relation: `select: { …, role: { select: { code: true } } }`. It's a join, and the result is `user.role: { code } | null`. I only wanted the code, so I selected just that — not the whole role row.

**Why would making a helper `async` be a bug here?** My first `OwnershipService` had `async scopeToCompany`. But it's used by *spreading* into a query: `where: { id, ...scopeToCompany(caller) }`. An `async` function returns a **Promise**, so that spread would splat the Promise's internal keys — not `{ companyId }`. The logic is pure and synchronous; making it async both broke the usage and forced `await` everywhere for no reason.

**Why 404 and not 403 for another tenant's record?** Because `403` confirms the record *exists*. In multi-tenant systems, existence itself is information you don't hand to outsiders — so cross-tenant reads look exactly like "not found."

## NestJS Concepts & Libraries

| Concept / Library | Why we used it |
|---|---|
| **Provider scopes** (`Scope.REQUEST` vs default singleton) | Weighed ambient request-scoped context vs. an explicit-param singleton; chose the singleton |
| **DI across modules** (`imports`/`exports`) | `UsersModule` imports `AuthorizationModule` to inject the exported `OwnershipService` |
| **Prisma relation `select`** | Join in the role's `code` so the guard can attach `roleCode` |
| **Object spread into a Prisma `where`** | `...scopeToCompany(caller)` merges the tenant filter into a query |
| **HTTP exceptions** (`NotFoundException` / `ForbiddenException`) | 404 for cross-tenant (no existence leak); 403 fail-closed on a broken invariant |
| **Jest** | Unit-test a pure singleton with no mocks (`new OwnershipService()`) |

## Wrap-up

Phase 2 was a small phase with an outsized payoff: it added the **scope** half of authorization. `OwnershipService` gives the codebase one place where "you can only touch your own company's records" lives — ADMIN-aware, fail-closed on broken invariants, 404 on cross-tenant probes — and the approval flow now routes through it. It's dependency-free and covered by unit tests (59 across the suite).

The real win is the **pattern**: every feature module from here on will pair Phase 1's `PermissionsGuard` (*can you?*) with Phase 2's `OwnershipService` (*is it yours?*). Next up are those modules — **products, then orders and inventory** — the first real consumers of both halves of the authorization story.
