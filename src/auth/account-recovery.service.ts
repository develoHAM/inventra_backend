import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';
import { maskEmail } from './mask-email';
import {
  AccountPasswordResetEvent,
  NotificationEvent,
} from '../notifications/notification-events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PasswordService } from './password.service';

@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phoneVerification: PhoneVerificationService,
    private readonly passwordService: PasswordService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * How the account on a verified phone signs in: its password-login email
   * (masked; null if it has none) and the providers it can use. A user who
   * signed up with Kakao learns "Kakao", not a dead end.
   */
  async findId(
    phone: string,
    token: string,
  ): Promise<{ email: string | null; providers: string[] }> {
    // Spend the token first; "no account" still commits, so every lookup
    // costs a fresh phone verification.
    const user = await this.prisma.$transaction(async (transaction) => {
      await this.phoneVerification.consume(transaction, {
        token: token,
        phone: phone,
        purpose: PhoneVerificationPurpose.FIND_ID,
      });
      return transaction.user.findFirst({
        where: { phone: phone, deletedAt: null },
        select: {
          loginMethods: {
            select: { method: true, email: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
    });

    if (!user) throw new NotFoundException('No account uses this phone');
    const passwordLogin = user.loginMethods.find(
      (loginMethod) => loginMethod.method === 'local',
    );
    return {
      email: passwordLogin?.email ? maskEmail(passwordLogin.email) : null,
      providers: user.loginMethods
        .filter((loginMethod) => loginMethod.method !== 'local')
        .map((loginMethod) => loginMethod.method),
    };
  }

  /**
   * Set a new password for the account that owns BOTH the email and the
   * verified phone; every session is logged out and the owner is emailed.
   */
  async resetPassword(input: {
    email: string;
    phone: string;
    token: string;
    newPassword: string;
  }): Promise<void> {
    // Slow by design — do it before the transaction holds a connection.
    const passwordHash = await this.passwordService.hash(input.newPassword);

    const userId = await this.prisma.$transaction(async (transaction) => {
      await this.phoneVerification.consume(transaction, {
        token: input.token,
        phone: input.phone,
        purpose: PhoneVerificationPurpose.RESET_PASSWORD,
      });

      // Both factors must point at the same account.
      const loginMethod = await transaction.userLoginMethod.findFirst({
        where: {
          method: 'local',
          email: input.email,
          user: { phone: input.phone, deletedAt: null },
        },
        select: { id: true, userId: true },
      });
      if (!loginMethod) return null; // commit: the token stays spent

      await transaction.userLoginMethod.update({
        where: { id: loginMethod.id },
        data: { passwordHash: passwordHash },
      });
      // Log out every device: refresh tokens stop working now; issued access
      // tokens expire on their own (15 min).
      await transaction.refreshToken.updateMany({
        where: { userId: loginMethod.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return loginMethod.userId;
    });

    if (!userId) {
      throw new BadRequestException('Email and phone do not match an account');
    }

    const event: AccountPasswordResetEvent = { userId: userId };
    this.eventEmitter.emit(NotificationEvent.ACCOUNT_PASSWORD_RESET, event);
  }
}
