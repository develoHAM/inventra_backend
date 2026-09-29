import {
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CODE_TTL_SECONDS,
  DAILY_START_LIMIT,
  OCTOMO_RECEIVER_NUMBER,
  PHONE_VERIFIER,
} from './phone-verification.constants';
import type { PhoneOwnershipVerifier } from './verifiers/phone-ownership-verifier';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';
import { randomInt } from 'node:crypto';

@Injectable()
export class PhoneVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PHONE_VERIFIER) private readonly verifier: PhoneOwnershipVerifier,
  ) {}

  /**
   * Begin a verification: the caller shows `code` and `receiverNumber` to the
   * user, who texts the code from their phone.
   */
  async start(
    phone: string,
    purpose: PhoneVerificationPurpose,
  ): Promise<{
    verificationId: string;
    code: string;
    receiverNumber: string;
    expiresInSeconds: number;
  }> {
    const now = Date.now();

    // ① Daily cap per phone, across all purposes.
    const startedToday = await this.prisma.phoneVerification.count({
      where: {
        phone: phone,
        createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) },
      },
    });
    if (startedToday >= DAILY_START_LIMIT) {
      throw new HttpException(
        'Too many verifications for this phone today',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // ② Signup needs a phone nobody has: fail now, not after the user texted.
    if (purpose === PhoneVerificationPurpose.SIGNUP) {
      const owner = await this.prisma.user.findFirst({
        where: {
          phone: phone,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (owner) throw new ConflictException('Phone already registered');
    }

    // ③ The code is shown to the user, so it is stored as-is (not a secret).
    const verification = await this.prisma.phoneVerification.create({
      data: {
        phone: phone,
        purpose: purpose,
        code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
        expiresAt: new Date(now + CODE_TTL_SECONDS * 1000),
      },
    });

    return {
      verificationId: verification.id,
      code: verification.code,
      receiverNumber: OCTOMO_RECEIVER_NUMBER,
      expiresInSeconds: CODE_TTL_SECONDS,
    };
  }
}
