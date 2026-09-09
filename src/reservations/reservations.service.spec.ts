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
        update: jest.fn().mockResolvedValue({ ...reservedRow }),
      },
    };
    prisma = {
      companyStoreProduct: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: placementId, companyStoreId: cornerId }),
      },
      purchaseReservation: {
        findFirst: jest.fn().mockResolvedValue({ ...reservedRow }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(transaction)),
    };
    corners = {
      assertWorksCorner: jest
        .fn()
        .mockResolvedValue({ id: cornerId, companyId: 'company-1' }),
      findOne: jest.fn().mockResolvedValue({ id: cornerId }),
    };
    inventory = { recordWithinTransaction: jest.fn().mockResolvedValue({ id: 1 }) };
    service = new ReservationsService(prisma, corners as any, inventory as any);
  });

  it('create holds stock via a guarded RESERVATION_HOLD and writes a RESERVED row', async () => {
    await service.create(owner, cornerId, {
      companyStoreProductId: placementId,
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
      { transactionType: 'RESERVATION_HOLD', quantity: 3 },
      'owner-1',
      { type: 'RESERVATION', id: reservationId },
    );
  });

  it('findAll filters by corner and passes optional query filters through', async () => {
    await service.findAll(owner, cornerId, {
      companyStoreProductId: placementId,
      status: 'RESERVED',
    } as any);

    expect(corners.findOne).toHaveBeenCalledWith(owner, cornerId);
    expect(prisma.purchaseReservation.findMany).toHaveBeenCalledWith({
      where: {
        companyStoreId: cornerId,
        companyStoreProductId: placementId,
        status: 'RESERVED',
      },
      orderBy: { reservedAt: 'desc' },
    });
  });

  it('findOne 404s an absent reservation', async () => {
    prisma.purchaseReservation.findFirst.mockResolvedValue(null);
    await expect(
      service.findOne(owner, cornerId, reservationId),
    ).rejects.toThrow(NotFoundException);
  });

  it('fulfill releases the hold then sells, and marks FULFILLED', async () => {
    await service.fulfill(owner, cornerId, reservationId);

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
    await service.cancel(owner, cornerId, reservationId, {
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
      data: {
        status: 'CANCELLED',
        cancelledAt: expect.any(Date),
        cancelReason: 'no-show',
      },
    });
  });

  it('fulfill on a non-RESERVED reservation is 409', async () => {
    prisma.purchaseReservation.findFirst.mockResolvedValue({
      ...reservedRow,
      status: 'FULFILLED',
    });
    await expect(
      service.fulfill(owner, cornerId, reservationId),
    ).rejects.toThrow(ConflictException);
    expect(inventory.recordWithinTransaction).not.toHaveBeenCalled();
  });

  it('cancel on a non-RESERVED reservation is 409', async () => {
    prisma.purchaseReservation.findFirst.mockResolvedValue({
      ...reservedRow,
      status: 'CANCELLED',
    });
    await expect(
      service.cancel(owner, cornerId, reservationId, {} as any),
    ).rejects.toThrow(ConflictException);
    expect(inventory.recordWithinTransaction).not.toHaveBeenCalled();
  });
});
