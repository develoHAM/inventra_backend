import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { encryptToken } from '../../common/token-cipher';
import {
  SIGNUP_TICKET_TTL_SECONDS,
  TICKET_NAME_MAX_LENGTH,
} from '../social-auth.constants';
import type { SocialIdentity } from '../verifiers/social-identity-verifier';

export interface SignupProfile {
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/**
 * A signup ticket remembers "this provider proved this person" between social
 * sign-in (SIGNUP_REQUIRED) and the signup request that follows. The app holds
 * the raw token; we store only its SHA-256.
 */
@Injectable()
export class SignupTicketService {
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.encryptionKey = config.get('LOGIN_TOKEN_ENCRYPTION_KEY', {
      infer: true,
    });
  }

  async create(identity: SocialIdentity): Promise<{
    signupToken: string;
    expiresInSeconds: number;
    profile: SignupProfile;
  }> {
    const signupToken = randomBytes(32).toString('base64url');
    const profile: SignupProfile = {
      email: identity.email,
      emailVerified: identity.emailVerified,
      // provider names (Apple's comes from the app, unsigned) can be any length
      name: identity.name?.slice(0, TICKET_NAME_MAX_LENGTH) ?? null,
    };

    await this.prisma.socialSignupTicket.create({
      data: {
        tokenHash: createHash('sha256').update(signupToken).digest('hex'),
        provider: identity.provider,
        providerUserId: identity.providerUserId,
        email: profile.email,
        emailVerified: profile.emailVerified,
        name: profile.name,
        // what lets us revoke Apple/Google access later: never stored in plain text
        providerRefreshToken:
          identity.refreshToken === null
            ? null
            : encryptToken(identity.refreshToken, this.encryptionKey),
        expiresAt: new Date(Date.now() + SIGNUP_TICKET_TTL_SECONDS * 1000),
      },
    });

    return {
      signupToken: signupToken,
      expiresInSeconds: SIGNUP_TICKET_TTL_SECONDS,
      profile: profile,
    };
  }
}
