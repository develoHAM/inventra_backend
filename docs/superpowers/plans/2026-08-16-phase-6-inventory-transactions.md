# Phase 6 — Inventory Transactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **This project's execution style:** per task I (1) teach the concepts, (2) give requirements, (3) provide full reference code, (4) write + run the tests. Code blocks below are the reference; the developer compares their own against them.

**Goal:** A centralized, atomic inventory-transaction engine that appends an immutable `InventoryTransaction` ledger row and adjusts the affected balance bucket(s) on a 1:1 `CompanyStoreProductStock` table — in one `$transaction`, oversell-safe.

**Architecture:** Split the live balances out of `CompanyStoreProduct` into a hot 1:1 `CompanyStoreProductStock` table. `InventoryService.record` resolves the corner (`assertWorksCorner`) + placement, then in a `$transaction` applies a per-type effect (guarded `updateMany` for decrements, `update` for increments, absolute set for `ADJUSTMENT`) and inserts the ledger row. Nested under the placement URL.

**Tech Stack:** NestJS 11, Prisma 7, class-validator, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-08-16-phase-6-inventory-transactions-design.md`

## Global Constraints

- **Balances live on `CompanyStoreProductStock`** (1:1, PK = FK = `companyStoreProductId`): `currentQuantity`, `reservedQuantity`, `sampleQuantity`, `damagedQuantity`. `CompanyStoreProduct` keeps only config (`targetStockQuantity`, `isActive`, `description`).
- **Atomic write:** `prisma.$transaction`; every decrement is a **guarded `updateMany`** (`where: { companyStoreProductId, [field]: { gte: q } }`) → `count === 0` throws **409**. Ledger insert is in the same transaction.
- **ADJUSTMENT** sets `currentQuantity` to the entered value (absolute); every other type is a signed delta (`q ≥ 1`, else 400).
- **17 types** driven by the `EFFECTS` map; `reservedQuantity` is untouched this phase.
- **Auth:** writes → `corners.assertWorksCorner(caller, cornerId)`; reads → `corners.findOne`. Placement resolved scoped to `cornerId` + `deletedAt: null` → 404.
- **Ledger is append-only:** create + read only.
- **Permissions:** `transactions.{create,read}` → OWNER/MANAGER/STAFF (write row-fenced by `assertWorksCorner`); +2 → **35**.
- **Ids:** `cornerId` UUID (`ParseUUIDPipe`); `placementId` int (`ParseIntPipe`).

---

## Task 1: Data model — split balances + enum + permissions

**Files:**
- Modify: `prisma/schema.prisma` (split `CompanyStoreProduct`; new `CompanyStoreProductStock`; +3 enum values)
- Create: migration `prisma/migrations/<ts>_inventory_stock_split_and_types/`
- Modify: `prisma/seed.ts` (2 permissions + grants)

**Interfaces (Produces):** `CompanyStoreProductStock` (1:1, `companyStoreProductId` PK); `InventoryTransactionType` += `CUSTOMER_RETURN`/`CUSTOMER_DAMAGED_RETURN`/`BREAKAGE`; permission codes `transactions.*`.

- [ ] **Step 1: Edit `schema.prisma`** — remove the three balance columns from `CompanyStoreProduct`, add the `stock` relation, add the new model, and per spec §3 add the three enum values (with `///` doc comments — copy the commented block from spec §3):

```prisma
model CompanyStoreProduct {
  // ... keep: id, companyStoreId, productId, isActive, description, targetStockQuantity,
  //           createdAt, updatedAt, deletedAt, deletedByUserId, relations, indexes ...
  // REMOVE these three lines:
  //   sampleQuantity   Int @default(0) @map("sample_quantity")
  //   reservedQuantity Int @default(0) @map("reserved_quantity")
  //   currentQuantity  Int @default(0) @map("current_quantity")
  stock CompanyStoreProductStock?
}

model CompanyStoreProductStock {
  companyStoreProductId Int      @id @map("company_store_product_id")
  currentQuantity       Int      @default(0) @map("current_quantity")
  reservedQuantity      Int      @default(0) @map("reserved_quantity")
  sampleQuantity        Int      @default(0) @map("sample_quantity")
  damagedQuantity       Int      @default(0) @map("damaged_quantity")
  updatedAt             DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId], references: [id])

  @@map("company_store_product_stocks")
}
```

