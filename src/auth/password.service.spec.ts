import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const passwordService = new PasswordService();
  const testValue = 'testValue';

  it('can generate and verify hash', async () => {
    const hash = await passwordService.hash(testValue);

    await expect(passwordService.verify(hash, testValue)).resolves.toBe(true);
  });

  it('can detect different password', async () => {
    const anotherPassword = 'anotherTestValue';

    const hash = await passwordService.hash(testValue);
    await expect(passwordService.verify(hash, anotherPassword)).resolves.toBe(
      false,
    );
  });

  it('returns a different hash for the same value', async () => {
    const hash1 = await passwordService.hash(testValue);
    const hash2 = await passwordService.hash(testValue);

    expect(hash1).not.toBe(hash2);
  });
});
