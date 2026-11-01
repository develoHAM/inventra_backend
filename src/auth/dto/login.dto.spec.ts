import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LoginDto } from './login.dto';

describe('LoginDto', () => {
  async function check(body: Record<string, unknown>) {
    const instance = plainToInstance(LoginDto, body);
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return {
      instance: instance,
      failedFields: errors.map((error) => error.property),
    };
  }

  it('lowercases the email: Jane@Acme.com finds the account stored as jane@acme.com', async () => {
    const { instance, failedFields } = await check({
      email: '  Jane@Acme.COM ',
      password: 'password123',
    });

    expect(failedFields).toEqual([]);
    expect(instance.email).toBe('jane@acme.com');
  });

  it.each([
    ['not an email', { email: 'jane', password: 'password123' }, 'email'],
    ['no password', { email: 'jane@acme.com' }, 'password'],
  ])('rejects %s', async (_label, body, field) => {
    const { failedFields } = await check(body);

    expect(failedFields).toEqual([field]);
  });
});
