import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthProfile } from '../auth/types/auth-profile';
import { PermissionEffect } from '../generated/prisma/enums';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePermissions(profile: AuthProfile): Promise<Set<string>> {
    if (!profile.roleId) {
      return new Set();
    }

    const role = await this.prisma.role.findUnique({
      where: {
        id: profile.roleId,
      },
      select: {
        rolePermissions: {
          select: {
            permission: {
              select: {
                code: true,
              },
            },
          },
        },
      },
    });

    if (!role) return new Set();

    const effective: Set<string> = new Set(
      role.rolePermissions.map(
        (rolePermission) => rolePermission.permission.code,
      ),
    );

    const overrides = await this.prisma.profilePermission.findMany({
      where: { profileId: profile.id },
      select: {
        effect: true,
        permission: { select: { code: true } },
      },
    });

    overrides
      .filter((o) => o.effect === PermissionEffect.GRANT)
      .forEach((o) => effective.add(o.permission.code));

    overrides
      .filter((o) => o.effect === PermissionEffect.DENY)
      .forEach((o) => effective.delete(o.permission.code));

    return effective;
  }
}
