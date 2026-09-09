import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional } from 'class-validator';
import { ReservationStatus } from '../../generated/prisma/enums';

export class ListReservationsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  companyStoreProductId?: number;

  @IsOptional()
  @IsEnum(ReservationStatus)
  status?: ReservationStatus;
}
