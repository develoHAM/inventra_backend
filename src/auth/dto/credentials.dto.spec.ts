import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { SignupDto } from './signup.dto';
import {
  PasswordCredentialsDto,
  SocialSignupCredentialsDto,
} from './credentials.dto';

// The credentials rules, seen through the one DTO that carries them
// (POST /auth/signup). What the global ValidationPipe does: build the DTO
// (running @Type and @Transform), then validate with the same options.
async function check(body: Record<string, unknown>) {
  const instance = plainToInstance(SignupDto, body);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { instance: instance, messages: flatten(errors) };
}

// "credentials.type: type must be equal to password", one per failure
function flatten(errors: ValidationError[], parent = ''): string[] {
  return errors.flatMap((error) => {
    const path = parent ? `${parent}.${error.property}` : error.property;
    return [
      ...Object.values(error.constraints ?? {}).map(
        (message) => `${path}: ${message}`,
      ),
      ...flatten(error.children ?? [], path),
    ];
  });
}

const base = { phone: '01012345678', phoneVerificationToken: 'phone-token' };
const password = {
  type: 'password',
  email: 'sam@acme.com',
  password: 'password123',
};

describe('signup credentials', () => {
  it('builds a PasswordCredentialsDto from type "password" and keeps the tag', async () => {
    const { instance, messages } = await check({
      ...base,
      credentials: password,
    });

    expect(messages).toEqual([]);
    expect(instance.credentials).toBeInstanceOf(PasswordCredentialsDto);
    // the tag stays on the built object: the service branches on it
    expect(instance.credentials.type).toBe('password');
  });

  it('builds a SocialSignupCredentialsDto from type "social": just the ticket', async () => {
    const { instance, messages } = await check({
      ...base,
      credentials: { type: 'social', signupToken: 'signup-token' },
    });

    expect(messages).toEqual([]);
    expect(instance.credentials).toBeInstanceOf(SocialSignupCredentialsDto);
  });

  it.each([
    ['Social', SocialSignupCredentialsDto, 'social'],
    ['PASSWORD', PasswordCredentialsDto, 'password'],
  ] as const)(
    'the tag is case-insensitive: "%s" builds the right class, stored lowercase',
    async (tag, expectedClass, stored) => {
      const body =
        stored === 'social'
          ? { type: tag, signupToken: 'signup-token' }
          : { ...password, type: tag };

      const { instance, messages } = await check({
        ...base,
        credentials: body,
      });

      expect(messages).toEqual([]);
      expect(instance.credentials).toBeInstanceOf(expectedClass);
      expect(instance.credentials.type).toBe(stored);
    },
  );

  it.each([
    [
      'an unknown type',
      { type: 'naver', email: 'a@b.com', password: 'password123' },
    ],
    ['a missing type', { email: 'a@b.com', password: 'password123' }],
    [
      'a type that is not a string',
      { type: 42, email: 'a@b.com', password: 'password123' },
    ],
  ])(
    'rejects %s (falls back to the password class, whose tag check fails)',
    async (_label, credentials) => {
      const { messages } = await check({ ...base, credentials: credentials });

      expect(messages).toContain(
        'credentials.type: type must be equal to password',
      );
    },
  );

  it('rejects mixing shapes: a social field inside a password body', async () => {
    const { messages } = await check({
      ...base,
      credentials: { ...password, signupToken: 'x' },
    });

    expect(messages).toContain(
      'credentials.signupToken: property signupToken should not exist',
    );
  });

  it('rejects mixing shapes: a password field inside a social body', async () => {
    const { messages } = await check({
      ...base,
      credentials: {
        type: 'social',
        signupToken: 'x',
        password: 'password123',
      },
    });

    expect(messages).toContain(
      'credentials.password: property password should not exist',
    );
  });

  it('still validates the password variant itself (min length, email format)', async () => {
    const { messages } = await check({
      ...base,
      credentials: {
        type: 'password',
        email: 'not-an-email',
        password: 'short',
      },
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        'credentials.email: email must be an email',
        'credentials.password: password must be longer than or equal to 8 characters',
      ]),
    );
  });

  it.each([
    ['missing', undefined],
    ['not an object', 'oops'],
  ])('rejects credentials that are %s', async (_label, credentials) => {
    const { messages } = await check({ ...base, credentials: credentials });

    expect(messages).toContain('credentials: credentials must be an object');
  });

  it('a password signup email is trimmed and lowercased (emails are case-insensitive)', async () => {
    const { instance, messages } = await check({
      ...base,
      credentials: { ...password, email: '  Sam@Acme.COM ' },
    });

    expect(messages).toEqual([]);
    expect((instance.credentials as PasswordCredentialsDto).email).toBe(
      'sam@acme.com',
    );
  });
});
