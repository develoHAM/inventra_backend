import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { checkNonce, verifyIdToken } from './id-token';
import type {
  SocialIdentity,
  SocialIdentityVerifier,
} from './social-identity-verifier';

export const FACEBOOK_ISSUER = 'https://www.facebook.com';
// from https://limited.facebook.com/.well-known/openid-configuration/
export const FACEBOOK_JWKS_URL =
  'https://www.facebook.com/.well-known/oauth/openid/jwks/';
export const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com';

export interface FacebookSettings {
  appId: string; // the ID token's audience; the access token's app_id
  appSecret: string;
}

/**
 * Two credentials, one per platform:
 * - iOS Limited Login → `{ authenticationToken }`: an OIDC ID token (nonce required)
 * - Android → `{ accessToken }`: opaque, so we ask Facebook about it (no nonce)
 */
export class FacebookVerifier implements SocialIdentityVerifier {
  private readonly logger = new Logger(FacebookVerifier.name);

  constructor(
    private readonly settings: FacebookSettings,
    private readonly keySet: JWTVerifyGetKey = createRemoteJWKSet(
      new URL(FACEBOOK_JWKS_URL),
    ),
  ) {}

  async verify(
    credential: Record<string, unknown>,
    nonce?: string,
  ): Promise<SocialIdentity> {
    if (credential.authenticationToken !== undefined) {
      return this.verifyLimitedLogin(credential.authenticationToken, nonce);
    }
    if (typeof credential.accessToken === 'string' && credential.accessToken) {
      return this.verifyAccessToken(credential.accessToken);
    }
    throw new UnauthorizedException('Invalid social credential');
  }

  /** iOS: checked like any provider's ID token. */
  private async verifyLimitedLogin(
    authenticationToken: unknown,
    nonce: string | undefined,
  ): Promise<SocialIdentity> {
    const payload = await verifyIdToken(authenticationToken, this.keySet, {
      provider: 'Facebook',
      issuer: FACEBOOK_ISSUER,
      audience: this.settings.appId,
    });
    checkNonce(payload, nonce, { required: true });
    return this.identity(payload.sub, payload.name, payload.email);
  }

  /**
   * Android: the token proves nothing by itself. Facebook tells us whether it
   * is valid and FOR OUR APP (else another app's token could log in here),
   * then who it belongs to.
   */
  private async verifyAccessToken(
    accessToken: string,
  ): Promise<SocialIdentity> {
    const inspected = await this.graph<{
      data?: { is_valid?: unknown; app_id?: unknown; user_id?: unknown };
    }>('/debug_token', {
      input_token: accessToken,
      access_token: this.appAccessToken(),
    });
    const token = inspected.data;
    if (
      token?.is_valid !== true ||
      token.app_id !== this.settings.appId ||
      typeof token.user_id !== 'string'
    ) {
      throw new UnauthorizedException('Invalid social credential');
    }

    const me = await this.graph<{
      id?: unknown;
      name?: unknown;
      email?: unknown;
    }>('/me', {
      fields: 'id,name,email',
      access_token: accessToken,
      // proves the call comes from our server (required if "Require App Secret" is on)
      appsecret_proof: createHmac('sha256', this.settings.appSecret)
        .update(accessToken)
        .digest('hex'),
    });
    if (me.id !== token.user_id) {
      throw new UnauthorizedException('Invalid social credential');
    }
    return this.identity(token.user_id, me.name, me.email);
  }

  /** Facebook returns an email only when it has a valid one: it counts as verified. */
  private identity(
    facebookUserId: string,
    name: unknown,
    email: unknown,
  ): SocialIdentity {
    return {
      provider: 'facebook',
      providerUserId: facebookUserId,
      email: typeof email === 'string' ? email : null,
      emailVerified: typeof email === 'string',
      name: typeof name === 'string' ? name : null,
      refreshToken: null, // disconnect uses the app token
    };
  }

  /** De-authorize our app for this user (app access token; no user token needed). */
  async disconnect(login: {
    providerUserId: string;
    refreshToken: string | null;
  }): Promise<void> {
    const query = new URLSearchParams({ access_token: this.appAccessToken() });
    const response = await fetch(
      `${FACEBOOK_GRAPH_URL}/${encodeURIComponent(login.providerUserId)}/permissions?${query.toString()}`,
      { method: 'DELETE', signal: AbortSignal.timeout(5000) },
    );
    if (!response.ok) {
      throw new Error(
        `Facebook disconnect responded ${response.status} - ${await response.text()}`,
      );
    }
  }

  /** "Our app" credential for server-to-server Graph calls. */
  private appAccessToken(): string {
    return `${this.settings.appId}|${this.settings.appSecret}`;
  }

  /** A Graph API GET; anything but a 200 means Facebook (or our app config) failed: 503. */
  private async graph<T>(
    path: string,
    query: Record<string, string>,
  ): Promise<T> {
    try {
      const response = await fetch(
        `${FACEBOOK_GRAPH_URL}${path}?${new URLSearchParams(query).toString()}`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (!response.ok) {
        throw new Error(
          `${path} responded ${response.status} - ${await response.text()}`,
        );
      }
      return (await response.json()) as T;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Facebook Graph call failed: ${reason}`);
      throw new ServiceUnavailableException(
        'Facebook could not be reached; try again',
      );
    }
  }
}
