import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { UserStatus } from '../../generated/prisma/enums';
import { CAN_AUTHENTICATE } from '../auth.constants';
import { AuthUser } from '../types/auth-user';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tokenService: TokenService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authorizationHeader = request.headers.authorization;

    if (!authorizationHeader) {
      throw new UnauthorizedException();
    }

    const [tokenType, token] = String(authorizationHeader).split(' ');

    if (tokenType !== 'Bearer' || !token) {
      throw new UnauthorizedException();
    }

    let tokenPayload;
    try {
      tokenPayload = await this.tokenService.verifyAccess(token);
    } catch {
      throw new UnauthorizedException();
    }

    const user = await this.prisma.user.findUnique({
      where: {
        id: tokenPayload.sub,
      },
      select: {
        id: true,
        companyId: true,
        roleId: true,
        status: true,
        deletedAt: true,
        role: {
          select: {
            code: true,
          },
        },
      },
    });

    if (!user || user.deletedAt || !CAN_AUTHENTICATE.includes(user.status)) {
      throw new UnauthorizedException();
    }

    const authenticatedUser: AuthUser = {
      id: user.id,
      companyId: user.companyId,
      roleId: user.roleId,
      roleCode: user.role?.code ?? null,
      status: user.status,
    };

    request.user = authenticatedUser;

    return true;
  }
}
