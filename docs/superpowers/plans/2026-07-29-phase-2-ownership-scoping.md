# Phase 2 — Ownership / Tenant Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **This project's execution style:** the developer implements each task themselves after I (1) teach the concepts, (2) give the requirements, (3) provide the full reference code, and (4) write + run the tests. Tasks below are still TDD-structured.

**Goal:** Add the *scope* half of authorization — an `OwnershipService` that enforces "this record belongs to the caller's company," recognizing the platform ADMIN as cross-tenant, and retrofit it onto the existing approval flow.

**Architecture:** A dependency-free singleton `OwnershipService` whose methods take the `AuthUser` explicitly. It exposes `scopeToCompany` (a Prisma `where`-fragment for proactive query-scoping) and `assertOwns` (a post-fetch assertion). ADMIN is recognized via a new `roleCode` field on `AuthUser`, loaded by `JwtAuthGuard`.

**Tech Stack:** NestJS 11, Prisma 7, Jest.

## Global Constraints

- **No DB migration** — type + query changes only.
- Cross-tenant access → **`NotFoundException` (404)** (never leak existence).
- Non-admin caller with no `companyId` → **`ForbiddenException` (403)** (fail closed; no magic sentinel).
- `OwnershipService` is a **pure singleton with no dependencies**.
- ADMIN (`roleCode === 'ADMIN'`) bypasses all tenant checks.
- Retrofit **`approveMember` only**; `approveCompany` unchanged. Existing unit + e2e tests must stay green (behaviour preserved).

---

## Task 1: `AuthUser.roleCode` + `JwtAuthGuard` loads it

**Files:**
- Modify: `src/auth/types/auth-user.ts`
- Modify: `src/auth/guards/jwt-auth.guard.ts`
- Test: `src/auth/guards/jwt-auth.guard.spec.ts`
- Modify (compile fix): `src/authorization/permissions.service.spec.ts`, `src/authorization/guards/permissions.guard.spec.ts`, `src/users/users.service.spec.ts` — every `const … : AuthUser = { … }` literal gains `roleCode`.

**Interfaces:**
- Produces: `AuthUser = { id: string; companyId: string | null; roleId: number | null; roleCode: string | null; status: UserStatus }`.

- [ ] **Step 1: Update `AuthUser`**

```ts
// src/auth/types/auth-user.ts
import { UserStatus } from '../../generated/prisma/enums';

export type AuthUser = {
  id: string;
  companyId: string | null;
  roleId: number | null;
  roleCode: string | null;
  status: UserStatus;
};
```

- [ ] **Step 2: Load `role.code` and map it in the guard**

```ts
// src/auth/guards/jwt-auth.guard.ts — the findUnique + attach block
const user = await this.prisma.user.findUnique({
  where: { id: tokenPayload.sub },
  select: {
    id: true,
    companyId: true,
    roleId: true,
    status: true,
    deletedAt: true,
    role: { select: { code: true } },
  },
});

if (!user || user.deletedAt || !CAN_AUTHENTICATE.includes(user.status)) {
  throw new UnauthorizedException();
}

request.user = {
  id: user.id,
  companyId: user.companyId,
  roleId: user.roleId,
  roleCode: user.role?.code ?? null,
  status: user.status,
};
```

- [ ] **Step 3: Update the guard spec** — add `role` to the mock row, `roleCode` to the expected `req.user`, and `role: { select: { code: true } }` to the asserted `select`.

```ts
// activeUser mock row gains the joined role:
const activeUser = {
  id: 'user-1', companyId: 'company-1', roleId: 2,
  status: UserStatus.ACTIVE, deletedAt: null,
  role: { code: 'OWNER' },
};

// in the happy-path test:
expect(request.user).toEqual({
  id: 'user-1', companyId: 'company-1', roleId: 2,
  roleCode: 'OWNER', status: UserStatus.ACTIVE,
});
expect(prisma.user.findUnique).toHaveBeenCalledWith({
  where: { id: 'user-1' },
  select: {
    id: true, companyId: true, roleId: true,
    status: true, deletedAt: true,
    role: { select: { code: true } },
  },
});
```

