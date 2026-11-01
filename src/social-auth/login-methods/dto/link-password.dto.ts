import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { normalizeEmail } from '../../../common/email';

/** Add an email + password login to an account that signs in socially. */
export class LinkPasswordDto {
  // the address verified with POST /auth/email/confirm, normalized the same way
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  @MaxLength(255)
  email!: string;

  // same rule as password signup
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @IsString()
  @IsNotEmpty()
  emailVerificationToken!: string;
}
