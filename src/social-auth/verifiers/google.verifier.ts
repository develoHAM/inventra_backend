import { Logger } from '@nestjs/common';
import { createRemoteJWKSet, decodeJwt } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { checkNonce, claimIsTrue, verifyIdToken } from './id-token';
import type {
  SocialIdentity,
  SocialIdentityVerifier,
} from './social-identity-verifier';

export const GOOGLE_ISSUERS = [
  'https://accounts.google.com',
  'accounts.google.com',
];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

export interface GoogleSettings {
  audiences: string[]; // every client id (web, iOS, Android) a token may be issued for
  webClientId: string; // the client the app's serverAuthCode is for
  clientSecret: string; // the web client's secret: exchanges the code
}

/** App sends `{ idToken, serverAuthCode? }` from Google Sign-In (offline access on). */
export class GoogleVerifier implements SocialIdentityVerifier {
  private readonly logger = new Logger(GoogleVerifier.name);

  constructor(
    private readonly settings: GoogleSettings,
    private readonly keySet: JWTVerifyGetKey = createRemoteJWKSet(
      new URL(GOOGLE_JWKS_URL),
    ),
  ) {}

  async verify(
    credential: Record<string, unknown>,
    nonce?: string,
  ): Promise<SocialIdentity> {
    const payload = await verifyIdToken(credential.idToken, this.keySet, {
      provider: 'Google',
      issuer: GOOGLE_ISSUERS,
      audience: this.settings.audiences,
    });
    // Google Sign-In can't always bind a nonce: check it only when the token has one
    checkNonce(payload, nonce, { required: false });

    const email = typeof payload.email === 'string' ? payload.email : null;
    return {
      provider: 'google',
      providerUserId: payload.sub,
      email: email,
      emailVerified: email !== null && claimIsTrue(payload.email_verified),
      name: typeof payload.name === 'string' ? payload.name : null,
      refreshToken: await this.refreshTokenFrom(
        credential.serverAuthCode,
        payload.sub,
      ),
    };
  }

  /**
   * Trade the one-time serverAuthCode for a refresh token: the only thing that
   * lets us revoke our access later. Google returns one only on the user's
   * first consent, and the identity is already proven, so any problem here
   * means "no refresh token" (logged), never a failed sign-in.
   */
  private async refreshTokenFrom(
    serverAuthCode: unknown,
    googleUserId: string,
  ): Promise<string | null> {
    if (typeof serverAuthCode !== 'string' || serverAuthCode.length === 0) {
      return null;
    }
    try {
      const response = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: serverAuthCode,
          client_id: this.settings.webClientId,
          client_secret: this.settings.clientSecret,
          redirect_uri: '', // native apps have no redirect
        }).toString(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(
          `Google token exchange responded ${response.status} - ${await response.text()}`,
        );
      }
      const body = (await response.json()) as {
        refresh_token?: unknown;
        id_token?: unknown;
      };
      if (typeof body.refresh_token !== 'string') return null; // not the first consent

      // The code must be this user's: never attach someone else's grant to the account.
      // Decoding without a signature check is fine here: this id_token came straight
      // from Google's token endpoint over HTTPS, in answer to our authenticated call.
      const exchangedFor =
        typeof body.id_token === 'string'
          ? decodeJwt(body.id_token).sub
          : undefined;
      if (exchangedFor !== googleUserId) {
        throw new Error('the auth code belongs to a different Google user');
      }
      return body.refresh_token;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Google refresh token not obtained: ${reason}`);
      return null;
    }
  }

  /** Revoke our access with the stored refresh token (nothing to do without one). */
  async disconnect(login: {
    providerUserId: string;
    refreshToken: string | null;
  }): Promise<void> {
    if (login.refreshToken === null) return;
    const response = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: login.refreshToken }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(
        `Google revoke responded ${response.status} - ${await response.text()}`,
      );
    }
  }
}
