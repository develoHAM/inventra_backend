import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { RegisterDto } from './register.dto';
import { RegisterMemberDto } from './register-member.dto';
import {
  PasswordCredentialsDto,
  SocialCredentialsDto,
} from './credentials.dto';

// What the global ValidationPipe does: build the DTO (running @Type and
// @Transform), then validate with the same whitelist options.
async function check(
  dtoClass: new () => object,
  body: Record<string, unknown>,
) {
  const instance = plainToInstance(dtoClass, body) as {
    credentials: { type?: string };
  };
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

const memberBase = {
  joinCode: '48291307',
  name: 'Sam Staff',
  phone: '01012345678',
  phoneVerificationToken: 'phone-token',
};
const ownerBase = {
  companyName: 'Acme',
  taxId: '123-45-67890',
  ownerName: 'Jane Owner',
  ownerPhone: '01012345678',
  ownerPhoneVerificationToken: 'phone-token',
};
const password = {
  type: 'password',
  email: 'sam@acme.com',
  password: 'password123',
};

describe.each([
  ['RegisterDto', RegisterDto, ownerBase],
  ['RegisterMemberDto', RegisterMemberDto, memberBase],
] as const)('%s credentials', (_name, dtoClass, base) => {
  it('builds a PasswordCredentialsDto from type "password" and keeps the tag', async () => {
    const { instance, messages } = await check(dtoClass, {
      ...base,
      credentials: password,
    });

    expect(messages).toEqual([]);
    expect(instance.credentials).toBeInstanceOf(PasswordCredentialsDto);
    // keepDiscriminatorProperty: the service branches on it
    expect(instance.credentials.type).toBe('password');
  });

  it('builds a SocialCredentialsDto from type "social"', async () => {
    const { instance, messages } = await check(dtoClass, {
      ...base,
      credentials: {
        type: 'social',
        signupToken: 'signup-token',
        contactEmail: 'sam@acme.com',
        emailVerificationToken: 'email-token',
      },
    });

    expect(messages).toEqual([]);
    expect(instance.credentials).toBeInstanceOf(SocialCredentialsDto);
  });

  it('a social body needs only the signup token (contact email is optional)', async () => {
    const { messages } = await check(dtoClass, {
      ...base,
      credentials: { type: 'social', signupToken: 'signup-token' },
    });

    expect(messages).toEqual([]);
  });

  it.each([
    [
      'an unknown type',
      { type: 'naver', email: 'a@b.com', password: 'password123' },
    ],
    ['a missing type', { email: 'a@b.com', password: 'password123' }],
  ])(
    'rejects %s (falls back to the password class, whose tag check fails)',
    async (_label, credentials) => {
      const { messages } = await check(dtoClass, {
        ...base,
        credentials: credentials,
      });

      expect(messages).toContain(
        'credentials.type: type must be equal to password',
      );
    },
  );

  it('rejects mixing shapes: a social field inside a password body', async () => {
    const { messages } = await check(dtoClass, {
      ...base,
      credentials: { ...password, signupToken: 'x' },
    });

    expect(messages).toContain(
      'credentials.signupToken: property signupToken should not exist',
    );
  });

  it('rejects mixing shapes: a password field inside a social body', async () => {
    const { messages } = await check(dtoClass, {
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
    const { messages } = await check(dtoClass, {
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
    const { messages } = await check(dtoClass, {
      ...base,
      credentials: credentials,
    });

    expect(messages).toContain('credentials: credentials must be an object');
  });

  it('rejects the OLD flat fields (the contract changed)', async () => {
    const legacy =
      dtoClass === RegisterDto
        ? { ownerEmail: 'a@b.com', ownerPassword: 'password123' }
        : { email: 'a@b.com', password: 'password123' };

    const { messages } = await check(dtoClass, {
      ...base,
      ...legacy,
      credentials: password,
    });

    expect(
      messages.some((message) => message.includes('should not exist')),
    ).toBe(true);
  });
});
