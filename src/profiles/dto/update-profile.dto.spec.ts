import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { UpdateProfileDto } from './update-profile.dto';

// What the global ValidationPipe does: build, then validate with the same
// whitelist options.
async function check(body: Record<string, unknown>) {
  const errors = await validate(plainToInstance(UpdateProfileDto, body), {
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

describe('UpdateProfileDto', () => {
  it('accepts a name', async () => {
    await expect(check({ name: 'Lee Ji-eun' })).resolves.toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not text', 42],
  ])('refuses a name that is %s', async (_label, name) => {
    const messages = await check({ name: name });

    expect(messages.some((message) => message.startsWith('name:'))).toBe(true);
  });

  it('allows 100 characters (the column size), refuses 101', async () => {
    await expect(check({ name: 'a'.repeat(100) })).resolves.toEqual([]);
    await expect(check({ name: 'a'.repeat(101) })).resolves.toEqual([
      'name: name must be shorter than or equal to 100 characters',
    ]);
  });

  it.each([
    [
      'contactEmail',
      'it needs a proof: PUT /profiles/me/contact-email',
      { contactEmail: 'lee@acme.com' },
    ],
    ['roleId', 'a profile cannot promote itself', { roleId: 1 }],
    ['status', 'a profile cannot approve itself', { status: 'ACTIVE' }],
  ])('refuses %s: %s', async (field, _reason, extra) => {
    await expect(check({ name: 'Lee', ...extra })).resolves.toEqual([
      `${field}: property ${field} should not exist`,
    ]);
  });
});
