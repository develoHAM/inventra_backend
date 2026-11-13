import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PermissionsService } from '../permissions.service';
import { Reflector } from '@nestjs/core';
import { REQUIRE_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { AuthProfile } from '../../auth/types/auth-profile';
import { ProfileStatus } from '../../generated/prisma/enums';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private permissionsService: PermissionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      REQUIRE_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const profile = context.switchToHttp().getRequest().profile as AuthProfile;

    if (!profile) {
      throw new ForbiddenException();
    }

    if (profile.status !== ProfileStatus.ACTIVE) {
      throw new ForbiddenException();
    }

    const effective =
      await this.permissionsService.getEffectivePermissions(profile);

    const allowed = requiredPermissions.every((code) => effective.has(code));

    if (!allowed) {
      throw new ForbiddenException();
    }

    return true;
  }
}
