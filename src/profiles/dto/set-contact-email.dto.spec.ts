import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { SetContactEmailDto } from './set-contact-email.dto';

// What the global ValidationPipe does: build (running @Transform), then
// validate with the same whitelist options.
async function check(body: Record<string, unknown>) {
  const instance = plainToInstance(SetContactEmailDto, body);
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

describe('SetContactEmailDto', () => {
  const valid = {
    email: 'lee@acme.com',
    emailVerificationToken: 'email-token',
  };

  it('accepts an email and its proof', async () => {
    const { messages } = await check(valid);

    expect(messages).toEqual([]);
  });

  it('stores emails trimmed and lowercased, like everywhere else', async () => {
    const { instance, messages } = await check({
      ...valid,
      email: '  Lee@Acme.COM ',
    });

    expect(messages).toEqual([]);
    expect(instance.email).toBe('lee@acme.com');
  });

  it.each([
    ['not an email', 'lee-at-acme'],
    ['not text', 42],
    ['missing', undefined],
  ])('refuses an email that is %s', async (_label, email) => {
    const { messages } = await check({ ...valid, email: email });

    expect(messages.some((message) => message.startsWith('email:'))).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
  ])(
    'refuses a proof that is %s: the address must be proven',
    async (_label, token) => {
      const { messages } = await check({
        ...valid,
        emailVerificationToken: token,
      });

      expect(
        messages.some((message) =>
          message.startsWith('emailVerificationToken:'),
        ),
      ).toBe(true);
    },
  );

  it('refuses other fields (the name has its own route)', async () => {
    const { messages } = await check({ ...valid, name: 'Lee' });

    expect(messages).toEqual(['name: property name should not exist']);
  });
});
