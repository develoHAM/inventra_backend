import { Logger } from '@nestjs/common';
import { decodeJwt } from 'jose';

const logger = new Logger('SocialCodeExchange');

/**
 * Trade a one-time authorization code (Google serverAuthCode, Apple
 * authorizationCode) for a refresh token: the only thing that lets us revoke
 * our access later. The identity is already proven by the ID token, so any
 * problem here means "no refresh token" (logged), never a failed sign-in.
 */
export async function exchangeCodeForRefreshToken(exchange: {
  provider: string; // for messages: 'Google'
  tokenUrl: string;
  form: Record<string, string>; // grant_type, code, client_id, client_secret, …
  expectedSub: string; // the user the verified ID token names
}): Promise<string | null> {
  try {
    const response = await fetch(exchange.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(exchange.form).toString(),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(
        `token exchange responded ${response.status} - ${await response.text()}`,
      );
    }
    const body = (await response.json()) as {
      refresh_token?: unknown;
      id_token?: unknown;
    };
    if (typeof body.refresh_token !== 'string') return null; // e.g. Google after first consent

    // The code must be this user's: never attach someone else's grant to the account.
    // Decoding without a signature check is fine here: this id_token came straight
    // from the provider's token endpoint over HTTPS, in answer to our authenticated call.
    const exchangedFor =
      typeof body.id_token === 'string'
        ? decodeJwt(body.id_token).sub
        : undefined;
    if (exchangedFor !== exchange.expectedSub) {
      throw new Error('the code belongs to a different user');
    }
    return body.refresh_token;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`${exchange.provider} refresh token not obtained: ${reason}`);
    return null;
  }
}
