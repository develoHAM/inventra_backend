import { MembershipHistoryService } from './membership-history.service';
import type { MembershipChangeInput } from './membership-change';
import { MembershipChangeReason } from '../generated/prisma/enums';

describe('MembershipHistoryService', () => {
  let service: MembershipHistoryService;
  let transaction: { membershipChange: { createMany: jest.Mock } };

  const staffMovedFromAToB: MembershipChangeInput = {
    companyId: 'company-1',
    userId: 'staff-1',
    reason: MembershipChangeReason.MOVED,
    fromRoleId: 4,
    toRoleId: 4,
    fromCornerId: 'corner-a',
    toCornerId: 'corner-b',
    changedByUserId: 'owner-1',
  };
  const managerPromotedToOwner: MembershipChangeInput = {
    companyId: 'company-1',
    userId: 'manager-1',
    reason: MembershipChangeReason.ROLE_CHANGED,
    fromRoleId: 3,
    toRoleId: 2,
    fromCornerId: 'corner-a',
    toCornerId: null,
    changedByUserId: null,
  };

  beforeEach(() => {
    transaction = {
      membershipChange: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    service = new MembershipHistoryService();
  });

  describe('record', () => {
    it('writes every change in one createMany, naming the branch columns', async () => {
      await service.record(transaction as any, [
        staffMovedFromAToB,
        managerPromotedToOwner,
      ]);

      expect(transaction.membershipChange.createMany).toHaveBeenCalledTimes(1);
      expect(transaction.membershipChange.createMany).toHaveBeenCalledWith({
        data: [
          {
            companyId: 'company-1',
            userId: 'staff-1',
            reason: MembershipChangeReason.MOVED,
            fromRoleId: 4,
            toRoleId: 4,
            fromCompanyStoreId: 'corner-a',
            toCompanyStoreId: 'corner-b',
            changedByUserId: 'owner-1',
          },
          {
            companyId: 'company-1',
            userId: 'manager-1',
            reason: MembershipChangeReason.ROLE_CHANGED,
            fromRoleId: 3,
            toRoleId: 2,
            fromCompanyStoreId: 'corner-a',
            toCompanyStoreId: null,
            changedByUserId: null,
          },
        ],
      });
    });

    it('writes nothing when there are no changes', async () => {
      await service.record(transaction as any, []);

      expect(transaction.membershipChange.createMany).not.toHaveBeenCalled();
    });
  });
});
