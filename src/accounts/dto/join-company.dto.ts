import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import {
  JOIN_CODE_PATTERN,
  normalizeJoinCode,
} from '../../companies/join-code';
import { ContactEmailProofDto } from './contact-email-proof.dto';

/**
 * POST /me/companies/join: a company's invite code, your name there and,
 * optionally, a proven contact email (ContactEmailProofDto).
 */
export class JoinCompanyDto extends ContactEmailProofDto {
  // '4829-1307' / '4829 1307' → '48291307', the same rule as signup
  @Transform(({ value }) => normalizeJoinCode(value))
  @Matches(JOIN_CODE_PATTERN, { message: 'joinCode must be 8 digits' })
  joinCode!: string;

  // each company profile has its own name (profiles.name is VARCHAR(100))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;
}
