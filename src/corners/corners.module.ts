import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../authorization/authorization.module';
import { StoresModule } from '../stores/stores.module';
import { UsersModule } from '../users/users.module';
import { CornersService } from './corners.service';
import { CornersController } from './corners.controller';

@Module({
  imports: [AuthorizationModule, StoresModule, UsersModule],
  providers: [CornersService],
  controllers: [CornersController],
  exports: [CornersService],
})
export class CornersModule {}
