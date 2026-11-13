import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApproveProfileDto } from './approve-profile.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(ApproveProfileDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('ApproveProfileDto', () => {
  const BRANCH_ID = '0b9a1f3e-5c2d-4e8f-9a7b-1c2d3e4f5a6b';

  it('accepts a role and a branch', async () => {
    await expect(
      failedFields({ roleId: 4, cornerId: BRANCH_ID }),
    ).resolves.toEqual([]);
  });

  it('accepts a role and null: "no branch yet"', async () => {
    await expect(failedFields({ roleId: 4, cornerId: null })).resolves.toEqual(
      [],
    );
  });

  it('requires cornerId: leaving it out is not the same as null', async () => {
    await expect(failedFields({ roleId: 4 })).resolves.toEqual(['cornerId']);
  });

  it('rejects a cornerId that is not a uuid', async () => {
    await expect(
      failedFields({ roleId: 4, cornerId: 'branch-a' }),
    ).resolves.toEqual(['cornerId']);
  });

  it.each([[undefined], [0], [-1], [1.5], ['4']])(
    'rejects roleId %p',
    async (roleId) => {
      await expect(
        failedFields({ roleId: roleId, cornerId: null }),
      ).resolves.toEqual(['roleId']);
    },
  );
});