- [ ] **Step 2: Migrate** — `npx prisma migrate dev --name inventory_stock_split_and_types`. *(Developer runs — Prisma AI-guard blocks me. The dropped columns held no real data; `migrate reset` regenerates the dev DB.)*
- [ ] **Step 3: Add permissions to `seed.ts`** — append to `PERMISSIONS` and each role array:

```ts
// PERMISSIONS: append
{ code: 'transactions.create', name: 'Create inventory transactions' },
{ code: 'transactions.read',   name: 'Read inventory transactions' },

// ROLE_PERMISSIONS: append to OWNER, MANAGER, and STAFF
'transactions.create', 'transactions.read',
```

- [ ] **Step 4: Re-seed + verify** — `npm run seed`; `docker compose exec postgres psql ... -c "\d company_store_product_stocks"` exists and `company_store_products` no longer has `current_quantity`; permission count is **35**.
- [ ] **Step 5: Commit** — `git add prisma/ && git commit -m "feat(db): split stock into 1:1 table + inventory transaction types + permissions"`

---

## Task 2: Phase 5 retrofit — placements create the stock row, reads include it

**Files:**
- Modify: `src/placements/placements.service.ts` (create nested stock; reads `include: { stock }`)
- Test: `src/placements/placements.service.spec.ts` (update moved-field assertions)

**Interfaces (Consumes):** `CompanyStoreProductStock` from Task 1.

- [ ] **Step 1: Teach + edit `create`** — the insert branch nested-creates the zeroed stock row (the revive branch is unchanged — a revived placement already has its stock row):

```ts
return this.prisma.companyStoreProduct.create({
  data: { ...fields, companyStoreId: cornerId, productId, stock: { create: {} } },
});
```

- [ ] **Step 2: Edit the reads** — `findAll` and the private `getPlacement` add `include: { stock: true }` so the API returns quantities:

```ts
// findAll
return this.prisma.companyStoreProduct.findMany({
  where: { companyStoreId: cornerId, deletedAt: null },
  include: { stock: true },
});
// getPlacement
const placement = await this.prisma.companyStoreProduct.findFirst({
  where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
  include: { stock: true },
});
```

- [ ] **Step 3: Update the placements spec** — the create test's expected `data` now carries `stock: { create: {} }`, and the `findOne` lookup carries `include: { stock: true }`:

```ts
// create — "places a product ..." test:
expect(prisma.companyStoreProduct.create).toHaveBeenCalledWith({
  data: { targetStockQuantity: 5, companyStoreId: 'corner-1', productId: 'prod-1', stock: { create: {} } },
});
// findOne — "404s ... scoped" test:
expect(prisma.companyStoreProduct.findFirst).toHaveBeenCalledWith({
  where: { id: 9, companyStoreId: 'corner-1', deletedAt: null },
  include: { stock: true },
});
```

- [ ] **Step 4: Run → passes** (`npm test -- placements.service`).
- [ ] **Step 5: Commit** — `git add src/placements/ && git commit -m "refactor(placements): create + return the 1:1 stock row"`

---

## Task 3: The effect map (`inventory-effects.ts`)

**Files:**
- Create: `src/inventory/inventory-effects.ts`
- Test: `src/inventory/inventory-effects.spec.ts`

**Interfaces (Produces):** `EFFECTS: Record<InventoryTransactionType, Effect>`; `type Bucket`, `type Effect`.

- [ ] **Step 1: Write the table test** (`inventory-effects.spec.ts`):

