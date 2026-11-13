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
import { ProfileStatus } from '../../generated/prisma/enums';
import { CAN_AUTHENTICATE } from '../auth.constants';
import { AuthProfile } from '../types/auth-profile';

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

    if (!authorizationHeader) throw new UnauthorizedException();

    const [tokenType, token] = String(authorizationHeader).split(' ');

    if (tokenType !== 'Bearer' || !token) throw new UnauthorizedException();

    let tokenPayload;
    try {
      tokenPayload = await this.tokenService.verifyAccess(token);
    } catch {
      throw new UnauthorizedException();
    }

    const profile = await this.prisma.profile.findUnique({
      where: {
        id: tokenPayload.sub,
      },
      select: {
        id: true,
        accountId: true,
        companyId: true,
        companyStoreId: true,
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

    if (
      !profile ||
      profile.deletedAt ||
      !CAN_AUTHENTICATE.includes(profile.status)
    )
      throw new UnauthorizedException();

    const authenticatedProfile: AuthProfile = {
      id: profile.id,
      accountId: profile.accountId,
      companyId: profile.companyId,
      companyStoreId: profile.companyStoreId,
      roleId: profile.roleId,
      roleCode: profile.role?.code ?? null,
      status: profile.status,
    };

    request.profile = authenticatedProfile;

    return true;
  }
}
