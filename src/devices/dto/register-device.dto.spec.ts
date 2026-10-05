import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDeviceDto } from './register-device.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(RegisterDeviceDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('RegisterDeviceDto', () => {
  it.each(['ANDROID', 'IOS', 'WEB'])(
    'accepts platform %s',
    async (platform) => {
      await expect(
        failedFields({ token: 'fcm-token-abc', platform: platform }),
      ).resolves.toEqual([]);
    },
  );

  it('rejects an unknown platform', async () => {
    await expect(
      failedFields({ token: 'fcm-token-abc', platform: 'WINDOWS_PHONE' }),
    ).resolves.toEqual(['platform']);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['absurdly long', 'x'.repeat(4097)],
  ])('rejects a token that is %s', async (_label, token) => {
    await expect(
      failedFields({ token: token, platform: 'ANDROID' }),
    ).resolves.toEqual(['token']);
  });

  it('refuses a userId in the body (the owner comes from the JWT)', async () => {
    await expect(
      failedFields({
        token: 'fcm-token-abc',
        platform: 'ANDROID',
        userId: 'someone-else',
      }),
    ).resolves.toEqual(['userId']);
  });
});
