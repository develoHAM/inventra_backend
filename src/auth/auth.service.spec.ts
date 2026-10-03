import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import {
  PhoneVerificationPurpose,
  UserStatus,
} from '../generated/prisma/enums';
import { NotificationEvent } from '../notifications/notification-events';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let tx: {
    user: { create: jest.Mock; update: jest.Mock };
    company: { create: jest.Mock };
  };
  let passwordService: { hash: jest.Mock; verify: jest.Mock };
  let tokenService: {
    signAccess: jest.Mock;
    signRefresh: jest.Mock;
    hashToken: jest.Mock;
    verifyRefresh: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  let phoneVerification: { consume: jest.Mock };

  const registerDto = {
    companyName: 'Acme',
    taxId: '123-45-67890',
    ownerName: 'Jane Owner',
    ownerEmail: 'jane@acme.com',
    ownerPassword: 'password123',
    ownerPhone: '01012345678',
    ownerPhoneVerificationToken: 'owner-verification-token',
  };

  const memberDto = {
    joinCode: '48291307',
    email: 'sam@acme.com',
    password: 'password123',
    name: 'Sam Staff',
    phone: '01099998888',
    phoneVerificationToken: 'member-verification-token',
  };

  beforeEach(() => {
    // transaction-scoped client used by the owner-register flow
    tx = {
      user: {
        create: jest.fn().mockResolvedValue({ id: 'user-1' }),
        update: jest.fn().mockResolvedValue({
          id: 'user-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: 2,
        }),
      },
      company: { create: jest.fn().mockResolvedValue({ id: 'company-1' }) },
    };

    prisma = {
      userLoginMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      // null default = "not taken" (register tax-ID check) / "not found" (member join-code)
      company: { findUnique: jest.fn().mockResolvedValue(null) },
      role: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: 2, code: 'OWNER' }),
      },
      // null default = "phone not taken"
      user: { findFirst: jest.fn().mockResolvedValue(null) },
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
        .mockResolvedValue({ sub: 'user-1', jti: 'jti-1' }),
    };

    eventEmitter = { emit: jest.fn().mockReturnValue(true) };
    phoneVerification = { consume: jest.fn().mockResolvedValue(undefined) };
    service = new AuthService(
      prisma,
      passwordService as any,
      tokenService as any,
      eventEmitter as any,
      phoneVerification as any,
    );
  });

  describe('register (company self-signup)', () => {
    it('creates company + owner and returns a pending session', async () => {
      const result = await service.register(registerDto as any);

      // company references the just-created user (circular-FK, user-first)
      expect(tx.company.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Acme',
          taxId: '123-45-67890',
          createdByUserId: 'user-1',
        }),
      });
      // user linked back to the company
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { companyId: 'company-1' },
      });
      // refresh token stored HASHED
      expect(prisma.refreshToken.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          tokenHash: 'hashed-refresh',
          expiresAt: expect.any(Date),
        },
      });
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'user-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: 2,
        },
      });
    });

    it('emits company.registered with the new company id, after the transaction commits', async () => {
      await service.register(registerDto as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.COMPANY_REGISTERED,
        { companyId: 'company-1' },
      );
      expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
    });

    it('emits nothing when the signup transaction fails', async () => {
      tx.company.create.mockRejectedValue(new Error('db down'));

      await expect(service.register(registerDto as any)).rejects.toThrow(
        'db down',
      );
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email with 409 before any writes', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({ id: 'lm-1' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a duplicate tax ID with 409 before any writes', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'existing-company' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a phone another user already has with 409 before any writes', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        new ConflictException('Phone already registered'),
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { phone: '01012345678', deletedAt: null },
        select: { id: true },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(phoneVerification.consume).not.toHaveBeenCalled();
    });

    it('spends the phone token inside the transaction, before creating the owner', async () => {
      await service.register(registerDto as any);

      expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
        token: 'owner-verification-token',
        phone: '01012345678',
        purpose: PhoneVerificationPurpose.SIGNUP,
      });
      expect(
        phoneVerification.consume.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.user.create.mock.invocationCallOrder[0]);
    });

    it('stores the verified phone on the owner', async () => {
      await service.register(registerDto as any);

      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ phone: '01012345678' }),
      });
    });

    it('creates nothing and emits nothing when the phone token is invalid', async () => {
      phoneVerification.consume.mockRejectedValue(
        new BadRequestException('Invalid or expired verification token'),
      );

      await expect(service.register(registerDto as any)).rejects.toThrow(
        BadRequestException,
      );
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(tx.company.create).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('registerMember (join-code self-signup)', () => {
    beforeEach(() => {
      // the member is now created inside a transaction
      tx.user.create.mockResolvedValue({
        id: 'member-1',
        status: 'PENDING_APPROVAL',
        companyId: 'company-1',
        roleId: null,
      });
    });

    it('creates a role-less PENDING member in the join-code company, with auto-login', async () => {
      prisma.company.findUnique.mockResolvedValue({
        id: 'company-1',
        joinCode: '48291307',
      });

      const result = await service.registerMember(memberDto as any);

      expect(prisma.company.findUnique).toHaveBeenCalledWith({
        where: { joinCode: '48291307' },
      });
      expect(tx.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Sam Staff',
          companyId: 'company-1',
          roleId: null,
          status: UserStatus.PENDING_APPROVAL,
          loginMethods: {
            create: expect.objectContaining({
              method: 'local',
              email: 'sam@acme.com',
            }),
          },
        }),
      });
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'member-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: null,
        },
      });
    });

    it('emits member.joinRequested after the member row is created', async () => {
      prisma.company.findUnique.mockResolvedValue({
        id: 'company-1',
        joinCode: '48291307',
      });

      await service.registerMember(memberDto as any);

      expect(eventEmitter.emit).toHaveBeenCalledWith(
        NotificationEvent.MEMBER_JOIN_REQUESTED,
        { companyId: 'company-1', memberUserId: 'member-1' },
      );
      expect(tx.user.create.mock.invocationCallOrder[0]).toBeLessThan(
        eventEmitter.emit.mock.invocationCallOrder[0],
      );
    });

    it('rejects an invalid join code with 404 and creates no user', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await expect(service.registerMember(memberDto as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(tx.user.create).not.toHaveBeenCalled();
      expect(phoneVerification.consume).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email with 409 before resolving the join code', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({ id: 'lm-1' });

      await expect(service.registerMember(memberDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.company.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a phone another user already has with 409 before resolving the join code', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'someone-else' });

      await expect(service.registerMember(memberDto as any)).rejects.toThrow(
        new ConflictException('Phone already registered'),
      );
      expect(prisma.user.findFirst).toHaveBeenCalledWith({
        where: { phone: '01099998888', deletedAt: null },
        select: { id: true },
      });
      expect(prisma.company.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('with a valid join code', () => {
      beforeEach(() => {
        prisma.company.findUnique.mockResolvedValue({
          id: 'company-1',
          joinCode: '48291307',
        });
      });

      it('spends the phone token inside a transaction, before creating the member', async () => {
        await service.registerMember(memberDto as any);

        expect(prisma.$transaction).toHaveBeenCalledTimes(1);
        expect(phoneVerification.consume).toHaveBeenCalledWith(tx, {
          token: 'member-verification-token',
          phone: '01099998888',
          purpose: PhoneVerificationPurpose.SIGNUP,
        });
        expect(
          phoneVerification.consume.mock.invocationCallOrder[0],
        ).toBeLessThan(tx.user.create.mock.invocationCallOrder[0]);
      });

      it('stores the verified phone on the member', async () => {
        await service.registerMember(memberDto as any);

        expect(tx.user.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ phone: '01099998888' }),
        });
      });

      it('creates nothing and emits nothing when the phone token is invalid', async () => {
        phoneVerification.consume.mockRejectedValue(
          new BadRequestException('Invalid or expired verification token'),
        );

        await expect(service.registerMember(memberDto as any)).rejects.toThrow(
          BadRequestException,
        );
        expect(tx.user.create).not.toHaveBeenCalled();
        expect(eventEmitter.emit).not.toHaveBeenCalled();
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      });
    });
  });

  describe('login', () => {
    const loginDto = { email: 'jane@acme.com', password: 'password123' };

    const activeLoginMethod = {
      passwordHash: 'stored-hash',
      user: {
        id: 'user-1',
        status: UserStatus.ACTIVE,
        companyId: 'company-1',
        roleId: 2,
        deletedAt: null,
      },
    };

    it('issues a session for valid credentials on an ACTIVE user', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue(activeLoginMethod);

      const result = await service.login(loginDto as any);

      // verify(storedHash, candidate) — argument order matters
      expect(passwordService.verify).toHaveBeenCalledWith(
        'stored-hash',
        'password123',
      );
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        user: {
          id: 'user-1',
          status: UserStatus.ACTIVE,
          companyId: 'company-1',
          roleId: 2,
        },
      });
    });

    it('allows a PENDING user to log in (lands on the pending screen)', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({
        ...activeLoginMethod,
        user: {
          ...activeLoginMethod.user,
          status: UserStatus.PENDING_APPROVAL,
        },
      });

      const result = await service.login(loginDto as any);

      expect(result.user.status).toBe(UserStatus.PENDING_APPROVAL);
    });

    it('rejects an unknown email with a generic 401 (no enumeration)', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue(null);

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(passwordService.verify).not.toHaveBeenCalled();
    });

    it('rejects a wrong password with a generic 401', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue(activeLoginMethod);
      passwordService.verify.mockResolvedValue(false);

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });

    it('rejects a suspended (terminal-status) user even with valid credentials', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({
        ...activeLoginMethod,
        user: { ...activeLoginMethod.user, status: UserStatus.SUSPENDED },
      });

      await expect(service.login(loginDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('refresh (rotation + reuse detection)', () => {
    const refreshDto = { refreshToken: 'refresh-token-string' };

    const validStored = {
      tokenHash: 'hashed-refresh',
      userId: 'user-1',
      revokedAt: null,
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    };

    it('rotates: revokes the old token and issues a new pair', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(validStored);

      const result = await service.refresh(refreshDto as any);

      // old token revoked
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { tokenHash: 'hashed-refresh' },
        data: { revokedAt: expect.any(Date) },
      });
      // new pair issued + stored
      expect(prisma.refreshToken.create).toHaveBeenCalled();
      expect(result).toEqual({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      });
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

    it("detects reuse: a revoked token revokes ALL the user's tokens and 401s", async () => {
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...validStored,
        revokedAt: new Date('2027-01-01T00:00:00Z'), // already revoked
      });

      await expect(service.refresh(refreshDto as any)).rejects.toThrow(
        UnauthorizedException,
      );
      // whole family revoked
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // and NO new session issued
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('revokes the presented refresh token, scoped to the user', async () => {
      await service.logout('user-1', {
        refreshToken: 'refresh-token-string',
      } as any);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: {
          tokenHash: 'hashed-refresh',
          userId: 'user-1',
          revokedAt: null,
        },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});
