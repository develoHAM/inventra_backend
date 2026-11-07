import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChangeBranchDto } from './change-branch.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(ChangeBranchDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('ChangeBranchDto', () => {
  it('accepts a branch id', async () => {
    await expect(
      failedFields({ cornerId: '0b9a1f3e-5c2d-4e8f-9a7b-1c2d3e4f5a6b' }),
    ).resolves.toEqual([]);
  });

  it('accepts null: off their branch', async () => {
    await expect(failedFields({ cornerId: null })).resolves.toEqual([]);
  });

  it('requires the field: leaving it out is not the same as null', async () => {
    await expect(failedFields({})).resolves.toEqual(['cornerId']);
  });

  it('rejects something that is not a uuid', async () => {
    await expect(failedFields({ cornerId: 'branch-a' })).resolves.toEqual([
      'cornerId',
    ]);
  });
});
