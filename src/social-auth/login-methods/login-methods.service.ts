import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { PasswordService } from '../../auth/password.service';
import { maskEmail } from '../../auth/mask-email';
import { decryptToken, encryptToken } from '../../common/token-cipher';
import { EmailVerificationService } from '../../email-verification/email-verification.service';
import { SOCIAL_VERIFIERS } from '../social-auth.constants';
import { SocialAuthService } from '../social-auth.service';
import { SOCIAL_PROVIDERS } from '../verifiers/social-identity-verifier';
import type { SocialSignInDto } from '../dto/social-sign-in.dto';
import type { LinkPasswordDto } from './dto/link-password.dto';
import type {
  SocialIdentity,
  SocialIdentityVerifier,
  SocialProvider,
} from '../verifiers/social-identity-verifier';

/** One way to sign in, as the settings screen shows it. */
export interface LoginMethodSummary {
  id: string;
  method: string; // 'local' | 'kakao' | 'google' | 'facebook' | 'apple'
  email: string | null; // the password login's email, masked; null for providers
}

const toSummary = (row: {
  id: string;
  method: string;
  email: string | null;
}): LoginMethodSummary => ({
  id: row.id,
  method: row.method,
  email: row.method === 'local' && row.email ? maskEmail(row.email) : null,
});

/** The ways the signed-in user can sign in: list, link, add a password, unlink. */
@Injectable()
export class LoginMethodsService {
  private readonly logger = new Logger(LoginMethodsService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAuth: SocialAuthService,
    @Inject(SOCIAL_VERIFIERS)
    private readonly verifiers: Record<SocialProvider, SocialIdentityVerifier>,
    private readonly passwords: PasswordService,
    private readonly emailVerification: EmailVerificationService,
    config: ConfigService<Env, true>,
  ) {
    this.encryptionKey = config.get('LOGIN_TOKEN_ENCRYPTION_KEY', {
      infer: true,
    });
  }

