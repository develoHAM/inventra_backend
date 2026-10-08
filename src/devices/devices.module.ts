import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { DevicesPruner } from './devices.pruner';
import { PushModule } from '../notifications/push.module';

@Module({
  imports: [PushModule],
  controllers: [DevicesController],
  providers: [DevicesService, DevicesPruner],
  exports: [DevicesService],
})
export class DevicesModule {}
