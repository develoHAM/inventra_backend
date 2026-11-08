import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangeRoleDto } from './change-role.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(ChangeRoleDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('ChangeRoleDto', () => {
  it.each(['OWNER', 'MANAGER', 'STAFF'])('accepts role %s', async (role) => {
    await expect(failedFields({ role: role })).resolves.toEqual([]);
  });

  it.each(['ADMIN', 'manager', '', undefined])(
    'rejects role %p',
    async (role) => {
      await expect(failedFields({ role: role })).resolves.toEqual(['role']);
    },
  );

  it('accepts cornerId as a uuid, as null, or left out', async () => {
    await expect(
      failedFields({
        role: 'STAFF',
        cornerId: '0b9a1f3e-5c2d-4e8f-9a7b-1c2d3e4f5a6b',
      }),
    ).resolves.toEqual([]);
    await expect(
      failedFields({ role: 'STAFF', cornerId: null }),
    ).resolves.toEqual([]);
    await expect(failedFields({ role: 'STAFF' })).resolves.toEqual([]);
  });

  it('rejects a cornerId that is not a uuid', async () => {
    await expect(
      failedFields({ role: 'STAFF', cornerId: 'branch-b' }),
    ).resolves.toEqual(['cornerId']);
  });

  it('keeps "not sent" (undefined) apart from null', () => {
    const notSent = plainToInstance(ChangeRoleDto, { role: 'STAFF' });
    const sentAsNull = plainToInstance(ChangeRoleDto, {
      role: 'STAFF',
      cornerId: null,
    });

    expect(notSent.cornerId).toBeUndefined();
    expect(sentAsNull.cornerId).toBeNull();
  });
});
