import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ACCOUNT_ROUTE_KEY } from '../decorators/account-route.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { TokenService } from '../token.service';
import { CAN_AUTHENTICATE } from '../auth.constants';
import { AuthProfile } from '../types/auth-profile';
import { AuthAccount } from '../types/auth-account';

/**
 * Every request, unless @Public(): who is it (the account), and which
 * company profile is open (if any)? The token says; the database confirms,
 * fresh each time, so a deleted account or a suspended profile is shut out
 * on its very next request.
 *
 * - 401: no usable sign-in (bad token, deleted account, a profile that is
 *   not this account's or can't be opened).
 * - 403 "Choose a company first": signed in, no company open, and the route
 *   is a company route (not marked @AccountRoute()).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private tokenService: TokenService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isMarked(context, IS_PUBLIC_KEY)) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authorizationHeader = request.headers.authorization;

    if (!authorizationHeader) throw new UnauthorizedException();

    const [tokenType, token] = String(authorizationHeader).split(' ');

    if (tokenType !== 'Bearer' || !token) throw new UnauthorizedException();

    let session: AuthAccount;
    try {
      session = await this.tokenService.verifyAccess(token);
    } catch {
      throw new UnauthorizedException();
    }

    if (session.profileId === null) {
      // Signed in, no company open: only the account has to be alive…
      const account = await this.prisma.account.findUnique({
        where: { id: session.accountId },
        select: { deletedAt: true },
      });
      if (!account || account.deletedAt) throw new UnauthorizedException();

      // …and the route must not need a company.
      if (!this.isMarked(context, ACCOUNT_ROUTE_KEY)) {
        throw new ForbiddenException('Choose a company first');
      }

      request.account = session;
      return true;
    }

    // A company open: the profile, with its account's deletedAt, in one query.
    const profile = await this.prisma.profile.findUnique({
      where: {
        id: session.profileId,
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
        account: {
          select: {
            deletedAt: true,
          },
        },
      },
    });

    if (
      !profile ||
      // The pair must match. Our signature proves WE issued the token, not
      // that the code which issued it was right: never act as a profile of
      // another account, whatever the token says.
      profile.accountId !== session.accountId ||
      profile.account.deletedAt ||
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

    request.account = session;
    request.profile = authenticatedProfile;

    return true;
  }

  /** Is this route (its handler, else its controller class) marked with `key`? */
  private isMarked(context: ExecutionContext, key: string): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(key, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
