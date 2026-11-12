import { BadRequestException, Logger } from '@nestjs/common';
import { DevicesService } from './devices.service';
import { DevicePlatform } from '../generated/prisma/enums';

describe('DevicesService', () => {
  let service: DevicesService;
  let prisma: {
    deviceToken: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findMany: jest.Mock;
    };
  };

  let push: { isValidToken: jest.Mock };

  const now = new Date('2026-10-05T09:00:00.000Z');

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    prisma = {
      deviceToken: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    push = { isValidToken: jest.fn().mockResolvedValue(true) };
    service = new DevicesService(prisma as any, push as any);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('register', () => {
    it("upserts by token: creates it for the caller's account, or moves an existing one to it", async () => {
      await service.register('account-1', {
        token: 'fcm-token-abc',
        platform: DevicePlatform.ANDROID,
      });

      expect(prisma.deviceToken.upsert).toHaveBeenCalledWith({
        where: { token: 'fcm-token-abc' },
        create: {
          accountId: 'account-1',
          token: 'fcm-token-abc',
          platform: DevicePlatform.ANDROID,
          lastSeenAt: now,
        },
        // a token re-registered by another account now belongs to it
        update: {
          accountId: 'account-1',
          platform: DevicePlatform.ANDROID,
          lastSeenAt: now,
        },
      });
    });

    it('validates the token with the push sender before storing it', async () => {
      await service.register('account-1', {
        token: 'fcm-token-abc',
        platform: DevicePlatform.ANDROID,
      });

      expect(push.isValidToken).toHaveBeenCalledWith('fcm-token-abc');
      expect(push.isValidToken.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.deviceToken.upsert.mock.invocationCallOrder[0],
      );
    });

    it('a token FCM rejects → 400, nothing stored', async () => {
      push.isValidToken.mockResolvedValue(false);

      await expect(
        service.register('account-1', {
          token: 'garbage',
          platform: DevicePlatform.WEB,
        }),
      ).rejects.toThrow(new BadRequestException('Invalid device token'));
      expect(prisma.deviceToken.upsert).not.toHaveBeenCalled();
    });

    it('FCM unreachable → fail open: store it anyway (and warn)', async () => {
      push.isValidToken.mockRejectedValue(new Error('server-unavailable'));

      await expect(
        service.register('account-1', {
          token: 'fcm-token-abc',
          platform: DevicePlatform.IOS,
        }),
      ).resolves.toBeUndefined();
      expect(prisma.deviceToken.upsert).toHaveBeenCalled();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('resolves with nothing (the route answers 204)', async () => {
      await expect(
        service.register('account-1', {
          token: 'fcm-token-abc',
          platform: DevicePlatform.WEB,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('unregister', () => {
    it("deletes the token only if it is the caller's account's own", async () => {
      await service.unregister('account-1', 'fcm-token-abc');

      expect(prisma.deviceToken.deleteMany).toHaveBeenCalledWith({
        where: { token: 'fcm-token-abc', accountId: 'account-1' },
      });
    });

    it("is quiet when the token is unknown or someone else's (count 0)", async () => {
      prisma.deviceToken.deleteMany.mockResolvedValue({ count: 0 });

      await expect(
        service.unregister('account-1', 'not-mine'),
      ).resolves.toBeUndefined();
    });
  });

  describe('findTokens', () => {
    it('returns every device of the given accounts', async () => {
      prisma.deviceToken.findMany.mockResolvedValue([
        { accountId: 'account-1', token: 'phone' },
        { accountId: 'account-1', token: 'laptop' },
        { accountId: 'account-2', token: 'tablet' },
      ]);

      const tokens = await service.findTokens(['account-1', 'account-2']);

      expect(tokens).toHaveLength(3);
      expect(prisma.deviceToken.findMany).toHaveBeenCalledWith({
        where: { accountId: { in: ['account-1', 'account-2'] } },
        select: { accountId: true, token: true },
      });
    });

    it('skips the query entirely for an empty list', async () => {
      await expect(service.findTokens([])).resolves.toEqual([]);
      expect(prisma.deviceToken.findMany).not.toHaveBeenCalled();
    });
  });
});
