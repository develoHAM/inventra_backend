import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import {
  InventoryTransactionType,
  TransactionSourceType,
} from '../../generated/prisma/enums';

export class CreateTransactionDto {
  @IsEnum(InventoryTransactionType)
  transactionType!: InventoryTransactionType;

  @IsInt()
  @Min(0)
  quantity!: number;

  @IsOptional()
  @IsNotEmpty()
  @IsString()
  remarks?: string;
}