```ts
import { EFFECTS } from './inventory-effects';
import { InventoryTransactionType } from '../generated/prisma/enums';

describe('EFFECTS', () => {
  it('maps every transaction type', () => {
    for (const t of Object.values(InventoryTransactionType)) {
      expect(EFFECTS[t]).toBeDefined();
    }
  });

  it('SALE decrements current', () => {
    expect(EFFECTS.SALE).toEqual({
      kind: 'delta', deltas: [{ field: 'currentQuantity', sign: -1 }], primary: 'currentQuantity',
    });
  });

  it('BREAKAGE moves current -> damaged (primary = current)', () => {
    expect(EFFECTS.BREAKAGE).toEqual({
      kind: 'delta',
      deltas: [{ field: 'currentQuantity', sign: -1 }, { field: 'damagedQuantity', sign: 1 }],
      primary: 'currentQuantity',
    });
  });

  it('ADJUSTMENT is an absolute set on current', () => {
    expect(EFFECTS.ADJUSTMENT).toEqual({ kind: 'set', field: 'currentQuantity' });
  });
});
```

- [ ] **Step 2: Run → fails** (`npm test -- inventory-effects`).
- [ ] **Step 3: Implement** (`inventory-effects.ts`):

```ts
import { InventoryTransactionType } from '../generated/prisma/enums';

export type Bucket = 'currentQuantity' | 'sampleQuantity' | 'damagedQuantity';
export type Effect =
  | { kind: 'delta'; deltas: { field: Bucket; sign: 1 | -1 }[]; primary: Bucket }
  | { kind: 'set'; field: 'currentQuantity' };

const cur: Bucket = 'currentQuantity';
const smp: Bucket = 'sampleQuantity';
const dmg: Bucket = 'damagedQuantity';
const inc = (f: Bucket): Effect => ({ kind: 'delta', deltas: [{ field: f, sign: 1 }], primary: f });
const dec = (f: Bucket): Effect => ({ kind: 'delta', deltas: [{ field: f, sign: -1 }], primary: f });

export const EFFECTS: Record<InventoryTransactionType, Effect> = {
  INITIAL_STOCK: inc(cur),
  RESTOCK: inc(cur),
  TRANSFER_IN: inc(cur),
  CUSTOMER_RETURN: inc(cur),
  SALE: dec(cur),
  TRANSFER_OUT: dec(cur),
  RETURN: dec(cur),
  ADJUSTMENT: { kind: 'set', field: cur },
  CUSTOMER_DAMAGED_RETURN: inc(dmg),
  BREAKAGE: { kind: 'delta', deltas: [{ field: cur, sign: -1 }, { field: dmg, sign: 1 }], primary: cur },
  DAMAGED_DISPOSAL: dec(dmg),
  DAMAGED_RETURN: dec(dmg),
  SAMPLE_ALLOCATION: { kind: 'delta', deltas: [{ field: cur, sign: -1 }, { field: smp, sign: 1 }], primary: cur },
  SAMPLE_TRANSFER_IN: inc(smp),
  SAMPLE_TRANSFER_OUT: dec(smp),
  SAMPLE_RETURN: dec(smp),
  SAMPLE_DISPOSAL: dec(smp),
};
```
(The `Record<InventoryTransactionType, Effect>` type makes a missing type a compile error — the table test is belt-and-suspenders.)

- [ ] **Step 4: Run → passes** (`npm test -- inventory-effects`).
- [ ] **Step 5: Commit** — `git add src/inventory/inventory-effects.* && git commit -m "feat(inventory): transaction effect map"`

---

## Task 4: `InventoryService` — the atomic engine

**Files:**
- Create: `src/inventory/inventory.service.ts`, `src/inventory/dto/create-transaction.dto.ts`
- Test: `src/inventory/inventory.service.spec.ts`

**Interfaces (Consumes):** `EFFECTS` (Task 3), `CornersService.assertWorksCorner`/`findOne`.
**Interfaces (Produces):** `record(caller, cornerId, placementId, dto, source?)`, `findForPlacement(caller, cornerId, placementId)`.

- [ ] **Step 1: DTO** (`dto/create-transaction.dto.ts`):

```ts
import { IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { InventoryTransactionType } from '../../generated/prisma/enums';

export class CreateTransactionDto {
  @IsEnum(InventoryTransactionType) transactionType!: InventoryTransactionType;
  @IsInt() @Min(0) quantity!: number;
  @IsOptional() @IsString() remarks?: string;
}
```

- [ ] **Step 2: Write the tests** (`inventory.service.spec.ts`):

