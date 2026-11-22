import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LeaveCompanyDto } from './leave-company.dto';

async function failedFields(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(LeaveCompanyDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((error) => error.property);
}

describe('LeaveCompanyDto', () => {
  it('an empty body is fine: the system picks a successor if one is needed', async () => {
    await expect(failedFields({})).resolves.toEqual([]);
  });

  it('accepts a successor profile id', async () => {
    await expect(
      failedFields({
        ownerSuccessorProfileId: '0b9a1f3e-5c2d-4e8f-9a7b-1c2d3e4f5a6b',
      }),
    ).resolves.toEqual([]);
  });

  it('accepts null: JSON clients send it for "nobody chosen" (the service treats it as left out)', async () => {
    await expect(
      failedFields({ ownerSuccessorProfileId: null }),
    ).resolves.toEqual([]);
  });

  it('rejects a successor id that is not a uuid', async () => {
    await expect(
      failedFields({ ownerSuccessorProfileId: 'lee' }),
    ).resolves.toEqual(['ownerSuccessorProfileId']);
  });

  it('rejects any other field', async () => {
    await expect(failedFields({ reason: 'bored' })).resolves.toEqual([
      'reason',
    ]);
  });
});
