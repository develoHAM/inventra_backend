import { AccountsService } from './accounts.service';
import { ProfileStatus } from '../generated/prisma/enums';

describe('AccountsService', () => {
  let service: AccountsService;
  let prisma: { profile: { findFirst: jest.Mock } };
  let transaction: { account: { createManyAndReturn: jest.Mock } };

  /** A profile as findProfileToOpen selects it. */
  const profile = (id: string, changes: Record<string, unknown> = {}) => ({
    id: id,
    status: ProfileStatus.ACTIVE,
    companyId: 'company-1',
    roleId: 4,
    ...changes,
  });
  /** What "openable" means: this account's, not deleted, ACTIVE or PENDING_APPROVAL. */
  const openableOf = (accountId: string) => ({
    accountId: accountId,
    deletedAt: null,
    status: { in: [ProfileStatus.PENDING_APPROVAL, ProfileStatus.ACTIVE] },
  });
  const OPEN_PROFILE_SELECT = {
    id: true,
    status: true,
    companyId: true,
    roleId: true,
  };

  beforeEach(() => {
    prisma = { profile: { findFirst: jest.fn().mockResolvedValue(null) } };
    transaction = {
      account: {
        createManyAndReturn: jest.fn().mockResolvedValue([{ id: 'account-1' }]),
      },
    };
    service = new AccountsService(prisma as any);
  });

  describe('createAccount', () => {
    it('inserts the account with ON CONFLICT DO NOTHING and returns its id', async () => {
      await expect(
        service.createAccount(transaction as any, '01012345678'),
      ).resolves.toBe('account-1');

      expect(transaction.account.createManyAndReturn).toHaveBeenCalledWith({
        data: [{ phone: '01012345678' }],
        skipDuplicates: true,
        select: { id: true },
      });
    });

    it('the phone already belongs to a live account (nothing inserted) → null, for the caller to answer 409', async () => {
      transaction.account.createManyAndReturn.mockResolvedValue([]);

      await expect(
        service.createAccount(transaction as any, '01012345678'),
      ).resolves.toBeNull();
    });

    it('an account with no phone (the seeded admin) is allowed', async () => {
      await service.createAccount(transaction as any, null);

      expect(
        transaction.account.createManyAndReturn.mock.calls[0][0].data,
      ).toEqual([{ phone: null }]);
    });
  });

  describe('findProfileToOpen', () => {
    it('opens the preferred profile when it is still openable and belongs to the account', async () => {
      prisma.profile.findFirst.mockResolvedValueOnce(profile('profile-2'));

      await expect(
        service.findProfileToOpen('account-1', 'profile-2'),
      ).resolves.toEqual(profile('profile-2'));

      expect(prisma.profile.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.profile.findFirst).toHaveBeenCalledWith({
        where: { id: 'profile-2', ...openableOf('account-1') },
        select: OPEN_PROFILE_SELECT,
      });
    });

    it('a preferred profile that is left, suspended, deleted or another account’s → the newest openable one instead', async () => {
      prisma.profile.findFirst
        .mockResolvedValueOnce(null) // the preferred one didn't match "openable, this account"
        .mockResolvedValueOnce(profile('profile-3'));

      await expect(
        service.findProfileToOpen('account-1', 'profile-2'),
      ).resolves.toEqual(profile('profile-3'));

      expect(prisma.profile.findFirst).toHaveBeenLastCalledWith({
        where: openableOf('account-1'),
        orderBy: { createdAt: 'desc' },
        select: OPEN_PROFILE_SELECT,
      });
    });

    it('no preferred profile → straight to the newest openable one', async () => {
      prisma.profile.findFirst.mockResolvedValueOnce(profile('profile-3'));

      await expect(
        service.findProfileToOpen('account-1', null),
      ).resolves.toEqual(profile('profile-3'));

      expect(prisma.profile.findFirst).toHaveBeenCalledTimes(1);
      expect(prisma.profile.findFirst).toHaveBeenCalledWith({
        where: openableOf('account-1'),
        orderBy: { createdAt: 'desc' },
        select: OPEN_PROFILE_SELECT,
      });
    });

    it('nothing openable at all → null', async () => {
      await expect(
        service.findProfileToOpen('account-1', 'profile-2'),
      ).resolves.toBeNull();
    });
  });
});
