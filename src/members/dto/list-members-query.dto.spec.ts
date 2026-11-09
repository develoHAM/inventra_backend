import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListMembersQueryDto } from './list-members-query.dto';

async function failedFields(query: Record<string, unknown>) {
  const errors = await validate(plainToInstance(ListMembersQueryDto, query), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('ListMembersQueryDto', () => {
  const BRANCH_ID = '0b9a1f3e-5c2d-4e8f-9a7b-1c2d3e4f5a6b';

  it('accepts no filters at all', async () => {
    await expect(failedFields({})).resolves.toEqual([]);
  });

  it('accepts every filter together', async () => {
    await expect(
      failedFields({
        companyId: BRANCH_ID,
        cornerId: BRANCH_ID,
        role: 'STAFF',
        status: 'ACTIVE',
      }),
    ).resolves.toEqual([]);
  });

  it('accepts the word "none" as a branch filter', async () => {
    await expect(failedFields({ cornerId: 'none' })).resolves.toEqual([]);
  });

  it('rejects a branch filter that is neither a uuid nor "none"', async () => {
    await expect(failedFields({ cornerId: 'branch-a' })).resolves.toEqual([
      'cornerId',
    ]);
  });

  it('rejects a companyId that is not a uuid', async () => {
    await expect(failedFields({ companyId: 'company-1' })).resolves.toEqual([
      'companyId',
    ]);
  });

  it.each(['ADMIN', 'staff', 'BOSS'])('rejects role %s', async (role) => {
    await expect(failedFields({ role: role })).resolves.toEqual(['role']);
  });

  it('accepts PENDING_APPROVAL and rejects an unknown status', async () => {
    await expect(failedFields({ status: 'PENDING_APPROVAL' })).resolves.toEqual(
      [],
    );
    await expect(failedFields({ status: 'ASLEEP' })).resolves.toEqual([
      'status',
    ]);
  });

  it('rejects an unknown parameter', async () => {
    await expect(failedFields({ foo: '1' })).resolves.toEqual(['foo']);
  });
});
