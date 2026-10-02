import { Transform } from 'class-transformer';
import { IsEnum, Matches } from 'class-validator';
import { PhoneVerificationPurpose } from '../../generated/prisma/enums';
import { KOREAN_MOBILE_PATTERN, normalizePhone } from '../phone';

export class StartVerificationDto {
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'phone must be a Korean mobile number starting with 010',
  })
  phone!: string;

  @IsEnum(PhoneVerificationPurpose)
  purpose!: PhoneVerificationPurpose;
}
