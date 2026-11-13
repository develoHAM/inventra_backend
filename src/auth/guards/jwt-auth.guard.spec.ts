import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ProfileStatus } from '../../generated/prisma/enums';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let tokenService: { verifyAccess: jest.Mock };
  let prisma: { profile: { findUnique: jest.Mock } };

  const activeProfile = {
    id: 'profile-1',
    accountId: 'account-1',
    companyId: 'company-1',
    companyStoreId: 'store-1',
    roleId: 2,
    status: ProfileStatus.ACTIVE,
    deletedAt: null,
    role: { code: 'OWNER' },
  };

  // A guard receives an ExecutionContext, not plain arguments. The guard only
  // touches three of its methods, so we fake exactly those three.
  function contextWith(request: any): ExecutionContext {
    return {
      getHandler: () => null,
      getClass: () => null,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    tokenService = { verifyAccess: jest.fn() };
    prisma = { profile: { findUnique: jest.fn() } };
    guard = new JwtAuthGuard(
      reflector as any,
      tokenService as any,
      prisma as any,
    );
  });

  it('allows public routes without a token', async () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const request = { headers: {} };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
    expect(tokenService.verifyAccess).not.toHaveBeenCalled();
  });

  it('rejects a request with no Authorization header', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const request = { headers: {} };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a malformed Authorization header', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const request = { headers: { authorization: 'Basic abc' } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
      UnauthorizedException,
    );
    expect(tokenService.verifyAccess).not.toHaveBeenCalled();
  });

  it('rejects an invalid or expired token', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockRejectedValue(new Error('invalid'));
    const request = { headers: { authorization: 'Bearer bad-token' } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a valid token for a terminal-status (suspended) user', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockResolvedValue({ sub: 'profile-1' });
    prisma.profile.findUnique.mockResolvedValue({
      ...activeProfile,
      status: ProfileStatus.SUSPENDED,
    });
    const request = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('allows a PENDING user to authenticate (activation is enforced downstream)', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockResolvedValue({ sub: 'profile-1' });
    prisma.profile.findUnique.mockResolvedValue({
      ...activeProfile,
      status: ProfileStatus.PENDING_APPROVAL,
    });
    const request: any = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
    // authenticated, and status carried through so downstream guards can gate on it
    expect(request.profile.status).toBe(ProfileStatus.PENDING_APPROVAL);
  });

  it('rejects a soft-deleted user', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockResolvedValue({ sub: 'profile-1' });
    prisma.profile.findUnique.mockResolvedValue({
      ...activeProfile,
      deletedAt: new Date(),
    });
    const request = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('allows an ACTIVE user and attaches the AuthProfile to the request', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockResolvedValue({ sub: 'profile-1' });
    prisma.profile.findUnique.mockResolvedValue(activeProfile);
    const request: any = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);

    // request.profile carries exactly the AuthProfile shape — no deletedAt leak
    expect(request.profile).toEqual({
      id: 'profile-1',
      accountId: 'account-1', // the sign-in this profile belongs to
      companyId: 'company-1',
      companyStoreId: 'store-1',
      roleId: 2,
      roleCode: 'OWNER',
      status: ProfileStatus.ACTIVE,
    });
    expect(request.profile).not.toHaveProperty('deletedAt');

    // the fresh-load query selects only what AuthProfile needs (+ deletedAt)
    expect(prisma.profile.findUnique).toHaveBeenCalledWith({
      where: { id: 'profile-1' },
      select: {
        id: true,
        accountId: true,
        companyId: true,
        companyStoreId: true,
        roleId: true,
        status: true,
        deletedAt: true,
        role: { select: { code: true } },
      },
    });
  });
});
