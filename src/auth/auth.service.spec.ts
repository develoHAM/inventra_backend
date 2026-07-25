import { ConflictException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  let prisma: any;
  let tx: {
    user: { create: jest.Mock; update: jest.Mock };
    company: { create: jest.Mock };
  };
  let passwordService: { hash: jest.Mock };
  let tokenService: {
    signAccess: jest.Mock;
    signRefresh: jest.Mock;
    hashToken: jest.Mock;
  };

  const dto = {
    companyName: 'Acme',
    taxId: '123-45-67890',
    ownerName: 'Jane Owner',
    ownerEmail: 'jane@acme.com',
    ownerPassword: 'password123',
  };

  beforeEach(() => {
    // the transaction-scoped client the $transaction callback receives
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
      company: {
        create: jest.fn().mockResolvedValue({ id: 'company-1' }),
      },
    };

    prisma = {
      userLoginMethod: { findFirst: jest.fn().mockResolvedValue(null) },
      company: { findUnique: jest.fn().mockResolvedValue(null) },
      role: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 2, code: 'OWNER' }),
      },
      refreshToken: { create: jest.fn().mockResolvedValue({}) },
      // invoke the callback with the fake tx, like a real interactive transaction
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };

    passwordService = { hash: jest.fn().mockResolvedValue('hashed-pw') };
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

  it('registers a company + owner and returns a pending session', async () => {
    const result = await service.register(dto as any);

    // company created referencing the just-created user (circular-FK, user-first)
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
    // the refresh token is stored HASHED, never raw
    expect(prisma.refreshToken.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        tokenHash: 'hashed-refresh',
        expiresAt: expect.any(Date),
      },
    });
    // returns the session + PENDING status (auto-login)
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

    await expect(service.register(dto as any)).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a duplicate tax ID with 409 before any writes', async () => {
    prisma.company.findUnique.mockResolvedValue({ id: 'existing-company' });

    await expect(service.register(dto as any)).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