```ts
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('InventoryService', () => {
  let service: InventoryService;
  let prisma: any;
  let corners: { assertWorksCorner: jest.Mock; findOne: jest.Mock };
  let tx: any;

  const owner: AuthUser = {
    id: 'owner-1', companyId: 'company-1', roleId: 2, roleCode: 'OWNER', status: UserStatus.ACTIVE,
  };
  const PLACEMENT = { id: 7, companyStoreId: 'corner-1', companyId: 'company-1' };

  beforeEach(() => {
    tx = {
      companyStoreProductStock: {
        findUnique: jest.fn().mockResolvedValue({
          companyStoreProductId: 7, currentQuantity: 5, sampleQuantity: 0, damagedQuantity: 0,
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryTransaction: { create: jest.fn().mockResolvedValue({ id: 100 }) },
    };
    prisma = {
      companyStoreProduct: { findFirst: jest.fn().mockResolvedValue(PLACEMENT) },
      inventoryTransaction: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    corners = {
      assertWorksCorner: jest.fn().mockResolvedValue(PLACEMENT),
      findOne: jest.fn().mockResolvedValue({ id: 'corner-1' }),
    };
    service = new InventoryService(prisma, corners as any);
  });

  it('SALE decrements current with a guarded updateMany and records before/after', async () => {
    await service.record(owner, 'corner-1', 7, { transactionType: 'SALE', quantity: 2 } as any);

    expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, 'corner-1');
    expect(tx.companyStoreProductStock.updateMany).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7, currentQuantity: { gte: 2 } },
      data: { currentQuantity: { decrement: 2 } },
    });
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        companyStoreProductId: 7, transactionType: 'SALE', quantity: 2,
        quantityBefore: 5, quantityAfter: 3, createdByUserId: 'owner-1',
        sourceType: null, sourceId: null,
      }),
    });
  });

  it('409s when a decrement finds insufficient stock (updateMany count 0)', async () => {
    tx.companyStoreProductStock.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.record(owner, 'corner-1', 7, { transactionType: 'SALE', quantity: 99 } as any),
    ).rejects.toThrow(ConflictException);
    expect(tx.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('RESTOCK increments current', async () => {
    await service.record(owner, 'corner-1', 7, { transactionType: 'RESTOCK', quantity: 4 } as any);
    expect(tx.companyStoreProductStock.update).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7 },
      data: { currentQuantity: { increment: 4 } },
    });
  });

  it('ADJUSTMENT sets current to the counted total', async () => {
    await service.record(owner, 'corner-1', 7, { transactionType: 'ADJUSTMENT', quantity: 12 } as any);
    expect(tx.companyStoreProductStock.update).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7 },
      data: { currentQuantity: 12 },
    });
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ quantityBefore: 5, quantityAfter: 12 }),
    });
  });

  it('BREAKAGE decrements current (guarded) and increments damaged', async () => {
    await service.record(owner, 'corner-1', 7, { transactionType: 'BREAKAGE', quantity: 1 } as any);
    expect(tx.companyStoreProductStock.updateMany).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7, currentQuantity: { gte: 1 } },
      data: { currentQuantity: { decrement: 1 } },
    });
    expect(tx.companyStoreProductStock.update).toHaveBeenCalledWith({
      where: { companyStoreProductId: 7 },
      data: { damagedQuantity: { increment: 1 } },
    });
  });

  it('rejects quantity < 1 for a movement type (400)', async () => {
    await expect(
      service.record(owner, 'corner-1', 7, { transactionType: 'SALE', quantity: 0 } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('404s an absent placement', async () => {
    prisma.companyStoreProduct.findFirst.mockResolvedValue(null);
    await expect(
      service.record(owner, 'corner-1', 7, { transactionType: 'SALE', quantity: 1 } as any),
    ).rejects.toThrow(NotFoundException);
  });
});
```

- [ ] **Step 3: Run → fails** (`npm test -- inventory.service`).
- [ ] **Step 4: Implement** (`inventory.service.ts`):

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { EFFECTS } from './inventory-effects';
import { TransactionSourceType } from '../generated/prisma/enums';

