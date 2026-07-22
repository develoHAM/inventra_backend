import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PermissionsService } from '../permissions.service';
import { Observable } from 'rxjs';
import { Reflector } from '@nestjs/core';
import { REQUIRE_PERMISSIONS_KEY } from '../decorators/require-permissions.decorator';
import { AuthUser } from '../../auth/types/auth-user';

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

    const user = context.switchToHttp().getRequest().user as AuthUser;

    if (!user) {
      throw new ForbiddenException();
    }

    const effective =
      await this.permissionsService.getEffectivePermissions(user);

    const allowed = requiredPermissions.every((code) => effective.has(code));

    if (!allowed) {
      throw new ForbiddenException();
    }

    return true;
  }
}
