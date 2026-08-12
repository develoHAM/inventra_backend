import {
  IsUUID,
  IsOptional,
  IsString,
  MaxLength,
  IsNotEmpty,
} from 'class-validator';

export class CreateCornerDto {
  @IsUUID()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  location?: string;

  @IsOptional()
  @IsUUID()
  @IsNotEmpty()
  managerUserId?: string;

  @IsOptional()
  @IsUUID()
  @IsNotEmpty()
  companyId?: string; // ADMIN target company
}
