import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWTPayload, JWTVerifyGetKey } from 'jose';

/**
 * A local RS256 key pair standing in for a provider's published keys, so
 * unit tests can mint real signed ID tokens with no network.
 *
 *   const provider = await fakeProviderKeys();
 *   const idToken = await provider.sign({ iss: 'https://kauth.kakao.com', aud: 'app-key', sub: '42' });
 *   new KakaoVerifier(settings, provider.keySet);   // verifies against these keys
 */
export async function fakeProviderKeys(kid = 'test-key-1'): Promise<{
  keySet: JWTVerifyGetKey;
  sign: (claims: JWTPayload, header?: { kid?: string }) => Promise<string>;
}> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const publicJwk = await exportJWK(publicKey);
  const keySet = createLocalJWKSet({
    keys: [{ ...publicJwk, kid: kid, alg: 'RS256', use: 'sig' }],
  });

  const sign = (claims: JWTPayload, header: { kid?: string } = {}) => {
    const now = Math.floor(Date.now() / 1000);
    // iat/exp default to "now, valid 1 h"; a test overrides them through claims
    return new SignJWT({ iat: now, exp: now + 3600, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: header.kid ?? kid })
      .sign(privateKey);
  };

  return { keySet: keySet, sign: sign };
}
