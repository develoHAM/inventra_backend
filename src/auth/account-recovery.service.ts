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

  /** The login email of the account on a verified phone, masked. */
  async findId(phone: string, token: string): Promise<{ email: string }> {
    // Spend the token first; "no account" still commits, so every lookup
    // costs a fresh phone verification.
    const loginMethod = await this.prisma.$transaction(async (transaction) => {
      await this.phoneVerification.consume(transaction, {
        token: token,
        phone: phone,
        purpose: PhoneVerificationPurpose.FIND_ID,
      });
      return transaction.userLoginMethod.findFirst({
        where: {
          method: 'local',
          email: { not: null },
          user: { phone: phone, deletedAt: null },
        },
        select: { email: true },
      });
    });

    if (!loginMethod?.email) {
      throw new NotFoundException('No account uses this phone');
    }
    return { email: maskEmail(loginMethod.email) };
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
