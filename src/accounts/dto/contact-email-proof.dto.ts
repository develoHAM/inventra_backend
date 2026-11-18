import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { normalizeEmail } from '../../common/email';

/** Sent at all? Then both fields are checked: both or neither. */
const sendsEither = (dto: ContactEmailProofDto) =>
  dto.contactEmail !== undefined || dto.emailVerificationToken !== undefined;

/**
 * An optional contact email for the new profile, proven up front with the
 * token from POST /auth/email/confirm, so the approval email can reach it
 * without a separate PUT /profiles/me/contact-email. Join and create extend
 * this; class-transformer and class-validator read the decorators through
 * the prototype chain, so the subclasses inherit the rules (and the
 * whitelist allows the fields).
 */
export class ContactEmailProofDto {
  // stored lowercase: emails are case-insensitive
  @ValidateIf(sendsEither)
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  contactEmail?: string;

  @ValidateIf(sendsEither)
  @IsString()
  @IsNotEmpty()
  emailVerificationToken?: string;
}
