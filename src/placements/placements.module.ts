import { Module } from '@nestjs/common';
import { CornersModule } from '../corners/corners.module';
import { ProductsModule } from '../products/products.module';
import { PlacementsService } from './placements.service';
import { PlacementsController } from './placements.controller';

@Module({
  imports: [CornersModule, ProductsModule],
  providers: [PlacementsService],
  controllers: [PlacementsController],
})
export class PlacementsModule {}