- [ ] **Step 4: Fix the other `AuthUser` literals** — add `roleCode` so they compile. The value is functionally irrelevant to those specs; use the role they imply:
  - `permissions.service.spec.ts` user → `roleCode: 'OWNER'`
  - `permissions.guard.spec.ts` user → `roleCode: 'OWNER'`
  - `users.service.spec.ts` caller → `roleCode: 'MANAGER'`

- [ ] **Step 5: Run the full suite** — `npm test`. Expected: all green (the guard now carries `roleCode`; other specs compile).

- [ ] **Step 6: Commit**

```bash
git add src/auth/ src/authorization/ src/users/
git commit -m "feat(auth): add roleCode to AuthUser, loaded by JwtAuthGuard"
```

---

## Task 2: `OwnershipService`

**Files:**
- Create: `src/authorization/ownership.service.ts`
- Test: `src/authorization/ownership.service.spec.ts`
- Modify: `src/authorization/authorization.module.ts` (provide + export)

**Interfaces:**
- Consumes: `AuthUser` (Task 1).
- Produces:
  - `scopeToCompany(caller: AuthUser): { companyId?: string }`
  - `assertOwns(caller: AuthUser, resourceCompanyId: string | null): void`

- [ ] **Step 1: Write the failing spec**

```ts
// src/authorization/ownership.service.spec.ts
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OwnershipService } from './ownership.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('OwnershipService', () => {
  let service: OwnershipService;

  const member: AuthUser = {
    id: 'u1', companyId: 'company-1', roleId: 3,
    roleCode: 'MANAGER', status: UserStatus.ACTIVE,
  };
  const admin: AuthUser = {
    id: 'admin', companyId: null, roleId: 1,
    roleCode: 'ADMIN', status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    service = new OwnershipService();
  });

  describe('scopeToCompany', () => {
    it('scopes a regular caller to their own company', () => {
      expect(service.scopeToCompany(member)).toEqual({ companyId: 'company-1' });
    });

    it('returns an empty scope for ADMIN (all companies)', () => {
      expect(service.scopeToCompany(admin)).toEqual({});
    });

    it('throws 403 for a non-admin with no company', () => {
      expect(() =>
        service.scopeToCompany({ ...member, companyId: null }),
      ).toThrow(ForbiddenException);
    });
  });

  describe('assertOwns', () => {
    it('passes when the resource is in the caller company', () => {
      expect(() => service.assertOwns(member, 'company-1')).not.toThrow();
    });

    it('throws 404 for a cross-tenant resource', () => {
      expect(() => service.assertOwns(member, 'company-2')).toThrow(
        NotFoundException,
      );
    });

    it('lets ADMIN access any company', () => {
      expect(() => service.assertOwns(admin, 'company-2')).not.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run it — fails** (`npm test -- ownership.service` → cannot find `./ownership.service`).

- [ ] **Step 3: Implement the service**

```ts
// src/authorization/ownership.service.ts
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthUser } from '../auth/types/auth-user';

@Injectable()
export class OwnershipService {
  /** Prisma `where`-fragment scoping to the caller's company (ADMIN → all). */
  scopeToCompany(caller: AuthUser): { companyId?: string } {
    if (caller.roleCode === 'ADMIN') return {};
    if (!caller.companyId) throw new ForbiddenException();
    return { companyId: caller.companyId };
  }

