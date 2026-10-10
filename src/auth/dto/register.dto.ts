import { Transform } from 'class-transformer';
import {
  IsDefined,
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { CredentialsType } from './credentials.dto';
import type { SignupCredentials } from './credentials.dto';
import {
  normalizePhone,
  KOREAN_MOBILE_PATTERN,
} from '../../phone-verification/phone';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  companyName!: string;

  @IsString()
  @IsNotEmpty()
  taxId!: string;

  @IsString()
  @IsNotEmpty()
  ownerName!: string;

  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'ownerPhone must be a Korean mobile number starting with 010',
  })
  ownerPhone!: string;

  // from POST /auth/phone/confirm
  @IsString()
  @IsNotEmpty()
  ownerPhoneVerificationToken!: string;

  // { type: 'password', email, password } | { type: 'social', signupToken, … }
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @CredentialsType()
  credentials!: SignupCredentials;
}
