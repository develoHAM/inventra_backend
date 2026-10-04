import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  KOREAN_MOBILE_PATTERN,
  normalizePhone,
} from '../../phone-verification/phone';

export class ResetPasswordDto {
  // factor 1: the login ID (find-ID only ever shows it masked)
  @IsEmail()
  email!: string;

  // factor 2: the phone, proven by the token
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'phone must be a Korean mobile number starting with 010',
  })
  phone!: string;

  // from POST /auth/phone/confirm, started with purpose RESET_PASSWORD
  @IsString()
  @IsNotEmpty()
  phoneVerificationToken!: string;

  // same rule as signup
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
