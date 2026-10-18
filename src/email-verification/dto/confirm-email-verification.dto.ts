import { Matches } from 'class-validator';
import { StartEmailVerificationDto } from './start-email-verification.dto';

export class ConfirmEmailVerificationDto extends StartEmailVerificationDto {
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
