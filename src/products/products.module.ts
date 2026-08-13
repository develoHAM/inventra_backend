import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { CategoriesModule } from '../categories/categories.module';
import { BrandsModule } from '../brands/brands.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { ProductsService } from './products.service';

@Module({
  imports: [CategoriesModule, BrandsModule, AuthorizationModule],
  providers: [ProductsService],
  controllers: [ProductsController],
  exports: [ProductsService],
})
export class ProductsModule {}
