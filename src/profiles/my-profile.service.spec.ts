import { BadRequestException } from '@nestjs/common';
import { MyProfileService, PROFILE_SUMMARY_SELECT } from './my-profile.service';
import { ProfileStatus } from '../generated/prisma/enums';
import type { AuthProfile } from '../auth/types/auth-profile';

describe('MyProfileService', () => {
  let service: MyProfileService;
  let prisma: { profile: { update: jest.Mock }; $transaction: jest.Mock };
  let transaction: { profile: { update: jest.Mock } };
  let emailVerification: { consume: jest.Mock };

  // a join still waiting for approval: these routes are for it too
  const caller: AuthProfile = {
    id: 'profile-1',
    accountId: 'account-1',
    companyId: 'company-1',
    roleId: null,
    roleCode: null,
    status: ProfileStatus.PENDING_APPROVAL,
  };
  const summary = (changes: Record<string, unknown> = {}) => ({
    id: 'profile-1',
    name: 'Lee',
    contactEmail: null,
    ...changes,
  });

  beforeEach(() => {
    transaction = {
      profile: {
        update: jest
          .fn()
          .mockResolvedValue(summary({ contactEmail: 'lee@acme.com' })),
      },
    };
    prisma = {
      profile: {
        update: jest.fn().mockResolvedValue(summary({ name: 'Lee Ji-eun' })),
      },
      $transaction: jest.fn((work: (client: unknown) => unknown) =>
        work(transaction),
      ),
    };
    emailVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    service = new MyProfileService(prisma as any, emailVerification as any);
  });

  it('a summary is the id, the name and the contact email', () => {
    expect(PROFILE_SUMMARY_SELECT).toEqual({
      id: true,
      name: true,
      contactEmail: true,
    });
  });

  describe('updateMyProfile', () => {
    it("renames only the caller's own profile: the id comes from the token", async () => {
      await service.updateMyProfile(caller, { name: 'Lee Ji-eun' });

      expect(prisma.profile.update).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        data: { name: 'Lee Ji-eun' },
        select: PROFILE_SUMMARY_SELECT,
      });
    });

    it('returns the summary', async () => {
      await expect(
        service.updateMyProfile(caller, { name: 'Lee Ji-eun' }),
      ).resolves.toEqual(summary({ name: 'Lee Ji-eun' }));
    });
  });

  describe('setMyContactEmail', () => {
    const dto = {
      email: 'lee@acme.com',
      emailVerificationToken: 'email-token',
    };

    it('spends the proof for exactly this address, inside the transaction', async () => {
      await service.setMyContactEmail(caller, dto);

      expect(emailVerification.consume).toHaveBeenCalledWith(transaction, {
        token: 'email-token',
        email: 'lee@acme.com',
      });
    });

    it("then writes it on the caller's own profile, in the SAME transaction", async () => {
      await service.setMyContactEmail(caller, dto);

      expect(transaction.profile.update).toHaveBeenCalledWith({
        where: { id: 'profile-1' },
        data: { contactEmail: 'lee@acme.com' },
        select: PROFILE_SUMMARY_SELECT,
      });
      expect(
        emailVerification.consume.mock.invocationCallOrder[0],
      ).toBeLessThan(transaction.profile.update.mock.invocationCallOrder[0]);
      expect(prisma.profile.update).not.toHaveBeenCalled(); // not outside it
    });

    it('a bad, used or expired proof → the email-verification 400, and nothing is written', async () => {
      emailVerification.consume.mockRejectedValue(
        new BadRequestException('Invalid or expired email verification'),
      );

      await expect(service.setMyContactEmail(caller, dto)).rejects.toThrow(
        new BadRequestException('Invalid or expired email verification'),
      );
      expect(transaction.profile.update).not.toHaveBeenCalled();
    });

    it('returns the summary', async () => {
      await expect(service.setMyContactEmail(caller, dto)).resolves.toEqual(
        summary({ contactEmail: 'lee@acme.com' }),
      );
    });
  });
});
