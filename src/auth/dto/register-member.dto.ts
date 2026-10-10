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
import { JOIN_CODE_PATTERN, normalizeJoinCode } from '../../users/join-code';

export class RegisterMemberDto {
  @Transform(({ value }) => normalizeJoinCode(value))
  @Matches(JOIN_CODE_PATTERN, { message: 'joinCode must be 8 digits' })
  joinCode!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'phone must be a Korean mobile number starting with 010',
  })
  phone!: string;

  // from POST /auth/phone/confirm
  @IsString()
  @IsNotEmpty()
  phoneVerificationToken!: string;

  // { type: 'password', email, password } | { type: 'social', signupToken, … }
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @CredentialsType()
  credentials!: SignupCredentials;
}
