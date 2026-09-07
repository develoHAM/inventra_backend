# Phase 9 — Purchase Reservations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add customer **purchase reservations** — hold stock of one placement (`available → reserved`) on create, convert the hold to a `SALE` on fulfill, release it on cancel — extending the Phase 6 effect map to the `reserved` bucket.

**Architecture:** A new `ReservationsModule` (placement-nested controller + service). Every stock move runs through `InventoryService.recordWithinTransaction(tx, …)` inside one `$transaction` per action, `source = RESERVATION`. Fulfill = `RESERVATION_RELEASE` + `SALE` (every purchase is a `SALE`). Reservations use status transitions, not soft-delete.

**Tech Stack:** NestJS 11, Prisma 7 (client in `src/generated/prisma`), PostgreSQL, class-validator, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-09-07-phase-9-purchase-reservations-design.md`

## Global Constraints

- **Import from `../generated/prisma/*`** (enums from `.../enums`), never `@prisma/client`.
- **Two-layer authz:** `@RequirePermissions(...)` + `CornersService` (writes → `assertWorksCorner`, reads → `findOne`).
- **Fetch-then-decide:** row-or-null lookups; the service decides 400/403/404/409.
- **Hold on create; all-or-nothing.** Reserve holds the full quantity; fulfill/cancel act on the whole `reservedQuantity`. Status starts `RESERVED`.
- **Fulfill = `RESERVATION_RELEASE` + `SALE`** (both `source = RESERVATION`); cancel = `RESERVATION_RELEASE`.
- **No soft-delete** on reservations (terminal statuses instead). `expiresAt` stored, auto-sweep deferred.
- **Claude cannot run `prisma migrate` or `npm run test:e2e`** — a human runs those. Claude runs `npm test`, `npm run seed`, `npm run build`.
- **`recordWithinTransaction(tx, placementId, dto, callerId, source?)`** already exists (Phase 8). `dto` is `{ transactionType, quantity, remarks? }`.
- **`PurchaseReservation` PK is a single `id`** (uuid) — `update`/`findUnique` by `{ id }` directly (no compound key).

---

## File Structure

- `prisma/schema.prisma` — **modify**: 2 enum values on `InventoryTransactionType`; `createdByUserId` + relation on `PurchaseReservation`; `User` back-relation.
- `prisma/migrations/<new>/migration.sql` — **human-generated**: the enum values + `created_by_user_id` column/FK.
- `prisma/seed.ts` — **modify**: 4 `reservations.*` permissions + grants (44 → 48).
- `src/inventory/inventory-effects.ts` — **modify**: widen `Bucket`, add `RESERVE` + `RESERVATION_RELEASE`.
- `src/inventory/inventory-effects.spec.ts` — **modify (tests)**: assert the two new effects.
- `src/reservations/dto/create-reservation.dto.ts`, `cancel-reservation.dto.ts` — **create**.
- `src/reservations/reservations.service.ts` — **create**.
- `src/reservations/reservations.service.spec.ts` — **create (tests)**.
- `src/reservations/reservations.controller.ts`, `reservations.module.ts` — **create**.
- `src/app.module.ts` — **modify**: register `ReservationsModule`.
- `test/reservations.e2e-spec.ts` — **create (tests)**.

---

## Task 1: Data model + effect map + permissions

Enum values and the effect map ship **together**: `EFFECTS` is a compiler-enforced total `Record<InventoryTransactionType, Effect>`, so adding enum values without the matching effects fails the build. This task ends green.

**Files:**
- Modify: `prisma/schema.prisma`, `prisma/seed.ts`, `src/inventory/inventory-effects.ts`
- Test: `src/inventory/inventory-effects.spec.ts`
- Human-generated: `prisma/migrations/<timestamp>_reservations_reserve_types_created_by/migration.sql`

**Interfaces:**
- Produces: `InventoryTransactionType.RESERVE` / `.RESERVATION_RELEASE`; `Bucket` includes `'reservedQuantity'`; `EFFECTS.RESERVE` / `.RESERVATION_RELEASE`; `PurchaseReservation.createdByUserId`; permissions `reservations.{create,read,fulfill,cancel}`.

- [ ] **Step 1: Edit `prisma/schema.prisma` — two enum values**

At the end of the `InventoryTransactionType` enum (before `@@map`):
```prisma
  /// Stock held for a customer reservation. available -q, reserved +q.
  RESERVE
  /// A reservation hold is released back to sellable. reserved -q, available +q.
  RESERVATION_RELEASE
```

- [ ] **Step 2: Edit `prisma/schema.prisma` — reservation creator**

In `model PurchaseReservation`, add the field and relation:
```prisma
  createdByUserId String @map("created_by_user_id") @db.Uuid

  companyStoreProduct CompanyStoreProduct @relation(fields: [companyStoreProductId, companyStoreId], references: [id, companyStoreId])
  createdByUser       User @relation("ReservationsCreatedBy", fields: [createdByUserId], references: [id])
```
And in `model User`, add the back-relation (near the other `created*` relations):
```prisma
  createdReservations PurchaseReservation[] @relation("ReservationsCreatedBy")
```

- [ ] **Step 3: Human applies the migration**

```bash
npx prisma migrate dev --name reservations_reserve_types_created_by
```
This regenerates the client (new enum values). **Build is now red** until Step 5 — expected. Verify the column:
```bash
docker compose exec -T postgres psql -U inventra -d inventra -c "\d purchase_reservations" | grep created_by
```

- [ ] **Step 4: Add the effect-map spec assertions** (`src/inventory/inventory-effects.spec.ts`)

Add two tests inside the `describe('EFFECTS', …)` block:
```ts
  it('RESERVE moves available -> reserved, primary = available (guarded side)', () => {
    expect(EFFECTS.RESERVE).toEqual({
      kind: 'delta',
      deltas: [
        { field: 'availableQuantity', sign: -1 },
        { field: 'reservedQuantity', sign: 1 },
      ],
      primaryBucket: 'availableQuantity',
    });
  });

  it('RESERVATION_RELEASE moves reserved -> available, primary = reserved', () => {
    expect(EFFECTS.RESERVATION_RELEASE).toEqual({
      kind: 'delta',
      deltas: [
        { field: 'reservedQuantity', sign: -1 },
        { field: 'availableQuantity', sign: 1 },
      ],
      primaryBucket: 'reservedQuantity',
    });
  });
```
And extend the "decrement first" loop to cover them:
```ts
    for (const t of ['BREAKAGE', 'SAMPLE_ALLOCATION', 'RESERVE', 'RESERVATION_RELEASE'] as const) {
```

- [ ] **Step 5: Extend `src/inventory/inventory-effects.ts`**

Widen the `Bucket` type and add the `reservedQuantity` const:
```ts
export type Bucket =
  | 'availableQuantity'
  | 'reservedQuantity'
  | 'sampleQuantity'
  | 'damagedQuantity';

const availableQuantity: Bucket = 'availableQuantity';
const reservedQuantity: Bucket = 'reservedQuantity';
const sampleQuantity: Bucket = 'sampleQuantity';
const damagedQuantity: Bucket = 'damagedQuantity';
```
Add two entries to `EFFECTS` (anywhere in the record):
```ts
  RESERVE: {
    kind: 'delta',
    deltas: [
      { field: availableQuantity, sign: -1 },
      { field: reservedQuantity, sign: 1 },
    ],
    primaryBucket: availableQuantity,
  },
  RESERVATION_RELEASE: {
    kind: 'delta',
    deltas: [
      { field: reservedQuantity, sign: -1 },
      { field: availableQuantity, sign: 1 },
    ],
    primaryBucket: reservedQuantity,
  },
```

- [ ] **Step 6: Run the effect-map tests**

Run: `npm test -- inventory-effects`
Expected: PASS (existing + the 2 new; the totality and invariant tests now include the new types).

- [ ] **Step 7: Seed the four permissions** (`prisma/seed.ts`)

In `PERMISSIONS`, after `audits.apply`:
```ts
  { code: 'reservations.create', name: 'Create reservations' },
  { code: 'reservations.read', name: 'Read reservations' },
  { code: 'reservations.fulfill', name: 'Fulfill reservations' },
  { code: 'reservations.cancel', name: 'Cancel reservations' },
```
Append to each of the OWNER, MANAGER, STAFF arrays (each ends with `'audits.apply',`):
```ts
    'reservations.create',
    'reservations.read',
    'reservations.fulfill',
    'reservations.cancel',
```

- [ ] **Step 8: Reseed, verify, build**

```bash
npm run seed
docker compose exec -T postgres psql -U inventra -d inventra -tA -c "SELECT count(*) FROM permissions;"   # 48
npm run build   # green again
```

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts src/inventory/inventory-effects.ts src/inventory/inventory-effects.spec.ts
git commit -m "feat(reservations): reserved bucket + RESERVE/RESERVATION_RELEASE effects, createdBy, reservations.* perms (48)"
```

---

## Task 2: DTOs + `ReservationsService` (+ unit tests)

**Files:**
- Create: `src/reservations/dto/create-reservation.dto.ts`, `cancel-reservation.dto.ts`
- Create: `src/reservations/reservations.service.ts`
- Test: `src/reservations/reservations.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`; `CornersService.assertWorksCorner`/`findOne`; `InventoryService.recordWithinTransaction`; `AuthUser`; enums `InventoryTransactionType`, `ReservationStatus`, `TransactionSourceType`.
- Produces: `ReservationsService` with `create`, `findAll`, `findOne`, `fulfill`, `cancel`.

- [ ] **Step 1: Write the DTOs**

`src/reservations/dto/create-reservation.dto.ts`:
```ts
import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReservationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  reservedByName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  reservedByPhone?: string;

  @IsInt()
  @Min(1)
  reservedQuantity!: number;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
```

`src/reservations/dto/cancel-reservation.dto.ts`:
```ts
import { IsOptional, IsString } from 'class-validator';

export class CancelReservationDto {
  @IsOptional()
  @IsString()
  cancelReason?: string;
}
```

- [ ] **Step 2: Write the failing unit tests** (`src/reservations/reservations.service.spec.ts`)

```ts
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { AuthUser } from '../auth/types/auth-user';
import { UserStatus } from '../generated/prisma/enums';

describe('ReservationsService', () => {
  let service: ReservationsService;
  let prisma: any;
  let corners: { assertWorksCorner: jest.Mock; findOne: jest.Mock };
  let inventory: { recordWithinTransaction: jest.Mock };
  let transaction: any;

  const owner: AuthUser = {
    id: 'owner-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: UserStatus.ACTIVE,
  };
  const cornerId = '11111111-1111-1111-1111-111111111111';
  const placementId = 7;
  const reservationId = '22222222-2222-2222-2222-222222222222';

  const reservedRow = {
    id: reservationId,
    companyStoreProductId: placementId,
    companyStoreId: cornerId,
    reservedQuantity: 3,
    status: 'RESERVED',
  };

  beforeEach(() => {
    transaction = {
      purchaseReservation: {
        create: jest.fn().mockResolvedValue({ ...reservedRow }),
        update: jest.fn().mockResolvedValue({ ...reservedRow, status: 'FULFILLED' }),
      },
    };
    prisma = {
      companyStoreProduct: {
        findFirst: jest.fn().mockResolvedValue({ id: placementId, companyStoreId: cornerId }),
      },
      purchaseReservation: {
        findFirst: jest.fn().mockResolvedValue({ ...reservedRow }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(transaction)),
    };
    corners = {
      assertWorksCorner: jest.fn().mockResolvedValue({ id: cornerId, companyId: 'company-1' }),
      findOne: jest.fn().mockResolvedValue({ id: cornerId }),
    };
    inventory = { recordWithinTransaction: jest.fn().mockResolvedValue({ id: 1 }) };
    service = new ReservationsService(prisma, corners as any, inventory as any);
  });

  it('create holds stock via a guarded RESERVE and writes a RESERVED row', async () => {
    await service.create(owner, cornerId, placementId, {
      reservedByName: 'Kim',
      reservedQuantity: 3,
    } as any);

    expect(corners.assertWorksCorner).toHaveBeenCalledWith(owner, cornerId);
    const createArg = transaction.purchaseReservation.create.mock.calls[0][0];
    expect(createArg.data).toEqual(
      expect.objectContaining({
        companyStoreProductId: placementId,
        companyStoreId: cornerId,
        reservedByName: 'Kim',
        reservedQuantity: 3,
        status: 'RESERVED',
        createdByUserId: 'owner-1',
      }),
    );
    expect(inventory.recordWithinTransaction).toHaveBeenCalledWith(
      transaction,
      placementId,
      { transactionType: 'RESERVE', quantity: 3 },
      'owner-1',
      { type: 'RESERVATION', id: reservationId },
    );
  });

  it('findOne 404s an absent reservation', async () => {
    prisma.purchaseReservation.findFirst.mockResolvedValue(null);
    await expect(
      service.findOne(owner, cornerId, placementId, reservationId),
    ).rejects.toThrow(NotFoundException);
  });

  it('fulfill releases the hold then sells, and marks FULFILLED', async () => {
    await service.fulfill(owner, cornerId, placementId, reservationId);

    expect(inventory.recordWithinTransaction).toHaveBeenNthCalledWith(
      1,
      transaction,
      placementId,
      { transactionType: 'RESERVATION_RELEASE', quantity: 3 },
      'owner-1',
      { type: 'RESERVATION', id: reservationId },
    );
    expect(inventory.recordWithinTransaction).toHaveBeenNthCalledWith(
      2,
      transaction,
      placementId,
      { transactionType: 'SALE', quantity: 3 },
      'owner-1',
      { type: 'RESERVATION', id: reservationId },
    );
    expect(transaction.purchaseReservation.update).toHaveBeenCalledWith({
      where: { id: reservationId },
      data: { status: 'FULFILLED', fulfilledAt: expect.any(Date) },
    });
  });

  it('cancel releases the hold and marks CANCELLED with a reason', async () => {
    await service.cancel(owner, cornerId, placementId, reservationId, {
      cancelReason: 'no-show',
    } as any);

    expect(inventory.recordWithinTransaction).toHaveBeenCalledWith(
      transaction,
      placementId,
      { transactionType: 'RESERVATION_RELEASE', quantity: 3 },
      'owner-1',
      { type: 'RESERVATION', id: reservationId },
    );
    expect(transaction.purchaseReservation.update).toHaveBeenCalledWith({
      where: { id: reservationId },
      data: { status: 'CANCELLED', cancelledAt: expect.any(Date), cancelReason: 'no-show' },
    });
  });

  it('fulfill on a non-RESERVED reservation is 409', async () => {
    prisma.purchaseReservation.findFirst.mockResolvedValue({ ...reservedRow, status: 'FULFILLED' });
    await expect(
      service.fulfill(owner, cornerId, placementId, reservationId),
    ).rejects.toThrow(ConflictException);
    expect(inventory.recordWithinTransaction).not.toHaveBeenCalled();
  });

  it('cancel on a non-RESERVED reservation is 409', async () => {
    prisma.purchaseReservation.findFirst.mockResolvedValue({ ...reservedRow, status: 'CANCELLED' });
    await expect(
      service.cancel(owner, cornerId, placementId, reservationId, {} as any),
    ).rejects.toThrow(ConflictException);
    expect(inventory.recordWithinTransaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run — verify they fail**

Run: `npm test -- reservations.service`
Expected: FAIL — `Cannot find module './reservations.service'`.

- [ ] **Step 4: Write `src/reservations/reservations.service.ts`**

```ts
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  InventoryTransactionType,
  ReservationStatus,
  TransactionSourceType,
} from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { CornersService } from '../corners/corners.service';
import { InventoryService } from '../inventory/inventory.service';
import { AuthUser } from '../auth/types/auth-user';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { CancelReservationDto } from './dto/cancel-reservation.dto';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corners: CornersService,
    private readonly inventory: InventoryService,
  ) {}

  private async getPlacement(cornerId: string, placementId: number) {
    const placement = await this.prisma.companyStoreProduct.findFirst({
      where: { id: placementId, companyStoreId: cornerId, deletedAt: null },
    });
    if (!placement) throw new NotFoundException('Placement not found');
    return placement;
  }

  private async getReservation(
    cornerId: string,
    placementId: number,
    reservationId: string,
  ) {
    const reservation = await this.prisma.purchaseReservation.findFirst({
      where: {
        id: reservationId,
        companyStoreId: cornerId,
        companyStoreProductId: placementId,
      },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }

  async create(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
    dto: CreateReservationDto,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    await this.getPlacement(cornerId, placementId);

    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.purchaseReservation.create({
        data: {
          companyStoreProductId: placementId,
          companyStoreId: cornerId,
          reservedByName: dto.reservedByName,
          reservedByPhone: dto.reservedByPhone ?? null,
          reservedQuantity: dto.reservedQuantity,
          status: ReservationStatus.RESERVED,
          remark: dto.remark ?? null,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
          createdByUserId: caller.id,
        },
      });

      await this.inventory.recordWithinTransaction(
        tx,
        placementId,
        {
          transactionType: InventoryTransactionType.RESERVE,
          quantity: dto.reservedQuantity,
        },
        caller.id,
        { type: TransactionSourceType.RESERVATION, id: reservation.id },
      );

      return reservation;
    });
  }

  async findAll(caller: AuthUser, cornerId: string, placementId: number) {
    await this.corners.findOne(caller, cornerId);
    await this.getPlacement(cornerId, placementId);
    return this.prisma.purchaseReservation.findMany({
      where: { companyStoreId: cornerId, companyStoreProductId: placementId },
      orderBy: { reservedAt: 'desc' },
    });
  }

  async findOne(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
    reservationId: string,
  ) {
    await this.corners.findOne(caller, cornerId);
    await this.getPlacement(cornerId, placementId);
    return this.getReservation(cornerId, placementId, reservationId);
  }

  async fulfill(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
    reservationId: string,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const reservation = await this.getReservation(
      cornerId,
      placementId,
      reservationId,
    );
    if (reservation.status !== ReservationStatus.RESERVED)
      throw new ConflictException('Reservation is not active');

    return this.prisma.$transaction(async (tx) => {
      await this.inventory.recordWithinTransaction(
        tx,
        placementId,
        {
          transactionType: InventoryTransactionType.RESERVATION_RELEASE,
          quantity: reservation.reservedQuantity,
        },
        caller.id,
        { type: TransactionSourceType.RESERVATION, id: reservation.id },
      );
      await this.inventory.recordWithinTransaction(
        tx,
        placementId,
        {
          transactionType: InventoryTransactionType.SALE,
          quantity: reservation.reservedQuantity,
        },
        caller.id,
        { type: TransactionSourceType.RESERVATION, id: reservation.id },
      );
      return tx.purchaseReservation.update({
        where: { id: reservationId },
        data: { status: ReservationStatus.FULFILLED, fulfilledAt: new Date() },
      });
    });
  }

  async cancel(
    caller: AuthUser,
    cornerId: string,
    placementId: number,
    reservationId: string,
    dto: CancelReservationDto,
  ) {
    await this.corners.assertWorksCorner(caller, cornerId);
    const reservation = await this.getReservation(
      cornerId,
      placementId,
      reservationId,
    );
    if (reservation.status !== ReservationStatus.RESERVED)
      throw new ConflictException('Reservation is not active');

    return this.prisma.$transaction(async (tx) => {
      await this.inventory.recordWithinTransaction(
        tx,
        placementId,
        {
          transactionType: InventoryTransactionType.RESERVATION_RELEASE,
          quantity: reservation.reservedQuantity,
        },
        caller.id,
        { type: TransactionSourceType.RESERVATION, id: reservation.id },
      );
      return tx.purchaseReservation.update({
        where: { id: reservationId },
        data: {
          status: ReservationStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: dto.cancelReason ?? null,
        },
      });
    });
  }
}
```

- [ ] **Step 5: Run the unit tests — all green**

Run: `npm test -- reservations.service`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/reservations/dto src/reservations/reservations.service.ts src/reservations/reservations.service.spec.ts
git commit -m "feat(reservations): ReservationsService (hold on create, fulfill=release+sale, cancel)"
```

---

## Task 3: Controller + module + app wiring

**Files:**
- Create: `src/reservations/reservations.controller.ts`, `src/reservations/reservations.module.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `ReservationsService` (Task 2); `CornersModule`, `InventoryModule`.
- Produces: routes under `/corners/:cornerId/products/:placementId/reservations`; `ReservationsModule`.

- [ ] **Step 1: Write `src/reservations/reservations.controller.ts`**

```ts
import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { RequirePermissions } from '../authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/types/auth-user';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { CancelReservationDto } from './dto/cancel-reservation.dto';

@Controller('corners/:cornerId/products/:placementId/reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @RequirePermissions('reservations.read')
  @Get()
  findAll(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
  ) {
    return this.reservations.findAll(caller, cornerId, placementId);
  }

  @RequirePermissions('reservations.read')
  @Get(':reservationId')
  findOne(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.findOne(caller, cornerId, placementId, reservationId);
  }

  @RequirePermissions('reservations.create')
  @Post()
  create(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Body() dto: CreateReservationDto,
  ) {
    return this.reservations.create(caller, cornerId, placementId, dto);
  }

  @RequirePermissions('reservations.fulfill')
  @Post(':reservationId/fulfill')
  fulfill(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
  ) {
    return this.reservations.fulfill(caller, cornerId, placementId, reservationId);
  }

  @RequirePermissions('reservations.cancel')
  @Post(':reservationId/cancel')
  cancel(
    @CurrentUser() caller: AuthUser,
    @Param('cornerId', ParseUUIDPipe) cornerId: string,
    @Param('placementId', ParseIntPipe) placementId: number,
    @Param('reservationId', ParseUUIDPipe) reservationId: string,
    @Body() dto: CancelReservationDto,
  ) {
    return this.reservations.cancel(caller, cornerId, placementId, reservationId, dto);
  }
}
```

- [ ] **Step 2: Write `src/reservations/reservations.module.ts`**

```ts
import { Module } from '@nestjs/common';
import { CornersModule } from '../corners/corners.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';

@Module({
  imports: [CornersModule, InventoryModule],
  providers: [ReservationsService],
  controllers: [ReservationsController],
  exports: [ReservationsService],
})
export class ReservationsModule {}
```

- [ ] **Step 3: Register `ReservationsModule` in `src/app.module.ts`**

Add the import and place `ReservationsModule` in the `imports` array (after `AuditsModule`):
```ts
import { ReservationsModule } from './reservations/reservations.module';
```

- [ ] **Step 4: Build (DI + types)**

Run: `npm run build`
Expected: exits 0 (`ReservationsModule` imports `CornersModule` + `InventoryModule`).

- [ ] **Step 5: Full unit suite**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 6: Commit**

```bash
git add src/reservations/reservations.controller.ts src/reservations/reservations.module.ts src/app.module.ts
git commit -m "feat(reservations): placement-nested controller (create/read/fulfill/cancel) + wiring"
```

---

## Task 4: e2e — the reservation flow

**Files:**
- Create: `test/reservations.e2e-spec.ts`

**Interfaces:**
- Consumes: the running app + seeded permissions.

- [ ] **Step 1: Write the e2e** (reuse the `registerCompany`/`registerMember`/`placeProduct` helper shapes from `test/audits.e2e-spec.ts`; distinct `@rsv.test` emails, `2x0-…` tax ids, `RSV-…` barcodes). Setup: company 1 owner + assigned staff + unrelated manager; a corner with the staff assigned; one placement restocked to a known available; company 2 owner.

`test/reservations.e2e-spec.ts`:
```ts
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Purchase Reservations (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let http: any;

  let adminAccess: string;
  let ownerAccess: string;
  let staffAccess: string;
  let otherManagerAccess: string;
  let owner2Access: string;

  let cornerId: string;
  let placementId: number;

  let managerUserId: string;
  let staffUserId: string;

  const auth = (token: string): [string, string] => [
    'Authorization',
    `Bearer ${token}`,
  ];

  const registerCompany = async (n: number) => {
    const taxId = `2${n}0-00-0000${n}`;
    const email = `owner${n}@rsv.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register')
      .send({
        companyName: `RSV Co ${n}`,
        taxId,
        ownerName: `Owner ${n}`,
        ownerEmail: email,
        ownerPassword: password,
      })
      .expect(201);
    const company = await prisma.company.findUnique({ where: { taxId } });
    await request(http)
      .patch(`/companies/${company!.id}/approve`)
      .set(...auth(adminAccess))
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return {
      access: login.body.accessToken as string,
      joinCode: company!.joinCode as string,
    };
  };

  const registerMember = async (
    joinCode: string,
    ownerToken: string,
    roleCode: string,
    tag: string,
  ) => {
    const email = `${tag}@rsv.test`;
    const password = 'password123';
    await request(http)
      .post('/auth/register/member')
      .send({ joinCode, email, password, name: tag })
      .expect(201);
    const user = await prisma.user.findFirst({
      where: { loginMethods: { some: { email } } },
    });
    const role = await prisma.role.findUnique({ where: { code: roleCode } });
    await request(http)
      .patch(`/users/${user!.id}/approve`)
      .set(...auth(ownerToken))
      .send({ roleId: role!.id })
      .expect(200);
    const login = await request(http)
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    return {
      access: login.body.accessToken as string,
      userId: user!.id as string,
    };
  };

  const stockOf = async (): Promise<{ available: number; reserved: number }> => {
    const res = await request(http)
      .get(`/corners/${cornerId}/products/${placementId}`)
      .set(...auth(ownerAccess))
      .expect(200);
    return {
      available: res.body.stock.availableQuantity,
      reserved: res.body.stock.reservedQuantity,
    };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    prisma = app.get(PrismaService);
    http = app.getHttpServer();

    const adminLogin = await request(http)
      .post('/auth/login')
      .send({
        email: process.env.SEED_ADMIN_EMAIL,
        password: process.env.SEED_ADMIN_PASSWORD,
      })
      .expect(201);
    adminAccess = adminLogin.body.accessToken;

    const company1 = await registerCompany(1);
    ownerAccess = company1.access;
    const manager = await registerMember(company1.joinCode, ownerAccess, 'MANAGER', 'manager');
    managerUserId = manager.userId;
    const staff = await registerMember(company1.joinCode, ownerAccess, 'STAFF', 'staff');
    staffAccess = staff.access;
    staffUserId = staff.userId;
    const otherManager = await registerMember(company1.joinCode, ownerAccess, 'MANAGER', 'othermgr');
    otherManagerAccess = otherManager.access;

    const storeId = (
      await request(http)
        .post('/stores')
        .set(...auth(adminAccess))
        .send({ name: 'RSV Store' })
        .expect(201)
    ).body.id;
    cornerId = (
      await request(http)
        .post('/corners')
        .set(...auth(ownerAccess))
        .send({ storeId, name: 'RSV Corner' })
        .expect(201)
    ).body.id;
    await request(http)
      .post(`/corners/${cornerId}/staff`)
      .set(...auth(ownerAccess))
      .send({ userId: staffUserId })
      .expect(201);

    const categoryId = (
      await request(http)
        .post('/categories')
        .set(...auth(adminAccess))
        .send({ name: 'RSV Cat' })
        .expect(201)
    ).body.id;
    const brandId = (
      await request(http)
        .post('/brands')
        .set(...auth(ownerAccess))
        .send({ name: 'RSV Brand' })
        .expect(201)
    ).body.id;
    const productId = (
      await request(http)
        .post('/products')
        .set(...auth(ownerAccess))
        .send({ name: 'RSV P1', barcode: 'RSV-BC-1', categoryId, brandId, priceKrw: 1000 })
        .expect(201)
    ).body.id;
    placementId = (
      await request(http)
        .post(`/corners/${cornerId}/products`)
        .set(...auth(ownerAccess))
        .send({ productId, targetStockQuantity: 10 })
        .expect(201)
    ).body.id;
    await request(http)
      .post(`/corners/${cornerId}/products/${placementId}/transactions`)
      .set(...auth(ownerAccess))
      .send({ transactionType: 'RESTOCK', quantity: 10 })
      .expect(201);

    const company2 = await registerCompany(2);
    owner2Access = company2.access;
  });

  afterAll(async () => {
    await app.close();
  });

  const base = () => `/corners/${cornerId}/products/${placementId}/reservations`;
  let reservationId: string;

  it('reserving holds stock (available -> reserved) and logs RESERVE/source=RESERVATION', async () => {
    const res = await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ reservedByName: 'Kim', reservedQuantity: 3 })
      .expect(201);
    reservationId = res.body.id;
    expect(res.body.status).toBe('RESERVED');

    expect(await stockOf()).toEqual({ available: 7, reserved: 3 });

    const ledger = await request(http)
      .get(`/corners/${cornerId}/products/${placementId}/transactions`)
      .set(...auth(ownerAccess))
      .expect(200);
    expect(ledger.body[0].transactionType).toBe('RESERVE');
    expect(ledger.body[0].sourceType).toBe('RESERVATION');
  });

  it('over-reserving beyond available is 409', async () => {
    await request(http)
      .post(base())
      .set(...auth(ownerAccess))
      .send({ reservedByName: 'Greedy', reservedQuantity: 999 })
      .expect(409);
    expect(await stockOf()).toEqual({ available: 7, reserved: 3 }); // unchanged
  });

  it('fulfilling releases then sells (reserved -> 0, available net down) and marks FULFILLED', async () => {
    await request(http)
      .post(`${base()}/${reservationId}/fulfill`)
      .set(...auth(ownerAccess))
      .expect(201);

    expect(await stockOf()).toEqual({ available: 7, reserved: 0 }); // 3 left the reserved pool as a sale

    const ledger = await request(http)
      .get(`/corners/${cornerId}/products/${placementId}/transactions`)
      .set(...auth(ownerAccess))
      .expect(200);
    // both land in the same transaction (same createdAt) — assert order-independently
    const types = ledger.body.slice(0, 2).map((t: any) => t.transactionType).sort();
    expect(types).toEqual(['RESERVATION_RELEASE', 'SALE']);
    expect(ledger.body[0].sourceType).toBe('RESERVATION');
  });

  it('fulfilling an already-fulfilled reservation is 409', async () => {
    await request(http)
      .post(`${base()}/${reservationId}/fulfill`)
      .set(...auth(ownerAccess))
      .expect(409);
  });

  it('an assigned STAFF can reserve, and cancel releases the hold', async () => {
    const res = await request(http)
      .post(base())
      .set(...auth(staffAccess))
      .send({ reservedByName: 'Lee', reservedQuantity: 2 })
      .expect(201);
    expect(await stockOf()).toEqual({ available: 5, reserved: 2 });

    await request(http)
      .post(`${base()}/${res.body.id}/cancel`)
      .set(...auth(staffAccess))
      .send({ cancelReason: 'changed mind' })
      .expect(201);
    expect(await stockOf()).toEqual({ available: 7, reserved: 0 }); // released back
  });

  it('a foreign MANAGER cannot reserve on this corner (403)', async () => {
    await request(http)
      .post(base())
      .set(...auth(otherManagerAccess))
      .send({ reservedByName: 'X', reservedQuantity: 1 })
      .expect(403);
  });

  it("company 2 cannot read this corner's reservations (404)", async () => {
    await request(http)
      .get(base())
      .set(...auth(owner2Access))
      .expect(404);
  });
});
```

- [ ] **Step 2: Run the e2e** — `npm run test:e2e`. *(Developer runs — Prisma AI-guard blocks the reset.)*
Expected: all e2e suites green, including `reservations`.

- [ ] **Step 3: Commit**

```bash
git add test/reservations.e2e-spec.ts
git commit -m "test(reservations): e2e reserve/fulfill/cancel bucket moves + oversell 409 + auth/tenant guards"
```

---

## Self-Review (spec coverage)

- Spec §1–§2 (hold on create, fulfill=release+SALE, all-or-nothing, expiresAt stored, no soft-delete, createdBy, reuse recordWithinTransaction, placement-nested) → Tasks 1–3. ✓
- §3 effect-map extension (reserved bucket + RESERVE + RESERVATION_RELEASE) → Task 1 (Steps 4–6). ✓
- §4 schema (2 enum values + createdByUserId + migration) → Task 1 (Steps 1–3). ✓
- §5 permissions (48) → Task 1 (Steps 7–8). ✓
- §6 API (placement-nested, 4 perms, fulfill/cancel actions) → Task 3 controller + Task 2 DTOs. ✓
- §7 service logic (getPlacement/getReservation, create holds via RESERVE, fulfill release+SALE, cancel release, state guards) → Task 2. ✓
- §8 errors (400 dto, 404 placement/reservation/corner, 403 perms/ownership, 409 oversell + non-RESERVED) → Task 2 (404/409) + Task 3 RBAC (403) + Corners (403/404); e2e Task 4. ✓
- §9 wiring (imports CornersModule + InventoryModule) → Task 3. ✓
- §10 testing (effects + service unit; e2e bucket moves + oversell + guards) → Tasks 1, 2, 4. ✓
- §11 out-of-scope (auto-expiry, partial, PENDING, editing) → nothing implements them. ✓
- Type consistency: `recordWithinTransaction(tx, placementId, { transactionType, quantity }, callerId, { type, id })` identical across service and tests; `RESERVE`/`RESERVATION_RELEASE`/`SALE` and `RESERVED`/`FULFILLED`/`CANCELLED` consistent; single-`id` `where` on `purchaseReservation.update`. ✓
