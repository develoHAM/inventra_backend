import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import { CurrentProfile } from '../auth/decorators/current-profile.decorator';
import type { AuthProfile } from '../auth/types/auth-profile';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

// Self-service: logged in, no permission needed — pending users too, so
// the "you've been approved" push can reach them.
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  register(
    @CurrentProfile() caller: AuthProfile,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.devices.register(caller.accountId, {
      token: dto.token,
      platform: dto.platform,
    });
  }

  @Delete(':token')
  @HttpCode(HttpStatus.NO_CONTENT)
  unregister(
    @CurrentProfile() caller: AuthProfile,
    @Param('token') token: string,
  ) {
    return this.devices.unregister(caller.accountId, token);
  }
}
