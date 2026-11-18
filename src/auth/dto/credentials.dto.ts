// @Type reads decorator metadata: load the polyfill even when Nest isn't
// running (unit tests importing only DTOs). Idempotent if already loaded.
import 'reflect-metadata';
import { Transform, Type } from 'class-transformer';
import type { TypeHelpOptions } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeEmail } from '../../common/email';

/** The tag may arrive in any case ('Social'); it is kept lowercase. */
const LowercaseTag = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );

/** Sign up with an email + password (a `local` login). */
export class PasswordCredentialsDto {
  // the tag needs a decorator too, or forbidNonWhitelisted rejects it
  @LowercaseTag()
  @Equals('password')
  type!: 'password';

  // stored lowercase: emails are case-insensitive
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

/** POST /auth/signup: a social identity, vouched for by POST /auth/social/login (SIGNUP_REQUIRED). */
export class SocialSignupCredentialsDto {
  @LowercaseTag()
  @Equals('social')
  type!: 'social';

  // the SIGNUP_REQUIRED response's signupToken
  @IsString()
  @IsNotEmpty()
  signupToken!: string;
}

/** POST /auth/signup: a password, or a social identity. */
export type AccountSignupCredentials =
  PasswordCredentialsDto | SocialSignupCredentialsDto;

/**
 * Builds the right class from `credentials.type`, ignoring case, so each
 * variant is validated (and whitelisted) on its own. Unknown, missing or
 * non-string → the password class, whose @Equals('password') refuses it.
 *
 * A type function, not the `discriminator` option: the discriminator
 * matches exactly and reads the raw JSON before any @Transform runs, so it
 * would never see 'Social' as 'social'.
 */
export const SignupCredentialsType = () =>
  Type((options?: TypeHelpOptions) => {
    const credentials = options?.object[options.property] as
      { type?: unknown } | null | undefined;
    const tag = credentials?.type;
    return typeof tag === 'string' && tag.toLowerCase() === 'social'
      ? SocialSignupCredentialsDto
      : PasswordCredentialsDto;
  });
