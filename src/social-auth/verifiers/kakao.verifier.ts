import { Logger } from '@nestjs/common';
import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { checkNonce, verifyIdToken } from './id-token';
import type {
  SocialIdentity,
  SocialIdentityVerifier,
} from './social-identity-verifier';

export const KAKAO_ISSUER = 'https://kauth.kakao.com';
export const KAKAO_JWKS_URL = 'https://kauth.kakao.com/.well-known/jwks.json';
export const KAKAO_USER_URL = 'https://kapi.kakao.com/v2/user/me';
export const KAKAO_UNLINK_URL = 'https://kapi.kakao.com/v1/user/unlink';

export interface KakaoSettings {
  nativeAppKey: string; // the ID token's audience
  adminKey: string; // server-to-server calls about any of our users
}

/** App sends `{ idToken }` from the Kakao SDK (OIDC enabled), with the nonce. */
export class KakaoVerifier implements SocialIdentityVerifier {
  private readonly logger = new Logger(KakaoVerifier.name);

  constructor(
    private readonly settings: KakaoSettings,
    // jose caches the keys and refetches when Kakao rotates them; tests pass a local set
    private readonly keySet: JWTVerifyGetKey = createRemoteJWKSet(
      new URL(KAKAO_JWKS_URL),
    ),
  ) {}

  async verify(
    credential: Record<string, unknown>,
    nonce?: string,
  ): Promise<SocialIdentity> {
    const payload = await verifyIdToken(credential.idToken, this.keySet, {
      provider: 'Kakao',
      issuer: KAKAO_ISSUER,
      audience: this.settings.nativeAppKey,
    });
    checkNonce(payload, nonce, { required: true });

    const email = typeof payload.email === 'string' ? payload.email : null;
    return {
      provider: 'kakao',
      providerUserId: payload.sub,
      email: email,
      emailVerified:
        email !== null && (await this.isVerifiedEmail(payload.sub, email)),
      name: typeof payload.nickname === 'string' ? payload.nickname : null,
      refreshToken: null, // unlink uses the admin key, not a user token
    };
  }

  /**
   * Kakao's ID token has no email_verified claim, so ask Kakao with the admin
   * key. Any failure counts as "not verified": the user then confirms the
   * email by code instead of being blocked.
   */
  private async isVerifiedEmail(
    kakaoUserId: string,
    email: string,
  ): Promise<boolean> {
    try {
      const query = new URLSearchParams({
        target_id_type: 'user_id',
        target_id: kakaoUserId,
      });
      const response = await fetch(`${KAKAO_USER_URL}?${query.toString()}`, {
        headers: { Authorization: `KakaoAK ${this.settings.adminKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`Kakao user/me responded ${response.status}`);
      }
      const body = (await response.json()) as {
        kakao_account?: {
          email?: unknown;
          is_email_valid?: unknown;
          is_email_verified?: unknown;
        };
      };
      const account = body.kakao_account;
      // the flags describe Kakao's current email: count them only for the one in the token
      return (
        account?.is_email_valid === true &&
        account.is_email_verified === true &&
        account.email === email
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Kakao email check failed; treating it as unverified: ${reason}`,
      );
      return false;
    }
  }

  /** Unlink our app from this Kakao user (admin key; refreshToken is unused). */
  async disconnect(login: {
    providerUserId: string;
    refreshToken: string | null;
  }): Promise<void> {
    const response = await fetch(KAKAO_UNLINK_URL, {
      method: 'POST',
      headers: {
        Authorization: `KakaoAK ${this.settings.adminKey}`,
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams({
        target_id_type: 'user_id',
        target_id: login.providerUserId,
      }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(
        `Kakao unlink responded ${response.status} - ${await response.text()}`,
      );
    }
  }
}
