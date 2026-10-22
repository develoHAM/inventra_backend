import { Logger } from '@nestjs/common';
import { SignJWT, createRemoteJWKSet, importPKCS8 } from 'jose';
import type { CryptoKey, JWTVerifyGetKey } from 'jose';
import { exchangeCodeForRefreshToken } from './code-exchange';
import { checkNonce, claimIsTrue, verifyIdToken } from './id-token';
import type {
  SocialIdentity,
  SocialIdentityVerifier,
} from './social-identity-verifier';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
export const APPLE_TOKEN_URL = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_URL = 'https://appleid.apple.com/auth/revoke';
const CLIENT_SECRET_TTL_SECONDS = 300; // minted per call, so short is enough

export interface AppleSettings {
  teamId: string;
  keyId: string; // the Sign in with Apple key's id (the .p8 file's)
  privateKeyPem: string; // the .p8 file's contents
  bundleId: string; // our client_id, and the identity token's audience
}

/** App sends `{ identityToken, authorizationCode, fullName? }` from expo-apple-authentication. */
export class AppleVerifier implements SocialIdentityVerifier {
  private readonly logger = new Logger(AppleVerifier.name);
  private signingKey: Promise<CryptoKey> | undefined; // the .p8 key, imported once

  constructor(
    private readonly settings: AppleSettings,
    private readonly keySet: JWTVerifyGetKey = createRemoteJWKSet(
      new URL(APPLE_JWKS_URL),
    ),
  ) {}

  async verify(
    credential: Record<string, unknown>,
    nonce?: string,
  ): Promise<SocialIdentity> {
    const payload = await verifyIdToken(credential.identityToken, this.keySet, {
      provider: 'Apple',
      issuer: APPLE_ISSUER,
      audience: this.settings.bundleId,
    });
    checkNonce(payload, nonce, { required: true });

    const email = typeof payload.email === 'string' ? payload.email : null;
    return {
      provider: 'apple',
      providerUserId: payload.sub,
      email: email,
      // Apple sends "true" as a string; a private-relay address is verified too
      emailVerified: email !== null && claimIsTrue(payload.email_verified),
      // Not in the token: the app passes it, and only on the very first sign-in.
      // Unsigned, so it is only ever a suggestion for the signup form.
      name: nameFrom(credential.fullName),
      refreshToken: await this.refreshTokenFrom(
        credential.authorizationCode,
        payload.sub,
      ),
    };
  }

  /** The authorizationCode (single-use, ~5 min) → refresh token, for revoking later. */
  private async refreshTokenFrom(
    authorizationCode: unknown,
    appleUserId: string,
  ): Promise<string | null> {
    if (
      typeof authorizationCode !== 'string' ||
      authorizationCode.length === 0
    ) {
      return null;
    }
    let clientSecret: string;
    try {
      clientSecret = await this.clientSecret();
    } catch (error) {
      // a broken .p8 key must not block sign-in: same rule as any exchange failure
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Apple refresh token not obtained: client secret failed: ${reason}`,
      );
      return null;
    }
    return exchangeCodeForRefreshToken({
      provider: 'Apple',
      tokenUrl: APPLE_TOKEN_URL,
      form: {
        grant_type: 'authorization_code',
        code: authorizationCode,
        client_id: this.settings.bundleId,
        client_secret: clientSecret,
      },
      expectedSub: appleUserId,
    });
  }

  /** Revoke our access with the stored refresh token (nothing to do without one). */
  async disconnect(login: {
    providerUserId: string;
    refreshToken: string | null;
  }): Promise<void> {
    if (login.refreshToken === null) return;
    const response = await fetch(APPLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.settings.bundleId,
        client_secret: await this.clientSecret(),
        token: login.refreshToken,
        token_type_hint: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(
        `Apple revoke responded ${response.status} - ${await response.text()}`,
      );
    }
  }

  /**
   * Apple has no static client secret: we prove we are this app by signing a
   * short JWT with our .p8 key (ES256) for every token or revoke call.
   */
  private async clientSecret(): Promise<string> {
    this.signingKey ??= importPKCS8(this.settings.privateKeyPem, 'ES256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.settings.keyId })
      .setIssuer(this.settings.teamId)
      .setIssuedAt(now)
      .setExpirationTime(now + CLIENT_SECRET_TTL_SECONDS)
      .setAudience(APPLE_ISSUER)
      .setSubject(this.settings.bundleId)
      .sign(await this.signingKey);
  }
}

/**
 * The app's fullName: a string (expo's formatFullName) or Apple's name
 * object ({ givenName, familyName, … }). Anything else → null.
 */
function nameFrom(fullName: unknown): string | null {
  if (typeof fullName === 'string') return fullName.trim() || null;
  if (typeof fullName !== 'object' || fullName === null) return null;
  const { givenName, familyName } = fullName as Record<string, unknown>;
  const parts = [givenName, familyName].filter(
    (part): part is string => typeof part === 'string' && part.trim() !== '',
  );
  return parts.length > 0 ? parts.map((part) => part.trim()).join(' ') : null;
}
