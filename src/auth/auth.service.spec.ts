import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthProfile } from './types/auth-profile';
import { AuthService } from './auth.service';
import {
  PhoneVerificationPurpose,
  ProfileStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let tx: {
    profile: { create: jest.Mock; update: jest.Mock };
    company: { create: jest.Mock; findUnique: jest.Mock };
    accountLoginMethod: { createMany: jest.Mock };
  };
  let passwordService: { hash: jest.Mock; verify: jest.Mock };
  let tokenService: {
    signAccess: jest.Mock;
    signRefresh: jest.Mock;
    hashToken: jest.Mock;
    verifyRefresh: jest.Mock;
  };
  let phoneVerification: { consume: jest.Mock };
  let devices: { unregister: jest.Mock };
  let signupTickets: { consume: jest.Mock };
  let accounts: {
    createAccount: jest.Mock;
    findProfileToOpen: jest.Mock;
    findOpenableProfile: jest.Mock;
    listCompanies: jest.Mock;
  };

  /** The profile AccountsService opens at login. */
  const openProfile = (changes: Record<string, unknown> = {}) => ({
    id: 'profile-1',
    status: ProfileStatus.ACTIVE,
    companyId: 'company-1',
    roleId: 2,
    ...changes,
  });

  /** The account's company list, as AccountsService.listCompanies returns it. */
  const companies = [
    {
      profileId: 'profile-1',
      status: ProfileStatus.ACTIVE,
      name: 'Jane Owner',
      profileImageUrl: null,
      role: { code: 'OWNER', name: 'Owner' },
      company: { id: 'company-1', name: 'Acme' },
    },
  ];

  /** A spent Kakao ticket whose provider email is verified. */
  const kakaoTicket = {
    provider: 'kakao',
    providerUserId: '4012345678',
    email: 'owner@kakao.com',
    emailVerified: true,
    name: '김사장',
    providerRefreshToken: null,
  };

  beforeEach(() => {
    // transaction-scoped client used by signup
    tx = {
      profile: {
        create: jest.fn().mockResolvedValue({ id: 'profile-1' }),
        update: jest.fn().mockResolvedValue({
          id: 'profile-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: 2,
        }),
      },
      company: {
        create: jest.fn().mockResolvedValue({ id: 'company-1' }),
        // member signup looks the join code up inside its transaction
        findUnique: jest.fn().mockResolvedValue({
          id: 'company-1',
          joinCode: '48291307',
        }),
      },
      // the first login method: ON CONFLICT DO NOTHING → count 1 inserted, 0 skipped
      accountLoginMethod: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    prisma = {
      accountLoginMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      // null default = "not taken" (register tax-ID check) / "not found" (member join-code)
      company: { findUnique: jest.fn().mockResolvedValue(null) },
      role: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 2, code: 'OWNER' }),
      },
      account: {
        // null default = "phone not taken" (the phone lives on the account)
        findFirst: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ phone: '01012345678' }),
        update: jest.fn().mockResolvedValue({}),
      },
      refreshToken: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };

    passwordService = {
      hash: jest.fn().mockResolvedValue('hashed-pw'),
      verify: jest.fn().mockResolvedValue(true),
    };
    tokenService = {
      signAccess: jest.fn().mockResolvedValue('access-token'),
      signRefresh: jest.fn().mockResolvedValue({
        token: 'refresh-token',
        jti: 'jti-1',
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      }),
      hashToken: jest.fn().mockReturnValue('hashed-refresh'),
      verifyRefresh: jest
        .fn()
        .mockResolvedValue({ accountId: 'account-1', jti: 'jti-1' }),
    };

    phoneVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    devices = { unregister: jest.fn().mockResolvedValue(undefined) };
    signupTickets = { consume: jest.fn().mockResolvedValue(kakaoTicket) };
    accounts = {
      createAccount: jest.fn().mockResolvedValue('account-1'),
      findProfileToOpen: jest.fn().mockResolvedValue(openProfile()),
      findOpenableProfile: jest.fn().mockResolvedValue(openProfile()),
      listCompanies: jest.fn().mockResolvedValue(companies),
    };
    // constructor order: (prisma, passwordService, tokenService,
    // phoneVerification, devices, signupTickets, accounts)
    service = new AuthService(
      prisma,
      passwordService,
      tokenService as any,
      phoneVerification as any,
      devices as any,
      signupTickets as any,
      accounts as any,
    );
  });

  describe('signup (the sign-in only: an account and its first login method)', () => {
    const passwordSignup = {
      phone: '01055556666',
      phoneVerificationToken: 'signup-phone-token',
      credentials: {
        type: 'password',
        email: 'sam@acme.com',
        password: 'password123',
      },
    };
    const socialSignup = {
      phone: '01055556666',
      phoneVerificationToken: 'signup-phone-token',
      credentials: { type: 'social', signupToken: 'raw-signup-token' },
    };

    beforeEach(() => {
      accounts.listCompanies.mockResolvedValue([]); // a brand-new account belongs nowhere
    });

    it('answers a session with no company open: profile null, companies []', async () => {
      const result = await service.signup(passwordSignup as any);

      expect(tokenService.signAccess).toHaveBeenCalledWith({
        accountId: 'account-1',
        profileId: null,
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          accountId: 'account-1',
          profileId: null,
          tokenHash: 'hashed-refresh',
          expiresAt: expect.any(Date),
        },
      });
      expect(accounts.listCompanies).toHaveBeenCalledWith('account-1');
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        profile: null,
        companies: [],
      });
    });

    it('creates the account with the verified phone and its password login — and no profile, no company', async () => {
      await service.signup(passwordSignup as any);

      expect(accounts.createAccount).toHaveBeenCalledWith(tx, '01055556666');
      expect(tx.accountLoginMethod.createMany).toHaveBeenCalledWith({
        data: [
          {
            method: 'local',
            email: 'sam@acme.com',
            passwordHash: 'hashed-pw',
            accountId: 'account-1',
          },
        ],
        skipDuplicates: true,
      });
      expect(tx.profile.create).not.toHaveBeenCalled();
      expect(tx.company.create).not.toHaveBeenCalled();
    });

    it('spends the SIGNUP phone token inside the transaction, before the account is created', async () => {
      await service.signup(passwordSignup as any);

      expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
        token: 'signup-phone-token',
        phone: '01055556666',
        purpose: PhoneVerificationPurpose.SIGNUP,
      });
      expect(
        phoneVerification.consume.mock.invocationCallOrder[0],
      ).toBeLessThan(accounts.createAccount.mock.invocationCallOrder[0]);
    });

    it('starts the session only AFTER the transaction commits (the account must be visible to it)', async () => {
      prisma.$transaction.mockImplementation(async (callback: any) => {
        const result = await callback(tx);
        // still inside the transaction: no session row yet
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        return result;
      });

      await service.signup(passwordSignup as any);

      expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    });

    it('hashes the password BEFORE the transaction (argon2 is slow)', async () => {
      await service.signup(passwordSignup as any);

      expect(passwordService.hash).toHaveBeenCalledWith('password123');
      expect(passwordService.hash.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.$transaction.mock.invocationCallOrder[0],
      );
    });

    describe('a social signup', () => {
      it('spends the ticket inside the transaction and links the provider identity', async () => {
        await service.signup(socialSignup as any);

        expect(signupTickets.consume).toHaveBeenCalledWith(
          tx,
          'raw-signup-token',
        );
        expect(tx.accountLoginMethod.createMany).toHaveBeenCalledWith({
          data: [
            {
              method: 'kakao',
              providerUserId: '4012345678',
              email: 'owner@kakao.com',
              emailVerified: true,
              refreshToken: null,
              accountId: 'account-1',
            },
          ],
          skipDuplicates: true,
        });
      });

      it('no password: no email-taken check, no hashing', async () => {
        await service.signup(socialSignup as any);

        expect(prisma.accountLoginMethod.findFirst).not.toHaveBeenCalled();
        expect(passwordService.hash).not.toHaveBeenCalled();
      });

      it('an invalid ticket → its error passes through: no account, no session', async () => {
        signupTickets.consume.mockRejectedValue(
          new BadRequestException('Invalid or expired signup token'),
        );

        await expect(service.signup(socialSignup as any)).rejects.toThrow(
          new BadRequestException('Invalid or expired signup token'),
        );
        expect(accounts.createAccount).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('the identity got registered meanwhile (count 0) → 409, no session', async () => {
        tx.accountLoginMethod.createMany.mockResolvedValue({ count: 0 });

        await expect(service.signup(socialSignup as any)).rejects.toThrow(
          new ConflictException('This account is already registered'),
        );
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });
    });

    describe('409s', () => {
      it('an email a password login already has → 409 before anything is spent', async () => {
        prisma.accountLoginMethod.findFirst.mockResolvedValue({ id: 'lm-1' });

        await expect(service.signup(passwordSignup as any)).rejects.toThrow(
          new ConflictException('Email already registered'),
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(phoneVerification.consume).not.toHaveBeenCalled();
      });

      it('a phone a live account already has → 409 before anything is spent', async () => {
        prisma.account.findFirst.mockResolvedValue({ id: 'account-9' });

        await expect(service.signup(passwordSignup as any)).rejects.toThrow(
          new ConflictException('Phone already registered'),
        );
        expect(prisma.account.findFirst).toHaveBeenCalledWith({
          where: { phone: '01055556666', deletedAt: null },
          select: { id: true },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('the phone got taken meanwhile (createAccount → null) → 409 thrown inside: no login method, no session', async () => {
        accounts.createAccount.mockResolvedValue(null);

        await expect(service.signup(passwordSignup as any)).rejects.toThrow(
          new ConflictException('Phone already registered'),
        );
        expect(tx.accountLoginMethod.createMany).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });

      it('the email got taken meanwhile (count 0) → 409 Email already registered, no session', async () => {
        tx.accountLoginMethod.createMany.mockResolvedValue({ count: 0 });

        await expect(service.signup(passwordSignup as any)).rejects.toThrow(
          new ConflictException('Email already registered'),
        );
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('login', () => {
    const loginDto = { email: 'jane@acme.com', password: 'password123' };

    /** The password login, with the account it belongs to. */
    const passwordLogin = (accountChanges: Record<string, unknown> = {}) => ({
      passwordHash: 'stored-hash',
      account: {
        id: 'account-1',
        deletedAt: null,
        lastProfileId: 'profile-1',
        ...accountChanges,
      },
    });

    it('finds the password login by email, with its account', async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue(passwordLogin());

      await service.login(loginDto);

      expect(prisma.accountLoginMethod.findFirst).toHaveBeenCalledWith({
        where: { email: 'jane@acme.com', method: 'local' },
        include: {
          account: {
            select: { id: true, deletedAt: true, lastProfileId: true },
          },
        },
      });
    });

    it("opens the profile AccountsService picks (the account's last-used one) and returns a SessionResponse", async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue(passwordLogin());

      const result = await service.login(loginDto);

      // verify(storedHash, candidate) — argument order matters
      expect(passwordService.verify).toHaveBeenCalledWith(
        'stored-hash',
        'password123',
      );
      expect(accounts.findProfileToOpen).toHaveBeenCalledWith(
        'account-1',
        'profile-1',
      );
      expect(tokenService.signAccess).toHaveBeenCalledWith({
        accountId: 'account-1',
        profileId: 'profile-1',
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          accountId: 'account-1',
          profileId: 'profile-1',
          tokenHash: 'hashed-refresh',
          expiresAt: expect.any(Date),
        },
      });
      expect(accounts.listCompanies).toHaveBeenCalledWith('account-1');
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        profile: {
          id: 'profile-1',
          status: ProfileStatus.ACTIVE,
          companyId: 'company-1',
          roleId: 2,
        },
        companies: companies, // the company dropdown
      });
    });

    it('a PENDING profile may be opened (lands on the pending screen)', async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue(passwordLogin());
      accounts.findProfileToOpen.mockResolvedValue(
        openProfile({ status: ProfileStatus.PENDING_APPROVAL }),
      );

      const result = await service.login(loginDto);

      expect(result.profile?.status).toBe(ProfileStatus.PENDING_APPROVAL);
    });

    it('rejects an unknown email with a generic 401 (no enumeration)', async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue(null);

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(passwordService.verify).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with a generic 401', async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue(passwordLogin());
      passwordService.verify.mockResolvedValue(false);

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('no profile can be opened (no company yet, or every one left…) → signs in with profile null', async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue(passwordLogin());
      accounts.findProfileToOpen.mockResolvedValue(null);
      accounts.listCompanies.mockResolvedValue([]);

      const result = await service.login(loginDto);

      // a session of the account with nothing open: the app shows join-or-create
      expect(tokenService.signAccess).toHaveBeenCalledWith({
        accountId: 'account-1',
        profileId: null,
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: 'account-1',
          profileId: null,
        }),
      });
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        profile: null,
        companies: [],
      });
    });

    it('a soft-deleted account → 401, no profile looked up, no session', async () => {
      prisma.accountLoginMethod.findFirst.mockResolvedValue(
        passwordLogin({ deletedAt: new Date('2026-12-01') }),
      );

      await expect(service.login(loginDto as any)).rejects.toThrow(
        new UnauthorizedException('Account cannot sign in'),
      );
      expect(accounts.findProfileToOpen).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  /** A live session of account-1, with profile-1 open; the account last chose profile-2. */
  const storedSession = (changes: Record<string, unknown> = {}) => ({
    tokenHash: 'hashed-refresh',
    accountId: 'account-1',
    profileId: 'profile-1',
    revokedAt: null,
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    account: { deletedAt: null, lastProfileId: 'profile-2' },
    ...changes,
  });

  describe('refresh (rotation + reuse detection)', () => {
    const refreshDto = { refreshToken: 'refresh-token-string' };

    it("finds the session by the token's hash, with the account's deletedAt and lastProfileId", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedSession());

      await service.refresh(refreshDto);

      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: 'hashed-refresh' },
        include: {
          account: { select: { deletedAt: true, lastProfileId: true } },
        },
      });
    });

    it("rotates: revokes the old token and keeps the session's profile while it is still openable", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedSession());

      const result = await service.refresh(refreshDto);

      expect(accounts.findOpenableProfile).toHaveBeenCalledWith(
        'account-1',
        'profile-1',
      );
      // kept: no fallback was needed, so lastProfileId was never consulted
      expect(accounts.findProfileToOpen).not.toHaveBeenCalled();
      // old token revoked
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash: 'hashed-refresh' },
        data: { revokedAt: expect.any(Date) },
      });
      // new pair issued + stored, the session keeps its open profile
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          accountId: 'account-1',
          profileId: 'profile-1',
          tokenHash: 'hashed-refresh',
          expiresAt: expect.any(Date),
        },
      });
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        profile: openProfile(),
        companies: companies,
      });
    });

    it("Review Focus 3: the session's profile stopped being openable → falls back the sign-in way (lastProfileId)", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedSession());
      accounts.findOpenableProfile.mockResolvedValue(null); // left, suspended or deleted
      accounts.findProfileToOpen.mockResolvedValue(
        openProfile({ id: 'profile-2', companyId: 'company-2' }),
      );

      const result = await service.refresh(refreshDto);

      expect(accounts.findProfileToOpen).toHaveBeenCalledWith(
        'account-1',
        'profile-2', // the account's last choice, not the dead session profile
      );
      expect(tokenService.signAccess).toHaveBeenCalledWith({
        accountId: 'account-1',
        profileId: 'profile-2',
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ profileId: 'profile-2' }),
      });
      expect(result.profile?.id).toBe('profile-2');
    });

    it('Review Focus 3: nothing openable any more → the new session has no profile (never the dead one)', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedSession());
      accounts.findOpenableProfile.mockResolvedValue(null);
      accounts.findProfileToOpen.mockResolvedValue(null);
      accounts.listCompanies.mockResolvedValue([]);

      const result = await service.refresh(refreshDto);

      expect(tokenService.signAccess).toHaveBeenCalledWith({
        accountId: 'account-1',
        profileId: null,
      });
      expect(result.profile).toBeNull();
      expect(result.companies).toEqual([]);
    });

    it('a session with no profile open → straight to the sign-in choice (e.g. a company joined since)', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedSession({ profileId: null }),
      );

      await service.refresh(refreshDto);

      expect(accounts.findOpenableProfile).not.toHaveBeenCalled();
      expect(accounts.findProfileToOpen).toHaveBeenCalledWith(
        'account-1',
        'profile-2',
      );
    });

    it('a soft-deleted account → 401, nothing revoked or issued', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedSession({
          account: { deletedAt: new Date('2026-11-01'), lastProfileId: null },
        }),
      );

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        new UnauthorizedException('Invalid refresh token'),
      );
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects an invalid refresh JWT with 401', async () => {
      tokenService.verifyRefresh.mockRejectedValue(new Error('bad'));

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a token that is not in the store with 401', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it("detects reuse: a revoked token revokes ALL the account's sessions and 401s", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedSession({ revokedAt: new Date('2027-01-01T00:00:00Z') }), // already revoked
      );

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        new UnauthorizedException('Refresh token reuse detected'),
      );
      // every session of the person, whichever company each had open
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { accountId: 'account-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // and NO new session issued
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('switchProfile (POST /auth/switch)', () => {
    /** The caller, as the guard put it on the request: profile-1 open. */
    const caller = { accountId: 'account-1', profileId: 'profile-1' };
    const switchDto = {
      refreshToken: 'refresh-token-string',
      profileId: 'profile-2',
    };
    const profileTwo = openProfile({ id: 'profile-2', companyId: 'company-2' });

    beforeEach(() => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedSession());
      accounts.findOpenableProfile.mockResolvedValue(profileTwo);
    });

    it("checks the target is the caller's own, openable profile", async () => {
      await service.switchProfile(caller, switchDto);

      expect(accounts.findOpenableProfile).toHaveBeenCalledWith(
        'account-1',
        'profile-2',
      );
    });

    it('rotates the session onto the new profile: old row revoked, new row remembers profile-2', async () => {
      await service.switchProfile(caller, switchDto);

      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash: 'hashed-refresh' },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          accountId: 'account-1',
          profileId: 'profile-2',
          tokenHash: 'hashed-refresh',
          expiresAt: expect.any(Date),
        },
      });
      expect(tokenService.signAccess).toHaveBeenCalledWith({
        accountId: 'account-1',
        profileId: 'profile-2',
      });
    });

    it('remembers the choice for the next sign-in (accounts.lastProfileId) — only switching writes it', async () => {
      await service.switchProfile(caller, switchDto);

      expect(prisma.account.update).toHaveBeenCalledWith({
        where: { id: 'account-1' },
        data: { lastProfileId: 'profile-2' },
      });
    });

    it('returns the new SessionResponse', async () => {
      await expect(service.switchProfile(caller, switchDto)).resolves.toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        profile: profileTwo,
        companies: companies,
      });
    });

    it("another account's profile, or one not openable → 404 Company profile not found, and nothing is revoked", async () => {
      accounts.findOpenableProfile.mockResolvedValue(null);

      await expect(service.switchProfile(caller, switchDto)).rejects.toThrow(
        new NotFoundException('Company profile not found'),
      );
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
      expect(prisma.account.update).not.toHaveBeenCalled();
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('a refresh token of ANOTHER account → 401, before the target is even looked at', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedSession({ accountId: 'account-2' }),
      );

      await expect(service.switchProfile(caller, switchDto)).rejects.toThrow(
        new UnauthorizedException('Invalid refresh token'),
      );
      expect(accounts.findOpenableProfile).not.toHaveBeenCalled();
      expect(prisma.refreshToken.update).not.toHaveBeenCalled();
    });

    it('a revoked refresh token → reuse detection: every session of the account revoked, 401', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(
        storedSession({ revokedAt: new Date('2027-01-01T00:00:00Z') }),
      );

      await expect(service.switchProfile(caller, switchDto)).rejects.toThrow(
        new UnauthorizedException('Refresh token reuse detected'),
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { accountId: 'account-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('an invalid refresh JWT → 401, nothing looked up', async () => {
      tokenService.verifyRefresh.mockRejectedValue(new Error('bad'));

      await expect(service.switchProfile(caller, switchDto)).rejects.toThrow(
        new UnauthorizedException('Invalid refresh token'),
      );
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('me (GET /auth/me)', () => {
    const openAuthProfile: AuthProfile = {
      id: 'profile-1',
      accountId: 'account-1',
      companyId: 'company-1',
      branchIds: [],
      roleId: 2,
      roleCode: 'OWNER',
      status: ProfileStatus.ACTIVE,
    };

    it('returns the account (id + phone) and the open profile', async () => {
      await expect(
        service.me(
          { accountId: 'account-1', profileId: 'profile-1' },
          openAuthProfile,
        ),
      ).resolves.toEqual({
        accountId: 'account-1',
        phone: '01012345678',
        profile: openAuthProfile,
      });

      expect(prisma.account.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'account-1' },
        select: { phone: true },
      });
    });

    it('no profile open → profile: null', async () => {
      await expect(
        service.me({ accountId: 'account-1', profileId: null }, null),
      ).resolves.toEqual({
        accountId: 'account-1',
        phone: '01012345678',
        profile: null,
      });
    });
  });

  describe('logout', () => {
    it("revokes the presented refresh token, scoped to the caller's account", async () => {
      await service.logout('account-1', {
        refreshToken: 'refresh-token-string',
      });

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: 'hashed-refresh',
          accountId: 'account-1',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('also removes the device token, so the phone stops showing pushes from every company', async () => {
      await service.logout('account-1', {
        refreshToken: 'refresh-token-string',
        deviceToken: 'phone-token',
      });

      // scoped to the caller's account: someone else's device is never touched
      expect(devices.unregister).toHaveBeenCalledWith(
        'account-1',
        'phone-token',
      );
    });

    it('leaves devices alone when no deviceToken is sent (e.g. the web console)', async () => {
      await service.logout('account-1', {
        refreshToken: 'refresh-token-string',
      });

      expect(devices.unregister).not.toHaveBeenCalled();
    });
  });
});
