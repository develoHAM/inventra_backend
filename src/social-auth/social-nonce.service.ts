import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { NONCE_TTL_SECONDS } from './social-auth.constants';

/**
 * What the provider signs into its token for `nonce`: the app hands
 * SHA-256(nonce) (hex) to the SDK and sends us the raw nonce. We store the
 * same hash, so a database leak gives out nothing usable.
 */
export function nonceClaimFor(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

@Injectable()
export class SocialNonceService {
  constructor(private readonly prisma: PrismaService) {}

  /** A fresh single-use nonce for one sign-in, valid 5 minutes. */
  async issue(): Promise<{ nonce: string; expiresInSeconds: number }> {
    const nonce = randomBytes(32).toString('base64url');
    await this.prisma.socialNonce.create({
      data: {
        nonceHash: nonceClaimFor(nonce),
        expiresAt: new Date(Date.now() + NONCE_TTL_SECONDS * 1000),
      },
    });
    return { nonce: nonce, expiresInSeconds: NONCE_TTL_SECONDS };
  }

  /** Spend a nonce once. false = unknown, already used or expired; the caller answers 401. */
  async consume(nonce: string): Promise<boolean> {
    const now = new Date();
    const consumed = await this.prisma.socialNonce.updateMany({
      where: {
        nonceHash: nonceClaimFor(nonce),
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    return consumed.count === 1;
  }
}
