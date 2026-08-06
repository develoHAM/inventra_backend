import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  barcode!: string;

  @IsInt()
  categoryId!: number;

  @IsInt()
  brandId!: number;

  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsInt()
  @Min(0)
  priceKrw!: number;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  color?: string;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  @MaxLength(2048)
  imageUrl?: string;
}
