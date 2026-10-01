import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CODE_TTL_SECONDS,
  DAILY_START_LIMIT,
  MAX_CONFIRM_CHECKS,
  OCTOMO_RECEIVER_NUMBER,
  PHONE_VERIFIER,
  TOKEN_TTL_SECONDS,
} from './phone-verification.constants';
import type { PhoneOwnershipVerifier } from './verifiers/phone-ownership-verifier';
import { PhoneVerificationPurpose } from '../generated/prisma/enums';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';

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

  /**
   * The user says they texted the code: ask the verifier, and on success
   * issue a single-use token that proves ownership of the phone.
   */
  async confirm(
    verificationId: string,
  ): Promise<{ verificationToken: string; expiresInSeconds: number }> {
    const now = new Date();

    // ① Only a live verification can be confirmed.
    const verification = await this.prisma.phoneVerification.findFirst({
      where: {
        id: verificationId,
        verifiedAt: null,
        expiresAt: { gt: now },
      },
    });
    if (!verification) {
      throw new BadRequestException('Invalid or expired verification');
    }

    // ② Each check costs an OCTOMO call: claim one first, in ONE conditional
    //    write, so parallel requests can't exceed the cap.
    const claimed = await this.prisma.phoneVerification.updateMany({
      where: {
        id: verification.id,
        checkAttempts: { lt: MAX_CONFIRM_CHECKS },
      },
      data: {
        checkAttempts: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      throw new HttpException(
        'Too many checks; start a new verification',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // ③ Only texts sent since this verification started may count.
    const minutesSinceStart = Math.ceil(
      (now.getTime() - verification.createdAt.getTime()) / 60_000,
    );
    const withinMinutes = Math.min(60, Math.max(1, minutesSinceStart));

    // ④ Ask the verifier. Its failure is ours (503), not the user's.
    let received: boolean;
    try {
      received = await this.verifier.messageExists(
        verification.phone,
        verification.code,
        withinMinutes,
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        'Could not check the message right now; try again',
      );
    }
    if (!received) throw new BadRequestException('Message not received yet');

    // ⑤ Issue the token — conditionally, so two parallel successful confirms
    //    can't both mint one.
    const verificationToken = randomBytes(32).toString('base64url');
    const issued = await this.prisma.phoneVerification.updateMany({
      where: { id: verification.id, verifiedAt: null },
      data: {
        verifiedAt: now,
        tokenHash: this.hashToken(verificationToken),
        tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_SECONDS * 1000),
      },
    });
    if (issued.count === 0) {
      throw new BadRequestException('Invalid or expired verification');
    }

    return {
      verificationToken: verificationToken,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Spend a verification token exactly once, inside the caller's
   * transaction (so a failed signup rolls the consumption back).
   */
  async consume(
    tx: Prisma.TransactionClient,
    input: { token: string; phone: string; purpose: PhoneVerificationPurpose },
  ): Promise<void> {
    const now = new Date();
    const consumed = await tx.phoneVerification.updateMany({
      where: {
        tokenHash: this.hashToken(input.token),
        phone: input.phone,
        purpose: input.purpose,
        consumedAt: null,
        tokenExpiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new BadRequestException('Invalid or expired verification token');
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
