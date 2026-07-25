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

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tokenService: TokenService,
    private prisma: PrismaService,
  ) {}

  private CAN_AUTHENTICATE: UserStatus[] = [
    UserStatus.PENDING_APPROVAL,
    UserStatus.ACTIVE,
  ];

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
      },
    });

    if (
      !user ||
      user.deletedAt ||
      !this.CAN_AUTHENTICATE.includes(user.status)
    ) {
      throw new UnauthorizedException();
    }

    request.user = {
      id: user.id,
      companyId: user.companyId,
      roleId: user.roleId,
      status: user.status,
    };

    return true;
  }
}
