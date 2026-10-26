import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { encryptToken } from '../../common/token-cipher';
import {
  SIGNUP_TICKET_TTL_SECONDS,
  TICKET_NAME_MAX_LENGTH,
} from '../social-auth.constants';
import type {
  SocialIdentity,
  SocialProvider,
} from '../verifiers/social-identity-verifier';

export interface SignupProfile {
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

/** What a spent ticket vouches for: the identity to create the account with. */
export interface SpentSignupTicket extends SignupProfile {
  provider: SocialProvider;
  providerUserId: string;
  providerRefreshToken: string | null; // still encrypted: copied as-is to the login method
}

const hashToken = (signupToken: string) =>
  createHash('sha256').update(signupToken).digest('hex');

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
        tokenHash: hashToken(signupToken),
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

  /**
   * Spend a ticket exactly once, inside the signup transaction. The
   * conditional write is the lock: of two signups sent at once with the same
   * ticket, only one matches `consumedAt: null`; the other gets count 0 → 400.
   */
  async consume(
    transaction: Prisma.TransactionClient,
    signupToken: string,
  ): Promise<SpentSignupTicket> {
    const now = new Date();
    const tokenHash = hashToken(signupToken);
    const spent = await transaction.socialSignupTicket.updateMany({
      where: { tokenHash: tokenHash, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    if (spent.count !== 1) {
      throw new BadRequestException('Invalid or expired signup token');
    }

    const ticket = await transaction.socialSignupTicket.findUniqueOrThrow({
      where: { tokenHash: tokenHash },
    });
    return {
      provider: ticket.provider as SocialProvider, // written by create(), from a verifier
      providerUserId: ticket.providerUserId,
      email: ticket.email,
      emailVerified: ticket.emailVerified,
      name: ticket.name,
      providerRefreshToken: ticket.providerRefreshToken,
    };
  }
}
