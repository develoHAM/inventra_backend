import {
  IsUUID,
  IsOptional,
  IsInt,
  Min,
  IsBoolean,
  IsString,
  IsNotEmpty,
} from 'class-validator';

export class CreatePlacementDto {
  @IsUUID()
  productId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  targetStockQuantity?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  description?: string;
}
