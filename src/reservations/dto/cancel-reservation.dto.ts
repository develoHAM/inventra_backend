import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CancelReservationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  cancelReason?: string;
}