type Source = { type: TransactionSourceType; id: string };

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
  ) {}

  async record(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
    dto: CreateTransactionDto,
    source?: Source,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId); // 404 / 403
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');

    const effect = EFFECTS[dto.transactionType];
    const q = dto.quantity;
    if (effect.kind !== 'set' && q < 1)
      throw new BadRequestException('Quantity must be at least 1');

    return this.prisma.$transaction(async (tx) => {
      const stock = await tx.companyStoreProductStock.findUnique({
        where: { companyStoreProductId: placementId },
      });
      if (!stock) throw new NotFoundException('Stock not found');

      let quantityBefore: number;
      let quantityAfter: number;

      if (effect.kind === 'set') {
        quantityBefore = stock.currentQuantity;
        quantityAfter = q;
        await tx.companyStoreProductStock.update({
          where: { companyStoreProductId: placementId },
          data: { currentQuantity: q },
        });
      } else {
        quantityBefore = stock[effect.primary];
        for (const { field, sign } of effect.deltas) {
          if (sign === -1) {
            const { count } = await tx.companyStoreProductStock.updateMany({
              where: { companyStoreProductId: placementId, [field]: { gte: q } },
              data: { [field]: { decrement: q } },
            });
            if (count === 0) throw new ConflictException('Insufficient stock');
          } else {
            await tx.companyStoreProductStock.update({
              where: { companyStoreProductId: placementId },
              data: { [field]: { increment: q } },
            });
          }
        }
        const primarySign = effect.deltas.find((d) => d.field === effect.primary)!.sign;
        quantityAfter = quantityBefore + primarySign * q;
      }

      return tx.inventoryTransaction.create({
        data: {
          companyStoreProductId: placementId,
          transactionType: dto.transactionType,
          quantity: q,
          quantityBefore,
          quantityAfter,
          remarks: dto.remarks ?? null,
          createdByUserId: caller.id,
          sourceType: source?.type ?? null,
          sourceId: source?.id ?? null,
        },
      });
    });
  }

  async findForPlacement(caller: AuthUser, cornerId: string, placementId: number) {
    await this.corners.findOne(caller, cornerId); // read scope → 404
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');
    return this.prisma.inventoryTransaction.findMany({
      where: { companyStoreProductId: placementId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
```

- [ ] **Step 5: Run → passes** (`npm test -- inventory.service`).
- [ ] **Step 6: Commit** — `git add src/inventory/ && git commit -m "feat(inventory): atomic transaction engine (record + history)"`

---

## Task 5: `InventoryModule` + controller + wiring

**Files:**
- Create: `src/inventory/inventory.controller.ts`, `src/inventory/inventory.module.ts`
- Modify: `src/app.module.ts` (register `InventoryModule`)

- [ ] **Step 1: Controller** (`inventory.controller.ts`):

```ts
import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Post } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateTransactionDto } from './dto/create-transaction.dto';

@Controller('corners/:cornerId/products/:placementId/transactions')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @RequirePermissions('transactions.read') @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
  ) {
    return this.inventory.findForPlacement(caller, cornerId, placementId);
  }

  @RequirePermissions('transactions.create') @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.inventory.record(caller, cornerId, placementId, dto);
  }
}
```

- [ ] **Step 2: Module + register** (`inventory.module.ts`, then add to `app.module.ts` imports):

```ts
import { Module } from '@nestjs/common';
import { CornersModule } from '../corners/corners.module';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [CornersModule],
  providers: [InventoryService],
  controllers: [InventoryController],
  exports: [InventoryService],
})
export class InventoryModule {}
```

- [ ] **Step 3: Run → passes** (`npm test` full suite) + confirm `CornersModule` exports `CornersService` (it does, Phase 5) so DI boots.
- [ ] **Step 4: Commit** — `git add src/inventory/ src/app.module.ts && git commit -m "feat(inventory): nested transactions endpoints + module wiring"`

---

## Task 6: e2e — inventory flow

**Files:**
- Create: `test/inventory.e2e-spec.ts`

- [ ] **Step 1: Write the e2e** (reuse `registerCompany`/`registerMember` from `test/placements.e2e-spec.ts`; distinct `@inv.test` / `5x0-…` ids). Setup: company + a corner + a placement (via Phase 3–5 endpoints), an assigned STAFF, and a second (unrelated) MANAGER. Then:

```ts
it('RESTOCK raises current; SALE lowers it; the ledger lists both', async () => {
  await request(http).post(base).set(...auth(ownerAccess)).send({ transactionType: 'RESTOCK', quantity: 10 }).expect(201);
  await request(http).post(base).set(...auth(ownerAccess)).send({ transactionType: 'SALE', quantity: 3 }).expect(201);
  const shelf = await request(http).get(`/corners/${cornerId}/products/${placementId}`).set(...auth(ownerAccess)).expect(200);
  expect(shelf.body.stock.currentQuantity).toBe(7);
  const ledger = await request(http).get(base).set(...auth(ownerAccess)).expect(200);
  expect(ledger.body.length).toBe(2);
});

