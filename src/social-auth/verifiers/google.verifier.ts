import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { exchangeCodeForRefreshToken } from './code-exchange';
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

  /** The serverAuthCode → refresh token (Google sends one only on first consent). */
  private async refreshTokenFrom(
    serverAuthCode: unknown,
    googleUserId: string,
  ): Promise<string | null> {
    if (typeof serverAuthCode !== 'string' || serverAuthCode.length === 0) {
      return null;
    }
    return exchangeCodeForRefreshToken({
      provider: 'Google',
      tokenUrl: GOOGLE_TOKEN_URL,
      form: {
        grant_type: 'authorization_code',
        code: serverAuthCode,
        client_id: this.settings.webClientId,
        client_secret: this.settings.clientSecret,
        redirect_uri: '', // native apps have no redirect
      },
      expectedSub: googleUserId,
    });
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
