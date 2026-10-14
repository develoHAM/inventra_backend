import { randomBytes } from 'node:crypto';
import { decryptToken, encryptToken } from './token-cipher';

describe('token cipher (AES-256-GCM)', () => {
  const key = randomBytes(32).toString('base64');
  const appleRefreshToken = 'r7f1a2b3c4.0.mrqwz.AbCdEfGh-IjKl_MnOp';

  it('round-trips: decrypt(encrypt(x)) === x', () => {
    const stored = encryptToken(appleRefreshToken, key);

    expect(decryptToken(stored, key)).toBe(appleRefreshToken);
  });

  it('never stores the plain token', () => {
    const stored = encryptToken(appleRefreshToken, key);

    expect(stored).not.toContain(appleRefreshToken);
    expect(Buffer.from(stored, 'base64').toString('utf8')).not.toContain(
      appleRefreshToken,
    );
  });

  it('gives different output for the same input (random IV per encryption)', () => {
    const first = encryptToken(appleRefreshToken, key);
    const second = encryptToken(appleRefreshToken, key);

    expect(first).not.toBe(second);
    expect(decryptToken(first, key)).toBe(decryptToken(second, key));
  });

  it('stores iv (12) + tag (16) + ciphertext in one base64 string', () => {
    const stored = encryptToken('abc', key);

    expect(Buffer.from(stored, 'base64')).toHaveLength(12 + 16 + 3);
  });

  it('refuses tampered data instead of returning garbage', () => {
    const bytes = Buffer.from(encryptToken(appleRefreshToken, key), 'base64');
    bytes[bytes.length - 1] ^= 0x01; // flip one bit of the ciphertext

    expect(() => decryptToken(bytes.toString('base64'), key)).toThrow();
  });

  it('refuses the wrong key', () => {
    const stored = encryptToken(appleRefreshToken, key);
    const otherKey = randomBytes(32).toString('base64');

    expect(() => decryptToken(stored, otherKey)).toThrow();
  });

  it('handles non-ASCII text', () => {
    const stored = encryptToken('토큰-✓', key);

    expect(decryptToken(stored, key)).toBe('토큰-✓');
  });
});
