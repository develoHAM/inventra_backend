import { Module } from '@nestjs/common';
import { CornersModule } from '../corners/corners.module';
import { InventoryModule } from '../inventory/inventory.module';
import { AuditsController } from './audits.controller';
import { AuditsService } from './audits.service';

@Module({
  imports: [CornersModule, InventoryModule],
  providers: [AuditsService],
  controllers: [AuditsController],
  exports: [AuditsService],
})
export class AuditsModule {}