it('overselling is 409 and leaves the balance unchanged', async () => {
  await request(http).post(base).set(...auth(ownerAccess)).send({ transactionType: 'SALE', quantity: 999 }).expect(409);
  const shelf = await request(http).get(`/corners/${cornerId}/products/${placementId}`).set(...auth(ownerAccess)).expect(200);
  expect(shelf.body.stock.currentQuantity).toBe(7);
});

it('ADJUSTMENT sets current to the counted total', async () => {
  await request(http).post(base).set(...auth(ownerAccess)).send({ transactionType: 'ADJUSTMENT', quantity: 5 }).expect(201);
  const shelf = await request(http).get(`/corners/${cornerId}/products/${placementId}`).set(...auth(ownerAccess)).expect(200);
  expect(shelf.body.stock.currentQuantity).toBe(5);
});

it('BREAKAGE moves current -> damaged (total unchanged)', async () => {
  await request(http).post(base).set(...auth(ownerAccess)).send({ transactionType: 'BREAKAGE', quantity: 2 }).expect(201);
  const shelf = await request(http).get(`/corners/${cornerId}/products/${placementId}`).set(...auth(ownerAccess)).expect(200);
  expect(shelf.body.stock.currentQuantity).toBe(3);
  expect(shelf.body.stock.damagedQuantity).toBe(2);
});

it('an assigned STAFF records a SALE; a foreign MANAGER is 403', async () => {
  await request(http).post(base).set(...auth(staffAccess)).send({ transactionType: 'SALE', quantity: 1 }).expect(201);
  await request(http).post(base).set(...auth(otherManagerAccess)).send({ transactionType: 'SALE', quantity: 1 }).expect(403);
});

it("company 2 cannot post to company 1's placement (404)", async () => {
  await request(http).post(base).set(...auth(owner2Access)).send({ transactionType: 'SALE', quantity: 1 }).expect(404);
});
```
where `const base = \`/corners/${cornerId}/products/${placementId}/transactions\`;`.

- [ ] **Step 2: Run the e2e** — `npm run test:e2e`. *(Developer runs — Prisma AI-guard blocks the reset.)*
- [ ] **Step 3: Fix failures, then commit** — `git add test/inventory.e2e-spec.ts && git commit -m "test(inventory): e2e stock movements, oversell 409, adjustment, breakage, auth"`

---

## Self-Review (spec coverage)

- Spec §2 decisions #1–#11 → Task 1 (split, buckets, permissions), Task 3 (effect map), Task 4 (atomicity, 409, ADJUSTMENT set, immutable ledger, `record(...source?)`), Task 5 (nested API, auth). ✓
- §3 schema + §3a Phase 5 retrofit → Tasks 1–2. §4 effect map → Task 3. §5 atomic write → Task 4. §7 endpoints → Task 5. §8 auth → Task 4/5. §9 permissions → Task 1. §10 errors → 400/403/404/409 across Tasks 4 + 6. §11 testing → each task + Task 6. ✓
- Type consistency: `EFFECTS: Record<InventoryTransactionType, Effect>`; `record(caller, cornerId, placementId, dto, source?)` matches controller + tests; stock keyed by `companyStoreProductId`; `InventoryTransaction.companyStoreProductId` = placement id. ✓
- Ordering: decrement deltas run before increments within a type (guard first) — `BREAKAGE`/`SAMPLE_ALLOCATION` list `current −` before the `+` sibling. ✓
