import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { CreateCompanyDto } from './create-company.dto';

// What the global ValidationPipe does: build, then validate with the same
// whitelist options.
async function check(body: Record<string, unknown>) {
  const instance = plainToInstance(CreateCompanyDto, body);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return flatten(errors);
}

function flatten(errors: ValidationError[]): string[] {
  return errors.flatMap((error) =>
    Object.values(error.constraints ?? {}).map(
      (message) => `${error.property}: ${message}`,
    ),
  );
}

describe('CreateCompanyDto', () => {
  const valid = {
    companyName: 'New Co',
    taxId: '123-45-67890',
    ownerName: 'Owner Kim',
  };

  it('accepts a company name, a tax ID and the owner’s name', async () => {
    await expect(check(valid)).resolves.toEqual([]);
  });

  describe.each(['companyName', 'taxId', 'ownerName'])('%s', (field) => {
    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not text', 42],
    ])('is refused when %s', async (_label, value) => {
      const messages = await check({ ...valid, [field]: value });

      expect(messages.some((message) => message.startsWith(`${field}:`))).toBe(
        true,
      );
    });
  });

  it.each([
    ['companyName', 100],
    ['taxId', 20],
    ['ownerName', 100],
  ])(
    '%s may be at most %i characters (the column size), so a long one is a 400, not a database error',
    async (field, limit) => {
      await expect(
        check({ ...valid, [field]: 'a'.repeat(limit) }),
      ).resolves.toEqual([]);
      await expect(
        check({ ...valid, [field]: 'a'.repeat(limit + 1) }),
      ).resolves.toEqual([
        `${field}: ${field} must be shorter than or equal to ${limit} characters`,
      ]);
    },
  );

  it.each([
    ['ownerPhone', { ownerPhone: '01012345678' }],
    ['credentials', { credentials: { type: 'password' } }],
  ])(
    'refuses %s: the signed-in account already has its phone and login',
    async (field, extra) => {
      await expect(check({ ...valid, ...extra })).resolves.toEqual([
        `${field}: property ${field} should not exist`,
      ]);
    },
  );
});
