import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM's recommended nonce size
const TAG_BYTES = 16; // the authentication tag ("seal")

/**
 * Encrypt a provider credential we must be able to read back (Apple/Google
 * refresh tokens, needed later to revoke). Returns base64(iv | tag | ciphertext).
 * Each call uses a fresh random IV, so equal inputs give different outputs.
 */
export function encryptToken(plain: string, keyBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64'); // 32 bytes (checked at boot)
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64',
  );
}

/**
 * Reverse of encryptToken. Throws if the data was altered or the key is
 * wrong — GCM verifies the tag instead of returning garbage.
 */
export function decryptToken(stored: string, keyBase64: string): string {
  const data = Buffer.from(stored, 'base64');
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(
    ALGORITHM,
    Buffer.from(keyBase64, 'base64'),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(), // ← throws "Unsupported state or unable to authenticate data"
  ]).toString('utf8');
}
