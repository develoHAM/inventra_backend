import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { errors, jwtVerify } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';
import { nonceClaimFor } from '../social-nonce.service';

const logger = new Logger('SocialIdToken');

// jose errors that mean "this token is bad" (401). Anything else — the key
// server unreachable, timing out or answering garbage — is on the provider's
// side (503): the same token may well verify a minute later.
const TOKEN_FAULTS = [
  errors.JWSInvalid,
  errors.JWTInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
];

/** A verified ID token's claims; `sub` is guaranteed. */
export type IdTokenPayload = JWTPayload & { sub: string };

/**
 * Verify a provider's ID token: signed by one of the provider's published
 * keys (RS256 — every provider we use), issued by it, for our app, unexpired.
 */
export async function verifyIdToken(
  idToken: unknown,
  keySet: JWTVerifyGetKey,
  expected: {
    provider: string; // for messages: 'Kakao'
    issuer: string | string[];
    audience: string | string[];
  },
): Promise<IdTokenPayload> {
  if (typeof idToken !== 'string' || idToken.length === 0) {
    throw new UnauthorizedException('Invalid social credential');
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, keySet, {
      issuer: expected.issuer,
      audience: expected.audience,
      algorithms: ['RS256'],
    }));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (TOKEN_FAULTS.some((fault) => error instanceof fault)) {
      logger.debug(`${expected.provider} ID token rejected: ${reason}`);
      throw new UnauthorizedException('Invalid social credential');
    }
    logger.warn(`${expected.provider} keys unavailable: ${reason}`);
    throw new ServiceUnavailableException(
      `${expected.provider} could not be reached; try again`,
    );
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new UnauthorizedException('Invalid social credential');
  }
  return payload as IdTokenPayload;
}

/** A boolean claim that providers send as `true` or (Apple) the string "true". */
export function claimIsTrue(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * The token's `nonce` claim must be SHA-256(the raw nonce the app sent us).
 * `required`: the provider always binds one (Kakao, Apple, Facebook iOS); if
 * not (Google), a token that carries one is still checked.
 */
export function checkNonce(
  payload: JWTPayload,
  nonce: string | undefined,
  options: { required: boolean },
): void {
  if (payload.nonce === undefined && !options.required) return;
  if (nonce === undefined || payload.nonce !== nonceClaimFor(nonce)) {
    throw new UnauthorizedException('Invalid social credential');
  }
}
