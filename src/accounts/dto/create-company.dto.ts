import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ContactEmailProofDto } from './contact-email-proof.dto';

/**
 * POST /me/companies: the company half of the old register, plus an
 * optional proven contact email (ContactEmailProofDto). The phone and login
 * already belong to the signed-in account. Lengths are the columns'.
 */
export class CreateCompanyDto extends ContactEmailProofDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  companyName!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  taxId!: string;

  // your name as the owner, in this company
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  ownerName!: string;
}
