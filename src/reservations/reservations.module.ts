import { Module } from '@nestjs/common';
import { CornersModule } from '../corners/corners.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';
import { ReservationExpiryService } from './reservation-expiry.service';

@Module({
  imports: [CornersModule, InventoryModule],
  providers: [ReservationsService, ReservationExpiryService],
  controllers: [ReservationsController],
  exports: [ReservationsService],
})
export class ReservationsModule {}
