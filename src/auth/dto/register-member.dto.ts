import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RegisterMemberDto {
  @IsString()
  @IsNotEmpty()
  joinCode!: string;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}
