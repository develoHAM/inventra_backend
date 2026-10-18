import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EmailVerificationController } from './email-verification.controller';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { StartEmailVerificationDto } from './dto/start-email-verification.dto';
import { ConfirmEmailVerificationDto } from './dto/confirm-email-verification.dto';
import { normalizeEmail } from './email';
import { notificationTemplates } from '../notifications/notification-templates';

describe('EmailVerificationController', () => {
  let controller: EmailVerificationController;
  let emailVerification: { start: jest.Mock; confirm: jest.Mock };

  const metadata = (key: string, method: keyof EmailVerificationController) =>
    Reflect.getMetadata(key, EmailVerificationController.prototype[method]);

  beforeEach(() => {
    emailVerification = {
      start: jest.fn().mockResolvedValue({ expiresInSeconds: 600 }),
      confirm: jest.fn().mockResolvedValue({
        emailVerificationToken: 'token',
        expiresInSeconds: 600,
      }),
    };
    controller = new EmailVerificationController(emailVerification as any);
  });

  it.each(['start', 'confirm'] as const)(
    '%s is public (no account yet during signup) and answers 200',
    (method) => {
      expect(metadata(IS_PUBLIC_KEY, method)).toBe(true);
      expect(metadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.OK);
    },
  );

  it('passes the address and code through', async () => {
    await controller.start({ email: 'new@example.com' });
    await controller.confirm({ email: 'new@example.com', code: '482913' });

    expect(emailVerification.start).toHaveBeenCalledWith('new@example.com');
    expect(emailVerification.confirm).toHaveBeenCalledWith(
      'new@example.com',
      '482913',
    );
  });
});

describe('email verification DTOs', () => {
  async function failedFields(
    dtoClass: new () => object,
    body: Record<string, unknown>,
  ) {
    const instance = plainToInstance(dtoClass, body);
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return {
      instance: instance as { email?: string },
      fields: errors.map((error) => error.property),
    };
  }

  it('normalizes the address (trim + lowercase) before validating', async () => {
    const { instance, fields } = await failedFields(StartEmailVerificationDto, {
      email: '  New@Example.COM ',
    });

    expect(fields).toEqual([]);
    expect(instance.email).toBe('new@example.com');
  });

  it.each([
    ['not an email', 'not-an-email'],
    ['missing', undefined],
    ['a number', 12345],
  ])('rejects an address that is %s', async (_label, email) => {
    const { fields } = await failedFields(StartEmailVerificationDto, {
      email: email,
    });

    expect(fields).toEqual(['email']);
  });

  it.each([
    ['5 digits', '48291'],
    ['letters', '48291a'],
    ['7 digits', '4829130'],
  ])('confirm rejects a code that is %s', async (_label, code) => {
    const { fields } = await failedFields(ConfirmEmailVerificationDto, {
      email: 'new@example.com',
      code: code,
    });

    expect(fields).toEqual(['code']);
  });

  it('normalizeEmail passes non-strings through for the validator to reject', () => {
    expect(normalizeEmail(42)).toBe(42);
    expect(normalizeEmail(undefined)).toBeUndefined();
  });

  it('the code template names the code; the placeholder version does not', () => {
    const real = notificationTemplates.emailVerificationCode('482913');
    const placeholder = notificationTemplates.emailVerificationCode('******');

    expect(real.subject).toBe('[Inventra] 이메일 인증번호');
    expect(real.body).toContain('482913');
    expect(placeholder.body).not.toContain('482913');
    expect(placeholder.body).toContain('******');
  });
});
