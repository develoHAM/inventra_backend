import { ReservationExpiryService } from './reservation-expiry.service';

describe('ReservationExpiryService', () => {
  let service: ReservationExpiryService;
  let prisma: any;
  let inventory: { recordWithinTransaction: jest.Mock };
  let transaction: any;

  const dueReservation = {
    id: 'res-1',
    companyStoreProductId: 7,
    reservedQuantity: 3,
    createdByUserId: 'owner-1',
  };

  beforeEach(() => {
    transaction = {
      purchaseReservation: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      purchaseReservation: {
        findMany: jest.fn().mockResolvedValue([dueReservation]),
      },
      $transaction: jest
        .fn()
        .mockImplementation(async (cb: any) => cb(transaction)),
    };
    inventory = { recordWithinTransaction: jest.fn().mockResolvedValue({}) };
    service = new ReservationExpiryService(prisma as any, inventory as any);
  });

  it('claims each due reservation and releases its hold (RESERVATION_RELEASE, creator as actor)', async () => {
    const result = await service.sweepExpired();

    // only RESERVED, expired holds are candidates
    expect(prisma.purchaseReservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'RESERVED' }),
      }),
    );
    // guarded claim flips RESERVED -> EXPIRED and stamps expiredAt
    expect(transaction.purchaseReservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'res-1', status: 'RESERVED' },
      data: { status: 'EXPIRED', expiredAt: expect.any(Date) },
    });
    // the release is attributed to the reservation's creator
    expect(inventory.recordWithinTransaction).toHaveBeenCalledWith(
      transaction,
      7,
      { transactionType: 'RESERVATION_RELEASE', quantity: 3 },
      'owner-1',
      { type: 'RESERVATION', id: 'res-1' },
    );
    expect(result).toEqual({ releasedCount: 1 });
  });

  it('skips a reservation whose guarded claim loses the race (count 0)', async () => {
    transaction.purchaseReservation.updateMany.mockResolvedValue({ count: 0 });

    const result = await service.sweepExpired();

    expect(inventory.recordWithinTransaction).not.toHaveBeenCalled();
    expect(result).toEqual({ releasedCount: 0 });
  });

  it('does nothing when no reservations are due', async () => {
    prisma.purchaseReservation.findMany.mockResolvedValue([]);

    const result = await service.sweepExpired();

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result).toEqual({ releasedCount: 0 });
  });

  it('one failing reservation does not stall the rest', async () => {
    prisma.purchaseReservation.findMany.mockResolvedValue([
      { ...dueReservation, id: 'res-bad' },
      { ...dueReservation, id: 'res-ok' },
    ]);
    prisma.$transaction
      .mockImplementationOnce(async () => {
        throw new Error('boom');
      })
      .mockImplementationOnce(async (cb: any) => cb(transaction));

    const result = await service.sweepExpired();

    // the second one still processed despite the first throwing
    expect(result).toEqual({ releasedCount: 1 });
  });
});
