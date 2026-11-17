import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { normalizeEmail } from '../../common/email';

/**
 * PUT /profiles/me/contact-email: where this company's notifications go,
 * with its proof from POST /auth/email/confirm for that same address.
 */
export class SetContactEmailDto {
  // stored lowercase: emails are case-insensitive
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  emailVerificationToken!: string;
}
