import { createHash } from 'node:crypto';
import { SocialNonceService, nonceClaimFor } from './social-nonce.service';

describe('nonceClaimFor', () => {
  it('is the hex SHA-256 of the raw nonce (what the app hands the SDK)', () => {
    // the standard SHA-256 test vector for "abc"
    expect(nonceClaimFor('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('SocialNonceService', () => {
  let service: SocialNonceService;
  let prisma: { socialNonce: { create: jest.Mock; updateMany: jest.Mock } };

  const now = new Date('2026-10-18T10:00:00.000Z');
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    prisma = {
      socialNonce: {
        create: jest.fn().mockResolvedValue({ id: 'nonce-row-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new SocialNonceService(prisma as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('issue', () => {
    it('returns a random 32-byte nonce (base64url) valid for 5 minutes', async () => {
      const issued = await service.issue();

      expect(issued.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(issued.expiresInSeconds).toBe(300);
    });

    it('stores only the SHA-256 of the nonce, expiring in 5 minutes', async () => {
      const issued = await service.issue();

      expect(prisma.socialNonce.create).toHaveBeenCalledWith({
        data: {
          nonceHash: sha256(issued.nonce),
          expiresAt: new Date('2026-10-18T10:05:00.000Z'),
        },
      });
    });

    it('never repeats', async () => {
      const first = await service.issue();
      const second = await service.issue();

      expect(first.nonce).not.toBe(second.nonce);
    });
  });

  describe('consume', () => {
    it('spends it in one conditional write: matching, unused, unexpired', async () => {
      await service.consume('raw-nonce');

      expect(prisma.socialNonce.updateMany).toHaveBeenCalledWith({
        where: {
          nonceHash: sha256('raw-nonce'),
          consumedAt: null,
          expiresAt: { gt: now },
        },
        data: { consumedAt: now },
      });
    });

    it('true when this call spent it', async () => {
      await expect(service.consume('raw-nonce')).resolves.toBe(true);
    });

    it('false when nothing matched (unknown, reused, expired) — the caller answers 401', async () => {
      prisma.socialNonce.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.consume('raw-nonce')).resolves.toBe(false);
    });
  });
});
