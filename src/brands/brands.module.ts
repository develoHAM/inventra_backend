import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { BrandsService } from './brands.service';
import { BrandsController } from './brands.controller';

@Module({
  imports: [AuthorizationModule],
  providers: [BrandsService],
  controllers: [BrandsController],
  exports: [BrandsService],
})
export class BrandsModule {}
