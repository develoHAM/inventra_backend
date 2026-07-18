import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class RegisterMemberDto {
  @IsEmail()
  email!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}
