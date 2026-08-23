import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../auth/types/auth-user';
import { PermissionEffect } from '../generated/prisma/enums';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async getEffectivePermissions(user: AuthUser): Promise<Set<string>> {
    if (!user.roleId) {
      return new Set();
    }

    const role = await this.prisma.role.findUnique({
      where: {
        id: user.roleId,
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

    const overrides = await this.prisma.userPermission.findMany({
      where: { userId: user.id },
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
