import { IsIn, IsString } from 'class-validator';

export class PresignImageDto {
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType!: string;
}
