import {
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { UserStatus } from '../generated/prisma/enums';

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
  };

  const registerDto = {
    companyName: 'Acme',
    taxId: '123-45-67890',
    ownerName: 'Jane Owner',
    ownerEmail: 'jane@acme.com',
    ownerPassword: 'password123',
  };

  const memberDto = {
    joinCode: 'INV-ABC123',
    email: 'sam@acme.com',
    password: 'password123',
    name: 'Sam Staff',
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
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 2, code: 'OWNER' }),
      },
      user: {
        create: jest.fn().mockResolvedValue({
          id: 'member-1',
          status: 'PENDING_APPROVAL',
          companyId: 'company-1',
          roleId: null,
        }),
      },
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
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
    };

    service = new AuthService(
      prisma,
      passwordService as any,
      tokenService as any,
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

    it('rejects a duplicate email with 409 before any writes', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({ id: 'lm-1' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a duplicate tax ID with 409 before any writes', async () => {
      prisma.company.findUnique.mockResolvedValue({ id: 'existing-company' });

      await expect(service.register(registerDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('registerMember (join-code self-signup)', () => {
    it('creates a role-less PENDING member in the join-code company, with auto-login', async () => {
      prisma.company.findUnique.mockResolvedValue({
        id: 'company-1',
        joinCode: 'INV-ABC123',
      });

      const result = await service.registerMember(memberDto as any);

      expect(prisma.company.findUnique).toHaveBeenCalledWith({
        where: { joinCode: 'INV-ABC123' },
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
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

    it('rejects an invalid join code with 404 and creates no user', async () => {
      prisma.company.findUnique.mockResolvedValue(null);

      await expect(service.registerMember(memberDto as any)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate email with 409 before resolving the join code', async () => {
      prisma.userLoginMethod.findFirst.mockResolvedValue({ id: 'lm-1' });

      await expect(service.registerMember(memberDto as any)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.company.findUnique).not.toHaveBeenCalled();
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
        user: { ...activeLoginMethod.user, status: UserStatus.PENDING_APPROVAL },
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
});
