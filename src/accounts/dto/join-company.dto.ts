import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import {
  JOIN_CODE_PATTERN,
  normalizeJoinCode,
} from '../../companies/join-code';

/** POST /me/companies/join: a company's invite code, and your name there. */
export class JoinCompanyDto {
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
