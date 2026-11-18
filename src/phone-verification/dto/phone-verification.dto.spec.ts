import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StartVerificationDto } from './start-verification.dto';
import { ConfirmVerificationDto } from './confirm-verification.dto';

// What the global ValidationPipe does: turn the JSON body into a DTO
// instance (running @Transform), then validate it. Returns the instance
// and the names of the properties that failed.
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

describe('StartVerificationDto', () => {
  it('normalizes a dashed phone and accepts it', async () => {
    const { instance, failedFields } = await check(StartVerificationDto, {
      phone: '010-1234-5678',
      purpose: 'SIGNUP',
    });

    expect(failedFields).toEqual([]);
    expect(instance.phone).toBe('01012345678');
  });

  it.each([
    ['a landline', '02-123-4567'],
    ['a legacy 011 number', '011-123-4567'],
    ['a number, not a string', 1012345678],
    ['an empty string', ''],
  ])('rejects %s', async (_label, phone) => {
    const { failedFields } = await check(StartVerificationDto, {
      phone: phone,
      purpose: 'SIGNUP',
    });

    expect(failedFields).toEqual(['phone']);
  });

  it.each(['SIGNUP', 'FIND_ID', 'RESET_PASSWORD'])(
    'accepts purpose %s',
    async (purpose) => {
      const { failedFields } = await check(StartVerificationDto, {
        phone: '01012345678',
        purpose: purpose,
      });

      expect(failedFields).toEqual([]);
    },
  );

  it('rejects an unknown purpose', async () => {
    const { failedFields } = await check(StartVerificationDto, {
      phone: '01012345678',
      purpose: 'LOGIN',
    });

    expect(failedFields).toEqual(['purpose']);
  });
});

describe('ConfirmVerificationDto', () => {
  it('accepts a UUID', async () => {
    const { failedFields } = await check(ConfirmVerificationDto, {
      verificationId: '3f1c2a9e-5b7d-4e8f-9a0b-1c2d3e4f5a6b',
    });

    expect(failedFields).toEqual([]);
  });

  it.each([
    ['not a UUID', 'abc'],
    ['missing', undefined],
  ])('rejects a verificationId that is %s', async (_label, verificationId) => {
    const { failedFields } = await check(ConfirmVerificationDto, {
      verificationId: verificationId,
    });

    expect(failedFields).toEqual(['verificationId']);
  });
});
