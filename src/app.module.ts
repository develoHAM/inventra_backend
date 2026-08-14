import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { UsersModule } from './users/users.module';
import { CategoriesModule } from './categories/categories.module';
import { BrandsModule } from './brands/brands.module';
import { ProductsModule } from './products/products.module';
import { StoresModule } from './stores/stores.module';
import { CornersModule } from './corners/corners.module';
import { PlacementsModule } from './placements/placements.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    PrismaModule,
    AuthModule,
    AuthorizationModule,
    UsersModule,
    CategoriesModule,
    BrandsModule,
    ProductsModule,
    StoresModule,
    CornersModule,
    PlacementsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
