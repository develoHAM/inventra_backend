import { IsInt, Min } from 'class-validator';

export class AuditItemDto {
  @IsInt()
  companyStoreProductId!: number;

  @IsInt()
  @Min(0)
  productQuantity!: number;
}
