import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AccountRecoveryService } from './account-recovery.service';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

describe('AccountRecoveryService', () => {
  let service: AccountRecoveryService;
  let tx: {
    userLoginMethod: { findFirst: jest.Mock; update: jest.Mock };
    refreshToken: { updateMany: jest.Mock };
  };
  let prisma: { $transaction: jest.Mock };
  let phoneVerification: { consume: jest.Mock };
  let passwordService: { hash: jest.Mock };
  let eventEmitter: { emit: jest.Mock };

  const phone = '01012345678';

  beforeEach(() => {
    tx = {
      userLoginMethod: {
        findFirst: jest.fn().mockResolvedValue({ email: 'owner@example.com' }),
        update: jest.fn().mockResolvedValue({}),
      },
      refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    prisma = { $transaction: jest.fn(async (callback: any) => callback(tx)) };
    phoneVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    passwordService = { hash: jest.fn().mockResolvedValue('new-hash') };
    eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    service = new AccountRecoveryService(
      prisma as any,
      phoneVerification as any,
      passwordService as any,
      eventEmitter as any,
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

  describe('resetPassword', () => {
    const input = {
      email: 'owner@example.com',
      phone: phone,
      token: 'reset-token',
      newPassword: 'brand-new-password',
    };

    beforeEach(() => {
      tx.userLoginMethod.findFirst.mockResolvedValue({
        id: 'login-1',
        userId: 'user-1',
      });
    });

    it('hashes the new password BEFORE opening the transaction (keeps it short)', async () => {
      await service.resetPassword(input);

      expect(passwordService.hash).toHaveBeenCalledWith('brand-new-password');
      expect(passwordService.hash.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
    });

    it('spends a RESET_PASSWORD token for that phone first', async () => {
      await service.resetPassword(input);

      expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
        token: 'reset-token',
        phone: phone,
        purpose: PhoneVerificationPurpose.RESET_PASSWORD,
      });
      expect(
        phoneVerification.consume.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.userLoginMethod.findFirst.mock.invocationCallOrder[0]);
    });

    it('requires the EMAIL to belong to the user who owns the PHONE (both factors)', async () => {
      await service.resetPassword(input);

      expect(tx.userLoginMethod.findFirst).toHaveBeenCalledWith({
        where: {
          method: 'local',
          email: 'owner@example.com',
          user: { phone: phone, deletedAt: null },
        },
        select: { id: true, userId: true },
      });
    });

    it('stores the new hash on that login method', async () => {
      await service.resetPassword(input);

      expect(tx.userLoginMethod.update).toHaveBeenCalledWith({
        where: { id: 'login-1' },
        data: { passwordHash: 'new-hash' },
      });
    });

    it('revokes every active refresh token of that user (all devices logged out)', async () => {
      await service.resetPassword(input);

      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('emits account.passwordReset with the user id, after the transaction commits', async () => {
      await service.resetPassword(input);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.ACCOUNT_PASSWORD_RESET,
        { userId: 'user-1' },
      );
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
    });

    it('resolves with nothing (the route answers 204)', async () => {
      await expect(service.resetPassword(input)).resolves.toBeUndefined();
    });

    it('an email that is not this phone’s account → 400, nothing changed, token spent', async () => {
      tx.userLoginMethod.findFirst.mockResolvedValue(null);

      await expect(service.resetPassword(input)).rejects.toThrow(
        new BadRequestException('Email and phone do not match an account'),
      );
      expect(tx.userLoginMethod.update).not.toHaveBeenCalled();
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      // committed, so the token stays spent
      await expect(
        prisma.$transaction.mock.results[0].value,
      ).resolves.toBeNull();
    });

    it('an invalid token (e.g. a FIND_ID token) → 400, nothing looked up or changed', async () => {
      phoneVerification.consume.mockRejectedValue(
        new BadRequestException('Invalid or expired verification token'),
      );

      await expect(service.resetPassword(input)).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.userLoginMethod.findFirst).not.toHaveBeenCalled();
      expect(tx.userLoginMethod.update).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('a failure mid-way rolls everything back and emits nothing', async () => {
      tx.refreshToken.updateMany.mockRejectedValue(new Error('db down'));

      await expect(service.resetPassword(input)).rejects.toThrow('db down');
      await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
        'db down',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });
});
