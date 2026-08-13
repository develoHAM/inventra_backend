import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { UserStatus } from '../../generated/prisma/enums';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let tokenService: { verifyAccess: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };

  const activeUser = {
    id: 'user-1',
    companyId: 'company-1',
    companyStoreId: 'store-1',
    roleId: 2,
    status: UserStatus.ACTIVE,
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
    prisma = { user: { findUnique: jest.fn() } };
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
    tokenService.verifyAccess.mockResolvedValue({ sub: 'user-1' });
    prisma.user.findUnique.mockResolvedValue({
      ...activeUser,
      status: UserStatus.SUSPENDED,
    });
    const request = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('allows a PENDING user to authenticate (activation is enforced downstream)', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockResolvedValue({ sub: 'user-1' });
    prisma.user.findUnique.mockResolvedValue({
      ...activeUser,
      status: UserStatus.PENDING_APPROVAL,
    });
    const request: any = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);
    // authenticated, and status carried through so downstream guards can gate on it
    expect(request.user.status).toBe(UserStatus.PENDING_APPROVAL);
  });

  it('rejects a soft-deleted user', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockResolvedValue({ sub: 'user-1' });
    prisma.user.findUnique.mockResolvedValue({
      ...activeUser,
      deletedAt: new Date(),
    });
    const request = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('allows an ACTIVE user and attaches the AuthUser to the request', async () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    tokenService.verifyAccess.mockResolvedValue({ sub: 'user-1' });
    prisma.user.findUnique.mockResolvedValue(activeUser);
    const request: any = { headers: { authorization: 'Bearer good-token' } };

    await expect(guard.canActivate(contextWith(request))).resolves.toBe(true);

    // req.user carries exactly the AuthUser shape — no deletedAt leak
    expect(request.user).toEqual({
      id: 'user-1',
      companyId: 'company-1',
      companyStoreId: 'store-1',
      roleId: 2,
      roleCode: 'OWNER',
      status: UserStatus.ACTIVE,
    });
    expect(request.user).not.toHaveProperty('deletedAt');

    // the fresh-load query selects only what AuthUser needs (+ deletedAt)
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        id: true,
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
