import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { randomInt } from 'node:crypto';
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
    phoneVerification: { count: jest.Mock; create: jest.Mock };
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
});
