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

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  ownerPassword!: string;

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
}
