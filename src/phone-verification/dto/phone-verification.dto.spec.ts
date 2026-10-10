import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StartVerificationDto } from './start-verification.dto';
import { ConfirmVerificationDto } from './confirm-verification.dto';
import { RegisterDto } from '../../auth/dto/register.dto';
import { RegisterMemberDto } from '../../auth/dto/register-member.dto';

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

describe('RegisterDto (phone fields)', () => {
  const validBody = {
    companyName: 'Acme',
    taxId: '123-45-67890',
    ownerName: 'Jane Owner',
    credentials: {
      type: 'password',
      email: 'jane@acme.com',
      password: 'password123',
    },
    ownerPhone: '010-1234-5678',
    ownerPhoneVerificationToken: 'some-token',
  };

  it('normalizes the owner phone', async () => {
    const { instance, failedFields } = await check(RegisterDto, validBody);

    expect(failedFields).toEqual([]);
    expect(instance.ownerPhone).toBe('01012345678');
  });

  it.each(['ownerPhone', 'ownerPhoneVerificationToken'] as const)(
    'requires %s',
    async (field) => {
      const { [field]: _omitted, ...body } = validBody;

      const { failedFields } = await check(RegisterDto, body);

      expect(failedFields).toEqual([field]);
    },
  );

  it('rejects a non-Korean-mobile owner phone', async () => {
    const { failedFields } = await check(RegisterDto, {
      ...validBody,
      ownerPhone: '+82-10-1234-5678',
    });

    expect(failedFields).toEqual(['ownerPhone']);
  });
});

describe('RegisterMemberDto (phone fields)', () => {
  const validBody = {
    joinCode: '48291307',
    credentials: {
      type: 'password',
      email: 'sam@acme.com',
      password: 'password123',
    },
    name: 'Sam Staff',
    phone: '010 9999 8888',
    phoneVerificationToken: 'some-token',
  };

  it('normalizes the member phone', async () => {
    const { instance, failedFields } = await check(
      RegisterMemberDto,
      validBody,
    );

    expect(failedFields).toEqual([]);
    expect(instance.phone).toBe('01099998888');
  });

  it.each([
    ['4829 1307', '48291307'],
    ['4829-1307', '48291307'],
  ])('normalizes a typed join code %p', async (typed, stored) => {
    const { instance, failedFields } = await check(RegisterMemberDto, {
      ...validBody,
      joinCode: typed,
    });

    expect(failedFields).toEqual([]);
    expect(instance.joinCode).toBe(stored);
  });

  it.each([
    ['7 digits', '4829130'],
    ['the old INV- format', 'INV-3FA91C07B2DE'],
    ['letters', 'ABCD1234'],
  ])('rejects a join code that is %s', async (_label, joinCode) => {
    const { failedFields } = await check(RegisterMemberDto, {
      ...validBody,
      joinCode: joinCode,
    });

    expect(failedFields).toEqual(['joinCode']);
  });

  it.each(['phone', 'phoneVerificationToken'] as const)(
    'requires %s',
    async (field) => {
      const { [field]: _omitted, ...body } = validBody;

      const { failedFields } = await check(RegisterMemberDto, body);

      expect(failedFields).toEqual([field]);
    },
  );
});
