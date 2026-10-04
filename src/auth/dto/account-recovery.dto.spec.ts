import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FindIdDto } from './find-id.dto';
import { ResetPasswordDto } from './reset-password.dto';

// What the global ValidationPipe does: build the DTO (running @Transform),
// then validate. Returns the instance and the names of failed properties.
async function check<T extends object>(
  dtoClass: new () => T,
  body: Record<string, unknown>,
) {
  const instance = plainToInstance(dtoClass, body);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return {
    instance: instance,
    failedFields: errors.map((error) => error.property),
  };
}

describe('FindIdDto', () => {
  it('normalizes the phone', async () => {
    const { instance, failedFields } = await check(FindIdDto, {
      phone: '010-1234-5678',
      phoneVerificationToken: 'find-token',
    });

    expect(failedFields).toEqual([]);
    expect(instance.phone).toBe('01012345678');
  });

  it('requires the token', async () => {
    const { failedFields } = await check(FindIdDto, { phone: '01012345678' });

    expect(failedFields).toEqual(['phoneVerificationToken']);
  });
});

describe('ResetPasswordDto', () => {
  const validBody = {
    email: 'owner@example.com',
    phone: '010 1234 5678',
    phoneVerificationToken: 'reset-token',
    newPassword: 'brand-new-password',
  };

  it('accepts a valid body and normalizes the phone', async () => {
    const { instance, failedFields } = await check(ResetPasswordDto, validBody);

    expect(failedFields).toEqual([]);
    expect(instance.phone).toBe('01012345678');
  });

  it.each(['email', 'phone', 'phoneVerificationToken', 'newPassword'] as const)(
    'requires %s',
    async (field) => {
      const { [field]: _omitted, ...body } = validBody;

      const { failedFields } = await check(ResetPasswordDto, body);

      expect(failedFields).toEqual([field]);
    },
  );

  it.each([
    ['too short (7)', 'short12'],
    ['too long (129)', 'x'.repeat(129)],
  ])(
    'rejects a new password that is %s — same rule as signup',
    async (_label, newPassword) => {
      const { failedFields } = await check(ResetPasswordDto, {
        ...validBody,
        newPassword: newPassword,
      });

      expect(failedFields).toEqual(['newPassword']);
    },
  );

  it('rejects a malformed email', async () => {
    const { failedFields } = await check(ResetPasswordDto, {
      ...validBody,
      email: 'not-an-email',
    });

    expect(failedFields).toEqual(['email']);
  });
});
