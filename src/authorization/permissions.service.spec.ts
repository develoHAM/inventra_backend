import { PermissionsService } from './permissions.service';
import { AuthProfile } from '../auth/types/auth-profile';
import { PermissionEffect, ProfileStatus } from '../generated/prisma/enums';

describe('PermissionsService', () => {
  let service: PermissionsService;
  let prisma: {
    role: { findUnique: jest.Mock };
    profilePermission: { findMany: jest.Mock };
  };

  const profile: AuthProfile = {
    id: 'profile-1',
    accountId: 'account-of-profile-1',
    companyId: 'company-1',
    roleId: 2,
    roleCode: 'OWNER',
    status: ProfileStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      role: { findUnique: jest.fn() },
      profilePermission: { findMany: jest.fn() },
    };
    service = new PermissionsService(prisma as any);
  });

  it('returns an empty set for a role-less user', async () => {
    const result = await service.getEffectivePermissions({
      ...profile,
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
    prisma.profilePermission.findMany.mockResolvedValue([]);

    const result = await service.getEffectivePermissions(profile);

    expect([...result].sort()).toEqual(['products.create', 'products.read']);
  });

  it('adds a GRANT override on top of the role baseline', async () => {
    prisma.role.findUnique.mockResolvedValue({
      code: 'STAFF',
      rolePermissions: [{ permission: { code: 'products.read' } }],
    });
    prisma.profilePermission.findMany.mockResolvedValue([
      {
        effect: PermissionEffect.GRANT,
        permission: { code: 'products.create' },
      },
    ]);

    const result = await service.getEffectivePermissions(profile);

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
    prisma.profilePermission.findMany.mockResolvedValue([
      {
        effect: PermissionEffect.DENY,
        permission: { code: 'products.delete' },
      },
    ]);

    const result = await service.getEffectivePermissions(profile);

    expect([...result]).toEqual(['products.read']);
  });

  it('treats ADMIN like any role: its rows are the baseline and overrides apply', async () => {
    // ADMIN is no longer a code-level wildcard — its permissions come from the
    // role_permissions rows seed grants it (PERMISSIONS.map(...)), and a DENY
    // override now takes effect just like for any other role.
    prisma.role.findUnique.mockResolvedValue({
      rolePermissions: [
        { permission: { code: 'stores.create' } },
        { permission: { code: 'orders.delete' } },
      ],
    });
    prisma.profilePermission.findMany.mockResolvedValue([
      { effect: PermissionEffect.DENY, permission: { code: 'orders.delete' } },
    ]);

    const adminProfile: AuthProfile = { ...profile, roleCode: 'ADMIN' };
    const result = await service.getEffectivePermissions(adminProfile);

    expect([...result]).toEqual(['stores.create']); // DENY removed orders.delete
    expect(prisma.profilePermission.findMany).toHaveBeenCalled();
  });
});
