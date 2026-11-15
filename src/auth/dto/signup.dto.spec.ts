import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { SignupDto } from './signup.dto';
import {
  PasswordCredentialsDto,
  SocialSignupCredentialsDto,
} from './credentials.dto';

// What the global ValidationPipe does: build the DTO (running @Type and
// @Transform), then validate with the same whitelist options.
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

describe('SignupDto', () => {
  const base = {
    phone: '01012345678',
    phoneVerificationToken: 'phone-token',
  };
  const password = {
    type: 'password',
    email: 'sam@acme.com',
    password: 'password123',
  };
  const social = { type: 'social', signupToken: 'signup-token' };

  it('accepts a password signup: phone, phone token, credentials — no name, no company', async () => {
    const { instance, messages } = await check({
      ...base,
      credentials: password,
    });

    expect(messages).toEqual([]);
    expect(instance.credentials).toBeInstanceOf(PasswordCredentialsDto);
  });

  it('accepts a social signup: just the signup token', async () => {
    const { instance, messages } = await check({
      ...base,
      credentials: social,
    });

    expect(messages).toEqual([]);
    expect(instance.credentials).toBeInstanceOf(SocialSignupCredentialsDto);
    expect(instance.credentials.type).toBe('social');
  });

  it.each([
    ['contactEmail', { contactEmail: 'me@acme.com' }],
    ['emailVerificationToken', { emailVerificationToken: 'email-token' }],
  ])(
    'refuses %s on social credentials: a contact email belongs to a company profile, and signup makes none',
    async (field, extra) => {
      const { messages } = await check({
        ...base,
        credentials: { ...social, ...extra },
      });

      expect(messages).toEqual([
        `credentials.${field}: property ${field} should not exist`,
      ]);
    },
  );

  describe('the tag is case-insensitive', () => {
    it.each(['Social', 'SOCIAL', 'sOcIaL'])(
      '"%s" builds the social class and is stored as "social"',
      async (tag) => {
        const { instance, messages } = await check({
          ...base,
          credentials: { ...social, type: tag },
        });

        expect(messages).toEqual([]);
        expect(instance.credentials).toBeInstanceOf(SocialSignupCredentialsDto);
        expect(instance.credentials.type).toBe('social');
      },
    );

    it('"Password" builds the password class and is stored as "password"', async () => {
      const { instance, messages } = await check({
        ...base,
        credentials: { ...password, type: 'Password' },
      });

      expect(messages).toEqual([]);
      expect(instance.credentials).toBeInstanceOf(PasswordCredentialsDto);
      expect(instance.credentials.type).toBe('password');
    });

    it.each([
      ['a typo', 'socail'],
      ['a number', 42],
      ['missing', undefined],
    ])(
      'a tag that is %s still falls back to the password class and is refused',
      async (_label, tag) => {
        const { instance, messages } = await check({
          ...base,
          credentials: { ...social, type: tag },
        });

        expect(instance.credentials).toBeInstanceOf(PasswordCredentialsDto);
        expect(messages).toContain(
          'credentials.type: type must be equal to password',
        );
      },
    );
  });

  it('normalizes the phone like every signup (dashes and spaces stripped)', async () => {
    const { instance, messages } = await check({
      ...base,
      phone: '010-1234 5678',
      credentials: password,
    });

    expect(messages).toEqual([]);
    expect(instance.phone).toBe('01012345678');
  });

  it('refuses a phone that is not a Korean mobile number', async () => {
    const { messages } = await check({
      ...base,
      phone: '0212345678',
      credentials: password,
    });

    expect(messages).toEqual([
      'phone: phone must be a Korean mobile number starting with 010',
    ]);
  });

  it.each(['phone', 'phoneVerificationToken', 'credentials'])(
    'requires %s',
    async (field) => {
      const body: Record<string, unknown> = { ...base, credentials: password };
      delete body[field];

      const { messages } = await check(body);

      expect(messages.some((message) => message.startsWith(field))).toBe(true);
    },
  );

  it.each([
    ['name', { name: 'Sam' }],
    ['joinCode', { joinCode: '48291307' }],
  ])(
    'refuses %s: signup creates no profile and joins no company',
    async (field, extra) => {
      const { messages } = await check({
        ...base,
        ...extra,
        credentials: password,
      });

      expect(messages).toEqual([
        `${field}: property ${field} should not exist`,
      ]);
    },
  );
});
