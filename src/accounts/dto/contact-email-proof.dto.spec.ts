import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { JoinCompanyDto } from './join-company.dto';
import { CreateCompanyDto } from './create-company.dto';

// What the global ValidationPipe does: build (running @Transform), then
// validate with the same whitelist options.
async function check(
  dtoClass: new () => object,
  body: Record<string, unknown>,
) {
  const instance = plainToInstance(dtoClass, body) as {
    contactEmail?: string;
  };
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

// The optional proven contact email both DTOs inherit from
// ContactEmailProofDto: tested through the real subclasses, so the
// inherited rules (and the whitelist) are what actually runs.
describe.each([
  ['JoinCompanyDto', JoinCompanyDto, { joinCode: '48291307', name: 'Sam' }],
  [
    'CreateCompanyDto',
    CreateCompanyDto,
    { companyName: 'New Co', taxId: '123-45-67890', ownerName: 'Owner Kim' },
  ],
] as const)(
  '%s: the optional proven contact email',
  (_name, dtoClass, base) => {
    const proof = {
      contactEmail: 'sam@acme.com',
      emailVerificationToken: 'email-token',
    };

    it('neither field → valid (the email can be set later, or never)', async () => {
      const { messages } = await check(dtoClass, base);

      expect(messages).toEqual([]);
    });

    it('both fields → valid: inherited, so the whitelist allows them', async () => {
      const { messages } = await check(dtoClass, { ...base, ...proof });

      expect(messages).toEqual([]);
    });

    it('the email is stored trimmed and lowercased (the inherited @Transform runs)', async () => {
      const { instance, messages } = await check(dtoClass, {
        ...base,
        ...proof,
        contactEmail: '  Sam@Acme.COM ',
      });

      expect(messages).toEqual([]);
      expect(instance.contactEmail).toBe('sam@acme.com');
    });

    it('only the email → 400 naming the missing proof (both or neither)', async () => {
      const { messages } = await check(dtoClass, {
        ...base,
        contactEmail: 'sam@acme.com',
      });

      expect(messages).toEqual(
        expect.arrayContaining([
          'emailVerificationToken: emailVerificationToken should not be empty',
        ]),
      );
      expect(messages.every((message) => message.startsWith('email'))).toBe(
        true,
      );
    });

    it('only the proof → 400 naming the missing email (both or neither)', async () => {
      const { messages } = await check(dtoClass, {
        ...base,
        emailVerificationToken: 'email-token',
      });

      expect(messages).toEqual(['contactEmail: contactEmail must be an email']);
    });

    it('a malformed email with its proof → 400', async () => {
      const { messages } = await check(dtoClass, {
        ...base,
        ...proof,
        contactEmail: 'sam-at-acme',
      });

      expect(messages).toEqual(['contactEmail: contactEmail must be an email']);
    });

    it('an empty proof → 400', async () => {
      const { messages } = await check(dtoClass, {
        ...base,
        ...proof,
        emailVerificationToken: '',
      });

      expect(messages).toEqual([
        'emailVerificationToken: emailVerificationToken should not be empty',
      ]);
    });
  },
);
