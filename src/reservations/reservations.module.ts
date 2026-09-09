import { Module } from '@nestjs/common';
import { CornersModule } from '../corners/corners.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';

@Module({
  imports: [CornersModule, InventoryModule],
  providers: [ReservationsService],
  controllers: [ReservationsController],
  exports: [ReservationsService],
})
export class ReservationsModule {}
