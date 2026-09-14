import { IsNotEmpty, IsString } from 'class-validator';

export class ConfirmImageDto {
  @IsString()
  @IsNotEmpty()
  key!: string;
}
