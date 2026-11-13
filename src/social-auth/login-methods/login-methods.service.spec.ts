import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginMethodsService } from './login-methods.service';
import { decryptToken, encryptToken } from '../../common/token-cipher';
import type { SocialIdentity } from '../verifiers/social-identity-verifier';

describe('LoginMethodsService', () => {
  let service: LoginMethodsService;
  let prisma: {
    accountLoginMethod: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      createManyAndReturn: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let tx: {
    account: { updateMany: jest.Mock };
    accountLoginMethod: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      count: jest.Mock;
      delete: jest.Mock;
      createManyAndReturn: jest.Mock;
    };
  };
  let socialAuth: { identify: jest.Mock };
  let verifiers: Record<string, { verify: jest.Mock; disconnect: jest.Mock }>;
  let passwords: { hash: jest.Mock };
  let emailVerification: { consume: jest.Mock };

  const encryptionKey = Buffer.alloc(32, 7).toString('base64');
  const googleIdentity: SocialIdentity = {
    provider: 'google',
    providerUserId: '109876543210',
    email: 'owner@gmail.com',
    emailVerified: true,
    name: 'Kim Owner',
    refreshToken: '1//google-refresh',
  };
  const linkBody = {
    provider: 'google' as const,
    credential: { idToken: 'g' },
  };
  const linkPasswordDto = {
    email: 'owner@example.com',
    password: 'brand-new-password',
    emailVerificationToken: 'raw-email-token',
  };

  beforeEach(() => {
    tx = {
      account: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      accountLoginMethod: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(2),
        delete: jest.fn().mockResolvedValue({}),
        createManyAndReturn: jest
          .fn()
          .mockResolvedValue([
            { id: 'lm-new', method: 'local', email: 'owner@example.com' },
          ]),
      },
    };
    prisma = {
      accountLoginMethod: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        createManyAndReturn: jest
          .fn()
          .mockResolvedValue([
            { id: 'lm-new', method: 'google', email: 'owner@gmail.com' },
          ]),
      },
      $transaction: jest.fn(async (work: (client: unknown) => unknown) =>
        work(tx),
      ),
    };
    socialAuth = { identify: jest.fn().mockResolvedValue(googleIdentity) };
    const verifierStub = () => ({
      verify: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
    });
    verifiers = {
      kakao: verifierStub(),
      google: verifierStub(),
      apple: verifierStub(),
      facebook: verifierStub(),
    };
    passwords = { hash: jest.fn().mockResolvedValue('hashed-pw') };
    emailVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    const config = { get: jest.fn().mockReturnValue(encryptionKey) };
    service = new LoginMethodsService(
      prisma as any,
      socialAuth as any,
      verifiers as any,
      passwords as any,
      emailVerification as any,
      config as any,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('list', () => {
    it("the account's logins, oldest first: the password email masked, providers without email", async () => {
      prisma.accountLoginMethod.findMany.mockResolvedValue([
        { id: 'lm-1', method: 'local', email: 'owner@example.com' },
        { id: 'lm-2', method: 'kakao', email: 'owner@kakao.com' },
      ]);

      await expect(service.list('account-1')).resolves.toEqual([
        { id: 'lm-1', method: 'local', email: 'ow***@example.com' },
        { id: 'lm-2', method: 'kakao', email: null },
      ]);
      expect(prisma.accountLoginMethod.findMany).toHaveBeenCalledWith({
        where: { accountId: 'account-1' },
        select: { id: true, method: true, email: true },
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  describe('linkProvider', () => {
    it('proves the identity exactly like social sign-in (nonce + verifier)', async () => {
      await service.linkProvider('account-1', linkBody);

      expect(socialAuth.identify).toHaveBeenCalledWith(linkBody);
    });

    it('inserts it for the account with ON CONFLICT DO NOTHING; the refresh token encrypted', async () => {
      await expect(
        service.linkProvider('account-1', linkBody),
      ).resolves.toEqual({
        id: 'lm-new',
        method: 'google',
        email: null,
      });

      const args =
        prisma.accountLoginMethod.createManyAndReturn.mock.calls[0][0];
      expect(args.skipDuplicates).toBe(true);
      expect(args.data).toEqual([
        {
          accountId: 'account-1',
          method: 'google',
          providerUserId: '109876543210',
          email: 'owner@gmail.com',
          emailVerified: true,
          refreshToken: expect.any(String),
        },
      ]);
      expect(decryptToken(args.data[0].refreshToken, encryptionKey)).toBe(
        '1//google-refresh',
      );
    });

    it('a provider without a refresh token (Kakao) → null', async () => {
      socialAuth.identify.mockResolvedValue({
        ...googleIdentity,
        provider: 'kakao',
        refreshToken: null,
      });

      await service.linkProvider('account-1', {
        ...linkBody,
        provider: 'kakao',
      });

      expect(
        prisma.accountLoginMethod.createManyAndReturn.mock.calls[0][0].data[0]
          .refreshToken,
      ).toBeNull();
    });

    it('an unproven credential → its 401, nothing inserted', async () => {
      socialAuth.identify.mockRejectedValue(
        new UnauthorizedException('Invalid social credential'),
      );

      await expect(
        service.linkProvider('account-1', linkBody),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(
        prisma.accountLoginMethod.createManyAndReturn,
      ).not.toHaveBeenCalled();
    });

    describe('nothing inserted → 409, with the reason looked up afterwards', () => {
      beforeEach(() => {
        prisma.accountLoginMethod.createManyAndReturn.mockResolvedValue([]);
      });

      it.each([
        [
          'the identity is already this account’s',
          { accountId: 'account-1' },
          'This account is already linked to you',
        ],
        [
          'the identity belongs to another account',
          { accountId: 'someone-else' },
          'This account is linked to another user',
        ],
        [
          'the account has another login with this provider',
          null,
          'You already have a login with this provider; unlink it first',
        ],
      ])('%s', async (_label, holder, message) => {
        prisma.accountLoginMethod.findUnique.mockResolvedValue(holder);

        await expect(
          service.linkProvider('account-1', linkBody),
        ).rejects.toThrow(new ConflictException(message));
        expect(prisma.accountLoginMethod.findUnique).toHaveBeenCalledWith({
          where: {
            method_providerUserId: {
              method: 'google',
              providerUserId: '109876543210',
            },
          },
          select: { accountId: true },
        });
      });
    });
  });

  describe('linkPassword', () => {
    it('hashes BEFORE the transaction, then spends the email proof and inserts, together', async () => {
      await expect(
        service.linkPassword('account-1', linkPasswordDto),
      ).resolves.toEqual({
        id: 'lm-new',
        method: 'local',
        email: 'ow***@example.com',
      });

      expect(passwords.hash).toHaveBeenCalledWith('brand-new-password');
      expect(passwords.hash.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
      expect(emailVerification.consume).toHaveBeenCalledWith(tx, {
        token: 'raw-email-token',
        email: 'owner@example.com',
      });
      expect(tx.accountLoginMethod.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          {
            accountId: 'account-1',
            method: 'local',
            email: 'owner@example.com',
            emailVerified: true,
            passwordHash: 'hashed-pw',
          },
        ],
        skipDuplicates: true,
        select: { id: true, method: true, email: true },
      });
    });

    it('the account already has a password login → 409 before anything is spent', async () => {
      prisma.accountLoginMethod.findUnique.mockResolvedValue({
        id: 'lm-local',
      });

      await expect(
        service.linkPassword('account-1', linkPasswordDto),
      ).rejects.toThrow(
        new ConflictException('You already have a password login'),
      );
      expect(passwords.hash).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('another password login uses this email → 409 (emails are stored lowercase, so a plain comparison)', async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue({ id: 'lm-other' });

      await expect(
        service.linkPassword('account-1', linkPasswordDto),
      ).rejects.toThrow(new ConflictException('Email already registered'));
      expect(prisma.accountLoginMethod.findFirst).toHaveBeenCalledWith({
        where: { method: 'local', email: 'owner@example.com' },
        select: { id: true },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('an invalid email proof → its 400, nothing inserted', async () => {
      emailVerification.consume.mockRejectedValue(
        new BadRequestException('Invalid or expired email verification'),
      );

      await expect(
        service.linkPassword('account-1', linkPasswordDto),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.accountLoginMethod.createManyAndReturn).not.toHaveBeenCalled();
    });

    describe('something changed between the checks and the insert (another device, the same instant)', () => {
      beforeEach(() => {
        // the database refused the row: ON CONFLICT DO NOTHING → nothing returned
        tx.accountLoginMethod.createManyAndReturn.mockResolvedValue([]);
      });

      it('this account got a password login meanwhile → 409, read inside the transaction', async () => {
        tx.accountLoginMethod.findUnique.mockResolvedValue({ id: 'lm-local' });

        await expect(
          service.linkPassword('account-1', linkPasswordDto),
        ).rejects.toThrow(
          new ConflictException('You already have a password login'),
        );
        expect(tx.accountLoginMethod.findUnique).toHaveBeenCalledWith({
          where: {
            accountId_method: { accountId: 'account-1', method: 'local' },
          },
          select: { id: true },
        });
      });

      it('another account took this email meanwhile (UQ_login_methods_local_email) → 409', async () => {
        await expect(
          service.linkPassword('account-1', linkPasswordDto),
        ).rejects.toThrow(new ConflictException('Email already registered'));
      });

      it('either way the transaction rolls back, so the email proof is not spent', async () => {
        await expect(
          service.linkPassword('account-1', linkPasswordDto),
        ).rejects.toThrow(ConflictException);
        await expect(prisma.$transaction.mock.results[0].value).rejects.toThrow(
          ConflictException,
        );
      });
    });
  });

  describe('unlink', () => {
    const googleLogin = {
      id: 'lm-google',
      accountId: 'account-1',
      method: 'google',
      providerUserId: '109876543210',
      refreshToken: encryptToken('1//google-refresh', encryptionKey),
    };

    beforeEach(() => {
      tx.accountLoginMethod.findFirst.mockResolvedValue(googleLogin);
    });

    it("locks the account's row FIRST, so two unlinks can't both remove the last two logins", async () => {
      await service.unlink('account-1', 'lm-google');

      expect(tx.account.updateMany).toHaveBeenCalledWith({
        where: { id: 'account-1' },
        data: { updatedAt: expect.any(Date) },
      });
      expect(tx.account.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        tx.accountLoginMethod.count.mock.invocationCallOrder[0],
      );
    });

    it('deletes only the caller’s own login', async () => {
      await service.unlink('account-1', 'lm-google');

      expect(tx.accountLoginMethod.findFirst).toHaveBeenCalledWith({
        where: { id: 'lm-google', accountId: 'account-1' },
      });
      expect(tx.accountLoginMethod.delete).toHaveBeenCalledWith({
        where: { id: 'lm-google' },
      });
    });

    it('not theirs, or no such login → 404, nothing deleted', async () => {
      tx.accountLoginMethod.findFirst.mockResolvedValue(null);

      await expect(service.unlink('account-1', 'lm-google')).rejects.toThrow(
        new NotFoundException('Login method not found'),
      );
      expect(tx.accountLoginMethod.delete).not.toHaveBeenCalled();
      expect(verifiers.google.disconnect).not.toHaveBeenCalled();
    });

    it('the last login → 409, nothing deleted', async () => {
      tx.accountLoginMethod.count.mockResolvedValue(1);

      await expect(service.unlink('account-1', 'lm-google')).rejects.toThrow(
        new ConflictException('An account needs at least one way to sign in'),
      );
      expect(tx.accountLoginMethod.delete).not.toHaveBeenCalled();
      expect(verifiers.google.disconnect).not.toHaveBeenCalled();
    });

    it('then asks the provider to forget us, with the DECRYPTED refresh token', async () => {
      await service.unlink('account-1', 'lm-google');

      expect(verifiers.google.disconnect).toHaveBeenCalledWith({
        providerUserId: '109876543210',
        refreshToken: '1//google-refresh',
      });
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        verifiers.google.disconnect.mock.invocationCallOrder[0],
      );
    });

    it('a password login has no provider to tell', async () => {
      tx.accountLoginMethod.findFirst.mockResolvedValue({
        id: 'lm-local',
        accountId: 'account-1',
        method: 'local',
        providerUserId: null,
        refreshToken: null,
      });

      await service.unlink('account-1', 'lm-local');

      for (const verifier of Object.values(verifiers)) {
        expect(verifier.disconnect).not.toHaveBeenCalled();
      }
    });

    it.each([
      [
        'the provider fails',
        () =>
          verifiers.google.disconnect.mockRejectedValue(
            new Error('Google revoke responded 400'),
          ),
      ],
      [
        'the stored token cannot be decrypted',
        () =>
          tx.accountLoginMethod.findFirst.mockResolvedValue({
            ...googleLogin,
            refreshToken: 'not-our-ciphertext',
          }),
      ],
    ])(
      '%s → the unlink still succeeds; a warning is logged',
      async (_label, fail) => {
        fail();

        await expect(
          service.unlink('account-1', 'lm-google'),
        ).resolves.toBeUndefined();
        expect(Logger.prototype.warn).toHaveBeenCalled();
      },
    );
  });
});
