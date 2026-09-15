import { IsIn, IsString } from 'class-validator';

export class PresignUploadDto {
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'image/webp'])
  contentType!: string;
}
