import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { Env } from '../config/env.schema';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../generated/prisma/client';
import { NotificationChannel } from '../generated/prisma/enums';
import { NotificationsService } from '../notifications/notifications.service';
import { notificationTemplates } from '../notifications/notification-templates';
import {
  DAILY_EMAIL_CODE_LIMIT,
  EMAIL_CODE_TTL_SECONDS,
  EMAIL_RESEND_COOLDOWN_SECONDS,
  EMAIL_TOKEN_TTL_SECONDS,
  EMAIL_VERIFICATION_CODE_EVENT,
  MAX_EMAIL_CODE_ATTEMPTS,
} from './email-verification.constants';
import { normalizeEmail } from './email';

@Injectable()
export class EmailVerificationService {
  private readonly codeSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    config: ConfigService<Env, true>,
  ) {
    this.codeSecret = config.get('VERIFICATION_CODE_SECRET', { infer: true });
  }

  /** Email a 6-digit code to `email`. The code is stored only as an HMAC. */
  async start(email: string): Promise<{ expiresInSeconds: number }> {
    const now = Date.now();

    // We SEND here, so a stranger's inbox must not be floodable.
    const latest = await this.prisma.emailVerification.findFirst({
      where: { email: email },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const cooldownLeftMs = latest
      ? EMAIL_RESEND_COOLDOWN_SECONDS * 1000 -
        (now - latest.createdAt.getTime())
      : 0;
    if (cooldownLeftMs > 0) {
      // retryAfterSeconds lets the app show "resend available in N s"
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Please wait before requesting another code',
          retryAfterSeconds: Math.ceil(cooldownLeftMs / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const sentToday = await this.prisma.emailVerification.count({
      where: {
        email: email,
        createdAt: { gte: new Date(now - 24 * 60 * 60 * 1000) },
      },
    });
    if (sentToday >= DAILY_EMAIL_CODE_LIMIT) {
      throw new HttpException(
        'Too many codes requested for this address today',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const message = notificationTemplates.emailVerificationCode(code);

    // Queue the email first: if that fails, no row exists, so the user can
    // retry at once instead of waiting out the cooldown.
    try {
      await this.notifications.dispatch({
        eventType: EMAIL_VERIFICATION_CODE_EVENT,
        channel: NotificationChannel.EMAIL,
        recipientAddress: email,
        subject: message.subject,
        body: message.body,
        // the notifications table keeps only this; the code rides in the job
        redactedBody:
          notificationTemplates.emailVerificationCode('******').body,
      });
    } catch {
      throw new ServiceUnavailableException(
        'Could not send the verification email; try again',
      );
    }

    await this.prisma.emailVerification.create({
      data: {
        email: email,
        codeHash: this.hashCode(code),
        expiresAt: new Date(now + EMAIL_CODE_TTL_SECONDS * 1000),
      },
    });
    return { expiresInSeconds: EMAIL_CODE_TTL_SECONDS };
  }

  /** Check the typed code; on success issue a single-use 10-minute token. */
  async confirm(
    email: string,
    code: string,
  ): Promise<{ emailVerificationToken: string; expiresInSeconds: number }> {
    const now = new Date();
    const verification = await this.prisma.emailVerification.findFirst({
      where: { email: email, verifiedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (!verification) throw new BadRequestException('Invalid or expired code');

    // Claim an attempt BEFORE comparing, in one conditional write, so
    // parallel guesses can't exceed the cap.
    const claimed = await this.prisma.emailVerification.updateMany({
      where: {
        id: verification.id,
        attempts: { lt: MAX_EMAIL_CODE_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new BadRequestException('Too many attempts; request a new code');
    }

    // Constant-time comparison of the two HMACs (both 32 bytes).
    const matches = timingSafeEqual(
      Buffer.from(verification.codeHash, 'hex'),
      Buffer.from(this.hashCode(code), 'hex'),
    );
    if (!matches) throw new BadRequestException('Invalid or expired code');

    // Issue the token conditionally: two parallel correct guesses can't both mint one.
    const emailVerificationToken = randomBytes(32).toString('base64url');
    const issued = await this.prisma.emailVerification.updateMany({
      where: { id: verification.id, verifiedAt: null },
      data: {
        verifiedAt: now,
        tokenHash: this.hashToken(emailVerificationToken),
        tokenExpiresAt: new Date(
          now.getTime() + EMAIL_TOKEN_TTL_SECONDS * 1000,
        ),
      },
    });
    if (issued.count === 0) {
      throw new BadRequestException('Invalid or expired code');
    }

    return {
      emailVerificationToken: emailVerificationToken,
      expiresInSeconds: EMAIL_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * Spend an email token exactly once, inside the caller's transaction, for
   * the address it was issued for (normalized the same way as at start).
   */
  async consume(
    tx: Prisma.TransactionClient,
    input: { token: string; email: string },
  ): Promise<void> {
    const now = new Date();
    const consumed = await tx.emailVerification.updateMany({
      where: {
        tokenHash: this.hashToken(input.token),
        email: normalizeEmail(input.email) as string,
        consumedAt: null,
        tokenExpiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new BadRequestException('Invalid or expired email verification');
    }
  }

  /** The code is a secret with only 10^6 values: a keyed hash, never a plain one. */
  private hashCode(code: string): string {
    return createHmac('sha256', this.codeSecret).update(code).digest('hex');
  }

  /** The token is 32 random bytes: a plain SHA-256 is enough. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
