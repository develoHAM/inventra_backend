// @Type reads decorator metadata: load the polyfill even when Nest isn't
// running (unit tests importing only DTOs). Idempotent if already loaded.
import 'reflect-metadata';
import { Type } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Sign up with an email + password (a `local` login). */
export class PasswordCredentialsDto {
  // the tag needs a decorator too, or forbidNonWhitelisted rejects it
  @Equals('password')
  type!: 'password';

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

/** Sign up with a social identity vouched for by POST /auth/social/:provider. */
export class SocialCredentialsDto {
  @Equals('social')
  type!: 'social';

  // the SIGNUP_REQUIRED response's signupToken
  @IsString()
  @IsNotEmpty()
  signupToken!: string;

  // only when the provider shared no verified email: a typed address…
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  // …proven by POST /auth/email/confirm
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  emailVerificationToken?: string;
}

export type SignupCredentials = PasswordCredentialsDto | SocialCredentialsDto;

/**
 * Builds the right class from `credentials.type`, so each variant is
 * validated (and whitelisted) on its own. Unknown or missing `type` → 400.
 */
export const CredentialsType = () =>
  Type(() => PasswordCredentialsDto, {
    discriminator: {
      property: 'type',
      subTypes: [
        { value: PasswordCredentialsDto, name: 'password' },
        { value: SocialCredentialsDto, name: 'social' },
      ],
    },
    keepDiscriminatorProperty: true,
  });
