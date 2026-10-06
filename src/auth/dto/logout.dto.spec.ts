import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LogoutDto } from './logout.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(LogoutDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('LogoutDto', () => {
  it('accepts just a refresh token (deviceToken is optional)', async () => {
    await expect(failedFields({ refreshToken: 'r' })).resolves.toEqual([]);
  });

  it('accepts a refresh token plus a device token', async () => {
    await expect(
      failedFields({ refreshToken: 'r', deviceToken: 'phone-token' }),
    ).resolves.toEqual([]);
  });

  it('still requires the refresh token', async () => {
    await expect(failedFields({ deviceToken: 'phone-token' })).resolves.toEqual(
      ['refreshToken'],
    );
  });

  it.each([
    ['empty', ''],
    ['not a string', 12345],
  ])('rejects a deviceToken that is %s', async (_label, deviceToken) => {
    await expect(
      failedFields({ refreshToken: 'r', deviceToken: deviceToken }),
    ).resolves.toEqual(['deviceToken']);
  });
});
