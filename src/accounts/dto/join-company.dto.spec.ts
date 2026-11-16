import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { JoinCompanyDto } from './join-company.dto';

// What the global ValidationPipe does: build (running @Transform), then
// validate with the same whitelist options.
async function check(body: Record<string, unknown>) {
  const instance = plainToInstance(JoinCompanyDto, body);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance: instance, messages: flatten(errors) };
}

function flatten(errors: ValidationError[]): string[] {
  return errors.flatMap((error) =>
    Object.values(error.constraints ?? {}).map(
      (message) => `${error.property}: ${message}`,
    ),
  );
}

describe('JoinCompanyDto', () => {
  const valid = { joinCode: '48291307', name: 'Sam' };

  it('accepts an 8-digit code and a name', async () => {
    const { messages } = await check(valid);

    expect(messages).toEqual([]);
  });

  it.each(['4829-1307', '4829 1307'])(
    'normalizes "%s" to 8 digits, like signup does',
    async (typed) => {
      const { instance, messages } = await check({ ...valid, joinCode: typed });

      expect(messages).toEqual([]);
      expect(instance.joinCode).toBe('48291307');
    },
  );

  it.each([
    ['7 digits', '4829130'],
    ['9 digits', '482913070'],
    ['letters', '4829130a'],
    ['a number, not text', 48291307],
    ['missing', undefined],
  ])('refuses a code that is %s', async (_label, joinCode) => {
    const { messages } = await check({ ...valid, joinCode: joinCode });

    expect(messages).toEqual(['joinCode: joinCode must be 8 digits']);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not text', 42],
  ])('refuses a name that is %s', async (_label, name) => {
    const { messages } = await check({ ...valid, name: name });

    expect(messages.some((message) => message.startsWith('name:'))).toBe(true);
  });

  it('refuses a name longer than 100 characters (the column size), allows exactly 100', async () => {
    expect((await check({ ...valid, name: 'a'.repeat(100) })).messages).toEqual(
      [],
    );
    expect((await check({ ...valid, name: 'a'.repeat(101) })).messages).toEqual(
      ['name: name must be shorter than or equal to 100 characters'],
    );
  });

  it.each([
    ['companyId', { companyId: 'company-1' }],
    ['roleId', { roleId: 2 }],
  ])(
    'refuses %s: the code picks the company, and the approver picks the role',
    async (field, extra) => {
      const { messages } = await check({ ...valid, ...extra });

      expect(messages).toEqual([
        `${field}: property ${field} should not exist`,
      ]);
    },
  );
});
