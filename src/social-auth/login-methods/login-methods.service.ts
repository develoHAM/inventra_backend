import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { PasswordService } from '../../auth/password.service';
import { maskEmail } from '../../auth/mask-email';
import { encryptToken } from '../../common/token-cipher';
import { EmailVerificationService } from '../../email-verification/email-verification.service';
import { SocialAuthService } from '../social-auth.service';
import { ProviderDisconnectService } from '../provider-disconnect.service';
import type { SocialSignInDto } from '../dto/social-sign-in.dto';
import type { LinkPasswordDto } from './dto/link-password.dto';
import type { SocialIdentity } from '../verifiers/social-identity-verifier';

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

/** The ways a person's account can sign in: list, link, add a password, unlink. */
@Injectable()
export class LoginMethodsService {
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly socialAuth: SocialAuthService,
    private readonly disconnect: ProviderDisconnectService,
    private readonly passwords: PasswordService,
    private readonly emailVerification: EmailVerificationService,
    config: ConfigService<Env, true>,
  ) {
    this.encryptionKey = config.get('LOGIN_TOKEN_ENCRYPTION_KEY', {
      infer: true,
    });
  }

  async list(accountId: string): Promise<LoginMethodSummary[]> {
    const rows = await this.prisma.accountLoginMethod.findMany({
      where: { accountId: accountId },
      select: { id: true, method: true, email: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toSummary);
  }

  /**
   * Link a provider, proven the same way as social sign-in. A conditional
   * insert (ON CONFLICT DO NOTHING) covers both rules at once: the identity
   * is linked to nobody else, and this account has no other login for that
   * provider. Nothing inserted → 409, with the reason read afterwards.
   */
  async linkProvider(
    accountId: string,
    body: SocialSignInDto,
  ): Promise<LoginMethodSummary> {
    // a network call to the provider: outside the transaction, so no lock waits on it
    const identity = await this.socialAuth.identify(body);

    return this.prisma.$transaction(async (transaction) => {
      // The account lock, on a live account only. An account deletion
      // running now finishes first; then this matches nothing → 401.
      // Without it, the new row could land after the deletion removed the
      // others, and stay on a deleted account forever.
      const locked = await transaction.account.updateMany({
        where: { id: accountId, deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) {
        throw new UnauthorizedException(); // deleted since the guard let this request in
      }

      const [linked] = await transaction.accountLoginMethod.createManyAndReturn(
        {
          data: [
            {
              accountId: accountId,
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
        },
      );
      if (!linked) {
        throw new ConflictException(
          await this.whyNotLinked(transaction, accountId, identity),
        );
      }
      return toSummary(linked);
    });
  }

  /** Which unique rule stopped the link (read only after the insert said no). */
  private async whyNotLinked(
    transaction: Prisma.TransactionClient,
    accountId: string,
    identity: SocialIdentity,
  ): Promise<string> {
    const holder = await transaction.accountLoginMethod.findUnique({
      where: {
        method_providerUserId: {
          method: identity.provider,
          providerUserId: identity.providerUserId,
        },
      },
      select: { accountId: true },
    });
    if (holder?.accountId === accountId) {
      return 'This account is already linked to you';
    }
    if (holder) {
      return 'This account is linked to another user';
    }
    return 'You already have a login with this provider; unlink it first';
  }

  /**
   * Add an email + password login to a social-only account. The address must
   * be proven by an emailed code and must not be any other password login's.
   */
  async linkPassword(
    accountId: string,
    dto: LinkPasswordDto,
  ): Promise<LoginMethodSummary> {
    const [ownPasswordLogin, emailInUse] = await Promise.all([
      this.prisma.accountLoginMethod.findUnique({
        where: { accountId_method: { accountId: accountId, method: 'local' } },
        select: { id: true },
      }),
      this.prisma.accountLoginMethod.findFirst({
        where: { method: 'local', email: dto.email }, // both sides lowercase
        select: { id: true },
      }),
    ]);
    if (ownPasswordLogin) {
      throw new ConflictException('You already have a password login');
    }
    if (emailInUse) {
      throw new ConflictException('Email already registered');
    }

    const passwordHash = await this.passwords.hash(dto.password); // slow: outside the transaction

    return this.prisma.$transaction(async (transaction) => {
      // The account lock, as in linkProvider: an account deleted meanwhile
      // → 401, before the proof is spent.
      const locked = await transaction.account.updateMany({
        where: { id: accountId, deletedAt: null },
        data: { updatedAt: new Date() },
      });
      if (locked.count === 0) {
        throw new UnauthorizedException(); // deleted since the guard let this request in
      }

      // spent with the insert: if the insert is refused, the proof rolls back too
      await this.emailVerification.consume(transaction, {
        token: dto.emailVerificationToken,
        email: dto.email,
      });
      const [linked] = await transaction.accountLoginMethod.createManyAndReturn(
        {
          data: [
            {
              accountId: accountId,
              method: 'local',
              email: dto.email,
              emailVerified: true,
              passwordHash: passwordHash,
            },
          ],
          // both rules, enforced by the database even for requests at the same instant:
          // one password login per account (accountId, method), one account per
          // password-login email (UQ_login_methods_local_email)
          skipDuplicates: true,
          select: { id: true, method: true, email: true },
        },
      );
      if (!linked) {
        throw new ConflictException(
          await this.whyPasswordNotLinked(transaction, accountId),
        );
      }
      return toSummary(linked);
    });
  }

  /** Which rule stopped it (read only after the insert said no, before the rollback). */
  private async whyPasswordNotLinked(
    transaction: Prisma.TransactionClient,
    accountId: string,
  ): Promise<string> {
    const ownPasswordLogin = await transaction.accountLoginMethod.findUnique({
      where: { accountId_method: { accountId: accountId, method: 'local' } },
      select: { id: true },
    });
    return ownPasswordLogin
      ? 'You already have a password login'
      : 'Email already registered';
  }

  /**
   * Remove one of the account's login methods, never the last one. Then ask the
   * provider to forget us too, best-effort: a provider outage must not keep
   * the login linked here.
   */
  async unlink(accountId: string, loginMethodId: string): Promise<void> {
    const removed = await this.prisma.$transaction(async (transaction) => {
      // A write to the account's row takes its lock: two unlinks for the same
      // account now run one after the other, so both can't see "one other
      // login left" and remove the last two together.
      await transaction.account.updateMany({
        where: { id: accountId },
        data: { updatedAt: new Date() },
      });

      const target = await transaction.accountLoginMethod.findFirst({
        where: { id: loginMethodId, accountId: accountId },
      });
      if (!target) {
        return null;
      }

      const count = await transaction.accountLoginMethod.count({
        where: { accountId: accountId },
      });
      if (count <= 1) {
        throw new ConflictException(
          'An account needs at least one way to sign in',
        );
      }
      await transaction.accountLoginMethod.delete({ where: { id: target.id } });
      return target;
    });
    if (!removed) {
      throw new NotFoundException('Login method not found');
    }

    // after the commit; never throws (the unlink already succeeded)
    await this.disconnect.disconnectQuietly(removed);
  }
}