  /** Assert a fetched record belongs to the caller's company (ADMIN bypasses). */
  assertOwns(caller: AuthUser, resourceCompanyId: string | null): void {
    if (caller.roleCode === 'ADMIN') return;
    if (resourceCompanyId !== caller.companyId) {
      throw new NotFoundException();
    }
  }
}
```

- [ ] **Step 4: Register it in `AuthorizationModule`** (provide + export)

```ts
// src/authorization/authorization.module.ts
import { OwnershipService } from './ownership.service';
// ...
@Module({
  providers: [
    PermissionsService,
    OwnershipService,
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [PermissionsService, OwnershipService],
})
export class AuthorizationModule {}
```

- [ ] **Step 5: Run — passes** (`npm test -- ownership.service` → 6 passing).

- [ ] **Step 6: Commit**

```bash
git add src/authorization/
git commit -m "feat(authz): add OwnershipService (tenant scoping helpers)"
```

---

## Task 3: Retrofit `UsersService.approveMember`

**Files:**
- Modify: `src/users/users.module.ts` (import `AuthorizationModule`)
- Modify: `src/users/users.service.ts` (inject `OwnershipService`, use `scopeToCompany`)
- Test: `src/users/users.service.spec.ts` (construct with `OwnershipService`; behaviour unchanged)

**Interfaces:**
- Consumes: `OwnershipService.scopeToCompany` (Task 2), `AuthUser.roleCode` (Task 1).

- [ ] **Step 1: Import `AuthorizationModule` into `UsersModule`**

```ts
// src/users/users.module.ts
import { AuthorizationModule } from '../authorization/authorization.module';
// ...
@Module({
  imports: [AuthorizationModule],
  controllers: [UsersController, CompaniesController],
  providers: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 2: Inject `OwnershipService` and use it in `approveMember`**

```ts
// src/users/users.service.ts
import { OwnershipService } from '../authorization/ownership.service';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ownership: OwnershipService,
  ) {}

  async approveMember(caller: AuthUser, targetUserId: string, dto: ApproveMemberDto) {
    const target = await this.prisma.user.findFirst({
      where: { id: targetUserId, ...this.ownership.scopeToCompany(caller) },
    });
    if (!target) throw new NotFoundException('Member not found');
    // ... unchanged: PENDING guard, role restriction, update
  }
}
```

- [ ] **Step 3: Update the spec's construction** — `UsersService` now needs an `OwnershipService`. It's dependency-free, so use a real one:

```ts
// src/users/users.service.spec.ts — beforeEach
import { OwnershipService } from '../authorization/ownership.service';
// ...
service = new UsersService(prisma as any, new OwnershipService());
```

The existing assertion still holds — for a `MANAGER` caller in `company-1`, `scopeToCompany` returns `{ companyId: 'company-1' }`, so the `findFirst` `where` is still `{ id: 'member-1', companyId: 'company-1' }`. (The caller mock already gained `roleCode: 'MANAGER'` in Task 1.)

- [ ] **Step 4: Add an ADMIN-caller case** (proves the scoping actually delegates):

```ts
it('does not company-scope the lookup for an ADMIN caller', async () => {
  const adminCaller = { ...caller, companyId: null, roleCode: 'ADMIN' };
  prisma.user.findFirst.mockResolvedValue({
    id: 'member-1', companyId: 'company-9',
    status: UserStatus.PENDING_APPROVAL,
  });
  prisma.role.findUnique.mockResolvedValue({ id: 4, code: 'STAFF' });

  await service.approveMember(adminCaller as any, 'member-1', { roleId: 4 });

  expect(prisma.user.findFirst).toHaveBeenCalledWith({
    where: { id: 'member-1' },   // no companyId → admin sees all tenants
  });
});
```

- [ ] **Step 5: Run the full suite** — `npm test`. Expected: all green.

- [ ] **Step 6: Run the e2e** — `npm run test:e2e`. Expected: all green (behaviour preserved).

- [ ] **Step 7: Commit**

```bash
git add src/users/
git commit -m "refactor(users): scope approveMember via OwnershipService"
```

---

## Self-Review (coverage vs spec)

- Spec §2 decisions 1–6: Tasks 1–3 cover roleCode (T1), explicit-param singleton + ADMIN-via-roleCode + null-company-throws + 404 cross-tenant (T2), infra+retrofit + module placement (T2/T3). ✅
- Spec §3 type/query changes: Task 1. ✅
- Spec §4 API (`scopeToCompany`, `assertOwns`): Task 2. ✅
- Spec §5 retrofit (`approveMember`, `approveCompany` unchanged): Task 3. ✅
- Spec §6 error handling (404 / 403): Task 2 spec asserts both. ✅
- Spec §7 module structure: Task 2 (export) + Task 3 (import). ✅
- Spec §8 testing (ownership unit, guard spec, users spec green, e2e green): Tasks 1–3. ✅
- Type consistency: `AuthUser.roleCode: string | null`, `scopeToCompany → { companyId?: string }`, `assertOwns → void` — consistent across tasks. ✅
