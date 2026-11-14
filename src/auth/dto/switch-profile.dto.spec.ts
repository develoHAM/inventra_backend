import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SwitchProfileDto } from './switch-profile.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(SwitchProfileDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('SwitchProfileDto', () => {
  const validBody = {
    refreshToken: 'refresh-token',
    profileId: '4f0c2a8e-6b1d-4c3e-9a7f-2d5e8b1c0a93',
  };

  it('accepts a refresh token and a profile id', async () => {
    await expect(failedFields(validBody)).resolves.toEqual([]);
  });

  it.each(['refreshToken', 'profileId'])('requires %s', async (field) => {
    const body: Record<string, unknown> = { ...validBody };
    delete body[field];

    await expect(failedFields(body)).resolves.toEqual([field]);
  });

  it('rejects a profileId that is not a uuid', async () => {
    await expect(
      failedFields({ ...validBody, profileId: 'profile-2' }),
    ).resolves.toEqual(['profileId']);
  });

  it('rejects an empty refresh token', async () => {
    await expect(
      failedFields({ ...validBody, refreshToken: '' }),
    ).resolves.toEqual(['refreshToken']);
  });

  it('rejects unknown fields (e.g. an accountId: the caller comes from the JWT)', async () => {
    await expect(
      failedFields({ ...validBody, accountId: 'someone-else' }),
    ).resolves.toEqual(['accountId']);
  });
});
