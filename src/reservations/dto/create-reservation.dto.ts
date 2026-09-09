import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateReservationDto {
  @IsInt()
  companyStoreProductId!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  reservedByName!: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @IsPhoneNumber('KR')
  @MaxLength(20)
  reservedByPhone?: string;

  @IsInt()
  @Min(1)
  reservedQuantity!: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  remark?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
