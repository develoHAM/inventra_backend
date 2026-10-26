import { HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SocialAuthController } from './social-auth.controller';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { SocialSignInDto } from './dto/social-sign-in.dto';

describe('SocialAuthController', () => {
  let controller: SocialAuthController;
  let socialAuth: { issueNonce: jest.Mock; signIn: jest.Mock };

  const metadata = (key: string, method: keyof SocialAuthController) =>
    Reflect.getMetadata(key, SocialAuthController.prototype[method]);

  beforeEach(() => {
    socialAuth = {
      issueNonce: jest
        .fn()
        .mockResolvedValue({ nonce: 'n', expiresInSeconds: 300 }),
      signIn: jest.fn().mockResolvedValue({ status: 'SIGNUP_REQUIRED' }),
    };
    controller = new SocialAuthController(socialAuth as any);
  });

  it.each(['issueNonce', 'signIn'] as const)(
    '%s is public (nobody is signed in yet) and answers 200',
    (method) => {
      expect(metadata(IS_PUBLIC_KEY, method)).toBe(true);
      expect(metadata(HTTP_CODE_METADATA, method)).toBe(HttpStatus.OK);
    },
  );

  it('routes: POST /auth/social/nonce and POST /auth/social/login (no path variables)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SocialAuthController)).toBe(
      'auth/social',
    );
    expect(metadata(PATH_METADATA, 'issueNonce')).toBe('nonce');
    expect(metadata(PATH_METADATA, 'signIn')).toBe('login');
  });

  it('passes the body through (the provider travels inside it)', async () => {
    const body = {
      provider: 'kakao' as const,
      credential: { idToken: 't' },
      nonce: 'raw-nonce',
    };

    await controller.signIn(body);
    await controller.issueNonce();

    expect(socialAuth.signIn).toHaveBeenCalledWith(body);
    expect(socialAuth.issueNonce).toHaveBeenCalled();
  });
});

describe('SocialSignInDto', () => {
  async function failedFields(body: Record<string, unknown>) {
    const errors = await validate(plainToInstance(SocialSignInDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return errors.map((error) => error.property);
  }

  it.each(['kakao', 'google', 'facebook', 'apple'])(
    'accepts the provider %s',
    async (provider) => {
      await expect(
        failedFields({ provider: provider, credential: { idToken: 't' } }),
      ).resolves.toEqual([]);
    },
  );

  it.each([
    ['an unknown provider', 'twitter'],
    ['a provider we left out', 'naver'],
    ['the wrong case', 'KAKAO'],
    ['missing', undefined],
  ])('rejects %s', async (_label, provider) => {
    await expect(
      failedFields({ provider: provider, credential: { idToken: 't' } }),
    ).resolves.toEqual(['provider']);
  });

  it('accepts any credential object (its verifier checks the fields) and keeps them', async () => {
    const instance = plainToInstance(SocialSignInDto, {
      provider: 'apple',
      credential: {
        identityToken: 'a',
        authorizationCode: 'b',
        fullName: { givenName: 'K' },
      },
      nonce: 'raw-nonce',
    });
    const errors = await validate(instance, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    expect(errors).toEqual([]);
    expect(instance.credential).toEqual({
      identityToken: 'a',
      authorizationCode: 'b',
      fullName: { givenName: 'K' },
    });
  });

  it('the nonce is optional', async () => {
    await expect(
      failedFields({ provider: 'kakao', credential: { idToken: 't' } }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['a string', 'eyJhbGciOi...'],
    ['an array', ['t']],
  ])('rejects a credential that is %s', async (_label, credential) => {
    await expect(
      failedFields({ provider: 'kakao', credential: credential }),
    ).resolves.toEqual(['credential']);
  });

  it.each([
    ['empty', ''],
    ['a number', 42],
    ['too long', 'n'.repeat(101)],
  ])('rejects a nonce that is %s', async (_label, nonce) => {
    await expect(
      failedFields({
        provider: 'kakao',
        credential: { idToken: 't' },
        nonce: nonce,
      }),
    ).resolves.toEqual(['nonce']);
  });

  it('rejects unknown top-level fields', async () => {
    await expect(
      failedFields({
        provider: 'kakao',
        credential: { idToken: 't' },
        email: 'x@y.z',
      }),
    ).resolves.toEqual(['email']);
  });
});