  async list(userId: string): Promise<LoginMethodSummary[]> {
    const rows = await this.prisma.userLoginMethod.findMany({
      where: { userId: userId },
      select: { id: true, method: true, email: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toSummary);
  }

  /**
   * Link a provider, proven the same way as social sign-in. A conditional
   * insert (ON CONFLICT DO NOTHING) covers both rules at once: the identity
   * is linked to nobody else, and this user has no other login for that
   * provider. Nothing inserted → 409, with the reason read afterwards.
   */
  async linkProvider(
    userId: string,
    body: SocialSignInDto,
  ): Promise<LoginMethodSummary> {
    const identity = await this.socialAuth.identify(body);

    const [linked] = await this.prisma.userLoginMethod.createManyAndReturn({
      data: [
        {
          userId: userId,
          method: identity.provider,
          providerUserId: identity.providerUserId,
          email: identity.email,
          emailVerified: identity.emailVerified,
          refreshToken:
            identity.refreshToken === null
              ? null
              : encryptToken(identity.refreshToken, this.encryptionKey),
        },
      ],
      skipDuplicates: true,
      select: { id: true, method: true, email: true },
    });
    if (!linked) {
      throw new ConflictException(await this.whyNotLinked(userId, identity));
    }
    return toSummary(linked);
  }

  /** Which unique rule stopped the link (read only after the insert said no). */
  private async whyNotLinked(
    userId: string,
    identity: SocialIdentity,
  ): Promise<string> {
    const holder = await this.prisma.userLoginMethod.findUnique({
      where: {
        method_providerUserId: {
          method: identity.provider,
          providerUserId: identity.providerUserId,
        },
      },
      select: { userId: true },
    });
    if (holder?.userId === userId) {
      return 'This account is already linked to you';
    }
    if (holder) return 'This account is linked to another user';
    return 'You already have a login with this provider; unlink it first';
  }

  /**
   * Add an email + password login to a social-only account. The address must
   * be proven by an emailed code and must not be any other password login's.
   */
  async linkPassword(
    userId: string,
    dto: LinkPasswordDto,
  ): Promise<LoginMethodSummary> {
    const [ownPasswordLogin, emailInUse] = await Promise.all([
      this.prisma.userLoginMethod.findUnique({
        where: { userId_method: { userId: userId, method: 'local' } },
        select: { id: true },
      }),
      this.prisma.userLoginMethod.findFirst({
        where: { method: 'local', email: dto.email }, // both sides lowercase
        select: { id: true },
      }),
    ]);
    if (ownPasswordLogin) {
      throw new ConflictException('You already have a password login');
    }
    if (emailInUse) throw new ConflictException('Email already registered');

    const passwordHash = await this.passwords.hash(dto.password); // slow: outside the transaction

    return this.prisma.$transaction(async (transaction) => {
      // spent with the insert: if the insert is refused, the proof rolls back too
      await this.emailVerification.consume(transaction, {
        token: dto.emailVerificationToken,
        email: dto.email,
      });
      const [linked] = await transaction.userLoginMethod.createManyAndReturn({
        data: [
          {
            userId: userId,
            method: 'local',
            email: dto.email,
            emailVerified: true,
            passwordHash: passwordHash,
          },
        ],
        // both rules, enforced by the database even for requests at the same instant:
        // one password login per account (userId, method), one account per
        // password-login email (UQ_login_methods_local_email)
        skipDuplicates: true,
        select: { id: true, method: true, email: true },
      });
      if (!linked) {
        throw new ConflictException(
          await this.whyPasswordNotLinked(transaction, userId),
        );
      }
      return toSummary(linked);
    });
  }

  /** Which rule stopped it (read only after the insert said no, before the rollback). */
  private async whyPasswordNotLinked(
    transaction: Prisma.TransactionClient,
    userId: string,
  ): Promise<string> {
    const ownPasswordLogin = await transaction.userLoginMethod.findUnique({
      where: { userId_method: { userId: userId, method: 'local' } },
      select: { id: true },
    });
    return ownPasswordLogin
      ? 'You already have a password login'
      : 'Email already registered';
  }

  /**
   * Remove one of the user's login methods, never the last one. Then ask the
   * provider to forget us too, best-effort: a provider outage must not keep
   * the login linked here.
   */
  async unlink(userId: string, loginMethodId: string): Promise<void> {
    const removed = await this.prisma.$transaction(async (transaction) => {
      // A write to the user's row takes its lock: two unlinks for the same
      // user now run one after the other, so both can't see "one other login
      // left" and remove the last two together.
      await transaction.user.updateMany({
        where: { id: userId },
        data: { updatedAt: new Date() },
      });

      const target = await transaction.userLoginMethod.findFirst({
        where: { id: loginMethodId, userId: userId },
      });
      if (!target) return null;

      const count = await transaction.userLoginMethod.count({
        where: { userId: userId },
      });
      if (count <= 1) {
        throw new ConflictException(
          'An account needs at least one way to sign in',
        );
      }
      await transaction.userLoginMethod.delete({ where: { id: target.id } });
      return target;
    });
    if (!removed) throw new NotFoundException('Login method not found');

    await this.disconnectFromProvider(removed);
  }

  /** Best-effort: logged, never thrown (the unlink already succeeded). */
  private async disconnectFromProvider(removed: {
    id: string;
    method: string;
    providerUserId: string | null;
    refreshToken: string | null;
  }): Promise<void> {
    const provider = SOCIAL_PROVIDERS.find((name) => name === removed.method);
    if (!provider || removed.providerUserId === null) return; // a password login
    try {
      await this.verifiers[provider].disconnect({
        providerUserId: removed.providerUserId,
        refreshToken:
          removed.refreshToken === null
            ? null
            : decryptToken(removed.refreshToken, this.encryptionKey),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Unlinked ${provider} login ${removed.id}, but the provider disconnect failed: ${reason}`,
      );
    }
  }
}
