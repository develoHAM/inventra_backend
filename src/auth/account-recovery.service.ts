import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PhoneVerificationService } from '../phone-verification/phone-verification.service';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';
import { maskEmail } from './mask-email';

@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly phoneVerification: PhoneVerificationService,
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
}
