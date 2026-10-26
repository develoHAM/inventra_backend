import { createHash } from 'node:crypto';
import { SignupTicketService } from './signup-ticket.service';
import { decryptToken } from '../../common/token-cipher';
import type { SocialIdentity } from '../verifiers/social-identity-verifier';

describe('SignupTicketService', () => {
  let service: SignupTicketService;
  let prisma: { socialSignupTicket: { create: jest.Mock } };

  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  const now = new Date('2026-10-22T10:00:00.000Z');
  const sha256 = (value: string) =>
    createHash('sha256').update(value).digest('hex');

  const appleIdentity: SocialIdentity = {
    provider: 'apple',
    providerUserId: '001234.0a1b2c3d4e5f.0123',
    email: 'x7k2@privaterelay.appleid.com',
    emailVerified: true,
    name: '김 사장',
    refreshToken: 'r-apple',
  };
  /** What the service passed to prisma.socialSignupTicket.create. */
  const storedTicket = () =>
    prisma.socialSignupTicket.create.mock.calls[0][0].data;

  beforeEach(() => {
    jest.useFakeTimers({ now: now });
    prisma = {
      socialSignupTicket: {
        create: jest.fn().mockResolvedValue({ id: 'ticket-1' }),
      },
    };
    const config = { get: jest.fn().mockReturnValue(encryptionKey) };
    service = new SignupTicketService(prisma as any, config as any);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a random 32-byte token (base64url), valid 15 minutes, and the profile', async () => {
    const ticket = await service.create(appleIdentity);

    expect(ticket.signupToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticket.expiresInSeconds).toBe(900);
    expect(ticket.profile).toEqual({
      email: 'x7k2@privaterelay.appleid.com',
      emailVerified: true,
      name: '김 사장',
    });
  });

  it('stores only the SHA-256 of the token, with the identity, expiring in 15 minutes', async () => {
    const ticket = await service.create(appleIdentity);

    expect(storedTicket()).toMatchObject({
      tokenHash: sha256(ticket.signupToken),
      provider: 'apple',
      providerUserId: '001234.0a1b2c3d4e5f.0123',
      email: 'x7k2@privaterelay.appleid.com',
      emailVerified: true,
      name: '김 사장',
      expiresAt: new Date('2026-10-22T10:15:00.000Z'),
    });
  });

  it('encrypts the provider refresh token (never stored in plain text)', async () => {
    await service.create(appleIdentity);

    const stored = storedTicket().providerRefreshToken as string;
    expect(stored).not.toContain('r-apple');
    expect(decryptToken(stored, encryptionKey)).toBe('r-apple');
  });

  it('no refresh token (Kakao, Facebook) → null', async () => {
    await service.create({ ...appleIdentity, refreshToken: null });

    expect(storedTicket().providerRefreshToken).toBeNull();
  });

  it('caps the name at the 100-character column (Apple’s name is unsigned app input)', async () => {
    const ticket = await service.create({
      ...appleIdentity,
      name: 'x'.repeat(500),
    });

    expect(storedTicket().name).toHaveLength(100);
    expect(ticket.profile.name).toHaveLength(100);
  });

  it('no name → null', async () => {
    const ticket = await service.create({ ...appleIdentity, name: null });

    expect(ticket.profile.name).toBeNull();
  });

  it('every ticket is different', async () => {
    const first = await service.create(appleIdentity);
    const second = await service.create(appleIdentity);

    expect(first.signupToken).not.toBe(second.signupToken);
  });
});
