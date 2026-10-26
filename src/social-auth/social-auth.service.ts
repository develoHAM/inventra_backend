import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { CAN_AUTHENTICATE } from '../auth/auth.constants';
import { encryptToken } from '../common/token-cipher';
import { SOCIAL_VERIFIERS } from './social-auth.constants';
import { SocialNonceService } from './social-nonce.service';
import { SignupTicketService } from './signup-tickets/signup-ticket.service';
import type { SignupProfile } from './signup-tickets/signup-ticket.service';
import type { SocialSignInDto } from './dto/social-sign-in.dto';
import type { UserStatus } from '../generated/prisma/enums';
import type {
  SocialIdentityVerifier,
  SocialProvider,
} from './verifiers/social-identity-verifier';

export type SocialSignInResult =
  | {
      status: 'LOGGED_IN';
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        status: UserStatus;
        companyId: string | null;
        roleId: number | null;
      };
    }
  | {
      status: 'SIGNUP_REQUIRED';
      signupToken: string;
      expiresInSeconds: number;
      profile: SignupProfile;
    };

@Injectable()
export class SocialAuthService {
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nonces: SocialNonceService,
    @Inject(SOCIAL_VERIFIERS)
    private readonly verifiers: Record<SocialProvider, SocialIdentityVerifier>,
    private readonly tickets: SignupTicketService,
    private readonly auth: AuthService,
    config: ConfigService<Env, true>,
  ) {
    this.encryptionKey = config.get('LOGIN_TOKEN_ENCRYPTION_KEY', {
      infer: true,
    });
  }

  issueNonce(): Promise<{ nonce: string; expiresInSeconds: number }> {
    return this.nonces.issue();
  }

  /**
   * Sign in with a provider's credential. A known identity gets our tokens;
   * an unknown one gets a signup ticket. Never matched by email: the same
   * address at another provider is NOT the same account.
   */
  async signIn(body: SocialSignInDto): Promise<SocialSignInResult> {
    const provider = body.provider;

    // 1. Spend the nonce first: a replayed request stops here, before any
    //    provider call. (Whether one is REQUIRED is the verifier's call.)
    if (body.nonce !== undefined && !(await this.nonces.consume(body.nonce))) {
      throw new UnauthorizedException('Invalid social credential');
    }

    // 2. Who is this? (401 bad credential, 503 provider unreachable)
    const identity = await this.verifiers[provider].verify(
      body.credential,
      body.nonce,
    );

    // 3. Have we seen this identity before?
    const login = await this.prisma.userLoginMethod.findUnique({
      where: {
        method_providerUserId: {
          method: provider,
          providerUserId: identity.providerUserId,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            status: true,
            companyId: true,
            roleId: true,
            deletedAt: true,
          },
        },
      },
    });

    if (!login) {
      const ticket = await this.tickets.create(identity);
      return { status: 'SIGNUP_REQUIRED', ...ticket };
    }

    // 4. Known: the same rules as password login
    const user = login.user;
    if (user.deletedAt || !CAN_AUTHENTICATE.includes(user.status)) {
      throw new UnauthorizedException('Account cannot sign in');
    }

    await this.prisma.userLoginMethod.update({
      where: { id: login.id },
      data: {
        lastLoginAt: new Date(),
        // a new refresh token replaces the old one; none this time → keep the old
        ...(identity.refreshToken !== null
          ? {
              refreshToken: encryptToken(
                identity.refreshToken,
                this.encryptionKey,
              ),
            }
          : {}),
      },
    });

    const tokens = await this.auth.issueSessionFor(user.id);
    return {
      status: 'LOGGED_IN',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        status: user.status,
        companyId: user.companyId,
        roleId: user.roleId,
      },
    };
  }
}
