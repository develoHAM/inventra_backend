import { PermissionsService } from './permissions.service';
import { AuthUser } from '../auth/types/auth-user';
import { PermissionEffect, UserStatus } from '../generated/prisma/enums';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let prisma: {
    role: { findUnique: jest.Mock };
    permission: { findMany: jest.Mock };
    userPermission: { findMany: jest.Mock };
  };

  const user: AuthUser = {
    id: 'user-1',
    companyId: 'company-1',
    roleId: 2,
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      role: { findUnique: jest.fn() },
      permission: { findMany: jest.fn() },
      userPermission: { findMany: jest.fn() },
    };
    service = new PermissionsService(prisma as any);
  });

  it('returns an empty set for a role-less user', async () => {
    const result = await service.getEffectivePermissions({
      ...user,
      roleId: null,
    });

    expect(result.size).toBe(0);
    expect(prisma.role.findUnique).not.toHaveBeenCalled();
  });

  it('returns the role baseline when there are no overrides', async () => {
    prisma.role.findUnique.mockResolvedValue({
      code: 'OWNER',
      rolePermissions: [
        { permission: { code: 'products.read' } },
        { permission: { code: 'products.create' } },
      ],
    });
    prisma.userPermission.findMany.mockResolvedValue([]);

    const result = await service.getEffectivePermissions(user);

    expect([...result].sort()).toEqual(['products.create', 'products.read']);
  });

  it('adds a GRANT override on top of the role baseline', async () => {
    prisma.role.findUnique.mockResolvedValue({
      code: 'STAFF',
      rolePermissions: [{ permission: { code: 'products.read' } }],
    });
    prisma.userPermission.findMany.mockResolvedValue([
      {
        effect: PermissionEffect.GRANT,
        permission: { code: 'products.create' },
      },
    ]);

    const result = await service.getEffectivePermissions(user);

    expect([...result].sort()).toEqual(['products.create', 'products.read']);
  });

  it('removes a permission via a DENY override even if the role grants it', async () => {
    prisma.role.findUnique.mockResolvedValue({
      code: 'MANAGER',
      rolePermissions: [
        { permission: { code: 'products.read' } },
        { permission: { code: 'products.delete' } },
      ],
    });
    prisma.userPermission.findMany.mockResolvedValue([
      {
        effect: PermissionEffect.DENY,
        permission: { code: 'products.delete' },
      },
    ]);

    const result = await service.getEffectivePermissions(user);

    expect([...result]).toEqual(['products.read']);
  });

  it('returns every permission for the ADMIN role and skips override lookup', async () => {
    prisma.role.findUnique.mockResolvedValue({
      code: 'ADMIN',
      rolePermissions: [],
    });
    prisma.permission.findMany.mockResolvedValue([
      { code: 'products.read' },
      { code: 'users.approve' },
      { code: 'companies.update' },
    ]);

    const result = await service.getEffectivePermissions(user);

    expect([...result].sort()).toEqual([
      'companies.update',
      'products.read',
      'users.approve',
    ]);
    expect(prisma.userPermission.findMany).not.toHaveBeenCalled();
  });
});
