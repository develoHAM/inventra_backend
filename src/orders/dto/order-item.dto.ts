import { IsInt, Min } from 'class-validator';

export class OrderItemDto {
  @IsInt()
  companyStoreProductId!: number;

  @IsInt()
  @Min(1)
  productOrderQuantity!: number;
}
