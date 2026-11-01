import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { normalizeEmail } from '../../common/email';

export class LoginDto {
  // stored lowercase, so 'Jane@Acme.com' finds 'jane@acme.com'
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
