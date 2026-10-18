import {
  BadRequestException,
  HttpException,
  HttpStatus,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac, randomInt } from 'node:crypto';
import { EmailVerificationService } from './email-verification.service';
import { NotificationChannel } from '../generated/prisma/enums';

// Replace only randomInt so tests can pick the "random" code; everything
// else in node:crypto (createHmac, timingSafeEqual, randomBytes) stays real.
jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomInt: jest.fn(),
}));
const randomIntMock = randomInt as unknown as jest.Mock;

describe('EmailVerificationService', () => {
  let service: EmailVerificationService;
  let prisma: {
    emailVerification: {
      findFirst: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let notifications: { dispatch: jest.Mock };

  const secret = 's'.repeat(32);
  const email = 'new@example.com';
  const now = new Date('2026-10-17T10:00:00.000Z');
  const hmac = (code: string) =>
    createHmac('sha256', secret).update(code).digest('hex');
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    randomIntMock.mockReturnValue(482913);
    prisma = {
      emailVerification: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'ev-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    notifications = { dispatch: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue(secret) };
    service = new EmailVerificationService(
      prisma as any,
      notifications as any,
      config as any,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('start', () => {
    it('emails a 6-digit code and stores ONLY its HMAC, expiring in 10 minutes', async () => {
      await expect(service.start(email)).resolves.toEqual({
        expiresInSeconds: 600,
      });

      expect(prisma.emailVerification.create).toHaveBeenCalledWith({
        data: {
          email: email,
          codeHash: hmac('482913'),
          expiresAt: new Date('2026-10-17T10:10:00.000Z'),
        },
      });
      // a keyed hash, not the code and not a plain sha256 of it
      const stored = prisma.emailVerification.create.mock.calls[0][0].data;
      expect(stored.codeHash).not.toBe('482913');
      expect(stored.codeHash).not.toBe(sha256('482913'));
    });

    it('sends through the queue as a REDACTED email: the code only in the body, never in the row text', async () => {
      await service.start(email);

      const sent = notifications.dispatch.mock.calls[0][0];
      expect(sent).toMatchObject({
        eventType: 'email.verificationCode',
        channel: NotificationChannel.EMAIL,
        recipientAddress: email,
        subject: '[Inventra] 이메일 인증번호',
      });
      expect(sent.body).toContain('482913');
      expect(sent.redactedBody).toContain('******');
      expect(sent.redactedBody).not.toContain('482913');
    });

    it('left-pads small codes to 6 digits', async () => {
      randomIntMock.mockReturnValue(42);

      await service.start(email);

      expect(randomIntMock).toHaveBeenCalledWith(0, 1_000_000);
      expect(notifications.dispatch.mock.calls[0][0].body).toContain('000042');
    });

    it('refuses a resend within 60 s (429) and sends nothing', async () => {
      prisma.emailVerification.findFirst.mockResolvedValue({
        createdAt: new Date('2026-10-17T09:59:01.000Z'), // 59 s ago
      });

      const attempt = service.start(email);
      await expect(attempt).rejects.toBeInstanceOf(HttpException);
      await expect(attempt).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      expect(notifications.dispatch).not.toHaveBeenCalled();
      expect(prisma.emailVerification.create).not.toHaveBeenCalled();
    });

    it('tells the app how long to wait (for a countdown), rounded up', async () => {
      prisma.emailVerification.findFirst.mockResolvedValue({
        createdAt: new Date('2026-10-17T09:59:20.500Z'), // 39.5 s ago → 20.5 s left
      });

      const error = await service.start(email).catch((caught) => caught);

      expect(error).toBeInstanceOf(HttpException);
      expect(error.getResponse()).toEqual({
        statusCode: 429,
        message: 'Please wait before requesting another code',
        retryAfterSeconds: 21,
      });
    });

    it('allows a resend after 60 s', async () => {
      prisma.emailVerification.findFirst.mockResolvedValue({
        createdAt: new Date('2026-10-17T09:58:59.000Z'), // 61 s ago
      });

      await expect(service.start(email)).resolves.toBeDefined();
    });

    it('refuses the 11th code for an address in 24 h (429)', async () => {
      prisma.emailVerification.count.mockResolvedValue(10);

      await expect(service.start(email)).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
      });
      expect(prisma.emailVerification.count).toHaveBeenCalledWith({
        where: {
          email: email,
          createdAt: { gte: new Date('2026-10-16T10:00:00.000Z') },
        },
      });
      expect(notifications.dispatch).not.toHaveBeenCalled();
    });

    it('if queueing fails: 503 and NO row (so the cooldown does not lock the user out)', async () => {
      notifications.dispatch.mockRejectedValue(new Error('redis down'));

      await expect(service.start(email)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.emailVerification.create).not.toHaveBeenCalled();
    });
  });

  describe('confirm', () => {
    const liveRow = { id: 'ev-1', email: email, codeHash: hmac('482913') };

    beforeEach(() => {
      prisma.emailVerification.findFirst.mockResolvedValue(liveRow);
    });

    it('looks up the newest live code for the address', async () => {
      await service.confirm(email, '482913');

      expect(prisma.emailVerification.findFirst).toHaveBeenCalledWith({
        where: { email: email, verifiedAt: null, expiresAt: { gt: now } },
        orderBy: { createdAt: 'desc' },
      });
    });

    it('right code → a 10-minute token; only its SHA-256 is stored', async () => {
      const result = await service.confirm(email, '482913');

      expect(result.expiresInSeconds).toBe(600);
      expect(result.emailVerificationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(prisma.emailVerification.updateMany).toHaveBeenNthCalledWith(2, {
        where: { id: 'ev-1', verifiedAt: null },
        data: {
          verifiedAt: now,
          tokenHash: sha256(result.emailVerificationToken),
          tokenExpiresAt: new Date('2026-10-17T10:10:00.000Z'),
        },
      });
    });

    it('claims an attempt (conditionally) BEFORE comparing', async () => {
      await service.confirm(email, '000000').catch(() => undefined);

      expect(prisma.emailVerification.updateMany).toHaveBeenNthCalledWith(1, {
        where: { id: 'ev-1', attempts: { lt: 5 } },
        data: { attempts: { increment: 1 } },
      });
    });

    it('wrong code → 400, no token issued', async () => {
      await expect(service.confirm(email, '000000')).rejects.toThrow(
        new BadRequestException('Invalid or expired code'),
      );
      expect(prisma.emailVerification.updateMany).toHaveBeenCalledTimes(1); // the claim only
    });

    it('no attempts left → 400 "Too many attempts", even for the right code', async () => {
      prisma.emailVerification.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.confirm(email, '482913')).rejects.toThrow(
        new BadRequestException('Too many attempts; request a new code'),
      );
    });

    it('no live code (unknown, expired, already used) → 400 without claiming an attempt', async () => {
      prisma.emailVerification.findFirst.mockResolvedValue(null);

      await expect(service.confirm(email, '482913')).rejects.toThrow(
        new BadRequestException('Invalid or expired code'),
      );
      expect(prisma.emailVerification.updateMany).not.toHaveBeenCalled();
    });

    it('loses a race with a parallel correct confirm → 400 (no second token)', async () => {
      prisma.emailVerification.updateMany
        .mockResolvedValueOnce({ count: 1 }) // attempt claimed
        .mockResolvedValueOnce({ count: 0 }); // someone else verified first

      await expect(service.confirm(email, '482913')).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('consume', () => {
    let tx: { emailVerification: { updateMany: jest.Mock } };

    beforeEach(() => {
      tx = {
        emailVerification: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
    });

    it('spends the token once, only for its address, unexpired, through the caller’s transaction', async () => {
      await service.consume(tx as any, { token: 'raw-token', email: email });

      expect(tx.emailVerification.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: sha256('raw-token'),
          email: email,
          consumedAt: null,
          tokenExpiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
      expect(prisma.emailVerification.updateMany).not.toHaveBeenCalled();
    });

    it('normalizes the address the same way as start (case, spaces)', async () => {
      await service.consume(tx as any, {
        token: 'raw-token',
        email: '  New@Example.COM ',
      });

      expect(tx.emailVerification.updateMany.mock.calls[0][0].where.email).toBe(
        'new@example.com',
      );
    });

    it('nothing matched (reused, expired, other address, made up) → 400', async () => {
      tx.emailVerification.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.consume(tx as any, { token: 'raw-token', email: email }),
      ).rejects.toThrow(
        new BadRequestException('Invalid or expired email verification'),
      );
    });
  });
});
