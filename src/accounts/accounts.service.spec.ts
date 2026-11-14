import { AccountsService } from './accounts.service';
import { ProfileStatus } from '../generated/prisma/enums';

describe('AccountsService', () => {
  let service: AccountsService;
  let prisma: { profile: { findFirst: jest.Mock; findMany: jest.Mock } };
  let transaction: { account: { createManyAndReturn: jest.Mock } };
  let storage: { presignGetUrl: jest.Mock };

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
    prisma = {
      profile: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    transaction = {
      account: {
        createManyAndReturn: jest.fn().mockResolvedValue([{ id: 'account-1' }]),
      },
    };
    storage = {
      presignGetUrl: jest
        .fn()
        .mockImplementation((key: string) =>
          Promise.resolve(`https://signed/${key}`),
        ),
    };
    service = new AccountsService(prisma as any, storage as any);
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
  describe('findOpenableProfile', () => {
    it("returns the profile when it is this account's and openable", async () => {
      prisma.profile.findFirst.mockResolvedValueOnce(profile('profile-2'));

      await expect(
        service.findOpenableProfile('account-1', 'profile-2'),
      ).resolves.toEqual(profile('profile-2'));

      // one query: the id AND every "openable" rule, so a miss is a miss for any reason
      expect(prisma.profile.findFirst).toHaveBeenCalledWith({
        where: { id: 'profile-2', ...openableOf('account-1') },
        select: OPEN_PROFILE_SELECT,
      });
    });

    it("another account's profile, or one left, suspended or deleted → null (the caller decides 404)", async () => {
      await expect(
        service.findOpenableProfile('account-1', 'profile-of-someone-else'),
      ).resolves.toBeNull();
    });
  });

  describe('listCompanies (the company dropdown)', () => {
    /** A profile row as listCompanies selects it. */
    const companyRow = (id: string, changes: Record<string, unknown> = {}) => ({
      id: id,
      status: ProfileStatus.ACTIVE,
      name: '김알바',
      profileImageUrl: null,
      role: { code: 'STAFF', name: 'Staff' },
      company: { id: 'company-1', name: '카페 A' },
      ...changes,
    });

    it('lists only openable profiles of the account, oldest first', async () => {
      await service.listCompanies('account-1');

      expect(prisma.profile.findMany).toHaveBeenCalledWith({
        where: openableOf('account-1'),
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          name: true,
          profileImageUrl: true,
          role: { select: { code: true, name: true } },
          company: { select: { id: true, name: true } },
        },
      });
    });

    it('returns each as a CompanyProfileView, with role and company', async () => {
      prisma.profile.findMany.mockResolvedValue([
        companyRow('profile-1'),
        companyRow('profile-2', {
          status: ProfileStatus.PENDING_APPROVAL,
          role: null, // a join request: no role until approved
          company: { id: 'company-2', name: '편의점 B' },
        }),
      ]);

      await expect(service.listCompanies('account-1')).resolves.toEqual([
        {
          profileId: 'profile-1',
          status: ProfileStatus.ACTIVE,
          name: '김알바',
          profileImageUrl: null,
          role: { code: 'STAFF', name: 'Staff' },
          company: { id: 'company-1', name: '카페 A' },
        },
        {
          profileId: 'profile-2',
          status: ProfileStatus.PENDING_APPROVAL,
          name: '김알바',
          profileImageUrl: null,
          role: null,
          company: { id: 'company-2', name: '편의점 B' },
        },
      ]);
    });

    it('presigns a stored photo key (the bucket is private); no photo → null, no presign', async () => {
      prisma.profile.findMany.mockResolvedValue([
        companyRow('profile-1', {
          profileImageUrl: 'profiles/profile-1/avatar.png',
        }),
        companyRow('profile-2'),
      ]);

      const [withPhoto, withoutPhoto] =
        await service.listCompanies('account-1');

      expect(withPhoto.profileImageUrl).toBe(
        'https://signed/profiles/profile-1/avatar.png',
      );
      expect(withoutPhoto.profileImageUrl).toBeNull();
      expect(storage.presignGetUrl).toHaveBeenCalledTimes(1);
    });

    it('nothing openable → an empty list', async () => {
      await expect(service.listCompanies('account-1')).resolves.toEqual([]);
    });
  });
});
