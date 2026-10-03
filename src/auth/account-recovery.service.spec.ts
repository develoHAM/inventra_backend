import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccountRecoveryService } from './account-recovery.service';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';

describe('AccountRecoveryService', () => {
  let service: AccountRecoveryService;
  let tx: { userLoginMethod: { findFirst: jest.Mock } };
  let prisma: { $transaction: jest.Mock };
  let phoneVerification: { consume: jest.Mock };

  const phone = '01012345678';

  beforeEach(() => {
    tx = {
      userLoginMethod: {
        findFirst: jest.fn().mockResolvedValue({ email: 'owner@example.com' }),
      },
    };
    prisma = { $transaction: jest.fn(async (callback: any) => callback(tx)) };
    phoneVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    service = new AccountRecoveryService(
      prisma as any,
      phoneVerification as any,
    );
  });

  describe('findId', () => {
    it('returns the masked email of the account that owns the phone', async () => {
      await expect(service.findId(phone, 'find-token')).resolves.toEqual({
        email: 'ow***@example.com',
      });
    });

    it('spends a FIND_ID token for that phone, inside the transaction, before looking anything up', async () => {
      await service.findId(phone, 'find-token');

      expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
        token: 'find-token',
        phone: phone,
        purpose: PhoneVerificationPurpose.FIND_ID,
      });
      expect(
        phoneVerification.consume.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.userLoginMethod.findFirst.mock.invocationCallOrder[0]);
    });

    it('looks only at a live user’s local (email) login on that phone', async () => {
      await service.findId(phone, 'find-token');

      expect(tx.userLoginMethod.findFirst).toHaveBeenCalledWith({
        where: {
          method: 'local',
          email: { not: null },
          user: { phone: phone, deletedAt: null },
        },
        select: { email: true },
      });
    });

    it('an invalid token (wrong purpose, reused, expired) gets 400 and looks nothing up', async () => {
      phoneVerification.consume.mockRejectedValue(
        new BadRequestException('Invalid or expired verification token'),
      );

      await expect(service.findId(phone, 'signup-token')).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.userLoginMethod.findFirst).not.toHaveBeenCalled();
    });

    it('404s when no account uses the phone — and the token stays spent (committed)', async () => {
      tx.userLoginMethod.findFirst.mockResolvedValue(null);

      await expect(service.findId(phone, 'find-token')).rejects.toThrow(
        new NotFoundException('No account uses this phone'),
      );
      // the transaction resolved (commit), so the consumption is kept
      await expect(
        prisma.$transaction.mock.results[0].value,
      ).resolves.toBeNull();
    });
  });
});
