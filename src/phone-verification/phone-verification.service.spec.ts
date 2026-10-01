import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomInt } from 'node:crypto';
import { PhoneVerificationService } from './phone-verification.service';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';

// Replace only randomInt so tests can pick the "random" code; everything
// else in node:crypto stays real.
jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomInt: jest.fn(),
}));
const randomIntMock = randomInt as unknown as jest.Mock;

describe('PhoneVerificationService', () => {
  let service: PhoneVerificationService;
  let prisma: {
    phoneVerification: {
      count: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      updateMany: jest.Mock;
    };
    user: { findFirst: jest.Mock };
  };
  let verifier: { messageExists: jest.Mock };

  const now = new Date('2026-09-30T10:00:00.000Z');
  const phone = '01012345678';

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    randomIntMock.mockReturnValue(482913);
    prisma = {
      phoneVerification: {
        count: jest.fn().mockResolvedValue(0),
        // echo the data back as the created row, with an id
        create: jest.fn(async ({ data }) => ({
          id: 'verification-1',
          ...data,
        })),
        // a live, unverified verification started 90 seconds ago
        findFirst: jest.fn().mockResolvedValue({
          id: 'verification-1',
          phone: phone,
          purpose: PhoneVerificationPurpose.SIGNUP,
          code: '482913',
          createdAt: new Date('2026-09-30T09:58:30.000Z'),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    verifier = { messageExists: jest.fn() };
    service = new PhoneVerificationService(prisma as any, verifier as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('start', () => {
    it('creates a verification row with a 6-digit code that expires in 5 minutes', async () => {
      await service.start(phone, PhoneVerificationPurpose.SIGNUP);

      expect(prisma.phoneVerification.create).toHaveBeenCalledWith({
        data: {
          phone: phone,
          purpose: PhoneVerificationPurpose.SIGNUP,
          code: '482913',
          expiresAt: new Date('2026-09-30T10:05:00.000Z'),
        },
      });
    });

    it('returns what the screen needs: id, code, receiver number, lifetime', async () => {
      const result = await service.start(
        phone,
        PhoneVerificationPurpose.SIGNUP,
      );

      expect(result).toEqual({
        verificationId: 'verification-1',
        code: '482913',
        receiverNumber: '1666-3538',
        expiresInSeconds: 300,
      });
    });

    it('draws the code from 0–999999 and left-pads it to 6 digits', async () => {
      randomIntMock.mockReturnValue(42);

      const result = await service.start(
        phone,
        PhoneVerificationPurpose.SIGNUP,
      );

      expect(randomIntMock).toHaveBeenCalledWith(0, 1_000_000);
      expect(result.code).toBe('000042');
    });

    it('counts this phone’s starts over the last 24 hours (all purposes)', async () => {
      await service.start(phone, PhoneVerificationPurpose.SIGNUP);

      expect(prisma.phoneVerification.count).toHaveBeenCalledWith({
        where: {
          phone: phone,
          createdAt: { gte: new Date('2026-09-29T10:00:00.000Z') },
        },
      });
    });

    it('allows the 10th start of the day', async () => {
      prisma.phoneVerification.count.mockResolvedValue(9);

      await expect(
        service.start(phone, PhoneVerificationPurpose.SIGNUP),
      ).resolves.toBeDefined();
    });

    it('refuses the 11th start with 429 and creates nothing', async () => {
      prisma.phoneVerification.count.mockResolvedValue(10);

      const attempt = service.start(phone, PhoneVerificationPurpose.SIGNUP);

      await expect(attempt).rejects.toBeInstanceOf(HttpException);
      await expect(attempt).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      expect(prisma.phoneVerification.create).not.toHaveBeenCalled();
    });

    it('refuses SIGNUP for a phone that already belongs to a user (409)', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });

      await expect(
        service.start(phone, PhoneVerificationPurpose.SIGNUP),
      ).rejects.toThrow(ConflictException);
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { phone: phone, deletedAt: null },
        select: { id: true },
      });
      expect(prisma.phoneVerification.create).not.toHaveBeenCalled();
    });

    it.each([
      PhoneVerificationPurpose.FIND_ID,
      PhoneVerificationPurpose.RESET_PASSWORD,
    ])(
      'does not check registration for %s (recovery needs a registered phone)',
      async (purpose) => {
        prisma.user.findFirst.mockResolvedValue({ id: 'user-1' });

        await expect(service.start(phone, purpose)).resolves.toBeDefined();
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
      },
    );

    it('never calls the verifier (nothing has been texted yet)', async () => {
      await service.start(phone, PhoneVerificationPurpose.SIGNUP);

      expect(verifier.messageExists).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    const sha256 = (value: string) =>
      createHash('sha256').update(value).digest('hex');

    beforeEach(() => {
      verifier.messageExists.mockResolvedValue(true);
    });

    it('looks up a live verification: unverified and not expired', async () => {
      await service.confirm('verification-1');

      expect(prisma.phoneVerification.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'verification-1',
          verifiedAt: null,
          expiresAt: { gt: now },
        },
      });
    });

    it('rejects an unknown, expired or already-verified id without spending a check', async () => {
      prisma.phoneVerification.findFirst.mockResolvedValue(null);

      await expect(service.confirm('verification-1')).rejects.toThrow(
        new BadRequestException('Invalid or expired verification'),
      );
      expect(prisma.phoneVerification.updateMany).not.toHaveBeenCalled();
      expect(verifier.messageExists).not.toHaveBeenCalled();
    });

    it('claims a check (conditionally) BEFORE asking the verifier', async () => {
      await service.confirm('verification-1');

      expect(prisma.phoneVerification.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'verification-1', checkAttempts: { lt: 10 } },
        data: { checkAttempts: { increment: 1 } },
      });
      const claimOrder =
        prisma.phoneVerification.updateMany.mock.invocationCallOrder[0];
      const askOrder = verifier.messageExists.mock.invocationCallOrder[0];
      expect(claimOrder).toBeLessThan(askOrder);
    });

    it('refuses with 429 once all 10 checks are used, without calling OCTOMO', async () => {
      prisma.phoneVerification.updateMany.mockResolvedValueOnce({ count: 0 });

      const attempt = service.confirm('verification-1');

      await expect(attempt).rejects.toBeInstanceOf(HttpException);
      await expect(attempt).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      expect(verifier.messageExists).not.toHaveBeenCalled();
    });

    it('asks the verifier about this phone and code', async () => {
      await service.confirm('verification-1');

      expect(verifier.messageExists).toHaveBeenCalledWith(
        phone,
        '482913',
        expect.any(Number),
      );
    });

    it.each([
      ['90 s', '2026-09-30T09:58:30.000Z', 2],
      ['10 s', '2026-09-30T09:59:50.000Z', 1],
      ['0 s', '2026-09-30T10:00:00.000Z', 1],
      ['4 min 59 s', '2026-09-30T09:55:01.000Z', 5],
      ['exactly 3 min', '2026-09-30T09:57:00.000Z', 3],
    ])(
      'looks back only since the start: %s ago → withinMinutes %i',
      async (_label, createdAt, expectedMinutes) => {
        prisma.phoneVerification.findFirst.mockResolvedValue({
          id: 'verification-1',
          phone: phone,
          purpose: PhoneVerificationPurpose.SIGNUP,
          code: '482913',
          createdAt: new Date(createdAt),
        });

        await service.confirm('verification-1');

        expect(verifier.messageExists).toHaveBeenCalledWith(
          phone,
          '482913',
          expectedMinutes,
        );
      },
    );

    it('turns a verifier failure (OCTOMO down, 429, timeout) into 503', async () => {
      verifier.messageExists.mockRejectedValue(
        new Error('OCTOMO responded 500'),
      );

      await expect(service.confirm('verification-1')).rejects.toThrow(
        ServiceUnavailableException,
      );
      // the check was still spent; no token was issued
      expect(prisma.phoneVerification.updateMany).toHaveBeenCalledTimes(1);
    });

    it('answers 400 "not received yet" when the text has not arrived', async () => {
      verifier.messageExists.mockResolvedValue(false);

      await expect(service.confirm('verification-1')).rejects.toThrow(
        new BadRequestException('Message not received yet'),
      );
      expect(prisma.phoneVerification.updateMany).toHaveBeenCalledTimes(1);
    });

    it('issues a 10-minute token once the text has arrived', async () => {
      const result = await service.confirm('verification-1');

      expect(result.expiresInSeconds).toBe(600);
      // 32 random bytes in base64url = 43 URL-safe characters
      expect(result.verificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('stores only the SHA-256 of the token, and only if still unverified', async () => {
      const result = await service.confirm('verification-1');

      expect(prisma.phoneVerification.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'verification-1', verifiedAt: null },
        data: {
          verifiedAt: now,
          tokenHash: sha256(result.verificationToken),
          tokenExpiresAt: new Date('2026-09-30T10:10:00.000Z'),
        },
      });
      const stored =
        prisma.phoneVerification.updateMany.mock.calls[1][0].data.tokenHash;
      expect(stored).not.toBe(result.verificationToken);
    });

    it('gives a different token each time', async () => {
      const first = await service.confirm('verification-1');
      const second = await service.confirm('verification-1');

      expect(first.verificationToken).not.toBe(second.verificationToken);
    });

    it('rejects the loser of two concurrent successful confirms (no second token)', async () => {
      prisma.phoneVerification.updateMany
        .mockResolvedValueOnce({ count: 1 }) // check claimed
        .mockResolvedValueOnce({ count: 0 }); // someone else verified it first

      await expect(service.confirm('verification-1')).rejects.toThrow(
        new BadRequestException('Invalid or expired verification'),
      );
    });
  });

  describe('consume', () => {
    const sha256 = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    let tx: { phoneVerification: { updateMany: jest.Mock } };

    beforeEach(() => {
      tx = {
        phoneVerification: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
    });

    it('marks the token consumed only if hash, phone, purpose, unused and unexpired all match', async () => {
      await service.consume(tx as any, {
        token: 'raw-token',
        phone: phone,
        purpose: PhoneVerificationPurpose.SIGNUP,
      });

      expect(tx.phoneVerification.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: sha256('raw-token'),
          phone: phone,
          purpose: PhoneVerificationPurpose.SIGNUP,
          consumedAt: null,
          tokenExpiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
    });

    it('writes through the caller’s transaction, not its own client', async () => {
      await service.consume(tx as any, {
        token: 'raw-token',
        phone: phone,
        purpose: PhoneVerificationPurpose.SIGNUP,
      });

      expect(prisma.phoneVerification.updateMany).not.toHaveBeenCalled();
    });

    it('rejects when nothing matched (reused, expired, wrong phone or purpose, unknown)', async () => {
      tx.phoneVerification.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.consume(tx as any, {
          token: 'raw-token',
          phone: phone,
          purpose: PhoneVerificationPurpose.SIGNUP,
        }),
      ).rejects.toThrow(
        new BadRequestException('Invalid or expired verification token'),
      );
    });
  });
});
