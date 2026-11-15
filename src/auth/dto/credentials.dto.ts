// @Type reads decorator metadata: load the polyfill even when Nest isn't
// running (unit tests importing only DTOs). Idempotent if already loaded.
import 'reflect-metadata';
import { Transform, Type } from 'class-transformer';
import type { TypeHelpOptions } from 'class-transformer';
import {
  Equals,
  IsEmail,
  IsNotEmpty,
  IsOptional,
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

/**
 * register / register/member: a social identity vouched for by
 * POST /auth/social/login (SIGNUP_REQUIRED), plus an optional typed
 * contact email for the profile they create.
 */
export class SocialCredentialsDto {
  @LowercaseTag()
  @Equals('social')
  type!: 'social';

  // the SIGNUP_REQUIRED response's signupToken
  @IsString()
  @IsNotEmpty()
  signupToken!: string;

  // a typed address for notifications (required when the provider shared no
  // verified email; otherwise it overrides the provider email)…
  @IsOptional()
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  contactEmail?: string;

  // …always with its proof from POST /auth/email/confirm (both or neither)
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  emailVerificationToken?: string;
}

/**
 * POST /auth/signup: a social identity and nothing else. A contact email
 * belongs to a company profile, and signup makes none.
 */
export class SocialSignupCredentialsDto {
  @LowercaseTag()
  @Equals('social')
  type!: 'social';

  // the SIGNUP_REQUIRED response's signupToken
  @IsString()
  @IsNotEmpty()
  signupToken!: string;
}

/** register and register/member (until Task 7). */
export type SignupCredentials = PasswordCredentialsDto | SocialCredentialsDto;

/** POST /auth/signup. */
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
function credentialsTypeFor(socialClass: new () => SocialSignupCredentialsDto) {
  return () =>
    Type((options?: TypeHelpOptions) => {
      const credentials = options?.object[options.property] as
        { type?: unknown } | null | undefined;
      const tag = credentials?.type;
      return typeof tag === 'string' && tag.toLowerCase() === 'social'
        ? socialClass
        : PasswordCredentialsDto;
    });
}

/** register and register/member: the social variant may carry a contact email. */
export const CredentialsType = credentialsTypeFor(SocialCredentialsDto);

/** POST /auth/signup: the social variant is only the ticket. */
export const SignupCredentialsType = credentialsTypeFor(
  SocialSignupCredentialsDto,
);
