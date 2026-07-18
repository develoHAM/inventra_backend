import { IsNotEmpty, IsString } from 'class-validator';

export class RegisterMemberDto {
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
