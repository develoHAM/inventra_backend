import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { SignupCredentialsType } from './credentials.dto';
import type { AccountSignupCredentials } from './credentials.dto';
import {
  normalizePhone,
  KOREAN_MOBILE_PATTERN,
} from '../../phone-verification/phone';

/**
 * POST /auth/signup: the sign-in only — a verified phone and the first
 * login method. No name and no company: those belong to a profile, made
 * when joining or creating a company.
 */
export class SignupDto {
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'phone must be a Korean mobile number starting with 010',
  })
  phone!: string;

  // from POST /auth/phone/confirm (purpose SIGNUP)
  @IsString()
  @IsNotEmpty()
  phoneVerificationToken!: string;

  // { type: 'password', email, password } | { type: 'social', signupToken }
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @SignupCredentialsType()
  credentials!: AccountSignupCredentials;
}
