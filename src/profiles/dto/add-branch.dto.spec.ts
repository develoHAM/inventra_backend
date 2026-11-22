import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AddBranchDto } from './add-branch.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(AddBranchDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('AddBranchDto', () => {
  it('accepts a branch id', async () => {
    await expect(
      failedFields({ cornerId: '0b9a1f3e-5c2d-4e8f-9a7b-1c2d3e4f5a6b' }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['left out', {}],
    ['null: "no branch" is DELETE, not an add', { cornerId: null }],
    ['not a uuid', { cornerId: 'branch-a' }],
  ])('rejects a cornerId %s', async (_label, body) => {
    await expect(failedFields(body)).resolves.toEqual(['cornerId']);
  });
});
