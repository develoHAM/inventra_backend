import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches } from 'class-validator';
import {
  KOREAN_MOBILE_PATTERN,
  normalizePhone,
} from '../../phone-verification/phone';

export class FindIdDto {
  @Transform(({ value }) => normalizePhone(value))
  @Matches(KOREAN_MOBILE_PATTERN, {
    message: 'phone must be a Korean mobile number starting with 010',
  })
  phone!: string;

  // from POST /auth/phone/confirm, started with purpose FIND_ID
  @IsString()
  @IsNotEmpty()
  phoneVerificationToken!: string;
}
